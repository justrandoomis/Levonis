import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signEnvelope, verifyEnvelope } from '../src/eventSig';
import { OrderCreatedV1 } from '@levonis/contracts/events/v1/OrderCreated';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { ringOf, testIdentity } from './_keys';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'src', 'events', 'fixtures');
const fixture = JSON.parse(readFileSync(join(FIXTURES, 'OrderCreated.v1.json'), 'utf8')) as EventEnvelope;
const { sig: _s, ...unsigned } = fixture;

test('a producer signs the canonical envelope; a consumer verifies producer key, allowlist and bytes', async () => {
  const commerce = await testIdentity('commerce');
  const reviews = await testIdentity('reviews');
  const ring = await ringOf(commerce, reviews);
  const signed = await signEnvelope(commerce.key, unsigned);
  assert.ok(OrderCreatedV1.is(signed.payload));
  const ok = await verifyEnvelope(signed, ring, { eventKey: 'OrderCreated.v1' });
  assert.deepEqual(ok, { ok: true, kid: commerce.key.kid, producer: 'commerce' });
  // reordering keys does not break the signature (canonical form)
  const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(signed).reverse()))) as EventEnvelope;
  assert.ok((await verifyEnvelope(reordered, ring, { eventKey: 'OrderCreated.v1' })).ok);
  // a changed payload field is a bad signature
  const tampered = { ...signed, payload: { ...(signed.payload as Record<string, unknown>), payment_state: 'cod' } } as EventEnvelope;
  assert.deepEqual(await verifyEnvelope(tampered, ring, { eventKey: 'OrderCreated.v1' }), { ok: false, reason: 'BAD_SIGNATURE' });
  // reviews holds a producer binding but is not a producer of OrderCreated: forged even with a valid signature
  const forged = await signEnvelope(reviews.key, { ...unsigned, source_service: 'reviews' });
  assert.deepEqual(await verifyEnvelope(forged, ring, { eventKey: 'OrderCreated.v1' }), { ok: false, reason: 'PRODUCER_NOT_ALLOWED' });
  // claiming to be commerce while signing with reviews' key
  const impersonating = await signEnvelope(reviews.key, unsigned);
  assert.deepEqual(await verifyEnvelope(impersonating, ring, { eventKey: 'OrderCreated.v1' }), { ok: false, reason: 'PRODUCER_KEY_MISMATCH' });
  assert.deepEqual(await verifyEnvelope({ ...signed, sig: 'garbage' }, ring, { eventKey: 'OrderCreated.v1' }), { ok: false, reason: 'MALFORMED_SIG' });
  // in rpc mode the hop issuer must also be an allowed producer
  assert.deepEqual(await verifyEnvelope(signed, ring, { eventKey: 'OrderCreated.v1', hopIss: 'reviews' }), { ok: false, reason: 'PRODUCER_NOT_ALLOWED' });
  assert.ok((await verifyEnvelope(signed, ring, { eventKey: 'OrderCreated.v1', hopIss: 'core' })).ok);
});
