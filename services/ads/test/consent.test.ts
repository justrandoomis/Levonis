/**
 * The hashing rule on its own (`03-EVENTS.md` §5 rule 3): SHA-256 of the
 * NORMALISED email / E.164 phone, and only when the consent flag says `ads`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@levonis/contracts/canonical';
import { consentedIdentifiers, hashIdentifiers, normaliseEmail, normalisePhone, stableUserHash } from '../src/consent';
import type { ConsentState } from '../src/types';

const RAW = { email: '  Ali@Example.COM ', phone: '+964 (770) 123-4567' };

test('normalisation is fixed here, so a hash computed anywhere else matches', () => {
  assert.equal(normaliseEmail(RAW.email), 'ali@example.com');
  assert.equal(normalisePhone(RAW.phone), '9647701234567');
  assert.equal(normalisePhone('00964 770 123 4567'), '9647701234567');
});

test('hashing happens ONLY under ads consent — no other value computes anything', async () => {
  const consented = await hashIdentifiers('ads', RAW);
  assert.equal(consented.email_hash, await sha256Hex('ali@example.com'));
  assert.equal(consented.phone_hash, await sha256Hex('9647701234567'));
  for (const consent of ['none', 'analytics'] as const) {
    assert.deepEqual(await hashIdentifiers(consent, RAW), { email_hash: null, phone_hash: null }, consent);
  }
});

test('a missing contact hashes to null rather than to the hash of an empty string', async () => {
  assert.deepEqual(await hashIdentifiers('ads', {}), { email_hash: null, phone_hash: null });
  assert.deepEqual(await hashIdentifiers('ads', { email: '', phone: null }), { email_hash: null, phone_hash: null });
});

test('the send-time gate is independent of the storage-time one: a stale snapshot yields nothing once consent is not ads', () => {
  const stale: ConsentState = {
    user_hash: 'h',
    consent: 'none',
    // a hash that somehow survived a withdrawal must still not be usable
    email_hash: 'deadbeef',
    phone_hash: 'deadbeef',
    first_ads_at: '2026-01-01T00:00:00.000Z',
  };
  assert.deepEqual(consentedIdentifiers(stale), { email_hash: null, phone_hash: null });
  assert.deepEqual(consentedIdentifiers(null), { email_hash: null, phone_hash: null });
  assert.deepEqual(consentedIdentifiers({ ...stale, consent: 'ads' }), { email_hash: 'deadbeef', phone_hash: 'deadbeef' });
});

test('the stable user hash is sha256(user_id) — the join key for envelopes that carry no hash', async () => {
  assert.equal(await stableUserHash('usr_01'), await sha256Hex('usr_01'));
  assert.notEqual(await stableUserHash('usr_01'), await stableUserHash('usr_02'));
});
