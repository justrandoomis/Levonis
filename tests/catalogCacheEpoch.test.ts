/**
 * THE CATALOGUE CACHE EPOCH (the clean start, spec addendum A.4, A.12.4).
 *
 * Every edge-cached catalogue answer is keyed with CATALOG_CACHE_EPOCH, so an
 * answer cached before the cut-over (legacy prices, products now hidden) is
 * never served after it: the first request of the new Worker misses and
 * rebuilds through the listing predicate.
 *
 * Run: node --import tsx --test tests/catalogCacheEpoch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeOf } from './fixtures/source';
import { CATALOG_CACHE_EPOCH, withCacheEpoch } from '../worker/lib/publicApi/cache';
import { canonicalKey } from '../worker/lib/edgePolicy';

test('withCacheEpoch appends the epoch last, after any declared parameter', () => {
  assert.equal(CATALOG_CACHE_EPOCH, 'catalog-only-2026-10-15');
  assert.equal(withCacheEpoch('https://levonis-iq.com/api/catalog/tree'), 'https://levonis-iq.com/api/catalog/tree?__cv=catalog-only-2026-10-15');
  assert.equal(withCacheEpoch('https://levonis-iq.com/api/products?page=2'), 'https://levonis-iq.com/api/products?page=2&__cv=catalog-only-2026-10-15');
  const key = canonicalKey('https://levonis-iq.com/api/products?page=2&junk=1', ['page']);
  assert.equal(new URL(key.url).searchParams.get('__cv'), CATALOG_CACHE_EPOCH);
  assert.equal(new URL(key.url).searchParams.get('junk'), null);
});

test('every catalogue edge-cache key in the Worker carries the epoch', () => {
  for (const file of ['worker/lib/edgePolicy.ts', 'worker/routes/catalog.ts', 'worker/routes/communitySearch.ts', 'worker/routes/publicApi.ts', 'worker/routes/printerFinder.ts']) {
    const code = codeOf(file);
    const keys = [...code.matchAll(/new Request\(([^;]+?)\{ method: 'GET' \}\)/g)].map((m) => m[1]!);
    assert.ok(keys.length > 0, `${file}: no cache key found`);
    for (const k of keys) assert.match(k, /withCacheEpoch\(/, `${file}: a cache key without the epoch: ${k.slice(0, 80)}`);
  }
});
