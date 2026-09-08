/**
 * The PII projection — the property this service exists to keep
 * (`01-TARGET.md` §9.2: "every field annotated `pii` is dropped at ingest").
 *
 * The check is driven by the CATALOGUE, not by a list written here: for every
 * event Analytics subscribes to, every field the schema annotates `pii` must be
 * absent from what is stored, and the person-scoped envelope ids must be
 * hashed. A new annotation in `packages/contracts` is therefore enforced by
 * this suite the moment it lands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUBSCRIPTIONS, CONSUMER_PII_MAX } from '@levonis/contracts/subscriptions';
import { EVENT_SCHEMAS } from '@levonis/contracts/events/index';
import { eventKeyOf } from '@levonis/contracts/envelope';
import { sha256Hex } from '@levonis/contracts/canonical';
import { dropPii, project, actorHash, dayOf, piiFieldsOf, PERSON_AGGREGATES } from '../src/projection';
import { metricsOf, METRIC_EVENT_KEYS } from '../src/metrics';
import { analyticsConsumer } from '../src/consumer';
import { analyticsDb, rows } from './_db';
import { fixture, producers } from './_events';

const ANALYTICS_TYPES = Object.entries(SUBSCRIPTIONS)
  .filter(([, consumers]) => (consumers as readonly string[]).includes('analytics'))
  .map(([key]) => key)
  .sort();

const SALT = 'test-salt-not-a-real-secret';

test('the mappers are exactly Analytics subscriptions, and none of them is a personal event', () => {
  assert.deepEqual([...METRIC_EVENT_KEYS].sort(), ANALYTICS_TYPES);
  assert.equal(CONSUMER_PII_MAX.analytics, 'pseudonymous');
  for (const key of ANALYTICS_TYPES) {
    assert.ok(EVENT_SCHEMAS[key], `${key} has no schema`);
    assert.notEqual(EVENT_SCHEMAS[key].pii_class, 'personal', `${key} is personal and must never reach Analytics`);
  }
});

test('every annotated field is dropped from every subscribed fixture, and nothing else is', () => {
  let droppedSomething = 0;
  for (const key of ANALYTICS_TYPES) {
    const payload = fixture(key).payload as Record<string, unknown>;
    const projected = dropPii(key, payload);
    const annotated = piiFieldsOf(key);
    for (const field of annotated) {
      assert.ok(field in payload, `${key}: the fixture must carry ${field} or this assertion is vacuous`);
      assert.ok(!(field in projected), `${key}: ${field} is annotated pii and survived the projection`);
      droppedSomething += 1;
    }
    for (const field of Object.keys(payload)) {
      if (annotated.includes(field)) continue;
      assert.deepEqual(projected[field], payload[field], `${key}: ${field} was dropped but is not annotated`);
    }
  }
  assert.ok(droppedSomething >= 8, `the catalogue should have annotated fields to drop, saw ${droppedSomething}`);
});

test('no raw person id survives ingest: neither in the payload nor as the aggregate id', async () => {
  const { db, raw } = analyticsDb();
  const p = await producers();
  const consumer = analyticsConsumer({ keys: p.ring, salt: SALT, now: () => '2026-09-08T12:00:00.000Z' });

  // Raw identifiers only. A 64-hex value is already a pseudonym — the
  // producer's daily-salted `user_hash`, which the catalogue deliberately keeps
  // on some events (`OrderCreated`) and annotates on others (`AddToCart`); it
  // is not a person's id and is not what this test is about.
  const isRawId = (v: unknown): v is string => typeof v === 'string' && v.length > 3 && !/^[0-9a-f]{64}$/.test(v);
  const personIds = new Set<string>();
  for (const key of ANALYTICS_TYPES) {
    const src = fixture(key);
    for (const field of piiFieldsOf(key)) {
      const value = (src.payload as Record<string, unknown>)[field];
      if (isRawId(value)) personIds.add(value);
    }
    if (PERSON_AGGREGATES.has(src.aggregate_type) && isRawId(src.aggregate_id)) personIds.add(src.aggregate_id);
    if (isRawId(src.actor_id)) personIds.add(src.actor_id);
    const res = await consumer.deliver(db, [await p.sign(src)]);
    assert.equal(res.results[0].result, 'acked', `${key}: ${JSON.stringify(res.results)}`);
  }
  assert.ok(personIds.size >= 3, `the fixtures must actually carry raw person ids, saw ${personIds.size}`);

  // The whole store, as text. Nothing a person is named by may appear in it.
  const stored = JSON.stringify(rows(raw, 'SELECT * FROM analytics_events'));
  for (const id of personIds) {
    assert.equal(stored.includes(id), false, `a raw person id (${id}) reached the analytics store`);
  }
});

test('the actor is a per-day salted hash, and the same person hashes differently tomorrow', async () => {
  const a = await actorHash('usr_1', '2026-09-08', SALT);
  const b = await actorHash('usr_1', '2026-09-09', SALT);
  const c = await actorHash('usr_1', '2026-09-08', 'another-salt');
  const d = await actorHash('usr_2', '2026-09-08', SALT);
  assert.equal(a, await sha256Hex(`2026-09-08:${SALT}:usr_1`));
  assert.notEqual(a, b, 'a daily salt is what stops a person being followed across days');
  assert.notEqual(a, c, 'the secret is what stops the hash being re-derived from a list of user ids');
  assert.notEqual(a, d);
  assert.equal(await actorHash(null, '2026-09-08', SALT), null);
});

test('the day is the envelope`s UTC day, and a malformed clock falls back rather than poisoning the index', () => {
  assert.equal(dayOf('2026-09-08T23:59:59.999Z', '2026-01-01T00:00:00.000Z'), '2026-09-08');
  assert.equal(dayOf('not a date', '2026-01-01T00:00:00.000Z'), '2026-01-01');
});

test('the counters are computable from the projection alone — no metric depends on a dropped field', async () => {
  for (const key of ANALYTICS_TYPES) {
    const src = fixture(key);
    const payload = src.payload as Record<string, unknown>;
    assert.deepEqual(
      metricsOf(key, dropPii(key, payload)),
      metricsOf(key, payload),
      `${key}: a metric reads a field the projection drops — it would be right in a test and wrong in production`
    );
  }
});

test('the stored projection is the projection: payload, hashed actor, lifted merchant id', async () => {
  const src = fixture('OrderCreated.v1');
  const projected = await project(src, { salt: SALT, now: '2026-09-08T00:00:00.000Z' });
  const payload = src.payload as Record<string, unknown>;
  assert.equal(eventKeyOf(src), 'OrderCreated.v1');
  assert.equal('user_id' in projected.payload, false);
  assert.equal(projected.payload.user_hash, payload.user_hash, 'the pseudonym the producer supplied is kept — that is what it is for');
  assert.equal(projected.merchant_id, payload.merchant_id ?? null);
  assert.equal(projected.aggregate_id, src.aggregate_id, 'an order is not a person: its id is stored as it is');
  assert.equal(projected.actor_hash, await actorHash(src.actor_id, projected.day, SALT));
});
