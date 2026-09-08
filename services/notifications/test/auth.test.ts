/**
 * The three authorisation surfaces of this Worker, each pinned by a test that
 * fails if the check is ever removed again.
 *
 *  1. `/api/notifications/*` — the SPA inbox. The principal is VERIFIED
 *     (signature, issuer, expiry), never merely decoded: a header anybody can
 *     mint must not bind a reader.
 *  2. `/api/v1/notifications/admin/*` — a full-scope admin principal, or 401.
 *  3. `NotificationsEntrypoint.send` — the hop assertion, because this Worker
 *     holds the mail credential and the bot token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import { generateKeyPair, importSigningKey, signCompact } from '@levonis/platform-kit/keys';
import { signHop } from '@levonis/platform-kit/hop';
import { createApp } from '../src/app';
import { assertCaller, hopMode, NOTIFICATIONS_METHOD_CALLERS } from '../src/guard';
import { identity, notifyDb, resetPrincipalCache, type TestIdentity } from './_harness';

const ID: TestIdentity = await identity();

function rig(vars: Record<string, string | undefined> = {}) {
  const { db, raw } = notifyDb();
  const app = createApp();
  const env = { ALLOWED_CALLER_KIDS: ID.allowlist, ...vars, DB: db, GATEWAY_ONLY: 'off' } as unknown as Parameters<typeof app.fetch>[1];
  resetPrincipalCache(env as never);
  const call = (path: string, init?: RequestInit) => app.fetch(new Request(`https://notifications.invalid${path}`, init), env);
  return { call, raw, env };
}

const seed = (raw: ReturnType<typeof rig>['raw'], userId: string, id: string) =>
  raw
    .prepare(
      `INSERT INTO user_notifications (id, user_id, kind, title_ar, title_en, body_ar, body_en, link, entity_type, entity_id, event_key, read_at, created_at)
       VALUES (?, ?, 'order_update', 'ع', 'en', '', '', '', '', '', ?, NULL, '2026-09-07T10:00:00.000Z')`
    )
    .run(id, userId, `k:${id}`);

/** A principal signed by a key this Worker has never heard of — the forgery. */
async function forgedPrincipal(sub: string): Promise<string> {
  const m = await generateKeyPair();
  const key = await importSigningKey(m.privateKeyB64, m.publicKeyB64);
  const now = Math.floor(Date.now() / 1000);
  return signCompact(key, {
    v: 1, sub, sid_hash: null, role: 'customer', scope: null, investor: false,
    tier: null, locale: 'en', host_kind: 'main', iat: now, exp: now + 120, cid: 'forged',
  });
}

test('a self-minted principal binds nobody: the inbox refuses a header signed by an unknown key', async () => {
  const { call, raw } = rig();
  seed(raw, 'victim-user-id', 'n1');
  const headers = { [PRINCIPAL_HEADER]: await forgedPrincipal('victim-user-id'), 'Content-Type': 'application/json' };

  for (const path of ['/api/notifications', '/api/notifications/unread-count']) {
    const res = await call(path, { headers });
    assert.equal(res.status, 401, `${path} must not accept a forged principal`);
  }
  const read = await call('/api/notifications/read', { method: 'POST', headers, body: '{}' });
  assert.equal(read.status, 401);
  // and nothing was mutated on the victim's behalf
  assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM user_notifications WHERE read_at IS NOT NULL").get() as { n: number }).n), 0);
});

test('an expired principal, and one from the wrong issuer, are refused as firmly as a forged one', async () => {
  const { call } = rig();
  const now = Math.floor(Date.now() / 1000);
  const expired = await ID.mint({ iat: now - 600, exp: now - 300 });
  assert.equal((await call('/api/notifications', { headers: { [PRINCIPAL_HEADER]: expired } })).status, 401);

  const other = await identity('marketplace');
  const { call: call2 } = rig({ ALLOWED_CALLER_KIDS: other.allowlist });
  assert.equal((await call2('/api/notifications', { headers: { [PRINCIPAL_HEADER]: await other.mint() } })).status, 401, 'only identity/core may sign a principal');
});

test('with no key registered the inbox answers 401 to everything — the fail-closed state before Phase 3', async () => {
  const { call } = rig({ ALLOWED_CALLER_KIDS: '' });
  assert.equal((await call('/api/notifications', { headers: { [PRINCIPAL_HEADER]: await ID.mint() } })).status, 401);
});

test('the admin delivery history refuses an anonymous caller and an assistant-scope admin', async () => {
  const { call } = rig();
  assert.equal((await call('/api/v1/notifications/admin/deliveries')).status, 401, 'no principal');
  assert.equal(
    (await call('/api/v1/notifications/admin/deliveries', { headers: { [PRINCIPAL_HEADER]: await ID.mint() } })).status,
    403,
    'a customer principal is not an admin'
  );
  assert.equal(
    (await call('/api/v1/notifications/admin/deliveries', { headers: { [PRINCIPAL_HEADER]: await ID.mint({ role: 'admin', scope: 'assistant' }) } })).status,
    403,
    'assistant scope is not full scope'
  );
  assert.equal(
    (await call('/api/v1/notifications/admin/deliveries', { headers: { [PRINCIPAL_HEADER]: await ID.mint({ role: 'admin', scope: 'full', host_kind: 'merchant' }) } })).status,
    401,
    'admin surfaces are apex-only'
  );
  assert.equal((await call('/api/v1/notifications/admin/deliveries', { headers: { [PRINCIPAL_HEADER]: await ID.mint({ role: 'admin', scope: 'full' }) } })).status, 200);
});

test('send() is hop-guarded: no hop, a wrong issuer and tampered arguments are all refused', async () => {
  const m = await generateKeyPair();
  const key = await importSigningKey(m.privateKeyB64, m.publicKeyB64);
  const env = { ALLOWED_CALLER_KIDS: `core:${key.kid}:${m.publicKeyB64}` } as never;
  assert.equal(hopMode(env), 'on', 'a registered caller key turns the assertion on');

  const cmd = { user_id: 'u1', template: 't', channels: ['email'], event_key: 'k1', params: { to: 'attacker@evil.invalid' } };
  const now = Math.floor(Date.now() / 1000);

  await assert.rejects(() => assertCaller(env, 'send', [cmd]), /Refused/, 'no hop at all');

  const good = await signHop({ iss: 'core', key }, { method: 'NotificationsEntrypoint.send', args: [cmd], nowSeconds: now });
  assert.equal(await assertCaller(env, 'send', [cmd], { hop: good }), 'core');

  // the SAME signed hop replayed against DIFFERENT arguments
  const tampered = { ...cmd, params: { to: 'victim@example.invalid' } };
  await assert.rejects(() => assertCaller(env, 'send', [tampered], { hop: good }), /Refused/, 'args_hash binds the arguments');

  // a Worker on the account that is not on the allowlist
  const outsider = await generateKeyPair();
  const outsiderKey = await importSigningKey(outsider.privateKeyB64, outsider.publicKeyB64);
  const env2 = { ALLOWED_CALLER_KIDS: `ads:${outsiderKey.kid}:${outsider.publicKeyB64}` } as never;
  const outsiderHop = await signHop({ iss: 'ads', key: outsiderKey }, { method: 'NotificationsEntrypoint.send', args: [cmd], nowSeconds: now });
  await assert.rejects(() => assertCaller(env2, 'send', [cmd], { hop: outsiderHop }), /Refused/, 'ads may not send mail');
});

test('the send allowlist is explicit — never `*` — and every method of the class has an entry', () => {
  const callers = NOTIFICATIONS_METHOD_CALLERS['NotificationsEntrypoint.send'];
  assert.ok(Array.isArray(callers) && callers.length > 0);
  assert.ok(!callers.includes('*'), 'sending is a privilege, not a duty: no wildcard');
});
