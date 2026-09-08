import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signHop, verifyHop, NonceSet, HOP_TTL_S } from '../src/hop';
import { ringOf, testIdentity } from './_keys';

const NOW = 1_800_000_000;
const args = [{ eventKey: 'wtx_ord_ord_01_usd', userId: 'usr_01', amount: 61500 }];

test('a signed hop verifies for the allowed issuer and method, and binds the arguments and principal', async () => {
  const commerce = await testIdentity('commerce');
  const ring = await ringOf(commerce);
  const hop = await signHop({ iss: 'commerce', key: commerce.key }, { method: 'LedgerEntrypoint.credit', args, principalHeader: 'p.q.r', nowSeconds: NOW });
  assert.equal(hop.exp, NOW + HOP_TTL_S);
  const nonces = new NonceSet();
  const ok = await verifyHop({ hop, method: 'LedgerEntrypoint.credit', args, principalHeader: 'p.q.r', allowedIssuers: ['commerce', 'marketplace'], ring, nonces, nowSeconds: NOW + 1 });
  assert.ok(ok.ok);
  // changed arguments — a 30-s bearer for any arguments is exactly what args_hash prevents
  const other = await verifyHop({ hop, method: 'LedgerEntrypoint.credit', args: [{ ...args[0], amount: 1e8 }], principalHeader: 'p.q.r', allowedIssuers: ['commerce'], ring, nonces: new NonceSet(), nowSeconds: NOW });
  assert.deepEqual(other, { ok: false, reason: 'ARGS_MISMATCH' });
  const otherPrincipal = await verifyHop({ hop, method: 'LedgerEntrypoint.credit', args, principalHeader: 'x.y.z', allowedIssuers: ['commerce'], ring, nonces: new NonceSet(), nowSeconds: NOW });
  assert.deepEqual(otherPrincipal, { ok: false, reason: 'PRINCIPAL_MISMATCH' });
  const otherMethod = await verifyHop({ hop, method: 'LedgerEntrypoint.decideDeposit', args, principalHeader: 'p.q.r', allowedIssuers: ['commerce'], ring, nonces: new NonceSet(), nowSeconds: NOW });
  assert.deepEqual(otherMethod, { ok: false, reason: 'METHOD_MISMATCH' });
});

test('issuer allowlist per method, replay, expiry and a tampered signature are refused', async () => {
  const reviews = await testIdentity('reviews');
  const commerce = await testIdentity('commerce');
  const ring = await ringOf(reviews, commerce);
  const hop = await signHop({ iss: 'reviews', key: reviews.key }, { method: 'LedgerEntrypoint.decideDeposit', args, nowSeconds: NOW });
  const notAllowed = await verifyHop({ hop, method: 'LedgerEntrypoint.decideDeposit', args, allowedIssuers: ['notifications', 'ledger-admin'], ring, nonces: new NonceSet(), nowSeconds: NOW });
  assert.deepEqual(notAllowed, { ok: false, reason: 'ISSUER_NOT_ALLOWED' });
  // a caller claiming to be commerce but signing with reviews' key
  const impersonating = await verifyHop({ hop: { ...hop, iss: 'commerce' }, method: 'LedgerEntrypoint.decideDeposit', args, allowedIssuers: ['commerce'], ring, nonces: new NonceSet(), nowSeconds: NOW });
  assert.deepEqual(impersonating, { ok: false, reason: 'ISSUER_KEY_MISMATCH' });
  const nonces = new NonceSet();
  const first = await verifyHop({ hop, method: 'LedgerEntrypoint.decideDeposit', args, allowedIssuers: ['*'], ring, nonces, nowSeconds: NOW });
  assert.ok(first.ok);
  const replay = await verifyHop({ hop, method: 'LedgerEntrypoint.decideDeposit', args, allowedIssuers: ['*'], ring, nonces, nowSeconds: NOW + 5 });
  assert.deepEqual(replay, { ok: false, reason: 'REPLAY' });
  const expired = await verifyHop({ hop, method: 'LedgerEntrypoint.decideDeposit', args, allowedIssuers: ['*'], ring, nonces: new NonceSet(), nowSeconds: NOW + HOP_TTL_S + 10 });
  assert.deepEqual(expired, { ok: false, reason: 'EXPIRED' });
  // Tamper with the FIRST character, never the last. A 64-byte signature is
  // 86 base64url characters: the last one carries only 2 significant bits, so
  // 'A' and 'B' there decode to the same 64 bytes and the signature is not
  // tampered with at all. Editing the tail made this assertion fail on itself
  // (originally 1 run in 4096, then every run) instead of on a defect.
  const flipped = (hop.sig[0] === 'A' ? 'B' : 'A') + hop.sig.slice(1);
  const tampered = await verifyHop({ hop: { ...hop, sig: flipped }, method: 'LedgerEntrypoint.decideDeposit', args, allowedIssuers: ['*'], ring, nonces: new NonceSet(), nowSeconds: NOW });
  assert.deepEqual(tampered, { ok: false, reason: 'BAD_SIGNATURE' });
  assert.deepEqual(await verifyHop({ hop: { iss: 'x' }, method: 'm', args, allowedIssuers: ['*'], ring, nonces, nowSeconds: NOW }), { ok: false, reason: 'MALFORMED' });
});

test('a retry re-signs with a fresh nonce, so the replay set does not block it', async () => {
  const commerce = await testIdentity('commerce');
  const ring = await ringOf(commerce);
  const nonces = new NonceSet();
  const a = await signHop({ iss: 'commerce', key: commerce.key }, { method: 'm', args, nowSeconds: NOW });
  const b = await signHop({ iss: 'commerce', key: commerce.key }, { method: 'm', args, nowSeconds: NOW });
  assert.notEqual(a.nonce, b.nonce);
  assert.ok((await verifyHop({ hop: a, method: 'm', args, allowedIssuers: ['*'], ring, nonces, nowSeconds: NOW })).ok);
  assert.ok((await verifyHop({ hop: b, method: 'm', args, allowedIssuers: ['*'], ring, nonces, nowSeconds: NOW })).ok);
  // the window prunes old nonces
  assert.equal(nonces.remember('commerce', 'n1', 0), true);
  assert.equal(nonces.remember('commerce', 'n1', 30_000), false);
  assert.equal(nonces.remember('commerce', 'n1', 61_000), true);
});
