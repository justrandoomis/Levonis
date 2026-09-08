/**
 * SESSION → SIGNED PRINCIPAL (`01-TARGET.md` §3.4, ADR-002).
 *
 * The gateway verifies the signature on a principal it just asked Identity
 * for, because that is the same check every callee will make: a rotation the
 * key cache has not seen must fail once, here, on the hop that can still fall
 * back — not as a 403 storm in every service at the same moment.
 *
 * The cache is keyed `(sid_hash, host_kind)` and is skipped for the classes
 * where staleness is expensive (`money`, `admin-write`). Both properties are
 * tested by counting Identity calls, because both are invisible in a response.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrincipal, signPrincipal } from '@levonis/platform-kit/principal';
import { generateKeyPair, importSigningKey, type KeyPairMaterial } from '@levonis/platform-kit/keys';
import { sha256Hex } from '@levonis/contracts/canonical';
import type { HostKind, PrincipalRole, PrincipalScope } from '@levonis/contracts/rpc/common';
import { createApp } from '../src/app';
import { PrincipalCache, cookieValue, sidHashOf } from '../src/principal';
import { makeEnv, req, stubTarget } from './_harness';

const APEX = 'https://levonis-iq.com';
const STORE = 'https://ali3d.levonis-iq.com';
const TOKEN = 'a-session-token';

interface IdentityOptions {
  role?: PrincipalRole;
  scope?: PrincipalScope;
  hostKind?: HostKind | 'echo';
  ttl?: number;
  iatOffset?: number;
  signWith?: KeyPairMaterial;
}

async function stubIdentity(pair: KeyPairMaterial, opts: IdentityOptions = {}) {
  const signing = await importSigningKey((opts.signWith ?? pair).privateKeyB64, (opts.signWith ?? pair).publicKeyB64);
  const state = { resolveCalls: 0, keyCalls: 0 };
  const identity = {
    ...state,
    async resolveSession(input: { sid_hash: string; host_kind: HostKind; cid: string }) {
      identity.resolveCalls++;
      const now = Math.floor(Date.now() / 1000) + (opts.iatOffset ?? 0);
      const p = buildPrincipal(
        {
          sub: 'u1',
          sid_hash: input.sid_hash,
          role: opts.role ?? 'customer',
          scope: opts.scope ?? null,
          investor: false,
          tier: 'free',
          locale: 'en',
          host_kind: opts.hostKind === 'echo' || opts.hostKind === undefined ? input.host_kind : opts.hostKind,
          cid: input.cid,
        },
        now,
        opts.ttl ?? 120
      );
      return { principal: await signPrincipal(signing, p), exp: p.exp };
    },
    async getPublicKeys() {
      identity.keyCalls++;
      return { keys: [{ kid: '', alg: 'EdDSA' as const, public_key: pair.publicKeyB64, service: 'identity', not_after: null }] };
    },
    async revoke() {
      return { revoked: true };
    },
    async rateLimitHit() {
      return { allowed: true, count: 1 };
    },
    async fetch() {
      return new Response('{}', { status: 200 });
    },
    resolveCalls: 0,
    keyCalls: 0,
  };
  return identity;
}

function appWith(identity: Awaited<ReturnType<typeof stubIdentity>>, over: Record<string, unknown> = {}) {
  const core = stubTarget();
  const env = makeEnv({ CORE: core, IDENTITY: identity as never, PRINCIPAL_MODE: 'on', ...over });
  const app = createApp();
  return { core, identity, call: (r: Request) => app.fetch(r, env as unknown as Record<string, unknown>) };
}

const withCookie = (url: string) => req(url, { headers: { cookie: `levonis_session=${TOKEN}; other=1` } });

test('the cookie is hashed exactly as worker/lib/session.ts hashes it', async () => {
  assert.equal(cookieValue('a=1; levonis_session=tok; b=2', 'levonis_session'), 'tok');
  assert.equal(cookieValue('other=1', 'levonis_session'), null);
  assert.equal(await sidHashOf(`levonis_session=${TOKEN}`), await sha256Hex(TOKEN));
  assert.equal(await sidHashOf(null), null);
});

test('a verified principal is forwarded, and it is the token Identity signed', async () => {
  const pair = await generateKeyPair();
  const { core, call } = appWith(await stubIdentity(pair));
  const res = await call(withCookie(`${APEX}/api/profile`));
  assert.equal(res.status, 200);
  const header = core.calls[0].headers['x-levonis-principal'];
  assert.ok(header, 'the principal is forwarded');
  assert.equal(header.split('.').length, 3, 'compact JWS-like form');
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store', 'a principal-bearing response is never shared');
});

test('a principal signed by a key the gateway does not know is dropped, not forwarded', async () => {
  const trusted = await generateKeyPair();
  const attacker = await generateKeyPair();
  const { core, call } = appWith(await stubIdentity(trusted, { signWith: attacker, role: 'admin', scope: 'full' }));
  const res = await call(withCookie(`${APEX}/api/admin/overview`));
  assert.equal(res.status, 401, 'an unverifiable principal is anonymous, and the admin route needs one');
  assert.equal(core.calls.length, 0);
  assert.equal((await res.json() as { code: string }).code, 'UNAUTHORIZED');
});

test('an expired principal is dropped', async () => {
  const pair = await generateKeyPair();
  const { core, call } = appWith(await stubIdentity(pair, { ttl: 1, iatOffset: -3600, role: 'admin', scope: 'full' }));
  const res = await call(withCookie(`${APEX}/api/admin/overview`));
  assert.equal(res.status, 401);
  assert.equal(core.calls.length, 0);
});

test('a principal whose host_kind does not match the request host is dropped', async () => {
  const pair = await generateKeyPair();
  const { core, call } = appWith(await stubIdentity(pair, { hostKind: 'main', role: 'customer' }));
  const onStore = await call(withCookie(`${STORE}/api/profile`));
  assert.equal(onStore.status, 401, 'the apex principal must not be usable on a storefront');
  assert.equal(core.calls.length, 0);
});

test('an admin principal passes the capability guard the core would apply', async () => {
  const pair = await generateKeyPair();
  const full = appWith(await stubIdentity(pair, { role: 'admin', scope: 'full' }));
  assert.equal((await full.call(withCookie(`${APEX}/api/admin/overview`))).status, 200);

  const assistant = appWith(await stubIdentity(pair, { role: 'admin', scope: 'assistant' }));
  assert.equal((await assistant.call(withCookie(`${APEX}/api/admin/overview`))).status, 200, 'an assistant may read the overview');
  const money = await assistant.call(withCookie(`${APEX}/api/admin/wallet/credit`));
  assert.equal(money.status, 403, 'but not credit a wallet');
  assert.equal(assistant.core.calls.length, 1, 'the refusal never reached the core');
});

test('a read class is cached for 30 s; a money class resolves every time', async () => {
  const pair = await generateKeyPair();
  const read = appWith(await stubIdentity(pair));
  await read.call(withCookie(`${APEX}/api/profile`));
  await read.call(withCookie(`${APEX}/api/profile`));
  await read.call(withCookie(`${APEX}/api/profile`));
  assert.equal(read.identity.resolveCalls, 1, 'one lookup for three reads');

  const money = appWith(await stubIdentity(pair));
  await money.call(withCookie(`${APEX}/api/wallet`));
  await money.call(withCookie(`${APEX}/api/wallet`));
  assert.equal(money.identity.resolveCalls, 2, 'money never reads a cached principal');
});

test('the cache is keyed by host kind: the apex principal is not reused on a storefront', async () => {
  const pair = await generateKeyPair();
  const { identity, call, core } = appWith(await stubIdentity(pair));
  await call(withCookie(`${APEX}/api/profile`));
  await call(withCookie(`${STORE}/api/profile`));
  assert.equal(identity.resolveCalls, 2);
  const [apex, store] = core.calls.map((c) => c.headers['x-levonis-principal']);
  assert.notEqual(apex, store, 'two hosts, two principals');
  assert.equal(core.calls[0].headers['x-levonis-host'], 'main;');
  assert.equal(core.calls[1].headers['x-levonis-host'], 'merchant;ali3d');
});

test('no cookie means no lookup at all', async () => {
  const pair = await generateKeyPair();
  const { identity, call, core } = appWith(await stubIdentity(pair));
  const res = await call(req(`${APEX}/api/products`));
  assert.equal(res.status, 200);
  assert.equal(identity.resolveCalls, 0);
  assert.equal(core.calls[0].headers['x-levonis-principal'], undefined);
});

test('PRINCIPAL_MODE=off keeps the core the only session reader — no second lookup per request', async () => {
  const pair = await generateKeyPair();
  const { identity, call, core } = appWith(await stubIdentity(pair), { PRINCIPAL_MODE: 'off' });
  const res = await call(withCookie(`${APEX}/api/admin/overview`));
  assert.equal(res.status, 200, 'the core decides who this is');
  assert.equal(identity.resolveCalls, 0);
  assert.equal(core.calls[0].headers.cookie, `levonis_session=${TOKEN}; other=1`);
});

test('shadow mode resolves a sampled share only — the share is a cost dial, not a switch', async () => {
  const pair = await generateKeyPair();
  const identity = await stubIdentity(pair);
  const core = stubTarget();
  const env = makeEnv({ CORE: core, IDENTITY: identity as never, PRINCIPAL_MODE: 'shadow', PRINCIPAL_SHADOW_RATE: '0.5' });

  // A deterministic sampler: below the rate, then above it.
  const draws = [0.1, 0.9, 0.1, 0.9];
  let i = 0;
  const app = createApp({ random: () => draws[i++ % draws.length] });
  for (let n = 0; n < 4; n++) await app.fetch(withCookie(`${APEX}/api/profile`), env as unknown as Record<string, unknown>);
  assert.equal(identity.resolveCalls, 1, 'the sampled requests resolve once — the second hits the 30-second cache');
  assert.equal(core.calls.filter((c) => c.headers['x-levonis-principal']).length, 2, 'and the core sees the principal beside the cookie, which is what it compares');
  assert.equal(core.calls.length, 4, 'every request is still served');

  const none = makeEnv({ CORE: stubTarget(), IDENTITY: identity as never, PRINCIPAL_MODE: 'shadow', PRINCIPAL_SHADOW_RATE: '0' });
  const before = identity.resolveCalls;
  await createApp().fetch(withCookie(`${APEX}/api/profile`), none as unknown as Record<string, unknown>);
  assert.equal(identity.resolveCalls, before, 'a zero share is off');
});

test('the principal cache evicts by session and clears wholesale, and expires by age', () => {
  let now = 1_000;
  const cache = new PrincipalCache(30_000, 3, () => now);
  const p = buildPrincipal({ sub: 'u1', sid_hash: 's1', role: 'customer', scope: null, investor: false, tier: null, locale: null, host_kind: 'main', cid: 'c' }, 0);
  cache.set('s1', 'main', 'h1', p);
  cache.set('s1', 'merchant', 'h2', p);
  assert.equal(cache.get('s1', 'main')?.header, 'h1');
  assert.equal(cache.get('s1', 'merchant')?.header, 'h2');
  assert.equal(cache.evictSession('s1'), 2, 'SessionRevoked drops every host kind');
  assert.equal(cache.get('s1', 'main'), null);

  cache.set('s2', 'main', 'h3', p);
  now += 30_001;
  assert.equal(cache.get('s2', 'main'), null, 'a 30-second TTL bounds everything the events do not reach');

  now = 2_000;
  cache.set('a', 'main', '1', p);
  cache.set('b', 'main', '2', p);
  cache.set('c', 'main', '3', p);
  cache.set('d', 'main', '4', p);
  assert.equal(cache.size, 3, 'the cap evicts the oldest');
  assert.equal(cache.get('a', 'main'), null);
  cache.clear();
  assert.equal(cache.size, 0);
});
