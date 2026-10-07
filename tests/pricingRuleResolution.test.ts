/**
 * Most-specific-wins resolution of the owner's two pricing rules — the fixed IQD
 * target profit and the direct-sale premium (owner decisions 3 and 4; master plan
 * v2 §2.3, C34, C40; packages/pricing/src/ruleResolution.ts):
 *
 *     sku > color > option > product > category (nearest ancestor first) > global
 *
 * INHERIT is skipped, BLOCKED stops the walk, and a tie inside one scope takes
 * the maximum with RULE_TIE — so a tie can never lower profit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RULE_AMOUNT_IQD,
  RULE_SCOPE_ORDER,
  isValidRuleAmount,
  resolveRuleAt,
  type PricingRuleKind,
  type PricingRuleRow,
  type RuleResolution,
  type RuleTarget,
} from '../packages/pricing/src/ruleResolution';
import { priceSku } from '../packages/pricing/src/costToPrice';
import { skuComboKey } from '../packages/pricing/src/skuChannel';

const PRODUCT = 'prod_a1';
const COMBO = 'ov_combo';
const PRO_KIT = 'ov_prokit';
const WHITE = 'col_white';
const KEY = skuComboKey({ option_value_ids: [COMBO, PRO_KIT], color_id: WHITE });
const TARGET: RuleTarget = {
  product_id: PRODUCT,
  combo_key: KEY,
  option_value_ids: [COMBO, PRO_KIT],
  color_id: WHITE,
  ancestry: ['cat_printers_fdm', 'cat_printers', 'cat_root'],
};

let seq = 0;
function rule(scope: PricingRuleRow['scope'], amount: number | null, extra: Partial<PricingRuleRow> = {}): PricingRuleRow {
  const kind: PricingRuleKind = extra.kind ?? 'target_profit';
  const productScoped = scope !== 'global' && scope !== 'category';
  return {
    id: extra.id ?? `r${++seq}_${scope}`,
    kind,
    scope,
    catalog_id: scope === 'category' ? (extra.catalog_id ?? 'cat_printers') : null,
    product_id: productScoped ? (extra.product_id ?? PRODUCT) : null,
    scope_id: extra.scope_id ?? (scope === 'sku' ? KEY : scope === 'color' ? WHITE : scope === 'option' ? COMBO : ''),
    state: extra.state ?? (amount == null ? 'BLOCKED' : 'ACTIVE'),
    amount_iqd: amount,
    version: extra.version ?? 1,
    ...(extra.source ? { source: extra.source } : {}),
  };
}

const amountOf = (r: RuleResolution) => (r.status === 'active' ? r.amount_iqd : r.status);
const scopeOf = (r: RuleResolution) => (r.status === 'missing' ? null : r.rule.scope);

test('the order is sku > color > option > product > category > global', () => {
  assert.deepEqual(RULE_SCOPE_ORDER, ['sku', 'color', 'option', 'product', 'category', 'global']);
  const all = [
    rule('global', 100_000),
    rule('category', 150_000),
    rule('product', 200_000),
    rule('option', 250_000),
    rule('color', 260_000),
    rule('sku', 275_000),
  ];
  const expected: Array<[string, number]> = [
    ['sku', 275_000],
    ['color', 260_000],
    ['option', 250_000],
    ['product', 200_000],
    ['category', 150_000],
    ['global', 100_000],
  ];
  // Peel off the most specific rule one at a time: the next one decides.
  for (let i = 0; i < expected.length; i++) {
    const rules = all.filter((r) => !expected.slice(0, i).some(([s]) => s === r.scope));
    const got = resolveRuleAt(rules, 'target_profit', TARGET);
    assert.equal(scopeOf(got), expected[i][0]);
    assert.equal(amountOf(got), expected[i][1]);
  }
  // Order of the input array never matters.
  assert.equal(amountOf(resolveRuleAt([...all].reverse(), 'target_profit', TARGET)), 275_000);
});

test('owner example: product 200,000, A1 Combo variant 250,000, special variant 275,000 — most specific wins', () => {
  const rules = [rule('product', 200_000), rule('option', 250_000, { scope_id: COMBO }), rule('sku', 275_000)];
  assert.equal(amountOf(resolveRuleAt(rules, 'target_profit', TARGET)), 275_000);
  const standalone: RuleTarget = { ...TARGET, combo_key: skuComboKey({ option_value_ids: ['ov_standalone'], color_id: WHITE }), option_value_ids: ['ov_standalone'] };
  assert.equal(amountOf(resolveRuleAt(rules, 'target_profit', standalone)), 200_000, 'the product default for the other model');
  const comboBlack: RuleTarget = { ...TARGET, combo_key: skuComboKey({ option_value_ids: [COMBO], color_id: 'col_black' }), option_value_ids: [COMBO], color_id: 'col_black' };
  assert.equal(amountOf(resolveRuleAt(rules, 'target_profit', comboBlack)), 250_000, 'the Combo rule covers every colour');
});

test('INHERIT is treated as absent; BLOCKED stops the walk', () => {
  const inherit = resolveRuleAt(
    [rule('sku', null, { state: 'INHERIT' }), rule('product', null, { state: 'INHERIT' }), rule('category', 150_000), rule('global', 100_000)],
    'target_profit',
    TARGET
  );
  assert.equal(scopeOf(inherit), 'category');
  assert.equal(amountOf(inherit), 150_000);

  const blocked = resolveRuleAt([rule('product', null, { id: 'held', state: 'BLOCKED' }), rule('category', 150_000), rule('global', 100_000)], 'target_profit', TARGET);
  assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.status === 'blocked');
  assert.equal(blocked.code, 'TARGET_PROFIT_BLOCKED');
  assert.equal(blocked.rule.id, 'held');
  // A more specific ACTIVE rule still decides above a BLOCKED one.
  assert.equal(amountOf(resolveRuleAt([rule('sku', 300_000), rule('product', null)], 'target_profit', TARGET)), 300_000);
  // The premium kind has its own code.
  const premium = resolveRuleAt([rule('product', null, { kind: 'direct_premium' })], 'direct_premium', TARGET);
  assert.ok(premium.status === 'blocked');
  assert.equal(premium.code, 'DIRECT_PREMIUM_BLOCKED');
});

test('a tie inside one scope takes the maximum and reports RULE_TIE; a BLOCKED rule in that scope wins', () => {
  const tie = resolveRuleAt(
    [rule('option', 200_000, { id: 'a', scope_id: COMBO }), rule('option', 250_000, { id: 'b', scope_id: PRO_KIT }), rule('product', 400_000)],
    'target_profit',
    TARGET
  );
  assert.ok(tie.status === 'active');
  assert.equal(tie.amount_iqd, 250_000, 'the higher of the two option rules');
  assert.equal(tie.tie, true);
  assert.equal(tie.rule.id, 'b');
  assert.deepEqual(tie.candidates.map((c) => c.id), ['b', 'a']);
  assert.equal(tie.rule.scope, 'option', 'the option scope decides; the product rule is not reached');

  const equal = resolveRuleAt([rule('option', 200_000, { id: 'z', scope_id: PRO_KIT }), rule('option', 200_000, { id: 'y', scope_id: COMBO })], 'target_profit', TARGET);
  assert.ok(equal.status === 'active');
  assert.equal(equal.rule.id, 'y', 'equal amounts: deterministic (id order)');

  const blockedTie = resolveRuleAt(
    [rule('option', 250_000, { scope_id: COMBO }), rule('option', null, { id: 'hold', scope_id: PRO_KIT, state: 'BLOCKED' })],
    'target_profit',
    TARGET
  );
  assert.ok(blockedTie.status === 'blocked');
  assert.equal(blockedTie.rule.id, 'hold');
  const inheritTie = resolveRuleAt([rule('option', 250_000, { scope_id: COMBO }), rule('option', null, { scope_id: PRO_KIT, state: 'INHERIT' })], 'target_profit', TARGET);
  assert.ok(inheritTie.status === 'active');
  assert.equal(inheritTie.tie, false, 'an INHERIT row is no rule');

  // Through the engine: RULE_TIE is a warning and the price uses the maximum.
  const r = priceSku({
    chain: { base: { source: { supplier_cost: '500', supplier_currency: 'USD', shipping_weight_g: 1000 } } },
    rates: { fx: { USD: { rate: '1500', version: 1, confirmed: true } }, shipping: { CHINA_AIR: { rate: '50000', version: 1, confirmed: true } } },
    channels: ['pre_order_air'],
    target: tie,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues.map((i) => [i.code, i.severity, i.rule_kind]), [['RULE_TIE', 'warning', 'target_profit']]);
  assert.equal(r.channels[0].computed_price_iqd, 800_000 + 250_000);
  assert.equal(r.channels[0].target_rule_id, 'b');
});

test('category rules follow the pinned pricing category, nearest ancestor first; others are ignored', () => {
  const rules = [rule('category', 120_000, { catalog_id: 'cat_root' }), rule('category', 150_000, { catalog_id: 'cat_printers' }), rule('category', 999_000, { catalog_id: 'cat_toys' })];
  const near = resolveRuleAt(rules, 'target_profit', TARGET);
  assert.equal(amountOf(near), 150_000);
  assert.ok(near.status === 'active');
  assert.equal(near.rule.catalog_id, 'cat_printers');
  assert.equal(amountOf(resolveRuleAt(rules, 'target_profit', { ...TARGET, ancestry: ['cat_x', 'cat_root'] })), 120_000);
  assert.equal(resolveRuleAt(rules, 'target_profit', { ...TARGET, ancestry: [] }).status, 'missing', 'no pricing category: no category rule');
  assert.equal(amountOf(resolveRuleAt(rules, 'target_profit', { ...TARGET, ancestry: ['cat_printers', 'cat_printers', 'cat_root'] })), 150_000, 'a repeated ancestor is harmless');
  // A BLOCKED category rule (legacy shapes aside) stops the walk too.
  assert.equal(resolveRuleAt([rule('category', null, { catalog_id: 'cat_printers_fdm', state: 'BLOCKED' }), rule('global', 100_000)], 'target_profit', TARGET).status, 'blocked');
});

test('rules addressed elsewhere never apply: another product, another SKU, another colour, the other kind', () => {
  const rules = [
    rule('product', 999_000, { product_id: 'prod_other' }),
    rule('sku', 999_000, { scope_id: 'o:ov_standalone' }),
    rule('color', 999_000, { scope_id: 'col_black' }),
    rule('option', 999_000, { scope_id: 'ov_standalone' }),
    rule('product', 50_000, { kind: 'direct_premium' }),
    rule('global', 100_000),
  ];
  assert.equal(amountOf(resolveRuleAt(rules, 'target_profit', TARGET)), 100_000);
  assert.equal(amountOf(resolveRuleAt(rules, 'direct_premium', TARGET)), 50_000);
  // The product itself (combo '') is never matched by a SKU or colour rule.
  const productItself: RuleTarget = { product_id: PRODUCT, combo_key: '', option_value_ids: [], color_id: null, ancestry: [] };
  assert.equal(amountOf(resolveRuleAt([rule('sku', 1_000, { scope_id: '' }), rule('color', 2_000, { scope_id: '' }), rule('product', 3_000)], 'target_profit', productItself)), 3_000);
});

test('nothing anywhere → TARGET_PROFIT_MISSING / DIRECT_PREMIUM_MISSING (no invented default)', () => {
  const t = resolveRuleAt([], 'target_profit', TARGET);
  assert.deepEqual(t, { status: 'missing', kind: 'target_profit', code: 'TARGET_PROFIT_MISSING' });
  const p = resolveRuleAt([rule('global', 100_000)], 'direct_premium', TARGET);
  assert.deepEqual(p, { status: 'missing', kind: 'direct_premium', code: 'DIRECT_PREMIUM_MISSING' });
});

test('amounts: a premium of 0 is real; an ACTIVE amount the CHECKs refuse fails closed as BLOCKED, never falls back', () => {
  const zero = resolveRuleAt([rule('product', 0, { kind: 'direct_premium' }), rule('global', 50_000, { kind: 'direct_premium' })], 'direct_premium', TARGET);
  assert.equal(amountOf(zero), 0);
  for (const bad of [0, -1, 1.5, MAX_RULE_AMOUNT_IQD + 1, Number.NaN]) {
    const got = resolveRuleAt([rule('product', bad), rule('global', 100_000)], 'target_profit', TARGET);
    assert.equal(got.status, 'blocked', `target ${bad}`);
  }
  assert.equal(resolveRuleAt([rule('product', -1000, { kind: 'direct_premium' })], 'direct_premium', TARGET).status, 'blocked');
  assert.equal(resolveRuleAt([rule('product', null, { state: 'ACTIVE' })], 'target_profit', TARGET).status, 'blocked', 'ACTIVE without an amount');
  assert.equal(isValidRuleAmount('target_profit', 1), true);
  assert.equal(isValidRuleAmount('target_profit', 0), false);
  assert.equal(isValidRuleAmount('direct_premium', 0), true);
});

test('the deciding row is stamped with id, version, scope and source (dependency stamps of pricing_sku_costs)', () => {
  const got = resolveRuleAt([rule('product', 150_000, { id: 'legacy_1', version: 7, source: 'LEGACY_MIGRATION' })], 'target_profit', TARGET);
  assert.ok(got.status === 'active');
  assert.deepEqual(got.rule, { id: 'legacy_1', version: 7, scope: 'product', scope_id: '', catalog_id: null, source: 'LEGACY_MIGRATION' });
  assert.equal(got.tie, false);
});

test('the SKU combo key is derived from the selection, so a SKU rule never matches on a key that disagrees with it', () => {
  const rules = [rule('sku', 275_000), rule('product', 200_000)];
  // No combo_key given: derived from the option values and colour (in any order).
  const derived: RuleTarget = { product_id: PRODUCT, option_value_ids: [PRO_KIT, COMBO], color_id: WHITE, ancestry: [] };
  assert.equal(amountOf(resolveRuleAt(rules, 'target_profit', derived)), 275_000);
  // Another SKU's selection never picks up this SKU's rule, whatever key a caller pairs with it.
  const other: RuleTarget = { product_id: PRODUCT, option_value_ids: [COMBO], color_id: WHITE, ancestry: [] };
  assert.equal(amountOf(resolveRuleAt(rules, 'target_profit', other)), 200_000);
  assert.throws(() => resolveRuleAt(rules, 'target_profit', { ...other, combo_key: KEY }), /PRICING_INVARIANT/, 'a key that is not the selection is a programming error');
  // A matching key is accepted as a cross-check.
  assert.equal(amountOf(resolveRuleAt(rules, 'target_profit', { ...derived, combo_key: KEY })), 275_000);
});
