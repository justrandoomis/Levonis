import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SALES_TIERS, salesBadgeTier } from '../worker/lib/salesBadge';

/**
 * THE OWNER'S DECISION, PINNED.
 *
 * The brief's own example was «237 → 250+». That was raised with the owner
 * because a "+" badge is read as "at least this many", so rounding 237 UP to
 * 250 advertises 13 sales that did not happen. The owner chose to round DOWN,
 * never overstating, with a denser ladder so the figure stays close to real.
 * These assertions are the record of that choice — a future "fix" that rounds
 * to nearest has to delete a test that says why.
 */
test('the badge rounds DOWN to a tier the product has actually passed', () => {
  assert.equal(salesBadgeTier(237), 200, '237 must not advertise 250');
  assert.equal(salesBadgeTier(49), 25);
  assert.equal(salesBadgeTier(1_240), 1_000);
  assert.equal(salesBadgeTier(99), 50);
});

test('a count sitting exactly on a tier shows that tier', () => {
  for (const tier of SALES_TIERS) {
    assert.equal(salesBadgeTier(tier), tier, `${tier} should show ${tier}`);
  }
});

test('below the first tier there is no badge at all', () => {
  // A product with four sales shows nothing rather than "0+" — an empty shelf
  // should read as new, not as unwanted.
  for (const n of [0, 1, 4]) assert.equal(salesBadgeTier(n), null);
  assert.equal(salesBadgeTier(5), 5, 'the first tier is the first badge');
});

test('the tier is never above the real count', () => {
  // The property the whole rule exists to guarantee, checked across the range
  // rather than at hand-picked points.
  for (let n = 0; n <= 12_000; n += 7) {
    const tier = salesBadgeTier(n);
    if (tier === null) {
      assert.ok(n < SALES_TIERS[0], `no badge at ${n} but it is above the first tier`);
    } else {
      assert.ok(tier <= n, `badge ${tier} overstates a count of ${n}`);
    }
  }
});

test('the ladder is strictly ascending, so "largest tier passed" is well defined', () => {
  for (let i = 1; i < SALES_TIERS.length; i += 1) {
    assert.ok(SALES_TIERS[i] > SALES_TIERS[i - 1], `tier ${i} is not above its predecessor`);
  }
});

test('nonsense in, no badge out', () => {
  for (const bad of [null, undefined, NaN, Infinity, -5, 'many']) {
    assert.equal(salesBadgeTier(bad as never), null, `${String(bad)} should not produce a badge`);
  }
  // A fractional count floors before bucketing rather than throwing.
  assert.equal(salesBadgeTier(50.9), 50);
});
