/**
 * WAGE SETTLEMENT (owner 2026-11-10; DECISIONS row 306).
 *
 * «remove hussein < 75000 only his profit make it >», «Sousou: 0», «sajjad
 * start from today < so start 0 >». The owner agrees one amount still owed
 * for every order an employee earned on before a day:
 *   - the agreed amount is payable at once, whatever held the rows before (a
 *     cancelled order's wage, a profit share waiting for a cost);
 *   - money already paid stays paid; the books move by one entry;
 *   - recalculations, the recovery scan and manual edits leave the settled
 *     period alone; later deliveries accrue as usual;
 *   - it refuses while a withdrawal holds a row or wages are being redone,
 *     and is the owner's alone.
 *
 * Run: node --import tsx --test tests/staffSettlement.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, freshDb, failingD1, get, json, patch, post, row, send, stubApp } from './fixtures/app';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { planOrderFinanceSnapshot, runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { reconcileFinanceOrder } from '../worker/lib/financeReconcile';
import { personFinance } from '../worker/lib/personFinance';
import type { Env } from '../worker/lib/types';

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),
    ('employee','employee@example.test','Hussein','admin','assistant'),
    ('buyer','buyer@example.test','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode) VALUES ('printer','Printer','settle-printer',50000,0,'BASE');`);
  const { db } = failingD1(raw);
  const app = (id: string, scope = 'assistant') => stubApp(db, {
    id, email: id === 'boss' ? 'boss@x.co' : `${id}@example.test`, role: 'admin', admin_scope: scope,
  }, (a) => {
    a.route('/people', adminFinancePeopleRoutes);
    a.route('/operations', adminFinanceOperationsRoutes);
    a.route('/earnings', financeEarningsRoutes);
  });
  const boss = app('boss', 'full');
  const env = { DB: db } as Env;
  async function order(id: string, delivered: string, opts: { unrecorded?: boolean } = {}) {
    const created = '2026-09-01T10:00:00.000Z';
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer','delivered','{}','standard','{}','cash',50000,1500,55000,55000,5000,?,?)`).run(id, created, delivered);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES (?,?,?,'Printer',1,50000,50000,20000,?)`).run(`line:${id}`, id, 'printer', opts.unrecorded ? 'unrecorded' : 'snapshot');
    if (!opts.unrecorded) {
      raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
        VALUES (?,?,'base',1,0,20000,'opening',?)`).run(`lot:${id}`, 'printer', created);
      raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
        VALUES (?,?,?,?,'base',1,20000,20000,?)`).run(`alloc:${id}`, id, `line:${id}`, `lot:${id}`, `consumed:${id}`);
    }
    await db.batch(await planOrderFinanceSnapshot(db, id, [{ id: `line:${id}`, product_id: 'printer' }], created));
  }
  async function staff() {
    const response = await post(boss, '/people/staff', { user_id: 'employee', start_work_date: '2026-09-20' });
    const data = await json(response); assert.equal(response.status, 200, JSON.stringify(data));
    return data.id as string;
  }
  async function rule(staffId: string, extra: Record<string, unknown> = {}) {
    const response = await post(boss, '/operations/rules', { staff_id: staffId, basis: 'unit', amount: 2500, milestone: 'delivered', ...extra });
    const data = await json(response); assert.equal(response.status, 200, JSON.stringify(data));
    return data.id as string;
  }
  async function drain(staffId: string) {
    for (let i = 0; i < 60; i++) {
      const data = await json(await post(boss, `/people/staff/${staffId}/reconcile`));
      assert.notEqual(data.reconciliation?.state, 'failed', JSON.stringify(data));
      if (data.reconciliation?.state === 'complete') return;
    }
    assert.fail('reconciliation did not finish');
  }
  const costs = (staffId: string) => all<{ id: string; order_id: string; state: string; effective_iqd: number | null }>(raw,
    `SELECT c.id,c.order_id,c.state,c.amount_iqd+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments a WHERE a.cost_id=c.id),0) effective_iqd
      FROM finance_order_costs c WHERE c.staff_id=? ORDER BY c.order_id,c.id`, staffId);
  const balance = async () => (await json(await get(boss, '/people/accounts/employee/earnings'))).summary as Record<string, number | boolean>;
  const settle = (staffId: string, body: Record<string, unknown>) => post(boss, `/people/staff/${staffId}/settle`, body);
  return { raw, db, env, boss, self: app('employee'), order, staff, rule, drain, costs, balance, settle };
}

test('Hussein: the agreed 75,000-style amount is all payable at once — a cancelled order\'s wage and the rest are cut, the books move once, a payout closes it', async () => {
  const { raw, env, boss, order, staff, rule, drain, costs, balance, settle } = setup();
  for (let d = 21; d <= 26; d++) await order(`o${d}`, `2026-09-${d}T10:00:00.000Z`);
  await order('cancelled', '2026-09-27T10:00:00.000Z');
  const id = await staff(); await rule(id); await drain(id);
  raw.prepare("UPDATE orders SET status='cancelled' WHERE id='cancelled'").run();
  let b = await balance();
  assert.equal(b.staff_iqd, 17500); assert.equal(b.staff_available_iqd, 15000); assert.equal(b.reconciliation_pending, true);
  assert.equal((await send(boss, 'DELETE', `/people/staff/${id}`)).status, 200); await drain(id);
  const entriesBefore = count(raw, 'SELECT COUNT(*) n FROM accounting_entries');

  // The preview writes nothing and says what will happen.
  const preview = await json(await settle(id, { through_day: '2026-10-01', owed_iqd: 10000, preview: true }));
  assert.deepEqual({ earned: preview.preview.earned_before_iqd, paid: preview.preview.paid_before_iqd, owed: preview.preview.owed_before_iqd, change: preview.preview.change_iqd, rows: preview.preview.rows },
    { earned: 17500, paid: 0, owed: 17500, change: -7500, rows: 7 });
  assert.equal(preview.preview.order_changes.length, 7);
  assert.deepEqual(preview.preview.order_changes.find((o: { order_id: string }) => o.order_id === 'cancelled'), { order_id: 'cancelled', before_iqd: 2500, after_iqd: 0 });
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_staff_settlements'), 0);

  const done = await settle(id, { through_day: '2026-10-01', owed_iqd: 10000, reason: 'تسوية نهائية', expected_owed_before_iqd: 17500 });
  assert.equal(done.status, 200, JSON.stringify(await json(done)));
  b = await balance();
  assert.equal(b.staff_iqd, 10000); assert.equal(b.staff_available_iqd, 10000); assert.equal(b.staff_net_iqd, 10000);
  assert.equal(b.staff_pending_settlement_reserve_iqd, 0); assert.equal(b.reconciliation_pending, false);
  // Every payable order's wage moves by the same share; the cancelled order's wage is gone.
  assert.deepEqual(costs(id).map((c) => [c.order_id, c.effective_iqd]), [['cancelled', 0], ['o21', 1667], ['o22', 1667], ['o23', 1667], ['o24', 1667], ['o25', 1666], ['o26', 1666]]);
  // One entry: the cut leaves the staff payable and the wage expense.
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM accounting_entries'), entriesBefore + 1);
  const lines = all<{ account_code: string; debit_iqd: number; credit_iqd: number }>(raw, "SELECT l.account_code,l.debit_iqd,l.credit_iqd FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.source_type='finance_staff_settlement' ORDER BY l.account_code");
  assert.deepEqual(lines, [{ account_code: '2100', debit_iqd: 7500, credit_iqd: 0 }, { account_code: '5100', debit_iqd: 0, credit_iqd: 7500 }]);
  assert.equal(count(raw, 'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines'), 0);

  // A recalculation of a settled order changes nothing; edits and reversals are refused.
  const before = JSON.stringify(costs(id));
  await reconcileFinanceOrder(env.DB, 'o25', { actor: 'boss' }); await runOrderFinancialEffects(env, 'cancelled', 'delivered');
  assert.equal(JSON.stringify(costs(id)), before);
  const settledRow = costs(id).find((c) => c.order_id === 'o21')!;
  assert.equal((await patch(boss, `/people/costs/${settledRow.id}`, { amount_iqd: 100 })).status, 409);
  assert.equal((await post(boss, `/operations/costs/${settledRow.id}/reverse`, { reason: 'x' })).status, 409);
  // The same period cannot be settled twice.
  assert.equal((await settle(id, { through_day: '2026-10-01', owed_iqd: 0 })).status, 409);

  // Paying the agreed amount closes the account.
  for (const c of costs(id).filter((x) => (x.effective_iqd ?? 0) > 0)) assert.equal((await post(boss, `/operations/costs/${c.id}/approve`)).status, 200);
  const paid = await post(boss, `/operations/staff/${id}/payments`, { operation_id: 'settle-pay', amount_iqd: 10000, kind: 'payment' });
  assert.equal(paid.status, 200, JSON.stringify(await json(paid)));
  b = await balance();
  assert.equal(b.staff_net_iqd, 0); assert.equal(b.staff_available_iqd, 0); assert.equal(b.staff_paid_iqd, 10000);
  const settlement = row(raw, 'SELECT owed_iqd,owed_before_iqd,rows_settled,through_day FROM finance_staff_settlements');
  assert.deepEqual({ ...settlement }, { owed_iqd: 10000, owed_before_iqd: 17500, rows_settled: 7, through_day: '2026-10-01' });
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action='finance.staff_settled'"), 1);
});

test('Sajjad: unpaid old wages go to 0, paid stays paid, a waiting profit share is closed, and work from the new day accrues as usual', async () => {
  const { raw, env, boss, order, staff, rule, drain, costs, balance, settle, db } = setup();
  for (let d = 21; d <= 24; d++) await order(`o${d}`, `2026-09-${d}T10:00:00.000Z`);
  await order('waiting', '2026-09-25T10:00:00.000Z', { unrecorded: true });
  const id = await staff(); await rule(id, { basis: 'profit_percent', amount: 1000 }); await drain(id);
  assert.equal(costs(id).find((c) => c.order_id === 'waiting' && c.state === 'pending_cost') !== undefined, true);
  for (const c of costs(id).filter((x) => ['o21', 'o22'].includes(x.order_id) && x.state === 'due')) assert.equal((await post(boss, `/operations/costs/${c.id}/approve`)).status, 200);
  assert.equal((await post(boss, `/operations/staff/${id}/payments`, { operation_id: 'old-wage-payment', amount_iqd: 5000, kind: 'payment' })).status, 200);
  let b = await balance();
  const paidBefore = b.staff_paid_iqd as number;
  assert.equal(paidBefore, 5000);
  assert.ok((b.pending_costs as number) >= 1);

  const done = await settle(id, { through_day: '2026-10-01', owed_iqd: 0 });
  const doneBody = await json(done);
  assert.equal(done.status, 200, JSON.stringify(doneBody));
  b = await balance();
  assert.equal(b.staff_net_iqd, 0); assert.equal(b.staff_available_iqd, 0); assert.equal(b.staff_paid_iqd, 5000);
  assert.equal(b.staff_iqd, 5000); assert.equal(b.pending_costs, 0); assert.equal(b.reconciliation_pending, false); assert.equal(b.debt_iqd, 0);
  assert.equal(costs(id).find((c) => c.order_id === 'waiting')?.state, 'reversed');
  assert.equal(count(raw, 'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines'), 0);

  // The waiting sale gets its cost later: nothing comes back for the settled period.
  raw.exec("UPDATE order_items SET cost_basis='snapshot' WHERE order_id='waiting'");
  await reconcileFinanceOrder(env.DB, 'waiting', { actor: 'boss' });
  assert.equal(costs(id).filter((c) => c.order_id === 'waiting' && c.state !== 'reversed').length, 0);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM finance_order_costs c JOIN orders o ON o.id=c.order_id WHERE c.staff_id='${id}' AND c.state='pending_cost'`), 0);

  // Work from the new day accrues as usual.
  await order('new', '2026-10-05T10:00:00.000Z');
  await runOrderFinancialEffects(env, 'new', 'delivered');
  b = await balance();
  assert.ok((b.staff_iqd as number) > 5000, JSON.stringify(b));
  // 10% of the new order's profit.
  assert.ok(costs(id).some((c) => c.order_id === 'new' && c.state === 'due' && (c.effective_iqd ?? 0) > 0));
  // The owner and the person both read the settlement.
  const own = await personFinance(db, 'employee', { owner: false });
  assert.deepEqual(own.work?.roles[0].settlement, { through_day: '2026-10-01', owed_iqd: 0, settlement_day: own.work?.roles[0].settlement?.settlement_day });
  assert.equal(own.work?.roles[0].settlement?.through_day, '2026-10-01');
});

test('a settlement refuses an open withdrawal, wages being redone and anyone but the owner', async () => {
  const { raw, boss, self, order, staff, rule, drain, balance, settle } = setup();
  await order('o21', '2026-09-21T10:00:00.000Z'); await order('o22', '2026-09-22T10:00:00.000Z');
  const id = await staff(); await rule(id); await drain(id);
  // An open withdrawal holds a row.
  const requested = await post(self, '/earnings/withdrawals', { operation_id: 'held-withdrawal-1', amount_iqd: 2500 });
  assert.equal(requested.status, 200, JSON.stringify(await json(requested)));
  const refused = await settle(id, { through_day: '2026-10-01', owed_iqd: 0 });
  assert.equal(refused.status, 409);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_staff_settlements'), 0);
  const withdrawal = row(raw, 'SELECT id FROM finance_withdrawals');
  assert.equal((await post(boss, `/people/withdrawals/${withdrawal!.id}/reject`, { note: 'settlement' })).status, 200);
  // Wages being redone.
  raw.exec(`UPDATE finance_staff_reconciliations SET state='pending',cursor='' WHERE staff_id='${id}'`);
  assert.equal((await settle(id, { through_day: '2026-10-01', owed_iqd: 0 })).status, 409);
  raw.exec(`UPDATE finance_staff_reconciliations SET state='complete' WHERE staff_id='${id}'`);
  // A day that has not come.
  assert.equal((await settle(id, { through_day: '2099-01-01', owed_iqd: 0 })).status, 400);
  // The employee cannot settle their own wages.
  assert.equal((await post(self, `/people/staff/${id}/settle`, { through_day: '2026-10-01', owed_iqd: 999999 })).status, 403);
  assert.equal((await balance()).staff_iqd, 5000);
  assert.equal((await settle(id, { through_day: '2026-10-01', owed_iqd: 0 })).status, 200);
});
