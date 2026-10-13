/**
 * NO NEW PICTURE IS STORED LARGER THAN THE SITE CAN USE (owner 2026-10-13:
 * «وضغطها بتكون بحجم صغير وليس بحجمها الأصلي الكبير»).
 *
 * The server keeps a new upload within 2048 × 2048 worth of pixels (4.2 MP)
 * and 3072 px on its long edge (worker/lib/imageConvert.ts STORED_MAX_PIXELS /
 * STORED_MAX_EDGE) — an area, so an 8:1 section banner of 2400 × 300 keeps
 * every pixel. A WebP at or under the limit is still stored byte for byte; one
 * above it is re-encoded smaller; an animated WebP is never touched. The
 * browser does its share first (src/lib/imagePreprocess.ts): a product edge of
 * 2048, and a still WebP above its purpose's edge redrawn — or, where the
 * canvas cannot encode WebP, sent as it is and never relabelled.
 *
 * Pictures already stored are not touched by any of this.
 *
 * Run: node --import tsx --test tests/imageStoredCap.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { ROOT } from './fixtures/d1';
import { asD1, ctx, freshDb, pending } from './fixtures/app';
import { R2Double, dimsOf, imagesDouble, jpegBytes, pngBytes, webpBytes } from './fixtures/imageDoubles';
import {
  STORED_MAX_EDGE,
  STORED_MAX_PIXELS,
  capStoredWebp,
  convertToWebp,
  productImageToWebp,
  storedCapBox,
} from '../worker/lib/imageConvert';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import {
  AVATAR_IMAGE_MAX_EDGE,
  ENCODE_EDGE_LADDER,
  PRODUCT_IMAGE_MAX_EDGE,
  prepareAvatarImage,
  prepareProductImage,
  stillWebpDimensions,
} from '../src/lib/imagePreprocess';

test('the limit is an area and an edge: photos shrink, an 8:1 banner keeps its width', () => {
  assert.equal(STORED_MAX_PIXELS, 2048 * 2048);
  assert.equal(STORED_MAX_EDGE, 3072);
  const box = storedCapBox(4032, 3024)!;
  assert.equal(box, 2364, 'a 12 MP phone photo: 2364 × 1773');
  assert.ok(box * Math.round(box * 3024 / 4032) <= STORED_MAX_PIXELS);
  assert.equal(storedCapBox(3000, 3000), 2048);
  assert.equal(storedCapBox(6000, 400), 3072, 'an extreme strip is held to the edge');
  assert.equal(storedCapBox(2400, 300), null, 'a section banner (0.7 MP) is kept as it is');
  assert.equal(storedCapBox(2048, 2048), null);
  assert.equal(storedCapBox(1254, 1254), null);
  assert.ok(storedCapBox(2049, 2048));
});

test('convertToWebp scales a PNG or JPEG above the limit in the same call, and leaves one under it alone', async () => {
  const images = imagesDouble();
  const big = await convertToWebp({ IMAGES: images.binding as never }, jpegBytes(4032, 3024), 'image/jpeg');
  assert.equal(big.ok, true);
  assert.deepEqual({ width: images.calls[0].width, height: images.calls[0].height, fit: images.calls[0].fit }, { width: 2364, height: 2364, fit: 'scale-down' });
  if (big.ok) {
    assert.equal(big.width, 2364);
    assert.ok(big.width * big.height <= STORED_MAX_PIXELS);
  }
  const small = await convertToWebp({ IMAGES: images.binding as never }, pngBytes(800, 600), 'image/png');
  assert.equal(small.ok, true);
  assert.equal(images.calls[1].width, undefined, 'no transform under the limit');
});

test('a product WebP: byte for byte at or under the limit, re-encoded within it above, never when animated', async () => {
  const images = imagesDouble();
  const env = { IMAGES: images.binding as never };
  const fits = webpBytes(1254, 1254);
  const kept = await productImageToWebp(env, fits, 'image/webp');
  assert.ok(kept.ok && !kept.converted && kept.bytes === fits, 'the dedupe digest is of these exact bytes');
  assert.equal(images.calls.length, 0);

  const over = await productImageToWebp(env, webpBytes(3000, 3000), 'image/webp');
  assert.ok(over.ok && over.converted);
  assert.equal(images.calls[0].width, 2048);
  if (over.ok) assert.deepEqual(dimsOf(over.bytes), { format: 'image/webp', width: 2048, height: 2048 });

  const strip = await productImageToWebp(env, jpegBytes(6000, 400), 'image/jpeg');
  assert.ok(strip.ok);
  if (strip.ok) assert.equal(strip.width, 3072);

  const moving = webpBytes(3000, 3000, { animated: true });
  const animated = await productImageToWebp(env, moving, 'image/webp');
  assert.ok(animated.ok && animated.bytes === moving, 'one frame is all a re-encode would keep');
});

test('capStoredWebp: the WebP-only doors re-encode above the limit and never fail an upload that works today', async () => {
  const images = imagesDouble();
  const capped = await capStoredWebp({ IMAGES: images.binding as never }, webpBytes(4000, 4000));
  assert.equal(capped.resized, true);
  assert.deepEqual({ width: capped.width, height: capped.height }, { width: 2048, height: 2048 });
  const banner = webpBytes(2400, 300);
  const kept = await capStoredWebp({ IMAGES: images.binding as never }, banner);
  assert.ok(!kept.resized && kept.bytes === banner);
  const bare = webpBytes(4000, 4000);
  const noBinding = await capStoredWebp({}, bare);
  assert.ok(!noBinding.resized && noBinding.bytes === bare, 'without the binding the bytes stay as they came');
  const failing = await capStoredWebp({ IMAGES: imagesDouble('throw9422').binding as never }, bare);
  assert.ok(!failing.resized && failing.bytes === bare, 'a binding failure is logged, not a refusal');
});

test('a section picture over the limit is stored within it (and its pointer names the stored key)', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('admin','Admin','boss@x.co','h','admin')");
  const pub = new R2Double();
  const db = asD1(raw);
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.env = { DB: db, BUCKET: pub, R2_PUBLIC: pub, R2_PRIVATE: pub, IMAGES: imagesDouble().binding, INITIAL_ADMIN_EMAIL: 'boss@x.co' } as never;
    c.set('user', { id: 'admin', role: 'admin', email: 'boss@x.co', admin_scope: null, email_verified_at: '2026-01-01T00:00:00.000Z' } as never);
    await next();
  });
  app.route('/api/admin/taxonomy', adminTaxonomyRoutes);
  app.onError((e, c) => (e instanceof HttpError ? c.json({ code: e.code }, e.status as 400) : c.json({ error: String(e) }, 500)));
  const form = new FormData();
  form.set('file', new File([webpBytes(3200, 3200) as unknown as BlobPart], 'huge.webp'));
  const res = await app.request('/api/admin/taxonomy/catalogs/cat_printers_fdm/image', { method: 'POST', body: form }, undefined, ctx);
  await Promise.all(pending.splice(0));
  assert.equal(res.status, 200);
  const key = String(((await res.json()) as Record<string, unknown>).image_key);
  assert.deepEqual(dimsOf(pub.objects.get(key)!.bytes), { format: 'image/webp', width: 2048, height: 2048 });
  // The brand-mark door applies the same check before measuring and storing.
  const admin = readFileSync(join(ROOT, 'worker/routes/admin.ts'), 'utf8');
  const upload = admin.slice(admin.indexOf("adminRoutes.post('/site-media/:slot'"), admin.indexOf("adminRoutes.delete('/site-media/:slot'"));
  assert.ok(upload.indexOf('capStoredWebp(c.env, buf)') > 0 && upload.indexOf('capStoredWebp(c.env, buf)') < upload.indexOf('rasterDimensions(buf'));
});

// ------------------------------------------------------------- the browser

test('the browser: products at 2048 (was 3000), and the canvas ladder below it', () => {
  assert.equal(PRODUCT_IMAGE_MAX_EDGE, 2048);
  assert.deepEqual([...ENCODE_EDGE_LADDER], [2048, 1600, 1200]);
  assert.deepEqual(stillWebpDimensions(webpBytes(3000, 2000)), { width: 3000, height: 2000 });
  assert.equal(stillWebpDimensions(webpBytes(3000, 2000, { animated: true })), null, 'an animated WebP is never redrawn');
  assert.equal(stillWebpDimensions(pngBytes(10, 10)), null);
});

const asFile = (bytes: Uint8Array, name: string, type = 'image/webp') => new File([bytes as unknown as BlobPart], name, { type });

test('a still WebP above its edge is redrawn; one under it, or an animated one, travels as it is', async () => {
  let called = 0;
  const encoder = async () => {
    called += 1;
    return { blob: new Blob([webpBytes(2048, 1365) as unknown as BlobPart], { type: 'image/webp' }), width: 2048, height: 1365 };
  };
  const big = await prepareProductImage(asFile(webpBytes(3000, 2000), 'camera.webp'), encoder);
  assert.equal(called, 1);
  assert.equal(big.converted, true);
  assert.equal(big.file.type, 'image/webp');
  assert.equal(big.width, 2048);
  const small = asFile(webpBytes(1200, 800), 'fine.webp');
  const kept = await prepareProductImage(small, encoder);
  assert.equal(kept.file, small);
  const animated = asFile(webpBytes(3000, 3000, { animated: true }), 'moving.webp');
  assert.equal((await prepareProductImage(animated, encoder)).file, animated);
  assert.equal(called, 1, 'neither of those was drawn');
  // An avatar's edge is 512.
  await prepareAvatarImage(asFile(webpBytes(600, 600), 'me.webp'), encoder);
  assert.equal(called, 2);
  assert.equal(AVATAR_IMAGE_MAX_EDGE, 512);
});

test('a canvas that cannot encode WebP sends the original WebP unchanged — never relabelled', async () => {
  const original = asFile(webpBytes(3000, 3000), 'safari.webp');
  // Safari's canvas: every rung fails, so the encoder hands back the very file it was given.
  const result = await prepareProductImage(original, async (f) => ({ blob: f, width: 3000, height: 3000 }));
  assert.equal(result.file, original);
  assert.equal(result.converted, false);
  // And a PNG fallback from the canvas is not accepted as a WebP either.
  const png = await prepareProductImage(original, async () => ({ blob: new Blob([pngBytes(2048, 2048) as unknown as BlobPart], { type: 'image/png' }), width: 2048, height: 2048 }));
  assert.equal(png.file, original);
});
