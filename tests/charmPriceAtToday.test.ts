/**
 * TODAY'S DINAR PRICE SHOWS c — THE RULING AGAINST THE RULE IT REPLACED (the lead's ruling for the owner, 2026-11-05,
 * on his «make the price for product be like that 9.99$ , 19.99$ 24.99$»; DECISIONS row 291 (ب); docs/SMART_PRICING.md
 * §4.11; packages/pricing/src/charmPrice.ts).
 *
 * Until this ruling a charm price whose dinar price IS today's kept the type's T («no new rule for no change»), so the
 * storefront showed today's own dollar figure, R ÷ U + T, within one rounding step's worth of c on either side at the
 * very same dinar price: 14 of the 785 estimated cards at 9,000 IQD or more were off the grid that way on the day of
 * the live re-pricing — the hardened-steel combo at $69.04 for 110,500, where $68.99 sells at the same 110,500. Now such
 * a SKU sells there at c's own profit and shows c; T stays only where today's own figure already is c, or for a house
 * price.
 *
 * `charmTargetBefore` (tests/fixtures/charmBeforeRuling.ts) is the pre-change `charmTarget`, copied verbatim as the oracle
 * (its name alone differs; the grid, the margin and the rounding it calls are the live ones, which the ruling does not
 * touch). One SKU at the R and U of the compute — the planner's own limit, and FX-5 between applies, are proven in
 * tests/estimateProfitCap.test.ts (g) and tests/priceEstimateProfitCap.test.ts. Proves, over 300,000
 * seeded random figures — R to 4,000,000 IQD with fractions, the thirteen types' T and two under one rounding step, P
 * with decimals, U in {1,600, 1,690, 1,650, 1,525.5}, the owner's differences on a tenth of the cases:
 *   - both read the same figures (null alike);
 *   - not one dinar moves: price_iqd, today_iqd and floor_iqd identical, always;
 *   - where the two differ it is exactly the ruling: the old one kept T, the new one is `charm` at today's very dinar
 *     price, its dollar figure — ceil6((R + (T_sku + Δ⁺) × U) ÷ U), up to the cent, as the storefront shows it —
 *     exactly c (on the grid, $5.49 or more; usd_ceil6 c itself), today's own figure not c, its margin one rounding
 *     step, T_sku a storable rule within one rounding step's worth of T, above it as well as below (both reached);
 *   - everywhere else the two are equal, field for field — rule (a) «nothing goes up», every house price, every charm
 *     price under today's, and today's own figure already c (reached);
 *   - PAST THE R AND U OF THE COMPUTE the two part, by (T_sku − T) × U: at a later rate each SKU moved sells where FX-5
 *     prices it, at most one rounding step from T's own price, above it and under it (both reached), two only after a
 *     rise of U with T_sku almost a full step from T;
 * and pins the live cards' shapes: the hardened-steel combo, a mainboard (T_sku above T), the 12 V adapter and the tea
 * lights now on the grid; the soccerbot (rule (a)), a figure already $19.99 and the $100,000 bound as before.
 *
 * Run: node --import tsx --test tests/charmPriceAtToday.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charmTargetBefore } from './fixtures/charmBeforeRuling';
import { LOWEST_USED_CHARM_CENTS, charmTarget, isCharmCents, marginNeededIqd, type CharmTarget, type CharmTargetInput } from '../packages/pricing/src/charmPrice';
import { PRICE_ROUNDING_STEP_IQD, roundPriceIqd } from '../packages/pricing/src/priceRounding';
import { canonicalUsdRuleAmount } from '../packages/pricing/src/ruleResolution';
import { usdCeilCentsOf } from '../packages/pricing/src/usdCents';
import {
  addProcurementExact,
  ceilToPlaces,
  compareProcurementExact,
  mulProcurementExact,
  procurementExact,
  procurementExactText,
  quotientProcurementExact,
  type ProcurementExact,
} from '../packages/contracts/src/procurementCost';

/* -------------------------------------------------------------- arithmetic -- */

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

const ZERO: ProcurementExact = { num: 0n, den: 1n };
/** B = R + Δ⁺ × U: what the engine adds the profit to (a negative sum moves nothing, C-9). */
const baseOf = (x: CharmTargetInput): ProcurementExact => {
  const d = x.difference_usd && !x.difference_usd.startsWith('-') ? procurementExact(x.difference_usd) : ZERO;
  return addProcurementExact(procurementExact(x.cost_iqd), mulProcurementExact(d, procurementExact(x.usd_iqd)));
};
/** The engine's dollar price at a USD profit, usd_ceil6 = ceil6((B + profit × U) ÷ U), exact. */
const usdCeil6 = (x: CharmTargetInput, usd: string): ProcurementExact => {
  const u = procurementExact(x.usd_iqd);
  return ceilToPlaces(quotientProcurementExact(addProcurementExact(baseOf(x), mulProcurementExact(procurementExact(usd), u)), u), 6);
};
/** …in whole cents, as the storefront shows it (`usdCeilCentsOf`): at the type's T itself, today's own figure. */
const shownCents = (x: CharmTargetInput, usd: string): number => usdCeilCentsOf(procurementExactText(usdCeil6(x, usd)))!;
/** The margin a profit keeps over R, (profit + Δ⁺) × U, IQD. */
const marginOf = (x: CharmTargetInput, usd: string): ProcurementExact => {
  const u = procurementExact(x.usd_iqd);
  return addProcurementExact(addProcurementExact(baseOf(x), mulProcurementExact(procurementExact(usd), u)), { num: -procurementExact(x.cost_iqd).num, den: procurementExact(x.cost_iqd).den });
};

const input = (cost: string, t: string, p: string, u = '1600', difference: string | null = null): CharmTargetInput => ({ cost_iqd: cost, usd_iqd: u, min_profit_usd: t, ceiling_pct: p, difference_usd: difference });
const pinned = (x: CharmTarget | null) => x && [x.basis, x.charm_cents, x.amount_usd, x.price_iqd, x.today_iqd, x.floor_iqd];

/* --------------------------------------------------------- the live shapes -- */

test('the live cards: today’s dinar price now shows c — the hardened-steel combo $68.99 at 110,500 (was $69.04), a mainboard $99.99 at 160,000 (was $99.94), the 12 V adapter, the tea lights; the soccerbot, a figure already $19.99 and the $100,000 bound as they were', () => {
  const cases: Array<[string, CharmTargetInput, unknown[], unknown[], number, number]> = [
    // [label, figures, before, now, cents shown before, cents shown now]
    // An accessory at $4.50 and 10%: 57.98 EUR × 1,776 + 70 freight + 220 = 103,262.48; $68.99 = 110,384 → 110,500.
    ['hardened-steel combo', input('103262.48', '4.5', '10'), ['today', null, '4.5', 110_500, 110_500, 103_750], ['charm', 6_899, '4.45095', 110_500, 110_500, 103_750], 6_904, 6_899],
    // An electronics part at $6 and 8%, 82.82 EUR by land: R 150,288.32; T_sku $6.0598 is above T, the dinar price the same.
    ['mainboard', input('150288.32', '6', '8'), ['today', null, '6', 160_000, 160_000, 150_750], ['charm', 9_999, '6.0598', 160_000, 160_000, 150_750], 9_994, 9_999],
    // Makers parts at $1.50 and 10%: the 12 V adapter (130 CNY, R 31,344) and the tea lights (122 CNY, R 29,510.4).
    ['12 V adapter', input('31344', '1.5', '10'), ['today', null, '1.5', 33_750, 33_750, 31_750], ['charm', 2_099, '1.4', 33_750, 33_750, 31_750], 2_109, 2_099],
    ['tea lights', input('29510.4', '1.5', '10'), ['today', null, '1.5', 32_000, 32_000, 30_000], ['charm', 1_999, '1.546', 32_000, 32_000, 30_000], 1_995, 1_999],
    // R 96,137 at $6 and 10% (tests/charmPrice.test.ts): $65.99 at 105,750 — was $66.09.
    ['R 96,137 at $6', input('96137', '6', '10'), ['today', null, '6', 105_750, 105_750, 96_500], ['charm', 6_599, '5.904375', 105_750, 105_750, 96_500], 6_609, 6_599],
    // Rule (a): the soccerbot (662 CNY, R 159,900) — $99.99 = 160,000 keeps 84 IQD over R, $104.99 = 168,000 is dearer
    // than today's 162,500: nothing goes up, its dollar figure $101.44 as before (no charm price has this dinar price).
    ['soccerbot (rule a)', input('159900', '1.5', '10'), ['today', null, '1.5', 162_500, 162_500, 160_250], ['today', null, '1.5', 162_500, 162_500, 160_250], 10_144, 10_144],
    // Today's own figure already c: R 29,570.4 shows $19.9815 → $19.99 at 32,000, $19.99's own dinar price: T stays.
    ['already $19.99', input('29570.4', '1.5', '10'), ['today', null, '1.5', 32_000, 32_000, 30_000], ['today', null, '1.5', 32_000, 32_000, 30_000], 1_999, 1_999],
    // The $100,000 bound: $200,009.99 sells at today's 320,016,000 at $100,000.115, past what a rule may carry: T stays.
    ['the $100,000 bound', input('160015800', '100000', '100'), ['today', null, '100000', 320_016_000, 320_016_000, 160_016_250], ['today', null, '100000', 320_016_000, 320_016_000, 160_016_250], 20_000_988, 20_000_988],
  ];
  for (const [label, x, before, now, centsBefore, centsNow] of cases) {
    const old = charmTargetBefore(x);
    const next = charmTarget(x);
    assert.deepEqual(pinned(old), before, `${label}: the rule it replaced`);
    assert.deepEqual(pinned(next), now, `${label}: the ruling`);
    assert.deepEqual([shownCents(x, old!.amount_usd), shownCents(x, next!.amount_usd)], [centsBefore, centsNow], `${label}: the dollar shown`);
    assert.equal(next!.price_iqd, old!.price_iqd, `${label}: the same dinar price`);
    if (next!.basis === 'charm') assert.equal(procurementExactText(usdCeil6(x, next!.amount_usd)), procurementExactText({ num: BigInt(next!.charm_cents!), den: 100n }), `${label}: usd_ceil6 is c itself`);
  }
});

/* ------------------------------------------------------------- the property -- */

const TYPE_T = ['135', '45', '375', '15', '6', '7.5', '18', '6', '7.5', '6', '4.5', '1.5', '3', '0.05', '0.15'];
const CEILINGS = ['0', '3', '4', '6', '8', '10', '25', '100', '7.25', '12.5'];
const RATES = ['1600', '1690', '1650', '1525.5'];
const DIFFERENCES = ['0.4', '1.3', '-2', '0.000001', '12.5', '-0.5'];
/** The number of random figures the property walks (said in the header, held here). */
const CASES = 300_000;
/** The later rates a SKU moved is priced at, FX-5's own arithmetic: its cost following the dollar, or not. */
const LATER_RATES = [-0.02, -0.005, 0.0025, 0.0075, 0.03];

test('property, 300,000 random figures: not one dinar moves; where the result differs the old rule kept T and the new one sells at today’s very dinar price showing exactly c, with its margin; everything else field for field', () => {
  const rnd = prng(2_911_105);
  const pick = <V>(xs: readonly V[]) => xs[Math.floor(rnd() * xs.length)]!;
  const counted = { cases: 0, unread: 0, same: 0, moved: 0, up: 0, down: 0, alreadyC: 0, charmBelowToday: 0, plain: 0, differences: 0, laterSame: 0, laterAbove: 0, laterUnder: 0, laterTwo: 0 };
  for (let i = 0; i < CASES; i++) {
    const band = rnd();
    const cost = band < 0.3 ? (rnd() * 60_000).toFixed(pick([0, 1, 2])) : band < 0.8 ? (rnd() * 400_000).toFixed(pick([0, 2])) : (rnd() * 4_000_000).toFixed(pick([0, 2]));
    const difference = rnd() < 0.1 ? pick(DIFFERENCES) : null;
    const x = input(cost, pick(TYPE_T), pick(CEILINGS), pick(RATES), difference);
    const at = `R ${x.cost_iqd}, T ${x.min_profit_usd}, P ${x.ceiling_pct}, U ${x.usd_iqd}, Δ ${difference}`;
    counted.cases++;
    const old = charmTargetBefore(x);
    const next = charmTarget(x);
    assert.equal(next === null, old === null, `${at}: both read the same figures`);
    if (!old || !next) {
      counted.unread++;
      continue;
    }
    if (difference) counted.differences++;
    // Not one dinar moves.
    assert.deepEqual([next.price_iqd, next.today_iqd, next.floor_iqd], [old.price_iqd, old.today_iqd, old.floor_iqd], `${at}: the same dinar figures`);
    if (next.basis === old.basis && next.amount_usd === old.amount_usd) {
      // Everywhere else, field for field.
      assert.deepEqual(next, old, `${at}: unchanged`);
      counted.same++;
      if (next.basis === 'plain') counted.plain++;
      if (next.basis === 'charm' && next.price_iqd < next.today_iqd) counted.charmBelowToday++;
      // Today's own figure already c — a charm price of at least $5.49 whose dinar price is today's: T stays.
      if (next.basis === 'today') {
        const cents = shownCents(x, x.min_profit_usd);
        if (cents >= LOWEST_USED_CHARM_CENTS && isCharmCents(cents) && roundPriceIqd(mulProcurementExact({ num: BigInt(cents), den: 100n }, procurementExact(x.usd_iqd))) === next.today_iqd) counted.alreadyC++;
      }
      continue;
    }
    // Exactly the ruling: T kept before; now c's own profit at today's very dinar price.
    counted.moved++;
    assert.deepEqual([old.basis, old.amount_usd, next.basis], ['today', canonicalUsdRuleAmount(x.min_profit_usd), 'charm'], `${at}: only a T kept at today's price moves`);
    assert.equal(next.price_iqd, next.today_iqd, `${at}: at today's very dinar price`);
    const c = next.charm_cents!;
    assert.ok(isCharmCents(c) && c >= LOWEST_USED_CHARM_CENTS, `${at}: $${c / 100} on the grid, from $5.49`);
    // Its dollar figure is c, exactly; today's own was not.
    assert.equal(procurementExactText(usdCeil6(x, next.amount_usd)), procurementExactText({ num: BigInt(c), den: 100n }), `${at}: usd_ceil6 is c`);
    assert.equal(shownCents(x, next.amount_usd), c, `${at}: the dollar shown is c`);
    assert.notEqual(shownCents(x, x.min_profit_usd), c, `${at}: today's own figure was not c already`);
    // A storable rule, its margin one rounding step, within one rounding step's worth of T.
    assert.equal(canonicalUsdRuleAmount(next.amount_usd), next.amount_usd, `${at}: a canonical, storable profit`);
    assert.ok(compareProcurementExact(marginOf(x, next.amount_usd), procurementExact(marginNeededIqd(next.price_iqd))) >= 0, `${at}: its margin`);
    const apart = mulProcurementExact(addProcurementExact(procurementExact(next.amount_usd), { num: -procurementExact(x.min_profit_usd).num, den: procurementExact(x.min_profit_usd).den }), procurementExact(x.usd_iqd));
    const gap = apart.num < 0n ? { num: -apart.num, den: apart.den } : apart;
    assert.ok(compareProcurementExact(gap, procurementExact(PRICE_ROUNDING_STEP_IQD)) < 0, `${at}: T_sku within one rounding step's worth of T`);
    if (apart.num > 0n) counted.up++;
    else counted.down++;
    // At a later rate, FX-5's arithmetic: R' + (T_sku + Δ⁺) × U' against what T would sell it at, R' + (T + Δ⁺) × U'.
    const r = procurementExact(x.cost_iqd);
    const u = procurementExact(x.usd_iqd);
    const plus = difference && !difference.startsWith('-') ? procurementExact(difference) : ZERO;
    for (const move of LATER_RATES) {
      const later = procurementExact((Number(x.usd_iqd) * (1 + move)).toFixed(2));
      for (const cost of [r, quotientProcurementExact(mulProcurementExact(r, later), u)]) {
        const priceAt = (profit: string) => roundPriceIqd(addProcurementExact(cost, mulProcurementExact(addProcurementExact(procurementExact(profit), plus), later)));
        const steps = (priceAt(next.amount_usd) - priceAt(x.min_profit_usd)) / PRICE_ROUNDING_STEP_IQD;
        // Never further apart than their gap, (T_sku − T) × U', rounded up to whole steps: one step, unless that gap is
        // past one — only after a rise of U, the gap being under one step at the apply's rate.
        const pastOneStep = compareProcurementExact(quotientProcurementExact(mulProcurementExact(gap, later), u), procurementExact(PRICE_ROUNDING_STEP_IQD)) > 0;
        assert.ok(Math.abs(steps) <= (pastOneStep ? 2 : 1), `${at}: at U ${procurementExactText(later)}, ${steps} steps from T's price`);
        if (pastOneStep) assert.ok(move > 0, `${at}: past one step only after a rise of U`);
        if (steps === 0) counted.laterSame++;
        else if (Math.abs(steps) > 1) counted.laterTwo++;
        else if (steps > 0) counted.laterAbove++;
        else counted.laterUnder++;
      }
    }
  }
  assert.equal(counted.cases, CASES);
  // Not vacuous: thousands moved, both ways; the ones that stay — today's own figure already c, house prices, charm
  // prices under today's — all reached.
  assert.ok(
    counted.moved > 3_000 && counted.up > 1_000 && counted.down > 1_000 && counted.alreadyC > 200 && counted.charmBelowToday > 50_000 && counted.plain > 5_000 && counted.differences > 20_000 && counted.unread === 0 && counted.laterSame > 10_000 && counted.laterAbove > 2_000 && counted.laterUnder > 2_000,
    JSON.stringify(counted)
  );
});
