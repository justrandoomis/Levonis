import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuardedMediaCleanup } from '../worker/lib/mediaRefs';
import { mediaRoutes } from '../worker/routes/media';
import { asD1, count, freshDb, json, post, row, stubApp } from './fixtures/app';

const ADMIN = { id: 'media_migration_admin', role: 'admin' as const, email: 'media-migration@x.co', admin_scope: null };
const OLD_KEY = 'products/legacy/gallery/source.png';

function png(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function webp(width = 321, height = 123): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 255, (w >>> 8) & 255, (w >>> 16) & 255], 24);
  bytes.set([h & 255, (h >>> 8) & 255, (h >>> 16) & 255], 27);
  return bytes;
}

interface StoredObject { bytes: Uint8Array; contentType: string }

class MemoryBucket {
  objects = new Map<string, StoredObject>();
  deletes: string[] = [];
  corruptNextWrite = false;
  nextContentType: string | null = null;
  afterPut: ((key: string) => void) | null = null;

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? ({ key, size: object.bytes.byteLength } as unknown as R2Object) : null;
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      size: object.bytes.byteLength,
      body: new Blob([object.bytes]).stream(),
      arrayBuffer: () => new Blob([object.bytes]).arrayBuffer(),
      httpMetadata: { contentType: object.contentType },
    } as unknown as R2ObjectBody;
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: R2PutOptions) {
    if (options?.onlyIf && this.objects.has(key)) return null;
    const input = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const bytes = this.corruptNextWrite ? png() : input.slice();
    this.corruptNextWrite = false;
    const metadata = options?.httpMetadata;
    const declaredType = metadata instanceof Headers ? metadata.get('content-type') : metadata?.contentType;
    this.objects.set(key, {
      bytes,
      contentType: this.nextContentType ?? declaredType ?? 'application/octet-stream',
    });
    this.nextContentType = null;
    this.afterPut?.(key);
    return { key, size: bytes.byteLength } as unknown as R2Object;
  }

  async delete(key: string) {
    this.deletes.push(key);
    this.objects.delete(key);
  }
}

interface WriteFailureGate {
  fail: boolean;
  attempted: string[];
}

class GatedStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    readonly sql: string,
    readonly gate: WriteFailureGate
  ) {}

  bind(...values: unknown[]) {
    return new GatedStatement(this.inner.bind(...values), this.sql, this.gate);
  }

  private rejectWrite(): void {
    if (!/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(this.sql)) return;
    this.gate.attempted.push(this.sql.replace(/\s+/g, ' ').trim());
    if (this.gate.fail) throw new Error('simulated total D1 write outage after R2 put');
  }

  run() {
    this.rejectWrite();
    return this.inner.run();
  }

  first<T = Record<string, unknown>>(column?: string) {
    this.rejectWrite();
    return column === undefined ? this.inner.first<T>() : this.inner.first<T>(column);
  }

  all<T = Record<string, unknown>>() {
    this.rejectWrite();
    return this.inner.all<T>();
  }
}

class GatedD1 {
  constructor(readonly inner: D1Database, readonly gate: WriteFailureGate) {}

  prepare(sql: string) {
    return new GatedStatement(this.inner.prepare(sql), sql, this.gate);
  }

  batch(statements: GatedStatement[]) {
    if (this.gate.fail) throw new Error('simulated total D1 write outage after R2 put');
    return this.inner.batch(statements.map((statement) => statement.inner));
  }
}

function imagesBinding(output: Uint8Array) {
  return {
    async info(_stream: ReadableStream) {
      return { format: 'image/webp', fileSize: output.byteLength, width: 321, height: 123 };
    },
    input(_stream: ReadableStream) {
      return {
        async output() {
          return { response: () => new Response(output) };
        },
      };
    },
  };
}

async function targetKey(output: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', output));
  const id = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
  return `products/p1/gallery/${id}.webp`;
}

function setup(dbFactory: (db: D1Database) => D1Database = (db) => db) {
  const raw = freshDb();
  raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, price_iqd, images, options, colors, description_images)
     VALUES ('p1','migration-product','Migration product','منتج',1000,'[]','[]','[]','[]')`
  ).run();
  raw.prepare(
    `INSERT INTO product_images (id, product_id, url, r2_key, content_type, width, height, bytes)
     VALUES ('img_old','p1',?,?,'image/png',9,9,32)`
  ).run(`/files/${OLD_KEY}`, OLD_KEY);

  const legacy = new MemoryBucket();
  legacy.objects.set(OLD_KEY, { bytes: png(), contentType: 'image/png' });
  const publicBucket = new MemoryBucket();
  const output = webp();
  const app = stubApp(
    dbFactory(asD1(raw)),
    ADMIN,
    (router) => router.route('/api/admin/media', mediaRoutes),
    { env: { BUCKET: legacy, R2_PUBLIC: publicBucket, R2_PRIVATE: new MemoryBucket(), IMAGES: imagesBinding(output) } }
  );
  return { raw, legacy, publicBucket, output, app };
}

test('migration refuses corrupted converted bytes and queues cleanup only for its newly-created object', async () => {
  const setupState = setup();
  setupState.publicBucket.corruptNextWrite = true;
  const response = await post(setupState.app, '/api/admin/media/migration/apply', { key: OLD_KEY, confirm: true });
  const body = await json(response);

  assert.equal(response.status, 503, JSON.stringify(body));
  assert.equal(body.code, 'MEDIA_VERIFY_FAILED');
  assert.deepEqual(
    row(setupState.raw, "SELECT url,r2_key,width,height,bytes FROM product_images WHERE id='img_old'"),
    { url: `/files/${OLD_KEY}`, r2_key: OLD_KEY, width: 9, height: 9, bytes: 32 },
    'no product row changes before byte verification'
  );
  const key = await targetKey(setupState.output);
  assert.equal(
    row<{ n: number }>(setupState.raw, "SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE object_key=? AND state='pending'", key)?.n,
    1,
    'a created object is recovered through the guarded queue, never a raw delete'
  );
  assert.deepEqual(setupState.publicBucket.deletes, []);
});

test('migration rejects wrong stored MIME without deleting or queueing a preexisting shared key', async () => {
  const setupState = setup();
  const key = await targetKey(setupState.output);
  setupState.publicBucket.objects.set(key, { bytes: setupState.output, contentType: 'image/png' });

  const response = await post(setupState.app, '/api/admin/media/migration/apply', { key: OLD_KEY, confirm: true });
  const body = await json(response);

  assert.equal(response.status, 503, JSON.stringify(body));
  assert.equal(body.code, 'MEDIA_VERIFY_FAILED');
  assert.equal(setupState.publicBucket.objects.has(key), true, 'preexisting bytes are never rollback-owned');
  assert.deepEqual(setupState.publicBucket.deletes, []);
  assert.equal(
    row<{ n: number }>(setupState.raw, "SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE object_key=? AND state='pending'", key)?.n,
    0,
    'created_new=false must not manufacture a destructive cleanup job'
  );
});

test('migration persists verifier-authoritative WebP metadata', async () => {
  const setupState = setup();
  const key = await targetKey(setupState.output);
  const response = await post(setupState.app, '/api/admin/media/migration/apply', { key: OLD_KEY, confirm: true });
  const body = await json(response);

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(
    row(setupState.raw, "SELECT url,r2_key,content_type,width,height,bytes FROM product_images WHERE id='img_old'"),
    {
      url: `/files/${key}`,
      r2_key: key,
      content_type: 'image/webp',
      width: 321,
      height: 123,
      bytes: setupState.output.byteLength,
    }
  );
});

test('migration conversion keeps a pre-R2 cleanup intent through a total later D1 outage', async () => {
  const gate: WriteFailureGate = { fail: false, attempted: [] };
  const setupState = setup((db) => new GatedD1(db, gate) as unknown as D1Database);
  const key = await targetKey(setupState.output);
  let intentSeenAtPut = false;
  setupState.publicBucket.afterPut = (writtenKey) => {
    intentSeenAtPut = writtenKey === key && count(
      setupState.raw,
      "SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE object_key = ? AND state = 'pending'",
      key
    ) === 1;
    gate.fail = true;
  };

  const response = await post(setupState.app, '/api/admin/media/migration/apply', { key: OLD_KEY, confirm: true });
  assert.equal(response.status, 500, await response.text());
  assert.equal(intentSeenAtPut, true, 'the cleanup ledger commits before the converted object is created');
  assert.equal(setupState.publicBucket.objects.has(key), true, 'the injected outage happens after a successful put');
  assert.deepEqual(
    row(setupState.raw, "SELECT url,r2_key,width,height,bytes FROM product_images WHERE id='img_old'"),
    { url: `/files/${OLD_KEY}`, r2_key: OLD_KEY, width: 9, height: 9, bytes: 32 },
    'every product-row write after the put was refused'
  );
  assert.deepEqual(
    row<{ state: string; reason: string }>(
      setupState.raw,
      'SELECT state, reason FROM media_cleanup_jobs WHERE object_key = ?',
      key
    ),
    { state: 'pending', reason: 'product_media_staging' }
  );

  // D1 recovers after the grace period. No product ever attached the new key,
  // so the global reference-safe worker can finish the pre-existing intent.
  gate.fail = false;
  setupState.raw.prepare("UPDATE media_cleanup_jobs SET not_before = '' WHERE object_key = ?").run(key);
  setupState.raw.prepare("UPDATE media_object_guards SET protected_until = '' WHERE object_key = ?").run(key);
  const cleanup = await runGuardedMediaCleanup({
    DB: asD1(setupState.raw),
    BUCKET: setupState.legacy,
    R2_PUBLIC: setupState.publicBucket,
    R2_PRIVATE: new MemoryBucket(),
  } as never);
  assert.deepEqual(cleanup.deleted, [key]);
  assert.equal(setupState.publicBucket.objects.has(key), false);
  assert.equal(
    row<{ state: string }>(setupState.raw, 'SELECT state FROM media_cleanup_jobs WHERE object_key = ?', key)?.state,
    'done'
  );
});
