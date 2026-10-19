/**
 * CATALOG-ONLY MAY APPEAR BUT MUST NOT CROWD PRICED ITEMS (DECISIONS row 240;
 * spec §3.2, §3.6 rules R1–R4, §7.2).
 *
 * Proves:
 *   - R3: both price sorts put an unpriced product LAST; a price range, «عليها
 *     عرض» and «سعر أقل للأعضاء» exclude it;
 *   - R1: the default browse is a stable partition (priced first), and with
 *     350 unpriced products newer than 5 priced ones every priced product
 *     still comes first (the listing pages every candidate now —
 *     tests/listingPaging.test.ts);
 *   - R2: search keeps pure relevance — the order of the hits is the same
 *     whether the product is priced or not;
 *   - R4: the home's new arrivals take at most 5 catalog-only products, and
 *     only in the slots fewer than 20 priced ones leave empty; the commercial
 *     shelves (featured, discounted, …) never show an unpriced product, even
 *     one flagged featured with a legacy «was» price.
 *
 * Run: node --import tsx --test tests/catalogOnlySorting.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { publishV2 } from './fixtures/v2Publish';
import { CAT, catalogLeaks, catalogOnlyWorld, mountCustomer, type CatalogOnlyWorld } from './fixtures/catalogOnly';

type Card = Record<string, any>;
const listOf = (body: Record<string, unknown>) => (body.products ?? []) as Card[];

let shared: Promise<CatalogOnlyWorld> | null = null;
const world = () => (shared ??= catalogOnlyWorld());

test('R3: both price sorts put the unpriced product last; price, offer and member filters exclude it', async () => {
  const w = await world();
  const app = w.as(null);
  for (const sort of ['price_asc', 'price_desc'] as const) {
    const list = listOf(await json(await get(app, `/api/products?sort=${sort}&limit=50`)));
    assert.equal(list.length, 14);
    assert.equal(list.at(-1)!.id, CAT.id, `${sort}: unpriced last`);
    const prices = list.slice(0, -1).map((p) => Number(p.display_price_iqd));
    const sorted = [...prices].sort((a, b) => (sort === 'price_asc' ? a - b : b - a));
    assert.deepEqual(prices, sorted, `${sort}: the priced ones in price order`);
  }
  for (const filter of ['price=0-99999999', 'price=1000-', 'offer=1', 'member=1']) {
    const body = await json(await get(app, `/api/products?${filter}&limit=50`));
    assert.deepEqual(catalogLeaks(body), []);
    assert.equal(listOf(body).some((p) => p.id === CAT.id), false, `${filter} excludes a product with no price`);
  }
  // The facet histogram and bounds never count it.
  const facets = await json(await get(app, '/api/products?limit=50'));
  assert.deepEqual(catalogLeaks(facets), []);
});

/**
 * THE BAMBU IMPORT'S HARD DEPENDENCIES (its spec §K.1): D-4, a price range excludes every unpriced product
 * — in the exact syntax workflow 7's probes read `{slug}` with (`price=1-`, formatPriceRange) and through the
 * public API's `min_price` / `max_price`, which build the same range — and D-3, the API context says how
 * many products are priced (`products_priced`) beside how many are shown (`products`).
 */
test('D-4: the probes\' price range (price=1-) and the public API\'s min_price / max_price exclude the unpriced product; D-3: the context counts the priced ones', async () => {
  const w = await world();
  const app = w.as(null);
  const all = listOf(await json(await get(app, '/api/products?limit=50')));
  assert.ok(all.some((p) => p.id === CAT.id), 'without a range the unpriced product is shown');
  const ranged = listOf(await json(await get(app, '/api/products?limit=50&price=1-')));
  assert.equal(ranged.length, all.length - 1, 'every priced product, and only those');
  assert.ok(ranged.every((p) => p.price_status === 'priced' && Number.isSafeInteger(p.price_iqd)));
  assert.equal(listOf(await json(await get(app, '/api/products?limit=1&price=1-')))[0]?.price_status, 'priced', 'the probes\' {slug} is a priced product');
  for (const q of ['min_price=0', 'min_price=1', 'max_price=1000000000', 'min_price=0&max_price=1000000000']) {
    const body = await json(await get(app, `/api/public/v1/products?limit=50&${q}`));
    assert.deepEqual(catalogLeaks(body), []);
    const slugs = (body.data as Array<{ slug: string; price: { status: string } }>).map((p) => p.slug);
    assert.ok(slugs.length > 0, `${q}: not vacuous`);
    assert.equal(slugs.includes(CAT.slug), false, `${q} excludes a product with no price`);
  }
  const plain = await json(await get(app, '/api/public/v1/products?limit=50'));
  assert.ok((plain.data as Array<{ slug: string }>).some((p) => p.slug === CAT.slug), 'without a price filter the API shows it');
  const context = (await json(await get(app, '/api/public/v1/context'))).content as { products: number; products_priced: number };
  assert.equal(context.products, all.length);
  assert.equal(context.products_priced, all.length - 1);
});

test('R1: the default browse is a stable partition, priced first', async () => {
  const w = await world();
  const list = listOf(await json(await get(w.as(null), '/api/products?limit=50')));
  const firstUnpriced = list.findIndex((p) => p.price_status === 'unpriced');
  assert.ok(list.slice(firstUnpriced).every((p) => p.price_status === 'unpriced'));
  for (const sort of ['available', 'direct'] as const) {
    const sorted = listOf(await json(await get(w.as(null), `/api/products?sort=${sort}&limit=50`)));
    assert.equal(sorted.at(-1)!.id, CAT.id, `${sort}: priced first`);
  }
});

/** 5 priced products, then 350 newer unpriced ones (the import of ~1,100 in miniature). */
async function crowded(): Promise<DatabaseSync> {
  const raw = freshDb();
  const ins = raw.prepare(
    `INSERT INTO products (id, slug, name, status, price_iqd, stock, selling_type, sale_types, is_featured, original_price_iqd, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, 3, 'direct_sale', '["direct_sale"]', ?, ?, ?, ?)`
  );
  for (let i = 0; i < 5; i++) {
    const at = `2026-01-0${i + 1}T00:00:00.000Z`;
    ins.run(`p_priced_${i}`, `priced-${i}`, `Priced ${i}`, 100_000 + i * 1000, 0, null, at, at);
  }
  for (let i = 0; i < 350; i++) {
    const at = `2026-10-${String(1 + (i % 14)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`;
    // Legacy columns still filled — featured and «was» priced — as an imported archive could leave them.
    ins.run(`p_unpriced_${String(i).padStart(3, '0')}`, `unpriced-${i}`, `Unpriced ${i}`, 7_101_000, i < 10 ? 1 : 0, i < 10 ? 7_404_000 : null, at, at);
  }
  for (let i = 0; i < 5; i++) await publishV2(raw, `p_priced_${i}`);
  return raw;
}

test('R1 at scale: 350 newer unpriced products still leave every priced one first', async () => {
  const raw = await crowded();
  const app = stubApp(asD1(raw), null, mountCustomer, { publishV2: false });
  const body = await json(await get(app, '/api/products?limit=48'));
  const list = listOf(body);
  assert.deepEqual(
    list.slice(0, 5).map((p) => p.id).sort(),
    ['p_priced_0', 'p_priced_1', 'p_priced_2', 'p_priced_3', 'p_priced_4']
  );
  assert.ok(list.slice(5).every((p) => p.price_status === 'unpriced'));
  assert.deepEqual(catalogLeaks(body), []);
  for (const filter of ['type=featured', 'type=discounted']) {
    const shelf = listOf(await json(await get(app, `/api/products?${filter}&limit=48`)));
    assert.equal(shelf.some((p) => String(p.id).startsWith('p_unpriced_')), false, `${filter} is for priced products only`);
  }
});

test('R4: new arrivals take at most 5 catalog-only products, only where fewer than 20 priced leave room; no commercial shelf shows one', async () => {
  const raw = await crowded();
  const app = stubApp(asD1(raw), null, mountCustomer, { publishV2: false });
  const home = await json(await get(app, '/api/home'));
  assert.deepEqual(catalogLeaks(home), []);
  const latest = (home.latest ?? []) as Card[];
  assert.equal(latest.length, 10, '5 priced + at most 5 catalog-only');
  assert.ok(latest.slice(0, 5).every((p) => p.price_status === 'priced'), 'priced first');
  assert.ok(latest.slice(5).every((p) => p.price_status === 'unpriced'));
  for (const [shelf, items] of Object.entries(home)) {
    if (shelf === 'latest' || !Array.isArray(items)) continue;
    assert.ok(!JSON.stringify(items).includes('p_unpriced_'), `the ${shelf} shelf shows no unpriced product`);
  }

  // Twenty priced products: the new arrivals are all priced.
  const more = raw.prepare(
    `INSERT INTO products (id, slug, name, status, price_iqd, stock, selling_type, sale_types, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, 3, 'direct_sale', '["direct_sale"]', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`
  );
  for (let i = 5; i < 20; i++) {
    more.run(`p_priced_${i}`, `priced-${i}`, `Priced ${i}`, 100_000 + i * 1000);
    await publishV2(raw, `p_priced_${i}`);
  }
  const full = (await json(await get(stubApp(asD1(raw), null, mountCustomer, { publishV2: false }), '/api/home'))).latest as Card[];
  assert.equal(full.length, 20);
  assert.ok(full.every((p) => p.price_status === 'priced'), 'no catalog-only product once 20 priced exist');
});

test('R2: search keeps pure relevance — the hits are in the same order priced or not', async () => {
  const w = await catalogOnlyWorld();
  const app = w.as(null);
  const order = async () => listOf(await json(await get(app, '/api/products?search=H2&limit=50'))).map((p) => p.id);
  const before = await order();
  assert.ok(before.includes(CAT.id), 'the unpriced product is a hit');
  assert.ok(before.length >= 3, `H2D, H2C and H2S (${before.length})`);
  await publishV2(w.raw, CAT.id);
  const after = await order();
  assert.deepEqual(after, before, 'its price state does not move it in a search');
});
