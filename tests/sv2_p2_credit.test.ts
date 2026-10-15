/**
 * Services S-P2 (DECISIONS row 238; spec §6.7, §13.3) — the credit once the device is in the shop:
 * the collection fee off the credit (decision 2), seven days from the moment it is fixed (the
 * policy), the line it pays for frozen on the order (`coupon_snapshot.trade_in_line_id`), and the
 * checkout refusing a credit whose device was never received. LOCAL ONLY.
 *
 * Run: node --import tsx --test tests/sv2_p2_credit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { json, post, row, send } from './fixtures/app';
import { OWNER, STAFF, adminApp, checkoutBody, customerApp, received, restoreFetch, seed, settle, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const DAY = 86_400_000;
const req = (raw: DatabaseSync, id: string) => row<Record<string, any>>(raw, 'SELECT * FROM trade_in_requests WHERE id = ?', id)!;

test('collection: the fee comes off the credit, the value stays; the credit lasts the policy’s seven days from the moment it is fixed', async () => {
  const raw = seed();
  const id = await submitted(raw);
  // The customer asks us to collect (allowed while sent and not yet received).
  const chose = await json(await send(customerApp(raw), 'PATCH', `/api/trade-in/requests/${id}`, { handover: 'pickup' }));
  assert.equal(chose.request.handover, 'pickup');
  assert.equal(chose.request.pickup_fee_iqd, 5_000);
  await received(raw, id, { body: { handover: 'pickup' } });
  const t0 = Date.now();
  const approved = await json(await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/approve`));
  const r = req(raw, id);
  assert.equal(approved.request.status, 'awaiting_payment');
  assert.equal(r.final_value_iqd, r.offer_iqd);
  assert.equal(r.credit_iqd, r.offer_iqd - 5_000);
  assert.equal(r.difference_iqd, 1_500_000 - (r.offer_iqd - 5_000));
  const c = row<{ value: number; ends_at: string }>(raw, 'SELECT value, ends_at FROM coupons WHERE trade_in_id = ?', id)!;
  assert.equal(c.value, r.offer_iqd - 5_000);
  assert.ok(Math.abs(Date.parse(c.ends_at) - (t0 + 7 * DAY)) < 60_000, c.ends_at);
  const notice = row<{ title_ar: string; meta: string }>(raw, 'SELECT title_ar, meta FROM user_notifications WHERE event_key = ?', `trade_in:${id}:fixed`)!;
  assert.match(notice.title_ar, /^رصيد الاستبدال جاهز حتى \d{4}-\d{2}-\d{2}$/);
  assert.match(JSON.parse(notice.meta).title_ckb, /^باڵانسی گۆڕینەوەکەت تا \d{4}-\d{2}-\d{2} ئامادەیە$/);
  // After intake the handover is the desk's record, not the customer's to change.
  assert.equal((await send(customerApp(raw), 'PATCH', `/api/trade-in/requests/${id}`, { handover: 'store' })).status, 409);
});

test('the order freezes the line the credit pays for (coupon_snapshot.trade_in_line_id) — read by the refund attribution', async () => {
  const raw = seed();
  const id = await submitted(raw);
  await received(raw, id);
  await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/approve`);
  const a = customerApp(raw);
  const pay = await json(await post(a, `/api/trade-in/requests/${id}/checkout`));
  assert.ok(pay.coupon_code, JSON.stringify(pay));
  assert.equal(pay.any_device, false);
  assert.equal(pay.target.product_id, 'p_p1s');
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('c_p1s','cust','p_p1s','','[]','','','','',1)`);
  const placed = await post(a, '/api/orders', checkoutBody({ couponCode: pay.coupon_code }));
  assert.equal(placed.status, 200, await placed.clone().text());
  await settle();
  const orderId = (await json(placed)).order.id as string;
  const snap = JSON.parse(row<{ coupon_snapshot: string }>(raw, 'SELECT coupon_snapshot FROM orders WHERE id = ?', orderId)!.coupon_snapshot);
  const line = row<{ id: string }>(raw, "SELECT id FROM order_items WHERE order_id = ? AND product_id = 'p_p1s'", orderId)!;
  assert.equal(snap.trade_in_line_id, line.id);
  assert.equal(snap.discount_iqd, req(raw, id).credit_iqd);
});
