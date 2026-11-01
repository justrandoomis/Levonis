/**
 * WHAT THE WORKSPACE SHOWS OF A LABELLED PRODUCT AFTER A COMPUTE (docs/SMART_PRICING.md
 * §4.6, §4.9, §7; compute.ts `shownFlags` and the Flags tab's list, EstimateLists' `rowFlags`).
 *
 * A filament the Bambu import created, red and black both priced from the Tmall capture
 * and both on the filament type's default weight and box, is published as an estimate.
 * The row keeps the applied estimate's default measures until the next apply; what the
 * banner and the lists show follows the latest compute's lines:
 *
 *   - the owner saves real measures in the pricing form (the store holds them at once):
 *     after a compute, an option on its real measures is no longer shown under the
 *     default measures, the Flags tab drops the product once none is left, and the
 *     server confirms it — the row itself was never rewritten;
 *   - the owner fills «الأبعاد والوزن» instead (the store keeps the type's measures until
 *     the next apply, since that section fills only an EMPTY pricing measure): after a
 *     compute the default measures are still shown, as the server still refuses the
 *     confirmation; once the refresh is applied they are gone;
 *   - the type's default is a CBM, and the owner saves a box for the product in the pricing
 *     form: the type's CBM still decides that level (a manual CBM beats a box there, LD6),
 *     so the default box stays shown — though the lines call the measure the owner's — as
 *     the server still refuses, except for an option on its own colour's package, or whose
 *     colour has its own box in the pricing form; once the refresh is applied it is gone;
 *   - in «التحديث» a refresh's own price sources show beside the row's flags;
 *   - real measures removed in the pricing form after the latest compute: the row's default
 *     measures are shown again until the next compute, as the server refuses.
 *
 * Run: node --import tsx --test tests/priceEstimateFlagsShown.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { asD1, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { confirmGate } from '../src/components/adminEstimates/ConfirmSheet';
import { rowFlags } from '../src/components/adminEstimates/EstimateLists';
import { FlagList } from '../src/components/adminEstimates/parts';
import { FLAG_SKUS, say } from '../src/components/adminEstimates/strings';
import type { StoredEstimate } from '../src/components/adminEstimates/api';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const RED = 'c:p_fs_red';
const BLACK = 'c:p_fs_black';
const DEFAULTS = [
  { code: 'EST_DEFAULT_BOX', combo_keys: [BLACK, RED] },
  { code: 'EST_DEFAULT_WEIGHT', combo_keys: [BLACK, RED] },
];

function world() {
  const w = pricingWorld();
  w.raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 1300, default_length_mm = 200, default_width_mm = 200, default_height_mm = 100, min_profit_usd = '2' WHERE key = 'filament';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', '${TODAY}', '${'a'.repeat(64)}', 'complete', 'usr_owner', '${NOW}', '${NOW}');
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
      VALUES ('p_fs', 'slug-p_fs', 'PLA Basic', 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', 'COLOR');
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', 'sp_fs', 'p_fs', 'h-fs', 'https://us.store.bambulab.com/products/h-fs', 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock) VALUES ('p_fs_red', 'p_fs', 'red', 'لون', 'ڕەنگ', '#aa3333', 0, 1, NULL);
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock) VALUES ('p_fs_black', 'p_fs', 'black', 'لون', 'ڕەنگ', '#000000', 1, 1, NULL);
    INSERT INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', '1053109777561', 'item', 'filament');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', '1053109777561', '6264995743091', '69');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', '1053109777561', '6264995743092', '69');
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES ('p_fs', '${RED}', 'tmall_cn', '1053109777561', '6264995743091', 'exact', 'owner', 'confirmed', 'usr_owner', '${NOW}', 'sps_tmall', '${NOW}');
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES ('p_fs', '${BLACK}', 'tmall_cn', '1053109777561', '6264995743092', 'exact', 'owner', 'confirmed', 'usr_owner', '${NOW}', 'sps_tmall', '${NOW}');
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
  const res = body === undefined ? await get(app, path) : await post(app, path, body);
  return { status: res.status, body: (await json(res)) as Json };
}

const version = (raw: DatabaseSync) => row<{ version: number }>(raw, "SELECT version FROM product_price_estimates WHERE product_id = 'p_fs'")!.version;
const label = (raw: DatabaseSync) => row<{ l: number }>(raw, "SELECT price_estimate AS l FROM products WHERE id = 'p_fs'")!.l;
/** The row's own column, as compute and apply leave it. */
const storedFlags = (raw: DatabaseSync) => JSON.parse(row<{ f: string }>(raw, "SELECT flags_json AS f FROM product_price_estimates WHERE product_id = 'p_fs'")!.f) as Json[];
/** What the banner, the Estimated list and the sheet are handed. */
const shown = async (app: App) => (await call(app, `${BASE}/products/p_fs`)).body.product as StoredEstimate;
const flagsTab = async (app: App) => ((await call(app, `${BASE}/products?state=flags`)).body.products as StoredEstimate[]).map((p) => p.product_id);
const compute = async (app: App) => (await call(app, `${BASE}/compute`, { product_ids: ['p_fs'] })).body.products[0] as Json;
const apply = async (app: App, hash: string) => (await call(app, `${BASE}/apply`, { items: [{ product_id: 'p_fs', preview_hash: hash, confirm_large_change: true }] })).body.results[0] as Json;

/** Published on the type's default measures: the row, the banner and the Flags tab all name them. */
async function published(w: ReturnType<typeof world>) {
  const first = await compute(w.app);
  assert.match(String(first.preview_hash), /^[0-9a-f]{64}$/, JSON.stringify(first.blocked_by));
  assert.equal((await apply(w.app, first.preview_hash)).outcome, 'applied');
  assert.deepEqual(storedFlags(w.raw), DEFAULTS);
  assert.deepEqual((await shown(w.app)).flags, DEFAULTS);
  assert.deepEqual(await flagsTab(w.app), ['p_fs']);
}

/** The pricing form's save of one colour's real weight and box: a priced save, through its preview. */
async function formMeasures(app: App, colourId: string) {
  await formSave(app, [{ scope: 'color', scope_id: colourId, shipping_weight_g: 1250, shipping_length_mm: 210, shipping_width_mm: 210, shipping_height_mm: 90 }]);
}

/** A priced save of the pricing form's measures (`inputs` as the form sends them), through its preview. */
async function formSave(app: App, inputs: Json[]) {
  const pricing = { cost: { inputs } };
  const seq = async () => (await json(await get(app, '/api/admin/products-v2/p_fs/pricing'))).seq;
  const sheet = await json(await put(app, '/api/admin/products-v2/p_fs/pricing', { seq: await seq(), pricing }));
  assert.equal(sheet.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(sheet).slice(0, 300));
  const saved = await put(app, '/api/admin/products-v2/p_fs/pricing', { seq: await seq(), pricing, preview_hash: sheet.details.preview.review_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())).slice(0, 300));
}

/** Lets the clock pass an instant (on Windows it moves in steps of about 15.6 ms). */
async function past(iso: string) {
  while (new Date().toISOString() <= iso) await new Promise((resolve) => setTimeout(resolve, 5));
}

const confirmAll = async (w: ReturnType<typeof world>) => call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [] });

test('real measures saved in the pricing form: after a compute, an option on them is no longer shown under the default measures, the Flags tab drops the product, and the server confirms it', async () => {
  const w = world();
  await published(w);

  // Red first. The lines say red is on the owner's measures, black still on the type's.
  await formMeasures(w.app, 'p_fs_red');
  await compute(w.app);
  const half = await shown(w.app);
  assert.deepEqual(
    half.lines.map((l) => [l.combo_key, l.measure_source]),
    [
      [BLACK, 'type_default'],
      [RED, 'owner'],
    ]
  );
  assert.deepEqual(half.flags, [
    { code: 'EST_DEFAULT_BOX', combo_keys: [BLACK] },
    { code: 'EST_DEFAULT_WEIGHT', combo_keys: [BLACK] },
  ]);
  assert.deepEqual(await flagsTab(w.app), ['p_fs'], 'black still has its defaults');

  // Then black: nothing is priced from a default measure any more.
  await formMeasures(w.app, 'p_fs_black');
  await compute(w.app);
  const real = await shown(w.app);
  assert.deepEqual(real.lines.map((l) => l.measure_source), ['owner', 'owner']);
  assert.deepEqual(real.flags, [], 'the banner’s «وزن افتراضي / صندوق افتراضي» are gone');
  assert.deepEqual(await flagsTab(w.app), [], 'nothing left to show');
  // Display only: the row is still the applied estimate's (§4.9 reads its soft codes, and the store for D2).
  assert.deepEqual(storedFlags(w.raw), DEFAULTS);

  // The sheet and the server agree: the label comes off with nothing to accept.
  assert.deepEqual(confirmGate(real, null), { hard: false, soft: [] });
  const ok = await call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.confirmed, label(w.raw)], ['whole', 0]);
});

test('real measures entered in «الأبعاد والوزن»: the store keeps the type’s until the refresh is applied, so the default measures stay shown as the server still refuses; after the apply they are gone', async () => {
  const w = world();
  await published(w);

  // The product's package, as the form's «الأبعاد والوزن» stores it: the pricing measures are not empty, so untouched.
  w.raw.exec("UPDATE products SET package_weight_g = 1250, package_depth_mm = 210, package_width_mm = 210, package_height_mm = 90 WHERE id = 'p_fs'");
  const refresh = await compute(w.app);
  assert.deepEqual(refresh.flags, [], 'the refresh itself prices from the package');
  const pending = await shown(w.app);
  assert.deepEqual(pending.lines.map((l) => [l.measure_source, l.flags]), [
    ['product', []],
    ['product', []],
  ]);
  assert.deepEqual(row(w.raw, "SELECT shipping_weight_g AS g, shipping_length_mm AS l FROM pricing_inputs WHERE product_id = 'p_fs' AND scope = 'base'"), { g: 1300, l: 200 });
  assert.deepEqual(pending.flags, DEFAULTS, 'still priced from the default measures: customers pay that price');
  assert.deepEqual(await flagsTab(w.app), ['p_fs']);
  const refused = await call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [] });
  assert.deepEqual([refused.status, refused.body.code, refused.body.details?.combo_keys], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', [BLACK, RED]]);

  // The refresh applied: the store and the row take the package.
  assert.equal((await apply(w.app, refresh.preview_hash)).outcome, 'applied');
  assert.deepEqual(storedFlags(w.raw), []);
  assert.deepEqual((await shown(w.app)).flags, []);
  assert.deepEqual(await flagsTab(w.app), []);
  const ok = await call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('a type whose default is a CBM: a box the owner saves for the product prices nothing while the type’s CBM is still there (LD6), so the default box stays shown as the server refuses — except for an option on its own package; once the refresh is applied it is gone', async () => {
  const w = world();
  // The filament type's default freight measure is a CBM: the apply writes it at the product level as `manual_cbm`.
  w.raw.exec("UPDATE price_estimate_types SET default_cbm = '0.004' WHERE key = 'filament'");
  const baseRow = () => row(w.raw, "SELECT manual_cbm AS cbm, shipping_length_mm AS l, shipping_weight_g AS g FROM pricing_inputs WHERE product_id = 'p_fs' AND scope = 'base'");
  await published(w);
  assert.deepEqual(baseRow(), { cbm: '0.004', l: null, g: 1300 });

  // The pricing form (it has no manual-CBM field): the box once for the product, each colour's own weight.
  await formSave(w.app, [
    { scope: 'base', scope_id: '', shipping_length_mm: 210, shipping_width_mm: 210, shipping_height_mm: 90 },
    ...['p_fs_red', 'p_fs_black'].map((id) => ({ scope: 'color', scope_id: id, shipping_weight_g: 1250 })),
  ]);
  assert.deepEqual((await compute(w.app)).flags, [], 'the refresh prices from the owner’s box and weights');
  const pending = await shown(w.app);
  // The lines describe the store as the refresh leaves it (the type's CBM taken away): the owner's measures. The
  // store still prices from the type's CBM, which decides its level: customers pay that price.
  assert.deepEqual(pending.lines.map((l) => [l.combo_key, l.measure_source, l.flags]), [
    [BLACK, 'owner', []],
    [RED, 'owner', []],
  ]);
  assert.deepEqual(baseRow(), { cbm: '0.004', l: 210, g: 1300 });
  assert.deepEqual(pending.flags, [{ code: 'EST_DEFAULT_BOX', combo_keys: [BLACK, RED] }], 'the default box stays shown; the weights are the owner’s');
  assert.deepEqual(await flagsTab(w.app), ['p_fs']);
  const refused = await call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [] });
  assert.deepEqual([refused.status, refused.body.code, refused.body.details?.combo_keys], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', [BLACK, RED]]);
  assert.deepEqual(storedFlags(w.raw), DEFAULTS, 'display only: the row is the applied estimate’s');

  // Red's own package (its colour's level, above the product's): red is on real measures at once; black still waits.
  w.raw.exec("UPDATE product_colors SET package_weight_g = 1250, package_depth_mm = 210, package_width_mm = 210, package_height_mm = 90 WHERE id = 'p_fs_red'");
  const refresh = await compute(w.app);
  const half = await shown(w.app);
  assert.deepEqual(half.lines.map((l) => [l.combo_key, l.measure_source]), [
    [BLACK, 'owner'],
    [RED, 'colour'],
  ]);
  assert.deepEqual(half.flags, [{ code: 'EST_DEFAULT_BOX', combo_keys: [BLACK] }]);
  assert.deepEqual(await flagsTab(w.app), ['p_fs']);
  const black = await call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [] });
  assert.deepEqual([black.status, black.body.code, black.body.details?.combo_keys], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', [BLACK]], 'the server names black alone');

  // The refresh applied: the type's CBM is gone from the store, the owner's box prices black.
  assert.equal((await apply(w.app, refresh.preview_hash)).outcome, 'applied');
  assert.deepEqual(baseRow(), { cbm: null, l: 210, g: null });
  assert.deepEqual(storedFlags(w.raw), []);
  assert.deepEqual((await shown(w.app)).flags, []);
  assert.deepEqual(await flagsTab(w.app), []);
  const ok = await call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.confirmed, label(w.raw)], ['whole', 0]);
});

test('«التحديث» shows a refresh’s own price sources beside the row’s flags: a price the owner typed after the apply', async () => {
  const w = world();
  await published(w);
  w.raw.exec(`INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at)
              VALUES ('p_fs', '${RED}', '80', 'CNY', 'typed', 'usr_owner', '${NOW}')`);
  const refresh = await compute(w.app);
  assert.deepEqual(
    refresh.lines.map((l: Json) => [l.combo_key, l.source, l.flags.includes('EST_MANUAL_PRICE')]),
    [
      [RED, 'typed', true],
      [BLACK, 'tmall_cn', false],
    ]
  );
  const tab = (await call(w.app, `${BASE}/products?state=refresh`)).body.products as StoredEstimate[];
  assert.deepEqual(tab.map((p) => p.product_id), ['p_fs'], 'red’s price moves');
  const r = tab[0]!;
  // The server's flags are the published estimate's (no typed price) and the lines' default measures.
  assert.deepEqual(r.flags, DEFAULTS);
  assert.deepEqual(rowFlags(r, 'refresh'), [...DEFAULTS, { code: 'EST_MANUAL_PRICE', combo_keys: [RED] }]);
  assert.equal(rowFlags(r, 'estimated'), r.flags, 'the other lists show the server’s flags as they are');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const html = renderToStaticMarkup(createElement(FlagList, { flags: rowFlags(r, 'refresh'), lang }));
    assert.match(html, /data-flag-code="EST_MANUAL_PRICE"/);
    assert.ok(html.includes(say(FLAG_SKUS, lang, { n: 1 })), lang);
  }
  // Applying it stores the refresh's flags; confirm asks for the typed price, as the row now says.
  assert.equal((await apply(w.app, refresh.preview_hash)).outcome, 'applied');
  assert.deepEqual(
    storedFlags(w.raw).map((f) => [f.code, f.combo_keys]),
    [
      ['EST_DEFAULT_BOX', [BLACK, RED]],
      ['EST_DEFAULT_WEIGHT', [BLACK, RED]],
      ['EST_MANUAL_PRICE', [RED]],
    ]
  );
});

test('real measures removed in the pricing form after the latest compute: the row’s default measures are shown again until the next compute, as the server refuses', async () => {
  const w = world();
  await published(w);
  await formMeasures(w.app, 'p_fs_red');
  await formMeasures(w.app, 'p_fs_black');
  const refresh = await compute(w.app);
  assert.deepEqual((await shown(w.app)).flags, []);
  assert.deepEqual(await flagsTab(w.app), []);

  // Both cleared again, with no compute since: the lines still say the owner's measures.
  await past(refresh.computed_at);
  await formSave(
    w.app,
    ['p_fs_red', 'p_fs_black'].map((id) => ({ scope: 'color', scope_id: id, shipping_weight_g: null, shipping_length_mm: null, shipping_width_mm: null, shipping_height_mm: null }))
  );
  const stale = await shown(w.app);
  assert.deepEqual(stale.lines.map((l) => l.measure_source), ['owner', 'owner'], 'the lines are still that compute’s');
  assert.deepEqual(stale.flags, DEFAULTS, 'the banner’s «وزن افتراضي / صندوق افتراضي» are back');
  assert.deepEqual(await flagsTab(w.app), ['p_fs']);
  const refused = await confirmAll(w);
  assert.deepEqual([refused.status, refused.body.code, refused.body.details], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [BLACK, RED] }]);

  // The next compute's lines say it themselves.
  await compute(w.app);
  const again = await shown(w.app);
  assert.deepEqual(again.lines.map((l) => l.measure_source), ['type_default', 'type_default']);
  assert.deepEqual(again.flags, DEFAULTS);
});

test('a type whose default is a CBM, with a box for the product and red’s own box in the pricing form: red’s box decides its CBM, so only black keeps «صندوق افتراضي», as the server says; with black’s own box too, none is left and the price is confirmed', async () => {
  const w = world();
  w.raw.exec("UPDATE price_estimate_types SET default_cbm = '0.004' WHERE key = 'filament'");
  await published(w);
  await formSave(w.app, [
    { scope: 'base', scope_id: '', shipping_length_mm: 210, shipping_width_mm: 210, shipping_height_mm: 90 },
    { scope: 'color', scope_id: 'p_fs_red', shipping_weight_g: 1250, shipping_length_mm: 220, shipping_width_mm: 220, shipping_height_mm: 90 },
    { scope: 'color', scope_id: 'p_fs_black', shipping_weight_g: 1250 },
  ]);
  await compute(w.app);
  const one = await shown(w.app);
  // Both lines are the owner's: red's box is its colour's, black's the product's, which the type's CBM still beats.
  assert.deepEqual(one.lines.map((l) => [l.combo_key, l.measure_source]), [
    [BLACK, 'owner'],
    [RED, 'owner'],
  ]);
  assert.deepEqual(one.flags, [{ code: 'EST_DEFAULT_BOX', combo_keys: [BLACK] }]);
  assert.deepEqual(await flagsTab(w.app), ['p_fs']);
  const black = await confirmAll(w);
  assert.deepEqual([black.status, black.body.code, black.body.details?.combo_keys], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', [BLACK]]);

  await formSave(w.app, [{ scope: 'color', scope_id: 'p_fs_black', shipping_weight_g: 1250, shipping_length_mm: 220, shipping_width_mm: 220, shipping_height_mm: 90 }]);
  await compute(w.app);
  assert.deepEqual((await shown(w.app)).flags, [], 'each colour’s own box prices it');
  assert.deepEqual(await flagsTab(w.app), []);
  const ok = await confirmAll(w);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.confirmed, label(w.raw)], ['whole', 0]);
});
