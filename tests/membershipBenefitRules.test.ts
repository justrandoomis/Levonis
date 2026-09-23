import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPE_RANK,
  lineBenefit,
  orderLineBenefits,
  selectRule,
  shippingAfterBenefit,
  shippingBenefit,
  taxBenefit,
  unitDiscountIqd,
  type BenefitRule,
} from '../packages/pricing/src/membershipBenefits';
import { calculateCodTaxIqd, codDeliveryTaxIqd } from '../packages/shipping/src/codTax';

/**
 * THE OWNER'S OWN WORKED EXAMPLES, as tests.
 *
 * Every number below is a ROW an admin can change, so each test states the
 * configuration it is asserting about. Nothing here pins a value into the
 * code: change the rule and the arithmetic follows, which is the entire point
 * of the table these read from.
 */

const NOW = '2026-09-14T12:00:00Z';

const rule = (over: Partial<BenefitRule>): BenefitRule => ({
  id: 'r',
  tier: 'pro',
  benefit_type: 'product_discount',
  scope: 'global',
  category_id: null,
  sub_category_id: null,
  product_id: null,
  discount_mode: 'percent',
  percent: null,
  fixed_iqd: null,
  max_discount_iqd: null,
  cap_scope: null,
  max_quantity: null,
  min_subtotal_iqd: null,
  free_shipping_threshold_iqd: null,
  shipping_methods: null,
  max_shipping_subsidy_iqd: null,
  cod_tax_exempt: null,
  enabled: true,
  priority: 0,
  valid_from: null,
  valid_until: null,
  label: null,
  ...over,
});

/* ------------------------------------------------------- PRO — printers */

test('PRO printer: 10% of 1,850,000 is 185,000, and the 100,000 per-unit cap holds it to 100,000', () => {
  const printers = rule({ percent: 10, max_discount_iqd: 100_000, cap_scope: 'per_unit' });
  assert.equal(unitDiscountIqd(1_850_000, printers), 100_000);
  const line = lineBenefit({ regularUnitIqd: 1_850_000, qty: 1, rule: printers });
  assert.equal(line.total_iqd, 100_000);
  assert.equal(line.capped_by, 'per_unit', 'the UI must be able to say the cap is what decided this');
});

test('PRO printer: a cheaper printer is not capped — 10% of 500,000 is the whole 50,000', () => {
  const printers = rule({ percent: 10, max_discount_iqd: 100_000, cap_scope: 'per_unit' });
  const line = lineBenefit({ regularUnitIqd: 500_000, qty: 1, rule: printers });
  assert.equal(line.total_iqd, 50_000);
  assert.equal(line.capped_by, 'none');
});

test('PRO printer: the cap is PER UNIT, so two capped printers save 200,000 and not 100,000', () => {
  // The whole reason `cap_scope` is stored rather than assumed. Read the other
  // way round, the second printer would silently save nothing.
  const perUnit = rule({ percent: 10, max_discount_iqd: 100_000, cap_scope: 'per_unit' });
  assert.equal(lineBenefit({ regularUnitIqd: 1_850_000, qty: 2, rule: perUnit }).total_iqd, 200_000);

  const perOrder = rule({ percent: 10, max_discount_iqd: 100_000, cap_scope: 'per_order' });
  const capped = lineBenefit({ regularUnitIqd: 1_850_000, qty: 2, rule: perOrder });
  assert.equal(capped.total_iqd, 100_000, 'the same numbers, capped per order, stop at one ceiling');
  assert.equal(capped.capped_by, 'per_order');
});

/* ------------------------------------- a per-order limit is ONE per order */

test('a per-order ceiling is shared by every line of the rule, not granted once per line', () => {
  // Two DIFFERENT printers under one rule capped at 150,000 per order. Applied
  // line by line this gave 150,000 + 100,000 = 250,000.
  const perOrder = rule({ percent: 10, max_discount_iqd: 150_000, cap_scope: 'per_order' });
  const [big, small] = orderLineBenefits([
    { regularUnitIqd: 1_850_000, qty: 1, rule: perOrder },
    { regularUnitIqd: 1_000_000, qty: 1, rule: perOrder },
  ]);
  assert.equal(big!.total_iqd + small!.total_iqd, 150_000, 'one ceiling for the whole order');
  assert.equal(big!.total_iqd, 150_000, 'the larger saving draws on the budget first');
  assert.equal(big!.capped_by, 'per_order');
  assert.equal(small!.total_iqd, 0);
  assert.equal(small!.capped_by, 'per_order', 'the line says why it saved nothing');
  assert.equal(small!.rule_id, 'r');
});

test('a per-order ceiling the lines do not reach leaves every line whole', () => {
  const perOrder = rule({ percent: 10, max_discount_iqd: 500_000, cap_scope: 'per_order' });
  const lines = orderLineBenefits([
    { regularUnitIqd: 1_850_000, qty: 1, rule: perOrder },
    { regularUnitIqd: 1_000_000, qty: 2, rule: perOrder },
  ]);
  assert.deepEqual(lines.map((l) => l.total_iqd), [185_000, 200_000]);
  assert.ok(lines.every((l) => l.capped_by === 'none'));
});

test('max_quantity counts units across the order, not per line', () => {
  const firstTwo = rule({ percent: 10, max_discount_iqd: 100_000, cap_scope: 'per_unit', max_quantity: 2 });
  const lines = orderLineBenefits([
    { regularUnitIqd: 500_000, qty: 2, rule: firstTwo },
    { regularUnitIqd: 1_850_000, qty: 2, rule: firstTwo },
  ]);
  // The two most valuable units are the two capped printers on the second line.
  assert.equal(lines[1]!.eligible_qty, 2);
  assert.equal(lines[1]!.total_iqd, 200_000);
  assert.equal(lines[0]!.eligible_qty, 0);
  assert.equal(lines[0]!.total_iqd, 0);
  assert.equal(lines[0]!.capped_by, 'quantity');
  assert.equal(lines.reduce((n, l) => n + l.eligible_qty, 0), 2, 'two units in the whole order');
});

test('two different rules keep two budgets, and a rule without an order limit is untouched', () => {
  const a = rule({ id: 'a', percent: 10, max_discount_iqd: 100_000, cap_scope: 'per_order' });
  const b = rule({ id: 'b', percent: 10, max_discount_iqd: 100_000, cap_scope: 'per_order' });
  const plain = rule({ id: 'c', percent: 20 });
  const lines = orderLineBenefits([
    { regularUnitIqd: 1_850_000, qty: 1, rule: a },
    { regularUnitIqd: 1_850_000, qty: 1, rule: b },
    { regularUnitIqd: 25_000, qty: 4, rule: plain },
  ]);
  assert.deepEqual(lines.map((l) => l.total_iqd), [100_000, 100_000, 20_000]);
  assert.equal(lines[2]!.applied_at, 'unit');
});

test('a single line answers the same through lineBenefit and orderLineBenefits', () => {
  const perOrder = rule({ percent: 10, max_discount_iqd: 100_000, cap_scope: 'per_order', max_quantity: 3 });
  const input = { regularUnitIqd: 1_850_000, qty: 5, rule: perOrder };
  assert.deepEqual(lineBenefit(input), orderLineBenefits([input])[0]);
});

/* ---------------------------------------------- PRO — filament and parts */

test('PRO filament at a configured 20% takes exactly 20%, with no ceiling in the way', () => {
  const line = lineBenefit({ regularUnitIqd: 25_000, qty: 3, rule: rule({ percent: 20 }) });
  assert.equal(line.per_unit_iqd, 5_000);
  assert.equal(line.total_iqd, 15_000);
});

test('PRO accessory at a configured 40% takes exactly 40%', () => {
  assert.equal(unitDiscountIqd(60_000, rule({ percent: 40 })), 24_000);
});

test('a percentage never rounds in the member’s favour, and never exceeds the item', () => {
  // 33% of 1,001 is 330.33 — the member saves 330, not 331.
  assert.equal(unitDiscountIqd(1_001, rule({ percent: 33 })), 330);
  // A fixed amount larger than the product cannot make a price negative.
  assert.equal(unitDiscountIqd(5_000, rule({ discount_mode: 'fixed', fixed_iqd: 9_999 })), 5_000);
});

/* --------------------------------------------------------- PREMIUM */

test('PREMIUM printer: a FIXED 25,000 per unit on two units saves 50,000', () => {
  const premium = rule({
    tier: 'prime',
    discount_mode: 'fixed',
    fixed_iqd: 25_000,
    cap_scope: 'per_unit',
  });
  const line = lineBenefit({ regularUnitIqd: 1_850_000, qty: 2, rule: premium });
  assert.equal(line.per_unit_iqd, 25_000);
  assert.equal(line.total_iqd, 50_000);
});

test('PREMIUM fixed amounts differ per product, which is the point of the scope', () => {
  const rules: BenefitRule[] = [
    rule({ id: 'tier', tier: 'prime', discount_mode: 'fixed', fixed_iqd: 10_000, scope: 'global' }),
    rule({ id: 'a1', tier: 'prime', discount_mode: 'fixed', fixed_iqd: 15_000, scope: 'product', product_id: 'a1' }),
    rule({ id: 'x2d', tier: 'prime', discount_mode: 'fixed', fixed_iqd: 25_000, scope: 'product', product_id: 'x2d' }),
  ];
  const pick = (product_id: string) =>
    selectRule(rules, { tier: 'prime', tierActive: true, benefitType: 'product_discount', target: { product_id }, nowIso: NOW });
  assert.equal(pick('mini')!.fixed_iqd, 10_000, 'a product with no rule of its own gets the tier default');
  assert.equal(pick('a1')!.fixed_iqd, 15_000);
  assert.equal(pick('x2d')!.fixed_iqd, 25_000);
});

/* ------------------------------------------------------- precedence */

test('PRODUCT beats SUB-SECTION beats SECTION beats the tier default', () => {
  const rules: BenefitRule[] = [
    rule({ id: 'tier', percent: 10, scope: 'global' }),
    rule({ id: 'sec', percent: 15, scope: 'category', category_id: 'filament' }),
    rule({ id: 'sub', percent: 20, scope: 'sub_category', sub_category_id: 'pla' }),
    rule({ id: 'prod', percent: 25, scope: 'product', product_id: 'silk-pla' }),
  ];
  const at = (target: Record<string, string | null>) =>
    selectRule(rules, { tier: 'pro', tierActive: true, benefitType: 'product_discount', target, nowIso: NOW })!.id;

  assert.equal(at({ product_id: 'silk-pla', sub_category_id: 'pla', category_id: 'filament' }), 'prod');
  assert.equal(at({ product_id: 'other', sub_category_id: 'pla', category_id: 'filament' }), 'sub');
  assert.equal(at({ product_id: 'other', sub_category_id: 'petg', category_id: 'filament' }), 'sec');
  assert.equal(at({ product_id: 'other', sub_category_id: null, category_id: 'printers' }), 'tier');
  assert.deepEqual(
    [SCOPE_RANK.product, SCOPE_RANK.sub_category, SCOPE_RANK.category, SCOPE_RANK.global],
    [3, 2, 1, 0]
  );
});

test('priority breaks a tie WITHIN one scope and never across scopes', () => {
  // A global rule shouted at priority 99 must not beat the product override an
  // admin typed for one printer — otherwise "override" means nothing.
  const rules: BenefitRule[] = [
    rule({ id: 'loud-global', percent: 50, scope: 'global', priority: 99 }),
    rule({ id: 'quiet-product', percent: 5, scope: 'product', product_id: 'p', priority: 0 }),
    rule({ id: 'global-b', percent: 40, scope: 'global', priority: 1 }),
  ];
  const win = selectRule(rules, {
    tier: 'pro', tierActive: true, benefitType: 'product_discount', target: { product_id: 'p' }, nowIso: NOW,
  })!;
  assert.equal(win.id, 'quiet-product');

  const noProduct = selectRule(rules, {
    tier: 'pro', tierActive: true, benefitType: 'product_discount', target: { product_id: 'z' }, nowIso: NOW,
  })!;
  assert.equal(noProduct.id, 'loud-global', 'between two globals, priority decides');
});

test('only ONE membership rule ever applies to a line', () => {
  // Stacking is not a feature: it is a bug whose only symptom is a total that
  // is quietly too small.
  const rules: BenefitRule[] = [
    rule({ id: 'a', percent: 10, scope: 'global' }),
    rule({ id: 'b', percent: 20, scope: 'category', category_id: 'c' }),
  ];
  const win = selectRule(rules, {
    tier: 'pro', tierActive: true, benefitType: 'product_discount', target: { category_id: 'c' }, nowIso: NOW,
  })!;
  assert.equal(unitDiscountIqd(100_000, win), 20_000, 'the more specific rule, not 10% then 20%');
});

/* --------------------------------------------------------- quantity */

test('a quantity limit discounts the first N units and leaves the rest at full price', () => {
  const firstTwo = rule({ percent: 10, max_quantity: 2 });
  const line = lineBenefit({ regularUnitIqd: 100_000, qty: 5, rule: firstTwo });
  assert.equal(line.eligible_qty, 2);
  assert.equal(line.total_iqd, 20_000);
  assert.equal(line.capped_by, 'quantity');
  assert.equal(lineBenefit({ regularUnitIqd: 100_000, qty: 5, rule: rule({ percent: 10 }) }).total_iqd, 50_000,
    'with no limit configured, every unit qualifies');
});

/* ------------------------------------------------ enabled, dates, tier */

test('a disabled, expired, not-yet-valid or wrong-tier rule is not applied', () => {
  const ctx = { tier: 'pro' as const, tierActive: true, benefitType: 'product_discount' as const, nowIso: NOW };
  assert.equal(selectRule([rule({ percent: 10, enabled: false })], ctx), null);
  assert.equal(selectRule([rule({ percent: 10, valid_until: '2026-01-01T00:00:00Z' })], ctx), null);
  assert.equal(selectRule([rule({ percent: 10, valid_from: '2027-01-01T00:00:00Z' })], ctx), null);
  assert.equal(selectRule([rule({ percent: 10, tier: 'prime' })], ctx), null);
  assert.ok(selectRule([rule({ percent: 10, valid_from: '2026-01-01T00:00:00Z', valid_until: '2027-01-01T00:00:00Z' })], ctx));
});

test('an expired membership earns nothing, whatever the rules say', () => {
  const ctx = { tier: 'pro' as const, tierActive: false, benefitType: 'product_discount' as const, nowIso: NOW };
  assert.equal(selectRule([rule({ percent: 10 })], ctx), null);
});

test('a minimum subtotal is honoured when the order value is known', () => {
  const big = rule({ percent: 10, min_subtotal_iqd: 200_000 });
  const ctx = { tier: 'pro' as const, tierActive: true, benefitType: 'product_discount' as const, nowIso: NOW };
  assert.equal(selectRule([big], { ...ctx, subtotalIqd: 199_999 }), null);
  assert.ok(selectRule([big], { ...ctx, subtotalIqd: 200_000 }));
});

/* --------------------------------------------------------- shipping */

const shipRule = (over: Partial<BenefitRule>) =>
  rule({ benefit_type: 'free_shipping', discount_mode: null, ...over });

test('PRO free delivery covers STANDARD and PERSONAL above its threshold', () => {
  const pro = shipRule({ free_shipping_threshold_iqd: 75_000, shipping_methods: ['standard', 'personal'] });
  assert.equal(shippingBenefit({ rule: pro, basisIqd: 75_001, method: 'standard' }).eligible, true);
  assert.equal(shippingBenefit({ rule: pro, basisIqd: 75_001, method: 'personal' }).eligible, true);
  const below = shippingBenefit({ rule: pro, basisIqd: 74_999, method: 'standard' });
  assert.equal(below.eligible, false);
  assert.equal(below.reason, 'below_threshold');
});

/**
 * ONE OPERATOR, IN BOTH ENGINES.
 *
 * `quoteShipping` has always compared STRICTLY GREATER — the owner's confirmed
 * rule is "75,000 does not qualify, 75,001 does" — and the rules table changes
 * only WHAT the number is. If these two ever diverged, the same basket would
 * be free on the product page and charged at the door.
 */
test('the threshold is strictly greater, exactly as the shipping engine reads it', () => {
  const pro = shipRule({ free_shipping_threshold_iqd: 75_000, shipping_methods: ['standard', 'personal'] });
  const atExactly = shippingBenefit({ rule: pro, basisIqd: 75_000, method: 'standard' });
  assert.equal(atExactly.eligible, false, '75,000 itself does NOT qualify');
  assert.equal(atExactly.reason, 'below_threshold');
  assert.equal(shippingBenefit({ rule: pro, basisIqd: 75_001, method: 'standard' }).eligible, true);
});

test('PREMIUM free delivery covers STANDARD ONLY — personal stays payable', () => {
  const premium = shipRule({ tier: 'prime', free_shipping_threshold_iqd: 100_000, shipping_methods: ['standard'] });
  assert.equal(shippingBenefit({ rule: premium, basisIqd: 100_001, method: 'standard' }).eligible, true);
  assert.equal(
    shippingBenefit({ rule: premium, basisIqd: 100_000, method: 'standard' }).eligible,
    false,
    'strictly greater here too'
  );
  const personal = shippingBenefit({ rule: premium, basisIqd: 500_000, method: 'personal' });
  assert.equal(personal.eligible, false, 'however large the order');
  assert.equal(personal.reason, 'method_not_covered');
});

test('a subsidy ceiling makes the member pay the difference', () => {
  const capped = shipRule({ free_shipping_threshold_iqd: 0, max_shipping_subsidy_iqd: 15_000 });
  const benefit = shippingBenefit({ rule: capped, basisIqd: 100_000, method: 'standard' });
  assert.deepEqual(shippingAfterBenefit(25_000, benefit), { paid_iqd: 10_000, subsidy_iqd: 15_000 });
  assert.deepEqual(shippingAfterBenefit(9_000, benefit), { paid_iqd: 0, subsidy_iqd: 9_000 },
    'a fee under the ceiling is waived in full');

  const uncapped = shippingBenefit({ rule: shipRule({ free_shipping_threshold_iqd: 0 }), basisIqd: 1, method: 'standard' });
  assert.deepEqual(shippingAfterBenefit(25_000, uncapped), { paid_iqd: 0, subsidy_iqd: 25_000 },
    'with no ceiling configured, the whole eligible fee goes');
});

/* -------------------------------------------------------------- COD tax */

test('PRO: the COD tax is CALCULATED IN FULL and then exempted — both numbers survive', () => {
  // The exemption must never be implemented by skipping the calculation: an
  // order showing "COD tax: 0" cannot be reconciled against a courier's cash
  // sheet, and an invoice that never names the waiver cannot explain itself.
  const calculated = codDeliveryTaxIqd({
    paymentMethodId: 'cash',
    deliveryMethodId: 'standard',
    payableBeforeTaxIqd: 1_000_000,
  });
  // «اجعلها 3 الف لكل 500 الف» — the owner halved the per-block charge, so two
  // complete blocks of 500,000 now cost 6,000 rather than 12,000. The figure is
  // the PACKAGED DEFAULT: this call passes no rate, which is what an
  // unconfigured shop charges.
  assert.equal(calculated, 6_000, 'two complete 500,000 blocks at 3,000 each');

  const proExempt = taxBenefit(rule({ benefit_type: 'cod_tax_exemption', discount_mode: null, cod_tax_exempt: true }));
  assert.equal(proExempt.cod_exempt, true);
  const payable = proExempt.cod_exempt ? 0 : calculated;
  assert.equal(payable, 0);
  assert.equal(calculated, 6_000, 'and the calculated figure is still there to record');
});

test('PREMIUM: the COD tax stays, because its rule says so', () => {
  const premium = taxBenefit(
    rule({ tier: 'prime', benefit_type: 'cod_tax_exemption', discount_mode: null, cod_tax_exempt: false })
  );
  assert.equal(premium.cod_exempt, false);
  assert.equal(calculateCodTaxIqd(1_000_000), 6_000);
});

test('the COD exemption is a rule, not a tier check anywhere in the code', () => {
  // Flipping the stored value is all it takes to exempt PREMIUM tomorrow.
  const flipped = taxBenefit(
    rule({ tier: 'prime', benefit_type: 'cod_tax_exemption', discount_mode: null, cod_tax_exempt: true })
  );
  assert.equal(flipped.cod_exempt, true);
});

/* ------------------------------------------------- changing the rules */

test('changing a percentage changes the next calculation and nothing already computed', () => {
  const before = rule({ percent: 10 });
  const snapshot = lineBenefit({ regularUnitIqd: 1_000_000, qty: 1, rule: before });
  assert.equal(snapshot.total_iqd, 100_000);

  const after = { ...before, percent: 20 };
  assert.equal(lineBenefit({ regularUnitIqd: 1_000_000, qty: 1, rule: after }).total_iqd, 200_000);
  assert.equal(snapshot.total_iqd, 100_000, 'the figure already resolved is a value, not a live query');
});
