import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, count, freshDb, json, post, row, stubApp } from './fixtures/app';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { getOrderProfitBase } from '../worker/lib/orderProfit';
import { runOrderFinancialEffects, type CostRule } from '../worker/lib/orderFinance';
import { participantSources, participantSummary, reconcileStaffOrderCosts } from '../worker/lib/financeParticipants';
import { reconcileEffectiveWages } from '../worker/lib/financeWageCalculation';
import type { Env } from '../worker/lib/types';

function setup() {
  const raw = freshDb(), db = asD1(raw), env = { DB: db } as Env;
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),('employee','employee@x.co','Worker','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('p','Printer','refund-wage-trust',50000,10000);
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('wages','refund-wage-trust','أجور');
    INSERT INTO orders(id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES ('order','buyer','delivered','delivered','{}','standard','{}','cash',150000,1500,150000,150000,0,'2026-09-01T00:00:00Z','2026-09-22T10:00:00Z');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES ('line','order','p','Printer',3,50000,150000,10000,'snapshot');
    INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution)
      VALUES ('returned','order','line','buyer',1,'shipping_damage','resolved','refund');
    INSERT INTO stock_return_inspections(id,order_item_id,qty,disposition,actor_id,created_at,return_case_id)
      VALUES ('inspection','line',1,'damage','boss','2026-09-23','returned');`);
  const app = stubApp(db, { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, a => {
    a.route('/people', adminFinancePeopleRoutes);
    a.route('/operations', adminFinanceOperationsRoutes);
  });
  const knownRefund = (amount: number) => raw.prepare(`INSERT INTO finance_refund_facts(case_id,order_id,refund_iqd,qty,disposition,cogs_iqd,channel,refunded_day)
    VALUES ('returned','order',?,1,'damage',0,'wallet','2026-09-23')`).run(amount);
  const costs = () => all<{ rule_name: string; amount_iqd: number | null; state: string }>(raw,
    'SELECT rule_name,amount_iqd,state FROM finance_order_costs WHERE order_id=? ORDER BY rule_name', 'order');
  const available = async () => participantSummary(await participantSources(db, 'employee')).available_earnings_iqd;
  return { raw, db, env, app, knownRefund, costs, available };
}

function freezeLegacyRules(x: ReturnType<typeof setup>, pending = false) {
  x.raw.exec("UPDATE finance_staff SET user_id='employee' WHERE id='staff_hussein'");
  const rules = (['profit_percent', 'revenue_percent'] as const).map((basis): CostRule => ({
    id: basis, version: 1, name: basis, group_key: basis, staff_id: 'staff_hussein', category_id: 'wages', center_id: null,
    basis, amount: 1000, target_type: 'all', target_id: '', milestone: 'delivered', requires_assignment: 0,
    cap_iqd: null, priority: 0, effective_from: '2026-09-01', effective_to: null, created_at: '2026-09-01T00:00:00Z',
  }));
  x.raw.prepare('INSERT INTO finance_order_snapshots(order_id,rules_json,created_at) VALUES (?,?,?)')
    .run('order', JSON.stringify([{ line_id: 'line', product_id: 'p', rules }]), '2026-09-01');
  if (pending) for (const rule of rules) x.raw.prepare(`INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot)
    VALUES (?,'order','line',?,1,?,?,?,'wages','delivered',NULL,3,NULL,'2026-09-22','pending_cost',?)`)
    .run(rule.id, rule.id, rule.name, rule.group_key, rule.staff_id, JSON.stringify({ rule }));
}

const pendingPercentages = [
  { rule_name: 'profit_percent', amount_iqd: null, state: 'pending_cost' },
  { rule_name: 'revenue_percent', amount_iqd: null, state: 'pending_cost' },
];
const knownPercentages = [
  { rule_name: 'profit_percent', amount_iqd: 7000, state: 'due' },
  { rule_name: 'revenue_percent', amount_iqd: 10000, state: 'due' },
];

test('native delivery/retry never finalizes percentage wages while a historical refund amount is unknown', async () => {
  const x = setup(); freezeLegacyRules(x);
  const base = await getOrderProfitBase(x.db, 'order');
  assert.equal(base.lines[0].cost_confidence, 'recorded_snapshot');
  assert.equal(base.lines[0].gross_profit_iqd, null);
  assert.ok(base.lines[0].cost_review?.issues.some(issue => issue.code === 'refund_amount_missing'));
  await runOrderFinancialEffects(x.env, 'order', 'delivered');
  assert.deepEqual(x.costs(), pendingPercentages);
  assert.equal(await x.available(), 0);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE source_type='order_cost'"), 0);
  x.knownRefund(50000);
  await runOrderFinancialEffects(x.env, 'order', 'delivered');
  assert.deepEqual(x.costs(), knownPercentages);
  assert.equal(await x.available(), 17000);
  const entries = count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries');
  await runOrderFinancialEffects(x.env, 'order', 'delivered');
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries'), entries);
  assert.equal(await x.available(), 17000);
});

test('legacy pending wages require a known retained-sales basis, then materialize once after the refund is documented', async () => {
  const x = setup(); freezeLegacyRules(x, true);
  await reconcileStaffOrderCosts(x.db, 'order', { actor: 'boss', day: '2026-10-05' });
  assert.deepEqual(x.costs(), pendingPercentages);
  assert.equal(await x.available(), 0);
  x.knownRefund(50000);
  await reconcileStaffOrderCosts(x.db, 'order', { actor: 'boss', day: '2026-10-05' });
  assert.deepEqual(x.costs(), knownPercentages);
  assert.equal(await x.available(), 17000);
  const entries = count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries');
  await reconcileStaffOrderCosts(x.db, 'order', { actor: 'boss', day: '2026-10-05' });
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries'), entries);
});

test('effective wages hold unknown refund percentages while independent unit/order pay uses remaining sold units', async () => {
  const x = setup();
  const staffResponse = await post(x.app, '/people/staff', { user_id: 'employee', start_work_date: '2026-09-20' });
  const staff = await json(staffResponse); assert.equal(staffResponse.status, 200, JSON.stringify(staff));
  for (const [basis, amount] of [['unit', 5000], ['order', 2500], ['profit_percent', 1000], ['revenue_percent', 1000]] as const) {
    const response = await post(x.app, '/operations/rules', { staff_id: staff.id, name: basis, group_key: basis, basis, amount,
      category_id: 'wages', milestone: 'delivered', effective_from: '2026-09-01' });
    assert.equal(response.status, 200, JSON.stringify(await json(response)));
  }
  await reconcileEffectiveWages(x.db, 'order', { actor: 'boss', day: '2026-10-05' });
  assert.deepEqual(x.costs(), [
    { rule_name: 'order', amount_iqd: 2500, state: 'due' }, ...pendingPercentages,
    { rule_name: 'unit', amount_iqd: 10000, state: 'due' },
  ]);
  assert.equal(row(x.raw, "SELECT qty FROM finance_order_costs WHERE rule_name='unit'")?.qty, 2);
  assert.equal(await x.available(), 12500);
  x.knownRefund(50000);
  await reconcileStaffOrderCosts(x.db, 'order', { actor: 'boss', day: '2026-10-05' });
  assert.deepEqual(x.costs(), [
    { rule_name: 'order', amount_iqd: 2500, state: 'due' }, ...knownPercentages,
    { rule_name: 'unit', amount_iqd: 10000, state: 'due' },
  ]);
  assert.equal(await x.available(), 29500);
  const entries = count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries');
  await reconcileStaffOrderCosts(x.db, 'order', { actor: 'boss', day: '2026-10-05' });
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries'), entries);
});

test('a documented zero refund is known revenue and does not leave percentage wages permanently pending', async () => {
  const x = setup(); freezeLegacyRules(x, true); x.knownRefund(0);
  await reconcileStaffOrderCosts(x.db, 'order', { actor: 'boss', day: '2026-10-05' });
  assert.deepEqual(x.costs(), [
    { rule_name: 'profit_percent', amount_iqd: 12000, state: 'due' },
    { rule_name: 'revenue_percent', amount_iqd: 15000, state: 'due' },
  ]);
  assert.equal(await x.available(), 27000);
});

test('a newly discovered unknown historical refund blocks already-earned percentages after reconciliation without rewriting paid history', async () => {
  const x = setup(); freezeLegacyRules(x);
  x.raw.exec('DELETE FROM stock_return_inspections; DELETE FROM return_cases;');
  await runOrderFinancialEffects(x.env, 'order', 'delivered');
  assert.equal(await x.available(), 27000);
  for (const cost of all<{ id: string }>(x.raw, 'SELECT id FROM finance_order_costs WHERE order_id=?', 'order')) {
    const response = await post(x.app, `/operations/costs/${cost.id}/approve`, {});
    assert.equal(response.status, 200, JSON.stringify(await json(response)));
  }
  const paid = await post(x.app, '/operations/staff/staff_hussein/payments', { operation_id: 'pay-before-unknown-refund', amount_iqd: 9000, kind: 'payment' });
  assert.equal(paid.status, 200, JSON.stringify(await json(paid)));
  const original = x.costs(), posted = count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries');
  x.raw.exec(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution)
      VALUES ('returned','order','line','buyer',1,'shipping_damage','resolved','refund');
    INSERT INTO stock_return_inspections(id,order_item_id,qty,disposition,actor_id,created_at,return_case_id)
      VALUES ('inspection','line',1,'damage','boss','2026-09-23','returned');`);
  await reconcileStaffOrderCosts(x.db, 'order', { actor: 'boss', day: '2026-10-05' });
  assert.deepEqual(x.costs(), original, 'the unknown refund does not invent a replacement amount');
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries'), posted);
  assert.equal(await x.available(), 0, 'a refreshed fingerprint cannot release a percentage whose retained sales are unknown');
  assert.equal(row(x.raw, 'SELECT SUM(amount_iqd) amount FROM finance_staff_payments')?.amount, 9000);
  x.knownRefund(50000);
  await reconcileStaffOrderCosts(x.db, 'order', { actor: 'boss', day: '2026-10-05' });
  assert.deepEqual(x.costs(), original, 'corrections remain separate from original wage records');
  assert.equal(await x.available(), 8000, '17,000 corrected earnings less the original 9,000 payment');
  assert.equal(row(x.raw, 'SELECT SUM(amount_iqd) amount FROM finance_staff_payments')?.amount, 9000);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key='staff-payment:pay-before-unknown-refund'"), 1);
});
