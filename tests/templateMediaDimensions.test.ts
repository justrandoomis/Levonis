import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import {
  all,
  asD1,
  count,
  failingD1,
  freshDb,
  get,
  json,
  post,
  row,
  stubApp,
  type App,
} from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { parseTemplate } from '../worker/lib/template';
import { parseProductRow } from '../worker/lib/productModel';
import { loadRelationsView } from '../worker/lib/productOverlay';
import { resolveSelectionPhysicalDimensions } from '../worker/lib/physicalDimensions';
import { SqliteD1, SqliteStatement } from './fixtures/d1';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

function png(marker: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes[31] = marker;
  return bytes;
}

function jpeg(marker: number): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes[15] = marker;
  return bytes;
}

function webp(marker: number, width = 640, height = 480): Uint8Array {
  const bytes = new Uint8Array(31);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  bytes[20] = marker;
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 255, (w >>> 8) & 255, (w >>> 16) & 255], 24);
  bytes.set([h & 255, (h >>> 8) & 255, (h >>> 16) & 255], 27);
  return bytes;
}

async function streamBytes(stream: ReadableStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function imagesBinding(failMarkers = new Set<number>()) {
  return {
    input(stream: ReadableStream) {
      return {
        async output() {
          const source = await streamBytes(stream);
          const marker = source[source.length - 1] ?? 0;
          if (failMarkers.has(marker)) throw new Error(`conversion failed for marker ${marker}`);
          const converted = webp(marker, 640 + marker, 480 + marker);
          return { response: () => new Response(converted, { headers: { 'content-type': 'image/webp' } }) };
        },
      };
    },
    async info(stream: ReadableStream) {
      const source = await streamBytes(stream);
      const marker = source[20] ?? 0;
      return { format: 'image/webp', fileSize: source.byteLength, width: 640 + marker, height: 480 + marker };
    },
  };
}

class MemoryBucket {
  objects = new Map<string, Uint8Array>();
  deletes: string[] = [];
  failDelete = false;

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? ({ key, size: bytes.byteLength } as unknown as R2Object) : null;
  }

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const copy = bytes.slice();
    return {
      key,
      size: copy.byteLength,
      httpMetadata: { contentType: 'image/webp' },
      body: new Blob([copy]).stream(),
      arrayBuffer: async () => copy.slice().buffer,
    } as unknown as R2ObjectBody;
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView, opts?: R2PutOptions) {
    if (opts?.onlyIf && this.objects.has(key)) return null;
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, bytes.slice());
    return { key, size: bytes.byteLength } as unknown as R2Object;
  }

  async delete(key: string) {
    this.deletes.push(key);
    if (this.failDelete) throw new Error('simulated R2 delete failure');
    this.objects.delete(key);
  }
}

/** Pauses the first post-commit product readback.
 * The early template.apply audit is visible while the request is paused, but
 * the verified-completion marker cannot exist yet. */
class ReadbackBarrierD1 {
  private readonly inner: SqliteD1;
  private blocked = false;
  private signalReached!: () => void;
  private signalRelease!: () => void;
  readonly reached: Promise<void>;
  private readonly released: Promise<void>;

  constructor(private readonly raw: DatabaseSync) {
    this.inner = new SqliteD1(raw);
    this.reached = new Promise<void>((resolve) => { this.signalReached = resolve; });
    this.released = new Promise<void>((resolve) => { this.signalRelease = resolve; });
  }

  prepare(sql: string) {
    return new ReadbackBarrierStatement(this, this.inner.prepare(sql), sql);
  }

  async batch(statements: ReadbackBarrierStatement[]) {
    return this.inner.batch(statements.map((statement) => statement.unwrap()));
  }

  shouldBlock(sql: string): boolean {
    if (this.blocked) return false;
    if (sql.replace(/\s+/g, ' ').trim() !== 'SELECT * FROM products WHERE id = ?') return false;
    if (count(this.raw, 'SELECT COUNT(*) AS n FROM products') === 0) return false;
    this.blocked = true;
    this.signalReached();
    return true;
  }

  async readAfterRelease<T>(read: () => Promise<T | null>): Promise<T | null> {
    await this.released;
    return read();
  }

  release(): void {
    this.signalRelease();
  }
}

class ReadbackBarrierStatement {
  constructor(
    private readonly owner: ReadbackBarrierD1,
    private readonly inner: SqliteStatement,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]) {
    return new ReadbackBarrierStatement(this.owner, this.inner.bind(...values), this.sql);
  }

  run() { return this.inner.run(); }
  all<T = Record<string, unknown>>() { return this.inner.all<T>(); }
  first<T = Record<string, unknown>>() {
    return this.owner.shouldBlock(this.sql)
      ? this.owner.readAfterRelease(() => this.inner.first<T>())
      : this.inner.first<T>();
  }
  unwrap() { return this.inner; }
}

class MembershipFailureStatement {
  constructor(readonly inner: SqliteStatement, readonly sql: string) {}
  bind(...values: unknown[]) { return new MembershipFailureStatement(this.inner.bind(...values), this.sql); }
  run() { return this.inner.run(); }
  first<T = Record<string, unknown>>() { return this.inner.first<T>(); }
  all<T = Record<string, unknown>>() { return this.inner.all<T>(); }
}

/** Executes the real SQLite transaction but throws when its second tier-rule
 * mutation is reached. The first rule and product statements have run inside
 * that transaction by then, so only a genuine all-in-one batch rolls them all
 * back. */
class SecondMembershipWriteFailureD1 {
  private readonly inner: SqliteD1;
  constructor(raw: DatabaseSync) { this.inner = new SqliteD1(raw); }
  prepare(sql: string) { return new MembershipFailureStatement(this.inner.prepare(sql), sql); }
  async batch(statements: MembershipFailureStatement[]) {
    let membershipWrites = 0;
    const injected = statements.map((statement) => {
      if (/INSERT INTO membership_benefit_rules\b/.test(statement.sql) && ++membershipWrites === 2) {
        return {
          async run() { throw new Error('simulated second membership tier failure'); },
        } as unknown as SqliteStatement;
      }
      return statement.inner;
    });
    return this.inner.batch(injected);
  }
}

function mountWithMedia(
  db: unknown,
  bucket: MemoryBucket,
  images: ReturnType<typeof imagesBinding>
): App {
  return stubApp(
    db,
    OWNER,
    (app) => app.route('/api/admin/template', templateRoutes),
    { env: { BUCKET: bucket, R2_PUBLIC: bucket, IMAGES: images } }
  );
}

const apply = async (app: App, text: string, mode: 'draft' | 'update' = 'draft') => {
  const response = await post(app, '/api/admin/template/apply', { text, mode, confirm: true });
  return { response, body: await json(response) };
};

const FULL = `template_version=2
slug=template-media-a1
name_ar=طابعة بامبو A1
name_en=Bambu Lab A1
price_iqd=899000
selling_type=direct_sale
net_weight_g=8300
width_mm=385
depth_mm=410
height_mm=430
options.1.id=opt_a1
options.1.group=Model
options.1.name_en=A1
options.1.active=true
options.1.package_weight_g=13000
options.1.package_width_mm=596
options.1.package_depth_mm=536
options.1.package_height_mm=325
options.2.id=opt_combo
options.2.group=Model
options.2.name_en=A1 Combo
options.2.active=true
options.2.regular_price_iqd=+200000
options.2.package_weight_g=13500
options.2.package_width_mm=560
options.2.package_depth_mm=540
options.2.package_height_mm=430
options.2.image=https://vendor.example/legacy-combo.jpg
colors.1.id=col_black
colors.1.name_en=Black
colors.1.hex=#000000
colors.1.option_ids=opt_a1,opt_combo
colors.1.active=true
colors.1.package_weight_g=14000
variants.1.id=var_a1_black
variants.1.option_value_ids=opt_a1
variants.1.color_id=col_black
variants.1.package_weight_g=15000
images.1.id=img_front
images.1.fetch_url=https://vendor.example/front.png
images.1.primary=true
images.2.id=img_a1
images.2.fetch_url=https://vendor.example/front.png
images.2.option_value_id=opt_a1
images.3.id=img_black
images.3.fetch_url=https://vendor.example/black.jpg
images.3.color_id=col_black
images.4.id=img_variant
images.4.fetch_url=https://vendor.example/variant.png
images.4.variant_id=var_a1_black
images.5.fetch_url=https://vendor.example/extra-one.png
images.6.fetch_url=https://vendor.example/extra-two.jpg
images.7.id=img_legacy_url
images.7.url=https://vendor.example/legacy-url.png
images.8.fetch_url=https://vendor.example/extra-one-alias.png
images.8.key=products/stale-export-key.jpg
colors.1.image=https://vendor.example/legacy-black.png
`;

function sourceFor(url: string): Uint8Array {
  const values: Record<string, Uint8Array> = {
    'https://vendor.example/front.png': png(1),
    'https://vendor.example/black.jpg': jpeg(2),
    'https://vendor.example/variant.png': png(3),
    'https://vendor.example/extra-one.png': png(4),
    'https://vendor.example/extra-two.jpg': jpeg(5),
    'https://vendor.example/legacy-combo.jpg': jpeg(6),
    'https://vendor.example/legacy-url.png': png(7),
    'https://vendor.example/legacy-black.png': png(8),
    // A different source that converts to the same final WebP as extra-one.
    'https://vendor.example/extra-one-alias.png': png(4),
  };
  const bytes = values[url];
  if (!bytes) throw new Error(`unexpected test URL ${url}`);
  return bytes;
}

test('media and dimension validation errors retain the exact TXT field and line', () => {
  const parsed = parseTemplate(`template_version=2
net_weight_g=0
images.1.url=/files/a.webp
images.1.fetch_url=https://vendor.example/a.png
images.2.url=/files/b.webp
images.2.option_value_id=opt_a1
images.2.color_id=col_black
options.1.id=opt_a1
options.1.name_en=A1
options.1.width_mm=1.5
images.3.fetch_url=ftp://vendor.example/nope.png
`);
  assert.deepEqual(parsed.errors, [
    { line: 2, key: 'net_weight_g', message: 'must be between 1 and 100000000' },
    {
      line: 10,
      key: 'options.1.width_mm',
      message: 'must be an integer',
    },
    {
      line: 3,
      key: 'images.1.url',
      message: 'choose one media source: url for an existing local /files object, or fetch_url for a remote image to import',
    },
    {
      line: 4,
      key: 'images.1.fetch_url',
      message: 'choose one media source: url for an existing local /files object, or fetch_url for a remote image to import',
    },
    {
      line: 7,
      key: 'images.2.color_id',
      message: 'an image may bind to only one of option_value_id, color_id, or variant_id',
    },
    {
      line: 11,
      key: 'images.3.fetch_url',
      message: 'must be an absolute http(s) image URL without credentials',
    },
  ]);

  const duplicate = parseTemplate(`template_version=2
images.1.id=hero
images.1.fetch_url=https://vendor.example/a.png
images.2.id=hero
images.2.fetch_url=https://vendor.example/b.png
`);
  assert.deepEqual(duplicate.errors, [{
    line: 4,
    key: 'images.2.id',
    message: 'duplicate image id "hero" (already used by images.1.id)',
  }]);

  const generatedCollision = parseTemplate(`template_version=2
options.1.id=opt_a1
options.1.name_en=A1
options.1.image=https://vendor.example/legacy.png
images.1.id=img_option_1_opt_a1
images.1.fetch_url=https://vendor.example/explicit.png
`);
  assert.deepEqual(generatedCollision.errors, [{
    line: 4,
    key: 'options.1.image',
    message: 'materialized image id "img_option_1_opt_a1" conflicts with images.1.fetch_url',
  }]);

  const localGeneratedCollision = parseTemplate(`template_version=2
options.1.id=opt_a1
options.1.name_en=A1
options.1.image=/files/legacy/a.webp
images.1.id=img_option_1_opt_a1
images.1.url=/files/explicit/a.webp
`);
  assert.deepEqual(localGeneratedCollision.errors, [{
    line: 4,
    key: 'options.1.image',
    message: 'materialized image id "img_option_1_opt_a1" conflicts with images.1.id',
  }]);

  const invalidLocal = parseTemplate(`template_version=2
images.1.url=/files/legacy/a.jpg
images.2.url=/files/legacy/b.webp
images.2.key=legacy/other.webp
options.1.id=opt_a1
options.1.name_en=A1
options.1.image=/files/legacy/option.jpg
`);
  assert.deepEqual(invalidLocal.errors, [
    { line: 2, key: 'images.1.url', message: 'local product media must be a /files/<key>.webp URL' },
    { line: 4, key: 'images.2.key', message: 'must exactly match the key in images.2.url (legacy/b.webp)' },
    { line: 7, key: 'options.1.image', message: 'local product media must be a /files/<key>.webp URL' },
  ]);

  const uppercaseLocal = parseTemplate(`template_version=2
images.1.url=/files/legacy/a.WEBP
options.1.id=opt_a1
options.1.name_en=A1
options.1.image=/files/legacy/option.WEBP
`);
  assert.deepEqual(uppercaseLocal.errors, [
    { line: 2, key: 'images.1.url', message: 'local product media must be a /files/<key>.webp URL' },
    { line: 5, key: 'options.1.image', message: 'local product media must be a /files/<key>.webp URL' },
  ]);

  const cleared = parseTemplate(`template_version=2
images=__CLEAR__
images.1.fetch_url=https://vendor.example/ignored.png
options=__CLEAR__
options.1.name_en=Ignored
options.1.image=https://vendor.example/ignored-option.png
`);
  assert.deepEqual(cleared.errors, []);
  assert.deepEqual(cleared.media_to_fetch, [], 'indexed rows ignored by a group clear never authorize network access');
});

test('invalid image and variant bindings are refused by exact field before any fetch', async () => {
  const raw = freshDb();
  const bucket = new MemoryBucket();
  const app = mountWithMedia(asD1(raw), bucket, imagesBinding());
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(png(1));
  }) as typeof fetch;
  try {
    const badImage = `template_version=2
slug=bad-image-binding
name_en=Bad image binding
price_iqd=1000
images.1.fetch_url=https://vendor.example/a.png
images.1.option_value_id=missing_option
`;
    const preview = await json(await post(app, '/api/admin/template/parse', { text: badImage }));
    assert.equal(preview.validation_error.field, 'images.1.option_value_id');
    assert.equal(preview.validation_error.errors[0].line, 6);
    const applied = await apply(app, badImage);
    assert.equal(applied.response.status, 400);
    assert.equal(applied.body.code, 'TEMPLATE_BINDING_INVALID');
    assert.equal(applied.body.field, 'images.1.option_value_id');

    const badVariant = `template_version=2
slug=bad-variant-binding
name_en=Bad variant binding
price_iqd=1000
variants.1.id=var_bad
variants.1.option_value_ids=missing_option
`;
    const variantPreview = await json(await post(app, '/api/admin/template/parse', { text: badVariant }));
    assert.equal(variantPreview.validation_error.field, 'variants.1.option_value_ids');
    assert.equal(fetches, 0, 'binding validation happens before network materialization');
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy local option and color images become canonical bound rows', async () => {
  const raw = freshDb();
  const bucket = new MemoryBucket();
  bucket.objects.set('legacy/option.webp', webp(11));
  bucket.objects.set('legacy/color.webp', webp(12));
  const app = mountWithMedia(asD1(raw), bucket, imagesBinding());
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('local legacy media must not use outbound fetch');
  }) as typeof fetch;
  try {
    const text = `template_version=2
slug=local-legacy-media
name_en=Local legacy media
price_iqd=1000
options.1.id=opt_local
options.1.name_en=Local option
options.1.image=/files/legacy/option.webp
colors.1.id=col_local
colors.1.name_en=Local color
colors.1.hex=#101010
colors.1.option_ids=opt_local
colors.1.image=/files/legacy/color.webp
`;
    const result = await apply(app, text);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    const productId = String(result.body.product_id);
    assert.equal(fetches, 0);
    assert.deepEqual(
      all(raw, `SELECT url, option_value_id, color_id FROM product_images WHERE product_id = ? ORDER BY url`, productId),
      [
        { url: '/files/legacy/color.webp', option_value_id: null, color_id: 'col_local' },
        { url: '/files/legacy/option.webp', option_value_id: 'opt_local', color_id: null },
      ]
    );
    assert.equal(row<{ image: string }>(raw, `SELECT image FROM product_option_values WHERE id = 'opt_local'`)?.image, '');
    assert.equal(row<{ image: string }>(raw, `SELECT image FROM product_colors WHERE id = 'col_local'`)?.image, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failure on the second membership tier rolls back product, rules, versions, and audits', async () => {
  const raw = freshDb();
  const db = new SecondMembershipWriteFailureD1(raw);
  const bucket = new MemoryBucket();
  const app = mountWithMedia(db as unknown as D1Database, bucket, imagesBinding());
  const versionsBefore = count(raw, 'SELECT COUNT(*) AS n FROM membership_benefit_versions');
  const auditsBefore = count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'membership_benefit.%'`);
  const text = `template_version=2
slug=membership-second-tier-failure
name_en=Membership transaction
price_iqd=1000
membership.pro.discount_mode=percent
membership.pro.percent=10
membership.premium.discount_mode=fixed
membership.premium.fixed_iqd=250
`;

  const result = await apply(app, text);
  assert.equal(result.response.status, 500);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 0, 'the product shares the membership transaction');
  assert.equal(
    count(raw, `SELECT COUNT(*) AS n FROM membership_benefit_rules WHERE scope = 'product'`),
    0,
    'the first tier does not survive failure of the second'
  );
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM membership_benefit_versions'), versionsBefore);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'membership_benefit.%'`), auditsBefore);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.apply.verified'`), 0);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'tplfp:%'`), 0, 'the failed owner releases its claim');
});

test('a two-tier membership failure also rolls an existing product update back', async () => {
  const raw = freshDb();
  const bucket = new MemoryBucket();
  const baselineApp = mountWithMedia(asD1(raw), bucket, imagesBinding());
  const baseline = await apply(baselineApp, `template_version=2
slug=membership-update-atomic
name_en=Membership baseline
price_iqd=1000
membership.pro.discount_mode=percent
membership.pro.percent=5
`);
  assert.equal(baseline.response.status, 200, JSON.stringify(baseline.body));
  const productId = String(baseline.body.product_id);
  const versionsBefore = count(raw, 'SELECT COUNT(*) AS n FROM membership_benefit_versions');
  const auditsBefore = count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'membership_benefit.%'`);
  const verifiedBefore = count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.apply.verified'`);
  const claimsBefore = count(raw, `SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'tplfp:%'`);

  const failingApp = mountWithMedia(
    new SecondMembershipWriteFailureD1(raw) as unknown as D1Database,
    bucket,
    imagesBinding()
  );
  const changed = await apply(failingApp, `template_version=2
product_id=${productId}
name_en=Membership changed
membership.pro.discount_mode=percent
membership.pro.percent=20
membership.premium.discount_mode=fixed
membership.premium.fixed_iqd=250
`, 'update');
  assert.equal(changed.response.status, 500);
  assert.equal(row<{ name: string }>(raw, 'SELECT name FROM products WHERE id = ?', productId)?.name, 'Membership baseline');
  assert.deepEqual(
    all(raw, `SELECT tier, discount_mode, percent, fixed_iqd
                FROM membership_benefit_rules WHERE product_id = ? ORDER BY tier`, productId),
    [{ tier: 'pro', discount_mode: 'percent', percent: 5, fixed_iqd: null }]
  );
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM membership_benefit_versions'), versionsBefore);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'membership_benefit.%'`), auditsBefore);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.apply.verified'`), verifiedBefore);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'tplfp:%'`), claimsBefore);
});

test('an identical apply cannot report success before the winner passes readback verification', async () => {
  const raw = freshDb();
  const barrier = new ReadbackBarrierD1(raw);
  const bucket = new MemoryBucket();
  const app = mountWithMedia(barrier as unknown as D1Database, bucket, imagesBinding());
  const text = `template_version=2
slug=template-readback-barrier
name_en=Readback barrier
price_iqd=1000
membership.pro.discount_mode=percent
membership.pro.percent=10
`;
  const payload = {
    text,
    mode: 'draft',
    confirm: true,
    duplicate_choice: 'create_hidden_draft_new_identity',
  };

  const winnerPromise = post(app, '/api/admin/template/apply', payload);
  await barrier.reached;
  let fingerprint = '';
  try {
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 1, 'the winner catalog batch committed');
    const committedId = String(row<{ id: string }>(raw, 'SELECT id FROM products')?.id);
    assert.equal(
      count(raw, 'SELECT COUNT(*) AS n FROM membership_benefit_rules WHERE product_id = ?', committedId),
      1,
      'the product rule committed in the same catalogue batch'
    );
    assert.equal(
      count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.apply.verified'`),
      0,
      'readback has not produced a completion marker'
    );

    const duplicate = await post(app, '/api/admin/template/apply', payload);
    const duplicateBody = await json(duplicate);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicateBody.code, 'APPLY_IN_PROGRESS');
    fingerprint = String(duplicateBody.fingerprint);
    const activeStatusResponse = await get(
      app,
      `/api/admin/template/apply-status/${encodeURIComponent(fingerprint)}`
    );
    const activeStatus = await json(activeStatusResponse);
    assert.equal(activeStatusResponse.status, 200);
    assert.equal(activeStatus.state, 'applying', 'the browser can wait without reposting the mutation');
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 1, 'the losing confirm creates no twin');
    assert.equal(
      count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.apply.verified'`),
      0,
      'the pre-verification template.apply audit is not treated as completion'
    );

    raw.prepare(`UPDATE products SET name = 'tampered after commit'`).run();
  } finally {
    barrier.release();
  }

  const winner = await winnerPromise;
  const winnerBody = await json(winner);
  assert.equal(winner.status, 500);
  assert.equal(winnerBody.code, 'APPLY_VERIFY_FAILED');
  assert.equal(winnerBody.product_id, null);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 0, 'failed create verification rolls the product back');
  assert.equal(
    count(raw, `SELECT COUNT(*) AS n FROM membership_benefit_rules WHERE scope = 'product'`),
    0,
    'verification rollback leaves no product-scoped membership orphan'
  );
  const latestVersion = row<{ action: string; rule_id: string; before_json: string; rules_json: string }>(
    raw,
    'SELECT action, rule_id, before_json, rules_json FROM membership_benefit_versions ORDER BY id DESC LIMIT 1'
  );
  assert.equal(latestVersion?.action, 'delete');
  assert.ok(latestVersion?.rule_id);
  assert.equal(Array.isArray(JSON.parse(latestVersion!.before_json)), false, 'history carries one ordinary rule object');
  const versionIds = (JSON.parse(latestVersion!.rules_json) as Array<{ id: string }>).map((rule) => rule.id).sort();
  const liveIds = all<{ id: string }>(raw, 'SELECT id FROM membership_benefit_rules ORDER BY id').map((rule) => rule.id);
  assert.deepEqual(versionIds, liveIds, 'the rollback version snapshot describes the rule set that remains');
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.apply.verified'`), 0);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'tplfp:%'`), 0, 'the failed winner releases its owned claim');
  const retryStatusResponse = await get(
    app,
    `/api/admin/template/apply-status/${encodeURIComponent(fingerprint)}`
  );
  const retryStatus = await json(retryStatusResponse);
  assert.equal(retryStatusResponse.status, 200);
  assert.equal(retryStatus.state, 'retry', 'a released failed owner lets the browser retry the same file');
});

test('TXT media materializes before save and A1 dimensions survive reload, export, and zero-fetch re-import', async () => {
  const raw = freshDb();
  const db = asD1(raw);
  const bucket = new MemoryBucket();
  const app = mountWithMedia(db, bucket, imagesBinding());
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  let activeFetches = 0;
  let maxActiveFetches = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetched.push(url);
    activeFetches += 1;
    maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
    await Promise.resolve();
    const response = new Response(sourceFor(url), { status: 200 });
    activeFetches -= 1;
    return response;
  }) as typeof fetch;

  try {
    const previewResponse = await post(app, '/api/admin/template/parse', { text: FULL });
    const preview = await json(previewResponse);
    assert.equal(previewResponse.status, 200);
    assert.deepEqual(preview.errors, []);
    assert.equal(fetched.length, 0, '/parse is pure and performs no network request');
    assert.equal(preview.media_to_fetch.length, 10);
    assert.ok(preview.warnings.some((warning: string) => warning.includes('options.2.image')));
    assert.ok(preview.warnings.some((warning: string) => warning.includes('colors.1.image')));
    assert.ok(preview.warnings.some((warning: string) => warning.includes('images.7.url')));
    assert.ok(preview.media_to_fetch.some((intent: Record<string, unknown>) => intent.field === 'images.7.url'));
    const targetOf = (field: string) =>
      preview.media_to_fetch.find((intent: Record<string, unknown>) => intent.field === field)?.target;
    assert.equal(targetOf('images.2.fetch_url'), 'option:opt_a1');
    assert.equal(targetOf('images.3.fetch_url'), 'color:col_black');
    assert.equal(targetOf('images.4.fetch_url'), 'variant:var_a1_black');
    assert.equal(targetOf('options.2.image'), 'option:opt_combo');
    assert.equal(targetOf('colors.1.image'), 'color:col_black');
    assert.deepEqual(
      preview.media_to_fetch.find((intent: Record<string, unknown>) => intent.field === 'images.1.fetch_url'),
      {
        field: 'images.1.fetch_url',
        line: 40,
        target: 'product',
        primary: true,
        source_url: 'https://vendor.example/front.png',
        source_host: 'vendor.example',
      }
    );

    const created = await apply(app, FULL);
    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    const appliedStatus = await json(
      await get(app, `/api/admin/template/apply-status/${encodeURIComponent(String(created.body.fingerprint))}`)
    );
    assert.equal(appliedStatus.state, 'applied', 'the recovery poll observes the verified completion marker');
    const productId = String(created.body.product_id);
    assert.ok(productId);
    assert.equal(
      fetched.filter((url) => url === 'https://vendor.example/front.png').length,
      1,
      'a repeated source URL is fetched once'
    );
    assert.equal(maxActiveFetches, 1, 'unique sources share one serialized request/byte budget');

    const images = all<Record<string, unknown>>(
      raw,
      `SELECT id, url, r2_key, source_url, content_type, bytes, width, height,
              is_primary, option_value_id, color_id, variant_id
         FROM product_images WHERE product_id = ? ORDER BY sort_order, id`,
      productId
    );
    assert.equal(images.length, 9, 'two id-less gallery rows and every binding remain distinct');
    assert.equal(bucket.objects.size, 8, 'different source URLs with identical final WebP bytes share one object');
    assert.ok(images.every((image) => String(image.url).startsWith('/files/products/import/gallery/')));
    assert.ok(images.every((image) => image.content_type === 'image/webp' && Number(image.bytes) > 0));
    assert.equal(images.find((image) => image.id === 'img_front')?.is_primary, 1);
    assert.equal(images.find((image) => image.id === 'img_a1')?.option_value_id, 'opt_a1');
    assert.equal(images.find((image) => image.id === 'img_black')?.color_id, 'col_black');
    assert.equal(images.find((image) => image.id === 'img_variant')?.variant_id, 'var_a1_black');
    assert.ok(images.some((image) => image.source_url === 'https://vendor.example/legacy-combo.jpg'));
    assert.ok(images.some((image) => image.source_url === 'https://vendor.example/legacy-black.png'));
    assert.equal(
      row<{ image: string }>(raw, 'SELECT image FROM product_option_values WHERE id = ?', 'opt_combo')?.image,
      '',
      'legacy selector columns are drained after canonical media is written'
    );
    assert.equal(
      row<{ image: string }>(raw, 'SELECT image FROM product_colors WHERE id = ?', 'col_black')?.image,
      '',
      'legacy color image columns are drained after canonical media is written'
    );

    assert.deepEqual(
      row(raw, 'SELECT net_weight_g, width_mm, depth_mm, height_mm FROM products WHERE id = ?', productId),
      { net_weight_g: 8300, width_mm: 385, depth_mm: 410, height_mm: 430 }
    );
    assert.deepEqual(
      row(raw, `SELECT package_weight_g, package_width_mm, package_depth_mm, package_height_mm
                  FROM product_option_values WHERE id = 'opt_a1'`),
      { package_weight_g: 13000, package_width_mm: 596, package_depth_mm: 536, package_height_mm: 325 }
    );
    assert.deepEqual(
      row(raw, `SELECT package_weight_g, package_width_mm, package_depth_mm, package_height_mm
                  FROM product_option_values WHERE id = 'opt_combo'`),
      { package_weight_g: 13500, package_width_mm: 560, package_depth_mm: 540, package_height_mm: 430 }
    );
    assert.equal(
      row<{ package_weight_g: number }>(raw, `SELECT package_weight_g FROM product_colors WHERE id = 'col_black'`)?.package_weight_g,
      14000
    );
    assert.equal(
      row<{ package_weight_g: number }>(raw, `SELECT package_weight_g FROM product_variants WHERE id = 'var_a1_black'`)?.package_weight_g,
      15000
    );

    const productRow = row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', productId)!;
    const view = await loadRelationsView(db, productId, String(productRow.inventory_mode));
    const resolved = resolveSelectionPhysicalDimensions(parseProductRow(productRow), view, {
      optionValueIds: ['opt_a1'],
      colorId: 'col_black',
    });
    assert.deepEqual(
      {
        package_weight_g: resolved.package_weight_g,
        package_width_mm: resolved.package_width_mm,
        package_depth_mm: resolved.package_depth_mm,
        package_height_mm: resolved.package_height_mm,
      },
      { package_weight_g: 15000, package_width_mm: 596, package_depth_mm: 536, package_height_mm: 325 },
      'the exact variant wins per field; the option supplies fields it omits'
    );

    const exportedResponse = await get(app, `/api/admin/template/export/${productId}`);
    const exported = await exportedResponse.text();
    assert.equal(exportedResponse.status, 200);
    assert.doesNotMatch(exported, /\.fetch_url=/);
    assert.match(exported, /^images\.\d+\.url=\/files\//m);
    assert.match(exported, /^images\.\d+\.key=products\/import\/gallery\//m);
    assert.match(exported, /^images\.\d+\.source_url=https:\/\/vendor\.example\//m);
    assert.match(exported, /^images\.\d+\.content_type=image\/webp$/m);
    assert.match(exported, /^images\.\d+\.bytes=31$/m);
    assert.match(exported, /^net_weight_g=8300$/m);
    assert.match(exported, /^options\.1\.package_weight_g=13000$/m);
    assert.match(exported, /^variants\.1\.package_weight_g=15000$/m);
    assert.deepEqual(parseTemplate(exported).errors, []);

    const fetchesBeforeReimport = fetched.length;
    const reapplied = await apply(app, exported, 'update');
    assert.equal(reapplied.response.status, 200, JSON.stringify(reapplied.body));
    assert.equal(fetched.length, fetchesBeforeReimport, 'an exported local URL/source_url never triggers a refetch');
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', productId), 9);

    const partial = `template_version=2
product_id=${productId}
width_mm=__NULL__
options.1.id=opt_a1
options.1.name_en=A1
options.1.package_width_mm=__NULL__
colors.1.id=col_black
colors.1.name_en=Black
colors.1.package_weight_g=__NULL__
variants.1.id=var_a1_black
variants.1.package_weight_g=__NULL__
`;
    const patched = await apply(app, partial, 'update');
    assert.equal(patched.response.status, 200, JSON.stringify(patched.body));
    assert.deepEqual(
      row(raw, 'SELECT net_weight_g, width_mm FROM products WHERE id = ?', productId),
      { net_weight_g: 8300, width_mm: null },
      'an omitted product measurement is preserved and __NULL__ clears'
    );
    assert.deepEqual(
      row(raw, 'SELECT package_weight_g, package_width_mm FROM product_option_values WHERE id = ?', 'opt_a1'),
      { package_weight_g: 13000, package_width_mm: null },
      'an omitted option override is preserved and __NULL__ clears'
    );
    assert.equal(row<{ package_weight_g: number | null }>(raw, 'SELECT package_weight_g FROM product_colors WHERE id = ?', 'col_black')?.package_weight_g, null);
    assert.equal(row<{ package_weight_g: number | null }>(raw, 'SELECT package_weight_g FROM product_variants WHERE id = ?', 'var_a1_black')?.package_weight_g, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('conversion failure queues every staged object for guarded cleanup and writes no product', async () => {
  const raw = freshDb();
  const bucket = new MemoryBucket();
  const failedMarkers = new Set([250]);
  const app = mountWithMedia(asD1(raw), bucket, imagesBinding(failedMarkers));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return new Response(url.endsWith('/bad.png') ? png(250) : png(8));
  }) as typeof fetch;
  try {
    const text = `template_version=2
slug=bad-conversion
name_en=Bad conversion
price_iqd=1000
images.1.fetch_url=https://vendor.example/good.png
images.2.fetch_url=https://vendor.example/bad.png
`;
    const result = await apply(app, text);
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, 'TEMPLATE_MEDIA_FETCH_FAILED');
    assert.equal(result.body.errors[0].key, 'images.2.fetch_url');
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 0);
    assert.equal(bucket.objects.size, 1, 'rollback is delayed so a concurrent apply can safely claim the content key');
    assert.equal(bucket.deletes.length, 0, 'template rollback never performs a racy inline R2 delete');
    const cleanup = row<{ state: string; reason: string; created_at: string; not_before: string }>(
      raw,
      `SELECT state, reason, created_at, not_before
         FROM media_cleanup_jobs
        WHERE object_key LIKE 'products/import/gallery/%'`
    );
    assert.equal(cleanup?.state, 'pending');
    assert.equal(cleanup?.reason, 'product_media_staging');
    assert.ok(cleanup?.not_before && cleanup.not_before > cleanup.created_at, 'rollback gets a future cleanup grace period');

    failedMarkers.clear();
    const retry = await apply(app, text);
    assert.equal(retry.response.status, 200, 'a media failure releases the apply fingerprint for a corrected retry');
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a product batch failure leaves no product and durably queues staged media cleanup', async () => {
  const raw: DatabaseSync = freshDb();
  const wrapped = failingD1(raw);
  wrapped.failing.failWhen = (statements) => statements.some((statement) => /INSERT INTO products\b/.test(statement.sql));
  const bucket = new MemoryBucket();
  const app = mountWithMedia(wrapped.db, bucket, imagesBinding());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(png(9))) as typeof fetch;
  try {
    const text = `template_version=2
slug=db-failure-media
name_en=DB failure media
price_iqd=1000
images.1.fetch_url=https://vendor.example/staged.png
`;
    const result = await apply(app, text);
    assert.equal(result.response.status, 500);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 0);
    assert.equal(bucket.objects.size, 1, 'the staged object remains until the delayed cleanup worker rechecks references');
    assert.equal(bucket.deletes.length, 0, 'the request path only writes the durable cleanup job');
    assert.deepEqual(
      row(raw, `SELECT state, reason, CASE WHEN not_before > created_at THEN 1 ELSE 0 END AS delayed
                  FROM media_cleanup_jobs WHERE object_key LIKE 'products/import/gallery/%'`),
      { state: 'pending', reason: 'product_media_staging', delayed: 1 }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
