/**
 * THE DOLLAR CHARM PRICE OF AN ESTIMATED SKU, PURE (owner decisions 2026-11-05, DECISIONS row 291;
 * docs/SMART_PRICING.md §4.11; packages/pricing/src/charmPrice.ts).
 *
 * Proves, with no database:
 *   (a) THE GRID: below $10 every $0.50 ending .49 / .99; $10–$100 every $1 ending .99; $100–$1,000 every $5 ending
 *       4.99 / 9.99; from $1,000 every $10 ending 9.99 — the owner's own prices of 2026-11-05 are on it, and the
 *       grid's walk (at most / at least / next / previous) agrees with its definition cent by cent up to $3,000;
 *   (b) THE CHOICE, pinned by hand at U = 1,600: charm prices from $5 up (`CHARM_MIN_USD`; $5.49 the lowest used) —
 *       the Flush Cutter shape (an accessory at $4.50, R 18,431.2) 25,750 → $11.99, 19,250; an AMS shape ($45 at 4%, R
 *       458,224) 530,250 → $294.99, 472,000; a printer ($135 at 3%, R 2,928,824) 3,145,000 → $1,879.99, 3,008,000 —
 *       and under that the plain house price: the Nozzle Wiping Plate shape (a spare part at $6, R 3,659.5) 13,500 →
 *       4,000 at a 10% ceiling and at 0%; THE THRESHOLD — a ceiling of exactly $5 × U and one just under it price
 *       plainly (8,000 at $5.00, not $4.99; 7,750), so does every ceiling under the dinar price of $5.49, which itself
 *       prices on the grid (9,000; 8,999 → 8,750), at 1,600 and at 1,690 — where no house price under such a ceiling
 *       keeps the margin, the lowest that does, off the grid (R 8,600 at 0%: 9,000 at $5.63; R 8,999: 9,250 at $5.79;
 *       at 1,690 R 9,400: 9,750 at $5.77), never the grid's $5.99; THE MARGIN — a price keeps one rounding step
 *       over its cost (one dinar at or under 1,000 IQD), so the next rate tick cannot close its route under FX-5 (R
 *       4,760: 5,250, never 5,000's 240 IQD); the old band edges 784 / 1,334 / 1,335 / 2,134, now at 862 / 1,750 /
 *       1,750 / 2,500; TODAY'S DINAR PRICE SHOWS c (the lead's ruling for the owner, 2026-11-05): a charm price whose
 *       dinar price is today's sells there at c's own profit, its dollar figure c (R 96,137: $65.99 at 105,750, not
 *       $66.09; the hardened-steel combo $68.99 at 110,500, not $69.04; a mainboard $99.99 at 160,000, T_sku above T),
 *       while T stays where today's own dollar figure already is c (R 97,580: $66.99), for a house price, and at the
 *       $100,000 bound; nothing goes up while today's price clears the route floor;
 *       the floor forces a price above today's only when today's own would not clear it; the owner's positive option
 *       and colour differences stay on top (gold +$1.30: 6,000 under $5, $5.49 at 100%), a negative sum moves nothing;
 *       nothing guessed;
 *   (c) THE PROPERTY, for R from 1 to 3,000,000 IQD (every dinar to 17,000 — the whole band under $10 at both rates
 *       —, a stride to 60,000, every 997th dinar from 60,000 to 3,000,000, the band edges, the $5 edges, random costs
 *       and fractions), P in {0, 3, 4, 6, 8, 10, 25, 100}, U in {1,600, 1,690}, the thirteen types' T and two under one
 *       rounding step, and differences on a share of the cases (`CASES` below, asserted): a ceiling under $5 × U, or
 *       under the dinar price of $5.49, never prices on the grid, one at or above it never plainly (both boundaries
 *       reached); on the grid, c is at least $5, rp(R + (T_sku + Δ⁺) × U) = rp(c × U) and the engine's dollar price
 *       is c; plainly, the price D is a house price, T_sku = floor6((D − B) ÷ U) and the dollar price is D's own; the
 *       price is above rp(R) and its margin covers one rounding step, so after any rise of R or U it still clears rp(R)
 *       (sampled); it is never above today's unless today's own would not clear the floor (reached); the price is the
 *       highest within the ceiling that keeps the margin, else the lowest that keeps it; T stays only for today's
 *       price, and at a charm price only where today's own dollar figure already is c — a charm price at today's
 *       dinar price otherwise shows c (both reached) — every figure re-derived with the engine's own `roundPriceIqd`
 *       and independent exact arithmetic.
 *
 * The ruling against the rule it replaced, case by case over 300,000 random figures: tests/charmPriceAtToday.test.ts.
 *
 * Run: node --import tsx --test tests/charmPrice.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARM_BANDS,
  CHARM_MIN_USD,
  LOWEST_CHARM_CENTS,
  LOWEST_USED_CHARM_CENTS,
  centsText,
  charmAtLeastCents,
  charmAtMostCents,
  charmTarget,
  isCharmCents,
  marginNeededIqd,
  type CharmTarget,
} from '../packages/pricing/src/charmPrice';
import { isOnPriceRule, roundPriceIqd } from '../packages/pricing/src/priceRounding';
import { usdCeilCentsOf } from '../packages/pricing/src/usdCents';
import {
  addProcurementExact,
  ceilToPlaces,
  compareProcurementExact,
  floorToPlaces,
  mulProcurementExact,
  procurementExact,
  procurementExactText,
  quotientProcurementExact,
  type ProcurementExact,
} from '../packages/contracts/src/procurementCost';

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

const target = (cost: string, t: string, p: string, u = '1600', difference: string | null = null): CharmTarget => {
  const x = charmTarget({ cost_iqd: cost, usd_iqd: u, min_profit_usd: t, ceiling_pct: p, difference_usd: difference });
  assert.ok(x, `R ${cost}, T ${t}, P ${p}, U ${u}, Δ ${difference}: a target`);
  return x;
};
const pinned = (x: CharmTarget) => [x.basis, x.charm_cents === null ? null : centsText(x.charm_cents), x.amount_usd, x.price_iqd, x.today_iqd, x.floor_iqd];
/** The engine's dollar price at a USD profit, ceil6((R + (profit + Δ⁺) × U) ÷ U), in whole cents as the storefront shows it. */
const centsAtProfit = (cost: string, usd: string, u = '1600', difference = '0'): number =>
  usdCeilCentsOf(procurementExactText(ceilToPlaces(quotientProcurementExact(addProcurementExact(procurementExact(cost), mulProcurementExact(addProcurementExact(procurementExact(usd), procurementExact(difference)), procurementExact(u))), procurementExact(u)), 6)))!;
/** The same at the SKU's chosen profit (`centsAtProfit` at the type's T itself is today's own dollar figure). */
const shownCents = (cost: string, x: CharmTarget, u = '1600', difference = '0'): number => centsAtProfit(cost, x.amount_usd, u, difference);

/* ------------------------------------------------------------- (a) the grid -- */

test('(a) the grid: .49/.99 under $10, .99 to $100, 4.99/9.99 to $1,000, then 9.99 — the owner’s own prices are on it', () => {
  assert.deepEqual(
    CHARM_BANDS.map((b) => [b.below_cents, b.step_cents]),
    [
      [1_000, 50],
      [10_000, 100],
      [100_000, 500],
      [null, 1_000],
    ]
  );
  assert.equal(LOWEST_CHARM_CENTS, 49);
  // The owner's own products, set by hand on 2026-11-05, and his examples «9.99$ , 19.99$ 24.99$».
  for (const usd of ['0.49', '0.99', '4.49', '9.99', '10.99', '11.99', '12.99', '16.99', '18.99', '19.99', '24.99', '99.99', '104.99', '329.99', '524.99', '539.99', '684.99', '749.99', '999.99', '1009.99', '1049.99', '1209.99', '1249.99', '2049.99', '4429.99', '5069.99']) {
    assert.equal(isCharmCents(Math.round(Number(usd) * 100)), true, usd);
  }
  for (const usd of ['0.48', '0.50', '9.49x', '10.49', '10.5', '15', '99.49', '100.99', '102.99', '104.49', '1004.99', '1000', '1014.99', '429.98']) {
    assert.equal(isCharmCents(Math.round(Number(usd) * 100)), false, usd);
  }
  // Each band's last price is the one just below the next band's first.
  assert.deepEqual([charmAtLeastCents(1_000), charmAtMostCents(1_098), charmAtLeastCents(10_000), charmAtMostCents(10_498), charmAtLeastCents(100_000), charmAtMostCents(100_998)], [1_099, 999, 10_499, 9_999, 100_999, 99_999]);
  assert.equal(charmAtMostCents(48), null, 'nothing under $0.49');
  assert.deepEqual([charmAtLeastCents(0), charmAtLeastCents(49), charmAtLeastCents(50)], [49, 49, 99]);
  assert.deepEqual([centsText(249), centsText(124_999), centsText(49), centsText(0)], ['2.49', '1249.99', '0.49', '0.00']);
});

test('(a) the grid’s walk agrees with its definition, cent by cent, up to $3,000', () => {
  const definition = (cents: number): boolean => {
    if (cents < 49) return false;
    if (cents < 1_000) return (cents + 1) % 50 === 0;
    if (cents < 10_000) return (cents + 1) % 100 === 0 && cents >= 1_099;
    if (cents < 100_000) return (cents + 1) % 500 === 0 && cents >= 10_499;
    return (cents + 1) % 1_000 === 0 && cents >= 100_999;
  };
  let below: number | null = null;
  const grid: number[] = [];
  for (let cents = 0; cents <= 300_000; cents++) {
    assert.equal(isCharmCents(cents), definition(cents), `${cents}`);
    if (definition(cents)) {
      below = cents;
      grid.push(cents);
    }
    assert.equal(charmAtMostCents(cents), below, `at most ${cents}`);
  }
  let at = 0;
  for (let cents = 0; cents <= 299_000; cents++) {
    while (grid[at]! < cents) at++;
    assert.equal(charmAtLeastCents(cents), grid[at], `at least ${cents}`);
  }
  // Steps: 20 prices under $10, 90 to $100, 180 to $1,000, then one per $10.
  assert.deepEqual([grid.filter((c) => c < 1_000).length, grid.filter((c) => c >= 1_000 && c < 10_000).length, grid.filter((c) => c >= 10_000 && c < 100_000).length], [20, 90, 180]);
});

/* ------------------------------------------------------------ (b) the choice -- */

test('(b) pinned at U = 1,600: from $5 up the highest charm price under the ceiling (the Flush Cutter, an AMS, a printer); under it the plain house price (the Nozzle)', () => {
  // The Flush Cutter shape: an accessory at $4.50, 75 CNY × 240 + 211.2 + 220 = 18,431.2. Today 25,750; at 10%
  // the ceiling is 20,274.32: $11.99 (19,184 → 19,250); $12.99 → 21,000 is over it. At 0% the lowest that keeps the
  // margin is $11.99 too (752.8 over R).
  assert.deepEqual(pinned(target('18431.2', '4.5', '10')), ['charm', '11.99', '0.4705', 19_250, 25_750, 18_750]);
  assert.deepEqual(pinned(target('18431.2', '4.5', '0')), ['charm', '11.99', '0.4705', 19_250, 25_750, 18_750]);
  // An AMS shape: $45 at 4%, R = 249 EUR × 1,776 + 5 kg × 3,200 = 458,224. Today 530,250; ceiling 476,552.96:
  // $294.99 (471,984 → 472,000); $299.99 → 480,000 is over it.
  assert.deepEqual(pinned(target('458224', '45', '4')), ['charm', '294.99', '8.6', 472_000, 530_250, 458_500]);
  // A printer: $135 at 3%, R = 1,599 EUR × 1,776 + 20 kg × 3,200 + 25,000 = 2,928,824. Today 3,145,000; ceiling
  // 3,016,688.72: $1,879.99 (3,007,984 → 3,008,000); $1,889.99 → 3,024,000 is over it.
  assert.deepEqual(pinned(target('2928824', '135', '3')), ['charm', '1879.99', '49.475', 3_008_000, 3_145_000, 2_929_250]);
  // The same printer at $50: today's price (3,009,000) is the ceiling now — the charm price under it.
  assert.deepEqual(pinned(target('2928824', '50', '3')), ['charm', '1879.99', '49.475', 3_008_000, 3_009_000, 2_929_250]);

  // The Nozzle Wiping Plate shape: a spare part at $6, 15 CNY × 240 + 59.5 freight = 3,659.5 IQD. Today 13,500. At
  // 10% the ceiling, R × 1.1 = 4,025.45, is under $5 × 1,600: no charm price — the highest house price within it,
  // 4,000, keeps 340.5 over R. T_sku = floor6((4,000 − 3,659.5) ÷ 1,600) = 0.212812 (3,999.9992 → 4,000), its dollar
  // price $2.50. The route floor: rp(3,659.5) = 3,750, so 4,000.
  const nozzle = target('3659.5', '6', '10');
  assert.deepEqual(pinned(nozzle), ['plain', null, '0.212812', 4_000, 13_500, 4_000]);
  assert.equal(shownCents('3659.5', nozzle), 250, 'the house price’s own dollar figure, not a charm price');
  // 0%: R itself is the ceiling — 3,500 is under it; the lowest house price that keeps the margin: 3,750 keeps 90.5,
  // 4,000 keeps 340.5.
  assert.deepEqual(pinned(target('3659.5', '6', '0')), ['plain', null, '0.212812', 4_000, 13_500, 4_000]);
  // 100%: R × 2 = 7,319, still under $5 × 1,600 — 7,250.
  assert.deepEqual(pinned(target('3659.5', '6', '100')), ['plain', null, '2.244062', 7_250, 13_500, 4_000]);
});

test('(b) the $5 threshold: a ceiling at $5 × U or just under prices plainly, as does every one under the dinar price of $5.49; that price itself is on the grid — at 1,600 and 1,690', () => {
  assert.equal(CHARM_MIN_USD, 5);
  assert.equal(LOWEST_USED_CHARM_CENTS, 549, 'the lowest charm price used: the first on the grid at or above $5');
  assert.deepEqual([roundPriceIqd('7984'), roundPriceIqd('8784'), roundPriceIqd('9278.1')], [8_000, 9_000, 9_500], '$4.99 and $5.49 at 1,600, $5.49 at 1,690');
  // At 1,600 ($5 × U = 8,000; $5.49 → 9,000), a spare part at $6 under a 100% ceiling: R × 2 is the ceiling.
  // Exactly $5 × U: R 4,000 → 8,000. Its only charm price under the ceiling is $4.99, under $5: the plain 8,000, at
  // $5.00 (T_sku 2.5), where the grid's $4.99 sold it at the same dinar price.
  const five = target('4000', '6', '100');
  assert.deepEqual(pinned(five), ['plain', null, '2.5', 8_000, 13_750, 4_250]);
  assert.equal(shownCents('4000', five), 500);
  // Just under: R 3,999.5 → 7,999: the house price 7,750 (the grid's $4.49 sold it at 7,250).
  assert.deepEqual(pinned(target('3999.5', '6', '100')), ['plain', null, '2.344062', 7_750, 13_750, 4_250]);
  // The dinar price of $5.49: R 4,500 → 9,000 — on the grid, $5.49.
  const charm = target('4500', '6', '100');
  assert.deepEqual(pinned(charm), ['charm', '5.49', '2.6775', 9_000, 14_250, 4_750]);
  assert.equal(shownCents('4500', charm), 549);
  // Just under it: R 4,499.5 → 8,999 — the house price 8,750 (the grid's $4.99 sold it at 8,000).
  assert.deepEqual(pinned(target('4499.5', '6', '100')), ['plain', null, '2.656562', 8_750, 14_250, 4_750]);
  // Between the two at 25%: R 7,000 → 8,750 itself.
  assert.deepEqual(pinned(target('7000', '6', '25')), ['plain', null, '1.09375', 8_750, 16_750, 7_250]);
  // Between the two, the margin lifting it: R 7,900 at 3% (8,137): 8,000 keeps 100 — the lowest house price that
  // keeps the margin, 8,250, never the grid's $5.49 = 9,000. R 8,500 at 0%: 8,750, not $5.49 either.
  assert.deepEqual(pinned(target('7900', '6', '3')), ['plain', null, '0.21875', 8_250, 17_500, 8_250]);
  assert.deepEqual(pinned(target('8500', '6', '0')), ['plain', null, '0.15625', 8_750, 18_250, 8_750]);
  // Where no house price under such a ceiling keeps the margin, the lowest that does can reach $5.49's own dinar price
  // or one step over it — its dollar figure off the grid, never a charm price, and cheaper than the grid's lowest that
  // keeps the margin ($5.99 = 9,750): R 8,600 at 0%, 9,000 at $5.63; R 8,999, 9,250 at $5.79 — the dearest the
  // plain rule reaches at 1,600; at 1,690, R 9,400, 9,750 at $5.77.
  const nine = target('8600', '6', '0');
  assert.deepEqual(pinned(nine), ['plain', null, '0.25', 9_000, 18_250, 9_000]);
  assert.equal(shownCents('8600', nine), 563);
  const dearest = target('8999', '6', '0');
  assert.deepEqual(pinned(dearest), ['plain', null, '0.156875', 9_250, 18_750, 9_250]);
  assert.equal(shownCents('8999', dearest), 579);
  const dearest1690 = target('9400', '6', '0', '1690');
  assert.deepEqual(pinned(dearest1690), ['plain', null, '0.2071', 9_750, 19_750, 9_750]);
  assert.equal(shownCents('9400', dearest1690, '1690'), 577);
  // From $5.49 up the charm rule is as it was: R 9,000 at 0% — $5.49 (9,000) keeps nothing; the lowest charm price
  // that keeps the margin is $5.99, 9,750.
  assert.deepEqual(pinned(target('9000', '6', '0')), ['charm', '5.99', '0.365', 9_750, 18_750, 9_250]);

  // At 1,690 ($5 × U = 8,450; $5.49 → 9,500): exactly $5 × U and just under — the house price 8,250 (the grid's $4.49
  // sold them at 7,750); $5.49's dinar price — on the grid; just under it — 9,250.
  assert.deepEqual(pinned(target('4225', '6', '100', '1690')), ['plain', null, '2.381656', 8_250, 14_500, 4_500]);
  assert.deepEqual(pinned(target('4224.5', '6', '100', '1690')), ['plain', null, '2.381952', 8_250, 14_500, 4_500]);
  assert.deepEqual(pinned(target('4750', '6', '100', '1690')), ['charm', '5.49', '2.679349', 9_500, 15_000, 5_000]);
  assert.deepEqual(pinned(target('4749.5', '6', '100', '1690')), ['plain', null, '2.663017', 9_250, 15_000, 5_000]);
});

test('(b) the margin: a price keeps one rounding step over its cost (a dinar at or under 1,000 IQD), so FX-5 can follow any later rise', () => {
  assert.deepEqual([marginNeededIqd(784), marginNeededIqd(1_000), marginNeededIqd(1_001), marginNeededIqd(3_008_000)], [1, 1, 250, 250]);
  // A makers part at $1.50 costing 4,760 (10%: ceiling 5,236): 5,000 is within it with 240 IQD over its cost — a rise
  // of the cost to 5,005 rounds it up to 5,250, the very price 5,245 rounds to: FX-5 would hold the product and keep
  // selling it at 5,000. The lowest house price that keeps 250: 5,250, 490 over R.
  assert.deepEqual(pinned(target('4760', '1.5', '10')), ['plain', null, '0.30625', 5_250, 7_250, 5_250]);
  const after = (cost: number, usd: string) => roundPriceIqd(addProcurementExact(procurementExact(cost), mulProcurementExact(procurementExact(usd), procurementExact(1_600))));
  assert.deepEqual([after(5_005, '0.15'), after(5_005, '0.30625'), roundPriceIqd(5_005)], [5_250, 5_500, 5_250], '240 IQD of profit closes the route at R 5,005; 490 does not');
  // Exactly one step is enough: 4,750 at 10% sells at 5,000, 250 over it ($0.15625 × 1,600). At 1,690 the same 5,000
  // keeps floor6(250 ÷ 1,690) × 1,690 = 249.998 — under the step: 5,250. The margin is the stored dollar profit's.
  assert.deepEqual(pinned(target('4750', '1.5', '10')), ['plain', null, '0.15625', 5_000, 7_250, 5_000]);
  assert.deepEqual(pinned(target('4750', '1.5', '10', '1690')), ['plain', null, '0.295857', 5_250, 7_500, 5_000]);
  // A spare part at 5.94 CNY (R 1,485.1): 1,500 keeps 14.9 — 1,750 keeps 264.9 (the grid sold it at $1.49 = 2,500).
  assert.deepEqual(pinned(target('1485.1', '6', '10')), ['plain', null, '0.165562', 1_750, 11_250, 1_750]);
  // The grid's old edges at 10% — 784 to 1,334 IQD at $0.99 = 1,750 (+31% to +123%), 1,335 to 2,134 at $1.49 = 2,500:
  // now 784 sells at its ceiling, 862 (+10%); 1,334 and 1,335 at 1,750, the lowest house price 250 over them; 2,134 at
  // 2,500. The margin, not the grid, rules from 1,000 IQD to 2,500 at 10%.
  assert.deepEqual(pinned(target('784', '4.5', '10')), ['plain', null, '0.04875', 862, 8_000, 785]);
  assert.deepEqual(pinned(target('1334', '4.5', '10')), ['plain', null, '0.26', 1_750, 8_750, 1_750]);
  assert.deepEqual(pinned(target('1335', '4.5', '10')), ['plain', null, '0.259375', 1_750, 8_750, 1_750]);
  assert.deepEqual(pinned(target('2134', '4.5', '10')), ['plain', null, '0.22875', 2_500, 9_500, 2_500]);
  // At or under 1,000 IQD the rounding is to the dinar: one dinar of margin is the step. R 909: 999 (+9.9%); R 999:
  // 1,000, a dinar over it; R 1,000: 1,000 keeps nothing — 1,250; R 1,001: 1,250 keeps 249 — 1,500.
  assert.deepEqual(pinned(target('909', '4.5', '10')), ['plain', null, '0.05625', 999, 8_250, 910]);
  assert.deepEqual(pinned(target('999', '4.5', '10')), ['plain', null, '0.000625', 1_000, 8_250, 1_000]);
  assert.deepEqual(pinned(target('1000', '4.5', '10')), ['plain', null, '0.15625', 1_250, 8_250, 1_250]);
  assert.deepEqual(pinned(target('1001', '4.5', '10')), ['plain', null, '0.311875', 1_500, 8_250, 1_500]);
});

test('(b) today’s dinar price shows c: a charm price there sells at c’s own profit — T stays where today’s own dollar figure already is c, for a house price, and where none lies between the margin and today’s (nothing goes up); the floor forces a rise only when today’s own price would not clear it', () => {
  // R 96,137 at $6 and 10%: today 105,750 (105,737) is itself the dinar price of $65.99 (105,584 → 105,750), while
  // today's own dollar figure is 96,137 ÷ 1,600 + 6 = $66.085625 → $66.09. The same 105,750 at $65.99's own profit,
  // floor6(65.99 − 60.085625) = $5.904375: the dollar shown is $65.99 (the lead's ruling for the owner, 2026-11-05).
  const sixtyFive = target('96137', '6', '10');
  assert.deepEqual(pinned(sixtyFive), ['charm', '65.99', '5.904375', 105_750, 105_750, 96_500]);
  assert.deepEqual([shownCents('96137', sixtyFive), centsAtProfit('96137', '6')], [6_599, 6_609]);
  // The hardened-steel upgrade combo as it sold on 2026-11-05: an accessory at $4.50 and 10%, R 103,262.48 (57.98 EUR
  // × 1,776 + 70 freight + 220). Today 110,500 at $69.04; $68.99 sells at the very same 110,500 (110,384): now $68.99,
  // at $4.45095 — 78.48 IQD of profit under T.
  const steel = target('103262.48', '4.5', '10');
  assert.deepEqual(pinned(steel), ['charm', '68.99', '4.45095', 110_500, 110_500, 103_750]);
  assert.deepEqual([shownCents('103262.48', steel), centsAtProfit('103262.48', '4.5')], [6_899, 6_904]);
  // A mainboard at $6 and 8% (R 150,288.32): today 160,000 at $99.94; $99.99 = 159,984 → 160,000. T_sku, $6.0598, is
  // above T and the dinar price the same: the dollar shown rises to $99.99 (orders are charged in dinars).
  const board = target('150288.32', '6', '8');
  assert.deepEqual(pinned(board), ['charm', '99.99', '6.0598', 160_000, 160_000, 150_750]);
  assert.deepEqual([shownCents('150288.32', board), centsAtProfit('150288.32', '6')], [9_999, 9_994]);
  // Today's own dollar figure already c: R 97,580 at $6 sells at 107,250 and shows 97,580 ÷ 1,600 + 6 = $66.9875 →
  // $66.99, the charm price whose dinar price it is (107,184 → 107,250). Nothing a customer sees would change: T stays.
  assert.deepEqual(pinned(target('97580', '6', '10')), ['today', null, '6', 107_250, 107_250, 98_000]);
  assert.equal(centsAtProfit('97580', '6'), 6_699);
  // …as the storefront rounds it, up to the cent: R 29,570.4 at $1.50 — 32,000 at $19.9815, shown $19.99, $19.99's
  // own dinar price (31,984 → 32,000). T stays.
  assert.deepEqual(pinned(target('29570.4', '1.5', '10')), ['today', null, '1.5', 32_000, 32_000, 30_000]);
  assert.equal(centsAtProfit('29570.4', '1.5'), 1_999);
  // An accessory at $4.50 costing 160,000 (just over $100): today 167,250; the charm prices around it are 160,000
  // ($99.99, no margin over R) and 168,000 ($104.99, over today's). Nothing goes up: T stays, and so does today's
  // dollar figure, $104.50 — no charm price has this dinar price.
  assert.deepEqual(pinned(target('160000', '4.5', '10')), ['today', null, '4.5', 167_250, 167_250, 160_250]);
  // Under $5: a makers part at $1.50 costing 3,000 under a 100% ceiling — today's 5,500 is the ceiling and itself the
  // house price: no new rule (a house price shows its own dollar figure either way).
  assert.deepEqual(pinned(target('3000', '1.5', '100')), ['today', null, '1.5', 5_500, 5_500, 3_250]);
  // At the $100,000 bound: R 160,015,800 at $100,000 and 100% — $200,009.99 sells at today's 320,016,000 at a profit of
  // $100,000.115, past what a rule may carry: T stays, as before.
  assert.deepEqual(pinned(target('160015800', '100000', '100')), ['today', null, '100000', 320_016_000, 320_016_000, 160_016_250]);
  // A minimum profit under one rounding step ($0.05 × 1,600 = 80): today's 5,250 is the cost rounded up — a closed
  // route. The floor forces the price: the lowest house price that keeps the margin, 5,500.
  assert.deepEqual(pinned(target('5001', '0.05', '10')), ['plain', null, '0.311875', 5_500, 5_250, 5_500]);
});

test('(b) under $5 the plain house price: the highest within the ceiling that keeps the margin, whole dinars at or under 1,000 IQD, else the lowest that keeps it', () => {
  // R 500 at 10%: the ceiling 550 — 500 + 50 = 550.
  assert.deepEqual(pinned(target('500', '1.5', '10')), ['plain', null, '0.03125', 550, 3_000, 501]);
  // R 696 at 10%: 765.6 — 765 (never 766, a dinar over the ceiling).
  assert.deepEqual(pinned(target('696', '4.5', '10')), ['plain', null, '0.043125', 765, 8_000, 697]);
  // 0%: lifted to the margin, the lowest house price a dinar over the cost: 501 keeps 0.4992 of it, 502 keeps 1.4992.
  assert.deepEqual(pinned(target('500.5', '1.5', '0')), ['plain', null, '0.000937', 502, 3_000, 502]);
  // A cost of nothing still sells above it.
  assert.deepEqual(pinned(target('0', '1.5', '10')), ['plain', null, '0.000625', 1, 2_500, 1]);
  // R 720 at 10% (ceiling 792) and R 840 (924): their ceilings, where the grid sold them at $0.49 = 784 and $0.99 =
  // 1,750; R 783: 861.
  assert.deepEqual(pinned(target('720', '4.5', '10')), ['plain', null, '0.045', 792, 8_000, 721]);
  assert.deepEqual(pinned(target('840', '4.5', '10')), ['plain', null, '0.0525', 924, 8_250, 841]);
  assert.deepEqual(pinned(target('783', '4.5', '10')), ['plain', null, '0.04875', 861, 8_000, 784]);
  // R 2,900 at 10% (3,190): 3,250 — the house price 3,000 keeps 100.
  assert.deepEqual(pinned(target('2900', '6', '10')), ['plain', null, '0.21875', 3_250, 12_500, 3_250]);
});

test('(b) the owner’s differences stay on top: a positive sum is priced over, a negative one moves nothing; one that does not read prices nothing', () => {
  // The Nozzle's gold colour, +$1.30 (2,080 IQD) cost-first: the engine sells it at R + (T_sku + 1.30) × U. Today
  // 3,659.5 + 9,600 + 2,080 → 15,500; the ceiling 4,025.45 + 2,080 = 6,105.45, under $5 × 1,600: the house price
  // 6,000, T_sku = floor6((6,000 − 5,739.5) ÷ 1,600) = 0.162812.
  assert.deepEqual(pinned(target('3659.5', '6', '10', '1600', '1.3')), ['plain', null, '0.162812', 6_000, 15_500, 4_000]);
  // At 100% the ceiling (7,319 + 2,080 = 9,399) reaches $5.49 (8,784 → 9,000): on the grid.
  assert.deepEqual(pinned(target('3659.5', '6', '100', '1600', '1.3')), ['charm', '5.49', '1.902812', 9_000, 15_500, 4_000]);
  // A part of 300 IQD with the difference: the ceiling 2,410 holds no house price above R + 2,080 — the lowest above
  // it, 2,500.
  assert.deepEqual(pinned(target('300', '1.5', '10', '1600', '1.3')), ['plain', null, '0.075', 2_500, 5_000, 301]);
  // A negative sum never moves a cost-first price (C-9): exactly as with none, and as an explicit zero.
  for (const none of ['-1', '0', '-0.000001'])
    assert.deepEqual(pinned(target('3659.5', '6', '10', '1600', none)), ['plain', null, '0.212812', 4_000, 13_500, 4_000], none);
  for (const bad of ['1e3', '1.1234567', '+1', 'x', '']) assert.equal(charmTarget({ cost_iqd: '3659.5', usd_iqd: '1600', min_profit_usd: '6', ceiling_pct: '10', difference_usd: bad }), null, bad);
  assert.equal(charmTarget({ cost_iqd: '3659.5', usd_iqd: '1600', min_profit_usd: '6', ceiling_pct: '10', difference_usd: 1.3 as unknown as string }), null, 'a float is never read');
});

test('(b) nothing guessed: a figure that does not read prices nothing', () => {
  const ok = { cost_iqd: '3659.5', usd_iqd: '1600', min_profit_usd: '6', ceiling_pct: '10' };
  assert.ok(charmTarget(ok));
  for (const [k, bad] of [
    ['cost_iqd', '-1'],
    ['cost_iqd', '1e3'],
    ['cost_iqd', ''],
    ['usd_iqd', '0'],
    ['usd_iqd', '1,600'],
    ['min_profit_usd', '0'],
    ['min_profit_usd', '6.0000001'],
    ['ceiling_pct', '100.01'],
    ['ceiling_pct', '10.123'],
    ['ceiling_pct', '-1'],
  ] as const) {
    assert.equal(charmTarget({ ...ok, [k]: bad }), null, `${k} ${bad}`);
  }
  assert.equal(charmTarget({ ...ok, cost_iqd: 3659.5 as unknown as string }), null, 'a float is never read');
});

/* ---------------------------------------------------------- (c) the property -- */

/** The thirteen types' minimum profits, USD (the owner's table since 2026-11-02), and two under one rounding step at 1,600. */
const TYPE_T = ['135', '45', '375', '15', '6', '7.5', '18', '6', '7.5', '6', '4.5', '1.5', '3', '0.05', '0.15'];
const CEILINGS = ['0', '3', '4', '6', '8', '10', '25', '100'];
const RATES = ['1600', '1690'];
/** Differences on one case in nine: positive, negative, tiny, large. */
const DIFFERENCES = ['1.3', '-0.5', '0.07', '25', '0.000001', '-12'];

/** The costs the property walks: every dinar to 17,000, a stride to 60,000, every 997th dinar to 3,000,000, the band edges at both rates, the $5 edges, random costs and fractions. */
function costs(): string[] {
  const out: string[] = [];
  for (let r = 1; r <= 17_000; r++) out.push(String(r));
  for (let r = 17_001; r <= 60_000; r += 37) out.push(String(r));
  for (let r = 60_001; r <= 3_000_000; r += 997) out.push(String(r));
  for (const edge of [16_000, 16_900, 160_000, 169_000, 1_600_000, 1_690_000]) for (let r = edge - 1_200; r <= edge + 1_200; r += 29) out.push(String(r));
  const rnd = prng(291_1600);
  for (let i = 0; i < 1_200; i++) out.push(String(Math.max(1, Math.floor(Math.exp(rnd() * Math.log(3_000_000))))));
  for (let i = 0; i < 600; i++) out.push(`${Math.floor(rnd() * 60_000)}.${String(Math.floor(rnd() * 1_000)).padStart(3, '0')}`);
  out.push('3000000', '2999999.999', '1000', '1000.001', '999.999', '783', '784', '785', '1334', '1335', '2134', '2135');
  // A ceiling a half dinar under $5 × U and under the dinar price of $5.49, at both rates (P 0 and 100).
  out.push('3999.5', '4224.5', '4499.5', '4749.5', '7999.5', '8449.5', '8999.5', '9499.5');
  return out;
}
/** The number of cases the property walks: costs × ceilings × rates (said in the header, held here). */
const CASES = costs().length * CEILINGS.length * RATES.length;

const ZERO: ProcurementExact = { num: 0n, den: 1n };
const neg = (x: ProcurementExact): ProcurementExact => ({ num: -x.num, den: x.den });

/** The highest house price — rp's own grid: whole dinars to 1,000, then multiples of 250 — at or under q ≥ 0. */
function houseAtMost(q: ProcurementExact): number {
  const whole = Number(q.num / q.den);
  return whole > 1_000 ? whole - (whole % 250) : whole;
}

test('(c) property: from $5 up on the grid, under it the plain house price; a margin of one rounding step — the route floor never trips, now or after a rise — never above today’s unless the floor forces it; the highest price within the ceiling that keeps the margin, else the lowest that keeps it', () => {
  const counted = { cases: 0, charm: 0, today: 0, plain: 0, forced: 0, relaxed: 0, plainRelaxed: 0, differences: 0, risen: 0, atFive: 0, underFive: 0, window: 0, atCharm: 0, underCharm: 0, charmAtToday: 0, keptAtCharm: 0 };
  const rnd = prng(291_250);
  const list = costs();
  for (const [i, cost] of list.entries()) {
    const r = procurementExact(cost);
    for (const [pi, p] of CEILINGS.entries()) {
      for (const u of RATES) {
        counted.cases++;
        const t = TYPE_T[(i + pi) % TYPE_T.length]!;
        const difference = (i + pi) % 9 === 0 ? DIFFERENCES[(i + pi) % DIFFERENCES.length]! : null;
        const x = charmTarget({ cost_iqd: cost, usd_iqd: u, min_profit_usd: t, ceiling_pct: p, difference_usd: difference });
        const at = `R ${cost}, T ${t}, P ${p}, U ${u}, Δ ${difference}`;
        assert.ok(x, at);
        if (difference) counted.differences++;
        const U = procurementExact(u);
        const D = difference && !difference.startsWith('-') ? procurementExact(difference) : ZERO;
        // Independent arithmetic: B = R + Δ⁺ × U; the engine's price at a USD profit; the profit at a charm price c
        // (floor6(c − B ÷ U)) and at a house price (floor6((D − B) ÷ U)); the margin a profit keeps over R, (profit +
        // Δ⁺) × U.
        const b = addProcurementExact(r, mulProcurementExact(D, U));
        const priceAt = (usd: ProcurementExact) => roundPriceIqd(addProcurementExact(b, mulProcurementExact(usd, U)));
        const profitOf = (cents: number): ProcurementExact => floorToPlaces(quotientProcurementExact(addProcurementExact(mulProcurementExact(procurementExact(cents), U), { num: -100n * b.num, den: b.den }), mulProcurementExact(procurementExact(100), U)), 6);
        const houseProfitOf = (iqd: number): ProcurementExact => floorToPlaces(quotientProcurementExact(addProcurementExact(procurementExact(iqd), neg(b)), U), 6);
        const keeps = (usd: ProcurementExact) => compareProcurementExact(mulProcurementExact(addProcurementExact(usd, D), U), procurementExact(marginNeededIqd(priceAt(usd)))) >= 0;
        const charmAt = (cents: number | null): { price: number; usd: ProcurementExact } | null => {
          if (cents === null) return null;
          const usd = profitOf(cents);
          return usd.num > 0n ? { price: priceAt(usd), usd } : null;
        };
        const houseAt = (iqd: number): { price: number; usd: ProcurementExact } | null => {
          if (iqd < 1) return null;
          const usd = houseProfitOf(iqd);
          return usd.num > 0n ? { price: priceAt(usd), usd } : null;
        };
        const amount = procurementExact(x.amount_usd);
        assert.match(x.amount_usd, /^[0-9]+(?:\.[0-9]{1,6})?$/, at);
        assert.ok(amount.num > 0n && !/\.\d*0$/.test(x.amount_usd), `${at}: a storable, canonical profit`);
        const today = priceAt(procurementExact(t));
        // Today's own dollar figure as the storefront shows it: ceil6((B + T × U) ÷ U), then up to the cent.
        const todayCents = () => usdCeilCentsOf(procurementExactText(ceilToPlaces(quotientProcurementExact(addProcurementExact(b, mulProcurementExact(procurementExact(t), U)), U), 6)));
        const costRounded = roundPriceIqd(r);
        const floor = roundPriceIqd(BigInt(costRounded) + 1n);
        // Within R × (1 + P / 100) + Δ⁺ × U: price × 100 ≤ R × (100 + P) + 100 × Δ⁺ × U.
        const capTimes100 = addProcurementExact(mulProcurementExact(r, addProcurementExact(procurementExact(100), procurementExact(p))), mulProcurementExact(procurementExact(100), D, U));
        const fits = (price: number) => price <= today && compareProcurementExact(procurementExact(price * 100), capTimes100) <= 0;
        const ceiling = compareProcurementExact(procurementExact(today * 100), capTimes100) <= 0 ? procurementExact(today) : quotientProcurementExact(capTimes100, procurementExact(100));
        assert.deepEqual([x.today_iqd, x.floor_iqd, x.price_iqd], [today, floor, priceAt(amount)], `${at}: the engine's own figures`);
        // The route floor never trips: the price is above the cost rounded up (priceV2 Q1).
        assert.ok(x.price_iqd > costRounded, `${at}: ${x.price_iqd} clears rp(R) ${costRounded}`);
        // Never above today's, unless today's own price would not clear the route floor.
        assert.ok(x.price_iqd <= today || today <= costRounded, `${at}: ${x.price_iqd} above today's ${today}`);
        if (x.price_iqd > today) counted.forced++;

        // THE THRESHOLD. A ceiling under $5 × U never prices on the grid; nor does one under the dinar price of the
        // lowest charm price of at least $5 ($5.49) — its only charm prices are under $5; one at or above it never
        // prices plainly.
        const fiveU = mulProcurementExact(procurementExact(CHARM_MIN_USD), U);
        const lowestUsedIqd = roundPriceIqd(mulProcurementExact({ num: BigInt(LOWEST_USED_CHARM_CENTS), den: 100n }, U));
        const toFive = compareProcurementExact(ceiling, fiveU);
        const toCharm = compareProcurementExact(ceiling, procurementExact(lowestUsedIqd));
        const charmable = fits(lowestUsedIqd);
        assert.equal(charmable, toCharm >= 0, `${at}: the ceiling reaches $5.49's dinar price`);
        if (toFive < 0) assert.notEqual(x.basis, 'charm', `${at}: a ceiling under $5 × U prices plainly`);
        if (!charmable) assert.notEqual(x.basis, 'charm', `${at}: no charm price of at least $5 fits`);
        else assert.notEqual(x.basis, 'plain', `${at}: a charm price of at least $5 fits`);
        if (toFive === 0) counted.atFive++;
        if (toFive < 0 && compareProcurementExact(ceiling, addProcurementExact(fiveU, neg(procurementExact(250)))) >= 0) counted.underFive++;
        if (toFive >= 0 && toCharm < 0) counted.window++;
        if (toCharm === 0) counted.atCharm++;
        if (toCharm < 0 && compareProcurementExact(ceiling, procurementExact(lowestUsedIqd - 250)) >= 0) counted.underCharm++;

        if (x.basis !== 'today') {
          // The margin: one rounding step over R (a dinar at or under 1,000 IQD)…
          assert.ok(keeps(amount), `${at}: the margin of ${x.price_iqd}`);
          // …so whatever R and U do upward, the route stays open (sampled): at or under 1,000 IQD up to 1,000.
          if (counted.cases % 7 === 0) {
            for (let k = 0; k < 3; k++) {
              const top = x.price_iqd > 1_000 ? Number(cost) * 1.3 + 2_000 : Math.min(1_000, Number(cost) * 1.3);
              const r2 = procurementExact((Number(cost) + rnd() * Math.max(0, top - Number(cost))).toFixed(3));
              const u2 = procurementExact((Number(u) * (1 + rnd() * 0.2)).toFixed(2));
              const after = roundPriceIqd(addProcurementExact(r2, mulProcurementExact(addProcurementExact(amount, D), u2)));
              assert.ok(after > roundPriceIqd(r2), `${at}: after R ${procurementExactText(r2)}, U ${procurementExactText(u2)} the route closes`);
              counted.risen++;
            }
          }
        }

        if (x.basis === 'charm') {
          counted.charm++;
          const c = x.charm_cents!;
          assert.ok(isCharmCents(c), `${at}: $${centsText(c)} on the grid`);
          assert.ok(c >= CHARM_MIN_USD * 100, `${at}: $${centsText(c)} is at least $5`);
          assert.equal(compareProcurementExact(amount, profitOf(c)), 0, `${at}: T_sku = floor6(c − B ÷ U)`);
          // The engine's dollar price (usd_ceil6) is c, and the storefront's $ shows it.
          const ceil6 = ceilToPlaces(quotientProcurementExact(addProcurementExact(b, mulProcurementExact(amount, U)), U), 6);
          assert.equal(procurementExactText(ceil6), procurementExactText({ num: BigInt(c), den: 100n }), `${at}: the dollar price is $${centsText(c)}`);
          assert.equal(usdCeilCentsOf(procurementExactText(ceil6)), c);
          // The dinar price is rp(c × U).
          assert.equal(x.price_iqd, roundPriceIqd(mulProcurementExact({ num: BigInt(c), den: 100n }, U)), `${at}: rp(c × U)`);
          // Today's own dinar price only where today's own dollar figure is not c: the price stays, the dollar shown
          // becomes c (the lead's ruling for the owner, 2026-11-05) — where it already is c, T stays.
          if (x.price_iqd === today) {
            counted.charmAtToday++;
            assert.notEqual(todayCents(), c, `${at}: today's own dollar figure is already $${centsText(c)}: T stays`);
          }
          if (fits(x.price_iqd)) {
            // The highest: no dearer charm price within the ceiling keeps the margin.
            for (let up = charmAtLeastCents(c + 1), next = charmAt(up); next !== null && fits(next.price); up = charmAtLeastCents(up + 1), next = charmAt(up)) {
              assert.ok(!keeps(next.usd), `${at}: $${centsText(up)} fits and keeps — $${centsText(c)} is not the highest`);
            }
          } else {
            counted.relaxed++;
            // None fits: the lowest charm price of at least $5 that keeps the margin — the one below has no profit or
            // keeps none.
            if (c > LOWEST_USED_CHARM_CENTS) {
              const prev = charmAt(charmAtMostCents(c - 1));
              assert.ok(prev === null || !keeps(prev.usd), `${at}: $${centsText(c)} is the lowest charm price that keeps the margin`);
            }
          }
        } else if (x.basis === 'plain') {
          counted.plain++;
          assert.equal(x.charm_cents, null);
          // A house price, T_sku = floor6((D − B) ÷ U), and the dollar price its own: within a millionth of D ÷ U.
          assert.ok(isOnPriceRule(x.price_iqd), `${at}: ${x.price_iqd} is a house price`);
          assert.equal(compareProcurementExact(amount, houseProfitOf(x.price_iqd)), 0, `${at}: T_sku = floor6((D − B) ÷ U)`);
          const ceil6 = ceilToPlaces(quotientProcurementExact(addProcurementExact(b, mulProcurementExact(amount, U)), U), 6);
          const off = addProcurementExact(mulProcurementExact(ceil6, U), neg(procurementExact(x.price_iqd)));
          assert.ok(compareProcurementExact(off.num < 0n ? neg(off) : off, quotientProcurementExact(U, procurementExact(1_000_000))) < 0, `${at}: the dollar price is ${x.price_iqd}'s own`);
          if (fits(x.price_iqd)) {
            // The highest house price within the ceiling (it keeps the margin; the next one up does not fit).
            assert.ok(!fits(roundPriceIqd(x.price_iqd + 1)), `${at}: ${roundPriceIqd(x.price_iqd + 1)} fits too — ${x.price_iqd} is not the highest`);
          } else {
            counted.plainRelaxed++;
            // None within the ceiling keeps the margin…
            for (let h = houseAtMost(ceiling), here = houseAt(h); here !== null; h = houseAtMost(procurementExact(h - 1)), here = houseAt(h)) {
              assert.ok(!(fits(here.price) && keeps(here.usd)), `${at}: ${h} fits and keeps`);
            }
            // …and the house price below it keeps none.
            const prev = houseAt(houseAtMost(procurementExact(x.price_iqd - 1)));
            assert.ok(prev === null || !keeps(prev.usd), `${at}: ${x.price_iqd} is the lowest house price that keeps the margin`);
          }
        } else {
          counted.today++;
          assert.equal(compareProcurementExact(amount, procurementExact(t)), 0, `${at}: T itself`);
          assert.ok(today > costRounded, `${at}: today's price clears the route floor`);
          if (!charmable) {
            // Under $5: the highest house price within the ceiling that keeps the margin gives today's price exactly —
            // or none does, and the lowest that keeps it is no cheaper than today's.
            let found: ReturnType<typeof houseAt> = null;
            for (let h = houseAtMost(ceiling), here = houseAt(h); here !== null; h = houseAtMost(procurementExact(h - 1)), here = houseAt(h)) {
              if (fits(here.price) && keeps(here.usd)) {
                found = here;
                break;
              }
            }
            if (found) assert.equal(found.price, today, `${at}: T stays only for today's price (house)`);
            else {
              let h = roundPriceIqd(b.num / b.den + 1n);
              let above = houseAt(h);
              while (above === null || !keeps(above.usd)) above = houseAt((h = roundPriceIqd(h + 1)));
              assert.ok(above.price >= today, `${at}: no house price between the margin and today's (${above.price})`);
            }
          } else {
            // The highest charm price of at least $5 within the ceiling that keeps the margin gives today's price
            // exactly, and today's own dollar figure already is it — or none does, and the lowest that keeps it is
            // dearer than today's (nothing goes up), or today's price with today's own dollar figure already it.
            let c = charmAtMostCents(Number((ceiling.num * 100n * U.den) / (ceiling.den * U.num)) + 2);
            let found: ReturnType<typeof charmAt> = null;
            for (let at2 = charmAt(c); c !== null && c >= LOWEST_USED_CHARM_CENTS && at2 !== null; c = charmAtMostCents(c - 1), at2 = charmAt(c)) {
              if (fits(at2.price) && keeps(at2.usd)) {
                found = at2;
                break;
              }
            }
            if (found) {
              assert.equal(found.price, today, `${at}: T stays only for today's price`);
              assert.equal(todayCents(), c, `${at}: T stays at $${centsText(c!)}'s dinar price only where today's own dollar figure is it`);
              counted.keptAtCharm++;
            } else {
              let up = charmAtLeastCents(Math.max(LOWEST_USED_CHARM_CENTS, Number((b.num * 100n * U.den) / (b.den * U.num))));
              let above = charmAt(up);
              while (above === null || !keeps(above.usd)) above = charmAt((up = charmAtLeastCents(up + 1)));
              assert.ok(above.price > today || (above.price === today && todayCents() === up), `${at}: no charm price between the margin and today's (${above.price})`);
            }
          }
        }
      }
    }
  }
  assert.equal(counted.cases, CASES);
  // Not vacuous: every branch is walked — the floor-forced one, both relaxed ones, both boundaries, and today's dinar
  // price both ways (c shown; T kept where today's own figure already is c) too.
  assert.ok(
    counted.charm > 100_000 &&
      counted.plain > 50_000 &&
      counted.today > 10_000 &&
      counted.relaxed > 20_000 &&
      counted.plainRelaxed > 20_000 &&
      counted.forced > 1_000 &&
      counted.differences > 10_000 &&
      counted.risen > 50_000 &&
      counted.atFive > 100 &&
      counted.underFive > 1_000 &&
      counted.window > 5_000 &&
      counted.atCharm > 100 &&
      counted.underCharm > 1_000 &&
      counted.charmAtToday > 1_000 &&
      counted.keptAtCharm > 100,
    JSON.stringify(counted)
  );
});
