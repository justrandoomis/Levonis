/**
 * THE SCHEDULED PRICE — docs/BUNDLES_MYSTERY.md §4.6.
 *
 * A window carries its own price, or "limited offer" is a countdown over an
 * unchanged number: the only way to run "20% off this week" would be an admin
 * edit at the start and another at the end, and the order snapshot's `offer`
 * block could never answer "which offer produced this price".
 *
 * PRECEDENCE IS A REFUSAL, NOT AN ARITHMETIC. Exactly one source may set a
 * price for a subject — the window, or the subject's own ladder. Never both,
 * never summed, never a percentage of a percentage. That is precisely the
 * invalid stacking the mandate names, and it is why a window price beside a
 * non-'fixed' `bundle_config.price_mode` is refused at admin save rather than
 * combined here.
 *
 * And the member ladder is clamped against the OFFER price when one is live:
 * clamping against the stored regular would let a PRO member pay more than a
 * regular buyer the moment the offer price fell below the stored PRO price.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice, type ResolvedPrice, type Tier } from '../worker/lib/pricing';
import { resolveOfferPrice, scheduleState, type OfferWindow } from '../worker/lib/offers';

const NOW = Date.parse('2026-06-15T12:00:00Z');

const product = (over: Record<string, unknown> = {}) => ({
  price_iqd: 100_000,
  prime_price_iqd: null,
  pro_price_iqd: null,
  product_cost_iqd: null,
  selling_type: 'direct_sale',
  sale_types: ['direct_sale'],
  options: [],
  colors: [],
  preorder_transports: [],
  warranty_plans: [],
  ...over,
});

const base = (tier: Tier, tierActive = true, over = {}, proPolicy?: { mode: string; percent: number | null }): ResolvedPrice =>
  resolveUnitPrice({ product: product(over) as never, tier, tierActive, proPolicy: proPolicy as never });

const window = (over: Partial<OfferWindow> = {}): OfferWindow => ({
  id: 'ofw_1',
  starts_at: null,
  ends_at: null,
  required_tiers: [],
  offer_price_mode: '',
  offer_price_iqd: null,
  discount_percent: null,
  discount_iqd: null,
  plus_price_iqd: null,
  locked_preview: true,
  active: true,
  ...over,
});

test('a window with no price of its own changes no price at all', () => {
  const w = window({ ends_at: '2026-07-01T00:00:00Z' });
  const out = resolveOfferPrice({
    base: base('free', false),
    window: w,
    scheduleState: scheduleState(w.starts_at, w.ends_at, NOW),
    tier: 'free',
    tierActive: false,
  });
  assert.equal(out.applied_iqd, 100_000);
  assert.equal(out.source, 'ladder');
  assert.equal(out.offer_id, 'ofw_1', 'the offer is still named — it schedules and gates, it just does not price');
});

test('a LIVE window price replaces the ladder', () => {
  for (const [mode, extra, expected] of [
    ['fixed', { offer_price_iqd: 79_000 }, 79_000],
    ['discount_percent', { discount_percent: 20 }, 80_000],
    ['discount_iqd', { discount_iqd: 25_000 }, 75_000],
  ] as const) {
    const w = window({ offer_price_mode: mode, ...extra });
    const out = resolveOfferPrice({
      base: base('free', false),
      window: w,
      scheduleState: 'live',
      tier: 'free',
      tierActive: false,
    });
    assert.equal(out.applied_iqd, expected, mode);
    assert.equal(out.regular_iqd, expected, mode);
    assert.equal(out.source, 'offer', mode);
  }
});

test('an UPCOMING or ENDED window contributes its state and its countdown, never its price', () => {
  for (const [starts, ends] of [
    ['2026-07-01T00:00:00Z', null],
    [null, '2026-06-01T00:00:00Z'],
  ] as Array<[string | null, string | null]>) {
    const w = window({ offer_price_mode: 'discount_percent', discount_percent: 50, starts_at: starts, ends_at: ends });
    const out = resolveOfferPrice({
      base: base('free', false),
      window: w,
      scheduleState: scheduleState(starts, ends, NOW),
      tier: 'free',
      tierActive: false,
    });
    assert.equal(out.applied_iqd, 100_000);
    assert.equal(out.source, 'ladder');
  }
});

test('an INACTIVE window prices nothing even inside its dates', () => {
  const w = window({ offer_price_mode: 'fixed', offer_price_iqd: 1, active: false });
  const out = resolveOfferPrice({ base: base('free', false), window: w, scheduleState: 'live', tier: 'free', tierActive: false });
  assert.equal(out.applied_iqd, 100_000);
  assert.equal(out.source, 'ladder');
});

test('the member rungs are clamped against the OFFER price, so a PRO never pays more than a regular buyer', () => {
  // A 10% store-wide PRO policy gives a stored PRO price of 90,000. The offer
  // then sets 60,000 — below it.
  const resolved = base('pro', true, {}, { mode: 'global_percent', percent: 10 });
  assert.equal(resolved.pro_iqd, 90_000);
  const w = window({ offer_price_mode: 'fixed', offer_price_iqd: 60_000 });
  const out = resolveOfferPrice({ base: resolved, window: w, scheduleState: 'live', tier: 'pro', tierActive: true });
  assert.equal(out.regular_iqd, 60_000);
  assert.ok(out.pro_iqd !== null && out.pro_iqd <= out.regular_iqd);
  assert.equal(out.applied_iqd, 60_000);
});

test('the offer’s PLUS rung reaches PLUS and every inheriting tier', () => {
  const w = window({ offer_price_mode: 'fixed', offer_price_iqd: 80_000, plus_price_iqd: 70_000 });
  const plus = resolveOfferPrice({ base: base('plus', true), window: w, scheduleState: 'live', tier: 'plus', tierActive: true });
  assert.equal(plus.applied_iqd, 70_000);
  assert.equal(plus.plus_iqd, 70_000);

  const prime = resolveOfferPrice({ base: base('prime', true), window: w, scheduleState: 'live', tier: 'prime', tierActive: true });
  assert.equal(prime.applied_iqd, 70_000, 'PREMIUM inherits the PLUS price');

  const lapsed = resolveOfferPrice({ base: base('plus', false), window: w, scheduleState: 'live', tier: 'plus', tierActive: false });
  assert.equal(lapsed.applied_iqd, 80_000);
});

test('a PLUS rung above the offer price is clamped down, never charged', () => {
  const w = window({ offer_price_mode: 'fixed', offer_price_iqd: 50_000, plus_price_iqd: 90_000 });
  const out = resolveOfferPrice({ base: base('plus', true), window: w, scheduleState: 'live', tier: 'plus', tierActive: true });
  assert.equal(out.applied_iqd, 50_000);
  assert.equal(out.plus_iqd, 50_000);
});

test('the two price sources are never combined: the window replaces, it does not discount the discount', () => {
  // A product whose stored ladder already carries a member price, plus a live
  // 20% window: the result is 20% off the REGULAR price, once.
  const w = window({ offer_price_mode: 'discount_percent', discount_percent: 20 });
  const out = resolveOfferPrice({
    base: base('prime', true, { prime_price_iqd: 90_000 }),
    window: w,
    scheduleState: 'live',
    tier: 'prime',
    tierActive: true,
  });
  assert.equal(out.regular_iqd, 80_000, '100,000 − 20%, and not 90,000 − 20% as well');
  assert.equal(out.prime_iqd, 80_000, 'the stored PRIME price is clamped to the offer, not stacked under it');
  assert.equal(out.applied_iqd, 80_000);
});

/**
 * A WINDOW PRICE HAS A FLOOR, AND UNDER IT NOTHING IS SOLD (§4.3).
 *
 * The previous expectation here — `applied_iqd === 0` for a discount larger
 * than the price — WAS the defect: §4.6 makes a live window the sole price
 * source, so `Math.max(0, …)` turned one typed zero too many into a free sale
 * of any product or bundle, with no refusal, no warning and no admin banner.
 * §4.3's rule is that such a price does not clamp and does not sell.
 */
test('a window price under its floor does not clamp and does not sell', () => {
  const w = window({ offer_price_mode: 'discount_iqd', discount_iqd: 500_000 });
  const out = resolveOfferPrice({ base: base('free', false), window: w, scheduleState: 'live', tier: 'free', tierActive: false });
  assert.equal(out.source, 'ladder', 'the broken window contributes no price at all');
  assert.equal(out.applied_iqd, 100_000, 'and nothing is sold for 0 IQD');
  assert.deepEqual(out.errors, ['DERIVED_PRICE_BELOW_FLOOR', 'OFFER_INACTIVE']);

  const free = window({ offer_price_mode: 'fixed', offer_price_iqd: 0 });
  const zero = resolveOfferPrice({ base: base('free', false), window: free, scheduleState: 'live', tier: 'free', tierActive: false });
  assert.equal(zero.source, 'ladder');
  assert.deepEqual(zero.errors, ['DERIVED_PRICE_BELOW_FLOOR', 'OFFER_INACTIVE']);

  // A bundle carries its own, higher floor: `bundle_config.min_price_iqd`.
  const under = window({ offer_price_mode: 'fixed', offer_price_iqd: 50_000 });
  const floored = resolveOfferPrice({
    base: base('free', false), window: under, scheduleState: 'live', tier: 'free', tierActive: false,
    floorIqd: 100_000,
  });
  assert.deepEqual(floored.errors, ['DERIVED_PRICE_BELOW_FLOOR', 'OFFER_INACTIVE']);

  const wild = window({ offer_price_mode: 'discount_percent', discount_percent: 200 });
  const capped = resolveOfferPrice({ base: base('free', false), window: wild, scheduleState: 'live', tier: 'free', tierActive: false });
  assert.equal(capped.applied_iqd, 10_000, 'clamped to the documented 1..90 band');
  assert.deepEqual(capped.errors, []);
});

test('no window at all is the plain ladder', () => {
  const out = resolveOfferPrice({ base: base('free', false), window: null, scheduleState: 'live', tier: 'free', tierActive: false });
  assert.equal(out.applied_iqd, 100_000);
  assert.equal(out.offer_id, null);
  assert.equal(out.source, 'ladder');
});
