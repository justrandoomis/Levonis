import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminRoutes } from '../worker/routes/admin';
import { asD1, count, freshDb, get, json, post, send, stubApp } from './fixtures/app';

const ADMIN = { id: 'legacy_media_admin', role: 'admin' as const, email: 'legacy-media@x.co', admin_scope: 'full' };

class RecordingBucket {
  readonly objects = new Set<string>();
  readonly deleted: string[] = [];
  readonly fail = new Set<string>();
  reads = 0;

  async get(_key: string) {
    this.reads += 1;
    return null;
  }

  async head(_key: string) {
    this.reads += 1;
    return null;
  }

  async delete(key: string) {
    if (this.fail.has(key)) throw new Error('R2 unavailable');
    this.objects.delete(key);
    this.deleted.push(key);
  }
}

function setup() {
  const raw = freshDb();
  const bucket = new RecordingBucket();
  const app = stubApp(
    asD1(raw),
    ADMIN,
    (router) => router.route('/api/admin', adminRoutes),
    { env: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket } }
  );
  return { raw, bucket, app };
}

const base = (id: string) => ({ id, slug: id, name: 'Legacy media gate', price_iqd: 100_000 });

for (const scenario of [
  {
    name: 'external hotlink',
    field: 'images',
    value: ['https://vendor.example/catalog/a.jpg'],
  },
  {
    name: 'missing local WebP',
    field: 'images',
    value: ['/files/products/legacy/missing.webp'],
  },
  {
    name: 'fake local media claim',
    field: 'media',
    value: [{ url: '/files/products/legacy/fake.webp', key: 'products/legacy/fake.webp', content_type: 'image/webp' }],
  },
  {
    name: 'relation envelope',
    field: 'relations',
    value: { images: [{ url: '/files/products/legacy/relation.webp' }] },
  },
  {
    name: 'missing local specification diagram',
    field: 'specifications',
    value: [{ name: 'Dimensions', rows: [{ label: 'Plan', image: '/files/products/legacy/missing-spec.webp' }] }],
  },
  {
    name: 'external store artwork',
    field: 'stores',
    value: [{ name: 'Vendor', image: 'https://vendor.example/store/banner.jpg' }],
  },
] as const) {
  test(`legacy product POST rejects ${scenario.name} with no product, media, or guard write`, async () => {
    const { raw, bucket, app } = setup();
    const id = `legacy_${scenario.field}`;
    const response = await post(app, '/api/admin/products', { ...base(id), [scenario.field]: scenario.value });
    const body = await json(response);

    assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(body));
    assert.equal(body.code, 'LEGACY_PRODUCT_STRUCTURE_UNSUPPORTED');
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products WHERE id = ?', id), 0);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', id), 0);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM media_object_guards'), 0);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM media_cleanup_jobs'), 0);
    assert.equal(bucket.reads, 0, 'the retired writer does not even probe caller-supplied media');
    assert.deepEqual(bucket.deleted, []);
  });
}

test('legacy scalar update preserves pre-relational media mirrors', async () => {
  const { raw, app } = setup();
  raw.prepare(
    `INSERT INTO products
       (id, slug, name, price_iqd, images, options, colors, description_images, how_to_use, specifications, stores)
     VALUES ('legacy_scalar', 'legacy-scalar', 'Before', 100000, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    JSON.stringify(['/files/products/legacy/scalar.webp']),
    JSON.stringify([{ id: 'old-option', image: '/files/products/legacy/option.webp' }]),
    JSON.stringify([{ id: 'old-color', image: '/files/products/legacy/color.webp' }]),
    JSON.stringify(['/files/products/legacy/body.webp']),
    'Keep /files/products/legacy/manual.webp',
    JSON.stringify([{ name: 'Plan', image: '/files/products/legacy/spec.webp' }]),
    JSON.stringify([{ name: 'Vendor', image: '/files/products/legacy/store.webp' }])
  );

  const response = await post(app, '/api/admin/products', {
    ...base('legacy_scalar'),
    slug: 'legacy-scalar',
    name: 'After',
    price_iqd: 125_000,
  });
  assert.equal(response.status, 200, JSON.stringify(await json(response)));

  const stored = raw.prepare(
    `SELECT name, price_iqd, images, options, colors, description_images, how_to_use, specifications, stores
       FROM products WHERE id = 'legacy_scalar'`
  ).get() as Record<string, unknown>;
  assert.equal(stored.name, 'After');
  assert.equal(stored.price_iqd, 125_000);
  assert.equal(stored.images, JSON.stringify(['/files/products/legacy/scalar.webp']));
  assert.equal(stored.options, JSON.stringify([{ id: 'old-option', image: '/files/products/legacy/option.webp' }]));
  assert.equal(stored.colors, JSON.stringify([{ id: 'old-color', image: '/files/products/legacy/color.webp' }]));
  assert.equal(stored.description_images, JSON.stringify(['/files/products/legacy/body.webp']));
  assert.equal(stored.how_to_use, 'Keep /files/products/legacy/manual.webp');
  assert.equal(stored.specifications, JSON.stringify([{ name: 'Plan', image: '/files/products/legacy/spec.webp' }]));
  assert.equal(stored.stores, JSON.stringify([{ name: 'Vendor', image: '/files/products/legacy/store.webp' }]));
});

test('legacy admin product reads overlay authoritative relations and never revive a stale mirror', async () => {
  const { raw, app } = setup();
  const canonicalId = 'legacy_read_canonical';
  const quarantineId = 'legacy_read_quarantine';
  const mirrorOnlyId = 'legacy_read_mirror_only';
  const staleCanonical = '/files/products/legacy-read/stale.webp';
  const staleQuarantine = '/files/products/legacy-read/quarantine-stale.webp';
  const staleMirrorOnly = '/files/products/legacy-read/mirror-only-stale.webp';
  const secondary = '/files/products/legacy-read/secondary.webp';
  const primary = '/files/products/legacy-read/primary.webp';

  insertProduct(raw, canonicalId);
  insertProduct(raw, quarantineId);
  insertProduct(raw, mirrorOnlyId);
  raw.prepare('UPDATE products SET images = ? WHERE id = ?').run(JSON.stringify([staleCanonical]), canonicalId);
  raw.prepare('UPDATE products SET images = ? WHERE id = ?').run(JSON.stringify([staleQuarantine]), quarantineId);
  raw.prepare('UPDATE products SET images = ? WHERE id = ?').run(JSON.stringify([staleMirrorOnly]), mirrorOnlyId);
  raw.prepare(
    `INSERT INTO product_images
       (id, product_id, url, r2_key, content_type, sort_order, is_primary)
     VALUES ('legacy_secondary', ?, ?, ?, 'image/webp', 0, 0),
            ('legacy_primary', ?, ?, ?, 'image/webp', 50, 1)`
  ).run(
    canonicalId,
    secondary,
    secondary.slice('/files/'.length),
    canonicalId,
    primary,
    primary.slice('/files/'.length)
  );
  raw.prepare(
    `INSERT INTO product_images
       (id, product_id, url, r2_key, source_url, is_primary, quarantined, quarantine_reason)
     VALUES ('legacy_quarantine', ?, '', '', 'https://bad.example/quarantined.jpg', 0, 1, 'external_or_unsafe_url')`
  ).run(quarantineId);

  const response = await get(app, '/api/admin/products');
  const body = await json(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  const products = body.products as Array<Record<string, unknown>>;
  const canonical = products.find((product) => product.id === canonicalId)!;
  const quarantined = products.find((product) => product.id === quarantineId)!;
  const mirrorOnly = products.find((product) => product.id === mirrorOnlyId)!;

  assert.deepEqual(canonical.images, [primary, secondary], 'primary ordering wins over relation sort order');
  assert.deepEqual(
    (canonical.media as Array<{ url: string }>).map((media) => media.url),
    [primary, secondary]
  );
  assert.deepEqual(quarantined.images, []);
  assert.deepEqual(quarantined.media, []);
  assert.deepEqual(mirrorOnly.images, []);
  assert.deepEqual(mirrorOnly.media, []);
  assert.equal(JSON.stringify(body).includes(staleCanonical), false);
  assert.equal(JSON.stringify(body).includes(staleQuarantine), false);
  assert.equal(JSON.stringify(body).includes(staleMirrorOnly), false);
  assert.equal(JSON.stringify(body).includes('bad.example'), false);

  // The adjacent scalar POST returns the same legacy wire shape and must not
  // re-expose the mirror it deliberately preserves in storage.
  const saved = await post(app, '/api/admin/products', {
    ...base(canonicalId),
    name: 'Canonical after scalar save',
  });
  const savedBody = await json(saved);
  assert.equal(saved.status, 200, JSON.stringify(savedBody));
  assert.deepEqual(savedBody.product.images, [primary, secondary]);
  assert.equal(JSON.stringify(savedBody).includes(staleCanonical), false);
});

function insertProduct(raw: ReturnType<typeof freshDb>, id: string, slug = id) {
  raw.prepare('INSERT INTO products (id, slug, name, price_iqd, status) VALUES (?, ?, ?, 100000, \'active\')')
    .run(id, slug, id);
}

function insertImage(raw: ReturnType<typeof freshDb>, productId: string, key: string, imageId = `${productId}_image`) {
  raw.prepare(
    `INSERT INTO product_images (id, product_id, url, r2_key, content_type, is_primary)
     VALUES (?, ?, ?, ?, 'image/webp', 1)`
  ).run(imageId, productId, `/files/${key}`, key);
}

test('legacy product DELETE uses the atomic deletion engine and closes its guarded cleanup job', async () => {
  const { raw, bucket, app } = setup();
  const key = 'products/legacy-delete/only.webp';
  insertProduct(raw, 'legacy_delete');
  insertImage(raw, 'legacy_delete', key);
  bucket.objects.add(key);

  const response = await send(app, 'DELETE', '/api/admin/products/legacy_delete');
  const body = await json(response);

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.product_deleted, true);
  assert.deepEqual(body.r2_objects_deleted, [key]);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id='legacy_delete'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id='legacy_delete'"), 0);
  assert.deepEqual(bucket.deleted, [key]);
  assert.equal(bucket.objects.has(key), false);

  const job = raw.prepare(
    'SELECT state, attempts, last_error FROM media_cleanup_jobs WHERE object_key = ?'
  ).get(key) as { state: string; attempts: number; last_error: string };
  assert.equal(job.state, 'done');
  assert.equal(job.attempts, 1);
  assert.equal(job.last_error, '');
  const guard = raw.prepare(
    'SELECT claim_token, claim_until FROM media_object_guards WHERE object_key = ?'
  ).get(key) as { claim_token: string; claim_until: string };
  assert.equal(guard.claim_token, '');
  assert.equal(guard.claim_until, '');
});

test('legacy product DELETE preserves a shared object and queues no cleanup for it', async () => {
  const { raw, bucket, app } = setup();
  const key = 'products/shared/legacy-delete.webp';
  insertProduct(raw, 'legacy_shared_a');
  insertProduct(raw, 'legacy_shared_b');
  insertImage(raw, 'legacy_shared_a', key, 'shared_a_image');
  insertImage(raw, 'legacy_shared_b', key, 'shared_b_image');
  bucket.objects.add(key);

  const response = await send(app, 'DELETE', '/api/admin/products/legacy_shared_a');
  const body = await json(response);

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.r2_objects_shared_skipped, [key]);
  assert.deepEqual(bucket.deleted, []);
  assert.equal(bucket.objects.has(key), true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE object_key = ?', key), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id='legacy_shared_b'"), 1);
});

test('legacy product DELETE keeps a failed R2 cleanup durable and releases its claim', async () => {
  const { raw, bucket, app } = setup();
  const key = 'products/legacy-delete/retry.webp';
  insertProduct(raw, 'legacy_retry');
  insertImage(raw, 'legacy_retry', key);
  bucket.objects.add(key);
  bucket.fail.add(key);

  const response = await send(app, 'DELETE', '/api/admin/products/legacy_retry');
  const body = await json(response);

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.product_deleted, true);
  assert.equal(body.r2_cleanup_pending, 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id='legacy_retry'"), 0);
  assert.equal(bucket.objects.has(key), true);
  const job = raw.prepare(
    'SELECT state, attempts, last_error FROM media_cleanup_jobs WHERE object_key = ?'
  ).get(key) as { state: string; attempts: number; last_error: string };
  assert.equal(job.state, 'pending');
  assert.equal(job.attempts, 1);
  assert.match(job.last_error, /R2 unavailable/);
  const guard = raw.prepare('SELECT claim_token FROM media_object_guards WHERE object_key = ?').get(key) as {
    claim_token: string;
  };
  assert.equal(guard.claim_token, '');
});

test('legacy product DELETE retains blocking-reference refusals', async () => {
  const { raw, bucket, app } = setup();
  const key = 'products/legacy-delete/blocked.webp';
  insertProduct(raw, 'legacy_member');
  insertProduct(raw, 'legacy_bundle');
  insertImage(raw, 'legacy_member', key);
  bucket.objects.add(key);
  raw.prepare(
    `INSERT INTO bundle_components (id, bundle_product_id, member_product_id, qty)
     VALUES ('bc_legacy', 'legacy_bundle', 'legacy_member', 1)`
  ).run();

  const response = await send(app, 'DELETE', '/api/admin/products/legacy_member');
  const body = await json(response);

  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'PRODUCT_IN_BUNDLE');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id='legacy_member'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id='legacy_member'"), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM media_cleanup_jobs'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM media_object_guards'), 0);
  assert.equal(bucket.objects.has(key), true);
  assert.deepEqual(bucket.deleted, []);
});
