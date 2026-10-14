/**
 * SMALL COPIES, MADE ONCE, KEPT IN R2 (owner 2026-10-13: «أريد تحويل الصور
 * كلها وضغطها بتكون بحجم صغير وليس بحجمها الأصلي الكبير»).
 *
 * `GET /files/<key>?w=<width>` answers a PUBLIC still picture at one of eight
 * widths (packages/contracts/src/imageSizing.ts), in the format the browser's
 * `Accept` allows (AVIF, else WebP, else the stored format). The copy is cut
 * by the `IMAGES` binding once and stored under `variants/v1/<key>/w<W>.<ext>`
 * (worker/lib/imageVariants.ts); every later request — from any data centre —
 * reads it from R2, and the edge cache in front of that.
 *
 * What these pin: the one width list and its refusals; the shared srcset
 * builder and its public-key rule (the client's copy of the server's); the
 * three sources (edge, r2, render) and their headers; put-if-absent with
 * exactly the allowed metadata; the 304s; never enlarging; every failure
 * serving the original and storing nothing; a fixed-name picture the owner
 * replaced; an animated WebP kept whole; private keys, non-stills and the
 * `variants/` prefix refused.
 *
 * Run: node --import tsx --test tests/imageVariants.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { asD1, ctx, freshDb, pending, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { MemCache, R2Double, avifBytes, dimsOf, imagesDouble, jpegBytes, pngBytes, webpBytes } from './fixtures/imageDoubles';
import { fileRoutes, imageVariantCacheKey } from '../worker/routes/uploads';
import {
  IMAGE_VARIANT_WIDTHS as SERVER_WIDTHS,
  VARIANT_QUALITY,
  negotiateVariantFormat,
  parseVariantWidth,
  variantSourceMime,
} from '../worker/lib/imageConvert';
import { IMAGE_VARIANT_WIDTHS, isPublicVariantKey, variantSrcSet } from '../packages/contracts/src/imageSizing';
import { PRODUCT_GALLERY_SIZES, mediaAspect, productGallerySizes } from '../packages/contracts/src/imageSizes';
import { deleteMediaObject, isAnonymousPublicMediaKey } from '../worker/lib/mediaStorage';
import { rungsFor, variantMetadata } from '../worker/lib/imageVariants';
import { variantObjectKey } from '../worker/lib/variantKeys';

// ------------------------------------------------------------ the pure parts

test('ONE list of widths: eight rungs, written once in contracts and imported by the Worker', () => {
  assert.deepEqual([...IMAGE_VARIANT_WIDTHS], [160, 320, 480, 640, 800, 1080, 1280, 1600]);
  assert.equal(SERVER_WIDTHS, IMAGE_VARIANT_WIDTHS, 'the Worker re-exports the same array, not a copy');
  // Nothing else may declare a width list: a second copy is how the client and server drifted before.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (name === 'node_modules' || name === 'dist') continue;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(name) && rel !== 'packages/contracts/src/imageSizing.ts') {
        const src = readFileSync(join(ROOT, rel), 'utf8');
        if (/\[\s*160\s*,\s*320\s*,\s*480/.test(src)) offenders.push(rel);
      }
    }
  };
  for (const dir of ['src', 'worker', 'packages']) walk(dir);
  assert.deepEqual(offenders, [], 'only packages/contracts/src/imageSizing.ts lists the widths');
  for (const rel of ['src/components/ui/SafeImage.tsx', 'src/components/ui/VariantImg.tsx', 'src/components/storefront/parts.tsx', 'src/components/home/v2/PromoPhoto.tsx', 'src/components/catalog/CropPhoto.tsx', 'worker/lib/imageConvert.ts', 'worker/lib/socialPreview.ts']) {
    assert.match(readFileSync(join(ROOT, rel), 'utf8'), /packages\/contracts\/src\/imageSizing'/, `${rel} imports the shared list`);
  }
});

test('the width parameter is closed: listed widths in their canonical spelling only', () => {
  for (const w of IMAGE_VARIANT_WIDTHS) assert.equal(parseVariantWidth(String(w)), w);
  assert.equal(parseVariantWidth(undefined), null);
  assert.equal(parseVariantWidth(''), null);
  for (const bad of ['1000', '2048', '3000', '640.5', '1e3', '-640', 'abc', '0640', '640.0', '159', '0', '1600 ']) {
    assert.equal(parseVariantWidth(bad), 'invalid', `w=${bad} must not mint a new size`);
  }
});

test('only a still picture, read from the key, can be cut; GIF and video cannot', () => {
  assert.equal(variantSourceMime('products/p1/a.webp'), 'image/webp');
  assert.equal(variantSourceMime('merchants/u/public/x.JPG'), 'image/jpeg');
  assert.equal(variantSourceMime('UiUx/Logo/Logo.png'), 'image/png');
  for (const key of ['merchants/u1/public/clip.mp4', 'products/banner.gif', 'products/p1/a.svg', 'products/p1/noext']) assert.equal(variantSourceMime(key), null, key);
});

test('the format follows Accept, and the quality is fixed: AVIF 60 (was 75), WebP 75 (was 85), JPEG 85, PNG lossless', () => {
  assert.equal(negotiateVariantFormat('image/avif,image/webp,image/apng,*/*;q=0.8', 'image/webp'), 'image/avif');
  assert.equal(negotiateVariantFormat('image/webp,*/*', 'image/jpeg'), 'image/webp');
  assert.equal(negotiateVariantFormat('*/*', 'image/png'), 'image/png', 'a PNG keeps its transparency');
  assert.equal(negotiateVariantFormat(undefined, 'image/jpeg'), 'image/jpeg');
  assert.deepEqual(VARIANT_QUALITY, { 'image/avif': 60, 'image/webp': 75, 'image/jpeg': 85, 'image/png': undefined });
});

test('the srcset builder: public /files/ stills only, trimmed at the original, capped per place', () => {
  const src = '/files/products/catalog/gallery/a.webp';
  assert.equal(variantSrcSet(src), IMAGE_VARIANT_WIDTHS.map((w) => `${src}?w=${w} ${w}w`).join(', '));
  // A 1254 px original: the list stops at the first rung above it, which says its TRUE width.
  assert.equal(variantSrcSet(src, { width: 1254 }), `${src}?w=160 160w, ${src}?w=320 320w, ${src}?w=480 480w, ${src}?w=640 640w, ${src}?w=800 800w, ${src}?w=1080 1080w, ${src}?w=1280 1254w`);
  assert.equal(variantSrcSet(src, { width: 500 }), `${src}?w=160 160w, ${src}?w=320 320w, ${src}?w=480 480w, ${src}?w=640 500w`);
  // An original wider than the top rung is its own last candidate.
  assert.ok(variantSrcSet(src, { width: 2400 })!.endsWith(`${src}?w=1600 1600w, ${src} 2400w`));
  // `max` caps a place (the home tiles keep 1080).
  assert.ok(variantSrcSet(src, { max: 1080 })!.endsWith('?w=1080 1080w'));
  assert.ok(!variantSrcSet(src, { max: 1080, width: 2400 })!.includes(' 2400w'));
  assert.ok(variantSrcSet('https://levonis-iq.com/files/products/a.png')!.startsWith('https://levonis-iq.com/files/products/a.png?w=160 160w'));
  for (const not of ['/files/products/a.gif', '/files/products/a.webp?v=2', '/files/products/a.mp4', 'https://cdn.example/a.webp', 'blob:https://x/1', 'data:image/webp;base64,AAAA', '/icons/icon-192.png']) {
    assert.equal(variantSrcSet(not), undefined, not);
  }
});

test('the client never asks a PRIVATE key for copies — its public rule is the server\'s, key for key', () => {
  const keys = [
    'products/catalog/gallery/a.webp', 'avatars/u1/a.webp', 'community/legacy/a.webp', 'link-cards/c1.webp',
    'users/u1/avatar/a.webp', 'users/u1/public-avatars/a.webp', 'users/u1/posts/a.webp', 'users/u1/private/a.webp',
    'merchants/u1/public/a.webp', 'merchants/u1/logos/a.webp', 'merchants/u1/covers/a.webp', 'merchants/u1/kyc/a.webp',
    'UiUx/Logo/Logo.webp', 'UIUx/a.webp', 'ui/levonis/a.webp', 'uiux/a.webp', 'brands/a.webp', 'services/a.webp',
    'chat/c1/attachments/a.webp', 'support/t1/attachments/a.webp', 'receipts/u1/evidence/a.webp', 'reviews/u1/a.webp',
    'complaints/c1/attachments/a.webp', 'trade-in/r1/photos/a.webp', 'kyc/u1/a.webp', 'Users/u1/avatar/a.webp', 'Products/a.webp',
  ];
  for (const key of keys) assert.equal(isPublicVariantKey(key), isAnonymousPublicMediaKey(key), key);
  assert.equal(variantSrcSet('/files/chat/c1/attachments/a.webp'), undefined, 'a chat photo keeps its one address');
  assert.equal(variantSrcSet('/files/variants/v1/products/a.webp/w640.avif'), undefined);
});

test('the product gallery says how wide the PICTURE is drawn, from its own aspect', () => {
  assert.equal(productGallerySizes(null), PRODUCT_GALLERY_SIZES);
  assert.equal(productGallerySizes(undefined), PRODUCT_GALLERY_SIZES);
  const square = productGallerySizes(1);
  // 1280 px desktop: frame 702 px wide, 534 px tall content — a square photo is drawn at 534.
  assert.match(square, /\(min-width: 1280px\) min\(calc\(100vw - 578px\), 534px\)/);
  assert.match(square, /\(min-width: 1540px\) min\(962px, 534px\)/);
  assert.match(square, /min\(calc\(100vw - 58px\), 314px, calc\(78vw - 26px\)\)$/);
  assert.match(productGallerySizes(2.25), /min\(962px, 1201\.5px\)/, 'a wide picture keeps the frame width');
  assert.equal(mediaAspect({ width: 1000, height: 444 }), 1000 / 444);
  assert.equal(mediaAspect({ width: null, height: 4 }), null);
});

test('the rungs a picture needs ahead of time: every one below it and the first at or above it', () => {
  assert.deepEqual(rungsFor(1254), [160, 320, 480, 640, 800, 1080, 1280]);
  assert.deepEqual(rungsFor(512), [160, 320, 480, 640]);
  assert.deepEqual(rungsFor(2400), [...IMAGE_VARIANT_WIDTHS]);
  assert.deepEqual(rungsFor(100), [160]);
  assert.deepEqual(rungsFor(null), []);
});

// ----------------------------------------------------------------- the route

const KEY = 'products/catalog/gallery/9cee.webp';
const PRIVATE_KEY = 'receipts/u1/evidence/scan.webp';
const LOGO = 'UiUx/Logo/Logo.webp';
const MINTED = 'UiUx/MainPage/hero-1-0123456789abcdef.webp';
const ORIGINAL = webpBytes(1254, 1254, { pad: 400 });

function setup(opts: { images?: ReturnType<typeof imagesDouble> | null; cache?: MemCache; user?: boolean } = {}) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','U','u@x.co','h','customer');`);
  const bucket = new R2Double();
  bucket.seed(KEY, ORIGINAL, { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
  bucket.seed(PRIVATE_KEY, ORIGINAL, { contentType: 'image/webp' });
  bucket.seed('merchants/u1/public/clip.mp4', new Uint8Array(64), { contentType: 'video/mp4' });
  bucket.seed('merchants/u1/public/banner.gif', new Uint8Array(64), { contentType: 'image/gif' });
  const images = opts.images === undefined ? imagesDouble() : opts.images;
  const app = stubApp(asD1(raw), opts.user === false ? null : { id: 'u1', role: 'customer', email: 'u@x.co' }, (a) => a.route('/files', fileRoutes), {
    env: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket, ...(images ? { IMAGES: images.binding } : {}) },
  });
  const g = globalThis as { caches?: unknown };
  const fetchIt = async (path: string, headers: Record<string, string> = {}) => {
    const before = g.caches;
    if (opts.cache) g.caches = { default: opts.cache };
    try {
      const res = await app.request(path, { headers }, undefined, ctx);
      await Promise.all(pending.splice(0));
      return res;
    } finally {
      g.caches = before;
      if (before === undefined) delete g.caches;
    }
  };
  return { bucket, images, fetchIt };
}

const AVIF = { Accept: 'image/avif,image/webp,*/*' };
const etagOf = (bucket: R2Double, key: string) => bucket.objects.get(key)!.etag;

test('first request: cut once at that width, answered, and stored put-if-absent with exactly the allowed metadata', async () => {
  const { bucket, images, fetchIt } = setup();
  const res = await fetchIt(`/files/${KEY}?w=640`, AVIF);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/avif');
  assert.equal(res.headers.get('X-Variant-Source'), 'render');
  const body = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(dimsOf(body), { format: 'image/avif', width: 640, height: 640 });
  assert.equal(res.headers.get('Content-Length'), String(body.byteLength));
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(res.headers.get('Vary'), 'Accept');
  assert.equal(res.headers.get('etag'), `"${etagOf(bucket, KEY)}-w640-avif"`, 'the same ETag shape the route has always sent');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  assert.deepEqual(images!.calls.map(({ width, fit, format, quality }) => ({ width, fit, format, quality })), [{ width: 640, fit: 'scale-down', format: 'image/avif', quality: 60 }]);

  const vkey = variantObjectKey(KEY, 640, 'avif');
  assert.equal(vkey, `variants/v1/${KEY}/w640.avif`);
  const put = bucket.puts.find((p) => p.key === vkey);
  assert.ok(put, 'the copy was stored');
  assert.deepEqual(put.onlyIf, { etagDoesNotMatch: '*' }, 'two first requests cannot overwrite each other');
  assert.deepEqual(Object.keys(put.custom!).sort(), ['fmt', 'height', 'q', 'src', 'src_etag', 'ver', 'w', 'width']);
  assert.deepEqual(put.custom, { src: KEY, src_etag: etagOf(bucket, KEY), w: '640', width: '640', height: '640', fmt: 'avif', q: '60', ver: '1' });
  assert.equal(put.cacheControl, 'public, max-age=31536000, immutable');
});

test('second request from another data centre (empty edge): read from R2, the binding is not called', async () => {
  const { bucket, images, fetchIt } = setup();
  const first = new Uint8Array(await (await fetchIt(`/files/${KEY}?w=480`, AVIF)).arrayBuffer());
  bucket.ops.length = 0;
  const again = await fetchIt(`/files/${KEY}?w=480`, AVIF);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('X-Variant-Source'), 'r2');
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), first);
  assert.equal(images!.calls.length, 1, 'cut once in its lifetime');
  assert.deepEqual(bucket.ops, [`get variants/v1/${KEY}/w480.avif`], 'one R2 GET, no original read');
  assert.equal(again.headers.get('etag'), `"${etagOf(bucket, KEY)}-w480-avif"`);
  assert.equal(again.headers.get('Content-Type'), 'image/avif');
  assert.equal(again.headers.get('Vary'), 'Accept');
  assert.equal(again.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
});

test('a warm edge answers alone; a 304 comes from every one of the three sources', async () => {
  const cache = new MemCache();
  const { bucket, images, fetchIt } = setup({ cache });
  const first = await fetchIt(`/files/${KEY}?w=320`, AVIF);
  assert.equal(first.headers.get('X-Variant-Source'), 'render');
  const etag = first.headers.get('etag')!;
  assert.ok([...cache.store.keys()].some((u) => u.endsWith(`/files/${KEY}?w=320&f=avif&v=1`)), 'the edge entry carries width, format and store version');
  bucket.ops.length = 0;
  const edge = await fetchIt(`/files/${KEY}?w=320`, AVIF);
  assert.equal(edge.headers.get('X-Variant-Source'), 'edge');
  assert.deepEqual(bucket.ops, [], 'neither the bucket…');
  assert.equal(images!.calls.length, 1, '…nor the binding');
  assert.equal((await fetchIt(`/files/${KEY}?w=320`, { ...AVIF, 'If-None-Match': etag })).status, 304, 'edge 304');

  const r2 = setup();
  await r2.fetchIt(`/files/${KEY}?w=320`, AVIF);
  const fromR2 = await r2.fetchIt(`/files/${KEY}?w=320`, { ...AVIF, 'If-None-Match': `"${etagOf(r2.bucket, KEY)}-w320-avif"` });
  assert.equal(fromR2.status, 304, 'r2 304');
  const cold = setup();
  const fromRender = await cold.fetchIt(`/files/${KEY}?w=320`, { ...AVIF, 'If-None-Match': `"${etagOf(cold.bucket, KEY)}-w320-avif"` });
  assert.equal(fromRender.status, 304, 'a browser that holds the copy needs no cut');
  assert.equal(cold.images!.calls.length, 0, 'decided from the ETag before any pixel is touched');
});

test('other query parameters fork neither the cache key nor the stored copy, and set no quality', async () => {
  const { bucket, images, fetchIt } = setup();
  await fetchIt(`/files/${KEY}?w=640&q=100&x=1`, AVIF);
  await fetchIt(`/files/${KEY}?x=2&w=640`, AVIF);
  assert.equal(images!.calls.length, 1);
  assert.equal(images!.calls[0].quality, 60);
  assert.deepEqual(bucket.keys('variants/'), [`variants/v1/${KEY}/w640.avif`]);
  const key = imageVariantCacheKey(new Request(`https://levonis-iq.com/files/${KEY}?q=100&w=640`), KEY, 640, 'image/webp');
  assert.equal(key.url, `https://levonis-iq.com/files/${KEY}?w=640&f=webp&v=1`);
});

test('a width off the list, a private key, a non-still and the copy store itself are refused — touching nothing', async () => {
  const { bucket, images, fetchIt } = setup();
  for (const bad of ['1000', '2048', '3000', '640.5', '1e3', '-640', 'abc']) {
    const res = await fetchIt(`/files/${KEY}?w=${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal(((await res.json()) as { code: string }).code, 'IMAGE_VARIANT_WIDTH');
  }
  const priv = await fetchIt(`/files/${PRIVATE_KEY}?w=320`);
  assert.equal(priv.status, 400);
  assert.equal(((await priv.json()) as { code: string }).code, 'IMAGE_VARIANT_PRIVATE');
  for (const key of ['merchants/u1/public/clip.mp4', 'merchants/u1/public/banner.gif', 'products/catalog/gallery/x.svg']) {
    const res = await fetchIt(`/files/${key}?w=320`);
    assert.equal(res.status, 400, key);
    assert.equal(((await res.json()) as { code: string }).code, 'IMAGE_VARIANT_NOT_IMAGE');
  }
  assert.deepEqual(bucket.ops, [], 'no refusal reached the bucket');
  assert.equal(images!.calls.length, 0, 'nor the binding');
  // `variants/` has no address of its own — signed in or not.
  await fetchIt(`/files/${KEY}?w=160`, AVIF);
  const direct = `/files/variants/v1/${KEY}/w160.avif`;
  assert.equal((await fetchIt(direct)).status, 404);
  assert.equal((await setup({ user: false }).fetchIt(direct)).status, 404);
  assert.equal((await fetchIt('/files/variants/_state/sweep-v1.json')).status, 404);
  // The private file itself is still served to its owner, whole, privately.
  const own = await fetchIt(`/files/${PRIVATE_KEY}`);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('Cache-Control'), 'private, max-age=300');
});

test('never enlarged: w=1600 of a 1254 px original is a 1254 px copy; a copy wider than asked is never kept', async () => {
  const { bucket, fetchIt } = setup();
  const big = await fetchIt(`/files/${KEY}?w=1600`, AVIF);
  assert.deepEqual(dimsOf(new Uint8Array(await big.arrayBuffer())), { format: 'image/avif', width: 1254, height: 1254 });
  assert.equal(bucket.objects.get(`variants/v1/${KEY}/w1600.avif`)!.custom!.width, '1254');

  const liar = imagesDouble('tooWide');
  const bad = setup({ images: liar });
  const res = await bad.fetchIt(`/files/${KEY}?w=640`, AVIF);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/webp', 'the original');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), ORIGINAL);
  assert.deepEqual(bad.bucket.keys('variants/'), [], 'nothing stored');
});

test('every failure serves the original and stores nothing: no binding, a throw (9422), HTTP 500, the wrong format', async () => {
  for (const images of [null, imagesDouble('throw9422'), imagesDouble('http500'), imagesDouble('wrongFormat')]) {
    const { bucket, fetchIt } = setup({ images });
    const res = await fetchIt(`/files/${KEY}?w=320`, AVIF);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/webp');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), ORIGINAL);
    assert.equal(res.headers.get('X-Variant-Source'), null);
    assert.deepEqual(bucket.keys('variants/'), [], `${images?.state.mode ?? 'no binding'}: nothing stored`);
  }
});

test('negotiation: WebP q75 for a browser without AVIF; a PNG stays PNG, a JPEG stays JPEG for one that takes neither', async () => {
  const { bucket, images, fetchIt } = setup();
  const webp = await fetchIt(`/files/${KEY}?w=640`, { Accept: 'image/webp,*/*' });
  assert.equal(webp.headers.get('Content-Type'), 'image/webp');
  assert.equal(images!.calls[0].quality, 75);
  assert.ok(bucket.objects.has(`variants/v1/${KEY}/w640.webp`));
  bucket.seed('products/catalog/gallery/clear.png', pngBytes(800, 600), { contentType: 'image/png' });
  const png = await fetchIt('/files/products/catalog/gallery/clear.png?w=320', { Accept: '*/*' });
  assert.equal(png.headers.get('Content-Type'), 'image/png');
  assert.equal(images!.calls[1].quality, undefined, 'lossless');
  assert.ok(bucket.objects.has('variants/v1/products/catalog/gallery/clear.png/w320.png'));
  bucket.seed('products/catalog/gallery/photo.jpg', jpegBytes(900, 600), { contentType: 'image/jpeg' });
  const jpg = await fetchIt('/files/products/catalog/gallery/photo.jpg?w=320', { Accept: '*/*' });
  assert.equal(jpg.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(dimsOf(new Uint8Array(await jpg.arrayBuffer())), { format: 'image/jpeg', width: 320, height: 213 });
});

test('a fixed name the owner replaced in R2: its stale copy is never served, the copy is cut again', async () => {
  const { bucket, images, fetchIt } = setup();
  bucket.seed(LOGO, webpBytes(1536, 1024), { contentType: 'image/webp' });
  const first = await fetchIt(`/files/${LOGO}?w=320`, AVIF);
  assert.equal(first.headers.get('Cache-Control'), 'public, max-age=300, must-revalidate', 'a hand-named picture revalidates, and so do its copies');
  assert.deepEqual(dimsOf(new Uint8Array(await first.arrayBuffer())), { format: 'image/avif', width: 320, height: 213 });
  const fresh = await fetchIt(`/files/${LOGO}?w=320`, AVIF);
  assert.equal(fresh.headers.get('X-Variant-Source'), 'r2', 'unchanged original: the stored copy');
  // The owner uploads a new logo under the same name.
  bucket.seed(LOGO, webpBytes(1000, 1000), { contentType: 'image/webp' });
  const replaced = await fetchIt(`/files/${LOGO}?w=320`, AVIF);
  assert.equal(replaced.headers.get('X-Variant-Source'), 'render');
  assert.deepEqual(dimsOf(new Uint8Array(await replaced.arrayBuffer())), { format: 'image/avif', width: 320, height: 320 }, 'the NEW picture');
  assert.equal(images!.calls.length, 2);
  assert.equal(bucket.objects.get(`variants/v1/${LOGO}/w320.avif`)!.custom!.src_etag, etagOf(bucket, LOGO), 'the stale copy was replaced');
  assert.equal(replaced.headers.get('etag'), `"${etagOf(bucket, LOGO)}-w320-avif"`);
});

test('a name the app MINTED in the brand folder is immutable again — when its own R2 object says so', async () => {
  const { bucket, fetchIt } = setup();
  bucket.seed(MINTED, webpBytes(1600, 900), { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
  const plain = await fetchIt(`/files/${MINTED}`);
  assert.equal(plain.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  const copy = await fetchIt(`/files/${MINTED}?w=640`, AVIF);
  assert.equal(copy.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  // The same minted-looking name uploaded by hand, without that metadata, still revalidates.
  const hand = 'UiUx/MainPage/hero-2-fedcba9876543210.webp';
  bucket.seed(hand, webpBytes(800, 600), { contentType: 'image/webp' });
  assert.equal((await fetchIt(`/files/${hand}`)).headers.get('Cache-Control'), 'public, max-age=300, must-revalidate');
  // And a hand-named file that carries immutable metadata does too: both conditions, not either.
  bucket.seed('UiUx/MainPage/Bamabulab.webp', webpBytes(1536, 1024), { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
  assert.equal((await fetchIt('/files/UiUx/MainPage/Bamabulab.webp')).headers.get('Cache-Control'), 'public, max-age=300, must-revalidate');
});

test('an animated WebP keeps its frames: the original is the answer and no copy is cut or kept', async () => {
  const { bucket, images, fetchIt } = setup();
  const animated = webpBytes(600, 600, { animated: true, pad: 200 });
  bucket.seed('merchants/u1/public/moving.webp', animated, { contentType: 'image/webp' });
  const res = await fetchIt('/files/merchants/u1/public/moving.webp?w=320', AVIF);
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), animated);
  assert.equal(images!.calls.length, 0);
  assert.deepEqual(bucket.keys('variants/'), []);
});

test('deleting a picture deletes its copies: ?w= of a deleted key is a 404, not a stored copy', async () => {
  const { bucket, fetchIt } = setup();
  await fetchIt(`/files/${KEY}?w=160`, AVIF);
  await fetchIt(`/files/${KEY}?w=640`, { Accept: 'image/webp' });
  assert.equal(bucket.keys(`variants/v1/${KEY}/`).length, 2);
  await deleteMediaObject({ BUCKET: bucket as unknown as R2Bucket, R2_PUBLIC: bucket as unknown as R2Bucket }, 'public', KEY);
  assert.deepEqual(bucket.keys('variants/'), []);
  assert.equal((await fetchIt(`/files/${KEY}?w=160`, AVIF)).status, 404);
});

test('a stored copy says nothing the public picture does not: no supplier URL, file name or owner', () => {
  const meta = variantMetadata({ key: KEY, sourceEtag: 'abc', width: 640, format: 'image/avif', out: { width: 640, height: 480 } });
  assert.deepEqual(Object.keys(meta).sort(), ['fmt', 'height', 'q', 'src', 'src_etag', 'ver', 'w', 'width']);
  assert.doesNotMatch(JSON.stringify(meta), /source_url|original_name|owner|http/i);
});

test('the plain request is untouched by the copy store: same headers, no binding call, no copy read', async () => {
  const { bucket, images, fetchIt } = setup();
  const res = await fetchIt(`/files/${KEY}`, { Accept: 'image/avif' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/webp');
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(res.headers.get('Content-Length'), String(ORIGINAL.byteLength));
  assert.equal(res.headers.get('Vary'), null);
  assert.equal(images!.calls.length, 0);
  assert.ok(!bucket.ops.some((op) => op.includes('variants/')));
  assert.deepEqual(dimsOf(avifBytes(2, 3)), { format: 'image/avif', width: 2, height: 3 }, 'the AVIF builder reads back');
});

// ------------------------------------------------- the release that starts the store

test('right after the release: a data centre still holding the copy cut BEFORE the store (no `v`) answers from it at once and keeps a new copy after the response', async () => {
  const cache = new MemCache();
  const { bucket, images, fetchIt } = setup({ cache });
  // What an earlier deploy left in this data centre's edge: `?w=640&f=avif`, no `v`, immutable.
  const legacyKey = imageVariantCacheKey(new Request(`http://localhost/files/${KEY}?w=640`), KEY, 640, 'image/avif', true);
  assert.equal(new URL(legacyKey.url).searchParams.get('v'), null);
  const old = avifBytes(640, 640);
  await cache.put(legacyKey, new Response(old as unknown as BodyInit, {
    headers: { 'Content-Type': 'image/avif', etag: `"${etagOf(bucket, KEY)}-w640-avif"`, 'Cache-Control': 'public, max-age=31536000, immutable' },
  }));

  const first = await fetchIt(`/files/${KEY}?w=640`, AVIF);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Variant-Source'), 'legacy');
  assert.equal(first.headers.get('Cache-Control'), 'public, max-age=3600', 'short-lived in the browser: the kept copy replaces it');
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), old);
  // After the response: cut once, kept in R2 and under the current edge key.
  assert.equal(images!.calls.length, 1);
  assert.ok(bucket.objects.has(`variants/v1/${KEY}/w640.avif`));
  const current = imageVariantCacheKey(new Request(`http://localhost/files/${KEY}?w=640`), KEY, 640, 'image/avif');
  assert.ok(await cache.match(current), 'the new copy is at the edge');

  const second = await fetchIt(`/files/${KEY}?w=640`, AVIF);
  assert.equal(second.headers.get('X-Variant-Source'), 'edge');
  assert.equal(second.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(images!.calls.length, 1, 'not cut again');

  // A 304 from the old entry costs no bytes either.
  const fresh = new MemCache();
  const again = setup({ cache: fresh });
  const etag = `"${etagOf(again.bucket, KEY)}-w320-avif"`;
  await fresh.put(imageVariantCacheKey(new Request(`http://localhost/files/${KEY}?w=320`), KEY, 320, 'image/avif', true), new Response(avifBytes(320, 320) as unknown as BodyInit, { headers: { 'Content-Type': 'image/avif', etag } }));
  const notModified = await again.fetchIt(`/files/${KEY}?w=320`, { ...AVIF, 'If-None-Match': etag });
  assert.equal(notModified.status, 304);
});

test('a key rewritten in place never answers from an entry of before the store — it may be of an older picture', async () => {
  const cache = new MemCache();
  const { bucket, images, fetchIt } = setup({ cache });
  const LOGO = 'UiUx/Logo/Logo.webp';
  bucket.seed(LOGO, webpBytes(1000, 400), { contentType: 'image/webp' });
  await cache.put(imageVariantCacheKey(new Request(`http://localhost/files/${LOGO}?w=320`), LOGO, 320, 'image/avif', true), new Response(avifBytes(320, 999) as unknown as BodyInit, { headers: { 'Content-Type': 'image/avif' } }));
  const res = await fetchIt(`/files/${LOGO}?w=320`, AVIF);
  assert.equal(res.headers.get('X-Variant-Source'), 'render');
  assert.deepEqual(dimsOf(new Uint8Array(await res.arrayBuffer())), { format: 'image/avif', width: 320, height: 128 });
  assert.equal(images!.calls.length, 1);
});

test('the edge keys a delete names are the keys the route writes', () => {
  const req = new Request(`https://levonis-iq.com/files/${KEY}?w=800&q=9`);
  assert.equal(imageVariantCacheKey(req, KEY, 800, 'image/avif').url, `https://levonis-iq.com/files/${KEY}?w=800&f=avif&v=1`);
  assert.equal(imageVariantCacheKey(req, KEY, 800, 'image/avif', true).url, `https://levonis-iq.com/files/${KEY}?w=800&f=avif`);
  assert.equal(imageVariantCacheKey(new Request('https://levonis-iq.com/files/link-cards/c1.webp?w=320'), 'link-cards/c1.webp', 320, 'image/webp').url, 'https://levonis-iq.com/files/link-cards/c1.webp?w=320&f=webp&v=1&__edge=2');
});
