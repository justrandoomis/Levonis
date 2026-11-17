/**
 * THE OWNER'S SAVE REMOVES «سعر تقديري» (owner, 2026-11-17: «make estimated price gone when i edit the product
 * [saved it], not need to confirm button on edit page»; DECISIONS row 340).
 *
 *   - an estimated product the owner saves from its edit page loses the label in one batch: the bookkeeping
 *     `confirmed` (on 'real' measures, as the CHECK asks) FIRST, then `products.price_estimate = 0` (trigger T2
 *     passes), the firm SKUs deleted, the audit — even when a type-default measure priced it (the save is the
 *     owner's own statement), and with no price moved;
 *   - a product with no label, or one already confirmed, is left alone (false), and the helper never throws;
 *   - the save route calls it only for an existing product and a viewer who writes cost (the owner), after the
 *     save's own batch, and tells the form; the form's banner has no «تأكيد» button any more.
 *
 * Run: node --import tsx --test tests/priceEstimateClearOnSave.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, get, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { hydrateRelations, relationsToWire, type RelationsResponse } from '../src/components/adminProducts/form/model';
import { docWithoutLegacyMoney, withoutLegacyMoney } from '../src/components/adminProducts/form/v2/v2Model';
import { clearEstimateOnOwnerSave } from '../worker/lib/pricingEngine/estimate/confirm';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** A full admin with no pricing grant: saves products, never writes cost. */
const STAFF: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' } as StubUser;

const mount = (raw: DatabaseSync, user: StubUser = OWNER) =>
  stubApp(
    asD1(raw),
    user,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(BASE, adminPriceEstimatesRoutes);
      a.route('/api/admin/products', adminProductRelationsRoutes);
      a.route('/api/admin/products-v2', adminProductsRoutes);
    },
    { publishV2: false }
  );

/** The product form's own «نشر» of the product as it stands (a content save: no price typed), as `app`'s user. */
async function formSave(app: ReturnType<typeof mount>): Promise<{ status: number; body: Json }> {
  const p = (await json(await get(app, '/api/admin/products-v2/p_fil'))) as Json;
  const r = (await json(await get(app, '/api/admin/products/p_fil/relations'))) as Json;
  const doc: Record<string, unknown> = { ...(toEditorDoc(p.product) as unknown as Record<string, unknown>), status: 'active' };
  const { options: _o, colors: _c, media: _m, ...docFields } = doc;
  void _o;
  void _c;
  void _m;
  const res = await post(app, '/api/admin/products-v2', {
    ...docWithoutLegacyMoney(docFields),
    relations: withoutLegacyMoney(relationsToWire(hydrateRelations(r as unknown as RelationsResponse, p.product) as never)),
    expected_updated_at: p.product.updated_at,
  });
  return { status: res.status, body: (await json(res)) as Json };
}

function world() {
  const w = pricingWorld();
  w.raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 1300, default_length_mm = 200, default_width_mm = 200, default_height_mm = 100, min_profit_usd = '2' WHERE key = 'filament';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', ${q(TODAY)}, ${q('a'.repeat(64))}, 'complete', 'usr_owner', ${q(NOW)}, ${q(NOW)});
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
      VALUES ('p_fil', 'slug-p_fil', 'PLA', 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', 'COLOR');
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', 'sp_fil', 'p_fil', 'h-fil', 'https://us.store.bambulab.com/products/h-fil', 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
  `);
  ['red', 'black'].forEach((c, k) => {
    w.raw.exec(`
      INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock) VALUES ('p_fil_${c}', 'p_fil', '${c}', 'لون', 'ڕەنگ', '#336699', ${k}, 1, NULL);
      INSERT OR IGNORE INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', '1053109777521', 'item', 'filament');
      INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', '1053109777521', 'sku_${c}', '69');
      INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
        VALUES ('p_fil', 'c:p_fil_${c}', 'tmall_cn', '1053109777521', 'sku_${c}', 'exact', 'owner', 'confirmed', 'usr_owner', ${q(NOW)}, 'sps_tmall', ${q(NOW)});
    `);
  });
  return { ...w, app: mount(w.raw) };
}

/** Compute then apply the product: it is labelled, priced from the type's default weight and box. */
async function estimate(app: ReturnType<typeof mount>): Promise<void> {
  const c = (await json(await post(app, `${BASE}/compute`, { product_ids: ['p_fil'] }))) as Json;
  const preview = (c.products as Json[])[0]!;
  const a = (await json(await post(app, `${BASE}/apply`, { items: [{ product_id: 'p_fil', preview_hash: preview.preview_hash }] }))) as Json;
  assert.equal((a.results as Json[])[0]!.outcome, 'applied', JSON.stringify(a).slice(0, 300));
}

const label = (raw: DatabaseSync) => row<{ l: number }>(raw, "SELECT price_estimate AS l FROM products WHERE id = 'p_fil'")!.l;
const prices = (raw: DatabaseSync) => JSON.stringify(row<Json>(raw, "SELECT json_group_array(final_price_iqd) AS p FROM (SELECT final_price_iqd FROM pricing_v2_sku_results WHERE product_id = 'p_fil' ORDER BY combo_key, channel)"));

test('the owner’s save removes the label in one batch — default measures and all — and moves no price', async () => {
  const w = world();
  await estimate(w.app);
  assert.equal(label(w.raw), 1);
  const codes = (JSON.parse(row<{ f: string }>(w.raw, "SELECT flags_json AS f FROM product_price_estimates WHERE product_id = 'p_fil'")!.f) as Json[]).map((f) => f.code);
  assert.ok(codes.includes('EST_DEFAULT_WEIGHT'), 'priced from the type default');
  // One SKU made firm earlier: the whole product is firm now, so its row goes.
  w.raw.exec(`INSERT INTO price_estimate_firm_skus (product_id, combo_key, confirmed_by, confirmed_at) VALUES ('p_fil', 'c:p_fil_red', 'usr_owner', ${q(NOW)})`);
  const before = prices(w.raw);

  assert.equal(await clearEstimateOnOwnerSave(asD1(w.raw), 'p_fil', 'usr_owner', new Date()), true);
  assert.equal(label(w.raw), 0, 'the label is gone');
  const e = row<Json>(w.raw, "SELECT state, measure_basis, confirmed_by, flags_json FROM product_price_estimates WHERE product_id = 'p_fil'")!;
  assert.deepEqual([e.state, e.measure_basis, e.confirmed_by], ['confirmed', 'real', 'usr_owner']);
  assert.ok(!/EST_DEFAULT_(WEIGHT|BOX)/.test(String(e.flags_json)), 'no default-measure code left');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM price_estimate_firm_skus WHERE product_id = 'p_fil'"), 0);
  const audit = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'price_estimate.confirmed' AND target = 'p_fil'")!;
  assert.deepEqual(JSON.parse(audit.detail), { product_id: 'p_fil', whole: true, on_save: true });
  assert.equal(prices(w.raw), before, 'no price moved');

  // Already firm: nothing to do, and the estimator leaves it alone from now on.
  assert.equal(await clearEstimateOnOwnerSave(asD1(w.raw), 'p_fil', 'usr_owner', new Date()), false);
  const skipped = ((await json(await post(w.app, `${BASE}/compute`, { product_ids: ['p_fil'] }))) as Json).products[0];
  assert.deepEqual([skipped.state, skipped.lines], ['confirmed', []]);
});

test('a product with no label, an unknown id or a failing database answers false and never throws', async () => {
  const w = world();
  assert.equal(await clearEstimateOnOwnerSave(asD1(w.raw), 'p_fil', 'usr_owner', new Date()), false, 'not labelled');
  assert.equal(await clearEstimateOnOwnerSave(asD1(w.raw), 'p_none', 'usr_owner', new Date()), false);
  assert.equal(await clearEstimateOnOwnerSave(asD1(w.raw), 'bad id!', 'usr_owner', new Date()), false);
  const broken = { prepare: () => { throw new Error('D1 down'); } } as unknown as D1Database;
  assert.equal(await clearEstimateOnOwnerSave(broken, 'p_fil', 'usr_owner', new Date()), false);
});

test('the edit page’s save: the owner’s removes the label and says so; a staff save keeps it', async () => {
  const w = world();
  await estimate(w.app);
  const before = prices(w.raw);

  const staff = await formSave(mount(w.raw, STAFF));
  assert.equal(staff.status, 200, JSON.stringify(staff.body).slice(0, 300));
  assert.equal(staff.body.price_estimate, undefined);
  assert.equal(label(w.raw), 1, 'another admin’s save keeps the label');

  const owner = await formSave(w.app);
  assert.equal(owner.status, 200, JSON.stringify(owner.body).slice(0, 300));
  assert.deepEqual(owner.body.price_estimate, { label: false, state: 'confirmed' });
  assert.equal(label(w.raw), 0, 'the owner’s save removed it');
  assert.equal(prices(w.raw), before, 'no price moved');
  // The product read agrees.
  assert.deepEqual(((await json(await get(w.app, '/api/admin/products-v2/p_fil'))) as Json).price_estimate, { label: false, state: 'confirmed' });

  // A second save has nothing to remove.
  const again = await formSave(w.app);
  assert.equal(again.status, 200);
  assert.equal(again.body.price_estimate, undefined);
});

test('the save route calls it for the owner after the save, and the edit page has no «تأكيد» button', () => {
  const route = readFileSync('worker/routes/adminProducts.ts', 'utf8');
  const atSave = route.indexOf('await saveProductAtomic(c.env.DB, plan,');
  const atClear = route.indexOf('const estimateCleared = prev !== null && canWriteCost(c.env, admin) && (await clearEstimateOnOwnerSave(c.env.DB, doc.id, admin.id, new Date()));');
  const atReload = route.indexOf('const stored = await reloadForVerification(c.env.DB, doc.id);', atSave);
  assert.ok(atSave > 0 && atClear > atSave && atReload > atClear, 'after the save, before the read-back');
  assert.match(route, /\.\.\.\(estimateCleared \? \{ price_estimate: \{ label: false, state: 'confirmed' \} \} : \{\}\)/);
  const form = readFileSync('src/components/adminProducts/ProductForm.tsx', 'utf8');
  assert.match(form, /if \(res\.price_estimate !== undefined\) setPriceEstimate\(res\.price_estimate\);/);
  const banner = readFileSync('src/components/adminEstimates/EstimateBanner.tsx', 'utf8');
  assert.doesNotMatch(banner, /data-estimate-banner-confirm|ConfirmSheet|BANNER\.confirm/);
  assert.match(banner, /data-estimate-banner-on-save/);
});
