/**
 * Services S-P2 (DECISIONS rows 237, 238; spec §6.9, §13.3, §13.4) — the credit is never lost.
 * Returning the new device refunds cash NET of the credit, attributed to the new device's line only
 * (no other line is charged a share of it), and gives the SAME coupon back for 30 days on any
 * device sold directly — once, whatever is pressed twice. A qty-2 line: the credit belongs to the
 * first unit returned; the line's cash refunds sum to its basis − the credit. LOCAL ONLY.
 *
 * Run: node --import tsx --test tests/sv2_p2_reissue.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { count, get, json, post, row } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { stubApp } from './fixtures/app';
import { returnRoutes } from '../worker/routes/returns';
import { OWNER, adminApp, approvedAndOrdered, checkoutBody, customerApp, delivered, received, restoreFetch, seed, settle, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const DAY = 86_400_000;
const req = (raw: DatabaseSync, id: string) => row<Record<string, any>>(raw, 'SELECT * FROM trade_in_requests WHERE id = ?', id)!;
const openCase = (raw: DatabaseSync, caseId: string, orderId: string, itemId: string, qty = 1) =>
  raw
    .prepare(
      `INSERT INTO return_cases (id, order_id, order_item_id, user_id, qty, reason, state, within_window, delivered_at_snapshot)
       VALUES (?, ?, ?, 'cust', ?, 'defective', 'inspected', 1, ?)`
    )
    .run(caseId, orderId, itemId, qty, new Date().toISOString());
const refundOf = (raw: DatabaseSync, caseId: string) => row<{ amount_iqd: number }>(raw, "SELECT amount_iqd FROM wallet_transactions WHERE id = ?", `wtx_ret_${caseId}`)?.amount_iqd ?? 0;
const resolve = (raw: DatabaseSync, caseId: string) => post(adminApp(raw, OWNER), `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'refund' });

/** A completed trade-in: the P1S bought with the credit and delivered. */
async function completedWithP1S(raw: DatabaseSync) {
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  await delivered(raw, orderId);
  assert.equal(req(raw, id).status, 'completed');
  const line = row<{ id: string; unit_price_iqd: number }>(raw, "SELECT id, unit_price_iqd FROM order_items WHERE order_id = ? AND product_id = 'p_p1s'", orderId)!;
  return { id, orderId, lineId: line.id, unit: line.unit_price_iqd, credit: req(raw, id).credit_iqd as number };
}

test('returning the new device: cash = basis − credit, the SAME coupon back for 30 days, usable on any direct-sale device, then spent again', async () => {
  const raw = seed();
  const t = await completedWithP1S(raw);
  const coupon = row<{ id: string; code: string }>(raw, 'SELECT id, code FROM coupons WHERE trade_in_id = ?', t.id)!;
  openCase(raw, 'ret_p1s', t.orderId, t.lineId);
  const res = await resolve(raw, 'ret_p1s');
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.refund.amount_iqd, t.unit - t.credit, 'never the credit as cash');
  assert.equal(refundOf(raw, 'ret_p1s'), t.unit - t.credit);
  // The credit comes back: the same row, released use, a re-issue for 30 days.
  const x = row<Record<string, any>>(raw, 'SELECT * FROM trade_in_credit_reissues WHERE request_id = ?', t.id)!;
  assert.deepEqual([x.reason, x.return_case_id, x.amount_iqd, x.coupon_id, x.order_id], ['returned', 'ret_p1s', t.credit, coupon.id, t.orderId]);
  assert.ok(Math.abs(Date.parse(x.ends_at) - (Date.now() + 30 * DAY)) < 120_000, x.ends_at);
  assert.equal(row<{ ends_at: string }>(raw, 'SELECT ends_at FROM coupons WHERE id = ?', coupon.id)!.ends_at, x.ends_at);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM coupon_redemptions WHERE order_id = ?', t.orderId)!.state, 'released');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications WHERE event_key = ?', `trade_in:${t.id}:reissued:${t.orderId}`), 1);
  // The customer reads it.
  const a = customerApp(raw);
  const mine = (await json(await get(a, `/api/trade-in/requests/${t.id}`))).request;
  assert.deepEqual([mine.stage, mine.reissue?.any_device, mine.can.pay], ['credit_reissued', true, true]);
  const pay = await json(await post(a, `/api/trade-in/requests/${t.id}/checkout`));
  assert.deepEqual([pay.coupon_code, pay.any_device, pay.target], [coupon.code, true, null]);
  // Pressed twice: nothing more.
  assert.notEqual((await resolve(raw, 'ret_p1s')).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_credit_reissues WHERE request_id = ?', t.id), 1);
  // Spent again on ANOTHER device sold directly (the A1), never as cash.
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('c_a1_again','cust','p_a1','v_a1','["v_a1"]','','','','',1)`);
  const again = await post(a, '/api/orders', checkoutBody({ couponCode: coupon.code }));
  const placed = await json(again);
  assert.equal(again.status, 200, JSON.stringify(placed));
  await settle();
  const snap = JSON.parse(row<{ coupon_snapshot: string }>(raw, 'SELECT coupon_snapshot FROM orders WHERE id = ?', placed.order.id)!.coupon_snapshot);
  const a1Line = row<{ id: string }>(raw, "SELECT id FROM order_items WHERE order_id = ? AND product_id = 'p_a1'", placed.order.id)!;
  assert.deepEqual([snap.coupon_id, snap.trade_in_line_id, snap.discount_iqd], [coupon.id, a1Line.id, t.credit]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupons WHERE trade_in_id = ?', t.id), 1, 'one coupon for life');
});

test('a credit given back is not cash and buys no consumable: a cart with no direct-sale device is refused', async () => {
  const raw = seed();
  const t = await completedWithP1S(raw);
  openCase(raw, 'ret_x', t.orderId, t.lineId);
  assert.equal((await resolve(raw, 'ret_x')).status, 200);
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id,sub_category_id)
              VALUES ('p_pla','pla','PLA Basic','PLA',25000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','cat_materials','cat_materials_fdm');
            INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
              VALUES ('c_pla','cust','p_pla','','[]','','','','',1)`);
  const code = row<{ code: string }>(raw, 'SELECT code FROM coupons WHERE trade_in_id = ?', t.id)!.code;
  const res = await post(customerApp(raw), '/api/orders', checkoutBody({ couponCode: code }));
  assert.equal(res.status, 400, await res.clone().text());
  assert.equal((await json(res)).code, 'TRADE_IN_COUPON_MISMATCH');
});

test('a qty-2 line bought with the credit: the first unit returned carries the credit, the second is refunded in full — Σ cash = basis − credit, one re-issue', async () => {
  const raw = seed();
  const id = await submitted(raw);
  await received(raw, id);
  await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/approve`);
  const a = customerApp(raw);
  const pay = await json(await post(a, `/api/trade-in/requests/${id}/checkout`));
  // Two P1S on the line the credit pays for (the cap: one unit of it).
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('c_p1s_two','cust','p_p1s','','[]','','','','',2)`);
  const placed = await post(a, '/api/orders', checkoutBody({ couponCode: pay.coupon_code }));
  assert.equal(placed.status, 200, await placed.clone().text());
  await settle();
  const orderId = (await json(placed)).order.id as string;
  await delivered(raw, orderId);
  const line = row<{ id: string; unit_price_iqd: number; qty: number }>(raw, "SELECT id, unit_price_iqd, qty FROM order_items WHERE order_id = ? AND product_id = 'p_p1s'", orderId)!;
  assert.equal(line.qty, 2);
  const credit = req(raw, id).credit_iqd as number;
  openCase(raw, 'ret_one', orderId, line.id, 1);
  assert.equal((await resolve(raw, 'ret_one')).status, 200);
  openCase(raw, 'ret_two', orderId, line.id, 1);
  assert.equal((await resolve(raw, 'ret_two')).status, 200);
  assert.equal(refundOf(raw, 'ret_one') + refundOf(raw, 'ret_two'), 2 * line.unit_price_iqd - credit);
  assert.equal(refundOf(raw, 'ret_two'), line.unit_price_iqd);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_credit_reissues WHERE request_id = ?', id), 1);
});

test('concurrency: two refund presses of the target line at once — one refund, one re-issue', async () => {
  const raw = seed();
  const t = await completedWithP1S(raw);
  openCase(raw, 'ret_race', t.orderId, t.lineId);
  const db = serialD1(raw);
  const app = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/returns', returnRoutes));
  const [a, b] = await Promise.all([
    post(app, '/api/returns/admin/ret_race/transition', { to: 'resolved', resolution: 'refund' }),
    post(app, '/api/returns/admin/ret_race/transition', { to: 'resolved', resolution: 'refund' }),
  ]);
  assert.equal([a.status, b.status].filter((s) => s === 200).length, 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE id = 'wtx_ret_ret_race'"), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_credit_reissues WHERE request_id = ?', t.id), 1);
});
