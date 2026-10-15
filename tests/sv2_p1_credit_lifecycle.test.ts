/**
 * Services V2, S-P1 — ONE TRADE-IN CREDIT FOR LIFE (plan §0 correction 1, X1;
 * DECISIONS row 237, migration 0191).
 *
 * A cancelled order gives its coupon use back (trg_orders_coupon_released).
 * For a trade-in credit that must not become two credits: «إتمام الدفع» never
 * mints a second coupon — the same coupon comes back with the same code, and
 * its end moves by exactly the time the cancelled order held it. The database
 * refuses a second credit coupon for one request (trg_trade_in_one_credit) and
 * an inactive coupon inside the order batch (trg_coupon_redemption_limits).
 *
 *   X1      cancel the order that spent the credit, then type the old code and
 *           press «إتمام الدفع» at the same moment: one usable credit
 *   X1      two orders typing the same code at the same moment: one wins
 *   X1      an inactive coupon is refused by the trigger itself, and a
 *           personal code handed to someone else mid-checkout reads as unknown
 *   X1      a request that somehow already holds a coupon is not minted a
 *           second at approval: the trigger's refusal reads TRADE_IN_STALE
 *   legacy  an order cancelled before 0191 (its use still spent) is released
 *           by «إتمام الدفع», once, even when pressed twice at once
 *   reopen  cancel → reopen → cancel: the end is the original end plus every
 *           period an order held the credit
 *   closed  the order of a COMPLETED trade-in is cancelled: the use is released,
 *           but a credit that can never be spent again is neither extended nor
 *           announced to the customer as «back»
 *
 * Real routes over every migration; RaceD1 lets a second request finish at
 * the exact moment the first is about to write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { count, get, json, patch, post, row, stubApp, pending } from './fixtures/app';
import { LimitD1 } from './fixtures/d1Limits';
import { RaceD1, redeems } from './fixtures/raceD1';
import { orderRoutes } from '../worker/routes/orders';
import { tradeInRoutes } from '../worker/routes/tradeIn';
import { adminRoutes } from '../worker/routes/admin';
import { OWNER, CUSTOMER, adminApp, customerApp, checkoutBody, restoreFetch, seed, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const DAY = 86_400_000;
const MINUTE = 60_000;

/** An approved trade-in with its credit code in hand and the P1S in the cart. */
async function readyToPay(raw: DatabaseSync) {
  const id = await submitted(raw);
  const approved = await json(await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`));
  assert.equal(approved.request.status, 'awaiting_payment', JSON.stringify(approved));
  const pay = await json(await post(customerApp(raw), `/api/trade-in/requests/${id}/checkout`));
  assert.ok(pay.coupon_code, JSON.stringify(pay));
  const coupon = row<{ id: string; ends_at: string }>(raw, 'SELECT id, ends_at FROM coupons WHERE trade_in_id = ?', id)!;
  return { id, code: pay.coupon_code as string, coupon: coupon.id, endsAt: coupon.ends_at };
}

let lineSeq = 0;
/** One P1S in Sara's cart; its id, for `itemIds`. */
function p1sLine(raw: DatabaseSync): string {
  const id = `c_p1s_${++lineSeq}`;
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('${id}','cust','p_p1s','','[]','','','','',1)`);
  return id;
}

async function order(raw: DatabaseSync, code: string, app = customerApp(raw), line = p1sLine(raw)) {
  const res = await post(app, '/api/orders', checkoutBody({ couponCode: code, itemIds: [line] }));
  const body = await json(res);
  await Promise.all(pending.splice(0));
  return { status: res.status, body, id: String(body.order?.id ?? '') };
}
type Answer = { status: number; body: Record<string, unknown> };

const ordersOf = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) AS n FROM orders WHERE user_id = 'cust' AND id <> 'ORD-OLD'");
const liveUses = (raw: DatabaseSync, coupon: string) =>
  count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND state = 'active'", coupon);
const coupons = (raw: DatabaseSync, id: string) => count(raw, 'SELECT COUNT(*) AS n FROM coupons WHERE trade_in_id = ?', id);
const restored = (raw: DatabaseSync, id: string) =>
  count(raw, "SELECT COUNT(*) AS n FROM trade_in_events WHERE request_id = ? AND action = 'credit_restored'", id);
const endOf = (raw: DatabaseSync, coupon: string) => Date.parse(row<{ ends_at: string }>(raw, 'SELECT ends_at FROM coupons WHERE id = ?', coupon)!.ends_at);
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < MINUTE, `${what}: ${new Date(actual).toISOString()} vs ${new Date(expected).toISOString()}`);
const ownerAdmin = (raw: DatabaseSync) => stubApp(new LimitD1(raw) as unknown as D1Database, OWNER, (a) => a.route('/api/admin', adminRoutes));

test('X1: cancel the order that spent the credit, then type the old code and press «إتمام الدفع» at the same moment — one usable credit', async () => {
  const raw = seed({ deliveredDaysAgo: 40 });
  const t = await readyToPay(raw);
  const a = await order(raw, t.code);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  // Order A held the credit for one day, then the customer cancelled it.
  raw.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - DAY).toISOString(), a.id);
  const cancelled = await post(customerApp(raw), `/api/orders/${a.id}/cancel`, {});
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM coupon_redemptions WHERE order_id = ?', a.id)!.state, 'released');
  assert.equal(coupons(raw, t.id), 1);
  near(endOf(raw, t.coupon), Date.parse(t.endsAt) + DAY, 'the end moved by the day the order held it');
  assert.equal(restored(raw, t.id), 1);

  // The old code, typed, and «إتمام الدفع», at the same moment.
  const race = new RaceD1(raw);
  race.when = redeems;
  const seen: { pay?: Answer } = {};
  race.hook = async () => {
    const r = await post(customerApp(raw), `/api/trade-in/requests/${t.id}/checkout`);
    seen.pay = { status: r.status, body: await json(r) };
  };
  const b = await order(raw, t.code, stubApp(race as unknown as D1Database, CUSTOMER, (x) => x.route('/api/orders', orderRoutes)));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.ok(seen.pay, 'the press ran inside the race');
  assert.equal(seen.pay.status, 200, JSON.stringify(seen.pay.body));
  assert.equal(seen.pay.body.coupon_code, t.code, '«إتمام الدفع» answers the same code — it never mints');

  // One coupon, one live use, one live order carrying it.
  assert.equal(coupons(raw, t.id), 1);
  assert.equal(liveUses(raw, t.coupon), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders o JOIN coupon_redemptions r ON r.order_id = o.id WHERE r.coupon_id = ? AND o.status <> 'cancelled'", t.coupon), 1);
  const now = await json(await post(customerApp(raw), `/api/trade-in/requests/${t.id}/checkout`));
  assert.equal(now.order_id, b.id, '«إتمام الدفع» now sends the customer to the live order');

  // A third order with the code is refused whole.
  const before = ordersOf(raw);
  const c = await order(raw, t.code);
  assert.equal(c.status, 400, JSON.stringify(c.body));
  assert.ok(['GLOBAL_LIMIT_REACHED', 'PER_USER_LIMIT_REACHED'].includes(String(c.body.code)), String(c.body.code));
  assert.equal(ordersOf(raw), before);
});

test('X1: two orders typing the released code at the same moment — exactly one lands', async () => {
  const raw = seed({ deliveredDaysAgo: 40 });
  const t = await readyToPay(raw);
  const a = await order(raw, t.code);
  assert.equal(a.status, 200);
  assert.equal((await post(customerApp(raw), `/api/orders/${a.id}/cancel`, {})).status, 200);
  const before = ordersOf(raw);

  // One P1S in the cart, checked out from two tabs (a customer holds one line per
  // product: idx_cart_levonis_line), both typing the released code.
  const line = p1sLine(raw);
  const race = new RaceD1(raw);
  race.when = redeems;
  const seen: { inner?: Answer } = {};
  race.hook = async () => {
    const r = await order(raw, t.code, customerApp(raw), line);
    seen.inner = { status: r.status, body: r.body };
  };
  const outer = await order(raw, t.code, stubApp(race as unknown as D1Database, CUSTOMER, (x) => x.route('/api/orders', orderRoutes)), line);
  assert.ok(seen.inner, JSON.stringify(outer));
  assert.equal(seen.inner.status, 200, JSON.stringify(seen.inner.body));
  assert.equal(outer.status, 400, JSON.stringify(outer.body));
  assert.ok(['GLOBAL_LIMIT_REACHED', 'PER_USER_LIMIT_REACHED'].includes(String(outer.body.code)), `the redemption trigger refused it: ${JSON.stringify(outer.body)}`);
  assert.equal(liveUses(raw, t.coupon), 1);
  assert.equal(ordersOf(raw), before + 1);
});

test('X1: an inactive coupon is refused by the trigger — by SQL, mid-checkout for a promo code, and for a trade-in credit retired mid-checkout', async () => {
  // (a) The limit trigger refuses an inactive coupon itself (0191), not only the read-time check.
  {
    const raw = seed();
    raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active) VALUES ('cpn_off', 'OFF5K', 'fixed_iqd', 5000, 0, 1, 0)`);
    assert.throws(
      () => raw.prepare("INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('r_off', 'cpn_off', 'cust', 'ORD-OLD', 5000)").run(),
      /COUPON_INACTIVE/
    );
  }
  // (b) A promo code switched off between the checkout's read and its batch.
  {
    const raw = seed();
    raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active) VALUES ('cpn_once', 'ONCE5K', 'fixed_iqd', 5000, 0, 1, 1)`);
    const race = new RaceD1(raw);
    race.when = redeems;
    race.hook = async () => void raw.exec("UPDATE coupons SET active = 0 WHERE id = 'cpn_once'");
    const res = await order(raw, 'ONCE5K', stubApp(race as unknown as D1Database, CUSTOMER, (x) => x.route('/api/orders', orderRoutes)));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'INACTIVE');
    assert.equal(ordersOf(raw), 0);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = 'cpn_once'"), 0);
  }
  // (c) A trade-in credit retired by the desk's cancel mid-checkout (F2's shape, the admin door).
  {
    const raw = seed({ deliveredDaysAgo: 40 });
    const t = await readyToPay(raw);
    const race = new RaceD1(raw);
    race.when = redeems;
    let cancelStatus = 0;
    race.hook = async () => {
      cancelStatus = (await post(adminApp(raw), `/api/admin/trade-in/requests/${t.id}/cancel`, { reason: 'desk cancel' })).status;
    };
    const res = await order(raw, t.code, stubApp(race as unknown as D1Database, CUSTOMER, (x) => x.route('/api/orders', orderRoutes)));
    assert.equal(cancelStatus, 200);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'TRADE_IN_COUPON_MISMATCH');
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ?', t.coupon), 0);
    assert.equal(ordersOf(raw), 0);
    // And the retired coupon cannot be redeemed by any writer: the trigger says so.
    assert.throws(
      () => raw.prepare("INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('r_x', ?, 'cust', 'ORD-OLD', 1)").run(t.coupon),
      /COUPON_INACTIVE/
    );
  }
});

test('X1: a personal code reassigned between the checkout\'s read and its batch is refused by the trigger, answered as an unknown code', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active, assigned_user_id)
            VALUES ('cpn_mine', 'MINE5K', 'fixed_iqd', 5000, 0, 1, 1, 'cust')`);
  const race = new RaceD1(raw);
  race.when = redeems;
  race.hook = async () => void raw.exec("UPDATE coupons SET assigned_user_id = 'boss' WHERE id = 'cpn_mine'");
  const res = await order(raw, 'MINE5K', stubApp(race as unknown as D1Database, CUSTOMER, (x) => x.route('/api/orders', orderRoutes)));
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'CODE_NOT_FOUND', 'COUPON_NOT_YOURS reads exactly like a code that does not exist');
  assert.equal(ordersOf(raw), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = 'cpn_mine'"), 0);
});

test('X1: approving a request that somehow already holds a credit coupon mints no second one — TRADE_IN_STALE', async () => {
  const raw = seed({ deliveredDaysAgo: 40 });
  const id = await submitted(raw);
  raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_global, max_per_user, active, assigned_user_id, trade_in_id)
            VALUES ('cpn_pre', 'TIPRE0000000', 'fixed_iqd', 1000, 0, 1, 1, 0, 'cust', '${id}')`);
  const res = await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`);
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'TRADE_IN_STALE', 'trg_trade_in_one_credit (TRADE_IN_CREDIT_EXISTS) is answered as the stale refusal, never a 500');
  assert.equal(coupons(raw, id), 1);
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'submitted');
});

test('legacy: an order cancelled before 0191 still holds the use; «إتمام الدفع» releases it once, with the time that order held it', async () => {
  const raw = seed({ deliveredDaysAgo: 40 });
  const t = await readyToPay(raw);
  const a = await order(raw, t.code);
  assert.equal(a.status, 200);
  // The shape of an order cancelled before 0191: no release trigger at the cancel.
  raw.exec('DROP TRIGGER trg_orders_coupon_released');
  raw.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - DAY).toISOString(), a.id);
  raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(a.id);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM coupon_redemptions WHERE order_id = ?', a.id)!.state, 'active');
  const held = row<{ created_at: string; cancelled_at: string }>(raw, 'SELECT created_at, cancelled_at FROM orders WHERE id = ?', a.id)!;
  assert.ok(held.cancelled_at, '0081 stamps the cancel');

  // Two presses at the same moment: one release, one extension.
  const race = new RaceD1(raw);
  race.when = (sqls) => sqls.some((s) => s.includes("SET state = 'released'"));
  let inner = 0;
  race.hook = async () => {
    const r = await post(customerApp(raw), `/api/trade-in/requests/${t.id}/checkout`);
    inner = r.status;
    assert.equal((await json(r)).coupon_code, t.code);
  };
  const outer = await post(stubApp(race as unknown as D1Database, CUSTOMER, (x) => x.route('/api/trade-in', tradeInRoutes)), `/api/trade-in/requests/${t.id}/checkout`);
  const body = await json(outer);
  assert.equal(inner, 200);
  assert.equal(outer.status, 200, JSON.stringify(body));
  assert.equal(body.coupon_code, t.code, 'the same code, never a new one');
  assert.equal(coupons(raw, t.id), 1);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM coupon_redemptions WHERE order_id = ?', a.id)!.state, 'released');
  near(endOf(raw, t.coupon), Date.parse(t.endsAt) + (Date.parse(held.cancelled_at) - Date.parse(held.created_at)), 'one extension, by the held time');
  assert.equal(restored(raw, t.id), 1, 'one release logged');
  const ev = row<{ detail_json: string }>(raw, "SELECT detail_json FROM trade_in_events WHERE request_id = ? AND action = 'credit_restored'", t.id)!;
  assert.deepEqual(
    { ...JSON.parse(ev.detail_json), ends_at: undefined },
    { order_id: a.id, coupon_id: t.coupon, ends_at: undefined, via: 'checkout' }
  );
  // The released code buys the device once.
  const b = await order(raw, t.code);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(liveUses(raw, t.coupon), 1);
});

test('old code on the new database: a second credit coupon for one request is refused by the database', async () => {
  const raw = seed({ deliveredDaysAgo: 40 });
  const t = await readyToPay(raw);
  assert.throws(
    () =>
      raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_global, max_per_user, active, assigned_user_id, trade_in_id)
                VALUES ('cpn_second', 'TISECONDCODE', 'fixed_iqd', 1000, 0, 1, 1, 1, 'cust', '${t.id}')`),
    /TRADE_IN_CREDIT_EXISTS/
  );
  assert.equal(coupons(raw, t.id), 1);
  // A coupon of no trade-in is untouched by the rule.
  raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active) VALUES ('cpn_promo', 'PROMO1', 'fixed_iqd', 1000, 0, 1, 1)`);
});

test('reopen: cancel → reopen → cancel moves the end by every period an order held the credit, and never by the gap between', async () => {
  const raw = seed({ deliveredDaysAgo: 40 });
  const t = await readyToPay(raw);
  const a = await order(raw, t.code);
  assert.equal(a.status, 200);
  const E = Date.parse(t.endsAt);
  // The trigger reads the real clock; the order's created_at is moved so that,
  // at each step, «now − created_at» is the time elapsed since the order was
  // placed in this story: held 2 days, cancelled 1 day, reopened, held half a day.
  const placedAgo = (ms: number) => raw.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - ms).toISOString(), a.id);
  const admin = ownerAdmin(raw);

  placedAgo(2 * DAY);
  assert.equal((await patch(admin, `/api/admin/orders/${a.id}`, { status: 'cancelled' })).status, 200);
  near(endOf(raw, t.coupon), E + 2 * DAY, 'cancel: + the two days it held the credit');

  placedAgo(3 * DAY);
  const reopened = await patch(admin, `/api/admin/orders/${a.id}`, { status: 'pending' });
  assert.equal(reopened.status, 200, await reopened.clone().text());
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM coupon_redemptions WHERE order_id = ?', a.id)!.state, 'active');
  near(endOf(raw, t.coupon), E - DAY, 'reopen: the day it sat cancelled counts against the credit');

  placedAgo(3.5 * DAY);
  assert.equal((await patch(admin, `/api/admin/orders/${a.id}`, { status: 'cancelled' })).status, 200);
  near(endOf(raw, t.coupon), E + 2 * DAY + DAY / 2, 'cancel again: + both held periods, never the gap');
  assert.equal(coupons(raw, t.id), 1);
  assert.equal(restored(raw, t.id), 2);
});

test('closed: cancelling the order of a completed trade-in releases the use, but neither moves the credit\'s end nor tells the customer it is back', async () => {
  const raw = seed({ deliveredDaysAgo: 40 });
  const t = await readyToPay(raw);
  const a = await order(raw, t.code);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  // The desk took the old device while the order was live: the trade-in is done.
  const done = await post(adminApp(raw), `/api/admin/trade-in/requests/${t.id}/complete`, { reason: 'handed over at the counter' });
  assert.equal(done.status, 200, await done.clone().text());
  raw.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * DAY).toISOString(), a.id);
  const before = endOf(raw, t.coupon);

  const admin = ownerAdmin(raw);
  assert.equal((await patch(admin, `/api/admin/orders/${a.id}`, { status: 'cancelled' })).status, 200);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM coupon_redemptions WHERE order_id = ?', a.id)!.state, 'released', 'the release itself is unconditional');
  assert.equal(endOf(raw, t.coupon), before, 'a credit its completed request can never spend again is not extended');
  assert.equal(restored(raw, t.id), 0, 'no «credit_restored» in the log');
  const view = await json(await get(customerApp(raw), `/api/trade-in/requests/${t.id}`));
  assert.ok(Array.isArray(view.request?.events), JSON.stringify(view).slice(0, 200));
  assert.equal(
    (view.request.events as Array<{ action: string }>).filter((e) => e.action === 'credit_restored').length,
    0,
    'the customer is not told the credit is back'
  );

  // Reopened: the use comes back, and the end does not move the other way either.
  const re = await patch(admin, `/api/admin/orders/${a.id}`, { status: 'pending' });
  assert.equal(re.status, 200, await re.clone().text());
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM coupon_redemptions WHERE order_id = ?', a.id)!.state, 'active');
  assert.equal(endOf(raw, t.coupon), before);
});
