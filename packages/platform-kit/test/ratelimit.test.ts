import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { MemoryRateLimiter, BindingRateLimiter, D1RpcRateLimiter, LayeredRateLimiter, d1RateLimitHit, rateLimitKey, identifierKey, makeRateLimit, rateLimit } from '../src/ratelimit';
import { KitError } from '../src/errors';
import { memoryDb } from './_sqlite';

test('rateLimitKey and identifierKey behave exactly as the core (user, ip, explicit; hashed identifiers)', async () => {
  assert.equal(rateLimitKey('login', null, '1.2.3.4'), 'login:1.2.3.4');
  assert.equal(rateLimitKey('cart', 'usr_1', '1.2.3.4'), 'cart:u:usr_1');
  assert.equal(rateLimitKey('login', 'usr_1', '1.2.3.4', 'abc'), 'login:k:abc');
  assert.equal(await identifierKey(' Ali@X.com '), await identifierKey('ali@x.com'));
  assert.match(await identifierKey('x'), /^[0-9a-f]{64}$/);
});

test('the D1 window (today SQL, run by Identity) and the memory window count the same way', async () => {
  const { db } = memoryDb('CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);');
  const nowS = 1_800_000_000;
  for (let i = 1; i <= 3; i++) {
    const v = await d1RateLimitHit(db, 'login:1.2.3.4', 3, 600, nowS + i);
    assert.deepEqual(v, { allowed: true, count: i });
  }
  assert.deepEqual(await d1RateLimitHit(db, 'login:1.2.3.4', 3, 600, nowS + 4), { allowed: false, count: 4 });
  assert.deepEqual(await d1RateLimitHit(db, 'login:1.2.3.4', 3, 600, nowS + 600), { allowed: true, count: 1 }, 'a new window resets');
  let ms = nowS * 1000;
  const mem = new MemoryRateLimiter(() => ms);
  for (let i = 1; i <= 3; i++) assert.equal((await mem.hit('auth', 'k', 3, 600)).allowed, true);
  assert.equal((await mem.hit('auth', 'k', 3, 600)).allowed, false);
  ms += 600_000;
  assert.equal((await mem.hit('auth', 'k', 3, 600)).allowed, true);
});

test('adapters: the binding layer is a pre-filter, the D1 RPC layer is the authority; layered stops at the first refusal', async () => {
  const calls: string[] = [];
  const binding = new BindingRateLimiter({ ip: { limit: async () => ({ success: false }) } });
  assert.equal((await binding.hit('ip', 'k', 1, 1)).allowed, false);
  assert.equal((await binding.hit('auth', 'k', 1, 1)).allowed, true, 'an unconfigured class is not limited by this layer');
  const identity = new D1RpcRateLimiter({ rateLimitHit: async (cls, key) => ((calls.push(`${cls}:${key}`)), { allowed: true, count: 1 }) });
  const layered = new LayeredRateLimiter([binding, identity]);
  assert.equal((await layered.hit('ip', 'k', 1, 1)).allowed, false);
  assert.deepEqual(calls, [], 'the authority is not consulted when the first layer refused');
  assert.equal((await layered.hit('auth', 'k', 1, 1)).allowed, true);
  assert.deepEqual(calls, ['auth:k']);
});

test('the rateLimit(c, bucket, limit, window) facade keeps today signature and semantics (429 body), and never falls back to memory silently', async () => {
  type Env = { Bindings: { IDENTITY?: { rateLimitHit(cls: string, key: string, limit: number, w: number): Promise<{ allowed: boolean; count: number }> }; RATE_LIMIT_MODE?: string }; Variables: { user?: { id: string } | null } };
  const hits: string[] = [];
  const app = new Hono<Env>();
  app.onError((e, c) => (e instanceof KitError ? c.json(e.toBody(), e.status as 429) : c.text('boom', 500)));
  app.post('/login', async (c) => {
    await rateLimit(c as never, 'login', 2, 600);
    return c.json({ success: true });
  });
  const env = { IDENTITY: { rateLimitHit: async (cls: string, key: string, limit: number) => ((hits.push(key)), { allowed: hits.length <= limit, count: hits.length }) } };
  const req = () => app.request('http://x/login', { method: 'POST', headers: { 'CF-Connecting-IP': '9.9.9.9' } }, env);
  assert.equal((await req()).status, 200);
  assert.equal((await req()).status, 200);
  const third = await req();
  assert.equal(third.status, 429);
  assert.deepEqual(await third.json(), { success: false, error: 'Too many requests, try again later', code: 'RATE_LIMITED' });
  assert.deepEqual(hits, ['login:9.9.9.9', 'login:9.9.9.9', 'login:9.9.9.9']);
  // no limiter at all: 503, not a per-isolate bucket
  const bare = await app.request('http://x/login', { method: 'POST' }, {});
  assert.equal(bare.status, 503);
  // dark/local opt-in
  const dark = await app.request('http://x/login', { method: 'POST' }, { RATE_LIMIT_MODE: 'memory' });
  assert.equal(dark.status, 200);
  // a limiter chosen by the service's middleware, keyed by user id when signed in
  const seen: string[] = [];
  const app2 = new Hono<Env>();
  const limit = makeRateLimit({ hit: async (_c, key) => ((seen.push(key)), { allowed: true, count: 1 }) });
  app2.use('*', async (c, next) => {
    c.set('user', { id: 'usr_7' });
    await next();
  });
  app2.post('/x', async (c) => {
    await limit(c as never, 'write', 10, 60);
    return c.text('ok');
  });
  await app2.request('http://x/x', { method: 'POST' });
  assert.deepEqual(seen, ['write:u:usr_7']);
});
