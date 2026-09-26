/**
 * THE PRINTER FINDER'S ANSWERS IN THE URL (catalog discovery S0).
 *
 * A refresh on any step keeps the answers, a skip is an answer, priorities are
 * ORDERED and at most two, and anything unknown is dropped.
 *
 * Run: node --import tsx --test tests/finderAnswers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINDER_BUDGET_IDS,
  FINDER_LEVELS,
  FINDER_SALES,
  FINDER_TECHS,
  FINDER_USES,
  emptyAnswers,
  finderBudgetRange,
  finderComplete,
  parseAnswers,
  serializeAnswers,
} from '../src/lib/finder/answers';

test('nothing answered serialises to the empty string', () => {
  assert.equal(serializeAnswers(emptyAnswers()), '');
  assert.deepEqual(parseAnswers(''), emptyAnswers());
  assert.equal(finderComplete(emptyAnswers()), false);
});

test('every value of every step round-trips', () => {
  const each: Array<[keyof ReturnType<typeof emptyAnswers>, readonly string[]]> = [
    ['use', FINDER_USES],
    ['tech', FINDER_TECHS],
    ['budget', FINDER_BUDGET_IDS],
    ['sale', FINDER_SALES],
    ['level', FINDER_LEVELS],
  ];
  for (const [key, values] of each) {
    for (const v of values) {
      const a = { ...emptyAnswers(), [key]: v };
      assert.deepEqual(parseAnswers(serializeAnswers(a)), a, `${key}=${v}`);
    }
  }
  for (const prio of [['speed'], ['speed', 'colors'], ['colors', 'speed'], []] as const) {
    const a = { ...emptyAnswers(), prio: [...prio] };
    assert.deepEqual(parseAnswers(serializeAnswers(a)), a, `prio=${prio.join(',') || 'none'}`);
  }
});

test('the six answers of the acceptance example make a complete, shareable link', () => {
  const a = parseAnswers('?use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate');
  assert.equal(finderComplete(a), true);
  assert.deepEqual(a.prio, ['speed', 'colors']);
  assert.equal(serializeAnswers(a), 'use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate');
  assert.deepEqual(finderBudgetRange(a.budget), { min: 1_250_000, max: 2_500_000 });
  assert.equal(finderBudgetRange('any'), null);
});

test('a skipped step is an answer: prio=none is [] and counts as answered', () => {
  const a = parseAnswers('use=hobby&tech=any&budget=any&sale=direct&prio=none&level=beginner');
  assert.deepEqual(a.prio, []);
  assert.equal(finderComplete(a), true);
  assert.match(serializeAnswers(a), /prio=none/);
});

test('priorities keep their ORDER, drop unknowns and duplicates, and stop at two', () => {
  assert.deepEqual(parseAnswers('prio=quiet,speed,colors').prio, ['quiet', 'speed']);
  assert.deepEqual(parseAnswers('prio=bogus,speed,speed,size').prio, ['speed', 'size']);
  assert.equal(parseAnswers('prio=bogus').prio, null, 'nothing valid is not an answer');
});

test('an unknown value is dropped, never guessed', () => {
  const a = parseAnswers('use=everything&tech=sla&budget=0-100&sale=later&level=expert');
  assert.deepEqual(a, emptyAnswers());
});
