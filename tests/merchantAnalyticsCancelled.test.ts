/**
 * A CANCELLED ORDER IS NOT A SALE — audit 04 #12 (probe B7), audit 01 B12
 * (probe P13), audit 02 B19.
 *
 * One delivered 10,000 sale and one cancelled 90,000 order used to read
 * «gross 100,000 · earnings 95,000 · average 50,000» and a customer with
 * «2 orders / 100,000». A cancelled store order is refunded in full: it is not
 * revenue, its fee was never earned, and its buyer spent nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, get, json, type StubUser } from './fixtures/app';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantCustomerRoutes } from '../worker/routes/merchantCustomers';

const OWNER: StubUser = { id: 'owner', role: 'merchant', email: 'owner@x.co' };
const COLS = `(id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,platform_fee_iqd,merchant_receivable_iqd,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)`;

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('owner','Ali','owner@x.co','h','merchant'),
      ('ghost','Gone','ghost@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at,source)
      VALUES ('mm','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','purchase');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,sold_count)
      VALUES ('cp1','m1','s1','ali3d-a','A','active','active',10000,9), ('cp2','m1','s1','ali3d-b','B','active','active',90000,1);
    INSERT INTO orders ${COLS} VALUES
      ('o_ok','buyer','delivered',10000,'m1','s1','merchant','store_product',500,9500,'{}','d','{}','wallet',10000,1500,0),
      ('o_x','buyer','cancelled',90000,'m1','s1','merchant','store_product',4500,85500,'{}','d','{}','wallet',90000,1500,0),
      ('o_ghost','ghost','cancelled',5000,'m1','s1','merchant','store_product',250,4750,'{}','d','{}','wallet',5000,1500,0);
    INSERT INTO order_items (id,order_id,community_product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,seller_type) VALUES
      ('i1','o_ok','cp1','A',1,10000,10000,'merchant'),
      ('i2','o_x','cp2','B',1,90000,90000,'merchant'),
      ('i3','o_ghost','cp2','B',1,5000,5000,'merchant');
  `);
  return raw;
}

// Mounted as worker/index.ts mounts them: the customers list is its own router (W3-B).
const app = (raw: ReturnType<typeof freshDb>) =>
  stubApp(asD1(raw), OWNER, (a) => {
    a.route('/api/merchant/customers', merchantCustomerRoutes);
    a.route('/api/merchant', merchantRoutes);
  });

test('gross, earnings, fees and the average count only sales; the cancelled count is still reported', async () => {
  const raw = seed();
  const res = await get(app(raw), '/api/merchant/analytics');
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const { orders, products, top_products, repeat_customers } = await json(res);
  assert.deepEqual(
    {
      total: orders.total,
      gross: orders.gross_iqd,
      fees: orders.platform_fees_iqd,
      earnings: orders.receivable_iqd,
      average: orders.average_order_iqd,
      completed: orders.completed,
      cancelled: orders.cancelled,
    },
    { total: 1, gross: 10000, fees: 500, earnings: 9500, average: 10000, completed: 1, cancelled: 2 }
  );
  // Units from real sales, not the `sold_count` counter cancellations inflated.
  assert.equal(products.sold, 1);
  assert.deepEqual(
    top_products.map((p: { id: string; sold_count: number }) => [p.id, p.sold_count]),
    [['cp1', 1]]
  );
  assert.equal(repeat_customers, 0, 'one real order is not a repeat customer');
});

test('the customer list is people who BOUGHT, with what they spent', async () => {
  const raw = seed();
  const { customers } = await json(await get(app(raw), '/api/merchant/customers'));
  assert.deepEqual(
    customers.map((c: { name: string; order_count: number; spent_iqd: number }) => [c.name, c.order_count, c.spent_iqd]),
    [['Sara', 1, 10000]],
    'a cancelled order is refunded money, and someone with only a cancelled order never bought'
  );
});

test('custom (request) orders are their own series: completed work only', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,state) VALUES ('r1','buyer','Vase','completed'), ('r2','buyer','Cup','cancelled');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('of1','r1','m1','s1',20000,'accepted'), ('of2','r2','m1','s1',30000,'accepted');
    INSERT INTO community_orders (id,request_id,offer_id,customer_id,merchant_id,store_id,state,price_iqd,platform_fee_iqd,merchant_receivable_iqd) VALUES
      ('co1','r1','of1','buyer','m1','s1','completed',20000,1000,19000),
      ('co2','r2','of2','buyer','m1','s1','refunded',30000,1500,28500);
  `);
  const { custom_orders } = await json(await get(app(raw), '/api/merchant/analytics'));
  assert.deepEqual(custom_orders, { completed: 1, receivable_iqd: 19000 });
});

test('the old unpaged customers handler is gone from merchant.ts — one customers route (review W2-5 #8)', async () => {
  const raw = seed();
  const alone = stubApp(asD1(raw), OWNER, (a) => a.route('/api/merchant', merchantRoutes));
  assert.equal((await get(alone, '/api/merchant/customers')).status, 404);
});
