/**
 * «ما دفعه فعلاً» — ONE RULE FOR WHAT A UNIT COST ITS BUYER (Services V2 plan
 * §3.2; packages/pricing/src/paidNet.ts). Price protection and trade-in read
 * the same figure, so the same unit is never worth one amount to one service
 * and another to the next.
 *
 * Pure: the worked cases, then the properties over random orders —
 *   Σ lines + what stays on the order (the delivery's share) = the total,
 *   each discount is subtracted exactly once,
 *   never more than was paid, a trade-in credit counts as paid,
 *   qty × the unit figure ≤ the line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidNetLines, paidNetPerUnit, splitExact, type PaidNetLineFacts, type PaidNetOrderFacts } from '../packages/pricing/src/paidNet';

const line = (id: string, unit: number, qty = 1, extra: Partial<PaidNetLineFacts> = {}): PaidNetLineFacts => ({
  id,
  qty,
  gross_iqd: unit * qty,
  merchandise_iqd: unit * qty,
  membership_iqd: 0,
  line_discount_iqd: 0,
  price_adjustment_iqd: 0,
  ...extra,
});
const order = (lines: PaidNetLineFacts[], o: Partial<PaidNetOrderFacts> = {}): PaidNetOrderFacts => {
  const subtotal = lines.reduce((s, l) => s + l.gross_iqd, 0);
  const shipping = o.shipping_iqd ?? 0;
  const coupon = o.order_coupon_iqd ?? 0;
  const points = o.points_iqd ?? 0;
  return {
    subtotal_iqd: subtotal,
    shipping_iqd: shipping,
    total_iqd: subtotal + shipping - coupon - points,
    order_coupon_iqd: coupon,
    points_iqd: points,
    ...o,
  };
};

test('a coupon on the ORDER comes off the unit (V2): 850,000 − 150,000 = 700,000', () => {
  const lines = [line('a1', 850_000)];
  assert.equal(paidNetPerUnit(order(lines, { order_coupon_iqd: 150_000 }), lines, 'a1'), 700_000);
});

test('the coupon and the points are shared by gross over goods + delivery; delivery keeps its own share', () => {
  const lines = [line('printer', 900_000), line('spool', 20_000, 5)];
  const o = order(lines, { shipping_iqd: 80_000, order_coupon_iqd: 50_000, points_iqd: 10_000 });
  // shared 60,000 over 1,080,000: printer 900k → 50,000; spools 100k → 5,555
  assert.deepEqual(paidNetLines(o, lines), [850_000, 94_445]);
  assert.equal(paidNetPerUnit(o, lines, 'spool'), 18_889);
});

test('a line’s own discount is subtracted once: the order coupon that includes it leaves only its residual to share', () => {
  // A targeted code wrote 6,000 on the spool line; the order coupon records the whole 6,000.
  const lines = [line('printer', 900_000), line('spool', 30_000, 2, { line_discount_iqd: 6_000 })];
  const o = order(lines, { order_coupon_iqd: 6_000 });
  assert.deepEqual(paidNetLines(o, lines), [900_000, 54_000]);
});

test('membership, the warranty fee and an accepted price adjustment', () => {
  const lines = [line('p', 1_100_000, 2, { merchandise_iqd: 2_100_000, membership_iqd: 20_000, line_discount_iqd: 10_000, price_adjustment_iqd: -30_000 })];
  // (2,100,000 − 20,000 − 10,000 − 30,000) / 2
  assert.equal(paidNetPerUnit(order(lines, { total_iqd: 2_200_000 }), lines, 'p'), 1_020_000);
});

test('a trade-in credit is payment, not a discount: the unit keeps its full price (owner decision 5)', () => {
  const lines = [line('p1s', 1_500_000)];
  const paidWithCredit = { ...order(lines), total_iqd: 955_000, order_coupon_iqd: 0, paid_in_kind_iqd: 545_000 };
  assert.equal(paidNetPerUnit(paidWithCredit, lines, 'p1s'), 1_500_000);
  // Read as a coupon instead, it would have come off.
  assert.equal(paidNetPerUnit(order(lines, { order_coupon_iqd: 545_000 }), lines, 'p1s'), 955_000);
});

test('never more than was paid: lines that add up past the total are spread over it exactly', () => {
  const lines = [line('a', 60_000), line('b', 40_000)];
  const o = { ...order(lines), total_iqd: 90_000 };
  const paid = paidNetLines(o, lines);
  assert.deepEqual(paid, [54_000, 36_000]);
  assert.equal(paid.reduce((s, v) => s + v, 0), 90_000);
});

test('a line that is not in the order has no figure', () => {
  const lines = [line('a', 1_000)];
  assert.equal(paidNetPerUnit(order(lines), lines, 'zzz'), null);
});

test('splitExact: integers that add up exactly, the remainder to the largest fractions, ties to the earlier', () => {
  assert.deepEqual(splitExact(10, [1, 1, 1]), [4, 3, 3]);
  assert.deepEqual(splitExact(100, [0, 0]), [50, 50]);
  assert.deepEqual(splitExact(7, []), []);
});

/** Mulberry32 — a seeded stream, so a failure replays. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: every discount comes off once; what the lines do not carry is the delivery fee’s share; never above what was paid', () => {
  const r = rng(20261014);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  for (let i = 0; i < 2_000; i++) {
    const lines: PaidNetLineFacts[] = [];
    const n = int(1, 5);
    for (let k = 0; k < n; k++) {
      const unit = int(1, 2_000) * 500;
      const qty = int(1, 4);
      const own = r() < 0.3 ? int(0, Math.floor((unit * qty) / 10)) : 0;
      lines.push(line(`l${k}`, unit, qty, { line_discount_iqd: own }));
    }
    const subtotal = lines.reduce((s, l) => s + l.gross_iqd, 0);
    const ownTotal = lines.reduce((s, l) => s + l.line_discount_iqd, 0);
    const shipping = r() < 0.5 ? int(0, 20) * 500 : 0;
    const residual = int(0, Math.floor(subtotal / 5));
    const coupon = ownTotal + residual; // the order records every line's own discount plus the shared part
    const points = r() < 0.4 ? int(0, Math.max(0, subtotal + shipping - coupon) >> 2) : 0;
    const o = order(lines, { shipping_iqd: shipping, order_coupon_iqd: coupon, points_iqd: points });
    const paid = paidNetLines(o, lines);
    const shared = residual + points;
    // Each line loses exactly its own discount and its floor share of the residual and the points…
    const expected = lines.map((l) => l.gross_iqd - l.line_discount_iqd - Math.floor((shared * l.gross_iqd) / (subtotal + shipping)));
    const expectedSum = expected.reduce((s, v) => s + v, 0);
    if (expectedSum <= o.total_iqd) assert.deepEqual(paid, expected, `case ${i}`);
    // …unless the floors left more on the lines than the order charged (no delivery fee to hold the
    // odd dinars): then the total is spread over them exactly — never more than was paid.
    else assert.equal(paid.reduce((s, v) => s + v, 0), o.total_iqd, `case ${i}: capped`);
    // What the lines do not carry stays on the order: the delivery fee's own share, never negative, never more than the fee.
    const onOrder = o.total_iqd - paid.reduce((s, v) => s + v, 0);
    assert.ok(onOrder >= 0 && onOrder <= shipping, `case ${i}: ${onOrder} left on an order with delivery ${shipping}`);
    for (const [k, l] of lines.entries()) {
      const unit = paidNetPerUnit(o, lines, l.id)!;
      assert.ok(unit * l.qty <= paid[k] && paid[k] - unit * l.qty < l.qty, `case ${i}: unit ${unit} × ${l.qty} vs ${paid[k]}`);
      assert.ok(unit >= 0);
    }
  }
});
