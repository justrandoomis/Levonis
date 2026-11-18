/**
 * PRINTER SERVICES PHASE 3 — WHAT A CLAIM COSTS THE SHOP (owner rulings 2026-11-18; DECISIONS row 347).
 *
 * A warranty or Levo Care claim's out-of-pocket cost is a GENERAL expense of its cost day
 * (operating_expenses, category exp_warranty_claims / exp_care_claims; journal 5100 Dr / 1000 Cr),
 * recorded by the finance scope (owner ruling D3; an assistant is refused), idempotent on its
 * operation id, voided with a reversal. It is never written back to an order: the order's profit,
 * investor and staff shares stay exactly as they were. The money screens show the claims' costs as
 * a line already inside general expenses (never subtracted twice) and add the Care co-pay collected
 * as service income to the period's net (owner ruling D2). An order whose devices carry claim money
 * is never deleted (ORDER_HAS_SERVICE_CLAIMS).
 *
 * Run: node --import tsx --test tests/serviceClaimCosts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, post, json, row, all, type StubUser } from './fixtures/app';
import { deviceRoutes } from '../worker/routes/devices';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { adminFinanceRoutes } from '../worker/routes/adminFinance';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { deleteCancelledOrder } from '../worker/lib/orderDeletion';
import { baghdadDay } from '../worker/lib/operations';
import { serviceClaimsSummary } from '../worker/lib/printerFinance';
import { operationsReport } from '../worker/lib/operationsReport';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const today = baghdadDay();

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'sara@x.co' };
const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const FINANCE: StubUser = { id: 'staff', role: 'admin', email: 'staff@x.co', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };

function seed(): DatabaseSync {
  const raw = freshDb();
  const delivered = iso(Date.now() - 20 * DAY);
  const end = iso(Date.now() + 300 * DAY);
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role,email_verified_at,locale,admin_scope) VALUES
      ('buyer','Sara','sara@x.co','sara','h','customer','2026-01-01T00:00:00.000Z','ar',NULL),
      ('boss','Owner','boss@x.co','boss','h','admin','2026-01-01T00:00:00.000Z','ar',NULL),
      ('staff','Staff','staff@x.co','staff','h','admin','2026-01-01T00:00:00.000Z','ar','full'),
      ('helper','Helper','helper@x.co','helper','h','admin','2026-01-01T00:00:00.000Z','ar','assistant');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p1','a1','Bambu A1',899000);
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at)
     VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,'${delivered}');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES ('oi1','ORD-1','p1','Bambu A1',1,899000,899000);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index,
       delivered_at, warranty_base_months, warranty_start_at, warranty_end_at) VALUES
      ('u1','ORD-1','oi1','p1','buyer',1,'${delivered}',12,'${delivered}','${end}');
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('u1','buyer');
  `);
  return raw;
}
const as = (raw: DatabaseSync, who: StubUser) => stubApp(asD1(raw), who, (a) => {
  a.route('/api/devices', deviceRoutes);
  a.route('/f', adminFinanceWorkspaceRoutes);
});
async function file(raw: DatabaseSync) {
  const res = await json(await post(as(raw, BUYER), '/api/devices/units/u1/claims', {
    subject: 'Fan noise', description: 'The hotend fan is very loud after a month.', idempotencyKey: `cost-${Math.random().toString(36).slice(2, 10)}`,
  }));
  assert.equal(res.success, true, JSON.stringify(res));
  return res.id as string;
}
const addCost = (raw: DatabaseSync, who: StubUser, id: string, body: Record<string, unknown>) => post(as(raw, who), `/api/devices/admin/claims/${id}/costs`, body);

test('a claim cost is a general expense of its cost day, journalled 5100 / 1000, by the finance scope only', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const body = { kind: 'part_purchase', amount_iqd: 12_500, cost_day: today, note: 'Fan from the market', operation_id: 'cost-op-0001' };
    const helper = await addCost(raw, ASSISTANT, id, body);
    assert.equal(helper.status, 403);
    assert.equal((await json(helper)).code, 'FINANCIAL_SCOPE_REQUIRED');

    const res = await json(await addCost(raw, FINANCE, id, body));
    assert.equal(res.success, true, JSON.stringify(res));
    assert.deepEqual([res.cost.kind, res.cost.amount_iqd, res.cost.claim_kind, res.cost.cost_day], ['part_purchase', 12_500, 'warranty', today]);
    // A financial admin records it; reading the claim's costs is the owner's (expenses are cost, decision 2).
    assert.equal(res.costs, null);
    const panel = await json(await get(as(raw, OWNER), `/api/devices/admin/claims/${id}/care`));
    assert.equal(panel.costs_total_iqd, 12_500);
    assert.equal(panel.costs.length, 1);

    const exp = row<{ category_id: string; amount_iqd: number; expense_day: string; voided_at: string | null }>(raw,
      'SELECT e.category_id, e.amount_iqd, e.expense_day, e.voided_at FROM operating_expenses e JOIN service_claim_costs c ON c.expense_id = e.id WHERE c.claim_id = ?', id)!;
    assert.deepEqual([exp.category_id, exp.amount_iqd, exp.expense_day, exp.voided_at], ['exp_warranty_claims', 12_500, today, null]);
    // No order link: it counts as general (financeExpenseKinds), and no order cost row exists.
    assert.equal(all(raw, 'SELECT 1 FROM finance_expense_links').length, 0);
    assert.equal(all(raw, 'SELECT 1 FROM finance_order_costs').length, 0);
    const lines = all<{ account_code: string; debit_iqd: number; credit_iqd: number }>(raw,
      `SELECT l.account_code, l.debit_iqd, l.credit_iqd FROM accounting_lines l JOIN accounting_entries e ON e.id = l.entry_id
        JOIN service_claim_costs c ON c.expense_id = e.source_id WHERE e.source_type = 'expense' ORDER BY l.account_code`);
    assert.deepEqual(lines.map((l) => [l.account_code, l.debit_iqd, l.credit_iqd]), [['1000', 0, 12_500], ['5100', 12_500, 0]]);

    // The same operation id is the same cost; another amount under it is refused.
    const again = await json(await addCost(raw, FINANCE, id, body));
    assert.equal(again.already, true);
    assert.equal((await json(await addCost(raw, FINANCE, id, { ...body, amount_iqd: 1 }))).code, 'CLAIM_COST_OPERATION_REUSED');
    assert.equal(all(raw, 'SELECT 1 FROM service_claim_costs').length, 1);
    // A future day, a bad kind, a fraction: refused.
    const tomorrow = baghdadDay(new Date(Date.now() + 2 * DAY));
    assert.equal((await json(await addCost(raw, FINANCE, id, { ...body, cost_day: tomorrow, operation_id: 'cost-op-0002' }))).code, 'CLAIM_COST_DAY_FUTURE');
    assert.equal((await json(await addCost(raw, FINANCE, id, { ...body, kind: 'gift', operation_id: 'cost-op-0003' }))).code, 'CLAIM_COST_INVALID');
    assert.equal((await addCost(raw, FINANCE, id, { ...body, amount_iqd: 10.5, operation_id: 'cost-op-0004' })).status, 400);
  } finally {
    raw.close();
  }
});

test('a void reverses the expense and its journal; the row is kept; a second void is the same answer', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const res = await json(await addCost(raw, OWNER, id, { kind: 'courier', amount_iqd: 7_000, operation_id: 'cost-op-0101' }));
    const costId = res.cost.id as string;
    assert.equal((await post(as(raw, ASSISTANT), `/api/devices/admin/claims/${id}/costs/${costId}/void`, { reason: 'Entered twice' })).status, 403);
    const v = await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/costs/${costId}/void`, { reason: 'Entered twice' }));
    assert.equal(v.success, true, JSON.stringify(v));
    assert.ok(row(raw, 'SELECT 1 FROM service_claim_costs WHERE id = ? AND voided_at IS NOT NULL', costId));
    assert.ok(row(raw, 'SELECT 1 FROM operating_expenses e JOIN service_claim_costs c ON c.expense_id = e.id WHERE c.id = ? AND e.voided_at IS NOT NULL', costId));
    const net = row<{ d: number; c: number }>(raw,
      `SELECT SUM(l.debit_iqd) AS d, SUM(l.credit_iqd) AS c FROM accounting_lines l JOIN accounting_entries e ON e.id = l.entry_id
        JOIN service_claim_costs sc ON sc.expense_id = e.source_id WHERE l.account_code = '5100'`)!;
    assert.equal(net.d - net.c, 0, 'the expense journal is reversed');
    assert.equal((await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/costs/${costId}/void`, { reason: 'Entered twice' }))).already, true);
    assert.throws(() => raw.exec('DELETE FROM service_claim_costs'), /SERVICE_CLAIM_COST_KEPT/);
  } finally {
    raw.close();
  }
});

test('the period: claim costs are inside general expenses once, the co-pay is service income added to the net, orders untouched', async () => {
  const raw = seed();
  try {
    const before = await json(await get(as(raw, OWNER), `/f/summary?from=${today}&to=${today}`));
    assert.equal(before.success, true, JSON.stringify(before).slice(0, 400));
    const id = await file(raw);
    await addCost(raw, OWNER, id, { kind: 'labor', amount_iqd: 20_000, operation_id: 'cost-op-0201' });
    // A Care co-pay collected today (seeded: the Care flow itself is tests/printerCareClaims.test.ts).
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status, claim_kind)
              VALUES ('wc_care','buyer','oi1','Bambu A1','care claim',NULL,'resolved','approved','care')`);
    raw.prepare(`INSERT INTO care_claim_benefits (id, claim_id, entitlement_unit_id, order_item_id, policy_version, quote_json, list_iqd, eligible_iqd,
                   discount_pct, benefit_iqd, copay_iqd, state, quoted_at, decided_at, decided_day, copay_collected_at, copay_collected_day)
                 VALUES ('ccb1','wc_care','u1','oi1',1,'{}',40000,30000,50,15000,25000,'approved',?,?,?,?,?)`).run(iso(Date.now()), iso(Date.now()), today, iso(Date.now()), today);

    const s = await json(await get(as(raw, OWNER), `/f/summary?from=${today}&to=${today}`));
    assert.equal(s.totals.general_expenses_iqd - (before.totals.general_expenses_iqd ?? 0), 20_000, 'the cost is a general expense, once');
    assert.deepEqual(
      [s.service_claims.warranty_cost_iqd, s.service_claims.care_cost_iqd, s.service_claims.care_benefit_given_iqd, s.service_claims.copay_iqd, s.service_claims.count],
      [20_000, 0, 15_000, 25_000, 1]
    );
    assert.equal(s.service_claims.included_in_general_expenses, true);
    assert.equal(s.service_income_iqd, 25_000);
    assert.equal(s.totals.service_income_iqd, 25_000);
    if (before.totals.owner_period_net_iqd !== null && s.totals.owner_period_net_iqd !== null) {
      // −20,000 of cost (once) + 25,000 of service income.
      assert.equal(s.totals.owner_period_net_iqd - before.totals.owner_period_net_iqd, 5_000);
    }
    // Inspection labour is not configured: report-only and honest about it.
    assert.equal(s.service_claims.inspection_labor_iqd, null);
    assert.equal(s.service_claims.inspection_labor_total_iqd, null);
    // No order moved: no adjustment, no order cost, no investor event.
    assert.equal(all(raw, 'SELECT 1 FROM finance_order_adjustments').length, 0);
    assert.equal(all(raw, 'SELECT 1 FROM finance_order_costs').length, 0);
    assert.equal(all(raw, "SELECT 1 FROM investor_finance_events WHERE order_id = 'ORD-1'").length, 0);
    // The labour figure, once the owner sets it: completed inspections × the figure.
    raw.exec(`INSERT INTO order_service_tasks (id, order_id, order_item_id, kind, choice, qty, note, status, created_at, done_at, done_by)
              VALUES ('ost1','ORD-1','oi1','inspection','full',2,'x','done','${iso(Date.now())}','${iso(Date.now())}','boss')`);
    const withLabor = await serviceClaimsSummary(asD1(raw), { from: today, to: today }, { laborIqd: 4_000 });
    assert.deepEqual([withLabor!.inspections_done, withLabor!.inspection_labor_total_iqd], [2, 8_000]);
    // The operations report carries the same claims block and the services breakdown.
    const report = await operationsReport(asD1(raw), today, today);
    assert.equal(report.service_claims!.warranty_cost_iqd, 20_000);
    assert.equal(report.services_breakdown.printer_lines, 0);
  } finally {
    raw.close();
  }
});

test('an order whose devices carry claim money is never deleted (ORDER_HAS_SERVICE_CLAIMS)', async () => {
  const raw = seed();
  try {
    // An order with its devices is already kept for them (ORDER_HAS_FULFILMENT_HISTORY).
    const id = await file(raw);
    await addCost(raw, OWNER, id, { kind: 'other', amount_iqd: 3_000, operation_id: 'cost-op-0301' });
    raw.exec("UPDATE orders SET status = 'cancelled', cancelled_at = '2026-01-01T00:00:00.000Z' WHERE id = 'ORD-1'");
    await assert.rejects(deleteCancelledOrder(asD1(raw) as never, 'ORD-1'));
    assert.ok(row(raw, "SELECT 1 FROM orders WHERE id = 'ORD-1'"));
    // A line with no unit left but a claim that recorded money: the claims' own guard keeps it.
    raw.exec(`
      INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, cancelled_at)
       VALUES ('ORD-2','buyer','cancelled','{}','standard','{}','cash',1000,0,1400,1000,0,'2026-01-01T00:00:00.000Z');
      INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES ('oi9','ORD-2','p1','Bambu A1',1,1000,1000);
      INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status, claim_kind)
       VALUES ('wc9','buyer','oi9','Bambu A1','old claim',NULL,'resolved','approved','warranty');
    `);
    await addCost(raw, OWNER, 'wc9', { kind: 'other', amount_iqd: 3_000, operation_id: 'cost-op-0302' });
    await assert.rejects(deleteCancelledOrder(asD1(raw) as never, 'ORD-2'), (e: unknown) => (e as { code?: string }).code === 'ORDER_HAS_SERVICE_CLAIMS');
    assert.ok(row(raw, "SELECT 1 FROM orders WHERE id = 'ORD-2'"));
  } finally {
    raw.close();
  }
});

test('the general expense routes refuse an expense a claim cost holds: it is corrected from its claim (CLAIM_HELD_EXPENSE)', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const res = await json(await addCost(raw, FINANCE, id, { kind: 'labor', amount_iqd: 8_000, cost_day: today, note: 'Bench time', operation_id: 'cost-op-held-1' }));
    assert.equal(res.success, true, JSON.stringify(res));
    const expenseId = row<{ expense_id: string }>(raw, 'SELECT expense_id FROM service_claim_costs WHERE claim_id = ?', id)!.expense_id;
    const app = stubApp(asD1(raw), OWNER, (a) => { a.route('/api/admin/finance', adminFinanceRoutes); });
    const send = (method: string, path: string, body?: unknown) => app.request(path, {
      method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const r of [
      await send('PATCH', `/api/admin/finance/expenses/${expenseId}`, { amount_iqd: 1, note: 'edited' }),
      await send('DELETE', `/api/admin/finance/expenses/${expenseId}`, { reason: 'gone' }),
    ]) {
      assert.equal(r.status, 409, await r.clone().text());
      assert.equal((await r.json() as { code: string }).code, 'CLAIM_HELD_EXPENSE');
    }
    assert.ok(row(raw, 'SELECT 1 FROM operating_expenses WHERE id = ? AND voided_at IS NULL AND amount_iqd = 8000', expenseId), 'the expense is untouched');
    // Voided from its claim, it is not brought back from the expense page either.
    const costId = row<{ id: string }>(raw, 'SELECT id FROM service_claim_costs WHERE claim_id = ?', id)!.id;
    const v = await json(await post(as(raw, FINANCE), `/api/devices/admin/claims/${id}/costs/${costId}/void`, { reason: 'Entered twice' }));
    assert.equal(v.success, true, JSON.stringify(v));
    const back = await send('POST', `/api/admin/finance/expenses/${expenseId}/restore`, {});
    assert.equal(back.status, 409, await back.clone().text());
    assert.equal((await back.json() as { code: string }).code, 'CLAIM_HELD_EXPENSE');
    assert.ok(row(raw, 'SELECT 1 FROM operating_expenses WHERE id = ? AND voided_at IS NOT NULL', expenseId), 'still voided');
  } finally {
    raw.close();
  }
});

test('a claim-held expense is never linked to an order (CLAIM_HELD_EXPENSE) and is not offered on the linkable list', async () => {
  const raw = seed();
  try {
    const id = await file(raw);
    const res = await json(await addCost(raw, FINANCE, id, { kind: 'part_purchase', amount_iqd: 9_000, cost_day: today, note: 'Fan', operation_id: 'cost-op-link-1' }));
    assert.equal(res.success, true, JSON.stringify(res));
    const expenseId = row<{ expense_id: string }>(raw, 'SELECT expense_id FROM service_claim_costs WHERE claim_id = ?', id)!.expense_id;
    // An ordinary expense of the same day stays linkable, as before.
    raw.prepare(`INSERT INTO operating_expenses (id, category_id, amount_iqd, expense_day, title, note, created_by, created_at, updated_at)
                 VALUES ('rent-1', 'exp_warranty_claims', 50000, ?, 'Rent', '', 'boss', ?, ?)`).run(today, iso(Date.now()), iso(Date.now()));
    const app = stubApp(asD1(raw), OWNER, (a) => { a.route('/o', adminFinanceOperationsRoutes); });
    const list = await json(await get(app, `/o/expenses?from=${today}&to=${today}`));
    assert.equal(list.success, true, JSON.stringify(list));
    const ids = list.expenses.map((e: { id: string }) => e.id);
    assert.ok(ids.includes('rent-1'), 'an ordinary expense is listed');
    assert.ok(!ids.includes(expenseId), 'a claim cost is not offered for a link');
    // Linked to an order it would move that order's profit and every share read from it: refused, for any link.
    for (const body of [
      { expense_id: expenseId, order_id: 'ORD-1', allocation_basis: 'none', target_type: 'all' },
      { expense_id: expenseId, allocation_basis: 'orders', target_type: 'all' },
    ]) {
      const r = await post(app, '/o/expense-links', body);
      assert.equal(r.status, 409, await r.clone().text());
      assert.equal((await json(r)).code, 'CLAIM_HELD_EXPENSE');
    }
    assert.equal(all(raw, 'SELECT 1 FROM finance_expense_links WHERE expense_id = ?', expenseId).length, 0);
    assert.equal(all(raw, "SELECT 1 FROM finance_order_costs").length, 0);
    assert.equal((await post(app, '/o/expense-links', { expense_id: 'rent-1', allocation_basis: 'none', target_type: 'all' })).status, 200);
  } finally {
    raw.close();
  }
});
