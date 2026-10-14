/**
 * Services V2, S-P0 review findings F1–F3 (DECISIONS row 223, plan §1.3):
 * a trade-in credit is spent only while it is still its request's, and only
 * the figure the request approved.
 *
 *   F1  a return opened while the checkout is between its reads and its batch
 *       cancels the trade-in and retires its coupon: the order must roll back
 *       (the device is not paid for twice — once as credit, once as refund).
 *   F2  the same with the customer's own cancel, both orders of arrival: a
 *       cancel that lands first refuses the order; an order that lands first
 *       refuses the cancel (the device cannot earn a second credit).
 *   F3  the generic coupon editor neither rewrites nor retires a trade-in
 *       credit, and a coupon row that says more than the request approved
 *       pays the approved figure.
 *
 * Real routes over every migration; a D1 wrapper lets a second request finish
 * at the exact moment one batch is about to run (a concurrent request).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { json, post, send, row, count, stubApp, pending, type StubUser } from './fixtures/app';
import { LimitD1 } from './fixtures/d1Limits';
import { orderRoutes } from '../worker/routes/orders';
import { returnRoutes } from '../worker/routes/returns';
import { tradeInRoutes } from '../worker/routes/tradeIn';
import { adminRoutes } from '../worker/routes/admin';
import { OWNER, STAFF, CUSTOMER, adminApp, customerApp, checkoutBody, restoreFetch, seed, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

/** A D1 whose next batch matching `when` first lets another request finish. */
class RaceD1 extends LimitD1 {
  hook: (() => Promise<void>) | null = null;
  when: (sqls: string[]) => boolean = () => false;
  override async batch(statements: never[]) {
    const sqls = statements.map((s) => String((s as unknown as { sql?: string }).sql ?? ''));
    if (this.hook && this.when(sqls)) {
      const h = this.hook;
      this.hook = null;
      await h();
    }
    return super.batch(statements);
  }
}

const redeems = (sqls: string[]) => sqls.some((s) => s.includes('INSERT INTO coupon_redemptions'));
const cancels = (sqls: string[]) => sqls.some((s) => /SET status = 'cancelled'/.test(s));

/** An approved trade-in with its credit code in hand and the P1S in the cart. */
async function readyToPay(raw: DatabaseSync) {
  const id = await submitted(raw);
  const approved = await json(await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`));
  assert.equal(approved.request.status, 'awaiting_payment', JSON.stringify(approved));
  const pay = await json(await post(customerApp(raw), `/api/trade-in/requests/${id}/checkout`));
  assert.ok(pay.coupon_code, JSON.stringify(pay));
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('c_p1s','cust','p_p1s','','[]','','','','',1)`);
  const coupon = row<{ id: string }>(raw, 'SELECT id FROM coupons WHERE trade_in_id = ?', id)!.id;
  return { id, code: pay.coupon_code as string, credit: approved.request.credit_iqd as number, coupon };
}

const ordersOf = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) AS n FROM orders WHERE user_id = 'cust' AND id <> 'ORD-OLD'");

test('F1: a return opened mid-checkout cancels the trade-in, and the order that would spend its credit rolls back', async () => {
  const raw = seed({ deliveredDaysAgo: 2 });
  const t = await readyToPay(raw);
  const race = new RaceD1(raw);
  race.when = redeems;
  let returnStatus = 0;
  race.hook = async () => {
    const returnsApp = stubApp(new LimitD1(raw) as unknown as D1Database, CUSTOMER, (a) => a.route('/api/returns', returnRoutes));
    const r = await post(returnsApp, '/api/returns', { orderItemId: 'oi_a1', unitId: 'unit_a1', qty: 1, reason: 'defective', description: 'It stopped heating.' });
    returnStatus = r.status;
  };
  const placed = await post(stubApp(race as unknown as D1Database, CUSTOMER, (a) => a.route('/api/orders', orderRoutes)), '/api/orders', checkoutBody({ couponCode: t.code }));
  const body = await json(placed);
  await Promise.all(pending.splice(0));
  assert.equal(returnStatus, 200, 'the return wins: it was opened');
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM trade_in_requests WHERE id = ?', t.id)!.status, 'cancelled');
  // The order did not land, and the retired credit was not spent.
  assert.equal(placed.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'TRADE_IN_COUPON_MISMATCH');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ?', t.coupon), 0);
  assert.equal(ordersOf(raw), 0);
});

test('F2: a cancel that lands mid-checkout refuses the order; the device is free once, with one credit at most', async () => {
  const raw = seed({ deliveredDaysAgo: 40 });
  const t = await readyToPay(raw);
  const race = new RaceD1(raw);
  race.when = redeems;
  let cancelStatus = 0;
  race.hook = async () => {
    cancelStatus = (await post(customerApp(raw), `/api/trade-in/requests/${t.id}/cancel`, { reason: 'changed my mind' })).status;
  };
  const placed = await post(stubApp(race as unknown as D1Database, CUSTOMER, (a) => a.route('/api/orders', orderRoutes)), '/api/orders', checkoutBody({ couponCode: t.code }));
  const body = await json(placed);
  await Promise.all(pending.splice(0));
  assert.equal(cancelStatus, 200);
  assert.equal(placed.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'TRADE_IN_COUPON_MISMATCH');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND state = 'active'", t.coupon), 0);
  assert.equal(ordersOf(raw), 0);
});

test('F2: an order that spends the credit while a cancel is in flight refuses the cancel; the request keeps the device', async () => {
  const raw = seed({ deliveredDaysAgo: 40 });
  const t = await readyToPay(raw);
  const race = new RaceD1(raw);
  race.when = cancels;
  let orderStatus = 0;
  race.hook = async () => {
    const placed = await post(customerApp(raw), '/api/orders', checkoutBody({ couponCode: t.code }));
    orderStatus = placed.status;
  };
  const cancelApp = stubApp(race as unknown as D1Database, CUSTOMER, (a) => a.route('/api/trade-in', tradeInRoutes));
  const cancelled = await post(cancelApp, `/api/trade-in/requests/${t.id}/cancel`, { reason: 'changed my mind' });
  const body = await json(cancelled);
  await Promise.all(pending.splice(0));
  assert.equal(orderStatus, 200, 'the order spent the credit first');
  assert.equal(cancelled.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'TRADE_IN_ORDER_ACTIVE');
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM trade_in_requests WHERE id = ?', t.id)!.status, 'awaiting_payment');
  assert.ok(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_claims WHERE request_id = ?', t.id) > 0, 'the device is still held by the request');
  assert.equal(row<{ active: number }>(raw, 'SELECT active FROM coupons WHERE id = ?', t.coupon)!.active, 1);
  // The same device cannot open a second trade-in for a second credit.
  const again = await json(await post(customerApp(raw), '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 1, scope: 'whole' }));
  assert.notEqual(again.success, true, JSON.stringify(again));
});

const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };

test('F3: the coupon editor neither rewrites nor retires a trade-in credit — for any admin', async () => {
  const raw = seed({ deliveredDaysAgo: 20 });
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale,admin_scope)
              VALUES ('helper','Helper','helper@x.co','h','admin','2026-01-01T00:00:00.000Z','ar','assistant');`);
  const t = await readyToPay(raw);
  for (const who of [ASSISTANT, STAFF, OWNER]) {
    const app = stubApp(new LimitD1(raw) as unknown as D1Database, who, (a) => a.route('/api/admin', adminRoutes));
    const patched = await send(app, 'PATCH', `/api/admin/coupons/${t.coupon}`, {
      kind: 'fixed_iqd', value: 1_500_000, max_per_user: 1, max_global: 1, ends_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    });
    const pb = await json(patched);
    // Editing any promo code is the owner's (decision 3); the owner is refused for a trade-in credit.
    const expected = who === OWNER ? [409, 'TRADE_IN_COUPON_MANAGED'] : [403, who === ASSISTANT ? 'FINANCIAL_SCOPE_REQUIRED' : 'OWNER_REQUIRED'];
    assert.deepEqual([patched.status, pb.code], expected, `${who.id}: ${JSON.stringify(pb)}`);
    const retired = await send(app, 'DELETE', `/api/admin/coupons/${t.coupon}`);
    assert.equal(retired.status, 409, who.id);
    assert.equal((await json(retired)).code, 'TRADE_IN_COUPON_MANAGED');
  }
  const coupon = row<{ value: number; active: number }>(raw, 'SELECT value, active FROM coupons WHERE id = ?', t.coupon)!;
  assert.deepEqual([coupon.value, coupon.active], [t.credit, 1]);
});

test('F3: a credit coupon whose row says more than the request approved pays the approved figure', async () => {
  const raw = seed({ deliveredDaysAgo: 20 });
  const t = await readyToPay(raw);
  // However the row came to say it (an old editor, a hand edit), the request's figure decides.
  raw.prepare("UPDATE coupons SET value = 1500000, kind = 'fixed_iqd' WHERE id = ?").run(t.coupon);
  const placed = await post(customerApp(raw), '/api/orders', checkoutBody({ couponCode: t.code }));
  const body = await json(placed);
  await Promise.all(pending.splice(0));
  assert.equal(placed.status, 200, JSON.stringify(body));
  const redeemed = row<{ amount_iqd: number }>(raw, 'SELECT amount_iqd FROM coupon_redemptions WHERE coupon_id = ?', t.coupon)!.amount_iqd;
  assert.equal(redeemed, t.credit);
  assert.equal(row<{ credit_iqd: number }>(raw, 'SELECT credit_iqd FROM trade_in_requests WHERE id = ?', t.id)!.credit_iqd, t.credit);
});
