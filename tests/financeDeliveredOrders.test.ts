import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, row, stubApp } from './fixtures/app';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';

const period = 'from=2026-10-01&to=2026-10-06';

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('owner','boss@x.co','Owner','admin','full'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO catalogs(id,name_ar,name_en,slug) VALUES ('finance-delivered','مبيعات مستلمة','Delivered sales','finance-delivered');
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,category_id) VALUES
      ('sold','Delivered product','finance-delivered-product',25000,10000,'finance-delivered'),
      ('unsold','Undelivered product','finance-undelivered-product',999000,NULL,'finance-delivered');`);
  const db = asD1(raw);
  const app = stubApp(db, { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, a => a.route('/f', adminFinanceWorkspaceRoutes));
  const add = (id: string, status = 'delivered', options: { delivered?: string | null; created?: string; product?: string; qty?: number } = {}) => {
    const product = options.product ?? 'sold', qty = options.qty ?? 1;
    const cost = product === 'sold' ? 10000 : null;
    const price = product === 'sold' ? 25000 : 999000;
    const created = options.created ?? '2026-10-02T10:00:00Z';
    const delivered = options.delivered === undefined ? status === 'delivered' ? '2026-10-03T10:00:00Z' : null : options.delivered;
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer',?,'{}','standard','{}','cash',?,1400,?,?,5000,?,?)`).run(id,status,qty*price,qty*price+5000,qty*price+5000,created,delivered);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(`${id}:item`,id,product,product==='sold'?'Delivered product':'Undelivered product',qty,price,qty*price,cost,cost===null?'unpriced':'snapshot');
  };
  return { raw, app, add };
}

test('finance listings, summaries, product totals and exports use delivered status and Baghdad delivery date exclusively', async () => {
  const { raw, app, add } = setup();
  add('delivered-in-range', 'delivered', { created: '2026-09-01T10:00:00Z' });
  // The local delivery date is October 1 even though the UTC date is September 30.
  add('baghdad-boundary', 'delivered', { delivered: '2026-09-30T21:30:00Z' });
  for (const status of ['pending','confirmed','processing','shipped','cancelled']) {
    add(`excluded-${status}`, status, { product: 'unsold', delivered: '2026-10-04T10:00:00Z' });
  }
  add('delivered-outside-range', 'delivered', { delivered: '2026-09-30T20:30:00Z' });
  add('missing-delivery-date', 'delivered', { delivered: null });
  add('merchant-delivery');
  raw.exec("UPDATE orders SET seller_type='merchant' WHERE id='merchant-delivery';UPDATE orders SET stage='delivered' WHERE id='excluded-shipped'");
  const expected = ['delivered-in-range','baghdad-boundary'];
  for (const status of ['', 'delivered', 'cancelled', 'pending', 'shipped']) {
    const response = await get(app, `/f/orders?${period}&status=${status}`), list = await json(response);
    assert.equal(response.status, 200, JSON.stringify(list));
    assert.deepEqual(list.orders.map((o: { id: string }) => o.id), expected);
    assert.equal(list.total, 2);
    assert.ok(list.orders.every((o: { status: string; projected_finance?: unknown }) => o.status === 'delivered' && !o.projected_finance));
  }
  const summary = await json(await get(app, `/f/summary?${period}`));
  assert.deepEqual(summary.orders.map((o: { id: string }) => o.id), expected);
  assert.equal(summary.totals.orders_count, 2);
  assert.equal(summary.totals.net_goods_iqd, 50000);
  assert.equal(summary.totals.cogs_iqd, 20000);
  assert.equal(summary.totals.unknown_lines, 0);
  assert.deepEqual(summary.products.map((p: { id: string }) => p.id), ['sold']);
  assert.equal(summary.products[0].qty, 2);
  assert.equal(summary.categories[0].net_goods_iqd, 50000);
  assert.equal(summary.chart_data.orders_count, 2);
  assert.equal(summary.chart_data.daily.reduce((n: number, day: { orders_count: number }) => n + day.orders_count, 0), 2);
  const csv = await (await get(app, `/f/export.csv?${period}`)).text();
  assert.match(csv, /delivered-in-range/);
  assert.match(csv, /baghdad-boundary/);
  assert.doesNotMatch(csv, /excluded-|outside-range|missing-delivery-date|merchant-delivery|Undelivered product/);
  assert.equal(row(raw, "SELECT status FROM orders WHERE id='excluded-shipped'")?.status, 'shipped', 'report reads do not change operational order status');
});

test('finance order pagination and search count only deliveries, before applying the page limit', async () => {
  const { app, add } = setup();
  for (let i = 0; i < 101; i++) add(`delivery-${String(i).padStart(3,'0')}`);
  for (let i = 0; i < 105; i++) add(`cancelled-${i}`, 'cancelled', { delivered: '2026-10-05T10:00:00Z' });
  const first = await json(await get(app, `/f/orders?${period}`));
  const second = await json(await get(app, `/f/orders?${period}&offset=100`));
  assert.equal(first.total, 101); assert.equal(first.orders.length, 100);
  assert.equal(second.total, 101); assert.equal(second.orders.length, 1);
  assert.equal(second.orders[0].id, 'delivery-100');
  assert.equal(new Set([...first.orders,...second.orders].map((o: { id: string }) => o.id)).size, 101);
  const matching = await json(await get(app, `/f/orders?${period}&q=delivery-100`));
  assert.equal(matching.total, 1); assert.equal(matching.orders[0].id, 'delivery-100');
  const excluded = await json(await get(app, `/f/orders?${period}&q=cancelled`));
  assert.equal(excluded.total, 0); assert.deepEqual(excluded.orders, []);
});

test('delivered sales keep partial and full refund deductions in every finance report', async () => {
  const { raw, app, add } = setup();
  add('refunded-delivery', 'delivered', { qty: 2 });
  const returned = (id: string) => {
    raw.prepare(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at)
      VALUES (?,'refunded-delivery','refunded-delivery:item','buyer',1,'defective','resolved','refund','2026-10-04T10:00:00Z')`).run(id);
    raw.prepare(`INSERT INTO finance_refund_facts(case_id,order_id,refund_iqd,qty,disposition,refunded_day,cogs_iqd,channel)
      VALUES (?,'refunded-delivery',25000,1,'restock','2026-10-04',10000,'wallet')`).run(id);
  };
  for (const [id, refund, revenue, cost] of [['first',25000,25000,10000],['second',50000,0,0]] as const) {
    returned(id);
    const list = await json(await get(app, `/f/orders?${period}`));
    const summary = await json(await get(app, `/f/summary?${period}`));
    assert.equal(list.total, 1); assert.equal(summary.totals.orders_count, 1);
    for (const value of [list.orders[0],summary.totals,summary.products[0],summary.categories[0]]) {
      assert.equal(value.refund_iqd, refund);
      assert.equal(value.retained_revenue_iqd, revenue);
      assert.equal(value.cogs_iqd, cost);
      assert.equal(value.gross_profit_iqd, revenue-cost);
    }
    assert.equal(summary.chart_data.revenue_iqd, revenue+5000);
    const csv = await (await get(app, `/f/export.csv?${period}`)).text();
    assert.match(csv, /refunded-delivery/);
    assert.match(csv, new RegExp(`"${refund}","${cost}",`));
  }
  assert.equal(row(raw, "SELECT status FROM orders WHERE id='refunded-delivery'")?.status, 'delivered');
});
