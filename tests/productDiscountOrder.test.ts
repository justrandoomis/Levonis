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
