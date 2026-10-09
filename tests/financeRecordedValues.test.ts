/**
 * ACCOUNTING STAYS IQD, FROM THE VALUES RECORDED AT THE TIME (owner brief
 * 2026-10-09, "Accounting Currency"; design P-A §7.2, fixes F1–F5).
 *
 * «عند حساب الأرباح لا تعيد استنتاج التكلفة من الدولار الحالي. اعتمد القيم
 * الفعلية المسجلة وقت العملية» — profit is the revenue actually paid minus the
 * cost actually recorded. These tests pin the five places that did otherwise:
 *   F1  the old report priced an unrecorded cost from TODAY's catalogue into
 *       gross and net profit — it now stands apart as an estimate;
 *   F2  the order sheet offered today's catalogue or today's stock as the cost
 *       of a sale that already happened — a terminal order gets neither;
 *   F3  a USD promotion with no rate was booked at the wallet's 1,400 — it now
 *       needs the rate actually paid;
 *   F4  the order-level coupon was never deducted in the workspace;
 *   F5  price-protection credits were never deducted in the workspace —
 *       both now as report-only deductions (tests/financeOverlayNoSettlement
 *       proves no settlement moves).
 *
 * Run: node --import tsx --test tests/financeRecordedValues.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, count, freshDb, get, json, patch, post, row, stubApp } from './fixtures/app';
import { adminFinanceReportRoutes, resetFinanceSchemaMemo } from '../worker/routes/adminFinanceReport';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';

const OWNER = { id: 'boss', email: 'boss@x.co', role: 'admin' as const, admin_scope: 'full' };

function world() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('boss','boss@x.co','Owner','admin','full'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('p_kit','Kit','recorded-kit',10000,4000),('p_cam','Camera','recorded-cam',90000,50000);
    INSERT OR REPLACE INTO admin_settings(key,value) VALUES ('exchangeRate','1400');`);
  const order = (id: string, status: string, o: { delivered?: string | null; coupon?: number; created?: string } = {}) =>
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at,coupon_snapshot)
      VALUES (?,'buyer',?,'{}','standard','{}','cash',0,1400,0,0,0,?,?,?)`).run(id, status, o.created ?? '2026-03-04T09:00:00.000Z',
      o.delivered === undefined ? (status === 'delivered' ? '2026-03-05T10:00:00.000Z' : null) : o.delivered,
      o.coupon ? JSON.stringify({ code: 'SAVE', discount_iqd: o.coupon }) : null);
  const item = (id: string, orderId: string, product: string, qty: number, unit: number, cost: number | null, basis: string) =>
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, orderId, product, product, qty, unit, qty * unit, cost, basis);
  const report = () => {
    resetFinanceSchemaMemo();
    return stubApp(asD1(raw), OWNER, (a) => a.route('/r', adminFinanceReportRoutes));
  };
  const workspace = () => stubApp(asD1(raw), OWNER, (a) => a.route('/f', adminFinanceWorkspaceRoutes));
  return { raw, order, item, report, workspace };
}

// ------------------------------------------------------------------ F1

test('F1: a cost never recorded at sale is an estimate apart — gross and net come from recorded costs only, and a catalogue change moves neither', async () => {
  const w = world();
  w.order('o1', 'delivered');
  w.item('o1:a', 'o1', 'p_kit', 1, 10000, 2000, 'snapshot'); // recorded at sale: a fact
  w.item('o1:b', 'o1', 'p_kit', 2, 10000, null, 'unrecorded'); // pre-0095: only today's catalogue knows
  const read = async () => (await json(await get(w.report(), '/r/summary?from=2026-03-01&to=2026-03-31&granularity=range'))).totals;

  let t = await read();
  assert.equal(t.revenue_iqd, 30000);
  assert.equal(t.costed_revenue_iqd, 10000, 'only the recorded line is in the margin base');
  assert.equal(t.cogs_iqd, 2000);
  assert.equal(t.gross_profit_iqd, 8000);
  assert.equal(t.net_profit_iqd, 8000);
  assert.equal(t.estimated_revenue_iqd, 20000);
  assert.equal(t.estimated_cogs_iqd, 8000, '2 × today\'s 4,000 — reported, never subtracted');
  assert.equal(t.estimated_profit_iqd, 12000);
  assert.equal(t.costed_revenue_iqd + t.uncosted_revenue_iqd + t.estimated_revenue_iqd, t.revenue_iqd);

  // The supplier price changes. The profit that was recorded does not move;
  // only the estimate, which says it is one, does.
  w.raw.exec("UPDATE products SET product_cost_iqd = 9000 WHERE id = 'p_kit'");
  t = await read();
  assert.equal(t.gross_profit_iqd, 8000);
  assert.equal(t.net_profit_iqd, 8000);
  assert.equal(t.estimated_cogs_iqd, 18000);
  assert.equal(t.estimated_profit_iqd, 2000);
});

// ------------------------------------------------------------------ F2

test('F2: a delivered order is never re-costed from today\'s catalogue or stock — the recorded snapshot is its only suggestion; an order in flight keeps its forecast', async () => {
  const w = world();
  // Stock on the shelf today, priced: the very thing F2 must not offer as a past sale's cost.
  w.raw.exec(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
    VALUES ('lot_today','p_cam','base','',5,5,61000,'opening','2026-10-01')`);
  w.order('done', 'delivered');
  w.item('done:1', 'done', 'p_cam', 1, 90000, null, 'unpriced');
  w.order('snap', 'delivered');
  w.item('snap:1', 'snap', 'p_cam', 1, 90000, 47000, 'unrecorded');
  w.order('open', 'confirmed', { delivered: null });
  w.item('open:1', 'open', 'p_cam', 1, 90000, null, 'unpriced');
  const before = count(w.raw, 'SELECT COUNT(*) n FROM finance_order_adjustments');
  const detail = async (id: string) => {
    const res = await get(w.workspace(), `/f/orders/${id}`);
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body));
    return body;
  };

  const done = await detail('done');
  assert.equal(done.lines[0].cogs_iqd, null);
  assert.equal(done.lines[0].cost_review.suggestion, null, 'no current catalogue, no current stock');
  assert.equal(done.lines[0].cost_projection, undefined);
  assert.equal(done.lines[0].cost_review.can_verify, false);
  assert.doesNotMatch(JSON.stringify(done), /current_catalogue|confirmed_lot|61000|50000/);

  // A cost recorded on the line at the time of sale is still offered: it IS the recorded value.
  const snap = await detail('snap');
  assert.equal(snap.lines[0].cost_review.suggestion.source, 'order_snapshot');
  assert.equal(snap.lines[0].cost_review.suggestion.total_cost_iqd, 47000);

  // Not sold yet: the forecast stays, labelled a forecast, and earns nothing.
  const open = await detail('open');
  assert.ok(open.lines[0].cost_projection, 'an order in flight keeps its forecast');
  assert.equal(open.projected_finance.is_estimate, true);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM finance_order_adjustments'), before, 'reading writes nothing');
});

test('F2 client: the order sheet offers manual entry only, with the sentence in three languages', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('./fixtures/d1');
  const sheet = readFileSync(join(ROOT, 'src/components/financeWorkspace/OrderProfitSheet.tsx'), 'utf8');
  assert.match(sheet, /PA_STRINGS\.noRecordedCost/);
  const { PA_STRINGS } = await import('../src/components/financeWorkspace/displayCurrencyStrings');
  assert.equal(PA_STRINGS.noRecordedCost.ar, 'لا توجد تكلفة مسجلة وقت البيع؛ أدخل التكلفة الفعلية إن كانت معروفة');
});

// ------------------------------------------------------------------ F3

test('F3: a USD promotion needs the rate actually paid — never the wallet\'s 1,400; an edit keeps its stored rate; nothing is written on a refusal', async () => {
  const w = world();
  const app = w.workspace();
  const month = '2026-03';
  const promotions = () => count(w.raw, 'SELECT COUNT(*) n FROM finance_monthly_promotions');
  const expenses = () => count(w.raw, 'SELECT COUNT(*) n FROM operating_expenses');
  const [p0, e0] = [promotions(), expenses()];

  const refused = await post(app, '/f/promotions', { month, amount: 100, currency: 'USD' });
  const body = await json(refused);
  assert.equal(refused.status, 400);
  assert.equal(body.code, 'PROMOTION_RATE_REQUIRED');
  assert.doesNotMatch(JSON.stringify(body), /1400|140000/, 'the refusal names no rate');
  assert.equal((await post(app, '/f/promotions', { month, amount: 100, currency: 'USD', exchange_rate: '' })).status, 400, 'blank is missing');
  assert.equal(promotions(), p0);
  assert.equal(expenses(), e0);

  const created = await post(app, '/f/promotions', { month, amount: 100, currency: 'USD', exchange_rate: 1450 });
  const made = await json(created);
  assert.equal(created.status, 200, JSON.stringify(made));
  const stored = row<{ exchange_rate: number; amount_iqd: number }>(w.raw, 'SELECT exchange_rate, amount_iqd FROM finance_monthly_promotions WHERE id = ?', made.id)!;
  assert.equal(stored.exchange_rate, 1450);
  assert.equal(stored.amount_iqd, 145000, '100 USD at the rate paid, not 140,000 at the wallet\'s');

  // An edit of the amount alone keeps the row's own rate (the old path).
  const edited = await patch(app, `/f/promotions/${made.id}`, { amount: 120 });
  assert.equal(edited.status, 200, JSON.stringify(await json(edited)));
  assert.equal(row<{ amount_iqd: number }>(w.raw, 'SELECT amount_iqd FROM finance_monthly_promotions WHERE id = ?', made.id)!.amount_iqd, 174000);
  // A change of currency is a new rate: it must be given.
  const euro = await patch(app, `/f/promotions/${made.id}`, { currency: 'EUR', amount: 50 });
  assert.equal(euro.status, 400);
  assert.equal((await json(euro)).code, 'PROMOTION_RATE_REQUIRED');
  assert.equal(row<{ currency: string }>(w.raw, 'SELECT currency FROM finance_monthly_promotions WHERE id = ?', made.id)!.currency, 'USD');
  // A dinar promotion needs no rate.
  w.raw.exec("UPDATE finance_monthly_promotions SET enabled = 0");
  assert.equal((await post(app, '/f/promotions', { month: '2026-04', amount: 50000, currency: 'IQD' })).status, 200);
});

test('F3 client: the rate field is in view for a foreign currency, required unless the row keeps its own, and the save waits for it', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('./fixtures/d1');
  const src = readFileSync(join(ROOT, 'src/components/financeWorkspace/MonthlyCosts.tsx'), 'utf8');
  assert.match(src, /\{foreign && rateField\}/);
  assert.match(src, /\(foreign && !keepsRate && exchange\.trim\(\) === ''\)/);
  assert.doesNotMatch(src, /سعر صرف المتجر|store exchange rate/, 'the old «blank = the store rate» hint is gone');
});

// ------------------------------------------------------------------ F4 + F5

test('F4: the order-level coupon is deducted in full at the order, only min(coupon, goods) reaches the products, and orders.coupon_discount_iqd is the fallback', async () => {
  const w = world();
  // 10,000 of goods + 5,000 shipping; a 12,000 coupon also cut the shipping.
  w.order('big', 'delivered', { coupon: 12000 });
  w.raw.exec("UPDATE orders SET shipping_iqd = 5000 WHERE id = 'big'");
  w.item('big:1', 'big', 'p_kit', 1, 10000, 3000, 'snapshot');
  // No snapshot JSON: the column the store builder writes is the fallback.
  w.order('col', 'delivered');
  w.raw.exec("UPDATE orders SET coupon_discount_iqd = 4000 WHERE id = 'col'");
  w.item('col:1', 'col', 'p_cam', 1, 90000, 50000, 'snapshot');
  // A coupon partly carried by a line already: only the rest is order-level.
  w.order('split', 'delivered', { coupon: 6000 });
  w.item('split:1', 'split', 'p_kit', 1, 10000, 3000, 'snapshot');
  w.raw.exec("UPDATE order_items SET coupon_discount_iqd = 2500 WHERE id = 'split:1'");

  const res = await get(w.workspace(), '/f/summary?from=2026-03-01&to=2026-03-31');
  const summary = await json(res);
  assert.equal(res.status, 200, JSON.stringify(summary));
  const orders = Object.fromEntries(summary.orders.map((o: Record<string, unknown>) => [o.id, o]));
  assert.equal(orders.big.coupon_iqd, 12000, 'the whole coupon at the order');
  assert.equal(orders.big.net_after_report_adjustments_iqd, (orders.big.owner_net_iqd as number) - 12000);
  assert.equal(orders.col.coupon_iqd, 4000, 'orders.coupon_discount_iqd when no snapshot');
  assert.equal(orders.split.coupon_iqd, 3500, '6,000 less the 2,500 a line already carries');
  const kit = summary.products.find((p: { id: string }) => p.id === 'p_kit');
  // big gives the kit at most its 10,000 of goods; split gives 3,500 of its 7,500.
  assert.equal(kit.coupon_iqd, 10000 + 3500);
  assert.equal(kit.net_after_report_adjustments_iqd, kit.owner_net_iqd - kit.coupon_iqd);
  assert.equal(summary.totals.coupon_iqd, 12000 + 4000 + 3500, 'totals are the orders summed');
  assert.equal(summary.totals.owner_period_net_after_report_adjustments_iqd, summary.totals.owner_period_net_iqd - summary.totals.coupon_iqd - summary.totals.price_protection_iqd);
  // The accounting basis is untouched: owner net is what it was without the overlay.
  assert.equal(orders.big.net_goods_iqd, 10000);
  assert.equal(orders.big.owner_net_iqd, 10000 - 3000 + 5000);
});

test('F5: a credited price-protection claim is deducted on its line and order; a requested one is not', async () => {
  const w = world();
  w.order('pp', 'delivered');
  w.item('pp:1', 'pp', 'p_cam', 2, 90000, 50000, 'snapshot');
  w.raw.exec(`INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state)
    VALUES ('ppc_paid','buyer','pp','pp:1',90000,85000,2,10000,'credited'),('ppc_open','buyer','pp','pp:1',90000,80000,2,0,'requested')`);
  const summary = await json(await get(w.workspace(), '/f/summary?from=2026-03-01&to=2026-03-31'));
  assert.equal(summary.orders[0].price_protection_iqd, 10000);
  assert.equal(summary.orders[0].net_after_report_adjustments_iqd, summary.orders[0].owner_net_iqd - 10000);
  assert.equal(summary.products.find((p: { id: string }) => p.id === 'p_cam').price_protection_iqd, 10000);
  assert.equal(summary.totals.price_protection_iqd, 10000);
  const detail = await json(await get(w.workspace(), '/f/orders/pp'));
  assert.equal(detail.totals.price_protection_iqd, 10000);
  assert.equal(detail.lines[0].price_protection_iqd, 10000);
  assert.equal(detail.totals.owner_net_iqd, 180000 - 100000, 'owner net — the settled figure — does not move');
});

