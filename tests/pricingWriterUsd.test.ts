/**
 * THE WRITER: ADOPTION AT THE OWNER'S COMPLETING SAVE (owner decision 8; USD
 * design §6.1-§6.5; MVP plan §5's writer rules and exact check).
 *
 * Routes: PUT /products/:id/inputs (the product form's save), GET /save-list,
 * POST /save-list/preview, POST /products/save-bulk, POST /products/:id/manual
 * (worker/lib/pricingEngine/{engineWrite,writer}.ts).
 *
 * Proves:
 *   - a save that leaves a manual product complete, sent without the preview's
 *     hash, is 409 PRICING_PREVIEW_REQUIRED carrying the six figures — and
 *     writes nothing; with the hash it adopts the engine and writes the prices
 *     in the same batch: route rows with surcharge 0, the direct cell = the
 *     pre-order base + Direct Sale Extra, the pre-order cell the max of its
 *     routes, the option row the max, products.price_iqd the min, member prices
 *     and the route fee cleared — and the cart's own resolver charges exactly
 *     the engine's price on every channel, prepaid and cash on delivery;
 *   - Final Price USD is stored privately (pricing_sku_costs), the history
 *     rows carry the U and `engine_owner`, values live in pricing_audit and
 *     audit_log holds ids and counts only; the batch stays under 200;
 *   - a change above 15% needs the tick and a fresh sign-in;
 *   - a replay of the same preview answers `already` and writes nothing new;
 *   - an incomplete save stays manual and byte-identical;
 *   - a confirmed rate that moved lists the product as stale; one preview and
 *     one bulk save reprice it at the new rate;
 *   - a rate waiting for review never blocks: the save prices at the
 *     effective (last confirmed) rate, and says the review is pending;
 *   - a failure inside the batch changes nothing;
 *   - the migrated dinar minimum converts to USD at the adopting save, never
 *     below the old margin;
 *   - back to manual keeps every price as written.
 *
 * Run: node --import tsx --test tests/pricingWriterUsd.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, json, post, row } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';
import { loadPreviewContext, loadProducts } from '../worker/lib/pricingEngine/load';
import { evaluateLegacy } from '../worker/lib/pricingEngine/legacy';

const COMPLETE = {
  inputs: [{ scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 }],
  rules: [
    { kind: 'target_profit', scope: 'product', amount_usd: '120' },
    { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 50_000 },
  ],
};

type World = ReturnType<typeof pricingWorld>;

const priceImage = (w: World, pid = AMS) =>
  JSON.stringify([
    all(w.raw, 'SELECT id, price_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd, preorder_transports FROM products WHERE id = ?', pid),
    all(w.raw, 'SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id', pid),
    all(w.raw, 'SELECT * FROM product_option_fulfillment WHERE product_id = ? ORDER BY id', pid),
    all(w.raw, 'SELECT * FROM product_option_transports WHERE product_id = ? ORDER BY id', pid),
    all(w.raw, 'SELECT * FROM price_history ORDER BY id'),
  ]);

/** What the cart charges a guest today, per channel (the live resolver). */
async function cartPrices(w: World, pid = AMS) {
  const loaded = (await loadProducts(w.db, [pid])).get(pid)!;
  const ctx = await loadPreviewContext(w.db);
  const ev = evaluateLegacy(pid, loaded.doc, loaded.view, ctx);
  return Object.fromEntries(ev.models.flatMap((m) => m.channels.filter((c) => c.ok).map((c) => [`${m.option_id}@${c.channel}`, { prepaid: c.prepaid_iqd, cod: c.cod_iqd, fee: c.fee_iqd }])));
}

async function adopt(w: World, draft = COMPLETE) {
  const first = await w.putInputs(AMS, { inputs_seq: 0, ...draft });
  assert.equal(first.status, 409, JSON.stringify(first.body));
  const hash = first.body.details.preview.preview_hash as string;
  const saved = await w.putInputs(AMS, { inputs_seq: 0, ...draft, preview_hash: hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return { first, saved, hash };
}

test('a completing save without the preview hash → 409 with the six figures, nothing written; with it → the engine adopts and writes every price the cart reads', async () => {
  const w = pricingWorld();
  const before = priceImage(w);
  const today = await cartPrices(w);
  assert.equal(today[`${AMS_MODEL}@pre_order_land`]!.prepaid, 450_000, 'fixture: the item price, no route fee');

  const blind = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE });
  assert.equal(blind.status, 409, JSON.stringify(blind.body));
  assert.equal(blind.body.code, 'PRICING_PREVIEW_REQUIRED');
  const preview = blind.body.details.preview;
  assert.equal(preview.adoption.kind, 'adopt');
  assert.equal(preview.adoption.complete, true);
  const rows = preview.adoption.rows as Array<Record<string, unknown>>;
  const land = rows.find((r) => r.channel === 'pre_order_land')!;
  const direct = rows.find((r) => r.channel === 'direct_sale')!;
  // The six figures (decision 8): replacement cost, minimum profit, new pre-order price, extra, new direct price, old → new.
  assert.equal(land.replacement_cost_iqd, 800_000, '$500 × 1,600');
  assert.equal(land.target_profit_usd, '120');
  assert.equal(land.computed_price_iqd, 992_000, 'the brief: $620 × 1,600');
  assert.equal(direct.direct_sale_extra_iqd, 50_000);
  assert.equal(direct.computed_price_iqd, 1_042_000, 'pre-order base + Direct Sale Extra');
  assert.equal(land.today_prepaid_iqd, 450_000);
  assert.equal(land.route_fee_removed, false, 'this product carried no route fee');
  assert.equal(preview.adoption.large_change, true);
  assert.equal(preview.preview_hash, preview.adoption.preview_hash);
  assert.equal(priceImage(w), before, 'the refusal wrote nothing');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);

  // Above 15%: the tick first, then the price write.
  const unticked = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE, preview_hash: preview.preview_hash });
  assert.equal(unticked.status, 409);
  assert.equal(unticked.body.code, 'PRICING_LARGE_CHANGE_CONFIRM');
  assert.equal(priceImage(w), before);

  const r = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE, preview_hash: preview.preview_hash, confirm_large_change: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'engine');
  assert.equal(row<{ mode: string }>(w.raw, 'SELECT mode FROM product_pricing_state WHERE product_id = ?', AMS)!.mode, 'engine');

  // The MVP writer rules, row by row.
  const transport = row<Record<string, unknown>>(
    w.raw,
    "SELECT t.* FROM product_option_transports t JOIN product_option_fulfillment f ON f.id = t.fulfillment_id WHERE t.product_id = ? AND t.method = 'land' AND f.option_id = ?",
    AMS,
    AMS_MODEL
  )!;
  assert.equal(transport.regular_price_iqd, 992_000);
  assert.equal(transport.surcharge_iqd, 0);
  assert.equal(transport.pro_price_iqd, null);
  const cells = all<Record<string, unknown>>(w.raw, 'SELECT fulfillment_type, regular_price_iqd, regular_adjust_iqd FROM product_option_fulfillment WHERE option_id = ? ORDER BY fulfillment_type', AMS_MODEL);
  assert.deepEqual(cells.map((c) => [c.fulfillment_type, c.regular_price_iqd, c.regular_adjust_iqd]), [
    ['direct_sale', 1_042_000, null],
    ['pre_order', 992_000, null],
  ]);
  assert.equal(row<{ p: number }>(w.raw, 'SELECT regular_price_iqd AS p FROM product_option_values WHERE id = ?', AMS_MODEL)!.p, 1_042_000, 'the option row: the max');
  const product = row<Record<string, unknown>>(w.raw, 'SELECT price_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd, preorder_transports FROM products WHERE id = ?', AMS)!;
  assert.equal(product.price_iqd, 992_000, 'products.price_iqd: the min');
  assert.equal(product.direct_surcharge_iqd, null);
  assert.ok((JSON.parse(String(product.preorder_transports)) as Array<{ commission_iqd: number }>).every((t) => t.commission_iqd === 0));

  // The cart's own resolver reads the engine's price back, prepaid and at the door.
  const after = await cartPrices(w);
  assert.deepEqual(after[`${AMS_MODEL}@pre_order_land`], { prepaid: 992_000, cod: 1_042_000, fee: 0 }, 'COD pre-order pays the direct price (USD design §2.3)');
  assert.deepEqual(after[`${AMS_MODEL}@direct_sale`], { prepaid: 1_042_000, cod: 1_042_000, fee: 0 });

  // Final Price USD privately, beside the dinar price.
  const costs = all<Record<string, unknown>>(w.raw, 'SELECT channel, final_price_usd, usd_iqd_rate, computed_price_iqd, current_total_cost_usd, target_profit_usd FROM pricing_sku_costs WHERE product_id = ? ORDER BY channel', AMS);
  assert.deepEqual(costs.map((c) => [c.channel, c.final_price_usd, c.usd_iqd_rate, c.computed_price_iqd]), [
    ['direct_sale', '620', '1600', 1_042_000],
    ['pre_order_land', '620', '1600', 992_000],
  ]);
  // Owner decision 6's observations: sku: keys, field regular, the U, engine_owner.
  const history = all<Record<string, unknown>>(w.raw, "SELECT variant_key, field, old_iqd, new_iqd, usd_iqd_rate, price_source FROM price_history WHERE product_id = ? ORDER BY variant_key", AMS);
  assert.deepEqual(history, [
    { variant_key: `sku:o:${AMS_MODEL}@direct_sale`, field: 'regular', old_iqd: 500_000, new_iqd: 1_042_000, usd_iqd_rate: '1600', price_source: 'engine_owner' },
    { variant_key: `sku:o:${AMS_MODEL}@pre_order_land`, field: 'regular', old_iqd: 450_000, new_iqd: 992_000, usd_iqd_rate: '1600', price_source: 'engine_owner' },
  ]);
  // Values in the owner-only pricing audit; ids and counts in audit_log.
  const entry = row<Record<string, unknown>>(w.raw, "SELECT action, idempotency_key, pricing_after_json FROM pricing_audit WHERE entity = 'sku_price' AND product_id = ?", AMS)!;
  assert.equal(entry.action, 'engine_entry');
  assert.equal(entry.idempotency_key, `price:${AMS}:${preview.preview_hash}`);
  assert.match(String(entry.pricing_after_json), /992000/);
  const log = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'pricing.engine.adopted'")!;
  assert.doesNotMatch(log.detail, /992000|1042000|620|1600/);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM ops_guards"), 0, 'every token deleted');
});

test('a change above 15% on a stale sign-in → 401 REAUTH_REQUIRED, nothing written', async () => {
  const w = pricingWorld({ sessionAgeSeconds: 3600 });
  const before = priceImage(w);
  const first = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE });
  const r = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE, preview_hash: first.body.details.preview.preview_hash, confirm_large_change: true });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'REAUTH_REQUIRED');
  assert.equal(priceImage(w), before);
});

test('a replay of the saved preview answers `already` and writes nothing new; a second tab with the old counter is a fresh look', async () => {
  const w = pricingWorld();
  const { hash } = await adopt(w);
  const image = priceImage(w);
  const audits = count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit');
  const again = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE, preview_hash: hash, confirm_large_change: true });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.already, true);
  assert.equal(priceImage(w), image);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit'), audits);
  const tab = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE });
  assert.equal(tab.status, 409);
  assert.equal(tab.body.code, 'PRICING_CHANGED');
});

test('an incomplete save stores the data, stays manual, prices byte-identical', async () => {
  const w = pricingWorld();
  const before = priceImage(w);
  const r = await w.putInputs(AMS, { inputs_seq: 0, inputs: [{ scope: 'base', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 }], rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '120' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'manual');
  assert.equal(r.body.adoption.kind, null);
  assert.ok(r.body.adoption.missing_codes.includes('SUPPLIER_COST_MISSING'));
  assert.equal(priceImage(w), before);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_sku_costs'), 0);
});

test('an engine product: its save reprices in the same batch; a draft that leaves it incomplete is refused; the old dinar writers are refused by the database', async () => {
  const w = pricingWorld();
  await adopt(w);
  const seq = row<{ s: number }>(w.raw, 'SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?', AMS)!.s;
  const draft = { inputs: [], rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '130' }] };
  const p = await w.putInputs(AMS, { inputs_seq: seq, ...draft });
  assert.equal(p.status, 409);
  assert.equal(p.body.code, 'PRICING_PREVIEW_REQUIRED');
  assert.equal(p.body.details.preview.adoption.kind, 'reprice');
  const land = (p.body.details.preview.adoption.rows as Array<Record<string, unknown>>).find((r) => r.channel === 'pre_order_land')!;
  assert.equal(land.computed_price_iqd, 1_008_000, '$630 × 1,600');
  const r = await w.putInputs(AMS, { inputs_seq: seq, ...draft, preview_hash: p.body.details.preview.preview_hash });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`]!.prepaid, 1_008_000);
  assert.equal(row<{ a: string }>(w.raw, "SELECT action AS a FROM pricing_audit WHERE entity = 'sku_price' ORDER BY created_at DESC, rowid DESC LIMIT 1")!.a, 'reprice_owner');

  // Clearing the minimum profit would leave the engine product without a price.
  const seq2 = row<{ s: number }>(w.raw, 'SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?', AMS)!.s;
  const gone = await w.putInputs(AMS, { inputs_seq: seq2, inputs: [], rules: [{ kind: 'target_profit', scope: 'product', amount_usd: null }] });
  assert.equal(gone.status, 409);
  assert.equal(gone.body.code, 'PRICING_ENGINE_INCOMPLETE');
  assert.ok((gone.body.details.missing_codes as string[]).includes('TARGET_PROFIT_MISSING'));

  // ENGINE_MANAGED: a dinar price written outside the engine's batch.
  assert.throws(() => w.raw.exec(`UPDATE products SET price_iqd = 5000 WHERE id = '${AMS}'`), /ENGINE_MANAGED/);
  assert.throws(() => w.raw.exec(`UPDATE product_option_values SET regular_price_iqd = 5000 WHERE id = '${AMS_MODEL}'`), /ENGINE_MANAGED/);
  assert.throws(() => w.raw.exec(`UPDATE product_option_transports SET surcharge_iqd = 5000 WHERE product_id = '${AMS}'`), /ENGINE_MANAGED/);
});

test('a confirmed rate that moved lists the product as stale; one preview and one bulk save reprice it at the new rate', async () => {
  const w = pricingWorld();
  await adopt(w);
  const listed0 = await json(await (await import('./fixtures/app')).get(w.app, '/api/admin/pricing/save-list'));
  assert.equal(listed0.stale.count, 0);

  applyRate(w.raw, 'USD_IQD', '1660');
  const listed = await json(await (await import('./fixtures/app')).get(w.app, '/api/admin/pricing/save-list'));
  assert.equal(listed.stale.count, 1);
  assert.deepEqual(listed.stale.items[0].reasons, ['EUR', 'USD']);

  const pv = await json(await post(w.app, '/api/admin/pricing/save-list/preview', { product_ids: [AMS] }));
  const hash = pv.items[0].preview.preview_hash as string;
  const land = (pv.items[0].preview.rows as Array<Record<string, unknown>>).find((r) => r.channel === 'pre_order_land')!;
  assert.equal(land.computed_price_iqd, 1_029_000, 'ceil_1000(EUR 450 × 1.1 × 1,660 + 8,000 IQD freight + $120 × 1,660 = 1,028,900)');
  const res = await post(w.app, '/api/admin/pricing/products/save-bulk', { items: [{ product_id: AMS, preview_hash: hash }] });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.results, [{ product_id: AMS, status: 'saved' }]);
  assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`]!.prepaid, 1_029_000);
  const relisted = await json(await (await import('./fixtures/app')).get(w.app, '/api/admin/pricing/save-list'));
  assert.equal(relisted.stale.count, 0);
  // The same preview again finds nothing left to write; a preview the rates moved past is refused for that product only.
  const replay = await json(await post(w.app, '/api/admin/pricing/products/save-bulk', { items: [{ product_id: AMS, preview_hash: hash }] }));
  assert.deepEqual(replay.results, [{ product_id: AMS, status: 'unchanged' }]);
  applyRate(w.raw, 'USD_IQD', '1700');
  const pv2 = await json(await post(w.app, '/api/admin/pricing/save-list/preview', { product_ids: [AMS] }));
  applyRate(w.raw, 'USD_IQD', '1750');
  const stale = await json(await post(w.app, '/api/admin/pricing/products/save-bulk', { items: [{ product_id: AMS, preview_hash: pv2.items[0].preview.preview_hash }] }));
  assert.deepEqual(stale.results, [{ product_id: AMS, status: 'refused', code: 'PRICING_PREVIEW_STALE' }]);
});

test('a rate waiting for review never blocks: the save prices at the effective (last confirmed) rate and says the review is pending', async () => {
  const w = pricingWorld();
  w.raw.exec("UPDATE fx_rate_pairs SET status = 'REVIEW_REQUIRED', pending_effective_rate = '1800', pending_market_rate = '1800', pending_reason = 'ANOMALY_24H', pending_observed_at = '2026-10-09T00:00:00.000Z' WHERE pair = 'USD_IQD'");
  const first = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE });
  assert.equal(first.status, 409);
  assert.equal(first.body.details.preview.adoption.review_pending, true);
  const r = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE, preview_hash: first.body.details.preview.preview_hash, confirm_large_change: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await cartPrices(w))[`${AMS_MODEL}@pre_order_land`]!.prepaid, 992_000, 'priced at 1,600, never the held 1,800');
});

test('a failure inside the batch changes nothing (atomic)', async () => {
  const w = pricingWorld();
  const before = priceImage(w);
  const first = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE });
  w.raw.exec("CREATE TRIGGER test_fail BEFORE INSERT ON pricing_sku_costs BEGIN SELECT RAISE(ABORT, 'INJECTED'); END;");
  const r = await w.putInputs(AMS, { inputs_seq: 0, ...COMPLETE, preview_hash: first.body.details.preview.preview_hash, confirm_large_change: true });
  assert.equal(r.status, 500);
  assert.equal(priceImage(w), before);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_rules'), 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_pricing_state WHERE mode = 'engine'"), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});

test('the migrated dinar minimum converts to USD at the adopting save (rounded up to the cent): never below the old margin', async () => {
  const w = pricingWorld();
  const now = new Date().toISOString();
  // A migrated row as «قبول القيم المرحّلة» stores it (state row first, as the store does).
  w.raw.exec(`INSERT INTO product_pricing_state (product_id, mode, updated_at) VALUES ('${AMS}', 'manual', '${now}')`);
  w.raw.exec(`INSERT INTO pricing_rules (id, kind, scope, product_id, scope_id, state, amount_iqd, source, legacy_result_id, version, updated_at)
              VALUES ('prule_legacy', 'target_profit', 'product', '${AMS}', '', 'ACTIVE', 191001, 'LEGACY_MIGRATION', 'legacy:x', 1, '${now}')`);
  const seq = row<{ s: number }>(w.raw, 'SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?', AMS)!.s;
  const draft = { inputs: COMPLETE.inputs, rules: [{ kind: 'direct_sale_extra', scope: 'product', amount_iqd: 50_000 }] };
  const first = await w.putInputs(AMS, { inputs_seq: seq, ...draft });
  assert.equal(first.status, 409, JSON.stringify(first.body));
  const land = (first.body.details.preview.adoption.rows as Array<Record<string, unknown>>).find((r) => r.channel === 'pre_order_land')!;
  assert.equal(land.target_profit_usd, '119.38', 'ceil2(191,001 ÷ 1,600 = 119.375625)');
  const r = await w.putInputs(AMS, { inputs_seq: seq, ...draft, preview_hash: first.body.details.preview.preview_hash, confirm_large_change: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rule = row<Record<string, unknown>>(w.raw, "SELECT amount_usd, amount_iqd, legacy_amount_iqd, legacy_usd_iqd_rate, source FROM pricing_rules WHERE id = 'prule_legacy'")!;
  assert.deepEqual(rule, { amount_usd: '119.38', amount_iqd: null, legacy_amount_iqd: 191_001, legacy_usd_iqd_rate: '1600', source: 'LEGACY_MIGRATION' });
  const cost = row<{ p: number; r: number }>(w.raw, "SELECT computed_price_iqd AS p, replacement_cost_iqd AS r FROM pricing_sku_costs WHERE channel = 'pre_order_land'")!;
  assert.ok(cost.p - cost.r >= 191_001, 'the old dinar margin holds on the adopting day');
});

test('back to manual keeps every price exactly as the engine wrote it; the next save adopts only when asked', async () => {
  const w = pricingWorld();
  await adopt(w);
  const image = priceImage(w);
  const ws = row<{ s: number }>(w.raw, 'SELECT write_seq AS s FROM product_pricing_state WHERE product_id = ?', AMS)!.s;
  const res = await post(w.app, `/api/admin/pricing/products/${AMS}/manual`, { write_seq: ws });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  assert.equal(row<{ mode: string }>(w.raw, 'SELECT mode FROM product_pricing_state WHERE product_id = ?', AMS)!.mode, 'manual');
  assert.equal(priceImage(w), image);
  // The old dinar writers work again.
  w.raw.exec(`UPDATE products SET price_iqd = 990000 WHERE id = '${AMS}'`);
  const got = await w.getInputs(AMS);
  assert.equal(got.body.adoption.kind, null, 'a product taken back to manual is not adopted by a plain save');
  const asked = await post(w.app, `/api/admin/pricing/products/${AMS}/preview`, { draft: {}, adopt: true });
  assert.equal((await json(asked)).adoption.kind, 'adopt');
});

test('the writer over the whole census: every product whose fields can carry the engine price verifies exactly against the cart resolver (every model × channel, prepaid and COD)', async () => {
  const w = pricingWorld();
  const { evaluateEngineWrite, loadEngineControl } = await import('../worker/lib/pricingEngine/engineWrite');
  const { loadPricingRates } = await import('../worker/lib/pricingEngine/rates');
  const { loadProductsPricing } = await import('../worker/lib/pricingEngine/store');
  const { listPricedProducts } = await import('../worker/lib/pricingEngine/load');
  const ids = (await listPricedProducts(w.db)).map((p) => p.id);
  const loaded = await loadProducts(w.db, ids);
  const stores = await loadProductsPricing(w.db, ids);
  const ctx = await loadPreviewContext(w.db);
  const rates = await loadPricingRates(w.db);
  const control = await loadEngineControl(w.db);
  const now = new Date().toISOString();
  const base = {
    product_id: '', scope: 'base' as const, scope_id: '', origin: 'MANUAL_OVERRIDE' as const, supplier_cost_amount: '100', supplier_cost_delta: null,
    supplier_cost_currency: 'USD' as const, supplier_input_mode: 'SOURCE_CURRENCY' as const, shipping_profile: 'GERMANY_LAND' as const,
    shipping_weight_g: 1000, manual_cbm: '0.05', additional_cost_iqd: 2000, version: 1, updated_at: now,
  };
  let verified = 0;
  const shapes: string[] = [];
  for (const id of ids) {
    const product = loaded.get(id)!;
    const stored = stores.get(id)!;
    const rules = [
      { id: `r_t_${id}`, kind: 'target_profit', scope: 'product', catalog_id: null, product_id: id, scope_id: '', state: 'ACTIVE', amount_usd: '20', amount_iqd: null, source: 'OWNER', legacy_amount_iqd: null, legacy_usd_iqd_rate: null, legacy_result_id: null, version: 1, updated_at: now },
      { id: `r_x_${id}`, kind: 'direct_sale_extra', scope: 'product', catalog_id: null, product_id: id, scope_id: '', state: 'ACTIVE', amount_usd: null, amount_iqd: 15000, source: 'OWNER', legacy_amount_iqd: null, legacy_usd_iqd_rate: null, legacy_result_id: null, version: 1, updated_at: now },
    ];
    const ev = await evaluateEngineWrite({
      loaded: product,
      stored: { ...stored, rules: rules as never },
      ctx,
      rates,
      control,
      inputs: [{ ...base, product_id: id }],
      inputWrites: [],
      ruleWrites: [],
      image: '',
      storedCosts: [],
    });
    if (ev.codes.includes('PRICE_SHAPE_UNSUPPORTED')) {
      shapes.push(id);
      continue;
    }
    assert.deepEqual(ev.codes, [], `${id}: ${ev.codes.join(',')} ${ev.verification.mismatches.join(',')}`);
    assert.equal(ev.verification.ok, true, id);
    assert.ok(ev.rows.length > 0, id);
    for (const r of ev.rows) assert.ok(r.new_iqd % 1000 === 0 && r.new_iqd >= 1000, `${id} ${r.channel}`);
    verified += 1;
  }
  assert.ok(verified >= 30, `most of the census verifies (${verified}; shapes held: ${shapes.join(', ')})`);
});
