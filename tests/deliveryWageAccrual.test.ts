import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, count, freshDb, get, json, patch, post, row, stubApp } from './fixtures/app';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { runOrderDeliveredEffects } from '../worker/lib/orderDeliveredEffects';
import { participantSources } from '../worker/lib/financeParticipants';
import type { Env } from '../worker/lib/types';

function setup() {
  const raw = freshDb(), db = asD1(raw), env = { DB: db } as Env;
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),
    ('employee','employee@example.test','Worker','admin','assistant'),
    ('buyer','buyer@example.test','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode) VALUES
    ('printer','Printer','delivery-wage-printer',50000,0,'BASE');`);
  const app = (id: string, scope: string) => stubApp(db, {
    id, email: id === 'boss' ? 'boss@x.co' : `${id}@example.test`, role: 'admin', admin_scope: scope,
  }, a => {
    a.route('/people', adminFinancePeopleRoutes);
    a.route('/operations', adminFinanceOperationsRoutes);
    a.route('/workspace', adminFinanceWorkspaceRoutes);
    a.route('/earnings', financeEarningsRoutes);
  });
  const boss = app('boss', 'full'), self = app('employee', 'assistant');
  async function staff() {
    const response = await post(boss, '/people/staff', { user_id: 'employee', start_work_date: '2026-09-20' });
    const data = await json(response); assert.equal(response.status, 200, JSON.stringify(data));
    return data.id as string;
  }
  async function rule(staffId: string, basis = 'unit', amount = 5000) {
    const response = await post(boss, '/operations/rules', { staff_id: staffId, name: basis, group_key: basis, basis, amount, milestone: 'delivered' });
    const data = await json(response); assert.equal(response.status, 200, JSON.stringify(data));
    return data.id as string;
  }
  function order(id: string, qty = 1, cost: number | null = 20000) {
    raw.prepare(`INSERT INTO orders(id,user_id,status,stage,shipping_type,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at)
      VALUES (?,'buyer','shipped','out_for_delivery','direct','{}','standard','{}','cash',?,1500,?,?,0,'2026-09-21T10:00:00Z')`).run(id, qty * 50000, qty * 50000, qty * 50000);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES (?,?,'printer','Printer',?,50000,?,?,'snapshot')`).run(`line:${id}`, id, qty, qty * 50000, cost);
    raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES (?,'printer','base',?,0,?,'opening','2026-09-01T10:00:00Z')`).run(`lot:${id}`, qty, cost);
    raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
      VALUES (?,?,?,?,'base',?,?,?,?)`).run(`alloc:${id}`, id, `line:${id}`, `lot:${id}`, qty, cost, cost === null ? null : qty * cost, `spent:${id}`);
  }
  async function deliver(id: string, day = '2026-09-25') {
    const deferred: Promise<unknown>[] = [];
    const result = await moveOrderStage(env, { orderId: id, to: 'delivered', source: 'delivery_api', now: `${day}T10:00:00Z`, defer: work => { deferred.push(work); } });
    assert.equal(result.moved, true, JSON.stringify(result));
    // Financial assertions run BEFORE deferred notifications/referrals, with
    // no cron or retrospective continuation request in this test path.
    return () => Promise.all(deferred);
  }
  return { raw, db, env, boss, self, staff, rule, order, deliver };
}

test('courier-confirmed delivery makes its current-version fixed wage available immediately while the historical job remains pending', async () => {
  const { raw, db, env, self, staff, rule, order, deliver } = setup();
  const id = await staff(); await rule(id); order('new-delivery');
  assert.equal((await json(await get(self, '/earnings'))).summary.available_earnings_iqd, 0);
  const finishNotifications = await deliver('new-delivery');
  const job = row(raw, 'SELECT state,processed_orders,cursor FROM finance_staff_reconciliations WHERE staff_id=?', id);
  assert.deepEqual(job, { state: 'pending', processed_orders: 0, cursor: '' });
  const sources = await participantSources(db, 'employee');
  assert.equal(sources.length, 1); assert.equal(sources[0].available_iqd, 5000); assert.equal(sources[0].blocked, 0);
  const entries = count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE source_type='order_cost'");
  await runOrderDeliveredEffects(env, 'new-delivery');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE source_type='order_cost'"), entries);
  assert.equal((await json(await get(self, '/earnings'))).summary.available_earnings_iqd, 5000);
  await finishNotifications();
});

test('unknown FIFO holds only profit-dependent wages; verifying the order cost releases that profit immediately without a bulk-job page', async () => {
  const { raw, db, boss, self, staff, rule, order, deliver } = setup();
  const id = await staff(); await rule(id); await rule(id, 'revenue_percent', 1000); await rule(id, 'profit_percent', 1000);
  order('missing-cost', 1, null);
  raw.exec("UPDATE order_items SET cost_iqd=20000 WHERE order_id='missing-cost'");
  const finishNotifications = await deliver('missing-cost');
  const amounts = all<{ rule_name: string; amount_iqd: number | null; state: string }>(raw, 'SELECT rule_name,amount_iqd,state FROM finance_order_costs WHERE staff_id=? ORDER BY rule_name', id);
  assert.deepEqual(amounts, [
    { rule_name: 'profit_percent', amount_iqd: null, state: 'pending_cost' },
    { rule_name: 'revenue_percent', amount_iqd: 5000, state: 'due' },
    { rule_name: 'unit', amount_iqd: 5000, state: 'due' },
  ]);
  assert.equal((await json(await get(self, '/earnings'))).summary.available_earnings_iqd, 10000);
  const response = await post(boss, '/workspace/orders/missing-cost/adjustments', {
    operation_id: 'verify-delivered-order-cost', field: 'cogs_iqd', line_id: 'line:missing-cost', value_iqd: 20000,
  });
  const data = await json(response); assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.reconciliation_pending, false);
  const profit = (await participantSources(db, 'employee')).find(source => source.title === 'profit_percent')!;
  assert.equal(profit.amount_iqd, 3000); assert.equal(profit.available_iqd, 3000);
  assert.equal((await json(await get(self, '/earnings'))).summary.available_earnings_iqd, 13000);
  assert.equal(row(raw, 'SELECT processed_orders FROM finance_staff_reconciliations WHERE staff_id=?', id)?.processed_orders, 0);
  assert.equal(row(raw, "SELECT unit_cost_iqd FROM order_item_inventory_allocations WHERE order_id='missing-cost'")?.unit_cost_iqd, null, 'verified per-order adjustment does not fabricate inventory cost');
  await finishNotifications();
});

test('proven sale-time cost without FIFO makes profit pay available on delivery, unaffected by today\'s catalogue cost', async () => {
  const { raw, db, staff, rule, order, deliver } = setup();
  const id = await staff(); await rule(id, 'profit_percent', 1000); order('recorded-checkout');
  raw.exec("DELETE FROM order_item_inventory_allocations WHERE order_id='recorded-checkout'; UPDATE products SET product_cost_iqd=49000 WHERE id='printer'");
  const finishNotifications = await deliver('recorded-checkout');
  const sources = await participantSources(db, 'employee');
  assert.equal(sources.length, 1); assert.equal(sources[0].amount_iqd, 3000);
  assert.equal(sources[0].available_iqd, 3000, '50,000 sale less recorded 20,000 cost, not today\'s 49,000 estimate');
  assert.equal(row(raw, 'SELECT processed_orders FROM finance_staff_reconciliations WHERE staff_id=?', id)?.processed_orders, 0);
  await finishNotifications();
});

test('a non-null unrecorded cost is not promoted into withdrawable profit on delivery', async () => {
  const { raw, db, staff, rule, order, deliver } = setup();
  const id = await staff(); await rule(id, 'profit_percent', 1000); order('unproven-cost');
  raw.exec("DELETE FROM order_item_inventory_allocations WHERE order_id='unproven-cost'; UPDATE order_items SET cost_basis='unrecorded' WHERE order_id='unproven-cost'");
  const finishNotifications = await deliver('unproven-cost');
  const source = (await participantSources(db, 'employee'))[0];
  assert.equal(source.state, 'pending_cost'); assert.equal(source.available_iqd, 0);
  assert.equal(row(raw, "SELECT amount_iqd FROM finance_order_costs WHERE order_id='unproven-cost'")?.amount_iqd, null);
  await finishNotifications();
});

test('immediate new wages still cover paid historical wages awaiting a negative cutoff correction before any withdrawal', async () => {
  const { raw, db, boss, self, staff, rule, order, deliver } = setup();
  const id = await staff(); await rule(id); order('old-paid', 2);
  await (await deliver('old-paid', '2026-09-22'))();
  const old = row<{ id: string }>(raw, "SELECT id FROM finance_order_costs WHERE order_id='old-paid'")!;
  assert.equal((await post(boss, `/operations/costs/${old.id}/approve`, {})).status, 200);
  const paid = await post(boss, `/operations/staff/${id}/payments`, { operation_id: 'pay-before-cutoff-change', amount_iqd: 10000, kind: 'payment' });
  assert.equal(paid.status, 200, JSON.stringify(await json(paid)));
  const changed = await patch(boss, `/people/staff/${id}`, { start_work_date: '2026-09-23' });
  assert.equal(changed.status, 200, JSON.stringify(await json(changed)));
  order('new-after-cutoff', 3);
  await (await deliver('new-after-cutoff'))();
  const current = row<{ id: string }>(raw, "SELECT id FROM finance_order_costs WHERE order_id='new-after-cutoff'")!;
  assert.equal((await post(boss, `/operations/costs/${current.id}/approve`, {})).status, 200);
  const sources = await participantSources(db, 'employee');
  assert.equal(sources.find(source => source.order_id === 'old-paid')?.blocked, 1);
  assert.equal(sources.find(source => source.order_id === 'new-after-cutoff')?.available_iqd, 15000);
  const earnings = await json(await get(self, '/earnings'));
  assert.equal(earnings.summary.available_earnings_iqd, 5000, '10,000 paid stale wages remain reserved against 15,000 new earnings');
  assert.equal(earnings.summary.paid_iqd, 10000);
  const excessive = await post(self, '/earnings/withdrawals', { operation_id: 'do-not-escape-historical-debt', amount_iqd: 5001 });
  assert.ok([400, 409].includes(excessive.status), JSON.stringify(await json(excessive)));
  const excessPayment = await post(boss, `/operations/staff/${id}/payments`, { operation_id: 'do-not-pay-historical-debt', amount_iqd: 5001, kind: 'payment' });
  assert.ok([400, 409].includes(excessPayment.status), JSON.stringify(await json(excessPayment)));
  assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_staff_payments WHERE id='do-not-pay-historical-debt'"), 0);
  const payment = { operation_id: 'pay-only-net-new-wages', amount_iqd: 5000, kind: 'payment' };
  const allowed = await post(boss, `/operations/staff/${id}/payments`, payment);
  assert.equal(allowed.status, 200, JSON.stringify(await json(allowed)));
  const replay = await post(boss, `/operations/staff/${id}/payments`, payment);
  assert.equal(replay.status, 200);
  assert.equal((await json(replay)).already, true);
  assert.equal(row(raw, 'SELECT SUM(amount_iqd) amount FROM finance_staff_payments WHERE staff_id=?', id)?.amount, 15000);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_payment_allocations WHERE payment_id='pay-only-net-new-wages'"), 1);
  assert.equal(row(raw, "SELECT SUM(amount_iqd) amount FROM finance_payment_allocations WHERE payment_id='pay-only-net-new-wages'")?.amount, 5000);
  assert.equal((await json(await get(self, '/earnings'))).summary.available_earnings_iqd, 0);
  assert.equal(row(raw, 'SELECT processed_orders FROM finance_staff_reconciliations WHERE staff_id=?', id)?.processed_orders, 0);
});
