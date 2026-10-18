/**
 * THE BUNDLE PRICE — docs/BUNDLES_MYSTERY.md §4.2–§4.4, as amended by DECISIONS row 250.
 *
 * The owner's decision of 2026-10-18: a bundle or a mystery box is priced like
 * an ordinary product. Its price is the product row's own (the Pricing V2
 * write's), resolved by the untouched `resolveUnitPrice`; the old dinar rule of
 * `bundle_config` — a discount derived from the live component total, a typed
 * PLUS rung, a dinar floor — prices nothing any more. What still carries money
 * here:
 *
 *   1. THE ROW'S OWN LADDER, CLAMPED: a member price (a configured benefit or
 *      the PRO policy) is never above the regular price.
 *   2. THE SAVING IS STATED, NEVER NEGATIVE: against the components' total.
 *   3. THE FEES THE RESOLVER COMPUTED SURVIVE, outside merchandise.
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

test('DECISIONS row 250: a derived rule prices nothing — the bundle charges its own row price, whatever bundle_config says', () => {
  for (const cfg of [
    config({ price_mode: 'discount_percent', discount_percent: 20 }),
    config({ price_mode: 'discount_iqd', discount_iqd: 200_000, min_price_iqd: 1000 }),
    config({ price_mode: 'discount_percent', discount_percent: 200 }),
  ]) {
    const out = resolveBundlePrice({ resolved: resolved('free', false), config: cfg, componentTotalIqd: 200_000, tier: 'free', tierActive: false });
    assert.equal(out.bundle_price_iqd, 145_000, `${cfg.price_mode}: the row's own price`);
    assert.equal(out.regular_iqd, 145_000);
    assert.equal(out.discount_iqd, 55_000, 'the saving is stated against the parts');
    assert.deepEqual(out.errors, [], 'the retired rule neither refuses nor repairs anything');
  }
});

test('the member ladder is the row\'s own, clamped: a PRO is never charged more than a regular buyer', () => {
  // Stored regular 145,000 with a 30% store-wide PRO policy → a PRO price of 101,500.
  const base = resolveUnitPrice({
    product: bundleRow() as never,
    tier: 'pro',
    tierActive: true,
    proPolicy: { mode: 'global_percent', percent: 30 },
  });
  assert.equal(base.pro_iqd, 101_500, 'the resolver’s own PRO price');
  const out = resolveBundlePrice({
    resolved: base,
    config: config({ price_mode: 'discount_percent', discount_percent: 50 }),
    componentTotalIqd: 80_000,
    tier: 'pro',
    tierActive: true,
  });
  assert.equal(out.regular_iqd, 145_000);
  assert.ok(out.pro_iqd !== null && out.pro_iqd <= out.regular_iqd, 'a PRO is never charged more than a regular buyer');
  assert.equal(out.bundle_price_iqd, 101_500);
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

test('DECISIONS row 250: a typed PLUS price prices nothing — a PLUS or PRIME member with no member price pays the regular price', () => {
  const cfg = config({ plus_price_iqd: 130_000 });
  for (const tier of ['plus', 'prime'] as Tier[]) {
    const out = resolveBundlePrice({ resolved: resolved(tier, true), config: cfg, componentTotalIqd: 190_000, tier, tierActive: true });
    assert.equal(out.bundle_price_iqd, 145_000, `${tier}: the retired PLUS rung still priced the bundle`);
    assert.equal(out.plus_iqd, null);
    assert.equal(out.applied_tier, 'regular');
  }
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
