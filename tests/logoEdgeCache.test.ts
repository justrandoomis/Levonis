/**
 * «الشعار الجديد في R2 لكن الموقع يظهر القديم» — THE COPY AT THE EDGE.
 *
 * The live cause, measured: an IAD `caches.default` entry for
 * `/files/UiUx/Logo/Logo.webp` written while rewritable keys were still
 * served `immutable` for a year (etag 4112c29c…, 70,084 bytes, `age` over four
 * days) kept answering after the Cache-Control fix shipped, because a Cache
 * API entry keeps the TTL it was written with. The fix files rewritable keys
 * under a new cache key, so every entry from before is never looked up again.
 *
 * Run: node --import tsx --test tests/logoEdgeCache.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { REWRITABLE_EDGE_GENERATION, edgeCacheKey, edgeCachePutKey } from '../worker/routes/uploads';
import { SITE_LOGO_KEY } from '../src/lib/siteLogo';

const ORIGIN = 'https://levonis-iq.com';

test('the logo is cached under a key no pre-fix entry was ever written under', () => {
  const request = new Request(`${ORIGIN}/files/${SITE_LOGO_KEY}`, { headers: { 'If-None-Match': '"x"' } });
  const keyed = edgeCacheKey(request, SITE_LOGO_KEY);
  assert.notEqual(keyed.url, request.url, 'the stale immutable entry under the plain URL would still answer');
  assert.equal(new URL(keyed.url).searchParams.get('__edge'), REWRITABLE_EDGE_GENERATION);
  assert.equal(new URL(keyed.url).pathname, `/files/${SITE_LOGO_KEY}`, 'the path, and so the R2 key, is unchanged');
  assert.equal(keyed.headers.get('If-None-Match'), '"x"', 'conditional headers are carried over');
});

test('a versioned logo URL keeps its version inside the cache key', () => {
  const request = new Request(`${ORIGIN}/files/${SITE_LOGO_KEY}?v=bc80fc2b`);
  const url = new URL(edgeCacheKey(request, SITE_LOGO_KEY).url);
  assert.equal(url.searchParams.get('v'), 'bc80fc2b');
  assert.equal(url.searchParams.get('__edge'), REWRITABLE_EDGE_GENERATION);
});

test('every rewritable folder moves; a minted key keeps its warm entry', () => {
  for (const key of ['UiUx/MainPage/Bundle.webp', 'brands/bambu.webp', 'services/print.webp']) {
    const request = new Request(`${ORIGIN}/files/${key}`);
    assert.notEqual(edgeCacheKey(request, key).url, request.url, key);
  }
  const minted = new Request(`${ORIGIN}/files/products/p1/abc123.webp`);
  assert.equal(edgeCacheKey(minted, 'products/p1/abc123.webp'), minted, 'a content-addressed key never changes bytes');
});

test('the /files route matches AND writes through the same edge key', () => {
  const src = readFileSync(join(ROOT, 'worker/routes/uploads.ts'), 'utf8');
  assert.ok(src.includes('cache.match(edgeCacheKey(c.req.raw, key))'), 'lookups still use the plain URL');
  // Since P2c the write goes through `edgeCachePutKey`: the same edge key with
  // the player's Range/If-Range stripped, because what is stored is the whole
  // file and every later request — ranged or not — must find it under one key.
  assert.ok(src.includes('cache.put(edgeCachePutKey(c.req.raw, key), res.clone())'), 'writes still use the plain URL');
  assert.ok(!src.includes('cache.match(c.req.raw)'), 'a lookup under the plain URL survives');
  assert.ok(!src.includes('cache.put(c.req.raw'), 'a write under the plain URL survives');
  const ranged = new Request(`${ORIGIN}/files/${SITE_LOGO_KEY}`, { headers: { Range: 'bytes=0-1', 'If-Range': '"x"' } });
  const put = edgeCachePutKey(ranged, SITE_LOGO_KEY);
  assert.equal(put.url, edgeCacheKey(new Request(`${ORIGIN}/files/${SITE_LOGO_KEY}`), SITE_LOGO_KEY).url, 'the put key is the match key of the plain request');
  assert.equal(put.headers.get('Range'), null);
  assert.equal(put.headers.get('If-Range'), null);
});
