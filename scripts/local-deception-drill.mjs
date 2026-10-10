#!/usr/bin/env node
/**
 * THE LOCAL DECEPTION DRILL (DECISIONS row 206) — plays a scanner against a
 * LOCAL Worker and checks that it is deceived, then blocked, while a customer
 * from another address is untouched.
 *
 *   npx wrangler d1 migrations apply levonis-db --local
 *   npx wrangler dev --local            (in another terminal)
 *   node scripts/local-deception-drill.mjs http://127.0.0.1:8787
 *
 * NEVER AGAINST PRODUCTION OR ANY LIVE SERVICE: the base must be
 * http://localhost or http://127.0.0.1 (any port), or the drill refuses to
 * start. It sends `CF-Connecting-IP` itself to play two addresses; a local
 * runtime that overwrites the header makes both actors one address, and the
 * drill says so instead of failing.
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
let url;
try {
  url = new URL(base);
} catch {
  console.error(`not a URL: ${base}`);
  process.exit(2);
}
if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
  console.error(`REFUSED: the drill only runs against http://localhost or http://127.0.0.1, never ${url.origin}.`);
  process.exit(2);
}

const ATTACKER = '203.0.113.66';
const CUSTOMER = '198.51.100.66';
const jar = new Map();
let failures = 0;

async function call(path, { ip = ATTACKER, headers = {}, method = 'GET', body } = {}) {
  const h = { 'CF-Connecting-IP': ip, 'User-Agent': 'local-deception-drill/1', ...headers };
  const cookie = ip === ATTACKER && jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : '';
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(new URL(path, url.origin), { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  if (ip === ATTACKER) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const m = /^([^=]+)=([^;]*)/.exec(line);
      if (m) jar.set(m[1], m[2]);
    }
  }
  return { status: res.status, text: await res.text() };
}

function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const robots = await call('/robots.txt');
const disallowed = [...robots.text.matchAll(/^Disallow: (\/\.env|\/\.git\/|\/config\.json|\/backup\.sql)$/gm)].map((m) => m[1]);
check(disallowed.length >= 3, `robots.txt names the decoys (${disallowed.join(', ')})`);

const env = await call('/.env');
check(env.status === 200 && /LEVONIS_API_KEY=lvk_live_/.test(env.text), 'the scanner is DECEIVED: /.env answers fake keys');
check(jar.has('lv_pref'), 'and its browser is tagged on that very answer');
const key = /LEVONIS_API_KEY=(\S+)/.exec(env.text)?.[1] ?? '';

const next = await call('/api/products');
check(next.status === 403 && /ACCESS_BLOCKED/.test(next.text), 'its NEXT request is blocked (ACCESS_BLOCKED)');

jar.clear();
const noTag = await call('/api/products');
check(noTag.status === 403, 'without the tag, the same address is still blocked (anonymous network block)');

const reuse = await call('/api/products', { ip: '192.0.2.200', headers: { 'X-API-Key': key } });
check(reuse.status === 403, 'the stolen key used from another address blocks at once');

const customer = await call('/api/products', { ip: CUSTOMER });
if (customer.status === 403) {
  console.log('note: the local runtime overwrote CF-Connecting-IP — both actors share one address here; check the customer on a deployed preview of your own, never production');
} else {
  check(customer.status === 200, 'a customer from another address is untouched');
}

console.log(failures ? `${failures} check(s) failed` : 'drill passed');
process.exit(failures ? 1 : 0);
