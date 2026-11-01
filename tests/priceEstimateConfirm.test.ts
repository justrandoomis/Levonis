/**
 * «تأكيد السعر» — REMOVING THE LABEL (docs/SMART_PRICING.md §4.9; owner decision D2; WP6).
 *
 *   - a SKU priced from a type-default weight or box can never be confirmed: 409
 *     PRICE_ESTIMATE_DEFAULT_MEASURES, whatever `accept_flags` says, for the whole product and for that SKU
 *     alone — and the database refuses to clear the label behind the route's back (T2);
 *   - once the owner gives the real package (the product's own public spec), a refresh prices from it
 *     (`product`), and the whole product is confirmed: the bookkeeping `confirmed` on real measures FIRST,
 *     then the label cleared — no firm row left, the audit written;
 *   - every open soft flag (a typed price) must be accepted by name: 409 PRICE_ESTIMATE_FLAGS_OPEN with the
 *     codes, then a confirmation that names it passes;
 *   - some SKUs confirmed: they become firm (a public fact), the label stays for the others; a re-apply
 *     makes every SKU an estimate again (the firm rows cleared);
 *   - a stale version is refused (PRICING_CHANGED); a product that is not an estimate is refused.
 *
 * Run: node --import tsx --test tests/priceEstimateConfirm.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, get, json, post, put as putTo, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const mount = (raw: DatabaseSync) =>
  stubApp(
    asD1(raw),
    OWNER,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(BASE, adminPriceEstimatesRoutes);
    },
    { publishV2: false }
  );

function seedProduct(raw: DatabaseSync, id: string, o: { colours?: string[]; weight?: number; box?: [number, number, number] } = {}): void {
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
    VALUES (${q(id)}, ${q(`slug-${id}`)}, ${q(`Product ${id}`)}, 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]',
            ${q(o.colours?.length ? 'COLOR' : 'BASE')}, ${q(o.weight ?? null)}, ${q(o.box?.[0])}, ${q(o.box?.[1])}, ${q(o.box?.[2])});
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', ${q(`sp_${id}`)}, ${q(id)}, ${q(`h-${id}`)}, ${q(`https://us.store.bambulab.com/products/h-${id}`)}, 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
  `);
  (o.colours ?? []).forEach((c, k) => {
    raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock)
              VALUES (${q(`${id}_${c}`)}, ${q(id)}, ${q(c)}, 'لون', 'ڕەنگ', '#336699', ${k}, 1, NULL)`);
  });
}

let skuSeq = 0;
function tmall(raw: DatabaseSync, pid: string, combo: string, price: string, item: string): void {
  const sku = `${item}${++skuSeq}`;
  raw.exec(`
    INSERT OR IGNORE INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', ${q(item)}, 'item', 'filament');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', ${q(item)}, ${q(sku)}, ${q(price)});
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES (${q(pid)}, ${q(combo)}, 'tmall_cn', ${q(item)}, ${q(sku)}, 'exact', 'owner', 'confirmed', 'usr_owner', ${q(NOW)}, 'sps_tmall', ${q(NOW)});
  `);
}

function world() {
  const w = pricingWorld();
  w.raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 1300, default_length_mm = 200, default_width_mm = 200, default_height_mm = 100, min_profit_usd = '2' WHERE key = 'filament';
    UPDATE price_estimate_types SET min_profit_usd = '50', additional_cost_iqd = 25000 WHERE key = 'printer';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', ${q(TODAY)}, ${q('a'.repeat(64))}, 'complete', 'usr_owner', ${q(NOW)}, ${q(NOW)});
  `);
  return { ...w, app: mount(w.raw) };
}

type App = ReturnType<typeof mount>;

async function call(app: App, path: string, body?: unknown) {
  const res = body === undefined ? await get(app, path) : await post(app, path, body);
  return { status: res.status, body: (await json(res)) as Json };
}

/** Compute then apply one product; answers the applied preview. */
async function estimate(app: App, pid: string): Promise<Json> {
  const c = await call(app, `${BASE}/compute`, { product_ids: [pid] });
  const preview = (c.body.products as Json[]).find((p) => p.product_id === pid)!;
  assert.match(String(preview.preview_hash), /^[0-9a-f]{64}$/, `${pid}: ${JSON.stringify(preview.blocked_by)}`);
  const a = await call(app, `${BASE}/apply`, { items: [{ product_id: pid, preview_hash: preview.preview_hash }] });
  const out = (a.body.results as Json[])[0]!;
  assert.equal(out.outcome, 'applied', JSON.stringify(out).slice(0, 300));
  return out.preview;
}

const version = (raw: DatabaseSync, pid: string) => row<{ version: number }>(raw, 'SELECT version FROM product_price_estimates WHERE product_id = ?', pid)!.version;
const label = (raw: DatabaseSync, pid: string) => row<{ l: number }>(raw, 'SELECT price_estimate AS l FROM products WHERE id = ?', pid)!.l;
const storedCodes = (raw: DatabaseSync, pid: string) =>
  (JSON.parse(row<{ f: string }>(raw, 'SELECT flags_json AS f FROM product_price_estimates WHERE product_id = ?', pid)!.f) as Json[]).map((f) => f.code);

/** A current capture of one of the two Bambu stores. */
function storeSnapshot(raw: DatabaseSync, id: string, source: 'bambu_eu' | 'bambu_us', currency: 'EUR' | 'USD', hash: string): void {
  raw.exec(`INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
            VALUES (${q(id)}, ${q(source)}, ${q(currency)}, 'store_script', ${q(TODAY)}, ${q(hash.repeat(64))}, 'complete', 'usr_owner', ${q(NOW)}, ${q(NOW)})`);
}

/** A store offer confirmed for a product's only SKU. */
function storeMatch(raw: DatabaseSync, pid: string, snapshot: string, source: 'bambu_eu' | 'bambu_us', item: string, sku: string, price: string): void {
  raw.exec(`
    INSERT OR IGNORE INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES (${q(snapshot)}, ${q(item)}, 'item', 'printer');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES (${q(snapshot)}, ${q(item)}, ${q(sku)}, ${q(price)});
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES (${q(pid)}, '', ${q(source)}, ${q(item)}, ${q(sku)}, 'high', 'handle', 'confirmed', 'auto', ${q(NOW)}, ${q(snapshot)}, ${q(NOW)});
  `);
}

/** A printer the import created (20 kg, 600 × 500 × 500 mm), typed `printer` by the owner. */
function seedPrinter(raw: DatabaseSync, pid: string): void {
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES (${q(pid)}, ${q(`slug-${pid}`)}, 'X1C', 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', 'BASE', 20000, 600, 500, 500);
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', ${q(`sp_${pid}`)}, ${q(pid)}, ${q(`h-${pid}`)}, ${q(`https://us.store.bambulab.com/products/h-${pid}`)}, 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
    INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES (${q(pid)}, 'printer', 'owner', ${q(NOW)});
  `);
}

test('a type-default measure can never be confirmed (D2) — whatever accept_flags says; once the real package prices it, the whole product is confirmed', async () => {
  const w = world();
  seedProduct(w.raw, 'p_fil', { colours: ['red', 'black'] });
  tmall(w.raw, 'p_fil', 'c:p_fil_red', '69', '1053109777521');
  tmall(w.raw, 'p_fil', 'c:p_fil_black', '69', '1053109777521');
  await estimate(w.app, 'p_fil');

  const everything = ['EST_DEFAULT_WEIGHT', 'EST_DEFAULT_BOX', 'EST_MANUAL_PRICE', 'EST_US_REFERENCE'];
  const whole = await call(w.app, `${BASE}/products/p_fil/confirm`, { version: version(w.raw, 'p_fil'), accept_flags: everything });
  assert.equal(whole.status, 409);
  assert.equal(whole.body.code, 'PRICE_ESTIMATE_DEFAULT_MEASURES');
  assert.deepEqual(whole.body.details.combo_keys, ['c:p_fil_black', 'c:p_fil_red']);
  const one = await call(w.app, `${BASE}/products/p_fil/confirm`, { version: version(w.raw, 'p_fil'), accept_flags: everything, combo_keys: ['c:p_fil_red'] });
  assert.equal(one.body.code, 'PRICE_ESTIMATE_DEFAULT_MEASURES');
  assert.equal(label(w.raw, 'p_fil'), 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM price_estimate_firm_skus'), 0);
  // The database's own rule: the label is cleared only after a confirmation on real measures (T2).
  assert.throws(() => w.raw.exec("UPDATE products SET price_estimate = 0 WHERE id = 'p_fil'"), /PRICE_ESTIMATE_LABEL_CLEAR_REFUSED/);

  // The owner enters the real package (the product's public spec), computes and applies again.
  w.raw.exec("UPDATE products SET package_weight_g = 1250, package_depth_mm = 210, package_width_mm = 210, package_height_mm = 90 WHERE id = 'p_fil'");
  const refreshed = await estimate(w.app, 'p_fil');
  assert.equal(refreshed.measure_basis, 'real');
  assert.ok(refreshed.lines.every((l: Json) => l.measure_source === 'product'));
  assert.deepEqual(
    refreshed.flags.map((f: Json) => f.code),
    [],
    'no default left'
  );
  // 0.003969 m³ × 400,000 = 1,587.6: R = 17,043.6, D = 20,250.
  assert.ok(refreshed.lines.every((l: Json) => l.est_price_iqd === 20_250), JSON.stringify(refreshed.lines));

  const v = version(w.raw, 'p_fil');
  const ok = await call(w.app, `${BASE}/products/p_fil/confirm`, { version: v, accept_flags: [] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.confirmed, ok.body.firm, ok.body.version], ['whole', [], v + 1]);
  assert.equal(label(w.raw, 'p_fil'), 0, 'the label is gone');
  const e = row<Json>(w.raw, "SELECT state, measure_basis, confirmed_by, confirmed_at FROM product_price_estimates WHERE product_id = 'p_fil'")!;
  assert.deepEqual([e.state, e.measure_basis, e.confirmed_by], ['confirmed', 'real', 'usr_owner']);
  assert.ok(e.confirmed_at);
  const audit = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'price_estimate.confirmed' AND target = 'p_fil'")!;
  assert.deepEqual(JSON.parse(audit.detail), { product_id: 'p_fil', whole: true, skus: 2, accepted_flags: [] });
  // The price is untouched by the confirmation: an ordinary V2 price now.
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = 'p_fil' AND final_price_iqd = 20250"), 2);
  // A confirmed product is the estimator's no more: compute skips it, and it cannot be confirmed again.
  const again = await call(w.app, `${BASE}/products/p_fil/confirm`, { version: v + 1, accept_flags: [] });
  assert.equal(again.body.code, 'PRICE_ESTIMATE_NOT_ELIGIBLE');
  const skipped = (await call(w.app, `${BASE}/compute`, { product_ids: ['p_fil'] })).body.products[0];
  assert.deepEqual([skipped.state, skipped.lines], ['confirmed', []]);
});

test('every open soft flag must be accepted by name; a stale version is refused', async () => {
  const w = world();
  // A printer the owner typed at EUR 1,599 (a typed price: EST_MANUAL_PRICE), with its real package.
  w.raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES ('p_prn', 'slug-p_prn', 'H2D', 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', 'BASE', 20000, 600, 500, 500);
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', 'sp_prn', 'p_prn', 'h2d', 'https://us.store.bambulab.com/products/h2d', 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
    INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_prn', 'printer', 'owner', ${q(NOW)});
    INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at) VALUES ('p_prn', '', '1599', 'EUR', 'typed', 'usr_owner', ${q(NOW)});
  `);
  const applied = await estimate(w.app, 'p_prn');
  assert.deepEqual(applied.flags.map((f: Json) => f.code), ['EST_MANUAL_PRICE']);
  assert.equal(applied.lines[0].est_price_iqd, 2_983_250);

  const stale = await call(w.app, `${BASE}/products/p_prn/confirm`, { version: version(w.raw, 'p_prn') - 1, accept_flags: ['EST_MANUAL_PRICE'] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'PRICING_CHANGED');

  const open = await call(w.app, `${BASE}/products/p_prn/confirm`, { version: version(w.raw, 'p_prn'), accept_flags: [] });
  assert.equal(open.status, 409);
  assert.equal(open.body.code, 'PRICE_ESTIMATE_FLAGS_OPEN');
  assert.deepEqual(open.body.details.flags, ['EST_MANUAL_PRICE'], 'the open codes, never a value');
  assert.equal(label(w.raw, 'p_prn'), 1);
  const bad = await call(w.app, `${BASE}/products/p_prn/confirm`, { version: version(w.raw, 'p_prn'), accept_flags: 'EST_MANUAL_PRICE' });
  assert.equal(bad.status, 400);

  const ok = await call(w.app, `${BASE}/products/p_prn/confirm`, { version: version(w.raw, 'p_prn'), accept_flags: ['EST_MANUAL_PRICE'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(label(w.raw, 'p_prn'), 0);
  const audit = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'price_estimate.confirmed' AND target = 'p_prn'")!;
  assert.deepEqual(JSON.parse(audit.detail).accepted_flags, ['EST_MANUAL_PRICE']);
});

test('confirm reads the APPLIED estimate’s flags: a refresh computed and not applied never drops one (a US reference stays to accept)', async () => {
  const w = world();
  storeSnapshot(w.raw, 'sps_us', 'bambu_us', 'USD', 'b');
  storeSnapshot(w.raw, 'sps_eu', 'bambu_eu', 'EUR', 'c');
  // Only the US store lists the printer: priced from its USD 1,199 as a reference (EST_US_REFERENCE).
  seedPrinter(w.raw, 'p_x1');
  storeMatch(w.raw, 'p_x1', 'sps_us', 'bambu_us', 'x1c', '111', '1199');
  const applied = await estimate(w.app, 'p_x1');
  assert.deepEqual(applied.flags.map((f: Json) => f.code), ['EST_US_REFERENCE']);
  // 1,199 × 1,600 = 1,918,400 + 20 kg × 3,200 + 25,000 = 2,007,400; + $50 → 2,087,400 → 2,087,500.
  assert.equal(applied.lines[0].est_price_iqd, 2_087_500);

  // Later the EU store lists it at EUR 1,299: the owner computes (the Refresh tab) and does not apply.
  storeMatch(w.raw, 'p_x1', 'sps_eu', 'bambu_eu', 'x1c', '222', '1299');
  const refresh = (await call(w.app, `${BASE}/compute`, { product_ids: ['p_x1'] })).body.products[0] as Json;
  assert.deepEqual(refresh.flags.map((f: Json) => f.code), [], 'the refresh prices from the EU store');
  assert.deepEqual(refresh.lines.map((l: Json) => [l.source, l.est_price_iqd, l.published_price_iqd]), [['bambu_eu', 2_455_250, 2_087_500]]);
  // Customers still see the US-reference price: its flag stays on the row the lists and the sheet read.
  assert.deepEqual(storedCodes(w.raw, 'p_x1'), ['EST_US_REFERENCE']);
  assert.deepEqual(((await call(w.app, `${BASE}/products/p_x1`)).body.product.flags as Json[]).map((f) => f.code), ['EST_US_REFERENCE']);

  const open = await call(w.app, `${BASE}/products/p_x1/confirm`, { version: version(w.raw, 'p_x1'), accept_flags: [] });
  assert.deepEqual([open.status, open.body.code, open.body.details?.flags], [409, 'PRICE_ESTIMATE_FLAGS_OPEN', ['EST_US_REFERENCE']]);
  assert.equal(label(w.raw, 'p_x1'), 1);
  const ok = await call(w.app, `${BASE}/products/p_x1/confirm`, { version: version(w.raw, 'p_x1'), accept_flags: ['EST_US_REFERENCE'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(label(w.raw, 'p_x1'), 0);

  // A candidate's flags are its latest preview's: rewritten by every compute.
  seedPrinter(w.raw, 'p_x2');
  storeMatch(w.raw, 'p_x2', 'sps_us', 'bambu_us', 'x2d', '333', '1499');
  await call(w.app, `${BASE}/compute`, { product_ids: ['p_x2'] });
  assert.deepEqual(storedCodes(w.raw, 'p_x2'), ['EST_US_REFERENCE']);
  storeMatch(w.raw, 'p_x2', 'sps_eu', 'bambu_eu', 'x2d', '444', '1599');
  await call(w.app, `${BASE}/compute`, { product_ids: ['p_x2'] });
  assert.deepEqual(storedCodes(w.raw, 'p_x2'), []);
});

test('what the catalogue says today is read again at confirm, for the targeted SKUs: a capture grown too old, an item gone, out of stock', async () => {
  const w = world();
  seedProduct(w.raw, 'p_cat', { colours: ['red', 'black'], weight: 1250, box: [210, 210, 90] });
  tmall(w.raw, 'p_cat', 'c:p_cat_red', '69', '1053109777531');
  tmall(w.raw, 'p_cat', 'c:p_cat_black', '79', '1053109777532');
  assert.deepEqual((await estimate(w.app, 'p_cat')).flags, []);
  const confirm = (body: Json) => call(w.app, `${BASE}/products/p_cat/confirm`, { version: version(w.raw, 'p_cat'), ...body });

  // Time passes with no compute: the capture is now older than the type's 60 days.
  const old = new Date(Date.parse(NOW) - 90 * 86_400_000).toISOString().slice(0, 10);
  w.raw.exec(`UPDATE supplier_price_snapshots SET captured_on = ${q(old)} WHERE id = 'sps_tmall'`);
  const stale = await confirm({ accept_flags: [] });
  assert.deepEqual([stale.status, stale.body.code, stale.body.details?.flags], [409, 'PRICE_ESTIMATE_FLAGS_OPEN', ['EST_SNAPSHOT_STALE']]);
  assert.deepEqual(storedCodes(w.raw, 'p_cat'), [], 'read at confirm, nothing stored');
  w.raw.exec(`UPDATE supplier_price_snapshots SET captured_on = ${q(TODAY)} WHERE id = 'sps_tmall'`);

  // The newest capture no longer lists black's item, and red is out of stock: each SKU answers for itself.
  w.raw.exec("DELETE FROM supplier_price_skus WHERE item_key = '1053109777532'; UPDATE supplier_price_skus SET quantity = 0 WHERE item_key = '1053109777531'");
  const red = await confirm({ accept_flags: [], combo_keys: ['c:p_cat_red'] });
  assert.deepEqual([red.status, red.body.details?.flags], [409, ['EST_SUPPLIER_OUT_OF_STOCK']]);
  const black = await confirm({ accept_flags: ['EST_SUPPLIER_OUT_OF_STOCK'], combo_keys: ['c:p_cat_black'] });
  assert.deepEqual([black.status, black.body.details?.flags], [409, ['EST_SOURCE_ITEM_MISSING']], 'red’s word is not black’s');
  const both = await confirm({ accept_flags: [] });
  assert.deepEqual(both.body.details?.flags, ['EST_SOURCE_ITEM_MISSING', 'EST_SUPPLIER_OUT_OF_STOCK']);
  const ok = await confirm({ accept_flags: ['EST_SOURCE_ITEM_MISSING', 'EST_SUPPLIER_OUT_OF_STOCK'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.confirmed, label(w.raw, 'p_cat')], ['whole', 0]);
  const audit = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'price_estimate.confirmed' AND target = 'p_cat'")!;
  assert.deepEqual(JSON.parse(audit.detail).accepted_flags, ['EST_SOURCE_ITEM_MISSING', 'EST_SUPPLIER_OUT_OF_STOCK']);
});

test('some SKUs confirmed become firm and the label stays for the others; a re-apply makes every SKU an estimate again', async () => {
  const w = world();
  seedProduct(w.raw, 'p_two', { colours: ['red', 'black'], weight: 1250, box: [210, 210, 90] });
  tmall(w.raw, 'p_two', 'c:p_two_red', '69', '1053109777521');
  tmall(w.raw, 'p_two', 'c:p_two_black', '79', '1053109777522');
  const applied = await estimate(w.app, 'p_two');
  assert.equal(applied.measure_basis, 'real');

  const some = await call(w.app, `${BASE}/products/p_two/confirm`, { version: version(w.raw, 'p_two'), accept_flags: [], combo_keys: ['c:p_two_red'] });
  assert.equal(some.status, 200, JSON.stringify(some.body));
  assert.deepEqual([some.body.confirmed, some.body.firm], ['skus', ['c:p_two_red']]);
  assert.equal(label(w.raw, 'p_two'), 1, 'the label stays for the others');
  assert.deepEqual(all(w.raw, "SELECT combo_key, confirmed_by FROM price_estimate_firm_skus WHERE product_id = 'p_two'"), [{ combo_key: 'c:p_two_red', confirmed_by: 'usr_owner' }]);
  assert.equal(row<Json>(w.raw, "SELECT state FROM product_price_estimates WHERE product_id = 'p_two'")!.state, 'estimated');
  // A key that is not a sellable SKU of the product is refused.
  const unknown = await call(w.app, `${BASE}/products/p_two/confirm`, { version: version(w.raw, 'p_two'), accept_flags: [], combo_keys: ['c:nope'] });
  assert.equal(unknown.status, 400);

  // «Return to estimate» is a re-apply: every SKU is an estimate again.
  await estimate(w.app, 'p_two');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM price_estimate_firm_skus WHERE product_id = 'p_two'"), 0);
  assert.equal(label(w.raw, 'p_two'), 1);

  // Pause stops refreshes and leaves the label alone; resume returns it to `estimated`.
  const paused = await call(w.app, `${BASE}/products/p_two`, undefined);
  assert.equal(paused.status, 200);
  const put = (body: Json) => putTo(w.app, `${BASE}/products/p_two`, body);
  const p1 = await json(await put({ version: version(w.raw, 'p_two'), state: 'paused' }));
  assert.equal(p1.settings?.state, 'paused', JSON.stringify(p1));
  assert.equal(label(w.raw, 'p_two'), 1);
  const skipped = (await call(w.app, `${BASE}/compute`, { product_ids: ['p_two'] })).body.products[0];
  assert.equal(skipped.state, 'paused');
  const p2 = await json(await put({ version: version(w.raw, 'p_two'), state: 'active' }));
  assert.equal(p2.settings?.state, 'estimated', JSON.stringify(p2));
});
