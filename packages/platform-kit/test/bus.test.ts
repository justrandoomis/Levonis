import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcFanoutBus, batchEnvelopes, backoffSeconds, MAX_DELIVERY_ATTEMPTS, chunkQueueMessages, toQueueMessages, queueAsConsumer, selectConsumers } from '../src/bus';
import { outboxSchemaSql, OutboxProbe, Uow } from '../src/outbox';
import { uuidv7 } from '../src/correlation';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { DeliverResult } from '@levonis/contracts/rpc/common';
import { OrderCreatedV1 } from '@levonis/contracts/events/v1/OrderCreated';
import { DepositDecidedV1 } from '@levonis/contracts/events/v1/DepositDecided';
import { ProductViewedV1 } from '@levonis/contracts/events/v1/ProductViewed';
import { memoryDb, count, all, row } from './_sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'src', 'events', 'fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.v1.json`), 'utf8')) as EventEnvelope;

let clockMs = Date.UTC(2026, 8, 7, 10, 0, 0);
const clock = { now: () => clockMs };

function orderCreated(seq: number): EventEnvelope {
  const base = fixture('OrderCreated');
  const env = OrderCreatedV1.envelope({
    event_id: uuidv7(clock), created_at: new Date(clockMs).toISOString(), source_service: 'commerce', correlation_id: base.correlation_id, causation_id: null, actor_id: 'usr_01',
    aggregate_id: `ord_${seq}`, aggregate_seq: 1, payload: { ...(base.payload as Record<string, unknown>), order_id: `ord_${seq}` } as never,
  });
  return { ...env, sig: 'fixture' };
}

class FakeConsumer {
  received: EventEnvelope[][] = [];
  mode: 'ack' | 'throw' | 'retry' | 'invalid' = 'ack';
  async deliver(batch: EventEnvelope[]): Promise<DeliverResult> {
    this.received.push(batch);
    if (this.mode === 'throw') throw new Error('consumer down');
    return { results: batch.map((e) => ({ event_id: e.event_id, result: this.mode === 'ack' ? 'acked' : this.mode === 'retry' ? 'retry' : 'invalid' })) };
  }
}

function setup(consumers: Record<string, FakeConsumer>, budgets?: Partial<import('../src/bus').BusBudgets>) {
  const { db, raw } = memoryDb(outboxSchemaSql('commerce'));
  const bus = new RpcFanoutBus({ db, prefix: 'commerce', source: 'commerce', enabled: 'on', consumers, now: clock.now, probe: new OutboxProbe(), budgets });
  return { db, raw, bus };
}

async function publish(db: D1Database, bus: RpcFanoutBus, envs: EventEnvelope[]) {
  const uow = new Uow(db, { enabled: 'on', prefix: 'commerce', probe: new OutboxProbe() });
  for (const e of envs) await uow.publish(e);
  await uow.commit();
  return uow.eventIds;
}

test('publish -> pumpIds delivers only the committed ids to every PII-eligible subscriber, one bookkeeping statement per deliver()', async () => {
  const notifications = new FakeConsumer();
  const analytics = new FakeConsumer();
  const risk = new FakeConsumer();
  const audit = new FakeConsumer();
  const { db, raw, bus } = setup({ notifications, analytics, risk, audit });
  const ids = await publish(db, bus, [orderCreated(1), orderCreated(2)]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM commerce_outbox_events'), 2);
  const report = await bus.pumpIds(ids);
  assert.equal(report.selected, 2);
  assert.equal(report.delivered, 8, '2 events x 4 subscribers of OrderCreated (notifications, risk, audit, analytics)');
  assert.equal(report.rpc_calls, 4, 'one deliver() per consumer for a small batch');
  assert.deepEqual(notifications.received.map((b) => b.length), [2]);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM commerce_outbox_deliveries WHERE state = 'acked'"), 8);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM commerce_outbox_events WHERE dispatched_at IS NOT NULL'), 2, 'every subscriber acked -> dispatched');
  // a second pump of the same ids finds nothing pending
  const again = await bus.pumpIds(ids);
  assert.equal(again.selected, 0);
});

test('a personal event never reaches Analytics; an unbound subscriber leaves its delivery pending (the event is not dispatched)', async () => {
  const notifications = new FakeConsumer();
  const analytics = new FakeConsumer();
  const { db, raw, bus } = setup({ notifications, analytics }); // risk and audit unbound
  const base = fixture('DepositDecided');
  const env = { ...DepositDecidedV1.envelope({ ...base, event_id: uuidv7(clock), payload: base.payload as never }), sig: 'fixture' } as EventEnvelope;
  const ids = await publish(db, bus, [env]);
  assert.deepEqual(bus.subscribersFor(env).sort(), ['audit', 'notifications', 'risk']);
  await bus.pumpIds(ids);
  assert.equal(analytics.received.length, 0, 'personal never goes to analytics');
  assert.equal(notifications.received.length, 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM commerce_outbox_deliveries WHERE state = 'pending'"), 2, 'risk + audit still pending');
  assert.equal(row(raw, 'SELECT dispatched_at FROM commerce_outbox_events')!.dispatched_at, null);
});

test('a failing consumer backs off exponentially and is dead after 8 attempts; the others are unaffected', async () => {
  const notifications = new FakeConsumer();
  notifications.mode = 'throw';
  const analytics = new FakeConsumer();
  const { db, raw, bus } = setup({ notifications, analytics, risk: new FakeConsumer(), audit: new FakeConsumer() });
  const ids = await publish(db, bus, [orderCreated(3)]);
  const r1 = await bus.pumpIds(ids);
  assert.equal(r1.retried, 1);
  assert.equal(r1.delivered, 3);
  let d = row<{ attempts: number; state: string; next_attempt_at: string }>(raw, "SELECT attempts, state, next_attempt_at FROM commerce_outbox_deliveries WHERE consumer = 'notifications'")!;
  assert.equal(d.attempts, 1);
  assert.equal(d.state, 'pending');
  const wait1 = (Date.parse(d.next_attempt_at) - clockMs) / 1000;
  assert.ok(wait1 >= backoffSeconds(1) && wait1 < backoffSeconds(1) + 6, `first backoff ~${backoffSeconds(1)} s (+jitter), got ${wait1}`);
  // not due yet: nothing happens
  await bus.pumpIds(ids);
  assert.equal(notifications.received.length, 1);
  for (let attempt = 2; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    clockMs += (backoffSeconds(attempt - 1) + 6) * 1000;
    await bus.pumpIds(ids);
  }
  d = row(raw, "SELECT attempts, state, next_attempt_at FROM commerce_outbox_deliveries WHERE consumer = 'notifications'")!;
  assert.equal(d.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.equal(d.state, 'dead', 'the DLQ is the deliveries table');
  assert.equal(notifications.received.length, MAX_DELIVERY_ATTEMPTS);
  assert.ok(row(raw, 'SELECT dispatched_at FROM commerce_outbox_events')!.dispatched_at, 'dead counts as settled');
  // admin redeliver puts it back and delivers once the consumer is healthy
  notifications.mode = 'ack';
  const rr = await bus.redeliver(ids[0], 'notifications');
  assert.equal(rr.delivered, 1);
  assert.equal(row(raw, "SELECT state FROM commerce_outbox_deliveries WHERE consumer = 'notifications'")!.state, 'acked');
});

test('schema-invalid / forged outcomes are dead at once (poison never blocks the stream)', async () => {
  const notifications = new FakeConsumer();
  notifications.mode = 'invalid';
  const { db, raw, bus } = setup({ notifications, analytics: new FakeConsumer(), risk: new FakeConsumer(), audit: new FakeConsumer() });
  const ids = await publish(db, bus, [orderCreated(4)]);
  const r = await bus.pumpIds(ids);
  assert.equal(r.dead, 1);
  assert.equal(row(raw, "SELECT state, last_error FROM commerce_outbox_deliveries WHERE consumer = 'notifications'")!.last_error, 'invalid');
  assert.equal(notifications.received.length, 1);
  await bus.pumpIds(ids);
  assert.equal(notifications.received.length, 1, 'never retried');
});

test('the cron pump is the only lock holder: a second concurrent pump returns null; budgets stop a run and the next run continues', async () => {
  const consumer = new FakeConsumer();
  const { db, raw, bus } = setup({ notifications: consumer, analytics: consumer, risk: consumer, audit: consumer }, { statements: 12, rpcCalls: 2 });
  await publish(db, bus, Array.from({ length: 6 }, (_, i) => orderCreated(10 + i)));
  // hold the lock by hand: the pump must refuse
  raw.prepare("UPDATE pump_lock SET locked_until = ? WHERE name = 'commerce'").run(new Date(clockMs + 60_000).toISOString());
  assert.equal(await bus.pump('other'), null);
  raw.prepare("UPDATE pump_lock SET locked_until = ? WHERE name = 'commerce'").run(new Date(clockMs).toISOString());
  const r1 = await bus.pump();
  assert.ok(r1);
  assert.equal(r1!.budget_hit, true, 'the tiny budget is hit');
  assert.ok(r1!.rpc_calls <= 2);
  assert.equal(row(raw, "SELECT holder FROM pump_lock WHERE name = 'commerce'")!.holder, '', 'lock released');
  let guard = 0;
  while (count(raw, 'SELECT COUNT(*) AS n FROM commerce_outbox_events WHERE dispatched_at IS NULL') > 0 && guard++ < 50) {
    const r = await bus.pump();
    assert.ok(r, 'lock is free between runs');
  }
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM commerce_outbox_deliveries WHERE state = 'acked'"), 24, '6 events x 4 subscribers eventually delivered');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM commerce_outbox_events WHERE dispatched_at IS NULL'), 0);
  const seqs = all<{ seq: number }>(raw, 'SELECT seq FROM commerce_outbox_events ORDER BY dispatched_at, seq').map((r) => r.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6], 'delivered in seq order');
});

test('best_effort telemetry never touches the outbox and is dropped on failure', async () => {
  const analytics = new FakeConsumer();
  const ads = new FakeConsumer();
  ads.mode = 'throw';
  const { raw, bus } = setup({ analytics, ads, search: new FakeConsumer() });
  const base = fixture('ProductViewed');
  const env = { ...ProductViewedV1.envelope({ ...base, event_id: uuidv7(clock), payload: base.payload as never }), sig: 'fixture' } as EventEnvelope;
  const pending: Promise<unknown>[] = [];
  bus.emitBestEffort(env, (p) => void pending.push(p));
  await Promise.all(pending);
  assert.equal(analytics.received.length, 1);
  assert.equal(ads.received.length, 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM commerce_outbox_events'), 0);
  assert.throws(() => bus.emitBestEffort(orderCreated(99)), /transactional/);
  await assert.rejects(() => new Uow(raw as never, { enabled: 'on', prefix: 'commerce' }).publish(env), /best_effort/);
});

test('deliver() batches are capped at 50 events and 500 KB; queue chunks at 100 messages / 256 KB with pointers above 100 KB', () => {
  const small = Array.from({ length: 120 }, (_, i) => orderCreated(200 + i));
  const batches = batchEnvelopes(small);
  assert.deepEqual(batches.map((b) => b.length), [50, 50, 20]);
  const big = orderCreated(1);
  (big.payload as Record<string, unknown>).blob = 'x'.repeat(300 * 1024);
  const byBytes = batchEnvelopes([big, big, big]);
  assert.deepEqual(byBytes.map((b) => b.length), [1, 1, 1], 'a 300 KB envelope travels alone');
  const msgs = toQueueMessages([big, orderCreated(2)], 'commerce');
  assert.equal(msgs[0].kind, 'pointer', '>100 KB goes as a pointer');
  assert.equal(msgs[1].kind, 'envelope');
  assert.deepEqual(chunkQueueMessages(toQueueMessages(small, 'commerce')).map((c) => c.length), [100, 20]);
});

test('queue mode reuses the same bookkeeping: a queue binding acks what it accepted', async () => {
  const sent: unknown[][] = [];
  const q = { sendBatch: async (m: Array<{ body: unknown }>) => void sent.push(m.map((x) => x.body)) };
  const consumers = selectConsumers('queue', { analytics: new FakeConsumer() }, { notifications: q }, 'commerce');
  assert.ok(consumers.notifications);
  const r = await consumers.notifications!.deliver([orderCreated(1), orderCreated(2)]);
  assert.equal(r.results.length, 2);
  assert.equal(sent[0].length, 2);
  assert.equal(selectConsumers('rpc', { analytics: new FakeConsumer() }, { notifications: q }, 'commerce').notifications, undefined);
  assert.equal(typeof queueAsConsumer(q, 'commerce').deliver, 'function');
});
