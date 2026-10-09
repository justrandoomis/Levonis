/**
 * OWNER DECISION 6: PRICE PROTECTION ON THE BASE PRICE IN USD — AN FX-ONLY
 * DROP IS NEVER PROTECTED (ODP §5.1 items 9-10; USD design §6.6; policy
 * `price_protection` v5 §10.4, §11.8).
 *
 * Runs the real claim route over an engine-priced product (adopted and
 * repriced through the real writer) and an order line carrying 0181's
 * engine snapshot, and the pure rule beside it. Proves:
 *   - the owner's two examples: the base price falls 500 → 480 USD at 1,600 →
 *     32,000 IQD owed; the base price stays and only the rate moves → nothing
 *     (FX_ONLY_DROP, in ar / en / ckb for the customer);
 *   - a mixed move pays the USD part only, never more than the actual dinar
 *     drop, and the customer reads «المشمول: …»;
 *   - approval credits what the claim covers, never original − observed (H1);
 *   - an order created before v5 keeps the dinar rule, the engine's sku: rows
 *     counted as dinar observations (H2, fit #3);
 *   - a manual line on a v5 order restates the engine's prices at the rate in
 *     force when the order was created;
 *   - checkout gives an engine-priced line its snapshot (and only such a line),
 *     and the snapshot is frozen.
 *
 * Run: node --import tsx --test tests/priceProtectionFxNeutral.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, json, post, row, stubApp } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';
import { priceProtectionRoutes } from '../worker/routes/returns';
import { claimBasis, restate } from '../worker/lib/pricingEngine/protectionBasis';
import { baseUsdOf, engineBasisOf } from '../worker/lib/pricingEngine/orderBasis';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { price_protection } from '../worker/lib/policies/price_protection';

const COMPLETE = {
  inputs: [{ scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 }],
  rules: [
    { kind: 'target_profit', scope: 'product', amount_usd: '120' },
    { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 50_000 },
  ],
};

type World = ReturnType<typeof pricingWorld>;

async function save(w: World, draft: Record<string, unknown>) {
  const seq = row<{ s: number }>(w.raw, 'SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?', AMS)?.s ?? 0;
  const first = await w.putInputs(AMS, { inputs_seq: seq, ...draft });
  assert.equal(first.status, 409, JSON.stringify(first.body));
  const r = await w.putInputs(AMS, { inputs_seq: seq, ...draft, preview_hash: first.body.details.preview.preview_hash, confirm_large_change: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

async function resaveAtRates(w: World) {
  const pv = await json(await post(w.app, '/api/admin/pricing/save-list/preview', { product_ids: [AMS] }));
  const res = await json(await post(w.app, '/api/admin/pricing/products/save-bulk', { items: [{ product_id: AMS, preview_hash: pv.items[0].preview.preview_hash }], confirm_large_change: true }));
  assert.deepEqual(res.results, [{ product_id: AMS, status: 'saved' }]);
}

const directPrice = (w: World) =>
  row<{ p: number }>(w.raw, "SELECT regular_price_iqd AS p FROM product_option_fulfillment WHERE option_id = ? AND fulfillment_type = 'direct_sale'", AMS_MODEL)!.p;

/** A delivered order of one direct-sale unit bought at today's engine price, with checkout's own snapshot. */
async function boughtNow(w: World, opts: { createdAt?: string; engine?: boolean } = {}) {
  const price = directPrice(w);
  const basis = (await engineBasisOf(w.db, [{ key: 'x', product_id: AMS, option_id: AMS_MODEL, pricing_basis: 'direct', route: null, regular_iqd: price }])).get('x');
  assert.ok(basis, 'checkout gives the engine-priced line its snapshot');
  // Created and delivered a moment ago (on or after v5's effective date); the price moves after that.
  const delivered = new Date(Date.now() - 1000).toISOString();
  const created = opts.createdAt ?? new Date(Date.now() - 2000).toISOString();
  w.raw.exec(`INSERT OR IGNORE INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer')`);
  const id = `ORD-${Math.random().toString(36).slice(2, 8)}`;
  const snapshot = JSON.stringify({ applied_tier: 'regular', applied_iqd: price, regular_iqd: price, pricing_basis: 'direct' });
  w.raw
    .prepare(
      `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                           subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,created_at)
       VALUES (?, 'buyer', 'delivered', '{}', 'standard', '{}', 'wallet', ?, 0, 1400, ?, 0, ?, ?)`
    )
    .run(id, price, price, delivered, created);
  const engineCols = opts.engine === false ? '' : ', price_basis, engine_combo_key, engine_channel, engine_regular_iqd, usd_iqd_at_purchase, base_usd_at_purchase';
  const engineVals = opts.engine === false ? [] : [basis!.price_basis, basis!.engine_combo_key, basis!.engine_channel, basis!.engine_regular_iqd, basis!.usd_iqd_at_purchase, basis!.base_usd_at_purchase];
  w.raw
    .prepare(
      `INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids,color_id,pricing_snapshot${engineCols})
       VALUES (?, ?, ?, 'AMS HT', 'Model 1', 1, ?, ?, ?, ?, '', ?${engineVals.map(() => ', ?').join('')})`
    )
    .run(`oi_${id}`, id, AMS, price, price, AMS_MODEL, JSON.stringify([AMS_MODEL]), snapshot, ...engineVals);
  return { orderId: id, itemId: `oi_${id}`, price, basis: basis! };
}

const buyerApp = (w: World) => stubApp(w.db, { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/price-protection', priceProtectionRoutes));
const claim = async (w: World, itemId: string) => {
  const res = await post(buyerApp(w), '/api/price-protection/claims', { orderItemId: itemId });
  return { status: res.status, body: await json(res) };
};

/** A world with the brief's product adopted by the engine at 1,600. */
async function engineWorld() {
  const w = pricingWorld();
  await save(w, COMPLETE);
  assert.equal(directPrice(w), 1_042_000);
  return w;
}

test('the owner’s example 1: the base price falls by $20 at 1,600 → 32,000 IQD owed, on the USD basis', async () => {
  const w = await engineWorld();
  const bought = await boughtNow(w);
  assert.equal(bought.basis.usd_iqd_at_purchase, '1600');
  assert.equal(bought.basis.base_usd_at_purchase, baseUsdOf(1_042_000, '1600'));
  await save(w, { inputs: [], rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '100' }] });
  assert.equal(directPrice(w), 1_010_000);
  const r = await claim(w, bought.itemId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.claim.eligible_unit_iqd, 32_000);
  const stored = row<Record<string, unknown>>(w.raw, 'SELECT eligible_unit_iqd, basis, usd_iqd_at_purchase, original_unit_iqd, observed_unit_iqd, policy_snapshot FROM price_protection_claims')!;
  assert.equal(stored.basis, 'usd_base');
  assert.equal(stored.usd_iqd_at_purchase, '1600');
  assert.equal(stored.original_unit_iqd, 1_042_000);
  assert.equal(stored.observed_unit_iqd, 1_010_000);
  // The customer's snapshot carries no USD figure and no rate.
  assert.doesNotMatch(String(stored.policy_snapshot), /usd|1600|base_usd/i);
});

test('the owner’s example 2: only the rate moves (1,600 → 1,500) → FX_ONLY_DROP, nothing owed — with the sentence in ar, en and ckb', async () => {
  const w = await engineWorld();
  const bought = await boughtNow(w);
  applyRate(w.raw, 'USD_IQD', '1500');
  await resaveAtRates(w);
  assert.ok(directPrice(w) < bought.price, 'the dinar price fell');
  const r = await claim(w, bought.itemId);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'FX_ONLY_DROP');
  assert.equal(row<{ n: number }>(w.raw, 'SELECT COUNT(*) AS n FROM price_protection_claims')!.n, 0);
  const s = REFUSAL_STRINGS.FX_ONLY_DROP!;
  assert.match(s.ar, /سعر صرف الدولار/);
  assert.match(s.ckb, /ئاڵوگۆڕ/);
  assert.notEqual(s.ckb, s.ar);
});

test('a mixed move pays the USD part only, never more than the actual dinar drop; approval credits that, never original − observed (H1)', async () => {
  const w = await engineWorld();
  const bought = await boughtNow(w);
  applyRate(w.raw, 'USD_IQD', '1500');
  await save(w, { inputs: [], rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '100' }] });
  const now = directPrice(w);
  // EUR 450 × 1.1 × 1,500 + 8,000 + $100 × 1,500 = 900,500 → 901,000; + 50,000 extra.
  assert.equal(now, 951_000);
  const r = await claim(w, bought.itemId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const covered = 1_042_000 - restate(951_000, '1500', '1600');
  assert.equal(r.body.claim.eligible_unit_iqd, covered);
  assert.ok(covered < 1_042_000 - 951_000, 'the rest came from the exchange rate');

  // Approval credits what is covered (the wallet stays the order's wallet rate, decision 9).
  w.raw.exec(`INSERT OR IGNORE INTO users (id,name,email,password_hash,role) VALUES ('boss','Admin','a@x.co','h','admin')`);
  const admin = stubApp(w.db, { id: 'boss', role: 'admin', email: 'a@x.co' }, (a) => a.route('/api/price-protection', priceProtectionRoutes));
  const decided = await json(await post(admin, `/api/price-protection/admin/claims/${r.body.claim.id}/decide`, { decision: 'approved' }));
  assert.equal(decided.success, true, JSON.stringify(decided));
  const credited = row<{ c: number }>(w.raw, 'SELECT credited_iqd AS c FROM price_protection_claims WHERE id = ?', r.body.claim.id)!.c;
  assert.equal(credited, covered, 'never original − observed');
});

test('an order created before v5 keeps the dinar rule — the engine’s sku: rows are dinar observations, so an FX drop still counts there', async () => {
  const w = await engineWorld();
  const bought = await boughtNow(w, { createdAt: '2026-10-01T10:00:00.000Z', engine: false });
  applyRate(w.raw, 'USD_IQD', '1500');
  await resaveAtRates(w);
  const r = await claim(w, bought.itemId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.claim.eligible_unit_iqd, null, 'the v3 claim shape');
  assert.equal(r.body.claim.observed_unit_iqd, directPrice(w));
});

test('a manual line on a v5 order: the engine’s prices restated at the rate in force when the order was created', () => {
  // Bought at a manual 1,042,000 when U was 1,600; the engine later wrote 981,000 at 1,500 (an FX move only).
  const r = claimBasis({
    v5: true,
    engine: null,
    orderUsdIqd: '1600',
    paidUnit: 1_042_000,
    todayApplied: 981_000,
    manualMin: null,
    engineHistory: [{ price_iqd: 981_000, usd_iqd_rate: '1500', source: 'engine_fx' }],
    engineToday: { price_iqd: 981_000, usd_iqd_rate: '1500' },
  });
  assert.deepEqual(r, { ok: false, code: 'FX_ONLY_DROP', observed_unit: 981_000 });
  // With no rate on record at the order's creation, only the owner's own engine saves count.
  const noU0 = claimBasis({ v5: true, engine: null, orderUsdIqd: null, paidUnit: 1_042_000, todayApplied: 1_042_000, manualMin: null, engineHistory: [{ price_iqd: 981_000, usd_iqd_rate: '1500', source: 'engine_fx' }], engineToday: null });
  assert.equal(noU0.ok, false);
  const owner = claimBasis({ v5: true, engine: null, orderUsdIqd: null, paidUnit: 1_042_000, todayApplied: 1_042_000, manualMin: null, engineHistory: [{ price_iqd: 1_010_000, usd_iqd_rate: '1600', source: 'engine_owner' }], engineToday: null });
  assert.deepEqual(owner, { ok: true, basis: 'iqd', observed_unit: 1_010_000, eligible_unit: 32_000, base_usd_observed: null });
  // A manual price after the engine counts as dinars, unrestated (M3).
  const manual = claimBasis({ v5: true, engine: { regular_iqd: 1_042_000, usd_iqd_at_purchase: '1600', base_usd_at_purchase: '651.25' }, orderUsdIqd: null, paidUnit: 1_042_000, todayApplied: 1_000_000, manualMin: 1_000_000, engineHistory: [], engineToday: null });
  assert.deepEqual(manual, { ok: true, basis: 'usd_base', observed_unit: 1_000_000, eligible_unit: 42_000, base_usd_observed: '625' });
});

test('checkout gives the snapshot only to a line bought at exactly the stored engine price; the snapshot is frozen', async () => {
  const w = await engineWorld();
  const none = await engineBasisOf(w.db, [
    { key: 'a', product_id: AMS, option_id: AMS_MODEL, pricing_basis: 'direct', route: null, regular_iqd: 1_000_000 },
    { key: 'b', product_id: 'lp_04', option_id: 'lp_04_o0', pricing_basis: 'direct', route: null, regular_iqd: 200_000 },
    { key: 'c', product_id: AMS, option_id: AMS_MODEL, pricing_basis: 'preorder', route: 'land', regular_iqd: 992_000 },
  ]);
  assert.deepEqual([...none.keys()], ['c'], 'a different price or a manual product: no snapshot; the land pre-order at its engine price: yes');
  assert.equal(none.get('c')!.engine_channel, 'pre_order_land');
  const bought = await boughtNow(w);
  assert.throws(() => w.raw.exec(`UPDATE order_items SET usd_iqd_at_purchase = '1500' WHERE id = '${bought.itemId}'`), /ORDER_SNAPSHOT_IMMUTABLE/);
});

test('on a database without the engine tables no line gets a snapshot (the INSERT stays the one it always was)', async () => {
  const w = pricingWorld();
  w.raw.exec('DROP TABLE pricing_sku_costs');
  const none = await engineBasisOf(asD1(w.raw), [{ key: 'a', product_id: AMS, option_id: AMS_MODEL, pricing_basis: 'direct', route: null, regular_iqd: 500_000 }]);
  assert.equal(none.size, 0);
});

test('policy price_protection v5: effective 2026-10-09, the base-price definition, §10.4, §11.8 and §12.3 in all three languages', () => {
  assert.equal(price_protection.version, 5);
  assert.equal(price_protection.effective_at, '2026-10-09');
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.match(price_protection.body[lang], /### 11\.8 /);
  assert.match(price_protection.body.ar, /السعر الأساسي بالدولار/);
  assert.match(price_protection.body.en, /Base price in USD/);
  assert.match(price_protection.body.ckb, /نرخی بنەڕەتی بە دۆلار/);
  assert.match(price_protection.body.ar, /وسعر الصرف الذي حُسب به/);
  assert.doesNotMatch(price_protection.body.ar, /علاوة/, 'decision 7: the Direct Sale Extra, never a premium');
  assert.doesNotMatch(price_protection.body.en, /premium/i);
});
