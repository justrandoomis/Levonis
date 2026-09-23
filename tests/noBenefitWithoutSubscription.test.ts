/**
 * «مشترك برو يحصل على التوصيل المجاني سواء شخصي او عادي لكن المشكلة التي حدثت
 *  الان هو ان المستخدم لم يكن مشتركا بالاشتراك البرو وقد حصل على خصم»
 *
 * THE OWNER'S TWO SENTENCES, AS TESTS.
 *
 * The first half is a rule, not a bug: a PRO subscriber's delivery is free on
 * BOTH methods, personal and standard alike, and the seeded rule that says so
 * ('["standard","personal"]', migration 0074) is the owner's own. Nothing here
 * may narrow it — an earlier reading of the report did, and this file exists
 * partly to make that impossible to repeat quietly.
 *
 * The second half is the defect: the customer who got the benefit held no
 * subscription. Two paths put him there, and both are now closed:
 *
 *   1. `referralFreeDeliveryApplies` — a referred friend buying a printer had
 *      the WHOLE delivery fee waived, any method, no membership required.
 *      Withdrawn entirely: «ألغِ المكافأة تماماً».
 *   2. `grantPrinterGiftIfEligible` fired automatically, and on the 'paid'
 *      milestone it minted a live membership the instant an UNPAID cash-on
 *      -delivery order row was written — which no cancellation then revoked.
 *      Now manual: «الهديه تعطى يدويا وليس تلقائيا».
 *
 * The engine assertions below are the invariant the paths fed; the source
 * assertions are the paths themselves, because a deletion is only permanent if
 * something fails when it comes back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shippingBenefit, type BenefitRule } from '../packages/pricing/src/membershipBenefits';
import { quoteShipping } from '../worker/lib/shipping';
import type { MembershipShippingDecision, ShippingConfig, ShippingItem } from '../worker/lib/shipping';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const orders = readFileSync(join(ROOT, 'worker/routes/orders.ts'), 'utf8');
const admin = readFileSync(join(ROOT, 'worker/routes/admin.ts'), 'utf8');
const membershipOps = readFileSync(join(ROOT, 'worker/lib/membershipOps.ts'), 'utf8');

/** The owner's own figures: a 1,255,000 cart and a 50,000 personal tariff. */
const CART_IQD = 1_255_000;
const PERSONAL_IQD = 50_000;

const cfg = (over: Partial<ShippingConfig> = {}): ShippingConfig => ({
  // worker/routes/orders.ts substitutes the CHOSEN method's price as the
  // ordinary tariff before quoting, so this is the personal delivery's 50,000.
  ordinary_iqd: PERSONAL_IQD,
  printer_small_iqd: 25_000,
  printer_large_iqd: 50_000,
  pro_threshold_iqd: 75_000,
  threshold_basis: 'merchandise_after_coupon',
  pro_waiver_covers: 'ordinary_only',
  prime_threshold_iqd: 150_000,
  prime_waiver_covers: 'ordinary_only',
  carton_threshold_spools: null,
  carton_fee_iqd: null,
  printer_advance_required: true,
  protected_iqd: null,
  ...over,
});

/** The seeded PRO rule, verbatim from migration 0074: BOTH methods. */
const proRule = (over: Partial<BenefitRule> = {}): BenefitRule => ({
  id: 'seed-pro-free-shipping', tier: 'pro', benefit_type: 'free_shipping', scope: 'global',
  category_id: null, sub_category_id: null, product_id: null, discount_mode: null,
  percent: null, fixed_iqd: null, max_discount_iqd: null, cap_scope: null,
  max_quantity: null, min_subtotal_iqd: null,
  free_shipping_threshold_iqd: 75_000,
  shipping_methods: ['standard', 'personal'],
  max_shipping_subsidy_iqd: null, cod_tax_exempt: null,
  enabled: true, priority: 0, valid_from: null, valid_until: null, label: null,
  ...over,
});

const decisionOf = (rule: BenefitRule, method: 'standard' | 'personal'): MembershipShippingDecision => {
  const b = shippingBenefit({ rule, basisIqd: CART_IQD, method });
  return {
    rule_id: b.rule_id, eligible: b.eligible, threshold_iqd: b.threshold_iqd,
    basis_iqd: b.basis_iqd, max_subsidy_iqd: b.max_subsidy_iqd ?? null, reason: b.reason,
  } as MembershipShippingDecision;
};

/** A legacy cart: no per-product delivery rules, so the method's own tariff. */
const legacyCart: ShippingItem[] = [{ product_id: 'p1', qty: 1, size_class: 'ordinary' }];

/* ------------------------------ the rule the owner confirmed, kept intact */

test('CONFIRMED: an active PRO gets personal delivery free — «سواء شخصي او عادي»', () => {
  const q = quoteShipping({
    items: legacyCart,
    deliveryMethod: 'personal',
    merchandiseIqd: CART_IQD,
    tier: 'pro', tierActive: true,
    proShippingEntitled: true,
    atApprovedDefaultAddress: true,
    membershipShipping: decisionOf(proRule(), 'personal'),
    config: cfg(),
  });
  assert.equal(q.total_iqd, 0, 'a paid PRO subscription buys exactly this');
  assert.equal(q.pro_waiver_applied, true);
});

test('CONFIRMED: the same PRO gets standard delivery free too', () => {
  const q = quoteShipping({
    items: legacyCart,
    deliveryMethod: 'standard',
    merchandiseIqd: CART_IQD,
    tier: 'pro', tierActive: true,
    proShippingEntitled: true,
    atApprovedDefaultAddress: true,
    membershipShipping: decisionOf(proRule(), 'standard'),
    config: cfg({ ordinary_iqd: 5_000 }),
  });
  assert.equal(q.total_iqd, 0);
});

test('the seeded PRO rule still names BOTH methods — nothing may quietly narrow it', () => {
  const seed = readFileSync(join(ROOT, 'migrations/0074_membership_benefit_rules.sql'), 'utf8');
  assert.match(
    seed,
    /'seed-pro-free-shipping'[^\n]*\n?[^\n]*\[\\?"standard\\?",\\?"personal\\?"\]|\["standard","personal"\][^\n]*\n?[^\n]*seed-pro-free-shipping/s,
    'PRO covers standard and personal: «مشترك برو يحصل على التوصيل المجاني سواء شخصي او عادي»'
  );
});

/* ------------------------------- and nothing for somebody who has not paid */

test('THE DEFECT: a never-subscribed customer pays the 50,000 in full', () => {
  const q = quoteShipping({
    items: legacyCart,
    deliveryMethod: 'personal',
    merchandiseIqd: CART_IQD,
    tier: 'free', tierActive: false,
    proShippingEntitled: false,
    premiumShippingEntitled: false,
    atApprovedDefaultAddress: true,
    // resolveOrderBenefits hands the engine NO_SHIPPING_BENEFIT for a
    // non-member: worker/routes/orders.ts passes `tierStatus.active ? rules : []`.
    membershipShipping: {
      rule_id: null, eligible: false, threshold_iqd: null,
      basis_iqd: CART_IQD, max_subsidy_iqd: null, reason: 'no_rule',
    },
    config: cfg(),
  });
  assert.equal(q.total_iqd, PERSONAL_IQD);
  assert.equal(q.pro_waiver_applied, false);
  assert.equal(q.prime_waiver_applied, false);
  assert.equal(q.waiver_source, 'none');
});

test('an EXPIRED PRO is a non-subscriber and pays in full', () => {
  const q = quoteShipping({
    items: legacyCart,
    deliveryMethod: 'personal',
    merchandiseIqd: CART_IQD,
    tier: 'pro', tierActive: false,
    proShippingEntitled: false,
    atApprovedDefaultAddress: true,
    membershipShipping: {
      rule_id: null, eligible: false, threshold_iqd: null,
      basis_iqd: CART_IQD, max_subsidy_iqd: null, reason: 'no_rule',
    },
    config: cfg(),
  });
  assert.equal(q.total_iqd, PERSONAL_IQD, 'the rules are withheld the moment the subscription lapses');
});

test('PREMIUM keeps standard only — its rule names one method and the quote obeys it', () => {
  const premium = proRule({ id: 'seed-premium-free-shipping', tier: 'prime', free_shipping_threshold_iqd: 100_000, shipping_methods: ['standard'] });
  const base = {
    items: legacyCart,
    merchandiseIqd: CART_IQD,
    primeMerchandiseIqd: CART_IQD,
    tier: 'prime' as const, tierActive: true,
    premiumShippingEntitled: true,
    atApprovedDefaultAddress: true,
  };
  assert.equal(
    quoteShipping({ ...base, deliveryMethod: 'personal', membershipShipping: decisionOf(premium, 'personal'), config: cfg() }).total_iqd,
    PERSONAL_IQD
  );
  assert.equal(
    quoteShipping({ ...base, deliveryMethod: 'standard', membershipShipping: decisionOf(premium, 'standard'), config: cfg({ ordinary_iqd: 5_000 }) }).total_iqd,
    0
  );
});

/* ----------------------- the two paths that reached a non-subscriber, gone */

test('«ألغِ المكافأة تماماً» — no referral waiver anywhere in the checkout', () => {
  assert.ok(
    !/referralFreeDeliveryApplies\s*\(/.test(orders),
    'the checkout must not ask whether a referral waives the delivery'
  );
  assert.ok(
    !/export async function referralFreeDeliveryApplies/.test(membershipOps),
    'and the function that answered it is gone, not merely unused'
  );
  assert.match(
    orders,
    /const independentFreeDelivery = false;/,
    'the engine input stays, held at false, so a future promotion has somewhere to live'
  );
});

test('the REFERRER’s own reward is untouched — a different payment to a different person', () => {
  assert.match(membershipOps, /INSERT INTO referral_rewards[\s\S]{0,200}'printer'/);
  assert.match(membershipOps, /referral_attributions/);
});

test('«الهديه تعطى يدويا» — no automatic printer-gift membership at either milestone', () => {
  assert.ok(
    !/grantPrinterGiftIfEligible\(c\.env/.test(orders),
    'placing an order must not mint a membership — least of all an unpaid cash order'
  );
  assert.ok(
    !/grantPrinterGiftIfEligible\(c\.env/.test(admin),
    'and neither must marking it delivered'
  );
  assert.match(
    membershipOps,
    /export async function grantPrinterGiftIfEligible/,
    'the grant itself survives, idempotent, for a person to call deliberately'
  );
});

test('the manual path the gift now goes through still exists', () => {
  const memberships = readFileSync(join(ROOT, 'worker/routes/memberships.ts'), 'utf8');
  assert.match(memberships, /\/admin\/grant/, 'an administrator can still grant a membership by hand');
  const adminUi = readFileSync(join(ROOT, 'src/components/adminMemberships/actions.tsx'), 'utf8');
  assert.match(adminUi, /\/api\/memberships\/admin\/grant/, 'and the admin screen calls it');
});
