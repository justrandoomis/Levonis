/**
 * The pipeline, driven end to end through the REAL Hono app (`src/app.ts`) —
 * the core's `securityHeaders()`, the core's `originCheck()`, the host
 * classification and every step of `01-TARGET.md` §3.2 — with a stub Worker
 * standing in for the binding.
 *
 * What these tests are actually protecting:
 *   - the gateway is transparent at phase 1 (same body, same status, plus the
 *     headers the design adds and nothing else);
 *   - the security headers it emits are the core's, from the same source;
 *   - no client-supplied internal header, correlation id or cookie reaches a
 *     Worker that must not see it;
 *   - the refusals a request can earn happen before anything expensive does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATIC_SECURITY_HEADERS, STRICT_TRANSPORT_SECURITY, spaCsp } from '@levonis/platform-kit/edge/securityPolicy';
import { NonceSet, verifyHop } from '@levonis/platform-kit/hop';
import { KeyRing, generateKeyPair } from '@levonis/platform-kit/keys';
import { HTTP_FORWARD_METHOD, forwardArgs } from '@levonis/platform-kit/edge/gatewayOnly';
import { createApp } from '../src/app';
import { DEFAULT_MAX_BODY_BYTES } from '../src/uploadClasses';
import { makeEnv, readCore, req, stubTarget } from './_harness';

const APEX = 'https://levonis-iq.com';
const STORE = 'https://ali3d.levonis-iq.com';

function appWith(envOverrides: Parameters<typeof makeEnv>[0] = {}) {
  const core = stubTarget();
  const env = makeEnv({ CORE: core, ...envOverrides });
  const app = createApp();
  return { app, core, env, call: (r: Request) => app.fetch(r, env as unknown as Record<string, unknown>) };
}

test('a forwarded request keeps its method, URL and body, and the response keeps its status and body', async () => {
  const { core, call } = appWith();
  const res = await call(req(`${APEX}/api/products?x=1`));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, ok: true });
  assert.equal(core.calls.length, 1);
  assert.equal(core.calls[0].url, `${APEX}/api/products?x=1`);
  assert.equal(core.calls[0].headers.host, 'levonis-iq.com', 'the Host header is forwarded untouched');
});

test('the security headers are the CORE\'s, from the one shared source', async () => {
  assert.equal(
    readCore('packages/platform-kit/src/edge/securityPolicy.ts'),
    readCore('worker/lib/securityPolicy.ts'),
    'the kit copy and the core file must stay byte-identical (tests/edgeParity.test.ts pins this too)'
  );
  const { call } = appWith();
  const res = await call(req(`${APEX}/api/products`));
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) assert.equal(res.headers.get(name), value, name);
  assert.equal(res.headers.get('Strict-Transport-Security'), STRICT_TRANSPORT_SECURITY);
  assert.equal(res.headers.get('Content-Security-Policy'), spaCsp());
});

test('a refusal carries the same security headers as a forward — they are set outermost', async () => {
  const { call } = appWith();
  const res = await call(req(`${APEX}/api/d1/query`, { method: 'POST' }));
  assert.equal(res.status, 410);
  assert.deepEqual(await res.json(), { success: false, error: 'This endpoint has been removed.' });
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(res.headers.get('Content-Security-Policy'), spaCsp());
});

test('inbound internal headers and a client correlation id are stripped; the gateway sets its own', async () => {
  const { core, call } = appWith();
  const res = await call(
    req(`${APEX}/api/products`, {
      headers: { 'x-levonis-principal': 'forged', 'x-levonis-host': 'main;', 'x-levonis-hop': '{}', 'x-correlation-id': 'client-chosen' },
    })
  );
  const sent = core.calls[0].headers;
  assert.equal(sent['x-levonis-principal'], undefined, 'a client cannot inject a principal');
  assert.equal(sent['x-levonis-hop'], undefined, 'nor a hop envelope');
  assert.equal(sent['x-levonis-host'], 'main;', 'the gateway sets the host header itself');
  assert.notEqual(sent['x-correlation-id'], 'client-chosen');
  assert.match(sent['x-correlation-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/, 'a fresh UUIDv7');
  assert.equal(res.headers.get('x-correlation-id'), sent['x-correlation-id'], 'and echoes it');
});

test('the Cookie goes to CORE and IDENTITY only, and only they may set one', async () => {
  const catalog = stubTarget(() => new Response('{"success":true}', { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'sneaky=1' } }));
  const core = stubTarget();
  const env = makeEnv({ CORE: core, CATALOG: catalog, GATEWAY_PHASE: '5' });
  const app = createApp();
  const call = (r: Request) => app.fetch(r, env as unknown as Record<string, unknown>);

  const toCatalog = await call(req(`${APEX}/api/products`, { headers: { cookie: 'levonis_session=abc' } }));
  assert.equal(catalog.calls[0].headers.cookie, undefined, 'Catalog never sees the session cookie');
  assert.equal(toCatalog.headers.get('set-cookie'), null, 'and cannot set one');

  await call(req(`${APEX}/api/auth/me`, { headers: { cookie: 'levonis_session=abc' } }));
  assert.equal(core.calls[0].headers.cookie, 'levonis_session=abc', 'the strangler core still receives it');
});

test('a host under the root that is too deep to be a store is refused outright', async () => {
  const { core, call } = appWith();
  const res = await call(req(`https://a.b.levonis-iq.com/api/products`));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Not found' });
  assert.equal(core.calls.length, 0, 'nothing is forwarded');
});

test('GATEWAY_LOCKED refuses everything except a request carrying the probe token', async () => {
  const { core, call } = appWith({ GATEWAY_LOCKED: 'on', HEALTH_PROBE_TOKEN: 'probe-secret-value-not-logged' });
  const locked = await call(req(`${APEX}/api/products`));
  assert.equal(locked.status, 403);
  assert.equal((await locked.json() as { code: string }).code, 'FORBIDDEN');
  assert.equal(core.calls.length, 0);

  const probed = await call(req(`${APEX}/api/products`, { headers: { 'x-health-probe': 'probe-secret-value-not-logged' } }));
  assert.equal(probed.status, 200);
  assert.equal(core.calls.length, 1);

  const wrong = await call(req(`${APEX}/api/products`, { headers: { 'x-health-probe': 'wrong' } }));
  assert.equal(wrong.status, 403);
});

test('/api/health is forwarded unchanged; only ?gw=1 and ?deep=1 are the gateway\'s own', async () => {
  const core = stubTarget(() => new Response('{"status":"ok"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const env = makeEnv({ CORE: core, SVC_VERSION: 'abc1234' });
  const app = createApp();
  const call = (r: Request) => app.fetch(r, env as unknown as Record<string, unknown>);

  const forwarded = await call(req(`${APEX}/api/health`));
  assert.deepEqual(await forwarded.json(), { status: 'ok' }, 'workflow 7 keeps proving the core');
  assert.equal(core.calls.length, 1);

  const own = await call(req(`${APEX}/api/health?gw=1`));
  assert.deepEqual(await own.json(), { success: true, status: 'ok', version: 'abc1234', svc: 'gateway' });
  assert.equal(core.calls.length, 1, 'the gateway answered it itself');

  const deep = await call(req(`${APEX}/api/health?deep=1`));
  assert.equal(deep.status, 404, 'deep health without the probe token does not exist');
});

test('request validation refuses before anything expensive happens', async () => {
  const { core, call } = appWith();
  const cases: Array<[Request, number, string]> = [
    [req(`${APEX}/api/products`, { method: 'OPTIONS' }), 404, 'an unsupported method'],
    // A traversal never survives to the upstream: the URL parser collapses
    // `../` AND its `%2e%2e` spelling (WHATWG dot-segment normalisation), so
    // the request that arrives here is `/secret`, which no row claims. The
    // `..` check in validateRequest is belt and braces for anything that
    // builds a path from strings — validation.test.ts exercises it directly.
    [req(`${APEX}/files/%2e%2e/secret`, { method: 'GET' }), 404, 'a traversal attempt'],
    [req(`${APEX}/files/products/x.png`, { method: 'POST', body: 'x', headers: { 'content-type': 'application/json' } }), 404, 'a mutation on a read-only prefix'],
    [req(`${APEX}/api/cart`, { method: 'POST', body: 'x=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), 415, 'a content type the platform does not speak'],
    [req(`${APEX}/api/cart`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(DEFAULT_MAX_BODY_BYTES + 1) } }), 413, 'a body larger than the class allows'],
  ];
  for (const [request, status, why] of cases) {
    const res = await call(request);
    assert.equal(res.status, status, why);
  }
  assert.equal(core.calls.length, 0, 'none of them reached a Worker');
});

test('a bodiless POST or DELETE — 41 of them in the SPA — passes with no Content-Type', async () => {
  const { core, call } = appWith();
  assert.equal((await call(req(`${APEX}/api/auth/logout`, { method: 'POST' }))).status, 200);
  assert.equal((await call(req(`${APEX}/api/cart/lines/1`, { method: 'DELETE' }))).status, 200);
  assert.equal(core.calls.length, 2);
});

test('an upload class raises the cap only for its own route', async () => {
  const { call } = appWith();
  const big = String(30 * 1024 * 1024);
  const ok = await call(req(`${APEX}/api/uploads`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': big } }));
  assert.equal(ok.status, 200);
  const refused = await call(req(`${APEX}/api/cart`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': big } }));
  assert.equal(refused.status, 413);
});

test('Content-Length and Transfer-Encoding together is smuggling, not a client', async () => {
  const { call } = appWith();
  const res = await call(req(`${APEX}/api/cart`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '2', 'transfer-encoding': 'chunked' }, body: '{}' }));
  assert.equal(res.status, 400);
});

test('a cross-site mutation is refused by the core\'s own originCheck, and by Sec-Fetch-Site when Origin was stripped', async () => {
  const { core, call } = appWith();
  const byOrigin = await call(req(`${APEX}/api/cart`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(byOrigin.status, 403);
  assert.equal((await byOrigin.json() as { error: string }).error, 'Cross-origin request rejected');

  const bySecFetch = await call(req(`${APEX}/api/cart`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(bySecFetch.status, 403);
  assert.equal(core.calls.length, 0);
});

test('a same-origin mutation from a merchant storefront still works — that is what the host classes are for', async () => {
  const { core, call } = appWith();
  const res = await call(req(`${STORE}/api/cart`, { method: 'POST', headers: { origin: STORE, 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(res.status, 200);
  assert.equal(core.calls[0].headers['x-levonis-host'], 'merchant;ali3d');
});

test('the rate limiter refuses with the core\'s own 429 body, and refuses to run at all without a counter', async (t) => {
  // The counter's windows are aligned to the clock (60 s). 602 calls on a slow
  // runner could straddle a minute boundary and start a fresh window, so the
  // clock is held a second into one.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1, 0, 0, 1) });
  const { call } = appWith({ RATE_LIMIT_MODE: 'memory', RATE_LIMIT_ENFORCE: 'public-read' });
  let last = new Response();
  for (let i = 0; i < 602; i++) last = await call(req(`${APEX}/api/products`, { headers: { 'CF-Connecting-IP': '5.5.5.5' } }));
  assert.equal(last.status, 429);
  assert.deepEqual(await last.json(), { success: false, error: 'Too many requests, try again later', code: 'RATE_LIMITED' });

  const unconfigured = appWith({ RATE_LIMIT_MODE: '' });
  const res = await unconfigured.call(req(`${APEX}/api/products`));
  assert.equal(res.status, 503, 'never a silent per-isolate fallback (ADR-016)');
  assert.equal((await res.json() as { code: string }).code, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(unconfigured.core.calls.length, 0);
});

test('a shadow class counts but never refuses', async () => {
  const { call, core } = appWith({ RATE_LIMIT_MODE: 'memory' });
  let last = new Response();
  for (let i = 0; i < 700; i++) last = await call(req(`${APEX}/api/products`, { headers: { 'CF-Connecting-IP': '6.6.6.6' } }));
  assert.equal(last.status, 200);
  assert.equal(core.calls.length, 700);
});

test('with a signing key the forward carries a hop envelope the callee can verify', async () => {
  const pair = await generateKeyPair();
  const { core, call } = appWith({ GATEWAY_SIGNING_KEY: pair.privateKeyB64, GATEWAY_SIGNING_PUBLIC_KEY: pair.publicKeyB64 });
  await call(req(`${APEX}/api/products?a=1`));
  const raw = core.calls[0].headers['x-levonis-hop'];
  assert.ok(raw, 'the hop envelope is attached');
  const ring = new KeyRing();
  await ring.add('gateway', pair.publicKeyB64);
  const verified = await verifyHop({
    hop: JSON.parse(raw),
    method: HTTP_FORWARD_METHOD,
    args: forwardArgs('GET', `${APEX}/api/products?a=1`, 'main;'),
    principalHeader: null,
    allowedIssuers: ['gateway'],
    ring,
    nonces: new NonceSet(),
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  assert.equal(verified.ok, true, `hop rejected: ${JSON.stringify(verified)}`);
});

test('without a signing key nothing hop-shaped is sent — a degraded gateway is visibly degraded', async () => {
  const { core, call } = appWith();
  await call(req(`${APEX}/api/products`));
  assert.equal(core.calls[0].headers['x-levonis-hop'], undefined);
});

test('a target whose Worker is not deployed yet falls back to CORE, and a missing CORE is a 503', async () => {
  const { core, call } = appWith({ GATEWAY_PHASE: '5' });
  const res = await call(req(`${APEX}/api/products`));
  assert.equal(res.status, 200, 'CATALOG is not bound, so the core keeps serving it');
  assert.equal(core.calls.length, 1);

  const app = createApp();
  const env = makeEnv({});
  const bare = await app.fetch(req(`${APEX}/api/products`), env as unknown as Record<string, unknown>);
  assert.equal(bare.status, 503);
});

test('a legacy alias is marked on the way out so the 410 decision has usage data', async () => {
  const { call } = appWith();
  const legacy = await call(req(`${APEX}/api/community/stores`));
  assert.equal(legacy.headers.get('x-levonis-legacy-path'), '1');
  const current = await call(req(`${APEX}/api/products`));
  assert.equal(current.headers.get('x-levonis-legacy-path'), null);
});

test('an internal header set by an upstream never reaches the client', async () => {
  const core = stubTarget(() => new Response('{"success":true}', { status: 200, headers: { 'Content-Type': 'application/json', 'x-levonis-challenge': 'turnstile' } }));
  const env = makeEnv({ CORE: core });
  const res = await createApp().fetch(req(`${APEX}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env as unknown as Record<string, unknown>);
  assert.equal(res.headers.get('x-levonis-challenge'), null);
});
