import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishStatement, outboxSchemaSql, OutboxProbe, Uow, busEnabled } from '../src/outbox';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { memoryDb, count } from './_sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'src', 'events', 'fixtures');
const env = JSON.parse(readFileSync(join(FIXTURES, 'OrderCreated.v1.json'), 'utf8')) as EventEnvelope;

test('publishStatement is a no-op while EVENT_BUS_ENABLED is off or the outbox table is absent — the business batch is identical to today', async () => {
  const { db, raw } = memoryDb('CREATE TABLE orders (id TEXT PRIMARY KEY);');
  assert.equal(await publishStatement(db, env, { enabled: 'off', prefix: 'core', probe: new OutboxProbe() }), null);
  assert.equal(await publishStatement(db, env, { enabled: undefined, prefix: 'core', probe: new OutboxProbe() }), null);
  assert.equal(await publishStatement(db, env, { enabled: 'on', prefix: 'core', probe: new OutboxProbe() }), null, 'var on, table absent: still nothing appended');
  assert.ok(!busEnabled('ON'), 'only the exact value on enables');
  // a checkout-like batch runs unchanged
  const uow = new Uow(db, { enabled: 'on', prefix: 'core', probe: new OutboxProbe() });
  uow.add(db.prepare("INSERT INTO orders (id) VALUES ('ord_01')"));
  await uow.publish(env);
  assert.equal(uow.size, 1, 'no outbox statement was added');
  await uow.commit();
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1);
  assert.deepEqual(uow.eventIds, []);
});

test('once the table exists and the var is on, the outbox row rides in the same batch; the probe result is cached per isolate', async () => {
  const { db, raw } = memoryDb('CREATE TABLE orders (id TEXT PRIMARY KEY);');
  const probe = new OutboxProbe();
  assert.equal(await publishStatement(db, env, { enabled: 'on', prefix: 'core', probe }), null);
  raw.exec(outboxSchemaSql('core'));
  assert.equal(await publishStatement(db, env, { enabled: 'on', prefix: 'core', probe }), null, 'the negative answer is cached until the isolate restarts');
  probe.reset();
  const stmt = await publishStatement(db, env, { enabled: 'on', prefix: 'core', probe });
  assert.ok(stmt);
  const uow = new Uow(db, { enabled: 'on', prefix: 'core', probe });
  uow.declarePublishes('OrderCreated');
  uow.add(db.prepare("INSERT INTO orders (id) VALUES ('ord_02')"));
  await uow.publish(env);
  await uow.commit();
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events'), 1);
  assert.deepEqual(uow.eventIds, [env.event_id]);
  // A RE-PUBLISH IS A NO-OP, NOT A ROLLBACK. The two UNIQUEs still hold — the
  // table gains no second row — but `ON CONFLICT DO NOTHING` means the
  // COMMAND'S OWN BATCH survives. `aggregate_seq` is minted per isolate, so a
  // collision between two isolates is possible, and the outbox statement rides
  // inside the caller's business batch: without this an event could be the
  // reason an order fails to be placed.
  const dup = new Uow(db, { enabled: 'on', prefix: 'core', probe });
  dup.add(db.prepare("INSERT INTO orders (id) VALUES ('ord_02b')"));
  await dup.publish(env);
  await dup.commit();
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events'), 1, 'still exactly one event row');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE id = 'ord_02b'"), 1, 'and the business write committed');
});

test('a colliding aggregate_seq loses the EVENT, never the business batch it rides in', async () => {
  const { db, raw } = memoryDb('CREATE TABLE orders (id TEXT PRIMARY KEY);' + outboxSchemaSql('core'));
  const probe = new OutboxProbe();
  const first = env;
  const uow = new Uow(db, { enabled: 'on', prefix: 'core', probe });
  uow.add(db.prepare("INSERT INTO orders (id) VALUES ('ord_c1')"));
  await uow.publish(first);
  await uow.commit();

  // A DIFFERENT event (its own event_id) that another isolate numbered onto the
  // same (aggregate_type, aggregate_id, aggregate_seq).
  const clash = { ...first, event_id: `${first.event_id}-other` };
  const second = new Uow(db, { enabled: 'on', prefix: 'core', probe });
  second.add(db.prepare("INSERT INTO orders (id) VALUES ('ord_c2')"));
  await second.publish(clash);
  await second.commit();

  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE id = 'ord_c2'"), 1, 'the order was placed');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events'), 1, 'the colliding event was dropped, not the order');
});

test('Uow refuses to commit a command declared as publishing without its outbox statement (bus enabled), and passes when the bus is off', async () => {
  const { db } = memoryDb('CREATE TABLE orders (id TEXT PRIMARY KEY);' + outboxSchemaSql('core'));
  const strict = new Uow(db, { enabled: 'on', prefix: 'core', probe: new OutboxProbe() });
  strict.declarePublishes('OrderCreated');
  strict.add(db.prepare("INSERT INTO orders (id) VALUES ('ord_03')"));
  await assert.rejects(() => strict.commit(), /declared it publishes OrderCreated/);
  const off = new Uow(db, { enabled: 'off', prefix: 'core', probe: new OutboxProbe() });
  off.declarePublishes('OrderCreated');
  off.add(db.prepare("INSERT INTO orders (id) VALUES ('ord_04')"));
  await off.commit();
  assert.equal((await new Uow(db, { enabled: 'off', prefix: 'core' }).commit()).length, 0);
});
