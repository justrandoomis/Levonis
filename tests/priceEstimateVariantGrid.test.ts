/**
 * A PRODUCT STOCKED BY COMBINATION IS MATCHED AND ESTIMATED ON THE COMBINATIONS
 * IT SELLS (review finding data-1; docs/SMART_PRICING.md §3.5, §3.7, §4.4).
 *
 * The Bambu import writes one variant per source SKU and never a missing
 * combination, and the cart refuses a combination with no active variant row
 * (inventory.ts `resolveStock`, VARIANT_NOT_MODELLED). `sellableSkus` leaves
 * out such a combination of a VARIANT_COMBINATION product when each of its
 * choices (its option values, its colour) is stocked in another combination,
 * so:
 *
 *   - the Bambu Bus Cable (Type 6pin / 4pin × Length 510 / 1500 / 260 mm, the
 *     3 variants the EU store sells) matches the EU store `high`, 3 of 3, is
 *     priced from it with no EST_NO_PRICE, and is estimated and applied; its
 *     V2 state stays complete in the owner's panel and in an FX-5 evaluation;
 *   - the H2D sample's real «Standard» and «standard» SKUs are no longer
 *     AMBIGUOUS with cells the store does not sell;
 *   - a choice no row stocks (a model, a value, a colour) keeps its cells
 *     exactly as before, so every choice the grid offered is still offered:
 *     a price request for it is taken, never refused as «not part of this
 *     product», and its estimate asks for its price (EST_NO_PRICE);
 *   - a grid equal to its variants, every other inventory mode, and a product
 *     with no active variant row or none naming a cell answer exactly as
 *     before; a grid past the SKU limit is counted on the cells it keeps
 *     (tests/priceEstimateVariantGridLarge.test.ts).
 *
 * Run: node --import tsx --test tests/priceEstimateVariantGrid.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, freshDb, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { v2Context } from './fixtures/pricingV2';
import { fixtureText, importedIdentity } from './fixtures/supplierPrices/load';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminSupplierPricesRoutes } from '../worker/routes/adminSupplierPrices';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { sellableSkus, type SellableSku } from '../worker/lib/pricingEngine/legacy';
import { checkSelection, namesUnpricedChoice } from '../worker/lib/commercialState';
import { evaluateV2Write, storedDesired } from '../worker/lib/pricingEngine/v2/evaluate';
import { loadProductSkus, supplierPricesFor, versionTokens } from '../worker/lib/supplierPrices/store';
import { runMatchPage } from '../worker/lib/supplierPrices/matcher';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const SP = '/api/admin/pricing/supplier-prices';
const EST = '/api/admin/pricing/estimates';
const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const mount = (raw: DatabaseSync) =>
  stubApp(
    asD1(raw),
    OWNER,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(SP, adminSupplierPricesRoutes);
      a.route(EST, adminPriceEstimatesRoutes);
      a.route('/api/admin/products-v2', adminProductsRoutes);
    },
    { publishV2: false }
  );
type App = ReturnType<typeof mount>;

async function call(app: App, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
  const res = method === 'GET' ? await get(app, path) : method === 'POST' ? await post(app, path, body ?? {}) : await put(app, path, body ?? {});
  return { status: res.status, body: (await json(res)) as Json };
}

// ---------------------------------------------------------------- the Bambu Bus Cable

/** The combo keys of its grid (`skuComboKey`: option ids sorted). */
const SIX_510 = 'o:v_510|o:v_6';
const SIX_1500 = 'o:v_1500|o:v_6';
const SIX_260 = 'o:v_260|o:v_6';
const FOUR_510 = 'o:v_4|o:v_510';
const FOUR_1500 = 'o:v_1500|o:v_4';
const FOUR_260 = 'o:v_260|o:v_4';
/** The three variants the store sells (data/bambu-eu-prices, 2026-10-31). */
const REAL = [SIX_510, SIX_1500, FOUR_260];
const GRID = [SIX_510, SIX_1500, SIX_260, FOUR_510, FOUR_1500, FOUR_260];

/**
 * The Bus Cable as the import creates it: two option groups, five values, one variant per source SKU,
 * direct sale only, no stock, no price, the store handle. `variants` defaults to the real three.
 */
function seedBusCable(raw: DatabaseSync, o: { id?: string; mode?: string; variants?: string[]; active?: number } = {}): string {
  const id = o.id ?? 'p_bus';
  const v = (s: string) => (id === 'p_bus' ? s : `${s}_${id}`);
  const key = (combo: string) => combo.replace(/o:(v_\w+)/g, (_m, x: string) => `o:${v(x)}`);
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
      VALUES (${q(id)}, ${q(`slug-${id}`)}, 'Bambu Bus Cable', 'كابل باص بامبو', 'کێبڵی باسی بامبو', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', ${q(o.mode ?? 'VARIANT_COMBINATION')});
    INSERT INTO product_option_groups (id, product_id, name_en, kind, sort, active) VALUES
      (${q(v('g_type'))}, ${q(id)}, 'Type', 'other', 0, 1), (${q(v('g_len'))}, ${q(id)}, 'Size', 'size', 1, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES
      (${q(v('v_6'))}, ${q(id)}, ${q(v('g_type'))}, '6pin (AMS to AMS/Hub/Buffer)', '٦ دبابيس', '٦ پین', 0, 1),
      (${q(v('v_4'))}, ${q(id)}, ${q(v('g_type'))}, '4pin (Printer to Hub/Buffer)', '٤ دبابيس', '٤ پین', 1, 1),
      (${q(v('v_510'))}, ${q(id)}, ${q(v('g_len'))}, '510mm', '٥١٠ ملم', '٥١٠ میلیمەتر', 0, 1),
      (${q(v('v_1500'))}, ${q(id)}, ${q(v('g_len'))}, '1500mm', '١٥٠٠ ملم', '١٥٠٠ میلیمەتر', 1, 1),
      (${q(v('v_260'))}, ${q(id)}, ${q(v('g_len'))}, '260mm', '٢٦٠ ملم', '٢٦٠ میلیمەتر', 2, 1);
  `);
  (o.variants ?? REAL).forEach((combo, i) => {
    raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active) VALUES (${q(`pv_${id}_${i}`)}, ${q(id)}, ${q(key(combo))}, ${o.active ?? 1})`);
  });
  return id;
}

/** The Bus Cable's import row: created, stock not configured, the store handle the EU store shares. */
const sourceRef = (raw: DatabaseSync, id: string) =>
  raw.exec(`INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
            VALUES ('bambu_us', '6945416970376', ${q(id)}, 'bambu-bus-cable', 'https://us.store.bambulab.com/products/bambu-bus-cable', 'created', 'not_configured', 'f',
                    '2026-10-30T00:00:00.000Z', 'cir_000000000000000000000001')`);

/** The EU store's Bus Cable page, captured 2026-10-31 (data/bambu-eu-prices/eu-store-2026-10-31.v1.json), as a v1 file dated today. */
const busCableCapture = () => ({
  source: 'bambu_eu',
  currency: 'EUR',
  price_basis: 'list',
  capture: 'browser_sweep',
  captured_on: TODAY,
  captured_by: 'browser sweep (?skr=yes)',
  items: [
    {
      item_key: 'bambu-bus-cable',
      url: 'https://eu.store.bambulab.com/products/bambu-bus-cable?skr=yes',
      page_host: 'eu.store.bambulab.com',
      title: 'Bambu Bus Cable',
      name_en: 'Bambu Bus Cable',
      category: 'spare_part',
      sourcing: 'EU_STORE_EUR',
      freight_route: 'GERMANY_LAND',
      skus: [
        ['43372657443035', '6pin (AMS to AMS/Hub/Buffer)', '510mm', '4.99'],
        ['48836361290076', '6pin (AMS to AMS/Hub/Buffer)', '1500mm', '6.99'],
        ['48836361322844', '4pin (Printer to Hub/Buffer)', '260mm', '4.99'],
      ].map(([sku_key, option1, option2, price]) => ({
        sku_key,
        options: { option1, option2 },
        options_en: { option1, option2 },
        price,
        price_label: '',
        quantity: null,
        sku_code: '',
      })),
    },
  ],
});
const EU_SKU: Record<string, string> = { [SIX_510]: '43372657443035', [SIX_1500]: '48836361290076', [FOUR_260]: '48836361322844' };

/** A v1 file uploaded and completed through the owner's routes (the current snapshot of its source). */
async function upload(app: App, file: Json): Promise<string> {
  const text = JSON.stringify(file);
  const sha = createHash('sha256').update(text).digest('hex');
  const { source, currency, price_basis, capture, captured_on, captured_by } = file;
  const created = await call(app, 'POST', `${SP}/snapshots`, { source, currency, price_basis, capture, captured_on, captured_by, file_sha256: sha, item_count: file.items.length });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.snapshot.id as string;
  for (let i = 0; i < file.items.length; i += 10) assert.equal((await call(app, 'POST', `${SP}/snapshots/${id}/items`, { items: file.items.slice(i, i + 10), offset: i })).status, 200);
  const skus = (file.items as Json[]).reduce((n, it) => n + it.skus.length, 0);
  const done = await call(app, 'POST', `${SP}/snapshots/${id}/complete`, { item_count: file.items.length, sku_count: skus, file_sha256: sha });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return id;
}

const gridOf = async (raw: DatabaseSync, id: string) => {
  const loaded = (await loadProducts(asD1(raw), [id])).get(id)!;
  return { loaded, grid: sellableSkus(loaded.doc, loaded.view) };
};
/** The same document read without its inventory mode: the grid as `sellableSkus` answered before it read the variant rows. */
const unfiltered = async (raw: DatabaseSync, id: string) => {
  const loaded = (await loadProducts(asD1(raw), [id])).get(id)!;
  return sellableSkus(loaded.doc, { ...loaded.view!, inventory_mode: 'BASE' });
};
/** Every choice some SKU holds (each option value and colour, as combo-key parts), sorted. */
const held = (skus: readonly SellableSku[]): string[] =>
  [...new Set(skus.flatMap((s) => [...s.option_value_ids.map((v) => `o:${v}`), ...(s.color ? [`c:${s.color.id}`] : [])]))].sort();

// ---------------------------------------------------------------- 1. the sellable SKUs

test('sellableSkus: a VARIANT_COMBINATION product leaves out a combination it has no row for when each of its choices is stocked in another', async () => {
  const raw = freshDb();
  seedBusCable(raw);
  const { loaded, grid } = await gridOf(raw, 'p_bus');
  assert.equal(grid.overflow, false);
  assert.deepEqual(
    grid.skus.map((s) => [s.combo_key, s.option_value_ids, s.model?.id ?? null, s.color]),
    [
      [SIX_510, ['v_6', 'v_510'], 'v_6', null],
      [SIX_1500, ['v_6', 'v_1500'], 'v_6', null],
      [FOUR_260, ['v_4', 'v_260'], 'v_4', null],
    ],
    'the three variants the store sells, in grid order, the model first'
  );
  const before = await unfiltered(raw, 'p_bus');
  assert.deepEqual(before.skus.map((s) => s.combo_key), GRID, 'the grid itself is six cells');
  assert.deepEqual(held(grid.skus), held(before.skus), 'every type and length the grid offered is still offered');

  // The server-side selection check agrees with the cart: a cell with no variant row is not a SKU.
  const { doc, view } = loaded;
  assert.deepEqual(checkSelection(doc, view, ['v_4', 'v_260'], null), { ok: true, key: FOUR_260, optionValueIds: ['v_4', 'v_260'], colorId: null });
  assert.deepEqual(checkSelection(doc, view, ['v_4', 'v_510'], null), { ok: false, code: 'PRICE_REQUEST_SELECTION_INVALID' });
  assert.deepEqual(checkSelection(doc, view, ['v_4'], null), { ok: false, code: 'PRICE_REQUEST_SELECTION_REQUIRED' });
  assert.deepEqual(checkSelection(doc, view, ['v_510'], null), { ok: false, code: 'PRICE_REQUEST_SELECTION_REQUIRED' });

  // The only 1500 mm row switched off: 1500 mm is then stocked nowhere, so its two cells answer as before; the
  // other cells the store does not sell stay out. Switched on again: the three variants.
  raw.exec(`UPDATE product_variants SET active = 0 WHERE product_id = 'p_bus' AND combo_key = ${q(SIX_1500)}`);
  assert.deepEqual((await gridOf(raw, 'p_bus')).grid.skus.map((s) => s.combo_key), [SIX_510, SIX_1500, FOUR_1500, FOUR_260]);
  raw.exec(`UPDATE product_variants SET active = 1 WHERE product_id = 'p_bus'`);
  assert.deepEqual((await gridOf(raw, 'p_bus')).grid.skus.map((s) => s.combo_key), REAL);

  // A colour product stocked per model × colour: the pair without an active row leaves, the colour stays with the other model.
  seedColours(raw);
  raw.exec("UPDATE product_variants SET active = 0 WHERE id = 'pv_c4'");
  const colours = (await gridOf(raw, 'p_col')).grid.skus;
  assert.deepEqual(colours.map((s) => s.combo_key), ['o:m1|c:c_red', 'o:m1|c:c_blue', 'o:m2|c:c_red']);
  assert.deepEqual(held(colours), held((await unfiltered(raw, 'p_col')).skus));
});

test('a choice no variant row stocks keeps its cells as before: a price request for it is taken, and the estimate asks its price', async () => {
  const raw = freshDb();
  seedBusCable(raw);
  // 3000 mm: a length the page lists that no variant stocks (the cart refuses each of its cells).
  raw.exec("INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES ('v_3000', 'p_bus', 'g_len', '3000mm', '٣٠٠٠ ملم', '٣٠٠٠ میلیمەتر', 3, 1)");
  const SIX_3000 = 'o:v_3000|o:v_6';
  const FOUR_3000 = 'o:v_3000|o:v_4';
  const { loaded, grid } = await gridOf(raw, 'p_bus');
  assert.deepEqual(grid.skus.map((s) => s.combo_key), [SIX_510, SIX_1500, SIX_3000, FOUR_260, FOUR_3000], 'the real three, and 3000 mm with each type, as before');
  assert.deepEqual(held(grid.skus), held((await unfiltered(raw, 'p_bus')).skus));

  // Priced on the three real SKUs only (an estimate cannot be applied without 3000 mm, but an owner's V2 write
  // can leave it unpriced): the page answers «طلب السعر» for 3000 mm, and the request door takes it — never
  // «not part of this product». A cell the store does not sell whose choices it sells elsewhere is no SKU: the
  // quote answers it «not available» (VARIANT_NOT_MODELLED), not «طلب السعر».
  const strict = { ...loaded.doc, sku_strict: true as const, sku_prices: REAL.map((combo_key) => ({ combo_key, channel: 'pre_order_land', regular_price_iqd: 14_250, v2: true as const })) };
  const { view } = loaded;
  assert.equal(namesUnpricedChoice(strict, view, ['v_6', 'v_3000'], null), true);
  assert.deepEqual(checkSelection(strict, view, ['v_6', 'v_3000'], null), { ok: true, key: SIX_3000, optionValueIds: ['v_6', 'v_3000'], colorId: null });
  assert.equal(namesUnpricedChoice(strict, view, ['v_3000'], null), true);
  assert.deepEqual(checkSelection(strict, view, ['v_3000'], null), { ok: false, code: 'PRICE_REQUEST_SELECTION_REQUIRED' });
  assert.equal(namesUnpricedChoice(strict, view, ['v_4', 'v_510'], null), false);
  assert.deepEqual(checkSelection(strict, view, ['v_4', 'v_510'], null), { ok: false, code: 'PRICE_REQUEST_SELECTION_INVALID' });

  // The estimate: the EU store sells no 3000 mm, so its two cells ask for a price (fail closed); the three real
  // ones are matched to the store's SKUs.
  sourceRef(raw, 'p_bus');
  const app = mount(raw);
  await upload(app, busCableCapture());
  assert.equal((await call(app, 'POST', `${SP}/match`, { product_ids: ['p_bus'] })).status, 200);
  assert.deepEqual(
    all<Json>(raw, "SELECT combo_key, sku_key FROM supplier_price_matches WHERE product_id = 'p_bus' ORDER BY combo_key").map((m) => [m.combo_key, m.sku_key]),
    [...REAL].sort().map((combo) => [combo, EU_SKU[combo]])
  );
  const prices = (await supplierPricesFor(asD1(raw), [{ product_id: 'p_bus', combo_keys: grid.skus.map((s) => s.combo_key), sourcing: 'EU_STORE_EUR', us_reference_allowed: true }])).get('p_bus')!;
  assert.deepEqual(prices.get(SIX_3000)?.flags, ['EST_NO_PRICE']);
  assert.deepEqual(prices.get(FOUR_3000)?.flags, ['EST_NO_PRICE']);
});

/** One model group (Spool, Refill), two colours offered with both, a variant row per model × colour. */
function seedColours(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO products (id, slug, name, inventory_mode) VALUES ('p_col', 'p-col', 'PLA', 'VARIANT_COMBINATION');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_m', 'p_col', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('m1', 'p_col', 'g_m', 'Spool', 0, 1), ('m2', 'p_col', 'g_m', 'Refill', 1, 1);
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active) VALUES
      ('c_red', 'p_col', 'Red', 'أحمر', 'سوور', '#ff0000', 0, 1), ('c_blue', 'p_col', 'Blue', 'أزرق', 'شین', '#0000ff', 1, 1);
    INSERT INTO product_variants (id, product_id, combo_key, active) VALUES
      ('pv_c1', 'p_col', 'o:m1|c:c_red', 1), ('pv_c2', 'p_col', 'o:m1|c:c_blue', 1), ('pv_c3', 'p_col', 'o:m2|c:c_red', 1), ('pv_c4', 'p_col', 'o:m2|c:c_blue', 1);
  `);
}

test('sellableSkus answers exactly as before: a grid equal to its variants, another inventory mode, no active row, rows naming no cell; past the SKU limit, a cut still too large', async () => {
  const raw = freshDb();
  // Every cell has its variant row.
  seedBusCable(raw, { id: 'p_full', variants: GRID });
  // The same three rows, but stocked another way: the cart sells every cell, so every cell is a SKU.
  seedBusCable(raw, { id: 'p_base', mode: 'BASE' });
  seedBusCable(raw, { id: 'p_opt', mode: 'OPTION' });
  // Stocked by combination, but no row is active / no row names a cell: nothing to read them by.
  seedBusCable(raw, { id: 'p_off', active: 0 });
  seedBusCable(raw, { id: 'p_stale', variants: ['o:v_gone'] });
  for (const id of ['p_full', 'p_base', 'p_opt', 'p_off', 'p_stale']) {
    const { grid } = await gridOf(raw, id);
    assert.deepEqual(grid, await unfiltered(raw, id), `${id}: as before`);
    assert.equal(grid.skus.length, 6, `${id}: the whole grid`);
    assert.equal(grid.overflow, false);
  }

  // A colour product with a variant row per model × colour (the live filament shape): as before.
  seedColours(raw);
  const colours = await gridOf(raw, 'p_col');
  assert.deepEqual(colours.grid, await unfiltered(raw, 'p_col'));
  assert.deepEqual(colours.grid.skus.map((s) => s.combo_key), ['o:m1|c:c_red', 'o:m1|c:c_blue', 'o:m2|c:c_red', 'o:m2|c:c_blue']);

  // A model no variant row stocks (Refill sold by pre-order only, as the admin editor leaves it, or its rows
  // switched off), and a colour no row names: every cell of either answers as before, so the model keeps its SKUs.
  raw.exec("UPDATE product_variants SET active = 0 WHERE id IN ('pv_c3', 'pv_c4')");
  assert.deepEqual((await gridOf(raw, 'p_col')).grid, await unfiltered(raw, 'p_col'), 'a model with no row: as before');
  raw.exec("UPDATE product_variants SET active = 1 WHERE product_id = 'p_col'");
  raw.exec("INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active) VALUES ('c_green', 'p_col', 'Green', 'أخضر', 'سەوز', '#00ff00', 2, 1)");
  const green = await gridOf(raw, 'p_col');
  assert.deepEqual(green.grid, await unfiltered(raw, 'p_col'), 'a colour with no row: as before');
  assert.equal(green.grid.skus.length, 6);

  // Past the limit the grid is counted on the cells it keeps (r2-grid, tests/priceEstimateVariantGridLarge.test.ts):
  // two rows hold 4 of the 32 values, so 254 of the 16 × 16 = 256 cells are kept, still too many.
  raw.exec("INSERT INTO products (id, slug, name, inventory_mode) VALUES ('p_big', 'p-big', 'Big', 'VARIANT_COMBINATION')");
  raw.exec("INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_x', 'p_big', 'X', 0, 1), ('g_y', 'p_big', 'Y', 1, 1)");
  for (let i = 0; i < 16; i += 1) {
    raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('x${i}', 'p_big', 'g_x', 'X${i}', ${i}, 1), ('y${i}', 'p_big', 'g_y', 'Y${i}', ${i}, 1)`);
  }
  raw.exec("INSERT INTO product_variants (id, product_id, combo_key, active) VALUES ('pv_b1', 'p_big', 'o:x0|o:y0', 1), ('pv_b2', 'p_big', 'o:x1|o:y1', 1)");
  assert.deepEqual((await gridOf(raw, 'p_big')).grid, { skus: [], overflow: true });
});

// ---------------------------------------------------------------- 2. the matcher and §3.7

test('the Bus Cable matches the EU store high, 3 of 3, and each combination it sells is priced from it; a cell it does not sell is pruned and refused', async () => {
  const raw = freshDb();
  seedBusCable(raw);
  sourceRef(raw, 'p_bus');
  const app = mount(raw);
  const euId = await upload(app, busCableCapture());
  // A suggestion left on a cell the store does not sell (an earlier run read the whole grid): the next run prunes it.
  raw.exec(`INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
            VALUES ('p_bus', ${q(FOUR_510)}, 'bambu_eu', 'bambu-bus-cable', '43372657443035', 'low', 'handle', 'suggested', '', '', ${q(euId)}, ${q(NOW.toISOString())})`);

  const skus = (await loadProductSkus(asD1(raw), ['p_bus'])).get('p_bus')!.skus!;
  assert.deepEqual(skus.map((s) => [s.combo_key, s.labels.en]), [
    [SIX_510, '6pin (AMS to AMS/Hub/Buffer) · 510mm'],
    [SIX_1500, '6pin (AMS to AMS/Hub/Buffer) · 1500mm'],
    [FOUR_260, '4pin (Printer to Hub/Buffer) · 260mm'],
  ]);

  const run = await call(app, 'POST', `${SP}/match`, { product_ids: ['p_bus'] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const summary = run.body.products[0];
  assert.deepEqual([summary.confirmed, summary.suggested, summary.pruned, summary.skipped], [3, 0, 1, null], JSON.stringify(summary));
  assert.deepEqual(
    all<Json>(raw, "SELECT combo_key, source, item_key, sku_key, state, confidence, decided_by FROM supplier_price_matches WHERE product_id = 'p_bus' ORDER BY combo_key"),
    [...REAL].sort().map((combo) => ({ combo_key: combo, source: 'bambu_eu', item_key: 'bambu-bus-cable', sku_key: EU_SKU[combo], state: 'confirmed', confidence: 'high', decided_by: 'auto' })),
    'equal handle, every SKU by its English labels: high, confirmed automatically'
  );

  // §3.7: the EU store's price for each combination it sells, nothing flagged.
  const prices = (await supplierPricesFor(asD1(raw), [{ product_id: 'p_bus', combo_keys: skus.map((s) => s.combo_key), sourcing: 'EU_STORE_EUR', us_reference_allowed: true }])).get('p_bus')!;
  assert.deepEqual(
    [...prices.values()].map((p) => [p.combo_key, p.price_source, p.amount, p.currency, p.flags]),
    [
      [SIX_510, 'bambu_eu', '4.99', 'EUR', []],
      [SIX_1500, 'bambu_eu', '6.99', 'EUR', []],
      [FOUR_260, 'bambu_eu', '4.99', 'EUR', []],
    ]
  );

  // The owner cannot type a price for, nor match, a combination the product does not sell.
  const tokens = (await versionTokens(asD1(raw), ['p_bus'])).get('p_bus')!;
  const typed = await call(app, 'PUT', `${SP}/manual/p_bus`, { version: tokens.manual, skus: [{ combo_key: FOUR_510, amount: '4.99', currency: 'EUR' }] });
  assert.deepEqual([typed.status, typed.body.code, typed.body.details], [400, 'PRICING_INPUT_INVALID', { field: 'combo_key' }]);
  const decided = await call(app, 'PUT', `${SP}/matches/p_bus`, {
    version: tokens.matches,
    skus: [{ combo_key: SIX_260, source: 'bambu_eu', item_key: 'bambu-bus-cable', sku_key: '48836361322844' }],
  });
  assert.deepEqual([decided.status, decided.body.code, decided.body.details], [400, 'PRICING_INPUT_INVALID', { field: 'combo_key' }]);
});

test('the H2D sample: the real «Standard» and «standard» SKUs map again — no cell the store does not sell makes them AMBIGUOUS', async () => {
  const raw = freshDb();
  const id = importedIdentity('h2d');
  raw.exec(`INSERT INTO products (id, slug, name, name_ar, name_ku, inventory_mode) VALUES ('p_h2d', 'h2d', ${q(id.name)}, 'H2D', 'H2D', 'VARIANT_COMBINATION')`);
  id.groups.forEach((g, i) => raw.exec(`INSERT INTO product_option_groups (id, product_id, name_en, kind, sort, active) VALUES (${q(g.id)}, 'p_h2d', ${q(g.name_en ?? '')}, ${q(g.kind)}, ${i}, 1)`));
  const sort = new Map<string, number>();
  for (const v of id.values) {
    const n = sort.get(v.group_id) ?? 0;
    sort.set(v.group_id, n + 1);
    raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES (${q(v.id)}, 'p_h2d', ${q(v.group_id)}, ${q(v.name_en)}, ${q(v.name_en)}, ${q(v.name_en)}, ${n}, 1)`);
  }
  id.skus.forEach((s, i) => {
    raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active) VALUES ('pv_h${i}', 'p_h2d', ${q(s.combo_key)}, 1)`);
    for (const vid of s.variant_ids ?? []) raw.exec(`INSERT INTO product_external_ids (product_id, scope_kind, scope_id, id_type, value) VALUES ('p_h2d', 'variant', 'pv_h${i}', 'bambu_variant_id', ${q(vid)})`);
  });
  raw.exec(`INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
            VALUES ('bambu_us', '7001', 'p_h2d', ${q(id.handle)}, 'https://us.store.bambulab.com/products/h2d', 'created', 'not_configured', 'f', '2026-10-30T00:00:00.000Z', 'cir_test')`);
  const app = mount(raw);
  await upload(app, JSON.parse(fixtureText('eu-2026-10-31.v1.json')));

  // Two groups of 3 and 6 values, six real variants: six SKUs, not the 18 cells of the grid.
  const product = (await loadProductSkus(asD1(raw), ['p_h2d'])).get('p_h2d')!;
  assert.deepEqual(product.skus!.map((s) => s.combo_key).sort(), id.skus.map((s) => s.combo_key).sort());
  assert.equal((await unfiltered(raw, 'p_h2d')).skus.length, 18);

  const run = await call(app, 'POST', `${SP}/match`, { product_ids: ['p_h2d'] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual([run.body.products[0].confirmed, run.body.products[0].suggested], [0, 5], 'five of six mapped (one bundle has no EU variant), the owner’s to review');
  const name = new Map(product.skus!.map((s) => [s.combo_key, s.labels.en] as const));
  const mapped = Object.fromEntries(all<Json>(raw, "SELECT combo_key, sku_key FROM supplier_price_matches WHERE product_id = 'p_h2d'").map((m) => [name.get(m.combo_key), m.sku_key]));
  assert.equal(mapped['H2D AMS Combo · Standard'], '596571526982115329');
  assert.equal(mapped['H2D · standard'], '596571526990503947', 'labels compare case-blind');
  assert.equal(mapped['H2D Laser Full Combo · 40W'], '596571526990503942');
  assert.equal(mapped['H2D AMS Combo · Dual AMS 2 Pro Bundle'], undefined);
});

// ---------------------------------------------------------------- 3. the estimate and its V2 write

test('the Bus Cable is estimated and applied with no EST_NO_PRICE; its V2 state stays complete in the owner’s panel and in an FX-5 evaluation', async () => {
  const w = pricingWorld();
  w.raw.exec(`
    UPDATE price_estimate_types SET min_profit_usd = '3', default_weight_g = 200, default_length_mm = 100, default_width_mm = 100, default_height_mm = 50 WHERE key = 'electronics_part';
    UPDATE price_estimate_control SET apply_enabled = 1;
  `);
  seedBusCable(w.raw);
  sourceRef(w.raw, 'p_bus');
  w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_bus', 'electronics_part', 'owner', ${q(NOW.toISOString())})`);
  const app = mount(w.raw);
  await upload(app, busCableCapture());
  assert.equal((await runMatchPage(w.db, { product_ids: ['p_bus'] }, OWNER.id, NOW)).products[0]!.confirmed, 3);

  const computed = await call(app, 'POST', `${EST}/compute`, { product_ids: ['p_bus'] });
  assert.equal(computed.status, 200, JSON.stringify(computed.body).slice(0, 400));
  const p = computed.body.products[0];
  assert.deepEqual([p.type, p.sourcing, p.route, p.structure], ['electronics_part', 'EU_STORE_EUR', 'land', 'prepare']);
  assert.deepEqual(p.flags.map((f: Json) => f.code), ['EST_DEFAULT_BOX', 'EST_DEFAULT_WEIGHT'], 'the type defaults only: no SKU without a price');
  assert.deepEqual([p.blocking, p.blocked_by], [false, []]);
  assert.match(p.preview_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    p.lines.map((l: Json) => [l.combo_key, l.channel, l.source, l.supplier_amount, l.supplier_currency]),
    [
      [SIX_510, 'pre_order_land', 'bambu_eu', '4.99', 'EUR'],
      [SIX_1500, 'pre_order_land', 'bambu_eu', '6.99', 'EUR'],
      [FOUR_260, 'pre_order_land', 'bambu_eu', '4.99', 'EUR'],
    ]
  );
  const est = Object.fromEntries(p.lines.map((l: Json) => [l.combo_key, l.est_price_iqd as number]));
  assert.ok(est[SIX_510]! > 0 && est[SIX_510] === est[FOUR_260] && est[SIX_1500]! > est[SIX_510]!, JSON.stringify(est));

  const applied = await call(app, 'POST', `${EST}/apply`, { items: [{ product_id: 'p_bus', preview_hash: p.preview_hash }] });
  assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 400));
  assert.equal(applied.body.results[0].outcome, 'applied', JSON.stringify(applied.body.results[0]).slice(0, 400));
  for (const table of ['pricing_v2_sku_results', 'product_sku_prices']) {
    assert.deepEqual(
      all<Json>(w.raw, `SELECT combo_key, channel FROM ${table} WHERE product_id = 'p_bus' ORDER BY combo_key`).map((r) => [r.combo_key, r.channel]),
      [...REAL].sort().map((c) => [c, 'pre_order_land']),
      `${table}: the three combinations it sells`
    );
  }
  assert.equal(row<Json>(w.raw, "SELECT price_estimate FROM products WHERE id = 'p_bus'")!.price_estimate, 1);

  // Every other V2 path reads the same SKUs: the owner's panel is current, an FX-5 evaluation has nothing to write.
  const panel = await call(app, 'GET', '/api/admin/products-v2/p_bus/pricing');
  assert.equal(panel.status, 200, JSON.stringify(panel.body).slice(0, 300));
  assert.deepEqual([panel.body.status, panel.body.publishable, panel.body.needs_pricing], [{ kind: 'current' }, true, false]);
  assert.deepEqual([...new Set((panel.body.table as Json[]).map((r) => r.combo_key))].sort(), [...REAL].sort());
  const c = await v2Context(w.db, 'p_bus');
  const desired = storedDesired(c.v2);
  const fx5 = await evaluateV2Write({ ...c, method: 'cost', points: desired.points, discounts: desired.discounts, inputWrites: [], ruleWrites: [], auto: true });
  assert.deepEqual([fx5.complete, fx5.codes, fx5.needs_write, fx5.changes.length], [true, [], false, 0]);
});
