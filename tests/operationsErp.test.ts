import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, patch, put, get, json, row, count } from './fixtures/app';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminStockOperationsRoutes } from '../worker/routes/adminStockOperations';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { allocateExact, baghdadDay, journalPlan } from '../worker/lib/operations';
import {
  costAmount,
  matchingRules,
  planOrderFinanceSnapshot,
  runOrderFinancialEffects,
  type CostRule,
} from '../worker/lib/orderFinance';
import { productSelections } from '../worker/lib/inventorySelection';
import { operationsReport } from '../worker/lib/operationsReport';
import { adminFinanceRoutes } from '../worker/routes/adminFinance';
import { recordReturnFinancials } from '../worker/lib/orderFinance';
import { refundsByDaySql } from '../worker/lib/financeReport';
import { planLotRestore } from '../worker/lib/inventoryLots';
import { parsePurchaseCsv } from '../worker/lib/purchaseCsv';
import type { Env } from '../worker/lib/types';

const ADMIN = { id: 'admin', email: 'boss@x.co', role: 'admin' as const };
function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role) VALUES ('admin','boss@x.co','admin'),('assistant','assistant@example.test','admin'),('buyer','buyer@example.test','customer');
 INSERT INTO expense_categories(id,slug,name_ar) VALUES ('wages','erp-wages','أجور');
 INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','المورد');
 INSERT INTO products(id,name,name_ar,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('printer','Printer','طابعة','erp-printer','PRN',50000,10000,0,'BASE'),('part','Part','ملحق','erp-part','PART',10000,2000,0,'BASE');
 INSERT INTO catalogs(id,slug,name_ar,is_printer_catalog) VALUES ('main','erp-printers','طابعات',1),('sub','erp-small','صغيرة',0);
 UPDATE catalogs SET parent_id='main' WHERE id='sub';INSERT INTO product_catalogs(product_id,catalog_id,position) VALUES ('printer','sub',0);`);
  const db = asD1(raw),
    app = stubApp(db, ADMIN, (a) => {
      a.route('/p', adminProcurementRoutes);
      a.route('/s', adminStockOperationsRoutes);
      a.route('/f', adminFinanceOperationsRoutes);
      a.route('/e', adminFinanceRoutes);
    });
  return { raw, db, app, env: { DB: db } as Env };
}
function purchase(over: Record<string, unknown> = {}) {
  return {
    operation_id: crypto.randomUUID(),
    supplier_id: 'supplier',
    invoice_no: 'INV-1',
    currency: 'IQD',
    purchase_day: baghdadDay(),
    status: 'ordered',
    cost_state: 'final',
    lines: [
      { product_id: 'printer', scope: 'base', scope_id: '', qty_ordered: 3, source_unit_amount: 10000 },
    ],
    charges: [{ title: 'شحن', amount_iqd: 10, basis: 'quantity' }],
    ...over,
  };
}
async function create(app: ReturnType<typeof setup>['app'], body = purchase()) {
  const res = await post(app, '/p/documents', body),
    r = await json(res);
  assert.equal(res.status, 200, JSON.stringify(r));
  return { id: r.id as string, body, detail: await json(await get(app, `/p/documents/${r.id}`)) };
}
function seedOrder(raw: ReturnType<typeof freshDb>, id = 'order', cost = 10000) {
  raw
    .prepare(
      `INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
 VALUES (?,'buyer','delivered','{}','standard','{}','cash',50000,1500,55000,55000,5000,?,?)`,
    )
    .run(id, new Date().toISOString(), new Date().toISOString());
  raw
    .prepare(
      `INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,'printer','طابعة',2,25000,50000,?,'snapshot')`,
    )
    .run(`${id}-item`, id, cost);
  raw
    .prepare(
      `INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES (?,'printer','base','',2,0,?,'opening',?)`,
    )
    .run(`${id}-lot`, cost, new Date().toISOString());
  raw
    .prepare(
      'INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      `${id}-alloc`,
      id,
      `${id}-item`,
      `${id}-lot`,
      'base',
      '',
      2,
      cost,
      cost === null ? null : cost * 2,
      `${id}-allocation`,
    );
}
const ruleInput = (over: Record<string, unknown> = {}) => ({
  name: 'تجهيز',
  group_key: 'preparation',
  target_type: 'catalog',
  target_id: 'main',
  basis: 'unit',
  amount: 5000,
  staff_id: 'staff_sajjad',
  category_id: 'wages',
  milestone: 'delivered',
  ...over,
});

test('integer weighted freight conserves every dinar, with deterministic remainders', () => {
  assert.deepEqual(allocateExact(10, [1, 2, 3]), [2, 3, 5]);
  for (let total = 0; total < 100; total++)
    assert.equal(
      allocateExact(total, [1, 7, 9]).reduce((a, b) => a + b, 0),
      total,
    );
  assert.throws(() => allocateExact(1, [0, 0]), /الوزن/);
});
test('CSV parses quoted commas and refuses unknown or ambiguous selections before writing', async () => {
  assert.deepEqual(parsePurchaseCsv('sku,qty,unit_amount\r\n"A,B",2,100'), [
    { sku: 'A,B', qty: '2', unit_amount: '100' },
  ]);
  const { raw, app } = setup();
  const r = await post(app, '/p/import-preview', { csv: 'sku,qty,unit_amount\nNOPE,1,100' });
  assert.equal(r.status, 400);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM purchase_orders'), 0);
});
test('purchase selection fills latest cost and resolved selling price, and refuses foreign child ids', async () => {
  const { raw, db, app } = setup();
  assert.equal((await productSelections(db, 'printer'))[0].purchase_unit_iqd, 10000);
  raw.exec("UPDATE products SET direct_surcharge_iqd=2000 WHERE id='printer'");
  assert.equal((await productSelections(db, 'printer'))[0].selling_price_iqd, 52000);
  const invalid = await post(
    app,
    '/p/documents',
    purchase({
      lines: [
        { product_id: 'printer', scope: 'option', scope_id: 'other', qty_ordered: 1, source_unit_amount: 0 },
      ],
    }),
  );
  assert.equal(invalid.status, 400);
});
test('partial multi-line receipt freezes costs, conserves FIFO unit value and is replay-safe', async () => {
  const { raw, app } = setup();
  const { id, detail } = await create(app);
  const line = detail.lines[0].line_id;
  const receipt = { operation_id: crypto.randomUUID(), lines: [{ line_id: line, qty: 1 }] };
  let res = await post(app, `/p/documents/${id}/receive`, receipt);
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  assert.equal((await post(app, `/p/documents/${id}/receive`, receipt)).status, 200);
  assert.equal(count(raw, "SELECT stock n FROM products WHERE id='printer'"), 1);
  assert.equal(
    (await post(app, `/p/documents/${id}/receive`, { ...receipt, lines: [{ line_id: line, qty: 2 }] }))
      .status,
    409,
  );
  res = await post(app, `/p/documents/${id}/receive`, {
    operation_id: crypto.randomUUID(),
    lines: [{ line_id: line, qty: 2 }],
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  assert.equal(
    count(raw, "SELECT SUM(qty_remaining*unit_cost_iqd) n FROM inventory_lots WHERE product_id='printer'"),
    30010,
  );
  assert.equal(count(raw, "SELECT stock n FROM products WHERE id='printer'"), 3);
  const doc = await json(await get(app, `/p/documents/${id}`));
  assert.equal(doc.purchase.status, 'received');
  assert.equal(count(raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
  assert.equal(
    (await put(app, `/p/documents/${id}`, { ...purchase(), version: doc.purchase.version })).status,
    409,
  );
});
test('supplier prepayment and receipt clear prepaid asset, without recognising purchase twice', async () => {
  const { raw, app } = setup();
  const { id, detail } = await create(app);
  const payment = { operation_id: crypto.randomUUID(), amount_iqd: 30010 };
  assert.equal((await post(app, `/p/documents/${id}/payments`, payment)).status, 200);
  const res = await post(app, `/p/documents/${id}/receive`, {
    operation_id: crypto.randomUUID(),
    lines: [{ line_id: detail.lines[0].line_id, qty: 3 }],
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  assert.equal(
    count(raw, "SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='1300'"),
    0,
  );
  assert.equal(
    count(
      raw,
      "SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines WHERE account_code='2000'",
    ),
    0,
  );
});
test('rule specificity and profit base exclude wages; losses earn zero and unknown cost stays pending', () => {
  const r = {
    ...ruleInput(),
    id: 'main',
    version: 1,
    center_id: null,
    requires_assignment: 0,
    cap_iqd: null,
    priority: 0,
    effective_from: '2020-01-01',
    effective_to: null,
    created_at: '2020',
  } as CostRule;
  const sub = { ...r, id: 'sub', target_id: 'sub', amount: 6000 },
    product = { ...r, id: 'product', target_type: 'product' as const, target_id: 'printer', amount: 7000 };
  assert.equal(
    matchingRules(
      [r, sub, product],
      'printer',
      new Map([
        ['main', 1],
        ['sub', 2],
      ]),
    )[0].id,
    'product',
  );
  assert.equal(costAmount({ ...r, basis: 'profit_percent', amount: 1000 }, 2, 50000, 20000), 3000);
  assert.equal(costAmount({ ...r, basis: 'profit_percent', amount: 1000 }, 2, 10000, 20000), 0);
  assert.equal(costAmount({ ...r, basis: 'profit_percent', amount: 1000 }, 2, 50000, null), null);
});
test('order freezes rule version, generates one expense and one payable, and wage payment is not another expense', async () => {
  const { raw, db, app, env } = setup();
  const r = await json(await post(app, '/f/rules', ruleInput()));
  seedOrder(raw);
  await db.batch(
    await planOrderFinanceSnapshot(
      db,
      'order',
      [{ id: 'order-item', product_id: 'printer' }],
      new Date().toISOString(),
    ),
  );
  const old = await json(await get(app, '/f/rules'));
  assert.equal(
    (await put(app, `/f/rules/${r.id}`, { ...old.rules[0], amount: 7000, active: true })).status,
    200,
  );
  await runOrderFinancialEffects(env, 'order', 'delivered');
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assert.equal(count(raw, 'SELECT SUM(amount_iqd) n FROM finance_order_costs'), 10000);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM operating_expenses'), 1);
  const cost = row<{ id: string }>(raw, 'SELECT id FROM finance_order_costs')!;
  assert.equal((await post(app, `/f/costs/${cost.id}/approve`, {})).status, 200);
  const payment = { operation_id: crypto.randomUUID(), amount_iqd: 10000 };
  assert.equal((await post(app, '/f/staff/staff_sajjad/payments', payment)).status, 200);
  assert.equal((await post(app, '/f/staff/staff_sajjad/payments', payment)).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM operating_expenses'), 1);
  assert.equal(
    count(raw, "SELECT SUM(credit_iqd-debit_iqd) n FROM accounting_lines WHERE account_code='2100'"),
    0,
  );
});
test('profit-percent cost uses FIFO after goods discounts and does not compound preparation cost', async () => {
  const { raw, db, app, env } = setup();
  await post(app, '/f/rules', ruleInput());
  await post(
    app,
    '/f/rules',
    ruleInput({
      name: 'مواد',
      group_key: 'materials',
      basis: 'profit_percent',
      amount: 1000,
      staff_id: null,
    }),
  );
  seedOrder(raw);
  raw.exec(
    "UPDATE order_items SET coupon_discount_iqd=5000 WHERE order_id='order';UPDATE orders SET coupon_discount_iqd=5000,points_discount_iqd=1000,total_iqd=49000,due_on_delivery_iqd=49000 WHERE id='order'",
  );
  await db.batch(
    await planOrderFinanceSnapshot(
      db,
      'order',
      [{ id: 'order-item', product_id: 'printer' }],
      new Date().toISOString(),
    ),
  );
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assert.equal(count(raw, "SELECT amount_iqd n FROM finance_order_costs WHERE group_key='materials'"), 2400);
  assert.equal(
    count(raw, "SELECT amount_iqd n FROM finance_order_costs WHERE group_key='preparation'"),
    10000,
  );
});
test('generated expense corrections reverse in current period and cannot silently edit source expense', async () => {
  const { raw, db, app, env } = setup();
  await post(app, '/f/rules', ruleInput());
  seedOrder(raw);
  await db.batch(
    await planOrderFinanceSnapshot(
      db,
      'order',
      [{ id: 'order-item', product_id: 'printer' }],
      new Date().toISOString(),
    ),
  );
  await runOrderFinancialEffects(env, 'order', 'delivered');
  const cost = row<{ id: string; expense_id: string }>(raw, 'SELECT id,expense_id FROM finance_order_costs')!;
  assert.throws(
    () => raw.prepare('UPDATE operating_expenses SET amount_iqd=1 WHERE id=?').run(cost.expense_id),
    /source/,
  );
  assert.equal(
    (await post(app, `/f/costs/${cost.id}/reverse`, { reason: 'لم يتم تنفيذ المهمة' })).status,
    200,
  );
  assert.equal(count(raw, 'SELECT SUM(amount_iqd) n FROM finance_cost_reversals'), 10000);
});
test('posted journals balance, immutable lines cannot be changed, and closed periods refuse new expense and journal', async () => {
  const { raw, db } = setup();
  await db.batch(
    journalPlan(
      db,
      { key: 'opening', day: '2026-01-01', title: 'افتتاحي', source: 'manual', sourceId: 'opening' },
      [
        { account: '1000', debit: 1000 },
        { account: '3000', credit: 1000 },
      ],
    ).statements,
  );
  assert.throws(() => raw.exec('UPDATE accounting_lines SET debit_iqd=2000 WHERE debit_iqd>0'), /immutable/);
  raw.exec(
    "INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES ('2026-01','2026-02-01','admin')",
  );
  await assert.rejects(
    db.batch(
      journalPlan(
        db,
        { key: 'closed', day: '2026-01-02', title: 'مغلق', source: 'manual', sourceId: 'closed' },
        [
          { account: '1000', debit: 1000 },
          { account: '3000', credit: 1000 },
        ],
      ).statements,
    ),
    /closed/,
  );
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM accounting_entries'), 1);
  assert.throws(
    () =>
      raw.exec(
        "INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day) VALUES ('closed','wages',1,'2026-01-02')",
      ),
    /closed/,
  );
});
test('count and warehouse transfer preserve global quantities, value and reservation safety', async () => {
  const { raw, app } = setup();
  const { id, detail } = await create(app);
  await post(app, `/p/documents/${id}/receive`, {
    operation_id: crypto.randomUUID(),
    lines: [{ line_id: detail.lines[0].line_id, qty: 3 }],
  });
  const loc = await json(await post(app, '/s/locations', { name: 'بغداد' })),
    lot = row<{ id: string }>(raw, 'SELECT id FROM inventory_lots ORDER BY unit_cost_iqd LIMIT 1')!;
  const res = await post(app, '/s/transfers', {
    operation_id: crypto.randomUUID(),
    lot_id: lot.id,
    location_id: loc.id,
    qty: 1,
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  assert.equal(count(raw, "SELECT stock n FROM products WHERE id='printer'"), 3);
  assert.equal(count(raw, 'SELECT SUM(qty_remaining*unit_cost_iqd) n FROM inventory_lots'), 30010);
  const session = await json(
    await post(app, '/s/counts', {
      operation_id: crypto.randomUUID(),
      name: 'جرد',
      lines: [{ product_id: 'printer', scope: 'base', scope_id: '', counted_qty: 4, unit_cost_iqd: 10000 }],
    }),
  );
  assert.equal((await post(app, `/s/counts/${session.id}/post`, {})).status, 200);
  assert.equal(count(raw, 'SELECT SUM(qty_remaining) n FROM inventory_lots'), 4);
});
test('overhead allocation is exact and appears once; order profit drills into the same goods and costs', async () => {
  const { raw, db } = setup();
  seedOrder(raw, 'one');
  seedOrder(raw, 'two');
  raw
    .prepare(
      "INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day) VALUES ('rent','wages',1001,?)",
    )
    .run(baghdadDay());
  raw.exec("INSERT INTO finance_expense_links(expense_id,allocation_basis) VALUES ('rent','orders')");
  const report = await operationsReport(db, baghdadDay(), baghdadDay());
  assert.equal(report.allocated_overhead_iqd, 1001);
  assert.equal(
    report.orders.reduce((s, r) => s + Number(r.allocated_overhead_iqd), 0),
    1001,
  );
  assert.equal(report.general_expenses_iqd, 1001);
});
test('assistant receives no financial selection fields and denied operations remain denied in API', async () => {
  const { raw, db } = setup();
  raw.exec(
    "UPDATE users SET admin_scope='assistant' WHERE id='assistant';INSERT INTO ops_permissions(user_id,capability,allowed) VALUES ('assistant','count',0)",
  );
  const a = stubApp(
    db,
    { id: 'assistant', email: 'assistant@example.test', role: 'admin', admin_scope: 'assistant' },
    (app) => {
      app.route('/p', adminProcurementRoutes);
      app.route('/s', adminStockOperationsRoutes);
    },
  );
  const selections = await json(await get(a, '/p/selections/printer'));
  assert.equal('purchase_unit_iqd' in selections.selections[0], false);
  assert.equal('unit_cost_iqd' in selections.selections[0], false);
  assert.equal((await get(a, '/p/documents')).status, 403);
  assert.equal((await get(a, '/s/health')).status, 403);
});

test('advance settlement consumes approved wages and advance once without cash or expense duplication', async () => {
  const { raw, db, app, env } = setup();
  await post(app, '/f/rules', ruleInput());
  seedOrder(raw);
  await db.batch(
    await planOrderFinanceSnapshot(
      db,
      'order',
      [{ id: 'order-item', product_id: 'printer' }],
      new Date().toISOString(),
    ),
  );
  await runOrderFinancialEffects(env, 'order', 'delivered');
  const cost = row<{ id: string }>(raw, 'SELECT id FROM finance_order_costs')!;
  await post(app, `/f/costs/${cost.id}/approve`, {});
  assert.equal(
    (
      await post(app, '/f/staff/staff_sajjad/payments', {
        operation_id: crypto.randomUUID(),
        kind: 'advance',
        amount_iqd: 6000,
      })
    ).status,
    200,
  );
  const settlement = { operation_id: crypto.randomUUID(), amount_iqd: 4000 };
  const r = await post(app, '/f/staff/staff_sajjad/advance-settlements', settlement);
  assert.equal(r.status, 200, JSON.stringify(await json(r)));
  assert.equal((await post(app, '/f/staff/staff_sajjad/advance-settlements', settlement)).status, 200);
  const balance = (await json(await get(app, '/f/payroll'))).staff.find(
    (s: { id: string }) => s.id === 'staff_sajjad',
  );
  assert.equal(balance.advance_balance_iqd, 2000);
  assert.equal(balance.paid_iqd, 4000);
  assert.equal(count(raw, "SELECT SUM(credit_iqd) n FROM accounting_lines WHERE account_code='1000'"), 6000);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM operating_expenses'), 1);
  assert.equal(
    (
      await post(app, '/f/staff/staff_sajjad/advance-settlements', {
        operation_id: crypto.randomUUID(),
        amount_iqd: 3000,
      })
    ).status,
    400,
  );
});

test('rule cap is shared across all eligible lines in one order and replay does not use it twice', async () => {
  const { raw, db, app, env } = setup();
  await post(app, '/f/rules', ruleInput({ target_type: 'all', target_id: '', cap_iqd: 11000 }));
  seedOrder(raw);
  raw.exec(
    "INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('part-item','order','part','ملحق',1,10000,10000,2000,'snapshot');UPDATE orders SET total_iqd=65000,due_on_delivery_iqd=65000 WHERE id='order'",
  );
  await db.batch(
    await planOrderFinanceSnapshot(
      db,
      'order',
      [
        { id: 'order-item', product_id: 'printer' },
        { id: 'part-item', product_id: 'part' },
      ],
      new Date().toISOString(),
    ),
  );
  await runOrderFinancialEffects(env, 'order', 'delivered');
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assert.equal(count(raw, 'SELECT SUM(amount_iqd) n FROM finance_order_costs'), 11000);
});

test('no-op receipt leaves purchase untouched and missing cost is rejected rather than invented as zero', async () => {
  const { raw, app } = setup();
  const { id, detail } = await create(app);
  assert.equal(
    (
      await post(app, `/p/documents/${id}/receive`, {
        operation_id: crypto.randomUUID(),
        lines: [{ line_id: detail.lines[0].line_id, qty: 0 }],
      })
    ).status,
    400,
  );
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM purchase_receiving_events'), 0);
  assert.equal(
    (
      await post(
        app,
        '/p/documents',
        purchase({
          lines: [
            { product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 1, source_unit_amount: '' },
          ],
        }),
      )
    ).status,
    400,
  );
});

function returnCase(raw: ReturnType<typeof freshDb>, id: string, state = 'resolved') {
  raw
    .prepare(
      "INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES (?,'order','order-item','buyer',1,'defective',?,'refund',?)",
    )
    .run(id, state, new Date().toISOString());
}
test('return report reverses exact restored FIFO cost and no inventory cost for damaged goods', async () => {
  const { raw, db, env } = setup();
  seedOrder(raw);
  returnCase(raw, 'good');
  returnCase(raw, 'broken');
  await recordReturnFinancials(env, {
    caseId: 'good',
    orderId: 'order',
    itemId: 'order-item',
    refundIqd: 25000,
    qty: 1,
    restocked: true,
    cogsIqd: 10000,
    actor: 'admin',
    day: baghdadDay(),
  });
  await recordReturnFinancials(env, {
    caseId: 'broken',
    orderId: 'order',
    itemId: 'order-item',
    refundIqd: 25000,
    qty: 1,
    restocked: false,
    actor: 'admin',
    day: baghdadDay(),
  });
  const r = (
    await db
      .prepare(refundsByDaySql({ has0095: true, hasFifo: true, hasOperationalRefunds: true }))
      .bind('2000-01-01', '2100-01-01')
      .all<{ cogs_iqd: number; revenue_iqd: number }>()
  ).results![0];
  assert.equal(r.cogs_iqd, 10000);
  assert.equal(r.revenue_iqd, 50000);
  assert.equal(
    count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key LIKE 'return-stock:%'"),
    1,
  );
});

test('different partial returns cannot restore a unit twice even when their plans race', async () => {
  const { raw, db } = setup();
  seedOrder(raw);
  raw.exec("UPDATE inventory_lots SET qty_received=5,qty_remaining=3 WHERE id='order-lot'");
  const first = await planLotRestore(db, 'order', {
    lineIds: ['order-item'],
    qtyByLine: { 'order-item': 1 },
    operation: 'return:case-with-long-id-111111111111111111111111111111111',
  });
  const racing = await planLotRestore(db, 'order', {
    lineIds: ['order-item'],
    qtyByLine: { 'order-item': 2 },
    operation: 'return:case-with-long-id-222222222222222222222222222222222',
  });
  await db.batch(first.statements);
  await assert.rejects(db.batch(racing.statements), /CHECK/);
  assert.equal(count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='order-lot'"), 4);
  const second = await planLotRestore(db, 'order', {
    lineIds: ['order-item'],
    qtyByLine: { 'order-item': 1 },
    operation: 'return:case-2',
  });
  await db.batch(second.statements);
  assert.equal(count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='order-lot'"), 5);
  const replay = await planLotRestore(db, 'order', { operation: 'return:case-2' });
  assert.equal(replay.statements.length, 0);
});

test('ordinary expense creation, editing, voiding and restoration keep the journal and ledger together', async () => {
  const { raw, app } = setup();
  const created = await post(app, '/e/expenses', {
      category_id: 'wages',
      amount_iqd: 1000,
      expense_day: baghdadDay(),
      title: 'إيجار',
    }),
    body = await json(created);
  assert.equal(created.status, 200, JSON.stringify(body));
  const id = body.ids[0];
  assert.equal((await patch(app, `/e/expenses/${id}`, { amount_iqd: 2000 })).status, 200);
  assert.equal(
    count(raw, "SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='5100'"),
    2000,
  );
  const deleted = await app.request(`/e/expenses/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(
    count(raw, "SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='5100'"),
    0,
  );
  assert.equal((await post(app, `/e/expenses/${id}/restore`, {})).status, 200);
  assert.equal(
    count(raw, "SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='5100'"),
    2000,
  );
});

test('return inspection is tied to an open case; quarantine cannot silently remain sellable', async () => {
  const { raw, app } = setup();
  seedOrder(raw);
  returnCase(raw, 'open', 'received');
  const inspectionId = crypto.randomUUID();
  const inspected = await post(app, '/s/return-inspections', {
    operation_id: inspectionId,
    return_case_id: 'open',
    disposition: 'damage',
  });
  assert.equal(inspected.status, 200, JSON.stringify(await json(inspected)));
  assert.equal(
    (
      await post(app, '/s/return-inspections', {
        operation_id: inspectionId,
        return_case_id: 'other',
        disposition: 'restock',
      })
    ).status,
    409,
  );
  assert.equal(
    row<{ return_case_id: string }>(raw, 'SELECT return_case_id FROM stock_return_inspections')!
      .return_case_id,
    'open',
  );
  const trace = await get(app, '/s/trace');
  assert.equal(trace.status, 200, JSON.stringify(await json(trace)));
  raw.exec("UPDATE inventory_lots SET qty_remaining=1 WHERE id='order-lot'");
  const q = await json(await post(app, '/s/locations', { name: 'حجر', kind: 'quarantine' }));
  assert.equal(
    (
      await post(app, '/s/transfers', {
        operation_id: crypto.randomUUID(),
        lot_id: 'order-lot',
        location_id: q.id,
        qty: 1,
      })
    ).status,
    400,
  );
});

test('Gini bank receivable and courier fee have separate collection limits and reconcile to cash once', async () => {
  const { raw, app, env } = setup();
  seedOrder(raw);
  raw.exec("UPDATE orders SET gini_paid_iqd=50000,due_on_delivery_iqd=5000 WHERE id='order'");
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assert.equal(
    count(raw, "SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='1100'"),
    55000,
  );
  const bank = { operation_id: crypto.randomUUID(), order_id: 'order', payer: 'bank', amount_iqd: 50000 };
  assert.equal((await post(app, '/f/collections', bank)).status, 200);
  assert.equal((await post(app, '/f/collections', bank)).status, 200);
  assert.equal(
    (
      await post(app, '/f/collections', {
        operation_id: crypto.randomUUID(),
        order_id: 'order',
        payer: 'courier',
        amount_iqd: 5000,
        fee_iqd: 1000,
        category_id: 'wages',
      })
    ).status,
    200,
  );
  assert.equal(
    count(raw, "SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='1100'"),
    0,
  );
  assert.equal(
    count(raw, "SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='1000'"),
    54000,
  );
  assert.equal(
    (await post(app, '/f/collections', { ...bank, operation_id: crypto.randomUUID(), amount_iqd: 1 })).status,
    400,
  );
});

test('estimated purchase can be finalized after supplier advance while preserving the payment and receipt value', async () => {
  const { raw, app } = setup();
  const original = purchase({ cost_state: 'estimated' }),
    created = await create(app, original);
  assert.equal(
    (
      await post(app, `/p/documents/${created.id}/payments`, {
        operation_id: crypto.randomUUID(),
        amount_iqd: 10000,
      })
    ).status,
    200,
  );
  const changed = {
    ...original,
    cost_state: 'final',
    version: (await json(await get(app, `/p/documents/${created.id}`))).purchase.version,
    charges: [{ title: 'الشحن النهائي', amount_iqd: 20, basis: 'quantity' }],
  };
  const edited = await put(app, `/p/documents/${created.id}`, changed);
  assert.equal(edited.status, 200, JSON.stringify(await json(edited)));
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM supplier_payments'), 1);
  const updated = await json(await get(app, `/p/documents/${created.id}`));
  const receive = await post(app, `/p/documents/${created.id}/receive`, {
    operation_id: crypto.randomUUID(),
    lines: [{ line_id: updated.lines[0].line_id, qty: 3 }],
  });
  assert.equal(receive.status, 200, JSON.stringify(await json(receive)));
  assert.equal(count(raw, 'SELECT SUM(qty_remaining*unit_cost_iqd) n FROM inventory_lots'), 30020);
  assert.equal(
    count(raw, "SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='1300'"),
    0,
  );
});

test('scoped overhead is allocated only to orders containing the selected department', async () => {
  const { raw, db, app } = setup();
  seedOrder(raw, 'one');
  seedOrder(raw, 'two');
  raw.exec(
    "UPDATE order_items SET product_id='part' WHERE id='two-item';UPDATE inventory_lots SET product_id='part' WHERE id='two-lot'",
  );
  raw
    .prepare(
      "INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day) VALUES ('department-rent','wages',1001,?)",
    )
    .run(baghdadDay());
  const linked = await post(app, '/f/expense-links', {
    expense_id: 'department-rent',
    target_type: 'catalog',
    target_id: 'main',
    allocation_basis: 'orders',
  });
  assert.equal(linked.status, 200, JSON.stringify(await json(linked)));
  const report = await operationsReport(db, baghdadDay(), baghdadDay());
  assert.equal(report.orders.find((o) => o.id === 'one')!.allocated_overhead_iqd, 1001);
  assert.equal(report.orders.find((o) => o.id === 'two')!.allocated_overhead_iqd, 0);
});

test('missing FIFO cost stays pending and posts once when the allocations become complete after revenue posting', async () => {
  const { raw, app, env } = setup();
  await post(app, '/f/rules', ruleInput({ basis: 'profit_percent', amount: 1000 }));
  seedOrder(raw);
  raw.exec("DELETE FROM order_item_inventory_allocations WHERE order_id='order'");
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_order_costs WHERE state='pending_cost'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key='sale:order'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key='cogs:order'"), 0);
  raw.exec(
    "INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES ('repaired','order','order-item','order-lot','base','',2,10000,20000,'repaired')",
  );
  await runOrderFinancialEffects(env, 'order', 'delivered');
  await runOrderFinancialEffects(env, 'order', 'delivered');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key='cogs:order'"), 1);
  assert.equal(count(raw, 'SELECT SUM(amount_iqd) n FROM finance_order_costs'), 3000);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_posting_errors'), 0);
});
