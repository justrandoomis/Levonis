import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, count, freshDb, get, json, post, row, stubApp } from './fixtures/app';
import type { SqliteStatement } from './fixtures/d1';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { changeWithdrawalState, participantOverview, payWithdrawal, requestWithdrawal, staffBasisFingerprintSql } from '../worker/lib/financeParticipants';
import { reconcileEffectiveWages } from '../worker/lib/financeWageCalculation';
import { getOrderProfitBase } from '../worker/lib/orderProfit';
import { investorOrderSplit } from '../worker/lib/investorFinance';
import { drainOrderFinanceRecovery } from '../worker/lib/financeOrderRecovery';
import { runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { baghdadDay } from '../worker/lib/operations';
import type { Env } from '../worker/lib/types';

const sqlBudget = { bytes: 0, nesting: 0 };

async function earningsFixture(options: { staff?: boolean; percentage?: boolean; membership?: 'line' | 'unit'; allocate?: boolean } = {}) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),('employee','employee@x.co','Worker','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('p','Printer','financial-earnings-integration',50000,20000);
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES ('order','buyer','delivered','{}','standard','{}','cash',100000,1500,100000,100000,0,'2026-09-01T00:00:00Z','2026-09-22T10:00:00Z');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES ('line','order','p','Printer',2,50000,100000,20000,'snapshot');
    INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at)
      VALUES ('lot','p','base',2,0,20000,40000,'opening','2026-09-01');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
      VALUES ('allocation','order','line','lot','base',2,20000,40000,'financial-earnings-consumption');`);
  if (options.membership) {
    raw.exec("UPDATE order_items SET membership_discount_iqd=20000,membership_rule_id='member-rule' WHERE id='line'");
    raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='order'").run(JSON.stringify({ lines: [{ product_id: 'p', rule_id: 'member-rule', applied_at: options.membership }] }));
  }
  if(options.allocate===false)raw.exec("DELETE FROM order_item_inventory_allocations; UPDATE inventory_lots SET qty_remaining=2 WHERE id='lot'");
  const real = asD1(raw);
  let gate: { fragment: string; entered: () => void; resumed: Promise<void> } | undefined;
  const db = {
    prepare: (sql: string) => {
      const bytes = Buffer.byteLength(sql, 'utf8');
      sqlBudget.bytes = Math.max(sqlBudget.bytes, bytes);
      assert.ok(bytes <= 100000, `Financial SQL exceeds the 100,000-byte D1 budget: ${bytes}`);
      let nesting = 0;
      for (const character of sql.replace(/'(?:[^']|'')*'|--[^\n]*/g, '')) {
        if (character === '(') sqlBudget.nesting = Math.max(sqlBudget.nesting, ++nesting);
        else if (character === ')') nesting--;
      }
      return real.prepare(sql);
    },
    async batch(statements: SqliteStatement[]) {
      const pending = gate;
      if (pending && statements.some(statement => statement.sql.includes(pending.fragment))) {
        gate = undefined;
        pending.entered();
        await pending.resumed;
      }
      return real.batch(statements as unknown as D1PreparedStatement[]);
    },
  } as unknown as D1Database;
  const app = stubApp(db, { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, a => {
    a.route('/people', adminFinancePeopleRoutes);
    a.route('/operations', adminFinanceOperationsRoutes);
    a.route('/investments', adminInvestmentFinanceRoutes);
  });
  if (options.staff !== false) {
  const staffResponse = await post(app, '/people/staff', { user_id: 'employee', start_work_date: '2026-09-01' });
  const staff = await json(staffResponse);
  assert.equal(staffResponse.status, 200, JSON.stringify(staff));
  const ruleResponse = await post(app, '/operations/rules', { staff_id: staff.id, basis: options.percentage ? 'profit_percent' : 'unit', amount: options.percentage ? 1000 : 10000, milestone: 'delivered' });
  assert.equal(ruleResponse.status, 200, JSON.stringify(await json(ruleResponse)));
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await post(app, `/people/staff/${staff.id}/reconcile`, {});
    const result = await json(response);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.notEqual(result.reconciliation.state, 'failed', JSON.stringify(result));
    if (result.reconciliation.state === 'complete') break;
    assert.notEqual(attempt, 9, 'staff reconciliation did not finish');
  }
  }
  const pauseOn = (fragment: string) => {
    let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    gate = { fragment, entered, resumed };
    return { waiting, resume };
  };
  const recordRefund = () => raw.exec(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution)
      VALUES ('returned','order','line','buyer',1,'shipping_damage','resolved','refund');
    INSERT INTO finance_refund_facts(case_id,order_id,refund_iqd,qty,disposition,cogs_iqd,channel,refunded_day,posted_at)
      VALUES ('returned','order',50000,1,'damage',0,'wallet','2026-10-10','2026-10-10T00:00:00Z');`);
  return { raw, db, app, pauseOn, recordRefund, env: { DB: db } as Env };
}

test('a refund wage correction cannot consume a withdrawal reserved after its calculation', async () => {
  const x = await earningsFixture();
  assert.equal((await participantOverview(x.db, 'employee')).summary.available_earnings_iqd, 20000);
  const cost = row<{ id: string; amount_iqd: number }>(x.raw, "SELECT id,amount_iqd FROM finance_order_costs WHERE order_id='order'")!;
  const wageJournalBefore = count(x.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE source_type IN ('order_cost','finance_cost_adjustment')");
  const targetBefore = row(x.raw, 'SELECT * FROM finance_wage_targets WHERE cost_id=?', cost.id);
  x.recordRefund();
  const gate = x.pauseOn('INSERT INTO finance_cost_adjustments');
  const correction = reconcileEffectiveWages(x.db, 'order', { actor: 'boss' });
  await gate.waiting;
  await requestWithdrawal(x.env, 'employee', 'concurrent-wage-withdrawal', 15000);
  gate.resume();
  await assert.rejects(correction, /تغير|سحب|CHECK|reserved/);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_cost_adjustments WHERE cost_id=?', cost.id), 0);
  assert.equal(row(x.raw, 'SELECT amount_iqd FROM finance_order_costs WHERE id=?', cost.id)!.amount_iqd, 20000);
  assert.equal((await participantOverview(x.db, 'employee')).summary.held_iqd, 15000);
  assert.deepEqual(row(x.raw, 'SELECT * FROM finance_wage_targets WHERE cost_id=?', cost.id), targetBefore);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE source_type IN ('order_cost','finance_cost_adjustment')"), wageJournalBefore);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM audit_log WHERE action='finance.wage_reconciled'"), 0);

  await changeWithdrawalState(x.db, 'concurrent-wage-withdrawal', 'employee', 'cancel', 'employee');
  assert.equal((await reconcileEffectiveWages(x.db, 'order', { actor: 'boss' })).adjusted, 1);
  assert.equal((await participantOverview(x.db, 'employee')).summary.available_earnings_iqd, 10000);
  assert.equal(row(x.raw, 'SELECT amount_iqd FROM finance_order_costs WHERE id=?', cost.id)!.amount_iqd, 20000);
  assert.equal(row(x.raw, 'SELECT delta_iqd FROM finance_cost_adjustments WHERE cost_id=?', cost.id)!.delta_iqd, -10000);
  const journalAfter = count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries');
  assert.equal((await reconcileEffectiveWages(x.db, 'order', { actor: 'boss' })).adjusted, 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_cost_adjustments WHERE cost_id=?', cost.id), 1);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_entries'), journalAfter);
  assert.equal(count(x.raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
});

test('a refunded unit wage that was already paid remains recorded and becomes debt without an open hold', async () => {
  const x = await earningsFixture();
  await requestWithdrawal(x.env, 'employee', 'paid-wage-withdrawal', 20000);
  await changeWithdrawalState(x.db, 'paid-wage-withdrawal', 'boss', 'approve');
  await payWithdrawal(x.db, 'boss', 'paid-wage-withdrawal', { id: 'paid-wage-receipt', reference: 'cash proof', receipt_url: '' });
  const paymentBefore = row(x.raw, "SELECT * FROM finance_withdrawal_payments WHERE id='paid-wage-receipt'");
  x.recordRefund();
  assert.equal((await reconcileEffectiveWages(x.db, 'order', { actor: 'boss' })).adjusted, 1);
  const summary = (await participantOverview(x.db, 'employee')).summary;
  assert.equal(summary.staff_iqd, 10000);
  assert.equal(summary.earnings_paid_iqd, 20000);
  assert.equal(summary.staff_debt_iqd, 10000);
  assert.equal(summary.held_iqd, 0);
  assert.equal(summary.available_earnings_iqd, 0);
  const ownerResponse = await get(x.app, '/people/accounts/employee/earnings');
  assert.equal(ownerResponse.status, 200);
  const ownerAccount = await json(ownerResponse);
  assert.deepEqual(ownerAccount.summary, summary, 'owner and employee must see the same account calculation');
  assert.deepEqual(row(x.raw, "SELECT * FROM finance_withdrawal_payments WHERE id='paid-wage-receipt'"), paymentBefore);
  assert.equal(count(x.raw, 'SELECT SUM(amount_iqd) n FROM finance_staff_payments'), 20000);
  assert.equal((await reconcileEffectiveWages(x.db, 'order', { actor: 'boss' })).adjusted, 0);
  assert.equal(count(x.raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
});

test('frozen membership application changes invalidate wage and investor financial fingerprints', async () => {
  const x = await earningsFixture();
  const wageFingerprint = async () => (await x.db.prepare(`SELECT ${staffBasisFingerprintSql('?1')} AS value`).bind('order').first<{ value: string }>())!.value;
  assert.ok(JSON.parse((await x.db.prepare(`SELECT ${staffBasisFingerprintSql('?1', false)} AS value`).bind('order').first<{ value: string }>())!.value), 'the pre-late-cost SQL path still prepares and executes');
  const unaffected = { wage: await wageFingerprint(), investor: (await investorOrderSplit(x.db, 'order')).source_fingerprint };
  x.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='order'").run(JSON.stringify({ lines: [{ product_id: 'p', applied_at: 'unit' }] }));
  assert.deepEqual({ wage: await wageFingerprint(), investor: (await investorOrderSplit(x.db, 'order')).source_fingerprint }, unaffected,
    'metadata without a positive saving preserves the existing fingerprint bytes');
  x.raw.exec("UPDATE order_items SET membership_discount_iqd=20000,membership_rule_id='member-rule' WHERE id='line'");
  const snapshot = (at: 'line' | 'unit') => JSON.stringify({ lines: [{ product_id: 'p', rule_id: 'member-rule', applied_at: at }] });
  x.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='order'").run(snapshot('line'));
  const before = { wage: await wageFingerprint(), investor: (await investorOrderSplit(x.db, 'order')).source_fingerprint };
  assert.equal((await getOrderProfitBase(x.db, 'order')).lines[0].retained_revenue_iqd, 80000);
  x.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='order'").run(snapshot('unit'));
  assert.equal((await getOrderProfitBase(x.db, 'order')).lines[0].retained_revenue_iqd, 100000);
  assert.deepEqual({
    wage_invalidated: await wageFingerprint() !== before.wage,
    investor_invalidated: (await investorOrderSplit(x.db, 'order')).source_fingerprint !== before.investor,
  }, { wage_invalidated: true, investor_invalidated: true }, 'neither participant may withdraw against the old interpretation of the frozen saving');
  const unit = { wage: await wageFingerprint(), investor: (await investorOrderSplit(x.db, 'order')).source_fingerprint };
  x.raw.exec("UPDATE order_items SET membership_rule_id='different-rule' WHERE id='line'");
  assert.notEqual(await wageFingerprint(), unit.wage, 'changing the frozen rule linkage invalidates the wage basis');
  assert.notEqual((await investorOrderSplit(x.db, 'order')).source_fingerprint, unit.investor);
  assert.equal((await getOrderProfitBase(x.db, 'order')).lines[0].retained_revenue_iqd, 80000, 'missing evidence still restores the historical interpretation');
});

test('staff shares use net profit after every recorded deduction and recover historical paid wages through offsets', async () => {
  const x = await earningsFixture({ percentage: true });
  assert.equal((await participantOverview(x.db, 'employee')).summary.staff_iqd, 6000);
  await requestWithdrawal(x.env, 'employee', 'net-paid', 2000);
  await changeWithdrawalState(x.db, 'net-paid', 'boss', 'approve');
  await payWithdrawal(x.db, 'boss', 'net-paid', { id: 'net-receipt', reference: 'cash', receipt_url: '' });
  const payments = all(x.raw, 'SELECT * FROM finance_staff_payments ORDER BY id');
  const original = all(x.raw, 'SELECT * FROM finance_order_costs ORDER BY id');
  x.raw.exec(`UPDATE order_items SET coupon_discount_iqd=10000,membership_discount_iqd=10000 WHERE id='line';
    UPDATE orders SET coupon_snapshot='{"discount_iqd":14000}',coupon_discount_iqd=14000,points_discount_iqd=5000,price_adjustment_iqd=-5000,total_iqd=66000,due_on_delivery_iqd=66000 WHERE id='order';
    INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state)
      VALUES ('net-credit','buyer','order','line',50000,47000,2,6000,'credited');
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('net-expenses','net-expenses','Expenses');
    INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title) VALUES
      ('net-rent','net-expenses',4000,'2026-09-01','Rent'),('net-pack','net-expenses',2000,'2026-09-22','Packaging'),('net-ad','net-expenses',2000,'2026-09-01','Promotion');
    INSERT INTO finance_expense_links(expense_id,order_id) VALUES ('net-pack','order');
    INSERT INTO finance_monthly_promotions(id,month,currency,amount_minor,exchange_rate,amount_iqd,expense_id,created_by,created_at,updated_at)
      VALUES ('net-promotion','2026-09','IQD',2000,1,2000,'net-ad','boss','2026-09-01','2026-09-01');
    INSERT INTO finance_collections(id,order_id,payer,amount_iqd,fee_iqd,collection_day,actor_id,created_at)
      VALUES ('net-collection','order','customer',66000,1000,'2026-09-22','boss','2026-09-22');`);
  assert.equal((await participantOverview(x.db, 'employee')).summary.available_earnings_iqd, 0, 'old wages cannot fund a withdrawal');
  const recovery = await drainOrderFinanceRecovery(x.env);
  assert.equal(recovery.completed, 1, JSON.stringify(recovery));
  const summary = (await participantOverview(x.db, 'employee')).summary;
  // 100000 - 10000 line coupon - 10000 membership - 5000 points - 5000 price
  // - 40000 COGS - 4000 residual coupon - 6000 credit - 2000 packaging
  // - 1000 fee - 4000 rent = 13000; wage 10% = 1300. Promotion is store-only.
  assert.deepEqual([summary.staff_iqd, summary.earnings_paid_iqd, summary.staff_debt_iqd], [1300, 2000, 700]);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_order_costs ORDER BY id'), original);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_staff_payments ORDER BY id'), payments);
  assert.equal((await getOrderProfitBase(x.db, 'order')).totals.net_goods_iqd, 70000, 'invoice revenue is not rewritten by the participation calculation');
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0, 'replay never repeats the deduction or wage correction');

  // Full-month overhead follows all sold units, including later deliveries.
  x.raw.exec(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
    VALUES ('later','buyer','delivered','{}','standard','{}','cash',100000,1500,100000,100000,'2026-09-23','2026-09-23');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('later-line','later','p','Printer',2,50000,100000);`);
  const updated = await drainOrderFinanceRecovery(x.env);
  assert.equal(updated.completed, 1, JSON.stringify(updated));
  assert.equal((await participantOverview(x.db, 'employee')).summary.staff_iqd, 1500, 'half of the monthly 4000 rent now belongs to the later order; promotion stays with the store');
  assert.equal(count(x.raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
});

test('store promotion never reduces or blocks employee earnings when added, edited or allocated across later sales', async () => {
  const x = await earningsFixture({ percentage: true });
  const before = (await participantOverview(x.db, 'employee')).summary;
  const fingerprint = () => x.db.prepare(`SELECT ${staffBasisFingerprintSql("'order'")} value`).first<{ value: string }>();
  const source = (await fingerprint())!.value;
  x.raw.exec(`INSERT INTO expense_categories(id,slug,name_ar) VALUES ('promotion-expense','promotion-expense','Promotion');
    INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title) VALUES ('store-ad','promotion-expense',80000,'2026-09-01','Store promotion');
    INSERT INTO finance_monthly_promotions(id,month,currency,amount_minor,exchange_rate,amount_iqd,expense_id,created_by,created_at,updated_at)
      VALUES ('store-promotion','2026-09','IQD',80000,1,80000,'store-ad','boss','2026-09-01','2026-09-01');`);
  assert.equal((await fingerprint())!.value, source, 'promotion cannot freeze an existing wage');
  assert.equal((await participantOverview(x.db, 'employee')).summary.available_earnings_iqd, 6000);
  await runOrderFinancialEffects(x.env, 'order', 'delivered');
  assert.equal((await participantOverview(x.db, 'employee')).summary.staff_iqd, 6000);
  x.raw.exec(`UPDATE finance_monthly_promotions SET amount_iqd=200000,amount_minor=200000 WHERE id='store-promotion';
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
      VALUES ('later','buyer','delivered','{}','standard','{}','cash',50000,1500,50000,50000,'2026-09-23','2026-09-23');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('later-line','later','p','Printer',1,50000,50000);`);
  assert.equal((await fingerprint())!.value, source, 'changing promotion allocation across orders cannot freeze wages');
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
  x.raw.exec("UPDATE finance_monthly_promotions SET enabled=0 WHERE id='store-promotion'");
  assert.deepEqual((await participantOverview(x.db, 'employee')).summary, before);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_cost_adjustments'), 0);
});

for (const paidAmount of [0, 2000]) test(`automatic recovery restores wages wrongly reduced by promotion and preserves ${paidAmount} paid IQD`, async () => {
  const x = await earningsFixture({ percentage: true });
  if (paidAmount) {
    await requestWithdrawal(x.env, 'employee', 'promotion-paid', paidAmount);
    await changeWithdrawalState(x.db, 'promotion-paid', 'boss', 'approve');
    await payWithdrawal(x.db, 'boss', 'promotion-paid', { id: 'promotion-receipt', reference: 'cash', receipt_url: '' });
  }
  const original = all(x.raw, 'SELECT * FROM finance_order_costs ORDER BY id');
  const payments = all(x.raw, 'SELECT * FROM finance_staff_payments ORDER BY id');
  // Reproduce the old deduction with an ordinary expense first, then identify
  // it as store promotion. This produces the same posted -6000 wage offset
  // the old participation policy created, without fabricating a wage balance.
  x.raw.exec(`INSERT INTO expense_categories(id,slug,name_ar) VALUES ('old-ad','old-ad','Promotion');
    INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title) VALUES ('old-ad-cost','old-ad',80000,'2026-09-01','Promotion');`);
  await runOrderFinancialEffects(x.env, 'order', 'delivered');
  assert.equal((await participantOverview(x.db, 'employee')).summary.staff_iqd, 0);
  assert.equal(count(x.raw, 'SELECT SUM(delta_iqd) n FROM finance_cost_adjustments'), -6000);
  x.raw.exec(`INSERT INTO finance_monthly_promotions(id,month,currency,amount_minor,exchange_rate,amount_iqd,expense_id,created_by,created_at,updated_at)
      VALUES ('old-promotion','2026-09','IQD',80000,1,80000,'old-ad-cost','boss','2026-09-01','2026-09-01');`);
  // Exact v1 shape: the previous policy included promotion and its monthly
  // sold-unit population even though ordinary expenses were already excluded.
  const source = (await x.db.prepare(`SELECT ${staffBasisFingerprintSql("'order'")} value`).first<{value:string}>())!.value;
  const legacy = JSON.parse(source); legacy[5] = [['old-promotion',80000,1]]; legacy[7] = [['line',2]];
  x.raw.prepare("UPDATE finance_staff_basis SET basis_fingerprint=? WHERE order_id='order'").run(JSON.stringify(legacy));
  const repair = await drainOrderFinanceRecovery(x.env);
  assert.equal(repair.completed, 1, JSON.stringify(repair));
  const summary = (await participantOverview(x.db, 'employee')).summary;
  assert.deepEqual([summary.staff_iqd, summary.earnings_paid_iqd, summary.staff_debt_iqd, summary.available_earnings_iqd], [6000, paidAmount, 0, 6000-paidAmount]);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_order_costs ORDER BY id'), original);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_staff_payments ORDER BY id'), payments);
  assert.deepEqual(all(x.raw, 'SELECT delta_iqd FROM finance_cost_adjustments ORDER BY rowid'), [{ delta_iqd: -6000 }, { delta_iqd: 6000 }]);
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0, 'replay never credits the wage twice');
  assert.equal(count(x.raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
});

test('membership recovery corrects a historical percentage wage through a delta while keeping paid and held money', async () => {
  const x = await earningsFixture({ percentage: true, membership: 'line' });
  assert.equal((await participantOverview(x.db, 'employee')).summary.available_earnings_iqd, 4000);
  await requestWithdrawal(x.env, 'employee', 'member-wage-paid', 1000);
  await changeWithdrawalState(x.db, 'member-wage-paid', 'boss', 'approve');
  await payWithdrawal(x.db, 'boss', 'member-wage-paid', { id: 'member-wage-receipt', reference: 'cash proof', receipt_url: '' });
  await requestWithdrawal(x.env, 'employee', 'member-wage-held', 1000);
  const paid = all(x.raw, 'SELECT * FROM finance_staff_payments ORDER BY id');
  const allocated = all(x.raw, 'SELECT * FROM finance_payment_allocations ORDER BY payment_id,cost_id');
  const original = all(x.raw, 'SELECT * FROM finance_order_costs ORDER BY id');
  // Reconstruct a pre-fix projection: its fingerprint and wage reflected a
  // second subtraction although checkout had already saved at the unit price.
  x.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='order'").run(JSON.stringify({ lines: [{ product_id: 'p', rule_id: 'member-rule', applied_at: 'unit' }] }));
  assert.equal((await participantOverview(x.db, 'employee')).summary.available_earnings_iqd, 0);
  await assert.rejects(requestWithdrawal(x.env, 'employee', 'member-wage-stale', 1));
  const report = await drainOrderFinanceRecovery(x.env);
  assert.deepEqual([report.scanned, report.completed, report.pending, report.failed], [1, 1, 0, 0], JSON.stringify(report));
  const summary = (await participantOverview(x.db, 'employee')).summary;
  assert.deepEqual([summary.staff_iqd, summary.earnings_paid_iqd, summary.held_iqd, summary.available_earnings_iqd], [6000, 1000, 1000, 4000]);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_order_costs ORDER BY id'), original);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_staff_payments ORDER BY id'), paid);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_payment_allocations ORDER BY payment_id,cost_id'), allocated);
  assert.equal(count(x.raw, 'SELECT SUM(delta_iqd) n FROM finance_cost_adjustments'), 2000);
  const after = all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id');
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
  assert.deepEqual(all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id'), after);
  assert.equal(count(x.raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
});

test('bounded membership recovery reaches investor-only historical distributions without rewriting payments or unrelated orders', async context => {
  const x = await earningsFixture({ staff: false, membership: 'line', allocate: false });
  x.raw.exec(`INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,supplier_id,status,created_by)
      VALUES ('incoming','p','base','',2,2,20000,0,0,'supplier','received','boss');
    UPDATE inventory_lots SET incoming_id='incoming',supplier_id='supplier' WHERE id='lot';
    INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at)
      VALUES ('collection','order','customer',100000,'2026-09-22','boss','2026-09-22');`);
  const contract = await post(x.app, '/investments/contracts', { operation_id: 'membership-contract', incoming_id: 'incoming', user_id: 'employee', name: 'Financed stock', principal_iqd: 40000, capital_share_bps: 10000, profit_share_bps: 3500, loss_share_bps: 10000 });
  assert.equal(contract.status, 200, JSON.stringify(await json(contract)));
  const funding = await post(x.app, '/investments/contracts/membership-contract/funding', { operation_id: 'membership-funding', amount_iqd: 40000, payment_day: baghdadDay(), reference: 'funding receipt' });
  assert.equal(funding.status, 200, JSON.stringify(await json(funding)));
  x.raw.exec(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
    VALUES ('allocation','order','line','lot','base',2,20000,40000,'financial-earnings-consumption');
    UPDATE inventory_lots SET qty_remaining=0 WHERE id='lot';`);
  await runOrderFinancialEffects(x.env, 'order', 'delivered', baghdadDay());
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_order_costs'), 0, 'this recovery must not depend on a staff wage candidate');
  assert.equal((await participantOverview(x.db, 'employee')).summary.available_earnings_iqd, 14000);
  await requestWithdrawal(x.env, 'employee', 'member-investor-paid', 5000);
  await changeWithdrawalState(x.db, 'member-investor-paid', 'boss', 'approve');
  await payWithdrawal(x.db, 'boss', 'member-investor-paid', { id: 'member-investor-receipt', reference: 'cash proof', receipt_url: '' });
  await requestWithdrawal(x.env, 'employee', 'member-investor-held', 4000);
  const events = all(x.raw, 'SELECT * FROM investor_finance_events ORDER BY id');
  const receipts = all(x.raw, 'SELECT * FROM finance_withdrawal_payments ORDER BY id');
  const withdrawals = all(x.raw, 'SELECT * FROM finance_withdrawals ORDER BY id');
  const journal = all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id');
  x.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='order'").run(JSON.stringify({ lines: [{ product_id: 'p', rule_id: 'member-rule', applied_at: 'unit' }] }));
  assert.equal((await participantOverview(x.db, 'employee')).summary.available_earnings_iqd, 0);
  await assert.rejects(requestWithdrawal(x.env, 'employee', 'member-investor-stale', 1));
  x.raw.prepare('INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES (?,?,?)').run(baghdadDay().slice(0, 7), new Date().toISOString(), 'boss');
  const closed = await drainOrderFinanceRecovery(x.env);
  assert.deepEqual([closed.scanned, closed.failed], [1, 1], JSON.stringify(closed));
  assert.deepEqual(all(x.raw, 'SELECT * FROM investor_finance_events ORDER BY id'), events);
  assert.deepEqual(all(x.raw, 'SELECT * FROM accounting_entries ORDER BY id'), journal);
  x.raw.prepare('DELETE FROM accounting_periods WHERE month=?').run(baghdadDay().slice(0, 7));
  const report = await drainOrderFinanceRecovery(x.env, { maxOrders: 1 });
  assert.deepEqual([report.scanned, report.completed, report.pending, report.failed], [1, 1, 0, 0], JSON.stringify(report));
  const summary = (await participantOverview(x.db, 'employee')).summary;
  assert.deepEqual([summary.investor_profit_iqd, summary.earnings_paid_iqd, summary.held_iqd, summary.available_earnings_iqd], [21000, 5000, 4000, 12000]);
  assert.equal(summary.capital_iqd, 40000);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_withdrawal_payments ORDER BY id'), receipts);
  assert.deepEqual(all(x.raw, 'SELECT * FROM finance_withdrawals ORDER BY id'), withdrawals);
  for (const event of events) assert.deepEqual(row(x.raw, 'SELECT * FROM investor_finance_events WHERE id=?', String(event.id)), event);
  assert.equal(count(x.raw, "SELECT SUM(amount_iqd) n FROM investor_finance_events WHERE kind='profit_correction'"), 7000);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key='sale:order'"), 1);
  const eventCount = count(x.raw, 'SELECT COUNT(*) n FROM investor_finance_events');
  assert.equal((await drainOrderFinanceRecovery(x.env)).scanned, 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM investor_finance_events'), eventCount);
  assert.equal(count(x.raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
  context.diagnostic(`Financial statements: max ${sqlBudget.bytes} UTF-8 bytes; max parenthesis nesting ${sqlBudget.nesting}; current and pre-late-cost fingerprint SQL both execute`);
});
