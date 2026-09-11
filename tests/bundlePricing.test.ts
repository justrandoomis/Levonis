/**
 * THE BUNDLE PRICE — docs/BUNDLES_MYSTERY.md §4.2–§4.4.
 *
 * Case 8 of the owner's seventeen ("no negative total, no invalid stacking"),
 * at the level where the arithmetic actually lives. The three properties that
 * carry money:
 *
 *   1. THE LADDER'S ANCHOR IS THE DERIVED REGULAR PRICE. `resolveUnitPrice`
 *      computes a policy PRO price from the row's STORED regular price and
 *      clamps against the same stored number. In a discount mode the real
 *      regular price comes from the live component total instead, so once the
 *      components get cheaper the derived regular can fall BELOW the stored PRO
 *      price — and a PRO member would be charged more than a regular buyer with
 *      no clamp able to see it. Derive, then clamp.
 *   2. A DERIVED PRICE BELOW THE FLOOR DOES NOT SELL. It is not clamped up and
 *      it is not sold at 0: the offer answers OFFER_INACTIVE and the admin gets
 *      a loud warning. One typed zero must not publish a free bundle.
 *   3. THE PLUS RUNG IS OFFER-SCOPED. `packages/pricing` has three rungs and no
 *      PLUS price; the fourth value exists on the composition block only, and a
 *      PLUS member is never charged more than a PRIME or PRO member.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice, type ResolvedPrice, type Tier } from '../worker/lib/pricing';
import { resolveBundlePrice, type BundlePriceConfig } from '../worker/lib/bundleComposition';

/** The bundle PRODUCT row, priced by the untouched resolver (§4.1). */
const bundleRow = (over: Partial<Record<'price_iqd' | 'prime_price_iqd' | 'pro_price_iqd', number | null>> = {}) => ({
  price_iqd: 145_000,
  prime_price_iqd: null,
  pro_price_iqd: null,
  product_cost_iqd: null,
  selling_type: 'bundle',
  sale_types: ['bundle'],
  options: [],
  colors: [],
  preorder_transports: [],
  warranty_plans: [],
  ...over,
});

const resolved = (tier: Tier, tierActive: boolean, over = {}, proPolicy = undefined): ResolvedPrice =>
  resolveUnitPrice({ product: bundleRow(over) as never, tier, tierActive, proPolicy });

const config = (over: Partial<BundlePriceConfig> = {}): BundlePriceConfig => ({
  price_mode: 'fixed',
  discount_percent: null,
  discount_iqd: null,
  plus_price_iqd: null,
  min_price_iqd: 1,
  ...over,
});

test('fixed mode charges the product row’s own ladder, and states the saving against the component total', () => {
  const out = resolveBundlePrice({
    resolved: resolved('free', false),
    config: config(),
    componentTotalIqd: 190_000,
    tier: 'free',
    tierActive: false,
  });
  assert.equal(out.bundle_price_iqd, 145_000);
  assert.equal(out.component_total_iqd, 190_000);
  assert.equal(out.discount_iqd, 45_000);
  assert.equal(out.saving_percent, 24);
  assert.equal(out.applied_tier, 'regular');
  assert.deepEqual(out.errors, []);
});

test('discount_percent derives the price from the LIVE component total, at every read', () => {
  const out = resolveBundlePrice({
    resolved: resolved('free', false),
    config: config({ price_mode: 'discount_percent', discount_percent: 20 }),
    componentTotalIqd: 200_000,
    tier: 'free',
    tierActive: false,
  });
  assert.equal(out.bundle_price_iqd, 160_000, 'floor(200000 * 80 / 100)');
  assert.equal(out.regular_iqd, 160_000, 'the stored 145,000 is a sort key, not a price');
  assert.equal(out.discount_iqd, 40_000);
});

test('discount_iqd subtracts from the component total', () => {
  const out = resolveBundlePrice({
    resolved: resolved('free', false),
    config: config({ price_mode: 'discount_iqd', discount_iqd: 45_000 }),
    componentTotalIqd: 190_000,
    tier: 'free',
    tierActive: false,
  });
  assert.equal(out.bundle_price_iqd, 145_000);
});

test('a derived price below min_price_iqd REFUSES — it is never clamped up and never sold at 0', () => {
  // A component went free, or an admin typed 200000 for 20000.
  const out = resolveBundlePrice({
    resolved: resolved('free', false),
    config: config({ price_mode: 'discount_iqd', discount_iqd: 200_000, min_price_iqd: 1000 }),
    componentTotalIqd: 190_000,
    tier: 'free',
    tierActive: false,
  });
  assert.ok(out.errors.includes('DERIVED_PRICE_BELOW_FLOOR'));
  assert.ok(out.errors.includes('OFFER_INACTIVE'), 'the sale stops rather than being repaired');
  assert.ok(out.bundle_price_iqd >= 0, 'and never negative');
});

test('the member ladder is anchored on the DERIVED regular price: pro <= prime <= plus <= regular', () => {
  // Stored regular 145,000 with a 30% store-wide PRO policy → a stored PRO
  // price of 101,500. The components then get much cheaper and the derived
  // regular falls to 40,000 — below that stored PRO price.
  const base = resolveUnitPrice({
    product: bundleRow() as never,
    tier: 'pro',
    tierActive: true,
    proPolicy: { mode: 'global_percent', percent: 30 },
  });
  assert.equal(base.pro_iqd, 101_500, 'the resolver’s own PRO price, from the STORED regular');

  const out = resolveBundlePrice({
    resolved: base,
    config: config({ price_mode: 'discount_percent', discount_percent: 50 }),
    componentTotalIqd: 80_000,
    tier: 'pro',
    tierActive: true,
  });
  assert.equal(out.regular_iqd, 40_000);
  assert.ok(out.pro_iqd !== null && out.pro_iqd <= out.regular_iqd, 'a PRO is never charged more than a regular buyer');
  assert.equal(out.bundle_price_iqd, 40_000);
  assert.equal(out.applied_tier, 'pro');
});

test('the whole ladder is ordered for every tier, in both price modes', () => {
  for (const mode of ['fixed', 'discount_percent'] as const) {
    for (const tier of ['free', 'plus', 'prime', 'pro'] as Tier[]) {
      const out = resolveBundlePrice({
        resolved: resolveUnitPrice({
          product: bundleRow({ prime_price_iqd: 130_000, pro_price_iqd: 120_000 }) as never,
          tier,
          tierActive: true,
          proPolicy: { mode: 'global_percent', percent: 10 },
        }),
        config: config({ price_mode: mode, discount_percent: 25, plus_price_iqd: 138_000 }),
        componentTotalIqd: 190_000,
        tier,
        tierActive: true,
      });
      const { pro_iqd: pro, prime_iqd: prime, plus_iqd: plus, regular_iqd: regular } = out;
      assert.ok(pro === null || pro <= regular, `${mode}/${tier}: pro <= regular`);
      assert.ok(prime === null || prime <= regular, `${mode}/${tier}: prime <= regular`);
      assert.ok(plus === null || plus <= regular, `${mode}/${tier}: plus <= regular`);
      if (pro !== null && prime !== null) assert.ok(pro <= prime, `${mode}/${tier}: pro <= prime`);
      if (plus !== null && prime !== null) assert.ok(prime <= plus, `${mode}/${tier}: prime <= plus`);
      assert.ok(out.bundle_price_iqd >= 0, 'never negative');
      assert.ok(out.bundle_price_iqd <= regular, 'a member never pays more than the regular price');
    }
  }
});

test('the PLUS rung applies to active PLUS and every inheriting tier', () => {
  const cfg = config({ plus_price_iqd: 130_000 });
  const plus = resolveBundlePrice({
    resolved: resolved('plus', true),
    config: cfg,
    componentTotalIqd: 190_000,
    tier: 'plus',
    tierActive: true,
  });
  assert.equal(plus.bundle_price_iqd, 130_000);
  assert.equal(plus.applied_tier, 'plus');

  const lapsed = resolveBundlePrice({
    resolved: resolved('plus', false),
    config: cfg,
    componentTotalIqd: 190_000,
    tier: 'plus',
    tierActive: false,
  });
  assert.equal(lapsed.bundle_price_iqd, 145_000, 'an inactive membership pays the regular price');
  assert.equal(lapsed.applied_tier, 'regular');

  // PREMIUM inherits the PLUS rung when no better PREMIUM price is configured.
  const prime = resolveBundlePrice({
    resolved: resolved('prime', true),
    config: cfg,
    componentTotalIqd: 190_000,
    tier: 'prime',
    tierActive: true,
  });
  assert.equal(prime.bundle_price_iqd, 130_000);
  assert.equal(prime.applied_tier, 'prime', 'the inherited price is presented as the member’s PREMIUM tier');
});

test('a PRO away from the approved default address pays the regular price (tierActive is the context, not the tier)', () => {
  const away = resolveBundlePrice({
    resolved: resolveUnitPrice({
      product: bundleRow({ pro_price_iqd: 100_000 }) as never,
      tier: 'pro',
      tierActive: false, // pricingTierContext(...).pricingTierActive
    }),
    config: config(),
    componentTotalIqd: 190_000,
    tier: 'pro',
    tierActive: false,
  });
  assert.equal(away.bundle_price_iqd, 145_000);
  assert.equal(away.applied_tier, 'regular');
});

test('a bundle that costs more than its parts states a zero saving rather than a negative one', () => {
  const out = resolveBundlePrice({
    resolved: resolved('free', false),
    config: config(),
    componentTotalIqd: 100_000,
    tier: 'free',
    tierActive: false,
  });
  assert.equal(out.discount_iqd, 0);
  assert.equal(out.saving_percent, 0);
});

test('the fees the resolver computed survive, and merchandise never includes them', () => {
  // A pre-order bundle: the components' commissions ride on the parent's
  // unit_subtotal while `merchandise` stays exactly the bundle price (§2.2).
  const out = resolveBundlePrice({
    resolved: resolved('free', false),
    config: config(),
    componentTotalIqd: 190_000,
    tier: 'free',
    tierActive: false,
    componentFeesIqd: 12_000,
  });
  assert.equal(out.bundle_price_iqd, 145_000, 'merchandise');
  assert.equal(out.unit_subtotal_iqd, 157_000, 'what the line costs');
});

test('an out-of-range discount percent is reported, never silently repaired into a sale', () => {
  const out = resolveBundlePrice({
    resolved: resolved('free', false),
    config: config({ price_mode: 'discount_percent', discount_percent: 200 }),
    componentTotalIqd: 190_000,
    tier: 'free',
    tierActive: false,
  });
  assert.ok(out.errors.includes('BUNDLE_VALIDATION'));
});
