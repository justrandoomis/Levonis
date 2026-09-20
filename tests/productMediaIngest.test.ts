import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardedFetchBytes } from '../worker/lib/fetchGuard';
import { runGuardedMediaCleanup } from '../worker/lib/mediaRefs';
import {
  cleanupCreatedProductMedia,
  ingestProductMediaBytes,
  ingestProductMediaUrl,
  PRODUCT_MEDIA_CLEANUP_GRACE_MINUTES,
  ProductMediaIngestError,
  verifyStoredProductMedia,
} from '../worker/lib/productMediaIngest';
import { asD1, count, freshDb, row } from './fixtures/app';

function webp(width = 640, height = 480): Uint8Array {
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

function png(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

function gif(frames: number): Uint8Array {
  const out: number[] = [
    ...new TextEncoder().encode('GIF89a'),
    1, 0, 1, 0, // logical width/height
    0, 0, 0, // no global colour table
  ];
  const frame = [
    0x2c,
    0, 0, 0, 0, // left/top
    1, 0, 1, 0, // width/height
    0, // no local colour table
    2, // LZW minimum code size
    2, 0x4c, 0x01, 0, // one data sub-block, terminator
  ];
  for (let i = 0; i < frames; i++) out.push(...frame);
  out.push(0x3b);
  return new Uint8Array(out);
}

function avif(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0, 0, 0, 24], 0);
  bytes.set(new TextEncoder().encode('ftyp'), 4);
  bytes.set(new TextEncoder().encode('avif'), 8);
  bytes.set(new TextEncoder().encode('avif'), 16);
  return bytes;
}

class MemoryBucket {
  objects = new Map<string, Uint8Array>();
  puts = 0;
  deletes: string[] = [];
  failDelete = false;
  afterPut: ((key: string) => void) | null = null;

  async head(key: string) {
    const value = this.objects.get(key);
    return value ? ({ key, size: value.byteLength } as unknown as R2Object) : null;
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      key,
      size: value.byteLength,
      body: new Blob([value]).stream(),
      arrayBuffer: () => new Blob([value]).arrayBuffer(),
      httpMetadata: { contentType: 'image/webp' },
    } as unknown as R2ObjectBody;
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: R2PutOptions) {
    if (options?.onlyIf && this.objects.has(key)) return null;
    const view = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, view.slice());
    this.puts += 1;
    this.afterPut?.(key);
    return { key, size: view.byteLength } as unknown as R2Object;
  }

  async delete(key: string) {
    this.deletes.push(key);
    if (this.failDelete) throw new Error('R2 delete unavailable');
    this.objects.delete(key);
  }
}

class MemoryDb {
  cleanupJobs: Array<{ id: string; key: string; reason: string; error: string; state: 'pending' }> = [];
  cleanupDeferrals: string[] = [];
  references = new Set<string>();
  guards = new Map<string, { claim_token: string; protected: number }>();
  metadataFails = false;
  missingNotBefore = false;

  prepare(sql: string) {
    const statement = {
      all: async () => {
        if (/PRAGMA table_info\("media_object_guards"\)/.test(sql)) {
          return { results: ['object_key', 'protected_until', 'claim_token', 'claim_until'].map((name) => ({ name })) };
        }
        return { results: [] };
      },
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (this.missingNotBefore && sql.includes('not_before')) {
            throw new Error('table media_cleanup_jobs has no column named not_before');
          }
          if (sql.includes('INSERT INTO media_object_guards')) {
            const key = String(values[0]);
            const current = this.guards.get(key);
            if (!current || current.claim_token === '') this.guards.set(key, { claim_token: '', protected: 1 });
            return { success: true, meta: { changes: 1 } };
          }
          if (this.metadataFails && sql.includes('file_objects')) throw new Error('D1 metadata unavailable');
          if (sql.includes('UPDATE media_cleanup_jobs')) {
            this.cleanupDeferrals.push(String(values.at(-1)));
          }
          if (sql.includes('media_cleanup_jobs')) {
            if (sql.includes('UPDATE media_cleanup_jobs')) return { success: true };
            const key = String(values[1]);
            if (!this.cleanupJobs.some((job) => job.key === key && job.state === 'pending')) {
              this.cleanupJobs.push({
                id: String(values[0]),
                key,
                reason: String(values[2]),
                error: String(values[3]),
                state: 'pending',
              });
            }
          }
          return { success: true };
        },
        first: async () => {
          if (sql.includes('FROM media_object_guards')) return this.guards.get(String(values[0])) ?? null;
          if (sql.includes('FROM media_cleanup_jobs')) {
            return this.cleanupJobs.find((job) => job.key === String(values[0]) && job.state === 'pending') ?? null;
          }
          return this.references.has(String(values[0])) ? { x: 1 } : null;
        },
      }),
    };
    return statement;
  }
}

function imagesBinding(output = webp(), options: { infoFails?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    binding: {
      async info(_stream: ReadableStream) {
        if (options.infoFails) throw new Error('decode failed');
        return { format: 'image/webp', fileSize: output.byteLength, width: 640, height: 480 };
      },
      input(_stream: ReadableStream) {
        return {
          async output(options: { format: string }) {
            calls.push(options.format);
            return { response: () => new Response(output) };
          },
        };
      },
    },
  };
}

function env(images?: unknown) {
  const db = new MemoryDb();
  const publicBucket = new MemoryBucket();
  const legacyBucket = new MemoryBucket();
  return {
    db,
    publicBucket,
    legacyBucket,
    value: {
      DB: db,
      BUCKET: legacyBucket,
      R2_PUBLIC: publicBucket,
      R2_PRIVATE: new MemoryBucket(),
      IMAGES: images,
    } as never,
  };
}

interface WriteFailureGate {
  fail: boolean;
  attempted: string[];
  when?: (sql: string) => boolean;
}

/** A D1 facade which keeps reads available but rejects every write after the gate closes. */
function gatedWrites(db: D1Database, gate: WriteFailureGate): D1Database {
  const isWrite = (sql: string) => /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(sql);
  const wrap = (inner: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const statement = {
      bind: (...values: unknown[]) => wrap(inner.bind(...values), sql),
      first: <T = Record<string, unknown>>(column?: string) =>
        column === undefined ? inner.first<T>() : inner.first<T>(column),
      all: <T = Record<string, unknown>>() => inner.all<T>(),
      run: async () => {
        if (isWrite(sql)) {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          gate.attempted.push(normalized);
          if (gate.fail && (!gate.when || gate.when(normalized))) {
            throw new Error('simulated total D1 write outage after R2 put');
          }
        }
        return inner.run();
      },
    };
    return statement as unknown as D1PreparedStatement;
  };
  return {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
  } as unknown as D1Database;
}

async function importKey(bytes: Uint8Array): Promise<string> {
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  return `products/import/gallery/${digest}.webp`;
}

test('a redirect to a private address is rejected before the second fetch', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  }) as unknown as typeof fetch;
  await assert.rejects(() => guardedFetchBytes('https://vendor.example/a.png', { maxBytes: 1024, fetcher }), /not allowed/i);
  assert.deepEqual(calls, ['https://vendor.example/a.png']);
});

test('remote HTML with an image content type is rejected before conversion or R2', async () => {
  const images = imagesBinding();
  const setup = env(images.binding);
  const fetcher = (async () => new Response('<!doctype html><title>nope</title>', {
    headers: { 'content-type': 'image/png' },
  })) as unknown as typeof fetch;
  await assert.rejects(
    () => ingestProductMediaUrl(setup.value, 'https://vendor.example/fake.png', { fetcher }),
    (error: unknown) => error instanceof ProductMediaIngestError && error.code === 'IMAGE_NOT_SUPPORTED'
  );
  assert.equal(images.calls.length, 0);
  assert.equal(setup.publicBucket.puts, 0);
});

test('final verified WebP bytes define the key, metadata, and dedupe result', async () => {
  const output = webp(1200, 800);
  const images = imagesBinding(output);
  const setup = env(images.binding);
  const first = await ingestProductMediaBytes(setup.value, { bytes: png(), source_url: 'https://vendor.example/a.png' });
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', output)).toString('hex');

  assert.equal(first.key, `products/import/gallery/${digest}.webp`);
  assert.deepEqual(
    {
      width: first.width,
      height: first.height,
      bytes: first.bytes,
      type: first.content_type,
      created: first.created_new,
    },
    { width: 1200, height: 800, bytes: output.byteLength, type: 'image/webp', created: true }
  );
  assert.deepEqual(setup.publicBucket.objects.get(first.key), output);

  const second = await ingestProductMediaBytes(setup.value, { bytes: png() });
  assert.equal(second.key, first.key);
  assert.equal(second.created_new, false);
  assert.equal(setup.publicBucket.puts, 1, 'preexisting content is never overwritten');
  assert.deepEqual(
    [...new Set(setup.db.cleanupDeferrals)],
    [first.key],
    'ingest renews any old pending cleanup claim before returning a deduplicated key'
  );
});

test('metadata index failure cannot hide ownership of a newly-created R2 object', async () => {
  const images = imagesBinding();
  const setup = env(images.binding);
  setup.db.metadataFails = true;
  const stored = await ingestProductMediaBytes(setup.value, { bytes: png() });
  assert.equal(stored.created_new, true, 'the caller still receives cleanup provenance');
  assert.equal(setup.publicBucket.objects.has(stored.key), true);
});

test('a cleanup intent is durable before R2 and recovers an orphan after every later D1 write fails', async () => {
  const raw = freshDb();
  const gate: WriteFailureGate = { fail: false, attempted: [] };
  const db = gatedWrites(asD1(raw), gate);
  const bucket = new MemoryBucket();
  const output = webp(901, 701);
  let intentSeenAtPut = false;
  bucket.afterPut = (key) => {
    intentSeenAtPut = count(
      raw,
      "SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE object_key = ? AND state = 'pending'",
      key
    ) === 1;
    gate.fail = true;
  };
  const value = {
    DB: db,
    BUCKET: bucket,
    R2_PUBLIC: bucket,
    R2_PRIVATE: new MemoryBucket(),
    IMAGES: imagesBinding(output).binding,
  } as never;

  const stored = await ingestProductMediaBytes(value, { bytes: png() });
  assert.equal(stored.created_new, true);
  assert.equal(intentSeenAtPut, true, 'the pending row exists before the bucket mutation returns');
  await assert.rejects(
    () => db.prepare("INSERT INTO products (id, name, slug, price_iqd) VALUES ('never_commits','x','never-commits',1)").run(),
    /total D1 write outage/
  );
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id='never_commits'"), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM file_objects WHERE object_key = ?', stored.key), 0);
  assert.deepEqual(
    row<{ state: string; reason: string; grace_minutes: number }>(
      raw,
      `SELECT state, reason,
              ROUND((julianday(not_before) - julianday(created_at)) * 1440) AS grace_minutes
         FROM media_cleanup_jobs WHERE object_key = ?`,
      stored.key
    ),
    {
      state: 'pending',
      reason: 'product_media_staging',
      grace_minutes: PRODUCT_MEDIA_CLEANUP_GRACE_MINUTES,
    },
    'internal staging keeps the short cleanup window'
  );

  // Time passes and D1 recovers. The global guarded drain can now prove there
  // is no product reference and remove the object from the durable pre-intent.
  gate.fail = false;
  raw.prepare("UPDATE media_cleanup_jobs SET not_before = '' WHERE object_key = ?").run(stored.key);
  raw.prepare("UPDATE media_object_guards SET protected_until = '' WHERE object_key = ?").run(stored.key);
  const cleanup = await runGuardedMediaCleanup({
    DB: asD1(raw),
    BUCKET: bucket,
    R2_PUBLIC: bucket,
    R2_PRIVATE: new MemoryBucket(),
  } as never);
  assert.deepEqual(cleanup.deleted, [stored.key]);
  assert.equal(bucket.objects.has(stored.key), false, 'the failed product write leaves no permanent R2 orphan');
  assert.equal(
    row<{ state: string }>(raw, 'SELECT state FROM media_cleanup_jobs WHERE object_key = ?', stored.key)?.state,
    'done'
  );
});

test('the pre-write intent preserves a key that another writer attaches before guarded cleanup', async () => {
  const raw = freshDb();
  const gate: WriteFailureGate = { fail: false, attempted: [] };
  const db = gatedWrites(asD1(raw), gate);
  const bucket = new MemoryBucket();
  const output = webp(902, 702);
  bucket.afterPut = () => { gate.fail = true; };
  const value = {
    DB: db,
    BUCKET: bucket,
    R2_PUBLIC: bucket,
    R2_PRIVATE: new MemoryBucket(),
    IMAGES: imagesBinding(output).binding,
  } as never;
  const stored = await ingestProductMediaBytes(value, { bytes: png() });

  // A concurrent request/database owner succeeds while the original request's
  // writes are unavailable. Cleanup must judge the live reference, not which
  // request won the conditional put.
  gate.fail = false;
  raw.prepare(
    `INSERT INTO products (id, name, slug, price_iqd, stock)
     VALUES ('concurrent_owner', 'Concurrent owner', 'concurrent-owner', 1000, 1)`
  ).run();
  raw.prepare(
    `INSERT INTO product_images
       (id, product_id, url, r2_key, sort_order, is_primary, width, height, bytes, content_type)
     VALUES ('concurrent_image', 'concurrent_owner', ?, ?, 0, 1, ?, ?, ?, 'image/webp')`
  ).run(stored.url, stored.key, stored.width, stored.height, stored.bytes);
  raw.prepare("UPDATE media_cleanup_jobs SET not_before = '' WHERE object_key = ?").run(stored.key);
  raw.prepare("UPDATE media_object_guards SET protected_until = '' WHERE object_key = ?").run(stored.key);

  const cleanup = await runGuardedMediaCleanup({
    DB: asD1(raw),
    BUCKET: bucket,
    R2_PUBLIC: bucket,
    R2_PRIVATE: new MemoryBucket(),
  } as never);
  assert.deepEqual(cleanup.still_referenced, [stored.key]);
  assert.deepEqual(cleanup.deleted, []);
  assert.equal(bucket.objects.has(stored.key), true);
  assert.equal(
    row<{ state: string }>(raw, 'SELECT state FROM media_cleanup_jobs WHERE object_key = ?', stored.key)?.state,
    'skipped_shared'
  );
});

test('a genuinely preexisting content-addressed object gets no destructive staging intent', async () => {
  const output = webp();
  const images = imagesBinding(output);
  const setup = env(images.binding);
  const key = await importKey(output);
  setup.publicBucket.objects.set(key, output);

  const stored = await ingestProductMediaBytes(setup.value, { bytes: png() });
  assert.equal(stored.key, key);
  assert.equal(stored.created_new, false);
  assert.equal(setup.publicBucket.puts, 0);
  assert.deepEqual(setup.db.cleanupJobs, [], 'preexisting ownership is never manufactured by ingest');
});

test('an unavailable cleanup ledger fails closed before the first R2 mutation', async () => {
  const raw = freshDb();
  const gate: WriteFailureGate = {
    fail: true,
    attempted: [],
    when: (sql) => /INSERT OR IGNORE INTO media_cleanup_jobs/i.test(sql),
  };
  const bucket = new MemoryBucket();
  const value = {
    DB: gatedWrites(asD1(raw), gate),
    BUCKET: bucket,
    R2_PUBLIC: bucket,
    R2_PRIVATE: new MemoryBucket(),
    IMAGES: imagesBinding().binding,
  } as never;

  await assert.rejects(
    () => ingestProductMediaBytes(value, { bytes: png() }),
    (error: unknown) => error instanceof ProductMediaIngestError && error.code === 'IMAGE_STORAGE_FAILED'
  );
  assert.equal(bucket.puts, 0);
  assert.equal(bucket.objects.size, 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM media_cleanup_jobs'), 0);
});

test('staging intent renews an old pending row and coexists with terminal history', async () => {
  const raw = freshDb();
  const bucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();

  const terminalOutput = webp(903, 703);
  const terminalKey = await importKey(terminalOutput);
  raw.prepare(
    `INSERT INTO media_cleanup_jobs
       (id, object_key, visibility, reason, source_product_id, state, attempts, last_error, not_before)
     VALUES ('terminal_history', ?, 'public', 'old_cleanup', '', 'done', 1, '', '')`
  ).run(terminalKey);
  const terminalStored = await ingestProductMediaBytes({
    DB: asD1(raw), BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: privateBucket,
    IMAGES: imagesBinding(terminalOutput).binding,
  } as never, { bytes: png() });
  assert.equal(terminalStored.key, terminalKey);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE object_key = ?', terminalKey), 2);
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE object_key = ? AND state = 'pending'", terminalKey),
    1,
    'terminal audit history cannot suppress the new pre-write intent'
  );

  const pendingOutput = webp(904, 704);
  const pendingKey = await importKey(pendingOutput);
  raw.prepare(
    `INSERT INTO media_cleanup_jobs
       (id, object_key, visibility, reason, source_product_id, state, attempts, last_error, not_before)
     VALUES ('old_pending', ?, 'public', 'old_cleanup', '', 'pending', 4, 'old failure',
             '2000-01-01T00:00:00.000Z')`
  ).run(pendingKey);
  await ingestProductMediaBytes({
    DB: asD1(raw), BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: privateBucket,
    IMAGES: imagesBinding(pendingOutput).binding,
  } as never, { bytes: png() });
  assert.deepEqual(
    row<{ n: number; attempts: number; delayed: number }>(
      raw,
      `SELECT COUNT(*) AS n, attempts,
              CASE WHEN not_before > strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END AS delayed
         FROM media_cleanup_jobs WHERE object_key = ? AND state = 'pending'`,
      pendingKey
    ),
    { n: 1, attempts: 0, delayed: 1 },
    'one renewed pending row owns the cleanup retry after the conditional put'
  );
});

test('the pre-0099 cleanup schema records intent through the created_at grace fallback', async () => {
  const images = imagesBinding();
  const setup = env(images.binding);
  setup.db.missingNotBefore = true;

  const stored = await ingestProductMediaBytes(setup.value, { bytes: png() });
  assert.equal(stored.created_new, true);
  assert.equal(setup.publicBucket.puts, 1);
  assert.equal(setup.db.cleanupJobs.length, 1);
  assert.equal(setup.db.cleanupJobs[0].key, stored.key);
  assert.equal(setup.db.cleanupJobs[0].reason, 'product_media_staging');
});

test('missing conversion and fake converter output fail closed with zero writes', async () => {
  const missing = env();
  await assert.rejects(
    () => ingestProductMediaBytes(missing.value, { bytes: png() }),
    (error: unknown) => error instanceof ProductMediaIngestError && error.code === 'IMAGE_CONVERT_UNAVAILABLE'
  );
  assert.equal(missing.publicBucket.puts, 0);

  const fake = env(imagesBinding(new TextEncoder().encode('<html>not webp</html>')).binding);
  await assert.rejects(
    () => ingestProductMediaBytes(fake.value, { bytes: png() }),
    (error: unknown) => error instanceof ProductMediaIngestError && error.code === 'IMAGE_CONVERT_FAILED'
  );
  assert.equal(fake.publicBucket.puts, 0);

  const fakeWebp = env(imagesBinding(webp(), { infoFails: true }).binding);
  await assert.rejects(
    () => ingestProductMediaBytes(fakeWebp.value, { bytes: webp() }),
    (error: unknown) => error instanceof ProductMediaIngestError && error.code === 'IMAGE_CONVERT_FAILED'
  );
  assert.equal(fakeWebp.publicBucket.puts, 0, 'a RIFF header without a successful decode is never stored');
});

test('stored product media verification refuses an absent R2 object', async () => {
  const images = imagesBinding();
  const setup = env(images.binding);
  await assert.rejects(
    () => verifyStoredProductMedia(setup.value, [
      { url: '/files/products/p1/gallery/missing.webp', r2_key: 'products/p1/gallery/missing.webp' },
    ]),
    (error: unknown) => error instanceof ProductMediaIngestError && error.code === 'IMAGE_REFERENCE_MISSING'
  );
  assert.equal(setup.db.guards.size, 0, 'an invalid reference must not postpone cleanup');
  assert.deepEqual(setup.db.cleanupDeferrals, []);
});

test('stored product media requires the canonical lowercase .webp suffix', async () => {
  const images = imagesBinding();
  const setup = env(images.binding);
  const key = 'products/p1/gallery/upper.WEBP';
  setup.publicBucket.objects.set(key, webp());
  await assert.rejects(
    () => verifyStoredProductMedia(setup.value, [{ url: `/files/${key}`, key }]),
    (error: unknown) => error instanceof ProductMediaIngestError && error.code === 'IMAGE_REFERENCE_INVALID'
  );
  assert.equal(setup.db.guards.size, 0);
});

test('stored product media verification reads bytes and rejects a renamed fake WebP', async () => {
  const images = imagesBinding();
  const setup = env(images.binding);
  const key = 'products/p1/gallery/renamed.webp';
  // R2 says image/webp and the key says .webp; the body is still PNG.
  setup.publicBucket.objects.set(key, png());
  await assert.rejects(
    () => verifyStoredProductMedia(setup.value, [{ url: `/files/${key}`, key }]),
    (error: unknown) => error instanceof ProductMediaIngestError && error.code === 'IMAGE_REFERENCE_INVALID'
  );
  assert.equal(setup.db.guards.size, 0, 'fake bytes must not acquire a cleanup protection');
  assert.deepEqual(setup.db.cleanupDeferrals, []);
});

test('stored verification re-reads after protection and refuses an object cleanup removed in between', async () => {
  const images = imagesBinding();
  const setup = env(images.binding);
  const key = 'products/p1/gallery/raced.webp';
  setup.publicBucket.objects.set(key, webp());
  const get = setup.publicBucket.get.bind(setup.publicBucket);
  let reads = 0;
  setup.publicBucket.get = async (requested: string) => {
    reads += 1;
    if (reads === 2) return null;
    return get(requested);
  };

  await assert.rejects(
    () => verifyStoredProductMedia(setup.value, [{ url: `/files/${key}`, key }]),
    (error: unknown) => error instanceof ProductMediaIngestError && error.code === 'IMAGE_REFERENCE_MISSING'
  );
  assert.equal(reads, 2, 'the post-CAS object is authoritative');
});

test('stored product media verification accepts only a present, decodable WebP', async () => {
  const images = imagesBinding();
  const setup = env(images.binding);
  const key = 'products/p1/gallery/real.webp';
  const bytes = webp();
  setup.publicBucket.objects.set(key, bytes);

  const verified = await verifyStoredProductMedia(setup.value, [
    { url: `/files/${key}`, key, r2_key: key },
    // Duplicate references are decoded once and return one canonical result.
    { url: `/files/${key}`, r2_key: key },
  ]);
  assert.deepEqual(verified, [{
    key,
    url: `/files/${key}`,
    width: 640,
    height: 480,
    bytes: bytes.byteLength,
    content_type: 'image/webp',
  }]);

  await assert.rejects(
    () => verifyStoredProductMedia(setup.value, [{ url: `/files/${key}`, key, r2_key: 'products/p1/gallery/other.webp' }]),
    (error: unknown) => error instanceof ProductMediaIngestError && error.code === 'IMAGE_REFERENCE_INVALID'
  );
});

test('stored product media verification enforces a content-addressed key checksum', async () => {
  const images = imagesBinding();
  const setup = env(images.binding);
  const original = webp(640, 480);
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', original)).toString('hex');
  const key = `products/import/gallery/${digest}.webp`;

  setup.publicBucket.objects.set(key, original);
  await verifyStoredProductMedia(setup.value, [{ url: `/files/${key}`, key }]);

  // Still WebP and still decodable, but no longer the bytes named by the key.
  setup.publicBucket.objects.set(key, webp(320, 240));
  await assert.rejects(
    () => verifyStoredProductMedia(setup.value, [{ url: `/files/${key}`, key }]),
    (error: unknown) => error instanceof ProductMediaIngestError &&
      error.code === 'IMAGE_REFERENCE_INVALID' && /checksum/i.test(error.message)
  );
});

test('a static GIF is converted, while an animated GIF is explicitly refused', async () => {
  const images = imagesBinding();
  const setup = env(images.binding);
  const stored = await ingestProductMediaBytes(setup.value, { bytes: gif(1) });
  assert.equal(stored.content_type, 'image/webp');
  assert.deepEqual(images.calls, ['image/webp']);

  await assert.rejects(
    () => ingestProductMediaBytes(setup.value, { bytes: gif(2) }),
    (error: unknown) => error instanceof ProductMediaIngestError && error.code === 'IMAGE_ANIMATED_GIF'
  );
});

test('a static AVIF product image is converted and stored only as verified WebP', async () => {
  const images = imagesBinding();
  const setup = env(images.binding);
  const stored = await ingestProductMediaBytes(setup.value, { bytes: avif() });
  assert.equal(stored.content_type, 'image/webp');
  assert.match(stored.key, /\.webp$/);
  assert.deepEqual(images.calls, ['image/webp']);
  assert.deepEqual(setup.publicBucket.objects.get(stored.key), webp());
});

test('cleanup preserves preexisting objects and only queues delayed cleanup for newly-created objects', async () => {
  const setup = env();
  const key = 'products/import/gallery/abc.webp';
  setup.publicBucket.objects.set(key, webp());

  await cleanupCreatedProductMedia(setup.value, [{ key, created_new: false }]);
  assert.equal(setup.publicBucket.objects.has(key), true);
  assert.deepEqual(setup.publicBucket.deletes, []);

  await cleanupCreatedProductMedia(setup.value, [{ key, created_new: true }]);
  // A successful concurrent apply can attach this content-addressed key after
  // rollback returns. Inline SELECT -> delete would race that commit; durable
  // grace leaves the bytes in place until the guarded worker rechecks.
  setup.db.references.add(key);
  assert.equal(setup.publicBucket.objects.has(key), true);
  assert.deepEqual(setup.publicBucket.deletes, [], 'rollback never deletes R2 inline');
  assert.equal(setup.db.cleanupJobs.length, 1);
  assert.deepEqual(
    { key: setup.db.cleanupJobs[0].key, reason: setup.db.cleanupJobs[0].reason },
    { key, reason: 'template_apply_rollback' }
  );
});
