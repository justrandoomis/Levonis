/**
 * LARGEST-REMAINDER ALLOCATION — docs/BUNDLES_MYSTERY.md §6.2.
 *
 * `component_alloc_iqd` is what a return refunds. It is computed once, at
 * checkout, and stored, so it must sum EXACTLY to the parent line total: a
 * proportional split re-derived later with floating point would refund a dinar
 * more or less than was charged, for ever, with no way to tell which figure was
 * the real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateComponentValue } from '../worker/lib/bundleComposition';

test('a split sums exactly to the line total and gives the largest remainders the spare dinars', () => {
  const shares = allocateComponentValue(145_000, [30_000, 90_000, 70_000]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 145_000);
  assert.ok(shares.every((s) => s >= 0));
  // Proportional, not equal: the 90,000 component takes the largest share.
  assert.ok(shares[1] > shares[2] && shares[2] > shares[0]);
});

test('every value zero splits uniformly rather than refusing', () => {
  // A free bundle must still be returnable, and there is no proportion to
  // honour — so the split is uniform and still exact.
  const shares = allocateComponentValue(10, [0, 0, 0, 0]);
  assert.deepEqual(shares, [3, 3, 2, 2]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 10);
});

test('a zero total allocates zero to everyone', () => {
  assert.deepEqual(allocateComponentValue(0, [100, 200]), [0, 0]);
});

test('one component takes the whole line', () => {
  assert.deepEqual(allocateComponentValue(145_000, [30_000]), [145_000]);
});

test('no components allocates nothing', () => {
  assert.deepEqual(allocateComponentValue(1000, []), []);
});

test('500 randomised compositions sum exactly, every share >= 0', () => {
  // Deterministic pseudo-random: a seeded walk, so a failure is reproducible
  // rather than "it failed once on CI".
  let seed = 987_654_321;
  const rnd = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  for (let run = 0; run < 500; run += 1) {
    const n = 1 + rnd(12);
    const values = Array.from({ length: n }, () => rnd(250_000));
    const total = rnd(2_000_000);
    const shares = allocateComponentValue(total, values);
    assert.equal(shares.length, n);
    assert.equal(
      shares.reduce((a, b) => a + b, 0),
      total,
      `run ${run}: total ${total} values ${values.join(',')}`
    );
    assert.ok(shares.every((s) => s >= 0 && Number.isInteger(s)), `run ${run}: a share was negative or fractional`);
  }
});

test('a component worth nothing beside components worth something is allocated nothing', () => {
  const shares = allocateComponentValue(1000, [0, 1000]);
  assert.deepEqual(shares, [0, 1000]);
});
