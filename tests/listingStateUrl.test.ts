/**
 * THE LISTING'S URL IS ITS STATE (catalog discovery S5, docs/ux/CATALOG_DISCOVERY.md §7).
 *
 *  - the design's own example URL round-trips, and the API query the page
 *    sends is the SAME state when the Worker reads it back (one grammar);
 *  - every control is a pure state transform that keeps `q` and `sort`;
 *  - the quick chips and the filter-sheet sections come from the server's
 *    real facet counts (over the live catalogue) and only offer real choices;
 *  - the filter sheet's live count is the grid's count after apply (the
 *    `facets=1&limit=1` request and the page request agree);
 *  - `/categories/:cat/:sub` resolves by the last segment, with a canonical
 *    redirect for a wrong parent and the reserved `all`.
 *
 * Run: node --import tsx --test tests/listingStateUrl.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { catalogRoutes } from '../worker/routes/catalog';
import { productRoutes } from '../worker/routes/products';
import { parseListingParams } from '../packages/catalog/src/discovery';
import { emptyListing, listingApiQuery, parseListing, serializeListing } from '../src/lib/catalog/listingQuery';
import {
  SORT_ORDER,
  appliedChips,
  clearFilters,
  colorsLabel,
  quickChips,
  resolveListingRoute,
  sectionTypeOf,
  sheetSections,
  sortExplanation,
  sortLabel,
  specValueLabel,
  toggleBrand,
  toggleSpec,
  withoutGroup,
} from '../src/lib/catalog/listingModel';
import type { CatalogTreeResponse, FacetSet, ListingState } from '../src/lib/catalog/types';

function app() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  return stubApp(asD1(raw), null, (a) => {
    a.route('/api/catalog', catalogRoutes);
    a.route('/api/products', productRoutes);
  });
}

async function listing(a: ReturnType<typeof app>, state: ListingState, extra: { limit?: number } = {}) {
  const q = listingApiQuery(state, { category: 'cat_printers_fdm', limit: extra.limit ?? 24, facets: true });
  return (await json(await a.request(`/api/products?${q}`))) as { products: Array<{ id: string }>; total: number; facets: FacetSet };
}

const DESIGN_URL =
  'sort=price_asc&avail=1&sale=direct&price=500000-2500000&brand=bambu-lab,snapmaker&colors=24-&size=large&enclosed=1&level=beginner&q=h2';

test('the design’s example URL round-trips, and the Worker reads the page’s API query as the same state', () => {
  const state = parseListing(`?${DESIGN_URL}`);
  assert.equal(state.sort, 'price_asc');
  assert.deepEqual(state.brands, ['bambu-lab', 'snapmaker']);
  assert.deepEqual(state.specs.max_colors, ['24-']);
  assert.equal(parseListing(serializeListing(state)).q, 'h2');
  assert.equal(serializeListing(parseListing(serializeListing(state))), serializeListing(state), 'stable');
  const api = new URLSearchParams(listingApiQuery(state, { category: 'cat_printers_fdm', limit: 24, facets: true }));
  assert.deepEqual(parseListingParams((k) => api.get(k), 'api'), state, 'what the page shows applied is what the server applies');
  assert.equal(serializeListing(emptyListing()), '', 'the default list has a clean URL');
});

test('every control is a pure transform that keeps the search and the sort', () => {
  const base: ListingState = { ...parseListing(`?${DESIGN_URL}`) };
  const cleared = clearFilters(base);
  assert.equal(serializeListing(cleared), 'q=h2&sort=price_asc');
  assert.deepEqual(toggleBrand(base, 'snapmaker').brands, ['bambu-lab']);
  assert.deepEqual(toggleBrand(toggleBrand(base, 'snapmaker'), 'snapmaker').brands, ['bambu-lab', 'snapmaker']);
  assert.equal(toggleSpec(base, 'max_colors', '24-').specs.max_colors, undefined, 'the last value off removes the facet');
  assert.equal(withoutGroup(base, 'price').price, null);
  assert.deepEqual(base.brands, ['bambu-lab', 'snapmaker'], 'the input state is never mutated');
  assert.equal(SORT_ORDER.length, 7, 'the seven orders of the sort sheet');
  assert.equal(sortLabel('price_asc', 'ar'), 'السعر: من الأقل');
  assert.equal(sortExplanation('relevance', false, 'ar'), 'المتوفر للبيع المباشر أولًا');
  assert.equal(sortExplanation('relevance', true, 'ar'), 'الأقرب لبحثك أولًا');
});

test('facet values are said in words', () => {
  assert.equal(colorsLabel('24-', 'ar'), '24 لونًا فأكثر');
  assert.equal(colorsLabel('16-20', 'ar'), '16–20 لونًا');
  assert.equal(colorsLabel('1-4', 'ar'), 'حتى 4 ألوان');
  assert.equal(colorsLabel('16-', 'en'), '16+ colours');
  assert.equal(specValueLabel('enclosed', '1', 'ar'), 'هيكل مغلق');
  assert.equal(specValueLabel('skill_level', 'beginner', 'ar'), 'للمبتدئين');
  assert.equal(specValueLabel('diameter', '1.75', 'ar'), '1.75 مم');
  assert.equal(specValueLabel('material_type', 'pla', 'ar', 'PLA'), 'PLA');
});

test('quick chips and sheet sections come from the live facets and offer only real choices', async () => {
  const a = app();
  const { total, facets } = await listing(a, emptyListing());
  assert.equal(total, 10);
  const type = sectionTypeOf('printer');
  const chips = quickChips(type, facets, emptyListing(), 'ar');
  // 4 of 10 available, 6 of 10 enclosed, 7 of 10 with ≥ 16 colours, 9 of 10 Bambu Lab.
  // «طلب مسبق» is on every printer of the seed, so it would change nothing and is not offered.
  assert.deepEqual(chips.map((c) => [c.id, c.label, c.count]), [
    ['avail', 'متوفر الآن', 4],
    ['enclosed', 'هيكل مغلق', 6],
    ['multicolor', 'متعدد الألوان', 7],
    ['brand:bambu-lab', 'Bambu Lab', 9],
  ]);
  const sections = sheetSections(type, facets, emptyListing());
  assert.deepEqual(sections, ['availability', 'price', 'brands', 'max_colors', 'build_volume', 'enclosed', 'skill_level']);
  assert.ok(!sections.includes('technology'), 'every printer is FDM: «التقنية» is not a choice');
  // No offer is live and every printer has a lower PRO price (10 of 10): neither switch
  // would change the list, so «العروض والعضوية» is not drawn.
  assert.equal(facets.offer, 0);
  assert.equal(facets.member, 10);
  assert.ok(!sections.includes('offers'));

  // A chip turned on is a chip the list honours, and it stays on the row to be turned off.
  const on = chips.find((c) => c.id === 'multicolor')!.next;
  assert.equal(serializeListing(on), 'colors=16-');
  const after = await listing(a, on);
  assert.equal(after.total, 7);
  assert.ok(quickChips(type, after.facets, on, 'ar').find((c) => c.id === 'multicolor')?.active);
  const applied = appliedChips(on, { lang: 'ar', facets: after.facets });
  assert.deepEqual(applied.map((c) => c.label), ['16 لونًا فأكثر']);
  assert.equal(serializeListing(applied[0].next), '', 'removing the chip returns to the whole list');
});

test('the filter sheet’s live count is the grid’s count after apply', async () => {
  const a = app();
  const draft: ListingState = { ...emptyListing(), avail: true, brands: ['bambu-lab'] };
  const sheet = await listing(a, draft, { limit: 1 });
  const grid = await listing(a, draft);
  assert.equal(sheet.facets.total, grid.total);
  assert.equal(grid.products.length, grid.total);
  assert.equal(grid.total, 3);
});

test('the default list sorts direct-sale availability first; «عرض المزيد» keeps that order past page one', async () => {
  const a = app();
  const first = (await json(await a.request(`/api/products?${listingApiQuery(emptyListing(), { category: 'cat_printers_fdm', limit: 4, facets: true })}`))) as {
    products: Array<{ id: string; direct_stock_available?: number }>;
  };
  assert.ok(first.products.every((p) => (p.direct_stock_available ?? 0) > 0));
  // Page two, as useListing asks for it: no facets, but an explicit sort keeps the listing path.
  const q = listingApiQuery(emptyListing(), { category: 'cat_printers_fdm', limit: 4, offset: 4 });
  const second = (await json(await a.request(`/api/products?${q}&sort=relevance`))) as { products: Array<{ id: string; direct_stock_available?: number }>; total?: number };
  assert.equal(second.total, 10, 'still the listing envelope');
  assert.ok(second.products.every((p) => (p.direct_stock_available ?? 0) === 0));
  assert.equal(new Set([...first.products, ...second.products].map((p) => p.id)).size, 8, 'no product twice across pages');
});

test('/categories/:cat/:sub resolves by the last segment, with canonical redirects', async () => {
  const a = app();
  const tree = (await json(await a.request('/api/catalog/tree'))) as CatalogTreeResponse;
  const fdm = resolveListingRoute(tree.roots, 'printers', 'fdm-printers')!;
  assert.equal(fdm.node.id, 'cat_printers_fdm');
  assert.equal(fdm.canonical, '/categories/printers/fdm-printers');
  assert.equal(fdm.all, false);

  const all = resolveListingRoute(tree.roots, 'printers', 'all')!;
  assert.equal(all.node.id, 'cat_printers');
  assert.equal(all.canonical, '/categories/printers/all');

  // A wrong parent is not a 404: the section is found and the URL corrected.
  assert.equal(resolveListingRoute(tree.roots, 'makers-supply', 'fdm-printers')!.canonical, '/categories/printers/fdm-printers');
  // A root named as its own sub-section is its «all».
  assert.equal(resolveListingRoute(tree.roots, 'printers', 'printers')!.canonical, '/categories/printers/all');
  // A child's «all» is the child itself.
  assert.equal(resolveListingRoute(tree.roots, 'fdm-printers', 'all')!.canonical, '/categories/printers/fdm-printers');
  assert.equal(resolveListingRoute(tree.roots, 'printers', 'resin-printers'), null, 'unknown here — the page asks the category route');
});

test('a third level (مواد الطباعة ‹ مواد FDM ‹ فيلمنت PLA) is nested in the tree, lives at /categories/<root>/<slug> and lists its products', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  raw.exec(`INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, sort) VALUES ('cat_pla', 'cat_materials_fdm', 'pla', 'فيلمنت PLA', 'PLA filament', 1);
            UPDATE products SET sub_category_id = 'cat_pla' WHERE sub_category_id = 'cat_materials_fdm';`);
  const a = stubApp(asD1(raw), null, (x) => {
    x.route('/api/catalog', catalogRoutes);
    x.route('/api/products', productRoutes);
  });
  const tree = (await json(await a.request('/api/catalog/tree'))) as CatalogTreeResponse;
  const fdm = tree.roots.find((r) => r.slug === 'printing-materials')!.children[0];
  assert.equal(fdm.slug, 'fdm-materials');
  assert.deepEqual(fdm.children.map((c) => [c.slug, c.path, c.product_count]), [['pla', '/categories/printing-materials/pla', 1]]);

  // The sub-section page (/categories/printing-materials/fdm-materials) draws
  // its child's banner; the banner's link resolves, canonically, to PLA.
  const pla = resolveListingRoute(tree.roots, 'printing-materials', 'pla')!;
  assert.equal(pla.node.id, 'cat_pla');
  assert.equal(pla.canonical, '/categories/printing-materials/pla');
  assert.equal(resolveListingRoute(tree.roots, 'fdm-materials', 'pla')!.canonical, '/categories/printing-materials/pla', 'a wrong parent is corrected, not a 404');
  const parent = resolveListingRoute(tree.roots, 'printing-materials', 'fdm-materials')!;
  assert.equal(parent.all, false);
  assert.deepEqual(parent.node.children.map((c) => c.slug), ['pla']);

  const list = (await json(await a.request(`/api/products?${listingApiQuery(emptyListing(), { category: 'cat_pla', limit: 24, facets: true })}`))) as { total: number };
  assert.equal(list.total, 1);
  const page = await a.request('/api/catalog/pla');
  assert.equal(page.status, 200, 'the category route knows it too (a leaf → its listing)');
});
