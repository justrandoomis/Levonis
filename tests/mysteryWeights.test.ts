/**
 * THE WHEEL ITSELF — docs/BUNDLES_MYSTERY.md §7.3.
 *
 * A weighted draw is a money mechanism: the weights decide who gets the
 * expensive filament, so "roughly weighted" is not a specification. Ten
 * thousand seeded draws over weights {1, 3, 6} must land within two points of
 * 10 / 30 / 60 %, a weight of 0 must never be drawn at all, and a given
 * (seed, salt) must reproduce its sequence exactly — otherwise no past draw
 * could ever be re-verified from `mystery_draw_audits`.
 *
 * Nothing here touches a database: `drawSpools` is pure and synchronous on
 * purpose, so all three of `priceLines`' passes can call it and agree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawSpools, type MysteryCandidate } from '../worker/lib/mysteryDraw';

const candidate = (id: string, weight: number, available: number | null = 1_000_000): MysteryCandidate => ({
  entry_id: id,
  product_id: `p_${id}`,
  option_value_ids: [],
  color_id: '',
  family_id: '',
  weight,
  available,
  targets: [],
  name_snapshot: id,
  image_snapshot: '',
  variant_snapshot: '',
});

const SEED = 'c0ffee'.repeat(10) + 'abcd'; // 64 hex chars, as seedFrom produces

/** One spool per line, ten thousand lines — the shape a real shop produces. */
function tally(candidates: MysteryCandidate[], n: number, seed = SEED): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const res = drawSpools({ seed, cartItemId: `ci_${i}`, spools: 1, candidates, duplicatePolicy: 'allow' });
    assert.equal(res.ok, true);
    if (!res.ok) return counts;
    const id = res.spools[0].candidate.entry_id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

test('10 000 seeded draws over weights {1, 3, 6} land within 2 points of 10 / 30 / 60 %', () => {
  const counts = tally([candidate('one', 1), candidate('three', 3), candidate('six', 6)], 10_000);
  const share = (id: string) => ((counts.get(id) ?? 0) / 10_000) * 100;
  for (const [id, expected] of [
    ['one', 10],
    ['three', 30],
    ['six', 60],
  ] as const) {
    const got = share(id);
    assert.ok(Math.abs(got - expected) <= 2, `${id}: ${got.toFixed(2)}% is not within 2 points of ${expected}%`);
  }
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 10_000, 'every draw produced exactly one pick');
});

test('a weight of 0 is never drawn — not once in ten thousand', () => {
  const counts = tally([candidate('never', 0), candidate('always', 5)], 10_000);
  assert.equal(counts.get('never'), undefined);
  assert.equal(counts.get('always'), 10_000);
});

test('a pool whose every weight is 0 is an honest sold-out, not a silent weight of one', () => {
  const res = drawSpools({
    seed: SEED,
    cartItemId: 'ci_1',
    spools: 1,
    candidates: [candidate('a', 0), candidate('b', 0)],
    duplicatePolicy: 'allow',
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.code, 'MYSTERY_NO_ELIGIBLE_STOCK');
});

test('(seed, salt) is reproducible: the same inputs replay the same sequence for ever', () => {
  const candidates = [candidate('a', 1), candidate('b', 1), candidate('c', 1), candidate('d', 3)];
  const first = drawSpools({ seed: SEED, cartItemId: 'ci_stable', spools: 8, candidates, duplicatePolicy: 'allow' });
  const again = drawSpools({ seed: SEED, cartItemId: 'ci_stable', spools: 8, candidates, duplicatePolicy: 'allow' });
  assert.equal(first.ok && again.ok, true);
  assert.deepEqual(
    first.ok && first.spools.map((s) => s.candidate.entry_id),
    again.ok && again.spools.map((s) => s.candidate.entry_id)
  );

  // A DIFFERENT cart line is a different sequence: two lines of one offer in one
  // cart must not be forced to the same filament.
  const other = drawSpools({ seed: SEED, cartItemId: 'ci_other', spools: 8, candidates, duplicatePolicy: 'allow' });
  assert.notDeepEqual(
    first.ok && first.spools.map((s) => s.candidate.entry_id),
    other.ok && other.spools.map((s) => s.candidate.entry_id)
  );

  // And a different SECRET (hence a different seed) is a different sequence, so
  // rotating an offer's secret really does change every future draw.
  const rotated = drawSpools({ seed: 'f'.repeat(64), cartItemId: 'ci_stable', spools: 8, candidates, duplicatePolicy: 'allow' });
  assert.notDeepEqual(
    first.ok && first.spools.map((s) => s.candidate.entry_id),
    rotated.ok && rotated.spools.map((s) => s.candidate.entry_id)
  );
});

test('a candidate at zero stock leaves the wheel, so the wheel never sells the same unit twice', () => {
  // Three units in total across two candidates, four spools asked for.
  const res = drawSpools({
    seed: SEED,
    cartItemId: 'ci_1',
    spools: 4,
    candidates: [candidate('a', 1, 2), candidate('b', 1, 1)],
    duplicatePolicy: 'allow',
  });
  assert.equal(res.ok, false, 'four spools cannot come out of three units');
  assert.equal(res.ok === false && res.code, 'MYSTERY_NO_ELIGIBLE_STOCK');

  const three = drawSpools({
    seed: SEED,
    cartItemId: 'ci_1',
    spools: 3,
    candidates: [candidate('a', 1, 2), candidate('b', 1, 1)],
    duplicatePolicy: 'allow',
  });
  assert.equal(three.ok, true);
  if (!three.ok) return;
  const drawn = three.spools.map((s) => s.candidate.entry_id);
  assert.equal(drawn.filter((x) => x === 'a').length, 2);
  assert.equal(drawn.filter((x) => x === 'b').length, 1);
});
