/**
 * §21 «يجب أن تميز التقارير بين ... Normal Order / Quick Buy Order / Gift Order
 * وأن تظهر للمستخدم والأدمن العمليات بشكل مفهوم. لا تسجل HOLD على أنه Revenue
 * نهائي.»
 *
 * The owner's profit screen splits the period's DELIVERED orders by what made
 * them (0174), and the rows add up to the period totals; a customer's wallet
 * operation says when it paid for or refunded a Quick Buy or a gift order.
 *
 * Run: node --import tsx --test tests/orderKindReports.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { walletRoutes } from '../worker/routes/wallet';

const period = 'from=2026-10-01&to=2026-10-06';

function world() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('owner','boss@x.co','Owner','admin','full'),('buyer','buyer@x.co','Buyer','customer',NULL),('other','o@x.co','Other','customer',NULL);
    INSERT INTO catalogs(id,name_ar,name_en,slug) VALUES ('kinds','أنواع','Kinds','kinds');
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,category_id) VALUES
      ('printer','Printer','kinds-printer',600000,450000,'kinds'),
      ('spool','Spool','kinds-spool',25000,10000,'kinds');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');`);
  const order = (id: string, kind: string, o: { user?: string; status?: string; product: string; price: number; cost: number; delivered?: string | null }) => {
    const status = o.status ?? 'delivered';
    const delivered = o.delivered === undefined ? (status === 'delivered' ? '2026-10-03T10:00:00Z' : null) : o.delivered;
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at,order_kind)
      VALUES (?,?,?,'{}','standard','{}','wallet',?,1400,?,0,0,'2026-10-02T10:00:00Z',?,?)`).run(id, o.user ?? 'buyer', status, o.price, o.price, delivered, kind);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES (?,?,?,?,1,?,?,?,'snapshot')`).run(`${id}:1`, id, o.product, o.product, o.price, o.price, o.cost);
  };
  return { raw, db: asD1(raw), order };
}

test('the profit screen splits delivered orders by kind, the rows add up, a gift shows what it cost, an undelivered Quick Buy order is not revenue', async () => {
  const { db, order } = world();
  order('ORD-NORMAL0001', 'normal', { product: 'spool', price: 25000, cost: 10000 });
  order('ORD-QUICK00001', 'quick_buy', { product: 'printer', price: 600000, cost: 450000 });
  order('ORD-GIFT000001', 'gift', { product: 'spool', price: 0, cost: 10000 });
  // Placed by Quick Buy but not delivered: its money was captured, the sale is
  // not recognised yet — and an open session's HOLD is not an order at all.
  order('ORD-QUICK00002', 'quick_buy', { product: 'printer', price: 600000, cost: 450000, status: 'confirmed' });
  const app = stubApp(db, { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => a.route('/f', adminFinanceWorkspaceRoutes));

  const res = await get(app, `/f/summary?${period}`);
  const summary = await json(res);
  assert.equal(res.status, 200, JSON.stringify(summary));
  const kinds = Object.fromEntries(summary.kinds.map((k: { kind: string }) => [k.kind, k]));
  assert.deepEqual(summary.kinds.map((k: { kind: string }) => k.kind), ['normal', 'quick_buy', 'gift']);
  assert.equal(kinds.normal.orders_count, 1);
  assert.equal(kinds.quick_buy.orders_count, 1, 'only the delivered Quick Buy order is a sale');
  assert.equal(kinds.gift.orders_count, 1);
  assert.equal(kinds.quick_buy.net_goods_iqd, 600000);
  assert.equal(kinds.quick_buy.gross_profit_iqd, 150000);
  assert.equal(kinds.gift.net_goods_iqd, 0);
  assert.equal(kinds.gift.cogs_iqd, 10000);
  assert.equal(kinds.gift.gross_profit_iqd, -10000, 'a gift sells at 0 and keeps its cost');
  for (const field of ['orders_count', 'net_goods_iqd', 'cogs_iqd', 'gross_profit_iqd']) {
    const sum = summary.kinds.reduce((n: number, k: Record<string, number>) => n + k[field], 0);
    assert.equal(sum, summary.totals[field], `${field}: the kinds add up to the period`);
  }
  const rows = Object.fromEntries(summary.orders.map((o: { id: string; order_kind: string }) => [o.id, o.order_kind]));
  assert.deepEqual(rows, { 'ORD-NORMAL0001': 'normal', 'ORD-QUICK00001': 'quick_buy', 'ORD-GIFT000001': 'gift' });
});

test('a wallet operation on a Quick Buy or a gift order says so; an ordinary one and someone else\'s order do not', async () => {
  const { raw, db, order } = world();
  order('ORD-NORMAL0001', 'normal', { product: 'spool', price: 25000, cost: 10000 });
  order('ORD-QUICK00001', 'quick_buy', { product: 'printer', price: 600000, cost: 450000 });
  order('ORD-GIFT000001', 'gift', { product: 'spool', price: 0, cost: 10000 });
  order('ORD-THEIRS0001', 'quick_buy', { user: 'other', product: 'spool', price: 25000, cost: 10000 });
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,ref,created_by,decided_at) VALUES
    ('wtx_topup','buyer','deposit','USD',100000,'approved','Top-up','','user','2026-10-01T09:00:00Z'),
    ('wtx_ord_ORD-NORMAL0001_usd','buyer','withdrawal','USD',1786,'approved','Wallet payment on order ORD-NORMAL0001','ORD-NORMAL0001','system','2026-10-02T10:00:00Z'),
    ('wtx_ord_ORD-QUICK00001_usd','buyer','withdrawal','USD',42858,'approved','Wallet payment on order ORD-QUICK00001','ORD-QUICK00001','system','2026-10-02T10:00:00Z'),
    ('wtx_refund_ORD-QUICK00001_usd','buyer','deposit','USD',42858,'approved','Refund for cancelled order ORD-QUICK00001','ORD-QUICK00001','system','2026-10-02T11:00:00Z'),
    ('wtx_ord_ORD-GIFT000001_usd','buyer','withdrawal','USD',358,'approved','Wallet payment on order ORD-GIFT000001','ORD-GIFT000001','system','2026-10-02T10:00:00Z'),
    ('wtx_odd','buyer','deposit','USD',1,'approved','Odd','ORD-THEIRS0001','system','2026-10-02T10:00:00Z');`);
  const app = stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/wallet', walletRoutes));

  const res = await get(app, '/api/wallet');
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  const kinds = Object.fromEntries(body.transactions.map((t: { id: string; order_kind?: string }) => [t.id, t.order_kind ?? null]));
  assert.deepEqual(kinds, {
    wtx_topup: null,
    'wtx_ord_ORD-NORMAL0001_usd': null,
    'wtx_ord_ORD-QUICK00001_usd': 'quick_buy',
    'wtx_refund_ORD-QUICK00001_usd': 'quick_buy',
    'wtx_ord_ORD-GIFT000001_usd': 'gift',
    wtx_odd: null,
  });
});
