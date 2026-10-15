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

test('review F-15: re-opening a cancelled order whose released use is a credit not yet received is a mapped refusal, not a database error — the order stays cancelled', async () => {
  const { daysAgo, daysAhead } = await import('./sv2_tradein_fixture');
  const { LimitD1 } = await import('./fixtures/d1Limits');
  const { moveOrderStage } = await import('../worker/lib/orderStageOps');
  const raw = seed();
  const id = await submitted(raw);
  const offer = (raw.prepare('SELECT offer_iqd FROM trade_in_requests WHERE id = ?').get(id) as { offer_iqd: number }).offer_iqd;
  // A credit minted on photos before S-P2 (no intake), spent on an order that was cancelled after 0191.
  raw.exec(`
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,cancelled_at)
      VALUES ('ORD-X','cust','cancelled','cancelled','{}','standard','{}','cash',1500000,0,1400,${1_500_000 - offer},${1_500_000 - offer},'${daysAgo(2)}','${daysAgo(1)}');
    INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_global, max_per_user, active, created_at, assigned_user_id, scope, product_id, trade_in_id, ends_at)
      VALUES ('cpn_l', 'TILEGACY0001', 'fixed_iqd', ${offer}, 0, 1, 1, 1, '${daysAgo(3)}', 'cust', 'product', 'p_p1s', '${id}', '${daysAhead(4)}');
    UPDATE trade_in_requests SET status = 'awaiting_payment', final_value_iqd = ${offer}, credit_iqd = ${offer}, coupon_id = 'cpn_l' WHERE id = '${id}';
  `);
  raw.exec('DROP TRIGGER trg_trade_in_credit_needs_intake');
  raw.exec(`INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd, state, released_at) VALUES ('red_l', 'cpn_l', 'cust', 'ORD-X', ${offer}, 'released', '${daysAgo(1)}')`);
  const env = { DB: new LimitD1(raw) as unknown as D1Database } as never;
  const res = await moveOrderStage(env, { orderId: 'ORD-X', to: 'received', source: 'admin', changedBy: 'boss' } as never);
  assert.deepEqual([res.moved, res.reason], [false, 'ORDER_REOPEN_TRADE_IN_NOT_RECEIVED']);
  assert.equal((raw.prepare("SELECT status FROM orders WHERE id = 'ORD-X'").get() as { status: string }).status, 'cancelled');
});
