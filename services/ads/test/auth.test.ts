/**
 * `/api/v1/ads/admin/*` is an ADMIN surface, and this file is the proof it
 * behaves like one.
 *
 * `POST /flags` enables and disables advertising providers and event mappings;
 * `GET /deliveries` is the conversion history. `gatewayOnly()` in front of the
 * router proves only that a request came through the gateway, so the check
 * that establishes WHO the caller is has to live here (`01-TARGET.md` §4
 * item 2, §4 item 6) — and it has to fail closed while no key is registered,
 * because the dark twin ships `workers_dev: true`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import { generateKeyPair, importSigningKey, signCompact } from '@levonis/platform-kit/keys';
import { createApp } from '../src/app';
import { ProviderRegistry } from '../src/registry';
import { adsDb, identity, resetPrincipalCache, UNCONFIGURED_ENV, type TestIdentity } from './_harness';

const ID: TestIdentity = await identity();

const ADMIN_ROUTES: ReadonlyArray<{ path: string; init?: RequestInit }> = [
  { path: '/api/v1/ads/admin/providers' },
  { path: '/api/v1/ads/admin/event-map' },
  { path: '/api/v1/ads/admin/deliveries' },
  {
    path: '/api/v1/ads/admin/flags',
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ads.providers.meta_capi.enabled', enabled: false }) },
  },
];

function rig(vars: Record<string, string | undefined> = UNCONFIGURED_ENV) {
  const { db, raw } = adsDb();
  const app = createApp({ registry: new ProviderRegistry() });
  const env = { ALLOWED_CALLER_KIDS: ID.allowlist, ...vars, DB: db, GATEWAY_ONLY: 'off' } as unknown as Parameters<typeof app.fetch>[1];
  resetPrincipalCache(env as never);
  const call = (path: string, init?: RequestInit) => app.fetch(new Request(`https://ads.invalid${path}`, init), env);
  return { call, raw, env };
}

const withPrincipal = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string> | undefined), [PRINCIPAL_HEADER]: token },
});

test('every admin route refuses a caller with no principal — including the one that flips a provider switch', async () => {
  const { call, raw } = rig();
  for (const r of ADMIN_ROUTES) {
    const res = await call(r.path, r.init);
    assert.equal(res.status, 401, `${r.path} must not answer an anonymous caller`);
  }
  const enabled = Number((raw.prepare("SELECT enabled FROM ads_providers WHERE name = 'meta_capi'").get() as { enabled: number }).enabled);
  assert.equal(enabled, 1, 'the refused POST /flags changed nothing');
});

test('a forged principal — signed by a key this Worker never registered — is refused', async () => {
  const m = await generateKeyPair();
  const key = await importSigningKey(m.privateKeyB64, m.publicKeyB64);
  const now = Math.floor(Date.now() / 1000);
  const forged = await signCompact(key, {
    v: 1, sub: 'usr_attacker', sid_hash: null, role: 'admin', scope: 'full', investor: false,
    tier: null, locale: 'en', host_kind: 'main', iat: now, exp: now + 120, cid: 'forged',
  });
  const { call } = rig();
  for (const r of ADMIN_ROUTES) {
    assert.equal((await call(r.path, withPrincipal(forged, r.init))).status, 401, r.path);
  }
});

test('a customer, an assistant-scope admin and a merchant-host admin are all refused; a full admin on the apex is served', async () => {
  const { call } = rig();
  assert.equal((await call('/api/v1/ads/admin/providers', withPrincipal(await ID.mint({ role: 'customer', scope: null })))).status, 403);
  assert.equal((await call('/api/v1/ads/admin/providers', withPrincipal(await ID.mint({ scope: 'assistant' })))).status, 403);
  assert.equal((await call('/api/v1/ads/admin/providers', withPrincipal(await ID.mint({ host_kind: 'merchant' })))).status, 401, 'admin surfaces are apex-only');
  assert.equal((await call('/api/v1/ads/admin/providers', withPrincipal(await ID.mint()))).status, 200);
});

test('with no caller key registered the admin surface is closed, whatever the header says', async () => {
  const { call } = rig({ ...UNCONFIGURED_ENV, ALLOWED_CALLER_KIDS: '' });
  assert.equal((await call('/api/v1/ads/admin/providers', withPrincipal(await ID.mint()))).status, 401);
});

test('/health stays open — a probe that must authenticate cannot report that authentication is broken', async () => {
  const { call } = rig();
  assert.equal((await call('/health')).status, 200);
});
