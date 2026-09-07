import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineConsumer } from '../src/consumer';
import { processedEventsSchemaSql } from '../src/idempotency';
import { signEnvelope } from '../src/eventSig';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { memoryDb, count } from './_sqlite';
import { ringOf, testIdentity } from './_keys';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'src', 'events', 'fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.v1.json`), 'utf8')) as EventEnvelope;

async function analyticsConsumer(extra: Partial<Parameters<typeof defineConsumer>[0]> = {}) {
  const commerce = await testIdentity('commerce');
  const ring = await ringOf(commerce);
  const { db, raw } = memoryDb(processedEventsSchemaSql('analytics') + 'CREATE TABLE analytics_events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL);');
  const rejected: string[] = [];
  const consumer = defineConsumer({
    name: 'analytics', piiMax: 'pseudonymous', keys: ring,
    handlers: {
      'OrderCreated.v1': async (env, ctx) => [ctx.db.prepare('INSERT INTO analytics_events (event_id, type, payload) VALUES (?, ?, ?)').bind(env.event_id, env.event_type, JSON.stringify(env.payload))],
      'DepositDecided.v1': async () => [],
    },
    onRejected: (_e, reason) => void rejected.push(reason),
    ...extra,
  });
  const sign = async (env: EventEnvelope) => {
    const { sig: _s, ...unsigned } = env;
    return signEnvelope(commerce.key, unsigned);
  };
  return { consumer, db, raw, sign, rejected, commerce };
}

test('the idempotency guard blocks a duplicate event_id: the side effect runs once, the replay is acked as replayed', async () => {
  const { consumer, db, raw, sign } = await analyticsConsumer();
  const env = await sign(fixture('OrderCreated'));
  const first = await consumer.deliver(db, [env]);
  assert.deepEqual(first.results, [{ event_id: env.event_id, result: 'acked' }]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM analytics_events'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM analytics_processed_events'), 1);
  const second = await consumer.deliver(db, [env, env]);
  assert.deepEqual(second.results.map((r) => r.result), ['replayed', 'replayed']);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM analytics_events'), 1, 'no second side effect');
  // the processed_events row rides in the same batch as the side effect: a PK race is also a replay
  raw.prepare('DELETE FROM analytics_events').run();
  const raced = await consumer.deliver(db, [env]);
  assert.equal(raced.results[0].result, 'replayed');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM analytics_events'), 0, 'the batch was rejected as a whole');
});

test('unsigned, wrong-producer, above-PII-class and schema-invalid envelopes are refused before any state is touched', async () => {
  const { consumer, db, raw, sign, rejected } = await analyticsConsumer();
  const good = fixture('OrderCreated');
  // the fixture marker is not accepted unless the consumer opts in (dark/test)
  const unsigned = await consumer.deliver(db, [good]);
  assert.equal(unsigned.results[0].result, 'forged');
  // a signature by a producer not allowed for the type
  const reviews = await testIdentity('reviews');
  const ring = await ringOf(reviews);
  const { sig: _s, ...u } = good;
  const forgedEnv = await signEnvelope(reviews.key, { ...u, source_service: 'reviews' });
  const forgedConsumer = defineConsumer({ name: 'analytics', piiMax: 'pseudonymous', keys: ring, handlers: { 'OrderCreated.v1': async () => [] } });
  assert.equal((await forgedConsumer.deliver(db, [forgedEnv])).results[0].result, 'forged');
  // personal to a pseudonymous consumer
  const personal = await sign({ ...fixture('DepositDecided'), source_service: 'commerce' });
  assert.equal((await consumer.deliver(db, [personal])).results[0].result, 'forged', 'commerce is not a DepositDecided producer');
  const ledgerish = await analyticsConsumer();
  const ledger = await testIdentity('ledger');
  const ring2 = await ringOf(ledger);
  const { sig: _s2, ...dep } = fixture('DepositDecided');
  const signedPersonal = await signEnvelope(ledger.key, dep);
  const c2 = defineConsumer({ name: 'analytics', piiMax: 'pseudonymous', keys: ring2, handlers: { 'DepositDecided.v1': async () => [] } });
  assert.equal((await c2.deliver(ledgerish.db, [signedPersonal])).results[0].result, 'pii_refused');
  // schema-invalid payload (an extra key is refused: allowlist, never a whole row)
  const bad = await sign({ ...good, payload: { ...(good.payload as Record<string, unknown>), admin_note: 'secret' } });
  const r = await consumer.deliver(db, [bad]);
  assert.equal(r.results[0].result, 'invalid');
  assert.match(r.results[0].error ?? '', /admin_note/);
  // a type this consumer does not accept
  const other = await sign({ ...good, event_type: 'RefundCompleted' } as EventEnvelope);
  assert.equal((await consumer.deliver(db, [other])).results[0].result, 'invalid');
  // a malformed envelope
  assert.equal((await consumer.deliver(db, [{ event_id: 'x' } as never])).results[0].result, 'invalid');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM analytics_events'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM analytics_processed_events'), 0);
  assert.ok(rejected.includes('invalid') && rejected.includes('forged') && rejected.includes('unknown_type'));
});

test('a handler that throws or asks for a retry yields retry (transient) and leaves no processed row; batches above 50 are refused', async () => {
  const { db, raw, sign } = await analyticsConsumer();
  const commerce = await testIdentity('commerce');
  const ring = await ringOf(commerce);
  let calls = 0;
  const flaky = defineConsumer({
    name: 'analytics', piiMax: 'pseudonymous', keys: ring, acceptFixtureSig: true,
    handlers: { 'OrderCreated.v1': async () => (++calls === 1 ? { retry: true, error: 'db busy' } : []) },
  });
  const env = fixture('OrderCreated');
  void sign;
  assert.equal((await flaky.deliver(db, [env])).results[0].result, 'retry');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM analytics_processed_events'), 0);
  assert.equal((await flaky.deliver(db, [env])).results[0].result, 'acked');
  await assert.rejects(() => flaky.deliver(db, new Array(51).fill(env)), RangeError);
});
