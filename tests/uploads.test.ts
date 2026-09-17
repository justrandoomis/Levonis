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

test('the server accepts a valid product PNG when browser-side WebP conversion is unavailable', async () => {
  const { hono, publicBucket } = app(true);
  const png = new Uint8Array(32);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  png.set([0, 0, 2, 128], 16); // 640 px
  png.set([0, 0, 1, 224], 20); // 480 px
  const form = new FormData();
  form.set('purpose', 'product');
  form.set('file', new File([png], 'catalog.png', { type: 'image/png' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  assert.equal(response.status, 200);
  const body = await response.json() as { mime: string; width: number; height: number; key: string };
  assert.equal(body.mime, 'image/png');
  assert.equal(body.width, 640);
  assert.equal(body.height, 480);
  assert.match(body.key, /^products\/catalog\/gallery\/[a-f0-9]+\.png$/);
  assert.equal(publicBucket.objects.size, 1);
});

test('public media resolves anonymously while a private namespace never does', async () => {
  const { hono, publicBucket, privateBucket } = app(false);
  await publicBucket.put('products/p1/gallery/a.webp', webp(), { httpMetadata: { contentType: 'image/webp' } });
  await privateBucket.put('receipts/u1/evidence/a.webp', webp(), { httpMetadata: { contentType: 'image/webp' } });
  assert.equal((await hono.request('/files/products/p1/gallery/a.webp')).status, 200);
  assert.equal((await hono.request('/files/receipts/u1/evidence/a.webp')).status, 403);
});

