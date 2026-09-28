/**
 * AN ANSWER FROM THE EDGE CACHE KEEPS ITS ROUTE'S OWN BROWSER LIFETIME.
 *
 * Seen live on 2026-09-28: Cloudflare hands a Cache API hit back with its
 * `max-age` raised to the zone's Browser Cache TTL — `public, max-age=14400,
 * s-maxage=300` for /api/catalog/tree, whose own policy is `max-age=60`. A
 * visitor's browser then kept the section map for four hours after an admin
 * changed it (the tree's purge clears the edge, never a browser).
 *
 * Every route that serves a Cache API hit therefore sets its own
 * `Cache-Control` on it. The cache here is a stand-in that does to a hit what
 * the live zone does. (The public API's own hit path is in
 * tests/publicApi.test.ts.)
 *
 * Run: node --import tsx --test tests/edgeCacheLifetime.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, pending, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { catalogRoutes } from '../worker/routes/catalog';
import { printerFinderRoutes } from '../worker/routes/printerFinder';

/** `caches.default` as the live zone behaves: a hit comes back with max-age=14400. */
function zoneCache() {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req: Request) {
      const stored = store.get(req.url);
      if (!stored) return undefined;
      const copy = stored.clone();
      const headers = new Headers(copy.headers);
      headers.set('Cache-Control', (headers.get('Cache-Control') ?? '').replace(/max-age=\d+/, 'max-age=14400'));
      headers.set('CF-Cache-Status', 'HIT');
      return new Response(copy.body, { status: copy.status, headers });
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res);
    },
    async delete(req: Request) {
      return store.delete(req.url);
    },
  };
}

async function withZoneCache(run: (cache: ReturnType<typeof zoneCache>) => Promise<void>) {
  const scope = globalThis as { caches?: unknown };
  const cache = zoneCache();
  scope.caches = { default: cache };
  try {
    await run(cache);
  } finally {
    delete scope.caches;
  }
}

function app(mount: Parameters<typeof stubApp>[2]) {
  const raw = freshDb();
  seedLiveCatalog(raw);
  return stubApp(asD1(raw), null, mount);
}

test('the section map: a hit is sent with max-age=60, not the zone\'s four hours', async () => {
  await withZoneCache(async (cache) => {
    const a = app((x) => x.route('/api/catalog', catalogRoutes));
    const miss = await get(a, '/api/catalog/tree');
    assert.equal(miss.status, 200);
    await Promise.all(pending);
    assert.equal(cache.store.size, 1);
    const hit = await get(a, '/api/catalog/tree');
    assert.equal(hit.headers.get('CF-Cache-Status'), 'HIT', 'served from the cache');
    assert.equal(hit.headers.get('Cache-Control'), 'public, max-age=60, s-maxage=300');
    assert.equal(await hit.text(), await miss.text());
  });
});

test('a section page for a signed-out visitor: the same', async () => {
  await withZoneCache(async () => {
    const a = app((x) => x.route('/api/catalog', catalogRoutes));
    const miss = await get(a, '/api/catalog/printers');
    assert.equal(miss.status, 200);
    await Promise.all(pending);
    const hit = await get(a, '/api/catalog/printers');
    assert.equal(hit.headers.get('CF-Cache-Status'), 'HIT');
    assert.equal(hit.headers.get('Cache-Control'), 'public, max-age=60');
  });
});

test('the printer finder: the same', async () => {
  await withZoneCache(async () => {
    const a = app((x) => x.route('/api/printer-finder', printerFinderRoutes));
    const path = '/api/printer-finder?use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate';
    const miss = await get(a, path);
    assert.equal(miss.status, 200);
    await Promise.all(pending);
    const hit = await get(a, path);
    assert.equal(hit.headers.get('CF-Cache-Status'), 'HIT');
    assert.equal(hit.headers.get('Cache-Control'), 'public, max-age=60');
  });
});
