import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, failingD1, stubApp, post, get, json, count, row } from './fixtures/app';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { runOrderFinancialEffects } from '../worker/lib/orderFinance';
import type { Env } from '../worker/lib/types';

async function setup(basis: string, amount: number) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),('employee','employee@x.co','Employee','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO catalogs(id,name_ar,slug) VALUES ('printers','الطابعات','wage-printers');
    INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode,category_id) VALUES
    ('a','A1','wage-a1',50000,0,'BASE','printers'),('b','P1','wage-p1',50000,0,'BASE','printers'),('excluded','Excluded','wage-excluded',50000,0,'BASE','printers');`);
  const { db } = failingD1(raw);
  const app = (id: string) => stubApp(db, { id, email: `${id}@x.co`, role: 'admin', admin_scope: id === 'boss' ? 'full' : 'assistant' }, a => {
    a.route('/people', adminFinancePeopleRoutes);
    a.route('/operations', adminFinanceOperationsRoutes);
    a.route('/earnings', financeEarningsRoutes);
  });
  const boss = app('boss'), self = app('employee'), env = { DB: db } as Env;
  const scope = { catalog_ids: ['printers'], product_ids: [], excluded_product_ids: ['excluded'] };
  const staff = await json(await post(boss, '/people/staff', { user_id: 'employee', start_work_date: '2026-08-31' }));
  const ruleResponse = await post(boss, '/operations/rules', { staff_id: staff.id, basis, amount, scope });
  const rule = await json(ruleResponse);
  assert.equal(ruleResponse.status, 200, JSON.stringify(rule));
  async function order(id: string, lines: Array<[string, number]>) {
    const total = lines.reduce((sum, [, qty]) => sum + qty * 50000, 0);
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1500,?,?,0,'2026-09-01T00:00:00Z','2026-09-20T12:00:00Z')`).run(id, total, total, total);
    for (const [product, qty] of lines) {
      const key = `${id}:${product}`;
      raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
        VALUES (?,?,?,'Printer',?,50000,?,30000,'snapshot')`).run(key, id, product, qty, qty * 50000);
      raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
        VALUES (?,?,'base',?,0,30000,'opening','2026-09-01T00:00:00Z')`).run(key, product, qty);
      raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
        VALUES (?,?,?,?,'base',?,30000,?,?)`).run(key, id, key, key, qty, qty * 30000, key);
    }
    await runOrderFinancialEffects(env, id, 'delivered');
  }
  async function drain() {
    for (let i = 0; i < 10; i++) {
      const response = await post(boss, `/people/staff/${staff.id}/reconcile`, {}), result = await json(response);
      assert.equal(response.status, 200, JSON.stringify(result));
      if (result.reconciliation.state === 'complete') return;
    }
    assert.fail('Reconciliation did not complete');
  }
  const earnings = async () => (await json(await get(self, '/earnings'))).summary;
  return { raw, boss, env, rule, scope, order, drain, earnings };
}

for (const [basis, amount, expected] of [['unit', 5000, 30000], ['order', 5000, 5000], ['revenue_percent', 1000, 30000], ['profit_percent', 1000, 12000]] as const) {
  test(`${basis}: six eligible printers across two lines use the selected basis once, excluding a seventh printer`, async () => {
    const x = await setup(basis, amount);
    await x.order('mixed', [['a', 4], ['b', 2], ['excluded', 1]]);
    await x.order('only-excluded', [['excluded', 6]]);
    await x.drain();
    assert.equal((await x.earnings()).earned_iqd, expected);
    assert.equal((await x.earnings()).available_earnings_iqd, expected);
    assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_order_costs WHERE order_id='only-excluded'"), 0);
    assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_order_costs WHERE order_id='mixed'"), basis === 'order' ? 1 : 2);
    const entries = count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries');
    await runOrderFinancialEffects(x.env, 'mixed', 'delivered');
    await x.drain();
    assert.equal((await x.earnings()).earned_iqd, expected);
    assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries'), entries);
  });
}

test('changing six-unit pay to whole-order pay previews and posts only the difference, preserving the historical basis', async () => {
  const x = await setup('unit', 5000);
  await x.order('mixed', [['a', 4], ['b', 2], ['excluded', 1]]);
  await x.drain();
  const body = { basis: 'order', amount: 5000, scope: x.scope, effective_from: '2026-09-15', reason: 'اتفاق على أجر الطلب كاملًا', version: row(x.raw, 'SELECT version FROM finance_cost_rules WHERE id=?', x.rule.id)!.version };
  const previewResponse = await post(x.boss, `/people/rules/${x.rule.id}/preview`, body), preview = await json(previewResponse);
  assert.equal(previewResponse.status, 200, JSON.stringify(preview));
  assert.equal(preview.complete, true);
  assert.equal(preview.previous_iqd, 30000);
  assert.equal(preview.corrected_iqd, 5000);
  assert.equal(preview.delta_iqd, -25000);
  const operation = { ...body, preview_token: preview.preview_token, preview_job_id: preview.preview_job_id, operation_id: 'whole-order-pay-change' };
  const response = await post(x.boss, `/people/rules/${x.rule.id}/apply`, operation);
  assert.equal(response.status, 200, JSON.stringify(await json(response)));
  await x.drain();
  assert.equal((await x.earnings()).earned_iqd, 5000);
  assert.equal(count(x.raw, 'SELECT SUM(delta_iqd) n FROM finance_cost_adjustments'), -30000);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_wage_versions WHERE json_extract(snapshot,'$.basis')='unit'"), 1);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_wage_versions WHERE json_extract(snapshot,'$.basis')='order'"), 1);
  assert.equal((await post(x.boss, `/people/rules/${x.rule.id}/apply`, operation)).status, 200);
  await x.drain();
  assert.equal((await x.earnings()).earned_iqd, 5000);
});
