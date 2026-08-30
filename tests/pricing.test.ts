/**
 * Unit tests for the central price resolver (worker/lib/pricing.ts).
 * Run: npm run test:unit   (tsx --test tests/)
 * These pin the mandate §5 semantics: per-field null-inheritance
 * color→option→base, zero-as-explicit, PRO rules, fee composition.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice, DEFAULT_PRO_POLICY } from '../worker/lib/pricing';
import type { PricingProduct, OptionV2, ColorV2 } from '../worker/lib/pricing';

const baseOption = (over: Partial<OptionV2> = {}): OptionV2 => ({
  id: 'opt1', name_ar: 'خيار', name_en: 'Option', name_ckb: '', image: '', order: 0, active: true,
  regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, ...over,
});

const baseColor = (over: Partial<ColorV2> = {}): ColorV2 => ({
  id: 'col1', name_ar: 'أسود', name_en: 'Black', name_ckb: '', hex: '#000000', image: '',
  option_id: null, order: 0, active: true,
  regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, ...over,
});

const product = (over: Partial<PricingProduct> = {}): PricingProduct => {
  const selling_type = over.selling_type ?? 'direct_sale';
  return {
    price_iqd: 100_000, pro_price_iqd: null, prime_price_iqd: null, product_cost_iqd: 60_000,
    options: [], colors: [], preorder_transports: [], warranty_plans: [],
    ...over,
    selling_type,
    // Mirrors the model default: sale_types follows the scalar unless the
    // test sets it explicitly.
    sale_types: over.sale_types ?? [selling_type as 'direct_sale' | 'pre_order' | 'bundle'],
  };
};

const free = { tier: 'free' as const, tierActive: false };
const pro = { tier: 'pro' as const, tierActive: true };
const prime = { tier: 'prime' as const, tierActive: true };

test('base price applies with no selections', () => {
  const r = resolveUnitPrice({ product: product(), ...free });
  assert.equal(r.applied_iqd, 100_000);
  assert.equal(r.price_source, 'base');
  assert.deepEqual(r.errors, []);
});

test('option regular price REPLACES base', () => {
  const p = product({ options: [baseOption({ regular_price_iqd: 120_000 })] });
  const r = resolveUnitPrice({ product: p, optionId: 'opt1', ...free });
  assert.equal(r.applied_iqd, 120_000);
  assert.equal(r.price_source, 'option');
});

test('color overrides option overrides base — per field', () => {
  const p = product({
    options: [baseOption({ regular_price_iqd: 120_000, prime_price_iqd: 115_000 })],
    colors: [baseColor({ regular_price_iqd: 130_000 })], // prime null → inherits the option's 115k
  });
  const r = resolveUnitPrice({ product: p, optionId: 'opt1', colorId: 'col1', ...free });
  assert.equal(r.applied_iqd, 130_000);
  assert.equal(r.price_source, 'color');
  assert.equal(r.prime_iqd, 115_000); // per-field inheritance, not whole-object replacement
});

test('zero is an explicit price, not inherit', () => {
  const p = product({ options: [baseOption({ regular_price_iqd: 0 })] });
  const r = resolveUnitPrice({ product: p, optionId: 'opt1', ...free });
  assert.equal(r.applied_iqd, 0);
});

test('PRO pays explicit PRO price; never above regular', () => {
  const p = product({ pro_price_iqd: 90_000 });
  const r = resolveUnitPrice({ product: p, ...pro });
  assert.equal(r.applied_iqd, 90_000);
  assert.equal(r.applied_tier, 'pro');
  // Misconfigured PRO above regular clamps to regular:
  const bad = product({ pro_price_iqd: 120_000 });
  assert.equal(resolveUnitPrice({ product: bad, ...pro }).applied_iqd, 100_000);
});

test('no explicit PRO price + explicit_only policy = NO fabricated discount', () => {
  const r = resolveUnitPrice({ product: product(), ...pro, proPolicy: DEFAULT_PRO_POLICY });
  assert.equal(r.applied_iqd, 100_000);
  assert.equal(r.applied_tier, 'regular');
  assert.equal(r.pro_iqd, null);
});

test('global_percent policy applies when configured', () => {
  const r = resolveUnitPrice({ product: product(), ...pro, proPolicy: { mode: 'global_percent', percent: 10 } });
  assert.equal(r.applied_iqd, 90_000);
  assert.equal(r.applied_tier, 'pro');
});

// --------------------------------------------------------- LEVO PRIME (§5)

test('PRIME pays the explicit PRIME price', () => {
  const p = product({ prime_price_iqd: 95_000 });
  const r = resolveUnitPrice({ product: p, ...prime });
  assert.equal(r.applied_iqd, 95_000);
  assert.equal(r.applied_tier, 'prime');
});

test('no explicit PRIME price = regular, never a fabricated discount', () => {
  const r = resolveUnitPrice({ product: product(), ...prime });
  assert.equal(r.applied_iqd, 100_000);
  assert.equal(r.applied_tier, 'regular');
  assert.equal(r.prime_iqd, null);
});

test('PRIME has no store-wide percent policy — the PRO policy never leaks to it', () => {
  const r = resolveUnitPrice({ product: product(), ...prime, proPolicy: { mode: 'global_percent', percent: 10 } });
  assert.equal(r.applied_iqd, 100_000);
  assert.equal(r.applied_tier, 'regular');
});

test('price ladder PRO <= PRIME <= Regular is enforced at resolve time', () => {
  // PRIME above regular clamps down to regular.
  assert.equal(resolveUnitPrice({ product: product({ prime_price_iqd: 120_000 }), ...prime }).prime_iqd, 100_000);
  // PRIME below PRO would invert the ladder — it clamps UP to the PRO price.
  const inverted = product({ pro_price_iqd: 90_000, prime_price_iqd: 80_000 });
  assert.equal(resolveUnitPrice({ product: inverted, ...prime }).prime_iqd, 90_000);
  assert.equal(resolveUnitPrice({ product: inverted, ...prime }).applied_iqd, 90_000);
});

test('precedence: an active PRO member takes the PRO price even when PRIME is cheaper on paper', () => {
  const p = product({ pro_price_iqd: 85_000, prime_price_iqd: 92_000 });
  const r = resolveUnitPrice({ product: p, ...pro });
  assert.equal(r.applied_tier, 'pro');
  assert.equal(r.applied_iqd, 85_000);
});

test('an inactive PRIME membership pays the regular price', () => {
  const p = product({ prime_price_iqd: 95_000 });
  const r = resolveUnitPrice({ product: p, tier: 'prime', tierActive: false });
  assert.equal(r.applied_iqd, 100_000);
  assert.equal(r.applied_tier, 'regular');
});

test('PRIME does NOT inherit the PRO preorder-commission waiver', () => {
  const p = product({
    selling_type: 'pre_order',
    sale_types: ['pre_order'],
    preorder_transports: [{ method: 'sea', commission_iqd: 15_000, active: true }],
  });
  const r = resolveUnitPrice({ product: p, transportMethod: 'sea', ...prime });
  assert.equal(r.transport?.waived, false);
  assert.equal(r.unit_subtotal_iqd, 115_000);
});

test('a product offering both direct sale and pre-order does not force a transport choice', () => {
  const p = product({
    selling_type: 'direct_sale',
    sale_types: ['direct_sale', 'pre_order'],
    preorder_transports: [{ method: 'sea', commission_iqd: 15_000, active: true }],
  });
  // Buying it directly: no transport required, none charged.
  const direct = resolveUnitPrice({ product: p, ...free });
  assert.deepEqual(direct.errors, []);
  assert.equal(direct.unit_subtotal_iqd, 100_000);
  // Choosing pre-order: the commission applies.
  const pre = resolveUnitPrice({ product: p, transportMethod: 'sea', ...free });
  assert.deepEqual(pre.errors, []);
  assert.equal(pre.unit_subtotal_iqd, 115_000);
});

test('linked color rejected with the wrong option', () => {
  const p = product({
    options: [baseOption(), baseOption({ id: 'opt2' })],
    colors: [baseColor({ option_id: 'opt2' })],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'opt1', colorId: 'col1', ...free });
  assert.ok(r.errors.includes('COLOR_OPTION_MISMATCH'));
});

test('preorder requires a transport; commission ADDED for non-PRO', () => {
  const p = product({
    selling_type: 'pre_order',
    preorder_transports: [{ method: 'sea', commission_iqd: 15_000, active: true }],
  });
  const missing = resolveUnitPrice({ product: p, ...free });
  assert.ok(missing.errors.includes('TRANSPORT_REQUIRED'));
  const r = resolveUnitPrice({ product: p, transportMethod: 'sea', ...free });
  assert.equal(r.unit_subtotal_iqd, 115_000);
  assert.equal(r.transport?.waived, false);
});

test('PRO waives the preorder commission but NEVER the warranty fee', () => {
  const p = product({
    selling_type: 'pre_order',
    preorder_transports: [{ method: 'air', commission_iqd: 25_000, active: true }],
    warranty_plans: [{
      id: 'w2', title_ar: 'سنتان', title_en: '2 years', title_ckb: '', terms_ar: '', terms_en: '', terms_ckb: '',
      duration_months: 24, duration_kind: 'total', fee_iqd: 20_000, order: 0, active: true,
    }],
  });
  const r = resolveUnitPrice({ product: p, transportMethod: 'air', warrantyPlanId: 'w2', ...pro });
  assert.equal(r.transport?.waived, true);
  assert.equal(r.warranty?.fee_iqd, 20_000);
  assert.equal(r.unit_subtotal_iqd, 100_000 + 0 + 20_000); // no PRO price → regular + waived commission + warranty
});

test('transport commission inherits admin default when null', () => {
  const p = product({
    selling_type: 'pre_order',
    preorder_transports: [{ method: 'land', commission_iqd: null, active: true }],
  });
  const noDefault = resolveUnitPrice({ product: p, transportMethod: 'land', ...free });
  assert.ok(noDefault.errors.includes('TRANSPORT_COMMISSION_UNCONFIGURED'));
  const withDefault = resolveUnitPrice({
    product: p, transportMethod: 'land', ...free,
    transportDefaults: [{ method: 'land', commission_iqd: 10_000 }],
  });
  assert.equal(withDefault.unit_subtotal_iqd, 110_000);
});

test('transport on a direct-sale product is rejected', () => {
  const r = resolveUnitPrice({ product: product(), transportMethod: 'air', ...free });
  assert.ok(r.errors.includes('TRANSPORT_NOT_APPLICABLE'));
});

test('inactive option/color rejected server-side', () => {
  const p = product({ options: [baseOption({ active: false })] });
  const r = resolveUnitPrice({ product: p, optionId: 'opt1', ...free });
  assert.ok(r.errors.includes('OPTION_INACTIVE'));
});
