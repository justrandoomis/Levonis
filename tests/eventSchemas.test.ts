/**
 * Event contracts (`03-EVENTS.md`, `02-MIGRATION-PLAN.md` 1.3): every schema has
 * a fixture that validates and round-trips through JSON and through a real
 * signature; every consumer in `subscriptions.ts` is listed for an event that
 * has a schema; every event type has a `producers` entry; no `personal` event
 * lists Analytics/Ads/Search/Farm; every `best_effort` event is
 * none/pseudonymous; identifier fields are `pii` unless the event is `none`
 * and its consumers exclude Analytics and Ads; and — once services exist — a
 * producer's wrangler binds every subscriber of what it publishes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_SCHEMAS } from '@levonis/contracts/events/index';
import { SUBSCRIPTIONS, PRODUCERS, CONSUMER_PII_MAX, SERVICE_NAMES, ANY_PRODUCER, mayConsume } from '@levonis/contracts/subscriptions';
import { validateEnvelope, unsigned, type EventEnvelope } from '@levonis/contracts/envelope';
import { signEnvelope, verifyEnvelope } from '@levonis/platform-kit/eventSig';
import { generateKeyPair, importSigningKey, KeyRing } from '@levonis/platform-kit/keys';
import { listServices, readManifest } from './lib/boundaries';
import { parseJsonc, type WranglerLike } from './lib/wrangler';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'packages', 'contracts', 'src', 'events', 'fixtures');

/** Fields that name a person (`03-EVENTS.md` §1 rule). `merchant_id` is a store, kept for Analytics' merchant rollups (§9.2) — see the OrderCreated schema. */
const PERSON_ID_FIELDS = /^(user_id|buyer_id|referee_id|referrer_id|actor_id|decided_by|owner_id|sender_id|recipient_id)$/;
const PSEUDONYMOUS_ONLY = new Set(['analytics', 'ads', 'search', 'farm']);

test('every schema has exactly one fixture; every fixture validates, round-trips through JSON and through a real signature', async () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, Object.keys(EVENT_SCHEMAS).sort().map((k) => `${k}.json`));
  const keys = new Map<string, Awaited<ReturnType<typeof importSigningKey>>>();
  const ring = new KeyRing();
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as EventEnvelope;
    validateEnvelope(raw);
    const key = `${raw.event_type}.v${raw.version}`;
    assert.equal(`${key}.json`, f, 'the file is named after its event key');
    const schema = EVENT_SCHEMAS[key];
    assert.ok(schema, `${f}: no schema`);
    schema.parse(raw.payload);
    assert.equal(raw.aggregate_type, schema.aggregate_type);
    assert.equal(raw.pii_class, schema.pii_class);
    assert.equal(raw.delivery, schema.delivery);
    assert.ok(PRODUCERS[key]?.includes(raw.source_service) || PRODUCERS[key]?.includes(ANY_PRODUCER), `${f}: source ${raw.source_service} is not a producer`);
    // JSON round trip is lossless
    assert.deepEqual(JSON.parse(JSON.stringify(raw)), raw);
    // sign with a throwaway producer key and verify like a consumer would
    if (!keys.has(raw.source_service)) {
      const m = await generateKeyPair();
      keys.set(raw.source_service, await importSigningKey(m.privateKeyB64, m.publicKeyB64));
      await ring.add(raw.source_service, m.publicKeyB64);
    }
    const signed = await signEnvelope(keys.get(raw.source_service)!, unsigned(raw));
    validateEnvelope(signed);
    const v = await verifyEnvelope(JSON.parse(JSON.stringify(signed)) as EventEnvelope, ring, { eventKey: key });
    assert.ok(v.ok, `${f}: ${JSON.stringify(v)}`);
    // an extra payload key is refused: an allowlist, never a whole row
    assert.ok(!schema.is({ ...(raw.payload as Record<string, unknown>), password_hash: 'x' }), `${f}: extra keys are refused`);
  }
});

/**
 * THE PAYMENT ENUM, EXERCISED ON EVERY SCHEMA THAT CARRIES ONE.
 *
 * `oneOf(...)` refuses a value it was not given, which is the safety the
 * catalogue wants and also the trap: a new checkout id that never reaches this
 * enum does not fail loudly, it is swallowed by the producer's fallback —
 * `eventPaymentMethod` answered 'wallet' for anything it did not recognise, so
 * 'gini', a method whose money never touches a Levo wallet at all, would have
 * been published to Analytics as a wallet purchase.
 *
 * WHY THIS IS A DERIVED PAYLOAD RATHER THAN A SECOND FIXTURE FILE. The first
 * test above asserts EXACTLY ONE fixture per schema — `deepEqual(files, …)` —
 * and a `CheckoutStarted.v1.gini.json` beside the existing one would fail it.
 * So each real fixture is re-read and its payment field swapped, which also
 * keeps the rest of the payload honest: it is the shipped fixture, not a
 * hand-written shape that could drift from it.
 */
test('every checkout payment id the server can emit validates, including gini', () => {
  const swap: Record<string, (p: Record<string, unknown>, id: string) => Record<string, unknown>> = {
    'CheckoutStarted.v1': (p, id) => ({ ...p, payment_method: id }),
    'OrderDelivered.v1': (p, id) => ({ ...p, payment_method: id }),
    'OrderCreated.v1': (p, id) => ({ ...p, payment: { ...(p.payment as Record<string, unknown>), method: id } }),
  };
  for (const [key, apply] of Object.entries(swap)) {
    const schema = EVENT_SCHEMAS[key];
    assert.ok(schema, `${key}: no schema`);
    const raw = JSON.parse(readFileSync(join(FIXTURES, `${key}.json`), 'utf8')) as EventEnvelope;
    for (const id of ['wallet', 'cash', 'bnpl', 'gini']) {
      schema.parse(apply(raw.payload as Record<string, unknown>, id));
    }
    // And the enum is still an allowlist, not a free string.
    assert.throws(() => schema.parse(apply(raw.payload as Record<string, unknown>, 'qi_card')), `${key}: an unknown id must be refused`);
  }
});

test('subscriptions and producers are consistent with the schema registry', () => {
  for (const [key, consumers] of Object.entries(SUBSCRIPTIONS)) {
    assert.ok(EVENT_SCHEMAS[key], `${key} has consumers but no schema`);
    assert.ok(PRODUCERS[key], `${key} has no producers entry`);
    assert.ok(consumers.length > 0, `${key} lists no consumer`);
    assert.equal(new Set(consumers).size, consumers.length, `${key} lists a consumer twice`);
    for (const c of consumers) assert.ok((SERVICE_NAMES as readonly string[]).includes(c), `${key}: ${c} is not a service`);
  }
  for (const key of Object.keys(EVENT_SCHEMAS)) {
    assert.ok(PRODUCERS[key], `${key} has no producers entry (03-EVENTS.md §1: every event type names its producers)`);
    assert.ok(SUBSCRIPTIONS[key], `${key} has a schema but no subscribers`);
    for (const p of PRODUCERS[key]) assert.ok(p === ANY_PRODUCER || (SERVICE_NAMES as readonly string[]).includes(p), `${key}: producer ${p} is not a service`);
  }
  for (const key of Object.keys(PRODUCERS)) assert.ok(EVENT_SCHEMAS[key], `${key} has producers but no schema`);
});

test('PII rules over the catalogue: personal never to Analytics/Ads/Search/Farm; best_effort is never personal; person ids are pii unless none and unread by Analytics/Ads', () => {
  for (const [key, schema] of Object.entries(EVENT_SCHEMAS)) {
    const consumers = SUBSCRIPTIONS[key] ?? [];
    if (schema.pii_class === 'personal') {
      for (const c of consumers) assert.ok(!PSEUDONYMOUS_ONLY.has(c), `${key} is personal but lists ${c}`);
    }
    for (const c of consumers) assert.ok(mayConsume(c, schema.pii_class), `${key}: ${c} cannot receive ${schema.pii_class}`);
    if (schema.delivery === 'best_effort') assert.notEqual(schema.pii_class, 'personal', `${key}: best_effort telemetry is never personal`);
    const analyticsOrAds = consumers.some((c) => c === 'analytics' || c === 'ads');
    for (const field of schema.fields) {
      if (!PERSON_ID_FIELDS.test(field)) continue;
      const exempt = schema.pii_class === 'none' && !analyticsOrAds;
      if (!exempt) assert.ok(schema.pii.includes(field), `${key}: ${field} names a person and must be annotated pii`);
    }
    for (const f of schema.pii) assert.ok(schema.fields.includes(f), `${key}: pii field ${f} is not a payload field`);
  }
  for (const c of PSEUDONYMOUS_ONLY) assert.equal(CONSUMER_PII_MAX[c as keyof typeof CONSUMER_PII_MAX], 'pseudonymous');
});

test('a producer service binds every subscriber of the events it publishes (rpc mode) — applies once services exist; the core binds at G2', () => {
  for (const svc of listServices(ROOT)) {
    const dir = join(ROOT, 'services', svc);
    const m = readManifest(dir);
    const wranglerPath = join(dir, 'wrangler.jsonc');
    if (!m || !existsSync(wranglerPath)) continue;
    const cfg = parseJsonc(readFileSync(wranglerPath, 'utf8')) as WranglerLike;
    const bindings = new Set<string>();
    for (const block of [cfg, ...Object.values(cfg.env ?? {})]) for (const s of block.services ?? []) bindings.add(s.binding.toLowerCase());
    const queues = new Set<string>();
    for (const block of [cfg, ...Object.values(cfg.env ?? {})]) {
      const q = (block as { queues?: { producers?: Array<{ binding: string }> } }).queues?.producers ?? [];
      for (const p of q) queues.add(p.binding.replace(/^Q_/, '').toLowerCase());
    }
    for (const type of m.publishes ?? []) {
      const key = type.includes('.v') ? type : `${type}.v1`;
      assert.ok(EVENT_SCHEMAS[key], `services/${svc} publishes ${type} which has no schema`);
      assert.ok(PRODUCERS[key]?.includes(m.service ?? svc) || PRODUCERS[key]?.includes(ANY_PRODUCER), `services/${svc} is not a listed producer of ${type}`);
      for (const consumer of SUBSCRIPTIONS[key] ?? []) {
        if (consumer === (m.service ?? svc)) continue;
        assert.ok(bindings.has(consumer) || queues.has(consumer), `services/${svc} publishes ${type} but binds no ${consumer.toUpperCase()} (services or Q_${consumer.toUpperCase()})`);
      }
    }
    for (const type of m.consumes ?? []) {
      const key = type.includes('.v') ? type : `${type}.v1`;
      assert.ok(EVENT_SCHEMAS[key], `services/${svc} consumes ${type} which has no schema`);
      assert.ok(SUBSCRIPTIONS[key]?.includes((m.service ?? svc) as never), `services/${svc} consumes ${type} but subscriptions.ts does not list it`);
    }
  }
});
