/**
 * THE EDGE POLICY FOR THE ANONYMOUS PUBLIC READS (P2a; plan §B.1 #2, #4).
 *
 * Every route in the plan's list is exercised on the REAL routers against the
 * real migrations:
 *
 *   - a GUEST leaves with `public, max-age=60, s-maxage=120,
 *     stale-while-revalidate=600`, a weak ETag, and a 304 on If-None-Match;
 *   - a request that CARRIES A SESSION — the cookie alone, valid or not, or a
 *     resolved user — never gets a shared policy and is never stored;
 *   - the colo cache stores a guest's 200 once, serves it as a hit with the
 *     route's OWN lifetime (not the zone's four hours), keys it canonically
 *     (origin + path + declared parameters, sorted), and never stores a HEAD,
 *     a refusal or a session-bound answer;
 *   - the purge seams on the admin writes drop what they changed;
 *   - the storefront is one body for every visitor (`delivery_to_you` lives
 *     on /:slug/delivery), and the session-free GET list matches the handlers
 *     that really never read `user`;
 *   - P2 REVIEW: a route whose body differs per viewer says `Vary: Cookie`,
 *     so a browser cannot keep serving the guest body across a sign-in; a
 *     store suspension, a merchant suspension, a rename and every merchant
 *     write purge the shopfront (by slug, by id, the per-store reads); the
 *     site-media upload, the PRO pause, an admin product write and a benefit
 *     rule purge the first screen and the listing; the documents carry no
 *     stale-while-revalidate and the deploy workflows purge the zone.
 *
 * Run: node --import tsx --test tests/edgeCachePolicy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asD1, freshDb, get, json, patch, pending, post, put, stubApp, type Mount, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { seedLiveCatalog, LIVE_PRODUCTS } from './fixtures/liveCatalog';
import { seedLayoutStore, OWNER as LAYOUT_OWNER, SLUG } from './fixtures/storeLayout';
import { homeRoutes, productRoutes } from '../worker/routes/products';
import { storefrontRoutes } from '../worker/routes/storefront';
import { miscRoutes } from '../worker/routes/misc';
import { communityRoutes } from '../worker/routes/community';
import { printQuoteRoutes } from '../worker/routes/printQuote';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { adminRoutes } from '../worker/routes/admin';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminMembershipBenefitRoutes } from '../worker/routes/adminMembershipBenefits';
import { membershipsRoutes } from '../worker/routes/memberships';
import { merchantRoutes } from '../worker/routes/merchant';
import { storeLayoutRoutes } from '../worker/routes/storeLayout';
import {
  ANONYMOUS_CACHE_CONTROL,
  SESSION_CACHE_CONTROL,
  VIEWER_VARY,
  browserMayReuse,
  canonicalKey,
  cataloguePaths,
  pathsChangedBySetting,
  storefrontDocumentPaths,
  storefrontPaths,
} from '../worker/lib/edgePolicy';
import { DOCUMENT_SHARED_CACHE_CONTROL } from '../worker/lib/socialPreview';
import { SESSION_COOKIE_NAME, hasSessionCookie, sessionFreePublicGet } from '../worker/lib/session';

const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };
const HOST = `${SLUG}.levonis-iq.com`;
const MEMBER: StubUser = { id: 'c1', role: 'customer', email: 'c1@x.co' };
const ADMIN: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: 'full' };
const OWNER: StubUser = { id: LAYOUT_OWNER, role: 'merchant', email: 'owner@x.co' };
const COOKIE = { Cookie: `${SESSION_COOKIE_NAME}=not-even-a-real-token` };

const mount: Mount = (a) => {
  a.route('/api/home', homeRoutes);
  a.route('/api/products', productRoutes);
  a.route('/api/storefront', storefrontRoutes);
  a.route('/api/community', communityRoutes);
  a.route('/api/print-quote', printQuoteRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/membership-benefits', adminMembershipBenefitRoutes);
  a.route('/api/admin', adminRoutes);
  a.route('/api/memberships', membershipsRoutes);
  a.route('/api/merchant/store/layout', storeLayoutRoutes);
  a.route('/api/merchant', merchantRoutes);
  a.route('/api', miscRoutes);
};

function world() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  seedLayoutStore(raw);
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,username) VALUES ('boss','Boss','boss@x.co','h','admin','boss')`);
  const db = asD1(raw);
  const on = (user: StubUser | null, host?: string) => stubApp(db, user, mount, { host, env: ENV });
  return { raw, db, guest: on(null), guestHost: on(null, HOST), member: on(MEMBER), memberHost: on(MEMBER, HOST), admin: on(ADMIN), owner: on(OWNER) };
}

/** The store host's requests carry their Host header, as a browser's do (the cache keys on it). */
const hostGet = (app: ReturnType<typeof stubApp>, path: string, headers: Record<string, string> = {}) => get(app, path, { Host: HOST, ...headers });

/**
 * Every route of the plan's list, with the host it is asked on, and whether a
 * signed-in caller gets a DIFFERENT body (prices per membership, `favorite`,
 * `viewer_tier`, the community `admin`/`may_enter`, a merchant's own printer
 * groups) — those say `Vary: Cookie` to the browser (P2 review).
 */
const ROUTES: Array<{ path: string; host?: boolean; perViewer?: boolean }> = [
  { path: '/api/home', perViewer: true },
  { path: '/api/home/sections', perViewer: true },
  { path: '/api/products', perViewer: true },
  { path: `/api/products/${LIVE_PRODUCTS[0].slug}`, perViewer: true },
  { path: '/api/settings/public' },
  { path: '/api/community/access', perViewer: true },
  { path: '/api/storefront/resolve', host: true },
  { path: `/api/storefront/${SLUG}` },
  { path: `/api/storefront/${SLUG}/products` },
  { path: `/api/storefront/${SLUG}/products/raf3d-p1` },
  { path: `/api/storefront/${SLUG}/reviews` },
  { path: `/api/storefront/${SLUG}/sections` },
  { path: `/api/storefront/${SLUG}/services` },
  { path: `/api/storefront/${SLUG}/showcase` },
  { path: '/api/storefront/by-id/s1' },
  { path: '/api/print-quote/printers', perViewer: true },
  { path: '/api/print-quote/materials' },
  { path: '/api/print-quote/accessories' },
  { path: '/api/marketplace/print/catalog' },
];

/** `caches.default` as the live zone behaves: a hit comes back with max-age=14400. */
function zoneCache() {
  const store = new Map<string, Response>();
  let matches = 0;
  return {
    store,
    get matches() {
      return matches;
    },
    async match(req: Request) {
      matches += 1;
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

const settle = () => Promise.all(pending);

// ------------------------------------------------------------ the policy

test('every route in the list: a guest leaves with the anonymous policy, a weak ETag, and a 304 on If-None-Match', async () => {
  const w = world();
  assert.equal(ANONYMOUS_CACHE_CONTROL, 'public, max-age=60, s-maxage=120, stale-while-revalidate=600');
  for (const r of ROUTES) {
    const app = r.host ? w.guestHost : w.guest;
    const res = r.host ? await hostGet(app, r.path) : await get(app, r.path);
    assert.equal(res.status, 200, `${r.path}: ${await res.text()}`);
    assert.equal(res.headers.get('Cache-Control'), ANONYMOUS_CACHE_CONTROL, r.path);
    const etag = res.headers.get('ETag') ?? '';
    assert.match(etag, /^W\/"[0-9a-f]{32}"$/, `${r.path}: weak ETag`);
    assert.match(res.headers.get('Content-Type') ?? '', /application\/json/, r.path);
    const again = await get(app, r.path, { 'If-None-Match': etag });
    assert.equal(again.status, 304, `${r.path}: revalidation`);
    assert.equal(again.headers.get('Cache-Control'), ANONYMOUS_CACHE_CONTROL, `${r.path}: a 304 carries the policy too`);
    assert.equal(again.headers.get('ETag'), etag);
    assert.equal(await again.text(), '');
    // P2 review: the sign-in boundary, as a browser cache sees it.
    const cookieVary = /(^|,\s*)Cookie(\s*,|$)/i;
    for (const [what, r2] of [['200', res], ['304', again]] as const) {
      const vary = r2.headers.get('Vary') ?? '';
      if (r.perViewer) assert.match(vary, cookieVary, `${r.path}: the ${what} of a per-viewer route says Vary: Cookie`);
      else assert.doesNotMatch(vary, cookieVary, `${r.path}: one body for everyone keeps the full minute in the browser`);
    }
  }
});

test('P2 review: after a guest answer of a per-viewer route, a request that carries a session cookie cannot be satisfied without revalidation', async () => {
  const w = world();
  assert.equal(VIEWER_VARY, 'Cookie');
  const guestRequest = new Headers();
  const signedRequest = new Headers(COOKIE);
  const otherCookie = new Headers({ Cookie: 'levo_lang=ckb' });
  for (const r of ROUTES.filter((x) => x.perViewer)) {
    const stored = await get(w.guest, r.path);
    assert.equal(stored.status, 200);
    assert.equal(browserMayReuse(stored, guestRequest, guestRequest), true, `${r.path}: guest → guest, the minute holds`);
    assert.equal(browserMayReuse(stored, guestRequest, signedRequest), false, `${r.path}: guest → signed in, the entry does not match`);
    assert.equal(browserMayReuse(stored, guestRequest, otherCookie), false, `${r.path}: any cookie change misses`);
  }
  // …and a same-bytes route keeps its entry across the boundary (no Vary at all).
  const settings = await get(w.guest, '/api/settings/public');
  assert.equal(browserMayReuse(settings, guestRequest, signedRequest), true);
  // The community verdict end to end: the guest's cached body says the door is
  // open for a guest; the member's request, which the browser must now send,
  // is answered fresh, per person, with no shared policy.
  const guest = await get(w.guest, '/api/community/access');
  assert.deepEqual(await json(guest), { success: true, closed: false, admin: false, may_enter: true });
  const admin = await get(w.admin, '/api/community/access');
  assert.equal(admin.headers.get('Cache-Control'), 'no-store');
  assert.equal((await json(admin)).admin, true);
});

test('every route in the list: a request that carries a session is never given a shared policy', async () => {
  const w = world();
  for (const r of ROUTES) {
    // The cookie alone, valid or not — the session was not even resolved.
    const cookieOnly = await get(r.host ? w.guestHost : w.guest, r.path, COOKIE);
    assert.equal(cookieOnly.status, 200, r.path);
    const cc1 = cookieOnly.headers.get('Cache-Control') ?? '';
    assert.ok(!/public|s-maxage/.test(cc1), `${r.path}: ${cc1 || '(none)'} must not be shareable`);
    assert.ok(cc1 === SESSION_CACHE_CONTROL || cc1 === 'no-store', `${r.path}: got ${cc1}`);
    assert.equal(cookieOnly.headers.get('ETag'), null, `${r.path}: no validator on a session answer`);
    // A resolved user.
    const signed = await get(r.host ? w.memberHost : w.member, r.path);
    assert.equal(signed.status, 200, r.path);
    const cc2 = signed.headers.get('Cache-Control') ?? '';
    assert.ok(!/public|s-maxage/.test(cc2), `${r.path}: ${cc2 || '(none)'} must not be shareable`);
  }
  // The community verdict keeps its pinned `no-store` for a member (tests/communityGate.test.ts).
  assert.equal((await get(w.member, '/api/community/access')).headers.get('Cache-Control'), 'no-store');
});

test('the storefront is ONE body for every visitor: a guest and a member read the same bytes, and neither carries the viewer', async () => {
  const w = world();
  for (const p of [`/api/storefront/${SLUG}`, `/api/storefront/${SLUG}/products/raf3d-p1`, '/api/storefront/by-id/s1']) {
    const guest = await json(await get(w.guest, p));
    const member = await json(await get(w.member, p));
    assert.deepEqual(member, guest, p);
    assert.ok(!JSON.stringify(guest).includes('delivery_to_you'), `${p}: the viewer's line is not in the shared body`);
  }
  const guestHost = await json(await get(w.guestHost, '/api/storefront/resolve'));
  const memberHost = await json(await get(w.memberHost, '/api/storefront/resolve'));
  assert.deepEqual(memberHost, guestHost);
  // …and the viewer's own line lives on /delivery, which is neither cached nor session-free.
  const mine = await get(w.member, `/api/storefront/${SLUG}/delivery`);
  assert.equal(mine.status, 200);
  assert.ok(!/public/.test(mine.headers.get('Cache-Control') ?? ''));
  assert.equal(sessionFreePublicGet('GET', `/api/storefront/${SLUG}/delivery`), false);
});

// --------------------------------------------------------- the colo cache

test('the colo cache: a guest miss is stored once, the hit leaves with the route\'s own lifetime, a session never touches it', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    const miss = await get(w.guest, '/api/home');
    assert.equal(miss.status, 200);
    await settle();
    assert.equal(cache.store.size, 1);
    const key = [...cache.store.keys()][0];
    assert.equal(key, 'https://localhost/api/home', 'host + path, nothing else');

    const hit = await get(w.guest, '/api/home');
    assert.equal(hit.headers.get('CF-Cache-Status'), 'HIT');
    assert.equal(hit.headers.get('Cache-Control'), ANONYMOUS_CACHE_CONTROL, 'not the zone\'s four hours');
    assert.equal(await hit.text(), await miss.text());
    const revalidated = await get(w.guest, '/api/home', { 'If-None-Match': miss.headers.get('ETag')! });
    assert.equal(revalidated.status, 304, 'a 304 from a hit');

    const before = cache.matches;
    const signed = await get(w.member, '/api/home');
    assert.equal(signed.status, 200);
    assert.equal(cache.matches, before, 'a session request never consults the shared cache');
    const cookieOnly = await get(w.guest, '/api/home', COOKIE);
    assert.equal(cookieOnly.status, 200);
    assert.equal(cache.matches, before, 'nor does a bare cookie');
    await settle();
    assert.equal(cache.store.size, 1, 'and neither was stored');
  });
});

test('the key is canonical: declared parameters sorted, unknown ones ignored, one entry per origin', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    for (const q of ['?limit=5&offset=0', '?offset=0&limit=5', '?limit=5&offset=0&utm_source=tg&fbclid=x']) {
      assert.equal((await get(w.guest, `/api/products${q}`)).status, 200);
    }
    await settle();
    assert.deepEqual([...cache.store.keys()], ['https://localhost/api/products?limit=5&offset=0']);
    // A different DECLARED parameter is a different entry.
    assert.equal((await get(w.guest, '/api/products?limit=6')).status, 200);
    await settle();
    assert.equal(cache.store.size, 2);
    // A store host keys its own resolve; the apex keys its `store: null`.
    assert.equal((await hostGet(w.guestHost, '/api/storefront/resolve')).status, 200);
    assert.equal((await get(w.guest, '/api/storefront/resolve')).status, 200);
    await settle();
    assert.ok(cache.store.has(`https://${HOST}/api/storefront/resolve`));
    assert.ok(cache.store.has('https://localhost/api/storefront/resolve'));
  });
  assert.equal(canonicalKey('https://a.b/api/x?z=1&a=2&nope=3', ['a', 'z']).url, 'https://a.b/api/x?a=2&z=1');
  assert.equal(canonicalKey('http://a.b/api/x/?a=1', []).url, 'https://a.b/api/x', 'one scheme, whatever the request saw');
  assert.equal(canonicalKey('http://localhost/api/x', [], 'Shop.Levonis-IQ.com').url, 'https://shop.levonis-iq.com/api/x', 'the Host header wins');
});

test('never stored: a HEAD, a refusal, a session answer', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    const head = await w.guest.request('/api/settings/public', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const missing = await get(w.guest, '/api/storefront/no-such-shop');
    assert.equal(missing.status, 404);
    assert.ok(!/public/.test(missing.headers.get('Cache-Control') ?? ''), 'a refusal carries no shared policy');
    const gone = await get(w.guest, '/api/products/nope');
    assert.equal(gone.status, 404);
    await get(w.member, '/api/settings/public');
    await settle();
    assert.equal(cache.store.size, 0);
  });
});

// ------------------------------------------------------------- the seams

test('the settings PUT purges the public settings, the first screen and the shelves it feeds', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    for (const p of ['/api/settings/public', '/api/home', '/api/home/sections', '/api/community/access']) assert.equal((await get(w.guest, p)).status, 200);
    await settle();
    assert.equal(cache.store.size, 4);
    const res = await put(w.admin, '/api/admin/settings/homeSections', { value: [{ id: 'best' }] });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual([...cache.store.keys()], ['https://localhost/api/community/access'], 'the community verdict is not a setting');
    assert.deepEqual(pathsChangedBySetting('homeBanners').sort(), ['/api/home', '/api/home/sections', '/api/settings/public']);
    assert.deepEqual(pathsChangedBySetting('printAccessories').sort(), [
      '/api/marketplace/print/catalog', '/api/print-quote/accessories', '/api/print-quote/materials', '/api/settings/public',
    ]);
    assert.deepEqual(pathsChangedBySetting('proPricingPolicy').sort(), ['/api/home', '/api/home/sections', '/api/products', '/api/settings/public']);
  });
});

test('the community gate PUT purges the guests\' verdict — and the verdict follows the switch', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    const open = await json(await get(w.guest, '/api/community/access'));
    assert.deepEqual(open, { success: true, closed: false, admin: false, may_enter: true });
    await settle();
    assert.equal(cache.store.size, 1);
    const flip = await put(w.admin, '/api/admin/community/gate', { open: false, allowed_user_ids: [] });
    assert.equal(flip.status, 200, await flip.text());
    assert.equal(cache.store.size, 0, 'purged');
    const shut = await json(await get(w.guest, '/api/community/access'));
    assert.deepEqual(shut, { success: true, closed: true, admin: false, may_enter: false });
  });
});

test('a store\'s publish purges its shopfront on its own host and on the apex', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    assert.equal((await hostGet(w.guestHost, '/api/storefront/resolve')).status, 200);
    assert.equal((await get(w.guest, `/api/storefront/${SLUG}`, { Host: 'levonis-iq.com' })).status, 200);
    assert.equal((await get(w.guest, `/api/storefront/${SLUG}/products`, { Host: 'levonis-iq.com' })).status, 200);
    await settle();
    assert.equal(cache.store.size, 3);
    const layout = { schema_version: 1, theme: 'classic', blocks: [{ id: 'hello', type: 'text', settings: { title: { ar: 'ملاحظة', en: '', ckb: '' }, body: { ar: 'P2a', en: '', ckb: '' } } }] };
    const draft = await json(await put(w.owner, '/api/merchant/store/layout/draft', { version: 0, layout }));
    assert.equal(draft.success, true, JSON.stringify(draft));
    // The merchant published from the apex workspace; the store's own host is purged too.
    const published = await json(await post(w.owner, '/api/merchant/store/layout/publish', { version: draft.draft.version }, { Host: 'levonis-iq.com' }));
    assert.equal(published.success, true, JSON.stringify(published));
    assert.deepEqual([...cache.store.keys()], [], 'resolve on the store host, the store body on the apex and the parameter-less product list are gone');
    assert.deepEqual(storefrontPaths('x', 's9'), [
      '/api/storefront/resolve', '/api/storefront/x', '/api/storefront/x/sections', '/api/storefront/x/services',
      '/api/storefront/x/showcase', '/api/storefront/x/products', '/api/storefront/x/reviews', '/api/storefront/by-id/s9',
    ]);
    assert.deepEqual(storefrontDocumentPaths('x', 's9'), ['/', '/community/store/x', '/community/store/s9']);
  });
});

// ------------------------------------------------ P2 review: the missing seams

/** Warm every per-store answer a guest can hold, on the store host and the apex. */
async function warmStorefront(w: ReturnType<typeof world>, cache: ReturnType<typeof zoneCache>) {
  assert.equal((await hostGet(w.guestHost, '/api/storefront/resolve')).status, 200);
  for (const p of [`/api/storefront/${SLUG}`, `/api/storefront/${SLUG}/products`, `/api/storefront/${SLUG}/sections`, `/api/storefront/${SLUG}/services`, `/api/storefront/${SLUG}/showcase`, `/api/storefront/${SLUG}/reviews`, '/api/storefront/by-id/s1']) {
    assert.equal((await get(w.guest, p)).status, 200, p);
  }
  await settle();
  assert.equal(cache.store.size, 8);
}

test('P2 review: a store suspension purges the shopfront — the next anonymous GET on the store host is STORE_UNAVAILABLE, not the cached 200', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    await warmStorefront(w, cache);
    const res = await post(w.admin, '/api/admin/community/stores/s1/status', { status: 'suspended', reason: 'banner' });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual([...cache.store.keys()], [], 'every per-store entry on both hosts is gone');
    const after = await hostGet(w.guestHost, '/api/storefront/resolve');
    assert.equal(after.status, 404);
    const body = await json(after);
    assert.equal(body.code, 'STORE_UNAVAILABLE');
    assert.equal(body.store, null, 'not one merchant-controlled field');
    assert.equal((await get(w.guest, `/api/storefront/${SLUG}`)).status, 404);
    assert.equal((await get(w.guest, '/api/storefront/by-id/s1')).status, 404);
    await settle();
    assert.equal(cache.store.size, 0, 'a refusal is never stored');
  });
});

test('P2 review: a merchant suspension purges every store of the merchant', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    await warmStorefront(w, cache);
    const res = await post(w.admin, '/api/admin/community/merchants/m1/status', { status: 'suspended', reason: 'fraud' });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual([...cache.store.keys()], []);
    assert.equal((await json(await hostGet(w.guestHost, '/api/storefront/resolve'))).code, 'STORE_UNAVAILABLE');
  });
});

test('P2 review: a rename purges the OLD host\'s resolve and the new slug\'s answers, so the old address says STORE_MOVED at once', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    await warmStorefront(w, cache);
    // The new name was asked for a moment ago and refused as «no such store» — a refusal, never stored.
    assert.equal((await get(w.guest, '/api/storefront/rafidain3d')).status, 404);
    const res = await post(w.owner, '/api/merchant/store/slug', { slug: 'rafidain3d' });
    const renamed = await res.text();
    assert.equal(res.status, 200, renamed);
    assert.deepEqual(JSON.parse(renamed), { success: true, slug: 'rafidain3d', changed: true, previous: SLUG });
    assert.deepEqual([...cache.store.keys()], [], 'old slug, old host, by-id: all gone');
    const moved = await json(await hostGet(w.guestHost, '/api/storefront/resolve'));
    assert.equal(moved.code, 'STORE_MOVED');
    assert.equal(moved.details.redirect, 'https://rafidain3d.levonis-iq.com');
    assert.equal((await get(w.guest, '/api/storefront/rafidain3d')).status, 200);
  });
});

test('P2 review: every merchant write purges the shopfront (a profile edit, through the router middleware)', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    await warmStorefront(w, cache);
    const res = await patch(w.owner, '/api/merchant/store', { tagline: 'قطع غيار في اليوم نفسه' });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual([...cache.store.keys()], []);
    const store = (await json(await get(w.guest, `/api/storefront/${SLUG}`))).store;
    assert.equal(store.tagline, 'قطع غيار في اليوم نفسه', 'the guest reads the edit at once');
    // A refused write purges nothing.
    await warmStorefront(w, cache);
    assert.equal((await patch(w.owner, '/api/merchant/store', { name: 'x' })).status, 400);
    assert.equal(cache.store.size, 8);
  });
});

test('P2 review: the site-media routes purge the first screen and the public settings (the only writer of mainPageMedia)', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    for (const p of ['/api/settings/public', '/api/home', '/api/home/sections', '/api/products']) assert.equal((await get(w.guest, p)).status, 200);
    await settle();
    assert.equal(cache.store.size, 4);
    const res = await w.admin.request('/api/admin/site-media/brand-bambulab', { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual([...cache.store.keys()], ['https://localhost/api/products'], 'home, sections and settings are gone; the listing does not carry the media');
    // The upload route: the same seam, before the audit — pinned in the source (the
    // route needs a bucket and the image service, which the stand-in has not).
    const admin = readFileSync(join(ROOT, 'worker/routes/admin.ts'), 'utf8');
    const upload = admin.slice(admin.indexOf("adminRoutes.post('/site-media/:slot'"), admin.indexOf("adminRoutes.delete('/site-media/:slot'"));
    assert.match(upload, /setSetting\(c\.env\.DB, 'mainPageMedia'[\s\S]{0,400}afterSettingsWrite\(c, 'mainPageMedia'\)/);
  });
});

test('P2 review: the PRO pause purges the priced answers, as the settings PUT does for the same key', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    for (const p of ['/api/home', '/api/home/sections', '/api/products', `/api/products/${LIVE_PRODUCTS[0].slug}`, '/api/community/access']) assert.equal((await get(w.guest, p)).status, 200, p);
    await settle();
    assert.equal(cache.store.size, 5);
    const res = await post(w.admin, '/api/memberships/admin/pro-pause', { paused: true, confirm: 'PAUSE' });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual([...cache.store.keys()].sort(), [`https://localhost/api/products/${LIVE_PRODUCTS[0].slug}`, 'https://localhost/api/community/access'].sort(), 'the parameter-less priced answers are gone; the product pages age out within s-maxage, the verdict is untouched');
    assert.deepEqual(pathsChangedBySetting('proPause').sort(), ['/api/home', '/api/home/sections', '/api/products', '/api/settings/public']);
  });
});

test('P2 review: an admin product write and a benefit rule purge the listing, the home and the product page named', async () => {
  await withZoneCache(async (cache) => {
    const w = world();
    const slug = LIVE_PRODUCTS[0].slug;
    const warm = async () => {
      for (const p of ['/api/home', '/api/home/sections', '/api/products', `/api/products/${slug}`, '/api/settings/public']) assert.equal((await get(w.guest, p)).status, 200, p);
      await settle();
      assert.equal(cache.store.size, 5);
    };
    await warm();
    const hidden = await patch(w.admin, `/api/admin/products-v2/${LIVE_PRODUCTS[0].id}/status`, { status: 'hidden' });
    assert.equal(hidden.status, 200, await hidden.text());
    assert.deepEqual([...cache.store.keys()], ['https://localhost/api/settings/public'], 'the slug was found from the path');
    assert.equal((await get(w.guest, `/api/products/${slug}`)).status, 404, 'and the guest no longer sees the hidden product');
    assert.equal((await patch(w.admin, `/api/admin/products-v2/${LIVE_PRODUCTS[0].id}/status`, { status: 'active' })).status, 200);
    // A refused write purges nothing.
    await warm();
    assert.equal((await patch(w.admin, `/api/admin/products-v2/${LIVE_PRODUCTS[0].id}/status`, { status: 'nope' })).status, 400);
    assert.equal(cache.store.size, 5);
    // A benefit rule: the priced answers go, the product page named by nobody ages out.
    const rule = await post(w.admin, '/api/admin/membership-benefits', {
      tier: 'pro', benefit_type: 'product_discount', scope: 'global', discount_mode: 'percent', percent: 5, max_discount_iqd: 50_000, cap_scope: 'per_unit', label: 'PRO 5%',
    });
    assert.equal(rule.status, 200, await rule.text());
    assert.deepEqual([...cache.store.keys()].sort(), ['https://localhost/api/settings/public', `https://localhost/api/products/${slug}`].sort());
    assert.deepEqual(cataloguePaths(['a', '']), ['/api/home', '/api/home/sections', '/api/products', '/api/products/a']);
  });
});

test('P2 review: the documents carry no stale-while-revalidate, and the deploy workflows purge the zone after the deploy', () => {
  assert.equal(DOCUMENT_SHARED_CACHE_CONTROL, 'public, max-age=0, s-maxage=60');
  for (const wf of ['.github/workflows/deploy-staging-code.yml', '.github/workflows/deploy-staging.yml']) {
    const y = readFileSync(join(ROOT, wf), 'utf8');
    const deploy = y.indexOf('wrangler deploy --env staging');
    const purge = y.indexOf('run: node scripts/purge-zone-cache.mjs');
    assert.ok(deploy > 0 && purge > deploy, `${wf}: the purge step follows the deploy`);
    assert.match(y, /CLOUDFLARE_ZONE_ID: \$\{\{ secrets\.CLOUDFLARE_ZONE_ID \}\}/, `${wf}: the zone id comes from the secret`);
  }
  const script = readFileSync(join(ROOT, 'scripts/purge-zone-cache.mjs'), 'utf8');
  assert.match(script, /purge_everything: true/);
  assert.match(script, /if \(!zone\) \{[\s\S]*process\.exit\(0\)/, 'no zone id: a notice, not a failed deploy');
});

// ------------------------------------------------- the session-free GETs

test('sessionFreePublicGet names exactly the handlers that never read `user`', () => {
  for (const [method, path, want] of [
    ['GET', '/api/settings/public', true],
    ['HEAD', '/api/settings/public', false],
    ['POST', '/api/settings/public', false],
    ['GET', '/api/storefront/resolve', true],
    ['GET', `/api/storefront/${SLUG}`, true],
    ['GET', `/api/storefront/${SLUG}/products/x`, true],
    ['GET', `/api/storefront/${SLUG}/reviews`, true],
    ['GET', '/api/storefront/by-id/s1', true],
    ['GET', `/api/storefront/${SLUG}/delivery`, false],
    ['GET', `/api/storefront/${SLUG}/delivery/`, false],
    ['GET', '/api/storefront', false],
    ['GET', '/api/print-quote/materials', true],
    ['GET', '/api/print-quote/accessories', true],
    ['GET', '/api/print-quote/printers', false],
    ['GET', '/api/marketplace/print/catalog', true],
    ['GET', '/api/home', false],
    ['GET', '/api/products', false],
    ['GET', '/api/products/x', false],
    ['GET', '/api/community/access', false],
    ['GET', '/api/auth/me', false],
  ] as const) {
    assert.equal(sessionFreePublicGet(method, path), want, `${method} ${path}`);
  }
  assert.equal(hasSessionCookie(`a=1; ${SESSION_COOKIE_NAME}=x`), true);
  assert.equal(hasSessionCookie(`${SESSION_COOKIE_NAME}x=1`), false);
  assert.equal(hasSessionCookie(null), false);
});

const code = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the storefront router reads `user` in /:slug/delivery only, and every other GET is behind anonymousCached', () => {
  const src = code('worker/routes/storefront.ts');
  const handlers = src.split(/^storefrontRoutes\.get\(/m).slice(1);
  assert.equal(handlers.length, 10, `the storefront's ten handlers, found ${handlers.length}`);
  for (const h of handlers) {
    const path = /^'([^']+)'/.exec(h)?.[1] ?? '?';
    const readsUser = /c\.get\(\s*['"]user['"]\s*\)/.test(h);
    const cached = /^'[^']+',\s*\(c\)\s*=>\s*anonymousCached\(/.test(h);
    if (path === '/:slug/delivery') {
      assert.equal(readsUser, true, 'the delivery preview answers for the viewer');
      assert.equal(cached, false, 'and is never shared');
    } else {
      assert.equal(readsUser, false, `${path} must not read the session: the pipeline no longer loads one for it`);
      assert.equal(cached, true, `${path} must be behind anonymousCached`);
    }
  }
  assert.ok(!/delivery_to_you/.test(src), 'the store body never names the viewer\'s line');
  assert.ok(!/viewerId/.test(src), 'publicStore has no viewer');
});

test('the other session-free handlers never read `user`, and the pipeline asks the predicate before loading a session', () => {
  const misc = code('worker/routes/misc.ts');
  const settings = /miscRoutes\.get\('\/settings\/public'[\s\S]*?\n\);/.exec(misc)?.[0] ?? '';
  assert.ok(settings.includes('anonymousCached('), 'settings/public is behind the policy');
  assert.ok(!/c\.get\(\s*['"]user['"]\s*\)/.test(settings));
  const pq = code('worker/routes/printQuote.ts');
  for (const p of ['/materials', '/accessories']) {
    const h = new RegExp(`printQuoteRoutes\\.get\\('${p}'[\\s\\S]*?\\n\\}\\)\\);`).exec(pq)?.[0] ?? '';
    assert.ok(h.includes('anonymousCached('), `${p} is behind the policy`);
    assert.ok(!/c\.get\(\s*['"]user['"]\s*\)/.test(h), `${p} reads no session`);
  }
  const pr = code('worker/routes/printRequests.ts');
  const cat = /printRequestRoutes\.get\('\/catalog'[\s\S]*?\n\}\)\);/.exec(pr)?.[0] ?? '';
  assert.ok(cat.includes('anonymousCached('));
  assert.ok(!/c\.get\(\s*['"]user['"]\s*\)/.test(cat));
  const index = code('worker/index.ts');
  const skip = index.indexOf('sessionFreePublicGet(c.req.method, path)');
  const load = index.indexOf('await loadSessionUser(c);');
  assert.ok(skip > 0 && load > skip, 'the session-free branch precedes the session load');
  // The routes that price per viewer or answer per viewer are NOT on the list, and still read the session.
  const products = code('worker/routes/products.ts');
  assert.match(products, /export async function pricingCtx\(c: Context<AppContext>\)[\s\S]{0,120}c\.get\('user'\)/);
});
