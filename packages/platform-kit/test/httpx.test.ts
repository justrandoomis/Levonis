import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithBudget, validateOutboundUrl, FetchTimeoutError, PROVIDER_BUDGETS } from '../src/httpx';
import { CircuitBreaker } from '../src/rpc';
import { KitError } from '../src/errors';

test('validateOutboundUrl refuses private, loopback, mapped and credentialed addresses (the fetchGuard rules, verbatim)', () => {
  for (const bad of ['http://localhost/x', 'http://localhost./x', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::7f00:1]/', 'ftp://example.com/', 'https://user:pw@example.com/', 'not a url', 'http://a.internal/']) {
    assert.throws(() => validateOutboundUrl(bad), (e: unknown) => e instanceof KitError && e.status === 400, bad);
  }
  assert.equal(validateOutboundUrl('https://api.resend.com/emails').hostname, 'api.resend.com');
});

test('fetchWithBudget: retries on 503 only up to the budget, re-checks the SSRF guard on every redirect hop, times out', async () => {
  let n = 0;
  const responses = [new Response('busy', { status: 503 }), new Response('busy', { status: 503 }), new Response('ok', { status: 200 })];
  const fetchImpl = (async () => responses[n++]) as unknown as typeof fetch;
  const res = await fetchWithBudget('https://api.example.test/x', {}, { timeoutMs: 1000, retries: 2, fetchImpl, sleep: async () => {} });
  assert.equal(res.status, 200);
  assert.equal(n, 3);
  n = 0;
  const gaveUp = await fetchWithBudget('https://api.example.test/x', {}, { timeoutMs: 1000, retries: 1, fetchImpl: (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch, sleep: async () => {} });
  assert.equal(gaveUp.status, 503);
  // a redirect to a private address is refused even though the first hop was fine
  const redirecting = (async (url: string) => (url.includes('example.test') ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }) : new Response('nope'))) as unknown as typeof fetch;
  await assert.rejects(() => fetchWithBudget('https://api.example.test/x', {}, { timeoutMs: 1000, fetchImpl: redirecting }), (e: unknown) => e instanceof KitError && e.status === 400);
  // timeout with fake timers
  let now = 0;
  const timers = { setTimeout: (fn: () => void, ms: number) => { queueMicrotask(() => { now += ms; fn(); }); return 1; }, clearTimeout: () => {} };
  await assert.rejects(() => fetchWithBudget('https://api.example.test/slow', {}, { timeoutMs: 50, fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch, timers, clock: { now: () => now } }), FetchTimeoutError);
  assert.equal(PROVIDER_BUDGETS.alwaseet.retries, 0, 'courier calls are never retried');
});

test('a provider breaker opens after 5 failures and fails fast with 503 DEPENDENCY_UNAVAILABLE', async () => {
  let t = 0;
  const breaker = new CircuitBreaker({}, { now: () => t });
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  for (let i = 0; i < 5; i++) await assert.rejects(() => fetchWithBudget('https://api.telegram.org/bot/x', {}, { timeoutMs: 100, fetchImpl: down, breaker, provider: 'telegram' }));
  await assert.rejects(() => fetchWithBudget('https://api.telegram.org/bot/x', {}, { timeoutMs: 100, fetchImpl: down, breaker, provider: 'telegram' }), (e: unknown) => e instanceof KitError && e.code === 'DEPENDENCY_UNAVAILABLE');
  t = 30_000;
  const ok = await fetchWithBudget('https://api.telegram.org/bot/x', {}, { timeoutMs: 100, fetchImpl: (async () => new Response('ok')) as unknown as typeof fetch, breaker, provider: 'telegram' });
  assert.equal(ok.status, 200);
  assert.equal(breaker.state, 'closed');
});
