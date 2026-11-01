/**
 * FX-5 AND AN ESTIMATE (docs/SMART_PRICING.md §4.10; WP6).
 *
 * An estimate is an ordinary V2 cost-first price, so the automatic repricing
 * (worker/lib/pricingEngine/autoReprice.ts) follows it when a rate or a freight
 * rate moves — through the V2 writer, prices only — and never touches the
 * label or the owner's bookkeeping (it lays no estimate statement). On a PLA
 * at 69 CNY by sea (the filament defaults, $2) and a printer typed at EUR 1,599
 * by land ($50, 25,000 IQD extra):
 *
 *   - CNY/USD 0.14 → 0.145 moves the PLA only: 69 × 232 + 1,600 + 3,200 =
 *     20,808 → 21,000; the label stays, the bookkeeping is untouched;
 *   - EUR/USD 1.1 → 1.12 moves the printer only: 1,599 × 1,792 + 64,000 +
 *     25,000 + 80,000 = 3,034,408 → 3,034,500;
 *   - U and the China sea freight rate move what they price;
 *   - a change above 15% is HELD (PRICING_V2_LARGE_CHANGE), the price stays at
 *     the last good write, and the estimator lists it (EST_LARGE_CHANGE_HELD,
 *     the line `large`); the owner's refresh needs the tick and a fresh sign-in,
 *     and then publishes it — still labelled.
 *
 * Run: node --import tsx --test tests/priceEstimateFx5.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, get, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { applyRate, fxEnv } from './fixtures/fx';
import { pricingWorld } from './fixtures/procurementPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { repriceStaleEngineProducts } from '../worker/lib/pricingEngine/autoReprice';
import { statementBudget } from '../worker/lib/fx/budget';
import type { Env } from '../worker/lib/types';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const mount = (raw: DatabaseSync, sessionAgeSeconds = 0) =>
  stubApp(
    asD1(raw),
    OWNER,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(BASE, adminPriceEstimatesRoutes);
    },
    { publishV2: false, sessionAgeSeconds }
  );

async function call(app: ReturnType<typeof mount>, path: string, body?: unknown) {
  const res = body === undefined ? await get(app, path) : await post(app, path, body);
  return { status: res.status, body: (await json(res)) as Json };
}

function seed(raw: DatabaseSync): void {
  raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 1300, default_length_mm = 200, default_width_mm = 200, default_height_mm = 100, min_profit_usd = '2' WHERE key = 'filament';
    UPDATE price_estimate_types SET min_profit_usd = '50', additional_cost_iqd = 25000 WHERE key = 'printer';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', ${q(TODAY)}, ${q('a'.repeat(64))}, 'complete', 'usr_owner', ${q(NOW)}, ${q(NOW)});
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
      VALUES ('p_fil', 'slug-p_fil', 'PLA Basic', 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', 'BASE');
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', 'sp_fil', 'p_fil', 'pla-basic', 'https://us.store.bambulab.com/products/pla-basic', 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
    INSERT INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', '1053109777521', 'PLA', 'filament');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', '1053109777521', '6264995743059', '69');
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES ('p_fil', '', 'tmall_cn', '1053109777521', '6264995743059', 'exact', 'owner', 'confirmed', 'usr_owner', ${q(NOW)}, 'sps_tmall', ${q(NOW)});
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES ('p_prn', 'slug-p_prn', 'H2D', 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', 'BASE', 20000, 600, 500, 500);
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', 'sp_prn', 'p_prn', 'h2d', 'https://us.store.bambulab.com/products/h2d', 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
    INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_prn', 'printer', 'owner', ${q(NOW)});
    INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at) VALUES ('p_prn', '', '1599', 'EUR', 'typed', 'usr_owner', ${q(NOW)});
  `);
}

/** The two products, estimated through the owner's compute and apply. */
async function world() {
  const w = pricingWorld();
  seed(w.raw);
  const app = mount(w.raw);
  const computed = await call(app, `${BASE}/compute`, { product_ids: ['p_fil', 'p_prn'] });
  const items = (computed.body.products as Json[]).map((p) => ({ product_id: p.product_id, preview_hash: p.preview_hash }));
  const applied = await call(app, `${BASE}/apply`, { items });
  assert.deepEqual((applied.body.results as Json[]).map((r) => r.outcome), ['applied', 'applied'], JSON.stringify(applied.body).slice(0, 300));
  return { ...w, app };
}

const envOf = (raw: DatabaseSync): Env => ({ ...fxEnv(raw), STORE_ROOT_DOMAIN: 'levonis-iq.com' }) as Env;
const run = (raw: DatabaseSync) => repriceStaleEngineProducts(envOf(raw), { trigger: 'fx', budget: statementBudget(600) });
const price = (raw: DatabaseSync, pid: string) => all<{ p: number }>(raw, 'SELECT final_price_iqd AS p FROM pricing_v2_sku_results WHERE product_id = ?', pid).map((r) => r.p);
const label = (raw: DatabaseSync, pid: string) => row<{ l: number }>(raw, 'SELECT price_estimate AS l FROM products WHERE id = ?', pid)!.l;
/** The owner's bookkeeping of a product (FX-5 never touches it). */
const books = (raw: DatabaseSync, pid: string) =>
  JSON.stringify(row(raw, 'SELECT state, type_key, measure_basis, flags_json, applied_at, applied_wire_json, version FROM product_price_estimates WHERE product_id = ?', pid));

test('a CNY, EUR, U or freight move reprices through FX-5 and keeps the label and the bookkeeping', async () => {
  const w = await world();
  assert.deepEqual(price(w.raw, 'p_fil'), [20_500]);
  assert.deepEqual(price(w.raw, 'p_prn'), [2_983_250]);
  const before = { fil: books(w.raw, 'p_fil'), prn: books(w.raw, 'p_prn') };

  applyRate(w.raw, 'CNY_USD', '0.145');
  const cny = await run(w.raw);
  assert.deepEqual(cny.repriced, ['p_fil'], 'only the CNY product');
  assert.deepEqual(price(w.raw, 'p_fil'), [21_000]);
  assert.deepEqual(price(w.raw, 'p_prn'), [2_983_250]);

  applyRate(w.raw, 'EUR_USD', '1.12');
  const eur = await run(w.raw);
  assert.deepEqual(eur.repriced, ['p_prn'], 'only the EUR product');
  assert.deepEqual(price(w.raw, 'p_prn'), [3_034_500]);

  applyRate(w.raw, 'USD_IQD', '1632');
  const u = await run(w.raw);
  assert.deepEqual([...u.repriced].sort(), ['p_fil', 'p_prn']);
  w.raw.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '420000', version = version + 1 WHERE profile = 'CHINA_SEA'`);
  const sea = await repriceStaleEngineProducts(envOf(w.raw), { trigger: 'shipping', budget: statementBudget(600) });
  assert.deepEqual(sea.repriced, ['p_fil'], 'the sea freight moves the product sent by sea');

  for (const pid of ['p_fil', 'p_prn']) {
    assert.equal(label(w.raw, pid), 1, `${pid}: the label is untouched`);
    assert.equal(books(w.raw, pid), before[pid === 'p_fil' ? 'fil' : 'prn'], `${pid}: the bookkeeping is untouched`);
  }
  assert.equal(all(w.raw, "SELECT 1 FROM price_history WHERE product_id = 'p_fil' AND price_source = 'engine_fx'").length > 0, true);
});

test('a change above 15% is held and flagged; the owner’s refresh needs the tick and a fresh sign-in, then publishes it, labelled', async () => {
  const w = await world();
  // CNY/USD 0.14 → 0.2: the PLA's price would move about +30% — held at its last good write.
  applyRate(w.raw, 'CNY_USD', '0.2');
  const held = await run(w.raw);
  assert.deepEqual(held.repriced, []);
  assert.deepEqual(held.blocked, [{ product_id: 'p_fil', code: 'PRICING_V2_LARGE_CHANGE' }]);
  assert.deepEqual(price(w.raw, 'p_fil'), [20_500], 'the price stays at the last good write');
  assert.equal(row<{ c: string }>(w.raw, "SELECT reprice_blocked_code AS c FROM product_pricing_state WHERE product_id = 'p_fil'")!.c, 'PRICING_V2_LARGE_CHANGE');

  // The estimator lists it: the information flag, the line marked large with its change.
  const computed = await call(w.app, `${BASE}/compute`, { product_ids: ['p_fil'] });
  const p = (computed.body.products as Json[])[0]!;
  assert.ok((p.flags as Json[]).some((f) => f.code === 'EST_LARGE_CHANGE_HELD'));
  assert.equal(p.blocking, false, 'information only');
  // 69 × 0.2 × 1,600 = 22,080 + 1,600 + 3,200 = 26,880 → 27,000.
  assert.deepEqual(p.lines.map((l: Json) => [l.published_price_iqd, l.est_price_iqd, l.change_pct, l.large]), [[20_500, 27_000, '31.71', true]]);
  const listed = await call(w.app, `${BASE}/products?state=refresh`);
  assert.deepEqual((listed.body.products as Json[]).map((x) => x.product_id), ['p_fil']);
  assert.equal(listed.body.products[0].lines[0].large, true);

  // Without the tick: refused with the preview. With it but an old sign-in: a fresh sign-in first.
  const untick = await call(w.app, `${BASE}/apply`, { items: [{ product_id: 'p_fil', preview_hash: p.preview_hash }] });
  assert.deepEqual([untick.body.results[0].outcome, untick.body.results[0].code], ['refused', 'PRICING_LARGE_CHANGE_CONFIRM']);
  const stale = mount(w.raw, 3600);
  const old = await call(stale, `${BASE}/apply`, { items: [{ product_id: 'p_fil', preview_hash: p.preview_hash, confirm_large_change: true }] });
  assert.deepEqual([old.body.results[0].outcome, old.body.results[0].code], ['refused', 'REAUTH_REQUIRED']);
  assert.deepEqual(price(w.raw, 'p_fil'), [20_500]);

  const ok = await call(w.app, `${BASE}/apply`, { items: [{ product_id: 'p_fil', preview_hash: p.preview_hash, confirm_large_change: true }] });
  assert.equal(ok.body.results[0].outcome, 'applied', JSON.stringify(ok.body).slice(0, 300));
  assert.deepEqual(price(w.raw, 'p_fil'), [27_000]);
  assert.equal(label(w.raw, 'p_fil'), 1);
  assert.equal(row<{ c: string | null }>(w.raw, "SELECT reprice_blocked_code AS c FROM product_pricing_state WHERE product_id = 'p_fil'")!.c, null, 'the hold is released by the reviewed write');
});
