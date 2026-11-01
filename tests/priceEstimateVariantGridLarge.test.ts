/**
 * A GRID PAST ENGINE_MAX_SKUS IS COUNTED ON THE COMBINATIONS IT STOCKS (review
 * finding r2-grid; worker/lib/pricingEngine/legacy.ts `stockedPastLimit`).
 *
 * Round 1 (tests/priceEstimateVariantGrid.test.ts) cut a VARIANT_COMBINATION
 * grid to the combinations it stocks, but still counted the whole cross
 * product against the 240-SKU limit. A kit of 2 modules × 6 lights × 22
 * lengths (264 cells, 22 real variants: the shape the manifest's
 * wireless-inductive-coil-kit can have) was therefore SKU_GRID_TOO_LARGE, and
 * the matcher and the estimator skipped it. Now:
 *
 *   - such a product answers its rows' combinations, plus every cell of a
 *     choice no row stocks, in grid order, exactly round 1's rule over the
 *     whole grid, and overflows only when that set passes the limit;
 *   - it is matched, priced, estimated and applied on its 22 variants;
 *   - every other inventory mode, no active row, rows naming no cell, a cut
 *     still too large and a grid past SKU_GRID_SCAN_MAX cells overflow as
 *     before.
 *
 * Run: node --import tsx --test tests/priceEstimateVariantGridLarge.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, freshDb, get, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { v2Context } from './fixtures/pricingV2';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminSupplierPricesRoutes } from '../worker/routes/adminSupplierPrices';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { SKU_GRID_SCAN_MAX, sellableSkus, type SellableSku } from '../worker/lib/pricingEngine/legacy';
import { checkSelection } from '../worker/lib/commercialState';
import { evaluateV2Write, storedDesired } from '../worker/lib/pricingEngine/v2/evaluate';
import { loadProductSkus } from '../worker/lib/supplierPrices/store';
import { runMatchPage } from '../worker/lib/supplierPrices/matcher';
import { ENGINE_MAX_SKUS } from '@levonis/pricing/costToPrice';
import { skuComboKey } from '@levonis/pricing/skuChannel';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const SP = '/api/admin/pricing/supplier-prices';
const EST = '/api/admin/pricing/estimates';
const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// ---------------------------------------------------------------- the kit: 2 modules × 6 lights × 22 lengths

const MODULES = ['CD54', 'CD43'];
/** Light colours, with the names the import's colour registry gives them. */
const LIGHTS: Array<[string, string, string]> = [
  ['Red', 'أحمر', 'سوور'],
  ['Green', 'أخضر', 'سەوز'],
  ['Blue', 'أزرق', 'شین'],
  ['White', 'أبيض', 'سپی'],
  ['Pink', 'وردي', 'پەمەیی'],
  ['Yellow', 'أصفر', 'زەرد'],
];
const LENGTHS = Array.from({ length: 22 }, (_, i) => `${(i + 1) * 10}cm`);
const mod = (i: number) => `m${i}`;
const light = (i: number) => `l${i}`;
const len = (i: number) => `n${String(i).padStart(2, '0')}`;
/** The 22 variants the store sells: variant k is module k < 11 ? CD54 : CD43, light k mod 6, length k. Every value is in one. */
const REAL: Array<[number, number, number]> = Array.from({ length: 22 }, (_, k) => [k < 11 ? 0 : 1, k % 6, k]);
const keyOf = ([m, l, n]: [number, number, number]) => skuComboKey({ option_value_ids: [mod(m), light(l), len(n)], color_id: null });
/** Grid order: module, then light, then length (the cart's relation order). */
const inGridOrder = (cells: Array<[number, number, number]>) => [...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

/** The kit as the import writes it: three groups, one variant row per real SKU, direct sale, no stock, no price. */
function seedKit(raw: DatabaseSync, o: { id?: string; mode?: string; variants?: Array<[number, number, number]>; active?: number } = {}): string {
  const id = o.id ?? 'p_kit';
  const v = (s: string) => (id === 'p_kit' ? s : `${s}_${id}`);
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
      VALUES (${q(id)}, ${q(`slug-${id}`)}, 'Lighting Kit', 'طقم إضاءة', 'کیتی ڕووناکی', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', ${q(o.mode ?? 'VARIANT_COMBINATION')});
    INSERT INTO product_option_groups (id, product_id, name_en, kind, sort, active) VALUES
      (${q(v('g_mod'))}, ${q(id)}, 'Module', 'other', 0, 1), (${q(v('g_light'))}, ${q(id)}, 'Light', 'other', 1, 1), (${q(v('g_len'))}, ${q(id)}, 'Length', 'size', 2, 1);
  `);
  MODULES.forEach((name, i) => raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES (${q(v(mod(i)))}, ${q(id)}, ${q(v('g_mod'))}, ${q(name)}, ${i}, 1)`));
  LIGHTS.forEach(([en, ar, ckb], i) =>
    raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES (${q(v(light(i)))}, ${q(id)}, ${q(v('g_light'))}, ${q(en)}, ${q(ar)}, ${q(ckb)}, ${i}, 1)`)
  );
  LENGTHS.forEach((name, i) => raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES (${q(v(len(i)))}, ${q(id)}, ${q(v('g_len'))}, ${q(name)}, ${i}, 1)`));
  (o.variants ?? REAL).forEach((cell, i) => {
    const key = skuComboKey({ option_value_ids: [v(mod(cell[0])), v(light(cell[1])), v(len(cell[2]))], color_id: null });
    raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active) VALUES (${q(`pv_${id}_${i}`)}, ${q(id)}, ${q(key)}, ${o.active ?? 1})`);
  });
  return id;
}

const gridOf = async (raw: DatabaseSync, id: string) => {
  const loaded = (await loadProducts(asD1(raw), [id])).get(id)!;
  return { loaded, grid: sellableSkus(loaded.doc, loaded.view) };
};
/** The same document read in another inventory mode: the cart sells every cell, so the whole grid counts. */
const asMode = async (raw: DatabaseSync, id: string, mode: 'BASE' | 'OPTION' | 'COLOR') => {
  const loaded = (await loadProducts(asD1(raw), [id])).get(id)!;
  return sellableSkus(loaded.doc, { ...loaded.view!, inventory_mode: mode });
};
/** Every choice some SKU holds (each option value and colour, as combo-key parts), sorted. */
const held = (skus: readonly SellableSku[]): string[] =>
  [...new Set(skus.flatMap((s) => [...s.option_value_ids.map((x) => `o:${x}`), ...(s.color ? [`c:${s.color.id}`] : [])]))].sort();
const OVERFLOW = { skus: [], overflow: true };

// ---------------------------------------------------------------- 1. the sellable SKUs

test('sellableSkus: a VARIANT_COMBINATION grid of 264 cells with 22 real variants answers the 22, in grid order, not SKU_GRID_TOO_LARGE', async () => {
  const raw = freshDb();
  seedKit(raw);
  assert.ok(MODULES.length * LIGHTS.length * LENGTHS.length > ENGINE_MAX_SKUS, 'the grid itself is past the limit');
  const { loaded, grid } = await gridOf(raw, 'p_kit');
  assert.equal(grid.overflow, false);
  assert.deepEqual(
    grid.skus.map((s) => [s.combo_key, s.option_value_ids, s.model?.id ?? null, s.color]),
    inGridOrder(REAL).map((c) => [keyOf(c), [mod(c[0]), light(c[1]), len(c[2])], mod(c[0]), null]),
    'the 22 variants, module first, in grid order'
  );
  const every = [...MODULES.map((_, i) => mod(i)), ...LIGHTS.map((_, i) => light(i)), ...LENGTHS.map((_, i) => len(i))].map((x) => `o:${x}`).sort();
  assert.deepEqual(held(grid.skus), every, 'every module, light and length the page lists is still offered');
  // The supplier-price reader agrees: the matcher and the estimator see the 22 SKUs, not «too many».
  assert.equal((await loadProductSkus(asD1(raw), ['p_kit'])).get('p_kit')!.skus!.length, 22);

  // The server-side selection check agrees with the cart: a combination with no row is not a SKU.
  const { doc, view } = loaded;
  const real = REAL[1]!;
  assert.deepEqual(checkSelection(doc, view, [mod(real[0]), light(real[1]), len(real[2])], null), { ok: true, key: keyOf(real), optionValueIds: [mod(real[0]), light(real[1]), len(real[2])], colorId: null });
  assert.deepEqual(checkSelection(doc, view, [mod(0), light(0), len(1)], null), { ok: false, code: 'PRICE_REQUEST_SELECTION_INVALID' });
  assert.deepEqual(checkSelection(doc, view, [mod(0), light(0)], null), { ok: false, code: 'PRICE_REQUEST_SELECTION_REQUIRED' });

  // The same rows with every value held, one more length (230 cm) no row stocks: its 12 cells are kept, as round 1 keeps them.
  raw.exec("INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('n22', 'p_kit', 'g_len', '230cm', 22, 1)");
  const longer = (await gridOf(raw, 'p_kit')).grid;
  const kept: Array<[number, number, number]> = MODULES.flatMap((_, m) => LIGHTS.map((__, l): [number, number, number] => [m, l, 22]));
  assert.deepEqual(longer.skus.map((s) => s.combo_key), inGridOrder([...REAL, ...kept]).map(keyOf), '22 variants and 230 cm with every module and light');
  // A module no row stocks (CD32, sold by pre-order only): its 6 × 23 cells are kept too, so it keeps its SKUs and its level.
  raw.exec("INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('m2', 'p_kit', 'g_mod', 'CD32', 2, 1)");
  const third = (await gridOf(raw, 'p_kit')).grid;
  assert.equal(third.overflow, false);
  assert.equal(third.skus.length, 22 + 12 + LIGHTS.length * 23);
  assert.equal(third.skus.filter((s) => s.model?.id === 'm2').length, LIGHTS.length * 23);
});

test('past the limit, everything else overflows as before: another inventory mode, no active row, rows naming no cell, a cut still too large', async () => {
  const raw = freshDb();
  // The same kit stocked another way: the cart sells every cell, so all 264 count.
  for (const mode of ['BASE', 'OPTION', 'COLOR'] as const) {
    seedKit(raw, { id: `p_${mode}`, mode });
    assert.deepEqual((await gridOf(raw, `p_${mode}`)).grid, OVERFLOW, mode);
  }
  seedKit(raw);
  for (const mode of ['BASE', 'OPTION', 'COLOR'] as const) assert.deepEqual(await asMode(raw, 'p_kit', mode), OVERFLOW, `p_kit read as ${mode}`);
  // Stocked by combination, but no row is active / no row names a cell: nothing to read them by.
  seedKit(raw, { id: 'p_off', active: 0 });
  assert.deepEqual((await gridOf(raw, 'p_off')).grid, OVERFLOW);
  seedKit(raw, { id: 'p_stale', variants: [] });
  raw.exec("INSERT INTO product_variants (id, product_id, combo_key, active) VALUES ('pv_stale', 'p_stale', 'o:gone|o:m0_p_stale', 1)");
  assert.deepEqual((await gridOf(raw, 'p_stale')).grid, OVERFLOW);
  // One row left: almost every cell holds a choice no row stocks, so the cells kept pass the limit.
  raw.exec(`UPDATE product_variants SET active = 0 WHERE product_id = 'p_kit' AND combo_key <> ${q(keyOf(REAL[0]!))}`);
  assert.deepEqual((await gridOf(raw, 'p_kit')).grid, OVERFLOW);
  raw.exec("UPDATE product_variants SET active = 1 WHERE product_id = 'p_kit'");
  assert.equal((await gridOf(raw, 'p_kit')).grid.skus.length, 22);
});

/** n × n × m values, a row for each k on the diagonal (every value in one row). */
function seedCube(raw: DatabaseSync, id: string, n: number, m: number): void {
  raw.exec(`INSERT INTO products (id, slug, name, inventory_mode) VALUES (${q(id)}, ${q(id)}, 'Cube', 'VARIANT_COMBINATION')`);
  const sizes = [n, n, m];
  sizes.forEach((size, g) => {
    raw.exec(`INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES (${q(`${id}_g${g}`)}, ${q(id)}, ${q(`G${g}`)}, ${g}, 1)`);
    for (let i = 0; i < size; i += 1) raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES (${q(`${id}_${g}_${i}`)}, ${q(id)}, ${q(`${id}_g${g}`)}, ${q(`V${i}`)}, ${i}, 1)`);
  });
  for (let k = 0; k < m; k += 1) {
    const key = skuComboKey({ option_value_ids: sizes.map((size, g) => `${id}_${g}_${k % size}`), color_id: null });
    raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active) VALUES (${q(`pv_${id}_${k}`)}, ${q(id)}, ${q(key)}, 1)`);
  }
}

test('the scan is bounded: a grid of SKU_GRID_SCAN_MAX cells is read from its rows, one more and it is SKU_GRID_TOO_LARGE as before', async () => {
  const raw = freshDb();
  assert.equal(SKU_GRID_SCAN_MAX, 16 * 16 * 16);
  seedCube(raw, 'p_at', 16, 16);
  const at = (await gridOf(raw, 'p_at')).grid;
  assert.equal(at.overflow, false);
  assert.deepEqual(at.skus.map((s) => s.option_value_ids), Array.from({ length: 16 }, (_, k) => [`p_at_0_${k}`, `p_at_1_${k}`, `p_at_2_${k}`]));
  seedCube(raw, 'p_over', 16, 17);
  assert.deepEqual((await gridOf(raw, 'p_over')).grid, OVERFLOW, '16 × 16 × 17 cells: past the scan, whatever the rows');
});

test('colours past the limit: Spool / Refill × 130 colours answers the 130 combinations it stocks; a row for every cell is still too many', async () => {
  const raw = freshDb();
  const seed = (id: string, rows: Array<[number, number]>) => {
    raw.exec(`
      INSERT INTO products (id, slug, name, inventory_mode) VALUES (${q(id)}, ${q(id)}, 'PLA', 'VARIANT_COMBINATION');
      INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES (${q(`${id}_g`)}, ${q(id)}, 'Model', 0, 1);
      INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES
        (${q(`${id}_m0`)}, ${q(id)}, ${q(`${id}_g`)}, 'Spool', 'بكرة', 'بەکرە', 0, 1), (${q(`${id}_m1`)}, ${q(id)}, ${q(`${id}_g`)}, 'Refill', 'تعبئة', 'پڕکردنەوە', 1, 1);
    `);
    for (let c = 0; c < 130; c += 1) raw.exec(`INSERT INTO product_colors (id, product_id, name_en, hex, sort, active) VALUES (${q(`${id}_c${c}`)}, ${q(id)}, ${q(`C${c}`)}, '#336699', ${c}, 1)`);
    rows.forEach(([m, c], i) => raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active) VALUES (${q(`pv_${id}_${i}`)}, ${q(id)}, ${q(`o:${id}_m${m}|c:${id}_c${c}`)}, 1)`));
  };
  // Each colour sold with one model (even colours on the spool, odd ones as a refill): both models and every colour held.
  const half = Array.from({ length: 130 }, (_, c): [number, number] => [c % 2, c]);
  seed('p_half', half);
  const grid = (await gridOf(raw, 'p_half')).grid;
  assert.equal(grid.overflow, false);
  const want = [...half].sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([m, c]) => `o:p_half_m${m}|c:p_half_c${c}`);
  assert.deepEqual(grid.skus.map((s) => s.combo_key), want, 'the 130 combinations, model first, colours in order');
  assert.deepEqual(await asMode(raw, 'p_half', 'BASE'), OVERFLOW, 'read as another mode: all 260 count, as before');
  // A new colour in no row, offered with the refill only: its one cell is kept, last (the refill's last colour). A colour
  // offered with no model (linked to a switched-off one) has no cell to keep.
  raw.exec(`
    INSERT INTO product_colors (id, product_id, name_en, hex, sort, active) VALUES ('p_half_c130', 'p_half', 'C130', '#336699', 130, 1), ('p_half_c131', 'p_half', 'C131', '#336699', 131, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('p_half_m9', 'p_half', 'p_half_g', 'Old', 9, 0);
    INSERT INTO product_color_option_links (color_id, option_value_id, group_id) VALUES ('p_half_c130', 'p_half_m1', 'p_half_g'), ('p_half_c131', 'p_half_m9', 'p_half_g');
  `);
  assert.deepEqual((await gridOf(raw, 'p_half')).grid.skus.map((s) => s.combo_key), [...want, 'o:p_half_m1|c:p_half_c130']);
  // A row for every model × colour: the 260 combinations it stocks are more than the engine prices.
  seed('p_full', Array.from({ length: 260 }, (_, i): [number, number] => [i % 2, Math.floor(i / 2)]));
  assert.deepEqual((await gridOf(raw, 'p_full')).grid, OVERFLOW);
});

test('at and past the limit, the answer is round 1’s rule over the whole grid: its rows, and every cell of a choice no row holds', async () => {
  const raw = freshDb();
  /** Round 1's rule (stockedCells) over the whole cross product, written out: no colours, so every combination is a cell. */
  const reference = (sizes: number[], rows: number[][]): string[] | null => {
    let grid: number[][] = [[]];
    for (const n of sizes) grid = grid.flatMap((sel) => Array.from({ length: n }, (_, i) => [...sel, i]));
    const keys = new Set(rows.map((r) => r.join(',')));
    const choices = (sel: number[]) => sel.map((v, g) => `${g}:${v}`);
    const stocked = grid.filter((sel) => keys.has(sel.join(',')));
    const holds = new Set(stocked.flatMap(choices));
    const cut = grid.filter((sel) => keys.has(sel.join(',')) || choices(sel).some((c) => !holds.has(c)));
    return cut.length > ENGINE_MAX_SKUS ? null : cut.map((sel) => sel.join(','));
  };
  const shapes: Array<[string, number[], number[][]]> = [];
  for (const sizes of [[2, 6, 20], [2, 6, 21], [2, 6, 22], [15, 16], [16, 16], [4, 13, 13]]) {
    const width = Math.max(...sizes);
    const walk = Array.from({ length: width }, (_, k) => sizes.map((n, g) => (k * (g + 1) + g) % n));
    shapes.push([`w${sizes.join('x')}`, sizes, walk]);
    shapes.push([`g${sizes.join('x')}`, sizes, walk.filter((r) => r[r.length - 1] !== sizes[sizes.length - 1]! - 1)]);
    shapes.push([`h${sizes.join('x')}`, sizes, walk.slice(0, Math.ceil(width / 2))]);
  }
  for (const [id, sizes, rows] of shapes) {
    raw.exec(`INSERT INTO products (id, slug, name, inventory_mode) VALUES (${q(id)}, ${q(id)}, 'Grid', 'VARIANT_COMBINATION')`);
    sizes.forEach((n, g) => {
      raw.exec(`INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES (${q(`${id}_g${g}`)}, ${q(id)}, ${q(`G${g}`)}, ${g}, 1)`);
      for (let i = 0; i < n; i += 1) raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES (${q(`${id}_${g}_${i}`)}, ${q(id)}, ${q(`${id}_g${g}`)}, ${q(`V${i}`)}, ${i}, 1)`);
    });
    rows.forEach((r, k) => {
      const key = skuComboKey({ option_value_ids: r.map((v, g) => `${id}_${g}_${v}`), color_id: null });
      raw.exec(`INSERT OR IGNORE INTO product_variants (id, product_id, combo_key, active) VALUES (${q(`pv_${id}_${k}`)}, ${q(id)}, ${q(key)}, 1)`);
    });
  }
  const loaded = await loadProducts(asD1(raw), shapes.map(([id]) => id));
  const answers: string[] = [];
  for (const [id, sizes, rows] of shapes) {
    const { doc, view } = loaded.get(id)!;
    const got = sellableSkus(doc, view);
    const want = reference(sizes, rows);
    const index = (s: SellableSku) => s.option_value_ids.map((x) => x.slice(x.lastIndexOf('_') + 1)).join(',');
    assert.deepEqual(got.overflow ? null : got.skus.map(index), want, id);
    answers.push(`${id}:${want === null ? 'overflow' : want.length}`);
  }
  // Both sides of the limit: 2×6×20 and 15×16 are 240 cells (round 1's path), the rest past it; kept cells that fit and some that do not.
  assert.deepEqual(answers, [
    'w2x6x20:140', 'g2x6x20:145', 'h2x6x20:190', 'w2x6x21:231', 'g2x6x21:234', 'h2x6x21:221',
    'w2x6x22:154', 'g2x6x22:159', 'h2x6x22:209', 'w15x16:136', 'g15x16:156', 'h15x16:184',
    'w16x16:144', 'g16x16:172', 'h16x16:200', 'w4x13x13:13', 'g4x13x13:112', 'h4x13x13:overflow',
  ]);
});

// ---------------------------------------------------------------- 2. matched, estimated and applied on its real variants

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
async function call(app: App, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = method === 'GET' ? await get(app, path) : await post(app, path, body ?? {});
  return { status: res.status, body: (await json(res)) as Json };
}

/** The store's page of the kit as a v1 file dated today: its 22 variants by their English option labels. */
const kitCapture = () => ({
  source: 'bambu_eu',
  currency: 'EUR',
  price_basis: 'list',
  capture: 'browser_sweep',
  captured_on: TODAY,
  captured_by: 'browser sweep (?skr=yes)',
  items: [
    {
      item_key: 'lighting-kit',
      url: 'https://eu.store.bambulab.com/products/lighting-kit?skr=yes',
      page_host: 'eu.store.bambulab.com',
      title: 'Lighting Kit',
      name_en: 'Lighting Kit',
      category: 'spare_part',
      sourcing: 'EU_STORE_EUR',
      freight_route: 'GERMANY_LAND',
      skus: REAL.map(([m, l, n], k) => {
        const options = { option1: MODULES[m]!, option2: LIGHTS[l]![0], option3: LENGTHS[n]! };
        return { sku_key: `4880000000${String(k).padStart(4, '0')}`, options, options_en: options, price: (4.99 + k).toFixed(2), price_label: '', quantity: null, sku_code: '' };
      }),
    },
  ],
});

async function upload(app: App, file: Json): Promise<void> {
  const text = JSON.stringify(file);
  const sha = createHash('sha256').update(text).digest('hex');
  const { source, currency, price_basis, capture, captured_on, captured_by } = file;
  const created = await call(app, 'POST', `${SP}/snapshots`, { source, currency, price_basis, capture, captured_on, captured_by, file_sha256: sha, item_count: file.items.length });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.snapshot.id as string;
  assert.equal((await call(app, 'POST', `${SP}/snapshots/${id}/items`, { items: file.items, offset: 0 })).status, 200);
  const skus = (file.items as Json[]).reduce((n, it) => n + it.skus.length, 0);
  const done = await call(app, 'POST', `${SP}/snapshots/${id}/complete`, { item_count: file.items.length, sku_count: skus, file_sha256: sha });
  assert.equal(done.status, 200, JSON.stringify(done.body));
}

test('the kit is matched high, 22 of 22, estimated with no SKU_GRID_TOO_LARGE and applied on its 22 variants; its V2 state stays complete', async () => {
  const w = pricingWorld();
  w.raw.exec(`
    UPDATE price_estimate_types SET min_profit_usd = '3', default_weight_g = 200, default_length_mm = 100, default_width_mm = 100, default_height_mm = 50 WHERE key = 'electronics_part';
    UPDATE price_estimate_control SET apply_enabled = 1;
  `);
  seedKit(w.raw);
  w.raw.exec(`INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
              VALUES ('bambu_us', '7360000000000', 'p_kit', 'lighting-kit', 'https://us.store.bambulab.com/products/lighting-kit', 'created', 'not_configured', 'f', '2026-10-30T00:00:00.000Z', 'cir_000000000000000000000001')`);
  w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_kit', 'electronics_part', 'owner', ${q(NOW.toISOString())})`);
  const app = mount(w.raw);
  await upload(app, kitCapture());

  const run = (await runMatchPage(w.db, { product_ids: ['p_kit'] }, OWNER.id, NOW)).products[0]!;
  assert.deepEqual([run.skipped, run.confirmed, run.suggested], [null, 22, 0], JSON.stringify(run));
  assert.deepEqual(
    [...new Set(all<Json>(w.raw, "SELECT state, confidence, decided_by FROM supplier_price_matches WHERE product_id = 'p_kit'").map((m) => `${m.state}/${m.confidence}/${m.decided_by}`))],
    ['confirmed/high/auto']
  );

  const computed = await call(app, 'POST', `${EST}/compute`, { product_ids: ['p_kit'] });
  assert.equal(computed.status, 200, JSON.stringify(computed.body).slice(0, 400));
  const p = computed.body.products[0];
  assert.deepEqual(p.flags.map((f: Json) => f.code), ['EST_DEFAULT_BOX', 'EST_DEFAULT_WEIGHT'], 'the type defaults only: no SKU_GRID_TOO_LARGE, no SKU without a price');
  assert.deepEqual([p.blocking, p.blocked_by], [false, []]);
  assert.deepEqual(
    p.lines.map((l: Json) => [l.combo_key, l.channel, l.source]),
    inGridOrder(REAL).map((c) => [keyOf(c), 'pre_order_land', 'bambu_eu'])
  );

  const applied = await call(app, 'POST', `${EST}/apply`, { items: [{ product_id: 'p_kit', preview_hash: p.preview_hash }] });
  assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 400));
  assert.equal(applied.body.results[0].outcome, 'applied', JSON.stringify(applied.body.results[0]).slice(0, 400));
  const real = REAL.map(keyOf).sort();
  for (const table of ['pricing_v2_sku_results', 'product_sku_prices']) {
    assert.deepEqual(
      all<Json>(w.raw, `SELECT combo_key, channel FROM ${table} WHERE product_id = 'p_kit' ORDER BY combo_key`).map((r) => [r.combo_key, r.channel]),
      real.map((c) => [c, 'pre_order_land']),
      `${table}: the 22 combinations it sells`
    );
  }
  assert.equal(row<Json>(w.raw, "SELECT price_estimate FROM products WHERE id = 'p_kit'")!.price_estimate, 1);

  // The owner's panel is current and an FX-5 evaluation has nothing to write: every V2 path reads the same 22 SKUs.
  const panel = await call(app, 'GET', '/api/admin/products-v2/p_kit/pricing');
  assert.equal(panel.status, 200, JSON.stringify(panel.body).slice(0, 300));
  assert.deepEqual([panel.body.status, panel.body.publishable, panel.body.needs_pricing], [{ kind: 'current' }, true, false]);
  assert.deepEqual([...new Set((panel.body.table as Json[]).map((r) => r.combo_key))].sort(), real);
  const c = await v2Context(w.db, 'p_kit');
  const desired = storedDesired(c.v2);
  const fx5 = await evaluateV2Write({ ...c, method: 'cost', points: desired.points, discounts: desired.discounts, inputWrites: [], ruleWrites: [], auto: true });
  assert.deepEqual([fx5.complete, fx5.codes, fx5.needs_write, fx5.changes.length], [true, [], false, 0]);
});
