/**
 * THE HOP ASSERTION'S `log` MODE.
 *
 * `off -> log -> on` is the documented rollout for every hop check in the
 * platform (`worker/entrypoints/base.ts`, `edge/gatewayOnly.ts`), so `log` is a
 * real deployment state, not a test artefact. What `log` means is "count the
 * refusal, do not enforce it" — it does NOT mean "believe the envelope".
 *
 * That distinction is the whole point for Audit: `record()` stores the issuer
 * this function returns as `source_service`, under a doc comment promising it
 * comes from the SIGNED hop and never from the argument. Returning an
 * unverified `iss` from the `log` branch would let any caller write the
 * append-only, hash-chained log in `ledger`'s or `admin`'s name — the one
 * record the chain exists to make non-repudiable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, importSigningKey } from '@levonis/platform-kit/keys';
import { signHop } from '@levonis/platform-kit/hop';
import { assertCaller, hopMode, AUDIT_METHOD_CALLERS } from '../src/guard';
import { resetKeyCache } from '../src/keys';

async function envWith(vars: Record<string, string>) {
  const m = await generateKeyPair();
  const key = await importSigningKey(m.privateKeyB64, m.publicKeyB64);
  const env = { ALLOWED_CALLER_KIDS: `ledger:${key.kid}:${m.publicKeyB64}`, ...vars } as never;
  resetKeyCache(env);
  return { env, key };
}

const entry = { action: 'wallet.credit', target: 'usr_1', source_service: 'anyone-can-claim-this' };

test('log mode returns NO issuer for an unverified hop — an unsigned claim is not an identity', async () => {
  const { env } = await envWith({ ENTRYPOINT_HOP: 'log' });
  assert.equal(hopMode(env), 'log');

  // The forgery: a hop envelope with no valid signature, claiming to be Ledger.
  const forged = { iss: 'ledger', kid: 'deadbeefdeadbeef', iat: 0, exp: 0, nonce: 'n', method: 'AuditEntrypoint.record', args_hash: 'x', principal_hash: null, sig: 'not-a-signature' };
  assert.equal(await assertCaller(env, 'record', [entry], { hop: forged }), null, 'log must not attribute the entry to ledger');

  // and with no hop at all
  assert.equal(await assertCaller(env, 'record', [entry]), null);
});

test('log mode still returns the issuer when the hop actually verifies', async () => {
  const { env, key } = await envWith({ ENTRYPOINT_HOP: 'log' });
  const hop = await signHop({ iss: 'ledger', key }, { method: 'AuditEntrypoint.record', args: [entry], nowSeconds: Math.floor(Date.now() / 1000) });
  assert.equal(await assertCaller(env, 'record', [entry], { hop }), 'ledger', 'a verified hop is an identity in any mode');
});

test('on mode refuses outright, and off attributes nothing', async () => {
  const { env: on } = await envWith({ ENTRYPOINT_HOP: 'on' });
  await assert.rejects(() => assertCaller(on, 'record', [entry]), /Refused/);

  const { env: off } = await envWith({ ENTRYPOINT_HOP: 'off' });
  assert.equal(await assertCaller(off, 'record', [entry]), null);
});

test('the READ methods are allowlisted; only recording is open to every service', () => {
  assert.deepEqual(AUDIT_METHOD_CALLERS['AuditEntrypoint.record'], ['*'], 'auditing is a duty');
  assert.ok(!(AUDIT_METHOD_CALLERS['AuditEntrypoint.query'] as string[]).includes('*'));
  assert.ok(!(AUDIT_METHOD_CALLERS['AuditEntrypoint.verifyChain'] as string[]).includes('*'));
});
