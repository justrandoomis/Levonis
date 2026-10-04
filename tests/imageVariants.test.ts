/**
 * A CARD DOWNLOADS A CARD-SIZED PICTURE (perf plan §B.1 #5).
 *
 * `GET /files/<key>?w=160|320|480|640|1080` answers a PUBLIC still image at one of
 * five widths through the `IMAGES` binding, in the format the browser's
 * `Accept` header allows (AVIF, else WebP, else the stored format), and stores
 * the result in the same shared edge cache the original lives in. The client
 * (`ui/SafeImage`, `storefront/parts`) names exactly those five widths in a
 * `srcset` for `/files/` pictures and leaves every other source untouched.
 *
 * What these pin: the width allow-list and the refusals (a private key, a
 * non-image, a width off the list); the format negotiation; the response
 * headers (the original's cache policy, `Vary: Accept`, a variant ETag, a 304
 * on it); the cache — a second request for the same variant reaches neither
 * the binding nor the bucket, and the ORIGINAL is fetched from R2 once for
 * every width cut from it; the honest fallback without the binding; and that
 * the client's list and the server's list are the same list.
 *
 * Run: node --import tsx --test tests/imageVariants.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asD1, ctx, freshDb, pending, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { fileRoutes, imageVariantCacheKey } from '../worker/routes/uploads';
import {
  IMAGE_VARIANT_WIDTHS,
  negotiateVariantFormat,
  parseVariantWidth,
  variantSourceMime,
} from '../worker/lib/imageConvert';

// ------------------------------------------------------------ the pure parts

test('the width list is closed: five widths, anything else is invalid, absence is null', () => {
  assert.deepEqual([...IMAGE_VARIANT_WIDTHS], [160, 320, 480, 640, 1080]);
  assert.equal(parseVariantWidth('160'), 160);
  assert.equal(parseVariantWidth('320'), 320);
  assert.equal(parseVariantWidth('480'), 480);
  assert.equal(parseVariantWidth('640'), 640);
  assert.equal(parseVariantWidth('1080'), 1080);
  assert.equal(parseVariantWidth(undefined), null);
  assert.equal(parseVariantWidth(''), null);
  for (const bad of ['159', '321', '481', '0', '-640', '3000', '640.5', 'abc', '1e3']) {
    assert.equal(parseVariantWidth(bad), 'invalid', `w=${bad} must not mint a new size`);
  }
});

test('only a still picture, read from the key, can be cut; GIF and video cannot', () => {
  assert.equal(variantSourceMime('products/p1/a.webp'), 'image/webp');
  assert.equal(variantSourceMime('merchants/u/public/x.JPG'), 'image/jpeg');
  assert.equal(variantSourceMime('users/u/posts/y.jpeg'), 'image/jpeg');
  assert.equal(variantSourceMime('UiUx/Logo/Logo.png'), 'image/png');
  assert.equal(variantSourceMime('merchants/u/public/clip.mp4'), null);
  assert.equal(variantSourceMime('products/banner.gif'), null, 'a resize keeps one frame of an animation');
  assert.equal(variantSourceMime('products/p1/a.svg'), null);
  assert.equal(variantSourceMime('products/p1/noext'), null);
});

test('the format follows Accept: AVIF, else WebP, else what is stored', () => {
  assert.equal(negotiateVariantFormat('image/avif,image/webp,image/apng,*/*;q=0.8', 'image/webp'), 'image/avif');
  assert.equal(negotiateVariantFormat('image/webp,*/*', 'image/jpeg'), 'image/webp');
  assert.equal(negotiateVariantFormat('*/*', 'image/png'), 'image/png', 'a PNG keeps its transparency');
  assert.equal(negotiateVariantFormat('*/*', 'image/webp'), 'image/webp');
  assert.equal(negotiateVariantFormat(undefined, 'image/jpeg'), 'image/jpeg');
});

test('the client names exactly the widths the server cuts — in both places that emit a srcset', () => {
  const safeImage = readFileSync(join(ROOT, 'src/components/ui/SafeImage.tsx'), 'utf8');
  const parts = readFileSync(join(ROOT, 'src/components/storefront/parts.tsx'), 'utf8');
  const server = `[${IMAGE_VARIANT_WIDTHS.join(', ')}]`;
  assert.ok(safeImage.includes(`export const IMAGE_VARIANT_WIDTHS = ${server} as const;`), 'SafeImage lists the server widths');
  assert.ok(parts.includes(`const VARIANT_WIDTHS = ${server} as const;`), 'the store tile lists the server widths');
  // Both only ever address a same-origin /files/ still picture with no query of its own
  // (SafeImage also takes the absolute form older catalogue rows carry; a store's rows are relative).
  assert.ok(safeImage.includes("/^(?:https?:\\/\\/[^/?#]+)?\\/files\\/[^?#]+\\.(?:webp|jpe?g|png)$/i"), 'SafeImage guards the source');
  assert.ok(parts.includes("/^\\/files\\/[^?#]+\\.(?:webp|jpe?g|png)$/i.test(src)"), 'the store tile guards the source');
  // And the store tile does NOT import SafeImage for it: a store visit must not carry that component.
  assert.ok(!/from '\.\.\/ui\/SafeImage'/.test(parts));
  // SafeImage: the srcset is opt-in through `sizes` (a preloaded hero keeps its address), eager images do not fade.
  assert.match(safeImage, /const srcSet = sizes && cleanSrc \? variantSrcSet\(cleanSrc\) : undefined;/);
  assert.match(safeImage, /srcSet=\{srcSet\}\s*sizes=\{srcSet \? sizes : undefined\}/);
  assert.match(safeImage, /const revealCls = eager\s*\? 'opacity-100'/);
  // The three card sites say how wide they are.
  for (const rel of ['src/components/home/ProductCard.tsx', 'src/components/community/hub/ProductTile.tsx']) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(src, /<SafeImage[\s\S]*?sizes="[^"]+"/, `${rel} passes sizes`);
  }
  assert.match(parts, /srcSet=\{variantSrcSet\(image\)\}\s*sizes="[^"]+"/, 'the store tile passes sizes');
});

// ----------------------------------------------------------------- the route

/** An R2-shaped bucket that records every read. */
class Bucket {
  reads: string[] = [];
  objects = new Map<string, { bytes: Uint8Array; type: string }>();
  async get(key: string) {
    this.reads.push(`get ${key}`);
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      body: new Blob([o.bytes as unknown as BlobPart]).stream(),
      size: o.bytes.byteLength,
      httpEtag: `"etag-${key}"`,
      writeHttpMetadata(headers: Headers) {
        headers.set('Content-Type', o.type);
      },
    };
  }
  async head(key: string) {
    this.reads.push(`head ${key}`);
    const o = this.objects.get(key);
    return o ? { key, size: o.bytes.byteLength, httpEtag: `"etag-${key}"` } : null;
  }
}

/** The IMAGES binding as the route uses it, stubbed the way tests/productMediaIngest.test.ts stubs it — plus `transform`. */
function imagesBinding(opts: { fail?: boolean } = {}) {
  const calls: { width?: number; fit?: string; format: string; quality?: number }[] = [];
  const binding = {
    input(_stream: ReadableStream) {
      const pendingTransform: { width?: number; fit?: string } = {};
      const handle = {
        transform(t: { width?: number; fit?: string }) {
          Object.assign(pendingTransform, t);
          return handle;
        },
        async output(o: { format: string; quality?: number }) {
          calls.push({ ...pendingTransform, ...o });
          const out = new TextEncoder().encode(`variant:${pendingTransform.width}:${o.format}`);
          return { response: () => (opts.fail ? new Response('no', { status: 500 }) : new Response(out)) };
        },
      };
      return handle;
    },
  };
  return { calls, binding };
}

/** `caches.default` as the Workers runtime provides it: keyed by URL, whole responses, nothing else. */
class MemCache {
  store = new Map<string, { status: number; headers: [string, string][]; bytes: Uint8Array }>();
  matches: string[] = [];
  async match(req: Request) {
    this.matches.push(req.url);
    const e = this.store.get(req.url);
    return e ? new Response(e.bytes.slice(), { status: e.status, headers: e.headers }) : undefined;
  }
  async put(req: Request, res: Response) {
    const headers: [string, string][] = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    this.store.set(req.url, { status: res.status, headers, bytes: new Uint8Array(await res.arrayBuffer()) });
  }
}

const PUBLIC_KEY = 'products/p1/photo.webp';
const PRIVATE_KEY = 'receipts/u1/scan.jpg';
const VIDEO_KEY = 'merchants/u1/public/clip.mp4';
const PHOTO = new TextEncoder().encode('RIFF....WEBPVP8 original-bytes-of-the-photo');

function setup(opts: { images?: unknown; cache?: MemCache } = {}) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','U','u@x.co','h','customer');`);
  const bucket = new Bucket();
  bucket.objects.set(PUBLIC_KEY, { bytes: PHOTO, type: 'image/webp' });
  bucket.objects.set(PRIVATE_KEY, { bytes: PHOTO, type: 'image/jpeg' });
  bucket.objects.set(VIDEO_KEY, { bytes: PHOTO, type: 'video/mp4' });
  const app = stubApp(asD1(raw), { id: 'u1', role: 'customer', email: 'u@x.co' }, (a) => a.route('/files', fileRoutes), {
    env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket, ...(opts.images ? { IMAGES: opts.images } : {}) },
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
  return { bucket, fetchIt };
}

test('a public picture at a listed width goes through the binding at that width, in the negotiated format', async () => {
  const images = imagesBinding();
  const { bucket, fetchIt } = setup({ images: images.binding });
  const res = await fetchIt(`/files/${PUBLIC_KEY}?w=640`, { Accept: 'image/avif,image/webp,*/*' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/avif');
  assert.equal(await res.text(), 'variant:640:image/avif');
  assert.deepEqual(images.calls, [{ width: 640, fit: 'scale-down', format: 'image/avif', quality: 75 }]);
  assert.deepEqual(bucket.reads, [`get ${PUBLIC_KEY}`], 'the original was read once, with no HEAD');
  // The headers a card's picture needs.
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=31536000, immutable', 'a minted key keeps its policy');
  assert.equal(res.headers.get('Vary'), 'Accept', 'the AVIF is never handed to a browser that asked for WebP');
  assert.equal(res.headers.get('etag'), `"etag-${PUBLIC_KEY}-w640-avif"`);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");

  const webp = await fetchIt(`/files/${PUBLIC_KEY}?w=320`, { Accept: 'image/webp,*/*' });
  assert.equal(webp.headers.get('Content-Type'), 'image/webp');
  assert.equal(images.calls[1]?.quality, 85, 'WebP keeps the converter’s own quality');
  const plain = await fetchIt(`/files/${PUBLIC_KEY}?w=1080`, { Accept: '*/*' });
  assert.equal(plain.headers.get('Content-Type'), 'image/webp', 'the stored format is the floor');
});

test('a width off the list, a private key and a non-image are refused — and touch no byte', async () => {
  const images = imagesBinding();
  const { bucket, fetchIt } = setup({ images: images.binding });
  const odd = await fetchIt(`/files/${PUBLIC_KEY}?w=500`);
  assert.equal(odd.status, 400);
  assert.equal(((await odd.json()) as { code: string }).code, 'IMAGE_VARIANT_WIDTH');
  // The signed-in owner of the receipt may read it, but not as a variant: private bytes never enter the shared cache.
  for (const width of [160, 320, 480]) {
    const priv = await fetchIt(`/files/${PRIVATE_KEY}?w=${width}`);
    assert.equal(priv.status, 400);
    assert.equal(((await priv.json()) as { code: string }).code, 'IMAGE_VARIANT_PRIVATE');
    const video = await fetchIt(`/files/${VIDEO_KEY}?w=${width}`);
    assert.equal(video.status, 400);
    assert.equal(((await video.json()) as { code: string }).code, 'IMAGE_VARIANT_NOT_IMAGE');
  }
  assert.deepEqual(bucket.reads, [], 'no refusal reached the bucket');
  assert.deepEqual(images.calls, [], 'nor the binding');
  // The private receipt itself is still served to its owner, exactly as before.
  const own = await fetchIt(`/files/${PRIVATE_KEY}`);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('Cache-Control'), 'private, max-age=300');
});

test('thumbnail and intermediate widths transform once and cache independently without refetching the original', async () => {
  const images = imagesBinding();
  const cache = new MemCache();
  const { bucket, fetchIt } = setup({ images: images.binding, cache });
  for (const [width, format, extension] of [[160, 'image/webp', 'webp'], [480, 'image/avif', 'avif']] as const) {
    const path = `/files/${PUBLIC_KEY}?w=${width}`;
    const first = await fetchIt(path, { Accept: format });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Content-Type'), format);
    assert.equal(first.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    assert.equal(first.headers.get('ETag'), `"etag-${PUBLIC_KEY}-w${width}-${extension}"`);
    assert.equal(await first.text(), `variant:${width}:${format}`);
    assert.ok([...cache.store.keys()].some((key) => key.endsWith(`/files/${PUBLIC_KEY}?w=${width}&f=${extension}`)));

    const cached = await fetchIt(path, { Accept: format });
    assert.equal(cached.status, 200);
    assert.equal(await cached.text(), `variant:${width}:${format}`);
    const unchanged = await fetchIt(path, { Accept: format, 'If-None-Match': `"etag-${PUBLIC_KEY}-w${width}-${extension}"` });
    assert.equal(unchanged.status, 304);
  }
  assert.deepEqual(images.calls, [
    { width: 160, fit: 'scale-down', format: 'image/webp', quality: 85 },
    { width: 480, fit: 'scale-down', format: 'image/avif', quality: 75 },
  ]);
  assert.deepEqual(bucket.reads, [`get ${PUBLIC_KEY}`], 'both sizes share the cached original, but not each other’s result');
});

test('the variant is cached: a second request reaches neither the binding nor the bucket, and 304s on its ETag', async () => {
  const images = imagesBinding();
  const cache = new MemCache();
  const { bucket, fetchIt } = setup({ images: images.binding, cache });
  const first = await fetchIt(`/files/${PUBLIC_KEY}?w=640`, { Accept: 'image/webp' });
  assert.equal(first.status, 200);
  assert.equal(bucket.reads.length, 1);
  assert.equal(images.calls.length, 1);
  const stored = [...cache.store.keys()];
  assert.ok(stored.some((u) => u.endsWith(`/files/${PUBLIC_KEY}`)), 'the ORIGINAL was written to the cache too');
  assert.ok(stored.some((u) => u.endsWith(`/files/${PUBLIC_KEY}?w=640&f=webp`)), `the variant is filed under its width and format: ${stored}`);

  const second = await fetchIt(`/files/${PUBLIC_KEY}?w=640`, { Accept: 'image/webp' });
  assert.equal(second.status, 200);
  assert.equal(await second.text(), 'variant:640:image/webp');
  assert.equal(bucket.reads.length, 1, 'no second R2 read');
  assert.equal(images.calls.length, 1, 'no second transformation');

  // Another width of the same picture: the original comes from the cache, so R2 is still at one read.
  const other = await fetchIt(`/files/${PUBLIC_KEY}?w=320`, { Accept: 'image/webp' });
  assert.equal(other.status, 200);
  assert.equal(bucket.reads.length, 1, 'the original was read from the edge, not from R2');
  assert.equal(images.calls.length, 2);

  // A different Accept is a different entry — the WebP is never handed to an AVIF request.
  const avif = await fetchIt(`/files/${PUBLIC_KEY}?w=640`, { Accept: 'image/avif,image/webp' });
  assert.equal(avif.headers.get('Content-Type'), 'image/avif');
  assert.equal(images.calls.length, 3);

  // A browser holding the variant revalidates for a header, not a body.
  const cond = await fetchIt(`/files/${PUBLIC_KEY}?w=640`, { Accept: 'image/webp', 'If-None-Match': `"etag-${PUBLIC_KEY}-w640-webp"` });
  assert.equal(cond.status, 304);
  assert.equal(images.calls.length, 3);
  // The client's own query order or extras do not fork the cache key.
  const key = imageVariantCacheKey(new Request(`https://levonis-iq.com/files/${PUBLIC_KEY}?x=1&w=640`), PUBLIC_KEY, 640, 'image/webp');
  assert.equal(key.url, `https://levonis-iq.com/files/${PUBLIC_KEY}?w=640&f=webp`);
});

test('without the binding, or when it fails, the visitor gets the original — never an error', async () => {
  const { bucket, fetchIt } = setup();
  const res = await fetchIt(`/files/${PUBLIC_KEY}?w=640`, { Accept: 'image/avif' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/webp');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PHOTO);
  assert.deepEqual(bucket.reads, [`get ${PUBLIC_KEY}`], 'one read, no retry');

  const failing = imagesBinding({ fail: true });
  const again = setup({ images: failing.binding });
  const fallback = await again.fetchIt(`/files/${PUBLIC_KEY}?w=320`, { Accept: 'image/avif' });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get('Content-Type'), 'image/webp');
  assert.deepEqual(new Uint8Array(await fallback.arrayBuffer()), PHOTO);
  assert.equal(failing.calls.length, 1, 'the binding was tried once');
});

test('the plain request is untouched by the variant route: same headers, no binding call', async () => {
  const images = imagesBinding();
  const { fetchIt } = setup({ images: images.binding });
  const res = await fetchIt(`/files/${PUBLIC_KEY}`, { Accept: 'image/avif' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/webp');
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(res.headers.get('Content-Length'), String(PHOTO.byteLength));
  assert.equal(res.headers.get('Vary'), null);
  assert.deepEqual(images.calls, []);
});
