import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, count, freshDb, get, json, post, row, stubApp } from './fixtures/app';
import { adminStockOperationsRoutes } from '../worker/routes/adminStockOperations';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { baghdadDay } from '../worker/lib/operations';

function setup(assistant = false) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role,admin_scope) VALUES
    ('operator','operator@example.test','admin',${assistant ? "'assistant'" : "'full'"}),
    ('usr_owner','boss@x.co','admin',NULL),
    ('buyer','buyer@example.test','customer',NULL);
    INSERT INTO products(id,name,name_ar,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode)
    VALUES ('printer','Printer','طابعة','cap-printer','CAP-PRINTER',50000,10000,1,'BASE');
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
    VALUES ('order','buyer','delivered','{}','standard','{}','cash',50000,1500,55000,55000);
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd)
    VALUES ('item','order','printer','طابعة',1,50000,50000);
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('wages','cap-wages','أجور');`);
  const app = stubApp(asD1(raw), {
    id: 'operator', email: 'operator@example.test', role: 'admin', admin_scope: assistant ? 'assistant' : 'full',
  }, (a) => {
    a.route('/s', adminStockOperationsRoutes);
    a.route('/f', adminFinanceOperationsRoutes);
  });
  // The OWNER of every stubApp (INITIAL_ADMIN_EMAIL boss@x.co): payroll and
  // wages are cost, the owner's alone (owner decision 2).
  const owner = stubApp(asD1(raw), { id: 'usr_owner', email: 'boss@x.co', role: 'admin' }, (a) => {
    a.route('/s', adminStockOperationsRoutes);
    a.route('/f', adminFinanceOperationsRoutes);
  });
  const permission = (capability: string, allowed: number) => raw.prepare(
    'INSERT INTO ops_permissions(user_id,capability,allowed) VALUES (?,?,?) ON CONFLICT(user_id,capability) DO UPDATE SET allowed=excluded.allowed',
  ).run('operator', capability, allowed);
  return { raw, app, owner, permission };
}

function lot(raw: ReturnType<typeof freshDb>, id: string, remaining = 0) {
  raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
    VALUES (?,'printer','base','',1,?,10000,'opening','2026-10-01T09:00:00.000Z')`).run(id, remaining);
}

function cost(raw: ReturnType<typeof freshDb>, id: string, staff = 'staff_sajjad', amount: number | null = 5000) {
  raw.prepare(`INSERT INTO finance_order_costs(id,order_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot)
    VALUES (?,'order',?,1,'تجهيز','preparation',?,'wages','delivered',40000,1,?,?,?,'{}')`)
    .run(id, `rule-${id}`, staff, amount, baghdadDay(), amount === null ? 'pending_cost' : 'due');
}

test('receiving staff can trace consumed lots and inspect returns with transfer access denied and costs hidden', async () => {
  const { raw, app, permission } = setup(true);
  permission('transfer', 0);
  permission('receive', 1);
  lot(raw, 'consumed-lot');
  raw.exec(`INSERT INTO serial_inventory(serial_norm,serial_raw,model_name,product_id,created_by)
    VALUES ('03900D661012388','03900D661012388','Printer','printer','operator');
    INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state)
    VALUES ('return','order','item','buyer',1,'defective','requested');`);
  assert.equal((await get(app, '/s/locations')).status, 403);
  const linked = await post(app, '/s/serial-link', { serial_norm: '03900D661012388', lot_id: 'consumed-lot' });
  assert.equal(linked.status, 200, JSON.stringify(await json(linked)));
  const response = await get(app, '/s/trace');
  const trace = await json(response);
  assert.equal(response.status, 200);
  assert.equal(trace.lots[0].id, 'consumed-lot');
  assert.equal(trace.lots[0].qty_remaining, 0);
  assert.equal(trace.links[0].serial_norm, '03900D661012388');
  assert.equal('unit_cost_iqd' in trace.links[0], false);
  assert.equal('unit_cost_iqd' in trace.lots[0], false);
  assert.equal(trace.returns[0].id, 'return');
  const inspected = await post(app, '/s/return-inspections', {
    operation_id: crypto.randomUUID(), return_case_id: 'return', disposition: 'quarantine',
  });
  assert.equal(inspected.status, 200, JSON.stringify(await json(inspected)));
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM stock_return_inspections'), 1);
});

test('trace lot search is bounded and paginated, and denied receiving cannot read it', async () => {
  const { raw, app, permission } = setup(true);
  permission('transfer', 0);
  for (let i = 0; i < 205; i++) lot(raw, `purchase-${String(i).padStart(3, '0')}`);
  const first = await json(await get(app, '/s/trace?q=CAP-PRINTER'));
  const next = await json(await get(app, '/s/trace?q=CAP-PRINTER&offset=200'));
  assert.equal(first.lots.length, 200);
  assert.equal(next.lots.length, 5);
  assert.equal(first.limit, 200);
  assert.equal(new Set([...first.lots, ...next.lots].map((l: { id: string }) => l.id)).size, 205);
  assert.equal((await json(await get(app, '/s/trace?q=purchase-204'))).lots.length, 1);
  assert.equal((await get(app, '/s/trace?offset=-1')).status, 400);
  permission('receive', 0);
  assert.equal((await get(app, '/s/trace')).status, 403);
});

test('a full-scope operator with the pay permission is refused payroll at the cost door; the owner reviews, approves and settles wages', async () => {
  const { raw, app, owner, permission } = setup();
  permission('rules', 0);
  permission('pay', 1);
  cost(raw, 'earned');
  cost(raw, 'free', 'staff_sajjad', 0);
  cost(raw, 'unknown', 'staff_sajjad', null);
  // Owner decision 2: a wage is cost, so no permission row opens it to a
  // full-scope admin — every finance-operations route refuses, writes nothing.
  for (const path of ['/f/rules', '/f/costs', '/f/payroll?staff_id=staff_sajjad']) {
    const refused = await get(app, path);
    assert.equal(refused.status, 403, path);
    assert.equal((await json(refused)).code, 'COST_ACCESS_DENIED');
  }
  assert.equal((await post(app, '/f/costs/earned/approve')).status, 403);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM finance_order_costs WHERE id='earned'")?.state, 'due');
  const res = await get(owner, '/f/payroll?staff_id=staff_sajjad');
  const payroll = await json(res);
  assert.equal(res.status, 200);
  assert.equal(payroll.costs.length, 3);
  assert.equal(payroll.costs.find((c: { id: string }) => c.id === 'free').amount_iqd, 0);
  assert.equal(payroll.costs.find((c: { id: string }) => c.id === 'unknown').amount_iqd, null);
  assert.equal(payroll.staff.find((s: { id: string }) => s.id === 'staff_sajjad').due_iqd, 5000);
  assert.equal((await post(owner, '/f/costs/earned/approve')).status, 200);
  const paid = await post(owner, '/f/staff/staff_sajjad/payments', {
    operation_id: crypto.randomUUID(), amount_iqd: 2000, kind: 'payment',
  });
  assert.equal(paid.status, 200, JSON.stringify(await json(paid)));
  const updated = await json(await get(owner, '/f/payroll?staff_id=staff_sajjad'));
  assert.equal(updated.costs.find((c: { id: string }) => c.id === 'earned').paid_iqd, 2000);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM finance_order_costs WHERE id='earned'")?.state, 'approved');
});

test('payroll costs retain staff filtering and 100-row pages for the owner, and a full operator stays refused', async () => {
  const { raw, app, owner, permission } = setup();
  permission('rules', 0);
  for (let i = 0; i < 105; i++) cost(raw, `cost-${String(i).padStart(3, '0')}`);
  cost(raw, 'other-person', 'staff_hussein');
  const first = await json(await get(owner, '/f/payroll?staff_id=staff_sajjad'));
  const next = await json(await get(owner, '/f/payroll?staff_id=staff_sajjad&offset=100'));
  assert.equal(first.costs.length, 100);
  assert.equal(next.costs.length, 5);
  assert.equal(new Set([...first.costs, ...next.costs].map((c: { id: string }) => c.id)).size, 105);
  assert.ok([...first.costs, ...next.costs].every((c: { staff_id: string }) => c.staff_id === 'staff_sajjad'));
  assert.equal((await get(owner, '/f/payroll?offset=100001')).status, 400);
  // A permission row neither opens nor closes payroll for a full-scope admin:
  // the cost door refuses first (owner decision 2).
  permission('pay', 1);
  assert.equal((await get(app, '/f/payroll')).status, 403);
  permission('pay', 0);
  assert.equal((await get(app, '/f/payroll')).status, 403);
});

test('assistant scope cannot gain financial payroll data by enabling payment permission', async () => {
  const { app, permission } = setup(true);
  permission('pay', 1);
  assert.equal((await get(app, '/f/payroll')).status, 403);
});
