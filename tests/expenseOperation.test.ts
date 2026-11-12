/**
 * ONE ENTRY, HOWEVER MANY PRESSES — POST /api/admin/finance/expenses with an `operation_id` (the owner's brief, 2026-11-12,
 * part 4: «prevent duplicate transactions»).
 *
 * The expense form keeps one operation for an unchanged entry, across a press whose answer never came. The route derives the
 * rows' ids from it, so the same entry sent twice — one after the other, or both at once — is recorded once, its journal
 * posted once and its audit row written once, and the second answer carries the first one's rows (`already: true`), even
 * after its month was closed in between. The same operation for another entry is refused and writes nothing. Without an
 * operation (an older screen) two presses are still two rows.
 *
 * Every figure is invented. Run: node --import tsx --test tests/expenseOperation.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, get, json, all, type StubUser } from './fixtures/app';
import { adminFinanceRoutes } from '../worker/routes/adminFinance';
import { seedCatalogue } from './lib/bundles';

const owner: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const OP = 'op-7d3c2b1a-0000-4000-8000-000000000001';

async function world() {
  const raw = seedCatalogue();
  const app = stubApp(asD1(raw), owner, (a) => a.route('/api/admin/finance', adminFinanceRoutes));
  const cats = await json(await get(app, '/api/admin/finance/expense-categories'));
  const rent = (cats.categories as Array<{ id: string; slug: string }>).find((x) => x.slug === 'rent')!.id;
  return { raw, app, rent };
}
const entry = (category: string, over: Record<string, unknown> = {}) => ({
  category_id: category,
  amount_iqd: 450_000,
  expense_day: '2026-10-31',
  title: 'إيجار المعرض',
  note: '',
  repeat_months: 1,
  ...over,
});
const rows = (raw: DatabaseSync) => all(raw, 'SELECT id, amount_iqd, expense_day FROM operating_expenses ORDER BY expense_day, id') as Array<{ id: string; amount_iqd: number; expense_day: string }>;
const journals = (raw: DatabaseSync) => all(raw, "SELECT id FROM accounting_entries WHERE event_key LIKE 'expense:%'").length;
const audits = (raw: DatabaseSync) => all(raw, "SELECT id FROM audit_log WHERE action = 'finance.expense.create'").length;

test('the same entry pressed twice is recorded once, and the second answer is the first one’s rows', async () => {
  const { raw, app, rent } = await world();
  const first = await json(await post(app, '/api/admin/finance/expenses', { ...entry(rent), operation_id: OP }));
  assert.equal(first.success, true, JSON.stringify(first));
  assert.deepEqual(first.ids, [`exp_op_${OP}_0`]);
  assert.equal(first.already, undefined, 'the first press writes');
  const again = await json(await post(app, '/api/admin/finance/expenses', { ...entry(rent), operation_id: OP }));
  assert.equal(again.success, true, JSON.stringify(again));
  assert.equal(again.already, true);
  assert.deepEqual([again.ids, again.series_id, again.days], [first.ids, first.series_id, first.days]);
  assert.deepEqual(rows(raw), [{ id: `exp_op_${OP}_0`, amount_iqd: 450_000, expense_day: '2026-10-31' }]);
  assert.equal(journals(raw), 1, 'the journal is posted once');
  assert.equal(audits(raw), 1, 'and the audit row written once');
});

test('a twelve-month entry: one series, written once, answered whole', async () => {
  const { raw, app, rent } = await world();
  const body = { ...entry(rent, { repeat_months: 12, expense_day: '2026-01-31' }), operation_id: OP };
  const first = await json(await post(app, '/api/admin/finance/expenses', body));
  assert.equal(first.ids.length, 12);
  assert.ok(first.series_id);
  const again = await json(await post(app, '/api/admin/finance/expenses', body));
  assert.equal(again.already, true);
  assert.deepEqual([again.ids, again.series_id, again.days], [first.ids, first.series_id, first.days], 'month 10 is not read before month 2');
  assert.equal(rows(raw).length, 12);
  assert.equal(journals(raw), 12);
});

/**
 * A request that read the operation's rows before the other one's batch landed: its own first read sees nothing (the
 * local database runs one batch at a time, so the race is staged — D1 itself serialises the two batches).
 */
function blindOnce(d1: D1Database): D1Database {
  let blind = true;
  return new Proxy(d1 as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === 'prepare') {
        return (sql: string) => {
          if (blind && sql.includes('FROM operating_expenses WHERE id IN')) {
            blind = false;
            return { bind: () => ({ all: async () => ({ results: [] }) }) };
          }
          return (value as (q: string) => unknown).call(target, sql);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

test('two presses that both passed the check: the second meets the first on the primary key and answers with its rows', async () => {
  const { raw, app, rent } = await world();
  const body = { ...entry(rent), operation_id: OP };
  const first = await json(await post(app, '/api/admin/finance/expenses', body));
  const late = stubApp(blindOnce(asD1(raw) as unknown as D1Database), owner, (a) => a.route('/api/admin/finance', adminFinanceRoutes));
  const second = await json(await post(late, '/api/admin/finance/expenses', body));
  assert.equal(second.success, true, JSON.stringify(second));
  assert.equal(second.already, true);
  assert.deepEqual(second.ids, first.ids);
  assert.equal(rows(raw).length, 1);
  assert.equal(journals(raw), 1);
  assert.equal(audits(raw), 1);
});

test('the same operation for a different entry is refused, and writes nothing', async () => {
  const { raw, app, rent } = await world();
  await post(app, '/api/admin/finance/expenses', { ...entry(rent), operation_id: OP });
  const cats = await json(await get(app, '/api/admin/finance/expense-categories'));
  const other = (cats.categories as Array<{ id: string; slug: string }>).find((x) => x.slug !== 'rent')!.id;
  for (const over of [{ amount_iqd: 460_000 }, { expense_day: '2026-10-30' }, { title: 'إيجار المخزن' }, { note: 'تشرين' }, { repeat_months: 3 }, { category_id: other }]) {
    const res = await post(app, '/api/admin/finance/expenses', { ...entry(rent, over), operation_id: OP });
    const body = await json(res);
    assert.equal(res.status, 409, JSON.stringify(over));
    assert.equal(body.code, 'EXPENSE_OPERATION_REUSED', JSON.stringify(over));
  }
  assert.deepEqual(rows(raw), [{ id: `exp_op_${OP}_0`, amount_iqd: 450_000, expense_day: '2026-10-31' }]);
  assert.equal(journals(raw), 1);
});

test('an entry saved before its month closed is still the answer to its second press; a new one in that month is refused', async () => {
  const { raw, app, rent } = await world();
  await post(app, '/api/admin/finance/expenses', { ...entry(rent), operation_id: OP });
  raw.prepare("INSERT INTO accounting_periods(month, closed_at, closed_by) VALUES ('2026-10', '2026-11-01T09:00:00.000Z', 'boss')").run();
  const again = await json(await post(app, '/api/admin/finance/expenses', { ...entry(rent), operation_id: OP }));
  assert.equal(again.already, true, JSON.stringify(again));
  const fresh = await post(app, '/api/admin/finance/expenses', { ...entry(rent), operation_id: `${OP}-b` });
  assert.equal(fresh.status, 409);
  assert.equal((await json(fresh)).code, 'PERIOD_CLOSED');
  assert.equal(rows(raw).length, 1);
});

test('without an operation (an older screen) two presses are still two rows', async () => {
  const { raw, app, rent } = await world();
  await post(app, '/api/admin/finance/expenses', entry(rent));
  await post(app, '/api/admin/finance/expenses', entry(rent));
  assert.equal(rows(raw).length, 2);
  assert.ok(rows(raw).every((r) => !r.id.startsWith('exp_op_')));
});

test('an operation that is not plain letters and digits is refused before anything is read', async () => {
  const { raw, app, rent } = await world();
  for (const bad of ['short', "op'; DROP TABLE x --", 'op with spaces 12', 'x'.repeat(65), 42]) {
    const res = await post(app, '/api/admin/finance/expenses', { ...entry(rent), operation_id: bad });
    assert.equal(res.status, 400, String(bad));
  }
  assert.equal(rows(raw).length, 0);
});
