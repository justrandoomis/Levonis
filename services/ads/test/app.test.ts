/**
 * The admin surface, driven as the real Hono app with an in-memory database.
 * The response shapes are the ones `packages/contracts/src/http/ads.ts`
 * declares — that file is the pin, this test is the proof.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdsDeliveriesResponse, AdsEventMapResponse, AdsProvidersResponse } from '@levonis/contracts/http/ads';
import { createApp } from '../src/app';
import { ProviderRegistry } from '../src/registry';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import { adsDb, CONFIGURED_ENV, identity, resetPrincipalCache, UNCONFIGURED_ENV, type TestIdentity } from './_harness';

/** The Identity key every rig in this file trusts, minted once. */
const ID: TestIdentity = await identity();
/** The header a full-scope admin arrives with; the admin surface answers 401 without it. */
const ADMIN = { [PRINCIPAL_HEADER]: await ID.mint() };

function rig(vars: Record<string, string | undefined> = UNCONFIGURED_ENV) {
  const { db, raw } = adsDb();
  const app = createApp({ registry: new ProviderRegistry() });
  const env = { ALLOWED_CALLER_KIDS: ID.allowlist, ...vars, DB: db, GATEWAY_ONLY: 'off' } as unknown as Parameters<typeof app.fetch>[1];
  resetPrincipalCache(env as never);
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`https://ads.invalid${path}`, { ...init, headers: { ...ADMIN, ...(init.headers ?? {}) } }), env);
  /** The same app WITHOUT the admin principal — what an anonymous caller sees. */
  const callAnonymous = (path: string, init: RequestInit = {}) => app.fetch(new Request(`https://ads.invalid${path}`, init), env);
  return { call, callAnonymous, raw, db, env };
}

test('GET /health reports the service, its version and a live database', async () => {
  const { call } = rig();
  const res = await call('/health');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; svc: string; checks: { db: string } };
  assert.equal(body.svc, 'ads');
  assert.equal(body.checks.db, 'ok');
  assert.equal(body.ok, true);
});

test('GET /providers shows configured, enabled and the breaker per adapter, and the global switch', async () => {
  const unconfigured = rig(UNCONFIGURED_ENV);
  const a = (await (await unconfigured.call('/api/v1/ads/admin/providers')).json()) as AdsProvidersResponse;
  assert.equal(a.enabled, true, 'ADS_ENABLED=on in the harness');
  assert.deepEqual(a.providers.map((p) => p.name).sort(), ['google_ads', 'meta_capi', 'noop', 'snapchat', 'tiktok']);
  for (const p of a.providers) {
    assert.equal(p.configured, false, `${p.name} has no secret set`);
    assert.equal(p.breaker, 'closed');
    assert.equal(p.consecutive_failures, 0);
  }

  const configured = rig(CONFIGURED_ENV);
  const b = (await (await configured.call('/api/v1/ads/admin/providers')).json()) as AdsProvidersResponse;
  for (const p of b.providers) assert.equal(p.configured, p.name !== 'noop', `${p.name}`);
});

test('GET /event-map returns the seeded mapping with both kill switches folded in', async () => {
  const { call, raw } = rig();
  const before = (await (await call('/api/v1/ads/admin/event-map')).json()) as AdsEventMapResponse;
  assert.equal(before.mappings.length, 24);
  assert.ok(before.mappings.every((m) => m.enabled));
  assert.ok(before.mappings.some((m) => m.event_type === 'PurchaseCompleted' && m.provider === 'meta_capi' && m.provider_event === 'Purchase'));

  raw.prepare("UPDATE ads_providers SET enabled = 0 WHERE name = 'snapchat'").run();
  const after = (await (await call('/api/v1/ads/admin/event-map')).json()) as AdsEventMapResponse;
  assert.ok(after.mappings.filter((m) => m.provider === 'snapchat').every((m) => !m.enabled), 'the provider switch disables every one of its rows');
});

test('POST /flags flips a provider and an event switch; the GLOBAL switch is not settable here', async () => {
  const { call, raw } = rig();
  const post = (body: unknown) => call('/api/v1/ads/admin/flags', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

  assert.equal((await post({ name: 'ads.providers.tiktok.enabled', enabled: false })).status, 200);
  assert.equal(Number((raw.prepare("SELECT enabled AS n FROM ads_providers WHERE name = 'tiktok'").get() as { n: number }).n), 0);

  assert.equal((await post({ name: 'ads.events.PurchaseCompleted.enabled', enabled: false })).status, 200);
  assert.equal(
    Number((raw.prepare("SELECT COUNT(*) AS n FROM ads_event_map WHERE event_type = 'PurchaseCompleted' AND enabled = 0").get() as { n: number }).n),
    4
  );

  // `ads.enabled` is the ADS_ENABLED var: a workflow run, not a row an admin session flips.
  assert.equal((await post({ name: 'ads.enabled', enabled: false })).status, 404);
  assert.equal((await post({ name: 'ads.providers.not_a_provider.enabled', enabled: false })).status, 404);
});

test('GET /deliveries pages, filters and reports the DLQ depth — and names no person', async () => {
  const { call, raw } = rig();
  raw
    .prepare(
      `INSERT INTO ads_deliveries (id, event_id, event_type, provider, provider_event, status, attempts, payload, created_at)
       VALUES ('d1','e1','PurchaseCompleted','meta_capi','Purchase','sent',1,'{}','2026-09-07T10:00:00.000Z'),
              ('d2','e1','PurchaseCompleted','tiktok','CompletePayment','failed',2,'{}','2026-09-07T10:00:01.000Z')`
    )
    .run();
  raw.prepare("INSERT INTO ads_dead_letters (id, delivery_id, event_id, event_type, provider, reason, created_at) VALUES ('q1','d3','e2','T','tiktok','x','now')").run();

  const body = (await (await call('/api/v1/ads/admin/deliveries')).json()) as AdsDeliveriesResponse;
  assert.equal(body.rows.length, 2);
  assert.equal(body.dead_letters, 1);
  assert.ok(body.next);
  for (const row of body.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['attempts', 'created_at', 'delivered_at', 'error', 'event_id', 'event_type', 'id', 'provider', 'status']);
  }

  const filtered = (await (await call('/api/v1/ads/admin/deliveries?provider=tiktok&status=failed')).json()) as AdsDeliveriesResponse;
  assert.deepEqual(filtered.rows.map((r) => r.id), ['d2']);

  // an unknown filter value is ignored rather than injected
  const junk = (await (await call("/api/v1/ads/admin/deliveries?status=' OR 1=1 --")).json()) as AdsDeliveriesResponse;
  assert.equal(junk.rows.length, 2);
});

test('an unknown path is a 404 in the platform envelope, not an empty body', async () => {
  const { call } = rig();
  const res = await call('/api/v1/ads/admin/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Not found', code: 'NOT_FOUND' });
});

test('with GATEWAY_ONLY=on nothing but a health probe gets in without a signed gateway hop', async () => {
  const { db } = adsDb();
  const app = createApp({ registry: new ProviderRegistry() });
  const env = { ...UNCONFIGURED_ENV, DB: db, GATEWAY_ONLY: 'on', HEALTH_PROBE_TOKEN: 'probe-token-value' } as unknown as Parameters<typeof app.fetch>[1];
  const blocked = await app.fetch(new Request('https://ads.invalid/api/v1/ads/admin/providers'), env);
  assert.equal(blocked.status, 403);
  assert.deepEqual(await blocked.json(), { success: false, error: 'Not via gateway', code: 'NOT_VIA_GATEWAY' });

  const probed = await app.fetch(new Request('https://ads.invalid/health', { headers: { 'x-health-probe': 'probe-token-value' } }), env);
  assert.equal(probed.status, 200);
});
