/**
 * THE SAFE ANONYMOUS-GET CACHE (`01-TARGET.md` §3.7).
 *
 * The failure mode this suite exists for is serving one customer's body to
 * another, so the tests are written as refusals: a cookie, an Authorization
 * header, a mutation, a path that is not on the allowlist, a `success:false`
 * body and a `Set-Cookie` each independently stop the cache from being read or
 * written. `s-maxage` must never reach the client, and the key must separate
 * hosts and languages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_ALLOWLIST, canCache, canStore, cacheKey, clientCacheControl, hasSessionCookie, langOf, storedCacheControl } from '../src/cache';
import { createApp } from '../src/app';
import { MemoryEdgeCache, makeEnv, req, stubTarget } from './_harness';

const APEX = 'https://levonis-iq.com';
const STORE = 'https://ali3d.levonis-iq.com';

const request = (url: string, init: RequestInit = {}) => req(url, init);

test('only an anonymous GET of an allowlisted path is a candidate', () => {
  assert.ok(canCache(request(`${APEX}/api/products`), true));
  assert.equal(canCache(request(`${APEX}/api/products`), false), null, 'CACHE_MODE off is off');
  assert.equal(canCache(request(`${APEX}/api/products`, { method: 'POST' }), true), null, 'never a mutation');
  assert.equal(canCache(request(`${APEX}/api/products`, { headers: { cookie: 'levonis_session=x' } }), true), null, 'never with a session');
  assert.equal(canCache(request(`${APEX}/api/products`, { headers: { authorization: 'Bearer x' } }), true), null, 'never with Authorization');
  assert.equal(canCache(request(`${APEX}/api/cart`), true), null, 'never off the allowlist');
  assert.equal(canCache(request(`${APEX}/api/products/slug/quote`), true), null, 'a quote prices one caller\'s cart');
  assert.ok(canCache(request(`${APEX}/api/products/some-slug`), true), 'a product page is fine');
  // an unrelated cookie is not a session
  assert.ok(canCache(request(`${APEX}/api/products`, { headers: { cookie: 'lang=ar' } }), true));
  assert.equal(hasSessionCookie('levonis_session_other=1'), false, 'the name must match exactly');
  assert.equal(hasSessionCookie('a=1; levonis_session=x'), true);
});

test('the key separates host, path, sorted query and language', () => {
  const k1 = cacheKey(new URL(`${APEX}/api/products?b=2&a=1`), 'en');
  const k2 = cacheKey(new URL(`${APEX}/api/products?a=1&b=2`), 'en');
  assert.equal(k1, k2, 'query order is not part of the identity');
  assert.notEqual(k1, cacheKey(new URL(`${STORE}/api/products?a=1&b=2`), 'en'), 'a storefront is a different answer');
  assert.notEqual(k1, cacheKey(new URL(`${APEX}/api/products?a=1&b=2`), 'ar'), 'so is a language');
  assert.equal(cacheKey(new URL(`${APEX}/api/products?lang=ar`), 'ar'), cacheKey(new URL(`${APEX}/api/products`), 'ar'), '?lang is folded into the key once');
});

test('the language comes from ?lang, then Accept-Language, then en', () => {
  const h = (v?: string) => new Headers(v ? { 'accept-language': v } : {});
  assert.equal(langOf(new URL(`${APEX}/x?lang=ckb`), h()), 'ckb');
  assert.equal(langOf(new URL(`${APEX}/x?lang=fr`), h('ar-IQ,ar;q=0.9')), 'ar', 'an unsupported ?lang falls through');
  assert.equal(langOf(new URL(`${APEX}/x`), h('fr-FR,fr;q=0.9,en;q=0.8')), 'en');
  assert.equal(langOf(new URL(`${APEX}/x`), h()), 'en');
});

test('a response is stored only when it is a plain, public, successful 200', () => {
  const ok = new Response('{"success":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal(canStore(ok, '{"success":true}'), true);
  assert.equal(canStore(new Response('', { status: 500 }), null), false);
  assert.equal(canStore(new Response('', { status: 401 }), null), false);
  assert.equal(canStore(ok, '{"success":false,"error":"Members only"}'), false, 'a refusal is about the caller, not the URL');
  assert.equal(canStore(new Response('', { status: 200, headers: { 'Set-Cookie': 'a=1' } }), null), false);
  assert.equal(canStore(new Response('', { status: 200, headers: { Vary: 'Cookie' } }), null), false);
});

test('the shared TTL lives on the entry; the client is told private, max-age=0', () => {
  assert.equal(storedCacheControl(60), 'public, s-maxage=60');
  assert.equal(clientCacheControl(), 'private, max-age=0');
  for (const rule of CACHE_ALLOWLIST) assert.ok(rule.ttl > 0 && rule.ttl <= 300, `${rule.pattern}: ${rule.ttl}`);
});

function appWithCache(envOver: Record<string, unknown> = {}) {
  const core = stubTarget(r => new URL(r.url).pathname === '/api/products/cache/revision' ? Response.json({revision:1}) : Response.json({success:true,ok:true}));
  const cache = new MemoryEdgeCache();
  const env = makeEnv({ CORE: core, CACHE_MODE: 'on', ...envOver });
  const app = createApp({ cache });
  return { core, cache, call: (r: Request) => app.fetch(r, env as unknown as Record<string, unknown>) };
}

test('through the app: a second anonymous GET validates the generation and reuses the cached body', async () => {
  const { core, cache, call } = appWithCache();
  const first = await call(request(`${APEX}/api/products?a=1`));
  assert.equal(first.status, 200);
  assert.equal(core.calls.filter(r => !r.url.includes('/cache/revision')).length, 1);
  assert.equal(cache.puts, 1);
  assert.equal([...cache.entries.values()][0].headers.get('Cache-Control'), 'public, s-maxage=60', 'the stored entry carries the shared TTL');
  assert.equal(first.headers.get('Cache-Control'), 'private, max-age=0', 'the client never learns it');

  const second = await call(request(`${APEX}/api/products?a=1`));
  assert.equal(core.calls.filter(r => !r.url.includes('/cache/revision')).length, 1, 'served from the Cache API');
  assert.deepEqual(await second.json(), { success: true, ok: true });
  assert.equal(core.calls.filter(r => r.url.includes('/cache/revision')).length, 2, 'every POP revalidates the primary generation');
  assert.equal(second.headers.get('Cache-Control'), 'private, max-age=0');
});

test('a request carrying a session neither reads nor writes the cache', async () => {
  const { core, cache, call } = appWithCache();
  await call(request(`${APEX}/api/products`));
  assert.equal(cache.puts, 1);
  await call(request(`${APEX}/api/products`, { headers: { cookie: 'levonis_session=abc' } }));
  assert.equal(core.calls.filter(r => !r.url.includes('/cache/revision')).length, 2, 'a signed-in reader always gets a fresh answer');
  assert.equal(cache.puts, 1, 'and never writes one');
});

test('a mutation is never cached, even on a cacheable prefix', async () => {
  const { core, cache, call } = appWithCache();
  await call(request(`${APEX}/api/products/slug/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(cache.puts, 0);
  assert.equal(core.calls.filter(r => !r.url.includes('/cache/revision')).length, 1);
});

test('a success:false body is never stored', async () => {
  const core = stubTarget(() => new Response('{"success":false,"error":"Members only"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const cache = new MemoryEdgeCache();
  const env = makeEnv({ CORE: core, CACHE_MODE: 'on' });
  const app = createApp({ cache });
  await app.fetch(request(`${APEX}/api/bundles`), env as unknown as Record<string, unknown>);
  assert.equal(cache.puts, 0);
});

test('a response that sets a cookie is never stored', async () => {
  const core = stubTarget(() => new Response('{"success":true}', { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'levonis_session=x' } }));
  const cache = new MemoryEdgeCache();
  const env = makeEnv({ CORE: core, CACHE_MODE: 'on' });
  const app = createApp({ cache });
  await app.fetch(request(`${APEX}/api/products`), env as unknown as Record<string, unknown>);
  assert.equal(cache.puts, 0);
});

test('two hosts and two languages are four entries, never one', async () => {
  const { cache, call } = appWithCache();
  await call(request(`${APEX}/api/storefront/resolve`));
  await call(request(`${STORE}/api/storefront/resolve`));
  await call(request(`${APEX}/api/storefront/resolve?lang=ar`));
  await call(request(`${STORE}/api/storefront/resolve?lang=ar`));
  assert.equal(cache.entries.size, 4);
});

test('CACHE_MODE off means the Cache API is never touched', async () => {
  const { cache, core, call } = appWithCache({ CACHE_MODE: 'off' });
  await call(request(`${APEX}/api/products`));
  await call(request(`${APEX}/api/products`));
  assert.equal(cache.puts, 0);
  assert.equal(core.calls.filter(r => !r.url.includes('/cache/revision')).length, 2);
});

/**
 * CACHE POISONING VIA HEAD.
 *
 * Hono answers a HEAD on a GET route with `200`, `content-type:
 * application/json` and an EMPTY body. The cache key carries no method, so a
 * HEAD and a GET of the same URL are one entry. If HEAD were a cache
 * candidate, one anonymous HEAD would store an empty 200 under the GET's key
 * and every anonymous GET would be served nothing for the whole TTL — an
 * unauthenticated, one-request, storefront-wide outage.
 *
 * Two independent refusals close it, and both are asserted: HEAD is not a
 * candidate at all, and an empty body is never stored even if it somehow
 * became one.
 */
test('a HEAD is never a cache candidate — the key has no method in it', () => {
  assert.equal(canCache(request(`${APEX}/api/products`, { method: 'HEAD' }), true), null);
  assert.equal(canCache(request(`${APEX}/api/home`, { method: 'HEAD' }), true), null);
  assert.equal(canCache(request(`${STORE}/api/storefront/resolve`, { method: 'HEAD' }), true), null);
  assert.ok(canCache(request(`${APEX}/api/products`), true), 'the GET is still cacheable');
});

test('an empty 200 body is never stored, whatever produced it', () => {
  const jsonHeaders = new Headers({ 'content-type': 'application/json' });
  assert.equal(canStore({ status: 200, headers: jsonHeaders }, ''), false);
  assert.equal(canStore({ status: 200, headers: jsonHeaders }, '{"success":true}'), true);
});

test('through the app: an anonymous HEAD cannot blank the GET body for the next caller', async () => {
  // The upstream behaves as Hono does: a HEAD on a GET route answers 200 with
  // the JSON content type and an EMPTY body.
  const core = stubTarget((r) =>
    new URL(r.url).pathname === '/api/products/cache/revision' ? Response.json({revision:1}) : r.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ success: true, ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  );
  const cache = new MemoryEdgeCache();
  const env = makeEnv({ CORE: core, CACHE_MODE: 'on' });
  const app = createApp({ cache });
  const call = (r: Request) => app.fetch(r, env as unknown as Record<string, unknown>);

  const head = await call(request(`${APEX}/api/products?a=1`, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(cache.puts, 0, 'a HEAD stores nothing');

  const get = await call(request(`${APEX}/api/products?a=1`));
  assert.deepEqual(await get.json(), { success: true, ok: true }, 'the GET body is intact');
  assert.equal(core.calls.filter(r => !r.url.includes('/cache/revision')).length, 2, 'the GET was answered by the core, not by a poisoned entry');
});

test('a committed deletion invalidates every cached language/query/POP through the primary generation', async () => {
  let revision = 1; let deleted = false; let unavailable = false;
  const core = stubTarget(r => {
    if (new URL(r.url).pathname === '/api/products/cache/revision') return unavailable ? new Response('',{status:503}) : Response.json({revision});
    return deleted ? Response.json({success:false,code:'NOT_FOUND'},{status:404}) : Response.json({success:true,id:'p'});
  });
  const env=makeEnv({CORE:core,CACHE_MODE:'on'});
  const pops=[new MemoryEdgeCache(),new MemoryEdgeCache()];
  const urls=['/api/products/p?lang=ar','/api/products/p?lang=en','/api/products?q=p&lang=ar'];
  for(const cache of pops) for(const path of urls) assert.equal((await createApp({cache}).fetch(request(APEX+path),env as unknown as Record<string,unknown>)).status,200);
  deleted=true;revision++;
  for(const cache of pops) for(const path of urls) assert.equal((await createApp({cache}).fetch(request(APEX+path),env as unknown as Record<string,unknown>)).status,404);
  // A generation outage must bypass the old entries instead of serving them.
  unavailable=true;
  assert.equal((await createApp({cache:pops[0]}).fetch(request(APEX+urls[0]),env as unknown as Record<string,unknown>)).status,404);
});

test('no-store media is never retained by the edge cache',()=>{
  assert.equal(canStore(new Response('bytes',{headers:{'Cache-Control':'no-store','Content-Type':'image/webp'}}),null),false);
});
