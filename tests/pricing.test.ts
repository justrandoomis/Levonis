/**
 * Unit tests for the central price resolver (worker/lib/pricing.ts).
 * Run: npm run test:unit   (tsx --test tests/)
 * These pin the mandate §5 semantics: per-field null-inheritance
 * color→option→base, zero-as-explicit, PRO rules, fee composition.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice, DEFAULT_PRO_POLICY } from '../worker/lib/pricing';
import { validateProductDoc } from '../worker/lib/productModel';
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

test('color overrides option overrides base — per field, and a colour surcharge reaches the member price', () => {
  const p = product({
    options: [baseOption({ regular_price_iqd: 120_000, prime_price_iqd: 115_000 })],
    colors: [baseColor({ regular_price_iqd: 130_000 })], // prime null → the option's 115k PLUS this colour's +10k
  });
  const r = resolveUnitPrice({ product: p, optionId: 'opt1', colorId: 'col1', ...free });
  assert.equal(r.applied_iqd, 130_000);
  assert.equal(r.price_source, 'color');
  // Per-field inheritance, not whole-object replacement — and the colour is an
  // additional cost for every tier: 115,000 + (130,000 − 120,000).
  assert.equal(r.prime_iqd, 125_000);
});

// ------------------------- the owner's rule: surcharges are paid by every tier

test("OWNER: options, colours and availability are additional costs for every tier", () => {
  // Regular 150,000 / PRIME 125,000 / PRO 100,000. Option 2 adds 25,000 →
  // 175,000 / 150,000 / 125,000. Direct sale adds 100,000 on top →
  // 275,000 / 250,000 / 225,000.
  const p = product({
    price_iqd: 150_000,
    prime_price_iqd: 125_000,
    pro_price_iqd: 100_000,
    direct_surcharge_iqd: 100_000,
    options: [baseOption({ id: 'opt2', regular_adjust_iqd: 25_000 })],
  });
  const at = (tier: 'free' | 'prime' | 'pro') =>
    resolveUnitPrice({ product: p, optionId: 'opt2', tier, tierActive: tier !== 'free' });
  assert.equal(at('free').regular_iqd, 175_000);
  assert.equal(at('prime').prime_iqd, 150_000);
  assert.equal(at('pro').pro_iqd, 125_000);
  assert.deepEqual([at('free').applied_iqd, at('prime').applied_iqd, at('pro').applied_iqd], [175_000, 150_000, 125_000]);
  // The direct-sale premium is added after the tier price, for every tier.
  assert.deepEqual(
    [at('free').unit_subtotal_iqd, at('prime').unit_subtotal_iqd, at('pro').unit_subtotal_iqd],
    [275_000, 250_000, 225_000]
  );
});

test('OWNER: a FIXED option price is the same surcharge as an adjustment of the same size', () => {
  const adj = product({ price_iqd: 150_000, prime_price_iqd: 125_000, pro_price_iqd: 100_000, options: [baseOption({ regular_adjust_iqd: 25_000 })] });
  const fixed = product({ price_iqd: 150_000, prime_price_iqd: 125_000, pro_price_iqd: 100_000, options: [baseOption({ regular_price_iqd: 175_000 })] });
  for (const tier of ['free', 'prime', 'pro'] as const) {
    const a = resolveUnitPrice({ product: adj, optionId: 'opt1', tier, tierActive: tier !== 'free' });
    const f = resolveUnitPrice({ product: fixed, optionId: 'opt1', tier, tierActive: tier !== 'free' });
    assert.equal(a.applied_iqd, f.applied_iqd, tier);
  }
});

test('OWNER: a rung that states its own member price replaces the carried one; an adjustment applies on top of it', () => {
  const own = product({ price_iqd: 150_000, pro_price_iqd: 100_000, options: [baseOption({ regular_adjust_iqd: 25_000, pro_price_iqd: 110_000 })] });
  assert.equal(resolveUnitPrice({ product: own, optionId: 'opt1', ...pro }).pro_iqd, 110_000, 'stated: 110,000, not 125,000');
  const more = product({ price_iqd: 150_000, pro_price_iqd: 100_000, options: [baseOption({ regular_adjust_iqd: 25_000, pro_adjust_iqd: -5_000 })] });
  assert.equal(resolveUnitPrice({ product: more, optionId: 'opt1', ...pro }).pro_iqd, 120_000, '100,000 + 25,000 − 5,000');
});

test('OWNER: a colour surcharge stacks on the option surcharge for every tier', () => {
  const p = product({
    price_iqd: 150_000, prime_price_iqd: 125_000, pro_price_iqd: 100_000,
    options: [baseOption({ regular_adjust_iqd: 25_000 })],
    colors: [baseColor({ regular_adjust_iqd: 10_000 })],
  });
  const r = (tier: 'free' | 'prime' | 'pro') => resolveUnitPrice({ product: p, optionId: 'opt1', colorId: 'col1', tier, tierActive: tier !== 'free' }).applied_iqd;
  assert.deepEqual([r('free'), r('prime'), r('pro')], [185_000, 160_000, 135_000]);
});

test('a reduction that swallows the member price leaves the member paying the reduced regular price', () => {
  // Base PRO 90,000; an option 100,000 cheaper than the base. There is no
  // PRO price left to carry — the member pays the (already reduced) regular.
  const p = product({ price_iqd: 100_000, pro_price_iqd: 90_000, options: [baseOption({ regular_price_iqd: 0 })] });
  const r = resolveUnitPrice({ product: p, optionId: 'opt1', ...pro });
  assert.equal(r.pro_iqd, null);
  assert.equal(r.applied_iqd, 0);
  assert.equal(r.applied_tier, 'regular');
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

// ===================================================================
// §5 WRITE-TIME RULES — the resolver above clamps; the validator REFUSES.
//
//   "لا تنسخ تكلفة المنتج إلى سعر البيع أو العكس."
//   "يجب أن يختلف سعر البيع عن التكلفة. امنع الحفظ مع رسالة واضحة إذا تساويا."
//   "عند إدخال أسعار العضويات يجب أن يكون: PRO <= PRIME <= Regular"
//
// A clamp is not a refusal. resolveUnitPrice() will happily sell a product
// whose price field holds its cost, because at read time it has no way to
// know the two were meant to differ. The block has to happen on save, with a
// message the admin can act on — which is what §5 asks for in as many words.

const doc = (over: Record<string, unknown> = {}) => ({
  name_en: 'Rule Fixture',
  price_iqd: 100_000,
  ...over,
});
/** The thrown message, or '' when the call was accepted. */
const refusal = (body: Record<string, unknown>): string => {
  try {
    validateProductDoc(body);
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

test('a selling price equal to the cost is REFUSED, not silently accepted', () => {
  const why = refusal(doc({ price_iqd: 100_000, product_cost_iqd: 100_000 }));
  assert.match(why, /price_iqd/);
  assert.match(why, /must not equal the cost/);
});

test('the refusal says what to do about it', () => {
  // "امنع الحفظ مع رسالة واضحة" — a clear message, not just a code.
  const why = refusal(doc({ price_iqd: 100_000, product_cost_iqd: 100_000 }));
  assert.match(why, /set a selling price above the cost, or clear the cost/);
});

test('a price merely CLOSE to the cost is fine — only equality is the tell', () => {
  assert.equal(refusal(doc({ price_iqd: 100_001, product_cost_iqd: 100_000 })), '');
  assert.equal(refusal(doc({ price_iqd: 99_999, product_cost_iqd: 100_000 })), '');
});

test('no cost at all is not a violation', () => {
  assert.equal(refusal(doc({ price_iqd: 100_000, product_cost_iqd: null })), '');
  assert.equal(refusal(doc({ price_iqd: 100_000 })), '');
});

test('an OPTION that sells at its own cost is refused, and named', () => {
  const why = refusal(
    doc({
      options: [{ id: 'o1', name_en: 'Bundle', regular_price_iqd: 50_000, cost_iqd: 50_000 }],
    })
  );
  assert.match(why, /options\.o1\.price_iqd/);
  assert.match(why, /must not equal the cost/);
});

test('a COLOUR that sells at its own cost is refused, and named', () => {
  const why = refusal(
    doc({
      colors: [{ id: 'c1', name_en: 'Black', hex: '#000000', regular_price_iqd: 50_000, cost_iqd: 50_000 }],
    })
  );
  assert.match(why, /colors\.c1\.price_iqd/);
});

test('PRIME above the regular price is refused at write time', () => {
  const why = refusal(doc({ price_iqd: 100_000, prime_price_iqd: 120_000 }));
  assert.match(why, /prime_price_iqd/);
  assert.match(why, /PRO <= PRIME <= Regular/);
});

test('PRO above PRIME is refused — the PRIME discount is the smaller one', () => {
  const why = refusal(doc({ price_iqd: 100_000, prime_price_iqd: 90_000, pro_price_iqd: 95_000 }));
  assert.match(why, /pro_price_iqd/);
  assert.match(why, /must not be above PRIME/);
});

test('the legal ladder PRO <= PRIME <= Regular saves', () => {
  assert.equal(refusal(doc({ price_iqd: 100_000, prime_price_iqd: 95_000, pro_price_iqd: 90_000 })), '');
  // Equal rungs are legal: a product may simply not discount for a tier.
  assert.equal(refusal(doc({ price_iqd: 100_000, prime_price_iqd: 100_000, pro_price_iqd: 100_000 })), '');
});

test("an option's ladder is checked against the price actually in force", () => {
  // The option has no regular price of its own, so it sells at the product's
  // 100,000 — a 120,000 PRIME on it is still above what the customer pays.
  const why = refusal(doc({ price_iqd: 100_000, options: [{ id: 'o1', name_en: 'X', prime_price_iqd: 120_000 }] }));
  assert.match(why, /options\.o1\.prime_price_iqd/);
  // With its own higher regular price it is perfectly legal.
  assert.equal(
    refusal(doc({ price_iqd: 100_000, options: [{ id: 'o1', name_en: 'X', regular_price_iqd: 130_000, prime_price_iqd: 120_000 }] })),
    ''
  );
});

test('a membership price equal to the cost is refused too', () => {
  assert.match(refusal(doc({ price_iqd: 100_000, prime_price_iqd: 60_000, product_cost_iqd: 60_000 })), /prime_price_iqd/);
  assert.match(refusal(doc({ price_iqd: 100_000, pro_price_iqd: 60_000, product_cost_iqd: 60_000 })), /pro_price_iqd/);
});

test('the rule survives the resolver: a saved doc always prices above its cost', () => {
  // End to end — validate, then resolve, and assert the sale price and the
  // cost the resolver reports are genuinely different numbers.
  const body = doc({ price_iqd: 100_000, prime_price_iqd: 95_000, pro_price_iqd: 90_000, product_cost_iqd: 60_000 });
  const validated = validateProductDoc(body);
  const p = product({
    price_iqd: validated.price_iqd,
    prime_price_iqd: validated.prime_price_iqd,
    pro_price_iqd: validated.pro_price_iqd,
    product_cost_iqd: validated.product_cost_iqd,
  });
  // Every tier, not just one: the rule is that NO customer buys at cost.
  // 'free' is the ordinary signed-in customer — the regular price.
  for (const tier of ['free', 'plus', 'prime', 'pro'] as const) {
    const r = resolveUnitPrice({ product: p, tier, tierActive: tier !== 'free' });
    assert.notEqual(r.applied_iqd, r.cost_iqd, `${tier} sells at exactly the cost`);
    assert.ok((r.cost_iqd ?? 0) < r.applied_iqd, `${tier}: ${r.cost_iqd} !< ${r.applied_iqd}`);
  }
});

// ------------------------------------------- the validators know the rule too

test('OWNER: the validator refuses a reduction that swallows an inherited member price', async () => {
  const { validateProductDoc } = await import('../worker/lib/productModel');
  const body = (option: Record<string, unknown>) => ({
    name_ar: 'منتج', name_en: 'P', price_iqd: 100_000, pro_price_iqd: 90_000, selling_type: 'direct_sale',
    options: [{ id: 'o1', name_ar: 'خيار', name_en: 'O', ...option }],
  });
  // −95,000 on a 90,000 PRO price: the row still sells at 5,000 but there is
  // no PRO price left to carry → refused…
  assert.throws(() => validateProductDoc(body({ regular_adjust_iqd: -95_000 })), /reduction on this row is larger than the PRO price/);
  // …unless the row states its own PRO price…
  assert.doesNotThrow(() => validateProductDoc(body({ regular_adjust_iqd: -95_000, pro_price_iqd: 4_000 })));
  // (a row reduced to a FREE item has nothing to discount — not a refusal)
  assert.doesNotThrow(() => validateProductDoc(body({ regular_adjust_iqd: -100_000 })));
  // …and a plain surcharge is always fine.
  assert.doesNotThrow(() => validateProductDoc(body({ regular_adjust_iqd: 25_000 })));
  // A member adjustment that lifts PRO above the row's regular price is refused.
  assert.throws(() => validateProductDoc(body({ regular_adjust_iqd: 25_000, pro_adjust_iqd: 50_000 })), /PRO price this row resolves to/);
});
