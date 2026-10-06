import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, count, dbThrough, failingD1, freshDb, json, patch, post, row, stubApp } from './fixtures/app';
import { drainOrderFinanceRecovery } from '../worker/lib/financeOrderRecovery';
import { continueStaffReconciliation } from '../worker/lib/financeStaffAccrual';
import { participantOverview } from '../worker/lib/financeParticipants';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { baghdadDay, journalPlan } from '../worker/lib/operations';
import { recordFinancialFailure, runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { getSettings, PUBLIC_SETTING_KEYS } from '../worker/lib/settings';
import type { Env } from '../worker/lib/types';

const CHECKPOINT = '__finance_order_recovery_v1';

async function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),('hussein','hussein@x.co','Hussein','admin','assistant'),
    ('sajjad','sajjad@x.co','Sajjad','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
    UPDATE finance_staff SET user_id='hussein',start_work_date='2026-09-01' WHERE id='staff_hussein';
    UPDATE finance_staff SET user_id='sajjad',start_work_date='2026-09-01' WHERE id='staff_sajjad';
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('p','Filament','automatic-wage-filament',50000,90000);`);
  const { db, failing } = failingD1(raw), env = { DB: db } as Env;
  const boss = stubApp(db, { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, app => {
    app.route('/operations', adminFinanceOperationsRoutes);
    app.route('/people', adminFinancePeopleRoutes);
  });
  for (const [staff_id, amount] of [['staff_hussein', 200], ['staff_sajjad', 1000]] as const) {
    const response = await post(boss, '/operations/rules', { staff_id, basis: 'profit_percent', amount, milestone: 'delivered' });
    assert.equal(response.status, 200, JSON.stringify(await json(response)));
  }
  function order(id: string, basis = 'unrecorded', status = 'delivered') {
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
      subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
      VALUES (?,'buyer',?,'{}','standard','{}','cash',100000,1500,100000,100000,'2026-09-30T10:00:00Z','2026-10-03T10:00:00Z')`).run(id, status);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES (?,?,'p','Filament',2,50000,100000,20000,?)`).run(`line:${id}`, id, basis);
  }
  async function finishStaffJobs() {
    for (const staff of ['staff_hussein', 'staff_sajjad']) {
      for (let i = 0; i < 10; i++) {
        const result = await continueStaffReconciliation(env, staff);
        assert.notEqual(result?.state, 'failed', JSON.stringify(result));
        if (result?.state === 'complete') break;
      }
      assert.equal(row(raw, 'SELECT state FROM finance_staff_reconciliations WHERE staff_id=?', staff)?.state, 'complete');
    }
  }
  async function historicalPosting(id: string) {
    await db.batch(journalPlan(db, { key: `sale:${id}`, day: '2026-10-03', title: 'Historical sale', source: 'order', sourceId: id },
      [{ account: '1100', debit: 100000 }, { account: '4000', credit: 100000 }]).statements);
    await recordFinancialFailure(db, id, 'cogs', new Error('Old FIFO-only cost classification'));
  }
  const costs = (id: string) => all<{ id: string; staff_id: string; amount_iqd: number | null; state: string }>(raw,
    'SELECT id,staff_id,amount_iqd,state FROM finance_order_costs WHERE order_id=? ORDER BY staff_id', id);
  return { raw, db, failing, env, boss, order, finishStaffJobs, historicalPosting, costs };
}

test('automatic recovery materializes 2% and 10% after completed staff jobs, posts missing COGS and replays once', async () => {
  const x = await setup(); x.order('known'); await x.finishStaffJobs();
  assert.deepEqual(x.costs('known').map(c => [c.amount_iqd, c.state]), [[null, 'pending_cost'], [null, 'pending_cost']]);
  const staff = all(x.raw, 'SELECT * FROM finance_staff ORDER BY id');
  const jobs = all(x.raw, 'SELECT * FROM finance_staff_reconciliations ORDER BY staff_id');
  const rules = all(x.raw, 'SELECT * FROM finance_cost_rules ORDER BY id');
  const versions = all(x.raw, 'SELECT * FROM finance_wage_versions ORDER BY id');
  // Fixture for the old deployed classifier: the sale-time snapshot is
  // authoritative now; today's different catalogue cost must never replace it.
  x.raw.exec("UPDATE order_items SET cost_basis='snapshot' WHERE order_id='known'");
  await x.historicalPosting('known');
  assert.equal((await participantOverview(x.db, 'hussein')).summary.available_iqd, 0);
  const report = await drainOrderFinanceRecovery(x.env);
  assert.deepEqual([report.scanned, report.completed, report.pending, report.failed], [1, 1, 0, 0], JSON.stringify(report));
  assert.deepEqual(x.costs('known').map(c => [c.amount_iqd, c.state]), [[1200, 'due'], [6000, 'due']]);
  assert.equal((await participantOverview(x.db, 'hussein')).summary.available_iqd, 1200);
  assert.equal((await participantOverview(x.db, 'sajjad')).summary.available_iqd, 6000);
  assert.equal(count(x.raw, `SELECT SUM(l.debit_iqd-l.credit_iqd) n FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id
    WHERE e.event_key='cogs:known' AND l.account_code='5000'`), 40000);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE order_id='known'"), 0);
  assert.equal(row(x.raw, "SELECT cost_day FROM finance_order_costs WHERE order_id='known'")?.cost_day, baghdadDay());
  assert.equal(row(x.raw, 'SELECT earning_day FROM finance_wage_targets')?.earning_day, '2026-10-03');
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_staff ORDER BY id'), staff);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_staff_reconciliations ORDER BY staff_id'), jobs);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_cost_rules ORDER BY id'), rules);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_wage_versions ORDER BY id'), versions);
  const journals = all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id');
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
  assert.deepEqual(all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id'), journals);
  assert.equal(Object.hasOwn(await getSettings(x.db), CHECKPOINT), false);
  assert.equal(Object.hasOwn(await getSettings(x.db, PUBLIC_SETTING_KEYS), CHECKPOINT), false);
});

test('automatic replay preserves a manually corrected paid wage, employee dates and immutable rule history', async () => {
  const x = await setup(); x.order('paid', 'snapshot'); await x.finishStaffJobs();
  await runOrderFinancialEffects(x.env, 'paid', 'delivered', baghdadDay());
  const sajjad = x.costs('paid').find(c => c.staff_id === 'staff_sajjad')!;
  assert.equal((await patch(x.boss, `/people/costs/${sajjad.id}`, { amount_iqd: 4200 })).status, 200);
  assert.equal((await post(x.boss, `/operations/costs/${sajjad.id}/approve`)).status, 200);
  const payment = await post(x.boss, '/operations/staff/staff_sajjad/payments', { operation_id: 'automatic-history-payment', amount_iqd: 4200, kind: 'payment' });
  assert.equal(payment.status, 200, JSON.stringify(await json(payment)));
  const before = {
    staff: all(x.raw, 'SELECT * FROM finance_staff ORDER BY id'), versions: all(x.raw, 'SELECT * FROM finance_wage_versions ORDER BY id'),
    payments: all(x.raw, 'SELECT * FROM finance_staff_payments ORDER BY id'), allocations: all(x.raw, 'SELECT * FROM finance_payment_allocations ORDER BY payment_id,cost_id'),
    adjustments: all(x.raw, 'SELECT * FROM finance_cost_adjustments ORDER BY id'),
  };
  await recordFinancialFailure(x.db, 'paid', 'cogs', new Error('Stale historical posting warning'));
  const report = await drainOrderFinanceRecovery(x.env);
  assert.equal(report.completed, 1, JSON.stringify(report));
  const effective = row(x.raw, `SELECT c.amount_iqd+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments a WHERE a.cost_id=c.id),0) amount
    FROM finance_order_costs c WHERE c.id=?`, sajjad.id)?.amount;
  assert.equal(effective, 4200);
  assert.equal((await participantOverview(x.db, 'sajjad')).summary.available_iqd, 0);
  assert.deepEqual({
    staff: all(x.raw, 'SELECT * FROM finance_staff ORDER BY id'), versions: all(x.raw, 'SELECT * FROM finance_wage_versions ORDER BY id'),
    payments: all(x.raw, 'SELECT * FROM finance_staff_payments ORDER BY id'), allocations: all(x.raw, 'SELECT * FROM finance_payment_allocations ORDER BY payment_id,cost_id'),
    adjustments: all(x.raw, 'SELECT * FROM finance_cost_adjustments ORDER BY id'),
  }, before);
});

test('a bounded cursor advances past genuinely unknown costs and wraps to retry them after source repair', async () => {
  const x = await setup(); x.order('a-unknown'); x.order('b-known'); await x.finishStaffJobs();
  x.raw.exec("UPDATE order_items SET cost_basis='snapshot' WHERE order_id='b-known'");
  const first = await drainOrderFinanceRecovery(x.env, { maxOrders: 1 });
  assert.equal(first.scanned, 1); assert.equal(first.pending, 1);
  assert.equal(x.costs('a-unknown')[0].amount_iqd, null);
  assert.equal(x.costs('b-known')[0].amount_iqd, null);
  const second = await drainOrderFinanceRecovery(x.env, { maxOrders: 1 });
  assert.equal(second.completed, 1, JSON.stringify(second));
  assert.equal(x.costs('b-known')[0].amount_iqd, 1200);
  assert.equal(x.costs('a-unknown')[0].amount_iqd, null);
  x.raw.exec("UPDATE order_items SET cost_basis='snapshot' WHERE order_id='a-unknown'");
  const third = await drainOrderFinanceRecovery(x.env, { maxOrders: 1 });
  assert.equal(third.completed, 1, JSON.stringify(third));
  assert.equal(x.costs('a-unknown')[0].amount_iqd, 1200);
});

test('a financial write failure remains durable and does not starve the next candidate', async () => {
  const x = await setup(); x.order('a-failure'); x.order('b-known'); await x.finishStaffJobs();
  x.raw.exec("UPDATE order_items SET cost_basis='snapshot'");
  x.failing.failWhen = statements => statements.some(s => s.sql.includes('INSERT INTO accounting_entries') && s.params.includes('sale:a-failure'));
  const first = await drainOrderFinanceRecovery(x.env, { maxOrders: 1 });
  assert.equal(first.failed, 1, JSON.stringify(first));
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='automatic-finance:a-failure'"), 1);
  const second = await drainOrderFinanceRecovery(x.env, { maxOrders: 1 });
  assert.equal(second.completed, 1, JSON.stringify(second));
  x.failing.failWhen = null;
  const third = await drainOrderFinanceRecovery(x.env, { maxOrders: 1 });
  assert.equal(third.completed, 1, JSON.stringify(third));
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='automatic-finance:a-failure'"), 0);
});

test('overlapping drains have one lease winner and expired owners cannot release a replacement lease', async () => {
  const x = await setup(); x.order('known'); await x.finishStaffJobs();
  x.raw.exec("UPDATE order_items SET cost_basis='snapshot'");
  const results = await Promise.all([drainOrderFinanceRecovery(x.env), drainOrderFinanceRecovery(x.env)]);
  assert.equal(results.reduce((n, r) => n + r.scanned, 0), 1);
  assert.equal(results.filter(r => r.locked).length, 1);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key='cogs:known'"), 1);
  await recordFinancialFailure(x.db, 'known', 'cogs', new Error('Retry after old lease expired'));
  x.raw.prepare('UPDATE admin_settings SET value=? WHERE key=?').run(JSON.stringify({ cursor: '', owner: 'crashed', lease_until: 1 }), CHECKPOINT);
  let replaced = false;
  const replacement = JSON.stringify({ cursor: 'replacement-cursor', owner: 'replacement-owner', lease_until: Date.now() + 120000 });
  x.failing.beforeBatch = () => {
    if (replaced) return;
    replaced = true;
    x.raw.prepare('UPDATE admin_settings SET value=? WHERE key=?').run(replacement, CHECKPOINT);
  };
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 1);
  assert.equal(row(x.raw, 'SELECT value FROM admin_settings WHERE key=?', CHECKPOINT)?.value, replacement);
});

test('recovery is inert before the wage schema exists and never selects non-delivered orders', async () => {
  const old = dbThrough('0166');
  const report = await drainOrderFinanceRecovery({ DB: asD1(old) } as Env);
  assert.equal(report.schema_ready, false);
  assert.equal(count(old, 'SELECT COUNT(*) n FROM admin_settings WHERE key=?', CHECKPOINT), 0);
  const x = await setup(); x.order('shipped', 'snapshot', 'shipped');
  await recordFinancialFailure(x.db, 'shipped', 'delivered', new Error('An old marker is not delivery evidence'));
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries'), 0);
});

test('a closed current posting period blocks all recovery writes until that period is reopened', async () => {
  const x = await setup(); x.order('closed'); await x.finishStaffJobs();
  x.raw.exec("UPDATE order_items SET cost_basis='snapshot'");
  x.raw.prepare('INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES (?,?,?)').run(baghdadDay().slice(0, 7), new Date().toISOString(), 'boss');
  const closed = await drainOrderFinanceRecovery(x.env);
  assert.equal(closed.failed, 1, JSON.stringify(closed));
  assert.match(closed.errors[0].message, /الفترة المحاسبية مغلقة/);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries'), 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM operating_expenses'), 0);
  assert.deepEqual(x.costs('closed').map(c => c.amount_iqd), [null, null]);
  x.raw.prepare('DELETE FROM accounting_periods WHERE month=?').run(baghdadDay().slice(0, 7));
  assert.equal((await drainOrderFinanceRecovery(x.env)).completed, 1);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_posting_errors'), 0);
});

test('the recovery limit bounds five-line orders with two employees', async (context) => {
  const x = await setup();
  for (let i = 0; i < 3; i++) {
    const id = `bounded-${i}`; x.order(id);
    for (let line = 1; line < 5; line++) x.raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES (?,?,'p','Filament',2,50000,100000,20000,'unrecorded')`).run(`line:${id}:${line}`, id);
    x.raw.prepare('UPDATE orders SET subtotal_iqd=500000,total_iqd=500000,due_on_delivery_iqd=500000 WHERE id=?').run(id);
  }
  await x.finishStaffJobs();
  x.raw.exec("UPDATE order_items SET cost_basis='snapshot'");
  let prepared = 0, batches = 0, batchStatements = 0;
  const measured = {
    prepare(sql: string) { prepared++; return x.db.prepare(sql); },
    batch(statements: D1PreparedStatement[]) { batches++; batchStatements += statements.length; return x.db.batch(statements); },
  } as D1Database;
  const report = await drainOrderFinanceRecovery({ DB: measured } as Env, { maxOrders: 999 });
  assert.equal(report.scanned, 2, JSON.stringify(report));
  assert.equal(report.completed, 2, JSON.stringify(report));
  assert.equal(x.costs('bounded-2')[0].amount_iqd, null);
  // Prepared statements include both individual reads/writes and batched
  // statements, giving a conservative upper bound for this concrete fixture.
  context.diagnostic(`two five-line orders / ten wages each: ${prepared} prepared statements; ${batches} batches containing ${batchStatements} statements`);
  assert.ok(prepared < 700, `Unexpected D1 query growth: ${prepared}`);
});

test('a closed-period preflight does not freeze an existing fixed wage with unrelated unknown COGS', async () => {
  const x = await setup();
  const rule = await post(x.boss, '/operations/rules', { staff_id: 'staff_hussein', basis: 'order', amount: 2500, group_key: 'independent-fixed', milestone: 'delivered' });
  assert.equal(rule.status, 200, JSON.stringify(await json(rule)));
  x.order('fixed-unknown'); await x.finishStaffJobs();
  await runOrderFinancialEffects(x.env, 'fixed-unknown', 'delivered', baghdadDay());
  assert.equal((await participantOverview(x.db, 'hussein')).summary.available_iqd, 2500);
  const journals = all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id');
  x.raw.prepare('INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES (?,?,?)').run(baghdadDay().slice(0, 7), new Date().toISOString(), 'boss');
  const report = await drainOrderFinanceRecovery(x.env);
  assert.equal(report.failed, 1);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='automatic-finance:fixed-unknown'"), 0);
  assert.equal((await participantOverview(x.db, 'hussein')).summary.available_iqd, 2500);
  assert.deepEqual(all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id'), journals);
});

test('an interrupted source write with an existing stale percentage basis recovers without a failure marker', async () => {
  const x = await setup(); x.order('stale', 'snapshot'); await x.finishStaffJobs();
  await runOrderFinancialEffects(x.env, 'stale', 'delivered', baghdadDay());
  assert.equal((await participantOverview(x.db, 'hussein')).summary.available_iqd, 1200);
  // The source committed, but its immediate reconciliation was interrupted
  // before any durable error could be written. The old basis row still exists.
  x.raw.exec("UPDATE order_items SET cost_iqd=25000 WHERE order_id='stale'");
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_staff_basis WHERE order_id='stale'"), 1);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE order_id='stale'"), 0);
  assert.equal((await participantOverview(x.db, 'hussein')).summary.available_iqd, 0);
  const report = await drainOrderFinanceRecovery(x.env);
  assert.equal(report.completed, 1, JSON.stringify(report));
  assert.equal((await participantOverview(x.db, 'hussein')).summary.available_iqd, 1000);
  assert.equal((await participantOverview(x.db, 'sajjad')).summary.available_iqd, 5000);
  const journals = all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id');
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
  assert.deepEqual(all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id'), journals);
});
