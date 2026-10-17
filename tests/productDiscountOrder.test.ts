/**
 * PRODUCT DISCOUNT — THE ORDER AND THE INVOICE (docs/ux/PRODUCT-DISCOUNT.md §8.1, §8.6, §8.7, §12).
 *
 * A checkout during a dollar sale charges the after price, freezes the before price and the typed
 * dollars with the line, counts the redemption; the customer's order JSON carries the before price
 * and the percent and nothing else of the offer; the invoice prints «السعر قبل العرض» in the
 * invoice's language. Editing the sale, deleting it and moving the rate afterwards change nothing on
 * the order or the invoice. A PRO line pays min(member, offer) under the right label, and a percent
 * sale gets the same struck fields.
 *
 * Run: npx tsx --test tests/productDiscountOrder.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, get, json, proOnSale, row } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { discountWorld, M1, M2, option, off, PID, type DiscountWorld } from './fixtures/productDiscount';
import { writeV2 } from './fixtures/pricingV2';
import { createInvoiceForOrder, invoiceEmailData, type InvoiceSnapshotV1 } from '../worker/lib/invoices';
import { renderInvoiceHtmlDocument, renderOrderInvoiceEmail } from '../worker/lib/emailTemplates';
import type { Env } from '../worker/lib/types';
import { buyerClassOf } from '../worker/lib/protectionClaims';

const perModel = (p1s: string, combo: string) => ({
  offer_price_mode: 'fixed_usd',
  offer_usd_prices: [
    { model_id: M1, usd: p1s },
    { model_id: M2, usd: combo },
  ],
});

/** Keys no customer payload may carry (§11). */
const CUSTOMER_FORBIDDEN = /"(usd_iqd_rate|offer_usd_prices|price_usd_cents|offer_price_usd|offer_model_id|before_usd|after_usd|combo_key)"|"sku":\{/;

async function buyUnderSale(w: DiscountWorld, how: 'direct' | 'land' = 'direct', pay = 'cash') {
  const add = await w.addToCart({
    productId: PID,
    optionId: M1,
    optionValueIds: [M1],
    qty: 2,
    fulfillmentType: how === 'direct' ? 'direct_sale' : 'pre_order',
    ...(how === 'land' ? { transportMethod: 'land' } : {}),
  });
  assert.equal(add.status, 200, JSON.stringify(add.body).slice(0, 400));
  const placed = await w.placeOrder(pay);
  assert.equal(placed.status, 200, JSON.stringify(placed.body).slice(0, 400));
  return String(placed.body.order.id);
}

test('a checkout during a dollar sale: the after price is charged, the before price and the dollars are frozen, the redemption is counted', async () => {
  const w = await discountWorld();
  assert.equal((await w.saveOffer(w.owner, perModel('500', '640'))).status, 200);
  const orderId = await buyUnderSale(w);
  const item = row<{ unit_price_iqd: number; line_total_iqd: number; pricing_snapshot: string }>(
    w.raw,
    'SELECT unit_price_iqd, line_total_iqd, pricing_snapshot FROM order_items WHERE order_id = ?',
    orderId
  )!;
  assert.equal(item.unit_price_iqd, 750_000);
  assert.equal(item.line_total_iqd, 1_500_000);
  const snap = JSON.parse(item.pricing_snapshot);
  assert.equal(snap.applied_iqd, 750_000);
  assert.equal(snap.offer_before_iqd, 900_000);
  assert.equal(snap.offer.offer_price_mode, 'fixed_usd');
  assert.equal(snap.offer.offer_price_usd, '500.00');
  assert.equal(snap.offer.offer_model_id, M1);
  assert.equal(snap.offer.offer_applied_iqd, 750_000);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_redemptions WHERE order_id = ?', orderId), 1);

  // The customer's order: the frozen before price and its percent — no dollars, no rate, no model row.
  const mine = await json(await get(w.buyer, `/api/orders/${orderId}`));
  const line = mine.order.items[0];
  assert.equal(line.pricing.offer_before_iqd, 900_000);
  assert.equal(line.pricing.offer_saving_percent, 17);
  assert.doesNotMatch(JSON.stringify(mine), CUSTOMER_FORBIDDEN);

  // The invoice: the line carries the before price; each language prints its own sentence.
  const env = { DB: w.db, INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
  const inv = await createInvoiceForOrder(env, orderId);
  assert.ok(inv);
  const stored = row<{ snapshot: string; invoice_no: string; issued_at: string }>(w.raw, 'SELECT snapshot, invoice_no, issued_at FROM invoices WHERE order_id = ?', orderId)!;
  const snapshot = JSON.parse(stored.snapshot) as InvoiceSnapshotV1;
  assert.equal(snapshot.lines[0]!.offer_before_iqd, 900_000);
  assert.equal(snapshot.lines[0]!.offer_saving_percent, 17);
  const data = invoiceEmailData(snapshot, stored.invoice_no, 1, stored.issued_at);
  const html = { ar: renderInvoiceHtmlDocument('ar', data), en: renderInvoiceHtmlDocument('en', data), ckb: renderInvoiceHtmlDocument('ckb', data) };
  assert.match(html.ar, /السعر قبل العرض: <span[^>]*>900,000[^<]*<\/span> للقطعة \(−17٪\)/);
  assert.match(html.en, /Before the offer: <span[^>]*>900,000[^<]*<\/span> each \(−17%\)/);
  assert.match(html.ckb, /نرخی پێش ئۆفەر: <span[^>]*>900,000[^<]*<\/span> بۆ هەر دانەیەک \(−17٪\)/);
  const email = renderOrderInvoiceEmail('ckb', data, 'https://levonis-iq.com/orders');
  assert.match(email.html, /نرخی پێش ئۆفەر/);
  assert.match(email.text, /نرخی پێش ئۆفەر: .*900,000.* \(−17٪\)/);
  // The invoice route renders it for the buyer too.
  const page = await (await get(w.buyer, `/api/invoices/${inv!.invoiceId}/html?lang=ar`)).text();
  assert.match(page, /السعر قبل العرض/);

  // AFTER THE ORDER: edit the sale, delete it, move the rate — the order and the invoice do not move.
  const before = { item: JSON.stringify(all(w.raw, 'SELECT * FROM order_items WHERE order_id = ?', orderId)), invoice: stored.snapshot };
  assert.equal((await w.saveOffer(w.owner, perModel('450', '600'))).status, 200);
  assert.equal((await w.deleteOffer(w.owner)).status, 200);
  applyRate(w.raw, 'USD_IQD', '1530');
  await writeV2(w.db, PID, { method: 'usd', points: [option(M1, '600'), option(M2, '750')], discounts: [off('50')] });
  assert.equal(JSON.stringify(all(w.raw, 'SELECT * FROM order_items WHERE order_id = ?', orderId)), before.item);
  assert.equal(row<{ snapshot: string }>(w.raw, 'SELECT snapshot FROM invoices WHERE order_id = ?', orderId)!.snapshot, before.invoice);
  const again = await json(await get(w.buyer, `/api/orders/${orderId}`));
  assert.equal(again.order.items[0].pricing.offer_before_iqd, 900_000);
});

test('a prepaid land pre-order pays P − the same saving; COD pays the direct offer price', async () => {
  const w = await discountWorld();
  assert.equal((await w.saveOffer(w.owner, perModel('500', '640'))).status, 200);
  await w.addToCart({ productId: PID, optionId: M1, optionValueIds: [M1], qty: 1, fulfillmentType: 'pre_order', transportMethod: 'land' });
  const wallet = await w.quote('wallet');
  assert.equal(wallet.status, 200, JSON.stringify(wallet.body).slice(0, 300));
  assert.equal(wallet.body.quote.lines[0].unit_price_iqd, 675_000);
  assert.equal(wallet.body.quote.lines[0].offer_before_iqd, 825_000);
  assert.equal(wallet.body.quote.lines[0].offer_saving_percent, 18);
  const cash = await w.quote('cash');
  assert.equal(cash.body.quote.lines[0].unit_price_iqd, 750_000, 'cash on delivery: priced as direct, the direct offer');
  assert.equal(cash.body.quote.lines[0].offer_before_iqd, 900_000);
});

test('a PRO line pays min(member, offer) under the right label; a percent sale freezes the same struck fields', async () => {
  const w = await discountWorld();
  // PRO 20% on this product (a benefit rule): 720,000 < 750,000 — PRO pays 720,000 in PRO's name.
  proOnSale(w.raw);
  w.raw.exec(`
    INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,product_id,discount_mode,percent,enabled,priority)
      VALUES ('mbr_pro20','pro','product_discount','product','${PID}','percent',20,1,0);
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
      VALUES ('m_pro','u_buyer','pro_12mo','pro','active',12,1,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('ap_b','u_buyer',1,'Sara','+9647701234567','Baghdad, Karrada 12','','approved');
  `);
  assert.equal((await w.saveOffer(w.owner, perModel('500', '640'))).status, 200);
  await w.addToCart({ productId: PID, optionId: M1, optionValueIds: [M1], qty: 1, fulfillmentType: 'direct_sale' });
  const quote = await w.quote('cash');
  assert.equal(quote.status, 200, JSON.stringify(quote.body).slice(0, 300));
  const l = quote.body.quote.lines[0];
  assert.equal(l.unit_price_iqd, 720_000);
  assert.equal(l.breakdown.applied_tier, 'pro');
  assert.equal(l.offer_before_iqd, 900_000);
  assert.equal(l.offer_saving_percent, 20);

  // A percent sale: the same fields (F1).
  const w2 = await discountWorld({ costFirst: false });
  assert.equal((await w2.saveOffer(w2.owner, { offer_price_mode: 'discount_percent', discount_percent: 10 })).status, 200);
  const orderId = await buyUnderSale(w2);
  const snap = JSON.parse(row<{ pricing_snapshot: string }>(w2.raw, 'SELECT pricing_snapshot FROM order_items WHERE order_id = ?', orderId)!.pricing_snapshot);
  assert.equal(snap.applied_iqd, 810_000);
  assert.equal(snap.offer_before_iqd, 900_000);
  assert.equal(snap.offer.offer_price_mode, 'discount_percent');
  assert.equal('offer_price_usd' in snap.offer, false);
  const mine = await json(await get(w2.buyer, `/api/orders/${orderId}`));
  assert.equal(mine.order.items[0].pricing.offer_saving_percent, 10);
});

/**
 * D10 FOR A LINE-APPLIED MEMBER RULE (review): a rule that cannot be a unit price (a `max_quantity`, a
 * per-order cap, a minimum subtotal) is taken off the line, not clamped by the resolver — so it is
 * worked out on the line's PRE-OFFER regular price and the member pays the lower of the rule's line and
 * the offer's line. The discounts never stack.
 */
async function memberUnderSale(rule: string, sale: Record<string, unknown> | null, qty = 1) {
  const w = await discountWorld({ costFirst: false });
  proOnSale(w.raw);
  w.raw.exec(`
    INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,product_id,discount_mode,percent,max_quantity,max_discount_iqd,cap_scope,enabled,priority)
      VALUES ${rule};
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
      VALUES ('m_pro','u_buyer','pro_12mo','pro','active',12,1,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('ap_b','u_buyer',1,'Sara','+9647701234567','Baghdad, Karrada 12','','approved');
  `);
  if (sale) {
    const saved = await w.saveOffer(w.owner, sale);
    assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 300));
  }
  const add = await w.addToCart({ productId: PID, optionId: M1, optionValueIds: [M1], qty, fulfillmentType: 'direct_sale' });
  assert.equal(add.status, 200, JSON.stringify(add.body).slice(0, 300));
  const cart = await w.cart();
  const quote = await w.quote('cash');
  assert.equal(quote.status, 200, JSON.stringify(quote.body).slice(0, 300));
  const placed = await w.placeOrder('cash');
  assert.equal(placed.status, 200, JSON.stringify(placed.body).slice(0, 400));
  const orderId = String(placed.body.order.id);
  const order = row<{ subtotal_iqd: number; total_iqd: number; membership_discount_iqd: number }>(
    w.raw,
    'SELECT subtotal_iqd, total_iqd, membership_discount_iqd FROM orders WHERE id = ?',
    orderId
  )!;
  return { w, orderId, order, quote: quote.body.quote, cart: cart.body };
}

const DOLLAR_SALE = { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M1, usd: '500' }, { model_id: M2, usd: '640' }] };
const PERCENT_SALE = { offer_price_mode: 'discount_percent', discount_percent: 10 };
const PRO_RULE = (id: string, percent: number, maxQty: number | null, cap: number | null) =>
  `('${id}','pro','product_discount','product','${PID}','percent',${percent},${maxQty ?? 'NULL'},${cap ?? 'NULL'},${cap === null ? 'NULL' : "'per_order'"},1,0)`;

test('D10: a PRO rule limited to one unit does not stack on a dollar or a percent sale; the member pays the lower of the two', async () => {
  // No sale: 10% off one unit → 810,000.
  const plain = await memberUnderSale(PRO_RULE('mbr_q', 10, 1, null), null);
  assert.equal(plain.order.total_iqd, 810_000);
  // A $500 sale (750,000) beats the rule (810,000): the member pays 750,000 — not 750,000 − 10%.
  const usd = await memberUnderSale(PRO_RULE('mbr_q', 10, 1, null), DOLLAR_SALE);
  assert.equal(usd.order.subtotal_iqd, 750_000);
  assert.equal(usd.order.membership_discount_iqd, 0, 'the rule never stacks on the sale');
  assert.equal(usd.order.total_iqd, 750_000);
  assert.equal(usd.quote.membership_benefits.discount_total_iqd, 0, 'the quote says the same');
  assert.equal(usd.quote.total_iqd, 750_000);
  assert.equal(usd.cart.membership.discount_total_iqd, 0, 'and the cart');
  assert.equal(usd.cart.membership.merchandise_iqd, 750_000);
  // A 10% sale (810,000) equals the rule's 810,000: no stacking, 810,000.
  const pct = await memberUnderSale(PRO_RULE('mbr_q', 10, 1, null), PERCENT_SALE);
  assert.equal(pct.order.total_iqd, 810_000);
  // A rule that beats the sale (30% of 900,000 = 630,000 < 750,000): the member pays the rule's price.
  const big = await memberUnderSale(PRO_RULE('mbr_q', 30, 1, null), DOLLAR_SALE);
  assert.equal(big.order.subtotal_iqd, 750_000);
  assert.equal(big.order.membership_discount_iqd, 120_000);
  assert.equal(big.order.total_iqd, 630_000);
  assert.equal(big.cart.membership.discount_total_iqd, 120_000);
  // Two units, the rule covers one: 630,000 (rule) + 750,000 (sale) — each unit takes one discount.
  const two = await memberUnderSale(PRO_RULE('mbr_q', 30, 1, null), DOLLAR_SALE, 2);
  assert.equal(two.order.total_iqd, 630_000 + 750_000);
});

test('D10: a PRO rule with a per-order cap does not stack on a dollar or a percent sale', async () => {
  // 20% of 900,000 = 180,000, capped at 100,000 per order → the rule's price is 800,000.
  const plain = await memberUnderSale(PRO_RULE('mbr_cap', 20, null, 100_000), null);
  assert.equal(plain.order.total_iqd, 800_000);
  // The $500 sale (750,000) is lower: 750,000, no membership discount on top.
  const usd = await memberUnderSale(PRO_RULE('mbr_cap', 20, null, 100_000), DOLLAR_SALE);
  assert.equal(usd.order.membership_discount_iqd, 0);
  assert.equal(usd.order.total_iqd, 750_000);
  // The 10% sale (810,000) is higher than the rule's 800,000: the member pays 800,000.
  const pct = await memberUnderSale(PRO_RULE('mbr_cap', 20, null, 100_000), PERCENT_SALE);
  assert.equal(pct.order.subtotal_iqd, 810_000);
  assert.equal(pct.order.membership_discount_iqd, 10_000);
  assert.equal(pct.order.total_iqd, 800_000);
});

test('F5 regression: a PRO buyer clamped up to the sale price is frozen as a PRO buyer; the order reads «سعر العرض»', async () => {
  // PRO 5% (unit-applied) = 855,000 > the $500 sale (750,000): the member pays 750,000.
  const { w, orderId, order, quote } = await memberUnderSale(PRO_RULE('mbr_5', 5, null, null), DOLLAR_SALE);
  assert.equal(order.total_iqd, 750_000);
  assert.equal(quote.lines[0].breakdown.applied_tier, 'regular', 'the checkout label is the sale price');
  const snap = JSON.parse(row<{ pricing_snapshot: string }>(w.raw, 'SELECT pricing_snapshot FROM order_items WHERE order_id = ?', orderId)!.pricing_snapshot);
  assert.equal(snap.applied_tier, 'pro', 'the snapshot keeps the price class price protection reads');
  assert.equal(buyerClassOf(snap), 'pro');
  const mine = await json(await get(w.buyer, `/api/orders/${orderId}`));
  assert.equal(mine.order.items[0].pricing.applied_tier, 'regular', 'the buyer reads the F5 label');
});
