/**
 * Request validation and the Turnstile hook as pure rules
 * (`01-TARGET.md` §3.2 step 5, §3.8).
 *
 * These are the only checks that run before anything else knows who the caller
 * is, so they are unit-tested here without a Worker, a binding or a network —
 * and the pipeline suite proves the same rules again through the real app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPTED_CONTENT_TYPES, ALLOWED_METHODS, hasBody, hasTraversal, READ_ONLY_PREFIXES, validateRequest } from '../src/validation';
import { CONDITIONAL_ROUTES, ChallengeMarkers, TURNSTILE_ROUTES, challengeKeyFrom, challengeRequired, isChallengedRoute, isEnabled, verifyToken } from '../src/turnstile';
import { GatewayState } from '../src/pipeline';
import { createApp } from '../src/app';
import { makeEnv, req, stubTarget } from './_harness';

const h = (o: Record<string, string> = {}) => new Headers(o);
const check = (method: string, path: string, headers: Record<string, string> = {}, bodyStream = false) => validateRequest({ method, path, headers: h(headers), bodyStream });

test('the method allowlist is the platform\'s six; anything else gets today\'s 404 body', () => {
  assert.deepEqual([...ALLOWED_METHODS], ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
  for (const m of ['OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND', 'PURGE']) {
    const r = check(m, '/api/products');
    assert.equal(r?.status, 404, m);
    assert.deepEqual(r?.body, { success: false, error: 'Not found' });
  }
  assert.equal(check('get', '/api/products'), null, 'the method is compared case-insensitively');
});

test('a read-only prefix answers a mutation the way the core does: it has no such route', () => {
  for (const p of READ_ONLY_PREFIXES) {
    assert.equal(check('POST', `${p}/x`, { 'content-type': 'application/json' }, true)?.status, 404, p);
    assert.equal(check('GET', `${p}/x`), null, p);
  }
  // The prefix must match on a segment boundary, not as a substring.
  assert.equal(check('POST', '/api/homework', { 'content-type': 'application/json' }, true), null);
});

test('traversal is refused raw and percent-encoded', () => {
  assert.equal(hasTraversal('/files/../secret'), true);
  assert.equal(hasTraversal('/files/%2e%2e/secret'), true);
  assert.equal(hasTraversal('/files/%2E%2E/secret'), true);
  assert.equal(hasTraversal('/files/.%2e/secret'), true);
  assert.equal(hasTraversal('/files/products/..png'), false, 'a dot in a filename is not a segment');
  assert.equal(hasTraversal('/api/products/my..slug'), false);
  assert.equal(check('GET', '/files/../x')?.status, 400);
});

test('"has a body" means Content-Length, Transfer-Encoding OR a body stream', () => {
  assert.equal(hasBody(h()), false);
  assert.equal(hasBody(h({ 'content-length': '0' })), false);
  assert.equal(hasBody(h({ 'content-length': '12' })), true);
  assert.equal(hasBody(h({ 'transfer-encoding': 'chunked' })), true);
  assert.equal(hasBody(h(), true), true, 'HTTP/2 needs neither header');
  assert.equal(hasBody(h({ 'content-length': '0' }), true), false, 'workerd hands a bodiless POST a non-null empty stream; a declared 0 is the authority');
  assert.equal(hasBody(h({ 'content-length': '5' }), false), true);
});

test('a bodiless mutation passes with no Content-Type; a typed one must be JSON or multipart', () => {
  assert.equal(check('POST', '/api/auth/logout'), null);
  assert.equal(check('DELETE', '/api/cart/lines/1'), null);
  for (const ct of ACCEPTED_CONTENT_TYPES) assert.equal(check('POST', '/api/cart', { 'content-type': `${ct}; charset=utf-8`, 'content-length': '10' }), null, ct);
  const refused = check('POST', '/api/cart', { 'content-type': 'text/plain', 'content-length': '10' });
  assert.equal(refused?.status, 415);
  assert.equal(refused?.body.code, 'CONTRACT_VIOLATION');
  assert.equal(check('POST', '/api/cart', { 'content-length': '10' })?.status, 415, 'a body with no type at all is not accepted');
});

test('Content-Length together with Transfer-Encoding is refused as smuggling', () => {
  assert.equal(check('POST', '/api/cart', { 'content-length': '10', 'transfer-encoding': 'chunked', 'content-type': 'application/json' })?.status, 400);
  assert.equal(check('GET', '/api/products', { 'content-length': '10', 'transfer-encoding': 'chunked' })?.status, 400, 'on a GET too');
});

test('the size cap is per class and only applies to a declared length', () => {
  assert.equal(check('POST', '/api/cart', { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) })?.status, 413);
  assert.equal(check('POST', '/api/uploads', { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(2 * 1024 * 1024) }), null);
  assert.equal(check('POST', '/api/cart', { 'content-type': 'application/json' }, true), null, 'an undeclared length cannot be judged here');
});

// ------------------------------------------------------------- Turnstile

test('Turnstile is off until the secret exists — no route is challenged and nothing is fetched', async () => {
  assert.equal(isEnabled(undefined), false);
  assert.equal(isEnabled(''), false);
  assert.equal(isEnabled('  '), false);
  assert.equal(isEnabled('secret'), true);

  const core = stubTarget();
  const env = makeEnv({ CORE: core });
  const app = createApp({
    fetchImpl: () => {
      throw new Error('Turnstile must not be contacted while it is off');
    },
  });
  const res = await app.fetch(req('https://levonis-iq.com/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env as unknown as Record<string, unknown>);
  assert.equal(res.status, 200);
  assert.equal(core.calls.length, 1);
});

test('with a secret, a flagged route without a token is refused with the sitekey the widget needs', async () => {
  const core = stubTarget();
  const env = makeEnv({ CORE: core, TURNSTILE_SECRET: 'a-secret-referenced-by-name-only', TURNSTILE_SITEKEY: '0xSITEKEY' });
  const app = createApp({ fetchImpl: async () => new Response(JSON.stringify({ success: false, 'error-codes': ['missing-input-response'] }), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
  const res = await app.fetch(req('https://levonis-iq.com/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env as unknown as Record<string, unknown>);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { success: false, error: 'Verification required', code: 'TURNSTILE_REQUIRED', details: { turnstile_sitekey: '0xSITEKEY' } });
  assert.equal(core.calls.length, 0);
});

test('with a secret, a valid token passes and an unflagged route is never challenged', async () => {
  const core = stubTarget();
  const env = makeEnv({ CORE: core, TURNSTILE_SECRET: 'a-secret-referenced-by-name-only' });
  const app = createApp({ fetchImpl: async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
  const ok = await app.fetch(req('https://levonis-iq.com/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-turnstile-token': 't' }, body: '{}' }), env as unknown as Record<string, unknown>);
  assert.equal(ok.status, 200);
  const unflagged = await app.fetch(req('https://levonis-iq.com/api/products'), env as unknown as Record<string, unknown>);
  assert.equal(unflagged.status, 200);
});

test('a Turnstile outage is a refusal, not an exception — and never a silent pass', async () => {
  const v = await verifyToken('secret', 'token', '1.2.3.4', async () => {
    throw new Error('network down');
  });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? '', /unavailable/);
  assert.equal((await verifyToken('secret', '', null, async () => new Response('{}'))).ok, false, 'an empty token is not verified over the network');
});

test('login is challenged only after Identity arms the marker, and asking never arms it', async () => {
  const core = stubTarget((r) =>
    // The core answers the failing login with its internal marker, exactly as
    // Identity will once it owns the route.
    new Response('{"success":false,"error":"Invalid credentials"}', {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...(r.headers.get('x-attempt') === 'third' ? { 'x-levonis-challenge': 'turnstile; key=abc123' } : {}) },
    })
  );
  const env = makeEnv({ CORE: core, TURNSTILE_SECRET: 'a-secret-referenced-by-name-only', TURNSTILE_SITEKEY: '0xSITEKEY' });
  const state = new GatewayState();
  const app = createApp({ state, fetchImpl: async () => new Response(JSON.stringify({ success: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
  const login = (attempt?: string) =>
    app.fetch(
      req('https://levonis-iq.com/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '9.9.9.9', ...(attempt ? { 'x-attempt': attempt } : {}) }, body: '{}' }),
      env as unknown as Record<string, unknown>
    );

  for (let i = 0; i < 4; i++) {
    const res = await login();
    assert.equal(res.status, 401, 'an ordinary failed login is never challenged — asking must not arm the marker');
    assert.equal(res.headers.get('x-levonis-challenge'), null, 'and the internal header never reaches the client');
  }

  const third = await login('third');
  assert.equal(third.status, 401);
  const next = await login();
  assert.equal(next.status, 403, 'the attempt after Identity armed the marker is challenged');
  assert.equal((await next.json() as { code: string }).code, 'TURNSTILE_REQUIRED');
});

test('the marker store is a pure read with a TTL', () => {
  let now = 0;
  const markers = new ChallengeMarkers(1000, () => now);
  assert.equal(markers.isArmed('id:x'), false);
  assert.equal(markers.size, 0, 'asking does not create anything');
  markers.arm('id:x');
  assert.equal(markers.isArmed('id:x'), true);
  now = 1001;
  assert.equal(markers.isArmed('id:x'), false, 'and it expires');
  assert.equal(markers.size, 0);
});

test('the marker is keyed by the caller the gateway can recognise without reading a body', () => {
  assert.equal(challengeKeyFrom('turnstile', '1.2.3.4'), 'ip:1.2.3.4');
  assert.equal(challengeKeyFrom('turnstile; key=abc123', '1.2.3.4'), 'ip:1.2.3.4', 'Identity still counts failures per account; the gateway only decides whether to show a widget');
});

test('the hook list is the design\'s, and login is conditional rather than blanket', () => {
  assert.ok(isChallengedRoute('/api/auth/register', 'POST'));
  assert.ok(isChallengedRoute('/api/wallet', 'POST'));
  assert.ok(isChallengedRoute('/api/marketplace/print/requests/1/publish', 'POST'));
  assert.ok(!isChallengedRoute('/api/auth/register', 'GET'), 'a read is never challenged');
  assert.ok(!isChallengedRoute('/api/auth/login', 'POST'), 'login is not blanket-challenged');
  assert.ok(isChallengedRoute('/api/auth/login', 'POST', CONDITIONAL_ROUTES), 'it is challenged only once Identity says so');
  assert.equal(TURNSTILE_ROUTES.length, 10);
  assert.deepEqual(challengeRequired(undefined).body.details, undefined, 'no sitekey configured, no sitekey advertised');
});
