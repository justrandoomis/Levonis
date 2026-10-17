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
  LISTING_SLUG_MAX,
  bootRequests,
  categoryListingPath,
  categoryOpeningPaths,
  clearPrimedRequests,
  listingCategory,
  navigationCategoryOpening,
  primeCategoryOpening,
  primeGet,
  takePrimedJson,
} from '../src/lib/bootFetch';
import { DEFAULT_LISTING, listingFirstPagePath, parseListing } from '../src/lib/catalog/listingQuery';
import { loadCategory, loadTree } from '../src/lib/catalog/data';
import { clearPageCache } from '../src/lib/pageCache';
import { catalogRoutes, CATALOG_LISTING_HEADER as WORKER_LISTING_HEADER, LISTING_SLUG_MAX as WORKER_LISTING_SLUG_MAX, listingCategoryKey } from '../worker/routes/catalog';
import { slugify } from '../worker/routes/adminTaxonomy';
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
  // Both pages hand the listing the section's slug (its id when the slug is too long to ask by).
  assert.match(src('src/pages/CategoryListing.tsx'), /category: listingCategory\(node\),/);
  assert.match(src('src/pages/CategoryPage.tsx'), /category: listingCategory\(node\),/);
  assert.match(src('src/pages/CategoryListing.tsx'), /if \(!tree && listSlug && listsBySlug\(listSlug\)\) primeGet\(listPath\);/, 'beside the map, not after it');
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

// ------------------------------------------------------- a slug longer than 60 characters
//
// Review of the category lane: /api/products refused a `category` longer than 60 characters, while the
// admin's slugs reach 63 (slugify keeps 60, uniqueSlug then appends "-2" … "-50") and its quick-create
// 127 (slugToken keeps 120). Asked for BY SLUG, such a section's list answered 400 where, by id, it
// listed. A long slug is asked for by id again — after the map, as before the lane — and the Worker
// answers a slug as long as /api/catalog/:slug accepts.

const LONG_NAME = 'Bambu Lab X1 Carbon and P1S Hotend Replacement Parts and Nozzle Kits';

test('the storefront asks a section with a slug longer than 60 characters for its list by id, and starts nothing early by slug', () => {
  assert.equal(LISTING_SLUG_MAX, 60);
  assert.equal(WORKER_LISTING_SLUG_MAX, LISTING_SLUG_MAX, 'one bound on both sides');
  const second = `${slugify(LONG_NAME, 'x')}-2`; // uniqueSlug's next candidate
  assert.equal(second.length, 62);
  for (const node of [{ id: 'cat_pacc', slug: second }, { id: 'cat_q', slug: 'q'.repeat(127) }, { id: 'cat_e', slug: '' }]) {
    assert.equal(listingCategory(node), node.id, node.slug);
    assert.equal(listingCategoryKey(node), node.id, `the Worker names the same request: ${node.slug}`);
  }
  for (const slug of ['fdm-materials', 'طابعات', 'x'.repeat(60)]) {
    assert.equal(listingCategory({ id: 'cat_x', slug }), slug);
    assert.equal(listingCategoryKey({ id: 'cat_x', slug }), slug);
  }
  // The URL holds only the slug: the list waits for the map to name the id, as it did before the lane.
  assert.deepEqual(categoryOpeningPaths(`/categories/printer-accessories/${second}`), [CATALOG_TREE_PATH]);
  assert.deepEqual(categoryOpeningPaths(`/categories/${second}/all`), [CATALOG_TREE_PATH]);
  assert.deepEqual(categoryOpeningPaths(`/categories/printer-accessories/${'x'.repeat(60)}`), [CATALOG_TREE_PATH, categoryListingPath('x'.repeat(60))]);
  // Both pages and the page beside its map use the same rule (the test above); so does a door's prefetch.
  assert.match(src('src/lib/catalog/prefetch.ts'), /if \(slug && listsBySlug\(slug\) && new URLSearchParams\(search\)\.toString\(\) === ''\) primeGet\(categoryListingPath\(slug\)\);/);
});

test('a long slug on a department\'s headers (an older Worker\'s) starts nothing; its id does', async () => {
  browser();
  const second = `${slugify(LONG_NAME, 'x')}-2`;
  const asked: string[] = [];
  let named = second;
  globalThis.fetch = ((path: string) => {
    asked.push(path);
    const headers = new Headers({ 'content-type': 'application/json', [CATALOG_LISTING_HEADER]: encodeURIComponent(named) });
    return Promise.resolve(new Response(JSON.stringify({ success: true }), { headers }));
  }) as typeof fetch;
  primeCategoryOpening(`/categories/${second}`);
  await tick();
  await tick();
  assert.deepEqual(asked, [`/api/catalog/${second}`]);
  clearPrimedRequests();
  asked.length = 0;
  named = 'cat_pacc';
  primeCategoryOpening(`/categories/${second}`);
  await tick();
  await tick();
  assert.deepEqual(asked, [`/api/catalog/${second}`, categoryListingPath('cat_pacc')]);
});

test('the Worker lists a section by a 62-character slug, and names its id on a listing department\'s headers', async () => {
  const { raw, app } = world();
  const second = `${slugify(LONG_NAME, 'x')}-2`;
  raw.prepare('UPDATE catalogs SET slug = ? WHERE id = ?').run(second, 'cat_pacc');
  const bySlug = await get(app, categoryListingPath(second));
  assert.equal(bySlug.status, 200, 'refused before: category is too long (max 60 characters)');
  const byId = await json(await get(app, categoryListingPath('cat_pacc')));
  const ids = (b: Record<string, unknown>) => (b.products as Array<{ id: string }>).map((p) => p.id);
  const slugBody = await json(bySlug);
  assert.ok(ids(byId).length > 0);
  assert.deepEqual(ids(slugBody), ids(byId));
  assert.equal(slugBody.category?.id, 'cat_pacc');
  // An id is what the storefront asks such a section's list by; the department names that request.
  const dept = await get(app, `/api/catalog/${second}`);
  assert.equal(dept.status, 200);
  assert.equal((await json(dept)).layout, 'listing');
  assert.equal(dept.headers.get(WORKER_LISTING_HEADER), 'cat_pacc');
  assert.equal(dept.headers.get(WORKER_LISTING_HEADER), listingCategory({ id: 'cat_pacc', slug: second }));
  // Beyond what /api/catalog/:slug accepts, the list is still refused by slug (its id answers it).
  assert.equal((await get(app, categoryListingPath('q'.repeat(81)))).status, 400);
});
