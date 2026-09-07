import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvelope, isEnvelope, eventKey, eventKeyOf, unsigned, FIXTURE_SIG } from '../src/envelope';
import { OrderCreatedV1 } from '../src/events/v1/OrderCreated';
import { EVENT_SCHEMAS, schemaFor } from '../src/events/index';
import { SUBSCRIPTIONS, PRODUCERS, isAllowedProducer, mayConsume, deliverableSubscribers, subscribersOf } from '../src/subscriptions';
import { ownerOfTable, baseTableName, platformTableOwner } from '../src/ownership';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'events', 'fixtures');
const fixture = JSON.parse(readFileSync(join(FIXTURES, 'OrderCreated.v1.json'), 'utf8')) as Record<string, unknown>;

test('envelope validation accepts the fixture and rejects bad payloads, foreign keys, bad ids and malformed signatures', () => {
  validateEnvelope(fixture);
  assert.ok(isEnvelope(fixture));
  const bad = (patch: Record<string, unknown>, re: RegExp) => {
    assert.throws(() => validateEnvelope({ ...fixture, ...patch }), re);
  };
  bad({ event_id: 'not-a-uuid' }, /event_id: must be a UUIDv7/);
  bad({ event_type: 'order created' }, /PascalCase/);
  bad({ version: 0 }, /version starts at 1/);
  bad({ created_at: 'today' }, /ISO 8601/);
  bad({ source_service: 'Commerce!' }, /lowercase service name/);
  bad({ pii_class: 'secret' }, /pii_class: must be one of/);
  bad({ delivery: 'sometime' }, /delivery: must be one of/);
  bad({ payload: 'not an object' }, /payload must be an object/);
  bad({ payload: null }, /payload must be an object/);
  bad({ sig: 'nope' }, /malformed signature/);
  bad({ extra: true }, /extra: is not part of the contract/);
  const { aggregate_seq: _s, ...missing } = fixture;
  assert.throws(() => validateEnvelope(missing), /aggregate_seq: is required/);
  assert.equal(isEnvelope(undefined), false);
  assert.equal(eventKey('OrderCreated', 1), 'OrderCreated.v1');
  assert.equal(eventKeyOf(fixture as never), 'OrderCreated.v1');
  assert.ok(!('sig' in unsigned(fixture as never)));
  assert.equal(fixture.sig, FIXTURE_SIG);
});

test('payload schemas are allowlists with pii annotations; the registry resolves by type and version', () => {
  const payload = fixture.payload as Record<string, unknown>;
  assert.ok(OrderCreatedV1.is(payload));
  assert.ok(!OrderCreatedV1.is({ ...payload, commission_percent_x100: 500 }), 'internal commission must not leak');
  assert.ok(!OrderCreatedV1.is({ ...payload, admin_note: 'x' }));
  assert.ok(!OrderCreatedV1.is({ ...payload, address_snapshot: { street: 'x' } }), 'address by reference only');
  assert.ok(!OrderCreatedV1.is({ ...payload, items: [{ ...(payload.items as object[])[0], warranty_snapshot: {} }] }));
  assert.deepEqual([...OrderCreatedV1.pii], ['user_id']);
  assert.equal(OrderCreatedV1.key, 'OrderCreated.v1');
  assert.equal(OrderCreatedV1.aggregate_type, 'order');
  assert.equal(OrderCreatedV1.delivery, 'transactional');
  assert.equal(schemaFor('OrderCreated'), OrderCreatedV1);
  assert.equal(schemaFor('OrderCreated', 2), null);
  assert.equal(schemaFor('Nope'), null);
  assert.equal(Object.keys(EVENT_SCHEMAS).length, 28);
  for (const [key, s] of Object.entries(EVENT_SCHEMAS)) {
    assert.equal(key, s.key);
    for (const f of s.pii) assert.ok(s.fields.includes(f), `${key}: pii field ${f} exists`);
  }
  // envelope() validates the payload before building
  assert.throws(() => OrderCreatedV1.envelope({ event_id: 'x', created_at: 'y', source_service: 'commerce', correlation_id: 'c', causation_id: null, actor_id: null, aggregate_id: 'o', aggregate_seq: 1, payload: {} as never }), /is required/);
});

test('subscriptions: producers allowlist with the audit wildcard; PII gate per consumer', () => {
  assert.ok(isAllowedProducer('OrderCreated.v1', 'commerce') && isAllowedProducer('OrderCreated.v1', 'core'));
  assert.ok(!isAllowedProducer('OrderCreated.v1', 'reviews'));
  assert.ok(isAllowedProducer('AuditRecorded.v1', 'anything'));
  assert.ok(!isAllowedProducer('Unknown.v1', 'core'));
  assert.ok(mayConsume('analytics', 'pseudonymous') && !mayConsume('analytics', 'personal') && mayConsume('audit', 'personal'));
  assert.ok(!mayConsume('unknown-consumer', 'pseudonymous'), 'an unregistered consumer receives nothing above none');
  assert.deepEqual(deliverableSubscribers('DepositDecided.v1', 'personal'), ['notifications', 'risk', 'audit']);
  assert.deepEqual(subscribersOf('Nope.v1'), []);
  for (const key of Object.keys(SUBSCRIPTIONS)) assert.ok(PRODUCERS[key], `${key} has a producers entry`);
});

test('ownership map: every design table has one owner; rebuild artefacts and platform tables resolve to their owner', () => {
  assert.equal(ownerOfTable('wallet_transactions'), 'ledger');
  assert.equal(ownerOfTable('coupons_new'), 'commerce');
  assert.equal(ownerOfTable('_mig18_memberships'), 'subscriptions');
  assert.equal(ownerOfTable('link_challenges_v2'), 'identity');
  assert.equal(ownerOfTable('commerce_outbox_events'), 'commerce');
  assert.equal(ownerOfTable('pump_lock'), 'platform');
  assert.equal(ownerOfTable('mystery_table'), null);
  assert.equal(baseTableName('price_history_new'), 'price_history');
  assert.equal(platformTableOwner('ledger_sagas'), 'ledger');
  assert.equal(platformTableOwner('orders'), null);
});
