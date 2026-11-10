/**
 * A WAGE ON AN ORDER THAT LOST ITS DELIVERY (DECISIONS row 307).
 *
 * Hussein's 11,622 on ORD-30AD9ABDA5 — delivered 16 Oct, cancelled 17 Oct —
 * stayed in his earned total, held for ever, and stayed a cost of the order:
 * the timeline wage planner returned early for an order with no delivery day.
 * Now, as an employment cutoff does:
 *   - the order's timeline-managed wages come to 0 with a 'recalculation'
 *     adjustment and its journal, through the minute recovery scan or any
 *     recalculation of the order;
 *   - a paid part stays paid, as debt; an open withdrawal blocks the cut until
 *     it is paid or released;
 *   - a settled row keeps its agreed amount (DECISIONS row 306);
 *   - a re-delivery plans the wage again, and the investor's share of the sale
 *     follows the wage.
 *
 * Run: node --import tsx --test tests/wageLostDelivery.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, failingD1, freshDb, json, post, row, stubApp } from './fixtures/app';
import { drainOrderFinanceRecovery } from '../worker/lib/financeOrderRecovery';
import { continueStaffReconciliation } from '../worker/lib/financeStaffAccrual';
import { queueStaffReconciliation } from '../worker/lib/financeEmployment';
import { participantOverview, participantSources } from '../worker/lib/financeParticipants';
import { reconcileFinanceOrder } from '../worker/lib/financeReconcile';
import { runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { runOrderDeliveredEffects } from '../worker/lib/orderDeliveredEffects';
import { investorOrderSplit } from '../worker/lib/investorFinance';
import { baghdadDay, journalPlan } from '../worker/lib/operations';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import type { Env } from '../worker/lib/types';

const REASON = 'الطلب لم يعد مُسلَّمًا؛ يعود أجره إلى صفر حتى يُسلَّم من جديد';

async function setup(rules: Array<Record<string, unknown>> = [{ basis: 'order', amount: 2500 }]) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),('hussein','hussein@x.co','Hussein','admin','assistant'),
    ('buyer','buyer@x.co','Buyer','customer',NULL);
    UPDATE finance_staff SET user_id='hussein',start_work_date='2026-09-01' WHERE id='staff_hussein';
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('p','Printer','lost-delivery-printer',50000,20000);`);
  const { db, failing } = failingD1(raw), env = { DB: db } as Env;
  const app = (id: string, scope: string) => stubApp(db, { id, email: `${id === 'boss' ? 'boss@x.co' : `${id}@x.co`}`, role: 'admin', admin_scope: scope }, (a) => {
    a.route('/operations', adminFinanceOperationsRoutes);
    a.route('/people', adminFinancePeopleRoutes);
    a.route('/earnings', financeEarningsRoutes);
  });
  const boss = app('boss', 'full'), self = app('hussein', 'assistant');
  for (const rule of rules) {
    const response = await post(boss, '/operations/rules', { staff_id: 'staff_hussein', milestone: 'delivered', ...rule });
    assert.equal(response.status, 200, JSON.stringify(await json(response)));
  }
  async function finishJob() {
    for (let i = 0; i < 20; i++) {
      const job = await continueStaffReconciliation(env, 'staff_hussein');
      assert.notEqual(job?.state, 'failed', JSON.stringify(job));
      if (job?.state === 'complete') return;
    }
    assert.fail('the staff job did not finish');
  }
  await finishJob();
  /** Delivered through the delivery hook, as the courier sync or the admin's door does. */
  async function delivered(id: string, at = '2026-10-16T10:00:00.000Z', lines = 1) {
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
      subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
      VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1500,?,?,'2026-10-01T10:00:00.000Z',?)`).run(id, 50000 * lines, 50000 * lines, 50000 * lines, at);
    for (let line = 0; line < lines; line++) raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES (?,?,'p','Printer',1,50000,50000,20000,'snapshot')`).run(`line:${id}:${line}`, id);
    await runOrderFinancialEffects(env, id, 'delivered');
  }
  // Every door that cancels or walks back a platform order flips the status and
  // keeps `delivered_at` (worker/routes/admin.ts, worker/lib/orderStageOps.ts);
  // neither runs a financial hook.
  const cancel = (id: string, status = 'cancelled') => raw.prepare('UPDATE orders SET status=? WHERE id=?').run(status, id);
  /** A re-delivery keeps the first `delivered_at` and runs the delivery door's effects again. */
  async function redeliver(id: string) {
    raw.prepare("UPDATE orders SET status='delivered' WHERE id=?").run(id);
    await runOrderDeliveredEffects(env, id);
  }
  const wages = (id: string) => all<{ id: string; state: string; basis: string; effective: number | null }>(raw,
    `SELECT c.id,c.state,json_extract(c.snapshot,'$.rule.basis') basis,
      c.amount_iqd+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments a WHERE a.cost_id=c.id),0) effective
      FROM finance_order_costs c WHERE c.order_id=? AND c.staff_id='staff_hussein' ORDER BY basis,c.id`, id);
  const me = async () => (await participantOverview(db, 'hussein')).summary;
  const wageExpense = () => count(raw, "SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines WHERE account_code='5100'");
  const wageExpenseByDay = () => all(raw, `SELECT e.entry_day day,SUM(l.debit_iqd-l.credit_iqd) n FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id
    WHERE l.account_code='5100' GROUP BY e.entry_day ORDER BY e.entry_day`).map((r) => ({ ...r }));
  const balanced = () => count(raw, 'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines');
  return { raw, db, failing, env, boss, self, finishJob, delivered, cancel, redeliver, wages, me, wageExpense, wageExpenseByDay, balanced };
}

test('cancelled after delivery: the wage comes to 0 with a recalculation and its journal, stops counting, and returns on re-delivery', async () => {
  // Hussein's live rules: 2,500 an order and 2% of the order's profit.
  const x = await setup([{ basis: 'order', amount: 2500, group_key: 'replies' }, { basis: 'profit_percent', amount: 200, group_key: 'replies-profit' }]);
  await x.delivered('ORD-LOST');
  const earned = x.wages('ORD-LOST');
  assert.deepEqual(earned.map((w) => [w.basis, w.effective]), [['order', 2500], ['profit_percent', 550]], JSON.stringify(earned));
  let me = await x.me();
  assert.deepEqual([me.staff_iqd, me.staff_available_iqd], [3050, 3050]);
  assert.equal(x.wageExpense(), 3050);

  x.cancel('ORD-LOST');
  // What the live ledger showed: still earned, held for ever.
  me = await x.me();
  assert.deepEqual([me.staff_iqd, me.staff_available_iqd, me.reconciliation_pending], [3050, 0, true]);

  const report = await drainOrderFinanceRecovery(x.env);
  assert.deepEqual([report.scanned, report.completed, report.pending, report.failed], [1, 1, 0, 0], JSON.stringify(report));
  assert.deepEqual(x.wages('ORD-LOST').map((w) => [w.basis, w.state, w.effective]), [['order', 'due', 0], ['profit_percent', 'due', 0]],
    'the rows stay, at 0: a payout still allocates to real rows');
  // (The delivery's own second pass may already have corrected the profit share
  // for the fixed wage: these are the adjustments of the lost delivery.)
  const adjustments = all(x.raw, `SELECT a.kind,a.delta_iqd,a.before_iqd,a.after_iqd,a.reason,a.earning_day,a.adjustment_day FROM finance_cost_adjustments a
    JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.order_id='ORD-LOST' AND a.earning_day='2026-10-16' AND a.adjustment_day<>'2026-10-16' ORDER BY a.delta_iqd`);
  assert.deepEqual(adjustments.map((a) => ({ ...a })), [
    { kind: 'recalculation', delta_iqd: -2500, before_iqd: 2500, after_iqd: 0, reason: REASON, earning_day: '2026-10-16', adjustment_day: baghdadDay() },
    { kind: 'recalculation', delta_iqd: -550, before_iqd: 550, after_iqd: 0, reason: REASON, earning_day: '2026-10-16', adjustment_day: baghdadDay() },
  ]);
  // The journal moves the wage out of the books: the payable and the expense.
  const lines = all(x.raw, `SELECT l.account_code,SUM(l.debit_iqd) debit,SUM(l.credit_iqd) credit FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id
    WHERE e.source_type='finance_cost_adjustment' AND e.source_id IN (SELECT id FROM finance_cost_adjustments WHERE reason=?) GROUP BY l.account_code ORDER BY l.account_code`, REASON);
  assert.deepEqual(lines.map((l) => ({ ...l })), [{ account_code: '2100', debit: 3050, credit: 0 }, { account_code: '5100', debit: 0, credit: 3050 }]);
  assert.equal(x.wageExpense(), 0, 'the cancelled order carries no wage cost');
  assert.equal(x.balanced(), 0);
  assert.deepEqual(all(x.raw, `SELECT t.amount_iqd,t.earning_day FROM finance_wage_targets t JOIN finance_order_costs c ON c.id=t.cost_id
    WHERE c.order_id='ORD-LOST' ORDER BY c.id`).map((t) => ({ ...t })), [{ amount_iqd: 0, earning_day: '2026-10-16' }, { amount_iqd: 0, earning_day: '2026-10-16' }]);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM audit_log WHERE action='finance.wage_reconciled' AND json_extract(detail,'$.reason')=?", REASON), 2);
  me = await x.me();
  assert.deepEqual([me.staff_iqd, me.staff_available_iqd, me.staff_net_iqd, me.reconciliation_pending], [0, 0, 0, false]);
  // Done: the scan does not come back to it, and a replay changes nothing.
  const journals = all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id');
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
  await reconcileFinanceOrder(x.db, 'ORD-LOST');
  assert.deepEqual(all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id'), journals);

  // Delivered again: the same delivery day, the same rows, the same wage.
  await x.redeliver('ORD-LOST');
  assert.deepEqual(x.wages('ORD-LOST').map((w) => [w.basis, w.effective]), [['order', 2500], ['profit_percent', 550]]);
  assert.deepEqual(x.wages('ORD-LOST').map((w) => w.id), earned.map((w) => w.id), 'no second row');
  me = await x.me();
  assert.deepEqual([me.staff_iqd, me.staff_available_iqd, me.reconciliation_pending], [3050, 3050, false]);
  assert.equal(x.wageExpense(), 3050);
  assert.equal(x.balanced(), 0);
  // The restore is today's, like the cut: the delivery's month keeps exactly
  // the wage it had (its own -50 is the delivery's second pass correcting the
  // profit share for the fixed wage; the restore makes the same two passes).
  assert.deepEqual(all(x.raw, `SELECT a.adjustment_day day,SUM(a.delta_iqd) delta FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id
    WHERE c.order_id='ORD-LOST' GROUP BY a.adjustment_day ORDER BY a.adjustment_day`).map((a) => ({ ...a })),
  [{ day: '2026-10-16', delta: -50 }, { day: baghdadDay(), delta: 0 }]);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_cost_adjustments WHERE earning_day IS NOT '2026-10-16'"), 0);
  assert.deepEqual(x.wageExpenseByDay(), [{ day: '2026-10-16', n: 3050 }, { day: baghdadDay(), n: 0 }]);
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
});

test('a re-delivery after the delivery month closed restores the wage today instead of failing, a free order too', async () => {
  const x = await setup();
  await x.delivered('ORD-OCTOBER');
  // A free order (a replacement, a 100% coupon) books no sale and here no cost
  // either: only its wage says it was delivered before.
  x.raw.exec(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
      VALUES ('ORD-OCTOBER-FREE','buyer','delivered','{}','standard','{}','cash',0,1500,0,0,'2026-10-01T10:00:00.000Z','2026-10-16T12:00:00.000Z');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('line:ORD-OCTOBER-FREE','ORD-OCTOBER-FREE','p','Printer',1,0,0,0,'snapshot');`);
  await runOrderFinancialEffects(x.env, 'ORD-OCTOBER-FREE', 'delivered');
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key IN ('sale:ORD-OCTOBER-FREE','cogs:ORD-OCTOBER-FREE')"), 0);
  assert.deepEqual(x.wages('ORD-OCTOBER-FREE').map((w) => w.effective), [2500]);
  x.cancel('ORD-OCTOBER'); x.cancel('ORD-OCTOBER-FREE');
  assert.equal((await drainOrderFinanceRecovery(x.env)).completed, 2);
  x.raw.prepare('INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES (?,?,?)').run('2026-10', new Date().toISOString(), 'boss');
  await x.redeliver('ORD-OCTOBER'); await x.redeliver('ORD-OCTOBER-FREE');
  assert.deepEqual([x.wages('ORD-OCTOBER').map((w) => w.effective), x.wages('ORD-OCTOBER-FREE').map((w) => w.effective)], [[2500], [2500]]);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_posting_errors'), 0);
  assert.deepEqual(x.wageExpenseByDay(), [{ day: '2026-10-16', n: 5000 }, { day: baghdadDay(), n: 0 }]);
});

test('a recalculation of the order or of the employee does the same, and a walk-back short of cancelling is a lost delivery too', async () => {
  const x = await setup();
  await x.delivered('ORD-RECHECK'); await x.delivered('ORD-STAFF-JOB', '2026-10-17T10:00:00.000Z'); await x.delivered('ORD-WALKED-BACK', '2026-10-18T10:00:00.000Z');
  x.cancel('ORD-RECHECK'); x.cancel('ORD-STAFF-JOB'); x.cancel('ORD-WALKED-BACK', 'shipped');
  // The owner's recheck of one order (reconcileFinanceOrder), not the scan.
  assert.equal((await reconcileFinanceOrder(x.db, 'ORD-RECHECK')).staff_complete, true);
  assert.deepEqual(x.wages('ORD-RECHECK').map((w) => w.effective), [0]);
  // An employee recalculation walks every order with the employee's wages, cancelled ones included.
  await queueStaffReconciliation(x.db, 'staff_hussein', 'boss');
  await x.finishJob();
  assert.deepEqual(x.wages('ORD-STAFF-JOB').map((w) => w.effective), [0]);
  // Moved back to «shipped»: not delivered either, so the wage is not earned now.
  assert.deepEqual(x.wages('ORD-WALKED-BACK').map((w) => w.effective), [0]);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_cost_adjustments WHERE reason=?', REASON), 3);
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
});

test('a paid wage stays paid and becomes debt; a re-delivery clears the debt', async () => {
  const x = await setup();
  await x.delivered('ORD-PAID');
  const [wage] = x.wages('ORD-PAID');
  assert.equal((await post(x.boss, `/operations/costs/${wage.id}/approve`)).status, 200);
  const payment = await post(x.boss, '/operations/staff/staff_hussein/payments', { operation_id: 'lost-delivery-pay', amount_iqd: 2500, kind: 'payment' });
  assert.equal(payment.status, 200, JSON.stringify(await json(payment)));
  const paid = { payments: all(x.raw, 'SELECT * FROM finance_staff_payments ORDER BY id'), allocations: all(x.raw, 'SELECT * FROM finance_payment_allocations ORDER BY payment_id,cost_id') };
  x.cancel('ORD-PAID');
  assert.equal((await drainOrderFinanceRecovery(x.env)).completed, 1);
  assert.deepEqual(x.wages('ORD-PAID').map((w) => [w.state, w.effective]), [['approved', 0]]);
  let me = await x.me();
  assert.deepEqual([me.staff_iqd, me.staff_paid_iqd, me.staff_net_iqd, me.staff_debt_iqd, me.staff_available_iqd], [0, 2500, -2500, 2500, 0]);
  assert.deepEqual({ payments: all(x.raw, 'SELECT * FROM finance_staff_payments ORDER BY id'), allocations: all(x.raw, 'SELECT * FROM finance_payment_allocations ORDER BY payment_id,cost_id') }, paid,
    'the payment and its allocation are untouched');
  await x.redeliver('ORD-PAID');
  me = await x.me();
  assert.deepEqual([me.staff_iqd, me.staff_paid_iqd, me.staff_net_iqd, me.staff_debt_iqd], [2500, 2500, 0, 0]);
  assert.equal(x.balanced(), 0);
});

test('an open withdrawal holds only its own wage: the scan waits, a recalculation walks past it, the release lets the cut through', async () => {
  const x = await setup();
  await x.delivered('ORD-HELD');
  const request = await post(x.self, '/earnings/withdrawals', { operation_id: 'lost-delivery-withdrawal', amount_iqd: 2500 });
  const requested = await json(request);
  assert.equal(request.status, 200, JSON.stringify(requested));
  await x.delivered('ORD-UNHELD', '2026-10-18T10:00:00.000Z'); await x.delivered('ORD-Z-STILL-DELIVERED', '2026-10-20T10:00:00.000Z');
  x.cancel('ORD-HELD'); x.cancel('ORD-UNHELD');
  // Not paid either: the order is not delivered, so the held row is not payable.
  const held = (await participantSources(x.db, 'hussein')).find((s) => s.order_id === 'ORD-HELD')!;
  assert.deepEqual([held.held_iqd, held.eligible], [2500, false]);
  // The scan leaves the order with the held wage alone, rather than failing on it every minute.
  const report = await drainOrderFinanceRecovery(x.env);
  assert.deepEqual([report.scanned, report.completed], [1, 1], JSON.stringify(report));
  assert.deepEqual(x.wages('ORD-UNHELD').map((w) => w.effective), [0]);
  assert.deepEqual(x.wages('ORD-HELD').map((w) => w.effective), [2500]);
  // An employee's recalculation walks past it: it finishes, nothing is marked
  // failed, and the employee's other wages are not held behind it.
  await queueStaffReconciliation(x.db, 'staff_hussein', 'boss');
  await x.finishJob();
  assert.equal((await reconcileFinanceOrder(x.db, 'ORD-HELD')).staff_complete, true);
  assert.deepEqual(x.wages('ORD-HELD').map((w) => w.effective), [2500]);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_posting_errors'), 0);
  assert.equal((await participantSources(x.db, 'hussein')).find((s) => s.order_id === 'ORD-Z-STILL-DELIVERED')?.eligible, true);
  // Released: the scan cuts it.
  assert.equal((await post(x.boss, `/people/withdrawals/${requested.id}/reject`, { note: 'الطلب أُلغي' })).status, 200);
  assert.equal((await drainOrderFinanceRecovery(x.env)).completed, 1);
  assert.deepEqual(x.wages('ORD-HELD').map((w) => w.effective), [0]);
  const me = await x.me();
  assert.deepEqual([me.staff_iqd, me.staff_held_iqd, me.staff_net_iqd, me.staff_available_iqd], [2500, 0, 2500, 2500]);
});

test('a lost delivery does not raise an undated colleague\'s older profit share on the same order', async () => {
  const x = await setup();
  // Sajjad has no start date and his rule is never revised: the old writer keeps it.
  const rule = await post(x.boss, '/operations/rules', { staff_id: 'staff_sajjad', milestone: 'delivered', basis: 'profit_percent', amount: 1000, effective_from: '2026-09-01' });
  assert.equal(rule.status, 200, JSON.stringify(await json(rule)));
  // Created after that rule, so the order's frozen rules carry it.
  const now = new Date().toISOString();
  x.raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
    subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
    VALUES ('ORD-MIXED','buyer','delivered','{}','standard','{}','cash',50000,1500,50000,50000,?,?)`).run(now, now);
  x.raw.exec("INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('line:ORD-MIXED','ORD-MIXED','p','Printer',1,50000,50000,20000,'snapshot')");
  await runOrderFinancialEffects(x.env, 'ORD-MIXED', 'delivered');
  const sajjad = () => all<{ effective: number }>(x.raw, `SELECT c.amount_iqd+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments a WHERE a.cost_id=c.id),0) effective
    FROM finance_order_costs c WHERE c.order_id='ORD-MIXED' AND c.staff_id='staff_sajjad'`).map((c) => c.effective);
  // 10% of (50,000 - 20,000 - Hussein's 2,500).
  assert.deepEqual([x.wages('ORD-MIXED').map((w) => w.effective), sajjad()], [[2500], [2750]]);
  x.cancel('ORD-MIXED');
  assert.equal((await drainOrderFinanceRecovery(x.env)).completed, 1);
  assert.deepEqual([x.wages('ORD-MIXED').map((w) => w.effective), sajjad()], [[0], [2750]], 'not 3,000: the cut is not his profit');
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.staff_id='staff_sajjad'"), 0);
  await x.redeliver('ORD-MIXED');
  assert.deepEqual([x.wages('ORD-MIXED').map((w) => w.effective), sajjad()], [[2500], [2750]]);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.staff_id='staff_sajjad'"), 0);
});

test('a settled row keeps its agreed amount; an order delivered after the settled day is cut as usual', async () => {
  const x = await setup();
  await x.delivered('ORD-A-SETTLED', '2026-10-10T10:00:00.000Z');
  await x.delivered('ORD-B-LATER', '2026-10-25T10:00:00.000Z');
  const settled = await post(x.boss, '/people/staff/staff_hussein/settle', { through_day: '2026-10-20', owed_iqd: 1000, operation_id: 'lost-delivery-settle' });
  assert.equal(settled.status, 200, JSON.stringify(await json(settled)));
  assert.deepEqual(x.wages('ORD-A-SETTLED').map((w) => w.effective), [1000]);
  const before = all(x.raw, "SELECT a.* FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.order_id='ORD-A-SETTLED' ORDER BY a.id");
  x.cancel('ORD-A-SETTLED'); x.cancel('ORD-B-LATER');
  const report = await drainOrderFinanceRecovery(x.env);
  assert.deepEqual([report.scanned, report.completed], [1, 1], JSON.stringify(report));
  assert.deepEqual(x.wages('ORD-B-LATER').map((w) => w.effective), [0]);
  assert.deepEqual(x.wages('ORD-A-SETTLED').map((w) => w.effective), [1000]);
  // A recalculation of the settled order, cancelled or delivered again, leaves it alone.
  await reconcileFinanceOrder(x.db, 'ORD-A-SETTLED');
  await x.redeliver('ORD-A-SETTLED');
  assert.deepEqual(x.wages('ORD-A-SETTLED').map((w) => w.effective), [1000]);
  assert.deepEqual(all(x.raw, "SELECT a.* FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.order_id='ORD-A-SETTLED' ORDER BY a.id"), before);
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
});

test('only what the planner will cut is a candidate: never-delivered orders and legacy wages are not selected', async () => {
  const x = await setup();
  x.raw.exec(`INSERT INTO expense_categories(id,slug,name_ar) VALUES ('legacy-wages','legacy-wages','أجور قديمة');
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
    VALUES ('ORD-NEVER','buyer','processing','{}','standard','{}','cash',50000,1500,50000,50000,NULL),
           ('ORD-LEGACY','buyer','cancelled','{}','standard','{}','cash',50000,1500,50000,50000,'2026-10-16T10:00:00.000Z');`);
  const managed = row<{ id: string }>(x.raw, "SELECT id FROM finance_cost_rules WHERE staff_id='staff_hussein'")!.id;
  const cost = x.raw.prepare(`INSERT INTO finance_order_costs(id,order_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot)
    VALUES (?,?,?,1,'أجر','g','staff_hussein',?,'delivered',0,1,2500,'2026-10-16','due',?)`);
  // A wage recorded before any delivery (an old preparation row) waits for the delivery.
  cost.run('cost-never', 'ORD-NEVER', managed, row<{ category_id: string }>(x.raw, 'SELECT category_id FROM finance_cost_rules WHERE id=?', managed)!.category_id, JSON.stringify({ rule: { id: managed, basis: 'order' } }));
  // A rule with no wage version belongs to the legacy writer and its own cutoff.
  cost.run('cost-legacy', 'ORD-LEGACY', 'rule:legacy', 'legacy-wages', JSON.stringify({ rule: { id: 'rule:legacy', basis: 'order' } }));
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_cost_adjustments'), 0);
});

test('investor profit follows the wage: held while the sale is cancelled, re-synced with the wage on re-delivery', async () => {
  const x = await setup();
  const app = stubApp(x.db, { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => a.route('/i', adminInvestmentFinanceRoutes));
  x.raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('investor','investor@x.co','Investor','admin','assistant');
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO products(id,name,name_ar,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('part','Part','قطعة','lost-part','LOST',5000,100,0,'BASE');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,supplier_id,status,created_by) VALUES ('inc-a','part','base','',1,1,100,0,0,'supplier','received','boss');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at,incoming_id,supplier_id) VALUES ('lot-a','part','base','',1,0,100,100,'received','2026-01-01','inc-a','supplier');`);
  const contract = { operation_id: 'lost-delivery-contract', incoming_id: 'inc-a', user_id: 'investor', name: 'تمويل قطعة', principal_iqd: 100, capital_share_bps: 10000, profit_share_bps: 3500, loss_share_bps: 10000 };
  assert.equal((await post(app, '/i/contracts', contract)).status, 200);
  assert.equal((await post(app, `/i/contracts/${contract.operation_id}/funding`, { operation_id: 'lost-delivery-funding', amount_iqd: 100, payment_day: baghdadDay(), reference: 'cash receipt' })).status, 200);
  const at = new Date().toISOString();
  x.raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
    VALUES ('ORD-FUNDED','buyer','delivered','{}','standard','{}','cash',5000,1500,5000,5000,0,?,?)`).run(at, at);
  x.raw.exec(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('funded-item','ORD-FUNDED','part','قطعة',1,5000,5000,100,'snapshot');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES ('funded-a','ORD-FUNDED','funded-item','lot-a','base','',1,100,100,'ORD-FUNDED:lot-a:0');`);
  x.raw.prepare("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES ('funded-collection','ORD-FUNDED','customer',5000,?,'boss',?)").run(baghdadDay(), at);
  await x.db.batch([...journalPlan(x.db, { key: 'sale:ORD-FUNDED', day: baghdadDay(), title: 'Sale', source: 'order', sourceId: 'ORD-FUNDED', actor: 'boss' }, [{ account: '1100', debit: 5000 }, { account: '4000', credit: 5000 }]).statements,
    ...journalPlan(x.db, { key: 'cogs:ORD-FUNDED', day: baghdadDay(), title: 'COGS', source: 'order', sourceId: 'ORD-FUNDED', actor: 'boss' }, [{ account: '5000', debit: 100 }, { account: '1200', credit: 100 }]).statements]);
  await runOrderFinancialEffects(x.env, 'ORD-FUNDED', 'delivered');
  const investor = async () => (await participantOverview(x.db, 'investor')).summary;
  // (5,000 revenue - 100 cost - 2,500 wage) × 35%.
  assert.deepEqual(x.wages('ORD-FUNDED').map((w) => w.effective), [2500]);
  assert.equal((await investorOrderSplit(x.db, 'ORD-FUNDED')).investor_profit_iqd, 840);
  assert.equal((await investor()).investor_profit_available_iqd, 840);

  x.cancel('ORD-FUNDED');
  assert.equal((await drainOrderFinanceRecovery(x.env)).completed, 1);
  assert.deepEqual(x.wages('ORD-FUNDED').map((w) => w.effective), [0]);
  // A cancelled sale pays its investor nothing while it stays cancelled.
  assert.equal((await investor()).investor_profit_available_iqd, 0);

  await x.redeliver('ORD-FUNDED');
  assert.deepEqual(x.wages('ORD-FUNDED').map((w) => w.effective), [2500]);
  // The wage is back as the sale's cost before the investor's share is published again.
  assert.equal((await investorOrderSplit(x.db, 'ORD-FUNDED')).investor_profit_iqd, 840);
  assert.equal((await investor()).investor_profit_available_iqd, 840);
  assert.equal(count(x.raw, "SELECT COALESCE(SUM(profit_iqd),0) n FROM investor_allocation_results WHERE allocation_id='funded-a'"), 840);
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
});

test('the recovery limit bounds two cancelled five-line orders with two employees', async (context) => {
  const x = await setup([{ basis: 'unit', amount: 2500 }]);
  x.raw.exec("UPDATE finance_staff SET start_work_date='2026-09-01' WHERE id='staff_sajjad'");
  const rule = await post(x.boss, '/operations/rules', { staff_id: 'staff_sajjad', basis: 'unit', amount: 7500, milestone: 'delivered' });
  assert.equal(rule.status, 200, JSON.stringify(await json(rule)));
  for (let i = 0; i < 10; i++) if ((await continueStaffReconciliation(x.env, 'staff_sajjad'))?.state === 'complete') break;
  for (let i = 0; i < 3; i++) { await x.delivered(`ORD-BOUNDED-${i}`, '2026-10-16T10:00:00.000Z', 5); x.cancel(`ORD-BOUNDED-${i}`); }
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_order_costs WHERE amount_iqd>0"), 30);
  let prepared = 0, batches = 0, batchStatements = 0;
  const measured = {
    prepare(sql: string) { prepared++; return x.db.prepare(sql); },
    batch(statements: D1PreparedStatement[]) { batches++; batchStatements += statements.length; return x.db.batch(statements); },
  } as D1Database;
  const report = await drainOrderFinanceRecovery({ DB: measured } as Env, { maxOrders: 999 });
  assert.deepEqual([report.scanned, report.completed], [2, 2], JSON.stringify(report));
  context.diagnostic(`two cancelled five-line orders / ten wages each: ${prepared} prepared statements; ${batches} batches containing ${batchStatements} statements`);
  assert.ok(prepared < 700, `Unexpected D1 query growth: ${prepared}`);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_order_costs c WHERE c.order_id='ORD-BOUNDED-2' AND c.amount_iqd+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments a WHERE a.cost_id=c.id),0)>0"), 10);
});
