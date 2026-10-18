/**
 * THE DOLLAR IS THE BASE — EVERY CUSTOMER DOOR, END TO END (DECISIONS row 247).
 *
 * The owner, 2026-10-17: «الدولار هو الاساس كما اتفقنا وليس العكس … الدولار هو الثابت والدينار العراقي هو
 * المتغير بسعر الصرف». The storefront read his eSUN PLA+ at $15.66 → $14.45 (the rounded dinars ÷ the public
 * 1,660); his form says $15.20 → $14.00. Through the real routes on an in-memory database:
 *
 *  - the card, the product page (levels, ways to buy, the opening quote), the quote, the cart, the
 *    checkout quote and the order all carry the shop's dollar prices as whole cents (`*_usd_cents`)
 *    beside the dinars, and the «−N٪» of the dollar pair;
 *  - a rate move moves the dinars only — a price-first product's dollars do not move;
 *  - no payload carries the rate, `usd_ceil6`, the typed model rows or any other working;
 *  - a database without the V2 results serves no dollar key at all (the client converts, as before).
 *
 * Run: npx tsx --test tests/usdBaseCard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json, row } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { discountWorld, M1, M2, PID, SLUG, COST_PID, COST_SLUG, option, off, type DiscountWorld } from './fixtures/productDiscount';
import { seedOptionless, writeV2 } from './fixtures/pricingV2';
import { usdCeilCentsOf } from '../packages/pricing/src/usdCents';

const ESUN = 'p_esun';
const ESUN_SLUG = `slug-${ESUN}`;

/** Keys no customer payload may carry: the rate, the stored dollar figure, the typed rows, the working. */
const FORBIDDEN = /"(usd_ceil6|usd_iqd_rate|pricing_method|exact_iqd|discount_usd|deltas_usd|offer_usd_prices|usd_prices|price_usd_cents|offer_price_usd|offer_model_id|before_usd|after_usd|editor_usd|sku_prices)"|"v2_[a-z_]+"/;

/** Every dollar-ish key in a payload: a whole number of cents, or the percent of a dollar pair. */
function dollarKeys(payload: unknown, path = '$', out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (Array.isArray(payload)) payload.forEach((v, i) => dollarKeys(v, `${path}[${i}]`, out));
  else if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload)) {
      if (/usd/i.test(k)) out.push([`${path}.${k}`, v]);
      dollarKeys(v, `${path}.${k}`, out);
    }
  }
  return out;
}

function assertClean(label: string, payload: unknown): void {
  assert.doesNotMatch(JSON.stringify(payload), FORBIDDEN, `${label}: a private key`);
  for (const [path, v] of dollarKeys(payload)) {
    if (/_saving_percent_usd$/.test(path)) assert.ok(v === null || (Number.isSafeInteger(v) && (v as number) >= 1), `${label} ${path} = ${String(v)}`);
    else {
      assert.match(path, /_usd_cents$/, `${label}: ${path} is not a dollar price in cents`);
      assert.ok(Number.isSafeInteger(v) && (v as number) >= 0, `${label} ${path} = ${String(v)}`);
    }
  }
}

/** The owner's eSUN PLA+: $15.20 → 26,000 IQD at 1,700, its stored dollars the cost-first 15.194118 of his form. */
async function seedEsun(w: DiscountWorld): Promise<void> {
  seedOptionless(w.raw, ESUN, { price: 26_000, saleTypes: ['direct_sale'], routes: [] });
  await writeV2(w.db, ESUN, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '15.20' }], discounts: [] });
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${ESUN}', 1);
    UPDATE pricing_v2_sku_results SET usd_ceil6 = '15.194118' WHERE product_id = '${ESUN}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${ESUN}';`);
}

const cardOf = async (w: DiscountWorld, slug: string): Promise<Record<string, unknown>> => {
  const list = await json(await get(w.guest, '/api/products'));
  assertClean('/api/products', list);
  const card = ((list.products ?? []) as Array<Record<string, unknown>>).find((p) => p.slug === slug);
  assert.ok(card, `${slug} is listed`);
  return card!;
};

test('the owner’s eSUN: the card reads $14.00 with $15.20 struck and −8% — and 24,000 / 26,000 IQD in dinars', async () => {
  const w = await discountWorld({ rate: '1700' });
  await seedEsun(w);
  const stored = row<{ final_price_iqd: number; usd_ceil6: string }>(w.raw, `SELECT final_price_iqd, usd_ceil6 FROM pricing_v2_sku_results WHERE product_id = ?`, ESUN)!;
  assert.equal(stored.final_price_iqd, 26_000);
  assert.equal(usdCeilCentsOf(stored.usd_ceil6), 1520, 'the form’s «≈ $15.20»');
  const saved = await w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '14.00' }] }, ESUN);
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 300));

  const card = await cardOf(w, ESUN_SLUG);
  assert.equal(card.display_price_iqd, 24_000, '$14.00 × 1,700 = 23,800 → 24,000');
  assert.equal(card.display_offer_before_iqd, 26_000);
  assert.equal(card.display_offer_saving_percent, 8);
  assert.equal(card.display_price_usd_cents, 1400);
  assert.equal(card.display_regular_usd_cents, 1400);
  assert.equal(card.display_offer_before_usd_cents, 1520);
  assert.equal(card.display_offer_saving_percent_usd, 8);

  // The product page agrees: the opening quote and the level carry the same pair.
  const page = await json(await get(w.guest, `/api/products/${ESUN_SLUG}`));
  assertClean('/api/products/:slug', page);
  assert.equal(page.product.display_price_usd_cents, 1400);
  assert.equal(page.pricing.applied_usd_cents, 1400);
  assert.equal(page.pricing.offer_before_usd_cents, 1520);
  assert.equal(page.pricing.offer_saving_percent_usd, 8);
  assert.equal(page.price_levels.base.unit_subtotal_usd_cents, 1400);
  assert.equal(page.pricing_modes.direct.unit_subtotal_usd_cents, 1400);
});

test('every door carries the dollars: page, quote, cart, checkout and the frozen order — and nothing private', async () => {
  const w = await discountWorld();
  assert.equal((await w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M1, usd: '500' }, { model_id: M2, usd: '640' }] })).status, 200);

  // The card's «from» is the cheapest way to buy: P1S by land, $550 − ($600 − $500) = $450, struck $550.
  const card = await cardOf(w, SLUG);
  assert.equal(card.display_price_usd_cents, 45_000);
  assert.equal(card.display_offer_before_usd_cents, 55_000);
  assert.equal(card.display_offer_saving_percent_usd, 18);

  const page = await json(await get(w.guest, `/api/products/${SLUG}`));
  assertClean('page', page);
  assert.equal(page.price_levels.option[M1].applied_usd_cents, 50_000);
  assert.equal(page.price_levels.option[M1].offer_before_usd_cents, 60_000);
  assert.equal(page.price_levels.option[M2].applied_usd_cents, 64_000);
  assert.deepEqual(page.pricing_modes.preorder[0].prepaid, { unit_subtotal_iqd: 675_000, unit_subtotal_usd_cents: 45_000 });

  const quote = await w.call(w.guest, 'POST', `/api/products/${SLUG}/quote`, { qty: 2, optionId: M1, optionValueIds: [M1], fulfillmentType: 'direct_sale' });
  assertClean('quote', quote.body);
  assert.equal(quote.body.quote.unit_subtotal_usd_cents, 50_000);
  assert.equal(quote.body.quote.line_total_usd_cents, 100_000);
  assert.equal(quote.body.quote.offer_saving_percent_usd, 17);

  assert.equal((await w.addToCart({ productId: PID, optionId: M1, optionValueIds: [M1], qty: 2, fulfillmentType: 'direct_sale' })).status, 200);
  const cart = await w.cart();
  assertClean('cart', cart.body);
  const item = cart.body.items[0];
  assert.equal(item.unit_price_iqd, 750_000);
  assert.equal(item.unit_price_usd_cents, 50_000);
  assert.equal(item.breakdown.offer_before_usd_cents, 60_000);

  const checkout = await w.quote();
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body).slice(0, 300));
  assertClean('checkout quote', checkout.body);
  const l = checkout.body.quote?.lines?.[0] ?? checkout.body.lines?.[0];
  assert.equal(l.unit_price_usd_cents, 50_000);
  assert.equal(l.line_total_usd_cents, 100_000);
  assert.equal(l.offer_before_usd_cents, 60_000);

  const placed = await w.placeOrder();
  assert.equal(placed.status, 200, JSON.stringify(placed.body).slice(0, 300));
  const orderId = String(placed.body.order.id);
  const snap = JSON.parse(row<{ pricing_snapshot: string }>(w.raw, 'SELECT pricing_snapshot FROM order_items WHERE order_id = ?', orderId)!.pricing_snapshot);
  assert.equal(snap.regular_usd_cents, 50_000, 'the line’s dollars are frozen with it');
  assert.equal(snap.offer_before_usd_cents, 60_000);
  const mine = await json(await get(w.buyer, `/api/orders/${orderId}`));
  assertClean('order', mine);
  assert.equal(mine.order.items[0].pricing.unit_subtotal_usd_cents, 50_000);
  assert.equal(mine.order.items[0].pricing.offer_saving_percent_usd, 17);

  // A rate move reprices the dinars; the order's frozen dollars and the product's dollars stay.
  applyRate(w.raw, 'USD_IQD', '1800');
  await writeV2(w.db, PID, { method: 'usd', points: [option(M1, '600'), option(M2, '750')], discounts: [off('50')] });
  const after = await cardOf(w, SLUG);
  assert.notEqual(after.display_price_iqd, card.display_price_iqd, 'the dinars moved with the rate');
  assert.equal(after.display_price_usd_cents, 45_000, 'the dollars did not');
  assert.equal(after.display_offer_before_usd_cents, 55_000);
  const again = await json(await get(w.buyer, `/api/orders/${orderId}`));
  assert.equal(again.order.items[0].pricing.unit_subtotal_usd_cents, 50_000);
});

test('a cost-first product shows its selling price in cents (the form’s figure), never its working', async () => {
  const w = await discountWorld();
  const stored = row<{ final_price_iqd: number; usd_ceil6: string }>(
    w.raw,
    "SELECT final_price_iqd, usd_ceil6 FROM pricing_v2_sku_results WHERE product_id = ? AND channel = 'pre_order_land'",
    COST_PID
  )!;
  const card = await cardOf(w, COST_SLUG);
  assert.equal(card.display_price_iqd, stored.final_price_iqd);
  assert.equal(card.display_price_usd_cents, usdCeilCentsOf(stored.usd_ceil6));
  const page = await json(await get(w.guest, `/api/products/${COST_SLUG}`));
  assertClean('cost-first page', page);
  assert.doesNotMatch(JSON.stringify(page), new RegExp(stored.usd_ceil6.replace('.', '\\.')), 'the six-decimal figure never leaves');
});

test('a database without the V2 results serves no dollar key at all', async () => {
  const w = await discountWorld();
  w.raw.exec('DROP TABLE pricing_v2_sku_results');
  const list = await json(await get(w.guest, '/api/products'));
  const page = await json(await get(w.guest, `/api/products/${SLUG}`));
  for (const [label, payload] of [['list', list], ['page', page]] as const) {
    assert.deepEqual(dollarKeys(payload), [], `${label}: no dollar key`);
  }
});
