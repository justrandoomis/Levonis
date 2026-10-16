/**
 * A CATEGORY PAGE'S READS LEAVE TOGETHER, NOT ONE AFTER ANOTHER (speed audit
 * 2026-10-16: the category pages were the slowest of the audit, ~6 s LCP on a
 * phone — route chunk → /api/catalog/:slug or the tree → the listing by id →
 * pictures).
 *
 *  - src/lib/bootFetch.ts starts each category URL's reads with the entry
 *    script (cold load) and on the press of a link (`navigationCategoryOpening`);
 *  - the listing is asked for BY SLUG, which the Worker answers exactly as by
 *    id, so `/categories/<cat>/<sub>` no longer waits for the map;
 *  - a department that is its own listing names its list on its answer's
 *    headers (X-Catalog-Listing), so that list starts before the page renders;
 *  - the loaders take the early request (src/lib/catalog/data.ts, useListing)
 *    instead of asking twice.
 *
 * Run: node --import tsx --test tests/categoryOpeningReads.test.ts
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import {
  AUTH_ME_PATH,
  CATALOG_LISTING_HEADER,
  CATALOG_TREE_PATH,
  bootRequests,
  categoryListingPath,
  categoryOpeningPaths,
  clearPrimedRequests,
  navigationCategoryOpening,
  primeCategoryOpening,
  primeGet,
  takePrimedJson,
} from '../src/lib/bootFetch';
import { DEFAULT_LISTING, listingFirstPagePath, parseListing } from '../src/lib/catalog/listingQuery';
import { loadCategory, loadTree } from '../src/lib/catalog/data';
import { clearPageCache } from '../src/lib/pageCache';
import { catalogRoutes, CATALOG_LISTING_HEADER as WORKER_LISTING_HEADER } from '../worker/routes/catalog';
import { productRoutes } from '../worker/routes/products';

const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  clearPrimedRequests();
  clearPageCache();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
const browser = () => Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('each category URL names its first reads; the list by slug only for the default (unfiltered) list', () => {
  assert.deepEqual(categoryOpeningPaths('/categories'), [CATALOG_TREE_PATH]);
  assert.deepEqual(categoryOpeningPaths('/categories/'), [CATALOG_TREE_PATH]);
  assert.deepEqual(categoryOpeningPaths('/categories/printers'), ['/api/catalog/printers']);
  assert.deepEqual(categoryOpeningPaths('/categories/printing-materials/fdm-materials'), [
    CATALOG_TREE_PATH,
    '/api/products?category=fdm-materials&facets=1&limit=24',
  ]);
  assert.deepEqual(categoryOpeningPaths('/categories/printers/all'), [CATALOG_TREE_PATH, '/api/products?category=printers&facets=1&limit=24'], '«all» is the whole root');
  assert.deepEqual(categoryOpeningPaths('/categories/printers/all', '?avail=1'), [CATALOG_TREE_PATH], 'a filtered list starts from its page');
  // An Arabic slug travels encoded, exactly as loadCategory and useListing encode it.
  const ar = encodeURIComponent('طابعات');
  assert.deepEqual(categoryOpeningPaths(`/categories/${ar}`), [`/api/catalog/${ar}`]);
  for (const bad of ['/categories/a/b/c', '/categories/%E0%A4%A', '/categories/x%2Fy', '/category', '/categoriesx', '/products']) {
    assert.deepEqual(categoryOpeningPaths(bad), [], bad);
  }
});

test('the list started early is the very request the listing makes', () => {
  for (const slug of ['fdm-materials', 'printers', 'طابعات', 'a,b']) {
    assert.equal(categoryListingPath(slug), listingFirstPagePath(DEFAULT_LISTING, slug), slug);
    assert.equal(categoryListingPath(slug), listingFirstPagePath(parseListing(''), slug), slug);
  }
  const hook = src('src/components/listing/useListing.ts');
  assert.match(hook, /const path = useMemo\(\(\) => listingFirstPagePath\(state, category\), \[state, category\]\);/);
  assert.match(hook, /\(takePrimedJson<ProductsListResponse>\(path\) \?\? api\.get<ProductsListResponse>\(path, \{ signal: ctrl\.signal \}\)\)/);
  assert.match(hook, /if \(ctrl\.signal\.aborted\) return;/, 'an early answer for a list the page has left is dropped');
  // Both pages hand the listing the section's slug.
  assert.match(src('src/pages/CategoryListing.tsx'), /category: node\.slug,/);
  assert.match(src('src/pages/CategoryPage.tsx'), /category: node\.slug,/);
  assert.match(src('src/pages/CategoryListing.tsx'), /if \(!tree && listSlug\) primeGet\(listPath\);/, 'beside the map, not after it');
});

test('a cold load of a category URL starts its reads before React, on the main site only', () => {
  const start = (path: string, host: string, inline: { kind?: unknown } | null = { kind: 'main' }, search = '') => bootRequests(path, inline, () => {}, search, host);
  // The session (/api/auth/me) is asked on every page, after the page's own reads.
  assert.deepEqual(start('/categories', 'levonis-iq.com'), [CATALOG_TREE_PATH, AUTH_ME_PATH]);
  assert.deepEqual(start('/categories/printers', 'www.levonis-iq.com', null), ['/api/storefront/resolve', '/api/catalog/printers', AUTH_ME_PATH]);
  assert.deepEqual(start('/categories/printing-materials/fdm-materials', 'levonis-iq.com'), [CATALOG_TREE_PATH, categoryListingPath('fdm-materials'), AUTH_ME_PATH]);
  for (const host of ['shop.levonis-iq.com', 'printer.example']) assert.deepEqual(start('/categories/printers', host), [AUTH_ME_PATH], host);
  assert.deepEqual(start('/categories/printers', 'levonis-iq.com', { kind: 'merchant' }), [AUTH_ME_PATH]);
});

test('a press on a catalogue link starts its reads; another origin or host starts nothing', () => {
  const started: string[] = [];
  const s = (p: string) => started.push(p);
  assert.deepEqual(navigationCategoryOpening('/categories/printers', 'https://levonis-iq.com', s), ['/api/catalog/printers']);
  assert.deepEqual(navigationCategoryOpening('/categories/a/b?avail=1', 'https://levonis-iq.com', s), [CATALOG_TREE_PATH]);
  assert.deepEqual(navigationCategoryOpening('https://other.example/categories/printers', 'https://levonis-iq.com', s), []);
  assert.deepEqual(navigationCategoryOpening('/categories/printers', 'https://shop.levonis-iq.com', s), []);
  assert.deepEqual(navigationCategoryOpening('/products', 'https://levonis-iq.com', s), []);
  assert.deepEqual(started, ['/api/catalog/printers', CATALOG_TREE_PATH]);
  const app = src('src/App.tsx');
  assert.match(app, /if \(e\.type === 'pointerdown'\) navigationCategoryOpening\(href, window\.location\.origin\);/, 'on the press only');
});

test('a listing department\'s list starts on its answer\'s headers; a shelves department starts nothing more', async () => {
  browser();
  const asked: string[] = [];
  globalThis.fetch = ((path: string) => {
    asked.push(path);
    const listing = path === '/api/catalog/printing-materials';
    const headers = new Headers({ 'content-type': 'application/json' });
    if (listing) headers.set(CATALOG_LISTING_HEADER, encodeURIComponent('printing-materials'));
    return Promise.resolve(new Response(JSON.stringify({ success: true }), { headers }));
  }) as typeof fetch;
  primeCategoryOpening('/categories/printing-materials');
  primeCategoryOpening('/categories/printers');
  primeCategoryOpening('/categories/makers-supply', '?avail=1');
  await tick();
  await tick();
  assert.deepEqual(asked.sort(), ['/api/catalog/makers-supply', '/api/catalog/printers', '/api/catalog/printing-materials', categoryListingPath('printing-materials')].sort());
  assert.equal(WORKER_LISTING_HEADER, CATALOG_LISTING_HEADER, 'one header name on both sides');
});

test('the catalogue loaders take the early request: the page and a door\'s prefetch share ONE request', async () => {
  browser();
  let requests = 0;
  let finish: (r: Response) => void = () => {};
  globalThis.fetch = (() => {
    requests += 1;
    return new Promise<Response>((resolve) => { finish = resolve; });
  }) as typeof fetch;
  primeGet('/api/catalog/printers'); // the press (App) or the entry script
  const door = loadCategory('printers', { mascot: 'silent' }); // the door's own prefetch, same event
  const page = loadCategory('printers'); // the page, mounting while it settles
  finish(Response.json({ success: true, node: { slug: 'printers' } }));
  const [a, b] = await Promise.all([door, page]);
  assert.equal(requests, 1);
  assert.equal(a, b);
  assert.equal(takePrimedJson('/api/catalog/printers'), null, 'taken, not cached');
  // Nothing started early: an ordinary GET.
  globalThis.fetch = (() => { requests += 1; return Promise.resolve(Response.json({ success: true, roots: [] })); }) as typeof fetch;
  await loadTree();
  assert.equal(requests, 2);
});

// ------------------------------------------------------------ the Worker

function world(user: { id: string; role: 'customer'; email: string } | null = null) {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const app = stubApp(asD1(raw), user, (a) => {
    a.route('/api/catalog', catalogRoutes);
    a.route('/api/products', productRoutes);
  });
  return { raw, app };
}

test('the Worker names a listing department\'s list on its headers, and only for a listing department', async () => {
  const { app } = world();
  const listing = await get(app, '/api/catalog/printing-materials');
  assert.equal((await json(listing)).layout, 'listing');
  assert.equal(listing.headers.get(WORKER_LISTING_HEADER), 'printing-materials');
  const shelves = await get(app, '/api/catalog/printers');
  assert.equal((await json(shelves)).layout, 'shelves');
  assert.equal(shelves.headers.get(WORKER_LISTING_HEADER), null);
  const member = await get(world({ id: 'c1', role: 'customer', email: 'c1@x.co' }).app, '/api/catalog/printing-materials');
  assert.equal(member.headers.get(WORKER_LISTING_HEADER), 'printing-materials', 'a member\'s private answer says it too');
});

test('the listing by slug is the listing by id: the same cards, total and facets', async () => {
  const { app } = world();
  for (const [slug, id] of [['fdm-materials', 'cat_materials_fdm'], ['printers', 'cat_printers'], ['printing-materials', 'cat_materials']] as const) {
    const bySlug = await json(await get(app, categoryListingPath(slug)));
    const byId = await json(await get(app, categoryListingPath(id)));
    assert.ok(bySlug.products.length > 0, slug);
    assert.deepEqual(bySlug.products.map((p: { id: string }) => p.id), byId.products.map((p: { id: string }) => p.id), slug);
    assert.equal(bySlug.total, byId.total, slug);
    assert.deepEqual(bySlug.facets, byId.facets, slug);
    assert.equal(bySlug.category?.id, id, slug);
  }
});
