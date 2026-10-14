/**
 * Services V2 survey — offers & gifts COUPONS, reproduced (ported from the
 * survey worktree onto the default branch for stage S-P0a, coupons). Each
 * test states the behaviour the house rules and 0077's own comments promise;
 * all three failed on the base and pass with the coupon resolver wired into
 * the checkout and the cart. LOCAL ONLY.
 *
 *   C1  a cancelled order gives its coupon use back (S-P1, migration 0191's
 *       trg_orders_coupon_released, DECISIONS row 237) — through every door
 *       that cancels: the customer, the admin's status door, the stage door
 *       and the expiry sweep. A delivered order that is then cancelled keeps
 *       its use; re-opening a cancelled order takes the use back inside the
 *       limits, or is refused (ORDER_REOPEN_COUPON_SPENT) and stays cancelled.
 *   C2  the 0077 targeting columns are stored but the checkout's validateCoupon
 *       ignores them: a product-scoped, one-unit, 10% coupon takes 10% of the
 *       whole order (other products and the delivery fee included)
 *   C3  a delivery-only coupon (applies_to='delivery') is taken off the goods
 *   C4  /api/cart/coupon-check tells a stranger's personal code (a trade-in
 *       credit) apart from an unknown one — validateCoupon's «answered exactly
 *       as an unknown code» promise is undone by the follow-up SELECT
 *
 * Run: node --import tsx --test tests/sv2_offers-gifts_coupons.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, row } from './fixtures/app';
import { validateCoupon } from '../worker/lib/membershipOps';
import { sweepExpiredOrders } from '../worker/lib/orderExpirySweep';
import { apps, get, giftWorld, json, orderBody, paidLine, patch, placeOrder, post, send } from './fixtures/giftWorld';
import type { Env } from '../worker/lib/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

test('C2: a product-scoped, one-unit 10% coupon discounts one unit of that product only (it takes 10% of everything today)', async () => {
  const raw = giftWorld();
  // «10% off ONE unit of p_plain» — written with the 0077 vocabulary the admin
  // screen cannot set and the checkout does not read.
  raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active,
                                 scope, product_id, max_quantity, cap_scope, applies_to, stacks)
            VALUES ('cpn_unit', 'ONEUNIT10', 'percent', 10, 0, 1, 1,
                    'product', 'p_plain', 1, 'per_unit', 'merchandise', 0)`);
  const a = apps(raw);
  paidLine(raw, 'ci_plain', 'p_plain', { qty: 2 }); // 2 × 15,000
  paidLine(raw, 'ci_other', 'p_other', { optionValueIds: ['o_x'], qty: 1 }); // 10,000, not named by the coupon
  const order = await placeOrder(a.buyer, { couponCode: 'ONEUNIT10' });
  const o = row<J>(raw, 'SELECT coupon_snapshot, shipping_iqd FROM orders WHERE id = ?', order.id)!;
  const discount = Number(JSON.parse(String(o.coupon_snapshot)).discount_iqd);
  assert.equal(discount, 1500, `10% of ONE 15,000 unit is 1,500; the checkout took ${discount} (order goods 40,000 + delivery ${o.shipping_iqd})`);
});

test('C3: a delivery-only coupon reduces the delivery fee, never the goods (it reduces the goods today)', async () => {
  const raw = giftWorld();
  raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active, applies_to)
            VALUES ('cpn_ship', 'SHIPFREE', 'percent', 100, 0, 1, 1, 'delivery')`);
  const a = apps(raw);
  paidLine(raw, 'ci_plain', 'p_plain', { qty: 1 });
  const order = await placeOrder(a.buyer, { couponCode: 'SHIPFREE' });
  const o = row<J>(raw, 'SELECT coupon_snapshot, shipping_iqd, subtotal_iqd, total_iqd FROM orders WHERE id = ?', order.id)!;
  const discount = Number(JSON.parse(String(o.coupon_snapshot)).discount_iqd);
  assert.ok(Number(o.shipping_iqd) > 0, 'the world charges delivery');
  assert.equal(discount, Number(o.shipping_iqd), `a 100% delivery coupon should take exactly the delivery (${o.shipping_iqd}); it took ${discount}`);
});

test('C4: someone else\'s personal coupon answers exactly like an unknown code at /api/cart/coupon-check (it leaks existence today)', async () => {
  const raw = giftWorld();
  // A personal coupon (the trade-in credit shape, 0143) that belongs to «other».
  raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, max_global, active, assigned_user_id)
            VALUES ('cpn_mine', 'TIABCDEFGHJK', 'fixed_iqd', 300000, 0, 1, 1, 1, 'other')`);
  const a = apps(raw);
  paidLine(raw, 'ci_plain', 'p_plain', { qty: 1 });
  const theirs = (await json(await post(a.buyer, '/api/cart/coupon-check', { code: 'TIABCDEFGHJK' }))) as J;
  const unknown = (await json(await post(a.buyer, '/api/cart/coupon-check', { code: 'TIZZZZZZZZZZ' }))) as J;
  assert.equal(theirs.reason, unknown.reason, 'same reason');
  assert.deepEqual(
    { min_total_iqd: theirs.min_total_iqd, tier_required: theirs.tier_required },
    { min_total_iqd: unknown.min_total_iqd, tier_required: unknown.tier_required },
    'a stranger\'s personal code is distinguishable from a code that does not exist'
  );
});

// ===================================================================== C1 (S-P1)

/** A single-use promo code, one order that spent it, and the apps. */
async function spentOnce(code = 'ONCE5K', extra = '') {
  const raw = giftWorld();
  raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active${extra ? ', max_global' : ''})
            VALUES ('cpn_once', '${code}', 'fixed_iqd', 5000, 0, 1, 1${extra ? `, ${extra}` : ''})`);
  const a = apps(raw);
  paidLine(raw, 'ci_1', 'p_plain', { qty: 1 });
  const order = await placeOrder(a.buyer, { couponCode: code });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = 'cpn_once' AND state = 'active'"), 1);
  return { raw, a, orderId: order.id as string };
}
const useOf = (raw: DatabaseSync, orderId: string) =>
  row<J>(raw, 'SELECT state, released_at FROM coupon_redemptions WHERE order_id = ?', orderId)!;
const statusOf = (raw: DatabaseSync, orderId: string) => row<J>(raw, 'SELECT status FROM orders WHERE id = ?', orderId)!.status as string;
const liveUses = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = 'cpn_once' AND state = 'active'");

test('C1: cancelling an order gives its single-use coupon back', async () => {
  const { raw, a, orderId } = await spentOnce();
  const cancelled = (await json(await post(a.buyer, `/api/orders/${orderId}/cancel`, {}))) as J;
  assert.equal(cancelled.success, true, JSON.stringify(cancelled));
  assert.equal(statusOf(raw, orderId), 'cancelled');

  // The redemption reads released (0077: «A REDEMPTION MUST BE RELEASABLE»)…
  const red = useOf(raw, orderId);
  assert.equal(red.state, 'released', 'the cancelled order still holds its coupon use');
  assert.ok(red.released_at, 'the release is stamped');

  // …and the customer, who received nothing, can use the code again — once.
  const env = { DB: asD1(raw) } as unknown as Env;
  const again = await validateCoupon(env, 'buyer', 'ONCE5K', 15000);
  assert.equal(again.ok, true, `refused after a cancelled order: ${again.reason}`);
  paidLine(raw, 'ci_2', 'p_plain', { qty: 1 });
  await placeOrder(a.buyer, { couponCode: 'ONCE5K' });
  assert.equal(liveUses(raw), 1);
  paidLine(raw, 'ci_3', 'p_plain', { qty: 1 });
  const third = await post(a.buyer, '/api/orders', orderBody({ couponCode: 'ONCE5K' }));
  assert.equal(third.status, 400, 'the use is spent again');
  assert.equal(((await json(third)) as J).code, 'PER_USER_LIMIT_REACHED');
});

test('C1: every door that cancels gives the use back — the admin status door, the stage door, the expiry sweep', async () => {
  {
    const { raw, a, orderId } = await spentOnce();
    const res = await patch(a.admin, `/api/admin/orders/${orderId}`, { status: 'cancelled' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(useOf(raw, orderId).state, 'released', 'admin status door');
  }
  {
    const { raw, a, orderId } = await spentOnce();
    const res = await patch(a.admin, `/api/admin/orders/${orderId}/stage`, { stage: 'cancelled' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(statusOf(raw, orderId), 'cancelled');
    assert.equal(useOf(raw, orderId).state, 'released', 'stage door');
  }
  {
    const { raw, orderId } = await spentOnce();
    raw.prepare("UPDATE orders SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(orderId);
    const report = await sweepExpiredOrders({ DB: asD1(raw) } as unknown as Env, { enabled: true, ttl_minutes: 60, batch_limit: 100 }, new Date().toISOString());
    assert.equal(report.cancelled, 1, JSON.stringify(report));
    assert.equal(statusOf(raw, orderId), 'cancelled');
    assert.equal(useOf(raw, orderId).state, 'released', 'expiry sweep');
  }
});

test('C1: a delivered order that is then cancelled keeps its use; a delivery undone first releases normally', async () => {
  {
    const { raw, orderId } = await spentOnce();
    raw.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(orderId);
    raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
    assert.equal(useOf(raw, orderId).state, 'active', 'it was received: the use stays spent');
  }
  {
    const { raw, a, orderId } = await spentOnce();
    raw.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(orderId);
    assert.equal((await patch(a.admin, `/api/admin/orders/${orderId}`, { status: 'shipped' })).status, 200);
    const res = await patch(a.admin, `/api/admin/orders/${orderId}`, { status: 'cancelled' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(useOf(raw, orderId).state, 'released');
  }
});

test('C1: re-opening a cancelled order takes its use back — through both admin doors', async () => {
  {
    const { raw, a, orderId } = await spentOnce();
    assert.equal((await patch(a.admin, `/api/admin/orders/${orderId}`, { status: 'cancelled' })).status, 200);
    assert.equal(useOf(raw, orderId).state, 'released');
    const res = await patch(a.admin, `/api/admin/orders/${orderId}`, { status: 'pending' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual({ ...useOf(raw, orderId) }, { state: 'active', released_at: null }, 'status door');
  }
  {
    const { raw, a, orderId } = await spentOnce();
    assert.equal((await patch(a.admin, `/api/admin/orders/${orderId}/stage`, { stage: 'cancelled' })).status, 200);
    const res = await patch(a.admin, `/api/admin/orders/${orderId}/stage`, { stage: 'received' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(statusOf(raw, orderId), 'pending');
    assert.equal(useOf(raw, orderId).state, 'active', 'stage door');
  }
});

/** Cancelled by the customer (re-opened later through the status door), or through the stage door. */
const cancelBy = (a: ReturnType<typeof apps>, door: 'status' | 'stage', orderId: string) =>
  door === 'status' ? post(a.buyer, `/api/orders/${orderId}/cancel`, {}) : patch(a.admin, `/api/admin/orders/${orderId}/stage`, { stage: 'cancelled' });

test('C1: a re-open whose use was spent again, or whose code was switched off, is refused and the order stays cancelled', async () => {
  for (const door of ['status', 'stage'] as const) {
    // Spent again: the code bought a second order while the first was cancelled.
    const { raw, a, orderId } = await spentOnce();
    assert.equal((await cancelBy(a, door, orderId)).status, 200);
    paidLine(raw, `ci_again_${door}`, 'p_plain', { qty: 1 });
    await placeOrder(a.buyer, { couponCode: 'ONCE5K' });
    const reopen = door === 'status'
      ? await patch(a.admin, `/api/admin/orders/${orderId}`, { status: 'pending' })
      : await patch(a.admin, `/api/admin/orders/${orderId}/stage`, { stage: 'received' });
    const body = (await json(reopen)) as J;
    assert.equal(reopen.status, 409, `${door}: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'ORDER_REOPEN_COUPON_SPENT');
    assert.equal(statusOf(raw, orderId), 'cancelled');
    assert.equal(useOf(raw, orderId).state, 'released');
    assert.equal(liveUses(raw), 1, 'one live use: the second order\'s');
  }
  for (const door of ['status', 'stage'] as const) {
    // Switched off: the admin deactivated the code after the cancellation.
    const { raw, a, orderId } = await spentOnce();
    assert.equal((await cancelBy(a, door, orderId)).status, 200);
    assert.equal((await send(a.admin, 'DELETE', '/api/admin/coupons/cpn_once')).status, 200);
    const reopen = door === 'status'
      ? await patch(a.admin, `/api/admin/orders/${orderId}`, { status: 'pending' })
      : await patch(a.admin, `/api/admin/orders/${orderId}/stage`, { stage: 'received' });
    const body = (await json(reopen)) as J;
    assert.equal(reopen.status, 409, `${door}: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'ORDER_REOPEN_COUPON_SPENT');
    assert.equal(statusOf(raw, orderId), 'cancelled');
    assert.equal(liveUses(raw), 0);
  }
});

test('C1: the admin coupon list counts live uses only', async () => {
  const { raw, a, orderId } = await spentOnce();
  const used = async () => (((await json(await get(a.admin, '/api/admin/coupons'))) as J).coupons as J[]).find((c) => c.id === 'cpn_once')!.redeemed;
  assert.equal(await used(), 1);
  assert.equal((await post(a.buyer, `/api/orders/${orderId}/cancel`, {})).status, 200);
  assert.equal(await used(), 0, 'a released use is not «used»');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = 'cpn_once'"), 1, 'the row itself stays');
});
