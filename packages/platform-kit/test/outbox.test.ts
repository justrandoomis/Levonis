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
  // the UNIQUE (aggregate, seq) and event_id constraints hold
  const dup = new Uow(db, { enabled: 'on', prefix: 'core', probe });
  await dup.publish(env);
  await assert.rejects(() => dup.commit(), /UNIQUE/);
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
