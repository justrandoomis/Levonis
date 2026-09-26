/**
 * ZERO RESULTS OFFER A WAY BACK, ONE FILTER AT A TIME, WITH COUNTS
 * (catalog discovery S5, docs/ux/CATALOG_DISCOVERY.md §7 «Empty result»).
 *
 * A shopper who stacks «متوفر الآن» + «24 لونًا فأكثر» + «Snapmaker» on the live
 * FDM shelf gets nothing. The page must not say only «لا توجد نتائج»: it lists
 * each active filter with «أزل» and the number removing it brings back — and
 * those numbers must be what the list then shows. This drives the real
 * `/api/products` for the zero state and for every undo line (the requests
 * EmptyFiltered makes), and renders the component's words.
 *
 * Run: node --import tsx --test tests/listingEmptyUndo.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { productRoutes } from '../worker/routes/products';
import { emptyListing, listingApiQuery, serializeListing } from '../src/lib/catalog/listingQuery';
import { activeGroups, undoOptions } from '../src/lib/catalog/listingModel';
import { countNoun } from '../src/lib/catalog/copy';
import type { FacetSet, ListingState } from '../src/lib/catalog/types';

function app() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  return stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes));
}

async function totalFor(a: ReturnType<typeof app>, state: ListingState, limit = 1) {
  const q = listingApiQuery(state, { category: 'cat_printers_fdm', limit, facets: true });
  const body = (await json(await a.request(`/api/products?${q}`))) as { total: number; facets: FacetSet; products: unknown[] };
  return body;
}

const ZERO: ListingState = {
  ...emptyListing(),
  avail: true,
  brands: ['snapmaker'],
  specs: { max_colors: ['24-'] },
};

test('the stacked filters give nothing, and each undo line names one filter and what it brings back', async () => {
  const a = app();
  const zero = await totalFor(a, ZERO, 24);
  assert.equal(zero.total, 0);
  assert.equal(zero.products.length, 0);

  const options = undoOptions(ZERO, { lang: 'ar', facets: zero.facets });
  assert.deepEqual(options.map((o) => [o.group, o.label]), [
    ['avail', 'متوفر الآن'],
    ['brands', 'Snapmaker'],
    ['max_colors', '24 لونًا فأكثر'],
  ]);
  assert.deepEqual(activeGroups(ZERO), ['avail', 'brands', 'max_colors']);

  // What each line promises is what the list then shows.
  const counts: Record<string, number> = {};
  for (const o of options) {
    counts[o.group] = (await totalFor(a, o.next)).total;
    const grid = await totalFor(a, o.next, 24);
    assert.equal(grid.products.length, counts[o.group], `«أزل ${o.label}» shows the count it promised`);
  }
  // Without «متوفر الآن»: Snapmaker with 24+ colours — none (the U1 prints 4).
  // Without Snapmaker: available now with 24+ colours — the X2D and the H2S.
  // Without «24 لونًا فأكثر»: available Snapmaker — the U1.
  assert.deepEqual(counts, { avail: 0, brands: 2, max_colors: 1 });
  assert.equal(`← ${countNoun(counts.brands, 'printer', 'ar')}`, '← طابعتان');
});

test('each undo keeps the other filters, the search and the sort', () => {
  const state: ListingState = { ...ZERO, q: 'bambu', sort: 'price_desc' };
  for (const o of undoOptions(state, { lang: 'en', facets: null })) {
    assert.equal(o.next.q, 'bambu');
    assert.equal(o.next.sort, 'price_desc');
    assert.equal(activeGroups(o.next).length, 2, `removing ${o.group} removes exactly one group`);
  }
  assert.equal(serializeListing(undoOptions(state, { lang: 'en', facets: null })[0].next), 'q=bambu&sort=price_desc&brand=snapmaker&colors=24-');
});

test('a brand label falls back to its slug when the counts no longer list it', () => {
  const [, brand] = undoOptions(ZERO, { lang: 'ar', facets: null });
  assert.equal(brand.label, 'snapmaker');
});
