import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, failingD1, freshDb, get, json, patch, post, row, send, stubApp } from './fixtures/app';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { planOrderFinanceSnapshot, runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { baghdadDay } from '../worker/lib/operations';
import { drainStaffReconciliations } from '../worker/lib/financeStaffAccrual';
import { updateStaffEmployment } from '../worker/lib/financeEmployment';
import { reconcileStaffOrderCosts } from '../worker/lib/financeParticipants';
import type { Env } from '../worker/lib/types';

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),
    ('employee','employee@example.test','Sajjad','admin','assistant'),
    ('another','another@example.test','Hussein','admin','assistant'),
    ('buyer','buyer@example.test','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode) VALUES
    ('printer','Printer','employment-printer',50000,0,'BASE'),
    ('excluded','Excluded printer','employment-excluded',50000,0,'BASE');`);
  const { db, failing } = failingD1(raw);
  const app = (id: string, scope = 'assistant') => stubApp(db, {
    id, email: id === 'boss' ? 'boss@x.co' : `${id}@example.test`, role: 'admin', admin_scope: scope,
  }, (a) => {
    a.route('/people', adminFinancePeopleRoutes);
    a.route('/operations', adminFinanceOperationsRoutes);
    a.route('/earnings', financeEarningsRoutes);
  });
  const boss = app('boss', 'full');
  const env = { DB: db } as Env;
  async function order(id: string, delivered: string | null, options: { created?: string; product?: string; status?: string; freeze?: boolean } = {}) {
    const product = options.product ?? 'printer';
    const created = options.created ?? '2026-09-01T10:00:00.000Z';
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer',?,'{}','standard','{}','cash',50000,1500,55000,55000,5000,?,?)`).run(id, options.status ?? 'delivered', created, delivered);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES (?,?,?,'Printer',1,50000,50000,20000,'snapshot')`).run(`line:${id}`, id, product);
    raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES (?,?,'base',1,0,20000,'opening',?)`).run(`lot:${id}`, product, created);
    raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
      VALUES (?,?,?,?,'base',1,20000,20000,?)`).run(`alloc:${id}`, id, `line:${id}`, `lot:${id}`, `consumed:${id}`);
    if (options.freeze !== false) await db.batch(await planOrderFinanceSnapshot(db, id, [{ id: `line:${id}`, product_id: product }], created));
  }
  async function staff(extra: Record<string, unknown> = {}) {
    const response = await post(boss, '/people/staff', { user_id: 'employee', start_work_date: '2026-09-20', ...extra });
    const data = await json(response);
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.id as string;
  }
  async function rule(staffId: string, extra: Record<string, unknown> = {}) {
    const response = await post(boss, '/operations/rules', { staff_id: staffId, basis: 'unit', amount: 5000, milestone: 'delivered', ...extra });
    const data = await json(response);
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.id as string;
  }
  async function drain(staffId: string) {
    for (let i = 0; i < 50; i++) {
      const response = await post(boss, `/people/staff/${staffId}/reconcile`);
      const data = await json(response);
      assert.equal(response.status, 200, JSON.stringify(data));
      const reconciliation = data.reconciliation;
      assert.ok(reconciliation, `Missing reconciliation: ${JSON.stringify(data)}`);
      assert.notEqual(reconciliation.state, 'failed', JSON.stringify(reconciliation));
      if (reconciliation.state === 'complete') return reconciliation;
    }
    assert.fail('Employee reconciliation did not finish within 50 bounded requests');
  }
  const costs = (staffId: string) => all<{ id: string; order_id: string; amount_iqd: number; effective_iqd: number; state: string }>(raw,
    `SELECT c.id,c.order_id,c.amount_iqd,c.amount_iqd+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments a WHERE a.cost_id=c.id),0) effective_iqd,c.state
      FROM finance_order_costs c WHERE c.staff_id=? ORDER BY c.order_id,c.id`, staffId);
  return { raw, db, failing, boss, env, self: app('employee'), app, order, staff, rule, drain, costs };
}

test('staff lifecycle accepts one work-start date, rejects invalid calendar dates, and restricts changes to financial administrators', async () => {
  const { raw, boss, self, staff } = setup();
  const id = await staff({ name: 'Sajjad preparation', role: 'Preparation' });
  assert.equal(row(raw, 'SELECT start_work_date FROM finance_staff WHERE id=?', id)?.start_work_date, '2026-09-20');
  assert.equal((await patch(boss, `/people/staff/${id}`, { name: 'Sajjad updated', start_work_date: '2026-09-21' })).status, 200);
  assert.equal(row(raw, 'SELECT name FROM finance_staff WHERE id=?', id)?.name, 'Sajjad updated');
  assert.equal((await post(boss, '/people/staff', { user_id: 'another', start_work_date: '2026-02-30' })).status, 400);
  assert.equal((await patch(boss, `/people/staff/${id}`, { start_work_date: '2026-13-01' })).status, 400);
  assert.equal((await patch(self, `/people/staff/${id}`, { start_work_date: null })).status, 403);
  assert.equal((await send(self, 'DELETE', `/people/staff/${id}`)).status, 403);
  const listing = await json(await get(boss, '/people/staff'));
  assert.ok(Array.isArray(listing.reconciliations));
  assert.equal(listing.staff.find((s: { id: string }) => s.id === id).start_work_date, '2026-09-21');
});

test('retrospective accrual uses delivery after the start date in Baghdad, independent of checkout date, and respects exclusions', async () => {
  const { raw, order, staff, rule, drain, costs } = setup();
  await order('last-second-start-day', '2026-09-20T20:59:59.999Z');
  await order('first-second-next-day', '2026-09-20T21:00:00.000Z');
  await order('older-checkout', '2026-09-25T12:00:00.000Z', { created: '2026-08-01T10:00:00.000Z' });
  await order('created-later-delivered-earlier', '2026-09-19T12:00:00.000Z', { created: '2026-09-24T10:00:00.000Z' });
  await order('missing-delivery-time', null, { created: '2026-09-25T10:00:00.000Z' });
  await order('not-delivered', '2026-09-25T12:00:00.000Z', { status: 'processing' });
  await order('excluded-product', '2026-09-25T12:00:00.000Z', { product: 'excluded' });
  const id = await staff();
  const ruleId = await rule(id, { scope: { catalog_ids: [], product_ids: [], excluded_product_ids: ['excluded'] } });
  assert.equal(row(raw, 'SELECT effective_from FROM finance_cost_rules WHERE id=?', ruleId)?.effective_from, '2026-09-21');
  await drain(id);
  assert.deepEqual(costs(id).filter((c) => c.effective_iqd > 0).map((c) => c.order_id), ['first-second-next-day', 'older-checkout']);
  assert.equal(costs(id).reduce((sum, c) => sum + c.effective_iqd, 0), 10000);
  assert.equal(count(raw, 'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines'), 0);
});

test('repeating retrospective accrual preserves one cost and one journal and never rewrites the checkout snapshot', async () => {
  const { raw, boss, order, staff, rule, drain, costs } = setup();
  await order('historic', '2026-09-22T10:00:00.000Z');
  const before = row(raw, "SELECT rules_json FROM finance_order_snapshots WHERE order_id='historic'")?.rules_json;
  const id = await staff(); await rule(id); await drain(id);
  const first = costs(id);
  assert.equal(first.length, 1); assert.equal(first[0].effective_iqd, 5000);
  const journalCount = count(raw, 'SELECT COUNT(*) n FROM accounting_entries');
  const adjustmentCount = count(raw, 'SELECT COUNT(*) n FROM finance_cost_adjustments');
  await drain(id);
  assert.equal((await patch(boss, `/people/staff/${id}`, { start_work_date: '2026-09-20' })).status, 200);
  await drain(id);
  assert.deepEqual(costs(id), first);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM accounting_entries'), journalCount);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_cost_adjustments'), adjustmentCount);
  assert.equal(row(raw, "SELECT rules_json FROM finance_order_snapshots WHERE order_id='historic'")?.rules_json, before);
});

for (const basis of ['unit', 'order', 'revenue_percent']) {
  test(`retrospective ${basis} wages remain available when the delivered order only awaits inventory COGS`, async () => {
    const { raw, env, self, order, staff, rule, drain, costs } = setup();
    await order('legacy-without-fifo', '2026-09-22T10:00:00.000Z');
    raw.exec("DELETE FROM order_item_inventory_allocations WHERE order_id='legacy-without-fifo'");
    await runOrderFinancialEffects(env, 'legacy-without-fifo', 'delivered');
    assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='cogs:legacy-without-fifo'"), 1);
    const id = await staff();
    await rule(id, { basis, amount: basis === 'revenue_percent' ? 1000 : 5000 });
    await drain(id);
    assert.equal(costs(id)[0].effective_iqd, 5000);
    const earnings = await json(await get(self, '/earnings'));
    assert.equal(earnings.summary.available_earnings_iqd, 5000);
    assert.equal(earnings.summary.reconciliation_pending, false);
    assert.equal((await post(self, '/earnings/withdrawals', { operation_id: `legacy-wage-${basis}`, amount_iqd: 5000 })).status, 200);
    // The inventory warning must stay visible to the owner until COGS is fixed.
    assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='cogs:legacy-without-fifo'"), 1);
  });
}

test('retrospective profit-percentage wages still wait for verified inventory cost', async () => {
  const { raw, env, self, order, staff, rule, drain, costs } = setup();
  await order('profit-without-fifo', '2026-09-22T10:00:00.000Z');
  raw.exec("DELETE FROM order_item_inventory_allocations WHERE order_id='profit-without-fifo'");
  await runOrderFinancialEffects(env, 'profit-without-fifo', 'delivered');
  const id = await staff(); await rule(id, { basis: 'profit_percent', amount: 1000 }); await drain(id);
  assert.equal(costs(id)[0].state, 'pending_cost');
  const earnings = await json(await get(self, '/earnings'));
  assert.equal(earnings.summary.available_earnings_iqd, 0);
  assert.equal(earnings.summary.pending_costs, 1);
  assert.equal((await post(self, '/earnings/withdrawals', { operation_id: 'unverified-profit-withdrawal', amount_iqd: 1 })).status, 400);
});

test('own earnings explains work-start progress before any costs exist without exposing other accounts or rule snapshots', async () => {
  const { self, order, staff, rule, drain } = setup();
  await order('before-employment', '2026-09-22T10:00:00.000Z');
  const id = await staff({ start_work_date: '2027-01-01' }); await rule(id);
  await staff({ user_id: 'another', start_work_date: '2026-09-01' });
  let earnings = await json(await get(self, '/earnings?user_id=another'));
  assert.equal(earnings.entries.length, 0);
  assert.equal(earnings.summary.reconciliation_pending, true);
  assert.deepEqual(earnings.employment, [{
    start_work_date: '2027-01-01', first_earning_day: '2027-01-02', active: 1, archived: 0,
    has_rules: 1, reconciliation_state: 'pending', processed_orders: 0,
  }]);
  await drain(id);
  earnings = await json(await get(self, '/earnings'));
  assert.equal(earnings.summary.reconciliation_pending, false);
  assert.equal(earnings.employment[0].reconciliation_state, 'complete');
  assert.equal(earnings.employment[0].processed_orders, 0);
  assert.equal(earnings.summary.available_earnings_iqd, 0);
});

test('changing the start date after payout adjusts the current period and preserves original earnings and payment history', async () => {
  const { raw, boss, self, order, staff, rule, drain, costs } = setup();
  await order('paid-historic', '2026-09-21T10:00:00.000Z');
  const id = await staff(); await rule(id); await drain(id);
  const cost = costs(id)[0]; assert.ok(cost); assert.equal(cost.effective_iqd, 5000);
  assert.equal((await post(boss, `/operations/costs/${cost.id}/approve`)).status, 200);
  const paid = await post(boss, `/operations/staff/${id}/payments`, { operation_id: 'employment-pay-1', amount_iqd: 5000, kind: 'payment' });
  assert.equal(paid.status, 200, JSON.stringify(await json(paid)));
  const allocation = all(raw, 'SELECT * FROM finance_payment_allocations');
  const originalCost = row(raw, 'SELECT * FROM finance_order_costs WHERE id=?', cost.id);
  raw.prepare("INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES ('2026-09',?,'boss')").run(new Date().toISOString());
  const changed = await patch(boss, `/people/staff/${id}`, { start_work_date: '2026-09-21' });
  assert.equal(changed.status, 200, JSON.stringify(await json(changed)));
  await drain(id);
  assert.equal(costs(id)[0].effective_iqd, 0);
  assert.equal(costs(id)[0].amount_iqd, 5000);
  assert.deepEqual(all(raw, 'SELECT * FROM finance_payment_allocations'), allocation);
  assert.equal(row(raw, 'SELECT expense_id FROM finance_order_costs WHERE id=?', cost.id)?.expense_id, originalCost?.expense_id);
  const adjustment = row(raw, 'SELECT delta_iqd,adjustment_day FROM finance_cost_adjustments WHERE cost_id=? ORDER BY created_at DESC LIMIT 1', cost.id);
  assert.equal(adjustment?.delta_iqd, -5000); assert.equal(adjustment?.adjustment_day, baghdadDay());
  let earnings = await json(await get(self, '/earnings'));
  assert.equal(earnings.summary.debt_iqd, 5000); assert.equal(earnings.summary.available_earnings_iqd, 0);
  assert.equal((await patch(boss, `/people/staff/${id}`, { start_work_date: '2026-09-20' })).status, 200);
  await drain(id);
  assert.equal(costs(id)[0].effective_iqd, 5000);
  earnings = await json(await get(self, '/earnings'));
  assert.equal(earnings.summary.debt_iqd, 0); assert.equal(earnings.summary.available_earnings_iqd, 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_staff_payments'), 1);
  assert.equal(count(raw, 'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines'), 0);
});

test('archiving preserves earned wages and blocks new earnings from a rule frozen before archival', async () => {
  const { raw, boss, self, env, order, staff, rule, drain, costs, db } = setup();
  await order('earned-before-archive', '2026-09-22T10:00:00.000Z');
  const id = await staff(); await rule(id); await drain(id);
  const future = new Date(Date.now() + 60_000).toISOString();
  await order('frozen-before-archive', null, { created: new Date(Date.now() + 1000).toISOString(), status: 'processing', freeze: false });
  await db.batch(await planOrderFinanceSnapshot(db, 'frozen-before-archive', [{ id: 'line:frozen-before-archive', product_id: 'printer' }], new Date(Date.now() + 2000).toISOString()));
  const archived = await send(boss, 'DELETE', `/people/staff/${id}`);
  assert.equal(archived.status, 200, JSON.stringify(await json(archived)));
  await drain(id);
  assert.equal(row(raw, 'SELECT active FROM finance_staff WHERE id=?', id)?.active, 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_staff WHERE id=?', id), 1);
  assert.equal(costs(id).reduce((sum, c) => sum + c.effective_iqd, 0), 5000);
  raw.prepare("UPDATE orders SET status='delivered',delivered_at=? WHERE id='frozen-before-archive'").run(future);
  await runOrderFinancialEffects(env, 'frozen-before-archive', 'delivered');
  await drain(id);
  assert.equal(costs(id).reduce((sum, c) => sum + c.effective_iqd, 0), 5000);
  assert.equal((await json(await get(self, '/earnings'))).summary.available_earnings_iqd, 5000);
});

test('dated preparation wages wait for delivered orders, while undated legacy preparation remains unchanged', async () => {
  const { raw, env, db, order, staff, rule, drain, costs } = setup();
  const id = await staff(); await rule(id, { milestone: 'prepared' }); await drain(id);
  await order('awaiting-delivery', null, { created: new Date(Date.now() + 1000).toISOString(), status: 'processing', freeze: false });
  await db.batch(await planOrderFinanceSnapshot(db, 'awaiting-delivery', [{ id: 'line:awaiting-delivery', product_id: 'printer' }], new Date(Date.now() + 2000).toISOString()));
  await runOrderFinancialEffects(env, 'awaiting-delivery', 'prepared');
  assert.equal(costs(id).reduce((sum, c) => sum + (c.effective_iqd ?? 0), 0), 0);
  raw.prepare("UPDATE orders SET status='delivered',delivered_at=? WHERE id='awaiting-delivery'").run(new Date().toISOString());
  await runOrderFinancialEffects(env, 'awaiting-delivery', 'delivered');
  assert.equal(costs(id).reduce((sum, c) => sum + (c.effective_iqd ?? 0), 0), 5000);
  const legacyId = await staff({ user_id: 'another', start_work_date: null });
  await rule(legacyId, { milestone: 'prepared' });
  await order('legacy-preparation', null, { created: new Date(Date.now() + 1000).toISOString(), status: 'processing', freeze: false });
  await db.batch(await planOrderFinanceSnapshot(db, 'legacy-preparation', [{ id: 'line:legacy-preparation', product_id: 'printer' }], new Date(Date.now() + 2000).toISOString()));
  await runOrderFinancialEffects(env, 'legacy-preparation', 'prepared');
  assert.equal(costs(legacyId).reduce((sum, c) => sum + (c.effective_iqd ?? 0), 0), 5000);
  assert.equal(count(raw, 'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines'), 0);
});

test('retrospective reconciliation progresses in bounded requests and replaying the final page creates no duplicates', async () => {
  const { raw, boss, order, staff, rule, drain, costs } = setup();
  for (let i = 0; i < 27; i++) await order(`historic-${String(i).padStart(2, '0')}`, '2026-09-22T10:00:00.000Z');
  const id = await staff(); await rule(id);
  const response = await post(boss, `/people/staff/${id}/reconcile`);
  const first = await json(response);
  assert.equal(response.status, 200, JSON.stringify(first));
  assert.equal(first.reconciliation.state, 'pending');
  assert.equal(first.reconciliation.processed_orders, 1);
  assert.equal(costs(id).length, 1);
  await drain(id);
  assert.equal(costs(id).length, 27);
  assert.equal(costs(id).reduce((sum, c) => sum + c.effective_iqd, 0), 135000);
  const entries = count(raw, 'SELECT COUNT(*) n FROM accounting_entries');
  await drain(id);
  assert.equal(costs(id).length, 27);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM accounting_entries'), entries);
});

test('owner can read committed reconciliation progress after a lost response, resume one order and replay without another accrual', async () => {
  const { raw, boss, self, app, order, staff, rule, costs } = setup();
  await order('progress-a', '2026-09-22T10:00:00.000Z');
  await order('progress-b', '2026-09-23T10:00:00.000Z');
  const id = await staff(); await rule(id);
  const endpoint = `/people/staff/${id}/reconcile`;
  const financialAdmin = app('financial-admin', 'full');
  assert.equal((await json(await get(boss, '/people/staff'))).can_manage_staff, true);
  assert.equal((await json(await get(financialAdmin, '/people/staff'))).can_manage_staff, false);
  assert.equal((await get(self, endpoint)).status, 403);
  assert.equal((await get(financialAdmin, endpoint)).status, 403);
  assert.equal((await get(boss, '/people/staff/missing/reconcile')).status, 404);
  assert.equal((await get(boss, '/people/staff/staff_sajjad/reconcile')).status, 404);
  const initial = await json(await get(boss, endpoint));
  assert.equal(initial.reconciliation.processed_orders, 0);
  const revision = initial.reconciliation.revision;
  // The browser may lose this successful response. Its next GET must read
  // committed progress without starting another page or posting more money.
  assert.equal((await post(boss, endpoint, { revision, maxOrders: 1000 })).status, 200);
  const before = {
    job: row(raw, 'SELECT * FROM finance_staff_reconciliations WHERE staff_id=?', id),
    entries: count(raw, 'SELECT COUNT(*) n FROM accounting_entries'),
    clock: count(raw, 'SELECT version n FROM finance_mutation_clock'),
  };
  const progress = await json(await get(boss, endpoint));
  assert.equal(progress.reconciliation.state, 'pending');
  assert.equal(progress.reconciliation.processed_orders, 1);
  assert.equal(progress.reconciliation.cursor, 'progress-a');
  assert.equal('rules_json' in progress.reconciliation, false);
  assert.equal('actor_id' in progress.reconciliation, false);
  assert.equal(costs(id).length, 1);
  assert.deepEqual({
    job: row(raw, 'SELECT * FROM finance_staff_reconciliations WHERE staff_id=?', id),
    entries: count(raw, 'SELECT COUNT(*) n FROM accounting_entries'),
    clock: count(raw, 'SELECT version n FROM finance_mutation_clock'),
  }, before);
  assert.equal((await post(boss, endpoint, { revision: revision + 1 })).status, 409);
  assert.equal(costs(id).length, 1);
  const resumed = await json(await post(boss, endpoint, { revision }));
  assert.equal(resumed.reconciliation.state, 'complete');
  assert.equal(resumed.reconciliation.processed_orders, 2);
  assert.equal(costs(id).reduce((sum, cost) => sum + cost.effective_iqd, 0), 10000);
  const entries = count(raw, 'SELECT COUNT(*) n FROM accounting_entries');
  assert.equal((await post(boss, endpoint, { revision })).status, 200);
  assert.equal(costs(id).length, 2);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM accounting_entries'), entries);
});

test('failed retrospective accrual can be retried without losing or duplicating staff wages', async () => {
  const { raw, boss, failing, order, staff, rule, drain, costs } = setup();
  await order('retry-historic', '2026-09-22T10:00:00.000Z');
  const id = await staff(); await rule(id);
  failing.failWhen = (statements) => statements.some((s) => s.sql.includes('INSERT INTO finance_order_costs'));
  const failedResponse = await post(boss, `/people/staff/${id}/reconcile`);
  const failed = await json(failedResponse);
  assert.equal(failedResponse.status, 200, JSON.stringify(failed));
  assert.equal(failed.reconciliation.state, 'failed');
  assert.equal(costs(id).length, 0);
  failing.failWhen = null;
  await drain(id); await drain(id);
  assert.equal(costs(id).length, 1); assert.equal(costs(id)[0].effective_iqd, 5000);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE source_type='order_cost'"), 1);
  assert.equal(count(raw, 'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines'), 0);
});

test('start-date changes cannot invalidate an outstanding withdrawal reservation', async () => {
  const { raw, boss, self, order, staff, rule, drain, costs } = setup();
  await order('reserved-historic', '2026-09-21T10:00:00.000Z');
  const id = await staff(); await rule(id); await drain(id);
  const requested = await post(self, '/earnings/withdrawals', { operation_id: 'employment-withdrawal', amount_iqd: 5000 });
  assert.equal(requested.status, 200, JSON.stringify(await json(requested)));
  assert.equal((await patch(boss, `/people/staff/${id}`, { start_work_date: '2026-09-21' })).status, 409);
  assert.equal(row(raw, 'SELECT start_work_date FROM finance_staff WHERE id=?', id)?.start_work_date, '2026-09-20');
  assert.equal(costs(id)[0].effective_iqd, 5000);
  assert.equal((await post(self, '/earnings/withdrawals/employment-withdrawal/cancel')).status, 200);
  assert.equal((await patch(boss, `/people/staff/${id}`, { start_work_date: '2026-09-21' })).status, 200);
  await drain(id);
  assert.equal(costs(id)[0].effective_iqd, 0);
});

test('restoring an archived employee does not award deliveries during the archived interval', async (t) => {
  const initial = Date.UTC(2026, 9, 4, 12, 0, 0);
  t.mock.timers.enable({ apis: ['Date'], now: initial });
  const { raw, boss, order, staff, rule, drain, costs } = setup();
  await order('before-archive', '2026-09-22T10:00:00.000Z');
  const id = await staff(); await rule(id); await drain(id);
  assert.equal((await send(boss, 'DELETE', `/people/staff/${id}`)).status, 200);
  t.mock.timers.setTime(initial + 1000);
  await order('during-archive', new Date().toISOString());
  t.mock.timers.setTime(initial + 2000);
  const restored = await patch(boss, `/people/staff/${id}`, { active: true, restore: true });
  assert.equal(restored.status, 200, JSON.stringify(await json(restored)));
  t.mock.timers.setTime(initial + 3000);
  await order('after-archive', new Date().toISOString());
  await drain(id);
  assert.equal(row(raw, 'SELECT archived_at FROM finance_staff WHERE id=?', id)?.archived_at, null);
  assert.equal(row(raw, 'SELECT active FROM finance_staff WHERE id=?', id)?.active, 1);
  assert.deepEqual(costs(id).filter((c) => c.effective_iqd > 0).map((c) => c.order_id), ['after-archive', 'before-archive']);
});

test('a changed cutoff blocks stale wages immediately before the queued reconciliation runs', async () => {
  const { raw, boss, self, order, staff, rule, drain, costs } = setup();
  await order('not-yet-reconciled', '2026-09-21T10:00:00.000Z');
  const id = await staff(); await rule(id); await drain(id);
  assert.equal((await post(boss, `/operations/costs/${costs(id)[0].id}/approve`)).status, 200);
  assert.equal((await patch(boss, `/people/staff/${id}`, { start_work_date: '2026-09-21' })).status, 200);
  const before = await json(await get(self, '/earnings'));
  assert.equal(before.summary.available_earnings_iqd, 0);
  const selfPay = await post(self, '/earnings/withdrawals', { operation_id: 'stale-employment-withdrawal', amount_iqd: 5000 });
  assert.ok([400, 409].includes(selfPay.status), JSON.stringify(await json(selfPay)));
  const legacyPay = await post(boss, `/operations/staff/${id}/payments`, { operation_id: 'stale-employment-pay', amount_iqd: 5000, kind: 'payment' });
  assert.ok([400, 409].includes(legacyPay.status), JSON.stringify(await json(legacyPay)));
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_staff_payments'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_withdrawals'), 0);
  await drain(id);
  assert.equal(costs(id)[0].effective_iqd, 0);
});

test('concurrent employment cutoff change rolls back a newly accrued cost and its journal', async () => {
  const { raw, failing, env, order, staff, rule, drain, costs } = setup();
  const id = await staff(); await rule(id); await drain(id);
  await order('competing-cutoff', '2026-09-21T10:00:00.000Z');
  failing.beforeBatch = (statements) => {
    if (!statements.some((s) => s.sql.includes('INSERT INTO finance_order_costs'))) return;
    failing.beforeBatch = null;
    raw.prepare("UPDATE finance_staff SET start_work_date='2026-09-21',employment_version=employment_version+1 WHERE id=?").run(id);
    raw.prepare("UPDATE finance_staff_reconciliations SET revision=revision+1,state='pending',cursor='' WHERE staff_id=?").run(id);
  };
  await assert.rejects(runOrderFinancialEffects(env, 'competing-cutoff', 'delivered'), /CHECK constraint|تغير/);
  assert.equal(costs(id).length, 0);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE source_type='order_cost'"), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM operating_expenses'), 0);
  await drain(id);
  assert.equal(costs(id).length, 0);
});

test('scheduled reconciliation advances pending staff jobs without any browser continuation request', async () => {
  const { raw, env, order, staff, rule, costs } = setup();
  for (let i = 0; i < 3; i++) await order(`scheduled-${i}`, '2026-09-22T10:00:00.000Z');
  const id = await staff(); await rule(id);
  await drainStaffReconciliations(env, { maxJobs: 1, maxOrders: 1 });
  assert.equal(costs(id).length, 1);
  assert.equal(row(raw, 'SELECT state FROM finance_staff_reconciliations WHERE staff_id=?', id)?.state, 'pending');
  await drainStaffReconciliations(env, { maxJobs: 1, maxOrders: 1 });
  await drainStaffReconciliations(env, { maxJobs: 1, maxOrders: 1 });
  assert.equal(costs(id).length, 3);
  assert.equal(row(raw, 'SELECT state FROM finance_staff_reconciliations WHERE staff_id=?', id)?.state, 'complete');
  const entries = count(raw, 'SELECT COUNT(*) n FROM accounting_entries');
  await drainStaffReconciliations(env, { maxJobs: 1, maxOrders: 1 });
  assert.equal(costs(id).length, 3);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM accounting_entries'), entries);
});

test('moving employment earlier expands default rule eligibility while preserving an explicitly chosen rule start', async () => {
  const { boss, order, staff, rule, drain, costs } = setup();
  await order('sep20-delivery', '2026-09-20T10:00:00.000Z');
  await order('sep21-delivery', '2026-09-21T10:00:00.000Z');
  const automatic = await staff(); await rule(automatic); await drain(automatic);
  const explicit = await staff({ user_id: 'another' }); await rule(explicit, { effective_from: '2026-09-21' }); await drain(explicit);
  assert.deepEqual(costs(automatic).filter((c) => c.effective_iqd > 0).map((c) => c.order_id), ['sep21-delivery']);
  assert.deepEqual(costs(explicit).filter((c) => c.effective_iqd > 0).map((c) => c.order_id), ['sep21-delivery']);
  assert.equal((await patch(boss, `/people/staff/${automatic}`, { start_work_date: '2026-09-19' })).status, 200);
  assert.equal((await patch(boss, `/people/staff/${explicit}`, { start_work_date: '2026-09-19' })).status, 200);
  await drain(automatic); await drain(explicit);
  assert.deepEqual(costs(automatic).filter((c) => c.effective_iqd > 0).map((c) => c.order_id), ['sep20-delivery', 'sep21-delivery']);
  assert.deepEqual(costs(explicit).filter((c) => c.effective_iqd > 0).map((c) => c.order_id), ['sep21-delivery']);
});

test('editing only a staff name or role preserves the completed job revision and spendable earnings', async () => {
  const { raw, boss, self, order, staff, rule, drain, costs } = setup();
  await order('earned-before-profile-edit', '2026-09-22T10:00:00.000Z');
  const id = await staff(); await rule(id); await drain(id);
  const beforeJob = row<{ revision: number; state: string; cursor: string }>(raw,
    'SELECT revision,state,cursor FROM finance_staff_reconciliations WHERE staff_id=?', id)!;
  const beforeVersion = row(raw, 'SELECT employment_version FROM finance_staff WHERE id=?', id)?.employment_version;
  const beforeCosts = costs(id);
  assert.equal(beforeJob.state, 'complete');
  assert.equal((await json(await get(self, '/earnings'))).summary.available_earnings_iqd, 5000);
  const response = await patch(boss, `/people/staff/${id}`, { name: 'Sajjad updated', role: 'Printer preparation lead' });
  const changed = await json(response);
  assert.equal(response.status, 200, JSON.stringify(changed));
  assert.equal(changed.reconciliation.revision, beforeJob.revision);
  assert.equal(changed.reconciliation.state, 'complete');
  assert.deepEqual(row(raw, 'SELECT revision,state,cursor FROM finance_staff_reconciliations WHERE staff_id=?', id), beforeJob);
  assert.equal(row(raw, 'SELECT employment_version FROM finance_staff WHERE id=?', id)?.employment_version, beforeVersion);
  assert.deepEqual(row(raw, 'SELECT name,role FROM finance_staff WHERE id=?', id), { name: 'Sajjad updated', role: 'Printer preparation lead' });
  assert.deepEqual(costs(id), beforeCosts);
  const earnings = await json(await get(self, '/earnings'));
  assert.equal(earnings.summary.available_earnings_iqd, 5000);
  assert.equal(earnings.summary.reconciliation_pending, false);
});

test('the first work-start date promotes an unchanged legacy default rule but preserves explicit rule dates', async () => {
  const { raw, boss, order, staff, rule, drain, costs } = setup();
  await order('historic-before-legacy-rule', '2026-09-22T10:00:00.000Z');
  const inferred = await staff({ start_work_date: null });
  const inferredRule = await rule(inferred); await drain(inferred);
  const initial = row<{ effective_from: string; effective_to: string | null; employment_effective_default: number; created_at: string }>(raw,
    'SELECT effective_from,effective_to,employment_effective_default,created_at FROM finance_cost_rules WHERE id=?', inferredRule)!;
  assert.equal(initial.employment_effective_default, 0);
  assert.equal(initial.effective_from, baghdadDay(new Date(initial.created_at)));
  assert.equal(initial.effective_to, null);
  assert.equal(costs(inferred).length, 0);
  const explicit = await staff({ user_id: 'another', start_work_date: null });
  const explicitRule = await rule(explicit, { effective_from: '2026-09-30' }); await drain(explicit);
  assert.equal((await patch(boss, `/people/staff/${inferred}`, { start_work_date: '2026-09-20' })).status, 200);
  assert.equal((await patch(boss, `/people/staff/${explicit}`, { start_work_date: '2026-09-20' })).status, 200);
  await drain(inferred); await drain(explicit);
  assert.deepEqual(costs(inferred).filter((c) => c.effective_iqd > 0).map((c) => c.order_id), ['historic-before-legacy-rule']);
  assert.equal(costs(inferred).reduce((sum, c) => sum + c.effective_iqd, 0), 5000);
  assert.equal(costs(explicit).length, 0);
  assert.equal(row(raw, 'SELECT effective_from FROM finance_cost_rules WHERE id=?', explicitRule)?.effective_from, '2026-09-30');
  await drain(inferred);
  assert.equal(costs(inferred).length, 1);
});

test('a cutoff edit racing a committed archive cannot restore the stale active employee', { timeout: 15_000 }, async () => {
  const { raw, db, staff, drain } = setup();
  const id = await staff(); await drain(id);
  let notifyPaused!: () => void;
  let resumeLookup!: () => void;
  const paused = new Promise<void>((resolve) => { notifyPaused = resolve; });
  const resumed = new Promise<void>((resolve) => { resumeLookup = resolve; });
  let intercepted = false;
  const gateStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === 'bind') return (...values: unknown[]) => gateStatement(target.bind(...values));
      if (key === 'first') return async <T = unknown>(column?: string) => {
        if (!intercepted) {
          intercepted = true;
          notifyPaused();
          await resumed;
        }
        return column === undefined ? target.first<T>() : target.first<T>(column);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const gatedDb = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        return sql.trim() === 'SELECT id FROM users WHERE id=?' ? gateStatement(statement) : statement;
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const editor = stubApp(gatedDb, { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' },
    (a) => a.route('/people', adminFinancePeopleRoutes));
  const pendingEdit = patch(editor, `/people/staff/${id}`, { start_work_date: '2026-09-21' });
  await paused;
  let archivedStaff: Record<string, unknown> | undefined;
  let archivedJob: Record<string, unknown> | undefined;
  try {
    await updateStaffEmployment(db, id, {}, 'boss', true);
    archivedStaff = row(raw, 'SELECT * FROM finance_staff WHERE id=?', id);
    archivedJob = row(raw, 'SELECT * FROM finance_staff_reconciliations WHERE staff_id=?', id);
    assert.equal(archivedStaff?.active, 0);
    assert.ok(archivedStaff?.archived_at);
    const periods = JSON.parse(String(archivedStaff?.inactive_periods_json)) as Array<{ from: string; to: string | null }>;
    assert.equal(periods.length, 1); assert.equal(periods[0].to, null);
  } finally {
    resumeLookup();
  }
  const response = await pendingEdit;
  assert.equal(response.status, 409, JSON.stringify(await json(response)));
  assert.deepEqual(row(raw, 'SELECT * FROM finance_staff WHERE id=?', id), archivedStaff);
  assert.deepEqual(row(raw, 'SELECT * FROM finance_staff_reconciliations WHERE staff_id=?', id), archivedJob);
  assert.equal(row(raw, 'SELECT start_work_date FROM finance_staff WHERE id=?', id)?.start_work_date, '2026-09-20');
});

test('a percentage recalculation cannot revive earnings after a competing cutoff has fully reconciled', { timeout: 20_000 }, async () => {
  const { raw, db, boss, self, order, staff, rule, drain, costs } = setup();
  await order('zero-profit-cutoff', '2026-09-21T10:00:00.000Z');
  raw.exec(`UPDATE order_items SET cost_iqd=50000 WHERE order_id='zero-profit-cutoff';
    UPDATE inventory_lots SET unit_cost_iqd=50000 WHERE id='lot:zero-profit-cutoff';
    UPDATE order_item_inventory_allocations SET unit_cost_iqd=50000,cogs_iqd=50000 WHERE order_id='zero-profit-cutoff';`);
  const id = await staff(); await rule(id, { basis: 'profit_percent', amount: 1000 }); await drain(id);
  const original = costs(id)[0]; assert.ok(original); assert.equal(original.effective_iqd, 0);
  raw.exec("UPDATE orders SET price_adjustment_iqd=10000 WHERE id='zero-profit-cutoff'");
  let notifyPaused!: () => void;
  let resumeBatch!: () => void;
  const paused = new Promise<void>((resolve) => { notifyPaused = resolve; });
  const resumed = new Promise<void>((resolve) => { resumeBatch = resolve; });
  let intercepted = false;
  const gatedDb = new Proxy(db, {
    get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        const hasCostAdjustment = statements.some((s) =>
          (s as unknown as { sql?: string }).sql?.includes('INSERT INTO finance_cost_adjustments'));
        if (!intercepted && hasCostAdjustment) {
          intercepted = true;
          notifyPaused();
          await resumed;
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const pendingRecalculation = reconcileStaffOrderCosts(gatedDb, 'zero-profit-cutoff', { actor: 'boss' });
  await paused;
  try {
    const changed = await patch(boss, `/people/staff/${id}`, { start_work_date: '2026-09-21' });
    assert.equal(changed.status, 200, JSON.stringify(await json(changed)));
    await drain(id);
    assert.equal(row(raw, 'SELECT state FROM finance_staff_reconciliations WHERE staff_id=?', id)?.state, 'complete');
    assert.equal(costs(id)[0].effective_iqd, 0);
  } finally {
    resumeBatch();
  }
  await assert.rejects(pendingRecalculation, { status: 409 });
  assert.equal(costs(id)[0].effective_iqd, 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_cost_adjustments WHERE cost_id=?', original.id), 0);
  const earnings = await json(await get(self, '/earnings'));
  assert.equal(earnings.summary.available_earnings_iqd, 0);
  assert.equal(earnings.summary.earned_iqd, 0);
  const manual = await patch(boss, `/people/costs/${original.id}`, { amount_iqd: 1000 });
  assert.equal(manual.status, 409, JSON.stringify(await json(manual)));
  assert.equal(costs(id)[0].effective_iqd, 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_cost_adjustments WHERE cost_id=?', original.id), 0);
});
