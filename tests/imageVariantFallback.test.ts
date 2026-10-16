/**
 * ?w=1280 AND ?w=1600 OF A LARGE PICTURE ARE A SMALL COPY, CUT ONCE AND KEPT
 * (speed audit 2026-10-16, «?w=1280 and ?w=1600 return the untouched original
 * WebP (up to 852 KB), uncached, after a failed AVIF render on every request»).
 *
 * Seen live: the IMAGES binding answers no AVIF for a large picture at a large
 * rung — a 1254² photo at its own size, 1280 and 1600 of a 2992² one — while
 * every rung up to 1080, and the same rung in WebP, are fine. The route then
 * served the ORIGINAL (65–852 KB), stored nothing, cached nothing, and asked
 * the binding again on every request; the sweep marked the whole picture
 * unreadable at its top rung. The double here refuses AVIF the same way
 * (`avifMaxPixels`). What is pinned:
 *
 *   - such a rung is cut in WebP at its full size, served, and kept in the AVIF
 *     place (fmt webp, its own Content-Type), so the next request anywhere is
 *     an R2 read and the binding is never asked again;
 *   - ?w=1600 of a 1254 px picture is its ?w=1280 copy (`clampRung`), read from
 *     R2 when kept, cut once when not;
 *   - when no copy can be had the original goes out as before, and this data
 *     centre keeps it under the copy's address for an hour: one failed cut, not one per request;
 *   - the upload warm-up and the sweep make the top rung the same way, and no
 *     large photo is marked unreadable for it;
 *   - a browser that takes no WebP never gets a WebP from the AVIF place.
 *
 * Run: node --import tsx --test tests/imageVariantFallback.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, ctx, freshDb, pending, stubApp } from './fixtures/app';
import { MemCache, R2Double, dimsOf, imagesDouble, webpBytes } from './fixtures/imageDoubles';
import { fileRoutes } from '../worker/routes/uploads';
import { clampRung, cutVariant, rungsFor, sweepImageVariants, warmImageVariants } from '../worker/lib/imageVariants';
import { variantObjectKey } from '../worker/lib/variantKeys';

const KEY = 'products/catalog/gallery/light.webp';
const ORIGINAL = webpBytes(1254, 1254, { pad: 4000 });
/** The live binding's ceiling, between the 1080² that works and the 1254² that does not. */
const AVIF_CEILING = 1_200_000;

function ceilingBinding() {
  const images = imagesDouble();
  images.state.avifMaxPixels = AVIF_CEILING;
  return images;
}

function setup(opts: { images?: ReturnType<typeof imagesDouble>; cache?: MemCache } = {}) {
  const bucket = new R2Double();
  bucket.seed(KEY, ORIGINAL, { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
  const images = opts.images ?? ceilingBinding();
  const app = stubApp(asD1(freshDb()), null, (a) => a.route('/files', fileRoutes), {
    env: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket, IMAGES: images.binding },
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

const AVIF = { Accept: 'image/avif,image/webp,image/apng,*/*;q=0.8' };
const etag = (b: R2Double) => b.objects.get(KEY)!.etag;

test('the rung a request needs: the one asked, or past the picture\'s own size the rung that IS its own size', () => {
  assert.equal(clampRung(1600, 1254), 1280);
  assert.equal(clampRung(1280, 1254), 1280);
  assert.equal(clampRung(1080, 1254), 1080);
  assert.equal(clampRung(1600, 2992), 1600, 'a picture wider than the top rung needs every rung');
  assert.equal(clampRung(800, 500), 640);
  assert.equal(clampRung(1600, null), 1600, 'an unknown width clamps nothing');
});

test('a rung the binding will not encode in AVIF is cut in WebP at its full size, served, and kept in the AVIF place', async () => {
  const { bucket, images, fetchIt } = setup();
  const res = await fetchIt(`/files/${KEY}?w=1280`, AVIF);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Variant-Source'), 'render');
  assert.equal(res.headers.get('Content-Type'), 'image/webp', 'what the bytes are — every AVIF browser takes WebP');
  const body = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(dimsOf(body), { format: 'image/webp', width: 1254, height: 1254 }, 'the picture at its full size: only the codec changed');
  assert.ok(body.byteLength < ORIGINAL.byteLength);
  assert.equal(res.headers.get('etag'), `"${etag(bucket)}-w1280-webp"`);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(images.calls.map((c) => c.format), ['image/avif', 'image/webp'], 'AVIF once, then WebP');
  const kept = bucket.objects.get(variantObjectKey(KEY, 1280, 'avif'))!;
  assert.ok(kept, 'kept in the AVIF place');
  assert.equal(kept.contentType, 'image/webp');
  assert.deepEqual(kept.custom, { src: KEY, src_etag: etag(bucket), w: '1280', width: '1254', height: '1254', fmt: 'webp', q: '75', ver: '1' });

  // Any later request, from any data centre: R2, never the binding again.
  bucket.ops.length = 0;
  const again = await fetchIt(`/files/${KEY}?w=1280`, AVIF);
  assert.equal(again.headers.get('X-Variant-Source'), 'r2');
  assert.equal(again.headers.get('Content-Type'), 'image/webp');
  assert.equal(again.headers.get('etag'), `"${etag(bucket)}-w1280-webp"`);
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), body);
  assert.equal(images.calls.length, 2, 'not asked again');
  assert.deepEqual(bucket.ops, [`get variants/v1/${KEY}/w1280.avif`], 'one R2 read, no original');
  const revalidated = await fetchIt(`/files/${KEY}?w=1280`, { ...AVIF, 'If-None-Match': `"${etag(bucket)}-w1280-webp"` });
  assert.equal(revalidated.status, 304);
  // A rung the binding CAN encode stays AVIF.
  const small = await fetchIt(`/files/${KEY}?w=1080`, AVIF);
  assert.equal(small.headers.get('Content-Type'), 'image/avif');
});

test('?w=1600 of a 1254 px picture is its ?w=1280 copy: read from R2 when kept, cut once when not, and edge-cached under 1600', async () => {
  const cache = new MemCache();
  const { bucket, images, fetchIt } = setup({ cache });
  const first = await fetchIt(`/files/${KEY}?w=1600`, AVIF);
  assert.deepEqual(dimsOf(new Uint8Array(await first.arrayBuffer())), { format: 'image/webp', width: 1254, height: 1254 });
  assert.equal(first.headers.get('etag'), `"${etag(bucket)}-w1280-webp"`, 'one copy, one validator, whichever width named it');
  assert.ok(bucket.objects.has(variantObjectKey(KEY, 1280, 'avif')));
  assert.equal(bucket.objects.has(variantObjectKey(KEY, 1600, 'avif')), false, 'never a second copy of the same bytes');
  assert.equal(images.calls.length, 2);

  // The next ?w=1600 in this data centre: the edge, nothing else.
  bucket.ops.length = 0;
  const edge = await fetchIt(`/files/${KEY}?w=1600`, AVIF);
  assert.equal(edge.headers.get('X-Variant-Source'), 'edge');
  assert.deepEqual(bucket.ops, []);

  // Another data centre (empty edge), the 1280 copy kept: no cut — the kept copy answers.
  const elsewhere = setup();
  await elsewhere.fetchIt(`/files/${KEY}?w=1280`, AVIF);
  const callsBefore = elsewhere.images.calls.length;
  const fromKept = await elsewhere.fetchIt(`/files/${KEY}?w=1600`, AVIF);
  assert.equal(fromKept.headers.get('X-Variant-Source'), 'r2');
  assert.equal(fromKept.headers.get('Content-Type'), 'image/webp');
  assert.equal(elsewhere.images.calls.length, callsBefore, 'the binding is not asked');
});

test('when no copy can be had, the original goes out as before — and this data centre keeps it an hour instead of failing per request', async () => {
  const cache = new MemCache();
  const images = imagesDouble('http500');
  const { bucket, fetchIt } = setup({ images, cache });
  const first = await fetchIt(`/files/${KEY}?w=1280`, AVIF);
  assert.equal(first.status, 200);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), ORIGINAL);
  assert.equal(first.headers.get('X-Variant-Source'), 'original');
  assert.equal(first.headers.get('Cache-Control'), 'public, max-age=3600', 'short: a copy replaces it once one can be cut');
  assert.deepEqual(bucket.keys('variants/'), [], 'nothing in R2');
  const callsAfterFirst = images.calls.length;
  const second = await fetchIt(`/files/${KEY}?w=1280`, AVIF);
  assert.equal(second.headers.get('X-Variant-Source'), 'edge');
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), ORIGINAL);
  assert.equal(images.calls.length, callsAfterFirst, 'the binding is not asked again for every request');
});

test('a browser that takes no WebP never gets the WebP kept in the AVIF place', async () => {
  const { bucket, fetchIt } = setup();
  await fetchIt(`/files/${KEY}?w=1280`, AVIF);
  assert.equal(bucket.objects.get(variantObjectKey(KEY, 1280, 'avif'))!.custom!.fmt, 'webp');
  const res = await fetchIt(`/files/${KEY}?w=1280`, { Accept: 'image/avif' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Variant-Source'), 'original', 'the original, exactly as /files/<key> sends it — never the WebP copy');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), ORIGINAL);
  assert.equal(bucket.objects.get(variantObjectKey(KEY, 1280, 'avif'))!.custom!.fmt, 'webp', 'and the kept copy is left as it was');
});

test('only an answer in the wrong format is retried in WebP: a refusal or a throw is the picture\'s or the binding\'s', async () => {
  const source = async () => new Blob([ORIGINAL as unknown as BlobPart]);
  const ceiling = ceilingBinding();
  const fell = await cutVariant({ IMAGES: ceiling.binding } as never, source, { width: 1280, format: 'image/avif', sourceWidth: 1254 }, { webpFallback: true });
  assert.equal(fell.attempts, 2);
  assert.ok(fell.outcome.ok && fell.outcome.mime === 'image/webp');
  const noFallback = await cutVariant({ IMAGES: ceilingBinding().binding } as never, source, { width: 1280, format: 'image/avif', sourceWidth: 1254 }, { webpFallback: false });
  assert.equal(noFallback.attempts, 1);
  assert.equal(noFallback.outcome.ok, false);
  for (const mode of ['http500', 'throw9422'] as const) {
    const r = await cutVariant({ IMAGES: imagesDouble(mode).binding } as never, source, { width: 1280, format: 'image/avif', sourceWidth: 1254 }, { webpFallback: true });
    assert.equal(r.attempts, 1, mode);
  }
});

test('the upload warm-up and the sweep make the top rung too, and mark no large photo unreadable for it', async () => {
  const pub = new R2Double();
  pub.seed(KEY, ORIGINAL, { contentType: 'image/webp' });
  const warm = await warmImageVariants({ IMAGES: ceilingBinding().binding, R2_PUBLIC: pub, BUCKET: pub, R2_PRIVATE: new R2Double() } as never, { key: KEY, bytes: ORIGINAL, width: 1254 });
  assert.deepEqual(warm, { made: rungsFor(1254).length, failed: 0, skipped: null });
  assert.equal(pub.objects.get(variantObjectKey(KEY, 1280, 'avif'))!.custom!.fmt, 'webp');
  assert.equal(pub.objects.get(variantObjectKey(KEY, 1080, 'avif'))!.custom!.fmt, 'avif');
  assert.ok(pub.objects.has(`variants/v1/${KEY}/done`));

  const swept = new R2Double();
  swept.seed(KEY, ORIGINAL, { contentType: 'image/webp' });
  swept.seed('products/catalog/gallery/huge.webp', webpBytes(2992, 2992));
  const report = await sweepImageVariants({ IMAGES: ceilingBinding().binding, R2_PUBLIC: swept, BUCKET: swept, R2_PRIVATE: new R2Double() } as never, { limits: { transforms: 100, operations: 500 } });
  assert.equal(report.unreadable, 0, 'before: the top rung marked the whole photo unreadable');
  assert.equal(report.completed, 2);
  for (const [key, rungs] of [[KEY, rungsFor(1254)], ['products/catalog/gallery/huge.webp', rungsFor(2992)]] as const) {
    for (const rung of rungs) assert.ok(swept.objects.has(variantObjectKey(key, rung, 'avif')), `${key} w${rung}`);
    assert.equal(swept.objects.get(`variants/v1/${key}/done`)!.custom!.skip, undefined);
  }
  assert.equal(swept.objects.get(variantObjectKey('products/catalog/gallery/huge.webp', 1600, 'avif'))!.custom!.fmt, 'webp');
  assert.equal(swept.objects.get(variantObjectKey('products/catalog/gallery/huge.webp', 1080, 'avif'))!.custom!.fmt, 'avif');
});
