/**
 * THE PROFIT CEILING AS IT WAS BEFORE THE RULING «TODAY'S DINAR PRICE SHOWS c» — THE ORACLE (origin 6e72dae1; the lead's
 * ruling for the owner, 2026-11-05; DECISIONS row 291 (ب); docs/SMART_PRICING.md §4.11).
 *
 * `charmTargetBefore` is the pre-change `charmTarget` (packages/pricing/src/charmPrice.ts) and
 * `planEstimateProfitsBefore` the pre-change `planEstimateProfits` (packages/pricing/src/estimateInputs.ts), each copied
 * verbatim with the private helpers they read — only their names differ, and the planner's `charmTarget` is
 * `charmTargetBefore`. Until the ruling a charm price whose dinar price IS today's kept T whatever its dollar figure
 * showed, and the planner knew no other plan. The grid, the margin, the rounding, the resolver and the record's reading
 * they call are the live ones, which the ruling does not touch.
 *
 * Never edit the copies: they are what «no dinar price moves versus today's code» is measured against
 * (tests/charmPriceAtToday.test.ts, tests/estimateProfitCap.test.ts (g), tests/priceEstimateProfitCap.test.ts).
 */
import {
  LOWEST_USED_CHARM_CENTS,
  charmAtLeastCents,
  charmAtMostCents,
  marginNeededIqd,
  priceAtProfit,
  type CharmBasis,
  type CharmTarget,
  type CharmTargetInput,
} from '../../packages/pricing/src/charmPrice';
import {
  CEILING_SHARED_FLAG,
  MAX_ESTIMATE_PROFIT_ROWS,
  MINIMUM_PROFIT_FIELD,
  canonicalProfitCapPct,
  parseAppliedWire,
  type AppliedProfitScope,
  type EstimateFlag,
  type EstimateProfitInput,
  type EstimateProfitPlan,
  type EstimateProfitRow,
  type EstimateProfitRule,
  type EstimateSku,
  type ProfitScope,
} from '../../packages/pricing/src/estimateInputs';
import { PRICE_ROUNDING_STEP_IQD, PRICE_ROUNDING_THRESHOLD_IQD, roundPriceIqd } from '../../packages/pricing/src/priceRounding';
import { canonicalUsdRuleAmount, resolveRuleAt, type PricingRuleRow, type PricingRuleState } from '../../packages/pricing/src/ruleResolution';
import { skuComboKey } from '../../packages/pricing/src/skuChannel';
import { procurementExact, type ProcurementExact } from '../../packages/contracts/src/procurementCost';

/* ------------------------------------------------- charmPrice.ts, verbatim -- */

const MICRO = 1_000_000n;
/** The largest minimum profit a rule may carry (the 0211 USD6 CHECK): $100,000. */
const MAX_PROFIT_MICRO = 100_000n * MICRO;
const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/;
const SIGNED_DECIMAL = /^-?[0-9]+(?:\.[0-9]{1,6})?$/;
const THRESHOLD = BigInt(PRICE_ROUNDING_THRESHOLD_IQD);
const STEP = BigInt(PRICE_ROUNDING_STEP_IQD);

/** Decimal text as an exact rational, with at most `places` decimals when given; null otherwise. */
function decimalOf(raw: unknown, places?: number): ProcurementExact | null {
  if (typeof raw !== 'string') return null;
  const m = DECIMAL.exec(raw);
  if (!m || (places !== undefined && (m[2] ?? '').length > places)) return null;
  return procurementExact(raw);
}

/** Δ⁺: the positive part of a signed sum of differences (absent: none), or null when it does not read. */
function differenceOf(raw: unknown): ProcurementExact | null {
  if (raw === undefined || raw === null) return { num: 0n, den: 1n };
  if (typeof raw !== 'string' || !SIGNED_DECIMAL.test(raw)) return null;
  const d = procurementExact(raw, { signed: true });
  return d.num > 0n ? d : { num: 0n, den: 1n };
}

const floorDiv = (a: bigint, b: bigint): bigint => (a >= 0n ? a / b : -((-a + b - 1n) / b)); // b > 0
const ceilDiv = (a: bigint, b: bigint): bigint => -floorDiv(-a, b); // b > 0

/** The highest house price (rp's own grid: whole dinars to 1,000, then multiples of 250) at or under num ÷ den ≥ 0. */
function housePriceAtMost(num: bigint, den: bigint): number {
  const whole = floorDiv(num, den);
  return Number(whole > THRESHOLD ? (whole / STEP) * STEP : whole);
}

/** Whole micro-dollars as canonical USD text: 202812n → '0.202812', 6000000n → '6'. */
function microText(micro: bigint): string {
  const whole = micro / MICRO;
  const fraction = (micro % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * `charmTarget` AS IT WAS BEFORE THE RULING, verbatim: a price whose dinar price is today's kept T, whatever its dollar
 * figure showed.
 */
export function charmTargetBefore(input: CharmTargetInput): CharmTarget | null {
  const r = decimalOf(input.cost_iqd);
  const u = decimalOf(input.usd_iqd);
  const t = decimalOf(input.min_profit_usd, 6);
  const p = decimalOf(input.ceiling_pct, 2);
  const d = differenceOf(input.difference_usd);
  if (!r || !u || !t || !p || !d || u.num <= 0n || t.num <= 0n) return null;
  if (p.num > 100n * p.den) return null; // P ≤ 100
  const tMicro = (t.num * MICRO) / t.den; // exact: at most six decimals
  if (tMicro > MAX_PROFIT_MICRO) return null;
  const { num: rn, den: rd } = r;
  const { num: un, den: ud } = u;
  const { num: dn, den: dd } = d; // Δ⁺ ≥ 0

  // B = R + Δ⁺ × U: what the engine adds the profit to.
  const bd = rd * dd * ud;
  const bn = rn * dd * ud + dn * un * rd;
  // The engine's price at a profit of `micro` USD millionths: rp(B + micro × U ÷ 10⁶).
  const den = bd * ud * MICRO;
  const priceAt = (micro: bigint): number => roundPriceIqd({ num: bn * ud * MICRO + micro * un * bd, den });
  // T_sku for a charm price c: floor6(c − B ÷ U), in millionths; below one, no profit — not a price for this SKU.
  const charmMicro = (cents: number): bigint => floorDiv((BigInt(cents) * bd * un - 100n * bn * ud) * 10_000n, bd * un);
  // T_sku for a house price D: floor6((D − B) ÷ U), in millionths; below one, the same.
  const houseMicro = (iqd: number): bigint => floorDiv((BigInt(iqd) * bd - bn) * ud * MICRO, bd * un);
  // The least profit whose margin over R, (micro ÷ 10⁶ + Δ⁺) × U, is at least `iqd` dinars — and at least one millionth.
  const leastWith = (iqd: number): bigint => {
    const x = ceilDiv(BigInt(iqd) * MICRO * dd * ud - dn * MICRO * un, dd * un);
    return x < 1n ? 1n : x;
  };
  const leastAtOrUnder = leastWith(marginNeededIqd(PRICE_ROUNDING_THRESHOLD_IQD));
  const leastAbove = leastWith(marginNeededIqd(PRICE_ROUNDING_THRESHOLD_IQD + 1));
  // Does this profit keep the margin its own price needs?
  const keeps = (micro: bigint): boolean => micro >= (priceAt(micro) > PRICE_ROUNDING_THRESHOLD_IQD ? leastAbove : leastAtOrUnder);

  const todayD = priceAt(tMicro);
  const costRounded = roundPriceIqd(r);
  const floorD = roundPriceIqd(BigInt(costRounded) + 1n);
  // capD = R × (100 + P) / 100 + Δ⁺ × U, exact: a price x is within it when x × capDen ≤ capNum.
  const capDen = rd * 100n * p.den * dd * ud;
  const capNum = rn * (100n * p.den + p.num) * dd * ud + dn * un * rd * 100n * p.den;
  const fits = (price: number): boolean => price <= todayD && BigInt(price) * capDen <= capNum;
  // The ceiling min(todayD, capD) as a rational, for the searches' first estimates.
  const ceilingIsToday = BigInt(todayD) * capDen <= capNum;
  const [ceilNum, ceilDen] = ceilingIsToday ? [BigInt(todayD), 1n] : [capNum, capDen];

  const result = (micro: bigint, basis: CharmBasis, cents: number | null): CharmTarget | null =>
    micro >= 1n && micro <= MAX_PROFIT_MICRO
      ? { amount_usd: microText(micro), basis, charm_cents: cents, price_iqd: priceAt(micro), today_iqd: todayD, floor_iqd: floorD }
      : null;
  const today = () => result(tMicro, 'today', null);
  // Nothing goes up while today's price clears the route floor (the floor forces a rise only past it).
  const rises = (micro: bigint): boolean => micro > tMicro && todayD > costRounded;
  const guard = { n: 0 };
  const step = () => {
    if (++guard.n > 100_000) throw new RangeError('charmTarget: the grid search did not settle');
  };
  type Choice = { micro: bigint; price: number };
  // The highest price within the ceiling that keeps the margin, else the lowest that keeps it; then the exceptions.
  const settle = (chosen: Choice, withinCeiling: boolean, basis: 'charm' | 'plain', cents: number | null): CharmTarget | null => {
    // Nothing goes up: today's price clears the floor, so it stays rather than a dearer price.
    if (!withinCeiling && chosen.price > todayD && rises(chosen.micro)) return today();
    // The same price as today: no new rule.
    if (chosen.price === todayD) return today();
    return result(chosen.micro, basis, cents);
  };

  // UNDER $5: no charm price of at least CHARM_MIN_USD fits the ceiling (its lowest, $5.49, prices above it) — the
  // plain house price. Every lower house price keeps less margin, so the walk down stops at the first that keeps it,
  // or where the price is no longer above B; the walk up takes a step or two (each adds a dinar or 250 of margin).
  const lowestUsedIqd = roundPriceIqd({ num: BigInt(LOWEST_USED_CHARM_CENTS) * un, den: 100n * ud });
  if (!fits(lowestUsedIqd)) {
    const houseAt = (iqd: number): Choice | null => {
      const micro = houseMicro(iqd);
      return micro >= 1n ? { micro, price: priceAt(micro) } : null;
    };
    for (let iqd = housePriceAtMost(ceilNum, ceilDen); iqd >= 1; iqd = housePriceAtMost(BigInt(iqd - 1), 1n)) {
      step();
      const at = houseAt(iqd);
      if (!at) break; // every lower house price is at or under B too
      if (fits(at.price) && keeps(at.micro)) return settle(at, true, 'plain', null);
    }
    for (let iqd = roundPriceIqd(floorDiv(bn, bd) + 1n); ; iqd = roundPriceIqd(iqd + 1)) {
      step();
      const at = houseAt(iqd);
      if (at && keeps(at.micro)) return settle(at, false, 'plain', null);
    }
  }

  // FROM $5 UP: the engine's price at a charm price, or null where c is not above the SKU's own cost (and difference)
  // in dollars.
  const charmPrice = (cents: number): (Choice & { cents: number }) | null => {
    const micro = charmMicro(cents);
    return micro >= 1n ? { cents, micro, price: priceAt(micro) } : null;
  };

  // 1. The highest charm price of at least $5 within min(todayD, capD) that keeps the margin. Any c at or above `hi`
  //    cents prices above the ceiling (its price is above c × U less a millionth of U), so the walk starts there and
  //    steps down; under the margin the walk goes on down, until c is no longer above the cost or under $5.
  const hi = Number(floorDiv(100n * ceilNum * ud, ceilDen * un)) + 2;
  for (let c = charmAtMostCents(hi); c !== null && c >= LOWEST_USED_CHARM_CENTS; c = charmAtMostCents(c - 1)) {
    step();
    const at = charmPrice(c);
    if (!at) break; // every lower charm price is below the cost too
    if (fits(at.price) && keeps(at.micro)) return settle(at, true, 'charm', at.cents);
  }

  // 2. None: the lowest charm price of at least $5 that keeps the margin. At or below `lo` cents c is not above the
  //    cost, so the walk starts there and steps up (a step or two: every step adds at least $0.50 × U of margin).
  const lo = Number(floorDiv(100n * bn * ud, bd * un));
  for (let c = charmAtLeastCents(Math.max(LOWEST_USED_CHARM_CENTS, lo)); ; c = charmAtLeastCents(c + 1)) {
    step();
    const at = charmPrice(c);
    if (at && keeps(at.micro)) return settle(at, false, 'charm', at.cents);
  }
}

/* --------------------------------------------- estimateInputs.ts, verbatim -- */

const uniqueSorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

const isMapLike = <V>(m: unknown): m is ReadonlyMap<string, V> => !!m && typeof (m as ReadonlyMap<string, V>).get === 'function';

/** One key of a map or a plain record (own keys only), or null. */
function lookup<V>(m: ReadonlyMap<string, V> | Readonly<Record<string, V | null | undefined>> | null | undefined, key: string): V | null {
  if (!m) return null;
  if (isMapLike<V>(m)) return m.get(key) ?? null;
  const rec = m as Readonly<Record<string, V | null | undefined>>;
  return Object.prototype.hasOwnProperty.call(rec, key) ? (rec[key] ?? null) : null;
}

/** `ceilingProfitUsd` with how the price was chosen (`charmTarget`'s basis) and that price, IQD. */
function ceilingTargetOf(
  minProfitUsd: unknown,
  ceilingPct: unknown,
  costExact: unknown,
  usdIqd: unknown,
  differenceUsd?: unknown
): { amount_usd: string; basis: CharmBasis; price_iqd: number } | null {
  const t = canonicalUsdRuleAmount(minProfitUsd);
  const p = canonicalProfitCapPct(ceilingPct);
  if (t === null || p === null || typeof costExact !== 'string' || typeof usdIqd !== 'string') return null;
  if (differenceUsd !== undefined && differenceUsd !== null && typeof differenceUsd !== 'string') return null;
  const target = charmTargetBefore({ cost_iqd: costExact, usd_iqd: usdIqd, min_profit_usd: t, ceiling_pct: p, difference_usd: differenceUsd ?? null });
  if (!target) return null;
  // Today's price keeps the type's T as the type spells it, so its rule is byte for byte the one it replaces.
  const amount = target.basis === 'today' ? t : canonicalUsdRuleAmount(target.amount_usd);
  return amount === null ? null : { amount_usd: amount, basis: target.basis, price_iqd: target.price_iqd };
}

const PROFIT_SCOPE_RANK: Readonly<Record<ProfitScope, number>> = { option: 0, color: 1, sku: 2 };
const isProfitScope = (v: unknown): v is ProfitScope => v === 'option' || v === 'color' || v === 'sku';
const profitKey = (scope: string, scopeId: string) => `${scope}\u0000${scopeId}`;

function byProfitScope(a: { scope: ProfitScope; scope_id: string }, b: { scope: ProfitScope; scope_id: string }): number {
  return PROFIT_SCOPE_RANK[a.scope] - PROFIT_SCOPE_RANK[b.scope] || (a.scope_id < b.scope_id ? -1 : a.scope_id > b.scope_id ? 1 : 0);
}

/** A stored rule's value as the merge compares it — step 4's reading: null when absent or INHERIT. */
function profitRuleValue(rule: EstimateProfitRule | null | undefined): string | null {
  if (!rule || rule.state === 'INHERIT') return null;
  if (rule.state === 'ACTIVE' && rule.amount_usd != null) return canonicalUsdRuleAmount(rule.amount_usd) ?? `raw:${rule.amount_usd}`;
  if (rule.state === 'ACTIVE' && rule.amount_iqd != null) return `iqd:${rule.amount_iqd}`;
  return `state:${rule.state}`;
}

/** The product the verification's rule rows name (they are this product's alone). */
const PROFIT_RULE_PRODUCT = 'product';

/** The product's rules as an apply of these rows leaves them, as the engine's resolver reads rules. */
function profitRulesAfter(rules: readonly EstimateProfitRule[], rows: readonly EstimateProfitRow[]): PricingRuleRow[] {
  const at = new Map<string, PricingRuleRow>();
  const put = (id: string, scope: 'product' | ProfitScope, scopeId: string, state: string, usd: string | null, iqd: number | null) =>
    at.set(profitKey(scope, scopeId), {
      id,
      kind: 'target_profit',
      scope,
      catalog_id: null,
      product_id: PROFIT_RULE_PRODUCT,
      scope_id: scopeId,
      state: state as PricingRuleState,
      amount_usd: usd,
      amount_iqd: iqd,
      version: 1,
    });
  rules.forEach((r, i) => {
    if (r.scope === 'product') put(`stored:${i}`, 'product', '', r.state, r.amount_usd ?? null, r.amount_iqd ?? null);
    else if (isProfitScope(r.scope) && r.scope_id) put(`stored:${i}`, r.scope, r.scope_id, r.state, r.amount_usd ?? null, r.amount_iqd ?? null);
  });
  for (const w of rows) {
    const scopeId = w.scope === 'product' ? '' : (w.scope_id ?? '');
    put(`written:${profitKey(w.scope, scopeId)}`, w.scope, scopeId, w.amount_usd === null ? 'INHERIT' : 'ACTIVE', w.amount_usd, null);
  }
  return [...at.values()];
}

/**
 * `planEstimateProfits` AS IT WAS BEFORE THE RULING, verbatim: one plan, a charm price at today's dinar price at T.
 */
export function planEstimateProfitsBefore(input: EstimateProfitInput): EstimateProfitPlan {
  const applied = parseAppliedWire(input.applied);
  const records = applied?.minimum_profit_scopes ?? [];
  const cap = input.profit_cap_pct === null || input.profit_cap_pct === undefined ? null : canonicalProfitCapPct(input.profit_cap_pct);
  const out: EstimateProfitPlan = { kind: 'none', level: null, group_id: null, product_usd: null, targets: [], held: [], rows: [], minimum_profit: undefined, scopes: records, flags: [], owner_held: [] };
  if (cap === null && !records.length) return out;

  const { skus } = input;
  const comboOf = (s: EstimateSku) => skuComboKey({ option_value_ids: s.option_value_ids, color_id: s.color_id });
  const reaches = (scope: ProfitScope, scopeId: string, s: EstimateSku): boolean =>
    scope === 'option' ? s.option_value_ids.includes(scopeId) : scope === 'color' ? s.color_id === scopeId : comboOf(s) === scopeId;

  // 1. Who holds each rule below the product (§4.5's reading, rule by rule).
  const stored = new Map<string, EstimateProfitRule & { scope: ProfitScope }>();
  for (const r of input.rules) if (isProfitScope(r.scope) && r.scope_id) stored.set(profitKey(r.scope, r.scope_id), r as EstimateProfitRule & { scope: ProfitScope });
  const recorded = new Map(records.map((f) => [profitKey(f.scope, f.scope_id), f] as const));
  const holderOf = (k: string): 'estimator' | 'owner' | 'cleared' | 'empty' => {
    const value = profitRuleValue(stored.get(k));
    const record = recorded.get(k);
    if (record) return value === record.amount_usd ? 'estimator' : value === null ? 'cleared' : 'owner';
    return value === null ? 'empty' : 'owner';
  };
  // The owner's SKUs: an owner's live rule reaches them (it decides before the product's: `shadowed`), or the owner
  // cleared the cap's rule that reached them (they fall to the product's rule, which then never carries a cap).
  const held = new Set<string>();
  const shadowed = new Set<string>();
  let ownerEdited = false;
  for (const k of uniqueSorted([...stored.keys(), ...recorded.keys()])) {
    const holder = holderOf(k);
    if (holder === 'estimator' || holder === 'empty') continue;
    const at = (recorded.get(k) ?? stored.get(k))!;
    if (recorded.has(k)) ownerEdited = true;
    else out.owner_held.push({ scope: at.scope, scope_id: at.scope_id, field: MINIMUM_PROFIT_FIELD });
    for (const s of skus) {
      if (!reaches(at.scope, at.scope_id, s)) continue;
      held.add(s.combo_key);
      if (holder === 'owner') shadowed.add(s.combo_key);
    }
  }
  out.held = uniqueSorted(held);
  out.owner_held.sort(byProfitScope);
  if (ownerEdited) out.flags.push({ code: 'EST_OWNER_EDITED', fields: [MINIMUM_PROFIT_FIELD] });
  // The ids a rule may name on this product: a rule at any other id would be refused by the wire's parser.
  const fromSkus = {
    option: new Set(skus.flatMap((s) => s.option_value_ids.filter(Boolean))),
    color: new Set(skus.map((s) => s.color_id).filter((c): c is string => !!c)),
    sku: new Set(skus.map(comboOf).filter(Boolean)),
  };
  const sets: Record<ProfitScope, Set<string>> = {
    option: input.scopes?.option ? new Set(input.scopes.option) : fromSkus.option,
    color: input.scopes?.color ? new Set(input.scopes.color) : fromSkus.color,
    sku: input.scopes?.sku ? new Set(input.scopes.sku) : fromSkus.sku,
  };
  const tooMany: EstimateFlag = { code: 'EST_TOO_MANY_SCOPES', fields: [MINIMUM_PROFIT_FIELD] };

  // 2. The product's own rule: the estimator's or empty exactly as step 4 of `planEstimateInputs` reads it. A type
  //    with no minimum profit (EST_TYPE_INCOMPLETE, blocking) writes nothing and carries the record's rules.
  const typeProfit = canonicalUsdRuleAmount(input.min_profit_usd);
  const productValue = profitRuleValue(input.rules.find((r) => r.scope === 'product'));
  const productRecord = applied?.minimum_profit ?? null;
  const productOurs = productRecord ? productValue === productRecord.amount_usd : productValue === null;
  if (typeProfit === null) return { ...out, kind: 'owner' };
  if (!productOurs) {
    // The owner's own product rule: no profit amount is written, and it decides every SKU as it did before the cap.
    // So the cap's own option, colour and SKU rules — which would still decide their SKUs before his rule, and which
    // the product form does not draw — go back to inherit and leave the record; his own rules, a rule he cleared and
    // one the wire can no longer name are kept as they are.
    const back = records.filter((f) => holderOf(profitKey(f.scope, f.scope_id)) === 'estimator' && sets[f.scope].has(f.scope_id));
    if (back.length > MAX_ESTIMATE_PROFIT_ROWS) return { ...out, kind: 'too_many', flags: [...out.flags, tooMany] };
    return {
      ...out,
      kind: 'owner',
      rows: back.map((f) => ({ kind: 'target_profit' as const, scope: f.scope, scope_id: f.scope_id, amount_usd: null })),
      scopes: records.filter((f) => !back.includes(f)),
    };
  }

  // Nothing planned — a SKU with no cost to cap from, or no representation the wire takes: the product is priced as
  // it sells with no cap (this planner with no P: every SKU the estimator prices at T, the cap's own scope rules back
  // to inherit) — the very plan compute's first evaluation priced, so that evaluation stands and blocks it. When even
  // that cannot be written, the plan's own wire and the record's rules are kept.
  const unplanned = (kind: 'unpriced' | 'too_many', flags: EstimateFlag[]): EstimateProfitPlan => {
    const uncapped = cap === null ? null : planEstimateProfitsBefore({ ...input, profit_cap_pct: null });
    const back = uncapped?.kind === 'planned' ? uncapped : null;
    return { ...out, kind, flags, ...(back ? { rows: back.rows, minimum_profit: back.minimum_profit, scopes: back.scopes } : {}) };
  };

  // 3. Each SKU the estimator prices, its target: T, or under the ceiling its own price's profit — a dollar charm price
  //    from $5 up, the house price under it (`charmTarget`, its own differences counted) — T for a SKU the owner prices
  //    himself in dollars, whose minimum profit is only its floor (the ceiling leaves his price alone).
  const free = skus.filter((s) => !held.has(s.combo_key));
  const fixed = new Set(input.fixed ?? []);
  const targets = new Map<string, string>();
  // The SKUs priced under $5 at their plain house price (`charmTarget`'s `plain`), with that price: the only ones a
  // shared rule may price under their own price (step 6).
  const plainPrice = new Map<string, number>();
  for (const s of free) {
    if (cap === null || fixed.has(s.combo_key)) {
      targets.set(s.combo_key, typeProfit);
      continue;
    }
    const x = ceilingTargetOf(typeProfit, cap, lookup<string>(input.costs, s.combo_key), input.usd_iqd, lookup<string>(input.differences, s.combo_key));
    if (x === null) return unplanned('unpriced', out.flags);
    targets.set(s.combo_key, x.amount_usd);
    if (x.basis === 'plain') plainPrice.set(s.combo_key, x.price_iqd);
  }
  out.targets = free.map((s) => ({ combo_key: s.combo_key, amount_usd: targets.get(s.combo_key)!, capped: targets.get(s.combo_key) !== typeProfit }));

  // 4. The candidates, least specific first.
  interface Candidate {
    level: Exclude<EstimateProfitPlan['level'], null>;
    group_id: string | null;
    product: string;
    wanted: Map<string, AppliedProfitScope>;
  }
  const candidates: Candidate[] = [];
  const amounts = uniqueSorted(targets.values());
  const clearedOnly = [...held].some((k) => !shadowed.has(k));
  // The option groups of the SKUs the estimator prices, in relation order (the model's first), and a SKU's one value in each.
  const groupOf = (id: string): string => lookup<string>(input.option_groups, id) ?? '';
  const valueIn = (g: string) => (s: EstimateSku): string | null => {
    const values = s.option_value_ids.filter((id) => id && groupOf(id) === g);
    return values.length === 1 ? values[0]! : null;
  };
  const groupsOf = (list: readonly EstimateSku[]): string[] => {
    const out: string[] = [];
    for (const s of list) for (const id of s.option_value_ids.filter(Boolean)) if (!out.includes(groupOf(id))) out.push(groupOf(id));
    return out;
  };
  if (amounts.length <= 1 && (!amounts.length || amounts[0] === typeProfit || !clearedOnly)) {
    candidates.push({ level: 'product', group_id: null, product: amounts[0] ?? typeProfit, wanted: new Map() });
  } else {
    const capped = free.filter((s) => targets.get(s.combo_key) !== typeProfit);
    // One rule per id, each the profit of every capped SKU it names — or no such candidate.
    const by = (scope: ProfitScope, idOf: (s: EstimateSku) => string | null): Map<string, AppliedProfitScope> | null => {
      const wanted = new Map<string, AppliedProfitScope>();
      for (const s of capped) {
        const id = idOf(s);
        if (!id) return null;
        const amount = targets.get(s.combo_key)!;
        const k = profitKey(scope, id);
        const seen = wanted.get(k);
        if (seen && seen.amount_usd !== amount) return null;
        wanted.set(k, { scope, scope_id: id, amount_usd: amount, source: 'type_default' });
      }
      return wanted;
    };
    // ONE option group, in relation order (the model's first), fewest rules first.
    const options = groupsOf(capped)
      .flatMap((g, order) => {
        const wanted = by('option', valueIn(g));
        return wanted ? [{ g, order, wanted }] : [];
      })
      .sort((a, b) => a.wanted.size - b.wanted.size || a.order - b.order);
    for (const o of options) candidates.push({ level: 'option', group_id: o.g, product: typeProfit, wanted: o.wanted });
    const colours = by('color', (s) => s.color_id);
    if (colours) candidates.push({ level: 'color', group_id: null, product: typeProfit, wanted: colours });
    const own = by('sku', (s) => comboOf(s) || null);
    if (own) candidates.push({ level: 'sku', group_id: null, product: typeProfit, wanted: own });
  }

  // 5. The first candidate that merges, fits the wire and resolves every SKU exactly.
  const merge = (c: Candidate, accept: (s: EstimateSku, amount: string) => boolean): { rows: EstimateProfitRow[]; records: AppliedProfitScope[]; amounts: Map<string, string> } | null => {
    for (const w of c.wanted.values()) {
      // Never at a scope the wire may not name or the owner holds, never reaching a SKU the owner holds.
      if (!sets[w.scope].has(w.scope_id)) return null;
      const holder = holderOf(profitKey(w.scope, w.scope_id));
      if (holder === 'owner' || holder === 'cleared') return null;
      if (skus.some((s) => held.has(s.combo_key) && reaches(w.scope, w.scope_id, s))) return null;
    }
    const scopeRows: Array<EstimateProfitRow & { scope: ProfitScope; scope_id: string }> = [];
    const next: AppliedProfitScope[] = [];
    for (const k of uniqueSorted([...recorded.keys(), ...c.wanted.keys()])) {
      const want = c.wanted.get(k);
      const record = recorded.get(k);
      const holder = holderOf(k);
      if (want) {
        if (!(holder === 'estimator' && record!.amount_usd === want.amount_usd)) scopeRows.push({ kind: 'target_profit', scope: want.scope, scope_id: want.scope_id, amount_usd: want.amount_usd });
        next.push(want);
      } else if (holder === 'estimator' && sets[record!.scope].has(record!.scope_id)) {
        // The cap's own rule, no longer wanted: back to inherit.
        scopeRows.push({ kind: 'target_profit', scope: record!.scope, scope_id: record!.scope_id, amount_usd: null });
      } else if (record) {
        // The owner's (changed or cleared), or at a scope the product no longer offers: kept, never cleared through the wire.
        next.push(record);
      }
    }
    const rows: EstimateProfitRow[] = [...(productValue === c.product ? [] : [{ kind: 'target_profit' as const, scope: 'product' as const, amount_usd: c.product }]), ...scopeRows.sort(byProfitScope)];
    if (rows.length > MAX_ESTIMATE_PROFIT_ROWS) return null;
    // Every SKU the estimator prices resolves, through the engine's own walk over the rules as the write leaves
    // them, to a profit the candidate accepts — no tie, nothing else deciding.
    const rules = profitRulesAfter(input.rules, rows);
    const resolved = new Map<string, string>();
    for (const s of free) {
      const r = resolveRuleAt(rules, 'target_profit', { product_id: PROFIT_RULE_PRODUCT, option_value_ids: s.option_value_ids, color_id: s.color_id, ancestry: [] }, { usdIqdRate: input.usd_iqd });
      const amount = r.status === 'active' && !r.tie ? r.amount_usd : null;
      if (typeof amount !== 'string' || !accept(s, amount)) return null;
      resolved.set(s.combo_key, amount);
    }
    return { rows, records: next.sort(byProfitScope), amounts: resolved };
  };
  const planned = (c: Candidate, merged: NonNullable<ReturnType<typeof merge>>): EstimateProfitPlan => ({
    ...out,
    kind: 'planned',
    level: c.level,
    group_id: c.group_id,
    product_usd: c.product,
    rows: merged.rows,
    minimum_profit: { amount_usd: c.product, source: 'type_default' },
    scopes: merged.records,
  });
  for (const c of candidates) {
    const merged = merge(c, (s, amount) => amount === targets.get(s.combo_key));
    if (merged) return planned(c, merged);
  }
  if (cap === null) return unplanned('too_many', [...out.flags, tooMany]);

  // 6. None exact fits the wire: ONE PROFIT PER GROUP (§4.11) — one product rule, the values of one option group, or
  //    the colours (a value whose SKUs would all take T, or one reaching an owner's SKU, gets no rule: its SKUs fall
  //    to the product's T). Each rule is the DEAREST target among the SKUs it reaches, so every one sells at or above
  //    its own price's profit (its dollar price may leave the grid) — except where every SKU it reaches sells under $5
  //    at its plain house price: there it is the CHEAPEST of their targets, the highest profit at which none sells
  //    above its own house price, whenever each still keeps its margin there (a dearer one would lift a house price
  //    that leaves no slack under the next step a whole step), else the least profit that keeps each at or above its
  //    own house price with its margin (a group across 1,000 IQD). No SKU resolves above T, today's price (above it only
  //    where its own target already is), none from $5 up under its own target, and each whose profit is not its own
  //    keeps its margin at the price it resolves to (today's price excepted). The candidate adding the least profit
  //    above the SKUs' own wins, then the one taking the least under their own prices, then the fewest rows, then the
  //    least specific. EST_CEILING_SHARED names the SKUs above their own.
  const micro = (usd: string): bigint => {
    const [whole, fraction = ''] = usd.split('.');
    return BigInt(whole!) * 1_000_000n + BigInt(`${fraction}000000`.slice(0, 6));
  };
  const usdOf = (m: bigint): string => canonicalUsdRuleAmount(`${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, '0')}`)!;
  const typeMicro = micro(typeProfit);
  const own = (s: EstimateSku): bigint => micro(targets.get(s.combo_key)!);
  // The engine's price at a profit, and whether its margin holds there — the SKU's own R and differences.
  const at = (s: EstimateSku, m: bigint) =>
    priceAtProfit({ cost_iqd: lookup<string>(input.costs, s.combo_key) ?? '', usd_iqd: input.usd_iqd ?? '', difference_usd: lookup<string>(input.differences, s.combo_key) }, usdOf(m));
  const within = (s: EstimateSku, amount: string): boolean => {
    const a = micro(amount);
    const least = own(s);
    if (a === least) return true;
    // Never above today's price (above it only where its own target already is); from $5 up never under its own.
    if (a > (least > typeMicro ? least : typeMicro) || (a < least && !plainPrice.has(s.combo_key))) return false;
    // Today's price itself, or any other profit whose margin holds at the price it resolves to.
    return (a === typeMicro && a > least) || at(s, a)?.keeps === true;
  };
  // The least profit at which a SKU priced under $5 still sells at its own house price with its margin: every profit
  // from it to its own target does (one price, a margin that grows with the profit), every lower one does not.
  const leastAtOwn = (s: EstimateSku): bigint => {
    const price = plainPrice.get(s.combo_key)!;
    let lo = 1n;
    let hi = own(s);
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const x = at(s, mid);
      if (x !== null && x.price_iqd === price && x.keeps) hi = mid;
      else lo = mid + 1n;
    }
    return hi;
  };
  // One group's profit: the dearest of its SKUs' own. Under $5 (every SKU it reaches at its plain house price) the
  // cheapest — none above its own price — when every one keeps its margin there; else the least that keeps every one
  // at or above its own price, when every one keeps its margin there; else the dearest.
  const groupMicro = (list: readonly EstimateSku[]): bigint => {
    const owns = list.map(own);
    const dearest = owns.reduce((a, b) => (a > b ? a : b));
    if (!list.every((s) => plainPrice.has(s.combo_key))) return dearest;
    const cheapest = owns.reduce((a, b) => (a < b ? a : b));
    if (list.every((s) => own(s) === cheapest || at(s, cheapest)?.keeps === true)) return cheapest;
    const least = list.map(leastAtOwn).reduce((a, b) => (a > b ? a : b));
    return list.every((s) => least <= own(s) || at(s, least)?.keeps === true) ? least : dearest;
  };
  const sharedBy = (scope: ProfitScope, idOf: (s: EstimateSku) => string | null): Map<string, AppliedProfitScope> => {
    const members = new Map<string, EstimateSku[]>();
    for (const s of free) {
      const id = idOf(s);
      if (id) members.set(id, [...(members.get(id) ?? []), s]);
    }
    const wanted = new Map<string, AppliedProfitScope>();
    for (const [id, list] of members) {
      const m = groupMicro(list);
      if (m === typeMicro || skus.some((x) => held.has(x.combo_key) && reaches(scope, id, x))) continue;
      wanted.set(profitKey(scope, id), { scope, scope_id: id, amount_usd: usdOf(m), source: 'type_default' });
    }
    return wanted;
  };
  const shared: Candidate[] = [];
  if (!clearedOnly && free.length) shared.push({ level: 'product', group_id: null, product: usdOf(groupMicro(free)), wanted: new Map() });
  for (const g of groupsOf(free)) shared.push({ level: 'option', group_id: g, product: typeProfit, wanted: sharedBy('option', valueIn(g)) });
  shared.push({ level: 'color', group_id: null, product: typeProfit, wanted: sharedBy('color', (s) => s.color_id) });
  let best: { c: Candidate; merged: NonNullable<ReturnType<typeof merge>>; over: bigint; under: number } | null = null;
  for (const c of shared) {
    const merged = merge(c, within);
    if (!merged) continue;
    // The profit added above the SKUs' own (USD millionths), then the dinars taken under their own prices (under $5).
    let over = 0n;
    let under = 0;
    for (const s of free) {
      const a = micro(merged.amounts.get(s.combo_key)!);
      if (a > own(s)) over += a - own(s);
      else if (a < own(s)) under += plainPrice.get(s.combo_key)! - at(s, a)!.price_iqd;
    }
    const better = !best || over < best.over || (over === best.over && (under < best.under || (under === best.under && merged.rows.length < best.merged.rows.length)));
    if (better) best = { c, merged, over, under };
  }
  if (best) {
    const { amounts: resolved } = best.merged;
    const above = free.filter((s) => micro(resolved.get(s.combo_key)!) > own(s)).map((s) => s.combo_key);
    return {
      ...planned(best.c, best.merged),
      targets: free.map((s) => ({ combo_key: s.combo_key, amount_usd: resolved.get(s.combo_key)!, capped: resolved.get(s.combo_key) !== typeProfit })),
      flags: above.length ? [...out.flags, { code: CEILING_SHARED_FLAG, combo_keys: uniqueSorted(above) }] : out.flags,
    };
  }

  // 7. Not even that fits: the product as it sells with no ceiling — today's rule at today's U, the very plan compute's
  //    first evaluation priced — flagged the same, never blocked. Only when even that cannot be written: blocked.
  const uncapped = planEstimateProfitsBefore({ ...input, profit_cap_pct: null });
  if (uncapped.kind === 'planned' || uncapped.kind === 'none') {
    return {
      ...out,
      kind: 'uncapped',
      targets: free.map((s) => ({ combo_key: s.combo_key, amount_usd: typeProfit, capped: false })),
      flags: [...out.flags, { code: CEILING_SHARED_FLAG, combo_keys: uniqueSorted(free.filter((s) => targets.get(s.combo_key) !== typeProfit).map((s) => s.combo_key)) }],
      ...(uncapped.kind === 'planned' ? { rows: uncapped.rows, minimum_profit: uncapped.minimum_profit, scopes: uncapped.scopes } : {}),
    };
  }
  return unplanned('too_many', [...out.flags, tooMany]);
}
