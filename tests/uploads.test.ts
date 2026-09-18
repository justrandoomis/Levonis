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
  /**
   * A conversation the admin is in, because a chat upload is now filed under
   * the CHAT and refused outright for anyone who is not a participant — the
   * key names the conversation, so the server has to be able to check it.
   */
  raw.exec("INSERT INTO chats (id) VALUES ('chat_1')");
  raw.exec("INSERT INTO chat_participants (chat_id,user_id) VALUES ('chat_1','admin')");
  return new SqliteD1(raw) as unknown as D1Database;
}

/**
 * The Cloudflare Images binding, stubbed at its real shape.
 *
 * `input(stream).output({ format })` → something with `.response()`. The stub
 * returns a real WebP magic-number header so the rest of the pipeline — the
 * sniffer, the dimension reader, the stored contentType — is exercised on bytes
 * that genuinely ARE WebP rather than on a promise that they are.
 */
function imagesBinding(opts: { fail?: boolean } = {}) {
  const calls: Array<{ format: string }> = [];
  const binding = {
    input(stream: ReadableStream) {
      void stream;
      return {
        async output(o: { format: string }) {
          calls.push({ format: o.format });
          if (opts.fail) throw new Error('the converter refused this image');
          // A real WebP with a readable VP8X header, because the route measures
          // the image it is about to STORE — not the one that arrived. A stub
          // that returned shapeless bytes would let a converter that destroys
          // an image pass this suite.
          return { response: () => new Response(webp(640, 480)) };
        },
      };
    },
  };
  return { binding, calls };
}

function app(session: boolean, images?: ReturnType<typeof imagesBinding>['binding']) {
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const legacyBucket = new MemoryBucket();
  const hono = new Hono<AppContext>();
  hono.use('*', async (c, next) => {
    c.env = { DB: database(), BUCKET: legacyBucket, R2_PUBLIC: publicBucket, R2_PRIVATE: privateBucket, IMAGES: images } as never;
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
 * THE CONVERSION MOVED TO THE SERVER, AND THESE TESTS MOVED WITH IT.
 *
 * An earlier version of this file asserted that a PNG is ACCEPTED, because the
 * browser was supposed to have converted it. A later one asserted that a PNG is
 * REFUSED, because the browser could not be trusted to. Both were the same
 * mistake from opposite ends: they made the visitor's device decide the format
 * of what this shop stores.
 *
 * `env.IMAGES` takes the bytes the Worker is already holding and returns WebP
 * the same way for every device and every browser. So the contract is now the
 * only one that was ever wanted: whatever arrives, WebP is what is stored.
 */
test('A PNG IS CONVERTED ON THE SERVER — the browser is not consulted', async () => {
  const images = imagesBinding();
  const { hono, publicBucket } = app(true, images.binding);
  const png = new Uint8Array(32);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  png.set([0, 0, 2, 128], 16);
  png.set([0, 0, 1, 224], 20);
  const form = new FormData();
  form.set('purpose', 'product');
  form.set('file', new File([png], 'catalog.png', { type: 'image/png' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  const body = await response.json() as { mime: string; key: string; width: number };
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.mime, 'image/webp', 'the STORED type, not the uploaded one');
  assert.match(body.key, /\.webp$/, 'and the key may not disagree with the bytes');
  // Measured on the CONVERTED bytes: the dimensions recorded in the database
  // describe the file that is actually in the bucket.
  assert.equal(body.width, 640);
  assert.deepEqual(images.calls, [{ format: 'image/webp' }], 'the server did the converting');
  assert.equal(publicBucket.objects.size, 1);
  const stored = publicBucket.objects.get(body.key);
  assert.equal(stored?.metadata.contentType, 'image/webp', 'and R2 serves it as WebP too');
});

test('a JPEG is converted on EVERY purpose — chats and receipts included', async () => {
  for (const purpose of ['product', 'chat', 'receipt', 'avatar', 'community']) {
    const images = imagesBinding();
    const { hono } = app(true, images.binding);
    const jpeg = new Uint8Array(32);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
    const form = new FormData();
    form.set('purpose', purpose);
    // A chat upload names its conversation: the file is filed under the chat.
    if (purpose === 'chat') form.set('entity_id', 'chat_1');
    form.set('file', new File([jpeg], 'photo.jpg', { type: 'image/jpeg' }));
    const response = await hono.request('/api/uploads', { method: 'POST', body: form });
    const body = await response.json() as { mime?: string };
    assert.equal(response.status, 200, `${purpose}: ${JSON.stringify(body)}`);
    assert.equal(body.mime, 'image/webp', `${purpose} must be stored as WebP`);
  }
});

/**
 * A CHAT FILE BELONGS TO THE CONVERSATION — the owner chose that ordering so
 * one thread's pictures sit in one folder («الثاني الاسهل في فتح المحادثه»),
 * and it is the stronger rule as well as the tidier one: access becomes one
 * question with one answer instead of an uploader-prefix shortcut beside a
 * message lookup that could disagree with it.
 */
test('a chat upload is filed under the CHAT, not under whoever sent it', async () => {
  const images = imagesBinding();
  const { hono, privateBucket } = app(true, images.binding);
  const jpeg = new Uint8Array(32);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
  const form = new FormData();
  form.set('purpose', 'chat');
  form.set('entity_id', 'chat_1');
  form.set('file', new File([jpeg], 'photo.jpg', { type: 'image/jpeg' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  const body = await response.json() as { key: string };
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.key.split('/')[1], 'chat_1', 'the conversation names the folder');
  assert.match(body.key, /^chat\/chat_1\/attachments\/[a-z0-9]+\.webp$/, 'four segments, converted');
  assert.equal(privateBucket.objects.size, 1, 'and it is private');
});

test('a chat you are not in cannot be written to — checked before a byte is stored', async () => {
  const images = imagesBinding();
  const { hono, privateBucket } = app(true, images.binding);
  const jpeg = new Uint8Array(32);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
  const form = new FormData();
  form.set('purpose', 'chat');
  form.set('entity_id', 'chat_someone_else');
  form.set('file', new File([jpeg], 'photo.jpg', { type: 'image/jpeg' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  assert.equal(response.status, 403);
  assert.equal(privateBucket.objects.size, 0, 'nothing reached the bucket');
});

test('a conversation carries video too — it used to answer «Videos are not allowed here»', async () => {
  const images = imagesBinding();
  const { hono, privateBucket } = app(true, images.binding);
  // An MP4 by magic bytes: ....ftyp
  const mp4 = new Uint8Array(32);
  mp4.set([0x00, 0x00, 0x00, 0x18], 0);
  mp4.set([0x66, 0x74, 0x79, 0x70], 4);
  const form = new FormData();
  form.set('purpose', 'chat');
  form.set('entity_id', 'chat_1');
  form.set('file', new File([mp4], 'clip.mp4', { type: 'video/mp4' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  const body = await response.json() as { key: string; mime: string };
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.mime, 'video/mp4', 'a video is stored as itself — one frame is not the video');
  assert.match(body.key, /^chat\/chat_1\/video\//, 'and it is filed as video, beside the pictures');
  assert.equal(privateBucket.objects.size, 1);
  assert.deepEqual(images.calls, [], 'the converter is never asked to re-encode a video');
});

/**
 * WITHOUT THE BINDING IT REFUSES, and that is the whole reason this is not a
 * "best effort" conversion. Storing the original would put a JPEG in the
 * catalogue that something downstream calls a WebP — the exact defect the whole
 * change exists to remove — and it would be invisible until somebody read the
 * database. A 503 naming the missing entitlement is visible immediately and
 * tells the operator what to do.
 */
test('with NO Images binding the upload is refused, never silently stored as-is', async () => {
  const { hono, publicBucket } = app(true); // no binding
  const png = new Uint8Array(32);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  const form = new FormData();
  form.set('purpose', 'product');
  form.set('file', new File([png], 'catalog.png', { type: 'image/png' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  const body = await response.json() as { code?: string };
  assert.equal(response.status, 503);
  assert.equal(body.code, 'IMAGE_CONVERT_UNAVAILABLE');
  assert.equal(publicBucket.objects.size, 0, 'and nothing reached the bucket');
});

test('a converter that throws is reported, not swallowed', async () => {
  const images = imagesBinding({ fail: true });
  const { hono, publicBucket } = app(true, images.binding);
  const jpeg = new Uint8Array(32);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
  const form = new FormData();
  form.set('purpose', 'product');
  form.set('file', new File([jpeg], 'photo.jpg', { type: 'image/jpeg' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { code?: string }).code, 'IMAGE_CONVERT_FAILED');
  assert.equal(publicBucket.objects.size, 0);
});

test('an image ALREADY WebP is stored untouched — no pointless re-encode', async () => {
  const images = imagesBinding();
  const { hono } = app(true, images.binding);
  const form = new FormData();
  form.set('purpose', 'product');
  form.set('file', new File([webp()], 'printer.webp', { type: 'image/webp' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { mime: string }).mime, 'image/webp');
  assert.deepEqual(images.calls, [], 'the converter was never called');
});

test('a GIF is still accepted, and that exception is deliberate', async () => {
  // A transform keeps ONE frame, so re-encoding an animated GIF would throw the
  // animation away — the same quiet damage as the fake conversion, pointing the
  // other way. It is stored honestly under its own type, and the converter is
  // never even asked.
  const images = imagesBinding();
  const { hono, publicBucket } = app(true, images.binding);
  const gif = new Uint8Array(32);
  gif.set([0x47, 0x49, 0x46, 0x38], 0);
  const form = new FormData();
  form.set('purpose', 'product');
  form.set('file', new File([gif], 'spin.gif', { type: 'image/gif' }));
  const response = await hono.request('/api/uploads', { method: 'POST', body: form });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { mime: string }).mime, 'image/gif');
  assert.equal(publicBucket.objects.size, 1);
  assert.deepEqual(images.calls, [], 'an animated format is never re-encoded');
});

test('public media resolves anonymously while a private namespace never does', async () => {
  const { hono, publicBucket, privateBucket } = app(false);
  await publicBucket.put('products/p1/gallery/a.webp', webp(), { httpMetadata: { contentType: 'image/webp' } });
  await privateBucket.put('receipts/u1/evidence/a.webp', webp(), { httpMetadata: { contentType: 'image/webp' } });
  assert.equal((await hono.request('/files/products/p1/gallery/a.webp')).status, 200);
  assert.equal((await hono.request('/files/receipts/u1/evidence/a.webp')).status, 403);
});

