/**
 * THE ONE PRICE ROUNDING RULE (owner decision 2026-10-17, DECISIONS row 245).
 *
 * Above 1,000 IQD a price rounds UP to the next multiple of 250 (13,120 → 13,250;
 * 1,120 → 1,250; 24,000 stays); at or below 1,000 it is not stepped, only whole
 * dinars. ONE function (`roundPriceIqd`, packages/pricing/src/priceRounding.ts)
 * and every path calls it: Pricing V2's direct price and every route, the
 * dollar sale price, and the percent / amount-off sale price — whose result, if
 * the rounding brings it back to the price before, is no sale at all (D4).
 *
 * Run: node --import tsx --test tests/pricingRounding.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { isOnPriceRule, roundPriceIqd, PRICE_ROUNDING_STEP_IQD, PRICE_ROUNDING_THRESHOLD_IQD } from '../packages/pricing/src/priceRounding';
import { resolveOfferPrice, type OfferWindow } from '../worker/lib/offers';
import { fixedUsdLine, usdToIqdCeil } from '../worker/lib/offerUsd';
import type { ResolvedPrice } from '../worker/lib/pricing';

test('the boundaries: 999, 1,000, 1,001, 1,120, 13,120, 13,250, 24,000', () => {
  const cases: Array<[number, number]> = [
    [999, 999],
    [1_000, 1_000],
    [1_001, 1_250],
    [1_120, 1_250],
    [1_250, 1_250],
    [1_251, 1_500],
    [13_120, 13_250],
    [13_250, 13_250],
    [13_251, 13_500],
    [24_000, 24_000],
    [1, 1],
    [0, 0],
  ];
  for (const [input, want] of cases) assert.equal(roundPriceIqd(input), want, `${input} → ${want}`);
  assert.equal(PRICE_ROUNDING_THRESHOLD_IQD, 1_000);
  assert.equal(PRICE_ROUNDING_STEP_IQD, 250);
});

test('exact amounts: a fraction at or below 1,000 rounds up to whole dinars; just above 1,000 to 1,250', () => {
  assert.equal(roundPriceIqd('999.01'), 1_000, 'still ≤ 1,000 once whole: not stepped');
  assert.equal(roundPriceIqd('120.4'), 121);
  assert.equal(roundPriceIqd('1000'), 1_000);
  assert.equal(roundPriceIqd('1000.01'), 1_250, 'above 1,000: the next 250');
  assert.equal(roundPriceIqd({ num: 2_160_000n, den: 100n }), 21_750, '24,000 × 90% = 21,600 → 21,750');
  assert.equal(roundPriceIqd({ num: 1_312_001n, den: 100n }), 13_250);
  assert.equal(roundPriceIqd('1650015'), 1_650_250);
  assert.equal(roundPriceIqd(10n ** 11n), 100_000_000_000);
});

test('up, never to nearest; monotone; idempotent; never below the amount; adds less than one 250', () => {
  let previous = 0;
  for (let cents = 0; cents <= 3_000_00; cents += 37) {
    const exact = { num: BigInt(cents), den: 100n };
    const r = roundPriceIqd(exact);
    assert.ok(r * 100 >= cents, `${cents / 100}: never below`);
    assert.ok(r * 100 - cents < 250 * 100, `${cents / 100}: adds less than 250`);
    if (cents > 1_000_00) assert.equal(r % 250, 0, `${cents / 100}: a multiple of 250`);
    else assert.ok(r <= 1_000, `${cents / 100}: ≤ 1,000 stays ≤ 1,000`);
    assert.ok(r >= previous, 'monotone');
    assert.equal(roundPriceIqd(r), r, 'idempotent');
    previous = r;
  }
});

test('refusals: a negative amount is never a price, a binary float never enters', () => {
  assert.throws(() => roundPriceIqd(-1), RangeError);
  assert.throws(() => roundPriceIqd('-0.5'), RangeError);
  assert.throws(() => roundPriceIqd(1000.5), RangeError);
  assert.throws(() => roundPriceIqd(Number.NaN), RangeError);
});

test('isOnPriceRule: what the rule can give', () => {
  for (const ok of [1, 999, 1_000, 1_250, 13_250, 24_000]) assert.equal(isOnPriceRule(ok), true, String(ok));
  for (const bad of [0, -250, 1_001, 1_120, 13_120, 1.5]) assert.equal(isOnPriceRule(bad), false, String(bad));
});

/* ------------------------------------------------------------ the discount -- */

const base = (regular: number): ResolvedPrice =>
  ({ regular_iqd: regular, applied_iqd: regular, prime_iqd: null, pro_iqd: null, applied_tier: 'regular', unit_subtotal_iqd: regular, errors: [] }) as unknown as ResolvedPrice;

const win = (over: Partial<OfferWindow>): OfferWindow => ({
  id: 'w',
  starts_at: null,
  ends_at: null,
  required_tiers: [],
  offer_price_mode: 'discount_percent',
  offer_price_iqd: null,
  discount_percent: null,
  discount_iqd: null,
  plus_price_iqd: null,
  locked_preview: false,
  active: true,
  ...over,
});

const offer = (regular: number, over: Partial<OfferWindow>) =>
  resolveOfferPrice({ base: base(regular), window: win(over), scheduleState: 'live', tier: 'free', tierActive: false });

test('a percent sale is rounded up by the same rule (it was floored to whole dinars)', () => {
  assert.equal(offer(24_000, { discount_percent: 10 }).regular_iqd, 21_750, '21,600 → 21,750');
  assert.equal(offer(13_800, { discount_percent: 5 }).regular_iqd, 13_250, '13,110 → 13,250');
  assert.equal(offer(25_000, { discount_percent: 10 }).regular_iqd, 22_500, '22,500 is on the rule: unchanged');
});

test('percent: the struck price stays honest — a rounding that reaches the price before is no sale at all', () => {
  // 1% of 1,250 = 1,237.5 → 1,250: not strictly below, so the window contributes nothing (D4).
  const none = offer(1_250, { discount_percent: 1 });
  assert.equal(none.source, 'ladder');
  assert.equal(none.regular_iqd, 1_250);
  assert.deepEqual(none.errors, []);
  // 24,000 − 10% = 21,600 → 21,750: a sale, on the rule, below the before price.
  const sale = offer(24_000, { discount_percent: 10 });
  assert.equal(sale.source, 'offer');
  assert.ok(sale.regular_iqd < 24_000);
  // At or below 1,000 the result is whole dinars, never stepped: 900 − 10% = 810.
  assert.equal(offer(900, { discount_percent: 10 }).regular_iqd, 810);
  // 1,100 − 10% = 990: ≤ 1,000, whole dinars.
  assert.equal(offer(1_100, { discount_percent: 10 }).regular_iqd, 990);
  // An amount off is an after-price too: 24,000 − 1,234 = 22,766 → 23,000.
  assert.equal(offer(24_000, { offer_price_mode: 'discount_iqd', discount_iqd: 1_234 }).regular_iqd, 23_000);
  // An amount off that leaves nothing still refuses (the floor), never rounds a price out of nothing.
  assert.deepEqual(offer(24_000, { offer_price_mode: 'discount_iqd', discount_iqd: 30_000 }).errors, ['DERIVED_PRICE_BELOW_FLOOR', 'OFFER_INACTIVE']);
});

test('the dollar sale price: round(cents ÷ 100 × U) by the same rule, the saving carried to the route', () => {
  assert.equal(usdToIqdCeil(875, '1500'), 13_250, '$8.75 × 1,500 = 13,125 → 13,250');
  assert.equal(usdToIqdCeil(50, '1500'), 750, '$0.50 × 1,500 = 750: ≤ 1,000, not stepped');
  assert.equal(usdToIqdCeil(1600, '1500'), 24_000);
  assert.equal(usdToIqdCeil(1601, '1500'), 24_250, '24,015 → 24,250');
  // D4 by the rule: an after price that rounds back to the direct price is no sale.
  assert.deepEqual(fixedUsdLine({ cents: 1599, rate: '1500', directIqd: 24_000, channelIqd: 24_000 }), { kind: 'none' }, '23,985 → 24,000: not lower');
  // The same IQD saving off a route: 24,000 → 21,750 saves 2,250; the land price 22,500 pays 20,250.
  assert.deepEqual(fixedUsdLine({ cents: 1449, rate: '1500', directIqd: 24_000, channelIqd: 22_500 }), { kind: 'price', regular_iqd: 20_250 }, '21,735 → 21,750');
});

test('ONE function: no V2 or discount path keeps its own step', () => {
  const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
  const v2 = read('packages/pricing/src/priceV2.ts');
  assert.doesNotMatch(v2, /\bceilStep\b|\bROUNDING_STEP_IQD\b/, 'priceV2 rounds through roundPriceIqd only');
  assert.match(v2, /const D = roundPriceIqd\(eD\)/);
  assert.match(v2, /let price = roundPriceIqd\(eP\)/);
  const usd = read('worker/lib/offerUsd.ts');
  assert.doesNotMatch(usd, /\bceilStep\b|\bROUNDING_STEP_IQD\b/);
  assert.match(usd, /roundPriceIqd\(mulProcurementExact/);
  const offers = read('worker/lib/offers.ts');
  assert.doesNotMatch(offers, /Math\.floor\(\(base\.regular_iqd \* \(100 - p\)\) \/ 100\)/, 'the percent sale is no longer floored');
  assert.match(offers, /roundPriceIqd\(\{ num: BigInt\(before\) \* BigInt\(100 - p\), den: 100n \}\)/);
});
