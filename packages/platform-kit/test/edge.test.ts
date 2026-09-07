import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { gatewayOnly, forwardArgs, HTTP_FORWARD_METHOD } from '../src/edge/gatewayOnly';
import { matchCapability, capabilityDenial, ADMIN_CAPABILITIES, ADMIN_FULL_PREFIXES } from '../src/edge/capabilities';
import { originCheck, securityHeaders, requireMainHost } from '../src/edge/middleware';
import { classifyHost } from '../src/edge/hosts';
import type { AppContext } from '../src/edge/types';
import { signHop } from '../src/hop';
import { buildPrincipal } from '../src/principal';
import { healthReport, isHealthProbe, legacyHealthBody } from '../src/health';
import { canViewFinancials, scopeFor, stripFinancials, meetsRequirement } from '../src/scope';
import { HOP_HEADER, HOST_HEADER } from '@levonis/contracts/http/common';
import { KitError } from '../src/errors';
import { ringOf, testIdentity } from './_keys';
import { CronSweepRunner, WorkflowRunner, disabledSteps, stepEnabled, legacyStepDue } from '../src/process';
import { MemoryHub, NoopHub, selectHub } from '../src/realtime';

const NOW = 1_800_000_000;
const principal = (role: 'customer' | 'admin', scope: 'owner' | 'full' | 'assistant' | null = null) =>
  buildPrincipal({ sub: 'u', sid_hash: null, role, scope, investor: false, tier: null, locale: null, host_kind: 'main', cid: 'c' }, NOW);

function appWith(mode: string, ring: Awaited<ReturnType<typeof ringOf>>, seen: string[]) {
  const app = new Hono<AppContext>();
  app.onError((e, c) => (e instanceof KitError ? c.json(e.toBody(), e.status as 403) : c.text(String(e), 500)));
  app.use('*', securityHeaders());
  app.use('*', originCheck());
  app.use('*', async (c, next) => {
    c.set('host', classifyHost(c.req.header('Host'), 'levonis-iq.com'));
    await next();
  });
  app.use('*', gatewayOnly({ mode, ring, nowSeconds: () => NOW, probeToken: 'probe-token', onNotViaGateway: (i) => void seen.push(i.reason) }));
  app.get('/api/x', (c) => c.json({ success: true, iss: c.get('hopIss') ?? null }));
  app.post('/api/x', (c) => c.json({ success: true }));
  app.use('/api/admin/*', requireMainHost);
  app.get('/api/admin/y', (c) => c.json({ success: true }));
  return app;
}

test('gatewayOnly: off passes; log counts and passes; on refuses without a valid gateway hop, accepts a signed forward and the health probe', async () => {
  const gateway = await testIdentity('gateway');
  const ring = await ringOf(gateway);
  const seen: string[] = [];
  const off = appWith('off', ring, seen);
  assert.equal((await off.request('http://levonis-iq.com/api/x')).status, 200);
  const log = appWith('log', ring, seen);
  assert.equal((await log.request('http://levonis-iq.com/api/x')).status, 200);
  assert.deepEqual(seen, ['MISSING_HOP']);
  const on = appWith('on', ring, seen);
  const refused = await on.request('http://levonis-iq.com/api/x');
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { success: false, error: 'Not via gateway', code: 'NOT_VIA_GATEWAY' });
  const hop = await signHop({ iss: 'gateway', key: gateway.key }, { method: HTTP_FORWARD_METHOD, args: forwardArgs('GET', 'http://levonis-iq.com/api/x', 'main;'), nowSeconds: NOW });
  const ok = await on.request('http://levonis-iq.com/api/x', { headers: { [HOP_HEADER]: JSON.stringify(hop), [HOST_HEADER]: 'main;' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { success: true, iss: 'gateway' });
  // the same hop for another path is not a bearer
  const other = await on.request('http://levonis-iq.com/api/x?other=1', { headers: { [HOP_HEADER]: JSON.stringify(hop), [HOST_HEADER]: 'main;' } });
  assert.equal(other.status, 403);
  const probe = await on.request('http://levonis-iq.com/api/x', { headers: { 'x-health-probe': 'probe-token' } });
  assert.equal(probe.status, 200);
  assert.equal((await on.request('http://levonis-iq.com/api/x', { headers: { 'x-health-probe': 'wrong' } })).status, 403);
});

test('the copied edge middlewares behave as the core: security headers, origin check, apex-only admin', async () => {
  const gateway = await testIdentity('gateway');
  const app = appWith('off', await ringOf(gateway), []);
  const res = await app.request('http://levonis-iq.com/api/x');
  assert.ok(res.headers.get('Content-Security-Policy'));
  assert.equal(res.headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains');
  const cross = await app.request('http://levonis-iq.com/api/x', { method: 'POST', headers: { Origin: 'https://evil.example' } }, {});
  assert.equal(cross.status, 403);
  const same = await app.request('http://levonis-iq.com/api/x', { method: 'POST', headers: { Origin: 'http://levonis-iq.com' } }, {});
  assert.equal(same.status, 200);
  assert.equal((await app.request('http://levonis-iq.com/api/admin/y', { headers: { Host: 'levonis-iq.com' } })).status, 200);
  const onStore = await app.request('http://somestore.levonis-iq.com/api/admin/y', { headers: { Host: 'somestore.levonis-iq.com' } });
  assert.equal(onStore.status, 404);
  assert.deepEqual(await onStore.json(), { success: false, error: 'Not found' });
});

test('capabilities: longest prefix wins, admin surfaces are apex-only, money/PII admin paths need admin:full; denial bodies are today ones', () => {
  const wallet = matchCapability(ADMIN_CAPABILITIES, '/api/admin/wallet/credit', 'POST')!;
  assert.equal(wallet.requires, 'admin:full');
  assert.equal(matchCapability(ADMIN_CAPABILITIES, '/api/admin/orders', 'GET')!.requires, 'admin');
  assert.equal(matchCapability(ADMIN_CAPABILITIES, '/api/admin/users/u1', 'PATCH')!.requires, 'admin:full');
  assert.equal(matchCapability(ADMIN_CAPABILITIES, '/api/admin/users/u1', 'GET')!.requires, 'admin');
  assert.equal(matchCapability(ADMIN_CAPABILITIES, '/api/v1/audit/admin/query', 'GET')!.requires, 'admin');
  assert.equal(matchCapability(ADMIN_CAPABILITIES, '/api/v1/analytics/overview', 'GET'), null);
  assert.equal(matchCapability(ADMIN_CAPABILITIES, '/api/products', 'GET'), null);
  for (const p of ADMIN_FULL_PREFIXES) assert.equal(matchCapability(ADMIN_CAPABILITIES, p + 'x', 'PATCH')!.requires, 'admin:full', p);
  assert.deepEqual(capabilityDenial(wallet, principal('admin', 'owner'), 'merchant'), { status: 404, body: { success: false, error: 'Not found' } });
  assert.deepEqual(capabilityDenial(wallet, null, 'main'), { status: 401, body: { success: false, error: 'Authentication required', code: 'UNAUTHORIZED' } });
  assert.deepEqual(capabilityDenial(wallet, principal('customer'), 'main'), { status: 403, body: { success: false, error: 'Financial administrator access required', code: 'FORBIDDEN' } });
  assert.deepEqual(capabilityDenial(wallet, principal('admin', 'assistant'), 'main')?.status, 403);
  assert.equal(capabilityDenial(wallet, principal('admin', 'full'), 'main'), null);
  assert.equal(capabilityDenial(wallet, principal('admin', 'owner'), 'foreign'), null, 'a foreign host is treated as the main site so a probe learns nothing');
});

test('scope over the principal: owner and full see money, assistant does not; stripping is recursive', () => {
  assert.equal(scopeFor({ role: 'admin', admin_scope: null, isOwner: false }), 'full', 'NULL is unrestricted so the migration could not demote a live admin');
  assert.equal(scopeFor({ role: 'admin', admin_scope: 'assistant', isOwner: true }), 'owner', 'the owner can never be restricted');
  assert.equal(scopeFor({ role: 'customer', admin_scope: 'full', isOwner: false }), null);
  assert.ok(canViewFinancials(principal('admin', 'owner')) && canViewFinancials(principal('admin', 'full')));
  assert.ok(!canViewFinancials(principal('admin', 'assistant')) && !canViewFinancials(principal('customer')));
  assert.deepEqual(stripFinancials({ price_iqd: 1, cost_iqd: 2, options: [{ id: 'o', cost_iqd: 3, profit_iqd: 4 }] }), { price_iqd: 1, options: [{ id: 'o' }] });
  assert.ok(meetsRequirement(principal('admin', 'assistant'), 'admin') && !meetsRequirement(principal('admin', 'assistant'), 'admin:full'));
});

test('health: report shape, deep fan-out within a budget, probe token compare; process and realtime adapters', async () => {
  const dep = { health: async () => ({ ok: true, svc: 'audit', ver: 'v1', checks: {} }) };
  const slow = { health: () => new Promise<never>(() => {}) };
  const r = await healthReport({ svc: 'gateway', ver: 'v2', deps: { audit: dep, analytics: slow }, budgetMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.checks.db, 'skipped');
  assert.deepEqual(r.checks.deps!.map((d) => [d.name, d.ok]), [['audit', true], ['analytics', false]]);
  assert.ok(isHealthProbe(new Headers({ 'x-health-probe': 't0k3n' }), 't0k3n'));
  assert.ok(!isHealthProbe(new Headers({ 'x-health-probe': 't0k3n' }), undefined), 'an unset token never matches');
  assert.deepEqual(legacyHealthBody(), { success: true, status: 'ok' });
  const recorded: string[] = [];
  const cron = new CronSweepRunner(async (name, input) => void recorded.push(`${name}:${input.id}`));
  assert.deepEqual(await cron.start('points_release', { id: 'acc_1', params: {} }), { id: 'acc_1', mode: 'cron' });
  const created: string[] = [];
  const wf = new WorkflowRunner({ KYC_REVIEW: { create: async (o) => void created.push(o.id) } }, cron);
  assert.deepEqual(await wf.start('KYC_REVIEW', { id: 'case_1', params: {} }), { id: 'case_1', mode: 'workflow' });
  assert.deepEqual(await wf.start('points_release', { id: 'acc_2', params: {} }), { id: 'acc_2', mode: 'cron' });
  assert.deepEqual([created, recorded], [['case_1'], ['points_release:acc_1', 'points_release:acc_2']]);
  const disabled = disabledSteps('1, deliverySync');
  assert.ok(!stepEnabled({ index: 1, name: 'outbox' }, disabled) && !stepEnabled({ index: 12, name: 'deliverySync' }, disabled) && stepEnabled({ index: 0, name: 'pump' }, disabled));
  assert.ok(legacyStepDue(30) && !legacyStepDue(31));
  const hub = new MemoryHub();
  await hub.publish('order:1', { type: 'status', at: 'now', data: {} });
  assert.equal(hub.published.length, 1);
  assert.ok(selectHub(undefined) instanceof NoopHub);
});
