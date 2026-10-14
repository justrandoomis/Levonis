/**
 * A DELETED PICTURE'S SMALL COPIES LEAVE THE EDGE WITH IT (found by the
 * security verification of DECISIONS row 226; older than it).
 *
 * `/files/<key>?w=` answers are edge entries of their own, one per width and
 * format, under the current key (`?w=&f=&v=`) and the one without `v` that
 * earlier deploys wrote. `invalidateMediaCache` (worker/lib/productDeletion.ts,
 * what a product delete calls) now drops them with `/files/<key>`, so the data
 * centre that deleted a picture stops answering its copies at once — not a
 * year later.
 *
 * LOCAL ONLY. Run: node --import tsx --test tests/imageDeleteEdgeCopies.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, ctx, freshDb, pending, stubApp } from './fixtures/app';
import { MemCache, R2Double, imagesDouble, webpBytes } from './fixtures/imageDoubles';
import { fileRoutes } from '../worker/routes/uploads';
import { deleteMediaObject } from '../worker/lib/mediaStorage';
import { invalidateMediaCache } from '../worker/lib/productDeletion';

const KEY = 'products/catalog/gallery/deadbeef.webp';
const AVIF = { Accept: 'image/avif,image/webp,*/*' };

test('after delete + invalidateMediaCache, this data centre answers neither the picture nor its copies', async () => {
  const bucket = new R2Double();
  bucket.seed(KEY, webpBytes(1254, 1254, { pad: 400 }), { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
  const images = imagesDouble();
  const cache = new MemCache();
  // `caches.default.delete(url)` as the runtime has it (the shared double has no delete).
  (cache as unknown as { delete: (r: Request | string) => Promise<boolean> }).delete = async (r) => cache.store.delete(typeof r === 'string' ? r : r.url);
  const app = stubApp(asD1(freshDb()), null, (a) => a.route('/files', fileRoutes), { env: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket, IMAGES: images.binding } });
  const g = globalThis as { caches?: unknown };
  const fetchIt = async (path: string, headers: Record<string, string> = {}) => {
    g.caches = { default: cache };
    try {
      const res = await app.request(`http://localhost${path}`, { headers }, undefined, ctx);
      await Promise.all(pending.splice(0));
      return res;
    } finally {
      delete g.caches;
    }
  };

  assert.equal((await fetchIt(`/files/${KEY}`)).status, 200);
  assert.equal((await fetchIt(`/files/${KEY}?w=320`, AVIF)).status, 200);

  // The owner deletes the picture: R2 original, its R2 copies, and this colo's cache entry for /files/<key>.
  await deleteMediaObject({ BUCKET: bucket as unknown as R2Bucket, R2_PUBLIC: bucket as unknown as R2Bucket }, 'public', KEY);
  g.caches = { default: cache };
  const invalidated = await invalidateMediaCache('http://localhost', [KEY]).finally(() => { delete g.caches; });
  assert.deepEqual(bucket.keys(), [], 'nothing left in R2');

  const plain = await fetchIt(`/files/${KEY}`);
  const copy = await fetchIt(`/files/${KEY}?w=320`, AVIF);
  const evidence = {
    invalidated,
    plain: plain.status,
    copy: copy.status,
    copySource: copy.headers.get('X-Variant-Source'),
    copyCacheControl: copy.headers.get('Cache-Control'),
    edgeKeysLeft: [...cache.store.keys()],
  };
  assert.equal(evidence.plain, 404);
  assert.equal(evidence.copy, 404, `a deleted picture's copy must not be served; ${JSON.stringify(evidence)}`);
});
