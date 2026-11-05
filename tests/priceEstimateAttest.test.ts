/**
 * «تأكيد السعر» WITH THE OWNER'S STATEMENT OF REAL MEASURES (docs/SMART_PRICING.md §4.9 step 0; DECISIONS
 * row 292; owner 2026-11-04 «there as problem i cant click on تأكيد السعر»).
 *
 * The owner's Maker's Supply flush cutter, one SKU at 52.5 CNY by sea, published on its type's default measures
 * (0.1 kg, 16 × 11 × 3 cm). The confirmation sheet shows those values with «هذه القياسات صحيحة لهذا المنتج»;
 * ticked, ONE fenced batch takes them as the product's real package, re-records the base fields as the package's,
 * rewrites the lines, flags and basis as the next compute and apply write them, and confirms:
 *   - without the statement, D2 refuses exactly as before; with it, the label comes off, the package is written
 *     where it was empty, and no price moves — the pricing inputs, sequence and published V2 prices are untouched;
 *   - a statement the store no longer matches is PRICING_CHANGED; one that cannot be taken (the type's CBM, a
 *     package that differs or is partial) is refused with its reason, and nothing is written; a package already
 *     equal is not written again;
 *   - atomic and fenced: an open soft flag refuses the whole call; a pricing save, a package typed or a compute
 *     between the reads and the batch, or a catalogue import running, rolls everything back; the open product form
 *     then meets STALE_EDIT, never writes its empty package back;
 *   - options: the statement is the product's (its base row), so every option on those defaults becomes real while
 *     only the chosen ones turn firm; the Flags and «التحديث» lists and the next compute agree;
 *   - every whole confirmation leaves no default-measure flag on the row: a confirmed product never shows
 *     «وزن افتراضي»;
 *   - `confirm_gate` (GET /products/:id) answers what the confirmation does, before anything is sent.
 *
 * Run: node --import tsx --test tests/priceEstimateAttest.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, failingD1, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { keepEdits, toEditorDoc, withStatedPackage, type EditorDoc, type StatedPackage } from '../src/components/adminProducts/types';
import { hydrateRelations, relationsToWire, type RelationsState } from '../src/components/adminProducts/form/model';
import { emptyDimensions } from '../src/lib/productTypes';
import { shownFlags } from '../worker/lib/pricingEngine/estimate/compute';
import { docWithoutLegacyMoney, withoutLegacyMoney } from '../src/components/adminProducts/form/v2/v2Model';
import { ApiError } from '../src/lib/api';
import { measureHold, statementOf } from '../src/components/adminEstimates/ConfirmSheet';
import { refusalText } from '../src/components/adminEstimates/parts';
import { CONFIRM, flagText, say } from '../src/components/adminEstimates/strings';
import type { StoredEstimate } from '../src/components/adminEstimates/api';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const PID = 'p_cut';
/** The type's defaults the estimate is priced from: 0.1 kg, 16 × 11 × 3 cm ([L, W, H] in mm). */
const STATED = { weight_g: 100, box_mm: [160, 110, 30] };
const LANGS = ['ar', 'en', 'ckb'] as const;

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.use('/api/admin/*', noStoreUnlessSet);
  a.route('/api/admin/pricing', adminPricingRoutes);
  a.route(BASE, adminPriceEstimatesRoutes);
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
};

/** The flush cutter the import created, typed `makers_supply` by the owner, its Tmall price matched; `colours` makes it a two-colour product. */
function world(o: { typeMeasures?: string; colours?: string[] } = {}) {
  const w = pricingWorld();
  const measures = o.typeMeasures ?? 'default_length_mm = 160, default_width_mm = 110, default_height_mm = 30';
  w.raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 100, ${measures}, min_profit_usd = '2' WHERE key = 'makers_supply';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', '${TODAY}', '${'a'.repeat(64)}', 'complete', 'usr_owner', '${NOW}', '${NOW}');
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
      VALUES ('${PID}', 'slug-${PID}', 'Maker''s Supply Flush Cutter', 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', '${o.colours?.length ? 'COLOR' : 'BASE'}');
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', 'sp_cut', '${PID}', 'h-cut', 'https://us.store.bambulab.com/products/h-cut', 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
    INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('${PID}', 'makers_supply', 'owner', '${NOW}');
    INSERT INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', '1053109777591', 'item', 'tool');
  `);
  const keys = o.colours?.length ? o.colours.map((c) => `c:${PID}_${c}`) : [''];
  (o.colours ?? []).forEach((c, k) => {
    w.raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock) VALUES ('${PID}_${c}', '${PID}', '${c}', 'لون', 'ڕەنگ', '#336699', ${k}, 1, NULL)`);
  });
  keys.forEach((key, k) => {
    w.raw.exec(`
      INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', '1053109777591', '62649957431${k}', '52.5');
      INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
        VALUES ('${PID}', '${key}', 'tmall_cn', '1053109777591', '62649957431${k}', 'exact', 'owner', 'confirmed', 'usr_owner', '${NOW}', 'sps_tmall', '${NOW}');
    `);
  });
  return { ...w, app: stubApp(asD1(w.raw), OWNER, mount, { publishV2: false }), keys };
}

type World = ReturnType<typeof world>;
type App = World['app'];

async function call(app: App, path: string, body?: unknown) {
  const res = body === undefined ? await get(app, path) : await post(app, path, body);
  return { status: res.status, body: (await json(res)) as Json };
}

const compute = async (app: App) => (await call(app, `${BASE}/compute`, { product_ids: [PID] })).body.products[0] as Json;

/** Computed and applied: published on the type's defaults. */
async function published(w: World) {
  const first = await compute(w.app);
  assert.match(String(first.preview_hash), /^[0-9a-f]{64}$/, JSON.stringify(first.blocked_by));
  const a = await call(w.app, `${BASE}/apply`, { items: [{ product_id: PID, preview_hash: first.preview_hash, confirm_large_change: true }] });
  assert.equal(a.body.results[0].outcome, 'applied', JSON.stringify(a.body).slice(0, 300));
}

const version = (raw: DatabaseSync) => row<{ version: number }>(raw, 'SELECT version FROM product_price_estimates WHERE product_id = ?', PID)!.version;
const label = (raw: DatabaseSync) => row<{ l: number }>(raw, 'SELECT price_estimate AS l FROM products WHERE id = ?', PID)!.l;
const shown = async (app: App) => (await call(app, `${BASE}/products/${PID}`)).body.product as StoredEstimate & Json;
const confirm = (w: World, body: Json = {}) => call(w.app, `${BASE}/products/${PID}/confirm`, { version: version(w.raw), accept_flags: [], ...body });
const pkg = (raw: DatabaseSync) => row<Json>(raw, 'SELECT package_weight_g AS g, package_depth_mm AS d, package_width_mm AS w, package_height_mm AS h, updated_at FROM products WHERE id = ?', PID)!;
/** The base fields the last apply recorded and where each came from. */
const recorded = (raw: DatabaseSync) =>
  (JSON.parse(row<{ j: string }>(raw, 'SELECT applied_wire_json AS j FROM product_price_estimates WHERE product_id = ?', PID)!.j).inputs as Json[])
    .filter((f) => f.scope === 'base' && ['shipping_weight_g', 'shipping_box', 'manual_cbm'].includes(f.field))
    .map((f) => [f.field, f.source]);
const storedFlags = (raw: DatabaseSync) => JSON.parse(row<{ f: string }>(raw, 'SELECT flags_json AS f FROM product_price_estimates WHERE product_id = ?', PID)!.f) as Json[];
const lines = (raw: DatabaseSync) =>
  all<{ combo_key: string; measure_source: string; flags_json: string }>(raw, 'SELECT combo_key, measure_source, flags_json FROM price_estimate_lines WHERE product_id = ? ORDER BY combo_key', PID).map((l) => [
    l.combo_key,
    l.measure_source,
    JSON.parse(l.flags_json),
  ]);
/** The stored lines as the next compute rewrites them (every column it writes but the time). */
const lineRows = (raw: DatabaseSync) =>
  all(
    raw,
    `SELECT combo_key, channel, price_source, supplier_amount, supplier_currency, measure_source, flags_json, est_cost_iqd, est_price_iqd, published_price_iqd
       FROM price_estimate_lines WHERE product_id = ? ORDER BY combo_key, channel`,
    PID
  );
/** Everything a price is made of and everything published: none of it may move. */
const prices = (raw: DatabaseSync) =>
  JSON.stringify([
    all(raw, 'SELECT * FROM pricing_inputs WHERE product_id = ? ORDER BY scope, scope_id, origin', PID),
    all(raw, 'SELECT * FROM product_pricing_state WHERE product_id = ?', PID),
    all(raw, 'SELECT combo_key, channel, final_price_iqd FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key, channel', PID),
  ]);
/** Everything the statement or the confirmation could write. */
const everything = (raw: DatabaseSync) =>
  JSON.stringify([
    prices(raw),
    pkg(raw),
    label(raw),
    all(raw, 'SELECT * FROM product_price_estimates WHERE product_id = ?', PID),
    all(raw, 'SELECT * FROM price_estimate_lines WHERE product_id = ? ORDER BY combo_key, channel', PID),
    all(raw, 'SELECT * FROM price_estimate_firm_skus WHERE product_id = ?', PID),
    all(raw, "SELECT action, detail FROM audit_log WHERE action LIKE 'price_estimate.%' ORDER BY rowid"),
  ]);
const audits = (raw: DatabaseSync, action: string) => all<{ detail: string }>(raw, 'SELECT detail FROM audit_log WHERE action = ? AND target = ? ORDER BY rowid', action, PID).map((a) => JSON.parse(a.detail));

test('the flush cutter on its type’s defaults: refused as before without the statement; with it, the package is written, the records, lines, flags and basis become real, the label comes off — and no price moves', async () => {
  const w = world();
  await published(w);
  assert.deepEqual(recorded(w.raw), [
    ['shipping_weight_g', 'type_default'],
    ['shipping_box', 'type_default'],
  ]);
  assert.deepEqual(row(w.raw, "SELECT shipping_weight_g AS g, shipping_length_mm AS l, shipping_width_mm AS w, shipping_height_mm AS h FROM pricing_inputs WHERE product_id = ? AND scope = 'base'", PID), { g: 100, l: 160, w: 110, h: 30 });

  // The live gate offers exactly the values the price is computed from.
  const before = await shown(w.app);
  assert.deepEqual(before.confirm_gate, { defaulted: [''], waiting_on_apply: false, waiting_keys: [], real_measures: { ...STATED, combo_keys: [''] }, blocked: null });
  assert.ok(before.flags.some((f) => f.code === 'EST_DEFAULT_WEIGHT') && before.flags.some((f) => f.code === 'EST_DEFAULT_BOX'), 'the banner’s «وزن افتراضي / صندوق افتراضي»');

  // No statement: D2 as before, nothing written.
  const untouched = everything(w.raw);
  const plain = await confirm(w);
  assert.deepEqual([plain.status, plain.body.code, plain.body.details], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [''] }]);
  assert.equal(everything(w.raw), untouched);

  // The statement, as the sheet sends it once ticked.
  const priced = prices(w.raw);
  const updatedAt = pkg(w.raw).updated_at;
  const v = version(w.raw);
  const ok = await confirm(w, { real_measures: STATED });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.confirmed, ok.body.firm, ok.body.version], ['whole', [], v + 1]);
  assert.equal(label(w.raw), 0, 'the label is gone');
  const p = pkg(w.raw);
  assert.deepEqual([p.g, p.d, p.w, p.h], [100, 160, 110, 30], '[L, W, H] → depth, width, height');
  assert.notEqual(p.updated_at, updatedAt, 'the product’s version moved: an open form saves no stale copy');
  assert.deepEqual(recorded(w.raw), [
    ['shipping_weight_g', 'product_package'],
    ['shipping_box', 'product_package'],
  ]);
  assert.deepEqual(storedFlags(w.raw).filter((f) => /^EST_DEFAULT_/.test(f.code)), []);
  assert.deepEqual(lines(w.raw), [['', 'product', []]]);
  const e = row<Json>(w.raw, 'SELECT state, measure_basis, confirmed_by FROM product_price_estimates WHERE product_id = ?', PID)!;
  assert.deepEqual([e.state, e.measure_basis, e.confirmed_by], ['confirmed', 'real', 'usr_owner']);
  // No price moved: the inputs, the pricing sequence and every published price are as they were.
  assert.equal(prices(w.raw), priced);
  // The audit, names only; the confirmation says it carried a statement.
  assert.deepEqual(audits(w.raw, 'price_estimate.measures_attested'), [
    { product_id: PID, fields: ['shipping_weight_g', 'shipping_box'], package: ['package_weight_g', 'package_depth_mm', 'package_width_mm', 'package_height_mm'], skus: 1 },
  ]);
  assert.deepEqual(audits(w.raw, 'price_estimate.confirmed'), [{ product_id: PID, whole: true, skus: 1, accepted_flags: [], measures_attested: true }]);
  // The banner shows a confirmed product with no default measure.
  const after = await shown(w.app);
  assert.equal(after.state, 'confirmed');
  assert.equal(after.confirm_gate, undefined, 'a gate only for an estimated product');
  assert.deepEqual(after.flags.filter((f) => /^EST_DEFAULT_/.test(f.code)), []);
});

test('the sheet sends exactly the values the gate answered, only once ticked — and says each refusal in the owner’s words', async () => {
  const w = world();
  await published(w);
  const s = await shown(w.app);
  const hold = measureHold(s, null);
  assert.deepEqual(hold, { hard: true, live: true, statement: { weight_g: 100, box_mm: [160, 110, 30] }, reason: null });
  assert.equal(statementOf(hold, false), undefined, 'never without the tick');
  assert.deepEqual(statementOf(hold, true), STATED);
  // The server's words for a statement it cannot take, with the cure.
  for (const [reason, words] of [
    ['type_cbm', CONFIRM.typeCbm],
    ['package_differs', CONFIRM.packageDiffers],
    ['package_partial', CONFIRM.packagePartial],
    ['below_net', CONFIRM.belowNet],
  ] as const) {
    for (const lang of LANGS) assert.equal(refusalText(new ApiError(409, 'x', 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [''], reason }), lang), say(words, lang), `${reason} ${lang}`);
  }
});

test('a statement the store no longer matches is PRICING_CHANGED; one that cannot be taken is refused with its reason; a malformed one is refused — nothing written', async () => {
  const w = world();
  await published(w);
  const untouched = everything(w.raw);
  // Not what the price is computed from (101 g): what the owner saw is not the store.
  const off = await confirm(w, { real_measures: { ...STATED, weight_g: 101 } });
  assert.deepEqual([off.status, off.body.code], [409, 'PRICING_CHANGED']);
  const box = await confirm(w, { real_measures: { box_mm: [160, 110, 31] } });
  assert.deepEqual([box.status, box.body.code], [409, 'PRICING_CHANGED']);
  for (const bad of [{}, { weight_g: 0 }, { weight_g: 1.5 }, { weight_g: '100' }, { box_mm: [160, 110] }, { box_mm: [160, 110, 0] }, { box_mm: 'x' }, null, []]) {
    const r = await confirm(w, { real_measures: bad });
    assert.deepEqual([r.status, r.body.code, r.body.details?.field], [400, 'PRICING_INPUT_INVALID', 'real_measures'], JSON.stringify(bad));
  }
  const unknown = await confirm(w, { real_measures: { ...STATED, cbm: '0.1' } });
  assert.deepEqual([unknown.status, unknown.body.code, unknown.body.details?.field], [400, 'UNKNOWN_FIELD', 'cbm']);
  assert.equal(everything(w.raw), untouched);

  // «الأبعاد والوزن» holds another weight: the package is real, and the refresh's apply takes it in (the price moves).
  w.raw.exec(`UPDATE products SET package_weight_g = 120 WHERE id = '${PID}'`);
  const typed = everything(w.raw);
  assert.equal((await shown(w.app)).confirm_gate!.blocked, 'package_differs');
  const differs = await confirm(w, { real_measures: STATED });
  assert.deepEqual([differs.status, differs.body.code, differs.body.details], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [''], reason: 'package_differs' }]);
  assert.equal(everything(w.raw), typed);
  // …and another box too. After a compute «التحديث» lists it (the box moves the price): the refusal says that apply is the cure.
  w.raw.exec(`UPDATE products SET package_depth_mm = 170, package_width_mm = 110, package_height_mm = 30 WHERE id = '${PID}'`);
  await compute(w.app);
  const gate = (await shown(w.app)).confirm_gate!;
  assert.deepEqual([gate.blocked, gate.waiting_on_apply, gate.real_measures], ['package_differs', true, null]);
  const waiting = await confirm(w, { real_measures: STATED });
  assert.deepEqual(waiting.body.details, { combo_keys: [''], reason: 'package_differs', waiting_on_apply: true });
  assert.equal(refusalText(new ApiError(409, 'x', waiting.body.code, waiting.body.details), 'en'), say(CONFIRM.applyFirst, 'en'), 'the apply is the cure');

  // One box side typed: partial.
  w.raw.exec(`UPDATE products SET package_weight_g = NULL, package_depth_mm = 160, package_width_mm = NULL, package_height_mm = NULL WHERE id = '${PID}'`);
  const partial = await confirm(w, { real_measures: STATED });
  assert.deepEqual([partial.body.code, partial.body.details?.reason], ['PRICE_ESTIMATE_DEFAULT_MEASURES', 'package_partial']);
  assert.equal((await shown(w.app)).confirm_gate!.blocked, 'package_partial');
});

test('a type priced from its CBM: there is no box to state — the gate and the server say so, and a weight alone confirms nothing', async () => {
  const w = world({ typeMeasures: "default_cbm = '0.000528'" });
  await published(w);
  assert.deepEqual(recorded(w.raw), [
    ['shipping_weight_g', 'type_default'],
    ['manual_cbm', 'type_default'],
  ]);
  const gate = (await shown(w.app)).confirm_gate!;
  assert.deepEqual(gate, { defaulted: [''], waiting_on_apply: false, waiting_keys: [], real_measures: null, blocked: 'type_cbm' });
  const untouched = everything(w.raw);
  const box = await confirm(w, { real_measures: { box_mm: [160, 110, 30] } });
  assert.deepEqual([box.status, box.body.code, box.body.details], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [''], reason: 'type_cbm' }]);
  // The weight is the type's too, and stated real; the CBM still is not: refused as before, nothing written.
  const weight = await confirm(w, { real_measures: { weight_g: 100 } });
  assert.deepEqual([weight.status, weight.body.code, weight.body.details], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [''] }]);
  assert.equal(everything(w.raw), untouched);
});

test('a package that already holds the very values: nothing is written to the product, the records are re-sourced, and the label comes off', async () => {
  const w = world();
  await published(w);
  // «الأبعاد والوزن» typed with the type's very values after the apply (S3): the store keeps the defaults until an apply.
  w.raw.exec(`UPDATE products SET package_weight_g = 100, package_depth_mm = 160, package_width_mm = 110, package_height_mm = 30 WHERE id = '${PID}'`);
  const gate = (await shown(w.app)).confirm_gate!;
  assert.deepEqual(gate.real_measures, { ...STATED, combo_keys: [''] }, 'the statement is still on offer');
  const product = pkg(w.raw);
  const ok = await confirm(w, { real_measures: STATED });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(pkg(w.raw), product, 'no product write: its version stays');
  assert.deepEqual(recorded(w.raw), [
    ['shipping_weight_g', 'product_package'],
    ['shipping_box', 'product_package'],
  ]);
  assert.deepEqual(audits(w.raw, 'price_estimate.measures_attested')[0].package, []);
  assert.equal(label(w.raw), 0);
});

test('atomic: an open soft flag refuses the statement with the confirmation, nothing written; named, both pass', async () => {
  const w = world();
  // The owner's own typed price: EST_MANUAL_PRICE to accept by name.
  w.raw.exec(`INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at) VALUES ('${PID}', '', '52.5', 'CNY', 'typed', 'usr_owner', '${NOW}')`);
  await published(w);
  const untouched = everything(w.raw);
  const open = await confirm(w, { real_measures: STATED });
  assert.deepEqual([open.status, open.body.code, open.body.details?.flags], [409, 'PRICE_ESTIMATE_FLAGS_OPEN', ['EST_MANUAL_PRICE']]);
  assert.equal(everything(w.raw), untouched, 'the package and the records untouched');
  const ok = await confirm(w, { real_measures: STATED, accept_flags: ['EST_MANUAL_PRICE'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(audits(w.raw, 'price_estimate.confirmed'), [{ product_id: PID, whole: true, skus: 1, accepted_flags: ['EST_MANUAL_PRICE'], measures_attested: true }]);
  assert.equal(pkg(w.raw).g, 100);
});

test('fenced: a pricing save, a package typed, a compute or a catalogue import between the reads and the batch rolls the statement and the confirmation back', async () => {
  const w = world();
  await published(w);
  const { failing, db } = failingD1(w.raw);
  const racing = stubApp(db, OWNER, mount, { publishV2: false });
  /** The confirmation's batch, with `write` landing just before it (a concurrent writer). */
  const race = async (write: string) => {
    let armed = true;
    failing.beforeBatch = (statements) => {
      if (!armed || !statements.some((s) => /SET price_estimate = 0/.test(s.sql))) return;
      armed = false;
      w.raw.exec(write);
    };
    const r = await call(racing, `${BASE}/products/${PID}/confirm`, { version: version(w.raw), accept_flags: [], real_measures: STATED });
    failing.beforeBatch = null;
    return r;
  };
  const before = () => everything(w.raw);

  // A pricing-form save (the sequence moves; the values stay what the owner saw).
  let snapshot = before();
  const seq = await race(`UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = '${PID}'`);
  assert.deepEqual([seq.status, seq.body.code], [409, 'PRICING_CHANGED']);
  w.raw.exec(`UPDATE product_pricing_state SET inputs_seq = inputs_seq - 1 WHERE product_id = '${PID}'`);
  assert.equal(before(), snapshot, 'nothing else written');

  // A package typed meanwhile: the conditional write leaves it, and the fence on the stated values refuses.
  snapshot = before();
  const typed = await race(`UPDATE products SET package_weight_g = 150 WHERE id = '${PID}'`);
  assert.deepEqual([typed.status, typed.body.code], [409, 'PRICING_CHANGED']);
  assert.equal(pkg(w.raw).g, 150, 'the value typed meanwhile stays');
  assert.equal(label(w.raw), 1);
  w.raw.exec(`UPDATE products SET package_weight_g = NULL WHERE id = '${PID}'`);
  assert.equal(before(), snapshot);

  // A compute meanwhile (the version moves).
  const computed = await race(`UPDATE product_price_estimates SET version = version + 1 WHERE product_id = '${PID}'`);
  assert.deepEqual([computed.status, computed.body.code], [409, 'PRICING_CHANGED']);
  assert.deepEqual(recorded(w.raw), [
    ['shipping_weight_g', 'type_default'],
    ['shipping_box', 'type_default'],
  ]);

  // A catalogue import starts: its guards refuse the package and the bookkeeping, said as a reason.
  snapshot = before();
  const importing = await race("INSERT INTO ops_guards (id, ok) VALUES ('catalog-import-batch', 1)");
  assert.deepEqual([importing.status, importing.body.code, importing.body.details], [409, 'PRICE_ESTIMATE_NOT_ELIGIBLE', { flags: ['EST_IMPORT_RUNNING'] }]);
  w.raw.exec("DELETE FROM ops_guards WHERE id = 'catalog-import-batch'");
  assert.equal(before(), snapshot);
  // The sheet says the cure — wait for the import — never the contract's «review the flags, then compute again».
  for (const lang of LANGS) {
    assert.equal(refusalText(new ApiError(409, 'x', importing.body.code, importing.body.details), lang), flagText('EST_IMPORT_RUNNING', lang), lang);
  }
  assert.notEqual(refusalText(new ApiError(409, 'x', 'PRICE_ESTIMATE_NOT_ELIGIBLE', { state: 'confirmed' }), 'en'), flagText('EST_IMPORT_RUNNING', 'en'), 'only that refusal');

  // Nothing in the way: it goes through.
  const ok = await call(w.app, `${BASE}/products/${PID}/confirm`, { version: version(w.raw), accept_flags: [], real_measures: STATED });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

/** The product as ProductForm reads it (`readProduct`, then `toEditorDoc` and `hydrateRelations`). */
async function formRead(app: App) {
  const product = (await json(await get(app, `/api/admin/products-v2/${PID}`))).product as Json;
  const rel = await json(await get(app, `/api/admin/products/${PID}/relations`));
  return { updatedAt: String(product.updated_at), doc: toEditorDoc(product as never), rs: hydrateRelations(rel as never, product as never) };
}
/** What ProductForm `save` posts for a document, fenced on the version the form read (none: «احفظ تغييراتي فوقها»). */
function saveBody(doc: EditorDoc, rs: RelationsState, expected: string | undefined) {
  const { options: _o, colors: _c, media: _m, ...docFields } = doc as EditorDoc & Record<string, unknown>;
  void _o;
  void _c;
  void _m;
  return { ...docWithoutLegacyMoney(docFields), relations: withoutLegacyMoney(relationsToWire(rs) as never), expected_updated_at: expected };
}
const measuresOf = (raw: DatabaseSync) =>
  row<Json>(raw, 'SELECT package_weight_g AS g, package_depth_mm AS d, package_width_mm AS w, package_height_mm AS h, net_weight_g AS net FROM products WHERE id = ?', PID)!;
/** The statement's values as the sheet hands them to the product form. */
const STATED_PACKAGE: StatedPackage = { weight_g: 100, box_mm: [160, 110, 30] };

test('the product form after a statement: the read lays every unsaved edit back over the new package — dimensions field by field — and its save keeps the package; the form as it was meets STALE_EDIT', async () => {
  const w = world();
  await published(w);
  // The form open before the statement, with edits not saved: the product's own net weight (in `dimensions`, the
  // package's own object) and a how-to-use text («المواصفات والمحتوى الإضافي»).
  const opened = await formRead(w.app);
  const mine: EditorDoc = { ...opened.doc, how_to_use: 'Cut flush; keep the jaws dry.', dimensions: { ...opened.doc.dimensions!, net_weight_g: 80 } };
  assert.equal((await confirm(w, { real_measures: STATED })).status, 200);

  // The form as it was meets STALE_EDIT: its empty package never lands.
  const stale = await post(w.app, '/api/admin/products-v2', saveBody(mine, opened.rs, opened.updatedAt));
  assert.deepEqual([stale.status, (await json(stale)).code], [409, 'STALE_EDIT']);
  assert.deepEqual(measuresOf(w.raw), { g: 100, d: 160, w: 110, h: 30, net: null }, 'the package stands');

  // ProductForm `afterEstimateMeasures`: the read is the new baseline, the unsaved edits laid back over it.
  const fresh = await formRead(w.app);
  assert.notEqual(fresh.updatedAt, opened.updatedAt);
  const merged = keepEdits(opened.doc, mine, fresh.doc);
  assert.deepEqual(merged.dimensions, { ...fresh.doc.dimensions, net_weight_g: 80 }, 'the new package, with the net weight typed');
  assert.equal(merged.how_to_use, 'Cut flush; keep the jaws dry.', '«المواصفات» kept too: nothing else wrote it');
  const ok = await post(w.app, '/api/admin/products-v2', saveBody(merged, fresh.rs, fresh.updatedAt));
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())).slice(0, 300));
  assert.deepEqual(measuresOf(w.raw), { g: 100, d: 160, w: 110, h: 30, net: 80 }, 'the package kept, the net weight saved');
  assert.equal((await formRead(w.app)).doc.how_to_use, 'Cut flush; keep the jaws dry.');
});

test('the product form that could not read the product back: the stated package is laid in where its own is empty, so even its save over the stored copy keeps the package', async () => {
  const w = world();
  await published(w);
  const opened = await formRead(w.app);
  const mine: EditorDoc = { ...opened.doc, dimensions: { ...opened.doc.dimensions!, net_weight_g: 80 } };
  assert.equal((await confirm(w, { real_measures: STATED })).status, 200);
  // ProductForm `afterEstimateMeasures`, its read failed: the form stays, its old version and the stated package.
  const guarded: EditorDoc = { ...mine, dimensions: withStatedPackage(mine.dimensions, STATED_PACKAGE) };
  const stale = await post(w.app, '/api/admin/products-v2', saveBody(guarded, opened.rs, opened.updatedAt));
  assert.deepEqual([stale.status, (await json(stale)).code], [409, 'STALE_EDIT'], 'the next save asks');
  // «احفظ تغييراتي فوقها»: no version stated — the package written back is the one the server holds.
  const over = await post(w.app, '/api/admin/products-v2', saveBody(guarded, opened.rs, undefined));
  assert.equal(over.status, 200, JSON.stringify(await json(over.clone())).slice(0, 300));
  assert.deepEqual(measuresOf(w.raw), { g: 100, d: 160, w: 110, h: 30, net: 80 });
});

test('keepEdits and withStatedPackage: each unsaved edit wins over the read, the package field by field; the stated package fills only what is empty', () => {
  const before = toEditorDoc({ id: PID, how_to_use: '', dimensions: { ...emptyDimensions(), net_weight_g: 50 } } as never);
  const fresh = toEditorDoc({ id: PID, how_to_use: '', name_en: 'Renamed elsewhere', dimensions: { ...emptyDimensions(), net_weight_g: 50, package_weight_g: 100, package_depth_mm: 160, package_width_mm: 110, package_height_mm: 30 } } as never);
  const pkgOf = (d: EditorDoc) => [d.dimensions!.package_weight_g, d.dimensions!.package_depth_mm, d.dimensions!.package_width_mm, d.dimensions!.package_height_mm];
  // The net weight edited: the server's package is kept.
  const net = keepEdits(before, { ...before, dimensions: { ...before.dimensions!, net_weight_g: 80 } }, fresh);
  assert.deepEqual([net.dimensions!.net_weight_g, ...pkgOf(net)], [80, 100, 160, 110, 30]);
  // A how-to-use text edited: the edit is kept, and a key the admin left alone takes the server's.
  const text = keepEdits(before, { ...before, how_to_use: 'typed' }, fresh);
  assert.deepEqual([text.how_to_use, text.name_en, ...pkgOf(text)], ['typed', 'Renamed elsewhere', 100, 160, 110, 30]);
  // A package field the admin typed himself: his value is kept, the server's others beside it.
  const typed = keepEdits(before, { ...before, dimensions: { ...before.dimensions!, package_weight_g: 120 } }, fresh);
  assert.deepEqual(pkgOf(typed), [120, 160, 110, 30]);
  // Nothing edited: the read as it is.
  assert.deepEqual(keepEdits(before, before, fresh), fresh);

  // The read failed: the stated package where the form's own is empty — exactly the server's conditional write.
  assert.deepEqual(withStatedPackage(emptyDimensions(), STATED_PACKAGE), { ...emptyDimensions(), package_weight_g: 100, package_depth_mm: 160, package_width_mm: 110, package_height_mm: 30 });
  assert.deepEqual(withStatedPackage({ ...emptyDimensions(), package_weight_g: 120 }, STATED_PACKAGE).package_weight_g, 120, 'a weight typed stays');
  assert.deepEqual(pkgOf({ dimensions: withStatedPackage({ ...emptyDimensions(), package_width_mm: 90 }, STATED_PACKAGE) } as EditorDoc), [100, null, 90, null], 'a box with a side typed is the admin’s');
  assert.deepEqual(withStatedPackage(null, { weight_g: 100 }), { ...emptyDimensions(), package_weight_g: 100 }, 'only what was stated');
});

test('chosen options: the statement is the product’s, so every option on those defaults becomes real, only the chosen ones turn firm; the lists and the next compute agree, and no apply is offered', async () => {
  const w = world({ colours: ['red', 'black'] });
  const [BLACK, RED] = [`c:${PID}_black`, `c:${PID}_red`];
  await published(w);
  assert.deepEqual(((await call(w.app, `${BASE}/products?state=flags`)).body.products as Json[]).map((p) => p.product_id), [PID]);
  const gate = (await shown(w.app)).confirm_gate!;
  assert.deepEqual(gate.real_measures, { ...STATED, combo_keys: [BLACK, RED] });
  const priced = prices(w.raw);
  const ok = await confirm(w, { real_measures: STATED, combo_keys: [RED] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.confirmed, ok.body.firm, label(w.raw)], ['skus', [RED], 1]);
  assert.deepEqual(lines(w.raw).map((l) => [l[0], l[1], l[2]]), [
    [BLACK, 'product', []],
    [RED, 'product', []],
  ]);
  const statedLines = lineRows(w.raw);
  assert.deepEqual(storedFlags(w.raw).filter((f) => /^EST_DEFAULT_/.test(f.code)), [], 'no option is on a default any more');
  assert.equal(row<Json>(w.raw, 'SELECT measure_basis AS b, state FROM product_price_estimates WHERE product_id = ?', PID)!.b, 'real');
  assert.deepEqual(audits(w.raw, 'price_estimate.measures_attested')[0].skus, 2);
  assert.deepEqual(audits(w.raw, 'price_estimate.confirmed'), [{ product_id: PID, whole: false, skus: 1, accepted_flags: [], measures_attested: true }]);
  assert.equal(prices(w.raw), priced, 'no price moved');
  assert.deepEqual(((await call(w.app, `${BASE}/products?state=flags`)).body.products as Json[]).map((p) => p.product_id), [], 'the Flags tab drops the defaults');
  assert.deepEqual((await shown(w.app)).confirm_gate, { defaulted: [], waiting_on_apply: false, waiting_keys: [], real_measures: null, blocked: null });

  // The next compute writes what the statement wrote, offers no apply, and black now confirms with nothing to state.
  const next = await compute(w.app);
  assert.deepEqual((next.lines as Json[]).map((l) => [l.combo_key, l.measure_source, l.est_price_iqd === l.published_price_iqd]).sort(), [
    [BLACK, 'product', true],
    [RED, 'product', true],
  ]);
  assert.deepEqual(lineRows(w.raw), statedLines, 'the stored lines, measure sources and flags, are the statement’s');
  assert.equal(next.measure_basis, 'real');
  assert.deepEqual(((await call(w.app, `${BASE}/products?state=refresh`)).body.products as Json[]).map((p) => p.product_id), [], 'no apply is offered');
  assert.deepEqual(all(w.raw, 'SELECT combo_key FROM price_estimate_firm_skus WHERE product_id = ?', PID), [{ combo_key: RED }], 'red stays firm');
  const black = await confirm(w, { combo_keys: [BLACK] });
  assert.equal(black.status, 200, JSON.stringify(black.body));
});

/** The real weight and box typed in the pricing form (a priced save): the store holds the owner's at once (S2). */
async function ownerTypesMeasures(w: World) {
  const pricing = { cost: { inputs: [{ scope: 'base', scope_id: '', shipping_weight_g: 120, shipping_length_mm: 170, shipping_width_mm: 110, shipping_height_mm: 30 }] } };
  const seq = async () => (await json(await get(w.app, `/api/admin/products-v2/${PID}/pricing`))).seq;
  const sheet = await json(await put(w.app, `/api/admin/products-v2/${PID}/pricing`, { seq: await seq(), pricing }));
  assert.equal(sheet.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(sheet).slice(0, 300));
  const saved = await put(w.app, `/api/admin/products-v2/${PID}/pricing`, { seq: await seq(), pricing, preview_hash: sheet.details.preview.review_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())).slice(0, 300));
}

test('a confirmation through the owner’s typed measures (no statement) drops the row’s default-measure flags: a confirmed product never shows «وزن افتراضي»', async () => {
  const w = world();
  await published(w);
  await ownerTypesMeasures(w);
  // S2: no compute since — the live gate reads the store, so nothing holds the sheet.
  assert.deepEqual((await shown(w.app)).confirm_gate, { defaulted: [], waiting_on_apply: false, waiting_keys: [], real_measures: null, blocked: null });
  assert.ok(storedFlags(w.raw).some((f) => f.code === 'EST_DEFAULT_WEIGHT'), 'the row still holds the applied estimate’s defaults');
  const ok = await confirm(w);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(storedFlags(w.raw).filter((f) => /^EST_DEFAULT_/.test(f.code)), []);
  assert.deepEqual((await shown(w.app)).flags.filter((f) => /^EST_DEFAULT_/.test(f.code)), [], 'the banner shows no «وزن افتراضي»');
  // The no-statement audit is as it always was.
  assert.deepEqual(audits(w.raw, 'price_estimate.confirmed'), [{ product_id: PID, whole: true, skus: 1, accepted_flags: [] }]);
  assert.deepEqual(audits(w.raw, 'price_estimate.measures_attested'), []);
  assert.equal(pkg(w.raw).g, null, 'no statement, no package write');
});

test('a product confirmed before this change, its row still holding the default-measure codes: neither the banner nor the «مؤكدة» list shows them', async () => {
  const w = world();
  await published(w);
  await ownerTypesMeasures(w);
  // Confirmed as the Worker before this change confirmed it (state, basis and label; the row's flags left as stored).
  w.raw.exec(`UPDATE product_price_estimates SET state = 'confirmed', measure_basis = 'real', confirmed_at = '${NOW}', confirmed_by = 'usr_owner', version = version + 1 WHERE product_id = '${PID}'`);
  w.raw.exec(`UPDATE products SET price_estimate = 0 WHERE id = '${PID}'`);
  const stored = storedFlags(w.raw).map((f) => f.code);
  assert.ok(stored.includes('EST_DEFAULT_WEIGHT') && stored.includes('EST_DEFAULT_BOX'), 'the row still holds them');
  assert.deepEqual((await shown(w.app)).flags.filter((f) => /^EST_DEFAULT_/.test(f.code)), [], 'the banner: no «وزن افتراضي»');
  const listed = (await call(w.app, `${BASE}/products?state=confirmed`)).body.products as Json[];
  assert.deepEqual(
    listed.map((p) => [p.product_id, (p.flags as Json[]).filter((f) => /^EST_DEFAULT_/.test(f.code))]),
    [[PID, []]],
    'the «مؤكدة» list'
  );
  // Only the default measures go: every other entry of a confirmed row is shown as stored.
  const kept = { code: 'EST_MANUAL_PRICE', combo_keys: [''] };
  assert.deepEqual(shownFlags('confirmed', [{ code: 'EST_DEFAULT_WEIGHT', combo_keys: [''] }, kept, { code: 'EST_DEFAULT_BOX' }], []), [kept]);
});

test('a type weight lighter than the product’s own net weight is never stated real: the gate and the server say why, nothing is written; a product no heavier is', async () => {
  const w = world();
  await published(w);
  // The cutter itself weighs 150 g by its spec; the type's packed weight is 100 g («الصندوق أخف من محتواه»).
  w.raw.exec(`UPDATE products SET net_weight_g = 150 WHERE id = '${PID}'`);
  const s = await shown(w.app);
  assert.deepEqual(s.confirm_gate, { defaulted: [''], waiting_on_apply: false, waiting_keys: [], real_measures: null, blocked: 'below_net' });
  assert.deepEqual(measureHold(s, null), { hard: true, live: true, statement: null, reason: 'below_net' });
  const untouched = everything(w.raw);
  const refused = await confirm(w, { real_measures: STATED });
  assert.deepEqual([refused.status, refused.body.code, refused.body.details], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [''], reason: 'below_net' }]);
  for (const lang of LANGS) assert.equal(refusalText(new ApiError(409, 'x', refused.body.code, refused.body.details), lang), say(CONFIRM.belowNet, lang));
  // The box alone can be stated, but the weight stays the type's: refused as before.
  const box = await confirm(w, { real_measures: { box_mm: STATED.box_mm } });
  assert.deepEqual([box.status, box.body.code, box.body.details], [409, 'PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [''] }]);
  assert.equal(everything(w.raw), untouched);

  // As heavy as its packed weight is possible: the statement is on offer again, and taken.
  w.raw.exec(`UPDATE products SET net_weight_g = 100 WHERE id = '${PID}'`);
  assert.deepEqual((await shown(w.app)).confirm_gate!.real_measures, { ...STATED, combo_keys: [''] });
  const ok = await confirm(w, { real_measures: STATED });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(measuresOf(w.raw), { g: 100, d: 160, w: 110, h: 30, net: 100 });
});

test('the lines a statement writes are the next compute’s, each line’s other codes kept: a colour priced from the owner’s typed price keeps EST_MANUAL_PRICE', async () => {
  const w = world({ colours: ['red', 'black'] });
  const [BLACK, RED] = [`c:${PID}_black`, `c:${PID}_red`];
  // Black's price typed by the owner: its line carries EST_MANUAL_PRICE beside the default measures.
  w.raw.exec(`INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at) VALUES ('${PID}', '${BLACK}', '52.5', 'CNY', 'typed', 'usr_owner', '${NOW}')`);
  await published(w);
  assert.deepEqual(lines(w.raw), [
    [BLACK, 'type_default', ['EST_DEFAULT_BOX', 'EST_DEFAULT_WEIGHT', 'EST_MANUAL_PRICE']],
    [RED, 'type_default', ['EST_DEFAULT_BOX', 'EST_DEFAULT_WEIGHT']],
  ]);
  const ok = await confirm(w, { real_measures: STATED, combo_keys: [RED] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(lines(w.raw), [
    [BLACK, 'product', ['EST_MANUAL_PRICE']],
    [RED, 'product', []],
  ]);
  const statedLines = lineRows(w.raw);
  await compute(w.app);
  assert.deepEqual(lineRows(w.raw), statedLines, 'the next compute writes exactly the statement’s lines');
});
