/**
 * THE ANALYTICS PAGE'S TWO ADDITIONS TO THE REPORT (W3-B):
 *
 *   previous      the period of equal length just before — present only where
 *                 BOTH periods have a source (the store existed; traffic was
 *                 counted every day of both), so no delta is ever taken
 *                 against a zero that was really «not counted» or «not open»
 *   most_viewed   the other end of least_viewed, views > 0 only
 *
 * Run: node --import tsx --test tests/merchantAnalyticsPeriods.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { get, json } from './fixtures/app';
import { OWNER, OWNER2, addOrder, appOf, seedW2E } from './fixtures/merchantW2E';
import { merchantAnalyticsRoutes } from '../worker/routes/merchantAnalytics';

const report = async (raw: DatabaseSync, q = '?from=2026-09-11&to=2026-09-20', user = OWNER) => {
  const res = await get(appOf(raw, user, (a) => a.route('/api/merchant/analytics', merchantAnalyticsRoutes)), `/api/merchant/analytics/report${q}`);
  return { status: res.status, body: await json(res) };
};
const traffic = (raw: DatabaseSync, store: string, day: string, visitors: number, productViews = 0) =>
  raw.prepare(`INSERT INTO merchant_store_analytics_daily (store_id, day, visitors, product_views) VALUES (?,?,?,?)`).run(store, day, visitors, productViews);
const opened = (raw: DatabaseSync, at: string) => raw.prepare(`UPDATE merchant_stores SET created_at = ?`).run(at);

test('the previous period is the equal-length one just before, and its orders answer only if the store already existed', async () => {
  const raw = seedW2E();
  opened(raw, '2026-08-01T00:00:00.000Z');
  addOrder(raw, { id: 'P1', at: '2026-09-02T10:00:00.000Z', total: 10000 });
  addOrder(raw, { id: 'P2', at: '2026-09-09T10:00:00.000Z', total: 30000 });
  addOrder(raw, { id: 'PX', at: '2026-09-05T10:00:00.000Z', total: 90000, status: 'cancelled' });
  addOrder(raw, { id: 'PZ', at: '2026-09-05T10:00:00.000Z', total: 50000, merchant: 'm2', store: 's2' });
  addOrder(raw, { id: 'C1', at: '2026-09-15T10:00:00.000Z', total: 20000 });
  const { status, body } = await report(raw);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.previous.range, { from: '2026-09-01', to: '2026-09-10', days: 10 });
  assert.deepEqual(body.previous.orders, { orders: 2, gross_iqd: 40000, receivable_iqd: 38000, average_order_iqd: 20000 });
  assert.equal('traffic' in body.previous, false, 'no traffic was ever counted');

  // A store opened in the middle of the previous period had no «previous period».
  opened(raw, '2026-09-05T00:00:00.000Z');
  assert.deepEqual(Object.keys((await report(raw)).body.previous), ['range']);
  // Opened on its first day exactly (Baghdad): the period is whole.
  opened(raw, '2026-08-31T21:30:00.000Z'); // 00:30 on 1 September in Baghdad
  assert.equal((await report(raw)).body.previous.orders.orders, 2);
});

test('a previous period with no orders is a real 0 (store open) — with no average', async () => {
  const raw = seedW2E();
  opened(raw, '2026-01-01T00:00:00.000Z');
  const { body } = await report(raw);
  assert.deepEqual(body.previous.orders, { orders: 0, gross_iqd: 0, receivable_iqd: 0 });
});

test('previous traffic only when BOTH periods were counted on every day; its conversion only with visitors', async () => {
  const raw = seedW2E();
  opened(raw, '2026-01-01T00:00:00.000Z');
  traffic(raw, 's2', '2026-09-03', 1); // counting began on the 3rd — the previous period (1–10) is half-counted
  traffic(raw, 's1', '2026-09-04', 50, 80);
  traffic(raw, 's1', '2026-09-12', 40, 60);
  assert.equal('traffic' in (await report(raw)).body.previous, false, 'a half-counted period is no comparison');

  raw.exec(`DELETE FROM merchant_store_analytics_daily WHERE store_id = 's2'`);
  traffic(raw, 's2', '2026-09-01', 1); // counting began on the 1st
  addOrder(raw, { id: 'P1', at: '2026-09-02T10:00:00.000Z' });
  const { body } = await report(raw);
  assert.deepEqual(body.previous.traffic, { visitors: 50, product_views: 80, add_to_cart: 0, checkout_started: 0, orders: 1, conversion_percent: 2 });
  assert.equal(body.traffic.totals.visitors, 40);
  // Zahra's previous traffic is her own.
  assert.equal((await report(raw, undefined, OWNER2)).body.previous.traffic.visitors, 1);
});

test('most viewed: this store\'s products by views over the counted days, nobody-viewed left out', async () => {
  const raw = seedW2E();
  traffic(raw, 's1', '2026-09-11', 3);
  raw.exec(`INSERT INTO merchant_product_analytics_daily (store_id, product_id, day, views, add_to_cart) VALUES
    ('s1','cp1','2026-09-12',4,1), ('s1','cp2','2026-09-12',9,0), ('s1','cp2','2026-09-13',1,0),
    ('s1','cp1','2026-08-01',99,0),
    ('s2','cp9','2026-09-12',50,0)`);
  const { body } = await report(raw);
  assert.deepEqual(body.products.most_viewed, [
    { id: 'cp2', name: 'Lamp', views: 10, add_to_cart: 0 },
    { id: 'cp1', name: 'Vase', views: 4, add_to_cart: 1 },
  ]);
  const none = seedW2E();
  assert.equal('most_viewed' in (await report(none)).body.products, false, 'no traffic: absent');
});
