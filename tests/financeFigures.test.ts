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
 * Run: node --import tsx --test tests/financeFigures.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, post, stubApp } from './fixtures/app';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { monthlyPromotionShares } from '../worker/lib/orderProfit';
import { baghdadDay } from '../worker/lib/operations';

type Raw = ReturnType<typeof freshDb>;
const month = () => baghdadDay().slice(0, 7);
const period = () => `from=${month()}-01&to=${new Date(Date.UTC(Number(month().slice(0, 4)), Number(month().slice(5)), 0)).toISOString().slice(0, 10)}`;

interface O { id: string; qty?: number; unit?: number; cost?: number | null; estimate?: number; delivered?: string | null; status?: string; product?: string; shipping?: number }
/** A Levonis order with one line; `cost` null = never priced, otherwise a priced FIFO lot backs it. */
function order(raw: Raw, o: O) {
  const qty = o.qty ?? 2, unit = o.unit ?? 25000, sub = qty * unit, ship = o.shipping ?? 5000, total = sub + ship;
  const at = o.delivered === undefined ? new Date().toISOString() : o.delivered;
  raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,cod_tax_iqd,points_discount_iqd,order_kind,created_at,delivered_at)
    VALUES (?,'buyer',?,'{}','standard','{}','cash',?,1400,?,?,?,0,0,'normal',?,?)`).run(o.id, o.status ?? 'delivered', sub, total, total, ship, at ?? new Date().toISOString(), at);
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
