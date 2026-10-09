/**
 * THE MINIMUM PROFIT CARRIES ITS CURRENCY (owner brief 2026-10-09; USD design
 * §2.2, §4.1; packages/pricing/src/ruleResolution.ts).
 *
 *   - a minimum profit is a USD amount (≤ 2 dp, 0 < x ≤ 100,000) or, migrated
 *     and not yet converted, whole dinars — never both; the Direct Sale Extra
 *     is never USD;
 *   - inheritance is unchanged: most specific wins, INHERIT is skipped,
 *     BLOCKED stops, an invalid amount is BLOCKED (never skipped);
 *   - a tie inside one scope ranks by the EXACT dinar figure at U
 *     (amount_usd × U, or the dinar amount) — so the same two rules can rank
 *     differently at two rates — and a USD row with no U to rank it ranks
 *     first (the price then needs the rate it lacks and is refused, never
 *     lowered);
 *   - the owner's typed amount is normalised (Arabic-Indic digits, a decimal
 *     comma, '120.50' → '120.5'), and an ambiguous '1,200' is refused.
 *
 * Run: node --import tsx --test tests/pricingRuleResolutionUsd.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalUsdRuleAmount,
  isValidRuleRowAmount,
  parseUsdRuleAmount,
  resolveRuleAt,
  targetProfitExactIqd,
  type PricingRuleRow,
  type RuleResolution,
  type RuleTarget,
} from '../packages/pricing/src/ruleResolution';
import { procurementExactText } from '../packages/contracts/src/procurementCost';

const PRODUCT = 'p_usd';
const A = 'ov_a';
const B = 'ov_b';
const TARGET: RuleTarget = { product_id: PRODUCT, option_value_ids: [A, B], color_id: null, ancestry: [] };

let seq = 0;
function rule(scope: PricingRuleRow['scope'], amount: { usd?: string; iqd?: number }, extra: Partial<PricingRuleRow> = {}): PricingRuleRow {
  return {
    id: extra.id ?? `r${++seq}`,
    kind: extra.kind ?? 'target_profit',
    scope,
    catalog_id: null,
    product_id: PRODUCT,
    scope_id: extra.scope_id ?? (scope === 'option' ? A : ''),
    state: extra.state ?? 'ACTIVE',
    amount_iqd: amount.iqd ?? null,
    amount_usd: amount.usd ?? null,
    version: 1,
    ...(extra.source ? { source: extra.source } : {}),
  };
}

const active = (r: RuleResolution) => {
  assert.equal(r.status, 'active', JSON.stringify(r));
  return r as Extract<RuleResolution, { status: 'active' }>;
};

test('a USD minimum at the option level beats a migrated dinar minimum at the product level; INHERIT is skipped; BLOCKED stops', () => {
  const product = rule('product', { iqd: 150_000 }, { source: 'LEGACY_MIGRATION' });
  const option = rule('option', { usd: '120.50' });
  const r = active(resolveRuleAt([product, option], 'target_profit', TARGET));
  assert.equal(r.amount_usd, '120.5', 'canonical text');
  assert.equal(r.amount_iqd, null);
  assert.equal(r.rule.id, option.id);

  const inherit = rule('option', {}, { state: 'INHERIT' });
  const back = active(resolveRuleAt([product, inherit], 'target_profit', TARGET));
  assert.equal(back.amount_iqd, 150_000);
  assert.equal(back.amount_usd ?? null, null);

  const blocked = resolveRuleAt([product, rule('option', {}, { state: 'BLOCKED' })], 'target_profit', TARGET);
  assert.equal(blocked.status, 'blocked');
  assert.equal(resolveRuleAt([], 'target_profit', TARGET).status, 'missing');
});

test('an ACTIVE row with an amount the 0181 CHECKs refuse is BLOCKED, never skipped', () => {
  const product = rule('product', { usd: '50' });
  for (const bad of [{ usd: '0' }, { usd: '120.555' }, { usd: '100000.01' }, { usd: '1e3' }, { usd: '75', iqd: 120_000 }, { iqd: 0 }]) {
    const r = resolveRuleAt([product, rule('option', bad)], 'target_profit', TARGET);
    assert.equal(r.status, 'blocked', JSON.stringify(bad));
  }
  // The Direct Sale Extra never takes a USD amount.
  const extra = resolveRuleAt([rule('product', { usd: '30', iqd: 0 }, { kind: 'direct_sale_extra' })], 'direct_sale_extra', TARGET);
  assert.equal(extra.status, 'blocked');
  const fine = active(resolveRuleAt([rule('product', { iqd: 50_000 }, { kind: 'direct_sale_extra' })], 'direct_sale_extra', TARGET));
  assert.equal(fine.amount_iqd, 50_000);
});

test('a tie between a USD and a dinar row ranks by dinars at U — the same rules rank differently at two rates', () => {
  // Option A: $100; option B: 165,000 IQD (migrated). At U = 1,600, $100 = 160,000 < 165,000; at 1,700, 170,000 > 165,000.
  const usd = rule('option', { usd: '100' }, { id: 'r_usd', scope_id: A });
  const iqd = rule('option', { iqd: 165_000 }, { id: 'r_iqd', scope_id: B, source: 'LEGACY_MIGRATION' });
  const at1600 = active(resolveRuleAt([usd, iqd], 'target_profit', TARGET, { usdIqdRate: '1600' }));
  assert.equal(at1600.rule.id, 'r_iqd');
  assert.equal(at1600.amount_iqd, 165_000);
  assert.equal(at1600.tie, true);
  assert.equal(at1600.ranked_at_usd_iqd, '1600');
  const at1700 = active(resolveRuleAt([usd, iqd], 'target_profit', TARGET, { usdIqdRate: '1700' }));
  assert.equal(at1700.rule.id, 'r_usd');
  assert.equal(at1700.amount_usd, '100');
  assert.deepEqual(at1700.candidates.map((c) => c.id), ['r_usd', 'r_iqd']);
  // No U: the USD row ranks first (fail closed — its price needs the rate it lacks).
  const blind = active(resolveRuleAt([usd, iqd], 'target_profit', TARGET));
  assert.equal(blind.rule.id, 'r_usd');
  assert.equal(blind.ranked_at_usd_iqd ?? null, null);
  // Equal dinars at U: id order decides, deterministically.
  const tieAt1650 = active(resolveRuleAt([usd, iqd], 'target_profit', TARGET, { usdIqdRate: '1650' }));
  assert.equal(tieAt1650.rule.id, 'r_iqd', '165,000 = 165,000: "r_iqd" < "r_usd"');
  // Two USD rows rank by USD at any rate, and record no ranking rate.
  const two = active(resolveRuleAt([usd, rule('option', { usd: '100.01' }, { id: 'r_usd2', scope_id: B })], 'target_profit', TARGET));
  assert.equal(two.rule.id, 'r_usd2');
  assert.equal(two.ranked_at_usd_iqd ?? null, null);
});

test('targetProfitExactIqd: amount_usd × U exactly, or the dinar amount; null without U', () => {
  const usd = active(resolveRuleAt([rule('product', { usd: '120.55' })], 'target_profit', TARGET));
  assert.equal(procurementExactText(targetProfitExactIqd(usd, '1660.5')!), '200173.275');
  assert.equal(targetProfitExactIqd(usd, null), null);
  assert.equal(targetProfitExactIqd(usd, '0'), null);
  const iqd = active(resolveRuleAt([rule('product', { iqd: 192_000 }, { source: 'LEGACY_MIGRATION' })], 'target_profit', TARGET));
  assert.equal(procurementExactText(targetProfitExactIqd(iqd, null)!), '192000');
});

test('isValidRuleRowAmount and parseUsdRuleAmount mirror the 0181 CHECKs', () => {
  for (const ok of ['120', '120.5', '120.50', '0.01', '100000', '007.5']) assert.ok(parseUsdRuleAmount(ok), ok);
  for (const bad of ['0', '0.00', '120.555', '100000.01', '-1', '.5', '5.', '1e3', '١٢٠', ' 120', '1234567890', 120 as unknown as string]) {
    assert.equal(parseUsdRuleAmount(bad), null, String(bad));
  }
  assert.ok(isValidRuleRowAmount({ kind: 'target_profit', amount_usd: '120', amount_iqd: null }));
  assert.ok(isValidRuleRowAmount({ kind: 'target_profit', amount_iqd: 120_000 }));
  assert.ok(!isValidRuleRowAmount({ kind: 'target_profit', amount_usd: '120', amount_iqd: 120_000 }));
  assert.ok(!isValidRuleRowAmount({ kind: 'target_profit', amount_usd: null, amount_iqd: null }));
  assert.ok(isValidRuleRowAmount({ kind: 'direct_sale_extra', amount_iqd: 0 }));
  assert.ok(!isValidRuleRowAmount({ kind: 'direct_sale_extra', amount_iqd: 0, amount_usd: '1' }));
});

test("canonicalUsdRuleAmount: the owner's typing, normalised; ambiguity refused", () => {
  const cases: Array<[unknown, string | null]> = [
    ['120', '120'], ['120.50', '120.5'], ['120.00', '120'], ['007.5', '7.5'], [' 99.9 ', '99.9'],
    ['١٢٠٫٥', '120.5'], ['۱۲۰', '120'], ['120,5', '120.5'], ['120,55', '120.55'], [120.5, '120.5'], [100000, '100000'],
    ['1,200', null], ['120.555', null], ['0', null], ['0.001', null], ['', null], ['abc', null], ['-5', null], ['100000.01', null],
    ['.5', null], ['5.', null], [Number.NaN, null], [null, null], [{}, null],
  ];
  for (const [input, expected] of cases) assert.equal(canonicalUsdRuleAmount(input), expected, JSON.stringify(input));
});
