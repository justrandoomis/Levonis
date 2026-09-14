/**
 * Unit tests pinning the CONFIRMED shipping rules (final-phase brief §6.3):
 * strict >75,000 threshold, PRO-only, approved-default-address-only,
 * alternate-address ordinary treatment, unconfigured fees honest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productDeliveryFeeIqd, productDeliveryMethodAvailable, quoteShipping } from '../worker/lib/shipping';
import type { ShippingConfig, ShippingItem } from '../worker/lib/shipping';

const cfg = (over: Partial<ShippingConfig> = {}): ShippingConfig => ({
  ordinary_iqd: 5000,
  printer_small_iqd: 25000,
  printer_large_iqd: 50000,
  pro_threshold_iqd: 75000,
  threshold_basis: 'merchandise_after_coupon',
  pro_waiver_covers: 'all',
  prime_threshold_iqd: 150000,
  prime_waiver_covers: 'ordinary_only',
  carton_threshold_spools: 10,
  carton_fee_iqd: 3000,
  printer_advance_required: true,
  protected_iqd: 4000,
  ...over,
});

const ordinary = (qty = 1): ShippingItem => ({ product_id: 'p1', qty, size_class: 'ordinary' });
const spool = (qty: number): ShippingItem => ({ product_id: 'sp', qty, size_class: 'ordinary', is_spool: true });
const printerS = (qty = 1): ShippingItem => ({ product_id: 'pr', qty, size_class: 'printer_small' });

const asFree = { tier: 'free' as const, tierActive: false };
const asPro = { tier: 'pro' as const, tierActive: true };
const asPrime = { tier: 'prime' as const, tierActive: true };

test('ordinary product ships at 5,000 IQD everywhere', () => {
  const q = quoteShipping({ items: [ordinary()], merchandiseIqd: 30000, ...asFree, atApprovedDefaultAddress: false, config: cfg() });
  assert.equal(q.total_iqd, 5000);
});

test('CONFIRMED: exactly 75,000 does NOT qualify; 75,001 does', () => {
  const at75k = quoteShipping({ items: [ordinary()], merchandiseIqd: 75000, ...asPro, atApprovedDefaultAddress: true, config: cfg() });
  assert.equal(at75k.pro_waiver_applied, false);
  assert.equal(at75k.total_iqd, 5000);
  const above = quoteShipping({ items: [ordinary()], merchandiseIqd: 75001, ...asPro, atApprovedDefaultAddress: true, config: cfg() });
  assert.equal(above.pro_waiver_applied, true);
  assert.equal(above.total_iqd, 0);
});

test('CONFIRMED: waiver is PRO-only — free and PLUS tiers never qualify', () => {
  for (const tier of [{ tier: 'free' as const, tierActive: false }, { tier: 'plus' as const, tierActive: true }]) {
    const q = quoteShipping({ items: [ordinary()], merchandiseIqd: 200000, ...tier, atApprovedDefaultAddress: true, config: cfg() });
    assert.equal(q.pro_waiver_applied, false);
    assert.equal(q.total_iqd, 5000);
  }
});

test('CONFIRMED: PRO at an ALTERNATE address is priced as ordinary', () => {
  const q = quoteShipping({ items: [ordinary()], merchandiseIqd: 200000, ...asPro, atApprovedDefaultAddress: false, config: cfg() });
  assert.equal(q.pro_waiver_applied, false);
  assert.equal(q.total_iqd, 5000);
});

test('printer fees per unit by size class; advance due', () => {
  const q = quoteShipping({
    items: [printerS(2), { product_id: 'pl', qty: 1, size_class: 'printer_large' }],
    merchandiseIqd: 50000, ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.equal(q.total_iqd, 2 * 25000 + 50000);
  assert.equal(q.advance_due_iqd, 100000);
});

test('unconfigured printer fee → needs_config, no invented fee', () => {
  const q = quoteShipping({
    items: [printerS()], merchandiseIqd: 50000, ...asFree, atApprovedDefaultAddress: false,
    config: cfg({ printer_small_iqd: null }),
  });
  assert.ok(q.needs_config.includes('printer_small_fee_unconfigured'));
  assert.equal(q.total_iqd, 0); // blocked at checkout, never silently charged
});

test('carton fee only above threshold and only when configured', () => {
  const under = quoteShipping({ items: [spool(10)], merchandiseIqd: 40000, ...asFree, atApprovedDefaultAddress: false, config: cfg() });
  assert.ok(!under.components.some((c) => c.kind === 'carton'));
  const over = quoteShipping({ items: [spool(11)], merchandiseIqd: 44000, ...asFree, atApprovedDefaultAddress: false, config: cfg() });
  assert.ok(over.components.some((c) => c.kind === 'carton' && c.fee_iqd === 3000));
  const unconfigured = quoteShipping({ items: [spool(50)], merchandiseIqd: 200000, ...asFree, atApprovedDefaultAddress: false, config: cfg({ carton_fee_iqd: null }) });
  assert.ok(!unconfigured.components.some((c) => c.kind === 'carton'));
});

test('eligible PRO waiver covers printers under the default assumption (flagged)', () => {
  const q = quoteShipping({ items: [printerS(), ordinary()], merchandiseIqd: 300000, ...asPro, atApprovedDefaultAddress: true, config: cfg() });
  assert.equal(q.total_iqd, 0);
  assert.equal(q.advance_due_iqd, 0);
  assert.ok(q.assumptions.some((a) => a.includes('pro_waiver_covers=all')));
});

test('independent promo free delivery is distinct from the PRO rule', () => {
  const q = quoteShipping({
    items: [ordinary()], merchandiseIqd: 10000, ...asFree, atApprovedDefaultAddress: false,
    independentFreeDelivery: true, config: cfg(),
  });
  assert.equal(q.total_iqd, 0);
  assert.equal(q.pro_waiver_applied, false);
});

// ------------------------------------------------- LEVO PRIME delivery (§5)

test('PRIME: exactly 150,000 does NOT qualify; 150,001 does', () => {
  const at = quoteShipping({
    items: [ordinary()], merchandiseIqd: 150000, primeMerchandiseIqd: 150000,
    ...asPrime, atApprovedDefaultAddress: true, config: cfg(),
  });
  assert.equal(at.prime_waiver_applied, false);
  assert.equal(at.total_iqd, 5000);
  assert.equal(at.waiver_source, 'none');

  const above = quoteShipping({
    items: [ordinary()], merchandiseIqd: 150001, primeMerchandiseIqd: 150001,
    ...asPrime, atApprovedDefaultAddress: true, config: cfg(),
  });
  assert.equal(above.prime_waiver_applied, true);
  assert.equal(above.total_iqd, 0);
  assert.equal(above.waiver_source, 'prime');
  assert.equal(above.waiver_basis_iqd, 150001);
});

test('PRIME is tested on the AFTER coupon-and-points basis, not the gross total', () => {
  // 160,000 of goods, 20,000 of coupon+points → 140,000 → below the threshold.
  const q = quoteShipping({
    items: [ordinary()], merchandiseIqd: 160000, primeMerchandiseIqd: 140000,
    ...asPrime, atApprovedDefaultAddress: true, config: cfg(),
  });
  assert.equal(q.prime_waiver_applied, false);
  assert.equal(q.total_iqd, 5000);
});

test('PRIME does not require the PRO approved-address rule', () => {
  const q = quoteShipping({
    items: [ordinary()], merchandiseIqd: 200000, primeMerchandiseIqd: 200000,
    ...asPrime, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.equal(q.prime_waiver_applied, true);
  assert.equal(q.total_iqd, 0);
});

test('PRIME does NOT waive printer or carton surcharges by default', () => {
  const q = quoteShipping({
    items: [ordinary(), printerS(1), spool(12)],
    merchandiseIqd: 500000, primeMerchandiseIqd: 500000,
    ...asPrime, atApprovedDefaultAddress: true, config: cfg(),
  });
  assert.equal(q.prime_waiver_applied, true);
  // ordinary 5,000 waived; printer 25,000 and carton 3,000 still due.
  assert.equal(q.total_iqd, 28000);
  assert.equal(q.advance_due_iqd, 25000);
});

test('an inactive PRIME membership never qualifies', () => {
  const q = quoteShipping({
    items: [ordinary()], merchandiseIqd: 500000, primeMerchandiseIqd: 500000,
    tier: 'prime', tierActive: false, atApprovedDefaultAddress: true, config: cfg(),
  });
  assert.equal(q.prime_waiver_applied, false);
  assert.equal(q.total_iqd, 5000);
});

test('PRO keeps its own 75,000 threshold and full waiver — PRIME does not change it', () => {
  const q = quoteShipping({
    items: [ordinary(), printerS(1)], merchandiseIqd: 80000,
    ...asPro, atApprovedDefaultAddress: true, config: cfg(),
  });
  assert.equal(q.pro_waiver_applied, true);
  assert.equal(q.waiver_source, 'pro');
  assert.equal(q.total_iqd, 0);
});

// ---------------------------------------------------------------------------
// PROTECTED SHIPPING — the owner's rule list, in order:
//   standard shipping · protected shipping · PRIME free standard ·
//   PRO free standard AND protected.
//
// The point of these tests is the asymmetry between the two memberships. PRO
// is told both are free; PRIME is told the standard fee is free and nothing
// else. A waiver that quietly covered protected for PRIME too would look like
// generosity and read as a pricing bug on every invoice.
// ---------------------------------------------------------------------------

const ordinaryItem: ShippingItem[] = [{ product_id: 'p1', qty: 1, size_class: 'ordinary' }];

const fee = (q: ReturnType<typeof quoteShipping>, kind: string) =>
  q.components.find((c) => c.kind === kind) ?? null;

test('protected shipping is an add-on ON TOP of the standard fee, not instead of it', () => {
  const q = quoteShipping({
    items: ordinaryItem,
    merchandiseIqd: 30000,
    tier: 'free',
    tierActive: false,
    atApprovedDefaultAddress: false,
    protectedDelivery: true,
    config: cfg(),
  });
  assert.equal(fee(q, 'ordinary')?.fee_iqd, 5000);
  assert.equal(fee(q, 'protected')?.fee_iqd, 4000);
  assert.equal(q.total_iqd, 9000);
});

test('not asking for it charges nothing for it', () => {
  const q = quoteShipping({
    items: ordinaryItem,
    merchandiseIqd: 30000,
    tier: 'free',
    tierActive: false,
    atApprovedDefaultAddress: false,
    config: cfg(),
  });
  assert.equal(fee(q, 'protected'), null);
  assert.equal(q.total_iqd, 5000);
});

test('an unpriced protected option is refused honestly, never guessed at', () => {
  const q = quoteShipping({
    items: ordinaryItem,
    merchandiseIqd: 30000,
    tier: 'free',
    tierActive: false,
    atApprovedDefaultAddress: false,
    protectedDelivery: true,
    config: cfg({ protected_iqd: null }),
  });
  assert.equal(fee(q, 'protected'), null);
  assert.equal(q.needs_config.includes('protected_fee_unconfigured'), true);
  assert.equal(q.total_iqd, 5000);
});

test('an eligible PRO pays for neither the standard fee nor the protection', () => {
  const q = quoteShipping({
    items: ordinaryItem,
    merchandiseIqd: 80000, // strictly above 75,000
    tier: 'pro',
    tierActive: true,
    atApprovedDefaultAddress: true,
    protectedDelivery: true,
    config: cfg(),
  });
  assert.equal(fee(q, 'ordinary')?.waived, true);
  assert.equal(fee(q, 'protected')?.waived, true);
  assert.equal(q.total_iqd, 0);
});

test('a PRO below the threshold pays for both, as for any other customer', () => {
  const q = quoteShipping({
    items: ordinaryItem,
    merchandiseIqd: 75000, // 75,000 itself does not qualify
    tier: 'pro',
    tierActive: true,
    atApprovedDefaultAddress: true,
    protectedDelivery: true,
    config: cfg(),
  });
  assert.equal(q.total_iqd, 9000);
});

test('PRIME gets the standard fee free and still pays for protection', () => {
  const q = quoteShipping({
    items: ordinaryItem,
    merchandiseIqd: 200000,
    primeMerchandiseIqd: 200000,
    tier: 'prime',
    tierActive: true,
    atApprovedDefaultAddress: false,
    protectedDelivery: true,
    config: cfg(),
  });
  assert.equal(q.prime_waiver_applied, true);
  assert.equal(fee(q, 'ordinary')?.waived, true);
  assert.equal(fee(q, 'protected')?.waived, false);
  assert.equal(q.total_iqd, 4000);
});

// ------------------------------------------------ per-product delivery rules

test('product delivery tiers use ceil(quantity / step) with integer IQD', () => {
  const rule = { enabled: true, quantity_step: 10, fee_iqd: 5000 };
  for (const [quantity, expected] of [
    [1, 5000], [10, 5000], [11, 10000], [20, 10000],
    [21, 15000], [30, 15000], [31, 20000], [35, 20000],
  ] as const) {
    assert.equal(productDeliveryFeeIqd(quantity, rule), expected, `quantity ${quantity}`);
  }
  assert.equal(productDeliveryFeeIqd(1, { enabled: true, quantity_step: 1, fee_iqd: 50000 }), 50000);
  assert.equal(productDeliveryFeeIqd(5, { enabled: true, quantity_step: 1, fee_iqd: 50000 }), 250000);
  assert.equal(productDeliveryFeeIqd(35, { ...rule, enabled: false }), 0);
});

test('selected product delivery is summed per physical product and quantity', () => {
  const q = quoteShipping({
    items: [
      {
        product_id: 'tiered', qty: 35, size_class: 'ordinary',
        delivery: {
          standard: { enabled: true, quantity_step: 10, fee_iqd: 5000 },
          personal: { enabled: true, quantity_step: 1, fee_iqd: 50000 },
        },
      },
      {
        product_id: 'single', qty: 2, size_class: 'ordinary',
        delivery: {
          standard: { enabled: true, quantity_step: 1, fee_iqd: 3000 },
          personal: { enabled: false, quantity_step: 1, fee_iqd: 0 },
        },
      },
    ],
    deliveryMethod: 'standard', merchandiseIqd: 50000,
    ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.equal(q.total_iqd, 26000); // 20,000 + (2 × 3,000)
  assert.deepEqual(q.components.filter((c) => c.kind === 'product').map((c) => c.product_id), ['tiered', 'single']);
  assert.equal(q.components.some((c) => c.kind === 'ordinary'), false, 'explicit rules must not double-charge legacy delivery');
});

test('a disabled product method is unavailable and never contributes a fee', () => {
  const items: ShippingItem[] = [{
    product_id: 'standard-only', qty: 2, size_class: 'ordinary',
    delivery: {
      standard: { enabled: true, quantity_step: 1, fee_iqd: 5000 },
      personal: { enabled: false, quantity_step: 1, fee_iqd: 50000 },
    },
  }];
  assert.deepEqual(productDeliveryMethodAvailable(items, 'personal'), {
    available: false,
    unavailable_product_ids: ['standard-only'],
  });
  const q = quoteShipping({
    items, deliveryMethod: 'personal', merchandiseIqd: 20000,
    ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.equal(q.total_iqd, 0);
  assert.ok(q.needs_config.includes('product:standard-only:personal_unavailable'));
});

test('legacy products without delivery options keep the existing global tariff', () => {
  const q = quoteShipping({
    items: [ordinary(4)], deliveryMethod: 'standard', merchandiseIqd: 30000,
    ...asFree, atApprovedDefaultAddress: false, config: cfg(),
  });
  assert.equal(q.total_iqd, 5000);
});

test('prime_waiver_covers=all does not reach protected shipping either', () => {
  // The knob is about the printer and carton SURCHARGES in a mixed cart. It is
  // not a licence to hand PRIME a benefit the owner listed under PRO.
  const q = quoteShipping({
    items: ordinaryItem,
    merchandiseIqd: 200000,
    primeMerchandiseIqd: 200000,
    tier: 'prime',
    tierActive: true,
    atApprovedDefaultAddress: false,
    protectedDelivery: true,
    config: cfg({ prime_waiver_covers: 'all' }),
  });
  assert.equal(fee(q, 'protected')?.waived, false);
  assert.equal(q.total_iqd, 4000);
});

test('an approved promotion covers protection the same way it covers delivery', () => {
  const q = quoteShipping({
    items: ordinaryItem,
    merchandiseIqd: 10000,
    tier: 'free',
    tierActive: false,
    atApprovedDefaultAddress: false,
    independentFreeDelivery: true,
    protectedDelivery: true,
    config: cfg(),
  });
  assert.equal(q.total_iqd, 0);
});
