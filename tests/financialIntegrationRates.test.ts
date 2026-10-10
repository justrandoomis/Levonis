import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';
import { get, json, post, put } from './fixtures/app';
import { applyRate, fxEnv, pairOf } from './fixtures/fx';
import { loadProducts, loadPreviewContext } from '../worker/lib/pricingEngine/load';
import { evaluateLegacy } from '../worker/lib/pricingEngine/legacy';
import { loadProductPricing } from '../worker/lib/pricingEngine/store';
import { sweepStaleEnginePrices } from '../worker/lib/fx/reprice';

type World = ReturnType<typeof pricingWorld>;
const selections = {
  minimum_profits: [{ product_id: AMS, scope: 'product', amount_usd: '120' }],
  direct_sale_extras: [{ product_id: AMS, scope: 'product', amount_iqd: 50_000 }],
};
const history = (w: World) => Object.fromEntries([
  'purchase_orders', 'purchase_lines', 'purchase_charges', 'incoming_inventory', 'inventory_lots', 'inventory_lot_cost_versions',
].map((name) => [name, w.raw.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
async function quotes(w: World) {
  const loaded = (await loadProducts(w.db, [AMS])).get(AMS)!;
  const ctx = await loadPreviewContext(w.db);
  return evaluateLegacy(AMS, loaded.doc, loaded.view, ctx).units[0]!.channels;
}

test('a fully activated mixed product with a stock overlay cannot silently skip an incomplete preorder during automatic repricing', async () => {
  const w = pricingWorld();
  const initial = await w.putInputs(AMS, { inputs_seq: 0, data_only: true,
    inputs: [{ scope: 'base', supplier_cost_amount: '100', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 }],
    rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '120' }, { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 50_000 }],
  });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  const id = await w.save(w.draft());
  const purchase = await w.preview({ purchase_id: id });
  const applied = await w.apply(AMS, { purchase_id: id, preview_hash: purchase.body.products[0].preview_hash, confirm_large_change: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const allChannels = await w.previewInputs(AMS, {});
  const full = await w.putInputs(AMS, { inputs_seq: allChannels.body.inputs_seq, preview_hash: allChannels.body.preview_hash, confirm_large_change: true });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.equal((await loadProductPricing(w.db, AMS)).direct_purchase?.direct_only, false);
  const before = await quotes(w);
  // Simulate input corruption from an older writer. The current owner form
  // refuses this edit; the background worker must also fail closed on it.
  w.raw.exec(`INSERT INTO ops_guards(id,ok) VALUES ('engine-price:${AMS}',1);
    UPDATE pricing_inputs SET supplier_cost_amount=NULL,supplier_cost_currency=NULL,supplier_input_mode=NULL WHERE product_id='${AMS}' AND scope='base';
    DELETE FROM ops_guards WHERE id='engine-price:${AMS}';`);
  applyRate(w.raw, 'USD_IQD', '1650');
  const sweep = await sweepStaleEnginePrices(fxEnv(w.raw), { trigger: 'sweep' });
  assert.deepEqual(sweep.repriced, []);
  assert.deepEqual(sweep.blocked, [{ product_id: AMS, code: 'SUPPLIER_COST_MISSING' }]);
  assert.deepEqual(await quotes(w), before, 'no partial direct write while the managed preorder is missing its supplier');
  const list = await json(await get(w.app, '/api/admin/pricing/save-list'));
  assert.equal(list.stale.items.find((p: { product_id: string }) => p.product_id === AMS).blocked_code, 'SUPPLIER_COST_MISSING');
  const notices = () => w.raw.prepare("SELECT COUNT(*) AS n FROM user_notifications WHERE kind='fx_attention'").get()!.n;
  assert.equal(notices(), 1);
  const retry = await sweepStaleEnginePrices(fxEnv(w.raw), { trigger: 'sweep' });
  assert.deepEqual(retry.repriced, []);
  assert.equal(notices(), 1, 'waiting for owner repair does not repeatedly ring the bell');
  w.raw.close();
});
const directPrice = async (w: World) => (await quotes(w)).find((r) => r.channel === 'direct_sale')!.prepaid_iqd;
async function setFx(w: World, pair: 'USD_IQD' | 'EUR_USD' | 'CNY_USD', rate: string) {
  const previewResponse = await post(w.app, `/api/admin/pricing/rates/fx/${pair}/manual/preview`, { rate });
  const { preview } = await json(previewResponse);
  assert.equal(previewResponse.status, 200);
  const response = await put(w.app, `/api/admin/pricing/rates/fx/${pair}/manual`, {
    rate, owner_version: pairOf(w.raw, pair).owner_version, preview_hash: preview.preview_hash, confirm_large_change: true,
  });
  assert.equal(response.status, 200, JSON.stringify(await json(response.clone())));
  return preview;
}

for (const route of [
  { profile: 'germany_land', central: 'GERMANY_LAND', currency: 'EUR', pair: 'EUR_USD', supplier: 450, rate: '1.2', documentFx: 1760, centralShip: 3200, ship: '6400', volume: 0 },
  { profile: 'china_air', central: 'CHINA_AIR', currency: 'CNY', pair: 'CNY_USD', supplier: 3500, rate: '0.15', documentFx: 224, centralShip: 20000, ship: '40000', volume: 0 },
  { profile: 'china_sea', central: 'CHINA_SEA', currency: 'CNY', pair: 'CNY_USD', supplier: 3500, rate: '0.15', documentFx: 224, centralShip: 400000, ship: '800000', volume: 100000000 },
] as const) {
  test(`${route.central}: current FX/freight reprice received direct stock while purchase history and prepaid preorder remain immutable`, async () => {
    const w = pricingWorld();
    // Choose an explicit direct shipping profile: a mixed product's preorder
    // route must not silently decide the imported stock's replacement route.
    const stored = await w.putInputs(AMS, { inputs_seq: 0, data_only: true, inputs: [{ scope: 'option', scope_id: AMS_MODEL, shipping_profile: route.central }] });
    assert.equal(stored.status, 200, JSON.stringify(stored.body));
    const oldQuotes = await quotes(w);
    const id = await w.save(w.draft({
      currency: route.currency, exchange_rate: route.documentFx, cost_profile_id: route.profile,
      cost_profile_version: w.profileVersion(route.profile), shipping_rate_iqd: route.centralShip + 1000,
      lines: [{ product_id: AMS, scope: 'option', scope_id: AMS_MODEL, qty_ordered: 2, source_unit_amount: route.supplier, weight_g: 2500, volume_mm3: route.volume }],
    }));
    const received = await w.receive(id, `rate-integration-${route.profile}`);
    assert.equal(received.status, 200, JSON.stringify(received.body));
    const frozen = history(w);
    assert.ok(w.raw.prepare('SELECT COUNT(*) AS n FROM inventory_lots').get()!.n);
    assert.equal(await directPrice(w), oldQuotes.find((r) => r.channel === 'direct_sale')!.prepaid_iqd, 'receiving stock alone never adopts its pricing');
    const p = await w.preview({ purchase_id: id, pricing: selections });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const product = p.body.products[0];
    const apply = await w.apply(AMS, {
      purchase_id: id, preview_hash: product.preview_hash, confirm_large_change: true,
      minimum_profits: [{ scope: 'product', amount_usd: '120' }], direct_sale_extras: [{ scope: 'product', amount_iqd: 50_000 }],
    });
    assert.equal(apply.status, 200, JSON.stringify(apply.body));
    const adopted = await directPrice(w);
    const overlay = (await loadProductPricing(w.db, AMS)).direct_purchase;
    assert.equal(overlay?.direct_only, true);
    const profileEdit = await put(w.app, `/api/admin/procurement/cost-profiles/${route.profile}`, {
      version: w.profileVersion(route.profile), exchange_rate: route.documentFx + 7, shipping_rate_iqd: route.centralShip + 9000,
    });
    assert.equal(profileEdit.status, 200, JSON.stringify(await json(profileEdit.clone())));
    assert.equal(await directPrice(w), adopted, 'purchase-screen defaults are not approved central replacement rates');

    const fx = await setFx(w, route.pair, route.rate);
    assert.deepEqual(fx.rows.map((r: { channel: string }) => r.channel), ['direct_sale']);
    assert.equal(await directPrice(w), fx.rows[0].computed_price_iqd, 'same-request repricer writes the preview exactly');
    const usd = await setFx(w, 'USD_IQD', '1650');
    assert.equal(await directPrice(w), usd.rows[0].computed_price_iqd, 'USD moves the foreign supplier and USD minimum together');
    const previewResponse = await post(w.app, `/api/admin/pricing/rates/shipping/${route.central}/preview`, { rate_iqd: route.ship });
    const { preview } = await json(previewResponse);
    assert.equal(previewResponse.status, 200);
    const v = w.raw.prepare('SELECT version FROM pricing_shipping_rates WHERE profile = ?').get(route.central)!.version;
    const shipping = await put(w.app, `/api/admin/pricing/rates/shipping/${route.central}`, {
      version: v, rate_iqd: route.ship, preview_hash: preview.preview_hash, confirm_large_change: true,
    });
    assert.equal(shipping.status, 200, JSON.stringify(await json(shipping.clone())));
    const qty = route.volume ? route.volume / 1e9 : 2.5;
    const expected = Math.ceil((route.supplier * Number(route.rate) * 1650 + qty * Number(route.ship) + 120 * 1650) / 1000) * 1000 + 50_000;
    assert.equal(await directPrice(w), expected, 'freight enters once; Direct Sale Extra remains a separate fixed amount');
    assert.equal(await directPrice(w), preview.rows[0].computed_price_iqd);
    const finalQuotes = await quotes(w);
    assert.equal(finalQuotes.find((r) => r.channel === 'pre_order_land')!.prepaid_iqd, oldQuotes.find((r) => r.channel === 'pre_order_land')!.prepaid_iqd);
    assert.equal(finalQuotes.find((r) => r.channel === 'pre_order_land')!.cod_iqd, expected, 'the existing COD direct-price policy still applies');
    assert.deepEqual(history(w), frozen, 'no central rate, profile edit, adoption or repricing rewrites a purchase or FIFO lot');
    assert.deepEqual((await loadProductPricing(w.db, AMS)).direct_purchase, overlay, 'automatic rate changes retain the adopted purchase basis');
    const rates = await json(await get(w.app, '/api/admin/pricing/rates'));
    assert.equal(rates.stale_products, 0);
    assert.equal(rates.reprice_blocked, 0);
    w.raw.close();
  });
}
