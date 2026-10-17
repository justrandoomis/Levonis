/**
 * THE EDGE SERVES STALE AS ITS HEADERS HAVE ALWAYS SAID (speed audit
 * 2026-10-16, «the edge cache never serves stale»; worker/lib/edgePolicy.ts
 * «STALE WHILE REVALIDATE, AS DECLARED»).
 *
 * The Workers Cache API drops an entry at its `s-maxage` and implements no
 * `stale-while-revalidate`, so a guest arriving 121 s after the last build paid
 * the whole D1 rebuild although every answer said `stale-while-revalidate=600`.
 * Proved here on the real routers, with a stand-in `caches` that EXPIRES entries
 * at the lifetime they were stored with (as the live Cache API does) and a clock
 * the test moves:
 *
 *   - a late-fresh copy (past half its s-maxage) is served and rebuilt behind it;
 *   - a stale copy inside the declared window is served AT ONCE with its `Age`,
 *     the rebuild runs in the background, the next guest reads the new body;
 *   - past `s-maxage + stale-while-revalidate` it is a miss, built inline;
 *   - a route that declares no stale window (the catalogue tree) is never
 *     served past its s-maxage;
 *   - a purge retires the parameterised copies of a path in its colo (a listing
 *     that before lived on 120 s even where the admin wrote);
 *   - a refresh answered 404 drops the copy; refreshes are one per key;
 *   - without a dispatcher nothing is served stale; a session never sees a copy.
 *
 * Run: node --import tsx --test tests/edgeStaleWhileRevalidate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, pending, stubApp, type Mount, type StubUser } from './fixtures/app';
import { seedLiveCatalog, LIVE_PRODUCTS } from './fixtures/liveCatalog';
import { homeRoutes, productRoutes } from '../worker/routes/products';
import { catalogRoutes } from '../worker/routes/catalog';
import {
  ANONYMOUS_CACHE_CONTROL,
  ANONYMOUS_LIFETIME,
  PURGE_MARKER_CACHE,
  STORED_AT_HEADER,
  freshnessOf,
  isEdgeRefresh,
  purgeAnonymousCache,
  setEdgeRefreshDispatcher,
  storedCacheControl,
} from '../worker/lib/edgePolicy';
import { SESSION_COOKIE_NAME } from '../worker/lib/session';

const MEMBER: StubUser = { id: 'c1', role: 'customer', email: 'c1@x.co' };
const SLUG = LIVE_PRODUCTS[0].slug;
const ID = LIVE_PRODUCTS[0].id;

const mount: Mount = (a) => {
  a.route('/api/home', homeRoutes);
  a.route('/api/products', productRoutes);
  a.route('/api/catalog', catalogRoutes);
};

// ------------------------------------------------------------- the clock

let now = Date.parse('2026-10-16T09:00:00.000Z');
const realNow = Date.now;
function atClock<T>(run: () => Promise<T>): Promise<T> {
  Date.now = () => now;
  return run().finally(() => {
    Date.now = realNow;
  });
}
const advance = (seconds: number) => {
  now += seconds * 1000;
};

// --------------------------------------------- caches that expire like the live API

/** One Cache API store: an entry lives for the `s-maxage` (else `max-age`) it was put with, then it is gone. */
function expiringCache() {
  const store = new Map<string, { res: Response; until: number }>();
  let puts = 0;
  return {
    store,
    get puts() {
      return puts;
    },
    async match(req: Request) {
      const e = store.get(req.url);
      if (!e) return undefined;
      if (Date.now() > e.until) {
        store.delete(req.url);
        return undefined;
      }
      return e.res.clone();
    },
    async put(req: Request, res: Response) {
      puts += 1;
      const cc = res.headers.get('Cache-Control') ?? '';
      const s = Number(/s-maxage=(\d+)/.exec(cc)?.[1] ?? /max-age=(\d+)/.exec(cc)?.[1] ?? 0);
      // The Cache API reads a body to store it: keep a buffered copy.
      store.set(req.url, { res: new Response(await res.arrayBuffer(), res), until: Date.now() + s * 1000 });
    },
    async delete(req: Request) {
      return store.delete(req.url);
    },
  };
}

async function withCaches(run: (c: { answers: ReturnType<typeof expiringCache>; markers: ReturnType<typeof expiringCache> }) => Promise<void>) {
  const scope = globalThis as { caches?: unknown };
  const answers = expiringCache();
  const markers = expiringCache();
  scope.caches = {
    default: answers,
    async open(name: string) {
      assert.equal(name, PURGE_MARKER_CACHE);
      return markers;
    },
  };
  try {
    await atClock(() => run({ answers, markers }));
  } finally {
    delete scope.caches;
    setEdgeRefreshDispatcher(null);
  }
}

const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};

/** The guest app, its database, and the dispatcher a real Worker registers (its own `fetch`), counted. */
function world(opts: { dispatcher?: boolean } = {}) {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const db = asD1(raw);
  const guest = stubApp(db, null, mount);
  const member = stubApp(db, MEMBER, mount);
  const refreshes: string[] = [];
  const replays: Request[] = [];
  if (opts.dispatcher !== false) {
    setEdgeRefreshDispatcher((request, env, ctx) => {
      refreshes.push(`${new URL(request.url).pathname}${new URL(request.url).search}`);
      replays.push(request);
      assert.equal(request.headers.get('Cookie'), null, 'a refresh is a guest request: no cookie');
      return guest.fetch(request, env, ctx as never);
    });
  }
  const rename = (name: string) => raw.prepare('UPDATE products SET name = ? WHERE id = ?').run(name, ID);
  return { raw, db, guest, member, refreshes, replays, rename };
}

const nameIn = async (res: Response) => {
  const body = (await res.json()) as { products?: Array<{ id: string; name: string }>; product?: { name: string } };
  return body.product?.name ?? body.products?.find((p) => p.id === ID)?.name;
};

// ------------------------------------------------------------------- pure

test('the ladder: fresh to half of s-maxage, refreshed behind to s-maxage, stale only inside the declared window', () => {
  const L = ANONYMOUS_LIFETIME;
  assert.deepEqual(
    [0, 60_000, 60_001, 120_000, 120_001, 720_000, 720_001].map((ms) => freshnessOf(ms, L)),
    ['fresh', 'fresh', 'refresh', 'refresh', 'stale', 'stale', 'expired']
  );
  const tree = { maxAge: 60, sMaxAge: 300, staleWhileRevalidate: 0 };
  assert.deepEqual([150_000, 150_001, 300_000, 300_001].map((ms) => freshnessOf(ms, tree)), ['fresh', 'refresh', 'refresh', 'expired']);
  assert.equal(freshnessOf(-5_000, L), 'fresh', 'a clock behind the store reads as fresh, never as negative stale');
  // The copy is KEPT for the window — and not one second longer than the header allows.
  assert.equal(storedCacheControl(L), 'public, max-age=60, s-maxage=720');
  assert.equal(storedCacheControl(tree), 'public, max-age=60, s-maxage=300');
  // The header every client reads is unchanged.
  assert.equal(ANONYMOUS_CACHE_CONTROL, 'public, max-age=60, s-maxage=120, stale-while-revalidate=600');
});

// ------------------------------------------------------------ the ladder, live

test('a stale listing inside the declared window is served at once, rebuilt behind, and the next guest reads the new body', async () => {
  await withCaches(async ({ answers }) => {
    const w = world();
    const path = '/api/products?limit=50';
    const first = await get(w.guest, path);
    assert.equal(first.status, 200);
    const original = await nameIn(first.clone());
    await settle();
    assert.equal(answers.store.size, 1);
    const stored = [...answers.store.values()][0].res;
    assert.equal(stored.headers.get('Cache-Control'), 'public, max-age=60, s-maxage=720', 'kept through the stale window');
    assert.equal(stored.headers.get(STORED_AT_HEADER), String(now), 'stamped with when the data was read');

    // The catalogue changes; 200 s later (past s-maxage, inside the window) the copy still answers AT ONCE.
    w.rename('Renamed after the copy');
    advance(200);
    const stale = await get(w.guest, path);
    assert.equal(stale.status, 200);
    assert.equal(await nameIn(stale.clone()), original, 'the stale copy, not a rebuild on the visitor\'s time');
    assert.equal(stale.headers.get('Cache-Control'), ANONYMOUS_CACHE_CONTROL, 'the route\'s own header, unchanged');
    assert.equal(stale.headers.get('Age'), '200', 'counted from the build, so no browser can stretch it');
    assert.equal(stale.headers.get(STORED_AT_HEADER), null, 'the internal stamp never leaves');
    assert.deepEqual(w.refreshes, [], 'the rebuild starts only after the answer has gone (one turn of the event loop)');

    await settle();
    assert.deepEqual(w.refreshes, ['/api/products?limit=50'], 'one background refresh of the canonical URL');
    const next = await get(w.guest, path);
    assert.equal(await nameIn(next.clone()), 'Renamed after the copy', 'the refresh stored the new body');
    assert.equal(next.headers.get('Age'), '0');
    assert.deepEqual(w.refreshes, ['/api/products?limit=50'], 'a fresh copy triggers nothing');
  });
});

test('past s-maxage + stale-while-revalidate the copy is never served: the guest waits for a build, as before', async () => {
  await withCaches(async () => {
    const w = world();
    const path = `/api/products/${SLUG}`;
    assert.equal((await get(w.guest, path)).status, 200);
    await settle();
    w.rename('Changed long ago');
    advance(721);
    const res = await get(w.guest, path);
    assert.equal(await nameIn(res), 'Changed long ago');
    await settle();
    assert.deepEqual(w.refreshes, [], 'built inline, no background work');
  });
});

test('a late-fresh copy is served and rebuilt behind it, so a key read once a minute never expires', async () => {
  await withCaches(async ({ answers }) => {
    const w = world();
    assert.equal((await get(w.guest, '/api/home')).status, 200);
    await settle();
    advance(30);
    await get(w.guest, '/api/home');
    await settle();
    assert.deepEqual(w.refreshes, [], 'young: nothing to do');
    // Read every 90 s for ten minutes: every read is a hit, never a build on the visitor's time.
    for (let i = 0; i < 7; i += 1) {
      advance(90);
      const res = await get(w.guest, '/api/home');
      assert.equal(res.status, 200);
      assert.ok(Number(res.headers.get('Age')) <= 120, `read ${i}: never older than s-maxage (Age ${res.headers.get('Age')})`);
      await settle();
    }
    assert.equal(w.refreshes.length, 7, 'each late read refreshed the copy behind it');
    assert.equal(answers.store.size, 1);
  });
});

test('a route that declares no stale window — the catalogue tree, a category page — is never served past its s-maxage', async () => {
  await withCaches(async () => {
    const w = world();
    const tree = await get(w.guest, '/api/catalog/tree');
    assert.equal(tree.status, 200);
    assert.equal(tree.headers.get('Cache-Control'), 'public, max-age=60, s-maxage=300', 'its header, unchanged');
    await settle();
    advance(200);
    const late = await get(w.guest, '/api/catalog/tree');
    assert.equal(late.headers.get('Age'), '200');
    await settle();
    assert.deepEqual(w.refreshes, ['/api/catalog/tree'], 'past half its life: refreshed behind the answer');
    advance(301);
    w.refreshes.length = 0;
    const expired = await get(w.guest, '/api/catalog/tree');
    assert.equal(expired.headers.get('Age'), null, 'past its s-maxage: built inline, not served stale');
    await settle();
    assert.deepEqual(w.refreshes, []);

    const page = await get(w.guest, '/api/catalog/printers');
    assert.equal(page.status, 200, await page.clone().text());
    assert.equal(page.headers.get('Cache-Control'), 'public, max-age=60');
    assert.match(page.headers.get('Vary') ?? '', /Cookie/, 'tier-priced: a browser cannot keep the guest copy across a sign-in');
    await settle();
    advance(61);
    const again = await get(w.guest, '/api/catalog/printers');
    assert.equal(again.headers.get('Age'), null, 'a category page past 60 s is a build, as before');
  });
});

// ------------------------------------------------------------- the guards

test('a purge retires every copy of the path in its colo — the parameterised listing and search included', async () => {
  await withCaches(async ({ answers, markers }) => {
    const w = world();
    for (const p of ['/api/products?limit=50', '/api/products?search=bambu&limit=6', `/api/products/${SLUG}`]) {
      assert.equal((await get(w.guest, p)).status, 200);
    }
    await settle();
    assert.equal(answers.store.size, 3);
    advance(10);
    w.rename('Repriced by the owner');
    await purgeAnonymousCache('https://localhost', ['/api/products', `/api/products/${SLUG}`]);
    assert.equal(markers.store.size, 2, 'one marker per path, in its own cache');
    advance(1); // a read in the purge's own millisecond counts as before it (retired): move past it
    const listing = await get(w.guest, '/api/products?limit=50');
    assert.equal(await nameIn(listing), 'Repriced by the owner', 'a 10-second-old copy of a parameterised key is retired too');
    const page = await get(w.guest, `/api/products/${SLUG}`);
    assert.equal(await nameIn(page), 'Repriced by the owner');
    await settle();
    assert.deepEqual(w.refreshes, []);
    // A copy built AFTER the purge is a normal copy again.
    await settle();
    advance(5);
    const hit = await get(w.guest, '/api/products?limit=50');
    assert.equal(hit.headers.get('Age'), '5');
  });
});

test('a rebuild that read the data before a purge is retired by it, even if it is stored after', async () => {
  await withCaches(async () => {
    const w = world();
    // The read happens at `now`; the purge lands at now+1 (the clock moves inside the build).
    const realBuildNow = now;
    const res = await get(w.guest, '/api/home');
    assert.equal(res.status, 200);
    now = realBuildNow + 1_000;
    await purgeAnonymousCache('https://localhost', ['/api/home']);
    await settle(); // the copy read before the purge is stored now
    const after = await get(w.guest, '/api/home');
    assert.equal(after.headers.get('Age'), null, 'not served: its data predates the purge');
  });
});

test('a refresh that answers 404 (the product was hidden) drops the copy: one stale answer, then the truth', async () => {
  await withCaches(async ({ answers }) => {
    const w = world();
    const path = `/api/products/${SLUG}`;
    assert.equal((await get(w.guest, path)).status, 200);
    await settle();
    w.raw.prepare("UPDATE products SET status = 'hidden' WHERE id = ?").run(ID);
    advance(130);
    assert.equal((await get(w.guest, path)).status, 200, 'inside the window: the copy answers once');
    await settle();
    assert.equal(answers.store.size, 0, 'the refresh saw 404 and dropped it');
    assert.equal((await get(w.guest, path)).status, 404);
  });
});

test("the refresh is the Worker's own request: no visitor's address, no cookie, and known as a refresh — nothing outside can pass for one", async () => {
  await withCaches(async () => {
    const w = world();
    const path = '/api/products?search=bambu&limit=6';
    assert.equal((await get(w.guest, path, { 'CF-Connecting-IP': '198.51.100.77', 'Accept-Language': 'ckb' })).status, 200);
    await settle();
    advance(90);
    await get(w.guest, path, { 'CF-Connecting-IP': '198.51.100.77', 'Accept-Language': 'ckb' });
    await settle();
    assert.equal(w.replays.length, 1);
    const [replay] = w.replays;
    // The visitor's own request was gated already; the replay is nobody's (worker/lib/deception/gate.ts
    // lets it through untouched), so it carries no address a block or an incident could land on.
    assert.equal(replay.headers.get('CF-Connecting-IP'), null, "never the visitor's address");
    assert.equal(replay.headers.get('Cookie'), null);
    assert.equal(replay.headers.get('Accept-Language'), 'ckb', 'the language still picks the same answer');
    assert.equal(isEdgeRefresh(replay), true);
    // A request from outside with the very same URL and headers is not one.
    assert.equal(isEdgeRefresh(new Request(replay.url, { headers: replay.headers })), false);
  });
});

test('one refresh per key at a time, and none without a dispatcher: then a stale copy is a miss, as before', async () => {
  await withCaches(async () => {
    const w = world();
    assert.equal((await get(w.guest, '/api/home')).status, 200);
    await settle();
    advance(200);
    await Promise.all([get(w.guest, '/api/home'), get(w.guest, '/api/home'), get(w.guest, '/api/home')]);
    await settle();
    assert.equal(w.refreshes.length, 1, 'three stale hits, one rebuild');
  });
  await withCaches(async () => {
    const w = world({ dispatcher: false });
    assert.equal((await get(w.guest, '/api/home')).status, 200);
    await settle();
    w.rename('No dispatcher');
    advance(200);
    const res = await get(w.guest, `/api/products/${SLUG}`);
    assert.equal(res.headers.get('Age'), null);
    const home = await get(w.guest, '/api/home');
    assert.equal(home.headers.get('Age'), null, 'past s-maxage with nobody to refresh it: built inline');
  });
});

test('a session never reads a shared copy, stale or fresh', async () => {
  await withCaches(async ({ answers }) => {
    const w = world();
    assert.equal((await get(w.guest, '/api/products?limit=50')).status, 200);
    await settle();
    w.rename('Member sees the truth');
    advance(200);
    const member = await get(w.member, '/api/products?limit=50');
    assert.equal(await nameIn(member.clone()), 'Member sees the truth');
    assert.equal(member.headers.get('Cache-Control'), 'private, no-store');
    const cookie = await get(w.guest, '/api/products?limit=50', { Cookie: `${SESSION_COOKIE_NAME}=x` });
    assert.equal(await nameIn(cookie), 'Member sees the truth', 'a bare session cookie is not a guest either');
    await settle();
    assert.deepEqual(w.refreshes, []);
    assert.equal(answers.store.size, 1, 'and neither touched the store');
  });
});
