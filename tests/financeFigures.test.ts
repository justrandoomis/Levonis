/**
 * «المال والأرباح» — THE FIGURES ARE RIGHT BEFORE THEY ARE PRETTY (redesign step 1,
 * owner 2026-11-11; DECISIONS row 313).
 *
 * Each case was found by the 2026-11-11 audit of the live section and reproduced
 * against the code of 11262b04 (probes kept outside the repo, D:\lv-tmp\fin\server-audit).
 * Every test below failed on that code:
 *
 *   · the period's «الصافي بعد خصومات التقرير» leaves out a returned trade-in credit
 *     that every order and product deducts (dinars and dollars);
 *   · an expense linked to an order that is cancelled after delivery vanishes from
 *     every figure; one linked to an order still on its way is told apart, not lost;
 *   · «known» calls an order complete when its goods cost is only the sale-time
 *     estimate, and nothing says how much of the net rests on estimates;
 *   · the CSV export writes a loss as text («'-30000»), so a spreadsheet sum skips it,
 *     and it carries none of the deductions and no sign of a wage still waiting;
 *   · the month's promotion is spread per PIECE sold, so a bag of cheap parts
 *     carries almost all of it; the owner chose «by sales value» (2026-11-11).
 *
 * Two more, from the people-finance session's review of step 1 and the step's own review
 * (also failing on 11262b04): «known» — the headline while orders are incomplete — and its
 * dollars come after the same deductions as the headline; and in dollars a period, or a
 * day, without a delivered order owes its overheads exactly as in dinars, never «ناقص».
 *
 * The independent review of step 1 (2026-11-11) added the rest, each failing on e4574a8a:
 * the note under the headline named an incomplete order's coupon as taken off it (R2); in
 * dollars an order kind without orders read «ناقص» (R1); the CSV's deduction columns had
 * no tested value and did not add up to the orders when a coupon passed the goods (R3, M3);
 * nothing held the confirmed / estimated split of the overhead by revenue (M1), nor the
 * voided and out-of-period filters of the waiting costs, nor a cancelled order's cost in
 * dollars (M2); and the dollar headline's notes had no cents for the two parts.
 *
 * Redesign step 3 (DECISIONS row 315) adds the server's half of the overview's statement: «known.totals»
 * and «waiting» — the complete and the incomplete orders' sums, each with its share of the overheads, and
 * what each incomplete order waits for — in dinars and in cents, with a statement that adds up to the
 * server's own net, term by term.
 *
 * Run: node --import tsx --test tests/financeFigures.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, post, stubApp } from './fixtures/app';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { monthlyPromotionShares } from '../worker/lib/orderProfit';
import { baghdadDay } from '../worker/lib/operations';
import { overviewNet } from '../src/components/financeWorkspace/overviewFigures';
import { centsAt } from '../src/components/financeWorkspace/displayCurrency';
import type { FinanceSummary } from '../src/components/financeWorkspace/types';
import { statementAddsUp, statementRows, type StatementRow } from '../src/components/financeWorkspace/statement';

type Raw = ReturnType<typeof freshDb>;
const month = () => baghdadDay().slice(0, 7);
const period = () => `from=${month()}-01&to=${new Date(Date.UTC(Number(month().slice(0, 4)), Number(month().slice(5)), 0)).toISOString().slice(0, 10)}`;

interface O { id: string; qty?: number; unit?: number; cost?: number | null; estimate?: number; delivered?: string | null; status?: string; product?: string; shipping?: number; coupon?: number }
/** A Levonis order with one line; `cost` null = never priced, otherwise a priced FIFO lot backs it. */
function order(raw: Raw, o: O) {
  const qty = o.qty ?? 2, unit = o.unit ?? 25000, sub = qty * unit, ship = o.shipping ?? 5000, total = sub + ship;
  const at = o.delivered === undefined ? new Date().toISOString() : o.delivered;
  raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,cod_tax_iqd,points_discount_iqd,order_kind,created_at,delivered_at,coupon_discount_iqd)
    VALUES (?,'buyer',?,'{}','standard','{}','cash',?,1400,?,?,?,0,0,'normal',?,?,?)`).run(o.id, o.status ?? 'delivered', sub, total, total, ship, at ?? new Date().toISOString(), at, o.coupon ?? 0);
  const cost = o.cost === undefined ? 10000 : o.cost, product = o.product ?? 'product';
  raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,sku_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,?,?,'SKU',?,?,?,?,?)`)
    .run(`${o.id}:item`, o.id, product, product, qty, unit, sub, cost, cost === null ? 'unpriced' : 'snapshot');
  if (o.estimate !== undefined) raw.prepare('UPDATE order_items SET estimated_cost_iqd=? WHERE id=?').run(o.estimate, `${o.id}:item`);
  if (cost !== null && o.estimate === undefined) {
    raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES (?,?,'base','',?,0,?,'opening',?)`).run(`${o.id}:lot`, product, qty, cost, at ?? new Date().toISOString());
    raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,?,'base','',?,?,?,?)`)
      .run(`${o.id}:allocation`, o.id, `${o.id}:item`, `${o.id}:lot`, qty, cost, cost * qty, `${o.id}:allocation`);
  }
}
function world() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('admin','boss@x.co','Owner','admin','full'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,stock,product_cost_iqd) VALUES ('product','Printer','fig-printer',25000,0,999),('magnet','Magnet','fig-magnet',500,0,NULL),('esun','eSUN','fig-esun',20000,0,NULL),('switch','Switch','fig-switch',120,0,NULL);
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('rent','fig-rent','إيجار');
    INSERT INTO admin_settings(key,value) VALUES ('exchangeRate','1400') ON CONFLICT(key) DO UPDATE SET value='1400';`);
  const db = asD1(raw);
  const app = stubApp(db, { id: 'admin', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => a.route('/f', adminFinanceWorkspaceRoutes));
  const read = async (path: string) => { const r = await get(app, path); const b = await json(r); assert.equal(r.status, 200, `${path}: ${JSON.stringify(b)}`); return b; };
  return { raw, db, app, read };
}

test('the period net after deductions takes a returned trade-in credit too, as every order and product already does, in dinars and dollars', async () => {
  const w = world();
  order(w.raw, { id: 'order' });
  const now = new Date().toISOString();
  w.raw.exec(`INSERT INTO trade_in_requests(id,user_id,order_id,order_item_id,family,created_at,updated_at) VALUES ('ti','buyer','old-order','old-item','fdm','${now}','${now}');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('ti:lot','product','base','',1,1,7000,'opening','${now}');
    INSERT INTO trade_in_stock(request_id,lot_id,product_id,cost_basis_iqd,order_id,created_at) VALUES ('ti','ti:lot','product',7000,'old-order','${now}');
    INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES ('rc1','order','order:item','buyer',1,'defective','resolved','refund','${now}');
    INSERT INTO finance_refund_facts(case_id,order_id,refund_iqd,qty,disposition,cogs_iqd,channel,refunded_day) VALUES ('rc1','order',18000,1,'restock',10000,'wallet','${baghdadDay()}');
    INSERT INTO trade_in_credit_reissues(id,request_id,coupon_id,order_id,reason,return_case_id,amount_iqd,ends_at,created_at) VALUES ('x1','ti','cpn','order','returned','rc1',7000,'2027-01-01T00:00:00.000Z','${now}');
    UPDATE fx_rate_pairs SET effective_rate='1500', effective_version=1, drift_anchor_rate='1500', effective_source='provider' WHERE pair='USD_IQD';
    INSERT INTO fx_rate_log(id,pair,event,trigger_kind,effective_before,effective_after,result,created_at) VALUES ('l1','USD_IQD','review_approved','owner',NULL,'1500','APPLIED','2026-01-01T00:00:00.000Z');`);
  const s = await w.read(`/f/summary?${period()}&display=USD`);
  const o = s.orders.find((x: { id: string }) => x.id === 'order'), t = s.totals, u = s.display_usd;
  assert.equal(o.net_after_report_adjustments_iqd, o.owner_net_iqd - 7000, 'per order: deducted (as before)');
  assert.equal(t.owner_period_net_after_report_adjustments_iqd, t.owner_period_net_iqd - 7000, 'the period: deducted too');
  assert.equal(t.owner_period_net_after_report_adjustments_iqd, t.net_after_report_adjustments_iqd - t.general_expenses_iqd - t.unallocated_promotion_iqd, 'the period is the orders after their deductions, minus the period overheads');
  const cents = u.orders.order.cents;
  assert.ok(cents.net_after_report_adjustments_cents < cents.owner_net_cents, 'USD per order: the credit comes off, like its dinar twin');
  assert.equal(u.totals.owner_period_net_after_report_adjustments_cents, u.totals.net_after_report_adjustments_cents - (u.totals.general_expenses_cents ?? 0) - (u.totals.unallocated_promotion_cents ?? 0));
});

test('an expense linked to an order cancelled after delivery counts as a general expense on its day; one linked to an order still on its way waits for it, and the summary says so', async () => {
  const w = world();
  order(w.raw, { id: 'order' });
  order(w.raw, { id: 'gone', status: 'cancelled' });
  order(w.raw, { id: 'later', status: 'confirmed', delivered: null });
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('pack1','rent',20000,'${baghdadDay()}','Special packing','admin'),('pack2','rent',9000,'${baghdadDay()}','Prepaid customs','admin'),('rent1','rent',4000,'${baghdadDay()}','Rent','admin');
    INSERT INTO finance_expense_links(expense_id,order_id) VALUES ('pack1','gone'),('pack2','later');`);
  const s = await w.read(`/f/summary?${period()}`);
  assert.equal(s.totals.general_expenses_iqd, 24000, 'the rent and the cost of the cancelled order');
  assert.equal(s.totals.general_waiting_iqd, 9000, 'the cost of the order still on its way is named, not lost');
  assert.equal(s.totals.owner_period_net_iqd, s.totals.owner_net_iqd - 24000);
});

test('«known» tells the confirmed orders from those resting on a sale-time estimate, and the parts add up to its net', async () => {
  const w = world();
  order(w.raw, { id: 'fifo' });
  order(w.raw, { id: 'est', qty: 1, unit: 20000, cost: null, estimate: 15000, product: 'esun', shipping: 0 });
  order(w.raw, { id: 'mag', qty: 60, unit: 500, cost: null, product: 'magnet', shipping: 0 });
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',6000,'${baghdadDay()}','Rent','admin')`);
  const s = await w.read(`/f/summary?${period()}`);
  const k = s.known;
  assert.equal(k.orders_count, 2);
  assert.equal(k.confirmed.orders_count, 1, 'the FIFO order');
  assert.equal(k.estimated.orders_count, 1, 'the order whose cost is only the estimate');
  assert.equal(k.confirmed.owner_net_iqd + k.estimated.owner_net_iqd, k.owner_net_iqd, 'confirmed + estimated = the known net, overheads shared between them');
  assert.equal(k.confirmed.net_after_report_adjustments_iqd + k.estimated.net_after_report_adjustments_iqd, k.net_after_report_adjustments_iqd);
  assert.equal(k.net_after_report_adjustments_iqd, k.owner_net_iqd, 'no deduction in this world');
  // With the never-priced order gone the period is complete — and still says how much rests on an estimate.
  w.raw.exec("DELETE FROM order_items WHERE order_id='mag'; DELETE FROM orders WHERE id='mag';");
  const full = await w.read(`/f/summary?${period()}`);
  assert.notEqual(full.totals.owner_period_net_iqd, null);
  assert.equal(full.known.estimated.orders_count, 1, 'a complete period still names its estimated orders');
  assert.equal(full.known.incomplete_orders, 0);
});

test('the CSV writes amounts as numbers, so a loss sums; text keeps its formula guard; the deductions and a waiting wage have columns', async () => {
  const w = world();
  order(w.raw, { id: 'loss', cost: 40000 });
  w.raw.prepare("UPDATE order_items SET name_snapshot='=HYPERLINK(1)' WHERE id='loss:item'").run();
  w.raw.exec(`INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,qty,amount_iqd,cost_day,state,snapshot)
    VALUES ('c1','loss',NULL,'r1',1,'Packing wage','g','staff_sajjad','rent','delivered',1,NULL,'${baghdadDay()}','pending_cost','{}')`);
  const r = await get(w.app, `/f/export.csv?${period()}`);
  assert.equal(r.status, 200);
  const lines = (await r.text()).replace(/^\uFEFF/, '').split('\r\n');
  const header = lines[0].split(','), row = lines[1].split(',');
  const cell = (f: string) => { const i = header.indexOf(`"${f}"`); assert.ok(i >= 0, `column ${f}`); return row[i]; };
  assert.equal(cell('gross_profit_iqd'), '-30000', 'a number, not «\'-30000»');
  assert.equal(cell('net_goods_iqd'), '50000');
  assert.equal(cell('name_snapshot'), `"'=HYPERLINK(1)"`, 'text that starts a formula is still neutralised');
  for (const f of ['coupon_iqd', 'price_protection_iqd', 'trade_in_credit_returned_iqd', 'net_after_report_adjustments_iqd']) cell(f);
  assert.equal(cell('pending_costs'), '1', 'the waiting wage is visible, not a silent 0');
  assert.equal(cell('owner_net_iqd'), '""', 'the net waits with it');
});

test('the month\'s promotion is shared by sales value: a printer carries its share, a bag of cheap pieces almost none, and the month total is exact', async () => {
  const w = world();
  order(w.raw, { id: 'printer', qty: 1, unit: 1000000, cost: 800000, shipping: 0 });
  order(w.raw, { id: 'switches', qty: 100, unit: 100, cost: 50, product: 'switch', shipping: 0 });
  assert.equal((await post(w.app, '/f/promotions', { month: month(), currency: 'IQD', amount: 10100 })).status, 200);
  const shares = await monthlyPromotionShares(w.db, month());
  assert.equal(shares.total_iqd, 10100);
  assert.equal(shares.shares.get('printer:item'), 10000, '1,000,000 of 1,010,000 in sales');
  assert.equal(shares.shares.get('switches:item'), 100, '10,000 of 1,010,000 in sales — not 100 of 101 pieces');
  assert.equal([...shares.shares.values()].reduce((a, b) => a + b, 0), 10100);
  const s = await w.read(`/f/summary?${period()}`);
  assert.equal(s.allocation_basis, 'sales_value');
  assert.equal(s.products.find((p: { id: string }) => p.id === 'switch').promotion_iqd, 100);
  assert.equal(s.products.find((p: { id: string }) => p.id === 'switch').owner_net_iqd, 10000 - 5000 - 100, 'the switches keep their profit');
  const promotions = await w.read(`/f/promotions?month=${month()}`);
  assert.equal(promotions.allocation_basis, 'sales_value');
});

test('a sale from a batch whose investor agreement was voided completes in the period, as its order sheet already says', async () => {
  const w = world();
  w.raw.exec(`INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd) VALUES ('batch','product','base','',2,2,10000);
    INSERT INTO investment_contracts(id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,loss_share_bps,created_by,created_at,request_json,state) VALUES ('contract','batch','buyer','Funding',20000,10000,1000,1000,'admin','now','{}','void');`);
  order(w.raw, { id: 'order' });
  w.raw.prepare("UPDATE inventory_lots SET incoming_id='batch' WHERE id='order:lot'").run();
  const s = await w.read(`/f/summary?${period()}`);
  const sheet = await w.read('/f/orders/order');
  assert.equal(sheet.totals.owner_net_iqd, 35000, 'the sheet: no active agreement, no investor share');
  assert.equal(s.totals.owner_period_net_iqd, 35000, 'the period agrees instead of waiting for ever');
  assert.equal(s.exceptions.some((e: { type: string }) => e.type === 'investor'), false);
});

/** The shop's dollar rate (1,500), applied since January: every order and day of the period has one. */
const usd = (raw: Raw) => raw.exec(`UPDATE fx_rate_pairs SET effective_rate='1500', effective_version=1, drift_anchor_rate='1500', effective_source='provider' WHERE pair='USD_IQD';
  INSERT INTO fx_rate_log(id,pair,event,trigger_kind,effective_before,effective_after,result,created_at) VALUES ('l1','USD_IQD','review_approved','owner',NULL,'1500','APPLIED','2026-01-01T00:00:00.000Z');`);

test('«known» and its dollars come after the order deductions, as the headline they stand in for while orders are incomplete (people-finance review, 2026-11-11)', async () => {
  const w = world();
  usd(w.raw);
  order(w.raw, { id: 'paid', coupon: 3000 });
  order(w.raw, { id: 'mag', qty: 60, unit: 500, cost: null, product: 'magnet', shipping: 0 });
  const now = new Date().toISOString();
  w.raw.exec(`INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state) VALUES ('pp1','buyer','paid','paid:item',25000,23000,1,2000,'credited');
    INSERT INTO trade_in_requests(id,user_id,order_id,order_item_id,family,created_at,updated_at) VALUES ('ti','buyer','old-order','old-item','fdm','${now}','${now}');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('ti:lot','product','base','',1,1,7000,'opening','${now}');
    INSERT INTO trade_in_stock(request_id,lot_id,product_id,cost_basis_iqd,order_id,created_at) VALUES ('ti','ti:lot','product',7000,'old-order','${now}');
    INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES ('rc1','paid','paid:item','buyer',1,'defective','resolved','refund','${now}');
    INSERT INTO finance_refund_facts(case_id,order_id,refund_iqd,qty,disposition,cogs_iqd,channel,refunded_day) VALUES ('rc1','paid',18000,1,'restock',10000,'wallet','${baghdadDay()}');
    INSERT INTO trade_in_credit_reissues(id,request_id,coupon_id,order_id,reason,return_case_id,amount_iqd,ends_at,created_at) VALUES ('x1','ti','cpn','paid','returned','rc1',7000,'2027-01-01T00:00:00.000Z','${now}');
    INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',6000,'${baghdadDay()}','Rent','admin');`);
  const s = await w.read(`/f/summary?${period()}&display=USD`);
  const k = s.known, uk = s.display_usd.known, oc = s.display_usd.orders.paid.cents;
  assert.equal(s.totals.owner_period_net_after_report_adjustments_iqd, null, 'the never-priced magnets leave the period incomplete');
  assert.deepEqual([k.orders_count, k.incomplete_orders], [1, 1]);
  assert.ok(k.overhead_share_iqd > 0, 'the complete order carries its revenue share of the rent');
  assert.equal(k.net_after_report_adjustments_iqd, k.owner_net_iqd - 3000 - 2000 - 7000, 'the same overhead, after the coupon, the credited price protection and the returned trade-in credit');
  assert.ok(oc.coupon_cents > 0 && oc.price_protection_cents > 0 && oc.trade_in_credit_returned_cents > 0);
  assert.equal(uk.net_after_report_adjustments_cents, uk.owner_net_cents - oc.coupon_cents - oc.price_protection_cents - oc.trade_in_credit_returned_cents, 'in dollars, after the same three');
  const f = overviewNet(s as FinanceSummary, s.display_usd);
  assert.equal(f.fromKnown, true);
  assert.equal(f.net, k.net_after_report_adjustments_iqd, '«صافي حصتك» is the complete orders after their deductions');
  assert.equal(f.cents, uk.net_after_report_adjustments_cents, 'and its dollars are the server\'s, after the same deductions');
  assert.equal(f.deductions, 12000);
});

test('in dollars a period, or a day, without a delivered order owes its overheads as in dinars — never a missing headline beside a dinar figure (step 1 review)', async () => {
  const w = world();
  usd(w.raw);
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',15000,'${baghdadDay()}','Rent','admin')`);
  const empty = await w.read(`/f/summary?${period()}&display=USD`), u = empty.display_usd;
  assert.equal(empty.totals.owner_period_net_after_report_adjustments_iqd, -15000);
  assert.equal(u.totals.owner_period_net_cents, -1000);
  assert.equal(u.totals.owner_period_net_after_report_adjustments_cents, -1000, '15,000 at 1,500: −$10.00, not «ناقص»');
  assert.deepEqual([u.chart.cost_cents, u.chart.owner_net_cents], [1000, -1000], 'the cost tile and the chart say the same');
  assert.equal(overviewNet(empty as FinanceSummary, u).cents, -1000);
  // With an order on another day, the rent's own day still carries the rent in dollars, as in dinars.
  const other = baghdadDay().endsWith('-01') ? `${month()}-02` : `${month()}-01`;
  w.raw.exec(`UPDATE operating_expenses SET expense_day='${other}' WHERE id='rent1'`);
  order(w.raw, { id: 'sold' });
  const s = await w.read(`/f/summary?${period()}&display=USD`);
  const day = s.chart_data.daily.find((d: { day: string }) => d.day === other);
  assert.deepEqual([day.cost_iqd, day.owner_net_iqd], [15000, -15000]);
  assert.deepEqual([s.display_usd.chart.daily[other].cost_cents, s.display_usd.chart.daily[other].owner_net_cents], [1000, -1000]);
  assert.notEqual(s.display_usd.totals.owner_period_net_after_report_adjustments_cents, null);
});

/** On order `id` (one line): a credited price protection of 2,000 and a returned trade-in credit of 7,000 (one piece back, restocked). */
function creditsOn(raw: Raw, id: string) {
  const now = new Date().toISOString();
  raw.exec(`INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state) VALUES ('${id}:pp','buyer','${id}','${id}:item',25000,23000,1,2000,'credited');
    INSERT INTO trade_in_requests(id,user_id,order_id,order_item_id,family,created_at,updated_at) VALUES ('${id}:ti','buyer','old-order','old-item','fdm','${now}','${now}');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('${id}:ti:lot','product','base','',1,1,7000,'opening','${now}');
    INSERT INTO trade_in_stock(request_id,lot_id,product_id,cost_basis_iqd,order_id,created_at) VALUES ('${id}:ti','${id}:ti:lot','product',7000,'old-order','${now}');
    INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES ('${id}:rc','${id}','${id}:item','buyer',1,'defective','resolved','refund','${now}');
    INSERT INTO finance_refund_facts(case_id,order_id,refund_iqd,qty,disposition,cogs_iqd,channel,refunded_day) VALUES ('${id}:rc','${id}',18000,1,'restock',10000,'wallet','${baghdadDay()}');
    INSERT INTO trade_in_credit_reissues(id,request_id,coupon_id,order_id,reason,return_case_id,amount_iqd,ends_at,created_at) VALUES ('${id}:x','${id}:ti','cpn','${id}','returned','${id}:rc',7000,'2027-01-01T00:00:00.000Z','${now}');`);
}

/** The export as rows of named cells: a quoted cell is text (an empty one blank), a bare one a number. */
function csvRows(text: string): Array<Record<string, string | number>> {
  const cells = (line: string) => {
    const out: Array<string | number> = [];
    for (let i = 0; i <= line.length;) {
      if (line[i] === '"') {
        let j = i + 1, value = '';
        while (j < line.length) { if (line[j] === '"' && line[j + 1] === '"') { value += '"'; j += 2; } else if (line[j] === '"') break; else value += line[j++]; }
        out.push(value); i = j + 2;
      } else {
        const end = line.indexOf(',', i), stop = end < 0 ? line.length : end;
        out.push(Number(line.slice(i, stop))); i = stop + 1;
      }
    }
    return out;
  };
  const [head, ...lines] = text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  const names = cells(head) as string[];
  return lines.map((line) => { const row = cells(line); return Object.fromEntries(names.map((name, i) => [name, row[i]])); });
}

test('the note under the headline names only what came off it: while orders are incomplete, the complete orders\' own deductions, never an incomplete order\'s coupon (review R2)', async () => {
  const w = world();
  usd(w.raw);
  order(w.raw, { id: 'fifo' });
  order(w.raw, { id: 'mag', qty: 60, unit: 500, cost: null, product: 'magnet', shipping: 0, coupon: 5000 });
  const s = await w.read(`/f/summary?${period()}&display=USD`);
  assert.equal(s.totals.coupon_iqd, 5000, 'the period has the never-priced order\'s coupon');
  const f = overviewNet(s as FinanceSummary), fu = overviewNet(s as FinanceSummary, s.display_usd);
  assert.deepEqual([f.fromKnown, f.net], [true, 35000], 'the headline is the complete order, which had no coupon');
  assert.equal(f.deductions, 0, 'nothing came off it: the note must not say «−5,000 د.ع»');
  assert.equal(fu.deductionsCents, 0);
  // The same coupon on the complete order: it came off the headline, and the note names it, in dinars and dollars.
  w.raw.exec("UPDATE orders SET coupon_discount_iqd=0 WHERE id='mag'; UPDATE orders SET coupon_discount_iqd=5000 WHERE id='fifo';");
  const s2 = await w.read(`/f/summary?${period()}&display=USD`);
  const g = overviewNet(s2 as FinanceSummary), gu = overviewNet(s2 as FinanceSummary, s2.display_usd);
  assert.deepEqual([g.net, g.deductions], [30000, 5000]);
  assert.equal(gu.deductionsCents, s2.display_usd.orders.fifo.cents.coupon_cents, 'the order\'s own coupon, in its cents');
  assert.equal(gu.cents! + gu.deductionsCents!, s2.display_usd.known.owner_net_cents, 'headline + what came off = the complete orders before their deductions');
});

test('in dollars an order kind without orders is 0 in every column, as in dinars — never «ناقص» beside «0 طلب» (review R1)', async () => {
  const w = world();
  usd(w.raw);
  order(w.raw, { id: 'sold' });
  const s = await w.read(`/f/summary?${period()}&display=USD`);
  const kinds = s.display_usd.kinds;
  for (const kind of ['quick_buy', 'gift']) {
    const iqd = s.kinds.find((k: { kind: string }) => k.kind === kind);
    assert.deepEqual([iqd.orders_count, iqd.gross_profit_iqd], [0, 0], `${kind} in dinars`);
    assert.equal(centsAt(kinds[kind], 'gross_profit_iqd'), 0, `${kind}: the row the overview draws reads $0.00`);
    for (const field of Object.keys(kinds.normal)) assert.equal(kinds[kind][field], 0, `${kind}.${field}`);
  }
  assert.notEqual(kinds.normal.gross_profit_cents, 0, 'the kind that sold carries its figures');
});

test('the CSV deduction columns carry their values, and every column adds up to the orders: a coupon above the goods has its own order-level row (review R3, M3)', async () => {
  const w = world();
  order(w.raw, { id: 'paid', coupon: 3000 });
  creditsOn(w.raw, 'paid');
  // 10,000 of goods (cost 4,000), 5,000 of shipping and a 12,000 coupon: 2,000 of it cut the shipping.
  order(w.raw, { id: 'big', qty: 1, unit: 10000, cost: 4000, coupon: 12000 });
  const s = await w.read(`/f/summary?${period()}`), t = s.totals;
  const r = await get(w.app, `/f/export.csv?${period()}`);
  assert.equal(r.status, 200);
  const rows = csvRows(await r.text());
  const line = (id: string) => rows.find((x) => x.id === id)!;
  const paid = line('paid:item');
  assert.deepEqual([paid.row_kind, paid.coupon_iqd, paid.price_protection_iqd, paid.trade_in_credit_returned_iqd], ['line', 3000, 2000, 7000]);
  assert.equal(paid.net_after_report_adjustments_iqd, (paid.owner_net_iqd as number) - 12000, 'the line\'s net after its coupon, credit and returned trade-in credit');
  assert.equal(paid.net_after_report_adjustments_iqd, s.orders.find((o: { id: string }) => o.id === 'paid').net_after_report_adjustments_iqd);
  const big = line('big:item');
  assert.deepEqual([big.owner_net_iqd, big.coupon_iqd, big.net_after_report_adjustments_iqd], [11000, 10000, 1000], 'the goods carry the coupon up to their value');
  const rest = rows.filter((x) => x.row_kind === 'order_level');
  assert.equal(rest.length, 1, 'one order-level row: the order whose coupon passed its goods');
  assert.deepEqual([rest[0].order_id, rest[0].id, rest[0].coupon_iqd, rest[0].price_protection_iqd, rest[0].trade_in_credit_returned_iqd, rest[0].net_after_report_adjustments_iqd, rest[0].owner_net_iqd],
    ['big', '', 2000, 0, 0, -2000, ''], 'the 2,000 that cut the shipping, with no line and no owner net of its own');
  const column = (f: string) => rows.reduce((v, x) => v + (typeof x[f] === 'number' ? x[f] as number : 0), 0);
  assert.equal(column('owner_net_iqd'), t.owner_net_iqd);
  assert.deepEqual([column('coupon_iqd'), column('price_protection_iqd'), column('trade_in_credit_returned_iqd')], [15000, 2000, 7000]);
  assert.deepEqual([column('coupon_iqd'), column('price_protection_iqd'), column('trade_in_credit_returned_iqd')], [t.coupon_iqd, t.price_protection_iqd, t.trade_in_credit_returned_iqd], 'each deduction column is the period\'s');
  assert.equal(column('net_after_report_adjustments_iqd'), t.net_after_report_adjustments_iqd, 'Σ net after deductions = the orders\' (15,000 − 1,000), not 2,000 over');
  assert.equal(column('net_after_report_adjustments_iqd'), column('owner_net_iqd') - column('coupon_iqd') - column('price_protection_iqd') - column('trade_in_credit_returned_iqd'));
});

test('the complete orders\' overhead is shared between «مؤكد» and «فيها تكلفة تقديرية» by revenue, in dinars and in dollars (review M1)', async () => {
  const w = world();
  usd(w.raw);
  order(w.raw, { id: 'fifo', qty: 1, unit: 100000, cost: 60000, shipping: 0 });
  order(w.raw, { id: 'est', qty: 1, unit: 50000, cost: null, estimate: 30000, product: 'esun', shipping: 0, coupon: 2000 });
  order(w.raw, { id: 'mag', qty: 10, unit: 500, cost: null, product: 'magnet', shipping: 0 });
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',15500,'${baghdadDay()}','Rent','admin')`);
  const s = await w.read(`/f/summary?${period()}&display=USD`), k = s.known;
  assert.equal(k.overhead_share_iqd, 15000, 'the complete orders: 150,000 of 155,000 in revenue');
  assert.deepEqual([k.confirmed.owner_net_iqd, k.estimated.owner_net_iqd], [30000, 15000], '10,000 and 5,000 of the overhead, by revenue — not 7,500 each (32,500 / 12,500)');
  assert.deepEqual([k.confirmed.net_after_report_adjustments_iqd, k.estimated.net_after_report_adjustments_iqd], [30000, 13000], 'the estimated order after its 2,000 coupon');
  // In dollars (1,500): the rent is 1,033 cents, the complete orders carry 1,000 of it, 667 and 333 by revenue.
  const uk = s.display_usd.known;
  assert.deepEqual([uk.confirmed.orders_count, uk.estimated.orders_count], [1, 1]);
  assert.deepEqual([uk.confirmed.owner_net_cents, uk.estimated.owner_net_cents], [2000, 1000], '2,667 − 667 and 1,333 − 333 — not 500 each');
  assert.deepEqual([uk.confirmed.net_after_report_adjustments_cents, uk.estimated.net_after_report_adjustments_cents], [2000, 867]);
  assert.equal(uk.confirmed.owner_net_cents + uk.estimated.owner_net_cents, uk.owner_net_cents, 'the parts add up in dollars too');
  assert.equal(uk.confirmed.net_after_report_adjustments_cents + uk.estimated.net_after_report_adjustments_cents, uk.net_after_report_adjustments_cents);
  const f = overviewNet(s as FinanceSummary, s.display_usd);
  assert.deepEqual([f.confirmed!.cents, f.estimated!.cents], [2000, 867], 'the overview names each part in the headline\'s dollars');
  assert.equal(f.cents, 2867);
});

test('the waiting costs and the general expenses leave out a voided expense and one dated outside the period; in dollars a cancelled order\'s cost reaches the total and its own day (review M2)', async () => {
  const w = world();
  usd(w.raw);
  order(w.raw, { id: 'order' });
  order(w.raw, { id: 'gone', status: 'cancelled' });
  order(w.raw, { id: 'later', status: 'confirmed', delivered: null });
  // A day of the period without the delivered order, and a day of the month before it.
  const day = baghdadDay().endsWith('-01') ? `${month()}-02` : `${month()}-01`;
  const before = new Date(Date.UTC(Number(month().slice(0, 4)), Number(month().slice(5)) - 2, 15)).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by,voided_at,voided_by) VALUES
      ('pack1','rent',20000,'${day}','Special packing','admin',NULL,NULL),('pack2','rent',9000,'${day}','Prepaid customs','admin',NULL,NULL),('rent1','rent',4000,'${day}','Rent','admin',NULL,NULL),
      ('void1','rent',3000,'${day}','Customs, voided','admin','${now}','admin'),('void2','rent',6000,'${day}','Packing, voided','admin','${now}','admin'),
      ('old1','rent',7000,'${before}','Customs, last month','admin',NULL,NULL),('old2','rent',8000,'${before}','Packing, last month','admin',NULL,NULL);
    INSERT INTO finance_expense_links(expense_id,order_id) VALUES ('pack1','gone'),('pack2','later'),('void1','later'),('void2','gone'),('old1','later'),('old2','gone');`);
  const s = await w.read(`/f/summary?${period()}&display=USD`), u = s.display_usd;
  assert.equal(s.totals.general_expenses_iqd, 24000, 'the rent and the cancelled order\'s cost — not a voided one, not last month\'s');
  assert.equal(s.totals.general_waiting_iqd, 9000, 'what waits for the order on its way — not a voided cost, not last month\'s');
  assert.equal(u.totals.general_expenses_cents, 1600, '24,000 at 1,500');
  const d = s.chart_data.daily.find((x: { day: string }) => x.day === day);
  assert.deepEqual([d.cost_iqd, d.owner_net_iqd], [24000, -24000], 'the day the costs were entered carries them');
  assert.deepEqual([u.chart.daily[day].cost_cents, u.chart.daily[day].owner_net_cents], [1600, -1600], 'in dollars too');
});

// ------------------------------------------------------------ redesign step 3 (DECISIONS row 315)
/** The fields /summary sums over orders (sumRows), which the statement's columns are read from. */
const SUMMED = ['net_goods_iqd', 'retained_revenue_iqd', 'cogs_iqd', 'gross_profit_iqd', 'shipping_income_iqd', 'cod_tax_iqd', 'direct_cost_iqd', 'wages_iqd', 'materials_iqd', 'manual_direct_iqd',
  'courier_fee_iqd', 'payment_fee_iqd', 'promotion_iqd', 'investor_iqd', 'owner_net_iqd', 'coupon_iqd', 'price_protection_iqd', 'trade_in_credit_returned_iqd', 'net_after_report_adjustments_iqd',
  'collected_iqd', 'collection_difference_iqd', 'pending_costs', 'unknown_lines', 'units'];
const cellOf = (rows: StatementRow[], key: string, col: 0 | 1 | 2) => rows.find((r) => r.key === key)!.cells[col];

test('the statement\'s columns come from the server: «known.totals» and «waiting» add up to the period, the overheads split by revenue, and each incomplete order says what it waits for (redesign step 3)', async () => {
  const w = world();
  usd(w.raw);
  const day = baghdadDay();
  order(w.raw, { id: 'fifo', coupon: 3000 });
  order(w.raw, { id: 'est', qty: 1, unit: 20000, cost: null, estimate: 15000, product: 'esun', shipping: 0 });
  order(w.raw, { id: 'mag', qty: 60, unit: 500, cost: null, product: 'magnet', shipping: 0 });
  order(w.raw, { id: 'wage' });
  order(w.raw, { id: 'inv' });
  w.raw.exec(`INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,qty,amount_iqd,cost_day,state,snapshot) VALUES
      ('c1','wage',NULL,'r1',1,'Packing wage','g1','staff_sajjad','rent','delivered',1,NULL,'${day}','pending_cost','{}'),
      ('c2','fifo',NULL,'r2',1,'Packing wage','g2','staff_sajjad','rent','delivered',1,7500,'${day}','approved','{}'),
      ('c3','fifo',NULL,'r3',1,'Box','g3',NULL,'rent','delivered',1,2000,'${day}','approved','{}');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd) VALUES ('batch','product','base','',2,2,10000);
    INSERT INTO investment_contracts(id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,loss_share_bps,created_by,created_at,request_json,state) VALUES ('contract','batch','buyer','Funding',20000,10000,1000,1000,'admin','now','{}','active');
    INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',10001,'${day}','Rent','admin');`);
  w.raw.prepare("UPDATE inventory_lots SET incoming_id='batch' WHERE id='inv:lot'").run();
  const s = await w.read(`/f/summary?${period()}&display=USD`);
  const k = s.known, wt = s.waiting, t = s.totals;
  // Each incomplete order names the one thing it waits for, first match in the order the owner fixes them.
  assert.equal(wt.orders_count, 3);
  assert.deepEqual(wt.reasons, { no_price: ['mag'], wage_waits_cost: ['wage'], investor_waits: ['inv'] });
  assert.deepEqual([k.orders_count, k.totals.orders_count, k.incomplete_orders], [2, 2, 3]);
  // The complete orders and the waiting ones add up to the period, field by field, wherever both are known.
  for (const f of SUMMED) {
    if (k.totals[f] === null || wt.totals[f] === null) continue;
    assert.equal(k.totals[f] + wt.totals[f], t[f], f);
  }
  assert.deepEqual([wt.totals.cogs_iqd, wt.totals.investor_iqd, wt.totals.owner_net_iqd], [null, null, null], 'what the waiting orders lack stays unknown, never 0');
  assert.equal(wt.totals.pending_costs, 1);
  // The rent is shared by revenue: what the complete orders carry is their known share, the rest waits with the others.
  assert.equal(k.general_share_iqd, k.overhead_share_iqd);
  assert.equal(k.general_share_iqd + wt.general_share_iqd, 10001, 'the period\'s general expenses, to the dinar');
  assert.equal(k.unallocated_share_iqd + wt.unallocated_share_iqd, 0);
  // The statement drawn from them: the «محسوبة» column adds up to the headline; the period waits.
  const st = statementRows(s as FinanceSummary);
  assert.equal(st.currency, 'IQD');
  assert.equal(statementAddsUp(st.rows, 0), true);
  assert.equal(cellOf(st.rows, 'net', 0), overviewNet(s as FinanceSummary).net, 'the column\'s net is «صافي حصتك»');
  assert.deepEqual([cellOf(st.rows, 'wages', 0), cellOf(st.rows, 'materials', 0)], [7500, 2000]);
  assert.equal(cellOf(st.rows, 'deductions', 0), 3000, 'the confirmed order\'s coupon');
  assert.equal(statementAddsUp(st.rows, 2), null, 'the period waits for the magnets, the wage and the investor');
  assert.deepEqual([cellOf(st.rows, 'cogs', 1), cellOf(st.rows, 'wages', 1), cellOf(st.rows, 'investor', 1), cellOf(st.rows, 'net', 1)], [null, null, null, null]);
  for (const r of st.rows) if (r.cells[0] !== null && r.cells[1] !== null) assert.equal(r.cells[0] + r.cells[1], r.cells[2], `${r.key}: «محسوبة» + «تنتظر» = the period`);
  // In dollars the same columns are the server's cents: the shares add up to the period's, the column to its net.
  const u = s.display_usd;
  assert.equal(u.known.general_share_cents + u.waiting.general_share_cents, u.totals.general_expenses_cents);
  assert.equal(u.waiting.orders_count, 3);
  for (const f of SUMMED.map((x) => x.replace(/_iqd$/, '_cents'))) {
    if (!(f in u.totals) || u.known.totals[f] == null || u.waiting.totals[f] == null) continue;
    assert.equal(u.known.totals[f] + u.waiting.totals[f], u.totals[f], f);
  }
  const su = statementRows(s as FinanceSummary, u);
  assert.equal(su.currency, 'USD');
  assert.equal(statementAddsUp(su.rows, 0), true, 'to the cent');
  assert.equal(cellOf(su.rows, 'net', 0), u.known.net_after_report_adjustments_cents);
  for (const r of su.rows) if (r.cells[0] !== null && r.cells[1] !== null) assert.equal(r.cells[0] + r.cells[1], r.cells[2], `${r.key} in cents`);
});

test('a complete period\'s statement adds up to the server\'s «صافي حصتك» term by term — goods, delivery, COD fee, wages, materials, a manual cost, the courier\'s fee, promotion, rent, coupon and credit — in dinars and to the cent in dollars (redesign step 3)', async () => {
  const w = world();
  usd(w.raw);
  const day = baghdadDay(), m = month();
  order(w.raw, { id: 'fifo', coupon: 3000 });
  order(w.raw, { id: 'est', qty: 1, unit: 20000, cost: null, estimate: 15000, product: 'esun', shipping: 0 });
  w.raw.exec(`UPDATE orders SET cod_tax_iqd=4000,total_iqd=total_iqd+4000,due_on_delivery_iqd=due_on_delivery_iqd+4000 WHERE id='fifo';
    INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,qty,amount_iqd,cost_day,state,snapshot) VALUES
      ('c2','fifo',NULL,'r2',1,'Packing wage','g2','staff_sajjad','rent','delivered',1,7508,'${day}','approved','{}'),
      ('c3','fifo',NULL,'r3',1,'Box','g3',NULL,'rent','delivered',1,2108,'${day}','approved','{}');
    INSERT INTO finance_order_adjustments(id,operation_id,order_id,order_item_id,field,old_value_iqd,new_value_iqd,delta_iqd,version,actor_id,created_at,allocations_json,before_json,after_json) VALUES
      ('adj1','op-courier','fifo','fifo:item','courier_fee_iqd',0,3001,3001,1,'admin','now','[{"line_id":"fifo:item","delta_iqd":3001}]','{}','{}'),
      ('adj2','op-manual','fifo','fifo:item','manual_direct_iqd',0,1499,1499,2,'admin','now','[{"line_id":"fifo:item","delta_iqd":1499}]','{}','{}');
    INSERT INTO finance_order_versions(order_id,version) VALUES ('fifo',2);
    INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state) VALUES ('pp1','buyer','fifo','fifo:item',25000,23000,1,2000,'credited');
    INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',10001,'${day}','Rent','admin'),('promo-exp','rent',6001,'${m}-01','Promotion','admin');
    INSERT INTO finance_monthly_promotions(id,month,title,currency,amount_minor,exchange_rate,amount_iqd,enabled,expense_id,version,created_by,created_at,updated_at) VALUES ('promo','${m}','ترويج','IQD',6001,1,6001,1,'promo-exp',1,'admin','now','now');`);
  const s = await w.read(`/f/summary?${period()}&display=USD`);
  assert.equal(s.waiting, null, 'every order is complete');
  assert.notEqual(s.totals.owner_period_net_after_report_adjustments_iqd, null);
  const st = statementRows(s as FinanceSummary);
  // Every term carries an amount, so the sum proves the order and the signs, not a run of zeros.
  for (const key of ['cod', 'wages', 'materials', 'fees', 'promotion', 'general', 'deductions']) assert.ok((cellOf(st.rows, key, 2) ?? 0) > 0, key);
  assert.equal(cellOf(st.rows, 'materials', 2), 2108 + 1499, 'the box and the manual cost');
  assert.equal(cellOf(st.rows, 'deductions', 2), 3000 + 2000, 'the coupon and the credited price protection');
  assert.equal(statementAddsUp(st.rows, 2), true);
  assert.equal(cellOf(st.rows, 'net', 2), s.totals.owner_period_net_after_report_adjustments_iqd);
  assert.deepEqual(st.rows.map((r) => r.cells[0]), st.rows.map((r) => r.cells[2]), 'nothing waits: «محسوبة» is the period');
  // In dollars each field is converted on its own: 7,508 and 2,108 are 501 and 141 cents, their 9,616 only 641. Read as
  // every direct cost that is not a wage, the materials row still lands on the server's net to the cent.
  const su = statementRows(s as FinanceSummary, s.display_usd);
  assert.equal(su.currency, 'USD');
  assert.equal(statementAddsUp(su.rows, 2), true);
  assert.equal(cellOf(su.rows, 'net', 2), s.display_usd.totals.owner_period_net_after_report_adjustments_cents);
});
