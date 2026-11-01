/**
 * «طبّق» — THE ESTIMATE APPLY: ONE ATOMIC BATCH PER PRODUCT (docs/SMART_PRICING.md §4.7, §4.8; WP6).
 *
 * On the pricing world (U = 1,600; CNY/USD 0.14; China sea 400,000 IQD/m³) with a PLA the Bambu import
 * created — two colours, direct sale only, no stock, no price, no measures — priced from a confirmed Tmall
 * offer at 69 CNY and the filament defaults (1,300 g, 200 × 200 × 100 mm, $2): D = 20,500 IQD.
 *
 *   - ONE batch: the never-on-published fence; the no-stock fence; «بلا تتبّع» BEFORE the writer's import
 *     fence; the pre-order structure on ONE route (`planProductSave`, under the token); the inputs (their
 *     `source_ref` the snapshot), the product's minimum-profit rule and the prices; then — after the state
 *     row and the price-request transitions, inside the `engine-price:` token — the label and the
 *     bookkeeping; the type defaults never reach `products.package_*`;
 *   - NO UNLABELLED WINDOW: the batch that writes the first price is the batch that sets the label; a
 *     failed batch leaves neither; the label cannot be set outside a price write (T1);
 *   - refusals, one product at a time: a stale hash answers the fresh preview; a replay answers `already`;
 *     a firm V2 price (also when it lands between the read and the write: the fence); a stocked, celled or
 *     merged product is never restructured (also when stock lands between: the fence); an incomplete one;
 *     «apply» off;
 *   - a product already pre-order-only on its route is priced with no structure written;
 *   - a refresh keeps the owner's correction (EST_OWNER_EDITED) and writes only what the estimator owns;
 *   - the admin product read tells any admin the label and the state — never a figure — and null without 0218.
 *
 * Run: node --import tsx --test tests/priceEstimateApply.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, dbThrough, failingD1, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { writeV2 } from './fixtures/pricingV2';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { adminProductsRoutes } from '../worker/routes/adminProducts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const mount = (db: unknown, user: StubUser | null = OWNER) =>
  stubApp(
    db,
    user,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(BASE, adminPriceEstimatesRoutes);
      a.route('/api/admin/products-v2', adminProductsRoutes);
    },
    { publishV2: false }
  );

interface Seed {
  colours?: string[];
  weight?: number | null;
  box?: [number, number, number] | null;
  match?: 'created' | 'merged' | null;
  saleTypes?: string[];
  routes?: Array<{ method: string; commission_iqd: number; active: boolean }>;
}

function seedProduct(raw: DatabaseSync, id: string, o: Seed = {}): void {
  const box = o.box ?? null;
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
    VALUES (${q(id)}, ${q(`slug-${id}`)}, ${q(`Product ${id}`)}, 'منتج', 'بەرهەم', 'active', 0, NULL,
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
                      ${q(match === 'created' ? 'not_configured' : 'not_required')}, 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001')`);
  }
}

let skuSeq = 0;
function tmall(raw: DatabaseSync, pid: string, combo: string, price: string, item: string, category = ''): string {
  const sku = `${item}${++skuSeq}`;
  raw.exec(`
    INSERT OR IGNORE INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', ${q(item)}, 'item', ${q(category)});
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', ${q(item)}, ${q(sku)}, ${q(price)});
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES (${q(pid)}, ${q(combo)}, 'tmall_cn', ${q(item)}, ${q(sku)}, 'exact', 'owner', 'confirmed', 'usr_owner', ${q(NOW)}, 'sps_tmall', ${q(NOW)});
  `);
  return sku;
}

const typed = (raw: DatabaseSync, pid: string, combo: string, amount: string, currency: string) =>
  raw.exec(`INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at)
            VALUES (${q(pid)}, ${q(combo)}, ${q(amount)}, ${q(currency)}, 'typed', 'usr_owner', ${q(NOW)})`);

function world() {
  const w = pricingWorld();
  w.raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 1300, default_length_mm = 200, default_width_mm = 200, default_height_mm = 100, min_profit_usd = '2' WHERE key = 'filament';
    UPDATE price_estimate_types SET min_profit_usd = '30' WHERE key = 'electronics_part';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', ${q(TODAY)}, ${q('a'.repeat(64))}, 'complete', 'usr_owner', ${q(NOW)}, ${q(NOW)});
  `);
  seedProduct(w.raw, 'p_fil', { colours: ['red', 'black'] });
  tmall(w.raw, 'p_fil', 'c:p_fil_red', '69', '1053109777521', 'filament');
  tmall(w.raw, 'p_fil', 'c:p_fil_black', '69', '1053109777521', 'filament');
  return w;
}

async function call(app: ReturnType<typeof mount>, path: string, body?: unknown) {
  const res = body === undefined ? await get(app, path) : await post(app, path, body);
  return { status: res.status, body: (await json(res)) as Json };
}

async function compute(app: ReturnType<typeof mount>, ids: string[]): Promise<Map<string, Json>> {
  const r = await call(app, `${BASE}/compute`, { product_ids: ids });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  return new Map((r.body.products as Json[]).map((p) => [p.product_id as string, p] as const));
}

async function apply(app: ReturnType<typeof mount>, items: Json[]) {
  const r = await call(app, `${BASE}/apply`, { items });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  return new Map((r.body.results as Json[]).map((x) => [x.product_id as string, x] as const));
}

/** Everything an apply writes for a product (to prove a refused one wrote nothing). */
const written = (raw: DatabaseSync, pid: string) =>
  JSON.stringify(
    ['pricing_inputs', 'pricing_rules', 'pricing_v2_sku_results', 'product_pricing_state', 'product_sku_prices', 'price_history', 'products', 'product_source_refs', 'price_estimate_firm_skus'].map((t) => [
      t,
      all(raw, `SELECT * FROM ${t} WHERE ${t === 'products' ? 'id' : 'product_id'} = ? ORDER BY rowid`, pid),
    ])
  );

test('ONE batch: fences, «بلا تتبّع» before the import fence, the structure on one route, inputs, rule and prices, then the label and the bookkeeping inside the token', async () => {
  const w = world();
  const { failing, db } = failingD1(w.raw);
  const captured: string[][] = [];
  failing.beforeBatch = (s) => captured.push(s.map((x) => `${x.sql.replace(/\s+/g, ' ').trim()} ${JSON.stringify(x.params)}`));
  const app = mount(db);
  const preview = (await compute(app, ['p_fil'])).get('p_fil')!;
  captured.length = 0;
  const out = (await apply(app, [{ product_id: 'p_fil', preview_hash: preview.preview_hash }])).get('p_fil')!;
  assert.equal(out.outcome, 'applied', JSON.stringify(out).slice(0, 300));
  assert.equal(out.preview.state, 'estimated');
  assert.equal(out.preview.label, true);

  // Exactly ONE batch carries the price: the results, the label and the decision together.
  const priced = captured.filter((b) => b.some((s) => s.startsWith('INSERT INTO pricing_v2_sku_results')));
  assert.equal(priced.length, 1, 'one batch writes the prices');
  const b = priced[0]!;
  const at = (re: RegExp, from = 0) => {
    const i = b.findIndex((s, k) => k >= from && re.test(s));
    assert.ok(i >= 0, `the batch carries ${re}`);
    return i;
  };
  const neverPublished = at(/^INSERT INTO ops_guards\(id,ok\) SELECT \?, CASE WHEN EXISTS \(SELECT 1 FROM products WHERE id = \? AND price_estimate = 1\) OR NOT EXISTS \(SELECT 1 FROM pricing_v2_sku_results/);
  const noStock = at(/^INSERT INTO ops_guards\(id,ok\) SELECT \?, CASE WHEN NOT EXISTS \(SELECT 1 FROM products WHERE id = \? AND stock IS NOT NULL\)/);
  const untracked = at(/^UPDATE product_source_refs SET stock_decision = 'untracked'/);
  const importFence = at(/^INSERT INTO ops_guards \(id, ok\) SELECT \?, NULL WHERE NOT NOT EXISTS/);
  const token = at(/^INSERT INTO ops_guards \(id, ok\) VALUES \(\?, 1\) \["engine-price:p_fil"\]/);
  const structure = at(/^UPDATE products SET /, token);
  const results = at(/^INSERT INTO pricing_v2_sku_results/);
  const state = at(/^UPDATE product_pricing_state SET mode = 'engine'/);
  const preorderFence = at(/sale_types LIKE '%"pre_order"%'/, state);
  const label = at(/^UPDATE products SET price_estimate = 1 WHERE id = \? AND price_estimate = 0/);
  const bookkeeping = at(/^INSERT INTO product_price_estimates/);
  const audit = at(/^INSERT INTO pricing_audit/, label);
  const release = at(/^DELETE FROM ops_guards WHERE id = \? \["engine-price:p_fil"\]/);
  assert.ok(neverPublished < noStock && noStock < untracked && untracked < importFence, 'the fences, then the decision, then the writer’s import fence');
  assert.ok(importFence < token && token < structure && structure < results && results < state, 'the structure under the token, before the prices');
  assert.ok(state < preorderFence && preorderFence < label && label < bookkeeping && bookkeeping < audit && audit < release, 'the label after 9b, before the audit, inside the token');

  // The product: pre-order only on ONE route at 0 commission; the defaults never reach its package columns.
  const p = row<Json>(w.raw, 'SELECT sale_types, selling_type, preorder_transports, price_estimate, package_weight_g, package_depth_mm FROM products WHERE id = ?', 'p_fil')!;
  assert.deepEqual(JSON.parse(p.sale_types), ['pre_order']);
  assert.equal(p.selling_type, 'pre_order');
  assert.deepEqual(JSON.parse(p.preorder_transports), [{ method: 'sea', commission_iqd: 0, active: true }]);
  assert.equal(p.price_estimate, 1);
  assert.equal(p.package_weight_g, null, 'a type default is a private input only');
  assert.equal(p.package_depth_mm, null);

  // «بلا تتبّع», with who and when, and its audit row.
  const ref = row<Json>(w.raw, 'SELECT stock_decision, stock_decided_by, stock_decided_at FROM product_source_refs WHERE product_id = ?', 'p_fil')!;
  assert.deepEqual([ref.stock_decision, ref.stock_decided_by], ['untracked', 'usr_owner']);
  assert.ok(ref.stock_decided_at);
  const decision = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'product.import_stock_decision' AND target = 'p_fil'")!;
  assert.deepEqual(JSON.parse(decision.detail), { product_id: 'p_fil', before: 'not_configured', after: 'untracked', source: 'estimate_apply' });

  // The inputs (the snapshot as their source), the product's own minimum profit, the prices.
  const inputs = all<Json>(w.raw, "SELECT scope, supplier_cost_amount, supplier_cost_currency, shipping_profile, shipping_weight_g, shipping_length_mm, shipping_width_mm, shipping_height_mm, manual_cbm, source_ref FROM pricing_inputs WHERE product_id = 'p_fil'");
  assert.deepEqual(inputs, [
    { scope: 'base', supplier_cost_amount: '69', supplier_cost_currency: 'CNY', shipping_profile: 'CHINA_SEA', shipping_weight_g: 1300, shipping_length_mm: 200, shipping_width_mm: 200, shipping_height_mm: 100, manual_cbm: null, source_ref: 'estimate:sps_tmall' },
  ]);
  assert.deepEqual(all<Json>(w.raw, "SELECT kind, scope, state, amount_usd FROM pricing_rules WHERE product_id = 'p_fil'"), [{ kind: 'target_profit', scope: 'product', state: 'ACTIVE', amount_usd: '2' }]);
  assert.deepEqual(all<Json>(w.raw, "SELECT combo_key, channel, final_price_iqd, replacement_cost_iqd FROM pricing_v2_sku_results WHERE product_id = 'p_fil' ORDER BY combo_key"), [
    { combo_key: 'c:p_fil_black', channel: 'pre_order_sea', final_price_iqd: 20_500, replacement_cost_iqd: 17_056 },
    { combo_key: 'c:p_fil_red', channel: 'pre_order_sea', final_price_iqd: 20_500, replacement_cost_iqd: 17_056 },
  ]);
  const st = row<Json>(w.raw, "SELECT mode, pricing_method, write_seq FROM product_pricing_state WHERE product_id = 'p_fil'")!;
  assert.deepEqual([st.mode, st.pricing_method], ['engine', 'cost']);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM price_history WHERE product_id = 'p_fil'"), 2);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit WHERE idempotency_key = ?', `v2price:p_fil:${preview.preview_hash}`), 1);

  // The bookkeeping: estimated, what was written and from where (the three-way merge's record), the lines.
  const e = row<Json>(w.raw, "SELECT * FROM product_price_estimates WHERE product_id = 'p_fil'")!;
  assert.deepEqual([e.state, e.type_key, e.measure_basis, e.applied_by, e.applied_write_seq], ['estimated', 'filament', 'type_default', 'usr_owner', st.write_seq]);
  const wire = JSON.parse(e.applied_wire_json);
  assert.deepEqual(
    (wire.inputs as Json[]).map((f) => [f.scope, f.field, f.source]),
    [
      ['base', 'supplier_cost', 'tmall_cn'],
      ['base', 'shipping_profile', 'type_default'],
      ['base', 'shipping_weight_g', 'type_default'],
      ['base', 'shipping_box', 'type_default'],
    ]
  );
  assert.deepEqual(wire.minimum_profit, { amount_usd: '2', source: 'type_default' });
  assert.deepEqual(JSON.parse(e.flags_json).map((f: Json) => f.code), ['EST_DEFAULT_BOX', 'EST_DEFAULT_WEIGHT']);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM price_estimate_lines WHERE product_id = 'p_fil' AND est_price_iqd = 20500"), 2);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0, 'every token released');

  // A replay of the same reviewed hash answers as the first did.
  const again = (await apply(app, [{ product_id: 'p_fil', preview_hash: preview.preview_hash }])).get('p_fil')!;
  assert.equal(again.outcome, 'already');
});

test('no unlabelled window: a failed batch leaves neither price nor label; the label is never set outside a price write (T1)', async () => {
  const w = world();
  const { failing, db } = failingD1(w.raw);
  const app = mount(db);
  const preview = (await compute(app, ['p_fil'])).get('p_fil')!;
  const before = written(w.raw, 'p_fil');
  failing.failWhen = (s) => s.some((x) => /price_estimate = 1/.test(x.sql));
  const res = await call(app, `${BASE}/apply`, { items: [{ product_id: 'p_fil', preview_hash: preview.preview_hash }] });
  assert.equal(res.status, 500, 'an unknown failure is not answered as a refusal');
  assert.equal(written(w.raw, 'p_fil'), before, 'nothing of the batch landed: no price, no label, no decision');
  assert.equal(row<Json>(w.raw, "SELECT state FROM product_price_estimates WHERE product_id = 'p_fil'")!.state, 'candidate');

  // The database's own rule: the label is set only inside a price write (T1).
  assert.throws(() => w.raw.exec("UPDATE products SET price_estimate = 1 WHERE id = 'p_fil'"), /PRICE_ESTIMATE_LABEL_OUTSIDE_PRICE_WRITE/);
  failing.failWhen = null;
  const ok = (await apply(app, [{ product_id: 'p_fil', preview_hash: preview.preview_hash }])).get('p_fil')!;
  assert.equal(ok.outcome, 'applied');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_v2_sku_results r JOIN products p ON p.id = r.product_id WHERE r.product_id = 'p_fil' AND p.price_estimate = 1"), 2);
});

test('refusals one product at a time: a stale hash answers the fresh preview; a firm price and stock are refused before the write and by the fences in it', async () => {
  const w = world();
  seedProduct(w.raw, 'p_part', { weight: 500, box: [100, 100, 50] });
  w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_part', 'spare_part', 'owner', ${q(NOW)});
              UPDATE price_estimate_types SET min_profit_usd = '3' WHERE key = 'spare_part';`);
  tmall(w.raw, 'p_part', '', '40', '2000000000001');
  const { failing, db } = failingD1(w.raw);
  const app = mount(db);
  const previews = await compute(app, ['p_fil', 'p_part']);

  // The supplier price moved after the review: the old hash is stale; the answer carries the fresh preview.
  w.raw.exec("UPDATE supplier_price_skus SET price = '72' WHERE item_key = '1053109777521'");
  const before = written(w.raw, 'p_fil');
  const out = await apply(app, [
    { product_id: 'p_fil', preview_hash: previews.get('p_fil')!.preview_hash },
    { product_id: 'p_part', preview_hash: previews.get('p_part')!.preview_hash },
  ]);
  const stale = out.get('p_fil')!;
  assert.deepEqual([stale.outcome, stale.code], ['refused', 'PRICING_PREVIEW_STALE']);
  const fresh = stale.details.preview;
  assert.notEqual(fresh.preview_hash, previews.get('p_fil')!.preview_hash);
  // 72 × 224 + 1,600 = 17,728; + $2 × 1,600 = 20,928 → 21,000.
  assert.deepEqual(fresh.lines.map((l: Json) => l.est_price_iqd), [21_000, 21_000]);
  assert.equal(written(w.raw, 'p_fil'), before, 'the stale product wrote nothing');
  assert.equal(out.get('p_part')!.outcome, 'applied', 'one product’s refusal never stops the others');

  // Stock lands between the read and the write: the fence in the batch refuses it whole.
  failing.beforeBatch = (s) => {
    if (s.some((x) => x.sql.startsWith('INSERT INTO pricing_v2_sku_results'))) w.raw.exec("UPDATE product_colors SET stock = 5 WHERE id = 'p_fil_red'");
  };
  const raced = (await apply(app, [{ product_id: 'p_fil', preview_hash: fresh.preview_hash }])).get('p_fil')!;
  assert.deepEqual([raced.outcome, raced.code], ['refused', 'PRICING_CHANGED']);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = 'p_fil'"), 0);
  assert.equal(row<Json>(w.raw, "SELECT stock_decision FROM product_source_refs WHERE product_id = 'p_fil'")!.stock_decision, 'not_configured');
  failing.beforeBatch = null;
  // Stocked now: never restructured — refused before any write.
  const stocked = (await apply(app, [{ product_id: 'p_fil', preview_hash: fresh.preview_hash }])).get('p_fil')!;
  assert.deepEqual([stocked.outcome, stocked.code], ['refused', 'PRICE_ESTIMATE_NOT_ELIGIBLE']);
  assert.ok(stocked.details.flags.includes('EST_STRUCTURE_OWNER'));
  w.raw.exec("UPDATE product_colors SET stock = NULL WHERE id = 'p_fil_red'");

  // A firm V2 price lands between the read and the write (another door published it): never-on-published, in the batch.
  await writeV2(w.db, AMS, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '300' }] });
  const cols = all<{ name: string }>(w.raw, 'PRAGMA table_info(pricing_v2_sku_results)').map((c) => c.name);
  failing.beforeBatch = (s) => {
    if (!s.some((x) => x.sql.startsWith('INSERT INTO pricing_v2_sku_results'))) return;
    w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:p_fil', 1);
      INSERT INTO pricing_v2_sku_results (${cols.join(', ')}) SELECT ${cols.map((c) => (c === 'product_id' ? "'p_fil'" : c)).join(', ')} FROM pricing_v2_sku_results WHERE product_id = '${AMS}' LIMIT 1;
      DELETE FROM ops_guards WHERE id = 'engine-price:p_fil';`);
  };
  const firm = (await apply(app, [{ product_id: 'p_fil', preview_hash: fresh.preview_hash }])).get('p_fil')!;
  assert.deepEqual([firm.outcome, firm.code], ['refused', 'PRICING_CHANGED']);
  assert.equal(row<Json>(w.raw, "SELECT price_estimate FROM products WHERE id = 'p_fil'")!.price_estimate, 0, 'a firm price is never turned into an estimate');
  failing.beforeBatch = null;
  // And refused before the write once it is there.
  const after = (await apply(app, [{ product_id: 'p_fil', preview_hash: fresh.preview_hash }])).get('p_fil')!;
  assert.deepEqual([after.outcome, after.code], ['refused', 'PRICE_ESTIMATE_NOT_ELIGIBLE']);
  assert.ok(after.details.flags.includes('EST_FIRM_PRICE'));
});

test('an incomplete product, a merged product and «apply» off are refused; a product already pre-order-only on its route is priced with no structure written', async () => {
  const w = world();
  const app = mount(asD1(w.raw));
  // One colour with no price: incomplete.
  seedProduct(w.raw, 'p_half', { colours: ['red', 'black'] });
  tmall(w.raw, 'p_half', 'c:p_half_red', '69', '4000000000001', 'filament');
  // The owner's existing listing, merged by the import: its structure is the owner's.
  seedProduct(w.raw, 'p_merged', { match: 'merged', weight: 2000, box: [300, 200, 200] });
  w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_merged', 'electronics_part', 'owner', ${q(NOW)})`);
  typed(w.raw, 'p_merged', '', '399', 'EUR');
  // Owner-built, already pre-order-only by land.
  seedProduct(w.raw, 'p_ready', { match: null, weight: 2000, box: [300, 200, 200], saleTypes: ['pre_order'], routes: [{ method: 'land', commission_iqd: 0, active: true }] });
  w.raw.exec(`INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_ready', 'electronics_part', 'owner', ${q(NOW)})`);
  typed(w.raw, 'p_ready', '', '399', 'EUR');
  const previews = await compute(app, ['p_half', 'p_merged', 'p_ready']);
  const forged = 'f'.repeat(64);
  const readyRow = row<Json>(w.raw, "SELECT sale_types, selling_type, preorder_transports FROM products WHERE id = 'p_ready'")!;

  // «apply» off: the whole call is refused.
  w.raw.exec('UPDATE price_estimate_control SET apply_enabled = 0');
  const off = await call(app, `${BASE}/apply`, { items: [{ product_id: 'p_ready', preview_hash: previews.get('p_ready')!.preview_hash }] });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, 'PRICE_ESTIMATES_DISABLED');
  w.raw.exec('UPDATE price_estimate_control SET apply_enabled = 1');

  const out = await apply(app, [
    { product_id: 'p_half', preview_hash: forged },
    { product_id: 'p_merged', preview_hash: forged },
    { product_id: 'p_ready', preview_hash: previews.get('p_ready')!.preview_hash },
  ]);
  assert.deepEqual([out.get('p_half')!.outcome, out.get('p_half')!.code], ['refused', 'PRICE_ESTIMATE_NOT_ELIGIBLE']);
  assert.ok(out.get('p_half')!.details.flags.includes('EST_NO_PRICE'));
  assert.ok(out.get('p_merged')!.details.flags.includes('EST_STRUCTURE_OWNER'));
  assert.equal(row<Json>(w.raw, "SELECT sale_types FROM products WHERE id = 'p_merged'")!.sale_types, '["direct_sale"]', 'the merged listing is untouched');
  assert.equal(out.get('p_ready')!.outcome, 'applied', JSON.stringify(out.get('p_ready')).slice(0, 300));
  // No structure written: the row's sale types and routes are as they were; the price and the label are there.
  assert.deepEqual(row<Json>(w.raw, "SELECT sale_types, selling_type, preorder_transports FROM products WHERE id = 'p_ready'"), readyRow);
  assert.equal(row<Json>(w.raw, "SELECT price_estimate FROM products WHERE id = 'p_ready'")!.price_estimate, 1);
  assert.deepEqual(all<Json>(w.raw, "SELECT channel, final_price_iqd FROM pricing_v2_sku_results WHERE product_id = 'p_ready'"), [{ channel: 'pre_order_land', final_price_iqd: 756_750 }]);

  // Bad bodies: more than five items, a duplicate, an unknown key.
  const six = Array.from({ length: 6 }, (_, i) => ({ product_id: `p_${i}`, preview_hash: forged }));
  assert.equal((await call(app, `${BASE}/apply`, { items: six })).status, 400);
  assert.equal((await call(app, `${BASE}/apply`, { items: [{ product_id: 'p_ready', preview_hash: forged }, { product_id: 'p_ready', preview_hash: forged }] })).status, 400);
  assert.equal((await call(app, `${BASE}/apply`, { items: [{ product_id: 'p_ready', preview_hash: forged, x: 1 }] })).body.code, 'UNKNOWN_FIELD');
});

test('a refresh keeps the owner’s correction (EST_OWNER_EDITED) and rewrites only what the estimator owns', async () => {
  const w = world();
  const app = mount(asD1(w.raw));
  const first = (await compute(app, ['p_fil'])).get('p_fil')!;
  assert.equal((await apply(app, [{ product_id: 'p_fil', preview_hash: first.preview_hash }])).get('p_fil')!.outcome, 'applied');
  // The owner corrects the weight in the product form (the base field is his from now on): the V2 door itself.
  const stored = await json(await get(app, '/api/admin/products-v2/p_fil/pricing'));
  const pricing = { cost: { inputs: [{ scope: 'base', shipping_weight_g: 1250 }] } };
  const sheet = await json(await put(app, '/api/admin/products-v2/p_fil/pricing', { seq: stored.seq, pricing }));
  assert.equal(sheet.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(sheet).slice(0, 300));
  const saved = await put(app, '/api/admin/products-v2/p_fil/pricing', { seq: stored.seq, pricing, preview_hash: sheet.details.preview.review_hash });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())).slice(0, 300));
  assert.equal(row<Json>(w.raw, "SELECT price_estimate FROM products WHERE id = 'p_fil'")!.price_estimate, 1, 'a form save never touches the label');
  // …and the supplier's price moves (a new capture).
  w.raw.exec("UPDATE supplier_price_skus SET price = '72' WHERE item_key = '1053109777521'");
  const refresh = (await compute(app, ['p_fil'])).get('p_fil')!;
  const edited = refresh.flags.find((f: Json) => f.code === 'EST_OWNER_EDITED');
  assert.deepEqual(edited?.fields, ['shipping_weight_g'], 'field names only');
  assert.equal(refresh.blocking, false);
  assert.ok(refresh.lines.every((l: Json) => l.published_price_iqd === 20_500 && l.est_price_iqd === 21_000), JSON.stringify(refresh.lines));
  const out = (await apply(app, [{ product_id: 'p_fil', preview_hash: refresh.preview_hash }])).get('p_fil')!;
  assert.equal(out.outcome, 'applied', JSON.stringify(out).slice(0, 300));
  const base = row<Json>(w.raw, "SELECT supplier_cost_amount, shipping_weight_g FROM pricing_inputs WHERE product_id = 'p_fil' AND scope = 'base'")!;
  assert.deepEqual(base, { supplier_cost_amount: '72', shipping_weight_g: 1250 }, 'the new price written, the owner’s weight kept');
  assert.equal(row<Json>(w.raw, "SELECT price_estimate FROM products WHERE id = 'p_fil'")!.price_estimate, 1, 'the label stays');
});

test('the admin product read: any admin sees whether the price is an estimate and its state — never a figure; null without 0218', async () => {
  const w = world();
  const app = mount(asD1(w.raw));
  const preview = (await compute(app, ['p_fil'])).get('p_fil')!;
  assert.equal((await apply(app, [{ product_id: 'p_fil', preview_hash: preview.preview_hash }])).get('p_fil')!.outcome, 'applied');
  const FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
  const staff = stubApp(asD1(w.raw), FULL, (a) => a.route('/api/admin/products-v2', adminProductsRoutes), { publishV2: false });
  const read = await json(await get(staff, '/api/admin/products-v2/p_fil'));
  assert.deepEqual(read.price_estimate, { label: true, state: 'estimated' });
  assert.doesNotMatch(JSON.stringify(read.price_estimate), /tmall|filament|20500|17056|EST_/);
  assert.deepEqual((await json(await get(staff, `/api/admin/products-v2/${AMS}`))).price_estimate, { label: false, state: null });

  // A database without 0218: no column, no table — the read answers null and nothing breaks.
  const old = dbThrough('0217');
  old.exec(`INSERT INTO products (id, slug, name, status) VALUES ('p_old', 'p-old', 'Old', 'active')`);
  const legacy = stubApp(asD1(old), FULL, (a) => a.route('/api/admin/products-v2', adminProductsRoutes), { publishV2: false });
  const res = await get(legacy, '/api/admin/products-v2/p_old');
  assert.equal(res.status, 200);
  assert.equal((await json(res)).price_estimate, null);
});
