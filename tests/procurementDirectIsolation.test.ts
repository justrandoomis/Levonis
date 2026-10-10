import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';
import { loadProductPricing } from '../worker/lib/pricingEngine/store';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { evaluateEngineWrite, loadEngineControl, loadStoredSkuCosts, priceImageOf, engineWriteStatements } from '../worker/lib/pricingEngine/engineWrite';
import { loadPreviewContext } from '../worker/lib/pricingEngine/load';
import { loadPricingRates } from '../worker/lib/pricingEngine/rates';
import { directPurchaseStore } from '../worker/lib/pricingEngine/directPurchase';

const choices = {
  minimum_profits: [{ product_id: AMS, scope: 'product', amount_usd: '120' }],
  direct_sale_extras: [{ product_id: AMS, scope: 'product', amount_iqd: 50_000 }],
};
const sharedSnapshot = (w: ReturnType<typeof pricingWorld>) => ({
  inputs: w.raw.prepare('SELECT * FROM pricing_inputs ORDER BY product_id, scope, scope_id').all(),
  rules: w.raw.prepare('SELECT * FROM pricing_rules ORDER BY id').all(),
  routes: w.raw.prepare('SELECT * FROM product_option_transports WHERE product_id = ? ORDER BY id').all(AMS),
  cells: w.raw.prepare("SELECT * FROM product_option_fulfillment WHERE product_id = ? AND fulfillment_type = 'pre_order' ORDER BY id").all(AMS),
});
async function applyStock(w: ReturnType<typeof pricingWorld>) {
  const id = await w.save(w.draft());
  const p = await w.preview({ purchase_id: id, pricing: choices });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const product = (p.body.products as Array<Record<string, any>>)[0]!; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(product.rows.map((r: { channel: string }) => r.channel), ['direct_sale']);
  assert.deepEqual(product.adoption.rows.map((r: { channel: string }) => r.channel), ['direct_sale']);
  const out = await w.apply(AMS, {
    purchase_id: id, preview_hash: product.preview_hash, confirm_large_change: true,
    minimum_profits: [{ scope: 'product', amount_usd: '120' }],
    direct_sale_extras: [{ scope: 'product', amount_iqd: 50_000 }],
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.priced, true);
  return { id, product };
}

test('stock pricing persists a direct-only cost basis and leaves ordinary inputs/rules and preorder storage unchanged; retries are idempotent', async () => {
  const w = pricingWorld();
  const before = sharedSnapshot(w);
  const { id, product } = await applyStock(w);
  assert.deepEqual(sharedSnapshot(w), before);
  const direct = w.raw.prepare("SELECT regular_price_iqd FROM product_option_fulfillment WHERE product_id = ? AND fulfillment_type = 'direct_sale'").get(AMS) as { regular_price_iqd: number };
  assert.equal(direct.regular_price_iqd, 1_042_000);
  const s = await loadProductPricing(w.db, AMS);
  assert.equal(s.direct_purchase?.direct_only, true);
  assert.equal(directPurchaseStore(s).inputs.find((r) => r.scope_id === AMS_MODEL)?.supplier_cost_amount, '450');
  const retry = await w.apply(AMS, { purchase_id: id, preview_hash: product.preview_hash, confirm_large_change: true, minimum_profits: [{ scope: 'product', amount_usd: '120' }], direct_sale_extras: [{ scope: 'product', amount_iqd: 50_000 }] });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.already, true);
  assert.equal((await loadProductPricing(w.db, AMS)).direct_purchase?.version, s.direct_purchase?.version);
});

test('later automatic repricing of a directly adopted product uses purchase inputs without activating or borrowing preorder inputs', async () => {
  const w = pricingWorld();
  await applyStock(w);
  const before = sharedSnapshot(w);
  w.raw.exec("UPDATE pricing_shipping_rates SET rate_iqd = '6400', version = version + 1 WHERE profile = 'GERMANY_LAND'");
  const stored = await loadProductPricing(w.db, AMS);
  const [loaded, ctx, rates, control, costs, image] = await Promise.all([
    loadProducts(w.db, [AMS]), loadPreviewContext(w.db), loadPricingRates(w.db), loadEngineControl(w.db), loadStoredSkuCosts(w.db, [AMS]), priceImageOf(w.db, AMS),
  ]);
  const ev = await evaluateEngineWrite({ loaded: loaded.get(AMS)!, stored, ctx, rates, control, inputs: stored.inputs, inputWrites: [], ruleWrites: [], storedCosts: costs, image });
  assert.equal(ev.complete, true, JSON.stringify(ev.codes));
  assert.equal(ev.plan.channel, 'direct_sale');
  assert.deepEqual(ev.rows.map((r) => r.channel), ['direct_sale']);
  assert.equal(ev.rows[0]!.new_iqd, 1_050_000);
  await w.db.batch(await engineWriteStatements(w.db, ev, [], [], { actor: 'usr_owner', now: new Date().toISOString(), source: 'fx_auto', idempotencyKey: 'direct-test-reprice', auto: { priceSource: 'engine_owner', pricesUnchanged: false, trigger: 'test', reasons: ['GERMANY_LAND'] } }));
  assert.deepEqual(sharedSnapshot(w), before);
});

test('before the direct-purchase migration ordinary pricing reads work and stock apply fails closed', async () => {
  const w = pricingWorld();
  w.raw.exec('DROP TABLE pricing_direct_purchase');
  const id = await w.save(w.draft());
  const p = await w.preview({ purchase_id: id, pricing: choices });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const product = (p.body.products as Array<{ preview_hash: string }>)[0]!;
  const out = await w.apply(AMS, { purchase_id: id, preview_hash: product.preview_hash, confirm_large_change: true, minimum_profits: [{ scope: 'product', amount_usd: '120' }], direct_sale_extras: [{ scope: 'product', amount_iqd: 50_000 }] });
  assert.equal(out.status, 503, JSON.stringify(out.body));
  assert.equal(out.body.code, 'PRICING_NOT_INSTALLED');
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_inputs').get()?.n, 0);
});

test('inherited preorder prices stay unchanged while COD retains the established direct-sale quote', async () => {
  const w = pricingWorld();
  w.raw.exec(`UPDATE product_option_fulfillment SET regular_price_iqd = NULL WHERE product_id = '${AMS}' AND fulfillment_type = 'pre_order';
    UPDATE product_option_transports SET regular_price_iqd = NULL, surcharge_iqd = 7000 WHERE product_id = '${AMS}' AND method = 'land';
    UPDATE product_option_values SET prime_price_iqd = 400000, pro_price_iqd = 390000 WHERE product_id = '${AMS}';`);
  const before = sharedSnapshot(w);
  const ctx = await loadPreviewContext(w.db);
  const { evaluateLegacy } = await import('../worker/lib/pricingEngine/legacy');
  const old = (await loadProducts(w.db, [AMS])).get(AMS)!;
  const previous = evaluateLegacy(AMS, old.doc, old.view, ctx).units[0]!.channels.find((c) => c.channel === 'pre_order_land')!;
  await applyStock(w);
  assert.deepEqual(sharedSnapshot(w), before);
  const loaded = (await loadProducts(w.db, [AMS])).get(AMS)!;
  const channels = evaluateLegacy(AMS, loaded.doc, loaded.view, ctx).units[0]!.channels;
  assert.equal(channels.find((c) => c.channel === 'pre_order_land')!.prepaid_iqd, previous.prepaid_iqd);
  assert.equal(channels.find((c) => c.channel === 'pre_order_land')!.cod_iqd, channels.find((c) => c.channel === 'direct_sale')!.prepaid_iqd);
});

test('a base product keeps its preorder base by writing a separate direct premium; an unrepresentable lower direct price is refused', async () => {
  const w = pricingWorld();
  w.raw.exec(`DELETE FROM product_option_groups WHERE product_id = '${AMS}';
    UPDATE products SET inventory_mode = 'BASE', preorder_transports = '[{"method":"land","commission_iqd":7000,"active":true}]' WHERE id = '${AMS}';`);
  const draft = (amount: number) => w.draft({ lines: [{ product_id: AMS, scope: 'base', scope_id: '', qty_ordered: 1, source_unit_amount: amount, weight_g: 2500, volume_mm3: 0 }] });
  const id = await w.save(draft(450));
  const p = await w.preview({ purchase_id: id, pricing: choices });
  const product = p.body.products[0];
  assert.equal(product.adoption.complete, true, JSON.stringify(product.adoption));
  const before = w.raw.prepare('SELECT price_iqd, prime_price_iqd, pro_price_iqd, preorder_transports FROM products WHERE id = ?').get(AMS);
  const saved = await w.apply(AMS, { purchase_id: id, preview_hash: product.preview_hash, confirm_large_change: true, minimum_profits: [{ scope: 'product', amount_usd: '120' }], direct_sale_extras: [{ scope: 'product', amount_iqd: 50_000 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(w.raw.prepare('SELECT price_iqd, prime_price_iqd, pro_price_iqd, preorder_transports FROM products WHERE id = ?').get(AMS), before);
  const low = await w.preview({ draft: draft(1), pricing: { ...choices, minimum_profits: [{ product_id: AMS, scope: 'product', amount_usd: '1' }], direct_sale_extras: [{ product_id: AMS, scope: 'product', amount_iqd: 0 }] } });
  assert.equal(low.status, 200, JSON.stringify(low.body));
  assert.ok(low.body.products[0].adoption.missing_codes.includes('DIRECT_PURCHASE_PRICE_SHAPE'), JSON.stringify(low.body.products[0].adoption));
});

test('a variant stock cost writes only direct SKU prices and preserves color and inherited preorder data', async () => {
  const w = pricingWorld();
  w.raw.exec(`UPDATE products SET inventory_mode = 'VARIANT_COMBINATION' WHERE id = '${AMS}'; INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock, regular_adjust_iqd) VALUES ('stock_red', '${AMS}', 'Red', 'أحمر', 'سوور', '#ff0000', 0, 1, 5, 3000);
    INSERT INTO product_variants (id, product_id, combo_key, sku, active, stock) VALUES ('stock_variant', '${AMS}', 'o:${AMS_MODEL}|c:stock_red', 'STOCK-RED', 1, 5);`);
  const before = sharedSnapshot(w);
  const color = w.raw.prepare('SELECT * FROM product_colors WHERE id = ?').get('stock_red');
  const draft = w.draft({ lines: [{ product_id: AMS, scope: 'variant', scope_id: 'stock_variant', qty_ordered: 1, source_unit_amount: 450, weight_g: 2500, volume_mm3: 0 }] });
  const id = await w.save(draft);
  const p = await w.preview({ purchase_id: id, pricing: choices });
  const product = p.body.products[0];
  assert.equal(product.adoption.complete, true, JSON.stringify(product.adoption));
  assert.equal(product.adoption.per_sku, true);
  const saved = await w.apply(AMS, { purchase_id: id, preview_hash: product.preview_hash, confirm_large_change: true, minimum_profits: [{ scope: 'product', amount_usd: '120' }], direct_sale_extras: [{ scope: 'product', amount_iqd: 50_000 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(sharedSnapshot(w), before);
  assert.deepEqual(w.raw.prepare('SELECT * FROM product_colors WHERE id = ?').get('stock_red'), color);
  assert.deepEqual(w.raw.prepare('SELECT channel, regular_price_iqd FROM product_sku_prices WHERE product_id = ?').all(AMS).map((r) => ({ ...r })), [{ channel: 'direct_sale', regular_price_iqd: 1_042_000 }]);
});

test('explicit global activation converts its legacy minimum without replacing the stock minimum, and later owner input edits do not revive old stock values', async () => {
  const w = pricingWorld();
  const saved = await w.putInputs(AMS, { inputs_seq: 0, data_only: true, inputs: [{ scope: 'option', scope_id: AMS_MODEL, supplier_cost_amount: '100', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  w.raw.exec(`INSERT INTO pricing_rules (id, kind, scope, product_id, scope_id, state, amount_iqd, source, legacy_result_id, version, updated_at)
    VALUES ('stock_legacy_min', 'target_profit', 'product', '${AMS}', '', 'ACTIVE', 191001, 'LEGACY_MIGRATION', 'legacy:stock', 1, '2026-10-10T00:00:00Z')`);
  await applyStock(w);
  const p = await w.previewInputs(AMS, {});
  assert.equal(p.body.adoption.complete, true, JSON.stringify(p.body.adoption));
  assert.equal(p.body.adoption.rows.find((r: { channel: string }) => r.channel === 'direct_sale').target_profit_usd, '120');
  assert.equal(p.body.adoption.rows.find((r: { channel: string }) => r.channel === 'pre_order_land').target_profit_usd, '119.38');
  const stored = await loadProductPricing(w.db, AMS);
  const adopted = await w.putInputs(AMS, { inputs_seq: stored.state!.inputs_seq, preview_hash: p.body.preview_hash, confirm_large_change: true });
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  const after = await loadProductPricing(w.db, AMS);
  assert.equal(after.direct_purchase?.direct_only, false);
  assert.equal(after.rules.find((r) => r.id === 'stock_legacy_min')!.amount_usd, '119.38');
  assert.equal(directPurchaseStore(after).rules.find((r) => r.kind === 'target_profit')!.amount_usd, '120');
  for (const amount of ['130', '100']) {
    const state = await loadProductPricing(w.db, AMS);
    const draft = { inputs: [{ scope: 'option', scope_id: AMS_MODEL, supplier_cost_amount: amount, supplier_cost_currency: 'EUR' }] };
    const preview = await w.previewInputs(AMS, draft);
    const out = await w.putInputs(AMS, { inputs_seq: state.state!.inputs_seq, ...draft, preview_hash: preview.body.preview_hash, confirm_large_change: true });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const effective = directPurchaseStore(await loadProductPricing(w.db, AMS));
    assert.equal(effective.inputs.find((r) => r.scope_id === AMS_MODEL)!.supplier_cost_amount, amount);
    assert.equal(effective.inputs.find((r) => r.scope_id === AMS_MODEL)!.shipping_weight_g, 2500);
  }
});
