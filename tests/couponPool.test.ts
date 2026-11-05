/**
 * SPENDING SEVERAL REWARD COUPONS ON ONE ORDER (owner, 2026-11-05; DECISIONS row
 * 295): `allocateCouponPool`, the one piece of arithmetic behind the cart, the
 * quote and the order.
 *
 *   «the coupon is for 1 pic, 1 free shipping 5000, 2 coupon mean shipping
 *    discount 10000 and 2 pic of filament»
 *
 * Run: node --import tsx --test tests/couponPool.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateCouponPool, type CouponLine, type CouponRule, type PoolCoupon } from '@levonis/pricing/coupons';
import { couponRuleOf } from '../worker/lib/couponLines';

const line = (id: string, product: string, unit: number, qty = 1, over: Partial<CouponLine> = {}): CouponLine => ({
  line_id: id,
  product_id: product,
  option_value_ids: [],
  color_id: '',
  brand_id: null,
  category_id: null,
  sub_category_id: null,
  ancestry: null,
  bundle_product_id: null,
  fulfillment_type: 'direct_sale',
  transport_method: '',
  qty,
  unit_goods_iqd: unit,
  already_discounted: false,
  ...over,
});

const ship = (id: string, over: Record<string, unknown> = {}): PoolCoupon => ({
  coupon_id: id,
  code: id.toUpperCase(),
  min_total_iqd: Number(over.min_total_iqd ?? 100_000),
  rule: couponRuleOf({ kind: 'fixed_iqd', value: 5_000, scope: 'global', applies_to: 'delivery', stacks: 1, ...over }),
});

const filament = (id: string, over: Record<string, unknown> = {}): PoolCoupon => ({
  coupon_id: id,
  code: id.toUpperCase(),
  min_total_iqd: 0,
  rule: couponRuleOf({ kind: 'percent', value: 15, max_discount_iqd: 25_000, cap_scope: 'per_order', max_quantity: 1, scope: 'products', product_ids: '["p_pla","p_petg"]', applies_to: 'merchandise', stacks: 0, ...over }),
});

const ctx = (fee: number) => ({ delivery_method: 'standard', delivery_iqd: fee });
const PRINTER = line('printer', 'p_printer', 800_000);

test('the owner’s example: two coupons of each kind take 10,000 off the delivery and 15% off two pieces of filament', () => {
  const out = allocateCouponPool([filament('f1'), ship('s1'), filament('f2'), ship('s2')], [PRINTER, line('pla', 'p_pla', 30_000, 3)], ctx(12_000));
  assert.equal(out.merchandise_iqd, 4_500 + 4_500, 'two pieces, not three');
  assert.equal(out.delivery_iqd, 10_000);
  assert.equal(out.total_iqd, 19_000);
  assert.deepEqual(out.lines, [{ line_id: 'pla', amount_iqd: 9_000 }]);
  assert.deepEqual(out.used.map((u) => [u.coupon_id, u.total_iqd]), [['f1', 4_500], ['f2', 4_500], ['s1', 5_000], ['s2', 5_000]]);
});

test('every coupon spends only while it has something to take, and what is not spent is not touched', () => {
  const three = allocateCouponPool([filament('f1'), filament('f2'), filament('f3')], [line('pla', 'p_pla', 30_000, 2)], ctx(0));
  assert.equal(three.merchandise_iqd, 9_000, 'two pieces, two coupons');
  assert.deepEqual(three.used.map((u) => u.coupon_id), ['f1', 'f2'], 'the third is still the customer’s');

  const fee = allocateCouponPool([ship('s1'), ship('s2')], [PRINTER], ctx(3_000));
  assert.equal(fee.delivery_iqd, 3_000, 'never more than the fee');
  assert.deepEqual(fee.used.map((u) => u.coupon_id), ['s1'], 'a fee one coupon covers spends one');

  const free = allocateCouponPool([ship('s1')], [PRINTER], ctx(0));
  assert.equal(free.total_iqd, 0);
  assert.deepEqual(free.used, [], 'a delivery that came out free spends nothing (row 227 (5))');
});

test('one coupon goes on the dearest piece it names, and never on a piece another coupon took', () => {
  const lines = [line('cheap', 'p_pla', 10_000, 1), line('dear', 'p_petg', 40_000, 1)];
  const one = allocateCouponPool([filament('f1')], lines, ctx(0));
  assert.deepEqual(one.lines, [{ line_id: 'dear', amount_iqd: 6_000 }], 'the customer’s coupon is worth the most there');

  const two = allocateCouponPool([filament('f1'), filament('f2')], lines, ctx(0));
  assert.deepEqual(two.lines, [{ line_id: 'dear', amount_iqd: 6_000 }, { line_id: 'cheap', amount_iqd: 1_500 }]);
  const three = allocateCouponPool([filament('f1'), filament('f2'), filament('f3')], lines, ctx(0));
  assert.equal(three.merchandise_iqd, 7_500, 'two pieces cannot take three coupons');
  assert.equal(three.used.length, 2);
});

test('the sums hold: the per-line figures are the goods part, and each coupon’s part adds up to the discount', () => {
  const out = allocateCouponPool(
    [filament('f1'), ship('s1'), filament('f2', { value: 20, max_discount_iqd: 1_000 }), ship('s2', { value: 1_500 })],
    [PRINTER, line('pla', 'p_pla', 33_333, 2), line('petg', 'p_petg', 47_777, 1)],
    ctx(5_500)
  );
  assert.equal(out.lines.reduce((s, l) => s + l.amount_iqd, 0), out.merchandise_iqd);
  assert.equal(out.used.reduce((s, u) => s + u.total_iqd, 0), out.total_iqd);
  assert.equal(out.used.reduce((s, u) => s + u.merchandise_iqd, 0), out.merchandise_iqd);
  assert.equal(out.used.reduce((s, u) => s + u.delivery_iqd, 0), out.delivery_iqd);
  assert.equal(out.delivery_iqd, 5_500, 'the first coupon’s 5,000 and 500 of the second');
  assert.equal(out.merchandise_iqd, Math.floor((47_777 * 15) / 100) + 1_000, 'each coupon at its own percentage and ceiling');
});

test('a delivery coupon’s minimum is tested on the goods after every discount, before the delivery', () => {
  const lines = [line('other', 'p_tool', 75_000), line('pla', 'p_pla', 30_000)];
  const alone = allocateCouponPool([ship('s1')], lines, ctx(5_000));
  assert.equal(alone.goods_after_discount_iqd, 105_000);
  assert.equal(alone.delivery_iqd, 5_000, '105,000 of goods clears 100,000');

  const withFilament = allocateCouponPool([filament('f1'), ship('s1')], lines, ctx(5_000));
  assert.equal(withFilament.goods_after_discount_iqd, 100_500, 'still clear: 105,000 less 4,500');
  assert.equal(withFilament.delivery_iqd, 5_000);

  const short = allocateCouponPool([filament('f1'), filament('f2'), ship('s1')], [line('pla', 'p_pla', 58_000, 2)], ctx(5_000));
  assert.equal(short.goods_after_discount_iqd, 98_600, '116,000 less two filament coupons');
  assert.equal(short.delivery_iqd, 0, 'row 223 #4: «بعد كل الخصومات»');
  assert.equal(short.blocked_min_total_iqd, 100_000, 'and the answer says what it needed');
  assert.equal(short.total_iqd, short.merchandise_iqd, 'the filament coupons still spend');
  assert.deepEqual(short.used.map((u) => u.coupon_id), ['f1', 'f2']);

  assert.equal(allocateCouponPool([ship('s1')], [line('t', 'p_tool', 99_999)], ctx(5_000)).delivery_iqd, 0, 'a fee never lifts an order over its own threshold');
  assert.equal(allocateCouponPool([ship('s1')], [line('t', 'p_tool', 100_000)], ctx(5_000)).delivery_iqd, 5_000, 'the minimum itself clears');
});

test('in the cart, before a delivery exists, a delivery coupon is valid and waits, worth nothing yet', () => {
  const out = allocateCouponPool([ship('s1')], [PRINTER], { delivery_method: null, delivery_iqd: 0 }, { deliveryPending: true });
  assert.equal(out.total_iqd, 0);
  assert.equal(out.delivery_waiting, true);
  assert.deepEqual(out.used, []);
  const short = allocateCouponPool([ship('s1')], [line('t', 'p_tool', 10_000)], { delivery_method: null, delivery_iqd: 0 }, { deliveryPending: true });
  assert.equal(short.delivery_waiting, false, 'it cannot wait for a delivery while the goods fall short');
  assert.equal(short.blocked_min_total_iqd, 100_000);
});

test('a coupon issued before the owner’s change spends on its own terms: the whole fee, and every piece it names', () => {
  const oldShip = ship('old_s', { kind: 'percent', value: 100, min_total_iqd: 0 });
  const oldFilament = filament('old_f', { max_quantity: null });
  const out = allocateCouponPool([oldShip, oldFilament, filament('f1')], [line('pla', 'p_pla', 30_000, 3)], ctx(12_000));
  assert.equal(out.delivery_iqd, 12_000, 'the fee in full, no minimum');
  assert.equal(out.merchandise_iqd, 13_500, 'three pieces at 15%');
  assert.deepEqual(out.used.map((u) => u.coupon_id), ['old_f', 'old_s'], 'the old coupon took every piece, so the new one stays');
});

test('a discounted line takes no filament coupon, and an order with nothing to take is worth nothing', () => {
  const discounted = line('pla', 'p_pla', 30_000, 2, { already_discounted: true });
  assert.equal(allocateCouponPool([filament('f1')], [discounted], ctx(0)).total_iqd, 0, 'one discount per piece');
  const out = allocateCouponPool([filament('f1'), ship('s1')], [discounted, PRINTER], ctx(5_000));
  assert.deepEqual([out.merchandise_iqd, out.delivery_iqd], [0, 5_000], 'the delivery coupon still spends: it stacks');
  assert.equal(allocateCouponPool([], [PRINTER], ctx(5_000)).total_iqd, 0);
  assert.equal(allocateCouponPool([filament('f1')], [], ctx(5_000)).total_iqd, 0);
  assert.equal(allocateCouponPool([ship('s1', { min_total_iqd: 0 })], [], ctx(5_000)).total_iqd, 0, 'a delivery coupon still has to name a paid line (a gift-only order)');
});

test('the same order always allocates the same way, whatever order its lines arrive in', () => {
  const a = line('a', 'p_pla', 30_000, 1);
  const b = line('b', 'p_petg', 30_000, 1);
  const coupons = [filament('f1')];
  assert.deepEqual(allocateCouponPool(coupons, [a, b], ctx(0)).lines, allocateCouponPool(coupons, [b, a], ctx(0)).lines);
  const rules: CouponRule[] = coupons.map((c) => c.rule);
  assert.equal(rules[0].max_quantity, 1);
});
