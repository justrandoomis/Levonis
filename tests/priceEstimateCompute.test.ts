/**
 * «احسب» — THE ESTIMATE PREVIEW (docs/SMART_PRICING.md §4.3–§4.8; WP6).
 *
 * On the pricing world (U = 1,600 IQD; CNY/USD 0.14; EUR/USD 1.1; China sea
 * 400,000 IQD/m³; Germany land 3,200 IQD/kg) with products the Bambu import
 * created — direct sale only, no stock, no price — and the owner's type figures:
 *
 *   - each SKU's line: the supplier price as captured, R (the engine's own) and
 *     the estimated price — PLA at 69 CNY with the filament defaults (1,300 g,
 *     200 × 200 × 100 mm) and $2: R = 15,456 + 1,600 = 17,056, D = 20,500; a
 *     spare part at 40 CNY with its real 500 g / 100 × 100 × 50 mm and $3:
 *     R = 9,160, D = 14,000; a printer typed at EUR 1,599 by land, 20 kg, $50 and
 *     25,000 IQD extra: R = 2,903,240, D = 2,983,250;
 *   - the flags (codes only): the type defaults (hard), a typed price (soft);
 *     the hash a later apply must carry, stored with the lines;
 *   - compute WRITES NO V2 TABLE — no input, rule, price row, result, state,
 *     history or pricing audit; the product row is untouched;
 *   - the blocking flags: no type, an incomplete type, no price, a suggestion
 *     to review, a route below cost, an import running — no hash;
 *   - eligibility (§4.7): a stocked product, one with an order-type cell, a
 *     merged direct-sale product are never restructured (EST_STRUCTURE_OWNER);
 *     a firm V2 product is never turned into an estimate (EST_FIRM_PRICE); an
 *     owner-built product already pre-order-only on its route is ready as it is;
 *   - the type (§3.8): the confirmed Tmall match's category, the import's type
 *     (a spare part named as an electronic part is EU-sourced), the owner's
 *     choice first; the owner's type table, its suggestion and the two switches;
 *   - the paging enrols only import-created products (a merged one only once
 *     the owner chose its type); the door is the owner's alone; 503 without 0218.
 *
 * Run: node --import tsx --test tests/priceEstimateCompute.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, dbThrough, get, json, post, put, row, stubApp, withoutTriggers, type StubUser } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { writeV2 } from './fixtures/pricingV2';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { listEstimates, previewStatements, refreshStateOf, shownFlags, type PreparedEstimate } from '../worker/lib/pricingEngine/estimate/compute';
import { parseFlags, type EstimateLine, type PlanFlag } from '../worker/lib/pricingEngine/estimate/types';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** The router as WP15 mounts it: inside adminPricingRoutes' door. */
const appAs = (raw: DatabaseSync, user: StubUser | null = OWNER) =>
  stubApp(
    asD1(raw),
    user,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(BASE, adminPriceEstimatesRoutes);
    },
    { publishV2: false }
  );

interface Seed {
  name?: string;
  colours?: string[];
  weight?: number | null;
  box?: [number, number, number] | null;
  stock?: number | null;
  match?: 'created' | 'merged' | null;
  decision?: string;
  saleTypes?: string[];
  routes?: Array<{ method: string; commission_iqd: number; active: boolean }>;
}

/** A product as the Bambu import leaves one it created: direct sale only, no stock, no price, no route. */
function seedProduct(raw: DatabaseSync, id: string, o: Seed = {}): void {
  const box = o.box ?? null;
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
    VALUES (${q(id)}, ${q(`slug-${id}`)}, ${q(o.name ?? `Product ${id}`)}, 'منتج', 'بەرهەم', 'active', 0, ${q(o.stock ?? null)},
            ${q((o.saleTypes ?? ['direct_sale'])[0])}, ${q(JSON.stringify(o.saleTypes ?? ['direct_sale']))}, ${q(JSON.stringify(o.routes ?? []))},
            ${q(o.colours?.length ? 'COLOR' : 'BASE')}, ${q(o.weight ?? null)}, ${q(box?.[0])}, ${q(box?.[1])}, ${q(box?.[2])});
  `);
  (o.colours ?? []).forEach((c, k) => {
    raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock)
              VALUES (${q(`${id}_${c}`)}, ${q(id)}, ${q(c)}, 'لون', 'ڕەنگ', '#336699', ${k}, 1, NULL)`);
  });
  if (o.match !== null) {
    const match = o.match ?? 'created';
    raw.exec(`INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
              VALUES ('bambu_us', ${q(`sp_${id}`)}, ${q(id)}, ${q(`h-${id}`)}, ${q(`https://us.store.bambulab.com/products/h-${id}`)}, ${q(match)},
                      ${q(o.decision ?? (match === 'created' ? 'not_configured' : 'not_required'))}, 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001')`);
  }
}

/** A Tmall offer confirmed for one SKU of a product (the current complete snapshot `sps_tmall`). */
function tmall(raw: DatabaseSync, pid: string, combo: string, price: string, o: { item?: string; sku?: string; category?: string; state?: 'confirmed' | 'suggested' } = {}): void {
  const item = o.item ?? `1${pid.replace(/\D/g, '').padEnd(6, '0')}${combo.length}`;
  const sku = o.sku ?? `${item}${Math.floor(Math.random() * 1e6)}`;
  raw.exec(`
    INSERT OR IGNORE INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', ${q(item)}, 'item', ${q(o.category ?? '')});
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', ${q(item)}, ${q(sku)}, ${q(price)});
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES (${q(pid)}, ${q(combo)}, 'tmall_cn', ${q(item)}, ${q(sku)}, ${q(o.state === 'suggested' ? 'medium' : 'exact')}, 'owner', ${q(o.state ?? 'confirmed')},
              ${q(o.state === 'suggested' ? '' : 'usr_owner')}, ${q(o.state === 'suggested' ? '' : NOW)}, 'sps_tmall', ${q(NOW)});
  `);
}

/** The owner's typed price of one SKU. */
const typed = (raw: DatabaseSync, pid: string, combo: string, amount: string, currency: string) =>
  raw.exec(`INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at)
            VALUES (${q(pid)}, ${q(combo)}, ${q(amount)}, ${q(currency)}, 'typed', 'usr_owner', ${q(NOW)})`);

/** The pricing world, the owner's type figures, a current Tmall snapshot, and «apply» on. */
function world() {
  const w = pricingWorld();
  w.raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 1300, default_length_mm = 200, default_width_mm = 200, default_height_mm = 100, min_profit_usd = '2' WHERE key = 'filament';
    UPDATE price_estimate_types SET min_profit_usd = '3' WHERE key = 'spare_part';
    UPDATE price_estimate_types SET min_profit_usd = '50', additional_cost_iqd = 25000 WHERE key = 'printer';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', ${q(TODAY)}, ${q('a'.repeat(64))}, 'complete', 'usr_owner', ${q(NOW)}, ${q(NOW)});
  `);
  return { ...w, app: appAs(w.raw) };
}

/** The three estimable products: PLA (two colours, no measures), a spare part (real package), a printer (typed EUR). */
function seedThree(raw: DatabaseSync): void {
  seedProduct(raw, 'p_fil', { name: 'PLA Basic', colours: ['red', 'black'] });
  tmall(raw, 'p_fil', 'c:p_fil_red', '69', { item: '1053109777521', sku: '6264995743059', category: 'filament' });
  tmall(raw, 'p_fil', 'c:p_fil_black', '69', { item: '1053109777521', sku: '6264995743060', category: 'filament' });
  seedProduct(raw, 'p_part', { name: 'Nozzle wiper', weight: 500, box: [100, 100, 50] });
  tmall(raw, 'p_part', '', '40', { item: '2000000000001', sku: '2000000000002', category: 'spare_part' });
  seedProduct(raw, 'p_prn', { name: 'H2D', weight: 20_000, box: [600, 500, 500] });
  typed(raw, 'p_prn', '', '1599', 'EUR');
}

async function call(app: ReturnType<typeof appAs>, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
  const res = method === 'GET' ? await get(app, path) : method === 'POST' ? await post(app, path, body ?? {}) : await put(app, path, body ?? {});
  return { status: res.status, body: (await json(res)) as Json, headers: res.headers };
}

const byId = (products: Json[]) => new Map(products.map((p) => [p.product_id as string, p] as const));
const codes = (p: Json) => (p.flags as Array<{ code: string }>).map((f) => f.code);

/** Every V2 and price table a write would touch, and the products row. */
const v2Image = (raw: DatabaseSync, ids: string[]) =>
  JSON.stringify(
    ['pricing_inputs', 'pricing_rules', 'pricing_v2_sku_results', 'product_pricing_state', 'product_sku_prices', 'price_history', 'pricing_audit', 'products', 'product_source_refs'].map((t) => [
      t,
      all(raw, `SELECT * FROM ${t} WHERE ${t === 'products' ? 'id' : 'product_id'} IN (${ids.map(q).join(', ')}) ORDER BY rowid`),
    ])
  );

test('compute answers each line (the supplier price, R and the estimated price), the flags and the hash — and writes no V2 table', async () => {
  const w = world();
  seedThree(w.raw);
  // The spare part and the printer are typed by the owner (the PLA's type comes from its Tmall match's category).
  w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_prn', 'printer', 'owner', ${q(NOW)})`);
  const ids = ['p_fil', 'p_part', 'p_prn'];
  const before = v2Image(w.raw, ids);
  const auditBefore = count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit');

  const res = await call(w.app, 'POST', `${BASE}/compute`, { product_ids: ids });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const p = byId(res.body.products);

  const fil = p.get('p_fil')!;
  assert.equal(fil.type, 'filament');
  assert.equal(fil.type_source, 'supplier_category');
  assert.deepEqual([fil.sourcing, fil.route, fil.currency, fil.structure], ['CHINA_CNY', 'sea', 'CNY', 'prepare']);
  assert.deepEqual(
    fil.lines.map((l: Json) => [l.combo_key, l.channel, l.source, l.supplier_amount, l.supplier_currency, l.measure_source, l.est_cost_iqd, l.est_price_iqd]).sort(),
    [
      ['c:p_fil_black', 'pre_order_sea', 'tmall_cn', '69', 'CNY', 'type_default', 17_056, 20_500],
      ['c:p_fil_red', 'pre_order_sea', 'tmall_cn', '69', 'CNY', 'type_default', 17_056, 20_500],
    ]
  );
  assert.deepEqual(codes(fil), ['EST_DEFAULT_BOX', 'EST_DEFAULT_WEIGHT'], 'priced from the type defaults: hard flags, still an estimate (D2)');
  assert.equal(fil.measure_basis, 'type_default');
  assert.equal(fil.blocking, false);
  assert.match(fil.preview_hash, /^[0-9a-f]{64}$/);

  const part = p.get('p_part')!;
  assert.equal(part.type, 'spare_part');
  assert.deepEqual(part.lines.map((l: Json) => [l.combo_key, l.channel, l.measure_source, l.est_cost_iqd, l.est_price_iqd]), [['', 'pre_order_sea', 'product', 9_160, 14_000]]);
  assert.deepEqual(codes(part), []);
  assert.equal(part.measure_basis, 'real');

  const prn = p.get('p_prn')!;
  assert.deepEqual([prn.type, prn.type_source, prn.sourcing, prn.route, prn.currency], ['printer', 'owner', 'EU_STORE_EUR', 'land', 'EUR']);
  assert.deepEqual(prn.lines.map((l: Json) => [l.channel, l.source, l.supplier_amount, l.supplier_currency, l.est_cost_iqd, l.est_price_iqd]), [
    ['pre_order_land', 'typed', '1599', 'EUR', 2_903_240, 2_983_250],
  ]);
  assert.deepEqual(codes(prn), ['EST_MANUAL_PRICE'], 'a typed price is a soft flag');
  assert.match(prn.preview_hash, /^[0-9a-f]{64}$/);

  // Stored: the bookkeeping (candidate, its hash) and the lines — owner-only tables.
  for (const pid of ids) {
    const e = row<Json>(w.raw, 'SELECT state, preview_hash, computed_at FROM product_price_estimates WHERE product_id = ?', pid)!;
    assert.equal(e.state, 'candidate');
    assert.equal(e.preview_hash, p.get(pid)!.preview_hash);
    assert.ok(e.computed_at);
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM price_estimate_lines WHERE product_id = ?', pid), p.get(pid)!.lines.length);
  }
  const line = row<Json>(w.raw, "SELECT * FROM price_estimate_lines WHERE product_id = 'p_fil' AND combo_key = 'c:p_fil_red'")!;
  assert.deepEqual([line.price_source, line.supplier_amount, line.supplier_currency, line.measure_source, line.est_cost_iqd, line.est_price_iqd, JSON.parse(line.flags_json)], [
    'tmall_cn',
    '69',
    'CNY',
    'type_default',
    17_056,
    20_500,
    ['EST_DEFAULT_BOX', 'EST_DEFAULT_WEIGHT'],
  ]);

  // NO V2 TABLE WRITTEN, the product row untouched.
  assert.equal(v2Image(w.raw, ids), before);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit'), auditBefore);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);

  // The same compute again: the same hash (nothing moved), the bookkeeping's version moved.
  const again = byId((await call(w.app, 'POST', `${BASE}/compute`, { product_ids: ['p_fil'] })).body.products);
  assert.equal(again.get('p_fil')!.preview_hash, fil.preview_hash);
  assert.equal(row<Json>(w.raw, "SELECT version FROM product_price_estimates WHERE product_id = 'p_fil'")!.version, 2);

  // The stored read answers the same lines.
  const stored = await call(w.app, 'GET', `${BASE}/products/p_fil`);
  assert.equal(stored.status, 200);
  assert.deepEqual(stored.body.product.lines.map((l: Json) => l.est_price_iqd), [20_500, 20_500]);
  const ready = await call(w.app, 'GET', `${BASE}/products?state=ready`);
  assert.deepEqual(ready.body.products.map((x: Json) => x.product_id), ['p_fil', 'p_part', 'p_prn']);
});

test('blocking flags give no hash: no type, an incomplete type, no price, a suggestion only, a route below cost, an import running', async () => {
  const w = world();
  seedProduct(w.raw, 'p_none', { name: 'Mystery item' });
  typed(w.raw, 'p_none', '', '10', 'CNY');
  // A spare part with no minimum profit on its type, nor a weight for a product with no package.
  seedProduct(w.raw, 'p_inc', { name: 'Hotend kit' });
  w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_inc', 'hotend', 'owner', ${q(NOW)})`);
  tmall(w.raw, 'p_inc', '', '120', { item: '3000000000001', sku: '3000000000002' });
  // One colour priced, the other with no price at all.
  seedProduct(w.raw, 'p_half', { name: 'PLA Matte', colours: ['red', 'black'] });
  tmall(w.raw, 'p_half', 'c:p_half_red', '69', { item: '4000000000001', sku: '4000000000002', category: 'filament' });
  // Priced only through a suggestion the owner has not reviewed.
  seedProduct(w.raw, 'p_sug', { name: 'Scraper', weight: 100, box: [100, 50, 20] });
  w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_sug', 'spare_part', 'owner', ${q(NOW)})`);
  tmall(w.raw, 'p_sug', '', '12', { item: '5000000000001', sku: '5000000000002', state: 'suggested' });

  const res = await call(w.app, 'POST', `${BASE}/compute`, { product_ids: ['p_none', 'p_inc', 'p_half', 'p_sug'] });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  const p = byId(res.body.products);
  const expect: Array<[string, string]> = [
    ['p_none', 'EST_TYPE_MISSING'],
    ['p_inc', 'EST_TYPE_INCOMPLETE'],
    ['p_half', 'EST_NO_PRICE'],
    ['p_sug', 'EST_MATCH_REVIEW'],
  ];
  for (const [pid, code] of expect) {
    const x = p.get(pid)!;
    assert.ok(codes(x).includes(code), `${pid}: ${code} (${codes(x).join(', ')})`);
    assert.ok(x.blocked_by.includes(code), `${pid}: ${code} blocks`);
    assert.equal(x.blocking, true);
    assert.equal(x.preview_hash, null, `${pid}: no hash to apply`);
    assert.equal(row<Json>(w.raw, 'SELECT preview_hash FROM product_price_estimates WHERE product_id = ?', pid)!.preview_hash, null);
  }
  const half = p.get('p_half')!.flags.find((f: Json) => f.code === 'EST_NO_PRICE');
  assert.deepEqual(half.combo_keys, ['c:p_half_black'], 'the SKU with no price is named; nothing is inferred from its sibling');
  const inc = p.get('p_inc')!.flags.find((f: Json) => f.code === 'EST_TYPE_INCOMPLETE');
  assert.ok(inc.fields.includes('minimum_profit'));

  // A minimum profit below one rounding step: the route floor closes the route (§4.3) — blocked, and the type warns.
  w.raw.exec(`UPDATE price_estimate_types SET min_profit_usd = '0.05' WHERE key = 'spare_part'`);
  seedProduct(w.raw, 'p_low', { name: 'Clip', weight: 500, box: [100, 100, 50] });
  w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_low', 'spare_part', 'owner', ${q(NOW)})`);
  tmall(w.raw, 'p_low', '', '40', { item: '6000000000001', sku: '6000000000002' });
  const low = byId((await call(w.app, 'POST', `${BASE}/compute`, { product_ids: ['p_low'] })).body.products).get('p_low')!;
  assert.ok(low.blocked_by.includes('V2_ROUTE_BELOW_COST'), low.blocked_by.join(', '));
  assert.equal(low.preview_hash, null);
  const types = (await call(w.app, 'GET', `${BASE}/types`)).body.types as Json[];
  assert.deepEqual(types.find((t) => t.key === 'spare_part')!.warnings, ['MIN_PROFIT_BELOW_ROUTE_FLOOR']);
  assert.deepEqual(types.find((t) => t.key === 'filament')!.warnings, []);

  // An import batch in flight (its guard row visible): answered, never stored (the 0218 guards refuse the write).
  seedThree(w.raw);
  w.raw.exec("INSERT INTO ops_guards (id, ok) VALUES ('catalog-import-batch', 1)");
  const running = byId((await call(w.app, 'POST', `${BASE}/compute`, { product_ids: ['p_part'] })).body.products).get('p_part')!;
  assert.ok(codes(running).includes('EST_IMPORT_RUNNING'));
  assert.equal(running.preview_hash, null);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_price_estimates WHERE product_id = 'p_part'"), 0);
  w.raw.exec("DELETE FROM ops_guards WHERE id = 'catalog-import-batch'");
});

test('eligibility (§4.7): stocked, celled and merged products are never restructured; a firm V2 price is never an estimate; an owner-built pre-order product is ready', async () => {
  const w = world();
  // Stocked (a number on a colour), celled (an order-type cell), merged (the owner's existing listing, direct sale).
  seedProduct(w.raw, 'p_stock', { name: 'PLA Silk', colours: ['red'] });
  w.raw.exec("UPDATE product_colors SET stock = 3 WHERE product_id = 'p_stock'");
  tmall(w.raw, 'p_stock', 'c:p_stock_red', '79', { item: '7000000000001', sku: '7000000000002', category: 'filament' });
  seedProduct(w.raw, 'p_cell', { name: 'Build plate' });
  w.raw.exec(`
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_cell', 'p_cell', 'Size', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES ('v_cell', 'p_cell', 'g_cell', '256', '256', '٢٥٦', 0, 1);
    INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES ('f_cell', 'p_cell', 'v_cell', 'direct_sale', 1);
    INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_cell', 'build_plate', 'owner', ${q(NOW)});
    UPDATE price_estimate_types SET min_profit_usd = '3' WHERE key = 'build_plate';
  `);
  tmall(w.raw, 'p_cell', 'o:v_cell', '99', { item: '8000000000001', sku: '8000000000002' });
  seedProduct(w.raw, 'p_merged', { name: 'AMS lite', match: 'merged', weight: 3000, box: [400, 300, 300] });
  w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_merged', 'ams', 'owner', ${q(NOW)})`);
  w.raw.exec(`UPDATE price_estimate_types SET min_profit_usd = '20' WHERE key = 'ams'`);
  typed(w.raw, 'p_merged', '', '249', 'EUR');
  // An owner-built product already pre-order-only by land: ready as it is (no structure written).
  seedProduct(w.raw, 'p_ready', {
    name: 'Laser module',
    match: null,
    weight: 2000,
    box: [300, 200, 200],
    saleTypes: ['pre_order'],
    routes: [{ method: 'land', commission_iqd: 0, active: true }],
  });
  typed(w.raw, 'p_ready', '', '399', 'EUR');
  w.raw.exec(`UPDATE price_estimate_types SET min_profit_usd = '30' WHERE key = 'electronics_part'`);

  const app = w.app;
  // The owner enrols the owner-built product by choosing its type (PUT /products/:id, version 0: no row yet).
  const enrol = await call(app, 'PUT', `${BASE}/products/p_ready`, { version: 0, type_key: 'electronics_part' });
  assert.equal(enrol.status, 200, JSON.stringify(enrol.body));
  assert.deepEqual([enrol.body.settings.type_key, enrol.body.settings.type_source, enrol.body.settings.state], ['electronics_part', 'owner', 'candidate']);

  // A firm V2 product (published, no label), enrolled by the owner.
  await writeV2(w.db, AMS, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '300' }] });
  const firmEnrol = await call(app, 'PUT', `${BASE}/products/${AMS}`, { version: 0, type_key: 'ams' });
  assert.equal(firmEnrol.status, 200);

  const res = await call(app, 'POST', `${BASE}/compute`, { product_ids: ['p_stock', 'p_cell', 'p_merged', 'p_ready', AMS] });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  const p = byId(res.body.products);
  for (const pid of ['p_stock', 'p_cell', 'p_merged']) {
    assert.equal(p.get(pid)!.structure, 'owner', pid);
    assert.ok(p.get(pid)!.blocked_by.includes('EST_STRUCTURE_OWNER'), `${pid}: ${p.get(pid)!.blocked_by.join(', ')}`);
    assert.equal(p.get(pid)!.preview_hash, null);
  }
  assert.ok(p.get(AMS)!.blocked_by.includes('EST_FIRM_PRICE'), 'never-on-published');
  assert.deepEqual(p.get(AMS)!.lines, []);
  const ready = p.get('p_ready')!;
  assert.equal(ready.structure, 'ready');
  assert.deepEqual(ready.blocked_by, []);
  assert.match(ready.preview_hash, /^[0-9a-f]{64}$/);
  // EUR 399 × 1,760 + 2 kg × 3,200 = 708,640; $30 = 48,000 → 756,640 → 756,750.
  assert.deepEqual(ready.lines.map((l: Json) => [l.channel, l.est_cost_iqd, l.est_price_iqd]), [['pre_order_land', 708_640, 756_750]]);

  // An override against the type's rules (filament never by air; EU sourcing by land only) is refused by T5.
  const version = row<Json>(w.raw, "SELECT version FROM product_price_estimates WHERE product_id = 'p_ready'")!.version as number;
  const air = await call(app, 'PUT', `${BASE}/products/p_ready`, { version, route_override: 'sea' });
  assert.equal(air.status, 409);
  assert.equal(air.body.code, 'PRICE_ESTIMATE_TYPE_RULE');
});

test('an owner’s stock route on another route is kept and blocks (EST_STRUCTURE_OWNER, shipping_profile): set by a data-only form save, cleared by the route override or by the form', async () => {
  const w = world();
  seedProduct(w.raw, 'p_sw', { name: 'Nozzle wiper', weight: 500, box: [100, 100, 50] });
  w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_sw', 'spare_part', 'owner', ${q(NOW)})`);
  tmall(w.raw, 'p_sw', '', '40', { item: '2100000000001', sku: '2100000000002' });
  const app = stubApp(
    asD1(w.raw),
    OWNER,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(BASE, adminPriceEstimatesRoutes);
      a.route('/api/admin/products-v2', adminProductsRoutes);
    },
    { publishV2: false }
  );
  // The product form's «مسار شحن المخزون» alone, before any price: the evaluation is incomplete, so a data-only save.
  const formRoute = async (shipping_profile: string | null) => {
    const stored = await json(await get(app, '/api/admin/products-v2/p_sw/pricing'));
    const res = await put(app, '/api/admin/products-v2/p_sw/pricing', { seq: stored.seq, pricing: { method: 'cost', cost: { inputs: [{ scope: 'base', shipping_profile }] } } });
    assert.equal(res.status, 200, JSON.stringify(await json(res.clone())).slice(0, 300));
  };
  const compute = async () => (await call(app, 'POST', `${BASE}/compute`, { product_ids: ['p_sw'] })).body.products[0] as Json;
  await formRoute('CHINA_AIR');
  assert.deepEqual(all(w.raw, "SELECT scope, origin, shipping_profile FROM pricing_inputs WHERE product_id = 'p_sw'"), [{ scope: 'base', origin: 'MANUAL_OVERRIDE', shipping_profile: 'CHINA_AIR' }]);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = 'p_sw'"), 0, 'no price yet');

  // The type sails by sea, the owner's stock route is air: V2 would price D on air freight. Blocked, his route kept.
  const held = await compute();
  assert.equal(held.route, 'sea');
  assert.deepEqual(held.flags.find((f: Json) => f.code === 'EST_STRUCTURE_OWNER'), { code: 'EST_STRUCTURE_OWNER', combo_keys: [''], fields: ['shipping_profile'] });
  assert.ok(held.blocked_by.includes('EST_STRUCTURE_OWNER'));
  assert.equal(held.preview_hash, null, 'nothing to apply');
  assert.equal(row<Json>(w.raw, "SELECT shipping_profile FROM pricing_inputs WHERE product_id = 'p_sw' AND scope = 'base'")!.shipping_profile, 'CHINA_AIR');

  // Clear it one way: this product goes by air (the type allows air) — the owner's route is now the estimate's.
  const version = () => row<Json>(w.raw, "SELECT version FROM product_price_estimates WHERE product_id = 'p_sw'")!.version as number;
  assert.equal((await call(app, 'PUT', `${BASE}/products/p_sw`, { version: version(), route_override: 'air' })).status, 200);
  const byAir = await compute();
  assert.deepEqual([byAir.route, byAir.blocked_by], ['air', []]);
  // 40 × 224 = 8,960 + 0.5 kg × 20,000 = 18,960; + $3 = 4,800 → 23,760 → 24,000.
  assert.deepEqual(byAir.lines.map((l: Json) => [l.channel, l.est_cost_iqd, l.est_price_iqd]), [['pre_order_air', 18_960, 24_000]]);
  assert.match(byAir.preview_hash, /^[0-9a-f]{64}$/);

  // …or the other: back to the type's sea, and the form's stock route set to sea.
  assert.equal((await call(app, 'PUT', `${BASE}/products/p_sw`, { version: version(), route_override: null })).status, 200);
  assert.ok((await compute()).blocked_by.includes('EST_STRUCTURE_OWNER'));
  await formRoute('CHINA_SEA');
  const bySea = await compute();
  assert.deepEqual([bySea.route, bySea.blocked_by], ['sea', []]);
  assert.deepEqual(bySea.lines.map((l: Json) => [l.channel, l.est_cost_iqd, l.est_price_iqd]), [['pre_order_sea', 9_160, 14_000]]);
});

test('a refresh stores on an estimated row what describes the product now — the applied soft and hard flags stay, the blocking and information ones are the refresh’s; the Flags tab lists what the workspace shows', async () => {
  const w = world();
  const db = asD1(w.raw);
  const wire = JSON.stringify({ v: 1, inputs: [], minimum_profit: null });
  const seed = (pid: string, state: string, flags: unknown) => {
    seedProduct(w.raw, pid);
    w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, state, flags_json, applied_at, applied_wire_json, version, updated_at)
                VALUES (${q(pid)}, 'filament', 'owner', ${q(state)}, ${q(JSON.stringify(flags))}, ${q(NOW)}, ${q(wire)}, 3, ${q(NOW)})`);
  };
  const stored = (pid: string) => row<{ f: string; v: number }>(w.raw, 'SELECT flags_json AS f, version AS v FROM product_price_estimates WHERE product_id = ?', pid)!;
  const flagsOf = (pid: string) => JSON.parse(stored(pid).f) as Json[];
  const store = (pid: string, flags: PlanFlag[]) =>
    db.batch(previewStatements(db, { product_id: pid, skipped: true, preview: { type: 'filament', type_source: 'owner', flags, preview_hash: null, computed_at: NOW, lines: [] } } as unknown as PreparedEstimate, 'usr_owner'));
  const refresh: PlanFlag[] = [
    { code: 'EST_LARGE_CHANGE_HELD' },
    { code: 'EST_NO_PRICE', combo_keys: ['k3'] },
    { code: 'EST_SNAPSHOT_STALE', combo_keys: ['k1'] },
    { code: 'EST_US_REFERENCE', combo_keys: ['k2'] },
    { code: 'FX_RATE_MISSING' },
  ];

  // The applied soft and hard flags stay (a bare code kept as its entry); the applied information is the refresh's now.
  seed('p_est', 'estimated', [{ code: 'EST_DEFAULT_WEIGHT', combo_keys: ['k1', 'k2'] }, 'EST_MANUAL_PRICE', { code: 'EST_OWNER_EDITED', fields: ['shipping_weight_g'] }, { code: 'EST_US_REFERENCE', combo_keys: ['k1'] }]);
  await store('p_est', refresh);
  assert.deepEqual(flagsOf('p_est'), [
    { code: 'EST_DEFAULT_WEIGHT', combo_keys: ['k1', 'k2'] },
    { code: 'EST_LARGE_CHANGE_HELD' },
    { code: 'EST_MANUAL_PRICE' },
    { code: 'EST_NO_PRICE', combo_keys: ['k3'] },
    { code: 'EST_US_REFERENCE', combo_keys: ['k1'] },
    { code: 'FX_RATE_MISSING' },
  ]);
  assert.equal(stored('p_est').v, 4);
  await store('p_est', [{ code: 'EST_SNAPSHOT_STALE', combo_keys: ['k1'] }]);
  assert.deepEqual(flagsOf('p_est').map((f) => f.code), ['EST_DEFAULT_WEIGHT', 'EST_MANUAL_PRICE', 'EST_US_REFERENCE'], 'a refresh with nothing to say of now');

  // Long applied flags: the refresh's combo keys are counted to fit beside them; with no room left, the applied ones alone, never cut.
  const keysOf = (n: number) => Array.from({ length: n }, (_, i) => `c:${String(i).padStart(16, '0')}`);
  const mid = [{ code: 'EST_US_REFERENCE', combo_keys: keysOf(150) }];
  assert.ok(JSON.stringify(mid).length + JSON.stringify(keysOf(60)).length > 4000, 'the full refresh does not fit beside it');
  seed('p_mid', 'estimated', mid);
  await store('p_mid', [{ code: 'EST_LARGE_CHANGE_HELD' }, { code: 'EST_NO_PRICE', combo_keys: keysOf(60) }]);
  assert.deepEqual(flagsOf('p_mid'), [{ code: 'EST_LARGE_CHANGE_HELD' }, { code: 'EST_NO_PRICE', count: 60 }, ...mid]);
  const keys: string[] = [];
  while (JSON.stringify([{ code: 'EST_US_REFERENCE', combo_keys: [...keys, 'c:x'] }]).length < 3960) keys.push(`c:${String(keys.length).padStart(16, '0')}`);
  const full = [{ code: 'EST_US_REFERENCE', combo_keys: keys }];
  seed('p_big', 'estimated', full);
  await store('p_big', refresh);
  assert.deepEqual(flagsOf('p_big'), full);
  assert.equal(stored('p_big').v, 4, 'the row is still the refresh’s (its hash and time)');

  // A candidate takes the preview whole; a paused row is never rewritten.
  seed('p_cand', 'candidate', [{ code: 'EST_OWNER_EDITED' }]);
  await store('p_cand', refresh);
  assert.deepEqual(flagsOf('p_cand'), refresh);
  seed('p_pause', 'paused', [{ code: 'EST_US_REFERENCE' }]);
  await store('p_pause', refresh);
  assert.deepEqual([flagsOf('p_pause'), stored('p_pause').v], [[{ code: 'EST_US_REFERENCE' }], 3]);

  // What the workspace shows of an estimated (or paused) product: its row's flags, and its latest lines' default
  // measures and catalogue words, each for its SKU — never a line's price source, which is that compute's own.
  const lines: Array<Pick<EstimateLine, 'combo_key' | 'flags' | 'measure_source'>> = [
    { combo_key: 'c:r', measure_source: 'colour', flags: ['EST_SNAPSHOT_STALE', 'EST_US_REFERENCE'] },
    { combo_key: 'c:b', measure_source: 'type_default', flags: ['EST_DEFAULT_WEIGHT', 'EST_MANUAL_PRICE', 'EST_SUPPLIER_OUT_OF_STOCK'] },
  ];
  assert.deepEqual(shownFlags('estimated', [{ code: 'EST_MANUAL_PRICE', combo_keys: ['c:b'] }, { code: 'EST_OWNER_EDITED', fields: ['supplier_cost'] }], lines), [
    { code: 'EST_DEFAULT_WEIGHT', combo_keys: ['c:b'] },
    { code: 'EST_MANUAL_PRICE', combo_keys: ['c:b'] },
    { code: 'EST_OWNER_EDITED', fields: ['supplier_cost'] },
    { code: 'EST_SNAPSHOT_STALE', combo_keys: ['c:r'] },
    { code: 'EST_SUPPLIER_OUT_OF_STOCK', combo_keys: ['c:b'] },
  ]);
  assert.deepEqual(shownFlags('paused', [], lines.slice(0, 1)), [{ code: 'EST_SNAPSHOT_STALE', combo_keys: ['c:r'] }]);
  assert.deepEqual(shownFlags('estimated', [{ code: 'EST_SNAPSHOT_STALE' }], lines.slice(0, 1)), [{ code: 'EST_SNAPSHOT_STALE' }], 'a flag naming no SKU is the product’s already');
  assert.deepEqual(shownFlags('candidate', [], lines), []);
  assert.deepEqual(shownFlags('confirmed', [], lines), []);

  // The Flags tab: labelled products with a flag to show, on the row or on a line.
  const line = (pid: string, flags: string[]) =>
    w.raw.exec(`INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, measure_source, flags_json, computed_at)
                VALUES (${q(pid)}, '', 'pre_order_sea', 'tmall_cn', 'product', ${q(JSON.stringify(flags))}, ${q(NOW)})`);
  for (const [pid, flags] of [
    ['p_stock', ['EST_SUPPLIER_OUT_OF_STOCK']],
    ['p_default', ['EST_DEFAULT_BOX']],
    ['p_source', ['EST_US_REFERENCE', 'EST_UNITS_DIVIDED']],
    ['p_clean', []],
  ] as const) {
    seed(pid, 'estimated', []);
    line(pid, [...flags]);
  }
  line('p_cand', ['EST_SNAPSHOT_STALE']);
  const tab = await listEstimates(db, 'flags', '');
  assert.deepEqual(
    tab.products.map((p) => [p.product_id, p.flags]),
    [
      ['p_big', full],
      ['p_default', [{ code: 'EST_DEFAULT_BOX', combo_keys: [''] }]],
      ['p_est', flagsOf('p_est')],
      // A counted entry keeps its number of options (parseFlags reads `count`).
      ['p_mid', [{ code: 'EST_LARGE_CHANGE_HELD' }, { code: 'EST_NO_PRICE', count: 60 }, ...mid]],
      ['p_stock', [{ code: 'EST_SUPPLIER_OUT_OF_STOCK', combo_keys: [''] }]],
    ]
  );
});

test('a refresh that does not fit beside long applied flags: its combo keys counted, else left out — a previous refresh’s hold never outlives it, and the applied entries stay whole', async () => {
  const w = world();
  const db = asD1(w.raw);
  const wire = JSON.stringify({ v: 1, inputs: [], minimum_profit: null });
  const seed = (pid: string, flags: unknown[]) => {
    seedProduct(w.raw, pid);
    w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, state, flags_json, applied_at, applied_wire_json, version, updated_at)
                VALUES (${q(pid)}, 'filament', 'owner', 'estimated', ${q(JSON.stringify(flags))}, ${q(NOW)}, ${q(wire)}, 3, ${q(NOW)})`);
  };
  const stored = (pid: string) => row<{ f: string; v: number }>(w.raw, 'SELECT flags_json AS f, version AS v FROM product_price_estimates WHERE product_id = ?', pid)!;
  const flagsOf = (pid: string) => JSON.parse(stored(pid).f) as Json[];
  const store = (pid: string, flags: PlanFlag[]) =>
    db.batch(previewStatements(db, { product_id: pid, skipped: true, preview: { type: 'filament', type_source: 'owner', flags, preview_hash: null, computed_at: NOW, lines: [] } } as unknown as PreparedEstimate, 'usr_owner'));
  const held = { code: 'EST_LARGE_CHANGE_HELD' };
  /** An applied US reference whose combo keys leave `free` characters of the column beside a hold. */
  const reference = (free: number) => {
    const keys: string[] = [];
    while (JSON.stringify([held, { code: 'EST_US_REFERENCE', combo_keys: [...keys, 'c:x'] }]).length < 4000 - free) keys.push(`c:${String(keys.length).padStart(16, '0')}`);
    return { code: 'EST_US_REFERENCE', combo_keys: keys };
  };
  const us = reference(155);
  const room = 4000 - JSON.stringify([us]).length - 1;
  seed('p_over', [us]);

  // 1. FX-5 holds a change: the hold fits beside the applied reference.
  await store('p_over', [held]);
  assert.deepEqual(flagsOf('p_over'), [held, us]);
  // 2. Released, and twelve new colours have no price: short, but more than the room left — counted.
  const twelve: PlanFlag = { code: 'EST_NO_PRICE', combo_keys: Array.from({ length: 12 }, (_, i) => `c:new-colour-${i}`) };
  assert.ok(JSON.stringify([twelve]).length > room && JSON.stringify([twelve]).length < 1000);
  await store('p_over', [twelve]);
  assert.deepEqual(flagsOf('p_over'), [{ code: 'EST_NO_PRICE', count: 12 }, us], 'the hold is gone with the refresh that raised it');
  // 3. A refresh whose codes alone do not fit: left out, and the previous refresh's code with it.
  const wide: PlanFlag[] = [
    { code: 'CBM_MISSING' },
    { code: 'EST_MATCH_REVIEW', combo_keys: ['c:a'] },
    twelve,
    { code: 'EST_OWNER_EDITED', fields: ['shipping_box', 'shipping_weight_g', 'supplier_cost'] },
    { code: 'EST_STRUCTURE_OWNER', combo_keys: ['c:a'], fields: ['shipping_profile'] },
    { code: 'EST_TYPE_INCOMPLETE', combo_keys: ['c:a'], fields: ['minimum_profit'] },
    { code: 'FX_RATE_MISSING' },
    { code: 'V2_ROUTE_BELOW_COST', combo_keys: ['c:a'] },
  ];
  assert.ok(JSON.stringify(wide.map((f) => ({ code: f.code }))).length > room);
  await store('p_over', wide);
  assert.deepEqual(flagsOf('p_over'), [us]);
  assert.equal(stored('p_over').v, 6, 'each refresh is the row’s (its hash and time)');

  // The counted form keeps the field names: the owner is told what to correct.
  seed('p_route', [us]);
  await store('p_route', [{ code: 'EST_STRUCTURE_OWNER', combo_keys: Array.from({ length: 20 }, (_, i) => `c:k${i}`), fields: ['shipping_profile'] }]);
  assert.deepEqual(flagsOf('p_route'), [{ code: 'EST_STRUCTURE_OWNER', count: 20, fields: ['shipping_profile'] }, us]);

  // Applied entries that no longer fit as entries (bare codes): the row as stored, never cut.
  const bare = [...Array.from({ length: 199 }, () => 'EST_MANUAL_PRICE'), 'EST_OWNER_EDITED'];
  seed('p_bare', bare);
  await store('p_bare', [twelve]);
  assert.deepEqual([stored('p_bare').f, stored('p_bare').v], [JSON.stringify(bare), 4]);

  // What the workspace reads back of a counted entry: its number of options (display only), never in place of keys.
  assert.deepEqual((await listEstimates(db, 'estimated', '')).products.find((p) => p.product_id === 'p_route')?.flags, [
    { code: 'EST_STRUCTURE_OWNER', count: 20, fields: ['shipping_profile'] },
    us,
  ]);
  assert.deepEqual(
    parseFlags(JSON.stringify([{ code: 'A', count: 3, fields: ['shipping_box'] }, { code: 'B', count: 0 }, { code: 'C', combo_keys: ['k'], count: 9 }, { code: 'D', count: -1 }, { code: 'E', count: 2.5 }, { code: 'F', count: '4' }])),
    [{ code: 'A', count: 3, fields: ['shipping_box'] }, { code: 'B', count: 0 }, { code: 'C', combo_keys: ['k'] }, { code: 'D' }, { code: 'E' }, { code: 'F' }]
  );
});

test('the default measures the workspace shows are the row’s except on a SKU whose latest line is on real measures already in the store; the Flags tab lists exactly what is shown', async () => {
  type Line = Pick<EstimateLine, 'combo_key' | 'flags' | 'measure_source'>;
  const L = (combo_key: string, measure_source: Line['measure_source'], flags: string[] = []): Line => ({ combo_key, measure_source, flags });
  const applied: PlanFlag[] = [
    { code: 'EST_DEFAULT_BOX', combo_keys: ['c:b', 'c:g', 'c:r'] },
    { code: 'EST_DEFAULT_WEIGHT', combo_keys: ['c:b', 'c:g', 'c:r'] },
    { code: 'EST_US_REFERENCE', combo_keys: ['c:r'] },
  ];
  const onlyBlack = [
    { code: 'EST_DEFAULT_BOX', combo_keys: ['c:b'] },
    { code: 'EST_DEFAULT_WEIGHT', combo_keys: ['c:b'] },
    { code: 'EST_US_REFERENCE', combo_keys: ['c:r'] },
  ];
  // Red saved in the pricing form (the owner's), green on its colour's package; black waits on its product package (the next apply).
  assert.deepEqual(shownFlags('estimated', applied, [L('c:b', 'product'), L('c:g', 'colour'), L('c:r', 'owner', ['EST_US_REFERENCE'])]), onlyBlack);
  // …or black is still on the type's box, as its line says.
  assert.deepEqual(shownFlags('estimated', applied, [L('c:b', 'type_default', ['EST_DEFAULT_BOX']), L('c:g', 'model'), L('c:r', 'owner')]), onlyBlack);
  // All on real measures: none is shown, estimated or paused.
  const real = [L('c:b', 'model'), L('c:g', 'colour'), L('c:r', 'owner')];
  assert.deepEqual(shownFlags('estimated', applied, real), [{ code: 'EST_US_REFERENCE', combo_keys: ['c:r'] }]);
  assert.deepEqual(shownFlags('paused', applied, real), [{ code: 'EST_US_REFERENCE', combo_keys: ['c:r'] }]);
  // One naming no SKU (its keys counted away) goes only when every line is on real measures.
  assert.deepEqual(shownFlags('estimated', [{ code: 'EST_DEFAULT_BOX' }], real), []);
  assert.deepEqual(shownFlags('estimated', [{ code: 'EST_DEFAULT_BOX' }], [...real.slice(1), L('c:b', 'product')]), [{ code: 'EST_DEFAULT_BOX' }]);
  // No line: the row's as stored; a candidate's are its own preview's.
  assert.deepEqual(shownFlags('estimated', applied, []), applied);
  assert.deepEqual(shownFlags('candidate', applied, real), applied);
  // The type's CBM still decides the product level, beside a box the owner entered there: a line on the owner's
  // measures may be that box, which prices nothing yet — only a package's line shows a SKU's box real. The weight is unaffected.
  const hidden = { typeCbmHidesBox: true };
  assert.deepEqual(shownFlags('estimated', applied, real, hidden), [
    { code: 'EST_DEFAULT_BOX', combo_keys: ['c:r'] },
    { code: 'EST_US_REFERENCE', combo_keys: ['c:r'] },
  ]);
  assert.deepEqual(shownFlags('estimated', applied, [L('c:b', 'model'), L('c:g', 'colour'), L('c:r', 'colour')], hidden), [{ code: 'EST_US_REFERENCE', combo_keys: ['c:r'] }]);
  assert.deepEqual(shownFlags('estimated', [{ code: 'EST_DEFAULT_BOX' }, { code: 'EST_DEFAULT_WEIGHT' }], real, hidden), [{ code: 'EST_DEFAULT_BOX' }]);
  assert.deepEqual(shownFlags('paused', [{ code: 'EST_DEFAULT_BOX' }], real.slice(0, 2), hidden), []);
  assert.deepEqual(shownFlags('estimated', applied, real, { typeCbmHidesBox: false }), shownFlags('estimated', applied, real));
  // …unless a level above the product's decides that SKU's CBM (its colour's, model's or own box in the pricing
  // form): the type's CBM does not reach it, so its line on the owner's measures shows its box real.
  const above = { typeCbmHidesBox: true, boxDecidedAbove: (k: string) => k === 'c:r' };
  assert.deepEqual(shownFlags('estimated', applied, real, above), [{ code: 'EST_US_REFERENCE', combo_keys: ['c:r'] }]);
  assert.deepEqual(shownFlags('estimated', [{ code: 'EST_DEFAULT_BOX' }], real, above), []);
  assert.deepEqual(shownFlags('estimated', applied, [L('c:b', 'owner'), L('c:g', 'owner'), L('c:r', 'owner')], above), [
    { code: 'EST_DEFAULT_BOX', combo_keys: ['c:b', 'c:g'] },
    { code: 'EST_US_REFERENCE', combo_keys: ['c:r'] },
  ]);
  assert.deepEqual(shownFlags('estimated', applied, real, { boxDecidedAbove: () => false }), shownFlags('estimated', applied, real), 'only while the type’s CBM decides');
  // An owner's pricing row written after the lines: they may no longer say what the store holds, so the row's stand,
  // with the lines' own default measures and catalogue words beside them.
  assert.deepEqual(shownFlags('estimated', applied, real, { stale: true }), applied);
  assert.deepEqual(shownFlags('paused', applied, [L('c:b', 'type_default', ['EST_DEFAULT_BOX', 'EST_SNAPSHOT_STALE']), L('c:r', 'owner')], { stale: true }), [
    ...applied.slice(0, 2),
    { code: 'EST_SNAPSHOT_STALE', combo_keys: ['c:b'] },
    applied[2],
  ]);

  // The Flags tab: labelled products with something shown, and nothing else.
  const w = world();
  const db = asD1(w.raw);
  const wire = JSON.stringify({ v: 1, inputs: [], minimum_profit: null });
  /** A record of the type's CBM written at the product level, and the base row the store holds now. */
  const cbmWire = (value: string, source = 'type_default') => JSON.stringify({ v: 1, inputs: [{ scope: 'base', scope_id: '', field: 'manual_cbm', value, source }], minimum_profit: null });
  type Base = { cbm: string | null; box: [number | null, number | null, number | null] };
  const ownerBox = (cbm: string | null = '0.004', box: Base['box'] = [210, 210, 90]): Base => ({ cbm, box });
  const cases: Array<[string, unknown[], Line[], string?, Base?]> = [
    ['p_all_real', applied.slice(0, 2), real],
    ['p_one_pending', applied.slice(0, 2), [L('c:b', 'product'), L('c:g', 'colour'), L('c:r', 'owner')]],
    ['p_no_lines', applied.slice(0, 2), []],
    ['p_wide_real', [{ code: 'EST_DEFAULT_WEIGHT' }], real],
    ['p_wide_pending', ['EST_DEFAULT_WEIGHT'], [L('c:b', 'none')]],
    ['p_soft_left', applied, real],
    ['p_line_default', [], [L('c:b', 'type_default', ['EST_DEFAULT_WEIGHT'])]],
    // The type's CBM beside the owner's box at the product level: red's line is the owner's, so its box still waits.
    ['p_cbm_hides_box', applied.slice(0, 2), real, cbmWire('0.004'), ownerBox()],
    ['p_cbm_hides_wide', [{ code: 'EST_DEFAULT_BOX' }], real, cbmWire('0.004'), ownerBox()],
    ['p_cbm_same_value', applied.slice(0, 2), real, cbmWire('0.004'), ownerBox('0.0040')],
    // …every SKU on its package; the owner's own CBM there; no whole box; a CBM not the type's; nothing at base.
    ['p_cbm_packaged', applied.slice(0, 2), [L('c:b', 'model'), L('c:g', 'colour'), L('c:r', 'colour')], cbmWire('0.004'), ownerBox()],
    ['p_cbm_owner_value', applied.slice(0, 2), real, cbmWire('0.004'), ownerBox('0.005')],
    ['p_cbm_half_box', applied.slice(0, 2), real, cbmWire('0.004'), ownerBox('0.004', [210, 210, null])],
    ['p_cbm_not_type', applied.slice(0, 2), real, cbmWire('0.004', 'product_package'), ownerBox()],
    ['p_cbm_no_base', applied.slice(0, 2), real, cbmWire('0.004')],
  ];
  for (const [pid, flags, lines, applied_wire = wire, base] of cases) {
    seedProduct(w.raw, pid);
    w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, state, flags_json, applied_at, applied_wire_json, version, updated_at)
                VALUES (${q(pid)}, 'filament', 'owner', 'estimated', ${q(JSON.stringify(flags))}, ${q(NOW)}, ${q(applied_wire)}, 3, ${q(NOW)})`);
    for (const l of lines) {
      w.raw.exec(`INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, measure_source, flags_json, computed_at)
                  VALUES (${q(pid)}, ${q(l.combo_key)}, 'pre_order_sea', 'tmall_cn', ${q(l.measure_source)}, ${q(JSON.stringify(l.flags))}, ${q(NOW)})`);
    }
    if (base) {
      w.raw.exec(`INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, manual_cbm, shipping_length_mm, shipping_width_mm, shipping_height_mm, updated_at)
                  VALUES (${q(pid)}, 'base', '', 'MANUAL_OVERRIDE', ${q(base.cbm)}, ${q(base.box[0])}, ${q(base.box[1])}, ${q(base.box[2])}, ${q(NOW)})`);
    }
  }
  const redBox = [{ code: 'EST_DEFAULT_BOX', combo_keys: ['c:r'] }];
  const tab = await listEstimates(db, 'flags', '');
  assert.deepEqual(
    tab.products.map((p) => [p.product_id, p.flags]),
    [
      ['p_cbm_hides_box', redBox],
      ['p_cbm_hides_wide', [{ code: 'EST_DEFAULT_BOX' }]],
      ['p_cbm_same_value', redBox],
      ['p_line_default', [{ code: 'EST_DEFAULT_WEIGHT', combo_keys: ['c:b'] }]],
      ['p_no_lines', applied.slice(0, 2)],
      ['p_one_pending', onlyBlack.slice(0, 2)],
      ['p_soft_left', [{ code: 'EST_US_REFERENCE', combo_keys: ['c:r'] }]],
      ['p_wide_pending', [{ code: 'EST_DEFAULT_WEIGHT' }]],
    ]
  );
  // What the other lists and the banner show of those the Flags tab leaves out: nothing.
  const all = new Map((await listEstimates(db, 'estimated', '')).products.map((p) => [p.product_id, p.flags] as const));
  for (const pid of ['p_all_real', 'p_wide_real', 'p_cbm_packaged', 'p_cbm_owner_value', 'p_cbm_half_box', 'p_cbm_not_type', 'p_cbm_no_base']) assert.deepEqual(all.get(pid), [], pid);
  assert.deepEqual(all.get('p_cbm_hides_box'), redBox);
});

test('what the lists read of the store since the latest lines: a pricing row written after them keeps the row’s defaults, a level above deciding a SKU’s CBM clears its box under the type’s CBM; «التحديث» also lists a refresh that takes in real measures with no price moved, and never one that takes nothing in', async () => {
  const w = world();
  const db = asD1(w.raw);
  const T0 = '2026-11-01T09:59:59.999Z';
  const T1 = '2026-11-01T10:00:00.000Z';
  const T2 = '2026-11-01T10:00:00.001Z';
  const HASH = 'a'.repeat(64);
  const defaults = [
    { code: 'EST_DEFAULT_BOX', combo_keys: ['c:b', 'c:r'] },
    { code: 'EST_DEFAULT_WEIGHT', combo_keys: ['c:b', 'c:r'] },
  ];
  const typeCbm = JSON.stringify({ v: 1, inputs: [{ scope: 'base', scope_id: '', field: 'manual_cbm', value: '0.004', source: 'type_default' }], minimum_profit: null });
  /** The last apply's record of the product level: a weight of 1,300 g and a box of 200 × 200 × 100 mm, and where each came from. */
  const measuresWire = (weightSource: string, boxSource: string) =>
    JSON.stringify({
      v: 1,
      inputs: [
        { scope: 'base', scope_id: '', field: 'shipping_weight_g', value: 1300, source: weightSource },
        { scope: 'base', scope_id: '', field: 'shipping_box', value: [200, 200, 100], source: boxSource },
      ],
      minimum_profit: null,
    });
  /** A pricing row; at the product level it holds the type's CBM unless `cbm` says otherwise. */
  type Row = { scope: string; id: string; box?: [number, number, number]; weight?: number; cbm?: string | null; at?: string };
  interface Seeded {
    flags: unknown[];
    lines: Array<[string, string, number?]>;
    wire?: string;
    rows?: Row[];
    hash?: string | null;
    pkg?: { weight?: number; box?: [number, number, number] };
  }
  const seed = (pid: string, s: Seeded) => {
    seedProduct(w.raw, pid, { weight: s.pkg?.weight ?? null, box: s.pkg?.box ?? null });
    w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, state, flags_json, preview_hash, computed_at, applied_at, applied_wire_json, version, updated_at)
                VALUES (${q(pid)}, 'filament', 'owner', 'estimated', ${q(JSON.stringify(s.flags))}, ${q(s.hash ?? null)}, ${q(T1)}, ${q(T1)}, ${q(s.wire ?? JSON.stringify({ v: 1, inputs: [], minimum_profit: null }))}, 3, ${q(T1)})`);
    for (const [combo, measure, est] of s.lines) {
      w.raw.exec(`INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, measure_source, flags_json, est_price_iqd, published_price_iqd, computed_at)
                  VALUES (${q(pid)}, ${q(combo)}, 'pre_order_sea', 'tmall_cn', ${q(measure)}, '[]', ${q(est ?? 20_500)}, 20500, ${q(T1)})`);
    }
    for (const r of s.rows ?? []) {
      const cbm = r.cbm !== undefined ? r.cbm : r.scope === 'base' ? '0.004' : null;
      w.raw.exec(`INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, manual_cbm, shipping_weight_g, shipping_length_mm, shipping_width_mm, shipping_height_mm, updated_at)
                  VALUES (${q(pid)}, ${q(r.scope)}, ${q(r.id)}, 'MANUAL_OVERRIDE', ${q(cbm)}, ${q(r.weight)}, ${q(r.box?.[0])}, ${q(r.box?.[1])}, ${q(r.box?.[2])}, ${q(r.at ?? T0)})`);
    }
  };
  const owners: Array<[string, string]> = [
    ['c:b', 'owner'],
    ['c:r', 'owner'],
  ];
  const ownerBase: Row = { scope: 'base', id: '', box: [210, 210, 90], weight: 1250 };
  const box: [number, number, number] = [220, 220, 90];
  // The display: rows on real measures by their lines, the pricing rows written before or after those lines.
  seed('p_s_fresh', { flags: defaults, lines: owners, rows: [{ scope: 'color', id: 'r', at: T0 }] });
  seed('p_s_same', { flags: defaults, lines: owners, rows: [{ scope: 'color', id: 'r', at: T1 }] });
  seed('p_s_after', { flags: defaults, lines: owners, rows: [{ scope: 'color', id: 'r', at: T2 }] });
  // The type's CBM beside the owner's box at the product level; red's colour has its own box, then black's too.
  seed('p_c_red_box', { flags: defaults.slice(0, 1), lines: owners, wire: typeCbm, rows: [ownerBase, { scope: 'color', id: 'r', box }] });
  seed('p_c_both_boxes', { flags: defaults.slice(0, 1), lines: owners, wire: typeCbm, rows: [ownerBase, { scope: 'color', id: 'r', box }, { scope: 'color', id: 'b', box }] });
  // «التحديث»: a price moved; the package waits (the store still holds the type's measures, the package has its
  // own); the type's CBM still decides; already real; no hash; no default left.
  const typeBase: Row = { scope: 'base', id: '', weight: 1300, box: [200, 200, 100], cbm: null };
  const products: Array<[string, string]> = [
    ['c:b', 'product'],
    ['c:r', 'product'],
  ];
  seed('p_r_moved', { flags: [], lines: [['c:b', 'owner', 20_250]], hash: HASH });
  seed('p_r_package', { flags: defaults, lines: products, wire: measuresWire('type_default', 'type_default'), rows: [typeBase], pkg: { weight: 1250, box: [210, 210, 90] }, hash: HASH });
  seed('p_r_type_cbm', { flags: defaults.slice(0, 1), lines: owners, wire: typeCbm, rows: [ownerBase], hash: HASH });
  seed('p_r_real', { flags: defaults, lines: owners, hash: HASH });
  seed('p_r_no_hash', { flags: defaults, lines: products });
  seed('p_r_clean_package', { flags: [], lines: products, hash: HASH });
  // Nothing for the apply to take in, so it is not offered (it would make every confirmed option an estimate again):
  // the package's box was taken in at the last apply and black was weighed since, so its line is on the package
  // (the weaker of its two measures), though the package has no weight; the package's weight (or box) would replace
  // the type's at the product level, but every option has the owner's own weight (or box) above it; under the
  // type's CBM, every option's box is decided above the product level (its colour's own box, or its colour's or
  // model's package). With only red's own weight or box, black's still waits.
  const weightLeft = [{ code: 'EST_DEFAULT_WEIGHT', combo_keys: ['c:b', 'c:r'] }];
  const weighed = (id: string): Row => ({ scope: 'color', id, weight: 1250 });
  seed('p_r_package_taken', { flags: weightLeft, lines: [['c:b', 'product'], ['c:r', 'type_default']], wire: measuresWire('type_default', 'product_package'), rows: [typeBase, weighed('b')], pkg: { box: [200, 200, 100] }, hash: HASH });
  const boxTaken = { flags: weightLeft, lines: products, wire: measuresWire('type_default', 'product_package'), pkg: { weight: 1250, box: [200, 200, 100] as [number, number, number] }, hash: HASH };
  seed('p_r_weight_above', { ...boxTaken, rows: [typeBase, weighed('b'), weighed('r')] });
  seed('p_r_weight_one_above', { ...boxTaken, rows: [typeBase, weighed('r')] });
  seed('p_r_box_above', {
    flags: defaults.slice(0, 1),
    lines: products,
    wire: measuresWire('product_package', 'type_default'),
    rows: [typeBase, { scope: 'color', id: 'r', box }, { scope: 'color', id: 'b', box }],
    pkg: { weight: 1300, box: [210, 210, 90] },
    hash: HASH,
  });
  seed('p_r_type_cbm_above', { flags: defaults.slice(0, 1), lines: owners, wire: typeCbm, rows: [ownerBase, { scope: 'color', id: 'r', box }, { scope: 'color', id: 'b', box }], hash: HASH });
  seed('p_r_type_cbm_packaged', { flags: defaults.slice(0, 1), lines: [['c:b', 'colour'], ['c:r', 'colour']], wire: typeCbm, rows: [ownerBase], hash: HASH });
  // The owner's own CBM at the product level beside the type's recorded box: that CBM decides the level whatever
  // the box, so putting the package's box in place of the type's takes nothing in.
  seed('p_r_owner_cbm', {
    flags: defaults.slice(0, 1),
    lines: products,
    wire: measuresWire('product_package', 'type_default'),
    rows: [{ ...typeBase, cbm: '0.004' }],
    pkg: { weight: 1300, box: [210, 210, 90] },
    hash: HASH,
  });
  seed('p_r_type_cbm_red_box', { flags: defaults.slice(0, 1), lines: owners, wire: typeCbm, rows: [ownerBase, { scope: 'color', id: 'r', box }], hash: HASH });

  const shown = new Map((await listEstimates(db, 'estimated', '')).products.map((p) => [p.product_id, p.flags] as const));
  assert.deepEqual(shown.get('p_s_fresh'), []);
  assert.deepEqual(shown.get('p_s_same'), [], 'a row written with the lines (the apply’s own batch)');
  assert.deepEqual(shown.get('p_s_after'), defaults);
  assert.deepEqual(shown.get('p_c_red_box'), [{ code: 'EST_DEFAULT_BOX', combo_keys: ['c:b'] }]);
  assert.deepEqual(shown.get('p_c_both_boxes'), []);
  const flagsTab = (await listEstimates(db, 'flags', '')).products.map((p) => p.product_id);
  assert.deepEqual(flagsTab.filter((p) => p.startsWith('p_s_') || p.startsWith('p_c_')), ['p_c_red_box', 'p_s_after']);
  const refresh = (await listEstimates(db, 'refresh', '')).products.map((p) => p.product_id);
  assert.deepEqual(refresh, ['p_r_moved', 'p_r_package', 'p_r_type_cbm', 'p_r_type_cbm_red_box', 'p_r_weight_one_above']);
  // §4.9's words read the same rule (`waiting_on_apply`).
  for (const pid of ['p_r_package', 'p_r_package_taken', 'p_r_weight_above', 'p_r_weight_one_above', 'p_r_box_above', 'p_r_owner_cbm', 'p_r_type_cbm_above', 'p_r_type_cbm_red_box']) {
    assert.equal((await refreshStateOf(db, pid)).listed, refresh.includes(pid), pid);
  }
});

test('«التحديث» and a default measure stored without its options (counted or bare): listed only while the apply puts the product’s package in place of the type’s default at the product level — never again once that apply is done', async () => {
  const w = world();
  const db = asD1(w.raw);
  const T1 = '2026-11-01T10:00:00.000Z';
  const HASH = 'b'.repeat(64);
  const typeBox: [number, number, number] = [200, 200, 100];
  type Field = { field: string; value: unknown; source?: string };
  interface Seeded {
    flags: unknown[];
    lines: string[];
    record: Field[];
    base: { weight?: number; box?: [number, number, number]; cbm?: string };
    pkg?: { weight?: number | null; box?: [number, number, number] | null };
  }
  const seed = (pid: string, s: Seeded) => {
    seedProduct(w.raw, pid, { weight: s.pkg?.weight ?? null, box: s.pkg?.box ?? null });
    const wire = { v: 1, inputs: s.record.map((f) => ({ scope: 'base', scope_id: '', source: 'type_default', ...f })), minimum_profit: null };
    w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, state, flags_json, preview_hash, computed_at, applied_at, applied_wire_json, version, updated_at)
                VALUES (${q(pid)}, 'filament', 'owner', 'estimated', ${q(JSON.stringify(s.flags))}, ${q(HASH)}, ${q(T1)}, ${q(T1)}, ${q(JSON.stringify(wire))}, 3, ${q(T1)})`);
    s.lines.forEach((measure, i) => {
      w.raw.exec(`INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, measure_source, flags_json, est_price_iqd, published_price_iqd, computed_at)
                  VALUES (${q(pid)}, ${q(`c:${pid}_${i}`)}, 'pre_order_sea', 'tmall_cn', ${q(measure)}, '[]', 20500, 20500, ${q(T1)})`);
    });
    w.raw.exec(`INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, shipping_weight_g, shipping_length_mm, shipping_width_mm, shipping_height_mm, manual_cbm, updated_at)
                VALUES (${q(pid)}, 'base', '', 'MANUAL_OVERRIDE', ${q(s.base.weight)}, ${q(s.base.box?.[0])}, ${q(s.base.box?.[1])}, ${q(s.base.box?.[2])}, ${q(s.base.cbm)}, ${q(T1)})`);
  };
  const weightCounted = [{ code: 'EST_DEFAULT_WEIGHT', count: 120 }];
  const boxCounted = [{ code: 'EST_DEFAULT_BOX', count: 140 }];
  const typeWeight: Field = { field: 'shipping_weight_g', value: 1300 };
  const someReal = ['product', 'type_default', 'type_default'];
  // The weight: the store still holds the type's (recorded), the product's package has one now, a line on it.
  seed('p_w_package', { flags: weightCounted, lines: someReal, record: [typeWeight], base: { weight: 1300 }, pkg: { weight: 1250 } });
  seed('p_w_bare', { flags: ['EST_DEFAULT_WEIGHT'], lines: someReal, record: [typeWeight], base: { weight: 1300 }, pkg: { weight: 1250 } });
  // The round-3 regression's state: the box was taken in by the apply (the package has a box only), the weight
  // stays the type's for most options: the next apply takes nothing in, so it is not offered.
  seed('p_w_box_taken', {
    flags: weightCounted,
    lines: someReal,
    record: [typeWeight, { field: 'shipping_box', value: typeBox, source: 'product_package' }],
    base: { weight: 1300, box: typeBox },
    pkg: { box: typeBox },
  });
  seed('p_w_no_package', { flags: weightCounted, lines: someReal, record: [typeWeight], base: { weight: 1300 } });
  // The owner's own base weight replaced the type's: the apply keeps it, nothing waits on it.
  seed('p_w_owner_base', { flags: weightCounted, lines: someReal, record: [typeWeight], base: { weight: 1240 }, pkg: { weight: 1250 } });
  // Every line still on the type's default: no option of it takes real measures in by that apply.
  seed('p_w_no_line', { flags: weightCounted, lines: ['type_default', 'type_default'], record: [typeWeight], base: { weight: 1300 }, pkg: { weight: 1250 } });
  seed('p_w_package_box_only', { flags: weightCounted, lines: someReal, record: [typeWeight], base: { weight: 1300 }, pkg: { box: [210, 210, 90] } });
  // The box: the type's box or the type's CBM still in the store, the product's package now has a whole box.
  seed('p_b_type_box', { flags: boxCounted, lines: someReal, record: [{ field: 'shipping_box', value: typeBox }], base: { box: typeBox }, pkg: { box: [210, 210, 90] } });
  seed('p_b_type_cbm', { flags: boxCounted, lines: someReal, record: [{ field: 'manual_cbm', value: '0.004' }], base: { cbm: '0.004' }, pkg: { box: [210, 210, 90] } });
  seed('p_b_taken', {
    flags: boxCounted,
    lines: someReal,
    record: [{ field: 'shipping_box', value: [210, 210, 90], source: 'product_package' }],
    base: { box: [210, 210, 90] },
    pkg: { box: [210, 210, 90] },
  });
  seed('p_b_package_weight_only', { flags: boxCounted, lines: someReal, record: [{ field: 'shipping_box', value: typeBox }], base: { box: typeBox }, pkg: { weight: 1250 } });
  seed('p_b_owner_box', { flags: boxCounted, lines: someReal, record: [{ field: 'shipping_box', value: typeBox }], base: { box: [220, 220, 90] }, pkg: { box: [210, 210, 90] } });

  const refresh = (await listEstimates(db, 'refresh', '')).products.map((p) => p.product_id);
  assert.deepEqual(refresh, ['p_b_type_box', 'p_b_type_cbm', 'p_w_bare', 'p_w_package']);
  // §4.9's words read the same rule (`waiting_on_apply`).
  for (const pid of ['p_w_package', 'p_w_box_taken', 'p_b_type_cbm', 'p_b_taken']) assert.equal((await refreshStateOf(db, pid)).listed, refresh.includes(pid), pid);
});

test('paging: import-created products and those the owner enrolled; a merged product only once enrolled; a bundle never', async () => {
  const w = world();
  seedThree(w.raw);
  seedProduct(w.raw, 'p_zz_merged', { match: 'merged' });
  seedProduct(w.raw, 'p_zz_loose', { match: null });
  const first = await call(w.app, 'POST', `${BASE}/compute`, {});
  assert.equal(first.status, 200);
  const ids = first.body.products.map((p: Json) => p.product_id);
  assert.ok(ids.includes('p_fil') && ids.includes('p_part') && ids.includes('p_prn'), ids.join(', '));
  assert.ok(!ids.includes('p_zz_merged') && !ids.includes('p_zz_loose'), 'never enrolled automatically');
  assert.equal(first.body.next_cursor, null);
  assert.equal(typeof first.body.spent, 'number');

  const bad = await call(w.app, 'POST', `${BASE}/compute`, { product_ids: Array.from({ length: 11 }, (_, i) => `p_${i}`) });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'PRICING_INPUT_INVALID');
  const unknown = await call(w.app, 'POST', `${BASE}/compute`, { product_ids: ['p_fil'], extra: 1 });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'UNKNOWN_FIELD');
});

test('the owner’s type table (version-fenced, audited, its rules held), the measure suggestion, and the two switches', async () => {
  const w = world();
  const types = (await call(w.app, 'GET', `${BASE}/types`)).body.types as Json[];
  const fil = types.find((t) => t.key === 'filament')!;
  assert.deepEqual([fil.sourcing, fil.route, fil.allow_air, fil.default_weight_g, fil.min_profit_usd], ['CHINA_CNY', 'sea', false, 1300, '2']);
  assert.equal(types.find((t) => t.key === 'hotend')!.min_profit_usd, null, 'the seed holds no figure');

  // An edit: version-fenced, its figures in pricing_audit (owner-only), names only in audit_log.
  const edit = await call(w.app, 'PUT', `${BASE}/types/filament`, { version: fil.version, min_profit_usd: '2.50', default_cbm: '0.0040', stale_after_days: 30 });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual([edit.body.type.min_profit_usd, edit.body.type.default_cbm, edit.body.type.stale_after_days, edit.body.type.version], ['2.5', '0.004', 30, fil.version + 1]);
  const audit = row<Json>(w.raw, "SELECT entity, action, product_id, pricing_before_json, pricing_after_json FROM pricing_audit WHERE entity_key = 'estimate_type:filament'")!;
  assert.deepEqual([audit.entity, audit.action, audit.product_id], ['rule', 'rule_set', null]);
  assert.equal(JSON.parse(audit.pricing_before_json).min_profit_usd, '2');
  assert.equal(JSON.parse(audit.pricing_after_json).min_profit_usd, '2.5');
  const log = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'price_estimate.type_set' AND target = 'filament'")!;
  assert.deepEqual(JSON.parse(log.detail), { key: 'filament', fields: ['default_cbm', 'min_profit_usd', 'stale_after_days'] }, 'names, never a figure');
  const stale = await call(w.app, 'PUT', `${BASE}/types/filament`, { version: fil.version, min_profit_usd: '3' });
  assert.deepEqual([stale.status, stale.body.code], [409, 'PRICING_CHANGED']);

  // The owner's rules: filament by sea only, the EU store by land only, air only where allowed.
  const v = fil.version + 1;
  for (const [key, body, code] of [
    ['filament', { version: v, route: 'air', allow_air: true }, 'PRICE_ESTIMATE_TYPE_RULE'],
    ['printer', { version: 1, route: 'sea' }, 'PRICE_ESTIMATE_TYPE_RULE'],
    ['spare_part', { version: 1, route: 'land' }, 'PRICE_ESTIMATE_TYPE_RULE'],
    ['filament', { version: v, default_length_mm: 100 }, 'PRICING_INPUT_INVALID'],
    ['filament', { version: v, min_profit_usd: '1.1234567' }, 'PRICING_INPUT_INVALID'],
    ['filament', { version: v, min_profit_usd: -1 }, 'PRICING_INPUT_INVALID'],
    ['filament', { version: v, sourcing: 'EU_STORE_EUR' }, 'UNKNOWN_FIELD'],
  ] as const) {
    const r = await call(w.app, 'PUT', `${BASE}/types/${key}`, body);
    assert.equal(r.body.code, code, `${key} ${JSON.stringify(body)}`);
  }
  const air = await call(w.app, 'PUT', `${BASE}/types/spare_part`, { version: 1, route: 'air' });
  assert.equal(air.status, 200, 'air where the type allows it');

  // A new type: every figure empty; its Sorani never the Arabic; a taken key refused.
  const created = await call(w.app, 'POST', `${BASE}/types`, { key: 'resin', name_ar: 'راتنج', name_en: 'Resin', name_ckb: 'ڕێزن', sourcing: 'CHINA_CNY', route: 'sea' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.type.min_profit_usd, created.body.type.default_weight_g], [null, null]);
  const copied = await call(w.app, 'POST', `${BASE}/types`, { key: 'resin_two', name_ar: 'راتنج', name_en: 'Resin', name_ckb: 'راتنج', sourcing: 'CHINA_CNY', route: 'sea' });
  assert.deepEqual([copied.status, copied.body.code], [400, 'PRICING_INPUT_INVALID']);
  const taken = await call(w.app, 'POST', `${BASE}/types`, { key: 'resin', name_ar: 'راتنج', name_en: 'Resin', name_ckb: 'ڕێزن', sourcing: 'CHINA_CNY', route: 'sea' });
  assert.equal(taken.status, 409);

  // The suggestion: the median of the REAL measures of the type's products — offered, never saved.
  for (const [id, wgt, box] of [
    ['p_s1', 300, [100, 100, 50]],
    ['p_s2', 500, [200, 100, 50]],
    ['p_s3', 900, [300, 200, 100]],
  ] as const) {
    seedProduct(w.raw, id, { weight: wgt, box: [...box] });
    w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES (${q(id)}, 'hotend', 'owner', ${q(NOW)})`);
  }
  const suggestion = await call(w.app, 'GET', `${BASE}/types/hotend/suggest`);
  assert.deepEqual(suggestion.body.suggestion, { key: 'hotend', count: 3, weight_g: 500, box: [200, 100, 50], cbm: '0.001' });
  assert.equal(row<Json>(w.raw, "SELECT default_weight_g FROM price_estimate_types WHERE key = 'hotend'")!.default_weight_g, null, 'nothing saved');

  // The switches: «apply» needs the published clause; «ordering» is the emergency brake. Neither asks for a
  // fresh sign-in (DECISIONS row 285): an hour-old session pulls the brake.
  const control = await call(w.app, 'GET', `${BASE}/control`);
  assert.deepEqual([control.body.control.apply_enabled, control.body.control.ordering_enabled, control.body.policy_ready], [true, true, true]);
  const old = stubApp(asD1(w.raw), OWNER, (a) => a.route(BASE, adminPriceEstimatesRoutes), { publishV2: false, sessionAgeSeconds: 3600 });
  const brake = await call(old, 'PUT', `${BASE}/control`, { version: control.body.control.version, ordering_enabled: false });
  assert.equal(brake.status, 200, JSON.stringify(brake.body));
  assert.deepEqual([brake.body.control.apply_enabled, brake.body.control.ordering_enabled], [true, false]);
  assert.equal(row<Json>(w.raw, 'SELECT ordering_enabled FROM price_estimate_control WHERE id = 1')!.ordering_enabled, 0);
  // Before the clause is in force (the purchase policy's effective date), «apply» cannot be switched on.
  w.raw.exec('UPDATE price_estimate_control SET apply_enabled = 0');
  const { estimatePolicyInForce, setControl } = await import('../worker/lib/pricingEngine/estimate/control');
  const effective = (await import('../worker/lib/policies')).getPolicyDocument('purchase')!.effective_at;
  const dayBefore = new Date(Date.parse(`${effective}T12:00:00Z`) - 86_400_000);
  assert.equal(estimatePolicyInForce(dayBefore.toISOString().slice(0, 10)), false);
  assert.equal(estimatePolicyInForce(effective), true);
  const version = row<Json>(w.raw, 'SELECT version FROM price_estimate_control WHERE id = 1')!.version as number;
  await assert.rejects(setControl(asD1(w.raw), { version, apply_enabled: true }, 'usr_owner', dayBefore), (e: Json) => e.code === 'PRICE_ESTIMATE_POLICY_MISSING');
  assert.equal(row<Json>(w.raw, 'SELECT apply_enabled FROM price_estimate_control WHERE id = 1')!.apply_enabled, 0);
});

test('the door: every caller but the owner is refused in the same bytes; 503 PRICE_ESTIMATES_NOT_INSTALLED without 0218', async () => {
  const w = world();
  seedThree(w.raw);
  const owner = await call(w.app, 'POST', `${BASE}/compute`, { product_ids: ['p_fil'] });
  assert.equal(owner.status, 200);
  const bodies = new Set<string>();
  for (const user of [FULL, { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' } as StubUser]) {
    for (const [method, path] of [
      ['POST', `${BASE}/compute`],
      ['GET', `${BASE}/products/p_fil`],
      ['GET', `${BASE}/products/zz-invented`],
      ['GET', `${BASE}/types`],
      ['POST', `${BASE}/apply`],
    ] as const) {
      const r = await call(appAs(w.raw, user), method, path, {});
      assert.equal(r.status, 403, `${user.id} ${method} ${path}`);
      bodies.add(JSON.stringify(r.body));
    }
  }
  assert.equal(bodies.size, 1, 'the same bytes for every route, real id or invented');
  assert.doesNotMatch([...bodies][0]!, /p_fil|20500|17056|filament/);

  // Through 0217: no estimate table. After the door, the owner hears 503.
  const old = dbThrough('0217');
  const r = await call(appAs(old), 'POST', `${BASE}/compute`, {});
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'PRICE_ESTIMATES_NOT_INSTALLED');
});

test('the type from the import (§3.8 rung 3): a spare part whose name is an electronic part is EU-sourced by land; the owner’s choice wins over it', async () => {
  const w = world();
  w.raw.exec(`UPDATE price_estimate_types SET min_profit_usd = '30' WHERE key = 'electronics_part'`);
  w.raw.exec("INSERT INTO catalog_import_runs (id, source, state) VALUES ('cir_000000000000000000000001', 'bambu_us', 'closed')");
  for (const [id, name, type] of [
    ['p_ap', 'AP board for X1 series', 'spare_part'],
    ['p_cover', 'Front cover for X1 series', 'spare_part'],
  ] as const) {
    seedProduct(w.raw, id, { name, weight: 300, box: [200, 150, 30] });
    // A COMPLETE item of a closed run, staged as the import leaves it (the item graph's insert trigger lifted for it alone).
    withoutTriggers(
      w.raw,
      ['trg_cii_insert'],
      `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, product_type, queue_position, discovered_at,
                                         processing_state, match_kind, levonis_product_id, live_url, verified_at, d1_checks, edge_evidence, completed_at)
       VALUES (${q(`cii_${id}`)}, 'cir_000000000000000000000001', 'bambu_us', ${q(`sp_${id}`)}, ${q(`h-${id}`)}, ${q(`https://us.store.bambulab.com/products/h-${id}`)},
               ${q(type)}, ${id === 'p_ap' ? 1 : 2}, ${q(NOW)}, 'COMPLETE', 'created', ${q(id)}, ${q(`https://levonis-iq.com/products/slug-${id}`)}, ${q(NOW)}, '{"ok":1}', '{"ok":1}', ${q(NOW)})`
    );
  }
  typed(w.raw, 'p_ap', '', '49', 'EUR');
  w.raw.exec(`UPDATE price_estimate_types SET min_profit_usd = '3' WHERE key = 'spare_part'`);
  tmall(w.raw, 'p_cover', '', '25', { item: '9000000000001', sku: '9000000000002' });
  const p = byId((await call(w.app, 'POST', `${BASE}/compute`, { product_ids: ['p_ap', 'p_cover'] })).body.products);
  const ap = p.get('p_ap')!;
  assert.deepEqual([ap.type, ap.type_source, ap.sourcing, ap.route, ap.currency], ['electronics_part', 'import_type', 'EU_STORE_EUR', 'land', 'EUR']);
  // EUR 49 × 1,760 = 86,240 + 0.3 kg × 3,200 = 960 → R 87,200; + $30 = 48,000 → 135,200 → 135,250.
  assert.deepEqual(ap.lines.map((l: Json) => [l.channel, l.est_cost_iqd, l.est_price_iqd]), [['pre_order_land', 87_200, 135_250]]);
  const cover = p.get('p_cover')!;
  assert.deepEqual([cover.type, cover.type_source, cover.sourcing, cover.route], ['spare_part', 'import_type', 'CHINA_CNY', 'sea'], 'a cover is not an electronic part');

  // The owner's choice is the first source (§3.8 rung 1): the next compute uses it, and keeps it.
  const version = row<Json>(w.raw, "SELECT version FROM product_price_estimates WHERE product_id = 'p_cover'")!.version as number;
  const chosen = await call(w.app, 'PUT', `${BASE}/products/p_cover`, { version, type_key: 'accessory' });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  w.raw.exec(`UPDATE price_estimate_types SET min_profit_usd = '3' WHERE key = 'accessory'`);
  const again = byId((await call(w.app, 'POST', `${BASE}/compute`, { product_ids: ['p_cover'] })).body.products).get('p_cover')!;
  assert.deepEqual([again.type, again.type_source], ['accessory', 'owner']);
});
