/**
 * Services S-P2 (DECISIONS row 238; spec §6.10, §7, §13.3, §13.4) — the services sweep, the
 * quarter-hour tick's last step: the cut-over stamp, offers and credits that end (a reminder the
 * day before, then the expiry), completions the delivered hook missed, credits given back. Every
 * sub-step run twice does nothing the second time; notices go once; the budget is respected and a
 * sweep that runs out stops cleanly. LOCAL ONLY.
 *
 * Run: node --import tsx --test tests/sv2_p2_expiry_sweep.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, get, json, post, row, stubApp } from './fixtures/app';
import { adminTradeInRoutes } from '../worker/routes/tradeIn';
import { serialD1 } from './fixtures/serialD1';
import { countingD1 } from '../worker/lib/d1Count';
import { statementBudget } from '../worker/lib/fx/budget';
import { COMPLETION_STATEMENT_BOUND, STOCK_BOOKING_STATEMENT_BOUND, runServicesSweep } from '../worker/lib/tradeInSweep';
import { completeTradeInsForOrder } from '../worker/lib/tradeInStock';
import { SERVICES_TICK_BUDGET, quarterHourServicesBudget, QUARTER_HOUR_TICK_LIMIT } from '../worker/lib/quarterHourBudget';
import { STAFF, adminApp, approvedAndOrdered, customerApp, daysAgo, received, restoreFetch, seed, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const DAY = 86_400_000;
const req = (raw: DatabaseSync, id: string) => row<Record<string, any>>(raw, 'SELECT * FROM trade_in_requests WHERE id = ?', id)!;
const notices = (raw: DatabaseSync, key: string) => count(raw, 'SELECT COUNT(*) AS n FROM user_notifications WHERE event_key = ?', key);
const sweep = (raw: DatabaseSync, limit = SERVICES_TICK_BUDGET, now?: Date) => runServicesSweep({ DB: asD1(raw), APP_ORIGIN: 'https://levonis.test' } as never, statementBudget(limit), now);
const hoursAhead = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

test('cut-over: a request open before S-P2 gets 7 days from the first sweep to hand the device in, told once; a legacy credit with no end gets one', async () => {
  const raw = seed();
  const id = await submitted(raw);
  // Submitted before 0192: no offer end.
  raw.prepare('UPDATE trade_in_requests SET offer_expires_at = NULL WHERE id = ?').run(id);
  const first = await sweep(raw);
  assert.equal(first.stamped, 1);
  const stamped = req(raw, id).offer_expires_at as string;
  assert.ok(Math.abs(Date.parse(stamped) - (Date.now() + 7 * DAY)) < 120_000, stamped);
  assert.equal(notices(raw, `trade_in:${id}:cutover`), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM trade_in_events WHERE request_id = ? AND action = 'cutover'", id), 1);
  const again = await sweep(raw);
  assert.equal(again.stamped, 0);
  assert.equal(req(raw, id).offer_expires_at, stamped, 'stamped once');
  assert.equal(notices(raw, `trade_in:${id}:cutover`), 1);

  // A credit minted on photos before S-P2, its coupon with no end.
  const raw2 = seed();
  const id2 = await submitted(raw2);
  const offer = req(raw2, id2).offer_iqd as number;
  raw2.exec(`
    INSERT INTO coupons (id, code, tier_required, kind, value, min_total_iqd, max_global, max_per_user, active, created_at, assigned_user_id, scope,
                         product_id, fulfillment_types, applies_to, cap_scope, max_quantity, stacks, trade_in_id, ends_at)
      VALUES ('cpn_old', 'TIOLD0001', NULL, 'fixed_iqd', ${offer}, 0, 1, 1, 1, '${daysAgo(3)}', 'cust', 'product',
              'p_p1s', '["direct_sale"]', 'merchandise', 'per_order', 1, 0, '${id2}', NULL);
    UPDATE trade_in_requests SET status = 'awaiting_payment', final_value_iqd = ${offer}, credit_iqd = ${offer}, coupon_id = 'cpn_old' WHERE id = '${id2}';
  `);
  await sweep(raw2);
  const ends = row<{ ends_at: string }>(raw2, "SELECT ends_at FROM coupons WHERE id = 'cpn_old'")!.ends_at;
  assert.ok(Math.abs(Date.parse(ends) - (Date.now() + 7 * DAY)) < 120_000, ends);
  assert.equal(notices(raw2, `trade_in:${id2}:cutover`), 1);
  await sweep(raw2);
  assert.equal(row<{ ends_at: string }>(raw2, "SELECT ends_at FROM coupons WHERE id = 'cpn_old'")!.ends_at, ends);
  assert.equal(notices(raw2, `trade_in:${id2}:cutover`), 1);
});

test('an offer ending within 24 hours is reminded once; an offer past its end with no device is cancelled (expired_offer), the claim released; a received device is never expired', async () => {
  const raw = seed();
  const id = await submitted(raw);
  raw.prepare('UPDATE trade_in_requests SET offer_expires_at = ? WHERE id = ?').run(hoursAhead(12), id);
  assert.equal((await sweep(raw)).offer_reminders, 1);
  assert.equal((await sweep(raw)).offer_reminders, 0);
  assert.equal(notices(raw, `trade_in:${id}:offer_expiring`), 1);

  raw.prepare('UPDATE trade_in_requests SET offer_expires_at = ? WHERE id = ?').run(daysAgo(1), id);
  assert.equal((await sweep(raw)).offers_expired, 1);
  const r = req(raw, id);
  assert.deepEqual([r.status, r.cancel_reason, r.cancelled_by], ['cancelled', 'expired_offer', null]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_claims WHERE request_id = ?', id), 0, 'the device is free for another service');
  assert.equal(notices(raw, `trade_in:${id}:expired_offer`), 1);
  const mine = (await json(await get(customerApp(raw), `/api/trade-in/requests/${id}`))).request;
  assert.equal(mine.stage, 'offer_expired');
  assert.equal((await sweep(raw)).offers_expired, 0);

  // Received before its end: the offer is the shop's to decide now; the sweep leaves it.
  const raw2 = seed();
  const id2 = await submitted(raw2);
  await received(raw2, id2);
  raw2.prepare('UPDATE trade_in_requests SET offer_expires_at = ? WHERE id = ?').run(daysAgo(1), id2);
  await sweep(raw2);
  assert.equal(req(raw2, id2).status, 'under_review');
});

test('a credit ending within 24 hours is reminded once (per end date); a credit past its end and unspent is cancelled (expired_credit), its coupon off, the received device to collect; a credit an order holds is never expired', async () => {
  const raw = seed();
  const id = await submitted(raw);
  await received(raw, id);
  await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`);
  const coupon = row<{ id: string }>(raw, 'SELECT id FROM coupons WHERE trade_in_id = ?', id)!.id;
  const soon = hoursAhead(10);
  raw.prepare('UPDATE coupons SET ends_at = ? WHERE id = ?').run(soon, coupon);
  assert.equal((await sweep(raw)).credit_reminders, 1);
  assert.equal((await sweep(raw)).credit_reminders, 0);
  assert.equal(notices(raw, `trade_in:${id}:credit_expiring:${soon.slice(0, 10)}`), 1);

  raw.prepare('UPDATE coupons SET ends_at = ? WHERE id = ?').run(daysAgo(1), coupon);
  assert.equal((await sweep(raw)).credits_expired, 1);
  const r = req(raw, id);
  assert.deepEqual([r.status, r.cancel_reason], ['cancelled', 'expired_credit']);
  assert.equal(row<{ active: number }>(raw, 'SELECT active FROM coupons WHERE id = ?', coupon)!.active, 0);
  assert.equal(notices(raw, `trade_in:${id}:expired_credit`), 1);
  assert.equal(notices(raw, `trade_in:${id}:device_ready`), 1);
  assert.equal((await json(await get(customerApp(raw), `/api/trade-in/requests/${id}`))).request.stage, 'device_to_collect');
  assert.equal((await sweep(raw)).credits_expired, 0);

  // Spent on an order still on its way: the credit is the order's, never expired under it.
  const raw2 = seed();
  const id2 = await submitted(raw2);
  await approvedAndOrdered(raw2, id2);
  raw2.prepare('UPDATE coupons SET ends_at = ? WHERE trade_in_id = ?').run(daysAgo(1), id2);
  await sweep(raw2);
  assert.equal(req(raw2, id2).status, 'awaiting_payment');
});

test('completion catch-up: an order delivered by a door that missed the hook completes its trade-in and books the device; a request completed before its intake books stock once received', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), orderId);
  const out = await sweep(raw);
  assert.equal(out.completed, 1, JSON.stringify(out));
  assert.equal(req(raw, id).status, 'completed');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_stock WHERE request_id = ?', id), 1);
  assert.equal((await sweep(raw)).completed, 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_lots WHERE id = ?', `ilot_ti_${id}`), 1);

  // Completed by hand before S-P2, the device received afterwards with its stock not booked (the door failed).
  const raw2 = seed();
  const id2 = await submitted(raw2);
  const offer = req(raw2, id2).offer_iqd as number;
  raw2.prepare(`UPDATE trade_in_requests SET status = 'completed', completed_at = ?, final_value_iqd = ?, credit_iqd = ?, intake_at = ?, intake_by = 'staff' WHERE id = ?`).run(daysAgo(2), offer, offer, daysAgo(1), id2);
  assert.equal((await sweep(raw2)).stock_booked, 1);
  assert.equal(count(raw2, 'SELECT COUNT(*) AS n FROM trade_in_stock WHERE request_id = ?', id2), 1);
  assert.equal((await sweep(raw2)).stock_booked, 0);
});

test('a credit given back by the cancel trigger is told to its customer by the sweep, once', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  // Completed before S-P2 by hand while the order was on its way; the order is then cancelled.
  raw.prepare(`UPDATE trade_in_requests SET status = 'completed', completed_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  raw.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(new Date().toISOString(), orderId);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_credit_reissues WHERE request_id = ?', id), 1, 'the 0192 trigger re-issued');
  assert.equal((await sweep(raw)).reissue_notices, 1);
  assert.equal((await sweep(raw)).reissue_notices, 0);
  assert.equal(notices(raw, `trade_in:${id}:reissued:${orderId}`), 1);
});

test('the budget: every statement charged before it is sent — a short budget stops cleanly, and a whole sweep stays inside it; a completion costs less than its bound', async () => {
  const raw = seed();
  const ids: string[] = [];
  for (const item of ['oi_a1']) ids.push(await submitted(raw, item));
  raw.prepare('UPDATE trade_in_requests SET offer_expires_at = NULL').run();
  const view = countingD1(asD1(raw));
  const before = view.executed;
  const tiny = await runServicesSweep({ DB: view.db } as never, statementBudget(4));
  assert.equal(tiny.stopped, true);
  assert.ok(view.executed - before <= 4, `spent ${view.executed - before} of 4`);
  assert.equal(req(raw, ids[0]).offer_expires_at, null, 'nothing half-done');
  const mid = view.executed;
  const full = await runServicesSweep({ DB: view.db } as never, statementBudget(SERVICES_TICK_BUDGET));
  assert.equal(full.stopped, false);
  assert.ok(view.executed - mid <= SERVICES_TICK_BUDGET, `spent ${view.executed - mid} of ${SERVICES_TICK_BUDGET}`);
  assert.equal(full.stamped, 1);

  // The share: its 120, cut to what the tick left.
  assert.equal(quarterHourServicesBudget(0), SERVICES_TICK_BUDGET);
  assert.equal(quarterHourServicesBudget(QUARTER_HOUR_TICK_LIMIT - 30), 30);
  assert.equal(quarterHourServicesBudget(QUARTER_HOUR_TICK_LIMIT + 5), 0);

  // A completion on delivery and a late stock booking, measured on the counting view.
  const w = seed();
  const id = await submitted(w);
  const { orderId } = await approvedAndOrdered(w, id);
  w.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), orderId);
  const v = countingD1(asD1(w));
  const at = v.executed;
  assert.deepEqual(await completeTradeInsForOrder({ DB: v.db } as never, orderId), [id]);
  const cost = v.executed - at;
  assert.ok(cost <= COMPLETION_STATEMENT_BOUND, `a completion cost ${cost} > ${COMPLETION_STATEMENT_BOUND}`);
  assert.ok(STOCK_BOOKING_STATEMENT_BOUND < COMPLETION_STATEMENT_BOUND);
  console.log(`one completion on delivery: ${cost} statements (bound ${COMPLETION_STATEMENT_BOUND})`);
});

test('concurrency: the intake and the offer-expiry sweep at once — one wins: either the device is received, or the offer expired and the intake refused', async () => {
  const raw = seed();
  const id = await submitted(raw);
  // The offer ends between the desk's read and the sweep's clock: the desk still sees it open.
  raw.prepare('UPDATE trade_in_requests SET offer_expires_at = ? WHERE id = ?').run(new Date(Date.now() + 30_000).toISOString(), id);
  raw.prepare(`INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES ('SNRACE0001', 'SNRACE0001', 'unit_a1', 'staff')`).run();
  const db = serialD1(raw);
  const desk = stubApp(db, STAFF, (a) => a.route('/api/admin/trade-in', adminTradeInRoutes));
  const [intake, swept] = await Promise.all([
    post(desk, `/api/admin/trade-in/requests/${id}/intake`, { serial: 'SNRACE0001', handover: 'store' }),
    runServicesSweep({ DB: db } as never, statementBudget(SERVICES_TICK_BUDGET), new Date(Date.now() + 60_000)),
  ]);
  const r = req(raw, id);
  if (intake.status === 200) {
    assert.equal(swept.offers_expired, 0);
    assert.ok(r.intake_at);
    assert.equal(r.status, 'under_review');
  } else {
    assert.equal(intake.status, 409, await intake.clone().text());
    assert.equal(swept.offers_expired, 1);
    assert.deepEqual([r.status, r.cancel_reason, r.intake_at], ['cancelled', 'expired_offer', null]);
  }
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM trade_in_events WHERE request_id = ? AND action IN ('intake','cancel')", id), 1, 'exactly one of them happened');
});

test('review F-7/F-16: completions that keep failing do not hold the catch-up — they are put on record, wait their turn, and the next one completes; the desk sees them as overdue', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES ('other','Other','o@x.co','h','customer','2026-01-01T00:00:00.000Z','ar')`);
  for (const k of ['b', 'c']) {
    raw.exec(`
      INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at)
        VALUES ('ORD-OLD-${k}','cust','delivered','delivered','{}','standard','{}','cash',850000,0,1400,850000,0,'${daysAgo(25)}','${daysAgo(20)}','${daysAgo(20)}');
      INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids)
        VALUES ('oi_${k}1','ORD-OLD-${k}','p_a1','Bambu Lab A1','','A1',1,850000,850000,'v_a1','["v_a1"]');
      INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_ext_months,warranty_start_at,warranty_end_at,policy_version)
        VALUES ('unit_${k}1','ORD-OLD-${k}','oi_${k}1','p_a1','cust',1,'${daysAgo(20)}',12,0,'${daysAgo(20)}','${new Date(Date.now() + 340 * DAY).toISOString()}','{}');`);
  }
  const ids: string[] = [];
  const orders: string[] = [];
  for (const item of ['oi_a1', 'oi_b1', 'oi_c1']) {
    const id = await submitted(raw, item);
    ids.push(id);
    orders.push((await approvedAndOrdered(raw, id)).orderId);
  }
  // A and B: their devices were linked to another account behind the doors' back — their completion fails every time.
  raw.exec(`INSERT INTO device_registrations (unit_id, user_id) VALUES ('unit_a1', 'other'), ('unit_b1', 'other')`);
  // All three orders delivered by a door that missed the hook.
  for (const o of orders) raw.prepare("UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), o);
  await sweep(raw);
  await sweep(raw);
  assert.equal(req(raw, ids[2]).status, 'completed', 'the third completes — the failing two do not hold the two places');
  assert.deepEqual([req(raw, ids[0]).status, req(raw, ids[1]).status], ['awaiting_payment', 'awaiting_payment']);
  for (const id of ids.slice(0, 2)) assert.ok(count(raw, "SELECT COUNT(*) AS n FROM trade_in_events WHERE request_id = ? AND action = 'completion_failed'", id) >= 1);
  // The desk's «overdue» chip carries them; the customer's view never shows the failed attempt.
  const q = await json(await get(adminApp(raw, STAFF), '/api/admin/trade-in/requests?chip=overdue'));
  const overdue = (q.requests as Array<{ id: string }>).map((r) => r.id).sort();
  assert.deepEqual(overdue, ids.slice(0, 2).sort());
  const mine = await json(await get(customerApp(raw), `/api/trade-in/requests/${ids[0]}`));
  assert.ok(!JSON.stringify(mine).includes('completion_failed'));
});

test('review F-17: a legacy credit minted on photos that already had an end is told, once, to bring the device in — and gets the owner’s window to do it', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const offer = req(raw, id).offer_iqd as number;
  const soon = new Date(Date.now() + 2 * DAY).toISOString();
  raw.exec(`
    INSERT INTO coupons (id, code, tier_required, kind, value, min_total_iqd, max_global, max_per_user, active, created_at, assigned_user_id, scope,
                         product_id, fulfillment_types, applies_to, cap_scope, max_quantity, stacks, trade_in_id, ends_at)
      VALUES ('cpn_s0', 'TIS0CREDIT1', NULL, 'fixed_iqd', ${offer}, 0, 1, 1, 1, '${daysAgo(5)}', 'cust', 'product',
              'p_p1s', '["direct_sale"]', 'merchandise', 'per_order', 1, 0, '${id}', '${soon}');
    UPDATE trade_in_requests SET status = 'awaiting_payment', final_value_iqd = ${offer}, credit_iqd = ${offer}, coupon_id = 'cpn_s0' WHERE id = '${id}';
  `);
  await sweep(raw);
  assert.equal(notices(raw, `trade_in:${id}:cutover`), 1);
  const ends = row<{ ends_at: string }>(raw, "SELECT ends_at FROM coupons WHERE id = 'cpn_s0'")!.ends_at;
  assert.ok(Date.parse(ends) > Date.now() + 6 * DAY, ends);
  await sweep(raw);
  assert.equal(notices(raw, `trade_in:${id}:cutover`), 1, 'told once');
  assert.equal(row<{ ends_at: string }>(raw, "SELECT ends_at FROM coupons WHERE id = 'cpn_s0'")!.ends_at, ends);
});
