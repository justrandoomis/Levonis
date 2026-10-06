import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, count, freshDb, get, json, row, stubApp } from './fixtures/app';
import { getOrderProfitBase } from '../worker/lib/orderProfit';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { reconcileFinanceOrder } from '../worker/lib/financeReconcile';
import { journalPlan } from '../worker/lib/operations';
import { recordFinancialFailure, runOrderFinancialEffects } from '../worker/lib/orderFinance';
import type { Env } from '../worker/lib/types';

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('owner','boss@x.co','Owner','admin','full'),('helper','helper@x.co','Helper','admin','assistant'),('financial','finance@x.co','Finance','admin','full'),('buyer','buyer@x.co','Buyer','customer',NULL);
    UPDATE finance_staff SET user_id='helper' WHERE id='staff_sajjad';
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('p','Printer','cost-review-printer',50000,999);
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('wages','review-wages','أجور');
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
      VALUES ('order','buyer','delivered','{}','standard','{}','cash',150000,1500,150000,150000,'2026-09-20T00:00:00Z','2026-09-22T00:00:00Z');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES ('line','order','p','Printer',3,50000,150000,10000,'snapshot');`);
  const db = asD1(raw);
  const app = (owner = true) => stubApp(db, { id: owner ? 'owner' : 'financial', email: owner ? 'boss@x.co' : 'finance@x.co', role: 'admin', admin_scope: 'full' }, a => a.route('/f', adminFinanceWorkspaceRoutes));
  return { raw, db, app };
}

test('historical recorded snapshot reconciliation retains a missing COGS posting until the full financial retry posts it', async () => {
  const { raw, db } = setup();
  // Before recorded snapshots were accepted, delivery could post the sale
  // while rejecting this proven cost and leaving no COGS journal at all.
  await db.batch(journalPlan(db, {
    key: 'sale:order', day: '2026-09-22', title: 'Historical delivered sale', source: 'order', sourceId: 'order',
  }, [{ account: '1100', debit: 150000 }, { account: '4000', credit: 150000 }]).statements);
  await recordFinancialFailure(db, 'order', 'cogs', new Error('Historical FIFO-only cost rejection'));
  const postedGoodsCost = () => count(raw, `SELECT COALESCE(SUM(l.debit_iqd-l.credit_iqd),0) n
    FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id
    WHERE l.account_code='5000' AND e.state='posted' AND e.source_id='order'`);
  assert.equal(postedGoodsCost(), 0);
  assert.equal((await getOrderProfitBase(db, 'order')).totals.cogs_iqd, 30000);
  assert.equal((await reconcileFinanceOrder(db, 'order', { day: '2026-10-06' })).complete, true);
  assert.equal(postedGoodsCost(), 0, 'staff reconciliation does not implicitly replay the entire sale');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='cogs:order'"), 1,
    'a known snapshot must not clear a still-unposted goods expense warning');
  const message = row<{ message: string }>(raw, "SELECT message FROM finance_posting_errors WHERE event_key='cogs:order'")!.message;
  assert.match(message, /تكلفة البضاعة مثبتة/, 'known cost must not be described as missing cost evidence');
  assert.match(message, /قيد مصروفها المحاسبي لم يُرحّل/, 'the warning must identify the missing accounting posting');
  assert.match(message, /يعيد النظام محاولة الترحيل تلقائيًا/, 'known costs must not require an admin to start the posting retry');
  await reconcileFinanceOrder(db, 'order', { day: '2026-10-06' });
  assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='cogs:order'"), 1);
  await runOrderFinancialEffects({ DB: db } as Env, 'order', 'delivered', '2026-10-06');
  assert.equal(postedGoodsCost(), 30000);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='cogs:order'"), 0);
  await runOrderFinancialEffects({ DB: db } as Env, 'order', 'delivered', '2026-10-06');
  await reconcileFinanceOrder(db, 'order', { day: '2026-10-06' });
  assert.equal(postedGoodsCost(), 30000, 'delivery and reconciliation retries must not duplicate the expense');
});

test('a genuine zero recorded cost clears the historical COGS error without requiring a zero-value journal', async () => {
  const { raw, db } = setup();
  raw.exec("UPDATE order_items SET cost_iqd=0 WHERE order_id='order'");
  await db.batch(journalPlan(db, {
    key: 'sale:order', day: '2026-09-22', title: 'Historical delivered sale', source: 'order', sourceId: 'order',
  }, [{ account: '1100', debit: 150000 }, { account: '4000', credit: 150000 }]).statements);
  await recordFinancialFailure(db, 'order', 'cogs', new Error('Historical FIFO-only cost rejection'));
  const base = await getOrderProfitBase(db, 'order');
  assert.equal(base.lines[0].cost_confidence, 'recorded_snapshot');
  assert.equal(base.totals.cogs_iqd, 0);
  assert.equal((await reconcileFinanceOrder(db, 'order', { day: '2026-10-06' })).complete, true);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE event_key='cogs:order'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key='cogs:order'"), 0);
});

test('order review distinguishes a recorded sale-time cost from unrecorded or unpriced history and never applies catalogue suggestions', async () => {
  const { raw, db, app } = setup();
  let base = await getOrderProfitBase(db, 'order');
  assert.equal(base.lines[0].cost_confidence, 'recorded_snapshot');
  assert.equal(base.totals.cogs_iqd, 30000);
  assert.deepEqual(base.lines[0].cost_review?.issues, []);
  assert.equal(base.lines[0].cost_review?.snapshot_unit_iqd, 10000);
  assert.equal(base.lines[0].cost_review?.suggestion, null);
  raw.exec('UPDATE products SET product_cost_iqd=80000');
  assert.equal((await getOrderProfitBase(db, 'order')).totals.cogs_iqd, 30000);
  raw.exec("UPDATE order_items SET cost_basis='unrecorded'");
  base = await getOrderProfitBase(db, 'order');
  assert.equal(base.lines[0].cost_confidence, 'snapshot');
  assert.equal(base.lines[0].cost_review?.issues[0].code, 'historical_cost_unverified');
  assert.equal(base.lines[0].cost_review?.suggestion?.total_cost_iqd, 30000);
  raw.exec("UPDATE order_items SET cost_basis='unpriced',cost_iqd=NULL");
  const before = count(raw, 'SELECT COUNT(*) n FROM finance_order_adjustments');
  const response = await get(app(), '/f/orders/order'), detail = await json(response);
  assert.equal(response.status, 200, JSON.stringify(detail));
  assert.equal(detail.lines[0].cogs_iqd, null);
  assert.equal(detail.lines[0].cost_review.issues[0].code, 'fifo_missing');
  assert.equal(detail.lines[0].cost_review.suggestion.source, 'current_catalogue');
  assert.equal(detail.lines[0].cost_review.suggestion.total_cost_iqd, 240000);
  assert.equal(detail.lines[0].cost_review.suggestion.requires_confirmation, true);
  assert.equal(detail.lines[0].cost_review.can_verify, true);
  assert.equal(detail.can_reconcile, true);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_order_adjustments'), before);
  assert.equal((await getOrderProfitBase(db, 'order')).totals.cogs_iqd, null);
  raw.exec("INSERT INTO ops_permissions(user_id,capability,allowed) VALUES ('financial','accounting',0),('financial','rules',0)");
  const denied = await json(await get(app(false), '/f/orders/order'));
  assert.equal(denied.lines[0].cost_review.can_verify, false);
  assert.equal(denied.can_reconcile, false);
});

test('order-level scoped review uses recorded line evidence and does not blame unrelated unpriced products', async () => {
  const { raw, db } = setup();
  raw.exec(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_basis) VALUES ('unrelated','order','p','Unrelated missing cost',1,50000,50000,'unpriced');`);
  const insert = raw.prepare(`INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot)
    VALUES (?,'order',NULL,?,1,'Order scoped wage',?,'staff_sajjad','wages','delivered',NULL,3,NULL,'2026-09-22','pending_cost',?)`);
  insert.run('recorded-scope', 'recorded-rule', 'recorded-group', JSON.stringify({ rule: { id: 'recorded-rule', version: 1, basis: 'profit_percent', amount: 1000, target_type: 'catalog', target_id: 'printers' }, line_ids: ['line'] }));
  insert.run('legacy-scope', 'legacy-rule', 'legacy-group', JSON.stringify({ rule: { id: 'legacy-rule', version: 1, basis: 'profit_percent', amount: 1000, target_type: 'catalog', target_id: 'printers' } }));
  const base = await getOrderProfitBase(db, 'order');
  const recorded = base.costs.find(c => c.id === 'recorded-scope')!;
  assert.deepEqual(recorded.line_ids, ['line']); assert.equal(recorded.scope_confidence, 'recorded');
  assert.deepEqual(recorded.review_reasons, [{ code: 'wage_reconciliation_pending', field: 'finance_wage_targets.amount_iqd', source_id: 'recorded-scope', line_ids: ['line'] }]);
  const legacy = base.costs.find(c => c.id === 'legacy-scope')!;
  assert.deepEqual(legacy.line_ids, []); assert.equal(legacy.scope_confidence, 'historical_unknown');
  assert.deepEqual(legacy.review_reasons, [{ code: 'wage_reconciliation_pending', field: 'finance_wage_targets.amount_iqd', source_id: 'legacy-scope', line_ids: [] }]);
});

test('FIFO review points to the exact allocation and quantity gap; known zero and complete allocation override the old product snapshot', async () => {
  const { raw, db } = setup();
  raw.exec(`INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('lot','p','base',3,0,18000,'opening','2026-09-19');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES ('allocated','order','line','lot','base',3,18000,54000,'review-consumed');`);
  let base = await getOrderProfitBase(db, 'order');
  assert.equal(base.totals.cogs_iqd, 54000);
  assert.equal(base.lines[0].cost_review?.source, 'fifo');
  assert.equal(base.lines[0].cost_review?.sources[0].allocation_id, 'allocated');
  assert.equal(base.lines[0].cost_review?.sources[0].lot_id, 'lot');
  raw.exec('UPDATE order_item_inventory_allocations SET qty=1,cogs_iqd=NULL');
  base = await getOrderProfitBase(db, 'order');
  assert.equal(base.totals.cogs_iqd, null);
  const review = base.lines[0].cost_review!;
  assert.equal(review.allocated_qty, 1); assert.equal(review.required_qty, 3);
  assert.deepEqual(review.issues.map(i => i.code), ['fifo_quantity_incomplete', 'fifo_cost_missing']);
  assert.equal(review.issues[1].source_id, 'allocated');
  assert.equal(review.issues[1].field, 'order_item_inventory_allocations.cogs_iqd');
  raw.exec('UPDATE order_item_inventory_allocations SET qty=3,cogs_iqd=0,unit_cost_iqd=0');
  base = await getOrderProfitBase(db, 'order');
  assert.equal(base.totals.cogs_iqd, 0);
  assert.equal(base.lines[0].cost_review?.source, 'fifo');
  assert.deepEqual(base.lines[0].cost_review?.issues, []);
});

test('two three-printer lines carry distinct wages once and pending percentage pay identifies its missing cost line', async () => {
  const { raw, db } = setup();
  raw.exec(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('second','order','p','Printer second option',3,50000,150000,10000,'snapshot');`);
  const wage = (id: string, line: string) => raw.prepare(`INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot)
    VALUES (?,'order',?,'printer-wage',1,'تجهيز سجاد','prepare','staff_sajjad','wages','delivered',150000,3,22500,'2026-09-22','due','{"rule":{"basis":"unit","amount":7500}}')`).run(id, line);
  wage('first-wage', 'line'); wage('second-wage', 'second');
  assert.throws(() => wage('duplicate-wage', 'line'), /UNIQUE/);
  let base = await getOrderProfitBase(db, 'order');
  assert.equal(base.totals.wages_iqd, 45000);
  assert.deepEqual(base.lines.map(l => l.wages_iqd), [22500, 22500]);
  assert.deepEqual(base.costs.map(c => c.line_ids), [['line'], ['second']]);
  assert.equal(base.costs[0].staff_user_id, 'helper');
  assert.equal(base.costs[0].basis, 'unit'); assert.equal(base.costs[0].rate, 7500);
  raw.exec(`UPDATE order_items SET cost_basis='unrecorded' WHERE id='second';
    INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot)
    VALUES ('percent','order','second','profit-rule',1,'حصة ربح','support','staff_hussein','wages','delivered',NULL,3,NULL,'2026-09-22','pending_cost','{"rule":{"basis":"profit_percent","amount":1000}}');`);
  base = await getOrderProfitBase(db, 'order');
  const pending = base.costs.find(c => c.id === 'percent')!;
  assert.equal(pending.effective_amount_iqd, null);
  assert.deepEqual(pending.review_reasons, [{ code: 'verified_goods_cost_required', field: 'cogs_iqd', source_id: 'percent', line_ids: ['second'] }]);
  assert.equal(base.totals.wages_iqd, 45000);
});
