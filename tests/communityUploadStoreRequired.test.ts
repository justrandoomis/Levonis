/**
 * REVIEW W2-5 p3 — PUBLIC STORE MEDIA (purpose=community) NEEDS A STORE.
 *
 * purpose=community files are PUBLIC, 40 MB videos included, filed under
 * `merchants/<uploader>/public/`. Any signed-in account could store them. Now
 * the uploader must own a store (403 STORE_REQUIRED otherwise, nothing
 * stored), and one owner's live public videos may total at most
 * MERCHANT_PUBLIC_VIDEO_QUOTA_BYTES (1 GiB) — VIDEO_QUOTA_EXCEEDED beyond it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { uploadRoutes, MERCHANT_PUBLIC_VIDEO_QUOTA_BYTES } from '../worker/routes/uploads';
import { HttpError } from '../worker/lib/http';
import { freshDb, asD1 } from './fixtures/app';

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));
function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}
/** A minimal MP4 with a real H.264 video track (the shape `sniffVideo` accepts). */
function mp4(): Uint8Array {
  const stsd = box('stsd', [0, 0, 0, 0], u32(1), box('avc1', new Array(78).fill(0)));
  const trak = box('trak', box('mdia', box('hdlr', [0, 0, 0, 0], u32(0), ascii('vide'), new Array(12).fill(0)), box('minf', box('stbl', stsd))));
  return new Uint8Array([...box('ftyp', ascii('isom'), u32(512), ascii('isom')), ...box('moov', trak), ...box('mdat', new Array(64).fill(7))]);
}

function app(opts: { store: boolean }) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','U','u@x.co','h','customer')`);
  if (opts.store) {
    raw.exec(`INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','u1','U 3D');
              INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','u1','u3d','U 3D');`);
  }
  const objects = new Map<string, number>();
  const bucket = {
    async put(key: string, v: ArrayBuffer | ArrayBufferView) { objects.set(key, (v as ArrayBuffer).byteLength); },
    async get() { return null; }, async head() { return null; }, async delete() {},
  };
  const h = new Hono<AppContext>();
  h.use('*', async (c, next) => {
    c.env = { DB: asD1(raw), BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket } as never;
    c.set('user', { id: 'u1', role: 'customer' } as never);
    await next();
  });
  h.route('/api/uploads', uploadRoutes);
  h.onError((e, c) => (e instanceof HttpError ? c.json({ code: e.code, details: e.details }, e.status as 400) : Promise.reject(e)));
  const up = async (bytes: Uint8Array) => {
    const f = new FormData();
    f.set('purpose', 'community');
    f.set('file', new File([bytes as unknown as BlobPart], 'x.mp4', { type: 'video/mp4' }));
    const r = await h.request('/api/uploads', { method: 'POST', body: f });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { raw, up, objects };
}

test('an account WITHOUT a store cannot store public merchant media — 403 STORE_REQUIRED, nothing stored', async () => {
  const { up, objects } = app({ store: false });
  const r = await up(mp4());
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'STORE_REQUIRED');
  assert.equal(objects.size, 0);
});

test('a store owner still uploads a video under their own public prefix', async () => {
  const { up, objects } = app({ store: true });
  const r = await up(mp4());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(String(r.body.key), /^merchants\/u1\/public\/.+\.mp4$/);
  assert.equal(objects.size, 1);
});

test('the per-owner public video quota refuses the upload that would pass it — VIDEO_QUOTA_EXCEEDED', async () => {
  const { raw, up, objects } = app({ store: true });
  assert.equal(MERCHANT_PUBLIC_VIDEO_QUOTA_BYTES, 1024 * 1024 * 1024);
  // The owner already holds 1 GiB − 10 bytes of live public video …
  raw.prepare(
    `INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size)
     VALUES ('merchants/u1/public/old.mp4','public','merchants','u1','u1','video/mp4',?)`
  ).run(MERCHANT_PUBLIC_VIDEO_QUOTA_BYTES - 10);
  const r = await up(mp4());
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'VIDEO_QUOTA_EXCEEDED');
  assert.equal((r.body.details as { limit_bytes: number }).limit_bytes, MERCHANT_PUBLIC_VIDEO_QUOTA_BYTES);
  assert.equal(objects.size, 0);
  // … a video the sweep dated deleted no longer counts.
  raw.exec(`UPDATE file_objects SET deleted_at = '2026-01-01T00:00:00Z' WHERE object_key = 'merchants/u1/public/old.mp4'`);
  assert.equal((await up(mp4())).status, 200);
});
