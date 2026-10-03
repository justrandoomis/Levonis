import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, failingD1, stubApp, get, post, json, count, row } from './fixtures/app';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import {
  planOrderFinanceSnapshot,
  recordFinancialFailure,
  recordReturnFinancials,
  runOrderFinancialEffects,
} from '../worker/lib/orderFinance';
import { baghdadDay } from '../worker/lib/operations';
import { operationsReport } from '../worker/lib/operationsReport';
import type { Env } from '../worker/lib/types';

function setup(cost: number | null = 10000) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role) VALUES ('admin','boss@x.co','admin'),('buyer','buyer@example.test','customer');
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('wages','reconciliation-wages','أجور');
    INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode) VALUES ('printer','Printer','reconciliation-printer',50000,0,'BASE');`);
  const at = new Date().toISOString();
  raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
    VALUES ('order','buyer','delivered','{}','standard','{}','cash',50000,1500,55000,55000,5000,?,?)`).run(at, at);
  raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
    VALUES ('item','order','printer','طابعة',2,25000,50000,?,'snapshot')`).run(cost);
  raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
    VALUES ('lot','printer','base','',2,0,?,'opening',?)`).run(cost, at);
  raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
    VALUES ('alloc','order','item','lot','base','',2,?,?,'allocation')`).run(cost, cost === null ? null : cost * 2);
  const { db, failing } = failingD1(raw);
  const app = stubApp(db, { id: 'admin', email: 'boss@x.co', role: 'admin' }, (a) => a.route('/f', adminFinanceOperationsRoutes));
  return { raw, db, failing, app, env: { DB: db } as Env };
}
const collection = () => ({ operation_id: crypto.randomUUID(), order_id: 'order', payer: 'courier', amount_iqd: 55000 });
const balance = (raw: ReturnType<typeof freshDb>, account: string) =>
  count(raw, 'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines WHERE account_code=?', account);
function assertSettled(raw: ReturnType<typeof freshDb>) {
  assert.equal(balance(raw, '1100'), 0, 'receivable cleared');
  assert.equal(balance(raw, '2300'), 0, 'advance cleared');
  assert.equal(balance(raw, '1000'), 55000, 'cash received once');
  assert.equal(balance(raw, '4000'), -50000, 'goods revenue recognised once');
  assert.equal(balance(raw, '4100'), -5000, 'shipping revenue recognised once');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key='sale:order'"), 1);
  assert.equal(count(raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
}

test('pending profit cost follows reassignment immediately and keeps that employee after FIFO resolves', async () => {
  const { raw, db, app, env } = setup(null);
  const created = await post(app, '/f/rules', {
    name: 'تجهيز', group_key: 'preparation', target_type: 'all', basis: 'profit_percent', amount: 1000,
    staff_id: 'staff_sajjad', category_id: 'wages', milestone: 'delivered',
  });
  assert.equal(created.status, 200, JSON.stringify(await json(created)));
  await db.batch(await planOrderFinanceSnapshot(db, 'order', [{ id: 'item', product_id: 'printer' }], new Date().toISOString()));
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assert.equal(row(raw, 'SELECT staff_id FROM finance_order_costs')?.staff_id, 'staff_sajjad');
  const assigned = await post(app, '/f/orders/order/assignment', { group_key: 'preparation', staff_id: 'staff_hussein', completed: false });
  assert.equal(assigned.status, 200, JSON.stringify(await json(assigned)));
  assert.deepEqual(row(raw, 'SELECT staff_id,state FROM finance_order_costs'), { staff_id: 'staff_hussein', state: 'pending_cost' });
  raw.exec('UPDATE order_item_inventory_allocations SET unit_cost_iqd=10000,cogs_iqd=20000');
  await runOrderFinancialEffects(env, 'order', 'delivered');
  const cost = row<{ id: string; staff_id: string; state: string; amount_iqd: number; snapshot_staff: string }>(raw,
    "SELECT id,staff_id,state,amount_iqd,json_extract(snapshot,'$.staff_id') snapshot_staff FROM finance_order_costs")!;
  assert.equal(cost.staff_id, 'staff_hussein');
  assert.equal(cost.snapshot_staff, 'staff_hussein');
  assert.equal(cost.state, 'due');
  assert.equal(cost.amount_iqd, 3000);
  assert.equal((await post(app, `/f/costs/${cost.id}/approve`, {})).status, 200);
  assert.equal((await post(app, '/f/staff/staff_hussein/payments', { operation_id: crypto.randomUUID(), amount_iqd: 3000 })).status, 200);
});

test('delivered order collected before sale posting clears the actual advance and replays once', async () => {
  const { raw, env, app } = setup();
  const receipt = collection();
  assert.equal((await post(app, '/f/collections', receipt)).status, 200);
  assert.equal(balance(raw, '2300'), -55000);
  assert.equal(balance(raw, '1100'), 0);
  await runOrderFinancialEffects(env, 'order', 'delivered');
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assert.equal((await post(app, '/f/collections', receipt)).status, 200);
  assertSettled(raw);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_collections'), 1);
});

test('collection after sale posting clears the receivable without creating an advance', async () => {
  const { raw, env, app } = setup();
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assert.equal(balance(raw, '1100'), 55000);
  assert.equal((await post(app, '/f/collections', collection())).status, 200);
  assertSettled(raw);
});

test('failed sale posting accepts actual receipt as advance and retry posts one sale with no stray balances', async () => {
  const { raw, failing, env, app } = setup();
  failing.failWhen = (statements) => statements.some((s) => s.params.includes('sale:order'));
  await assert.rejects(runOrderFinancialEffects(env, 'order', 'delivered'), /simulated D1 failure/);
  await recordFinancialFailure(env.DB, 'order', 'delivered', new Error('simulated D1 failure'));
  failing.failWhen = null;
  assert.equal((await post(app, '/f/collections', collection())).status, 200);
  assert.equal(balance(raw, '2300'), -55000);
  assert.equal((await post(app, '/f/orders/order/retry-posting', { day: baghdadDay() })).status, 200);
  assertSettled(raw);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_posting_errors'), 0);
});

// These synchronous hooks stand in for a second request committing after
// the first request's reads but before its D1 batch starts.
function commitCompetingSale(raw: ReturnType<typeof freshDb>) {
  raw.prepare(`INSERT INTO accounting_entries(id,event_key,entry_day,title,source_type,source_id,created_at)
    VALUES ('competing-sale','sale:order',?,'Sale','order','order',?)`).run(baghdadDay(), new Date().toISOString());
  raw.exec(`INSERT INTO accounting_lines(id,entry_id,account_code,debit_iqd,credit_iqd) VALUES
    ('cs-receivable','competing-sale','1100',55000,0),('cs-goods','competing-sale','4000',0,50000),('cs-shipping','competing-sale','4100',0,5000);
    UPDATE accounting_entries SET state='posted' WHERE id='competing-sale';`);
}
function commitCompetingAdvance(raw: ReturnType<typeof freshDb>) {
  raw.prepare(`INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at)
    VALUES ('competing-receipt','order','courier',55000,?,'admin',?)`).run(baghdadDay(), new Date().toISOString());
  raw.prepare(`INSERT INTO accounting_entries(id,event_key,entry_day,title,source_type,source_id,created_at)
    VALUES ('competing-collection','collection:competing-receipt',?,'Collection','collection','competing-receipt',?)`).run(baghdadDay(), new Date().toISOString());
  raw.exec(`INSERT INTO accounting_lines(id,entry_id,account_code,debit_iqd,credit_iqd) VALUES
    ('cc-cash','competing-collection','1000',55000,0),('cc-advance','competing-collection','2300',0,55000);
    UPDATE accounting_entries SET state='posted' WHERE id='competing-collection';`);
}
test('collection rolls back when sale posts concurrently, then retry uses the receivable', async () => {
  const { raw, failing, env, app } = setup();
  failing.beforeBatch = (statements) => {
    if (!statements.some((s) => s.sql.includes('INSERT INTO finance_collections'))) return;
    failing.beforeBatch = null;
    commitCompetingSale(raw);
  };
  const receipt = collection();
  assert.notEqual((await post(app, '/f/collections', receipt)).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_collections'), 0);
  assert.equal(balance(raw, '1000'), 0);
  assert.equal((await post(app, '/f/collections', receipt)).status, 200);
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assertSettled(raw);
});
test('sale rolls back when a collection commits concurrently, then retry consumes the advance', async () => {
  const { raw, failing, env } = setup();
  failing.beforeBatch = (statements) => {
    if (!statements.some((s) => s.params.includes('sale:order'))) return;
    failing.beforeBatch = null;
    commitCompetingAdvance(raw);
  };
  await assert.rejects(runOrderFinancialEffects(env, 'order', 'delivered'), /CHECK constraint/);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key='sale:order'"), 0);
  assert.equal(balance(raw, '2300'), -55000);
  await runOrderFinancialEffects(env, 'order', 'delivered');
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assertSettled(raw);
});

function seedGini(raw: ReturnType<typeof freshDb>) {
  raw.exec("UPDATE orders SET gini_paid_iqd=50000,due_on_delivery_iqd=5000 WHERE id='order'");
  raw.prepare(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at)
    VALUES ('gini-return','order','item','buyer',1,'defective','resolved','refund',?)`).run(new Date().toISOString());
}
async function refundGini(env: Env) {
  await recordReturnFinancials(env, {
    caseId: 'gini-return', orderId: 'order', itemId: 'item', refundIqd: 25000, qty: 1,
    restocked: false, actor: 'admin', day: baghdadDay(), channel: 'gini',
  });
}
function bankReceipt(amount = 50000) {
  return { operation_id: crypto.randomUUID(), order_id: 'order', payer: 'bank', amount_iqd: amount };
}
const doorReceipt = () => ({ operation_id: crypto.randomUUID(), order_id: 'order', payer: 'courier', amount_iqd: 5000 });

test('Gini refund before bank settlement reduces only bank collection limit and leaves door due independent', async () => {
  const { raw, env, app } = setup();
  seedGini(raw);
  await runOrderFinancialEffects(env, 'order', 'delivered');
  await refundGini(env);
  const before = (await json(await get(app, '/f/receivables'))).orders[0];
  assert.equal(before.bank_expected_iqd, 25000);
  assert.equal(before.bank_balance_iqd, 25000);
  assert.equal(before.door_balance_iqd, 5000);
  assert.equal(before.balance_iqd, 30000);
  assert.equal((await post(app, '/f/collections', bankReceipt(25001))).status, 400);
  assert.equal((await post(app, '/f/collections', bankReceipt(25000))).status, 200);
  assert.equal((await post(app, '/f/collections', bankReceipt(1))).status, 400);
  assert.equal((await post(app, '/f/collections', doorReceipt())).status, 200);
  assert.equal(balance(raw, '1100'), 0);
  assert.equal(balance(raw, '1000'), 30000);
  assert.equal((await json(await get(app, '/f/receivables'))).orders.length, 0);
});

test('Gini refund after full settlement exposes bank credit without reversing cash or creating another expense', async () => {
  const { raw, db, env, app } = setup();
  seedGini(raw);
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assert.equal((await post(app, '/f/collections', bankReceipt())).status, 200);
  assert.equal((await post(app, '/f/collections', doorReceipt())).status, 200);
  await refundGini(env);
  await refundGini(env);
  const after = (await json(await get(app, '/f/receivables'))).orders[0];
  assert.equal(after.bank_balance_iqd, -25000);
  assert.equal(after.bank_credit_balance_iqd, 25000);
  assert.equal(after.door_balance_iqd, 0);
  assert.equal(after.receivable_iqd, 0);
  assert.equal(after.balance_iqd, -25000);
  assert.equal((await post(app, '/f/collections', bankReceipt(1))).status, 400);
  assert.equal((await post(app, '/f/collections', { ...doorReceipt(), amount_iqd: 1 })).status, 400);
  assert.equal(balance(raw, '1000'), 55000, 'actual received cash is retained');
  assert.equal(balance(raw, '1100'), -25000, 'credit is the bank settlement due');
  assert.equal(balance(raw, '4000'), -25000, 'return reduces revenue exactly once');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM operating_expenses'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key='refund:gini-return'"), 1);
  const report = await operationsReport(db, baghdadDay(), baghdadDay());
  assert.equal(report.orders[0].collection_difference_iqd, -25000);
});

test('bank credit after Gini refund does not hide or consume the outstanding door payment', async () => {
  const { raw, db, env, app } = setup();
  seedGini(raw);
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assert.equal((await post(app, '/f/collections', bankReceipt())).status, 200);
  await refundGini(env);
  const before = (await json(await get(app, '/f/receivables'))).orders[0];
  assert.equal(before.bank_credit_balance_iqd, 25000);
  assert.equal(before.door_balance_iqd, 5000);
  assert.equal(before.receivable_iqd, 5000);
  assert.equal(before.balance_iqd, -20000);
  assert.equal((await operationsReport(db, baghdadDay(), baghdadDay())).orders[0].collection_difference_iqd, -20000);
  assert.equal((await post(app, '/f/collections', bankReceipt(1))).status, 400);
  assert.equal((await post(app, '/f/collections', doorReceipt())).status, 200);
  assert.equal(balance(raw, '1100'), -25000);
  const after = (await json(await get(app, '/f/receivables'))).orders[0];
  assert.equal(after.bank_credit_balance_iqd, 25000);
  assert.equal(after.door_balance_iqd, 0);
});

test('bank collection rolls back if a refund lowers its limit between reads and commit', async () => {
  const { raw, failing, env, app } = setup();
  seedGini(raw);
  await runOrderFinancialEffects(env, 'order', 'delivered');
  failing.beforeBatch = (statements) => {
    if (!statements.some((s) => s.sql.includes('INSERT INTO finance_collections'))) return;
    failing.beforeBatch = null;
    // A second request records and posts the real Gini refund before this
    // collection batch can commit its stale original 50k bank limit.
    raw.prepare(`INSERT INTO finance_refund_facts(case_id,order_id,refund_iqd,qty,disposition,cogs_iqd,channel,refunded_day,posted_at)
      VALUES ('gini-return','order',25000,1,'damage',0,'gini',?,?)`).run(baghdadDay(), new Date().toISOString());
    raw.prepare(`INSERT INTO accounting_entries(id,event_key,entry_day,title,source_type,source_id,created_at)
      VALUES ('competing-refund','refund:gini-return',?,'Refund','return','gini-return',?)`).run(baghdadDay(), new Date().toISOString());
    raw.exec(`INSERT INTO accounting_lines(id,entry_id,account_code,debit_iqd,credit_iqd) VALUES
      ('cr-revenue','competing-refund','4000',25000,0),('cr-bank','competing-refund','1100',0,25000);
      UPDATE accounting_entries SET state='posted' WHERE id='competing-refund';`);
  };
  assert.notEqual((await post(app, '/f/collections', bankReceipt())).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_collections'), 0);
  assert.equal(balance(raw, '1000'), 0);
  assert.equal((await post(app, '/f/collections', bankReceipt())).status, 400);
  assert.equal((await post(app, '/f/collections', bankReceipt(25000))).status, 200);
  assert.equal((await post(app, '/f/collections', doorReceipt())).status, 200);
  assert.equal(balance(raw, '1100'), 0);
  assert.equal(balance(raw, '1000'), 30000);
});

async function pendingAssignedCost(s: ReturnType<typeof setup>) {
  assert.equal((await post(s.app, '/f/rules', {
    name: 'تجهيز', group_key: 'preparation', target_type: 'all', basis: 'profit_percent', amount: 1000,
    staff_id: 'staff_sajjad', category_id: 'wages', milestone: 'delivered', requires_assignment: true,
  })).status, 200);
  await s.db.batch(await planOrderFinanceSnapshot(s.db, 'order', [{ id: 'item', product_id: 'printer' }], new Date().toISOString()));
  s.raw.exec(`INSERT INTO finance_task_assignments(order_id,group_key,staff_id,actor_id)
    VALUES ('order','preparation','staff_sajjad','admin')`);
  await runOrderFinancialEffects(s.env, 'order', 'delivered');
  assert.equal(row(s.raw, 'SELECT state FROM finance_order_costs')?.state, 'pending_cost');
  s.raw.exec('UPDATE order_item_inventory_allocations SET unit_cost_iqd=10000,cogs_iqd=20000');
}

test('concurrent assignment prevents stale FIFO completion from charging the former employee', async () => {
  const s = setup(null);
  await pendingAssignedCost(s);
  s.failing.beforeBatch = (statements) => {
    if (!statements.some((v) => v.sql.includes('UPDATE finance_order_costs SET amount_iqd'))) return;
    s.failing.beforeBatch = null;
    s.raw.exec("UPDATE finance_task_assignments SET staff_id='staff_hussein' WHERE order_id='order' AND group_key='preparation'");
  };
  await assert.rejects(runOrderFinancialEffects(s.env, 'order', 'delivered'), /CHECK constraint/);
  assert.equal(row(s.raw, 'SELECT state FROM finance_order_costs')?.state, 'pending_cost');
  await runOrderFinancialEffects(s.env, 'order', 'delivered');
  assert.deepEqual(row(s.raw, 'SELECT staff_id,state,amount_iqd FROM finance_order_costs'), {
    staff_id: 'staff_hussein', state: 'due', amount_iqd: 3000,
  });
});

test('assignment cannot change after a competing request fixes the employee payable', async () => {
  const s = setup(null);
  await pendingAssignedCost(s);
  let interleaved = false;
  const compete = async () => {
    if (interleaved) return;
    interleaved = true;
    await runOrderFinancialEffects(s.env, 'order', 'delivered');
  };
  // Cover both a single-statement handler and an atomic batched handler:
  // another request completes FIFO after the handler's eligibility read,
  // before its assignment write can begin.
  const prepare = s.failing.prepare.bind(s.failing);
  s.failing.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.includes('INSERT INTO finance_task_assignments')) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...values) => {
      const bound = bind(...values), run = bound.run.bind(bound);
      bound.run = async () => { await compete(); return run(); };
      return bound;
    };
    return statement;
  };
  const batch = s.failing.batch.bind(s.failing);
  s.failing.batch = async (statements) => {
    if (statements.some((v) => v.sql.includes('INSERT INTO finance_task_assignments'))) await compete();
    return batch(statements);
  };
  const response = await post(s.app, '/f/orders/order/assignment', {
    group_key: 'preparation', staff_id: 'staff_hussein', completed: false,
  });
  assert.ok(interleaved, 'competing completion actually ran');
  assert.equal(response.status, 409);
  assert.equal(row(s.raw, 'SELECT staff_id FROM finance_task_assignments')?.staff_id, 'staff_sajjad');
  assert.deepEqual(row(s.raw, 'SELECT staff_id,state,amount_iqd FROM finance_order_costs'), {
    staff_id: 'staff_sajjad', state: 'due', amount_iqd: 3000,
  });
});
