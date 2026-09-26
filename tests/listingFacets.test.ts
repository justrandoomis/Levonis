/**
 * THE LISTING'S FILTERS, SORTS AND DISJUNCTIVE FACET COUNTS (catalog discovery S1).
 *
 * Over the live catalogue of 2026-09-25: 10 printers under «طابعات FDM», 4 of
 * them available now, 2 brands. The counts a filter sheet shows must be the
 * counts the grid gets after «عرض», and each facet's counts must ignore that
 * facet's own selection (you see what switching would give).
 *
 * Run: node --import tsx --test tests/listingFacets.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { P, seedLiveCatalog } from './fixtures/liveCatalog';
import { productRoutes } from '../worker/routes/products';
import { applyFilters, facetTokensOf, sortItems, type ListingItem } from '../worker/lib/listingFacets';
import { DEFAULT_LISTING } from '../packages/catalog/src/discovery';

function world() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes));
  return { raw, app };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids = (b: Record<string, any>) => (b.products as Array<{ id: string }>).map((p) => p.id);
const FDM = '/api/products?category=cat_printers_fdm&limit=50';

test('the facet set of the FDM shelf reads the live data honestly', async () => {
  const { app } = world();
  const b = await json(await get(app, `${FDM}&facets=1`));
  assert.equal(b.total, 10);
  assert.equal(b.truncated, false);
  const f = b.facets;
  assert.equal(f.total, 10);
  assert.equal(f.avail.now, 4, 'H2S, A1, X2D, U1 are available now');
  assert.deepEqual(f.sale, { direct: 10, preorder: 10 });
  assert.deepEqual(
    f.brands.map((x: { slug: string; count: number }) => [x.slug, x.count]),
    [['bambu-lab', 9], ['snapmaker', 1]]
  );
  assert.equal(f.price.min, 525_000);
  assert.equal(f.price.max, 4_550_000);
  assert.equal(f.price.histogram.length, 12);
  assert.equal(f.price.histogram.reduce((a: number, n: number) => a + n, 0), 10);
  assert.deepEqual(
    f.specs.max_colors.map((o: { value: string; count: number }) => [o.value, o.count]),
    [['1-4', 3], ['16-20', 3], ['24-', 4]],
    'buckets from the data: 4,4,4 · 16,19,20 · 24,24,25,25'
  );
  assert.deepEqual(
    f.specs.enclosed.map((o: { value: string; count: number }) => [o.value, o.count]),
    [['0', 4], ['1', 6]]
  );
  assert.deepEqual(
    f.specs.skill_level.map((o: { value: string; count: number }) => [o.value, o.count]),
    [['beginner', 5], ['professional', 3]],
    'the A1 and the U1 state no skill level and are counted under neither — never assumed'
  );
  // Multi-nozzle volumes are read on their main nozzle, so all ten have a size.
  const sizes = f.specs.build_volume.map((o: { value: string; count: number }) => [o.value, o.count]);
  assert.deepEqual(sizes, [['compact', 1], ['large', 4], ['standard', 5]]);
});

test('facet counts are DISJUNCTIVE: a facet ignores its own selection and honours every other', async () => {
  const { app } = world();
  const b = await json(await get(app, `${FDM}&facets=1&brand=bambu-lab&avail=1`));
  // Grid: Bambu Lab AND available now → H2S, A1, X2D.
  assert.equal(b.total, 3);
  assert.deepEqual(ids(b).sort(), [P.H2S, P.A1, P.X2D].sort());
  // The brand facet ignores the brand selection but keeps «available now»:
  // Bambu 3, Snapmaker 1 — so the shopper sees that switching gives the U1.
  assert.deepEqual(
    b.facets.brands.map((x: { slug: string; count: number }) => [x.slug, x.count]),
    [['bambu-lab', 3], ['snapmaker', 1]]
  );
  // The availability facet ignores «available now» and keeps the brand: 3 of 9.
  assert.equal(b.facets.avail.now, 3);
  // A spec facet with nothing selected is counted under BOTH filters.
  const colors = Object.fromEntries(b.facets.specs.max_colors.map((o: { value: string; count: number }) => [o.value, o.count]));
  assert.deepEqual(colors, { '1-4': 1, '16-20': 0, '24-': 2 }, 'a zero is returned, not dropped — the sheet stays stable');
  assert.equal(b.facets.total, b.total, 'the count on «عرض» is the grid after apply');
});

test('two values of one facet are OR; two facets are AND', async () => {
  const { app } = world();
  const or = await json(await get(app, `${FDM}&f.max_colors=1-4,24-`));
  assert.equal(or.total, 7);
  const and = await json(await get(app, `${FDM}&f.max_colors=24-&f.enclosed=1`));
  assert.deepEqual(ids(and).sort(), [P.H2D, P.H2C, P.H2S, P.X2D].sort());
  const size = await json(await get(app, `${FDM}&f.build_volume=large`));
  assert.deepEqual(ids(size).sort(), [P.H2D, P.H2C, P.H2S, P.A2L].sort(), 'the X2D main nozzle is 256 × 256 × 260 — standard, not large');
});

test('a missing value never matches: the A1 has no skill level and is neither beginner nor pro', async () => {
  const { app } = world();
  const beg = await json(await get(app, `${FDM}&f.skill_level=beginner`));
  assert.equal(beg.products.some((p: { id: string }) => p.id === P.A1), false);
  const item = { specs: { skill_level: '' } } as unknown as ListingItem;
  assert.deepEqual(facetTokensOf('skill_level', item.specs), []);
  assert.deepEqual(facetTokensOf('enclosed', { enclosed: 'Optional' }), [], 'Optional is neither Yes nor No');
});

test('price, sale, offer and member filters read the viewer-resolved card', async () => {
  const { app } = world();
  const mid = await json(await get(app, `${FDM}&price=1250000-2500000`));
  assert.deepEqual(ids(mid).sort(), [P.H2S, P.P2S, P.X2D, P.U1].sort());
  const open = await json(await get(app, `${FDM}&price=-750000`));
  assert.deepEqual(ids(open).sort(), [P.A1MINI, P.A1].sort());
  const member = await json(await get(app, `${FDM}&member=1`));
  assert.equal(member.total, 10, 'every printer has a PRIME/PRO rung below the guest price');
  const offer = await json(await get(app, `${FDM}&offer=1`));
  assert.equal(offer.total, 0, 'no SALE price and no offer window in the live data');
  const pre = await json(await get(app, '/api/products?category=cat_makers&sale=preorder'));
  assert.equal(pre.total, 0, 'maker supplies sell direct only');
});

test('the seven sorts, each stable; the default puts available-now first', async () => {
  const { app } = world();
  const rel = await json(await get(app, `${FDM}&sort=relevance`));
  assert.deepEqual(ids(rel).slice(0, 4).sort(), [P.H2S, P.A1, P.X2D, P.U1].sort(), 'direct sale first');
  const asc = await json(await get(app, `${FDM}&sort=price_asc`));
  assert.deepEqual(ids(asc).slice(0, 3), [P.A1MINI, P.A1, P.P1S]);
  const desc = await json(await get(app, `${FDM}&sort=price_desc`));
  assert.deepEqual(ids(desc).slice(0, 2), [P.H2C, P.H2D]);
  const name = await json(await get(app, `${FDM}&sort=name`));
  assert.equal(name.products.at(-1).id, P.U1, 'Snapmaker sorts after every Bambu Lab');
  const newest = await json(await get(app, `${FDM}&sort=newest`));
  assert.equal(newest.products[0].id, P.H2D, 'the newest printer in the capture');
  const avail = await json(await get(app, `${FDM}&sort=available`));
  assert.deepEqual(ids(avail).slice(0, 4), [P.A1, P.U1, P.X2D, P.H2S], 'by units, 5 · 5 · 2 · 1');
});

test('«البيع المباشر أولًا»: direct-sale products first, pre-order-only after — stable', () => {
  const mk = (id: string, sale: string[], available: number, rank: number): ListingItem => ({
    id, card: { id }, name: id, price: 1, regular: 1, prime: null, pro: null, available, saleTypes: sale,
    brandId: null, brandSlug: null, createdAt: '', rank, scheduledOffer: false, specs: {},
  });
  const items = [
    mk('pre-a', ['pre_order'], 0, 0),
    mk('direct-empty', ['direct_sale'], 0, 1),
    mk('pre-b', ['pre_order'], 0, 2),
    mk('direct-stock', ['direct_sale', 'pre_order'], 3, 3),
  ];
  assert.deepEqual(sortItems(items, 'direct', false).map((i) => i.id), ['direct-stock', 'direct-empty', 'pre-a', 'pre-b']);
  assert.deepEqual(
    applyFilters(items, { ...DEFAULT_LISTING, sale: 'preorder' }).map((i) => i.id),
    ['pre-a', 'pre-b', 'direct-stock']
  );
});

test('paging happens after sorting, and the envelope says so', async () => {
  const { app } = world();
  const p1 = await json(await get(app, '/api/products?category=cat_printers_fdm&sort=price_asc&limit=4'));
  const p2 = await json(await get(app, '/api/products?category=cat_printers_fdm&sort=price_asc&limit=4&offset=4'));
  assert.equal(p1.total, 10);
  assert.equal(p1.sort, 'price_asc');
  assert.deepEqual([...ids(p1), ...ids(p2)].length, 8);
  assert.equal(new Set([...ids(p1), ...ids(p2)]).size, 8, 'no product on two pages');
  const prices = [...p1.products, ...p2.products].map((p: { display_price_iqd: number }) => p.display_price_iqd);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test('an unknown listing value is dropped, not refused', async () => {
  const { app } = world();
  const res = await get(app, `${FDM}&sort=cheapest&f.max_colors=lots&f.bogus=1&price=9-1`);
  assert.equal(res.status, 200);
  const b = await json(res);
  assert.equal(b.total, 10);
  assert.equal(b.sort, 'relevance');
});

test('search keeps its ranking under the listing, and a scoped search still filters', async () => {
  const { app } = world();
  const b = await json(await get(app, '/api/products?search=u1&sort=relevance&facets=1'));
  assert.equal(b.success, true);
  assert.equal(b.facets.total, b.total);
});
