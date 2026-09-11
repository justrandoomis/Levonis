/**
 * THE CORE AS A PRODUCER — the outbox, the dispatcher and the named
 * entrypoints (02-MIGRATION-PLAN.md 1.6, 03-EVENTS.md §2).
 *
 * The property that matters most here is the one that is easiest to lose: with
 * no `EVENT_BUS_ENABLED=on`, no outbox table or no consumer binding — the live
 * Worker today, and the live Worker after this ships — NOTHING changes. Every
 * "off" case below asserts the statement count of the batch the business code
 * would have run anyway, not merely that no event was written.
 *
 * The rest is the dispatcher against fake consumer bindings: acked, retried
 * with backoff, dead-lettered after the eighth attempt, and never delivered to
 * a consumer this deployment cannot reach.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, count, row, all } from './fixtures/app';
import type { Env } from '../worker/lib/types';
import {
  CORE_SERVICE,
  busFor,
  configureEventBus,
  dailyUserHash,
  emitEvent,
  eventsEnabled,
  nextAggregateSeq,
  outboxStatement,
  pruneOutbox,
  pumpOutbox,
  resetEventBus,
  subscriptionsFor,
} from '../worker/lib/eventBus';
import { audit } from '../worker/lib/audit';
import { planInventory } from '../worker/lib/inventory';
import { commitHold, commitHoldStatements, createPurchaseHold, holdDebitTxId, holdSettledEventStatements } from '../worker/lib/walletOps';
import { outboxSchemaSql } from '@levonis/platform-kit/outbox';
import { auditDetailsSchemaSql } from '@levonis/platform-kit/audit';
import { MAX_DELIVERY_ATTEMPTS } from '@levonis/platform-kit/bus';
import { OrderCreatedV1 } from '@levonis/contracts/events/v1/OrderCreated';
import { InventoryChangedV1 } from '@levonis/contracts/events/v1/InventoryChanged';
import type { EventEnvelope } from '@levonis/contracts/envelope';

// --------------------------------------------------------------- fixtures

interface FakeConsumer {
  name: string;
  seen: EventEnvelope[][];
  deliver(batch: EventEnvelope[]): Promise<{ results: Array<{ event_id: string; result: string }> }>;
}

/** A bound consumer Worker that acknowledges everything. */
function acking(name: string): FakeConsumer {
  const seen: EventEnvelope[][] = [];
  return {
    name,
    seen,
    async deliver(batch) {
      seen.push(batch);
      return { results: batch.map((e) => ({ event_id: e.event_id, result: 'acked' })) };
    },
  };
}

/** A bound consumer that is having a bad day: every delivery is transient. */
function retrying(name: string): FakeConsumer {
  const seen: EventEnvelope[][] = [];
  return {
    name,
    seen,
    async deliver(batch) {
      seen.push(batch);
      return { results: batch.map((e) => ({ event_id: e.event_id, result: 'retry' })) };
    },
  };
}

function envFor(raw: DatabaseSync, extra: Record<string, unknown> = {}): Env {
  return { DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ...extra } as unknown as Env;
}

const ORDER_PAYLOAD = {
  order_id: 'ORD-1',
  user_id: 'usr_1',
  user_hash: 'a'.repeat(64),
  seller_type: 'platform' as const,
  merchant_id: null,
  store_id: null,
  payment_state: 'cod' as const,
  items: [{ order_item_id: 'oi_1', product_id: 'p1', qty: 1, unit_price_iqd: 1000, is_printer: false, warranty_plan_id: null, ops_policy_id: null }],
  totals: { merchandise_iqd: 1000, delivery_iqd: 0, discount_iqd: 0, total_iqd: 1000 },
  payment: { method: 'cash' as const, wallet_usd_cents: 0, points: 0, cod_iqd: 1000, exchange_rate: 1400 },
  shipping_type: 'direct',
  address_snapshot_ref: 'adr_1',
  coupon_code: null,
  membership_gift: false,
  referral_delivery_waived: false,
  idempotency_key: 'idem-1',
  created_at: new Date().toISOString(),
};

// ------------------------------------------------------- the migration itself

test('0057 creates exactly the platform tables the kit generates, and seeds no row', () => {
  const sql = readFileSync(join(ROOT, 'migrations/0057_core_outbox.sql'), 'utf8');
  // Every CREATE the kit's generator emits for this producer is in the file,
  // so the DDL the dispatcher was written against and the DDL that is applied
  // cannot drift apart.
  const generated = `${outboxSchemaSql(CORE_SERVICE)}\n${auditDetailsSchemaSql(CORE_SERVICE)}`;
  const statements = generated
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('CREATE'));
  assert.ok(statements.length >= 5, 'the generator should produce the four tables and their indexes');
  const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (const stmt of statements) {
    assert.ok(normalise(sql).includes(normalise(stmt)), `0057 is missing: ${normalise(stmt).slice(0, 80)}`);
  }
  // Additive: the file may never contain a statement that touches existing data.
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER']) {
    assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), new RegExp(`\\b${verb}\\s`, 'i'), `0057 must stay CREATE-only (found ${verb})`);
  }
});

test('0056 adds the ledger keys additively and leaves existing rows alone', () => {
  const raw = freshDb();
  const info = all<{ name: string; notnull: number; dflt_value: string }>(raw, 'PRAGMA table_info(wallet_transactions)');
  for (const col of ['event_key', 'correlation_id', 'source_service']) {
    const c = info.find((i) => i.name === col);
    assert.ok(c, `${col} missing`);
    assert.equal(c!.notnull, 1, `${col} should be NOT NULL`);
    assert.equal(c!.dflt_value, "''", `${col} should default to '' so every existing row keeps its meaning`);
  }
  // The UNIQUE index is PARTIAL: today's rows are all '' and must not collide.
  raw.exec(
    `INSERT INTO users (id, email, name) VALUES ('u1', 'u1@x.co', 'U');
     INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status) VALUES ('t1','u1','deposit','USD',10,'approved');
     INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status) VALUES ('t2','u1','deposit','USD',10,'approved');`
  );
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE event_key = ''"), 2);
  raw.exec("UPDATE wallet_transactions SET event_key = 'wtx_ord_1_usd' WHERE id = 't1'");
  assert.throws(
    () => raw.exec("UPDATE wallet_transactions SET event_key = 'wtx_ord_1_usd' WHERE id = 't2'"),
    /UNIQUE/,
    'a second row may not claim the same event_key'
  );
});

// ------------------------------------------------------------- the off cases

test('with no bus configured, nothing publishes and the audit row is the one row it has always been', async () => {
  resetEventBus();
  const raw = freshDb();
  const db = asD1(raw);
  assert.equal(busFor(db), null);
  assert.equal(await outboxStatement(db, OrderCreatedV1, ORDER_PAYLOAD, { aggregateId: 'ORD-1' }), null);
  await audit(db, 'usr_1', 'test.action', 'ORD-1', { a: 1 });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_log'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_audit_details'), 0);
});

test('a bus configured for ANOTHER database is not this database’s bus', async () => {
  resetEventBus();
  const a = freshDb();
  const b = freshDb();
  configureEventBus(envFor(a, { EVENT_BUS_ENABLED: 'on' }));
  assert.equal(await outboxStatement(asD1(b), OrderCreatedV1, ORDER_PAYLOAD, { aggregateId: 'ORD-1' }), null);
  assert.equal(count(b, 'SELECT COUNT(*) AS n FROM core_outbox_events'), 0);
});

test('EVENT_BUS_ENABLED unset: the inventory batch is exactly the batch it is today', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw); // no EVENT_BUS_ENABLED
  configureEventBus(env);
  assert.equal(eventsEnabled(env), false);
  seedProduct(raw);
  const plan = await planInventory(env.DB, [{ product_id: 'p1', qty: 2, line_id: 'l1', targets: [baseTarget()] }], {
    kind: 'reserve',
    operationId: 'op1',
  });
  // Two statements per move — the guarded ledger INSERT and the guarded counter
  // UPDATE — and not one more.
  assert.equal(plan.statements.length, 2);
});

/**
 * `busFor()` IS AN "IS THE BUS ON" CHECK, not merely "is there a handle".
 *
 * `configureEventBus(env)` runs on every fetch, so a handle exists whether or
 * not the bus is enabled. While it answered "yes, here is the handle" on a
 * Worker with `EVENT_BUS_ENABLED` unset, the three emitter guards written as
 * `if (busFor(db))` ran their bodies on the LIVE Worker — an extra `SELECT` on
 * every checkout settlement and three catalogue reads on every product save.
 * This counts the statements the money path prepares, which is the only form of
 * the assertion a refactor cannot quietly satisfy.
 */
test('with the bus off the wallet path prepares exactly the statements it does today', async () => {
  resetEventBus();
  const raw = freshDb();
  const off = envFor(raw); // no EVENT_BUS_ENABLED — the live Worker
  configureEventBus(off);
  assert.equal(busFor(off.DB), null, 'a handle that cannot publish is not a bus');

  seedFundedUser(raw, 'usr_off', 5000);
  const counted = countingDb(off.DB);
  const hold = await createPurchaseHold(counted.db, { userId: 'usr_off', amountCents: 900, eventKey: 'k_off', refType: 'order', refId: 'ord_off' });
  assert.ok(hold.ok && hold.holdId);
  const afterHold = counted.prepared.length;
  await commitHold(counted.db, { holdId: hold.holdId!, note: 'Purchase settled', ref: 'ord_off' });
  const settle = counted.prepared.slice(afterHold);

  // The settlement is the two `commitHoldStatements` and the state re-read that
  // has always followed them — no envelope, no outbox row, and above all no
  // extra `SELECT … FROM wallet_holds` for an event nobody asked for.
  assert.equal(settle.filter((sql) => /core_outbox_events/.test(sql)).length, 0, 'no outbox statement');
  assert.equal(
    settle.filter((sql) => /SELECT user_id, amount_cents, event_key/.test(sql)).length,
    0,
    'the event emitter did not read the hold row'
  );
  assert.equal(counted.prepared.filter((sql) => /PRAGMA table_info/.test(sql)).length, 0, 'not even the boot probe ran');
});

test('the table is absent: the bus is on, and still nothing is appended', async () => {
  resetEventBus();
  const raw = freshDb();
  raw.exec('DROP TABLE core_outbox_events');
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);
  assert.equal(await outboxStatement(env.DB, OrderCreatedV1, ORDER_PAYLOAD, { aggregateId: 'ORD-1' }), null);
  seedProduct(raw);
  const plan = await planInventory(env.DB, [{ product_id: 'p1', qty: 1, line_id: 'l1', targets: [baseTarget()] }], {
    kind: 'reserve',
    operationId: 'op-absent',
  });
  assert.equal(plan.statements.length, 2, 'code may ship before its migration');
});

// -------------------------------------------------------------- the on cases

test('the outbox row rides in the caller’s own batch', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);
  seedProduct(raw);
  const plan = await planInventory(env.DB, [{ product_id: 'p1', qty: 2, line_id: 'l1', targets: [baseTarget()] }], {
    kind: 'reserve',
    operationId: 'op2',
    actorUserId: null,
  });
  assert.equal(plan.statements.length, 3, 'the ledger row, the counter and ONE outbox row');
  await env.DB.batch(plan.statements);
  const stored = row<{ event_type: string; envelope: string; aggregate_id: string }>(
    raw,
    'SELECT event_type, envelope, aggregate_id FROM core_outbox_events'
  );
  assert.equal(stored?.event_type, 'InventoryChanged');
  assert.equal(stored?.aggregate_id, 'p1');
  const envelope = JSON.parse(stored!.envelope) as EventEnvelope<Record<string, unknown>>;
  assert.equal(envelope.source_service, 'core');
  assert.equal(envelope.delivery, 'transactional');
  // The event states the row AFTER the guarded statements it travels with.
  assert.deepEqual(envelope.payload, {
    product_id: 'p1',
    scope: { table: 'products', id: 'p1' },
    delta: 0,
    stock_after: 10,
    reserved_after: 2,
    reason: 'reserve',
    op_id: 'reserve:op2:l1:base:-',
    order_id: null,
  });
  // …and it is a valid InventoryChanged payload, not merely an object that looks like one.
  assert.deepEqual(InventoryChangedV1.parse(envelope.payload), envelope.payload);
});

/**
 * THE PHANTOM EVENT.
 *
 * `planInventory` puts the ledger INSERT and the counter UPDATE behind
 * `WHERE EXISTS (… AND <guard>)`. When the guard stops holding between the
 * pre-check read and the batch — two checkouts of the last unit, a checkout
 * racing an admin adjustment — both match ZERO rows and the batch still
 * commits. The event row must match zero rows too, or consumers are told a
 * movement happened that never did, which inverts the outbox's own promise
 * (`migrations/0057_core_outbox.sql`) for the highest-volume transactional
 * event in the system.
 */
test('a movement whose guard stopped holding writes NO event: the batch commits, the outbox stays empty', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);
  seedProduct(raw);

  const plan = await planInventory(env.DB, [{ product_id: 'p1', qty: 10, line_id: 'l1', targets: [baseTarget()] }], {
    kind: 'reserve',
    operationId: 'op-race',
  });
  assert.equal(plan.statements.length, 3, 'the ledger row, the counter and ONE guarded outbox row');

  // The race: between the pre-check and the batch, a concurrent reservation
  // takes the whole stock, so `stock - stock_reserved >= 10` no longer holds.
  raw.exec("UPDATE products SET stock_reserved = 10 WHERE id = 'p1'");

  await env.DB.batch(plan.statements);

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0, 'the guard refused the ledger row');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events'), 0, 'and therefore refused the event');
  assert.equal(count(raw, "SELECT stock_reserved AS n FROM products WHERE id = 'p1'"), 10, 'the counter did not move twice');
});

test('the same guard lets the event through when the movement DID happen', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);
  seedProduct(raw);
  const plan = await planInventory(env.DB, [{ product_id: 'p1', qty: 2, line_id: 'l1', targets: [baseTarget()] }], {
    kind: 'reserve',
    operationId: 'op-ok',
  });
  await env.DB.batch(plan.statements);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events'), 1, 'one ledger row, one event');
  const stored = row<{ envelope: string }>(raw, 'SELECT envelope FROM core_outbox_events');
  const payload = (JSON.parse(stored!.envelope) as EventEnvelope<{ op_id: string }>).payload;
  assert.equal(payload.op_id, plan.keys[0], 'the event names the ledger row that proves it');
});

test('a rolled-back business batch takes its event with it', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);
  const pending = await outboxStatement(env.DB, OrderCreatedV1, ORDER_PAYLOAD, { aggregateId: 'ORD-1', aggregateSeq: 1 });
  assert.ok(pending);
  await assert.rejects(
    env.DB.batch([pending!.statement, env.DB.prepare('INSERT INTO orders (id) VALUES (?)').bind('broken')]),
    'the batch must fail'
  );
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events'), 0);
});

/**
 * THE MONEY EVENTS (03-EVENTS.md §3.8-§3.10).
 *
 * Two properties, and both were wrong: an idempotent replay must not publish a
 * payment FAILURE for a payment that succeeded, and the settlement event must
 * be published by the path that actually settles — which is
 * `commitHoldStatements` inside the order's own batch, not `commitHold()`.
 */
test('an idempotent hold replay publishes no PaymentFailed — the payment succeeded', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);
  seedFundedUser(raw, 'usr_m', 5000);

  const first = await createPurchaseHold(env.DB, { userId: 'usr_m', amountCents: 1000, eventKey: 'ord_pay_1', refType: 'order', refId: 'ord_1' });
  assert.ok(first.ok && first.holdId);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM core_outbox_events WHERE event_type = 'PaymentAuthorized'"), 1, 'the authorisation rode in the hold batch');

  // settle it, then replay the very same request the way a double tap does
  await commitHold(env.DB, { holdId: first.holdId!, note: 'Purchase settled', ref: 'ord_1' });
  const replay = await createPurchaseHold(env.DB, { userId: 'usr_m', amountCents: 1000, eventKey: 'ord_pay_1', refType: 'order', refId: 'ord_1' });
  assert.equal(replay.ok, false, 'the hold is no longer active');

  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM core_outbox_events WHERE event_type = 'PaymentFailed'"),
    0,
    'a replay of a settled payment is not a payment failure'
  );
  // a real refusal still is one
  const broke = await createPurchaseHold(env.DB, { userId: 'usr_m', amountCents: 999_999, eventKey: 'ord_pay_2', refType: 'order', refId: 'ord_2' });
  assert.equal(broke.ok, false);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM core_outbox_events WHERE event_type = 'PaymentFailed'"), 1);
});

test('PaymentCompleted is published by the batch that posts the debit, and only when it posts', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);
  seedFundedUser(raw, 'usr_s', 5000);
  const hold = await createPurchaseHold(env.DB, { userId: 'usr_s', amountCents: 1200, eventKey: 'ord_pay_s', refType: 'order', refId: 'ord_s' });
  assert.ok(hold.ok && hold.holdId);

  // The statements the real settlement paths append to their OWN batch.
  const statements = [
    ...commitHoldStatements(env.DB, { holdId: hold.holdId!, note: 'Wallet payment on order ord_s', ref: 'ord_s' }),
    ...(await holdSettledEventStatements(env.DB, hold.holdId!)),
  ];
  await env.DB.batch(statements);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM core_outbox_events WHERE event_type = 'PaymentCompleted'"), 1);
  const stored = row<{ envelope: string }>(raw, "SELECT envelope FROM core_outbox_events WHERE event_type = 'PaymentCompleted'");
  const payload = (JSON.parse(stored!.envelope) as EventEnvelope<{ order_id: string | null; amount: number; ledger_tx_ids: string[] }>).payload;
  assert.equal(payload.order_id, 'ord_s');
  assert.equal(payload.amount, 1200);
  assert.equal(payload.ledger_tx_ids[0], holdDebitTxId(hold.holdId!), 'the event names the debit that proves it');
});

test('a settlement whose debit is refused publishes no PaymentCompleted', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);
  seedFundedUser(raw, 'usr_r', 5000);
  const hold = await createPurchaseHold(env.DB, { userId: 'usr_r', amountCents: 1200, eventKey: 'ord_pay_r', refType: 'order', refId: 'ord_r' });
  assert.ok(hold.ok && hold.holdId);
  const eventStatements = await holdSettledEventStatements(env.DB, hold.holdId!);
  assert.equal(eventStatements.length, 1);

  // The hold is released before the batch runs, so the debit's guard matches
  // nothing. The event must match nothing either.
  raw.exec(`UPDATE wallet_holds SET state = 'released', released_at = '2026-09-07T10:00:00.000Z' WHERE id = '${hold.holdId}'`);
  await env.DB.batch(eventStatements);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM core_outbox_events WHERE event_type = 'PaymentCompleted'"), 0);
});

test('audit() dual-writes: the legacy row, the detail body and the outbox row, in one batch', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);
  await audit(env.DB, 'adm_1', 'wallet.credit', 'usr_1', { usd_cents: 500 });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_log'), 1, 'audit_log is untouched by the migration');
  const legacy = row<{ actor_id: string; action: string; detail: string }>(raw, 'SELECT actor_id, action, detail FROM audit_log');
  assert.equal(legacy?.action, 'wallet.credit');
  assert.deepEqual(JSON.parse(legacy!.detail), { usd_cents: 500 });
  const event = row<{ event_type: string; envelope: string }>(raw, 'SELECT event_type, envelope FROM core_outbox_events');
  assert.equal(event?.event_type, 'AuditRecorded');
  const envelope = JSON.parse(event!.envelope) as EventEnvelope<{ detail_hash: string; detail_ref: string }>;
  assert.equal(envelope.pii_class, 'personal', 'an audit body is personal and never reaches Analytics or Ads');
  // The body is NOT in the envelope: only its hash and the row it lives in.
  assert.doesNotMatch(event!.envelope, /usd_cents/);
  const detail = row<{ event_id: string; detail: string }>(raw, 'SELECT event_id, detail FROM core_audit_details');
  assert.equal(detail?.event_id, envelope.payload.detail_ref);
  assert.deepEqual(JSON.parse(detail!.detail), { usd_cents: 500 });
});

// ------------------------------------------------------------- the dispatcher

test('the pump delivers to every bound consumer, records the acks and marks the event dispatched', async () => {
  resetEventBus();
  const raw = freshDb();
  const auditSvc = acking('audit');
  const analytics = acking('analytics');
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on', AUDIT: auditSvc, ANALYTICS: analytics });
  configureEventBus(env);
  await emitEvent(env.DB, OrderCreatedV1, ORDER_PAYLOAD, { aggregateId: 'ORD-1', aggregateSeq: 1, actorId: 'usr_1' });

  const report = await pumpOutbox(env, 'test');
  assert.ok(report);
  assert.equal(report!.selected, 1);
  assert.equal(report!.delivered, 2, 'audit and analytics both subscribe to OrderCreated');
  assert.equal(auditSvc.seen.length, 1);
  assert.equal(auditSvc.seen[0][0].event_type, 'OrderCreated');
  assert.equal(analytics.seen.length, 1);
  const deliveries = all<{ consumer: string; state: string; attempts: number }>(
    raw,
    'SELECT consumer, state, attempts FROM core_outbox_deliveries ORDER BY consumer'
  );
  assert.deepEqual(deliveries, [
    { consumer: 'analytics', state: 'acked', attempts: 1 },
    { consumer: 'audit', state: 'acked', attempts: 1 },
  ]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events WHERE dispatched_at IS NOT NULL'), 1);

  // A second pump has nothing to do — delivery is exactly-once per consumer.
  const second = await pumpOutbox(env, 'test');
  assert.equal(second!.selected, 0);
  assert.equal(auditSvc.seen.length, 1);
});

test('a consumer this deployment cannot reach is not a subscriber, so the event still completes', async () => {
  resetEventBus();
  // `OrderCreated` names risk and analytics in the end-state table; with only
  // AUDIT bound, only audit may be a subscriber — otherwise every event would
  // stay pending for ever and the cron would re-select a growing backlog.
  assert.deepEqual(subscriptionsFor(['audit'])['OrderCreated.v1'], ['audit']);
  assert.equal(subscriptionsFor([])['OrderCreated.v1'], undefined);
  const raw = freshDb();
  const auditSvc = acking('audit');
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on', AUDIT: auditSvc });
  configureEventBus(env);
  await emitEvent(env.DB, OrderCreatedV1, ORDER_PAYLOAD, { aggregateId: 'ORD-1', aggregateSeq: 1 });
  await pumpOutbox(env, 'test');
  assert.deepEqual(
    all<{ consumer: string }>(raw, 'SELECT consumer FROM core_outbox_deliveries'),
    [{ consumer: 'audit' }],
    'no delivery row is created for a consumer that is not bound'
  );
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events WHERE dispatched_at IS NOT NULL'), 1);
});

test('a transient failure is retried with backoff and dead-letters after the eighth attempt', async () => {
  resetEventBus();
  const raw = freshDb();
  const flaky = retrying('audit');
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on', AUDIT: flaky });
  configureEventBus(env);
  const eventId = await emitEvent(env.DB, OrderCreatedV1, ORDER_PAYLOAD, { aggregateId: 'ORD-1', aggregateSeq: 1 });
  assert.ok(eventId);

  await pumpOutbox(env, 'test');
  let delivery = row<{ state: string; attempts: number; next_attempt_at: string }>(
    raw,
    'SELECT state, attempts, next_attempt_at FROM core_outbox_deliveries'
  );
  assert.equal(delivery?.state, 'pending');
  assert.equal(delivery?.attempts, 1);
  assert.ok(Date.parse(delivery!.next_attempt_at) > Date.now(), 'the retry is scheduled into the future, not immediately');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events WHERE dispatched_at IS NOT NULL'), 0, 'an undelivered event is not dispatched');

  // Drive it to the dead-letter state without waiting out the backoff.
  for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
    raw.exec("UPDATE core_outbox_deliveries SET next_attempt_at = '1970-01-01T00:00:00.000Z'");
    await pumpOutbox(env, 'test');
  }
  delivery = row(raw, 'SELECT state, attempts, next_attempt_at FROM core_outbox_deliveries');
  assert.equal(delivery?.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.equal(delivery?.state, 'dead', 'the DLQ is the deliveries table, replayable by redeliver()');
  // A dead delivery no longer blocks the event: nothing is pending on it.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM core_outbox_deliveries WHERE state = 'pending'"), 0);
});

test('the pump takes the lock, creates it when the migration did not, and stays silent when there is nothing to do', async () => {
  resetEventBus();
  const raw = freshDb();
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM pump_lock'), 0, 'the migration seeds no row');
  const auditSvc = acking('audit');
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on', AUDIT: auditSvc });
  configureEventBus(env);
  await pumpOutbox(env, 'test');
  const lock = row<{ name: string; holder: string; locked_until: string }>(raw, 'SELECT name, holder, locked_until FROM pump_lock');
  assert.equal(lock?.name, CORE_SERVICE);
  assert.equal(lock?.holder, '', 'the lease is released at the end of the run');

  // Off, or unbound: no lock is taken and no report is produced.
  resetEventBus();
  const quiet = envFor(raw, { AUDIT: auditSvc });
  assert.equal(await pumpOutbox(quiet, 'test'), null);
  resetEventBus();
  const unbound = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  assert.equal(await pumpOutbox(unbound, 'test'), null);
});

test('a held lock stops a second sweep from delivering the same event twice', async () => {
  resetEventBus();
  const raw = freshDb();
  const auditSvc = acking('audit');
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on', AUDIT: auditSvc });
  configureEventBus(env);
  await emitEvent(env.DB, OrderCreatedV1, ORDER_PAYLOAD, { aggregateId: 'ORD-1', aggregateSeq: 1 });
  await pumpOutbox(env, 'first'); // creates the row
  raw.exec(
    `UPDATE pump_lock SET locked_until = '${new Date(Date.now() + 60_000).toISOString()}', holder = 'other-isolate' WHERE name = '${CORE_SERVICE}'`
  );
  raw.exec('UPDATE core_outbox_events SET dispatched_at = NULL');
  raw.exec("UPDATE core_outbox_deliveries SET state = 'pending', next_attempt_at = '1970-01-01T00:00:00.000Z'");
  const before = auditSvc.seen.length;
  assert.equal(await pumpOutbox(env, 'second'), null, 'the lock holder is the only sweeper');
  assert.equal(auditSvc.seen.length, before);
});

// ------------------------------------------------------------------ envelopes

test('the daily user hash is a hash, is stable within a day and changes with it', async () => {
  const a = await dailyUserHash('usr_1', '2026-09-08');
  const b = await dailyUserHash('usr_1', '2026-09-08');
  const c = await dailyUserHash('usr_1', '2026-09-09');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, await dailyUserHash('usr_2', '2026-09-08'));
});

test('aggregate sequences do not collide inside one millisecond, which is what the outbox’s UNIQUE demands', () => {
  // A thousand slots per millisecond: a business batch aborting because two
  // events of one aggregate claimed the same sequence is the failure this
  // guards against, and inside an isolate it cannot happen at all.
  const seqs = Array.from({ length: 1000 }, () => nextAggregateSeq(1_700_000_000_000));
  assert.equal(new Set(seqs).size, seqs.length, 'a repeated sequence would abort the business batch it rides in');
  assert.ok(nextAggregateSeq(1_700_000_000_001) > 1_700_000_000_000 * 1000, 'later milliseconds sort after earlier ones');
});

/**
 * RETENTION. `migrations/0057_core_outbox.sql` promises acked rows are pruned
 * within 24 h and `03-EVENTS.md` §5 rule 6 requires it; the prune helper had no
 * caller anywhere in the tree, so with the bus on the shared customer database
 * would have gained a signed envelope per event and a second copy of every
 * audit body, for ever, against D1's 10 GB cap.
 */
test('pruneOutbox drops the audit body, the acked deliveries and the dispatched events past the window — and nothing else', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);
  await audit(env.DB, 'adm_1', 'wallet.credit', 'usr_1', { usd_cents: 500 });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_audit_details'), 1);

  const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
  raw.exec(`UPDATE core_outbox_events SET created_at = '${old}', dispatched_at = '${old}'`);
  raw.exec(`UPDATE core_audit_details SET created_at = '${old}'`);
  raw.prepare(
    `INSERT INTO core_outbox_deliveries (event_id, consumer, state, next_attempt_at, acked_at)
     SELECT event_id, 'analytics', 'acked', ?, ? FROM core_outbox_events`
  ).run(old, old);
  raw.prepare(
    `INSERT INTO core_outbox_deliveries (event_id, consumer, state, next_attempt_at, acked_at)
     SELECT event_id, 'ads', 'dead', ?, NULL FROM core_outbox_events`
  ).run(old);

  const first = await pruneOutbox(env);
  assert.equal(first?.audit_details, 1, 'the duplicate audit body is gone');
  assert.equal(first?.deliveries, 1, 'the acked delivery is gone');
  assert.equal(first?.events, 0, 'the event still has a dead delivery pointing at it');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM core_outbox_deliveries WHERE state = 'dead'"), 1, 'the DLQ row is NEVER pruned');

  // once the DLQ row is dealt with, the event itself goes
  raw.exec("DELETE FROM core_outbox_deliveries WHERE state = 'dead'");
  const second = await pruneOutbox(env);
  assert.equal(second?.events, 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events'), 0);
});

test('pruneOutbox keeps everything inside the replay window, and does nothing at all with the bus off', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);
  await audit(env.DB, 'adm_1', 'wallet.credit', 'usr_1', { usd_cents: 500 });
  raw.exec("UPDATE core_outbox_events SET dispatched_at = created_at");
  const fresh = await pruneOutbox(env);
  assert.deepEqual(fresh, { audit_details: 0, deliveries: 0, events: 0 }, 'a recent event is still replayable');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events'), 1);

  resetEventBus();
  const off = envFor(freshDb());
  configureEventBus(off);
  assert.equal(await pruneOutbox(off), null, 'the live Worker today: nothing to do, and no statement run');
});

// -------------------------------------------------------------------- helpers

/** Wraps a D1 handle and records the SQL of every statement prepared through it. */
function countingDb(db: D1Database): { db: D1Database; prepared: string[] } {
  const prepared: string[] = [];
  const wrapped = {
    ...db,
    prepare(sql: string) {
      prepared.push(sql);
      return db.prepare(sql);
    },
    batch: (stmts: D1PreparedStatement[]) => db.batch(stmts),
  } as unknown as D1Database;
  return { db: wrapped, prepared };
}

/** A user with a settled USD balance, which is what `availableUsdSql` reads. */
function seedFundedUser(raw: DatabaseSync, id: string, cents: number): void {
  raw.exec(`INSERT INTO users (id, email, name, role) VALUES ('${id}', '${id}@x.co', 'U', 'customer')`);
  raw.exec(
    `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
     VALUES ('wtx_seed_${id}', '${id}', 'deposit', 'USD', ${cents}, 'approved', 'seed', '', 'system', '2026-09-07T10:00:00.000Z')`
  );
}

function seedProduct(raw: DatabaseSync): void {
  raw.exec(
    `INSERT INTO products (id, slug, name, price_iqd, status, stock, stock_reserved)
     VALUES ('p1', 'p-1', 'P', 1000, 'active', 10, 0)`
  );
}

function baseTarget() {
  return { scope: 'base' as const, scope_id: '', stock: 10, reserved: 0, low_stock_threshold: null, label: 'base' };
}
