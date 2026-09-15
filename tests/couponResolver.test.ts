/**
 * THE COUPON RESOLVER, tested against the owner's own two examples.
 *
 * «مثال خصم بقيمة تسعمائة ألف لمستخدم معين على منتج معين بخيار ولون محدد
 *   وبطريقة شحن محددة … بقيمة خصم ٩٥٠ الف، أو مثلا خصم لكل الأعضاء على
 *   توصيل العادي على منتج الفلامنت ولكن بشرط أن يصل قيمة الطلب أكثر من مئة
 *   ألف وصالح لمدة ثلاثة أيام فقط»
 *
 * Both are written out below as literal fixtures, because a resolver that
 * cannot express the two cases the owner actually described is not finished no
 * matter how many abstract cases it passes.
 *
 * Every other test here pins one of the decisions the owner made, or one of
 * the money traps the adversarial pass found. Each says which.
 * Run: npx tsx --test tests/couponResolver.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateCoupon,
  couponMatchesLine,
  needsDeliveryChoice,
  scopeNamesLine,
  type CouponContext,
  type CouponLine,
  type CouponRule,
} from '@levonis/pricing/coupons';

const RULE: CouponRule = {
  scope: 'global',
  category_id: null,
  sub_category_id: null,
  product_id: null,
  brand_id: null,
  bundle_product_id: null,
  option_value_id: null,
  color_id: null,
  fulfillment_types: [],
  transport_methods: [],
  delivery_methods: [],
  kind: 'percent',
  value: 10,
  max_discount_iqd: null,
  cap_scope: 'per_order',
  max_quantity: null,
  applies_to: 'merchandise',
  stacks: true,
};

const LINE: CouponLine = {
  line_id: 'l1',
  product_id: 'p_a1',
  option_value_ids: [],
  color_id: '',
  brand_id: 'br_bambu',
  category_id: 'cat_printers',
  sub_category_id: null,
  ancestry: ['cat_printers'],
  bundle_product_id: null,
  fulfillment_type: 'direct_sale',
  transport_method: '',
  qty: 1,
  unit_goods_iqd: 950_000,
  already_discounted: false,
};

const rule = (over: Partial<CouponRule> = {}): CouponRule => ({ ...RULE, ...over });
const line = (over: Partial<CouponLine> = {}): CouponLine => ({ ...LINE, ...over });
const ctx = (over: Partial<CouponContext> = {}): CouponContext => ({ delivery_method: 'standard', delivery_iqd: 0, ...over });

// ===========================================================================
// THE OWNER'S EXAMPLE 1 — one user, one model, one colour, pre-order, personal
// ===========================================================================

test('example 1: 950,000 off the A1 Combo in black, pre-order by land, personal delivery', () => {
  const vip = rule({
    scope: 'product',
    product_id: 'p_a1',
    option_value_id: 'ov_combo',
    color_id: 'col_black',
    fulfillment_types: ['pre_order'],
    transport_methods: ['land'],
    delivery_methods: ['personal'],
    kind: 'fixed_iqd',
    value: 950_000,
  });
  const combo = line({
    option_value_ids: ['ov_combo'],
    color_id: 'col_black',
    fulfillment_type: 'pre_order',
    transport_method: 'land',
    unit_goods_iqd: 1_900_000,
  });
  const got = allocateCoupon(vip, [combo], ctx({ delivery_method: 'personal' }));
  assert.equal(got.merchandise_iqd, 950_000);
  assert.deepEqual(got.lines, [{ line_id: 'l1', amount_iqd: 950_000 }]);

  // Every axis is load-bearing: changing ANY one of the five refuses it.
  const refusals: Array<[string, CouponLine, CouponContext]> = [
    ['the base model, not the Combo', line({ ...combo, option_value_ids: ['ov_base'] }), ctx({ delivery_method: 'personal' })],
    ['the wrong colour', line({ ...combo, color_id: 'col_white' }), ctx({ delivery_method: 'personal' })],
    ['bought as a direct sale', line({ ...combo, fulfillment_type: 'direct_sale' }), ctx({ delivery_method: 'personal' })],
    ['shipped by air', line({ ...combo, transport_method: 'air' }), ctx({ delivery_method: 'personal' })],
    ['ordinary delivery', combo, ctx({ delivery_method: 'standard' })],
  ];
  for (const [why, l, c] of refusals) {
    assert.equal(couponMatchesLine(vip, l, c), false, `must not match: ${why}`);
    assert.equal(allocateCoupon(vip, [l], c).total_iqd, 0, `must pay nothing: ${why}`);
  }
});

test('example 1: the 950,000 does not spill onto the filament sitting beside it', () => {
  // THE TRAP. Today's clamp is `Math.min(discount, orderTotal)`, so a 950,000
  // coupon on a 900,000 printer pays 900,000 for the printer and then quietly
  // discounts 50,000 of unrelated filament. The ceiling is the MATCHED goods.
  const vip = rule({ scope: 'product', product_id: 'p_a1', kind: 'fixed_iqd', value: 950_000 });
  const got = allocateCoupon(
    vip,
    [line({ unit_goods_iqd: 900_000 }), line({ line_id: 'l2', product_id: 'p_pla', unit_goods_iqd: 400_000 })],
    ctx()
  );
  assert.equal(got.merchandise_iqd, 900_000, 'clamped to the printer, not to the order');
  assert.deepEqual(got.lines, [{ line_id: 'l1', amount_iqd: 900_000 }]);
  assert.deepEqual(got.matched_line_ids, ['l1'], 'the filament was never named');
});

test('example 1: three of the same printer take 950,000 between them, not 2,850,000', () => {
  // A FIXED AMOUNT IS ONE AMOUNT. Treating it as per-unit is how a single-use
  // coupon pays out three times while the counter records one redemption.
  const vip = rule({ scope: 'product', product_id: 'p_a1', kind: 'fixed_iqd', value: 950_000 });
  const got = allocateCoupon(vip, [line({ qty: 3, unit_goods_iqd: 1_900_000 })], ctx());
  assert.equal(got.merchandise_iqd, 950_000);
});

// ===========================================================================
// THE OWNER'S EXAMPLE 2 — everyone, filament, ordinary delivery
// ===========================================================================

test('example 2: a delivery coupon reduces the delivery and leaves the filament alone', () => {
  const promo = rule({
    scope: 'product',
    product_id: 'p_pla',
    delivery_methods: ['standard'],
    applies_to: 'delivery',
    kind: 'percent',
    value: 100,
  });
  const filament = line({ line_id: 'f1', product_id: 'p_pla', unit_goods_iqd: 60_000, qty: 2 });
  const got = allocateCoupon(promo, [filament], ctx({ delivery_method: 'standard', delivery_iqd: 5_000 }));
  assert.equal(got.delivery_iqd, 5_000, 'the delivery is waived');
  assert.equal(got.merchandise_iqd, 0, 'the goods are untouched');
  assert.deepEqual(got.lines, [], 'and no line carries a discount to refund later');

  // Personal delivery is a different method and the coupon does not name it.
  assert.equal(allocateCoupon(promo, [filament], ctx({ delivery_method: 'personal', delivery_iqd: 25_000 })).total_iqd, 0);
});

test('example 2: a delivery-conditional coupon FAILS CLOSED before a method is chosen', () => {
  // The cart page runs before an address exists. A coupon that filters on
  // delivery cannot be evaluated there, and answering "valid" would advertise
  // a discount the checkout might refuse — the exact complaint the price-
  // stability work exists to prevent. So it does not match, and the caller is
  // told WHY by needsDeliveryChoice rather than being handed a bare refusal.
  const promo = rule({ delivery_methods: ['standard'] });
  assert.equal(needsDeliveryChoice(promo), true);
  assert.equal(couponMatchesLine(promo, line(), ctx({ delivery_method: null })), false);
  assert.equal(needsDeliveryChoice(rule()), false, 'an unfiltered coupon needs nothing');
});

// ===========================================================================
// DECISION 2 — a percentage is taken off the GOODS, never off the fees
// ===========================================================================

test('a percentage never discounts freight commission, surcharge or warranty', () => {
  // The caller passes goods only. A 950,000 printer whose stored unit price is
  // 1,300,000 once a 200,000 warranty and a 150,000 air commission are folded
  // in must still yield 95,000 at 10%, not 130,000 — the difference is cash
  // the shop owes a forwarder and a warranty book.
  const got = allocateCoupon(rule({ value: 10 }), [line({ unit_goods_iqd: 950_000 })], ctx());
  assert.equal(got.merchandise_iqd, 95_000);
});

// ===========================================================================
// DECISION 4 — the cap knows what it caps
// ===========================================================================

test('per_unit caps each unit, per_order caps the coupon once', () => {
  const two = [line({ qty: 2, unit_goods_iqd: 1_000_000 })];
  const perUnit = allocateCoupon(rule({ value: 20, max_discount_iqd: 100_000, cap_scope: 'per_unit' }), two, ctx());
  assert.equal(perUnit.merchandise_iqd, 200_000, 'two printers under a 100,000 cap save 200,000');
  const perOrder = allocateCoupon(rule({ value: 20, max_discount_iqd: 100_000, cap_scope: 'per_order' }), two, ctx());
  assert.equal(perOrder.merchandise_iqd, 100_000, 'the same cap, applied once');
  const uncapped = allocateCoupon(rule({ value: 20 }), two, ctx());
  assert.equal(uncapped.merchandise_iqd, 400_000, 'بدون حد');
});

test('max_quantity limits how many units qualify, in cart order', () => {
  const got = allocateCoupon(
    rule({ kind: 'percent', value: 50, max_quantity: 1 }),
    [line({ qty: 3, unit_goods_iqd: 100_000 })],
    ctx()
  );
  assert.equal(got.merchandise_iqd, 50_000, 'one unit of three');
});

// ===========================================================================
// DECISION 1 — scope, with the section tree
// ===========================================================================

test('a section coupon covers the whole branch beneath it', () => {
  const sec = rule({ scope: 'category', category_id: 'cat_printers' });
  // Filed three levels deep, so only ancestry can see it.
  const deep = line({ category_id: 'cat_bambu', ancestry: ['cat_printers', 'cat_fdm', 'cat_bambu'] });
  assert.equal(scopeNamesLine(sec, deep), true);
  // A product with NO ancestry resolved is not silently matched.
  assert.equal(scopeNamesLine(sec, line({ category_id: null, ancestry: null })), false);
});

test('brand and bundle scopes name what they say and nothing else', () => {
  assert.equal(scopeNamesLine(rule({ scope: 'brand', brand_id: 'br_bambu' }), line()), true);
  assert.equal(scopeNamesLine(rule({ scope: 'brand', brand_id: 'br_creality' }), line()), false);
  const bundleLine = line({ bundle_product_id: 'p_kit' });
  assert.equal(scopeNamesLine(rule({ scope: 'bundle', bundle_product_id: 'p_kit' }), bundleLine), true);
  assert.equal(scopeNamesLine(rule({ scope: 'bundle', bundle_product_id: 'p_kit' }), line()), false, 'a plain line is not a bundle');
});

// ===========================================================================
// DECISION — stacking is the coupon's own choice
// ===========================================================================

test('a non-stacking coupon refuses a line that already carries a discount', () => {
  const solo = rule({ stacks: false });
  assert.equal(couponMatchesLine(solo, line({ already_discounted: true }), ctx()), false);
  assert.equal(couponMatchesLine(solo, line({ already_discounted: false }), ctx()), true);
  // …and a stacking one does not care, which is today's behaviour.
  assert.equal(couponMatchesLine(rule({ stacks: true }), line({ already_discounted: true }), ctx()), true);
});

// ===========================================================================
// THE PER-LINE ALLOCATION — what a refund is later paid from
// ===========================================================================

test('the per-line amounts sum EXACTLY to the discount the customer was shown', () => {
  // Three lines whose natural split does not divide evenly. Losing a dinar
  // here is a receipt whose lines do not add up to its own total.
  const got = allocateCoupon(
    rule({ kind: 'fixed_iqd', value: 100_000 }),
    [
      line({ line_id: 'a', unit_goods_iqd: 33_333 }),
      line({ line_id: 'b', unit_goods_iqd: 33_333 }),
      line({ line_id: 'c', unit_goods_iqd: 33_334 }),
    ],
    ctx()
  );
  assert.equal(got.merchandise_iqd, 100_000);
  assert.equal(got.lines.reduce((s, l) => s + l.amount_iqd, 0), 100_000);
});

test('a cap re-spreads, so the lines still sum to the capped figure', () => {
  const got = allocateCoupon(
    rule({ value: 50, max_discount_iqd: 70_000, cap_scope: 'per_order' }),
    [line({ line_id: 'a', unit_goods_iqd: 100_000 }), line({ line_id: 'b', unit_goods_iqd: 100_000 })],
    ctx()
  );
  assert.equal(got.merchandise_iqd, 70_000);
  assert.equal(got.lines.reduce((s, l) => s + l.amount_iqd, 0), 70_000);
});

test('a coupon that names nothing in the cart pays nothing and allocates nothing', () => {
  const got = allocateCoupon(rule({ scope: 'product', product_id: 'p_nothing' }), [line()], ctx());
  assert.equal(got.total_iqd, 0);
  assert.deepEqual(got.lines, []);
  assert.deepEqual(got.matched_line_ids, []);
});

test("'both' spends one fixed amount once: goods first, delivery takes the remainder", () => {
  const got = allocateCoupon(
    rule({ kind: 'fixed_iqd', value: 60_000, applies_to: 'both' }),
    [line({ unit_goods_iqd: 50_000 })],
    ctx({ delivery_iqd: 25_000 })
  );
  assert.equal(got.merchandise_iqd, 50_000);
  assert.equal(got.delivery_iqd, 10_000, 'the remainder only — not another 60,000');
  assert.equal(got.total_iqd, 60_000);
});

test('a discount never exceeds what it is taken from', () => {
  const huge = allocateCoupon(rule({ kind: 'fixed_iqd', value: 9_000_000 }), [line({ unit_goods_iqd: 1_000 })], ctx());
  assert.equal(huge.merchandise_iqd, 1_000);
  const deliv = allocateCoupon(
    rule({ kind: 'fixed_iqd', value: 9_000_000, applies_to: 'delivery' }),
    [line()],
    ctx({ delivery_iqd: 5_000 })
  );
  assert.equal(deliv.delivery_iqd, 5_000);
});
