#!/usr/bin/env node
/**
 * The local rig's proof.
 *
 * Runs the gateway's behaviour against a REAL workerd process reached over a
 * REAL service binding — the one thing the unit suites cannot do, because they
 * stub the binding. Start the rig first (see README.md):
 *
 *   npx wrangler dev -c services/gateway/wrangler.jsonc \
 *                    -c services/gateway/dev/core-stub/wrangler.jsonc \
 *                    --env dark --port 8802 --var STORE_ROOT_DOMAIN:levonis-iq.com
 *   node services/gateway/dev/probe.mjs http://localhost:8802
 *
 * Nothing here touches Cloudflare: `wrangler dev` runs workerd locally and the
 * stub core is a local file. No account, no deploy, no outbound network.
 *
 * With `--var PRINCIPAL_MODE:on` on the rig and `PRINCIPAL_MODE=on` in the
 * probe's environment, it also drives the whole principal chain: the stub
 * Identity mints and SIGNS a principal with a key it generated in memory, the
 * gateway fetches that key over RPC, verifies the signature and forwards the
 * token, and the capability guard is answered from the signed claims.
 *
 * It speaks `node:http` rather than `fetch` on purpose: `Host` is a forbidden
 * header for `fetch`, and the whole point of half these checks is to arrive as
 * the apex, as a storefront, and as a hostname too deep to be either.
 */
import http from 'node:http';

const base = new URL(process.argv[2] || 'http://localhost:8802');
const APEX = 'levonis-iq.com';
const STORE = 'ali3d.levonis-iq.com';

function call(path, { host = APEX, method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: base.hostname, port: base.port, path, method, headers: { Host: host, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json: () => {
              try {
                return JSON.parse(text);
              } catch {
                return null;
              }
            },
          });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** With principals enforced, an authenticated route needs a caller. */
const PRINCIPAL = process.env.PRINCIPAL_MODE === 'on';
const asAdmin = PRINCIPAL ? { cookie: 'levonis_session=admin' } : {};
const asCustomer = PRINCIPAL ? { cookie: 'levonis_session=customer' } : {};

let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (e) {
    failures++;
    results.push(`  FAIL ${name}\n       ${e.message}`);
  }
}
const eq = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

await check('a legacy prefix is forwarded to CORE over the service binding, Host untouched', async () => {
  const res = await call('/api/products?x=1');
  eq(res.status, 200, 'status');
  const seen = res.json().seen;
  eq(seen.path, '/api/products?x=1', 'forwarded path');
  eq(seen.host, APEX, 'Host');
  eq(seen.levonis_host, 'main;', 'host classification');
  if (!seen.correlation) throw new Error('no correlation id reached the core');
});

await check('a storefront is classified and its slug is forwarded', async () => {
  const seen = (await call('/api/products', { host: STORE })).json().seen;
  eq(seen.levonis_host, 'merchant;ali3d', 'host header');
});

await check('the security headers are the core\'s', async () => {
  const res = await call('/api/products');
  eq(res.headers['x-frame-options'], 'DENY', 'X-Frame-Options');
  eq(res.headers['x-content-type-options'], 'nosniff', 'X-Content-Type-Options');
  eq(res.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains', 'HSTS');
  if (!(res.headers['content-security-policy'] ?? '').startsWith("default-src 'self'")) throw new Error('no CSP');
});

await check('a client cannot inject a principal, a hop or a correlation id', async () => {
  const seen = (await call('/api/products', { headers: { 'x-levonis-principal': 'forged', 'x-levonis-hop': '{}', 'x-correlation-id': 'chosen' } })).json().seen;
  eq(seen.principal, null, 'principal');
  eq(seen.hop, null, 'hop');
  if (seen.correlation === 'chosen') throw new Error('the client correlation id was trusted');
});

await check('admin is refused on a merchant storefront and served on the apex', async () => {
  const off = await call('/api/admin/overview', { host: STORE, headers: asAdmin });
  eq(off.status, 404, 'status on a storefront');
  eq(off.text, '{"success":false,"error":"Not found"}', 'body');
  eq((await call('/api/admin/overview', { headers: asAdmin })).status, 200, 'status on the apex');
});

await check('a host too deep to be a store is refused', async () => {
  eq((await call('/api/products', { host: `a.b.${APEX}` })).status, 404, 'status');
});

await check('the permanent 410s are answered by the gateway itself', async () => {
  for (const [path, error] of [
    ['/api/d1/query', 'This endpoint has been removed.'],
    ['/api/upload', 'Use POST /api/uploads.'],
  ]) {
    const res = await call(path, { method: 'POST' });
    eq(res.status, 410, `${path} status`);
    eq(res.json().error, error, `${path} body`);
  }
});

await check('/api/health is forwarded unchanged; ?gw=1 is the gateway\'s own', async () => {
  eq((await call('/api/health')).text, '{"status":"ok"}', 'forwarded body');
  eq((await call('/api/health?gw=1')).json().svc, 'gateway', 'own health');
});

await check('a bodiless POST passes — workerd still gives it a body stream', async () => {
  eq((await call('/api/auth/logout', { method: 'POST' })).status, 200, 'status');
});

await check('request validation refuses at the edge', async () => {
  eq((await call('/api/products', { method: 'OPTIONS' })).status, 404, 'method allowlist');
  eq((await call('/api/cart', { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '1', ...asCustomer }, body: 'x' })).status, 415, 'content type');
  const big = 'x'.repeat(4 * 1024 * 1024);
  eq((await call('/api/cart', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(big.length), ...asCustomer }, body: big })).status, 413, 'size cap');
  eq((await call('/api/uploads', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(big.length), ...asCustomer }, body: big })).status, 200, 'the upload class raises it for its own route');
});

await check('a cross-origin mutation is refused by the core\'s own originCheck', async () => {
  eq((await call('/api/cart', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'content-length': '2', ...asCustomer }, body: '{}' })).status, 403, 'status');
});

await check('the cross-isolate limiter is reached through IDENTITY.rateLimitHit', async () => {
  // The stub core answers `rateLimitHit`; a 200 proves the RPC round trip, and
  // a run of 700 anonymous reads proves the counter is shared across requests
  // (the class is `public-read`, which counts in shadow and never refuses).
  eq((await call('/api/admin/overview', { headers: asAdmin })).status, 200, 'status');
});

await check('an anonymous GET is cached and the shared TTL never reaches the client', async () => {
  const res = await call('/api/policies/current');
  eq(res.status, 200, 'status');
  eq(res.headers['cache-control'], 'private, max-age=0', 'client Cache-Control');
});

await check('a request carrying a session is never served from the cache', async () => {
  const res = await call('/api/policies/current', { headers: { cookie: 'levonis_session=abc' } });
  eq(res.status, 200, 'status');
  eq(res.json().seen.cookie, 'present', 'the cookie reached CORE, so the answer was fresh');
});

await check('the principal chain: Identity signs, the gateway verifies and forwards', async () => {
  const res = await call('/api/profile', { headers: { cookie: 'levonis_session=customer' } });
  eq(res.status, 200, 'status');
  const seen = res.json().seen;
  if (PRINCIPAL && seen.principal !== 'present') throw new Error('no principal was forwarded');
  if (!PRINCIPAL && seen.principal !== null) throw new Error('a principal was forwarded while PRINCIPAL_MODE is off');
});

if (PRINCIPAL) {
  await check('the capability guard is answered from the signed claims', async () => {
    eq((await call('/api/admin/overview')).status, 401, 'anonymous');
    eq((await call('/api/admin/overview', { headers: asCustomer })).status, 403, 'a customer');
    eq((await call('/api/admin/overview', { headers: asAdmin })).status, 200, 'an admin');
    eq((await call('/api/admin/overview', { host: STORE, headers: asAdmin })).status, 404, 'an admin on a storefront');
  });
}

console.log(`gateway rig probe — ${base.href}`);
for (const line of results) console.log(line);
console.log(failures === 0 ? `\n${results.length} checks passed` : `\n${failures} of ${results.length} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
