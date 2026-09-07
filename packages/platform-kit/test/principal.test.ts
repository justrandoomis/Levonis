import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrincipal, signPrincipal, verifyPrincipal, principalToSessionUser, systemPrincipalInput, UNFILLABLE_SESSION_FIELDS, isFullAdmin } from '../src/principal';
import { KeyRing } from '../src/keys';
import { ringOf, testIdentity } from './_keys';

const NOW = 1_800_000_000;

const userInput = {
  sub: 'usr_01', sid_hash: 'a'.repeat(64), role: 'admin' as const, scope: 'assistant' as const, investor: false, tier: 'plus',
  locale: 'ar' as const, host_kind: 'main' as const, cid: '018f0000-0000-7000-8000-000000000001',
};

test('signer/verifier round-trip: Identity signs, a service verifies with the published key', async () => {
  const identity = await testIdentity('identity');
  const ring = await ringOf(identity);
  const header = await signPrincipal(identity.key, buildPrincipal(userInput, NOW));
  assert.match(header, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const v = await verifyPrincipal(header, ring, { nowSeconds: NOW + 10, expectHostKind: 'main', issuers: ['identity'] });
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.principal.sub, 'usr_01');
    assert.equal(v.principal.exp, NOW + 120);
    assert.equal(v.kid, identity.key.kid);
  }
});

test('tampering with a claim is rejected; so is a signature by an unregistered or wrong-service key', async () => {
  const identity = await testIdentity('identity');
  const gateway = await testIdentity('gateway');
  const ring = await ringOf(identity, gateway);
  const header = await signPrincipal(identity.key, buildPrincipal(userInput, NOW));
  const [h, p, s] = header.split('.');
  // flip the payload: role admin -> keep the signature
  const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), scope: 'owner' })).toString('base64url');
  const tampered = await verifyPrincipal(`${h}.${forgedPayload}.${s}`, ring, { nowSeconds: NOW });
  assert.deepEqual(tampered, { ok: false, reason: 'BAD_SIGNATURE' });
  // a compromised gateway cannot mint: its key is registered, but it is not an accepted principal issuer
  const minted = await signPrincipal(gateway.key, buildPrincipal({ ...userInput, scope: 'owner' }, NOW));
  const wrongIssuer = await verifyPrincipal(minted, ring, { nowSeconds: NOW, issuers: ['identity'] });
  assert.deepEqual(wrongIssuer, { ok: false, reason: 'WRONG_ISSUER' });
  const unknown = await verifyPrincipal(header, new KeyRing(), { nowSeconds: NOW });
  assert.deepEqual(unknown, { ok: false, reason: 'UNKNOWN_KID' });
  assert.deepEqual(await verifyPrincipal('not.a.token.at.all', ring, { nowSeconds: NOW }), { ok: false, reason: 'MALFORMED' });
});

test('expiry (120 s) and host_kind are enforced', async () => {
  const identity = await testIdentity('identity');
  const ring = await ringOf(identity);
  const header = await signPrincipal(identity.key, buildPrincipal(userInput, NOW));
  assert.deepEqual(await verifyPrincipal(header, ring, { nowSeconds: NOW + 130 }), { ok: false, reason: 'EXPIRED' });
  assert.deepEqual(await verifyPrincipal(header, ring, { nowSeconds: NOW - 60 }), { ok: false, reason: 'NOT_YET_VALID' });
  const onMerchantHost = await verifyPrincipal(header, ring, { nowSeconds: NOW, expectHostKind: 'merchant' });
  assert.deepEqual(onMerchantHost, { ok: false, reason: 'HOST_MISMATCH' });
});

test('principalToSessionUser reconstructs the route shape and documents what it cannot fill', async () => {
  const p = buildPrincipal(userInput, NOW);
  const u = principalToSessionUser(p)!;
  assert.equal(u.id, 'usr_01');
  assert.equal(u.role, 'admin');
  assert.equal(u.admin_scope, 'assistant');
  assert.equal(u.membership_tier, 'plus');
  for (const f of UNFILLABLE_SESSION_FIELDS) assert.ok(f in u, `${f} is present (as an empty value) so a moved route fails visibly, not with undefined`);
  assert.equal(u.email, '');
  assert.equal(isFullAdmin(p), false);
  assert.equal(isFullAdmin(buildPrincipal({ ...userInput, scope: 'owner' }, NOW)), true);
  assert.equal(principalToSessionUser(buildPrincipal(systemPrincipalInput('commerce', 'cid'), NOW)), null);
});
