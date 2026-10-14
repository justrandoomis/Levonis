/** Cross-module money propagation; all rows and requests are local fixtures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, count, freshDb, get, json, post, row, stubApp } from './fixtures/app';
import { adminFinanceRoutes } from '../worker/routes/adminFinance';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { adminFinanceReportRoutes, resetFinanceSchemaMemo } from '../worker/routes/adminFinanceReport';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { getOrderGoods, getOrderProfitBase, profitSourceFingerprint } from '../worker/lib/orderProfit';
import { recordReturnFinancials, runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { baghdadDay } from '../worker/lib/operations';
import { membershipDiscountAtLine, membershipDiscountAtLineSql } from '../worker/lib/orderMembership';
import type { Env } from '../worker/lib/types';
import { drainOrderFinanceRecovery } from '../worker/lib/financeOrderRecovery';
import { correctMembershipSale } from '../worker/lib/membershipSaleCorrection';

function world() {
  const raw = freshDb(), db = asD1(raw), day = baghdadDay(), month = day.slice(0, 7);
  const at = `${day}T10:00:00.000Z`;
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock) VALUES ('p','Printer','integration-printer',50000,16000,0);
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('fees','integration-fees','مصروفات');
    INSERT OR REPLACE INTO admin_settings(key,value) VALUES ('exchangeRate','1400');`);
  raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
    payment_method_id,subtotal_iqd,shipping_iqd,cod_tax_iqd,points_discount_iqd,coupon_discount_iqd,
    membership_discount_iqd,coupon_snapshot,price_adjustment_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
    VALUES ('o','buyer','delivered','{}','standard','{}','cash',100000,5000,1000,3000,0,2000,
    '{"discount_iqd":0}',-5000,1400,96000,96000,?,?)`).run(at, at);
  raw.exec(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,
    cost_iqd,cost_basis,coupon_discount_iqd,membership_discount_iqd)
    VALUES ('item','o','p','Printer',2,50000,100000,16000,'snapshot',0,2000);
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
    VALUES ('lot','p','base','',2,0,20000,'opening','2026-01-01');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
    VALUES ('allocation','o','item','lot','base','',2,20000,40000,'integration:allocation');`);
  resetFinanceSchemaMemo();
  const app = stubApp(db, { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, a => {
    a.route('/expenses', adminFinanceRoutes); a.route('/ops', adminFinanceOperationsRoutes);
    a.route('/workspace', adminFinanceWorkspaceRoutes); a.route('/report', adminFinanceReportRoutes);
    a.route('/investment', adminInvestmentFinanceRoutes);
  }, { publishV2: false }); // finance only: the catalogue product stays as the cut-over left it
  const postOk = async (path: string, body: Record<string, unknown>) => {
    const response = await post(app, path, body), data = await json(response);
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const read = async (path: string) => {
    const response = await get(app, path), data = await json(response);
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const balance = (account: string) => count(raw,
    `SELECT COALESCE(SUM(l.debit_iqd-l.credit_iqd),0) n FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id
      WHERE e.state='posted' AND l.account_code=?`, account);
  const period = `from=${month}-01&to=${day}`;
  return { raw, db, day, month, at, app, postOk, read, balance, period, env: { DB: db } as Env };
}

test('sale, discounts, FIFO, expenses and corrected partial return agree across journals and owner reports without repricing history', async () => {
  const w = world();
  try {
    await runOrderFinancialEffects(w.env, 'o', 'delivered');
    assert.equal(w.balance('4000'), -90000, 'line discounts, points and accepted price delta each apply once');
    assert.equal(w.balance('4100'), -6000, 'delivery and COD income stay separately identifiable');
    assert.equal(w.balance('5000'), 40000, 'actual allocated lot costs beat the earlier 32000 checkout estimate');
    assert.equal(w.balance('1100'), 96000);

    const collection = { operation_id: 'integration-collection', order_id: 'o', amount_iqd: 96000,
      fee_iqd: 2000, payer: 'courier', category_id: 'fees', collection_day: w.day };
    await w.postOk('/ops/collections', collection);
    await w.postOk('/ops/collections', collection);
    assert.equal(w.balance('1100'), 0);
    assert.equal(w.balance('5200'), 2000, 'collection retry never charges a second courier fee');
    const direct = await w.postOk('/expenses/expenses', { category_id: 'fees', amount_iqd: 3000, expense_day: w.day, title: 'Packaging' });
    await w.postOk('/ops/expense-links', { expense_id: direct.ids[0], order_id: 'o' });
    await w.postOk('/expenses/expenses', { category_id: 'fees', amount_iqd: 7000, expense_day: w.day, title: 'Rent' });
    await w.postOk('/workspace/promotions', { month: w.month, amount: 5000, currency: 'IQD' });

    const summary = await w.read(`/workspace/summary?${w.period}`);
    const accounting = await w.read(`/report/summary?${w.period}&granularity=range`);
    assert.equal(summary.totals.net_goods_iqd, 90000);
    assert.equal(summary.totals.cogs_iqd, 40000);
    assert.equal(summary.totals.manual_direct_iqd, 3000);
    assert.equal(summary.totals.courier_fee_iqd, 2000);
    assert.equal(summary.totals.promotion_iqd, 5000);
    assert.equal(summary.totals.general_expenses_iqd, 7000, 'linked costs, courier fees and promotion are excluded from general expenses');
    assert.equal(summary.totals.owner_period_net_iqd, 39000);
    assert.equal(accounting.totals.net_profit_iqd, 39000, 'the two views agree before corrections/distributions');
    assert.equal(accounting.totals.operating_expenses_iqd, 17000);

    await w.postOk('/workspace/orders/o/adjustments', { operation_id: 'integration-cogs-correction', field: 'cogs_iqd', value_iqd: 45000 });
    const corrected = await w.read(`/workspace/summary?${w.period}`);
    assert.equal(corrected.totals.cogs_iqd, 45000);
    assert.equal(corrected.totals.owner_period_net_iqd, 34000);
    assert.equal(w.balance('5000'), 45000);
    assert.equal(row(w.raw, "SELECT cogs_iqd FROM order_item_inventory_allocations WHERE id='allocation'")?.cogs_iqd, 40000);
    assert.equal(row(w.raw, "SELECT cost_iqd FROM order_items WHERE id='item'")?.cost_iqd, 16000);
    assert.equal((await w.read(`/report/summary?${w.period}`)).totals.net_profit_iqd, 39000,
      'the explicitly labelled original accounting view excludes order-specific corrections');

    const journals = JSON.stringify(w.raw.prepare('SELECT * FROM accounting_lines ORDER BY id').all());
    w.raw.exec("UPDATE admin_settings SET value='1900' WHERE key='exchangeRate'; UPDATE products SET product_cost_iqd=99000,price_iqd=180000 WHERE id='p'");
    const afterCatalogueChange = await w.read(`/workspace/summary?${w.period}`);
    assert.deepEqual(afterCatalogueChange.totals, corrected.totals, 'current FX and catalogue prices cannot rewrite recorded IQD results');
    assert.equal(JSON.stringify(w.raw.prepare('SELECT * FROM accounting_lines ORDER BY id').all()), journals);

    w.raw.prepare(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at)
      VALUES ('return','o','item','buyer',1,'defective','resolved','refund',?)`).run(w.at);
    w.raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key,released_at)
      VALUES ('release','o','item','lot','base','',1,20000,20000,'integration:return',?)`).run(w.at);
    await recordReturnFinancials(w.env, { caseId: 'return', orderId: 'o', itemId: 'item', refundIqd: 45000,
      qty: 1, restocked: true, cogsIqd: 20000, actor: 'boss', day: w.day });
    const returned = await getOrderProfitBase(w.db, 'o');
    assert.equal(returned.totals.retained_revenue_iqd, 45000);
    assert.equal(returned.totals.cogs_iqd, 22500, 'one returned unit reverses half the explicit cost correction');
    assert.equal(returned.totals.contribution_profit_iqd, 23500);
    assert.equal(w.balance('4000'), -45000);
    assert.equal(w.balance('5000'), 22500);
    assert.equal((await w.read(`/workspace/summary?${w.period}`)).totals.owner_period_net_iqd, 11500);
    assert.equal(count(w.raw, `SELECT COALESCE(SUM(l.debit_iqd-l.credit_iqd),0) n FROM accounting_lines l
      JOIN accounting_entries e ON e.id=l.entry_id WHERE e.state='posted'`), 0);
  } finally { w.raw.close(); }
});

test('explicit landed-cost corrections reach profit and journals once and follow the remaining goods after a return', async () => {
  const w = world();
  try {
    w.raw.exec(`INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,status,created_by)
      VALUES ('incoming','p','base','',2,2,20000,'received','boss');
      UPDATE inventory_lots SET incoming_id='incoming' WHERE id='lot';`);
    await runOrderFinancialEffects(w.env, 'o', 'delivered');
    const correction = { operation_id: 'integration-landed-correction', incoming_id: 'incoming',
      new_unit_cost_iqd: 23000, adjustment_day: w.day };
    await w.postOk('/investment/lot-cost-adjustments', correction);
    await w.postOk('/investment/lot-cost-adjustments', correction);
    assert.equal((await getOrderProfitBase(w.db, 'o')).totals.cogs_iqd, 46000);
    assert.equal(w.balance('5000'), 46000);
    assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM lot_cost_adjustments'), 1);
    assert.equal(count(w.raw, 'SELECT SUM(recognized_iqd) n FROM lot_cost_adjustment_shares'), 6000);
    assert.equal(row(w.raw, "SELECT unit_cost_iqd FROM inventory_lots WHERE id='lot'")?.unit_cost_iqd, 20000);
    assert.equal(row(w.raw, "SELECT cogs_iqd FROM order_item_inventory_allocations WHERE id='allocation'")?.cogs_iqd, 40000);
    assert.equal((await w.read(`/report/summary?${w.period}`)).totals.cogs_iqd, 40000,
      'the original sale is frozen; the explicit correction is a separate accounting entry');

    w.raw.prepare(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at)
      VALUES ('return','o','item','buyer',1,'defective','resolved','refund',?)`).run(w.at);
    w.raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key,released_at)
      VALUES ('release','o','item','lot','base','',1,20000,20000,'integration:return',?)`).run(w.at);
    await recordReturnFinancials(w.env, { caseId: 'return', orderId: 'o', itemId: 'item', refundIqd: 45000,
      qty: 1, restocked: true, cogsIqd: 20000, actor: 'boss', day: w.day });
    assert.equal((await getOrderProfitBase(w.db, 'o')).totals.cogs_iqd, 23000);
    assert.equal(w.balance('5000'), 23000);
    assert.equal(count(w.raw, 'SELECT SUM(recognized_iqd) n FROM lot_cost_adjustment_shares'), 3000);
    assert.equal(count(w.raw, `SELECT SUM(l.debit_iqd-l.credit_iqd) n FROM accounting_lines l
      JOIN accounting_entries e ON e.id=l.entry_id WHERE e.state='posted'`), 0);
  } finally { w.raw.close(); }
});

test('legacy estimates remain separate from recorded profit and an explicitly unknown cost never becomes zero', async () => {
  const w = world();
  try {
    w.raw.exec("DELETE FROM order_item_inventory_allocations; UPDATE order_items SET cost_iqd=NULL,cost_basis='unrecorded' WHERE id='item'");
    const original = await w.read(`/report/summary?${w.period}`);
    assert.equal(original.totals.estimated_cogs_iqd, 32000);
    assert.equal(original.totals.estimated_revenue_iqd, 93000);
    assert.equal(original.totals.costed_revenue_iqd, 0);
    assert.equal(original.totals.gross_profit_iqd, 0);
    assert.equal((await getOrderProfitBase(w.db, 'o')).totals.cogs_iqd, null);
    w.raw.exec("UPDATE products SET product_cost_iqd=99000 WHERE id='p'; UPDATE admin_settings SET value='1900' WHERE key='exchangeRate'");
    const changed = await w.read(`/report/summary?${w.period}`);
    assert.equal(changed.totals.estimated_cogs_iqd, 198000);
    assert.equal(changed.totals.net_profit_iqd, original.totals.net_profit_iqd);
    w.raw.exec("UPDATE order_items SET cost_basis='unpriced' WHERE id='item'");
    const unknown = await w.read(`/report/summary?${w.period}`);
    assert.equal(unknown.totals.estimated_cogs_iqd, 0);
    assert.equal(unknown.totals.uncosted_revenue_iqd, 93000);
    const profit = await getOrderProfitBase(w.db, 'o');
    assert.equal(profit.totals.gross_profit_iqd, null);
    assert.equal(profit.totals.profit_basis_iqd, null);
  } finally { w.raw.close(); }
});

test('the frozen membership application site prevents an embedded saving from reducing goods revenue twice', async () => {
  const w = world();
  try {
    // Checkout stores total saving in membership_discount_iqd for both kinds;
    // benefit_snapshot records whether the price already contains that saving.
    w.raw.exec("UPDATE orders SET price_adjustment_iqd=0,points_discount_iqd=0,shipping_iqd=0,cod_tax_iqd=0,total_iqd=100000,due_on_delivery_iqd=100000 WHERE id='o'");
    for (const applied_at of ['unit', 'line']) {
      w.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='o'").run(JSON.stringify({
        discount_total_iqd: 2000, unit_discount_iqd: applied_at === 'unit' ? 2000 : 0,
        line_discount_iqd: applied_at === 'line' ? 2000 : 0,
        lines: [{ product_id: 'p', rule_id: null, applied_at, total_iqd: 2000 }],
      }));
      const expected = applied_at === 'unit' ? 100000 : 98000;
      assert.equal((await getOrderGoods(w.db, 'o'))!.lines[0].net_goods_iqd, expected,
        `${applied_at}: the current price already includes unit savings; only a line discount remains to deduct`);
      const report = await w.read(`/report/summary?${w.period}`);
      assert.equal(report.totals.revenue_iqd, expected);
      assert.equal(report.totals.gross_profit_iqd, expected - 40000);
    }
    for (const [snapshot, expected] of [
      [null, 98000], ['{', 98000],
      [JSON.stringify({ lines: [{ product_id: 'p', applied_at: 'unit' }, { product_id: 'p', applied_at: 'line' }] }), 98000],
      [JSON.stringify({ lines: [{ product_id: 'p', rule_id: 'other-rule', applied_at: 'unit' }] }), 98000],
      [JSON.stringify({ lines: ['bad', null, 7, { product_id: 'p', applied_at: 'unit' }, { product_id: 'p', applied_at: 'unit' }] }), 100000],
    ] as const) {
      w.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='o'").run(snapshot);
      assert.equal((await getOrderGoods(w.db, 'o'))!.lines[0].net_goods_iqd, expected);
      assert.equal((await w.read(`/report/summary?${w.period}`)).totals.revenue_iqd, expected,
        'SQL and in-memory projections share safe historical fallback');
    }
    const source = await profitSourceFingerprint(w.db, 'o');
    w.raw.exec("UPDATE orders SET benefit_snapshot=NULL WHERE id='o'");
    assert.notEqual((await profitSourceFingerprint(w.db, 'o')).value, source.value,
      'a concurrently changed frozen membership source invalidates a planned adjustment');
    for (const [product_id, rule_id, expected] of [['123', '456', 0], [123, '456', 2000], ['123', 456, 2000]] as const) {
      const benefit_snapshot = JSON.stringify({ lines: [{ product_id, rule_id, applied_at: 'unit' }] });
      w.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='o'").run(benefit_snapshot);
      const item = { product_id: '123', membership_rule_id: '456', membership_discount_iqd: 2000 };
      assert.equal(membershipDiscountAtLine({ benefit_snapshot }, item), expected);
      assert.equal(w.raw.prepare(`SELECT (${membershipDiscountAtLineSql()}) discount FROM
        (SELECT 'item' id,'o' order_id,'123' product_id,'456' membership_rule_id,2000 membership_discount_iqd) i`).get()!.discount, expected,
      'SQLite text affinity must not turn malformed numeric identifiers into evidence');
    }
  } finally { w.raw.close(); }
});

test('membership recovery reconciles an old native sale journal even without staff or investors', async () => {
  const w = world();
  try {
    w.raw.exec("UPDATE orders SET total_iqd=98000,due_on_delivery_iqd=98000 WHERE id='o'");
    await runOrderFinancialEffects(w.env, 'o', 'delivered');
    assert.equal(w.balance('4000'), -90000);
    const original = w.raw.prepare("SELECT l.* FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.event_key='sale:o' ORDER BY l.id").all();
    // Reconstruct the calculation persisted before the membership fix. Escaped
    // valid JSON must use the same parsed membership evidence as plain JSON.
    w.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='o'").run(JSON.stringify({
      lines: [{ product_id: 'p', rule_id: null, applied_at: 'unit', total_iqd: 2000 }],
    }).replace('"unit"', '"\\u0075nit"'));
    assert.equal((await getOrderProfitBase(w.db, 'o')).totals.net_goods_iqd, 92000);
    assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM finance_order_costs'), 0);
    const fixed = await drainOrderFinanceRecovery(w.env, { maxOrders: 1 });
    assert.deepEqual([fixed.scanned, fixed.completed, fixed.failed], [1, 1, 0], JSON.stringify(fixed));
    assert.equal(w.balance('4000'), -92000, 'the journal must catch up to the corrected frozen invoice');
    assert.equal(w.balance('1100'), 98000, 'receivable reflects the agreed amount, without inventing a cash collection');
    assert.deepEqual(w.raw.prepare("SELECT l.* FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.event_key='sale:o' ORDER BY l.id").all(), original);
    const journalCount = count(w.raw, 'SELECT COUNT(*) n FROM accounting_entries');
    await runOrderFinancialEffects(w.env, 'o', 'delivered');
    assert.equal((await drainOrderFinanceRecovery(w.env)).scanned, 0);
    assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM accounting_entries'), journalCount);
    assert.equal(count(w.raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
  } finally { w.raw.close(); }
});

test('native membership correction respects an advance, a closed period and later actual refunds', async () => {
  const w = world();
  try {
    w.raw.exec("UPDATE orders SET status='confirmed',total_iqd=98000,due_on_delivery_iqd=98000 WHERE id='o'");
    await w.postOk('/ops/collections', { operation_id: 'member-advance', order_id: 'o', amount_iqd: 50000,
      fee_iqd: 0, payer: 'customer', category_id: 'fees', collection_day: w.day });
    w.raw.exec("UPDATE orders SET status='delivered' WHERE id='o'");
    await runOrderFinancialEffects(w.env, 'o', 'delivered');
    assert.equal(w.balance('2300'), -2000);
    w.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='o'").run(JSON.stringify({ lines: [{ product_id: 'p', applied_at: 'unit' }] }));
    const native = count(w.raw, 'SELECT COUNT(*) n FROM accounting_entries');
    w.raw.prepare('INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES (?,?,?)').run(w.month, w.at, 'boss');
    const closed = await drainOrderFinanceRecovery(w.env);
    assert.deepEqual([closed.scanned, closed.failed], [1, 1]);
    assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM accounting_entries'), native);
    w.raw.exec('DELETE FROM accounting_periods');
    assert.equal((await drainOrderFinanceRecovery(w.env)).completed, 1);
    assert.equal(w.balance('2300'), 0, 'the full recorded advance is now recognized');
    assert.equal(w.balance('1100'), 48000, 'the correction does not collect or refund customer money');
    assert.equal(w.balance('4000'), -92000);
    w.raw.prepare(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at)
      VALUES ('member-return','o','item','buyer',1,'defective','resolved','refund',?)`).run(w.at);
    await recordReturnFinancials(w.env, { caseId: 'member-return', orderId: 'o', itemId: 'item', refundIqd: 46000,
      qty: 1, restocked: true, cogsIqd: 20000, actor: 'boss', day: w.day });
    assert.equal(w.balance('4000'), -46000);
    assert.equal((await getOrderProfitBase(w.db, 'o')).totals.retained_revenue_iqd, 46000);
    assert.equal(count(w.raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
  } finally { w.raw.close(); }
});

test('concurrent native membership corrections post once and unexplained old journals require review', async () => {
  const w = world();
  try {
    w.raw.exec("UPDATE orders SET total_iqd=98000,due_on_delivery_iqd=98000 WHERE id='o'");
    await runOrderFinancialEffects(w.env, 'o', 'delivered');
    w.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='o'").run(JSON.stringify({ lines: [{ product_id: 'p', applied_at: 'unit' }] }));
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const resumed = new Promise<void>(resolve => { release = resolve; });
    const paused = { prepare: (sql: string) => w.db.prepare(sql), batch: async (statements: D1PreparedStatement[]) => {
      entered(); await resumed; return w.db.batch(statements);
    } } as D1Database;
    const stale = assert.rejects(correctMembershipSale(paused, 'o', w.day));
    await waiting;
    await correctMembershipSale(w.db, 'o', w.day);
    release(); await stale;
    await correctMembershipSale(w.db, 'o', w.day);
    assert.equal(count(w.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key='membership-sale:o'"), 1);
    assert.equal(w.balance('4000'), -92000);
  } finally { w.raw.close(); }
  const w2 = world();
  try {
    await runOrderFinancialEffects(w2.env, 'o', 'delivered');
    w2.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='o'").run(JSON.stringify({ lines: [{ product_id: 'p', applied_at: 'unit' }] }));
    w2.raw.exec("UPDATE order_items SET line_total_iqd=110000 WHERE id='item'");
    const countBefore = count(w2.raw, 'SELECT COUNT(*) n FROM accounting_entries');
    await assert.rejects(correctMembershipSale(w2.db, 'o', w2.day), (error: unknown) =>
      !!error && typeof error === 'object' && 'code' in error && error.code === 'MEMBERSHIP_SALE_REVIEW_REQUIRED');
    assert.equal(count(w2.raw, 'SELECT COUNT(*) n FROM accounting_entries'), countBefore);
  } finally { w2.raw.close(); }
});
