/**
 * THE CAPABILITY GUARD (`01-TARGET.md` §3.5).
 *
 * The assessment's HIGH finding was that seven admin surfaces live outside
 * `/api/admin/*` — `/api/kyc/admin`, `/api/wallet/admin`, `/api/support/admin`,
 * `/api/telegram/admin`, `/api/reviews/admin`, `/api/memberships/admin`,
 * `/api/devices/admin` — while `worker/index.ts` mounts its host guard on
 * `/api/admin/*` alone. So this suite does not check a list someone wrote: it
 * DISCOVERS every admin path the core actually mounts (mount prefixes plus
 * every route inside each router whose path names `admin`) and requires the
 * gateway to refuse each of them off the apex, with today's 404 body.
 *
 * A new admin route anywhere in the core fails this test until it has a rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHost } from '@levonis/platform-kit/edge/hosts';
import type { Principal } from '@levonis/contracts/rpc/common';
import { guard, hostAllowedFor, needsFinancialScope } from '../src/capabilities';
import { matchRoute } from '../src/routes';
import { createApp } from '../src/app';
import { coreAdminPaths, makeEnv, req, stubTarget } from './_harness';

const ROOT_DOMAIN = 'levonis-iq.com';
const host = (h: string) => classifyHost(h, ROOT_DOMAIN);

const principal = (over: Partial<Principal> = {}): Principal => ({
  v: 1,
  sub: 'u1',
  sid_hash: 'sid',
  role: 'customer',
  scope: null,
  investor: false,
  tier: 'free',
  locale: 'en',
  host_kind: 'main',
  iat: 0,
  exp: 0,
  cid: 'c',
  ...over,
});

test('every admin path the core mounts is apex-only in the routing table', () => {
  const paths = coreAdminPaths();
  assert.ok(paths.length >= 60, `expected the core's admin surface, saw ${paths.length}`);
  const offenders: string[] = [];
  for (const p of paths) {
    const rule = matchRoute(p, 'POST');
    if (!rule) offenders.push(`${p}: no rule`);
    else if (rule.hosts !== 'main') offenders.push(`${p}: hosts=${rule.hosts}`);
    else if (rule.requires !== 'admin' && rule.requires !== 'admin:full') offenders.push(`${p}: requires=${rule.requires}`);
  }
  assert.deepEqual(offenders, [], `admin surfaces without a main-host, admin-gated rule:\n${offenders.join('\n')}`);
});

test('the money and PII admin surfaces need a non-assistant admin', () => {
  for (const p of ['/api/wallet/admin/withdrawals', '/api/admin/wallet/credit', '/api/admin/wallet-requests', '/api/kyc/admin/queue', '/api/telegram/admin/tg-identities', '/api/reviews/admin/1/reward', '/api/memberships/admin/grant', '/api/admin/farm/config']) {
    const rule = matchRoute(p, 'POST')!;
    const requires = needsFinancialScope(p, 'POST') ? 'admin:full' : rule.requires;
    assert.equal(requires, 'admin:full', p);
  }
  // A user LIST is readable by an assistant; changing a role or a tier is not.
  assert.equal(needsFinancialScope('/api/admin/users', 'GET'), false);
  assert.equal(needsFinancialScope('/api/admin/users/u1', 'PATCH'), true);
  assert.equal(needsFinancialScope('/api/admin/users/u1', 'GET'), false);
});

test('the host rule refuses a merchant storefront and a too-deep host, and allows the operator\'s own deployment', () => {
  assert.equal(hostAllowedFor('main', host('levonis-iq.com')), true);
  assert.equal(hostAllowedFor('main', host('www.levonis-iq.com')), true);
  assert.equal(hostAllowedFor('main', host('ali3d.levonis-iq.com')), false, 'a merchant controls this page');
  assert.equal(hostAllowedFor('main', host('studio.levonis-iq.com')), false, 'a system host is not the platform apex');
  assert.equal(hostAllowedFor('main', host('a.b.levonis-iq.com')), false, 'one wildcard certificate covers one label');
  assert.equal(hostAllowedFor('main', host('levonis-staging.workers.dev')), true, 'a mistyped root domain must not 404 the whole admin API');
  assert.equal(hostAllowedFor('root', host('ali3d.levonis-iq.com')), true, 'a customer shops on a storefront');
});

test('the refusal bodies are today\'s, and in today\'s order: host, then auth, then role, then scope', () => {
  const rule = matchRoute('/api/admin/wallet/credit', 'POST')!;
  const off = guard({ path: '/api/admin/wallet/credit', method: 'POST', host: host('ali3d.levonis-iq.com'), rule, principal: null, enforceIdentity: true });
  assert.deepEqual(off, { status: 404, body: { success: false, error: 'Not found' } });

  const anon = guard({ path: '/api/admin/wallet/credit', method: 'POST', host: host('levonis-iq.com'), rule, principal: null, enforceIdentity: true });
  assert.deepEqual(anon, { status: 401, body: { success: false, error: 'Authentication required', code: 'UNAUTHORIZED' } });

  const customer = guard({ path: '/api/admin/wallet/credit', method: 'POST', host: host('levonis-iq.com'), rule, principal: principal(), enforceIdentity: true });
  assert.deepEqual(customer, { status: 403, body: { success: false, error: 'Administrator access required', code: 'FORBIDDEN' } });

  const assistant = guard({ path: '/api/admin/wallet/credit', method: 'POST', host: host('levonis-iq.com'), rule, principal: principal({ role: 'admin', scope: 'assistant' }), enforceIdentity: true });
  assert.equal(assistant?.status, 403, 'an assistant may not touch money');

  const full = guard({ path: '/api/admin/wallet/credit', method: 'POST', host: host('levonis-iq.com'), rule, principal: principal({ role: 'admin', scope: 'full' }), enforceIdentity: true });
  assert.equal(full, null);

  const owner = guard({ path: '/api/admin/wallet/credit', method: 'POST', host: host('levonis-iq.com'), rule, principal: principal({ role: 'admin', scope: 'owner' }), enforceIdentity: true });
  assert.equal(owner, null);
});

test('while the core still resolves the session, the gateway applies the HOST rule and nothing else', () => {
  const rule = matchRoute('/api/admin/overview', 'GET')!;
  const noPrincipal = guard({ path: '/api/admin/overview', method: 'GET', host: host('levonis-iq.com'), rule, principal: null, enforceIdentity: false });
  assert.equal(noPrincipal, null, 'the core is still the authority on who this is');
  const offApex = guard({ path: '/api/admin/overview', method: 'GET', host: host('ali3d.levonis-iq.com'), rule, principal: null, enforceIdentity: false });
  assert.equal(offApex?.status, 404, 'but the host rule never waits for a principal');
});

test('through the app: every discovered admin path 404s on a merchant host and is forwarded on the apex', async () => {
  const core = stubTarget();
  const env = makeEnv({ CORE: core });
  const app = createApp();
  const sample = coreAdminPaths();
  for (const p of sample) {
    const res = await app.fetch(req(`https://ali3d.levonis-iq.com${p}`), env as unknown as Record<string, unknown>);
    assert.equal(res.status, 404, `${p} answered ${res.status} on a merchant host`);
    assert.deepEqual(await res.json(), { success: false, error: 'Not found' });
  }
  assert.equal(core.calls.length, 0, 'not one of them reached the core');

  const onApex = await app.fetch(req(`https://levonis-iq.com${sample[0]}`), env as unknown as Record<string, unknown>);
  assert.equal(onApex.status, 200);
});

test('a non-admin surface is still served on a storefront — the guard is a capability, not a blanket', async () => {
  const core = stubTarget();
  const env = makeEnv({ CORE: core });
  const app = createApp();
  for (const p of ['/api/products', '/api/cart', '/api/storefront/resolve', '/api/auth/me', '/api/wallet']) {
    const res = await app.fetch(req(`https://ali3d.levonis-iq.com${p}`), env as unknown as Record<string, unknown>);
    assert.equal(res.status, 200, `${p} must still answer on a storefront`);
  }
});

test('main-only customer surfaces stay off storefronts', async () => {
  const core = stubTarget();
  const env = makeEnv({ CORE: core });
  const app = createApp();
  for (const p of ['/api/kyc/upload', '/api/invest/portfolio', '/api/support/tickets', '/api/farm/state']) {
    const res = await app.fetch(req(`https://ali3d.levonis-iq.com${p}`), env as unknown as Record<string, unknown>);
    assert.equal(res.status, 404, `${p} is apex-only`);
  }
});
