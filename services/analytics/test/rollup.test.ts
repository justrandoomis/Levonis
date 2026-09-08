/**
 * The numbers: counted once per event, unchanged by a redelivery, and the same
 * whether they were added one event at a time or recomputed from the raw rows.
 *
 * The last property is the one worth the test — the fast path (add in the
 * delivery batch) and the repair path (recompute the day) are two pieces of
 * code that must always agree, and the only reason they do is that both call
 * the same pure `metricsOf`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { analyticsConsumer } from '../src/consumer';
import { metricsOf, METRICS } from '../src/metrics';
import { repairDay, sweep, dayBefore, repairDays, REPAIR_WRITE_CHUNK } from '../src/rollup';
import { overview } from '../src/read';
import { platformDaily, merchantDaily, countForDay } from '../src/store';
import { analyticsDb, count, one, rows } from './_db';
import { fixture, producers, nextEventId } from './_events';

const SALT = 'salt';
const DAY = '2026-09-08';
const AT = `${DAY}T10:00:00.000Z`;

async function stack() {
  const { db, raw } = analyticsDb();
  const p = await producers();
  const consumer = analyticsConsumer({ keys: p.ring, salt: SALT, now: () => AT });
  const send = async (key: string, patch: Partial<EventEnvelope> = {}) => {
    const src = fixture(key);
    const envelope = { ...src, event_id: nextEventId(), created_at: AT, ...patch } as EventEnvelope;
    return consumer.deliver(db, [await p.sign(envelope)]);
  };
  return { db, raw, p, consumer, send };
}

const metric = (raw: import('node:sqlite').DatabaseSync, name: string, day = DAY): number =>
  Number(one<{ value: number }>(raw, 'SELECT value FROM analytics_daily_platform WHERE day = ? AND metric = ?', day, name)?.value ?? 0);

test('an order raises the order counters, the item count and the day`s GMV', async () => {
  const s = await stack();
  const res = await s.send('OrderCreated.v1');
  assert.equal(res.results[0].result, 'acked');

  const payload = fixture('OrderCreated.v1').payload as { totals: { total_iqd: number }; items: unknown[]; merchant_id: string | null };
  assert.equal(metric(s.raw, METRICS.ordersCreated), 1);
  assert.equal(metric(s.raw, METRICS.orderItems), payload.items.length);
  assert.equal(metric(s.raw, METRICS.gmvCreatedIqd), payload.totals.total_iqd);
  assert.equal(count(s.raw, 'SELECT COUNT(*) AS n FROM analytics_events'), 1);
});

test('a redelivery adds nothing: the rollup rides in the same batch as processed_events', async () => {
  const s = await stack();
  const src = fixture('OrderCreated.v1');
  const envelope = { ...src, event_id: nextEventId(), created_at: AT } as EventEnvelope;
  const signed = await s.p.sign(envelope);

  assert.equal((await s.consumer.deliver(s.db, [signed])).results[0].result, 'acked');
  const afterFirst = metric(s.raw, METRICS.ordersCreated);
  assert.equal((await s.consumer.deliver(s.db, [signed])).results[0].result, 'replayed');
  assert.equal((await s.consumer.deliver(s.db, [signed, signed])).results[0].result, 'replayed');
  assert.equal(metric(s.raw, METRICS.ordersCreated), afterFirst, 'a replay must not add a second count');
  assert.equal(count(s.raw, 'SELECT COUNT(*) AS n FROM analytics_events'), 1);
});

test('a refused event contributes no row and no counter', async () => {
  const s = await stack();
  const src = fixture('OrderCreated.v1');
  // signed by a service that may not produce it
  const forged = await s.p.sign({ ...src, source_service: 'ads', event_id: nextEventId() } as EventEnvelope);
  const res = await s.consumer.deliver(s.db, [forged]);
  assert.equal(res.results[0].result, 'forged');
  assert.equal(count(s.raw, 'SELECT COUNT(*) AS n FROM analytics_events'), 0);
  assert.equal(count(s.raw, 'SELECT COUNT(*) AS n FROM analytics_daily_platform'), 0);
});

test('merchant counters are kept per merchant, and only for events that name one', async () => {
  const s = await stack();
  const orderFixture = fixture('OrderCreated.v1');
  const merchantId = 'mch_alpha';
  await s.send('OrderCreated.v1', { payload: { ...(orderFixture.payload as object), merchant_id: merchantId, seller_type: 'merchant' } } as Partial<EventEnvelope>);
  await s.send('OrderCreated.v1', { payload: { ...(orderFixture.payload as object), merchant_id: null, seller_type: 'platform' } } as Partial<EventEnvelope>);

  const points = await merchantDaily(s.db, merchantId, {});
  const created = points.find((p) => p.metric === METRICS.ordersCreated);
  assert.equal(created?.value, 1, 'only the merchant order counted for the merchant');
  assert.equal(metric(s.raw, METRICS.ordersCreated), 2, 'both counted for the platform');
  assert.equal(rows(s.raw, 'SELECT DISTINCT merchant_id FROM analytics_daily_merchant').length, 1);
});

test('the repair pass recomputes a day to exactly what the incremental path produced', async () => {
  const s = await stack();
  for (const key of ['OrderCreated.v1', 'OrderDelivered.v1', 'PurchaseCompleted.v1', 'PaymentCompleted.v1', 'UserCreated.v1', 'RefundCompleted.v1']) {
    await s.send(key);
  }
  const before = rows(s.raw, 'SELECT day, metric, value FROM analytics_daily_platform ORDER BY metric');
  const beforeMerchant = rows(s.raw, 'SELECT day, merchant_id, metric, value FROM analytics_daily_merchant ORDER BY merchant_id, metric');

  const res = await repairDay(s.db, DAY, { now: AT, maxRows: 1000 });
  assert.equal(res.rows, 6);
  assert.ok(res.metrics > 0);
  assert.deepEqual(rows(s.raw, 'SELECT day, metric, value FROM analytics_daily_platform ORDER BY metric'), before, 'the repair changed a number the fast path had right');
  assert.deepEqual(rows(s.raw, 'SELECT day, merchant_id, metric, value FROM analytics_daily_merchant ORDER BY merchant_id, metric'), beforeMerchant);
});

test('the repair pass restores a rollup that drifted, and refuses to walk a day above its ceiling', async () => {
  const s = await stack();
  await s.send('OrderCreated.v1');
  await s.send('OrderCreated.v1');
  assert.equal(metric(s.raw, METRICS.ordersCreated), 2);

  // something wrote a wrong number behind the service
  s.raw.exec(`UPDATE analytics_daily_platform SET value = 99 WHERE metric = '${METRICS.ordersCreated}'`);
  await repairDay(s.db, DAY, { now: AT, maxRows: 1000 });
  assert.equal(metric(s.raw, METRICS.ordersCreated), 2, 'the repair pass is the authority on a day it can recompute');

  s.raw.exec(`UPDATE analytics_daily_platform SET value = 99 WHERE metric = '${METRICS.ordersCreated}'`);
  const skipped = await repairDay(s.db, DAY, { now: AT, maxRows: 1 });
  assert.equal(skipped.skipped, true);
  assert.equal(metric(s.raw, METRICS.ordersCreated), 99, 'above the ceiling it leaves the numbers alone rather than half-recomputing them');
});

test('the sweep rolls raw events out at the retention window and keeps every rollup', async () => {
  const s = await stack();
  await s.send('OrderCreated.v1');
  const oldDay = dayBefore(DAY, 45);
  await s.send('OrderCreated.v1', { created_at: `${oldDay}T10:00:00.000Z` });
  assert.equal(await countForDay(s.db, oldDay), 1);

  const res = await sweep(s.db, { today: DAY, now: AT, rollupDays: 2, retentionDays: 30, maxRows: 1000 });
  assert.equal(res.pruned, 1);
  assert.equal(res.prunedBefore, dayBefore(DAY, 30));
  assert.equal(await countForDay(s.db, oldDay), 0, 'raw events roll at 30 days');
  assert.equal(await countForDay(s.db, DAY), 1);

  const series = await platformDaily(s.db, { metric: METRICS.ordersCreated });
  assert.deepEqual(
    series.map((p) => `${p.day}=${p.value}`).sort(),
    [`${DAY}=1`, `${oldDay}=1`].sort(),
    'the rollups outlive the raw rows they were computed from'
  );
});

test('the repair window never reaches a day whose raw rows have rolled off', () => {
  const days = repairDays(DAY, 2);
  assert.deepEqual(days, [DAY, dayBefore(DAY, 1)]);
  for (const day of days) assert.ok(day > dayBefore(DAY, 30), `${day} is inside the retention window`);
});

test('overview() reads the rollups and reports what it cannot know as zero', async () => {
  const s = await stack();
  await s.send('OrderCreated.v1');
  await s.send('OrderDelivered.v1');
  await s.send('PurchaseCompleted.v1');
  await s.send('UserCreated.v1');
  await s.send('PaymentCompleted.v1');
  await s.send('SubscriptionChanged.v1');

  const o = await overview(s.db, {});
  const purchase = fixture('PurchaseCompleted.v1').payload as { value_iqd: number };
  assert.equal(o.orders.total, 1);
  assert.equal(o.orders.delivered, 1);
  assert.equal(o.orders.pending, 0);
  assert.equal(o.orders.revenue_iqd, purchase.value_iqd);
  assert.equal(o.users.total, 1);
  assert.equal(o.users.investors, 0, 'the investor flag travels on a personal event Analytics never sees');

  const sub = fixture('SubscriptionChanged.v1').payload as { active: boolean; to_tier: string | null };
  if (sub.active && sub.to_tier === 'pro') assert.equal(o.users.pro, 1);

  const ranged = await overview(s.db, { from: '2099-01-01', to: '2099-12-31' });
  assert.deepEqual(ranged.orders, { total: 0, pending: 0, delivered: 0, revenue_iqd: 0 }, 'a range with no days is zeros, not the all-time total');
  assert.equal(ranged.from, '2099-01-01');
});

test('a cancelled order leaves `pending` where it should be, and never negative', async () => {
  const s = await stack();
  const status = fixture('OrderStatusChanged.v1');
  await s.send('OrderCreated.v1');
  await s.send('OrderStatusChanged.v1', { payload: { ...(status.payload as object), to: 'cancelled' } } as Partial<EventEnvelope>);
  const o = await overview(s.db, {});
  assert.equal(o.orders.total, 1);
  assert.equal(o.orders.pending, 0);

  // a cancellation with no creation in range must not produce a negative count
  const s2 = await stack();
  await s2.send('OrderStatusChanged.v1', { payload: { ...(status.payload as object), to: 'cancelled' } } as Partial<EventEnvelope>);
  assert.equal((await overview(s2.db, {})).orders.pending, 0);
});

test('metricsOf is total and drops empty counters', () => {
  assert.deepEqual(metricsOf('NotAnEvent.v1', {}), []);
  const zeroed = metricsOf('RefundCompleted.v1', { usd_cents: 0, points: 0 });
  assert.deepEqual(
    zeroed.map((m) => m.metric),
    [METRICS.refunds],
    'a zero-valued counter is not written'
  );
});

/**
 * THE REPAIR WRITE IS BOUNDED BY THE MERCHANT COUNT, NOT ONLY BY ROWS READ.
 *
 * `ANALYTICS_ROLLUP_MAX_ROWS` caps rows READ. The statement count grows with
 * the number of DISTINCT (merchant, metric) pairs, so a day with one merchant
 * per row produced one `db.batch()` carrying tens of thousands of statements —
 * far past anything D1 will accept, and the pass then never repairs the day at
 * all.
 */
test('a day with many merchants is written in bounded batches, never one huge one', async () => {
  const { db, raw } = analyticsDb();
  const day = '2026-09-07';
  const MERCHANTS = 300;
  for (let i = 0; i < MERCHANTS; i++) {
    raw
      .prepare(
        `INSERT INTO analytics_events
           (event_id, event_type, version, day, occurred_at, ingested_at, source_service, aggregate_type, aggregate_id, aggregate_seq, merchant_id, payload)
         VALUES (?, 'OrderCreated', 1, ?, ?, ?, 'commerce', 'order', ?, 1, ?, ?)`
      )
      .run(
        `evt_${String(i).padStart(6, '0')}`,
        day,
        `${day}T10:00:00.000Z`,
        `${day}T10:00:01.000Z`,
        `ord_${i}`,
        `mer_${i}`,
        JSON.stringify({ order_id: `o${i}`, total_iqd: 1000, currency: 'IQD', item_count: 1 })
      );
  }

  const batches: number[] = [];
  const counting = {
    ...db,
    prepare: db.prepare.bind(db),
    batch: async (stmts: D1PreparedStatement[]) => {
      batches.push(stmts.length);
      return db.batch(stmts);
    },
  } as unknown as D1Database;

  const res = await repairDay(counting, day, { now: '2026-09-07T12:00:00.000Z', maxRows: 20_000 });
  assert.equal(res.skipped, undefined);
  assert.ok(res.metrics > MERCHANTS, 'one statement per distinct (merchant, metric) pair, plus the platform ones');
  assert.ok(batches.length > 1, 'the write was chunked');
  for (const n of batches) assert.ok(n <= REPAIR_WRITE_CHUNK, `a batch of ${n} statements exceeds the chunk`);

  // …and the numbers are still right afterwards.
  const stored = Number((raw.prepare('SELECT COUNT(*) AS n FROM analytics_daily_merchant WHERE day = ?').get(day) as { n: number }).n);
  assert.ok(stored >= MERCHANTS);
});
