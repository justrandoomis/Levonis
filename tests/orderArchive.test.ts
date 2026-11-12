/**
 * THE COMPLETED ORDERS' ORDER, AS PURE FUNCTIONS (DECISIONS row 323) —
 * worker/lib/orderArchive.ts: the archive's ORDER BY for each half and each
 * direction (refusing anything outside the two closed sets), where a row with
 * no completion time lands, and the label of the day each order was finished.
 * The route that uses them is tests/orderArchiveRoute.test.ts.
 *
 * Run: node --import tsx --test tests/orderArchive.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ARCHIVE_DONE_COLUMN,
  ARCHIVE_SORTS,
  DEFAULT_ARCHIVE_SORT,
  archiveOrderSql,
  doneAtOf,
  doneDayOf,
  doneLabelOf,
  isArchiveScope,
} from '../worker/lib/orderArchive';

test('the ORDER BY: one completion column per half, the id as the tie-break, both in the chosen direction', () => {
  assert.deepEqual([...ARCHIVE_SORTS], ['newest', 'oldest']);
  assert.equal(DEFAULT_ARCHIVE_SORT, 'newest', 'the archive opens on the order finished last');
  assert.deepEqual({ ...ARCHIVE_DONE_COLUMN }, { delivered: 'delivered_at', cancelled: 'cancelled_at' });
  assert.equal(archiveOrderSql('delivered', 'newest'), 'ORDER BY o.delivered_at DESC, o.id DESC');
  assert.equal(archiveOrderSql('delivered', 'oldest'), 'ORDER BY o.delivered_at ASC, o.id ASC');
  assert.equal(archiveOrderSql('cancelled', 'newest'), 'ORDER BY o.cancelled_at DESC, o.id DESC');
  assert.equal(archiveOrderSql('cancelled', 'oldest'), 'ORDER BY o.cancelled_at ASC, o.id ASC');
});

test('only the two closed sets reach SQL text: any other scope or sort throws', () => {
  assert.equal(isArchiveScope('delivered'), true);
  assert.equal(isArchiveScope('cancelled'), true);
  for (const scope of ['open', 'preorder', 'all', 'prepare', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'delivered; DROP TABLE orders', 'DELIVERED', null, 7]) {
    assert.equal(isArchiveScope(scope), false, String(scope));
    assert.throws(() => archiveOrderSql(scope as never, 'newest'), /not an archive scope/, String(scope));
  }
  for (const sort of ['sideways', 'NEWEST', '', 'constructor', 'valueOf', '__proto__', 'newest DESC', undefined]) {
    assert.throws(() => archiveOrderSql('delivered', sort as never), /not an archive sort/, String(sort));
  }
});

test('in SQLite: newest first by the half’s own clock, ties by id; no time sorts as the oldest; oldest first is the exact reverse', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT, delivered_at TEXT, cancelled_at TEXT)');
  const ins = db.prepare('INSERT INTO orders VALUES (?,?,?,?)');
  // Inserted out of order, so neither the rowid nor the id can pass for the clock.
  ins.run('o-5', 'delivered', '2026-11-05T09:00:00.000Z', null);
  ins.run('o-1', 'delivered', null, null);
  ins.run('o-9', 'delivered', '2026-11-11T07:00:00.000Z', null);
  ins.run('o-3', 'delivered', '', null);
  ins.run('o-7', 'delivered', '2026-11-05T09:00:00.000Z', null);
  ins.run('o-2', 'delivered', '2025-11-10T09:00:00.000Z', null);
  // A cancelled order with a delivery time from an earlier life: the half reads its own clock only.
  ins.run('c-1', 'cancelled', '2026-12-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
  ins.run('c-2', 'cancelled', null, '2026-11-02T00:00:00.000Z');
  const run = (scope: 'delivered' | 'cancelled', sort: 'newest' | 'oldest') =>
    (db.prepare(`SELECT o.id FROM orders o WHERE o.status = ? ${archiveOrderSql(scope, sort)}`).all(scope) as Array<{ id: string }>).map((r) => r.id);
  const newest = run('delivered', 'newest');
  assert.deepEqual(newest, ['o-9', 'o-7', 'o-5', 'o-2', 'o-3', 'o-1'], "the same instant breaks by id; '' then NULL come last");
  assert.deepEqual(run('delivered', 'oldest'), [...newest].reverse(), 'NULL then \'\' come first; the exact reverse');
  assert.deepEqual(run('cancelled', 'newest'), ['c-2', 'c-1']);
  assert.deepEqual(run('cancelled', 'oldest'), ['c-1', 'c-2']);
  db.close();
});

test('when it was finished: `delivered_at` for a delivered order, `cancelled_at` for a cancelled one, nothing for a live one', () => {
  const both = { delivered_at: '2026-11-10T10:00:00.000Z', cancelled_at: '2026-11-09T10:00:00.000Z' };
  assert.equal(doneAtOf({ status: 'delivered', ...both }), both.delivered_at);
  assert.equal(doneAtOf({ status: 'cancelled', ...both }), both.cancelled_at);
  for (const status of ['pending', 'confirmed', 'processing', 'shipped', '', undefined]) assert.equal(doneAtOf({ status, ...both }), '', String(status));
  assert.equal(doneAtOf({ status: 'delivered', delivered_at: null }), '');
  assert.equal(doneAtOf({ status: 'delivered', delivered_at: '' }), '');
  assert.equal(doneAtOf({ status: 'delivered', delivered_at: 1_700_000_000 }), '', 'not a stored time');
  assert.equal(doneAtOf({ status: 'cancelled' }), '');
});

test('the Baghdad day it was finished on: 20:59Z and 21:00Z are two days, never `slice(0, 10)`', () => {
  assert.equal(doneDayOf({ status: 'delivered', delivered_at: '2026-11-10T20:59:59.999Z' }), '2026-11-10');
  assert.equal(doneDayOf({ status: 'delivered', delivered_at: '2026-11-10T21:00:00.000Z' }), '2026-11-11');
  assert.equal(doneDayOf({ status: 'cancelled', cancelled_at: '2025-12-31T21:30:00.000Z' }), '2026-01-01', 'a new year in Baghdad');
  assert.equal(doneDayOf({ status: 'delivered', delivered_at: 'not a time' }), '');
  assert.equal(doneDayOf({ status: 'shipped', delivered_at: '2026-11-10T10:00:00.000Z' }), '');
});

test('the label: «اليوم», a weekday and date, and the year only when it is not this year — in each language’s own digits', () => {
  const today = '2026-11-11';
  const at = (iso: string, status: 'delivered' | 'cancelled' = 'delivered') =>
    status === 'delivered' ? { status, delivered_at: iso } : { status, cancelled_at: iso };
  const cases: Array<[ReturnType<typeof at>, string, string, string]> = [
    // 01:30 on the 11th in Baghdad — today, though the UTC date is the 10th.
    [at('2026-11-10T22:30:00.000Z'), 'اليوم', 'Today', 'ئەمڕۆ'],
    // 23:59 on the 10th in Baghdad.
    [at('2026-11-10T20:59:00.000Z'), 'الثلاثاء ١٠ تشرين الثاني', 'Tuesday 10 November', 'سێشەممە ١٠ تشرینی دووەم'],
    [at('2026-11-09T08:00:00.000Z', 'cancelled'), 'الاثنين ٩ تشرين الثاني', 'Monday 9 November', 'دووشەممە ٩ تشرینی دووەم'],
    [at('2025-11-10T09:00:00.000Z'), 'الاثنين ١٠ تشرين الثاني ٢٠٢٥', 'Monday 10 November 2025', 'دووشەممە ١٠ تشرینی دووەم ٢٠٢٥'],
  ];
  for (const [row, ar, en, ckb] of cases) {
    assert.equal(doneLabelOf(row, today, 'ar'), ar);
    assert.equal(doneLabelOf(row, today, 'en'), en);
    assert.equal(doneLabelOf(row, today, 'ckb'), ckb);
    assert.doesNotMatch(doneLabelOf(row, today, 'ar') + doneLabelOf(row, today, 'ckb'), /[0-9]/, 'Arabic-Indic digits in ar and ckb, as dayLabel writes them');
    assert.doesNotMatch(doneLabelOf(row, today, 'en'), /[٠-٩]/);
  }
  // Across New Year: 21:30Z on 31 December is 1 January in Baghdad — this year, no year added.
  assert.equal(doneLabelOf(at('2025-12-31T21:30:00.000Z'), '2026-01-03', 'en'), 'Thursday 1 January');
  assert.equal(doneLabelOf(at('2025-12-31T20:30:00.000Z'), '2026-01-03', 'en'), 'Wednesday 31 December 2025');
  // A live order, an unknown time or an unknown status has no day to name.
  assert.equal(doneLabelOf({ status: 'shipped', delivered_at: '2026-11-10T10:00:00.000Z' }, today, 'ar'), '');
  assert.equal(doneLabelOf({ status: 'delivered', delivered_at: '' }, today, 'ar'), '');
  assert.equal(doneLabelOf({ status: 'delivered', delivered_at: null }, today, 'en'), '');
  assert.equal(doneLabelOf({ status: 'cancelled', cancelled_at: 'garbage' }, today, 'ckb'), '');
  // Any other language reads Arabic, as dayLabel does.
  assert.equal(doneLabelOf(at('2026-11-10T20:59:00.000Z'), today, 'fr'), 'الثلاثاء ١٠ تشرين الثاني');
});
