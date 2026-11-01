/**
 * REAL MEASURES THAT WAIT ON THE REFRESH'S APPLY (docs/SMART_PRICING.md §4.9, §7; compute.ts `LIST_WHERE.refresh`,
 * confirm.ts `waiting_on_apply`, parts.tsx `refusalText`).
 *
 * A filament the Bambu import created, red and black priced from the Tmall capture, is published on the type's
 * default measures. The owner then enters real measures that the store takes only at the next apply, and that
 * apply moves no rounded price:
 *   - «الأبعاد والوزن»: the product's package has the type's very measures (that section fills only an EMPTY
 *     pricing measure, so the store keeps the type's until the apply);
 *   - the type's default is a CBM, and the pricing form saves a box for the product with that very CBM (the type's
 *     CBM still decides that level, LD6, until the apply removes it).
 * In both, «التحديث» lists the product though no price moves, §4.9's refusal says to apply that refresh first
 * (`waiting_on_apply`, in the owner's three languages), the apply from that list goes through, and the
 * confirmation then passes. A product still on the type's own defaults is not listed, and its refusal keeps the
 * contract's words; so does one whose pricing rows moved after the lines. An apply that would take nothing in is
 * never offered — the package's box already taken in, or every option's box decided above the type's CBM — since it
 * would make the options confirmed meanwhile estimates again.
 *
 * Run: node --import tsx --test tests/priceEstimateWaitingApply.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { ApiError } from '../src/lib/api';
import { refusalText } from '../src/components/adminEstimates/parts';
import { CONFIRM, say } from '../src/components/adminEstimates/strings';
import { estimateRefusalText } from '../packages/contracts/src/priceEstimates';
import type { StoredEstimate } from '../src/components/adminEstimates/api';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const RED = 'c:p_fs_red';
const BLACK = 'c:p_fs_black';
const LANGS = ['ar', 'en', 'ckb'] as const;
/** A colour id of 190 characters: some twenty of them fill `flags_json`'s 4,000 characters, so the flags are counted. */
const LONG_COLOUR = (i: number) => `p_fs_${String(i).padStart(2, '0')}_`.padEnd(190, 'x');

/** `extra` more colours beside red and black, each priced at 69 CNY, with ids long enough that their flags pass the column. */
function world(typeMeasures = 'default_length_mm = 200, default_width_mm = 200, default_height_mm = 100', extra = 0) {
  const w = pricingWorld();
  w.raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 1300, ${typeMeasures}, min_profit_usd = '2' WHERE key = 'filament';
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
  for (let i = 0; i < extra; i++) {
    const id = LONG_COLOUR(i);
    w.raw.exec(`
      INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock) VALUES ('${id}', 'p_fs', 'c${i}', 'لون', 'ڕەنگ', '#336699', ${i + 2}, 1, NULL);
      INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', '1053109777561', '62649957431${String(i).padStart(2, '0')}', '69');
      INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
        VALUES ('p_fs', 'c:${id}', 'tmall_cn', '1053109777561', '62649957431${String(i).padStart(2, '0')}', 'exact', 'owner', 'confirmed', 'usr_owner', '${NOW}', 'sps_tmall', '${NOW}');
    `);
  }
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

type World = ReturnType<typeof world>;

async function call(app: World['app'], path: string, body?: unknown) {
  const res = body === undefined ? await get(app, path) : await post(app, path, body);
  return { status: res.status, body: (await json(res)) as Json };
}

const version = (raw: DatabaseSync) => row<{ version: number }>(raw, "SELECT version FROM product_price_estimates WHERE product_id = 'p_fs'")!.version;
/** The options confirmed on their own (firm), in key order. */
const firmKeys = (raw: DatabaseSync) =>
  (raw.prepare("SELECT combo_key AS k FROM price_estimate_firm_skus WHERE product_id = 'p_fs' ORDER BY combo_key").all() as Array<{ k: string }>).map((r) => r.k);
const label = (raw: DatabaseSync) => row<{ l: number }>(raw, "SELECT price_estimate AS l FROM products WHERE id = 'p_fs'")!.l;
const compute = async (app: World['app']) => (await call(app, `${BASE}/compute`, { product_ids: ['p_fs'] })).body.products[0] as Json;
const refreshTab = async (app: World['app']) => (await call(app, `${BASE}/products?state=refresh`)).body.products as StoredEstimate[];
const confirm = (w: World) => call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [] });
/** The base fields the last apply recorded, and where each came from. */
const recorded = (raw: DatabaseSync) =>
  (JSON.parse(row<{ j: string }>(raw, "SELECT applied_wire_json AS j FROM product_price_estimates WHERE product_id = 'p_fs'")!.j).inputs as Json[])
    .filter((f) => f.scope === 'base' && ['shipping_weight_g', 'shipping_box', 'manual_cbm'].includes(f.field))
    .map((f) => [f.field, f.source]);

/** The words the confirmation sheet shows for a refusal, in each language (useAct → refusalText). */
const words = (refused: { status: number; body: Json }) => LANGS.map((lang) => refusalText(new ApiError(refused.status, String(refused.body.error ?? ''), refused.body.code, refused.body.details), lang));

/** Published on the type's default measures. */
async function published(w: World) {
  const first = await compute(w.app);
  assert.match(String(first.preview_hash), /^[0-9a-f]{64}$/, JSON.stringify(first.blocked_by));
  assert.equal((await call(w.app, `${BASE}/apply`, { items: [{ product_id: 'p_fs', preview_hash: first.preview_hash, confirm_large_change: true }] })).body.results[0].outcome, 'applied');
}

/** A priced save of the pricing form's measures, through its preview. */
async function formSave(app: World['app'], inputs: Json[]) {
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

/** The refresh listed in «التحديث» with no price moved, the refusal's cure, the apply from that list, then the confirmation. */
async function waitsThenApplies(w: World) {
  const tab = await refreshTab(w.app);
  assert.deepEqual(tab.map((p) => p.product_id), ['p_fs'], '«التحديث» offers the apply that takes the real measures in');
  const r = tab[0]!;
  assert.deepEqual(r.lines.map((l) => [l.combo_key, l.published_price_iqd === l.est_price_iqd]), [
    [BLACK, true],
    [RED, true],
  ], 'no rounded price moves');
  assert.equal(r.state, 'estimated');
  assert.match(String(r.preview_hash), /^[0-9a-f]{64}$/, 'the list can apply it');

  // §4.9 refuses on the store's defaults, and says the cure is that apply — words only, the options refused the same.
  const refused = await confirm(w);
  assert.deepEqual([refused.status, refused.body.code, refused.body.details], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [BLACK, RED], waiting_on_apply: true }]);
  assert.deepEqual(words(refused), LANGS.map((lang) => say(CONFIRM.applyFirst, lang)));
  assert.equal(label(w.raw), 1);

  // The apply from «التحديث» goes through though nothing is repriced; then the label comes off.
  const applied = await call(w.app, `${BASE}/apply`, { items: [{ product_id: 'p_fs', preview_hash: r.preview_hash, confirm_large_change: true }] });
  assert.equal(applied.body.results[0].outcome, 'applied', JSON.stringify(applied.body).slice(0, 300));
  assert.deepEqual(await refreshTab(w.app), [], 'nothing left to take in');
  const ok = await confirm(w);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.confirmed, label(w.raw)], ['whole', 0]);
}

test('the product’s package with the type’s very measures: «التحديث» lists the refresh though no price moves, the refusal says to apply it first, and once applied the price is confirmed', async () => {
  const w = world();
  await published(w);
  assert.deepEqual(recorded(w.raw), [
    ['shipping_weight_g', 'type_default'],
    ['shipping_box', 'type_default'],
  ]);
  w.raw.exec("UPDATE products SET package_weight_g = 1300, package_depth_mm = 200, package_width_mm = 200, package_height_mm = 100 WHERE id = 'p_fs'");
  const refresh = await compute(w.app);
  assert.deepEqual(refresh.lines.map((l: Json) => [l.measure_source, l.est_price_iqd, l.published_price_iqd]), [
    ['product', 20_500, 20_500],
    ['product', 20_500, 20_500],
  ]);
  await waitsThenApplies(w);
  assert.deepEqual(recorded(w.raw), [
    ['shipping_weight_g', 'product_package'],
    ['shipping_box', 'product_package'],
  ], 'the store’s values are now the package’s');
});

test('the type’s CBM beside the owner’s box of the very same CBM: «التحديث» lists the refresh though no price moves, the refusal says to apply it first, and once applied the price is confirmed', async () => {
  const w = world("default_cbm = '0.004'");
  await published(w);
  const baseRow = () => row(w.raw, "SELECT manual_cbm AS cbm, shipping_length_mm AS l FROM pricing_inputs WHERE product_id = 'p_fs' AND scope = 'base'");
  // 200 × 200 × 100 mm is the type's 0.004 m³; each colour's weight is the type's 1,300 g.
  await formSave(w.app, [
    { scope: 'base', scope_id: '', shipping_length_mm: 200, shipping_width_mm: 200, shipping_height_mm: 100 },
    ...['p_fs_red', 'p_fs_black'].map((id) => ({ scope: 'color', scope_id: id, shipping_weight_g: 1300 })),
  ]);
  assert.deepEqual(baseRow(), { cbm: '0.004', l: 200 }, 'the type’s CBM still decides the product level');
  const refresh = await compute(w.app);
  assert.deepEqual(refresh.lines.map((l: Json) => [l.measure_source, l.est_price_iqd, l.published_price_iqd]), [
    ['owner', 20_500, 20_500],
    ['owner', 20_500, 20_500],
  ]);
  await waitsThenApplies(w);
  assert.deepEqual(baseRow(), { cbm: null, l: 200 }, 'the apply removed the type’s CBM: the owner’s box prices the product');
});

test('still on the type’s own defaults, or with pricing rows written after the lines: the refusal keeps the contract’s words', async () => {
  const w = world("default_cbm = '0.004'");
  await published(w);
  const contract = LANGS.map((lang) => estimateRefusalText('PRICE_ESTIMATE_DEFAULT_MEASURES', lang));
  // Nothing real entered: nothing for «التحديث» to take in, and the cure is the real measures.
  assert.deepEqual(await refreshTab(w.app), []);
  const plain = await confirm(w);
  assert.deepEqual([plain.status, plain.body.code, plain.body.details], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [BLACK, RED] }]);
  assert.deepEqual(words(plain), contract);

  // The owner's box for the product, under the type's CBM: the refresh takes it in.
  await formSave(w.app, [
    { scope: 'base', scope_id: '', shipping_length_mm: 210, shipping_width_mm: 210, shipping_height_mm: 90 },
    ...['p_fs_red', 'p_fs_black'].map((id) => ({ scope: 'color', scope_id: id, shipping_weight_g: 1250 })),
  ]);
  const refresh = await compute(w.app);
  assert.equal((await confirm(w)).body.details?.waiting_on_apply, true);
  // The box removed again after that compute: the lines no longer say what the store holds, so no such cure is told.
  await past(refresh.computed_at);
  await formSave(w.app, [{ scope: 'base', scope_id: '', shipping_length_mm: null, shipping_width_mm: null, shipping_height_mm: null }]);
  const moved = await confirm(w);
  assert.deepEqual([moved.status, moved.body.code, moved.body.details], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [BLACK, RED] }]);
  assert.deepEqual(words(moved), contract);
});

test('so many options that the applied default measures are stored counted: «التحديث» offers the apply that takes the package’s box in once, then never again — the options confirmed since stay firm', async () => {
  const w = world(undefined, 22);
  const stored = () => JSON.parse(row<{ f: string }>(w.raw, "SELECT flags_json AS f FROM product_price_estimates WHERE product_id = 'p_fs'")!.f) as Json[];
  const firm = () => row<{ n: number }>(w.raw, "SELECT COUNT(*) AS n FROM price_estimate_firm_skus WHERE product_id = 'p_fs'")!.n;
  const confirmReal = () => call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [], combo_keys: [BLACK, RED] });
  await published(w);
  // 24 options on the type's measures: their keys do not fit the column, so each default is stored with its count.
  assert.deepEqual(stored(), [
    { code: 'EST_DEFAULT_BOX', count: 24 },
    { code: 'EST_DEFAULT_WEIGHT', count: 24 },
  ]);
  // «الأبعاد والوزن»: the product's package has the type's very box; red and black get their real weight.
  w.raw.exec("UPDATE products SET package_depth_mm = 200, package_width_mm = 200, package_height_mm = 100 WHERE id = 'p_fs'");
  await formSave(w.app, [RED, BLACK].map((k) => ({ scope: 'color', scope_id: k.slice(2), shipping_weight_g: 1300 })));
  const refresh = await compute(w.app);
  assert.deepEqual(
    [...new Set(refresh.lines.map((l: Json) => `${[RED, BLACK].includes(l.combo_key) ? 'real' : 'other'}:${l.measure_source}:${l.est_price_iqd === l.published_price_iqd}`))].sort(),
    ['other:type_default:true', 'real:product:true']
  );

  // The box waits on the apply: listed once, and §4.9 says so for red and black.
  const tab = await refreshTab(w.app);
  assert.deepEqual(tab.map((p) => p.product_id), ['p_fs']);
  const refused = await confirmReal();
  assert.deepEqual([refused.status, refused.body.code, refused.body.details], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [BLACK, RED], waiting_on_apply: true }]);
  const applied = await call(w.app, `${BASE}/apply`, { items: [{ product_id: 'p_fs', preview_hash: tab[0]!.preview_hash, confirm_large_change: true }] });
  assert.equal(applied.body.results[0].outcome, 'applied', JSON.stringify(applied.body).slice(0, 300));
  assert.deepEqual(stored(), [{ code: 'EST_DEFAULT_WEIGHT', count: 22 }], 'the other options stay on the type’s weight');
  assert.deepEqual(recorded(w.raw), [
    ['shipping_weight_g', 'type_default'],
    ['shipping_box', 'product_package'],
  ]);

  // Nothing is left for an apply to take in: not offered again, not after the next compute either.
  assert.deepEqual(await refreshTab(w.app), []);
  const ok = await confirmReal();
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.confirmed, firm()], ['skus', 2]);
  await compute(w.app);
  assert.deepEqual(await refreshTab(w.app), [], 'no 0.00% apply that would make the confirmed options estimates again');
  assert.equal(firm(), 2);
});

test('the package’s box taken in at the last apply, then one colour weighed a day: «التحديث» never offers an apply that takes nothing in, and the options confirmed stay firm', async () => {
  const w = world(undefined, 1);
  // «الأبعاد والوزن»: the product's package has the type's very box, and no weight.
  w.raw.exec("UPDATE products SET package_depth_mm = 200, package_width_mm = 200, package_height_mm = 100 WHERE id = 'p_fs'");
  await published(w);
  assert.deepEqual(recorded(w.raw), [
    ['shipping_weight_g', 'type_default'],
    ['shipping_box', 'product_package'],
  ]);
  const weighed: string[] = [];
  for (const key of [RED, BLACK]) {
    weighed.push(key);
    // The type's very weight, so no price moves; the colour's line names the weaker of its two measures, the package's box.
    await formSave(w.app, [{ scope: 'color', scope_id: key.slice(2), shipping_weight_g: 1300 }]);
    const lines = (await compute(w.app)).lines as Json[];
    assert.deepEqual(lines.filter((l) => l.combo_key === key).map((l) => [l.measure_source, l.est_price_iqd === l.published_price_iqd]), [['product', true]]);
    const ok = await call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [], combo_keys: [...weighed] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.confirmed, 'skus');
    await compute(w.app);
    assert.deepEqual(await refreshTab(w.app), [], 'the store already holds every real measure: nothing for an apply to take in');
    assert.deepEqual(firmKeys(w.raw), [...weighed].sort(), 'the options confirmed stay firm');
  }
});

test('every colour weighed in the pricing form, then the product’s package given a weight: «التحديث» offers no apply, since that weight would reach no option', async () => {
  const w = world();
  w.raw.exec("UPDATE products SET package_depth_mm = 200, package_width_mm = 200, package_height_mm = 100 WHERE id = 'p_fs'");
  await published(w);
  await formSave(w.app, ['p_fs_red', 'p_fs_black'].map((id) => ({ scope: 'color', scope_id: id, shipping_weight_g: 1300 })));
  await compute(w.app);
  const ok = await call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [], combo_keys: [RED] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // «الأبعاد والوزن»: the package now has a weight, which the next apply would put in place of the type's at the
  // product level — under each colour's own weight.
  w.raw.exec("UPDATE products SET package_weight_g = 1250 WHERE id = 'p_fs'");
  const refresh = await compute(w.app);
  assert.deepEqual(refresh.lines.map((l: Json) => [l.measure_source, l.est_price_iqd === l.published_price_iqd]), [
    ['product', true],
    ['product', true],
  ]);
  assert.deepEqual(await refreshTab(w.app), [], 'nothing for an apply to take in');
  assert.deepEqual(firmKeys(w.raw), [RED], 'red stays firm');
});

test('the type’s CBM beside the owner’s box, each colour with its own box: «التحديث» offers no apply that takes nothing in, and the option confirmed stays firm', async () => {
  const w = world("default_cbm = '0.004'");
  await published(w);
  // 200 × 200 × 100 mm is the type's 0.004 m³: a box for the product and for each colour, so no price moves.
  const box = { shipping_length_mm: 200, shipping_width_mm: 200, shipping_height_mm: 100 };
  await formSave(w.app, [{ scope: 'base', scope_id: '', ...box }, ...['p_fs_red', 'p_fs_black'].map((id) => ({ scope: 'color', scope_id: id, ...box }))]);
  await compute(w.app);
  assert.deepEqual(await refreshTab(w.app), [], 'the type’s CBM decides no option’s box: removing it prices nothing');
  await formSave(w.app, [{ scope: 'color', scope_id: 'p_fs_red', shipping_weight_g: 1300 }]);
  await compute(w.app);
  const ok = await call(w.app, `${BASE}/products/p_fs/confirm`, { version: version(w.raw), accept_flags: [], combo_keys: [RED] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await compute(w.app);
  assert.deepEqual(await refreshTab(w.app), []);
  assert.deepEqual(firmKeys(w.raw), [RED], 'red stays firm');
});
