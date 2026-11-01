/**
 * AFTER A REFRESH — WHAT THE ROW, THE FLAGS TAB, THE SHEET AND THE SERVER SAY
 * (docs/SMART_PRICING.md §4.6, §4.9, §4.10, §7; compute.ts `previewStatements`
 * and `shownFlags`, confirm.ts, ConfirmSheet's `confirmGate`).
 *
 * A filament with its real package: red priced from the Tmall capture, black
 * from a price the owner typed (EST_MANUAL_PRICE). After the apply, the owner
 * computes again and does not apply (the Refresh tab):
 *
 *   - the capture grows older than the type allows: the row keeps the
 *     published estimate's soft flag, shows the line's catalogue word for red,
 *     and the Flags tab lists the product; the sheet asks it of red only, as
 *     the server does (read again from the catalogue);
 *   - FX-5 holds a large change: the refresh's information replaces the row's
 *     (EST_LARGE_CHANGE_HELD comes, and goes once the hold is released);
 *   - the typed price is withdrawn: the refresh cannot be applied and the row
 *     says why (EST_NO_PRICE), while the published estimate is still what
 *     customers see and is confirmed against its own flags.
 *
 * Run: node --import tsx --test tests/priceEstimateConfirmScopeRefresh.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { confirmGate } from '../src/components/adminEstimates/ConfirmSheet';
import { flagClass } from '../src/components/adminEstimates/strings';
import type { StoredEstimate } from '../src/components/adminEstimates/api';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const RED = 'c:p_tab_red';
const BLACK = 'c:p_tab_black';

function world() {
  const w = pricingWorld();
  w.raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 1300, default_length_mm = 200, default_width_mm = 200, default_height_mm = 100, min_profit_usd = '2' WHERE key = 'filament';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', '${TODAY}', '${'a'.repeat(64)}', 'complete', 'usr_owner', '${NOW}', '${NOW}');
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES ('p_tab', 'slug-p_tab', 'PLA Basic', 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', 'COLOR', 1250, 210, 210, 90);
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', 'sp_tab', 'p_tab', 'h-tab', 'https://us.store.bambulab.com/products/h-tab', 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock) VALUES ('p_tab_red', 'p_tab', 'red', 'لون', 'ڕەنگ', '#aa3333', 0, 1, NULL);
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock) VALUES ('p_tab_black', 'p_tab', 'black', 'لون', 'ڕەنگ', '#000000', 1, 1, NULL);
    INSERT INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', '1053109777541', 'item', 'filament');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', '1053109777541', '6264995743071', '69');
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES ('p_tab', '${RED}', 'tmall_cn', '1053109777541', '6264995743071', 'exact', 'owner', 'confirmed', 'usr_owner', '${NOW}', 'sps_tmall', '${NOW}');
    INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at)
      VALUES ('p_tab', '${BLACK}', '75', 'CNY', 'typed', 'usr_owner', '${NOW}');
  `);
  const app = stubApp(
    asD1(w.raw),
    OWNER,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(BASE, adminPriceEstimatesRoutes);
    },
    { publishV2: false }
  );
  return { ...w, app };
}

type App = ReturnType<typeof world>['app'];

async function call(app: App, path: string, body?: unknown) {
  const res = body === undefined ? await get(app, path) : await post(app, path, body);
  return { status: res.status, body: (await json(res)) as Json };
}

const version = (raw: DatabaseSync) => row<{ version: number }>(raw, "SELECT version FROM product_price_estimates WHERE product_id = 'p_tab'")!.version;
const label = (raw: DatabaseSync) => row<{ l: number }>(raw, "SELECT price_estimate AS l FROM products WHERE id = 'p_tab'")!.l;
/** The row's own column (what §4.9 confirms against): codes in order. */
const storedCodes = (raw: DatabaseSync) => (JSON.parse(row<{ f: string }>(raw, "SELECT flags_json AS f FROM product_price_estimates WHERE product_id = 'p_tab'")!.f) as Json[]).map((f) => f.code);
/** The row the Estimated list, the Flags tab and the banner read. */
const storedRow = async (app: App) => (await call(app, `${BASE}/products/p_tab`)).body.product as StoredEstimate;
const flagsTab = async (app: App) => ((await call(app, `${BASE}/products?state=flags`)).body.products as StoredEstimate[]).map((p) => [p.product_id, p.flags.map((f) => f.code)]);
const compute = async (app: App) => (await call(app, `${BASE}/compute`, { product_ids: ['p_tab'] })).body.products[0] as Json;

test('after a refresh the row keeps the published estimate’s soft flags, takes the refresh’s blocking and information ones, and shows its catalogue words — the Flags tab, the sheet and the server agree', async () => {
  const w = world();
  const first = await compute(w.app);
  assert.match(String(first.preview_hash), /^[0-9a-f]{64}$/, JSON.stringify(first.blocked_by));
  const applied = await call(w.app, `${BASE}/apply`, { items: [{ product_id: 'p_tab', preview_hash: first.preview_hash }] });
  assert.equal(applied.body.results[0].outcome, 'applied', JSON.stringify(applied.body).slice(0, 300));
  assert.deepEqual(storedCodes(w.raw), ['EST_MANUAL_PRICE']);
  assert.deepEqual(await flagsTab(w.app), [['p_tab', ['EST_MANUAL_PRICE']]]);

  // 1. The capture grows older than the type's 60 days; the owner computes and does not apply.
  const old = new Date(Date.parse(NOW) - 90 * 86_400_000).toISOString().slice(0, 10);
  w.raw.exec(`UPDATE supplier_price_snapshots SET captured_on = '${old}' WHERE id = 'sps_tmall'`);
  const stale = await compute(w.app);
  assert.deepEqual(stale.flags.map((f: Json) => f.code), ['EST_MANUAL_PRICE', 'EST_SNAPSHOT_STALE']);
  assert.match(String(stale.preview_hash), /^[0-9a-f]{64}$/, 'a soft flag never blocks a refresh');
  // The row keeps the published estimate's soft flags — the refresh's are its own — …
  assert.deepEqual(storedCodes(w.raw), ['EST_MANUAL_PRICE']);
  // …and shows what the latest lines say of the catalogue, for their SKU; the Flags tab lists it.
  const shown = await storedRow(w.app);
  assert.deepEqual(shown.flags, [
    { code: 'EST_MANUAL_PRICE', combo_keys: [BLACK] },
    { code: 'EST_SNAPSHOT_STALE', combo_keys: [RED] },
  ]);
  assert.deepEqual(await flagsTab(w.app), [['p_tab', ['EST_MANUAL_PRICE', 'EST_SNAPSHOT_STALE']]]);
  // The sheet asks of each option what the server asks of it, before anything is sent.
  assert.deepEqual(confirmGate(shown, new Set([RED])), { hard: false, soft: ['EST_SNAPSHOT_STALE'] });
  assert.deepEqual(confirmGate(shown, new Set([BLACK])), { hard: false, soft: ['EST_MANUAL_PRICE'] });
  const black = await call(w.app, `${BASE}/products/p_tab/confirm`, { version: version(w.raw), accept_flags: [], combo_keys: [BLACK] });
  assert.deepEqual([black.status, black.body.code, black.body.details?.flags], [409, 'PRICE_ESTIMATE_FLAGS_OPEN', ['EST_MANUAL_PRICE']]);
  const unaccepted = await call(w.app, `${BASE}/products/p_tab/confirm`, { version: version(w.raw), accept_flags: [], combo_keys: [RED] });
  assert.deepEqual([unaccepted.status, unaccepted.body.details?.flags], [409, ['EST_SNAPSHOT_STALE']]);
  const red = await call(w.app, `${BASE}/products/p_tab/confirm`, { version: version(w.raw), accept_flags: confirmGate(shown, new Set([RED])).soft, combo_keys: [RED] });
  assert.equal(red.status, 200, JSON.stringify(red.body));
  assert.deepEqual([red.body.confirmed, red.body.firm, label(w.raw)], ['skus', [RED], 1]);
  w.raw.exec(`UPDATE supplier_price_snapshots SET captured_on = '${TODAY}' WHERE id = 'sps_tmall'`);

  // 2. FX-5 holds a large change: the refresh's information replaces the row's, and lists the product.
  w.raw.exec(`UPDATE product_pricing_state SET reprice_blocked_code = 'PRICING_V2_LARGE_CHANGE', reprice_blocked_at = '${NOW}' WHERE product_id = 'p_tab'`);
  assert.ok((await compute(w.app)).flags.some((f: Json) => f.code === 'EST_LARGE_CHANGE_HELD'));
  assert.deepEqual(storedCodes(w.raw), ['EST_LARGE_CHANGE_HELD', 'EST_MANUAL_PRICE']);
  assert.deepEqual(await flagsTab(w.app), [['p_tab', ['EST_LARGE_CHANGE_HELD', 'EST_MANUAL_PRICE']]]);
  w.raw.exec("UPDATE product_pricing_state SET reprice_blocked_code = NULL, reprice_blocked_at = NULL WHERE product_id = 'p_tab'");
  await compute(w.app);
  assert.deepEqual(storedCodes(w.raw), ['EST_MANUAL_PRICE'], 'released: the information is gone with it');

  // 3. The owner withdraws black's typed price: the refresh cannot be applied, and the row says why.
  w.raw.exec("DELETE FROM supplier_price_manual WHERE product_id = 'p_tab'");
  const blocked = await compute(w.app);
  assert.equal(blocked.preview_hash, null);
  assert.ok(blocked.blocked_by.includes('EST_NO_PRICE'));
  const codes = storedCodes(w.raw);
  assert.ok(codes.includes('EST_MANUAL_PRICE') && codes.includes('EST_NO_PRICE'), JSON.stringify(codes));
  assert.deepEqual(codes.filter((c) => c !== 'EST_MANUAL_PRICE').map(flagClass), codes.filter((c) => c !== 'EST_MANUAL_PRICE').map(() => 'blocking'), 'the rest is the refresh’s blocking codes');
  assert.deepEqual(
    (await storedRow(w.app)).flags.find((f) => f.code === 'EST_NO_PRICE'),
    blocked.flags.find((f: Json) => f.code === 'EST_NO_PRICE'),
    'as the compute answered it'
  );
  // Customers still see the published estimate: it is confirmed against its own flags, whatever the refresh says.
  const open = await call(w.app, `${BASE}/products/p_tab/confirm`, { version: version(w.raw), accept_flags: [] });
  assert.deepEqual([open.status, open.body.details?.flags], [409, ['EST_MANUAL_PRICE']]);
  const ok = await call(w.app, `${BASE}/products/p_tab/confirm`, { version: version(w.raw), accept_flags: ['EST_MANUAL_PRICE'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.confirmed, label(w.raw)], ['whole', 0]);
});
