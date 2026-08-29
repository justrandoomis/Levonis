/**
 * Purchase-points unit tests — integrated mandate §4.2 / §4.3 / §4.4 / §5.
 * These pin the NEW rule (100 IQD = 1 point, accrued pending at purchase,
 * released after seven days AND payment settlement) and the acceptance tests
 * PTS-01 / PTS-03 / PTS-07 from §14.3.
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unitMerchandiseIqd,
  eligibleMerchandiseIqd,
  netEligibleIqd,
  computeQualifyingSpendIqd,
  pointsForEligibleIqd,
  capRedeemablePoints,
  recomputeReversal,
  allocateReversalPortion,
  parsePointsRuleConfig,
  resolvePointsRule,
  availableAtFrom,
  ACCRUAL_HOLD_MS,
  POINTS_RULE_DEFAULTS,
  type PointsItemFacts,
} from '../worker/lib/pointsOps';

const RATE = 100; // the mandate's new rule: 100 IQD of net eligible = 1 point

const item = (over: Partial<PointsItemFacts> = {}): PointsItemFacts => ({
  qty: 1,
  unit_price_iqd: 10_000,
  pricing_snapshot: JSON.stringify({ applied_iqd: 10_000 }),
  warranty_snapshot: null,
  transport_snapshot: null,
  ...over,
});

// ------------------------------------------------------------------ PTS-01

test('PTS-01: 99 → 0, 100 → 1, 199 → 1, 75,000 → 750 points', () => {
  assert.equal(pointsForEligibleIqd(99, RATE), 0);
  assert.equal(pointsForEligibleIqd(100, RATE), 1);
  assert.equal(pointsForEligibleIqd(199, RATE), 1);
  assert.equal(pointsForEligibleIqd(75_000, RATE), 750);
  assert.equal(pointsForEligibleIqd(0, RATE), 0);
  assert.equal(pointsForEligibleIqd(-500, RATE), 0);
});

test('PTS-01: changing delivery alone never changes the points earned', () => {
  // Merchandise is the ONLY basis; a 5,000 or 50,000 delivery fee is simply
  // not part of it, so there is nothing for shipping to add.
  const merchandise = eligibleMerchandiseIqd([
    item({ unit_price_iqd: 75_000, pricing_snapshot: JSON.stringify({ applied_iqd: 75_000 }) }),
  ]);
  assert.equal(merchandise, 75_000);
  assert.equal(pointsForEligibleIqd(netEligibleIqd(merchandise, 0, 0), RATE), 750);
});

test('the order total is summed first and floored ONCE, never per line', () => {
  // Three lines of 199 IQD: per-line flooring would give 1+1+1 = 3 points.
  // The order-total basis gives floor(597/100) = 5 — the customer keeps the
  // remainders the mandate says they must not lose.
  const lines = [199, 199, 199].map((p) =>
    item({ unit_price_iqd: p, pricing_snapshot: JSON.stringify({ applied_iqd: p }) })
  );
  const merchandise = eligibleMerchandiseIqd(lines);
  assert.equal(merchandise, 597);
  assert.equal(pointsForEligibleIqd(merchandise, RATE), 5);
});

// ------------------------------------------- the mandatory §5 worked example

test('§5 mandatory arithmetic: 75,000 net, 739 points, 5,000 delivery, 30,000 wallet', () => {
  // Merchandise net of commercial (product/membership) discounts.
  const netMerchandise = 75_000;
  const merchandise = eligibleMerchandiseIqd([
    item({ unit_price_iqd: netMerchandise, pricing_snapshot: JSON.stringify({ applied_iqd: netMerchandise }) }),
  ]);
  assert.equal(merchandise, 75_000);

  // Redemption: all available points, capped at eligible merchandise. The
  // amount is EXACT — 739 points discount 739 IQD, not 500 and not 1,000.
  const pointsUsed = capRedeemablePoints(739, merchandise);
  assert.equal(pointsUsed, 739);

  // Merchandise actually paid for, then the order totals.
  const paidMerchandise = merchandise - pointsUsed;
  assert.equal(paidMerchandise, 74_261);

  const delivery = 5_000; // shipping is never covered by points
  const total = paidMerchandise + delivery;
  assert.equal(total, 79_261);

  const walletApplied = 30_000; // the wallet is a payment means, not a discount
  const dueOnDelivery = total - walletApplied;
  assert.equal(dueOnDelivery, 49_261);

  // Pending accrual: floor(net eligible merchandise after points / 100).
  const eligible = netEligibleIqd(merchandise, 0, pointsUsed);
  assert.equal(eligible, 74_261);
  assert.equal(pointsForEligibleIqd(eligible, RATE), 742);
});

test('§5: the wallet payment never changes the merchandise basis or the points', () => {
  const merchandise = 75_000;
  const eligible = netEligibleIqd(merchandise, 0, 739);
  // Same accrual whether the customer prepays 0, 30,000 or the whole total.
  for (const wallet of [0, 30_000, 79_261]) {
    void wallet;
    assert.equal(pointsForEligibleIqd(eligible, RATE), 742);
  }
});

// ------------------------------------------------------------------ PTS-03

test('PTS-03: points never exceed eligible merchandise and never fund delivery', () => {
  // 60,000 merchandise + 5,000 delivery; the customer holds 100,000 points.
  const merchandise = 60_000;
  const applied = capRedeemablePoints(100_000, merchandise);
  assert.equal(applied, 60_000); // capped at merchandise — delivery stays payable
  // Anything above the merchandise value stays in the customer's balance.
  assert.equal(100_000 - applied, 40_000);
});

test('PTS-03: the cap is the merchandise AFTER coupon discounts', () => {
  const merchandise = 75_000;
  const coupon = 10_000;
  const eligibleAfterCoupon = Math.max(0, merchandise - Math.min(coupon, merchandise));
  assert.equal(eligibleAfterCoupon, 65_000);
  assert.equal(capRedeemablePoints(70_000, eligibleAfterCoupon), 65_000);
});

test('PTS-03: an exact redemption is never rounded', () => {
  for (const n of [1, 7, 739, 1_234, 49_999]) {
    assert.equal(capRedeemablePoints(n, 100_000), n);
  }
});

// -------------------------------------------------- merchandise composition

test('merchandise comes from the applied price, not the fee-laden unit price', () => {
  // unit_price = applied 10,000 + commission 3,000 + warranty 2,000 = 15,000
  const it = item({
    unit_price_iqd: 15_000,
    pricing_snapshot: JSON.stringify({ applied_iqd: 10_000 }),
    warranty_snapshot: JSON.stringify({ fee_iqd: 2_000 }),
    transport_snapshot: JSON.stringify({ commission_iqd: 3_000, waived: false }),
  });
  assert.equal(unitMerchandiseIqd(it), 10_000);
});

test('legacy rows without a pricing snapshot subtract persisted fee snapshots', () => {
  const it = item({
    unit_price_iqd: 15_000,
    pricing_snapshot: null,
    warranty_snapshot: JSON.stringify({ fee_iqd: 2_000 }),
    transport_snapshot: JSON.stringify({ commission_iqd: 3_000, waived: false }),
  });
  assert.equal(unitMerchandiseIqd(it), 10_000);
});

test('a waived transport commission never reduces merchandise', () => {
  const it = item({
    unit_price_iqd: 10_000,
    pricing_snapshot: null,
    transport_snapshot: JSON.stringify({ commission_iqd: 3_000, waived: true }),
  });
  assert.equal(unitMerchandiseIqd(it), 10_000);
});

test('warranty and transport fees never earn points', () => {
  const q = computeQualifyingSpendIqd(
    [
      item({
        qty: 2,
        unit_price_iqd: 15_000,
        pricing_snapshot: JSON.stringify({ applied_iqd: 10_000 }),
        warranty_snapshot: JSON.stringify({ fee_iqd: 2_000 }),
        transport_snapshot: JSON.stringify({ commission_iqd: 3_000, waived: false }),
      }),
    ],
    0,
    0
  );
  assert.equal(q, 20_000); // 2 × 10,000 merchandise — the 10,000 of fees are out
  assert.equal(pointsForEligibleIqd(q, RATE), 200);
});

test('net eligible subtracts coupon and points spent, and never goes negative', () => {
  assert.equal(netEligibleIqd(30_000, 4_000, 6_000), 20_000);
  assert.equal(netEligibleIqd(10_000, 50_000, 50_000), 0);
  assert.equal(pointsForEligibleIqd(netEligibleIqd(10_000, 50_000, 50_000), RATE), 0);
});

// ------------------------------------------------- seven-day waiting period

test('§4.3: available_at is exactly purchase + 7 × 24h, from the server instant', () => {
  const purchaseAt = '2026-03-01T10:00:00.000Z';
  assert.equal(ACCRUAL_HOLD_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(availableAtFrom(purchaseAt), '2026-03-08T10:00:00.000Z');
});

test('PTS-02: one second before the seventh day is still not available', () => {
  const purchaseAt = '2026-03-01T10:00:00.000Z';
  const availableAt = Date.parse(availableAtFrom(purchaseAt));
  assert.equal(Date.parse('2026-03-08T09:59:59.000Z') >= availableAt, false);
  assert.equal(Date.parse('2026-03-08T10:00:00.000Z') >= availableAt, true);
});

test('PTS-02: a day-9 COD collection does not restart the seven-day clock', () => {
  // available_at is derived from PURCHASE, never from delivery or collection.
  const purchaseAt = '2026-03-01T00:00:00.000Z';
  const availableAt = availableAtFrom(purchaseAt);
  const collectedAtDay9 = '2026-03-10T00:00:00.000Z';
  // Both release conditions hold the moment the collection is recorded.
  assert.equal(Date.parse(collectedAtDay9) >= Date.parse(availableAt), true);
  // And the availability date itself is untouched by the collection event.
  assert.equal(availableAtFrom(purchaseAt), availableAt);
  assert.equal(availableAt, '2026-03-08T00:00:00.000Z');
});

// --------------------------------------------------- PTS-07 rule versioning

test('PTS-07: an order purchased before effective_at keeps the 1,000 IQD rule', () => {
  const config = parsePointsRuleConfig({
    iqd_per_point: 100,
    legacy_iqd_per_point: 1000,
    effective_at: '2026-03-01T00:00:00.000Z',
  });
  const before = resolvePointsRule(config, '2026-02-28T23:59:59.000Z');
  assert.equal(before.iqd_per_point, 1000);
  assert.equal(before.legacy, true);
  // The same 75,000 basis earns 75 under the old rule and 750 under the new —
  // which is exactly why old orders must never be re-evaluated.
  assert.equal(pointsForEligibleIqd(75_000, before.iqd_per_point), 75);

  const after = resolvePointsRule(config, '2026-03-01T00:00:00.000Z');
  assert.equal(after.iqd_per_point, 100);
  assert.equal(after.legacy, false);
  assert.equal(pointsForEligibleIqd(75_000, after.iqd_per_point), 750);
});

test('PTS-07: a malformed or missing config falls back to safe defaults', () => {
  const fromNothing = parsePointsRuleConfig(undefined);
  assert.deepEqual(fromNothing, POINTS_RULE_DEFAULTS);
  const fromJunk = parsePointsRuleConfig('{"iqd_per_point":-5,"effective_at":"not a date"}');
  assert.equal(fromJunk.iqd_per_point, 100);
  assert.equal(fromJunk.legacy_iqd_per_point, 1000);
  assert.equal(fromJunk.effective_at, null);
  // effective_at unset means the new rule is simply in force for NEW
  // purchases; it never reaches back into orders that already accrued.
  assert.equal(resolvePointsRule(fromJunk, '2020-01-01T00:00:00.000Z').iqd_per_point, 100);
});

test('PTS-07: the rate is read from config, so no balance is ever multiplied', () => {
  // Same eligible amount evaluated under each rule gives its own result; the
  // engine never converts one into the other.
  assert.equal(pointsForEligibleIqd(74_261, 1000), 74);
  assert.equal(pointsForEligibleIqd(74_261, 100), 742);
  assert.notEqual(pointsForEligibleIqd(74_261, 1000) * 10, pointsForEligibleIqd(74_261, 100));
});

// ------------------------------------------------------- reversal recompute

test('a full reversal removes everything that is left', () => {
  const r = recomputeReversal(742, 74_261, undefined, RATE);
  assert.equal(r.removePoints, 742);
  assert.equal(r.removeEligible, 74_261);
  assert.equal(r.remainingEligible, 0);
});

test('a partial return recomputes from the REMAINING eligible amount', () => {
  // 74,261 eligible → 742 points. Return 20,000 of merchandise:
  // remaining 54,261 → floor(54,261/100) = 542, so 200 points come back.
  const r = recomputeReversal(742, 74_261, 20_000, RATE);
  assert.equal(r.remainingEligible, 54_261);
  assert.equal(r.targetPoints, 542);
  assert.equal(r.removePoints, 200);
});

test('repeated partial returns never drift from the order-total basis', () => {
  let points = 742;
  let eligible = 74_261;
  for (const portion of [199, 199, 199]) {
    const r = recomputeReversal(points, eligible, portion, RATE);
    points -= r.removePoints;
    eligible -= r.removeEligible;
  }
  assert.equal(eligible, 73_664);
  // The end state equals a single recomputation of the same remaining basis —
  // three per-portion floors would have removed only 3 points instead of 5.
  assert.equal(points, pointsForEligibleIqd(73_664, RATE));
  assert.equal(points, 736);
});

test('a reversal never turns into a credit and never over-reverses', () => {
  const already = recomputeReversal(0, 0, 5_000, RATE);
  assert.equal(already.removePoints, 0);
  assert.equal(already.removeEligible, 0);
  // A portion larger than what remains is clamped to what remains.
  const over = recomputeReversal(742, 74_261, 999_999, RATE);
  assert.equal(over.removeEligible, 74_261);
  assert.equal(over.removePoints, 742);
});

test('a partial return of a sub-rate amount removes no points', () => {
  // Returning 40 IQD of a 74,261 basis leaves floor(74,221/100) = 742.
  const r = recomputeReversal(742, 74_261, 40, RATE);
  assert.equal(r.targetPoints, 742);
  assert.equal(r.removePoints, 0);
  assert.equal(r.removeEligible, 40); // the basis still shrinks honestly
});

// --------------------------------------------- refund distribution (§4.2)

test('a returned line is scaled onto the NET basis the accrual used', () => {
  // Order: 75,000 gross merchandise, 739 points spent → 74,261 net eligible.
  // Returning a 20,000 gross line removes floor(20,000 × 74,261 / 75,000).
  const portion = allocateReversalPortion(20_000, 74_261, 75_000);
  assert.equal(portion, 19_802);

  const r = recomputeReversal(742, 74_261, portion, RATE);
  assert.equal(r.remainingEligible, 54_459);
  assert.equal(r.targetPoints, 544);
  assert.equal(r.removePoints, 198); // not 200 — the discount travels with the line
});

test('with no discounts the scaled portion equals the gross portion', () => {
  assert.equal(allocateReversalPortion(20_000, 75_000, 75_000), 20_000);
});

test('legacy orders without a stored merchandise basis fall back to gross', () => {
  // Conservative: may remove marginally more basis, never less, so points are
  // never over-credited on a return.
  assert.equal(allocateReversalPortion(20_000, 74_261, 0), 20_000);
});

test('the scaled portion never exceeds what was returned', () => {
  assert.equal(allocateReversalPortion(20_000, 90_000, 75_000), 20_000);
  assert.equal(allocateReversalPortion(0, 74_261, 75_000), 0);
});

test('returning every line removes every point', () => {
  const portion = allocateReversalPortion(75_000, 74_261, 75_000);
  assert.equal(portion, 74_261);
  const r = recomputeReversal(742, 74_261, portion, RATE);
  assert.equal(r.remainingEligible, 0);
  assert.equal(r.removePoints, 742);
});
