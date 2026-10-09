import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, get, json, stubApp } from './fixtures/app';
import { adminFinanceReportRoutes, resetFinanceSchemaMemo } from '../worker/routes/adminFinanceReport';
import { calculateGoods, type GoodsLine } from '../worker/lib/orderProfit';

const day = '2026-10-03';
function seed(through?: string) {
  const db = through ? dbThrough(through) : freshDb();
  db.exec(`INSERT INTO users(id,name,email,password_hash,role) VALUES ('owner','Owner','owner@test.local','x','admin'),('buyer','Buyer','buyer@test.local','x','customer');
    INSERT INTO catalogs(id,slug,name_ar,name_en) VALUES ('ca','price-a','A','A'),('cb','price-b','B','B');
    INSERT INTO products(id,slug,name,name_ar,price_iqd,product_cost_iqd,category_id,sub_category_id) VALUES
    ('p1','price-p1','P1','P1',100,0,'ca','ca'),('p2','price-p2','P2','P2',100,0,'cb','cb'),('bundle','price-bundle','Bundle','Bundle',100,0,'ca','ca');`);
  return db;
}
function order(db: DatabaseSync, { delta = 0, points = 0, shipping = 0, cod = 0, legacy = false } = {}) {
  db.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,points_discount_iqd,cod_tax_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,seller_type,created_at)
    VALUES ('o','buyer','delivered','{}','standard','{}','cash',100,?,?,?,1400,100,0,'2026-10-03T10:00:00Z','levonis','2026-10-01T10:00:00Z')`).run(shipping, points, cod);
  if (!legacy) db.prepare('UPDATE orders SET price_adjustment_iqd=? WHERE id=?').run(delta, 'o');
}
function item(db: DatabaseSync, id: string, product: string, price: number, extra: { qty?: number; parent?: string; alloc?: number; legacy?: boolean; membership?: number; coupon?: number } = {}) {
  db.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,bundle_parent_item_id,component_alloc_iqd,membership_discount_iqd,coupon_discount_iqd)
    VALUES (?,'o',?,'Product',?,?,?,?,?,?,?)`).run(id, product, extra.qty ?? 1, price, price, extra.parent ?? null, extra.alloc ?? null, extra.membership ?? 0, extra.coupon ?? 0);
  if (!extra.legacy) db.prepare("UPDATE order_items SET cost_basis=?,cost_iqd=0 WHERE id=?").run(product === 'bundle' ? 'composed' : 'snapshot', id);
}
async function reports(db: DatabaseSync) {
  resetFinanceSchemaMemo();
  // The OWNER (owner decision 2: profit reports are the owner's alone).
  const app = stubApp(asD1(db), { id: 'owner', email: 'owner@test.local', role: 'admin' }, (a) => a.route('/api/admin/finance/report', adminFinanceReportRoutes), {
    env: { INITIAL_ADMIN_EMAIL: 'owner@test.local' },
  });
  const result = await Promise.all(['summary', 'products', 'categories'].map(async (route) => {
    const response = await get(app, `/api/admin/finance/report/${route}?from=${day}&to=${day}&granularity=range`);
    const body = await json(response); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  }));
  return { summary: result[0], products: result[1].products, categories: result[2].categories };
}

test('accepted positive adjustment reaches summary, products and categories with exact largest remainders', async () => {
  const db = seed(); order(db, { delta: 10 });
  item(db, 'a', 'p1', 100); item(db, 'b', 'p2', 100); item(db, 'c', 'p2', 100);
  const r = await reports(db);
  assert.equal(r.summary.totals.revenue_iqd, 310);
  assert.equal(r.summary.totals.net_profit_iqd, 310);
  assert.equal(r.products.find((p: { id: string }) => p.id === 'p1').totals.revenue_iqd, 104);
  assert.equal(r.products.find((p: { id: string }) => p.id === 'p2').totals.revenue_iqd, 206);
  assert.equal(r.categories.find((p: { id: string }) => p.id === 'ca').totals.revenue_iqd, 104);
  assert.equal(r.products.reduce((n: number, p: { totals: { revenue_iqd: number } }) => n + p.totals.revenue_iqd, 0), 310);
  db.close();
});

test('points influence price allocation without being subtracted twice from period profit', async () => {
  const db = seed(); order(db, { delta: -11, points: 21, shipping: 10, cod: 3 });
  item(db, 'a', 'p1', 70); item(db, 'b', 'p2', 30);
  const r = await reports(db);
  assert.equal(r.summary.totals.revenue_iqd, 89);
  assert.equal(r.summary.totals.points_redeemed_iqd, 21);
  assert.equal(r.summary.totals.net_profit_iqd, 81);
  assert.equal(r.products.find((p: { id: string }) => p.id === 'p1').totals.revenue_iqd, 62);
  assert.equal(r.products.find((p: { id: string }) => p.id === 'p2').totals.revenue_iqd, 27);
  const actualOrder = db.prepare('SELECT * FROM orders WHERE id=?').get('o')!;
  const goods = calculateGoods(actualOrder, db.prepare('SELECT * FROM order_items ORDER BY id').all() as GoodsLine[], []);
  assert.equal(r.summary.totals.net_profit_iqd, goods.lines.reduce((n, l) => n + l.net_goods_iqd, 0) + goods.order.shipping_iqd + goods.order.cod_tax_iqd);
  db.close();
});

test('price reduction consumes post-points goods, then delivery, then COD without negative goods', async () => {
  const db = seed(); order(db, { delta: -102, points: 20, shipping: 15, cod: 10 }); item(db, 'a', 'p1', 100);
  const r = await reports(db);
  assert.equal(r.summary.totals.revenue_iqd, 20, 'the separate points deduction leaves zero goods');
  assert.equal(r.summary.totals.shipping_collected_iqd, 0);
  assert.equal(r.summary.totals.cod_tax_collected_iqd, 3);
  assert.equal(r.summary.totals.net_profit_iqd, 3);
  db.close();
});

test('bundle adjustment stays on its revenue parent and never doubles on physical components', async () => {
  const db = seed(); order(db, { delta: 11 });
  item(db, 'a', 'bundle', 100); item(db, 'b', 'p1', 0, { parent: 'a', alloc: 40 }); item(db, 'c', 'p2', 0, { parent: 'a', alloc: 60 }); item(db, 'd', 'p2', 100);
  const r = await reports(db);
  assert.equal(r.summary.totals.revenue_iqd, 211);
  assert.equal(r.products.find((p: { id: string }) => p.id === 'bundle').totals.revenue_iqd, 106);
  assert.equal(r.products.find((p: { id: string }) => p.id === 'p1').totals.revenue_iqd, 0);
  assert.equal(r.products.find((p: { id: string }) => p.id === 'p2').totals.revenue_iqd, 105);
  assert.equal(r.summary.totals.units, 3);
  db.close();
});

test('a positive final price on zero-value goods uses quantities and stays integer exact', async () => {
  const db = seed(); order(db, { delta: 11 }); item(db, 'a', 'p1', 0, { qty: 1 }); item(db, 'b', 'p2', 0, { qty: 2 });
  const r = await reports(db);
  assert.equal(r.summary.totals.revenue_iqd, 11);
  assert.equal(r.products.find((p: { id: string }) => p.id === 'p1').totals.revenue_iqd, 4);
  assert.equal(r.products.find((p: { id: string }) => p.id === 'p2').totals.revenue_iqd, 7);
  db.close();
});

test('large bulk orders keep integer allocations when multiplication exceeds SQLite int64', async () => {
  const db = seed(); order(db, { delta: 500_000_000_003, points: 900_000_000_001 });
  item(db, 'a', 'p1', 1_000_000_000_000); item(db, 'b', 'p2', 1_000_000_000_000); item(db, 'c', 'p2', 1_000_000_000_000);
  const r = await reports(db);
  assert.equal(r.summary.totals.revenue_iqd, 3_500_000_000_003);
  assert.equal(r.summary.totals.net_profit_iqd, 2_600_000_000_002);
  const actualOrder = db.prepare('SELECT * FROM orders WHERE id=?').get('o')!;
  const goods = calculateGoods(actualOrder, db.prepare('SELECT * FROM order_items ORDER BY id').all() as GoodsLine[], []);
  const p1 = r.products.find((p: { id: string }) => p.id === 'p1').totals.revenue_iqd;
  assert.equal(p1, goods.lines[0].net_goods_iqd + 300_000_000_001);
  assert.equal(p1 + r.products.find((p: { id: string }) => p.id === 'p2').totals.revenue_iqd, 3_500_000_000_003);
  db.close();
});

test('pre-0095 schema still answers without probing a nonexistent accepted-price column in SQL', async () => {
  const db = seed('0094'); order(db, { legacy: true, points: 20, shipping: 10 }); item(db, 'a', 'p1', 100, { legacy: true });
  const r = await reports(db);
  assert.equal(r.summary.totals.revenue_iqd, 100);
  // P-A F1: with no cost-at-sale column the line's cost is today's catalogue —
  // an estimate — so its 100 stays out of gross and net: 0 + 10 − 20.
  assert.equal(r.summary.totals.net_profit_iqd, -10);
  assert.equal(r.summary.totals.estimated_revenue_iqd, 100);
  assert.equal(r.summary.meta.cost_snapshot_available, false);
  db.close();
});

test('legacy refund reverses the accepted price instead of the original line price', async () => {
  const db = seed('0140'); order(db, { delta: -13 }); item(db, 'a', 'p1', 100);
  db.exec("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES ('return-a','o','a','buyer',1,'defective','resolved','refund','2026-10-03T15:00:00Z')");
  const r = await reports(db);
  assert.equal(r.summary.totals.refunded_revenue_iqd, 87);
  assert.equal(r.summary.totals.net_profit_iqd, 0);
  assert.equal(r.products[0].totals.revenue_iqd, 0);
  db.close();
});

test('a legacy bundle component refund reverses its exact share of the parent adjustment', async () => {
  const db = seed('0140'); order(db, { delta: 11 });
  item(db, 'a', 'bundle', 100); item(db, 'b', 'p1', 0, { parent: 'a', alloc: 40 }); item(db, 'c', 'p2', 0, { parent: 'a', alloc: 60 });
  db.exec("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES ('return-c','o','c','buyer',1,'defective','resolved','refund','2026-10-03T15:00:00Z')");
  const r = await reports(db);
  assert.equal(r.summary.totals.refunded_revenue_iqd, 67);
  assert.equal(r.summary.totals.net_profit_iqd, 44);
  db.close();
});

test('a frozen operational refund remains authoritative after accepted-price allocation', async () => {
  const db = seed(); order(db, { delta: -13 }); item(db, 'a', 'p1', 100);
  db.exec("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES ('return-a','o','a','buyer',1,'defective','resolved','refund','2026-10-03T15:00:00Z'); INSERT INTO finance_refund_facts(case_id,order_id,refund_iqd,qty,disposition,cogs_iqd,refunded_day) VALUES ('return-a','o',50,1,'restock',0,'2026-10-03')");
  const r = await reports(db);
  assert.equal(r.summary.totals.refunded_revenue_iqd, 50);
  assert.equal(r.summary.totals.net_profit_iqd, 37);
  db.close();
});
