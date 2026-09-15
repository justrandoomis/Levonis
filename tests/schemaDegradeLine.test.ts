/**
 * THE LINE BETWEEN "NOT INSTALLED" AND "NOT READ", tested at the price.
 *
 * `degradeIfSchemaMissing` answers "no rows" so the shop survives a feature
 * whose migration has not run. The verify pass found it answering "no rows"
 * for a table that EXISTS AND IS FULL — a populated `membership_benefit_rules`
 * read with one column missing — and the shop then sold at the wrong price
 * with HTTP 200 and no error anywhere. That is the exact failure the helper's
 * own docblock says it exists to prevent, arriving through the door built to
 * prevent it.
 *
 * The two facts are not the same fact:
 *
 *   no such TABLE   the feature is absent. It holds no rows, so "no rules",
 *                   "no offer", "no pool" is literally true and withholds
 *                   nothing. Degrade.
 *
 *   no such COLUMN  the table is there and may be full. Every row in it is
 *                   UNREAD, not absent. A deploy that lands before its
 *                   migration produces exactly this, and 0076 alone does
 *                   ADD COLUMN thirteen times. Never degrade.
 *
 * These tests pin both directions on the real helpers, because a test that
 * only proved "it degrades" would have passed on the defective version.
 * Run: npx tsx --test tests/schemaDegradeLine.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  degradeIfSchemaMissing,
  isMissingTable,
  isSchemaMissing,
  safeErrorCode,
} from '../worker/lib/membershipBenefits';

/** D1's own wording, which wraps SQLite's. */
const d1 = (inner: string) => new Error(`D1_ERROR: ${inner}: SQLITE_ERROR`);

test('a missing TABLE is a missing table; a missing COLUMN is not', () => {
  assert.equal(isMissingTable(d1('no such table: membership_benefit_rules')), true);
  assert.equal(isMissingTable(d1('no such column: r.notes')), false);
  assert.equal(isMissingTable(d1('database is locked')), false);
  assert.equal(isMissingTable(new Error('SQLITE_BUSY')), false);
  assert.equal(isMissingTable(null), false);
});

test('both shapes still read as "deployment ahead of its database" for the customer', () => {
  // The WIDER question keeps its wider answer: SERVICE_SETUP is the honest
  // name for either, and AsyncStates renders it as «جزء من المتجر قيد
  // التجهيز». Only DEGRADING is narrowed.
  assert.equal(isSchemaMissing(d1('no such table: offer_windows')), true);
  assert.equal(isSchemaMissing(d1('no such column: w.locked_preview')), true);
  assert.equal(safeErrorCode(d1('no such table: offer_windows')), 'SERVICE_SETUP');
  assert.equal(safeErrorCode(d1('no such column: w.locked_preview')), 'SERVICE_SETUP');
});

test('SQLite\u2019s OTHER sentence for a missing column is recognised too', () => {
  // A SELECT says `no such column: x`. An INSERT says `table T has no column
  // named C`. Matching only the first left every WRITE path unrecognised, so
  // the checkout answered a missing migration with "please try again".
  const insertSide = d1('table points_accruals has no column named base_points');
  assert.equal(isSchemaMissing(insertSide), true, 'it is a schema problem');
  assert.equal(isMissingTable(insertSide), false, 'but the TABLE is there, so its rows are unread');
  assert.equal(safeErrorCode(insertSide), 'SERVICE_SETUP');
});

test('the cause chain is walked, not only the top-level message', () => {
  const wrapped = new Error('query failed', { cause: d1('no such table: mystery_pools') });
  assert.equal(isMissingTable(wrapped), true);
  const wrappedCol = new Error('query failed', { cause: d1('no such column: p.active') });
  assert.equal(isMissingTable(wrappedCol), false);
});

test('a self-referencing cause chain terminates instead of hanging', () => {
  const a = new Error('a') as Error & { cause?: unknown };
  a.cause = a;
  assert.equal(isMissingTable(a), false);
  assert.equal(isSchemaMissing(a), false);
});

test('an absent feature degrades to its fallback', async () => {
  const answer = await degradeIfSchemaMissing(
    'offers (migration 0060)',
    () => Promise.reject(d1('no such table: offer_windows')),
    'FALLBACK'
  );
  assert.equal(answer, 'FALLBACK');
});

test('a populated table read with a missing column does NOT degrade — it throws', async () => {
  // THE DEFECT. A PRO with three live discount rules was told they had none
  // and charged the regular price, at HTTP 200, because one column of the
  // rules table was behind the deployment. Failing here is what turns that
  // into «جزء من المتجر قيد التجهيز» and gets the migration run.
  await assert.rejects(
    () =>
      degradeIfSchemaMissing(
        'benefit rules (migration 0074)',
        () => Promise.reject(d1('no such column: r.cap_scope')),
        'FALLBACK'
      ),
    /no such column/
  );
});

test('a lock is never absorbed, and never was', async () => {
  await assert.rejects(
    () => degradeIfSchemaMissing('offers', () => Promise.reject(d1('database is locked')), 'FALLBACK'),
    /locked/
  );
});

test('a successful read is returned untouched and the fallback is never consulted', async () => {
  assert.equal(await degradeIfSchemaMissing('x', () => Promise.resolve('REAL'), 'FALLBACK'), 'REAL');
});
