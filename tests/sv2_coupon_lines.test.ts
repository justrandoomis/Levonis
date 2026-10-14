/**
 * SERVICES V2 S-P0a — THE COUPON IS ALLOCATED TO THE LINES IT NAMES, AND EVERY
 * READER SUBTRACTS IT EXACTLY ONCE (offers B2/B3/B4/B6/B7, plan correction 2).
 *
 * The checkout now runs the coupon resolver (`allocateCoupon`) and freezes
 * the goods part of a code on `order_items.coupon_discount_iqd`. In the same
 * change every reader switched: finance takes the order coupon's RESIDUAL,
 * a refund and a price-protection credit read the line, and the trade-in
 * paid net reads the line. These tests pin each of them on the real routes:
 *
 *   L1  a percentage is taken off the goods, never off the delivery fee
 *   L2  the per-line figures add up exactly to the goods part, and the order
 *       total to subtotal + delivery − coupon
 *   L3  a fixed amount is one amount, spread across the lines by value
 *   L4  a delivery code at a store pickup has nothing to reduce: refused, and
 *       its use is not spent (plan §1.1 ⑫)
 *   L5  a released redemption gave its use back (B7: the advisory counts read
 *       the trigger's `state = 'active'`)
 *   L6  the refusal tells a customer the minimum of THEIR live code, and says
 *       nothing about an inactive one (B4)
 *   L7  X2 — one order, a line-scoped code and points: the refund, the paid net
 *       (protection and trade-in) and finance each subtract the discount once,
 *       and Σ paid + delivery part re-adds to the order total
 *   L8  the cart's estimate runs the same resolver: a scoped code estimates
 *       the scoped amount
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, all, count, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { BOSS, BUYER, giftWorld, mountGifts, orderBody, paidLine, placeOrder, apps, type J } from './fixtures/giftWorld';
import { returnRoutes } from '../worker/routes/returns';
import { validateCoupon } from '../worker/lib/membershipOps';
import { loadOrdersPaidNet } from '../worker/lib/paidNet';
import { paidNetLines } from '../packages/pricing/src/paidNet';
import type { Env } from '../worker/lib/types';

const coupon = (raw: DatabaseSync, sql: string) => raw.exec(`INSERT INTO coupons ${sql}`);
const snapshotOf = (raw: DatabaseSync, orderId: string) =>
  JSON.parse(String(row<J>(raw, 'SELECT coupon_snapshot FROM orders WHERE id = ?', orderId)!.coupon_snapshot)) as J;
const lineDiscounts = (raw: DatabaseSync, orderId: string) =>
  all<{ product_id: string; qty: number; line_total_iqd: number; coupon_discount_iqd: number }>(
    raw,
    'SELECT product_id, qty, line_total_iqd, coupon_discount_iqd FROM order_items WHERE order_id = ? ORDER BY product_id',
    orderId
  );

test('L1: a 10% code takes 10% of the goods and nothing of the delivery fee', async () => {
  const raw = giftWorld();
  coupon(raw, `(id, code, kind, value, min_total_iqd, max_per_user, active) VALUES ('c10', 'TEN', 'percent', 10, 0, 5, 1)`);
  const a = apps(raw);
  paidLine(raw, 'ci_1', 'p_plain', { qty: 1 });
  const order = await placeOrder(a.buyer, { couponCode: 'TEN' });
  const o = row<J>(raw, 'SELECT subtotal_iqd, shipping_iqd, total_iqd FROM orders WHERE id = ?', order.id)!;
  assert.ok(Number(o.shipping_iqd) > 0, 'the world charges delivery');
  const snap = snapshotOf(raw, order.id);
  assert.equal(snap.discount_iqd, 1_500, '10% of 15,000 of goods — the 5,000 delivery is not discounted');
  assert.equal(snap.merchandise_iqd, 1_500);
  assert.equal(snap.delivery_iqd, 0);
  assert.equal(Number(o.total_iqd), 15_000 + Number(o.shipping_iqd) - 1_500);
  assert.deepEqual(lineDiscounts(raw, order.id).map((l) => l.coupon_discount_iqd), [1_500]);
});

test('L2: the per-line discounts add up exactly to the goods part, and the total re-adds', async () => {
  const raw = giftWorld();
  coupon(raw, `(id, code, kind, value, min_total_iqd, max_per_user, active) VALUES ('c7', 'SEVEN', 'percent', 7, 0, 5, 1)`);
  const a = apps(raw);
  paidLine(raw, 'ci_a', 'p_plain', { qty: 2 }); // 2 × 15,000
  paidLine(raw, 'ci_b', 'p_other', { optionValueIds: ['o_x'], qty: 1 }); // 10,000
  const order = await placeOrder(a.buyer, { couponCode: 'SEVEN' });
  const snap = snapshotOf(raw, order.id);
  const lines = lineDiscounts(raw, order.id);
  assert.deepEqual(
    lines.map((l) => [l.product_id, l.coupon_discount_iqd]),
    [['p_other', 700], ['p_plain', 2_100]],
    '7% per unit: 1,050 × 2 on the cleaner, 700 on the other'
  );
  assert.equal(lines.reduce((s, l) => s + l.coupon_discount_iqd, 0), snap.merchandise_iqd);
  assert.equal(snap.discount_iqd, snap.merchandise_iqd + snap.delivery_iqd);
  const o = row<J>(raw, 'SELECT subtotal_iqd, shipping_iqd, total_iqd FROM orders WHERE id = ?', order.id)!;
  assert.equal(Number(o.total_iqd), Number(o.subtotal_iqd) + Number(o.shipping_iqd) - snap.discount_iqd);
  // The redemption records what the code took.
  assert.equal(row<J>(raw, 'SELECT amount_iqd FROM coupon_redemptions WHERE order_id = ?', order.id)!.amount_iqd, snap.discount_iqd);
});

test('L3: a fixed amount is ONE amount, spread across the lines by their value', async () => {
  const raw = giftWorld();
  coupon(raw, `(id, code, kind, value, min_total_iqd, max_per_user, active) VALUES ('c5k', 'FIVEK', 'fixed_iqd', 5000, 0, 5, 1)`);
  const a = apps(raw);
  paidLine(raw, 'ci_a', 'p_plain', { qty: 2 }); // 30,000
  paidLine(raw, 'ci_b', 'p_other', { optionValueIds: ['o_x'], qty: 1 }); // 10,000
  const order = await placeOrder(a.buyer, { couponCode: 'FIVEK' });
  assert.deepEqual(
    lineDiscounts(raw, order.id).map((l) => [l.product_id, l.coupon_discount_iqd]),
    [['p_other', 1_250], ['p_plain', 3_750]]
  );
  assert.equal(snapshotOf(raw, order.id).discount_iqd, 5_000);
});

test('L4: a delivery code at a store pickup has nothing to reduce — refused, and its use is not spent', async () => {
  const raw = giftWorld();
  coupon(raw, `(id, code, kind, value, min_total_iqd, max_per_user, active, applies_to)
               VALUES ('cship', 'SHIPFREE', 'percent', 100, 0, 1, 1, 'delivery')`);
  const a = apps(raw);
  paidLine(raw, 'ci_1', 'p_plain', { qty: 1 });
  const res = await post(a.buyer, '/api/orders', orderBody({ couponCode: 'SHIPFREE', deliveryMethodId: 'pickup' }));
  const out = await json(res);
  assert.equal(res.status, 400, JSON.stringify(out));
  assert.equal(out.code, 'NO_DISCOUNT');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = 'cship'"), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
});

test('L5: a released redemption gave its use back — the advisory counts read only active rows (B7)', async () => {
  const raw = giftWorld();
  coupon(raw, `(id, code, kind, value, min_total_iqd, max_per_user, max_global, active)
               VALUES ('conce', 'ONCE', 'fixed_iqd', 1000, 0, 1, 1, 1)`);
  const a = apps(raw);
  paidLine(raw, 'ci_1', 'p_plain', { qty: 1 });
  await placeOrder(a.buyer, { couponCode: 'ONCE' });
  const env = { DB: asD1(raw) } as unknown as Env;
  // Both limits are spent (one use per customer, one in all) — the global count is asked first.
  assert.equal((await validateCoupon(env, 'buyer', 'ONCE', 15_000)).reason, 'GLOBAL_LIMIT_REACHED');
  // The release itself lands with S-P1's trigger; the state it writes is 0077's.
  raw.exec("UPDATE coupon_redemptions SET state = 'released', released_at = '2026-10-14T00:00:00.000Z' WHERE coupon_id = 'conce'");
  const again = await validateCoupon(env, 'buyer', 'ONCE', 15_000);
  assert.equal(again.ok, true, `a released use still counted: ${again.reason}`);
});

test('L6: a refusal names the minimum of the customer\'s own live code, and nothing for an inactive one (B4)', async () => {
  const raw = giftWorld();
  coupon(raw, `(id, code, kind, value, min_total_iqd, max_per_user, active) VALUES ('cbig', 'BIGSPEND', 'fixed_iqd', 5000, 100000, 1, 1)`);
  coupon(raw, `(id, code, kind, value, min_total_iqd, max_per_user, active) VALUES ('cold', 'OLDCODE', 'fixed_iqd', 5000, 100000, 1, 0)`);
  const a = apps(raw);
  paidLine(raw, 'ci_1', 'p_plain', { qty: 1 });
  const mine = await json(await post(a.buyer, '/api/cart/coupon-check', { code: 'BIGSPEND' }));
  assert.equal(mine.valid, false);
  assert.equal(mine.reason, 'MIN_TOTAL_NOT_MET');
  assert.equal(mine.min_total_iqd, 100_000, 'the customer is told how far they are');
  const old = await json(await post(a.buyer, '/api/cart/coupon-check', { code: 'OLDCODE' }));
  assert.equal(old.min_total_iqd, null);
  assert.equal(old.tier_required, null);
});

test('L7 (X2): a line-scoped code and points — refund, paid net and finance each subtract it once', async () => {
  const raw = giftWorld();
  // 20% off ONE unit of p_plain — a line discount only that line carries.
  coupon(raw, `(id, code, kind, value, min_total_iqd, max_per_user, active, scope, product_id, max_quantity, cap_scope)
               VALUES ('cline', 'ONEPLAIN', 'percent', 20, 0, 1, 1, 'product', 'p_plain', 1, 'per_unit')`);
  raw.exec("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('pts_b','buyer','deposit','POINT',2000,'approved')");
  const a = apps(raw);
  paidLine(raw, 'ci_a', 'p_plain', { qty: 2 }); // 30,000
  paidLine(raw, 'ci_b', 'p_other', { optionValueIds: ['o_x'], qty: 1 }); // 10,000
  const order = await placeOrder(a.buyer, { couponCode: 'ONEPLAIN', usePoints: true });
  const o = row<J>(raw, 'SELECT * FROM orders WHERE id = ?', order.id)!;
  const snap = snapshotOf(raw, order.id);
  assert.equal(snap.discount_iqd, 3_000, '20% of ONE 15,000 unit');
  assert.equal(Number(o.points_discount_iqd), 2_000);
  const items = all<J>(raw, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY product_id', order.id);
  const plain = items.find((i) => i.product_id === 'p_plain')!;
  const other = items.find((i) => i.product_id === 'p_other')!;
  assert.equal(Number(plain.coupon_discount_iqd), 3_000);
  assert.equal(Number(other.coupon_discount_iqd), 0, 'the code never touched the other product');

  // PAID NET (price protection and trade-in read this): the line discount
  // comes off its own line; only the points are shared (no residual).
  const facts = (await loadOrdersPaidNet(asD1(raw), [order.id])).get(order.id)!;
  assert.equal(facts.order.order_coupon_iqd, 3_000);
  const paid = paidNetLines(facts.order, facts.lines);
  const byId = new Map(facts.lines.map((l, i) => [l.id, paid[i]]));
  const base = Number(o.subtotal_iqd) + Number(o.shipping_iqd);
  const plainPoints = Math.floor((2_000 * 30_000) / base);
  const otherPoints = Math.floor((2_000 * 10_000) / base);
  assert.equal(byId.get(String(plain.id)), 30_000 - 3_000 - plainPoints);
  assert.equal(byId.get(String(other.id)), 10_000 - otherPoints);
  // Every dinar of the order accounted for: the lines' paid nets, plus the
  // delivery less the points' share that fell on it, ARE the order total —
  // so no discount was subtracted twice, or left out.
  const paidSum = paid.reduce((s, v) => s + v, 0);
  const pointsOnDelivery = 2_000 - plainPoints - otherPoints;
  assert.equal(paidSum + Number(o.shipping_iqd) - pointsOnDelivery, Number(o.total_iqd));

  // FINANCE: the order-level residual is 0 — the whole code sits on the line.
  const residual = row<{ r: number }>(
    raw,
    `SELECT MAX(0, json_extract(o.coupon_snapshot, '$.discount_iqd')
                  - (SELECT SUM(i.coupon_discount_iqd) FROM order_items i WHERE i.order_id = o.id)) AS r
       FROM orders o WHERE o.id = ?`,
    order.id
  )!.r;
  assert.equal(residual, 0);

  // THE REFUND of the discounted line gives back what was paid for it: the
  // line less its OWN discount and its points share — not the gross, and not
  // the discount twice.
  raw.prepare("UPDATE orders SET status='delivered', stage='delivered', delivered_at=? WHERE id=?").run(new Date().toISOString(), order.id);
  const db = asD1(raw);
  const withReturns = (user: StubUser) => stubApp(db, user, (app) => { mountGifts(app); app.route('/api/returns', returnRoutes); });
  const opened = await json(await post(withReturns(BUYER), '/api/returns', { orderItemId: plain.id, qty: 2, reason: 'defective' }));
  assert.equal(opened.success, true, JSON.stringify(opened));
  const caseId = String(opened.case?.id ?? opened.cases?.[0]?.id);
  const admin = withReturns(BOSS);
  for (const to of ['assessment', 'approved', 'received', 'inspected']) {
    const step = await json(await post(admin, `/api/returns/admin/${caseId}/transition`, { to }));
    assert.equal(step.success, true, `${to}: ${JSON.stringify(step)}`);
  }
  const resolved = await json(await post(admin, `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'refund' }));
  assert.equal(resolved.success, true, JSON.stringify(resolved));
  assert.equal(Number(resolved.refund.amount_iqd), 30_000 - 3_000 - plainPoints);
});

test('L8: the cart estimate runs the same resolver — a scoped code estimates only what it names', async () => {
  const raw = giftWorld();
  coupon(raw, `(id, code, kind, value, min_total_iqd, max_per_user, active, scope, product_id)
               VALUES ('cscope', 'OTHER10', 'percent', 10, 0, 1, 1, 'product', 'p_other')`);
  const a = apps(raw);
  paidLine(raw, 'ci_a', 'p_plain', { qty: 2 });
  paidLine(raw, 'ci_b', 'p_other', { optionValueIds: ['o_x'], qty: 1 });
  const check = await json(await post(a.buyer, '/api/cart/coupon-check', { code: 'OTHER10' }));
  assert.equal(check.valid, true, JSON.stringify(check));
  assert.equal(check.estimated_discount_iqd, 1_000, '10% of the 10,000 line it names, not of the 40,000 cart');
});

test('L9: an older coupon row reads as an unscoped goods coupon; an unknown scope names nothing', async () => {
  const { couponRuleOf, wholeOrderTarget } = await import('../worker/lib/couponLines');
  const { allocateCoupon } = await import('../packages/pricing/src/coupons');
  // A row with only the 0002 columns — what every coupon was before 0077.
  const old = couponRuleOf({ id: 'c', code: 'OLD', kind: 'percent', value: 10 });
  assert.equal(old.scope, 'global');
  assert.equal(old.applies_to, 'merchandise');
  assert.equal(old.cap_scope, 'per_order');
  assert.equal(old.stacks, true);
  const t = wholeOrderTarget(40_000);
  assert.equal(allocateCoupon(old, t.lines, t.ctx).total_iqd, 4_000, 'exactly what the old checkout took off 40,000 of goods');
  // A percentage above 100 cannot take more than the goods.
  assert.equal(couponRuleOf({ kind: 'percent', value: 250 }).value, 100);
  // A scope no screen can write fails closed.
  const odd = couponRuleOf({ kind: 'fixed_iqd', value: 1000, scope: 'warehouse' });
  assert.equal(allocateCoupon(odd, t.lines, t.ctx).total_iqd, 0);
});
