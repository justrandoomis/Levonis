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

// ------------------------------------------------------------------ the final review (money)

test('review F-2: a re-issued credit spent and the order cancelled keeps the time it had left — cancelling can never renew it', async () => {
  const raw = seed();
  const t = await completedWithP1S(raw);
  const coupon = row<{ id: string; code: string }>(raw, 'SELECT id, code FROM coupons WHERE trade_in_id = ?', t.id)!;
  // A credit given back 29 days ago (a return): its re-issue ends tomorrow; the use was released.
  const tomorrow = new Date(Date.now() + DAY).toISOString();
  raw.prepare(`INSERT INTO trade_in_credit_reissues (id, request_id, coupon_id, order_id, reason, return_case_id, amount_iqd, ends_at, created_at)
               VALUES ('tcr_old', ?, ?, ?, 'returned', 'ret_old', ?, ?, ?)`).run(t.id, coupon.id, t.orderId, t.credit, tomorrow, new Date(Date.now() - 29 * DAY).toISOString());
  raw.prepare('UPDATE coupons SET ends_at = ? WHERE id = ?').run(tomorrow, coupon.id);
  raw.prepare(`UPDATE coupon_redemptions SET state = 'released', released_at = ? WHERE order_id = ?`).run(new Date().toISOString(), t.orderId);
  const a = customerApp(raw);
  for (let round = 1; round <= 3; round++) {
    raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
              VALUES ('c_r${round}','cust','p_a1','v_a1','["v_a1"]','','','','',1)`);
    const placed = await post(a, '/api/orders', checkoutBody({ couponCode: coupon.code }));
    const body = await json(placed);
    assert.equal(placed.status, 200, JSON.stringify(body));
    await settle();
    const cancel = await post(a, `/api/orders/${body.order.id}/cancel`, {});
    assert.equal(cancel.status, 200, await cancel.clone().text());
    await settle();
    const ends = Date.parse(row<{ ends_at: string }>(raw, 'SELECT ends_at FROM coupons WHERE id = ?', coupon.id)!.ends_at);
    // Still about one day left (plus the seconds the order held it) — never a fresh 30 days.
    assert.ok(ends - Date.now() < 1.1 * DAY, `round ${round}: ${new Date(ends).toISOString()}`);
    assert.ok(ends - Date.now() > 0.9 * DAY, `round ${round}: ${new Date(ends).toISOString()}`);
  }
  const rows = raw.prepare('SELECT ends_at FROM trade_in_credit_reissues WHERE request_id = ? AND reason = ?').all(t.id, 'order_cancelled') as Array<{ ends_at: string }>;
  assert.equal(rows.length, 3);
  for (const r of rows) assert.ok(Date.parse(r.ends_at) - Date.now() < 1.1 * DAY, r.ends_at);
  // The notice states the day it ends, not «30 days».
  const n = row<{ title_en: string }>(raw, 'SELECT title_en FROM user_notifications WHERE event_key LIKE ? ORDER BY created_at DESC LIMIT 1', `trade_in:${t.id}:reissued:%`);
  if (n) assert.ok(!/30 days/.test(n.title_en), n.title_en);
});

test('review F-3: a delivered order that completed a trade-in, stepped back one stage, is still never cancelled — by an assistant or anyone', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale,admin_scope) VALUES ('helper','Helper','helper@x.co','h','admin','2026-01-01T00:00:00.000Z','ar','assistant')`);
  const t = await completedWithP1S(raw);
  const { adminRoutes } = await import('../worker/routes/admin');
  const { LimitD1 } = await import('./fixtures/d1Limits');
  const { send } = await import('./fixtures/app');
  const app = stubApp(new LimitD1(raw) as unknown as D1Database, { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' } as never, (a) => a.route('/api/admin', adminRoutes));
  const back = await send(app, 'PATCH', `/api/admin/orders/${t.orderId}/stage`, { stage: 'out_for_delivery' });
  assert.equal(back.status, 200, await back.clone().text());
  const cancel = await send(app, 'PATCH', `/api/admin/orders/${t.orderId}/stage`, { stage: 'cancelled', note: 'x' });
  assert.equal(cancel.status, 409, await cancel.clone().text());
  assert.equal((await json(cancel)).code, 'TRADE_IN_ORDER_DELIVERED');
  assert.notEqual(row<{ status: string }>(raw, 'SELECT status FROM orders WHERE id = ?', t.orderId)!.status, 'cancelled');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_credit_reissues WHERE request_id = ?', t.id), 0);
  // The database says it too, whichever door writes.
  assert.throws(() => raw.prepare(`UPDATE orders SET status = 'cancelled', stage = 'cancelled' WHERE id = ?`).run(t.orderId), /TRADE_IN_ORDER_DELIVERED/);
});

test('review F-5/F-10: a completion that did not happen holds the refund (TRADE_IN_COMPLETION_PENDING) — never cash net of a credit that does not come back', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  // The completion fails on delivery (here: the slot's device was linked to another account behind the door's back).
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES ('other','Other','o@x.co','h','customer','2026-01-01T00:00:00.000Z','ar')`);
  raw.exec(`INSERT INTO device_registrations (unit_id, user_id, registered_at) VALUES ('unit_a1', 'other', '${new Date().toISOString()}')`);
  await delivered(raw, orderId);
  assert.equal(req(raw, id).status, 'awaiting_payment', 'completion failed and was contained');
  const line = row<{ id: string }>(raw, "SELECT id FROM order_items WHERE order_id = ? AND product_id = 'p_p1s'", orderId)!;
  openCase(raw, 'ret_pending', orderId, line.id);
  const res = await resolve(raw, 'ret_pending');
  assert.equal(res.status, 409, await res.clone().text());
  assert.equal((await json(res)).code, 'TRADE_IN_COMPLETION_PENDING');
  assert.equal(refundOf(raw, 'ret_pending'), 0);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM return_cases WHERE id = ?', 'ret_pending')!.state, 'inspected');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM coupon_redemptions WHERE order_id = ?', orderId)!.state, 'active');
});

test('review F-8: a qty-2 line bought with a credit worth one whole unit, points on the order — the line’s cash refunds sum to exactly its basis − the credit', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id,sub_category_id) VALUES
      ('p_mini','mini','Bambu Lab A1 mini','بامبو A1 ميني',400000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('pts_c','cust','deposit','POINT',100000,'approved');`);
  const id = await submitted(raw);
  // The target becomes the mini before intake: the credit is one whole unit of it (400,000).
  raw.exec(`UPDATE trade_in_requests SET target_product_id = 'p_mini', target_option_value_ids = '[]', target_color_id = NULL WHERE id = '${id}'`);
  await received(raw, id);
  const ap = await json(await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/approve`));
  assert.equal(ap.request.status, 'awaiting_payment', JSON.stringify(ap));
  const a = customerApp(raw);
  const pay = await json(await post(a, `/api/trade-in/requests/${id}/checkout`));
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty) VALUES ('c_m2','cust','p_mini','','[]','','','','',2)`);
  const placed = await post(a, '/api/orders', checkoutBody({ couponCode: pay.coupon_code, usePoints: true }));
  const pb = await json(placed);
  assert.equal(placed.status, 200, JSON.stringify(pb));
  await settle();
  const orderId = pb.order.id as string;
  await delivered(raw, orderId);
  assert.equal(req(raw, id).status, 'completed');
  const o = row<Record<string, any>>(raw, 'SELECT points_discount_iqd, coupon_snapshot, shipping_iqd FROM orders WHERE id = ?', orderId)!;
  const line = row<{ id: string; unit_price_iqd: number }>(raw, "SELECT id, unit_price_iqd FROM order_items WHERE order_id = ? AND product_id = 'p_mini'", orderId)!;
  const credit = JSON.parse(o.coupon_snapshot).discount_iqd as number;
  assert.ok(o.points_discount_iqd > 0, 'points were spent on the order');
  openCase(raw, 'r1', orderId, line.id);
  assert.equal((await resolve(raw, 'r1')).status, 200);
  openCase(raw, 'r2', orderId, line.id);
  assert.equal((await resolve(raw, 'r2')).status, 200);
  const cash = refundOf(raw, 'r1') + refundOf(raw, 'r2');
  // The goods' cash the customer paid: 2 units − the credit − the points' share of the goods (shipping is not
  // refunded). The points are spread over the goods and the delivery fee pro rata, so the goods' share is
  // points × goods / (goods + shipping) — with «إدارة التوصيل» two printers ship at 20,000, not one 10,000.
  const goods = 2 * line.unit_price_iqd - credit;
  const pointsOnGoods = Math.floor((o.points_discount_iqd * goods) / (goods + Number(o.shipping_iqd)));
  const paidCashForGoods = goods - pointsOnGoods;
  assert.ok(cash <= paidCashForGoods + 1_000, `cash back ${cash} > cash paid for the goods ${paidCashForGoods}`);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_credit_reissues WHERE request_id = ?', id), 1, 'the credit itself comes back once');
});
