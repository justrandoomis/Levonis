/**
 * Ingest: what Audit accepts, what it refuses, and that a redelivery changes
 * nothing.
 *
 * The subscription set is not restated here — it is read out of
 * `packages/contracts/src/subscriptions.ts`, so an event added to Audit's row
 * there without a mapper fails this suite rather than being silently dropped in
 * production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUBSCRIPTIONS, CONSUMER_PII_MAX } from '@levonis/contracts/subscriptions';
import { EVENT_SCHEMAS } from '@levonis/contracts/events/index';
import { FIXTURE_SIG } from '@levonis/contracts/envelope';
import { canonicalHash } from '@levonis/contracts/canonical';
import { KeyRing } from '@levonis/platform-kit/keys';
import { auditConsumer, directEntryStatements, encodeDetail, DETAIL_MAX_CHARS } from '../src/consumer';
import { ENTRY_MAPPERS, AUDITED_EVENT_KEYS } from '../src/entries';
import { sealOnce, verifyChain } from '../src/seal';
import { queryEntries } from '../src/store';
import { auditDb, count, one, rows } from './_db';
import { fixture, producers, nextEventId } from './_events';

const AUDIT_TYPES = Object.entries(SUBSCRIPTIONS)
  .filter(([, consumers]) => (consumers as readonly string[]).includes('audit'))
  .map(([key]) => key)
  .sort();

test('the mappers are exactly Audit`s subscriptions — no more, no less', () => {
  assert.deepEqual([...AUDITED_EVENT_KEYS].sort(), AUDIT_TYPES);
  for (const key of AUDIT_TYPES) assert.ok(EVENT_SCHEMAS[key], `${key} has no schema`);
  assert.equal(CONSUMER_PII_MAX.audit, 'personal', 'Audit is one of the consumers allowed to see personal events');
});

test('every subscribed fixture becomes one entry with a non-empty action and a hashed detail', async () => {
  const { db, raw } = auditDb();
  const p = await producers(['core', 'identity', 'ledger', 'commerce', 'audit']);
  const consumer = auditConsumer({ keys: p.ring, now: () => '2026-09-08T10:00:00.000Z' });

  for (const key of AUDIT_TYPES) {
    const signed = await p.sign(fixture(key));
    const res = await consumer.deliver(db, [signed]);
    assert.deepEqual(res.results, [{ event_id: signed.event_id, result: 'acked' }], `${key} was not acked: ${JSON.stringify(res.results)}`);
    const row = one<{ action: string; target: string; detail_hash: string; source_service: string; event_type: string }>(
      raw,
      'SELECT action, target, detail_hash, source_service, event_type FROM audit_events WHERE event_id = ?',
      signed.event_id
    );
    assert.ok(row, `${key}: no row`);
    assert.ok(row!.action.length > 0, `${key}: empty action`);
    assert.equal(row!.event_type, key);
    assert.equal(row!.source_service, signed.source_service);
    assert.match(row!.detail_hash, /^[0-9a-f]{64}$/, `${key}: detail_hash`);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_events'), AUDIT_TYPES.length);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_processed_events'), AUDIT_TYPES.length);
});

test('AuditRecorded keeps the producer`s hash and reference and stores no body', async () => {
  const { db, raw } = auditDb();
  const p = await producers(['core']);
  const consumer = auditConsumer({ keys: p.ring });
  const src = fixture('AuditRecorded.v1');
  const signed = await p.sign(src);
  await consumer.deliver(db, [signed]);
  const payload = src.payload as { detail_hash: string; detail_ref: string; action: string; target: string; actor_id: string | null };
  const row = one<{ detail_hash: string; detail_ref: string; detail: string | null; action: string; actor_id: string | null }>(
    raw,
    'SELECT detail_hash, detail_ref, detail, action, actor_id FROM audit_events WHERE event_id = ?',
    signed.event_id
  );
  assert.equal(row?.detail_hash, payload.detail_hash, 'the producer`s hash is the recorded one — it is the proof of the body');
  assert.equal(row?.detail_ref, payload.detail_ref);
  assert.equal(row?.detail, null, 'the body never travels in the envelope (03-EVENTS.md §4)');
  assert.equal(row?.action, payload.action);
  assert.equal(row?.actor_id, payload.actor_id);
});

test('idempotency: the same event delivered twice is acked once and recorded once', async () => {
  const { db, raw } = auditDb();
  const p = await producers(['core']);
  const consumer = auditConsumer({ keys: p.ring });
  const signed = await p.sign(fixture('OrderCreated.v1'));

  const first = await consumer.deliver(db, [signed]);
  const second = await consumer.deliver(db, [signed]);
  const third = await consumer.deliver(db, [signed, signed]);

  assert.equal(first.results[0].result, 'acked');
  assert.equal(second.results[0].result, 'replayed');
  assert.deepEqual(
    third.results.map((r) => r.result),
    ['replayed', 'replayed'],
    'a batch that repeats an event repeats nothing in the table'
  );
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_events'), 1);

  // and the chain does not grow either
  await sealOnce(db, { chainKey: 'k', limit: 10, now: 'n' });
  await consumer.deliver(db, [signed]);
  const after = await sealOnce(db, { chainKey: 'k', limit: 10, now: 'n2' });
  assert.equal(after.sealed, 0);
  assert.equal((await verifyChain(db, { chainKey: 'k', pageSize: 10 })).checked, 1);
});

test('an envelope signed by a service that may not produce it is refused as forged and writes nothing', async () => {
  const { db, raw } = auditDb();
  const p = await producers(['core', 'ads']);
  const consumer = auditConsumer({ keys: p.ring });
  const src = fixture('RoleChanged.v1');
  // Ads signs a role change with its own key: a producer binding must not be a
  // licence to grant privileges (03-EVENTS.md §1 "Authentication").
  const forged = await p.sign({ ...src, source_service: 'ads', event_id: nextEventId() });
  const res = await consumer.deliver(db, [forged]);
  assert.equal(res.results[0].result, 'forged');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_events'), 0);
});

test('an unsigned envelope is refused unless the fixture marker is explicitly accepted (dark only)', async () => {
  const p = await producers(['core']);
  const src = { ...fixture('UserCreated.v1'), sig: FIXTURE_SIG };

  const strict = auditDb();
  const refused = await auditConsumer({ keys: p.ring }).deliver(strict.db, [src]);
  assert.equal(refused.results[0].result, 'forged');
  assert.equal(count(strict.raw, 'SELECT COUNT(*) AS n FROM audit_events'), 0);

  const dark = auditDb();
  const accepted = await auditConsumer({ keys: p.ring, acceptFixtureSig: true }).deliver(dark.db, [src]);
  assert.equal(accepted.results[0].result, 'acked');
  assert.equal(count(dark.raw, 'SELECT COUNT(*) AS n FROM audit_events'), 1);
});

test('a tampered payload is refused: the signature covers the whole envelope', async () => {
  const { db, raw } = auditDb();
  const p = await producers(['ledger']);
  const consumer = auditConsumer({ keys: p.ring });
  const signed = await p.sign(fixture('PaymentCompleted.v1'));
  const tampered = { ...signed, payload: { ...(signed.payload as Record<string, unknown>), amount: 999_999 } };
  const res = await consumer.deliver(db, [tampered]);
  assert.equal(res.results[0].result, 'forged');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_events'), 0);
});

test('an event Audit does not subscribe to is refused, not recorded — and is RETRYABLE, not poison', async () => {
  const { db, raw } = auditDb();
  const p = await producers(['core']);
  const consumer = auditConsumer({ keys: p.ring });
  const res = await consumer.deliver(db, [await p.sign(fixture('AddToCart.v1'))]);
  // "no handler for this key" is what a consumer that has not been redeployed
  // yet looks like, so it backs off instead of dead-lettering on attempt 1.
  // Nothing is recorded either way.
  assert.equal(res.results[0].result, 'retry');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_events'), 0);
});

test('an empty key ring records nothing: an entry whose producer cannot be established is not an entry', async () => {
  const { db, raw } = auditDb();
  const p = await producers(['core']);
  const signed = await p.sign(fixture('OrderCreated.v1'));
  const res = await auditConsumer({ keys: new KeyRing() }).deliver(db, [signed]);
  assert.equal(res.results[0].result, 'forged');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_events'), 0);
});

test('record(): a direct entry, idempotent by event_id, and it fills the body of an entry the bus recorded by hash', async () => {
  const { db, raw } = auditDb();
  const p = await producers(['core']);
  const eventId = nextEventId();
  const entry = {
    event_id: eventId,
    actor_id: 'usr_admin',
    action: 'wallet.credit',
    target: 'wallet:usr_1',
    detail: { usd_cents: 500, note: 'manual credit' },
    source_service: 'core',
    correlation_id: 'cid_1',
    occurred_at: '2026-09-08T10:00:00.000Z',
    recorded_at: '2026-09-08T10:00:00.000Z',
  };
  const first = await db.batch(await directEntryStatements(db, entry));
  assert.equal(Number(first[0].meta?.changes ?? 0), 1);
  const second = await db.batch(await directEntryStatements(db, entry));
  assert.equal(Number(second[0].meta?.changes ?? 0), 0, 'a repeat records nothing');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_events'), 1);

  const row = one<{ detail: string; detail_hash: string; source_service: string }>(
    raw,
    'SELECT detail, detail_hash, source_service FROM audit_events WHERE event_id = ?',
    eventId
  );
  assert.deepEqual(JSON.parse(row!.detail), entry.detail);
  assert.equal(row!.detail_hash, await canonicalHash(entry.detail));

  // the same id arriving as an AuditRecorded envelope first, body second
  const { db: db2, raw: raw2 } = auditDb();
  const envelope = await p.sign({ ...fixture('AuditRecorded.v1'), event_id: eventId });
  await auditConsumer({ keys: p.ring }).deliver(db2, [envelope]);
  assert.equal(one<{ detail: string | null }>(raw2, 'SELECT detail FROM audit_events WHERE event_id = ?', eventId)?.detail, null);
  await db2.batch(await directEntryStatements(db2, entry));
  assert.deepEqual(JSON.parse(one<{ detail: string }>(raw2, 'SELECT detail FROM audit_events WHERE event_id = ?', eventId)!.detail), entry.detail);
  assert.equal(count(raw2, 'SELECT COUNT(*) AS n FROM audit_events'), 1, 'still one entry — the body filled the row the event created');
});

test('a detail body is bounded exactly as the audit() facade bounds it', () => {
  assert.equal(encodeDetail(null), null);
  const huge = encodeDetail({ blob: 'x'.repeat(10_000) });
  assert.equal(huge?.length, DETAIL_MAX_CHARS);
});

test('the query read model: newest first, keyset-paged, filtered on the indexed columns', async () => {
  const { db } = auditDb();
  const p = await producers(['core', 'identity', 'ledger', 'commerce', 'audit']);
  const consumer = auditConsumer({ keys: p.ring });
  for (const key of AUDIT_TYPES) await consumer.deliver(db, [await p.sign(fixture(key))]);

  const first = await queryEntries(db, { limit: 3, cursor: null });
  assert.equal(first.rows.length, 3);
  assert.ok(first.next, 'a full page carries a cursor');
  assert.ok(first.rows[0].seq > first.rows[1].seq, 'newest first');

  const second = await queryEntries(db, { limit: 3, cursor: Number(first.next) });
  assert.ok(second.rows.every((r) => r.seq < first.rows[2].seq), 'the next page continues below the cursor');
  const seen = new Set([...first.rows, ...second.rows].map((r) => r.seq));
  assert.equal(seen.size, first.rows.length + second.rows.length, 'no row appears on two pages');

  const byAction = await queryEntries(db, { action: 'user.role_changed', limit: 50, cursor: null });
  assert.equal(byAction.rows.length, 1);
  assert.equal(byAction.rows[0].action, 'user.role_changed');
  assert.equal(byAction.next, null);

  const roleRow = byAction.rows[0];
  const byActor = await queryEntries(db, { actor_id: roleRow.actor_id!, limit: 50, cursor: null });
  assert.ok(byActor.rows.some((r) => r.seq === roleRow.seq));

  const none = await queryEntries(db, { from: '2099-01-01T00:00:00.000Z', limit: 50, cursor: null });
  assert.deepEqual(none.rows, []);
});

test('the mappers put the ADMIN in actor_id for a role change, not the subject', () => {
  const src = fixture('RoleChanged.v1');
  const draft = ENTRY_MAPPERS['RoleChanged.v1'](src);
  const payload = src.payload as { user_id: string; actor_id: string };
  assert.equal(draft.actor_id, payload.actor_id);
  assert.equal(draft.target, `user:${payload.user_id}`);
  assert.notEqual(payload.actor_id, payload.user_id, 'the fixture must not make this test vacuous');
});

test('every recorded row is chained, and the chain covers what the log claims', async () => {
  const { db, raw } = auditDb();
  const p = await producers(['core', 'identity', 'ledger', 'commerce', 'audit']);
  const consumer = auditConsumer({ keys: p.ring });
  for (const key of AUDIT_TYPES) await consumer.deliver(db, [await p.sign(fixture(key))]);
  const sealed = await sealOnce(db, { chainKey: 'k', limit: 100, now: 'n' });
  assert.equal(sealed.sealed, AUDIT_TYPES.length);
  assert.equal(rows(raw, 'SELECT seq FROM audit_events WHERE chain_index IS NULL').length, 0);
  assert.equal((await verifyChain(db, { chainKey: 'k', pageSize: 4 })).ok, true);
});
