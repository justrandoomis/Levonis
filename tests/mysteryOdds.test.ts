/**
 * A PUBLISHED PROBABILITY IS THE PROBABILITY THE SERVER WILL HONOUR
 * (owner decision 8).
 *
 * The owner's rule, in their words: *"Odds shown to customers must be derived
 * from the actual configured pool/weights, never entered separately as
 * marketing copy"* and *"never advertise a 'rare' outcome without accurate
 * server-derived probability information."*
 *
 * Two things make that true, and both are tested here rather than assumed:
 *
 *   1. THERE IS NO OTHER SOURCE. No column, no admin field and no string
 *      anywhere holds a probability — `bundle_config.show_odds` is a boolean
 *      and `mystery_pool_entries.weight` is an integer. The last test asserts
 *      that, so a future "odds_text" field cannot be added quietly.
 *
 *   2. THE NUMBER MATCHES THE WHEEL. `familyOdds` and `drawSpools` now share
 *      one predicate (`isDrawable`), so the disclosure is computed over
 *      exactly the candidates the draw can land on. The empirical test below
 *      tallies ten thousand real draws and compares them with the published
 *      percentages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { familyOdds } from '../worker/lib/mysteryLine';
import { drawSpools, isDrawable, type MysteryCandidate } from '../worker/lib/mysteryDraw';
import { ROOT } from './fixtures/d1';

const candidate = (over: Partial<MysteryCandidate> & { entry_id: string }): MysteryCandidate => ({
  product_id: `p_${over.entry_id}`,
  option_value_ids: [],
  color_id: '',
  family_id: 'fam',
  weight: 1,
  available: null,
  targets: [],
  name_snapshot: over.entry_id,
  variant_snapshot: '',
  image_snapshot: '',
  ...over,
} as MysteryCandidate);

/** 64 hex characters, exactly what `seedFrom` produces. */
const SEED = 'c0ffee'.repeat(10) + 'abcd';

/** The wheel, run many times, tallied by family. */
function tallyByFamily(candidates: MysteryCandidate[], runs: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < runs; i += 1) {
    const res = drawSpools({ seed: SEED, cartItemId: `ci_${i}`, spools: 1, candidates, duplicatePolicy: 'allow' });
    if (!res.ok) continue;
    for (const s of res.spools) {
      out.set(s.candidate.family_id, (out.get(s.candidate.family_id) ?? 0) + 1);
    }
  }
  return out;
}

test('the published percentages are the percentages the wheel produces', () => {
  const candidates = [
    candidate({ entry_id: 'a1', family_id: 'fam_pla', weight: 3 }),
    candidate({ entry_id: 'a2', family_id: 'fam_pla', weight: 1 }),
    candidate({ entry_id: 'b1', family_id: 'fam_petg', weight: 4 }),
  ];
  const published = familyOdds(candidates);
  assert.deepEqual(
    published.map((o) => o.family_id).sort(),
    ['fam_petg', 'fam_pla'],
    'both families are disclosed'
  );
  assert.equal(published.reduce((n, o) => n + o.percent, 0), 100, 'the disclosure sums to 100%');

  const RUNS = 10_000;
  const tally = tallyByFamily(candidates, RUNS);
  for (const o of published) {
    const empirical = ((tally.get(o.family_id) ?? 0) / RUNS) * 100;
    assert.ok(
      Math.abs(empirical - o.percent) <= 2,
      `${o.family_id}: published ${o.percent}% but the wheel produced ${empirical.toFixed(1)}%`
    );
  }
});

test('a candidate the wheel can never land on is not advertised', () => {
  // A tracked entry at zero stock: `drawSpools` seeds its slot with remaining 0
  // and drops it before the first pick. Publishing it at 50% would advertise an
  // outcome the server cannot pay out.
  const candidates = [
    candidate({ entry_id: 'gone', family_id: 'fam_rare', weight: 1, available: 0 }),
    candidate({ entry_id: 'here', family_id: 'fam_common', weight: 1, available: 5 }),
  ];
  assert.equal(isDrawable(candidates[0]), false);
  assert.deepEqual(familyOdds(candidates), [{ family_id: 'fam_common', percent: 100 }]);
});

test('a weight-0 entry is kept for history and disclosed at nothing', () => {
  const candidates = [
    candidate({ entry_id: 'retired', family_id: 'fam_old', weight: 0, available: 9 }),
    candidate({ entry_id: 'live', family_id: 'fam_now', weight: 2, available: 9 }),
  ];
  assert.deepEqual(familyOdds(candidates), [{ family_id: 'fam_now', percent: 100 }]);
});

test('an empty or undrawable pool discloses nothing rather than guessing', () => {
  assert.deepEqual(familyOdds([]), []);
  assert.deepEqual(familyOdds([candidate({ entry_id: 'x', weight: 0 })]), []);
});

// ------------------------------------------------- there is no other source

test('no probability can be typed in: the schema holds a boolean and an integer, nothing else', () => {
  const sql = readdirSync(new URL('../migrations/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
    .join('\n');

  assert.match(sql, /show_odds\s+INTEGER/, 'show_odds is a flag, not a number a human types');
  assert.match(sql, /weight\s+INTEGER NOT NULL DEFAULT 1 CHECK \(weight >= 0\)/, 'the only odds input is the weight');

  // A column whose NAME offers somewhere to write a probability. If one is ever
  // added, this test fails and the owner's rule has to be re-argued.
  const suspicious = /\b(odds|probability|chance|rarity)_?(text|label|note|copy|percent|display)?\s+TEXT/i;
  assert.ok(!suspicious.test(sql), 'a free-text odds/rarity column exists — customer-facing odds must be derived');
});

test('the odds a customer sees and the odds an admin previews come from one predicate', () => {
  const line = readFileSync(new URL('../worker/lib/mysteryLine.ts', import.meta.url), 'utf8');
  const pools = readFileSync(new URL('../worker/lib/mystery/pools.ts', import.meta.url), 'utf8');
  const draw = readFileSync(new URL('../worker/lib/mysteryDraw.ts', import.meta.url), 'utf8');
  for (const [name, src] of [['mysteryLine', line], ['pools', pools], ['mysteryDraw', draw]] as const) {
    assert.match(src, /isDrawable/, `${name} does not use the shared drawable predicate`);
  }
  assert.ok(
    !/Math\.max\(1, c\.weight\)/.test(pools),
    'the admin preview floors a weight the wheel does not — the two would disagree'
  );
  assert.ok(ROOT.length > 0);
});
