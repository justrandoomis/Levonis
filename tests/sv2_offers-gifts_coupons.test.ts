/**
 * Services V2 survey — offers & gifts COUPONS, reproduced (ported from the
 * survey worktree onto the default branch for stage S-P0a, coupons). Each
 * test states the behaviour the house rules and 0077's own comments promise;
 * all three failed on the base and pass with the coupon resolver wired into
 * the checkout and the cart. LOCAL ONLY.
 *
 *   (C1, a cancelled order giving its coupon use back, is S-P1: it needs the
 *       release trigger and lands with migration 0189.)
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
import { row } from './fixtures/app';
import { apps, giftWorld, json, paidLine, placeOrder, post } from './fixtures/giftWorld';

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
