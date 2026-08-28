/**
 * Unit tests for the purchase-points math (worker/lib/pointsOps.ts) —
 * decision register row 20 defaults: floor(qualifying / 1000), qualifying =
 * merchandise net of discounts and the points-funded portion, EXCLUDING
 * shipping, transport commissions and warranty fees.
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unitMerchandiseIqd,
  computeQualifyingSpendIqd,
  pointsForQualifyingSpend,
  type PointsItemFacts,
} from '../worker/lib/pointsOps';

const item = (over: Partial<PointsItemFacts> = {}): PointsItemFacts => ({
  qty: 1,
  unit_price_iqd: 10_000,
  pricing_snapshot: JSON.stringify({ applied_iqd: 10_000 }),
  warranty_snapshot: null,
  transport_snapshot: null,
  ...over,
});

test('999 / 1000 / 1999 IQD earn 0 / 1 / 1 points (floor, no carry)', () => {
  assert.equal(pointsForQualifyingSpend(999), 0);
  assert.equal(pointsForQualifyingSpend(1000), 1);
  assert.equal(pointsForQualifyingSpend(1999), 1);
  assert.equal(pointsForQualifyingSpend(2000), 2);
  assert.equal(pointsForQualifyingSpend(0), 0);
  assert.equal(pointsForQualifyingSpend(-500), 0);
});

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

test('qualifying spend nets coupon and points-funded portions', () => {
  // merchandise 3 × 10,000 = 30,000; coupon 4,000; points-funded 6,000
  const q = computeQualifyingSpendIqd([item({ qty: 3 })], 4_000, 6_000);
  assert.equal(q, 20_000);
  assert.equal(pointsForQualifyingSpend(q), 20);
});

test('qualifying spend never goes negative', () => {
  const q = computeQualifyingSpendIqd([item()], 50_000, 50_000);
  assert.equal(q, 0);
});

test('shipping never earns points (it is simply not part of merchandise)', () => {
  // One 74,000 IQD item + 5,000 shipping paid: only the merchandise counts.
  const q = computeQualifyingSpendIqd(
    [item({ unit_price_iqd: 74_000, pricing_snapshot: JSON.stringify({ applied_iqd: 74_000 }) })],
    0,
    0
  );
  assert.equal(pointsForQualifyingSpend(q), 74);
});
