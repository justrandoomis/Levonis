import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { fileRoutes, uploadRoutes } from '../worker/routes/uploads';
import { HttpError } from '../worker/lib/http';
import { ROOT, SqliteD1 } from './fixtures/d1';

class MemoryBucket {
  objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: Record<string, string> }) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value.slice(0))
      : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, { bytes, metadata: options?.httpMetadata ?? {} });
  }
  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: new Blob([stored.bytes as unknown as BlobPart]).stream(),
      size: stored.bytes.byteLength,
      httpEtag: `"${key}"`,
      httpMetadata: stored.metadata,
      writeHttpMetadata(headers: Headers) {
        if (stored.metadata.contentType) headers.set('Content-Type', stored.metadata.contentType);
        if (stored.metadata.cacheControl) headers.set('Cache-Control', stored.metadata.cacheControl);
      },
      arrayBuffer: () => new Blob([stored.bytes as unknown as BlobPart]).arrayBuffer(),
    };
  }
  async head(key: string) {
    const stored = this.objects.get(key);
    return stored ? { key, size: stored.bytes.byteLength } : null;
  }
  async delete(key: string) { this.objects.delete(key); }
}

function database(): D1Database {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(ROOT, 'migrations', file), 'utf8'));
  }
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('admin','Admin','a@x.test','h','admin')");
  return new SqliteD1(raw) as unknown as D1Database;
}

function app(session: boolean) {
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const legacyBucket = new MemoryBucket();
  const hono = new Hono<AppContext>();
  hono.use('*', async (c, next) => {
    c.env = { DB: database(), BUCKET: legacyBucket, R2_PUBLIC: publicBucket, R2_PRIVATE: privateBucket } as never;
    c.set('user', session ? ({ id: 'admin', role: 'admin' } as never) : null);
    await next();
  });
  hono.route('/api/uploads', uploadRoutes);
  hono.route('/files', fileRoutes);
  hono.onError((error, c) => error instanceof HttpError
    ? c.json({ success: false, code: error.code, error: error.message }, error.status as 400)
    : Promise.reject(error));
  return { hono, publicBucket, privateBucket, legacyBucket };
}

function webp(width = 640, height = 480): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const w = width - 1;
  const h = height - 1;
  b.set([w & 255, (w >>> 8) & 255, (w >>> 16) & 255], 24);
  b.set([h & 255, (h >>> 8) & 255, (h >>> 16) & 255], 27);
  return b;
}

test('an admin WebP product upload lands only in the public bucket with verified metadata', async () => {
  const { hono, publicBucket, privateBucket, legacyBucket } = app(true);
  const form = new FormData();
  form.set('purpose', 'product');
  form.set('file', new File([webp()], 'printer.webp', { type: 'image/png' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.mime, 'image/webp');
  assert.equal(body.width, 640);
  assert.equal(body.height, 480);
  assert.match(String(body.key), /^products\/catalog\/gallery\/[a-f0-9]+\.webp$/);
  assert.equal(publicBucket.objects.size, 1);
  assert.equal(privateBucket.objects.size, 0);
  assert.equal(legacyBucket.objects.size, 0);
});

/**
 * THIS TEST IS THE REVERSE OF THE ONE IT REPLACES, AND THAT IS THE POINT.
 *
 * The previous version asserted that a PNG is accepted "when browser-side WebP
 * conversion is unavailable". That acceptance is exactly what the owner
 * reported as «التحويل وهمي»: `canvas.toBlob(cb, 'image/webp')` is specified to
 * fall back to PNG on a runtime with no WebP encoder — silently, with a valid
 * Blob — so a failed conversion arrived here as an ordinary PNG, was sniffed
 * correctly, and was stored as PNG while every screen in between said it had
 * been converted.
 *
 * A rule that only exists in the browser is off for whoever has the browser it
 * does not work in. So the rule lives on the server, the client is no longer
 * allowed to fall back, and the two cannot disagree any more.
 */
test('a PNG is REFUSED — the conversion is the client`s job and the server is what proves it', async () => {
  const { hono, publicBucket } = app(true);
  const png = new Uint8Array(32);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  png.set([0, 0, 2, 128], 16); // 640 px
  png.set([0, 0, 1, 224], 20); // 480 px
  const form = new FormData();
  form.set('purpose', 'product');
  form.set('file', new File([png], 'catalog.png', { type: 'image/png' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  assert.equal(response.status, 400);
  const body = await response.json() as { code?: string; error?: string };
  assert.equal(body.code, 'IMAGE_NOT_WEBP');
  assert.equal(publicBucket.objects.size, 0, 'and nothing reached the bucket');
});

test('a JPEG is refused the same way, on EVERY purpose — chats and receipts included', async () => {
  for (const purpose of ['product', 'chat', 'receipt', 'avatar', 'community']) {
    const { hono, publicBucket, privateBucket } = app(true);
    const jpeg = new Uint8Array(32);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
    const form = new FormData();
    form.set('purpose', purpose);
    form.set('file', new File([jpeg], 'photo.jpg', { type: 'image/jpeg' }));
    const response = await hono.request('/api/uploads', { method: 'POST', body: form });
    assert.equal(response.status, 400, `${purpose} must refuse a JPEG`);
    assert.equal((await response.json() as { code?: string }).code, 'IMAGE_NOT_WEBP');
    assert.equal(publicBucket.objects.size + privateBucket.objects.size, 0, `${purpose} stored nothing`);
  }
});

test('a GIF is still accepted, and that exception is deliberate', async () => {
  // A canvas draws ONE frame, so re-encoding an animated GIF would throw the
  // animation away — the same quiet damage as the fake conversion, pointing the
  // other way. It is stored honestly under its own type.
  const { hono, publicBucket } = app(true);
  const gif = new Uint8Array(32);
  gif.set([0x47, 0x49, 0x46, 0x38], 0);
  const form = new FormData();
  form.set('purpose', 'product');
  form.set('file', new File([gif], 'spin.gif', { type: 'image/gif' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { mime: string }).mime, 'image/gif');
  assert.equal(publicBucket.objects.size, 1);
});

test('public media resolves anonymously while a private namespace never does', async () => {
  const { hono, publicBucket, privateBucket } = app(false);
  await publicBucket.put('products/p1/gallery/a.webp', webp(), { httpMetadata: { contentType: 'image/webp' } });
  await privateBucket.put('receipts/u1/evidence/a.webp', webp(), { httpMetadata: { contentType: 'image/webp' } });
  assert.equal((await hono.request('/files/products/p1/gallery/a.webp')).status, 200);
  assert.equal((await hono.request('/files/receipts/u1/evidence/a.webp')).status, 403);
});

