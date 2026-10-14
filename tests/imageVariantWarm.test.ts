/**
 * A NEW PICTURE'S SMALL COPIES ARE CUT RIGHT AFTER ITS UPLOAD (worker/lib/imageVariants.ts
 * `scheduleVariantWarm`), so its first visitor reads them from R2 instead of
 * waiting for a cut.
 *
 * The four doors the owner uses each hand a warm-up to `waitUntil` after the
 * R2 write: a product picture (`POST /api/uploads` purpose=product), the public
 * upload purposes (avatar, community, post), a home photo or brand mark
 * (`POST /api/admin/site-media/:slot`) and a section picture
 * (`POST /api/admin/taxonomy/catalogs/:id/image`). Each makes the AVIF rungs up
 * to the picture's own width (`rungsFor`) and a `done` marker. A warm-up that
 * fails changes nothing about the upload's answer; a private, animated or
 * moving upload is never warmed.
 *
 * Run: node --import tsx --test tests/imageVariantWarm.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { asD1, ctx, freshDb, pending } from './fixtures/app';
import { R2Double, imagesDouble, webpBytes } from './fixtures/imageDoubles';
import { uploadRoutes } from '../worker/routes/uploads';
import { adminRoutes } from '../worker/routes/admin';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { rungsFor, warmImageVariants } from '../worker/lib/imageVariants';

function world(images = imagesDouble()) {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('admin','Admin','boss@x.co','h','admin')");
  raw.exec("INSERT INTO chats (id) VALUES ('chat_1')");
  raw.exec("INSERT INTO chat_participants (chat_id,user_id) VALUES ('chat_1','admin')");
  raw.exec("INSERT INTO community_merchants (id,user_id,name) VALUES ('m_admin','admin','Admin 3D')");
  raw.exec("INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s_admin','m_admin','admin','admin3d','Admin 3D')");
  const pub = new R2Double();
  const priv = new R2Double();
  const legacy = new R2Double();
  const db = asD1(raw);
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.env = { DB: db, BUCKET: legacy, R2_PUBLIC: pub, R2_PRIVATE: priv, IMAGES: images.binding, INITIAL_ADMIN_EMAIL: 'boss@x.co' } as never;
    c.set('user', { id: 'admin', role: 'admin', email: 'boss@x.co', admin_scope: null, username: 'admin', email_verified_at: '2026-01-01T00:00:00.000Z' } as never);
    c.set('sessionCreatedAt', new Date().toISOString());
    await next();
  });
  app.route('/api/uploads', uploadRoutes);
  app.route('/api/admin/taxonomy', adminTaxonomyRoutes);
  app.route('/api/admin', adminRoutes);
  app.onError((error, c) => (error instanceof HttpError
    ? c.json({ success: false, code: error.code, error: error.message }, error.status as 400)
    : c.json({ success: false, error: String(error) }, 500)));
  const send = async (path: string, form: FormData) => {
    const res = await app.request(path, { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
    const body = await res.json() as Record<string, unknown>;
    await Promise.all(pending.splice(0));
    return { res, body };
  };
  return { raw, pub, priv, legacy, images, send };
}

const file = (bytes: Uint8Array, name: string, type = 'image/webp') => new File([bytes as unknown as BlobPart], name, { type });
const formOf = (fields: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const avifRungs = (pub: R2Double, key: string) => pub.keys(`variants/v1/${key}/`).filter((k) => k.endsWith('.avif')).map((k) => Number(/\/w(\d+)\.avif$/.exec(k)![1])).sort((a, b) => a - b);

test('a product picture: its AVIF copies up to its own width, after the answer, and a done marker', async () => {
  const w = world();
  const { res, body } = await w.send('/api/uploads', formOf({ purpose: 'product', file: file(webpBytes(1254, 1254), 'spool.webp') }));
  assert.equal(res.status, 200, JSON.stringify(body));
  const key = String(body.key);
  assert.match(key, /^products\/catalog\/gallery\/[a-f0-9]+\.webp$/);
  assert.deepEqual(avifRungs(w.pub, key), rungsFor(1254));
  assert.ok(w.pub.objects.has(`variants/v1/${key}/done`), 'the sweep will skip it');
  assert.ok(w.images.calls.every((c) => c.format === 'image/avif' && c.quality === 60 && c.fit === 'scale-down'));
  assert.equal(w.pub.objects.get(`variants/v1/${key}/w1280.avif`)!.custom!.width, '1254', 'never enlarged');
});

test('an avatar (a public purpose): four rungs for a 512 px face', async () => {
  const w = world();
  const { res, body } = await w.send('/api/uploads', formOf({ purpose: 'avatar', file: file(webpBytes(512, 512), 'me.webp') }));
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(avifRungs(w.pub, String(body.key)), [160, 320, 480, 640]);
});

test('a home photo or brand mark (site media) and a section picture are warmed too', async () => {
  const w = world();
  const site = await w.send('/api/admin/site-media/brand-bambulab', formOf({ file: file(webpBytes(1536, 1024), 'bambu.webp') }));
  assert.equal(site.res.status, 200, JSON.stringify(site.body));
  const siteKey = w.pub.keys('UiUx/MainPage/').find((k) => !k.startsWith('variants/'))!;
  assert.match(siteKey, /^UiUx\/MainPage\/brand-bambulab-[a-z0-9]{16}\.webp$/);
  assert.deepEqual(avifRungs(w.pub, siteKey), rungsFor(1536));
  const section = await w.send('/api/admin/taxonomy/catalogs/cat_printers_fdm/image', formOf({ file: file(webpBytes(2400, 300), 'banner.webp') }));
  assert.equal(section.res.status, 200, JSON.stringify(section.body));
  const sectionKey = String(section.body.image_key);
  assert.deepEqual(avifRungs(w.pub, sectionKey), [...rungsFor(2400)], 'an 8:1 banner keeps every rung up to 1600');
  assert.equal(w.pub.objects.get(sectionKey)!.bytes.byteLength, webpBytes(2400, 300).byteLength, 'a 0.7 MP banner is stored as it came');
});

test('a warm-up that fails changes nothing about the upload: same answer, no copies, no marker', async () => {
  const images = imagesDouble('throw9422');
  const w = world(images);
  const { res, body } = await w.send('/api/uploads', formOf({ purpose: 'product', file: file(webpBytes(800, 800), 'ok.webp') }));
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.ok(images.calls.length > 0, 'it was tried');
  assert.deepEqual(w.pub.keys('variants/'), []);
});

test('nothing is warmed for a private, animated or moving upload', async () => {
  const w = world();
  const chat = await w.send('/api/uploads', formOf({ purpose: 'chat', entity_id: 'chat_1', file: file(webpBytes(1200, 900), 'c.webp') }));
  assert.equal(chat.res.status, 200, JSON.stringify(chat.body));
  const animated = await w.send('/api/uploads', formOf({ purpose: 'community', file: file(webpBytes(900, 900, { animated: true }), 'a.webp') }));
  assert.equal(animated.res.status, 200, JSON.stringify(animated.body));
  assert.deepEqual(w.priv.keys('variants/'), []);
  assert.equal(w.images.calls.length, 0, 'no cut for either');
  // The animated one is marked so the sweep does not fetch it again.
  assert.equal(w.pub.objects.get(`variants/v1/${String(animated.body.key)}/done`)?.custom?.skip, 'animated');
});

test('warmImageVariants is total: no binding, a non-public key or a missing original is a reason, never a throw', async () => {
  const pub = new R2Double();
  const env = { BUCKET: pub, R2_PUBLIC: pub } as never;
  assert.deepEqual(await warmImageVariants(env, { key: 'products/a.webp' }), { made: 0, failed: 0, skipped: 'unavailable' });
  const withImages = { BUCKET: pub, R2_PUBLIC: pub, IMAGES: imagesDouble().binding } as never;
  assert.equal((await warmImageVariants(withImages, { key: 'receipts/u1/evidence/a.webp' })).skipped, 'not_public_still');
  assert.equal((await warmImageVariants(withImages, { key: 'products/a.gif' })).skipped, 'not_public_still');
  assert.equal((await warmImageVariants(withImages, { key: 'products/missing.webp' })).skipped, 'missing');
});

test('the warm-up holds ONE copy of the original for every width, and stops at its first failed cut', async () => {
  // A 17 MB legacy JPEG cut at eight widths held the original once more per
  // width (`new Blob([bytes])` each time) and peaked at +180 MB — over the
  // isolate's 128 MB. Count the Blobs made while warming one picture.
  const pub = new R2Double();
  const images = imagesDouble();
  const key = 'products/catalog/gallery/big.webp';
  const bytes = webpBytes(1600, 1600, { pad: 2000 });
  pub.seed(key, bytes);
  const RealBlob = globalThis.Blob;
  let made = 0;
  (globalThis as { Blob: typeof Blob }).Blob = class extends RealBlob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      if (parts?.some((p) => (p as ArrayBufferView).byteLength === bytes.byteLength)) made += 1;
    }
  };
  try {
    const report = await warmImageVariants({ R2_PUBLIC: pub, BUCKET: pub, IMAGES: images.binding } as never, { key, bytes, width: 1600, etag: 'e1' });
    assert.equal(report.made, rungsFor(1600).length);
  } finally {
    (globalThis as { Blob: typeof Blob }).Blob = RealBlob;
  }
  assert.equal(made, 1, 'one Blob of the original, read afresh for each width');

  const failing = imagesDouble('throw9422');
  const pub2 = new R2Double();
  pub2.seed(key, bytes);
  const report = await warmImageVariants({ R2_PUBLIC: pub2, BUCKET: pub2, IMAGES: failing.binding } as never, { key, bytes, width: 1600, etag: 'e1' });
  assert.equal(report.failed, 1);
  assert.equal(failing.calls.length, 1, 'one failed cut, not one per width');
  assert.equal(pub2.objects.has(`variants/v1/${key}/done`), false);
});
