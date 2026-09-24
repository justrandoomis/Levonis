/**
 * THE STORE'S ANALYTICS OVER A RANGE (W2-E): GET /api/merchant/analytics/report.
 * Every figure has a real source; a figure without one is ABSENT, never 0;
 * cancelled orders are not sales; nothing of another store is counted.
 *
 * Run: node --import tsx --test tests/merchantAnalyticsReport.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { get, json } from './fixtures/app';
import { OWNER, OWNER2, addOrder, appOf, seedW2E } from './fixtures/merchantW2E';
import { merchantAnalyticsRoutes } from '../worker/routes/merchantAnalytics';

const report = async (raw: DatabaseSync, q = '?from=2026-09-01&to=2026-09-10', user = OWNER) => {
  const res = await get(appOf(raw, user, (a) => a.route('/api/merchant/analytics', merchantAnalyticsRoutes)), `/api/merchant/analytics/report${q}`);
  return { status: res.status, body: await json(res) };
};
const traffic = (raw: DatabaseSync, store: string, day: string, v: Partial<Record<string, number>>) =>
  raw.prepare(
    `INSERT INTO merchant_store_analytics_daily (store_id, day, visitors, store_views, product_views, add_to_cart, checkout_started, source_direct, source_search, source_social, source_other)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(store, day, v.visitors ?? 0, v.store_views ?? 0, v.product_views ?? 0, v.add_to_cart ?? 0, v.checkout_started ?? 0, v.direct ?? 0, v.search ?? 0, v.social ?? 0, v.other ?? 0);

test('before any traffic was ever counted, traffic and the funnel are ABSENT — not zeros — and orders still answer', async () => {
  const raw = seedW2E();
  const { status, body } = await report(raw);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal('traffic' in body, false);
  assert.equal('funnel' in body, false);
  assert.equal('least_viewed' in body.products, false);
  assert.equal(body.orders.series.length, 10, 'orders have always been recorded: every day of the range');
  assert.equal('average_order_iqd' in body.orders.totals, false, 'no orders: no average, not 0');
  assert.equal('win_rate_percent' in body.requests, false);
  assert.deepEqual(body.range, { from: '2026-09-01', to: '2026-09-10', days: 10, timezone: 'Asia/Baghdad' });
});

test('traffic starts on the day counting began; days before it are not in the series; after it an empty day is a real zero', async () => {
  const raw = seedW2E();
  traffic(raw, 's2', '2026-09-04', { visitors: 1 }); // counting began (another store's first row)
  traffic(raw, 's1', '2026-09-06', { visitors: 5, store_views: 4, product_views: 9, add_to_cart: 2, checkout_started: 1, direct: 3, social: 2 });
  traffic(raw, 's1', '2026-09-08', { visitors: 2, store_views: 2, direct: 1, search: 1 });
  addOrder(raw, { id: 'ORD-A', at: '2026-09-06T09:00:00.000Z', total: 20000 });
  addOrder(raw, { id: 'ORD-B', at: '2026-09-02T09:00:00.000Z', total: 10000 }); // before counting: an order, not a conversion
  const { body } = await report(raw);
  assert.equal(body.traffic.since, '2026-09-04');
  assert.deepEqual(body.traffic.series.map((d: { day: string }) => d.day), ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']);
  assert.equal(body.traffic.series[1].visitors, 0, 'a counted day with no visitor is a real zero');
  assert.deepEqual(body.traffic.totals, { visitors: 7, store_views: 6, product_views: 9, add_to_cart: 2, checkout_started: 1 });
  assert.deepEqual(body.traffic.sources, { direct: 4, search: 1, social: 2, other: 0 });
  assert.equal(body.funnel.orders, 1, 'only orders while traffic was counted enter the funnel');
  assert.equal(body.funnel.conversion_percent, 14.3);
  assert.equal(body.orders.totals.orders, 2);
});

test('orders: cancelled ones are not sales; the Baghdad day decides the bucket; another store is never counted', async () => {
  const raw = seedW2E();
  addOrder(raw, { id: 'ORD-1', at: '2026-09-03T22:30:00.000Z', total: 10000 }); // 01:30 on the 4th in Baghdad
  addOrder(raw, { id: 'ORD-2', at: '2026-09-04T10:00:00.000Z', total: 30000, status: 'cancelled' });
  addOrder(raw, { id: 'ORD-3', at: '2026-09-05T10:00:00.000Z', total: 5000, merchant: 'm2', store: 's2' });
  const { body } = await report(raw);
  assert.deepEqual(body.orders.totals, { orders: 1, gross_iqd: 10000, receivable_iqd: 9500, cancelled: 1, average_order_iqd: 10000 });
  assert.equal(body.orders.series.find((d: { day: string }) => d.day === '2026-09-04').orders, 1);
  assert.equal(body.orders.series.find((d: { day: string }) => d.day === '2026-09-03').orders, 0);
});

test('top and least-viewed products, returning customers, coupons, governorates, requests — each from its own rows', async () => {
  const raw = seedW2E();
  traffic(raw, 's1', '2026-09-02', { visitors: 3 });
  raw.exec(`INSERT INTO merchant_product_analytics_daily (store_id, product_id, day, views, add_to_cart) VALUES ('s1','cp1','2026-09-02',8,1), ('s1','cp2','2026-09-02',2,0);`);
  addOrder(raw, { id: 'ORD-OLD', at: '2026-08-01T10:00:00.000Z', user: 'buyer' });
  addOrder(raw, { id: 'ORD-R1', at: '2026-09-02T10:00:00.000Z', user: 'buyer', coupon: 'SUMMER', discount: 1000, governorate: 'basra' });
  addOrder(raw, { id: 'ORD-N1', at: '2026-09-03T10:00:00.000Z', user: 'buyer2', governorate: null });
  raw.exec(`
    INSERT INTO order_items (id,order_id,community_product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,seller_type) VALUES
      ('i1','ORD-R1','cp2','Lamp',2,25000,50000,'merchant'), ('i2','ORD-N1','cp1','Vase',1,10000,10000,'merchant');
    INSERT INTO merchant_coupons (id, store_id, merchant_id, code, kind, value, used_count, max_uses, ends_at) VALUES ('cpn1','s1','m1','SUMMER','percent',10,4,10,'2026-12-01T00:00:00.000Z');
    INSERT INTO community_requests (id, customer_id, title) VALUES ('rq1','buyer','A'), ('rq2','buyer','B');
    INSERT INTO community_request_matches (id, request_id, merchant_id, eligible, notified, created_at) VALUES
      ('mt1','rq1','m1',1,1,'2026-09-02T10:00:00.000Z'), ('mt2','rq2','m1',0,0,'2026-09-02T10:00:00.000Z');
    INSERT INTO community_offers (id, request_id, merchant_id, store_id, price_iqd, state, created_at) VALUES
      ('of1','rq1','m1','s1',9000,'accepted','2026-09-03T10:00:00.000Z'), ('of2','rq2','m1','s1',9000,'withdrawn','2026-09-03T10:00:00.000Z');
  `);
  const { body } = await report(raw);
  assert.deepEqual(body.products.top.map((p: { id: string; units: number; revenue_iqd: number }) => [p.id, p.units, p.revenue_iqd]), [['cp2', 2, 50000], ['cp1', 1, 10000]]);
  assert.deepEqual(body.products.least_viewed.map((p: { id: string; views: number }) => [p.id, p.views]).slice(0, 2), [['cp2', 2], ['cp1', 8]]);
  assert.ok(!body.products.least_viewed.some((p: { id: string }) => p.id === 'cp3' || p.id === 'cp9'), 'unpublished and other stores\' products are not listed');
  assert.deepEqual(body.customers, { customers: 2, returning: 1, new: 1 });
  assert.deepEqual(body.coupons, [{ code: 'SUMMER', orders: 1, discount_iqd: 1000, gross_iqd: 10000, coupon_id: 'cpn1', used_count: 4, max_uses: 10, ends_at: '2026-12-01T00:00:00.000Z', active: true }]);
  assert.deepEqual(body.governorates, [{ governorate: 'basra', orders: 1, gross_iqd: 10000 }]);
  assert.equal(body.governorates_unspecified, 1);
  assert.deepEqual(
    body.requests,
    { matched: 1, notified: 1, offers_sent: 2, offers_accepted: 1, win_rate_percent: 50, custom_orders_completed: 0, custom_orders_receivable_iqd: 0 }
  );
});

test('a range is validated, the entitlement is required, and each merchant sees only their own store', async () => {
  const raw = seedW2E();
  assert.equal((await report(raw, '?from=2026-09-10&to=2026-09-01')).body.code, 'BAD_RANGE');
  assert.equal((await report(raw, '?from=2025-01-01&to=2026-09-01')).body.code, 'BAD_RANGE');
  assert.equal((await report(raw, '?from=nope&to=2026-09-01')).status, 400);
  traffic(raw, 's1', '2026-09-02', { visitors: 9 });
  assert.equal((await report(raw, '?from=2026-09-01&to=2026-09-10', OWNER2)).body.traffic.totals.visitors, 0, 'zahra\'s traffic is her own');
  raw.exec("UPDATE memberships SET state = 'expired', expires_at = '2020-01-01T00:00:00.000Z' WHERE user_id = 'owner'");
  const lapsed = await report(raw);
  assert.deepEqual([lapsed.status, lapsed.body.code], [403, 'ANALYTICS_NOT_INCLUDED']);
});
