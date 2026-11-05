/**
 * THE PROFIT CEILING OF AN ESTIMATED PRICE, PURE (owner decisions 2026-11-05, DECISIONS row 291;
 * docs/SMART_PRICING.md §4.11; packages/pricing/src/estimateInputs.ts `planEstimateProfits`, its per-SKU choice in
 * packages/pricing/src/charmPrice.ts, proven on its own in tests/charmPrice.test.ts).
 *
 * At U = 1,600 (the owner's real cost of a dollar since 2026-11-05) and a 10% ceiling unless said otherwise.
 * Proves, with no database:
 *   (a) each SKU's minimum profit is, from $5 up, its dollar charm price's, floor6(c − R ÷ U), and under $5 its plain
 *       house price's, floor6((D − R) ÷ U), with a margin of one rounding step over R: the Nozzle Wiping Plate shape
 *       (3,659.5 IQD, a spare part at $6) 13,500 → 4,000 ($2.50); a printer 3,145,000 → $1,879.99; T itself where
 *       today's price stays; the owner's positive option or colour difference on top (floor6((D − R) ÷ U − Δ)); T for a
 *       SKU priced at the owner's own fixed dollar price; the ceiling's own grammar, 0 to 100 with two decimals;
 *       nothing guessed;
 *   (b) the representation is the least specific exact one — one product rule when every SKU takes the same profit,
 *       else rules on ONE option group, else on colours, else per SKU — and every SKU resolves through the engine's
 *       own `resolveRuleAt` over the rules as the write leaves them to exactly its target, which is never above
 *       today's price and keeps its margin over its route floor (a property test over random grids, mulberry32);
 *   (c) no ceiling and no record of a ceiling rule: nothing changes, the plan is today's byte for byte; a ceiling
 *       that leaves every price where it is changes nothing either; 0% is the lowest price that keeps the margin;
 *   (d) the owner's rules win: an owner's option, colour or SKU rule, live or BLOCKED, holds its SKUs (no estimator
 *       rule ever reaches them: no tie, no override); an owner's product rule means no profit amount written and
 *       the ceiling's own scope rules back to inherit, so his rule decides every SKU as before the ceiling; a changed
 *       record stays the owner's (EST_OWNER_EDITED, names only), a record no longer wanted goes back to inherit, a
 *       value the estimator never wrote is owner-held, a cleared one keeps its SKUs off the ceiling; the first
 *       evaluation's plan is the product with no ceiling (the ceiling's own rules out of it, so every SKU's cost is
 *       read), and nothing planned falls back to it;
 *   (e) no exact representation fits the wire (60 rows): ONE PROFIT PER GROUP — one product rule, one option group or
 *       the colours. From $5 up each rule is the highest profit of the SKUs it reaches, every SKU at or above its own
 *       target (61 SKUs at $10.99, all at 17,750; the 62-SKU filament — 31 colours × spool / refill, the cost by
 *       colour and the box by model — on its colours), flagged EST_CEILING_SHARED (information, never blocking).
 *       Under $5 the cheapest when every SKU keeps its margin there, so none sells above its own house price (61 SKUs
 *       at 2,000–2,060 IQD: every one at its own 2,250 / 2,500; at 900–960, never 1,250 with a 90 IQD margin), else
 *       the least that keeps each at or above its own (970–1,030: 1,250 over 1,000, not 1,500); a property over
 *       random grids past 60 rows: never above today's price, never a margin lost; not even that fits: the product
 *       with no ceiling, flagged the same, not blocked; only an owner's product rule with more ceiling rules to take
 *       back than one wire takes blocks (EST_TOO_MANY_SCOPES);
 *   (f) the record round-trips; its new key is written only when non-empty, so every older record stays as it is.
 *
 * Run: node --import tsx --test tests/estimateProfitCap.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CEILING_SHARED_FLAG,
  ESTIMATE_INPUT_BLOCKING,
  MAX_ESTIMATE_PROFIT_ROWS,
  MAX_PROFIT_CAP_PCT,
  canonicalProfitCapPct,
  ceilingProfitUsd,
  parseAppliedWire,
  planEstimateInputs,
  planEstimateProfits,
  serializeAppliedWire,
  withEstimateProfits,
  type AppliedWire,
  type EstimateProfitInput,
  type EstimateProfitPlan,
  type EstimateProfitRow,
  type EstimateProfitRule,
  type EstimateSku,
  type EstimateSupplierPrice,
  type EstimateTypeInputs,
} from '../packages/pricing/src/estimateInputs';
import { CHARM_MIN_USD, charmTarget, isCharmCents, marginNeededIqd } from '../packages/pricing/src/charmPrice';
import { ESTIMATE_INFO_FLAGS } from '../packages/contracts/src/priceEstimates';
import { canonicalUsdRuleAmount, resolveRuleAt, type PricingRuleRow, type PricingRuleState } from '../packages/pricing/src/ruleResolution';
import { skuComboKey } from '../packages/pricing/src/skuChannel';
import { isOnPriceRule, roundPriceIqd } from '../packages/pricing/src/priceRounding';
import { addProcurementExact, compareProcurementExact, mulProcurementExact, procurementExact } from '../packages/contracts/src/procurementCost';

/* ------------------------------------------------------------- fixtures -- */

/** mulberry32: a small seeded PRNG, so a failure reproduces. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const U = '1600';
const T = '6';
const P = '10';

/** A SKU's target under the ceiling (what the planner must write for it). */
const want = (cost: string, p = P, t = T) => ceilingProfitUsd(t, p, cost, U)!;
/** The engine's price at a minimum profit: roundPriceIqd(R + profit × U). */
const priceOf = (cost: string, usd: string) => roundPriceIqd(addProcurementExact(procurementExact(cost), mulProcurementExact(procurementExact(usd), procurementExact(U))));

/** A product's SKUs: one value of each group (relation order), times its colours (or none). */
function grid(groups: ReadonlyArray<readonly string[]>, colours: readonly string[] = []): EstimateSku[] {
  let selections: string[][] = [[]];
  for (const g of groups) selections = selections.flatMap((sel) => g.map((v) => [...sel, v]));
  const out: EstimateSku[] = [];
  for (const ids of selections) for (const colour of colours.length ? colours : [null]) out.push({ combo_key: skuComboKey({ option_value_ids: ids, color_id: colour }), option_value_ids: ids, color_id: colour });
  return out;
}
const groupsOf = (groups: ReadonlyArray<readonly string[]>): Record<string, string> => Object.fromEntries(groups.flatMap((g, i) => g.map((v) => [v, `g${i}`] as const)));

/** The estimator's product rule as today's apply leaves it, and the record that says so. */
const productRule = (amount = T): EstimateProfitRule => ({ scope: 'product', scope_id: '', state: 'ACTIVE', amount_usd: amount });
const record = (amount = T, scopes: AppliedWire['minimum_profit_scopes'] = []): AppliedWire => ({
  v: 1,
  inputs: [],
  minimum_profit: { amount_usd: amount, source: 'type_default' },
  ...(scopes.length ? { minimum_profit_scopes: scopes } : {}),
});

function plan(input: Partial<EstimateProfitInput> & Pick<EstimateProfitInput, 'skus' | 'costs'>): EstimateProfitPlan {
  return planEstimateProfits({ usd_iqd: U, min_profit_usd: T, profit_cap_pct: P, rules: [productRule()], applied: record(), ...input });
}

/** The rules as an apply of these rows leaves them — the engine's resolver reads them (an independent re-check). */
function rulesAfter(stored: readonly EstimateProfitRule[], rows: readonly EstimateProfitRow[]): PricingRuleRow[] {
  const at = new Map<string, PricingRuleRow>();
  const put = (scope: string, scopeId: string, state: string, usd: string | null, iqd: number | null) =>
    at.set(`${scope}|${scopeId}`, {
      id: `${scope}|${scopeId}|${state}|${usd}`,
      kind: 'target_profit',
      scope: scope as PricingRuleRow['scope'],
      catalog_id: null,
      product_id: 'p',
      scope_id: scopeId,
      state: state as PricingRuleState,
      amount_usd: usd,
      amount_iqd: iqd,
      version: 1,
    });
  for (const r of stored) put(r.scope, r.scope === 'product' ? '' : r.scope_id, r.state, r.amount_usd ?? null, r.amount_iqd ?? null);
  for (const w of rows) put(w.scope, w.scope === 'product' ? '' : (w.scope_id ?? ''), w.amount_usd === null ? 'INHERIT' : 'ACTIVE', w.amount_usd, null);
  return [...at.values()];
}
const resolve = (rules: readonly PricingRuleRow[], s: EstimateSku) =>
  resolveRuleAt(rules, 'target_profit', { product_id: 'p', option_value_ids: s.option_value_ids, color_id: s.color_id, ancestry: [] }, { usdIqdRate: U });

/** Every SKU the estimator prices resolves to exactly its target over the rules as the write leaves them. */
function assertExact(p: EstimateProfitPlan, skus: readonly EstimateSku[], stored: readonly EstimateProfitRule[] = [productRule()]): void {
  assert.equal(p.kind, 'planned', JSON.stringify(p).slice(0, 300));
  const rules = rulesAfter(stored, p.rows);
  for (const t of p.targets) {
    const s = skus.find((x) => x.combo_key === t.combo_key)!;
    const r = resolve(rules, s);
    assert.equal(r.status, 'active', t.combo_key);
    if (r.status !== 'active') return;
    assert.equal(r.tie, false, `${t.combo_key}: a tie`);
    assert.equal(r.amount_usd, t.amount_usd, `${t.combo_key} resolves to its target`);
  }
}

/* ---------------------------------------- (a) one SKU's profit under the ceiling -- */

test('(a) the profit of a SKU: from $5 up its dollar charm price’s, floor6(c − R ÷ U), under $5 its house price’s, floor6((D − R) ÷ U) — T itself where today’s price stays; nothing guessed', () => {
  // The Nozzle Wiping Plate shape at U = 1,600: R = 15 CNY × 240 + 59.5 = 3,659.5, a spare part at $6. Today 13,500;
  // at 10% the ceiling 4,025.45 is under $5 × 1,600 — the house price 4,000: 3,659.5 + 0.212812 × 1,600 = 3,999.9992 →
  // 4,000.
  assert.equal(want('3659.5'), '0.212812');
  assert.equal(priceOf('3659.5', want('3659.5')), 4_000);
  assert.equal(priceOf('3659.5', T), 13_500, 'today, T alone');
  // The same part at 1,690 and 3,862 IQD (the rate the shop priced at before 2026-11-05): 4,250, (4,250 − 3,862) ÷
  // 1,690 = $0.229585.
  assert.equal(ceilingProfitUsd(T, P, '3862', '1690'), '0.229585');
  // Where the charm price IS today's (R 96,137: $65.99 → 105,750), T stays as the type spells it: no new rule.
  assert.equal(want('96137'), '6');
  assert.equal(ceilingProfitUsd('6.0', P, '96137', U), '6', 'canonical');
  // A printer-type SKU at 3% sits under today's price: $1,879.99, 3,008,000 against 3,145,000 at $135.
  assert.equal(ceilingProfitUsd('135', '3', '2928824', U), '49.475');
  assert.equal(priceOf('2928824', '49.475'), 3_008_000);
  assert.equal(priceOf('2928824', '135'), 3_145_000);
  // The margin: a makers part at $1.50 costing 4,760 takes 5,250 (490 IQD over its cost), never 5,000 (240 over it,
  // which a later rise of the cost would close).
  assert.equal(ceilingProfitUsd('1.5', P, '4760', U), '0.30625');
  assert.ok(priceOf('4760', '0.30625') === 5_250 && 0.30625 * 1_600 >= marginNeededIqd(5_250));
  // The owner's gold colour at +$1.30 cost-first: the house price 6,000 under its ceiling 4,025.45 + 2,080 (R + (T_sku +
  // 1.30) × U = 5,999.9992 → 6,000); a negative sum moves nothing; a difference that does not read prices nothing.
  assert.equal(ceilingProfitUsd(T, P, '3659.5', U, '1.3'), '0.162812');
  assert.equal(ceilingProfitUsd(T, P, '3659.5', U, '-2'), '0.212812');
  assert.equal(ceilingProfitUsd(T, P, '3659.5', U, null), '0.212812');
  assert.equal(ceilingProfitUsd(T, P, '3659.5', U, '1e3'), null);
  assert.equal(ceilingProfitUsd(T, P, '3659.5', U, 1.3), null);
  // Nothing guessed: a figure that does not read prices nothing.
  for (const bad of [[null, P, '3659.5', U], [T, null, '3659.5', U], [T, P, null, U], [T, P, '3659.5', null], [T, P, '3659.5', '0'], [T, '100.01', '3659.5', U], [T, P, '-1', U], [T, P, '1e3', U], [T, P, 3659.5, U]] as const) {
    assert.equal(ceilingProfitUsd(...(bad as unknown as [string, string, string, string])), null, JSON.stringify(bad));
  }
});

test('(a) the ceiling’s own grammar, the 0222 CHECK said in code: a percentage from 0 to 100, two decimals', () => {
  for (const [raw, wanted] of [['0', '0'], ['0.00', '0'], ['3', '3'], ['10', '10'], ['37.5', '37.5'], ['37.50', '37.5'], ['0.01', '0.01'], ['100', '100'], ['100.00', '100'], ['025', '25'], [' 25 ', '25']] as const) {
    assert.equal(canonicalProfitCapPct(raw), wanted, raw);
  }
  for (const bad of ['-1', '37.123', '1e2', '37,5', '100.01', '101', '1000', '', '.5', '5.', '25%', 25, 0, null]) assert.equal(canonicalProfitCapPct(bad), null, String(bad));
  assert.equal(MAX_PROFIT_CAP_PCT, 100);
  assert.equal(MAX_ESTIMATE_PROFIT_ROWS, 60, 'the form parser’s own limit (ownerRules.ts MAX_RULES_PER_WRITE)');
});

/* ----------------------------------------------- (b) the representation -- */

test('(b) one SKU, or every SKU at one profit: the product rule alone carries it', () => {
  const one = grid([]);
  const single = plan({ skus: one, costs: { '': '3659.5' } });
  assert.deepEqual([single.kind, single.level, single.product_usd], ['planned', 'product', '0.212812']);
  assert.deepEqual(single.rows, [{ kind: 'target_profit', scope: 'product', amount_usd: '0.212812' }]);
  assert.deepEqual(single.minimum_profit, { amount_usd: '0.212812', source: 'type_default' });
  assert.deepEqual(single.scopes, []);
  assertExact(single, one);

  // Twenty colours of one filament at one cost: one product rule, not twenty ($10.99, 17,750 for 17,056 IQD).
  const colours = grid([], Array.from({ length: 20 }, (_, i) => `c${i}`));
  const same = plan({ skus: colours, costs: Object.fromEntries(colours.map((s) => [s.combo_key, '17056'])) });
  assert.deepEqual([same.level, same.rows.length, same.scopes.length, same.product_usd], ['product', 1, 0, '0.33']);
  assertExact(same, colours);

  // Today's price where the charm price IS today's: nothing moves, and the product rule as today needs no write.
  const kept = plan({ skus: one, costs: { '': '96137' } });
  assert.deepEqual([kept.kind, kept.level, kept.product_usd, kept.rows], ['planned', 'product', T, []]);
  assert.deepEqual(kept.targets, [{ combo_key: '', amount_usd: T, capped: false }]);
});

test('(b) a cost that follows one option group: rules on that group’s values, the product rule stays T', () => {
  // A model group (spool / refill) × a size group × two colours; the cost follows the model only.
  const groups = [['m_spool', 'm_refill'], ['s_1', 's_2']];
  const skus = grid(groups, ['c_red', 'c_blue']);
  const costs = Object.fromEntries(skus.map((s) => [s.combo_key, s.option_value_ids.includes('m_spool') ? '3659.5' : '2900']));
  const p = plan({ skus, costs, option_groups: groupsOf(groups) });
  assert.deepEqual([p.level, p.group_id, p.product_usd], ['option', 'g0', T]);
  // 2,900 IQD: 3,250 (its ceiling, 2,900 × 1.1 = 3,190, holds 3,000, which keeps only 100 over it — the lowest house
  // price that keeps the margin).
  assert.deepEqual(p.rows, [
    { kind: 'target_profit', scope: 'option', scope_id: 'm_refill', amount_usd: '0.21875' },
    { kind: 'target_profit', scope: 'option', scope_id: 'm_spool', amount_usd: '0.212812' },
  ]);
  assert.equal(want('2900'), '0.21875');
  assert.equal(priceOf('2900', '0.21875'), 3_250);
  assert.deepEqual(
    p.scopes.map((s) => [s.scope, s.scope_id, s.source]),
    [
      ['option', 'm_refill', 'type_default'],
      ['option', 'm_spool', 'type_default'],
    ]
  );
  assertExact(p, skus);

  // The cost follows the second group: that group's values, not the first's.
  const bySize = plan({ skus, costs: Object.fromEntries(skus.map((s) => [s.combo_key, s.option_value_ids.includes('s_1') ? '3659.5' : '2900'])), option_groups: groupsOf(groups) });
  assert.deepEqual([bySize.level, bySize.group_id], ['option', 'g1']);
  assertExact(bySize, skus);
});

test('(b) a cost that follows the colour: colour rules; a cost of its own per SKU: SKU rules; a SKU at today’s price gets none', () => {
  const groups = [['m_a', 'm_b']];
  const skus = grid(groups, ['c_red', 'c_blue', 'c_gold']);
  const byColour = plan({ skus, costs: Object.fromEntries(skus.map((s) => [s.combo_key, s.color_id === 'c_gold' ? '5200' : '3100'])), option_groups: groupsOf(groups) });
  assert.deepEqual([byColour.level, byColour.rows.map((r) => [r.scope, r.scope_id, r.amount_usd])], [
    'color',
    [
      ['color', 'c_blue', want('3100')],
      ['color', 'c_gold', want('5200')],
      ['color', 'c_red', want('3100')],
    ],
  ]);
  assertExact(byColour, skus);

  // Every SKU its own cost: one rule per SKU, at its canonical combo key.
  const own = Object.fromEntries(skus.map((s, i) => [s.combo_key, String(3000 + i * 111)]));
  const perSku = plan({ skus, costs: own, option_groups: groupsOf(groups) });
  assert.equal(perSku.level, 'sku');
  assert.deepEqual(
    perSku.rows.map((r) => r.scope_id),
    skus.map((s) => s.combo_key).sort()
  );
  assertExact(perSku, skus);

  // A SKU whose charm price is today's keeps the product's T: only the others get a rule.
  const mixed = { ...own, [skus[0]!.combo_key]: '96137' };
  const some = plan({ skus, costs: mixed, option_groups: groupsOf(groups) });
  assert.equal(some.level, 'sku');
  assert.ok(!some.rows.some((r) => r.scope_id === skus[0]!.combo_key), 'no rule for the SKU at today’s price');
  assert.deepEqual(some.targets.find((t) => t.combo_key === skus[0]!.combo_key), { combo_key: skus[0]!.combo_key, amount_usd: T, capped: false });
  assertExact(some, skus);
});

test('(b) property: on random grids every SKU resolves to exactly its own price’s profit (a charm price from $5 up, the house price under), at the least specific scope that is exact — never above today’s price, never under its route floor', () => {
  const rnd = prng(291);
  const pick = <V>(xs: readonly V[]) => xs[Math.floor(rnd() * xs.length)]!;
  for (let round = 0; round < 400; round++) {
    const groups = Array.from({ length: Math.floor(rnd() * 3) }, (_, g) => Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, v) => `g${g}v${v}`));
    const colours = Array.from({ length: Math.floor(rnd() * 4) }, (_, c) => `c${c}`);
    const skus = grid(groups, colours);
    const pool = ['3659.5', '2900', '1000.5', '987.25', '17056', '96137', '250000', '900000', '500'];
    const mode = pick(['same', 'group', 'colour', 'random'] as const);
    const ceiling = pick(['0', '3', '4', '6', '8', '10', '25', '100']);
    const costOf = (s: EstimateSku): string => {
      if (mode === 'same') return pool[0]!;
      if (mode === 'group' && s.option_value_ids.length) return pool[Number(s.option_value_ids[0]!.slice(-1)) % pool.length]!;
      if (mode === 'colour' && s.color_id) return pool[Number(s.color_id.slice(1)) % pool.length]!;
      return pick(pool);
    };
    const costs = Object.fromEntries(skus.map((s) => [s.combo_key, costOf(s)]));
    const p = plan({ skus, costs, option_groups: groupsOf(groups), profit_cap_pct: ceiling });
    assertExact(p, skus);
    for (const t of p.targets) {
      const cost = costs[t.combo_key]!;
      assert.equal(t.amount_usd, want(cost, ceiling), t.combo_key);
      const x = charmTarget({ cost_iqd: cost, usd_iqd: U, min_profit_usd: T, ceiling_pct: ceiling })!;
      const price = priceOf(cost, t.amount_usd);
      assert.ok(price <= priceOf(cost, T), `round ${round}: ${t.combo_key} never above today’s price`);
      assert.ok(price > roundPriceIqd(cost), `round ${round}: ${t.combo_key} clears its route floor`);
      // …with a margin of one rounding step over its cost (a dinar at or under 1,000 IQD), so FX-5 can follow a rise.
      if (t.capped) assert.ok(Number(t.amount_usd) * Number(U) >= marginNeededIqd(price) - 1e-9, `round ${round}: ${t.combo_key} keeps its margin`);
      if (x.basis === 'charm') assert.ok(isCharmCents(x.charm_cents!) && x.charm_cents! >= CHARM_MIN_USD * 100, `round ${round}: on the grid, from $5 up`);
      if (x.basis === 'plain') assert.ok(isOnPriceRule(price) && price === x.price_iqd, `round ${round}: a house price`);
    }
    const amounts = new Set(p.targets.map((t) => t.amount_usd));
    assert.equal(p.level === 'product', amounts.size === 1, `round ${round}: the product rule exactly when one profit fits every SKU`);
    assert.ok(p.rows.length <= MAX_ESTIMATE_PROFIT_ROWS);
    // A scope rule only for a SKU whose profit is not the type's, never one at today's price.
    for (const r of p.rows) if (r.scope !== 'product') assert.notEqual(r.amount_usd, T);
  }
});

/* ------------------------------------------------- (c) nothing changes -- */

const TYPE: EstimateTypeInputs = {
  key: 'spare_part',
  route: 'sea',
  default_weight_g: 100,
  default_length_mm: 100,
  default_width_mm: 100,
  default_height_mm: 50,
  default_cbm: null,
  additional_cost_iqd: null,
  min_profit_usd: T,
};

test('(c) no ceiling and no ceiling rule recorded: the plan is today’s, byte for byte; a ceiling that leaves every price where it is changes nothing either', () => {
  const skus = grid([], ['c_red', 'c_black']);
  const prices = new Map<string, EstimateSupplierPrice>(skus.map((s) => [s.combo_key, { amount: '15', currency: 'CNY', source: 'tmall_cn', ref: 'sps_1' }]));
  const base = planEstimateInputs({ skus, prices, type: TYPE, inputs: [] });
  const today = JSON.stringify(base);
  const costs = Object.fromEntries(skus.map((s) => [s.combo_key, '3659.5']));
  const none = planEstimateProfits({ skus, costs, usd_iqd: U, min_profit_usd: T, profit_cap_pct: null, rules: [], applied: null });
  assert.equal(none.kind, 'none');
  assert.equal(withEstimateProfits(base, none), base, 'the same plan, untouched');
  assert.equal(JSON.stringify(base), today);
  // A ceiling that moves no price (every charm price is today's): the same wire, the same record.
  const stays = planEstimateProfits({ skus, costs: Object.fromEntries(skus.map((s) => [s.combo_key, '96137'])), usd_iqd: U, min_profit_usd: T, profit_cap_pct: P, rules: [], applied: null });
  assert.equal(stays.kind, 'planned');
  const kept = withEstimateProfits(base, stays);
  assert.deepEqual(kept.wire, base.wire);
  assert.equal(kept.applied_json, base.applied_json, 'the record byte for byte: no new key');
  assert.equal(kept.applied_json.includes('minimum_profit_scopes'), false);
  // Binding: the product's text minimum profit is its target's (here the house price 4,000), as the form's wire carries it.
  const charmed = withEstimateProfits(base, planEstimateProfits({ skus, costs, usd_iqd: U, min_profit_usd: T, profit_cap_pct: P, rules: [], applied: null }));
  assert.equal(charmed.wire.cost.minimum_profit, '0.212812');
  assert.deepEqual(charmed.applied.minimum_profit, { amount_usd: '0.212812', source: 'type_default' });
  assert.equal(charmed.applied_json.includes('minimum_profit_scopes'), false);
  assert.deepEqual(charmed.blocked_by, base.blocked_by);
});

test('(c) 0% is the floor: the lowest price that keeps one rounding step over the cost — the house price under $5, the charm price from $5 up — never the cost itself', () => {
  const one = grid([]);
  for (const [cost, price] of [
    ['3659.5', 4_000],
    ['18431.2', 19_250],
    ['2900', 3_250],
    ['1000.5', 1_500],
  ] as const) {
    const p = plan({ skus: one, costs: { '': cost }, profit_cap_pct: '0' });
    assert.equal(p.kind, 'planned');
    const amount = p.targets[0]!.amount_usd;
    assert.equal(priceOf(cost, amount), price, cost);
    const x = charmTarget({ cost_iqd: cost, usd_iqd: U, min_profit_usd: T, ceiling_pct: '0' })!;
    assert.equal(x.price_iqd, price);
    assert.ok(price >= x.floor_iqd && price > roundPriceIqd(cost), `${cost}: above the route floor`);
    assert.ok(Number(amount) * Number(U) >= marginNeededIqd(price), `${cost}: one rounding step over its cost`);
  }
  // 5.94 CNY of a spare part (R 1,485.1): 1,500 would keep 14.9 IQD — the lowest that keeps 250 is 1,750 (the grid's
  // $0.99 would have kept 98.9, its $1.49 sold it at 2,500).
  const thin = plan({ skus: one, costs: { '': '1485.1' }, profit_cap_pct: '0' });
  assert.deepEqual([thin.targets[0]!.amount_usd, priceOf('1485.1', thin.targets[0]!.amount_usd)], ['0.165562', 1_750]);
});

test('(a) the owner’s own: his differences stay on top of the ceiling’s price; a SKU at his own fixed dollar price keeps T', () => {
  // Two colours of the Nozzle shape; gold carries the owner's +$1.30 (cost-first): red 4,000, gold 6,000 (its ceiling
  // 4,025.45 + 2,080) — both under $5, house prices, the difference still on top. Colour rules (the product rule
  // stays T).
  const tint = grid([], ['c_red', 'c_gold']);
  const costs = { 'c:c_red': '3659.5', 'c:c_gold': '3659.5' };
  const p = plan({ skus: tint, costs, differences: new Map([['c:c_gold', '1.3']]) });
  assert.deepEqual([p.kind, p.level], ['planned', 'color']);
  assert.deepEqual(
    p.rows.map((r) => [r.scope, r.scope_id, r.amount_usd]),
    [
      ['color', 'c_gold', '0.162812'],
      ['color', 'c_red', '0.212812'],
    ]
  );
  assertExact(p, tint);
  // A negative sum (a cheaper colour) never moves a cost-first price (C-9): one product rule, as with none.
  const cheaper = plan({ skus: tint, costs, differences: { 'c:c_gold': '-0.5' } });
  assert.deepEqual([cheaper.level, cheaper.product_usd], ['product', '0.212812']);

  // Two models; m1 sells at the owner's own «سعر خاص $» (anchor model_fixed): its minimum profit is only its floor, so
  // it keeps T — the ceiling prices m2 alone, on its own option rule.
  const models = grid([['m1', 'm2']]);
  const fixed = plan({ skus: models, costs: { 'o:m1': '3659.5', 'o:m2': '3659.5' }, fixed: ['o:m1'], option_groups: groupsOf([['m1', 'm2']]) });
  assert.deepEqual([fixed.kind, fixed.level, fixed.product_usd], ['planned', 'option', T]);
  assert.deepEqual(fixed.rows, [{ kind: 'target_profit', scope: 'option', scope_id: 'm2', amount_usd: '0.212812' }]);
  assert.deepEqual(fixed.targets, [
    { combo_key: 'o:m1', amount_usd: T, capped: false },
    { combo_key: 'o:m2', amount_usd: '0.212812', capped: true },
  ]);
  assertExact(fixed, models);
});

/* -------------------------------------------- (d) the owner's rules win -- */

test('(d) an owner’s option rule holds its SKUs: no estimator rule reaches them; the others are priced around it', () => {
  const groups = [['m1', 'm2', 'm3']];
  const skus = grid(groups, ['c_red', 'c_blue']);
  const costs = Object.fromEntries(skus.map((s) => [s.combo_key, s.option_value_ids[0] === 'm3' ? '5200' : '3659.5']));
  const owner: EstimateProfitRule = { scope: 'option', scope_id: 'm1', state: 'ACTIVE', amount_usd: '60' };
  const stored = [productRule(), owner];
  const p = plan({ skus, costs, option_groups: groupsOf(groups), rules: stored });
  const m1 = skus.filter((s) => s.option_value_ids[0] === 'm1').map((s) => s.combo_key).sort();
  assert.deepEqual(p.held, m1);
  assert.deepEqual(p.owner_held, [{ scope: 'option', scope_id: 'm1', field: 'minimum_profit' }], 'a value the estimator never wrote: the owner’s, kept');
  assert.ok(!p.targets.some((t) => m1.includes(t.combo_key)), 'the owner’s SKUs are not the ceiling’s');
  assertExact(p, skus, stored);
  // Nothing written reaches an owner's SKU (a tie at its level, an override below it), and they still resolve to his $60.
  const rules = rulesAfter(stored, p.rows);
  for (const s of skus.filter((x) => m1.includes(x.combo_key))) {
    for (const r of p.rows) {
      if (r.scope === 'product') continue;
      const reaches = r.scope === 'option' ? s.option_value_ids.includes(r.scope_id!) : r.scope === 'color' ? s.color_id === r.scope_id : s.combo_key === r.scope_id;
      assert.equal(reaches, false, `${r.scope}:${r.scope_id} reaches the owner’s ${s.combo_key}`);
    }
    const res = resolve(rules, s);
    assert.ok(res.status === 'active' && res.amount_usd === '60' && !res.tie, s.combo_key);
  }

  // Every SKU the owner's: nothing to price, nothing written, the product rule as it is.
  const all = [productRule(), { scope: 'option', scope_id: 'm1', state: 'ACTIVE', amount_usd: '60' }, { scope: 'option', scope_id: 'm2', state: 'ACTIVE', amount_usd: '45' }, { scope: 'option', scope_id: 'm3', state: 'ACTIVE', amount_usd: '45' }];
  const held = plan({ skus, costs, option_groups: groupsOf(groups), rules: all });
  assert.deepEqual([held.kind, held.level, held.product_usd, held.rows, held.targets], ['planned', 'product', T, [], []]);
  assert.equal(held.held.length, skus.length);
});

test('(d) an owner’s product rule: no profit amount written; the ceiling’s own scope rules go back to inherit, so his rule decides every SKU as before the ceiling', () => {
  const skus = grid([['m1', 'm2', 'm3']]);
  const costs = { 'o:m1': '3659.5', 'o:m2': '2900', 'o:m3': '2000' };
  // The last apply priced m1, m2 and m3 under the ceiling; since then the owner set the product's minimum profit
  // ($4.50) and changed m3's.
  const scopes = [
    { scope: 'option' as const, scope_id: 'm1', amount_usd: '0.212812', source: 'type_default' as const },
    { scope: 'option' as const, scope_id: 'm2', amount_usd: '0.21875', source: 'type_default' as const },
    { scope: 'option' as const, scope_id: 'm3', amount_usd: '0.15625', source: 'type_default' as const },
  ];
  const stored = [
    productRule('4.5'),
    { scope: 'option', scope_id: 'm1', state: 'ACTIVE', amount_usd: '0.212812' },
    { scope: 'option', scope_id: 'm2', state: 'ACTIVE', amount_usd: '0.21875' },
    { scope: 'option', scope_id: 'm3', state: 'ACTIVE', amount_usd: '3' },
  ];
  for (const cap of [P, null]) {
    const p = plan({ skus, costs, rules: stored, applied: record(T, scopes), profit_cap_pct: cap, option_groups: groupsOf([['m1', 'm2', 'm3']]) });
    assert.equal(p.kind, 'owner', `ceiling ${cap}`);
    assert.deepEqual(
      p.rows,
      [
        { kind: 'target_profit', scope: 'option', scope_id: 'm1', amount_usd: null },
        { kind: 'target_profit', scope: 'option', scope_id: 'm2', amount_usd: null },
      ],
      'the ceiling’s own rules back to inherit — no amount written, his m3 untouched'
    );
    assert.deepEqual(p.scopes, [scopes[2]], 'the record keeps only the rule now his');
    // After the write his product rule decides m1 and m2, his own rule m3: no estimator rule decides anything.
    const after = rulesAfter(stored, p.rows);
    assert.deepEqual(
      skus.map((s) => [s.combo_key, (resolve(after, s) as { amount_usd?: string }).amount_usd]),
      [
        ['o:m1', '4.5'],
        ['o:m2', '4.5'],
        ['o:m3', '3'],
      ]
    );
  }
  // …into the plan an apply stores: the product's record is the plan's own (step 4: the owner's, kept); the rows
  // travel as the form's rule rows.
  const p = plan({ skus, costs, rules: stored, applied: record(T, scopes) });
  const skusPlan = planEstimateInputs({
    skus,
    prices: new Map(skus.map((s) => [s.combo_key, { amount: '15', currency: 'CNY' as const, source: 'tmall_cn' as const, ref: 'sps_1' }])),
    type: TYPE,
    inputs: [],
    product_rule: { state: 'ACTIVE', amount_usd: '4.5' },
    applied: record(T, scopes),
  });
  assert.equal(skusPlan.wire.cost.minimum_profit, undefined, 'the planner alone sends no minimum profit for his product rule');
  const out = withEstimateProfits(skusPlan, p);
  assert.deepEqual(out.wire.cost.minimum_profit, p.rows);
  assert.deepEqual(out.applied.minimum_profit, { amount_usd: T, source: 'type_default' }, 'the record the owner changed stays (§4.5)');
  assert.deepEqual(out.applied.minimum_profit_scopes, [scopes[2]]);
  assert.ok(out.flags.some((f) => f.code === 'EST_OWNER_EDITED' && f.fields?.includes('minimum_profit')));
  assert.deepEqual(out.blocked_by, skusPlan.blocked_by, 'nothing blocks');
  // The next compute: nothing of the ceiling left, so nothing is written and the record keeps his rule.
  const settled = plan({ skus, costs, rules: rulesAfter(stored, p.rows).map((r) => ({ scope: r.scope, scope_id: r.scope_id, state: r.state, amount_usd: r.amount_usd })), applied: record(T, [scopes[2]!]) });
  assert.deepEqual([settled.kind, settled.rows, settled.scopes], ['owner', [], [scopes[2]]]);

  // A product with no ceiling rule recorded and his product rule: nothing at all.
  const plain = plan({ skus, costs, rules: [productRule('4.5')], applied: record(T) });
  assert.deepEqual([plain.kind, plain.rows, plain.scopes], ['owner', [], []]);
  assert.equal(withEstimateProfits(skusPlan, plain).wire.cost.minimum_profit, undefined);
  // More of the ceiling's rules than one wire takes: blocked (EST_TOO_MANY_SCOPES), nothing written, the record kept.
  const many = grid([Array.from({ length: 61 }, (_, i) => `v${i}`)]);
  const manyScopes = many.map((s) => ({ scope: 'option' as const, scope_id: s.option_value_ids[0]!, amount_usd: '0.5', source: 'type_default' as const }));
  const big = plan({
    skus: many,
    costs: {},
    rules: [productRule('4.5'), ...manyScopes.map((f) => ({ scope: 'option', scope_id: f.scope_id, state: 'ACTIVE', amount_usd: '0.5' }))],
    applied: record(T, manyScopes),
  });
  assert.deepEqual([big.kind, big.rows, big.scopes.length], ['too_many', [], 61]);
  assert.ok(big.flags.some((f) => f.code === 'EST_TOO_MANY_SCOPES'));
});

test('(d) property: under an owner’s product rule only the ceiling’s own rules are written, back to inherit — afterwards every SKU is decided by his rules alone', () => {
  const rnd = prng(2911);
  const pick = <V>(xs: readonly V[]) => xs[Math.floor(rnd() * xs.length)]!;
  let rounds = 0;
  for (let round = 0; round < 600; round++) {
    const groups = Array.from({ length: Math.floor(rnd() * 3) }, (_, g) => Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, v) => `g${g}v${v}`));
    const skus = grid(groups, Array.from({ length: Math.floor(rnd() * 3) }, (_, c) => `c${c}`));
    const ids = skus.flatMap((s) => [...s.option_value_ids.map((v) => ['option', v] as const), ...(s.color_id ? [['color', s.color_id] as const] : []), ...(s.combo_key ? [['sku', s.combo_key] as const] : [])]);
    // Every rule below the product: the ceiling's own (as recorded), changed or cleared by the owner, his own, or none.
    const stored: EstimateProfitRule[] = [productRule(pick(['4.5', '8', '50']))];
    const scopes: NonNullable<AppliedWire['minimum_profit_scopes']> = [];
    const seen = new Set<string>();
    for (const [scope, id] of ids) {
      if (seen.has(`${scope}|${id}`)) continue;
      seen.add(`${scope}|${id}`);
      const roll = rnd();
      if (roll < 0.5) {
        const amount = pick(['0.212812', '0.21875', '0.3']);
        scopes.push({ scope, scope_id: id, amount_usd: amount, source: 'type_default' });
        if (roll < 0.35) stored.push({ scope, scope_id: id, state: 'ACTIVE', amount_usd: amount });
        else if (roll < 0.42) stored.push({ scope, scope_id: id, state: 'ACTIVE', amount_usd: '7' });
        else stored.push({ scope, scope_id: id, state: 'INHERIT', amount_usd: null });
      } else if (roll < 0.6) stored.push(rnd() < 0.8 ? { scope, scope_id: id, state: 'ACTIVE', amount_usd: '9' } : { scope, scope_id: id, state: 'BLOCKED', amount_usd: null });
    }
    const cap = pick([P, '0', null]);
    const p = plan({ skus, costs: Object.fromEntries(skus.map((s) => [s.combo_key, pick(['3659.5', '1000.5', '900000'])])), rules: stored, applied: record(T, scopes), profit_cap_pct: cap, option_groups: groupsOf(groups) });
    if (!scopes.length && cap === null) {
      assert.equal(p.kind, 'none', `round ${round}: no ceiling and nothing of it recorded — today's planner alone`);
      continue;
    }
    assert.equal(p.kind, 'owner', `round ${round}`);
    const ours = new Set(scopes.filter((f) => stored.some((r) => r.scope === f.scope && r.scope_id === f.scope_id && r.state === 'ACTIVE' && r.amount_usd === f.amount_usd)).map((f) => `${f.scope}|${f.scope_id}`));
    assert.deepEqual(
      p.rows.map((r) => `${r.scope}|${r.scope_id}|${r.amount_usd}`).sort(),
      [...ours].map((k) => `${k}|null`).sort(),
      `round ${round}: exactly the ceiling's own rules, back to inherit`
    );
    const after = rulesAfter(stored, p.rows);
    const his = rulesAfter(stored.filter((r) => r.scope === 'product' || !ours.has(`${r.scope}|${r.scope_id}`)), []);
    for (const s of skus) assert.deepEqual(resolve(after, s), resolve(his, s), `round ${round}: ${s.combo_key}`);
    if (ours.size) rounds++;
  }
  assert.ok(rounds > 200, `enough rounds with the ceiling's rules to take back (${rounds})`);
});

test('(d) an owner’s colour or SKU rule, live or BLOCKED, holds its SKUs: nothing written reaches them, they decide as before, every other SKU is exact', () => {
  const rnd = prng(4242);
  const pool = ['3659.5', '2900', '1500.5', '17056', '96137', '900000'];
  let planned = 0;
  for (let round = 0; round < 1_500; round++) {
    const groups = Array.from({ length: Math.floor(rnd() * 3) }, (_, g) => Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, v) => `g${g}v${v}`));
    const colours = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, c) => `c${c}`);
    const skus = grid(groups, colours);
    const owner: EstimateProfitRule[] = [];
    if (rnd() < 0.5) owner.push({ scope: 'color', scope_id: colours[Math.floor(rnd() * colours.length)]!, state: rnd() < 0.2 ? 'BLOCKED' : 'ACTIVE', amount_usd: '7' });
    const one = skus[Math.floor(rnd() * skus.length)]!;
    if (rnd() < 0.5 && one.combo_key) owner.push({ scope: 'sku', scope_id: one.combo_key, state: rnd() < 0.2 ? 'BLOCKED' : 'ACTIVE', amount_usd: '8' });
    if (!owner.length) continue;
    const stored = [productRule(), ...owner];
    const costs = Object.fromEntries(skus.map((s) => [s.combo_key, pool[Math.floor(rnd() * pool.length)]!]));
    const p = plan({ skus, costs, rules: stored, option_groups: groupsOf(groups) });
    assert.notEqual(p.kind, 'unpriced');
    if (p.kind !== 'planned') continue;
    planned++;
    const before = rulesAfter(stored, []);
    const after = rulesAfter(stored, p.rows);
    const held = new Set(p.held);
    for (const s of skus) {
      if (held.has(s.combo_key)) {
        assert.deepEqual(resolve(after, s), resolve(before, s), `round ${round}: the owner’s ${s.combo_key} decides as before`);
        for (const r of p.rows) {
          if (r.scope === 'product') continue;
          const reaches = r.scope === 'option' ? s.option_value_ids.includes(r.scope_id!) : r.scope === 'color' ? s.color_id === r.scope_id : s.combo_key === r.scope_id;
          assert.equal(reaches, false, `round ${round}: ${r.scope}:${r.scope_id} reaches the owner’s ${s.combo_key}`);
        }
      } else {
        const r = resolve(after, s);
        assert.ok(r.status === 'active' && !r.tie && r.amount_usd === want(costs[s.combo_key]!), `round ${round}: ${s.combo_key}`);
      }
    }
  }
  assert.ok(planned > 300, `enough rounds planned (${planned})`);
});

test('(d) the first evaluation’s plan: the product with no ceiling — every SKU the estimator prices at T, the ceiling’s own rules back to inherit, the owner’s kept', () => {
  // Compute's first evaluation reads each SKU's cost from the product priced with NO ceiling (the planner with no P):
  // a ceiling rule of the last apply stays out of it, so a cost that moved past its rounding step is always read.
  const groups = [['m1', 'm2', 'm3']];
  const skus = grid(groups, ['c_red', 'c_blue']);
  const scopes = [
    { scope: 'option' as const, scope_id: 'm1', amount_usd: '0.04', source: 'type_default' as const },
    { scope: 'option' as const, scope_id: 'm2', amount_usd: '0.465', source: 'type_default' as const },
  ];
  // The owner holds the blue colour with his own rule.
  const stored = [
    productRule(),
    { scope: 'option', scope_id: 'm1', state: 'ACTIVE', amount_usd: '0.04' },
    { scope: 'option', scope_id: 'm2', state: 'ACTIVE', amount_usd: '0.465' },
    { scope: 'color', scope_id: 'c_blue', state: 'ACTIVE', amount_usd: '7' },
  ];
  const first = plan({ skus, costs: {}, usd_iqd: null, profit_cap_pct: null, rules: stored, applied: record(T, scopes), option_groups: groupsOf(groups) });
  assert.equal(first.kind, 'planned');
  assert.deepEqual(first.rows, [
    { kind: 'target_profit', scope: 'option', scope_id: 'm1', amount_usd: null },
    { kind: 'target_profit', scope: 'option', scope_id: 'm2', amount_usd: null },
  ]);
  const after = rulesAfter(stored, first.rows);
  for (const s of skus) {
    const r = resolve(after, s);
    assert.ok(r.status === 'active' && r.amount_usd === (s.color_id === 'c_blue' ? '7' : T) && !r.tie, `${s.combo_key}: ${JSON.stringify(r).slice(0, 100)}`);
  }
  // A ceiling product rule (one SKU) goes back to T the same way (`planEstimateInputs` sends T: nothing here).
  assert.equal(planEstimateProfits({ skus: grid([]), costs: {}, usd_iqd: null, min_profit_usd: T, profit_cap_pct: null, rules: [productRule('0.212812')], applied: record('0.212812') }).kind, 'none');
  // No ceiling rule recorded: no plan at all — the first evaluation is today's.
  assert.equal(plan({ skus, costs: {}, profit_cap_pct: null, rules: [productRule()], applied: record() }).kind, 'none');
});

test('(d) nothing planned falls back to the product with no ceiling — the first evaluation’s own wire and record — and blocks', () => {
  const groups = [['m1', 'm2']];
  const skus = grid(groups);
  const scopes = [{ scope: 'option' as const, scope_id: 'm1', amount_usd: '0.04', source: 'type_default' as const }];
  const stored = [productRule(), { scope: 'option', scope_id: 'm1', state: 'ACTIVE', amount_usd: '0.04' }];
  const first = plan({ skus, costs: {}, profit_cap_pct: null, rules: stored, applied: record(T, scopes), option_groups: groupsOf(groups) });
  // m2 priced no cost even at T: nothing is priced from a guess — the rows, record and wire are the first plan's.
  const unpriced = plan({ skus, costs: { 'o:m1': '1000.5' }, rules: stored, applied: record(T, scopes), option_groups: groupsOf(groups) });
  assert.equal(unpriced.kind, 'unpriced');
  assert.deepEqual([unpriced.rows, unpriced.scopes, unpriced.minimum_profit], [first.rows, first.scopes, first.minimum_profit]);
  const prices = new Map(skus.map((s) => [s.combo_key, { amount: '3', currency: 'CNY' as const, source: 'tmall_cn' as const, ref: 'sps_1' }]));
  const skusPlan = planEstimateInputs({ skus, prices, type: TYPE, inputs: [], product_rule: { state: 'ACTIVE', amount_usd: T }, applied: record(T, scopes) });
  const firstPlan = withEstimateProfits(skusPlan, first);
  const kept = withEstimateProfits(skusPlan, unpriced);
  assert.deepEqual(kept.wire, firstPlan.wire, 'the same wire: compute keeps its first evaluation (incomplete or blocked)');
  assert.equal(kept.applied_json, firstPlan.applied_json);
  // With no ceiling rule recorded, nothing planned keeps the plan exactly.
  const fresh = plan({ skus, costs: { 'o:m1': '1000.5' }, rules: [productRule()], applied: record(), option_groups: groupsOf(groups) });
  assert.deepEqual([fresh.kind, fresh.rows, fresh.scopes, fresh.minimum_profit], ['unpriced', [], [], undefined]);
  const plainPlan = planEstimateInputs({ skus, prices, type: TYPE, inputs: [] });
  assert.deepEqual(withEstimateProfits(plainPlan, fresh).wire, plainPlan.wire);
  assert.equal(withEstimateProfits(plainPlan, fresh).applied_json, plainPlan.applied_json);
});

test('(d) the merge, rule by rule: the ceiling’s own rule rewritten or cleared, the owner’s change kept, a cleared one keeps its SKUs off the ceiling', () => {
  const groups = [['m1', 'm2', 'm3']];
  const skus = grid(groups);
  const groupIds = groupsOf(groups);
  // The last apply priced m1 (3,659.5 IQD) and m2 (2,900 IQD) under the ceiling (the record), and the store still
  // holds those very values.
  const scopes = [
    { scope: 'option' as const, scope_id: 'm1', amount_usd: want('3659.5'), source: 'type_default' as const },
    { scope: 'option' as const, scope_id: 'm2', amount_usd: want('2900'), source: 'type_default' as const },
  ];
  const stored = [productRule(), { scope: 'option', scope_id: 'm1', state: 'ACTIVE', amount_usd: want('3659.5') }, { scope: 'option', scope_id: 'm2', state: 'ACTIVE', amount_usd: want('2900') }];
  // m1's cost moved; m2 now sells at today's price (T): its rule goes back to inherit; m3 is newly priced.
  const costs = { 'o:m1': '4000', 'o:m2': '96137', 'o:m3': '2000' };
  const p = plan({ skus, costs, rules: stored, applied: record(T, scopes), option_groups: groupIds });
  assert.equal(p.level, 'option');
  assert.deepEqual(p.rows, [
    { kind: 'target_profit', scope: 'option', scope_id: 'm1', amount_usd: want('4000') },
    { kind: 'target_profit', scope: 'option', scope_id: 'm2', amount_usd: null },
    { kind: 'target_profit', scope: 'option', scope_id: 'm3', amount_usd: want('2000') },
  ]);
  assert.deepEqual(
    p.scopes.map((s) => s.scope_id),
    ['m1', 'm3']
  );
  assertExact(p, skus, stored);
  // Nothing moved: nothing is sent, the record stays.
  const again = plan({ skus, costs: { 'o:m1': '3659.5', 'o:m2': '2900', 'o:m3': '96137' }, rules: stored, applied: record(T, scopes), option_groups: groupIds });
  assert.deepEqual(again.rows, []);
  assert.deepEqual(again.scopes, scopes);

  // The owner changed the ceiling's m1 rule to $2: his (EST_OWNER_EDITED), kept, m1 held; m2 and m3 still priced.
  const changed = [productRule(), { scope: 'option', scope_id: 'm1', state: 'ACTIVE', amount_usd: '2' }, stored[2]!];
  const owned = plan({ skus, costs: { 'o:m1': '3659.5', 'o:m2': '2900', 'o:m3': '2000' }, rules: changed, applied: record(T, scopes), option_groups: groupIds });
  assert.deepEqual(owned.held, ['o:m1']);
  assert.ok(owned.flags.some((f) => f.code === 'EST_OWNER_EDITED' && f.fields?.join() === 'minimum_profit'));
  assert.ok(owned.scopes.some((s) => s.scope_id === 'm1' && s.amount_usd === want('3659.5')), 'the record stays, so the rule stays his');
  assert.ok(!owned.rows.some((r) => r.scope_id === 'm1'), 'never written over');
  assertExact(owned, skus, changed);

  // The owner CLEARED the ceiling's m1 rule: m1 follows the product's rule — which then stays T, never a ceiling one.
  const cleared = [productRule(), { scope: 'option', scope_id: 'm1', state: 'INHERIT', amount_usd: null }, { scope: 'option', scope_id: 'm2', state: 'ACTIVE', amount_usd: want('2900') }];
  const allSame = { 'o:m1': '3659.5', 'o:m2': '3659.5', 'o:m3': '3659.5' };
  const off = plan({ skus, costs: allSame, rules: cleared, applied: record(T, scopes), option_groups: groupIds });
  assert.deepEqual(off.held, ['o:m1']);
  assert.equal(off.product_usd, T, 'one profit fits m2 and m3, yet the product rule stays T: m1 falls to it');
  assert.equal(off.level, 'option');
  assert.ok(!off.rows.some((r) => r.scope_id === 'm1'));
  const res = resolve(rulesAfter(cleared, off.rows), skus[0]!);
  assert.ok(res.status === 'active' && res.amount_usd === T, 'the cleared SKU stays on T');
  assertExact(off, skus, cleared);
});

test('(d) the ceiling emptied: the estimator takes its rules back — the product rule to T, its scope rules to inherit', () => {
  const skus = grid([['m1', 'm2']]);
  const scopes = [{ scope: 'option' as const, scope_id: 'm1', amount_usd: '0.212812', source: 'type_default' as const }];
  const stored = [productRule(), { scope: 'option', scope_id: 'm1', state: 'ACTIVE', amount_usd: '0.212812' }];
  const p = plan({ skus, costs: {}, profit_cap_pct: null, rules: stored, applied: record(T, scopes), usd_iqd: null });
  assert.deepEqual([p.kind, p.level, p.product_usd], ['planned', 'product', T]);
  assert.deepEqual(p.rows, [{ kind: 'target_profit', scope: 'option', scope_id: 'm1', amount_usd: null }]);
  assert.deepEqual(p.scopes, []);
  // A single ceiling product rule goes back to T the same way (the record says it was the estimator's).
  const single = planEstimateProfits({ skus: grid([]), costs: {}, usd_iqd: null, min_profit_usd: T, profit_cap_pct: null, rules: [productRule('0.212812')], applied: record('0.212812') });
  // No ceiling and no scope record: today's planner alone puts T back (step 4), nothing here.
  assert.equal(single.kind, 'none');
});

test('(d) a SKU with no cost, or no U: nothing is priced from a guess; a type with no minimum profit writes nothing', () => {
  const skus = grid([['m1', 'm2']]);
  assert.equal(plan({ skus, costs: { 'o:m1': '3659.5' } }).kind, 'unpriced');
  assert.equal(plan({ skus, costs: { 'o:m1': '3659.5', 'o:m2': '2900' }, usd_iqd: null }).kind, 'unpriced');
  assert.equal(plan({ skus, costs: { 'o:m1': '3659.5', 'o:m2': '2900' }, min_profit_usd: null }).kind, 'owner');
});

/* --------------------------------------------- (e) the wire's own limit -- */

/** USD text in whole millionths. */
const micro = (usd: string): number => Math.round(Number(usd) * 1_000_000);

/** What one SKU's shared profit gives it, re-derived with the engine's own rounding: its price and its margin. */
function sharedFigures(cost: string, amount: string, difference: string | null = null, u = U): { price: number; keeps: boolean } {
  const plus = difference !== null && !difference.startsWith('-') ? procurementExact(difference) : procurementExact(0);
  const margin = mulProcurementExact(addProcurementExact(procurementExact(amount), plus), procurementExact(u));
  const price = roundPriceIqd(addProcurementExact(procurementExact(cost), margin));
  return { price, keeps: compareProcurementExact(margin, procurementExact(marginNeededIqd(price))) >= 0 };
}

/**
 * A representation past the wire's 60 rows: every SKU the estimator prices resolves to the plan's profit for it,
 * never above T (today's price) unless its own target already is; from $5 up at or above its own target; under it
 * (its own price a plain house price) a profit under its own target sells at or under its own price; every profit
 * that is neither its own nor today's T keeps its margin at the price it resolves to; EST_CEILING_SHARED names
 * exactly the SKUs above their own target. Returns the SKUs above and under their own targets.
 */
function assertShared(
  p: EstimateProfitPlan,
  skus: readonly EstimateSku[],
  costOf: (s: EstimateSku) => string,
  opts: { t?: string; ceiling?: string; stored?: readonly EstimateProfitRule[]; differenceOf?: (s: EstimateSku) => string | null } = {}
): { above: string[]; under: string[] } {
  const t = opts.t ?? T;
  const ceiling = opts.ceiling ?? P;
  const rules = rulesAfter(opts.stored ?? [productRule(t)], p.rows);
  const above: string[] = [];
  const under: string[] = [];
  for (const tg of p.targets) {
    const s = skus.find((x) => x.combo_key === tg.combo_key)!;
    const cost = costOf(s);
    const difference = opts.differenceOf?.(s) ?? null;
    const r = resolve(rules, s);
    assert.ok(r.status === 'active' && !r.tie, tg.combo_key);
    if (r.status !== 'active') return { above, under };
    assert.equal(r.amount_usd, tg.amount_usd, `${tg.combo_key}: the plan says what the rules resolve to`);
    const own = ceilingProfitUsd(t, ceiling, cost, U, difference)!;
    const x = charmTarget({ cost_iqd: cost, usd_iqd: U, min_profit_usd: t, ceiling_pct: ceiling, difference_usd: difference })!;
    const [a, least, top] = [micro(tg.amount_usd), micro(own), micro(t)];
    const at = `${tg.combo_key} (R ${cost}, own ${own}, shared ${tg.amount_usd})`;
    assert.ok(a <= Math.max(least, top), `${at}: never above today's price`);
    if (a > least) above.push(tg.combo_key);
    if (a < least) {
      under.push(tg.combo_key);
      assert.equal(x.basis, 'plain', `${at}: only under $5 a profit under its own`);
      assert.ok(sharedFigures(cost, tg.amount_usd, difference).price <= x.price_iqd, `${at}: at or under its own price ${x.price_iqd}`);
    }
    if (a !== least && !(a === top && top > least)) assert.ok(sharedFigures(cost, tg.amount_usd, difference).keeps, `${at}: its margin at ${sharedFigures(cost, tg.amount_usd, difference).price}`);
  }
  const flag = p.flags.find((f) => f.code === CEILING_SHARED_FLAG);
  assert.deepEqual(flag?.combo_keys ?? [], [...above].sort(), 'EST_CEILING_SHARED names exactly the SKUs above their own');
  return { above, under };
}

test('(e) no exact representation fits the wire: one profit per group — 61 SKUs on one product rule, never blocked: under $5 every one at its own house price, from $5 up the dearest, flagged; sixty fit exactly', () => {
  const sixtyOne = grid([Array.from({ length: 61 }, (_, i) => `v${i}`)], ['c_red']);
  const costs = Object.fromEntries(sixtyOne.map((s, i) => [s.combo_key, String(2000 + i)]));
  const groups = Object.fromEntries(sixtyOne.map((s) => [s.option_value_ids[0]!, 'g0']));
  // Each SKU its own cost, under $5 — the house price that keeps the margin: R 2,000 at 2,250 (250 over it), 2,001 to
  // 2,060 at 2,500 (their ceilings, 2,201–2,266, hold none), each its own profit: 61 option or SKU rules, more than the
  // wire's 60; one colour cannot be exact.
  assert.equal(new Set(Object.values(costs).map((c) => want(c))).size, 61);
  const shared = plan({ skus: sixtyOne, costs, option_groups: groups });
  // Under $5 the cheapest of their profits, R 2,000's (2,250 − 2,000 = 250 IQD, $0.15625): every SKU keeps its margin
  // there, so the one product rule — as little profit as one colour rule, in as few rows, the least specific — sells
  // none above its own house price. The dearest ($0.311875, R 2,001's) sold 59 of them a step over their own, at 2,750.
  assert.deepEqual([shared.kind, shared.level, shared.product_usd], ['planned', 'product', '0.15625']);
  assert.deepEqual(shared.rows, [{ kind: 'target_profit', scope: 'product', amount_usd: '0.15625' }]);
  const { above, under } = assertShared(shared, sixtyOne, (s) => costs[s.combo_key]!);
  assert.deepEqual([above.length, under.length], [0, 60], 'none above its own; 60 at a profit under their own');
  // Every one at its own price, under today's (11,750): R 2,000 at 2,250, the 60 others at 2,500, each 250 IQD or more
  // over its cost; their dollar figures (R + $0.15625 × U) under 2,500's own. Nothing above its own: no flag.
  for (const [i, s] of sixtyOne.entries()) assert.equal(priceOf(costs[s.combo_key]!, '0.15625'), i === 0 ? 2_250 : 2_500, s.combo_key);
  assert.ok(!shared.flags.some((f) => f.code === CEILING_SHARED_FLAG));
  // From $5 up a charm price often leaves that slack: the same 61 SKUs at 17,000–17,060 IQD share $10.99's dearest
  // profit (10.99 − 17,000 ÷ 1,600 = $0.365), every one still at 17,750 — named, the 60 above their own profit (their
  // dollar prices off the grid).
  const dearCosts = Object.fromEntries(sixtyOne.map((s, i) => [s.combo_key, String(17_000 + i)]));
  const dear = plan({ skus: sixtyOne, costs: dearCosts, option_groups: groups });
  assert.deepEqual([dear.level, dear.product_usd], ['product', '0.365']);
  for (const s of sixtyOne) assert.equal(priceOf(dearCosts[s.combo_key]!, '0.365'), 17_750, s.combo_key);
  assert.equal(assertShared(dear, sixtyOne, (s) => dearCosts[s.combo_key]!).above.length, 60);
  assert.ok((ESTIMATE_INFO_FLAGS as readonly string[]).includes(CEILING_SHARED_FLAG) && !ESTIMATE_INPUT_BLOCKING.includes(CEILING_SHARED_FLAG as never), 'information, never blocking');
  // Through the plan: priced, not blocked.
  const skuPlan = planEstimateInputs({
    skus: sixtyOne,
    prices: new Map(sixtyOne.map((s) => [s.combo_key, { amount: '15', currency: 'CNY' as const, source: 'tmall_cn' as const, ref: 'sps_1' }])),
    type: TYPE,
    inputs: [],
  });
  const out = withEstimateProfits(skuPlan, shared);
  assert.deepEqual(out.blocked_by, skuPlan.blocked_by);
  assert.equal(out.wire.cost.minimum_profit, '0.15625');
  const outDear = withEstimateProfits(skuPlan, dear);
  assert.deepEqual(outDear.blocked_by, skuPlan.blocked_by);
  assert.equal(outDear.wire.cost.minimum_profit, '0.365');
  assert.ok(outDear.flags.some((f) => f.code === CEILING_SHARED_FLAG));
  // Sixty fit exactly: one option rule each, no flag.
  const sixty = sixtyOne.slice(0, 60);
  const fits = plan({ skus: sixty, costs, option_groups: groups });
  assert.deepEqual([fits.kind, fits.level, fits.rows.length], ['planned', 'option', 60]);
  assert.ok(!fits.flags.some((f) => f.code === CEILING_SHARED_FLAG));
  assertExact(fits, sixty);
});

test('(e) the 62-SKU filament — 31 colours × spool / refill, the cost by colour, the box by model — is priced on its colours, each the dearer of its two', () => {
  const colours = Array.from({ length: 31 }, (_, i) => `k${String(i).padStart(2, '0')}`);
  const groups = [['m_spool', 'm_refill']];
  const skus = grid(groups, colours);
  // 59–65 CNY by colour (× 240), the spool's box 2,800 IQD by sea, the refill's 2,200: R from 16,360 to 18,400.
  const costOf = (s: EstimateSku) => String((59 + (Number(s.color_id!.slice(1)) % 7)) * 240 + (s.option_value_ids[0] === 'm_spool' ? 2_800 : 2_200));
  const costs = Object.fromEntries(skus.map((s) => [s.combo_key, costOf(s)]));
  const filament = { min_profit_usd: '7.5', profit_cap_pct: '6', rules: [productRule('7.5')], applied: record('7.5') };
  const own = (s: EstimateSku) => ceilingProfitUsd('7.5', '6', costs[s.combo_key]!, U)!;
  // Exact: no option group (a model's profit follows the colour), no colour (spool and refill differ), 62 SKU rules.
  assert.ok(skus.length === 62 && colours.every((c) => own(skus.find((s) => s.color_id === c && s.option_value_ids[0] === 'm_spool')!) !== own(skus.find((s) => s.color_id === c && s.option_value_ids[0] === 'm_refill')!)));
  const p = plan({ skus, costs, option_groups: groupsOf(groups), ...filament });
  // The colours add the least: 31 rules, each the dearer of its spool and refill.
  assert.deepEqual([p.kind, p.level, p.product_usd, p.rows.length], ['planned', 'color', '7.5', 31]);
  assert.equal(assertShared(p, skus, (s) => costs[s.combo_key]!, { t: '7.5', ceiling: '6' }).under.length, 0, 'from $5 up never under its own');
  for (const s of skus) {
    const tg = p.targets.find((x) => x.combo_key === s.combo_key)!;
    const price = priceOf(costs[s.combo_key]!, tg.amount_usd);
    assert.ok(price <= priceOf(costs[s.combo_key]!, '7.5'), `${s.combo_key}: never above today's`);
    assert.ok(Number(tg.amount_usd) * Number(U) >= marginNeededIqd(price), `${s.combo_key}: its margin kept`);
  }
  // The dearer the other two shared representations would be: one product rule, or the models' two.
  const added = (q: EstimateProfitPlan) => q.targets.reduce((sum, tg) => sum + Number(tg.amount_usd) - Number(own(skus.find((s) => s.combo_key === tg.combo_key)!)), 0);
  assert.ok(added(p) > 0 && added(p) < 31 * 1.01, `the colours add at most a dollar a colour (${added(p).toFixed(6)})`);
  const flag = p.flags.find((f) => f.code === CEILING_SHARED_FLAG)!;
  assert.equal(flag.combo_keys!.length, 31, 'one SKU of each colour rides its sibling’s profit');
});

test('(e) under $5 a shared profit never costs a SKU its margin: the cheapest when every SKU keeps it there, else the least that keeps each at or above its own price', () => {
  const sixtyOne = grid([Array.from({ length: 61 }, (_, i) => `v${i}`)], ['c_red']);
  const groups = Object.fromEntries(sixtyOne.map((s) => [s.option_value_ids[0]!, 'g0']));
  const costsFrom = (first: number) => Object.fromEntries(sixtyOne.map((s, i) => [s.combo_key, String(first + i)]));
  // R 900–960 at 10%: their own prices in whole dinars, 990–999 (90 IQD over R) and 1,000 (90 down to 40). The dearest
  // profit, $0.05625, sold 50 of them at 1,250 with 90 IQD of margin — under one rounding step there, so the next rise
  // of the cost closed their route. The cheapest, R 960's $0.025 (40 IQD), keeps every one at or under its own price,
  // each a dinar or more over its cost: R 900 at 940, R 960 at 1,000.
  const thin = costsFrom(900);
  const p = plan({ skus: sixtyOne, costs: thin, option_groups: groups });
  assert.deepEqual([p.kind, p.level, p.product_usd], ['planned', 'product', '0.025']);
  const thinShared = assertShared(p, sixtyOne, (s) => thin[s.combo_key]!);
  assert.deepEqual([thinShared.above.length, thinShared.under.length], [0, 60]);
  assert.deepEqual([priceOf('900', '0.025'), priceOf('909', '0.025'), priceOf('910', '0.025'), priceOf('960', '0.025')], [940, 949, 950, 1_000]);
  assert.ok(sixtyOne.every((s) => priceOf(thin[s.combo_key]!, '0.025') <= 1_000), 'never 1,250 on a 90 IQD margin');
  // R 970–1,030: 999 and under sell at 1,000, 1,000 at 1,250, 1,001 and up at 1,500. At the cheapest profit, R 999's
  // $0.000625, a SKU over 1,000 IQD keeps a dinar — under one step: no profit keeps every one at or under its own. The
  // least that keeps each at or above its own with its margin, $0.15625: 1,000 → 1,250 for the thirty under 1,000, the
  // others at their own — where the dearest ($0.311875) sold the thirty at 1,500 and 29 more a step over their own.
  const straddle = costsFrom(970);
  const q = plan({ skus: sixtyOne, costs: straddle, option_groups: groups });
  assert.deepEqual([q.kind, q.level, q.product_usd], ['planned', 'product', '0.15625']);
  const straddleShared = assertShared(q, sixtyOne, (s) => straddle[s.combo_key]!);
  assert.equal(straddleShared.above.length, 30, 'named: the thirty above their own');
  const moves = sixtyOne.map((s) => `${priceOf(straddle[s.combo_key]!, want(straddle[s.combo_key]!))}→${priceOf(straddle[s.combo_key]!, '0.15625')}`);
  assert.deepEqual([moves.filter((m) => m === '1000→1250').length, moves.filter((m) => m === '1250→1250').length, moves.filter((m) => m === '1500→1500').length], [30, 1, 30]);
});

test('(e) property: past the wire’s 60 rows no SKU loses its margin or passes today’s price; from $5 up none under its own profit; under $5 none above its own price where the cheapest profit keeps every margin', () => {
  const rnd = prng(2_911);
  const pick = <V>(xs: readonly V[]) => xs[Math.floor(rnd() * xs.length)]!;
  const bands: ReadonlyArray<readonly [number, number]> = [
    [1, 999],
    [880, 1_120],
    [1_000, 8_000],
    [7_000, 9_600],
    [9_000, 40_000],
    [1, 40_000],
  ];
  const counted = { plans: 0, shared: 0, plainOnly: 0, above: 0, under: 0, uncapped: 0 };
  for (let round = 0; round < 80; round++) {
    // 61 to 72 SKUs, one option group by one or two colours, each its own cost: more profits than the wire's 60 rows.
    const colours = rnd() < 0.5 ? ['c_a'] : ['c_a', 'c_b'];
    const values = Array.from({ length: Math.ceil((61 + Math.floor(rnd() * 12)) / colours.length) }, (_, i) => `v${i}`);
    const skus = grid([values], colours);
    const [lo, hi] = pick(bands);
    const ceiling = pick(['0', '3', '6', '10', '25', '100']);
    const t = pick(['6', '4.5', '1.5', '0.15']);
    const costs = Object.fromEntries(skus.map((s) => [s.combo_key, (lo + rnd() * (hi - lo)).toFixed(pick([0, 0, 1, 3]))]));
    // The owner's +$0.40 on the second colour, on some rounds.
    const tinted = rnd() < 0.3;
    const differenceOf = (s: EstimateSku) => (tinted && s.color_id === 'c_b' ? '0.4' : null);
    const p = plan({
      skus,
      costs,
      option_groups: groupsOf([values]),
      profit_cap_pct: ceiling,
      min_profit_usd: t,
      rules: [productRule(t)],
      applied: record(t),
      ...(tinted ? { differences: new Map(skus.filter((s) => differenceOf(s)).map((s) => [s.combo_key, differenceOf(s)!])) } : {}),
    });
    const at = `round ${round} (R ${lo}–${hi}, P ${ceiling}, T ${t}${tinted ? ', tinted' : ''})`;
    if (p.kind === 'uncapped') {
      counted.uncapped++;
      continue;
    }
    assert.equal(p.kind, 'planned', at);
    counted.plans++;
    const { above, under } = assertShared(p, skus, (s) => costs[s.combo_key]!, { t, ceiling, differenceOf });
    if (above.length || under.length) counted.shared++;
    counted.above += above.length;
    counted.under += under.length;
    // Under $5 throughout, where the product's cheapest profit keeps every SKU's margin: nothing above its own price.
    const own = (s: EstimateSku) => ceilingProfitUsd(t, ceiling, costs[s.combo_key]!, U, differenceOf(s))!;
    const plain = skus.every((s) => charmTarget({ cost_iqd: costs[s.combo_key]!, usd_iqd: U, min_profit_usd: t, ceiling_pct: ceiling, difference_usd: differenceOf(s) })!.basis === 'plain');
    if (plain) {
      const cheapest = skus.map(own).reduce((a, b) => (micro(a) < micro(b) ? a : b));
      if (skus.every((s) => own(s) === cheapest || sharedFigures(costs[s.combo_key]!, cheapest, differenceOf(s)).keeps)) {
        counted.plainOnly++;
        assert.deepEqual(above, [], `${at}: under $5 none above its own price`);
      }
    }
  }
  // Not vacuous: shared plans, SKUs above and under their own, under $5 throughout.
  assert.ok(counted.plans > 50 && counted.shared > 40 && counted.plainOnly > 5 && counted.above > 200 && counted.under > 200, JSON.stringify(counted));
});

test('(e) not even that fits: the product with no ceiling — today’s rule at today’s U — flagged, never blocked; only an owner’s product rule with more ceiling rules to take back than one wire takes blocks', () => {
  // 62 colours, each its own cost; the owner CLEARED the ceiling's rule on the first (so the product rule must stay T:
  // no product-wide profit), and 61 colour rules are more than one wire takes.
  const colours = Array.from({ length: 62 }, (_, i) => `k${String(i).padStart(2, '0')}`);
  const skus = grid([], colours);
  const costs = Object.fromEntries(skus.map((s, i) => [s.combo_key, String(3000 + i * 37)]));
  const scopes = [{ scope: 'color' as const, scope_id: 'k00', amount_usd: '0.5', source: 'type_default' as const }];
  const stored = [productRule(), { scope: 'color', scope_id: 'k00', state: 'INHERIT', amount_usd: null }];
  const p = plan({ skus, costs, rules: stored, applied: record(T, scopes) });
  assert.deepEqual([p.kind, p.rows, p.held], ['uncapped', [], ['c:k00']]);
  assert.ok(p.targets.every((t) => t.amount_usd === T && !t.capped), 'every SKU at T: today’s rule');
  assert.deepEqual(p.flags.find((f) => f.code === CEILING_SHARED_FLAG)!.combo_keys!.length, 61);
  assert.ok(!p.flags.some((f) => f.code === 'EST_TOO_MANY_SCOPES'));
  // Through the plan: the plan's own minimum profit, nothing blocked; the owner's cleared record kept.
  const prices = new Map(skus.map((s) => [s.combo_key, { amount: '15', currency: 'CNY' as const, source: 'tmall_cn' as const, ref: 'sps_1' }]));
  const skusPlan = planEstimateInputs({ skus, prices, type: TYPE, inputs: [], product_rule: { state: 'ACTIVE', amount_usd: T }, applied: record(T, scopes) });
  const out = withEstimateProfits(skusPlan, p);
  assert.deepEqual(out.wire, skusPlan.wire, 'the very wire compute’s first evaluation priced');
  assert.deepEqual(out.blocked_by, skusPlan.blocked_by);
  assert.deepEqual(out.applied.minimum_profit_scopes, scopes, 'the cleared record stays');
  // The owner's product rule with 61 of the ceiling's rules to take back: more than one wire takes — blocked, as
  // before (it is no price today's rule could write either).
  const many = grid([Array.from({ length: 61 }, (_, i) => `v${i}`)]);
  const manyScopes = many.map((s) => ({ scope: 'option' as const, scope_id: s.option_value_ids[0]!, amount_usd: '0.5', source: 'type_default' as const }));
  const big = plan({
    skus: many,
    costs: {},
    rules: [productRule('4.5'), ...manyScopes.map((f) => ({ scope: 'option', scope_id: f.scope_id, state: 'ACTIVE', amount_usd: '0.5' }))],
    applied: record(T, manyScopes),
  });
  assert.deepEqual([big.kind, big.rows], ['too_many', []]);
  assert.ok(big.flags.some((f) => f.code === 'EST_TOO_MANY_SCOPES'));
});

/* ------------------------------------------------------- (f) the record -- */

test('(f) the record round-trips; its new key only when non-empty — an older record reads and writes exactly as before', () => {
  const older = '{"v":1,"inputs":[{"scope":"base","scope_id":"","field":"shipping_profile","value":"CHINA_SEA","source":"type_default"}],"minimum_profit":{"amount_usd":"6","source":"type_default"}}';
  assert.equal(serializeAppliedWire(parseAppliedWire(older)!), older, 'byte for byte');
  assert.equal('minimum_profit_scopes' in parseAppliedWire(older)!, false);

  const withScopes = record('6', [
    { scope: 'sku', scope_id: 'o:m1|c:c_red', amount_usd: '0.5', source: 'type_default' },
    { scope: 'option', scope_id: 'm2', amount_usd: '0.1775', source: 'type_default' },
    { scope: 'color', scope_id: 'c_blue', amount_usd: '1', source: 'type_default' },
  ]);
  const text = serializeAppliedWire(withScopes);
  assert.equal(
    text,
    '{"v":1,"inputs":[],"minimum_profit":{"amount_usd":"6","source":"type_default"},"minimum_profit_scopes":[{"scope":"option","scope_id":"m2","amount_usd":"0.1775","source":"type_default"},{"scope":"color","scope_id":"c_blue","amount_usd":"1","source":"type_default"},{"scope":"sku","scope_id":"o:m1|c:c_red","amount_usd":"0.5","source":"type_default"}]}'
  );
  assert.equal(serializeAppliedWire(parseAppliedWire(text)!), text);
  // Read defensively: an entry that does not parse is dropped (its rule then reads as the owner's, kept).
  const odd = JSON.parse(text);
  odd.minimum_profit_scopes.push({ scope: 'product', scope_id: '', amount_usd: '1', source: 'type_default' }, { scope: 'option', scope_id: '', amount_usd: '1', source: 'type_default' }, { scope: 'option', scope_id: 'm9', amount_usd: '0', source: 'type_default' }, { scope: 'option', scope_id: 'm2', amount_usd: '9', source: 'type_default' });
  assert.equal(serializeAppliedWire(parseAppliedWire(odd)!), text);
  assert.equal(serializeAppliedWire({ ...withScopes, minimum_profit_scopes: [] }), '{"v":1,"inputs":[],"minimum_profit":{"amount_usd":"6","source":"type_default"}}');
  // Canonical USD in, canonical out.
  assert.equal(canonicalUsdRuleAmount('0.177500'), '0.1775');
});
