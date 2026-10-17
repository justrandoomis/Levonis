/**
 * PRODUCT DISCOUNT — THE RATE (docs/ux/PRODUCT-DISCOUNT.md D3, §4.2–§4.4, §12 "Server: the rate").
 *
 * A dollar sale price is converted at the SKU's OWN V2 rate — the rate its published before price was
 * computed at — so before and after always move together:
 *   1. priced by the real V2 writer at U 1,500 (P1S $600, Combo $750, land Δ $50), a per-model sale
 *      ($500 / $640) saved through the door: card, product quote, cart and checkout quote all read
 *      900,000 → 750,000, «−17٪»;
 *   2. U 1,530 approved and the REAL `autoReprice` run: 918,000 → 765,000; land 841,500 → 688,500 (row 245);
 *   3. mid-wave (the rate approved, one product repriced, the other not): each uses its own row's
 *      rate — the one not yet repriced still reads 900,000 → 750,000, never 765,000 against 900,000;
 *   4. the owner lowers D to $480 by a V2 apply: the $500 sale strikes nothing and sells at 720,000.
 *
 * Run: npx tsx --test tests/productDiscountRateChange.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { applyRate, fxEnv } from './fixtures/fx';
import { discountWorld, M1, M2, option, off, PID, SLUG, writeV2Uniform, type DiscountWorld } from './fixtures/productDiscount';
import { writeV2 } from './fixtures/pricingV2';
import { repriceStaleEngineProducts } from '../worker/lib/pricingEngine/autoReprice';
import { statementBudget } from '../worker/lib/fx/budget';
import type { Env } from '../worker/lib/types';

const perModel = { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M1, usd: '500' }, { model_id: M2, usd: '640' }] };

const envOf = (raw: DatabaseSync): Env => ({ ...fxEnv(raw), STORE_ROOT_DOMAIN: 'levonis-iq.com' }) as Env;

async function card(w: DiscountWorld, id = PID) {
  const res = await w.call(w.guest, 'GET', '/api/products?limit=50');
  assert.equal(res.status, 200);
  return (res.body.products as Array<Record<string, unknown>>).find((p) => p.id === id)!;
}

async function productQuote(w: DiscountWorld, slug: string, model: string, how: 'direct' | 'land') {
  const res = await w.call(w.guest, 'POST', `/api/products/${slug}/quote`, {
    qty: 1,
    optionId: model,
    fulfillmentType: how === 'direct' ? 'direct_sale' : 'pre_order',
    ...(how === 'land' ? { transportMethod: 'land' } : {}),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  return res.body.quote as Record<string, number | null>;
}

async function reprice(raw: DatabaseSync) {
  const g = globalThis as { caches?: unknown };
  const before = g.caches;
  g.caches = { default: { delete: async () => true, match: async () => undefined, put: async () => undefined } };
  try {
    return await repriceStaleEngineProducts(envOf(raw), { trigger: 'fx', budget: statementBudget(600) });
  } finally {
    if (before === undefined) delete g.caches;
    else g.caches = before;
  }
}

test('before and after move together: card, quote, cart and checkout at U 1,500, then at 1,530 after the real reprice', async () => {
  const w = await discountWorld({ costFirst: false });
  assert.equal((await w.saveOffer(w.owner, perModel)).status, 200);

  // U 1,500.
  // The card's «from» is the P1S by land pre-order, before and after the sale (one basis).
  const c0 = await card(w);
  assert.deepEqual([c0.display_price_iqd, c0.display_offer_before_iqd, c0.display_offer_saving_percent], [675_000, 825_000, 18]);
  const q0 = await productQuote(w, SLUG, M1, 'direct');
  assert.deepEqual([q0.unit_subtotal_iqd, q0.offer_before_iqd, q0.offer_saving_percent], [750_000, 900_000, 17]);
  const land0 = await productQuote(w, SLUG, M1, 'land');
  assert.deepEqual([land0.unit_subtotal_iqd, land0.offer_before_iqd, land0.offer_saving_percent], [675_000, 825_000, 18]);
  const combo0 = await productQuote(w, SLUG, M2, 'direct');
  assert.deepEqual([combo0.unit_subtotal_iqd, combo0.offer_before_iqd, combo0.offer_saving_percent], [960_000, 1_125_000, 15]);
  assert.equal((await w.addToCart({ productId: PID, optionId: M1, optionValueIds: [M1], qty: 1, fulfillmentType: 'direct_sale' })).status, 200);
  const cart0 = (await w.cart()).body.items[0];
  assert.deepEqual([cart0.unit_price_iqd, cart0.breakdown.offer_before_iqd, cart0.breakdown.offer_saving_percent], [750_000, 900_000, 17]);
  const door0 = (await w.quote('cash')).body.quote.lines[0];
  assert.deepEqual([door0.unit_price_iqd, door0.offer_before_iqd, door0.offer_saving_percent], [750_000, 900_000, 17]);

  // U 1,530 approved, the real reprice: the product's rows carry 1,530 and both prices follow.
  applyRate(w.raw, 'USD_IQD', '1530');
  const report = await reprice(w.raw);
  assert.ok(report.repriced.includes(PID), JSON.stringify(report));
  const c1 = await card(w);
  assert.deepEqual([c1.display_price_iqd, c1.display_offer_before_iqd, c1.display_offer_saving_percent], [688_500, 841_500, 18]);
  const land1 = await productQuote(w, SLUG, M1, 'land');
  assert.deepEqual([land1.unit_subtotal_iqd, land1.offer_before_iqd], [688_500, 841_500]);
  const combo1 = await productQuote(w, SLUG, M2, 'direct');
  assert.deepEqual([combo1.unit_subtotal_iqd, combo1.offer_before_iqd], [979_250, 1_147_500]);
  const cart1 = (await w.cart()).body.items[0];
  assert.deepEqual([cart1.unit_price_iqd, cart1.breakdown.offer_before_iqd], [765_000, 918_000]);
  const door1 = (await w.quote('cash')).body.quote.lines[0];
  assert.deepEqual([door1.unit_price_iqd, door1.offer_before_iqd], [765_000, 918_000]);
});

test('mid-wave: the rate is approved, one product repriced and one not — each reads its own row’s rate', async () => {
  const w = await discountWorld({ costFirst: false });
  // A second printer, the same prices and the same sale.
  w.raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports,
                          inventory_mode, package_weight_g, package_depth_mm, package_width_mm, package_height_mm, net_weight_g)
      SELECT 'p_twin', 'bambu-twin', 'Bambu Twin', name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports,
             inventory_mode, package_weight_g, package_depth_mm, package_width_mm, package_height_mm, net_weight_g FROM products WHERE id = '${PID}';
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('p_twin_g', 'p_twin', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, stock, variant_key, variant_label)
      VALUES ('p_twin_m', 'p_twin', 'p_twin_g', 'P1S', 'P1S', 'P1S', 0, 1, 5, 'm0', 'P1S');
    INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES ('p_twin_m_d', 'p_twin', 'p_twin_m', 'direct_sale', 1);
  `);
  await writeV2(w.db, 'p_twin', { method: 'usd', points: [option('p_twin_m', '600')], discounts: [off('50')] });
  assert.equal((await w.saveOffer(w.owner, perModel)).status, 200);
  assert.equal((await w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] }, 'p_twin')).status, 200);

  // The central rate moves; ONLY the first product is repriced (the wave has not reached the twin).
  applyRate(w.raw, 'USD_IQD', '1530');
  await writeV2(w.db, PID, { method: 'usd', points: [option(M1, '600'), option(M2, '750')], discounts: [off('50')] });
  const repriced = await card(w, PID);
  assert.deepEqual([repriced.display_price_iqd, repriced.display_offer_before_iqd], [688_500, 841_500]);
  const waiting = await card(w, 'p_twin');
  assert.deepEqual(
    [waiting.display_price_iqd, waiting.display_offer_before_iqd, waiting.display_offer_saving_percent],
    [750_000, 900_000, 17],
    'its own row still says 1,500: never 765,000 against 900,000'
  );
});

test('the owner lowers D below the sale: no strike, no badge, and the line sells at its new price', async () => {
  const w = await discountWorld({ costFirst: false });
  assert.equal((await w.saveOffer(w.owner, perModel)).status, 200);
  await writeV2(w.db, PID, { method: 'usd', points: [option(M1, '480'), option(M2, '750')], discounts: [off('50')] });
  const q = await productQuote(w, SLUG, M1, 'direct');
  assert.deepEqual([q.unit_subtotal_iqd, q.offer_before_iqd, q.offer_saving_percent], [720_000, null, null]);
  assert.deepEqual(q.errors, []);
  // The card's cheapest level is now the un-discounted P1S by land at 645,000 (720,000 − $50): no strike.
  const c = await card(w);
  assert.deepEqual([c.display_price_iqd, c.display_offer_before_iqd, c.display_offer_saving_percent], [645_000, null, null]);
  assert.equal((c.offer as Record<string, unknown>).price_source, 'ladder', 'a priced window that lowers nothing on this card');
  // The Combo still sells at its sale price.
  const combo = await productQuote(w, SLUG, M2, 'direct');
  assert.deepEqual([combo.unit_subtotal_iqd, combo.offer_before_iqd], [960_000, 1_125_000]);
});

test('a saved whole-product sale whose models are later repriced apart prices nothing; the stored set is refused in the preview', async () => {
  const w = await discountWorld({ costFirst: false });
  await writeV2Uniform(w); // both models $600 → 900,000
  const whole = { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '500' }] };
  assert.equal((await w.saveOffer(w.owner, whole)).status, 200);
  const sale = await productQuote(w, SLUG, M2, 'direct');
  assert.deepEqual([sale.unit_subtotal_iqd, sale.offer_before_iqd], [750_000, 900_000]);
  // The owner reprices the Combo to $750 in the product form: no offer check runs on a V2 save.
  await writeV2(w.db, PID, { method: 'usd', points: [option(M1, '600'), option(M2, '750')], discounts: [off('50')] });
  // The stored '' row no longer has ONE before price: no model is sold at a discount nobody typed.
  for (const [model, price] of [[M2, 1_125_000], [M1, 900_000]] as const) {
    const q = await productQuote(w, SLUG, model, 'direct');
    assert.deepEqual([q.unit_subtotal_iqd, q.offer_before_iqd, q.offer_saving_percent], [price, null, null], model);
    assert.deepEqual(q.errors, []);
  }
  const add = await w.addToCart({ productId: PID, optionId: M2, optionValueIds: [M2], qty: 1, fulfillmentType: 'direct_sale' });
  assert.equal(add.status, 200, JSON.stringify(add.body).slice(0, 300));
  const quote = await w.quote('cash');
  assert.equal(quote.status, 200, JSON.stringify(quote.body).slice(0, 300));
  assert.equal(quote.body.quote.lines[0].unit_price_iqd, 1_125_000, 'the checkout charges the published price');
  assert.equal(quote.body.quote.lines[0].offer_before_iqd, undefined);
  // The card's preview of the stored set (the draft it opens with) says why, in three languages.
  const preview = await w.previewOffer(w.owner, whole);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.issues.map((i: { code: string }) => i.code), ['OFFER_USD_PER_MODEL']);
  assert.ok(preview.body.issues[0].ckb && preview.body.issues[0].ckb !== preview.body.issues[0].ar);
});
