/**
 * «تأكيد السعر» FOR CHOSEN OPTIONS — THE SHEET ASKS WHAT THE SERVER ASKS
 * (docs/SMART_PRICING.md §4.9; owner decision D2; ConfirmSheet's `confirmGate`).
 *
 * A filament whose red colour has its own package and whose black colour falls
 * back to the type's default measures, black priced from a price the owner
 * typed. Confirming red alone is allowed: the server checks default measures
 * and soft flags on the targeted SKUs only, and the sheet, fed the very row the
 * Estimated list and the product form's banner hand it, enables its submit for
 * red and asks nothing of black's flags. Confirming black or the whole product
 * is refused on black's default measures — by the sheet before anything is
 * sent, and by the server as the backstop.
 *
 * Once the owner gives black its real measures in the product form (a priced
 * save) and computes, the stored flags are still the applied estimate's
 * (black defaulted) while the lines are the new compute's: the workspace no
 * longer shows black's defaults, the sheet reads the lines and opens, as the
 * server does; an open flag the server names comes back as a box to tick.
 *
 * Run: node --import tsx --test tests/priceEstimateConfirmScope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { confirmThroughGate } from './fixtures/confirmGate';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { ApiError } from '../src/lib/api';
import { confirmGate, openFlagsOf } from '../src/components/adminEstimates/ConfirmSheet';
import { flagClass } from '../src/components/adminEstimates/strings';
import type { StoredEstimate } from '../src/components/adminEstimates/api';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const RED = 'c:p_mix_red';
const BLACK = 'c:p_mix_black';

function world() {
  const w = pricingWorld();
  w.raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 1300, default_length_mm = 200, default_width_mm = 200, default_height_mm = 100, min_profit_usd = '2' WHERE key = 'filament';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', '${TODAY}', '${'a'.repeat(64)}', 'complete', 'usr_owner', '${NOW}', '${NOW}');
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
      VALUES ('p_mix', 'slug-p_mix', 'PLA Basic', 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', 'COLOR');
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', 'sp_mix', 'p_mix', 'h-mix', 'https://us.store.bambulab.com/products/h-mix', 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock, package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES ('p_mix_red', 'p_mix', 'red', 'لون', 'ڕەنگ', '#aa3333', 0, 1, NULL, 1250, 210, 210, 90);
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock)
      VALUES ('p_mix_black', 'p_mix', 'black', 'لون', 'ڕەنگ', '#000000', 1, 1, NULL);
    INSERT INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', '1053109777521', 'item', 'filament');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', '1053109777521', '6264995743059', '69');
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES ('p_mix', '${RED}', 'tmall_cn', '1053109777521', '6264995743059', 'exact', 'owner', 'confirmed', 'usr_owner', '${NOW}', 'sps_tmall', '${NOW}');
    INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at)
      VALUES ('p_mix', '${BLACK}', '75', 'CNY', 'typed', 'usr_owner', '${NOW}');
  `);
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
  return { ...w, app };
}

type App = ReturnType<typeof world>['app'];

async function call(app: App, path: string, body?: unknown) {
  // Every confirmation is read through the sheet's live gate first, and the two must agree (§4.9; fixtures/confirmGate.ts).
  if (body !== undefined && path.endsWith('/confirm')) return confirmThroughGate(app, path, body as Json);
  const res = body === undefined ? await get(app, path) : await post(app, path, body);
  return { status: res.status, body: (await json(res)) as Json };
}

const version = (raw: DatabaseSync) => row<{ version: number }>(raw, "SELECT version FROM product_price_estimates WHERE product_id = 'p_mix'")!.version;
/** The row the Estimated list and the banner hand the sheet. */
const storedRow = async (app: App) => (await call(app, `${BASE}/products/p_mix`)).body.product as StoredEstimate;
const gate = (estimate: StoredEstimate, keys: string[] | null, named: string[] = []) => confirmGate(estimate, keys ? new Set(keys) : null, named);

test('a default measure on one option never stops confirming another: the sheet asks what the server asks, option by option', async () => {
  const w = world();
  const c = await call(w.app, `${BASE}/compute`, { product_ids: ['p_mix'] });
  const preview = c.body.products[0] as Json;
  assert.match(String(preview.preview_hash), /^[0-9a-f]{64}$/, JSON.stringify(preview.blocked_by));
  const a = await call(w.app, `${BASE}/apply`, { items: [{ product_id: 'p_mix', preview_hash: preview.preview_hash }] });
  assert.equal(a.body.results[0].outcome, 'applied', JSON.stringify(a.body).slice(0, 300));

  const stored = await storedRow(w.app);
  assert.equal(stored.measure_basis, 'mixed');
  assert.deepEqual(
    stored.flags.map((f) => [f.code, f.combo_keys]),
    [
      ['EST_DEFAULT_BOX', [BLACK]],
      ['EST_DEFAULT_WEIGHT', [BLACK]],
      ['EST_MANUAL_PRICE', [BLACK]],
    ]
  );
  // The sheet, before anything is sent: black (or the whole product) is held by its default measures; red is not.
  assert.deepEqual(gate(stored, null), { hard: true, soft: ['EST_MANUAL_PRICE'] });
  assert.deepEqual(gate(stored, [BLACK]), { hard: true, soft: ['EST_MANUAL_PRICE'] });
  assert.deepEqual(gate(stored, [RED]), { hard: false, soft: [] }, 'red alone: the submit is enabled and black’s flags are not asked');

  // The server agrees, option by option.
  const whole = await call(w.app, `${BASE}/products/p_mix/confirm`, { version: version(w.raw), accept_flags: ['EST_MANUAL_PRICE'] });
  assert.deepEqual([whole.status, whole.body.code, whole.body.details?.combo_keys], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', [BLACK]]);
  const black = await call(w.app, `${BASE}/products/p_mix/confirm`, { version: version(w.raw), accept_flags: ['EST_MANUAL_PRICE'], combo_keys: [BLACK] });
  assert.equal(black.body.code, 'PRICE_ESTIMATE_DEFAULT_MEASURES');
  const red = await call(w.app, `${BASE}/products/p_mix/confirm`, { version: version(w.raw), accept_flags: [], combo_keys: [RED] });
  assert.equal(red.status, 200, JSON.stringify(red.body));
  assert.deepEqual([red.body.confirmed, red.body.firm], ['skus', [RED]]);
  assert.equal(row<{ l: number }>(w.raw, "SELECT price_estimate AS l FROM products WHERE id = 'p_mix'")!.l, 1, 'the label stays for black');

  // The owner gives black its real measures in the product form: a priced save, the label untouched.
  const pricing = { cost: { inputs: [{ scope: 'color', scope_id: 'p_mix_black', shipping_weight_g: 1250, shipping_length_mm: 210, shipping_width_mm: 210, shipping_height_mm: 90 }] } };
  const sheet = await json(await put(w.app, '/api/admin/products-v2/p_mix/pricing', { seq: (await json(await get(w.app, '/api/admin/products-v2/p_mix/pricing'))).seq, pricing }));
  assert.equal(sheet.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(sheet).slice(0, 300));
  const seq = (await json(await get(w.app, '/api/admin/products-v2/p_mix/pricing'))).seq;
  const saved = await put(w.app, '/api/admin/products-v2/p_mix/pricing', { seq, pricing, preview_hash: sheet.details.preview.review_hash });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())).slice(0, 300));
  // …and computes again. The stored flags stay the applied estimate's; the lines are the new compute's,
  // and what the workspace shows follows them.
  await call(w.app, `${BASE}/compute`, { product_ids: ['p_mix'] });
  const fixed = await storedRow(w.app);
  assert.ok(!fixed.flags.some((f) => flagClass(f.code) === 'hard'), 'no default measure is shown once black’s real ones are in the store');
  assert.ok(
    (JSON.parse(row<{ f: string }>(w.raw, "SELECT flags_json AS f FROM product_price_estimates WHERE product_id = 'p_mix'")!.f) as Array<{ code: string }>).some(
      (f) => flagClass(f.code) === 'hard'
    ),
    'the row itself still holds the applied estimate’s defaults (display only)'
  );
  assert.deepEqual(
    fixed.lines.map((l) => [l.combo_key, l.measure_source]),
    [
      [BLACK, 'owner'],
      [RED, 'colour'],
    ]
  );
  assert.deepEqual(gate(fixed, null), { hard: false, soft: ['EST_MANUAL_PRICE'] }, 'the sheet opens, as the server does');

  // The server names the open flag; the sheet turns it into a box to tick.
  const open = await call(w.app, `${BASE}/products/p_mix/confirm`, { version: version(w.raw), accept_flags: [] });
  assert.deepEqual([open.status, open.body.code], [409, 'PRICE_ESTIMATE_FLAGS_OPEN']);
  const named = openFlagsOf(new ApiError(open.status, String(open.body.error ?? ''), open.body.code, open.body.details));
  assert.deepEqual(named, ['EST_MANUAL_PRICE']);
  assert.deepEqual(gate(fixed, null, named).soft, ['EST_MANUAL_PRICE']);
  const ok = await call(w.app, `${BASE}/products/p_mix/confirm`, { version: version(w.raw), accept_flags: named });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.confirmed, 'whole');
  assert.equal(row<{ l: number }>(w.raw, "SELECT price_estimate AS l FROM products WHERE id = 'p_mix'")!.l, 0);
});
