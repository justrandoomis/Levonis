#!/usr/bin/env node
/**
 * THE DARK STACK, END TO END: gateway -> core -> bus -> consumers.
 *
 *   node scripts/dev-stack.mjs                                  # shell 1
 *   node scripts/e2e-dark.mjs --base http://localhost:8799      # shell 2
 *
 *   node scripts/e2e-dark.mjs --all --fresh                     # or: all six
 *                                                               # phases, each
 *                                                               # with its own
 *                                                               # stack, started
 *                                                               # and killed here
 *
 * It drives a REAL authenticated flow through the REAL gateway into the REAL
 * core — register, sign in, add to cart, place the order `scripts/api-tests.mjs`
 * places, with the same product and the same expected total — and then proves,
 * from the consumers' OWN databases and their OWN HTTP surfaces, that the
 * events that flow produced were published, pumped and recorded.
 *
 * WHY IT READS THE DATABASES. Every cheaper way of asking "did the event
 * arrive?" answers a different question. A 200 from the write route proves the
 * core answered. A consumer's `/health` proves it is running. Even a log line
 * proves only that something was attempted. The row in `audit_events` is the
 * only artefact that means the envelope was signed by the core, accepted by the
 * consumer's producer allowlist, validated against the v1 schema, and committed
 * in the same batch as its `processed_events` row — which is the entire
 * contract of `03-EVENTS.md` §2.
 *
 * WHY IT RUNS IN PHASES. `wrangler dev` serves the PRIMARY config on the port
 * and hands the auxiliary ones only `--env` (see `setupDevEnv` in the CLI), so
 * exactly one Worker per run is reachable over HTTP, receives `--var` and
 * answers `--test-scheduled`. Six things have to be driven through their own
 * front door — the gateway, the core's cron, and the four consumers' read
 * surfaces — so the run is six stacks in sequence over ONE shared
 * `--persist-to` directory. The data is continuous across them: phase 1 writes
 * the order, phase 2 replays phase 1's own responses against the core alone to
 * prove the gateway changed nothing, and phases 3-6 read what the events built.
 *
 *   1 gateway       the authenticated flow, the outbox, the request-scoped pump
 *   2 core          read-route parity vs the gateway, then the CRON pump
 *   3 audit         the chain verifies, through the service's own authorisation
 *   4 analytics     the overview counts the events, same path
 *   5 ads           every provider unconfigured: sandbox, nothing sent
 *   6 notifications the inbox the order built, and nothing delivered to anyone
 *
 * It is local-only and account-safe: it talks to `http://localhost` and runs
 * `wrangler d1 execute --local --persist-to`, which reads the files
 * `dev-stack.mjs` migrated. It never deploys, never creates and never probes
 * anything on Cloudflare.
 *
 * `verify-dark.yml` runs the same script against the dark ZONE, where `--base`
 * is `https://<darkroot>`: there only phase 1 applies, the database half is
 * skipped, and the consumers are real Workers whose evidence is their own admin
 * read models.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, importSigningKey, signCompact, buildPrincipal } from './lib/sign.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (flag) => process.argv.includes(flag);

/** The phases, in order, and which Worker has to be primary for each. */
export const PHASES = [
  { name: 'gateway', primary: 'gateway', why: 'the authenticated flow through the front door' },
  { name: 'core', primary: 'core', why: 'read-route parity against the core alone, then the cron pump', testScheduled: true },
  { name: 'audit', primary: 'audit', why: 'the chain, through the service’s own authorisation' },
  { name: 'analytics', primary: 'analytics', why: 'the overview read model' },
  { name: 'ads', primary: 'ads', why: 'the provider registry: sandbox, nothing sent' },
  { name: 'notifications', primary: 'notifications', why: 'the inbox the order built' },
];

const port = arg('--port', '8799');
const base = arg('--base', `http://localhost:${port}`).replace(/\/$/, '');
const persistTo = arg('--persist-to', '.wrangler/dark');
const isLocal = base.startsWith('http://localhost') || base.startsWith('http://127.0.0.1');
const withDb = !has('--no-db') && isLocal;
const phaseName = arg('--phase', 'gateway');
const runAll = has('--all');

if (runAll && !isLocal) {
  console.error('e2e-dark: --all starts and stops local `wrangler dev` stacks, so it needs a localhost base.');
  process.exit(2);
}
if (!PHASES.some((p) => p.name === phaseName)) {
  console.error(`e2e-dark: unknown --phase ${phaseName} (${PHASES.map((p) => p.name).join(', ')})`);
  process.exit(2);
}

// ---------------------------------------------------------------- the journal
/**
 * What one phase leaves for the next: the accounts it opened, their cookies,
 * the ids it created, the responses it recorded for the parity replay, and the
 * ephemeral key pair the consumer phases authenticate with. It lives inside
 * `--persist-to`, which is git-ignored, beside the databases it describes.
 */
const journalPath = join(ROOT, persistTo, 'e2e-journal.json');
function readJournal() {
  try {
    return JSON.parse(readFileSync(journalPath, 'utf8'));
  } catch {
    return null;
  }
}
function writeJournal(j) {
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, JSON.stringify(j, null, 2));
}

// ------------------------------------------------------------------- checking
let failures = 0;
const lines = [];
async function check(name, fn) {
  try {
    const note = await fn();
    lines.push(`  ok   ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    failures++;
    lines.push(`  FAIL ${name}\n       ${e instanceof Error ? e.message : String(e)}`);
  }
}
const eq = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ------------------------------------------------------------------- the wire
/** One cookie jar per role, so the admin and the customer are genuinely different callers. */
const jars = { anon: '', user: '', admin: '' };

async function call(path, init = {}, as = 'anon') {
  const headers = { ...(init.headers ?? {}) };
  if (jars[as]) headers.cookie = jars[as];
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
  // The origin check refuses a cross-site mutation, exactly as it does today.
  if (init.method && init.method !== 'GET') headers.origin = base;
  const res = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && as !== 'anon') jars[as] = setCookie.split(';')[0];
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* the text is the diagnosis */
  }
  return { status: res.status, body, text, headers: res.headers };
}

const json = (path, body, as, method = 'POST') => call(path, { method, body: JSON.stringify(body) }, as);

// ---------------------------------------------------------------- the D1 half
const CONFIG_OF = {
  core: 'wrangler.jsonc',
  audit: 'services/audit/wrangler.jsonc',
  analytics: 'services/analytics/wrangler.jsonc',
  ads: 'services/ads/wrangler.jsonc',
  notifications: 'services/notifications/wrangler.jsonc',
};
const DB_OF = {
  core: 'levonis-db-dark',
  audit: 'levonis-audit-db-dark',
  analytics: 'levonis-analytics-db-dark',
  ads: 'levonis-ads-db-dark',
  notifications: 'levonis-notifications-db-dark',
};

/** Rows from a service's OWN local database — the files `dev-stack.mjs` migrated. */
function sql(service, command) {
  const out = execFileSync(
    'npx',
    [
      '--no-install', 'wrangler', 'd1', 'execute', DB_OF[service],
      '--local', '--persist-to', persistTo,
      '-c', CONFIG_OF[service], '--env', 'dark', '--json', '--command', command,
    ],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  // wrangler decorates stdout; strip the escape sequences before locating the JSON.
  // eslint-disable-next-line no-control-regex
  const clean = out.replace(/\[[0-9;]*m/g, '');
  const parsed = JSON.parse(clean.slice(clean.indexOf('[')));
  return parsed?.[0]?.results ?? [];
}

/** The first column of the first row, as a number — the shape every COUNT(*) here returns. */
const count = (service, command) => Number(Object.values(sql(service, command)[0] ?? { n: 0 })[0] ?? 0);

/** The pump runs in `waitUntil`; give it a few hundred milliseconds, not a fixed sleep. */
async function eventually(what, fn, timeoutMs = 20000) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`${what} did not happen within ${timeoutMs} ms (last: ${last})`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

// =========================================================== phase 1: gateway
/**
 * The read routes whose gateway response is recorded here and replayed against
 * the core alone in phase 2. In Phase 1 EVERY prefix resolves to CORE
 * (`services/gateway/src/routes.ts`: the lowest `flipPhase` is 2), so the
 * gateway is a pure forwarder and "parity" means byte-identical — not
 * "similar". Anything that is not deterministic between two reads of unchanged
 * data does not belong on this list; it belongs in a check of its own.
 */
const PARITY_REQUESTS = [
  { name: 'GET /api/health', method: 'GET', path: '/api/health', as: 'anon' },
  { name: 'GET /api/products', method: 'GET', path: '/api/products', as: 'anon' },
  { name: 'GET /api/policies', method: 'GET', path: '/api/policies', as: 'anon' },
  { name: 'GET /api/settings/public', method: 'GET', path: '/api/settings/public', as: 'anon' },
  { name: 'GET /api/memberships', method: 'GET', path: '/api/memberships', as: 'anon' },
  { name: 'GET an unclaimed prefix (the strangler default)', method: 'GET', path: '/api/not-a-real-route', as: 'anon' },
  { name: 'GET /api/cart (authenticated)', method: 'GET', path: '/api/cart', as: 'user' },
  { name: 'GET /api/orders (authenticated)', method: 'GET', path: '/api/orders', as: 'user' },
  { name: 'GET /api/wallet (authenticated)', method: 'GET', path: '/api/wallet', as: 'user' },
  { name: 'GET /api/rewards (authenticated)', method: 'GET', path: '/api/rewards', as: 'user' },
  { name: 'GET /api/cart without a session (401)', method: 'GET', path: '/api/cart', as: 'anon' },
  { name: 'GET /api/admin/overview as a customer (403)', method: 'GET', path: '/api/admin/overview', as: 'user' },
  { name: 'POST /api/d1/query (the removed endpoint, 410)', method: 'POST', path: '/api/d1/query', as: 'anon', body: { sql: 'SELECT 1' } },
];

/**
 * Headers the GATEWAY is allowed to add or change. Everything else the core
 * sets has to arrive at the client exactly as the core set it — that is what
 * makes putting a Worker in front of the site invisible.
 */
const GATEWAY_MAY_ADD = new Set([
  'x-correlation-id', 'x-levonis-legacy-path', 'date', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'content-encoding', 'vary', 'age', 'cf-cache-status', 'set-cookie',
  // the gateway prepends its own `gw;dur=` segment to whatever the core measured
  'server-timing',
]);

function headerMap(headers) {
  const out = {};
  headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

async function phaseGateway() {
  const rnd = Math.random().toString(36).slice(2, 8);
  /** A query parameter no cache entry can already hold. Every route below ignores it. */
  const fresh = `_e2e=${rnd}`;
  const journal = {
    rnd,
    base,
    userEmail: `dark-user-${rnd}@test.local`,
    adminEmail: `dark-admin-${rnd}@test.local`,
    parity: {},
    pendingBefore: [],
  };

  await check('the GATEWAY is the Worker on the port, and answers its own health', async () => {
    const res = await call('/api/health?gw=1');
    eq(res.status, 200, 'status');
    if (!res.body || (res.body.svc !== 'gateway' && res.body.service !== 'gateway')) {
      throw new Error(`?gw=1 answered ${res.text.slice(0, 200)} — is the gateway the FIRST -c config? (dev-stack.mjs puts it there)`);
    }
    return `svc=${res.body.svc ?? res.body.service}`;
  });

  await check('/api/health is FORWARDED to the core unchanged (01-TARGET.md §3.3)', async () => {
    const res = await call('/api/health');
    eq(res.status, 200, 'status');
    // The CORE answers `{status:"ok"}` (worker/routes/misc.ts) and must keep
    // answering exactly that, byte for byte, for as long as workflow 7's
    // post-deploy probe means what it means today. The gateway answers only
    // `?gw=1` and `?deep=1` itself — so a `svc` field here would mean the
    // gateway had started answering for the core, which is the one thing §3.3
    // forbids.
    eq(res.body?.status, 'ok', "the core's own legacy body");
    eq(res.body?.svc, undefined, 'the gateway must not answer /api/health itself');
    return 'the strangler default reached CORE, unchanged';
  });

  // ------------------------------------------------------------------ accounts
  await check('a write goes through the gateway into the core and opens an account', async () => {
    const res = await json('/api/auth/register', {
      email: journal.userEmail, username: `dku${rnd}`, name: 'Dark Probe', password: 'battery-staple-7',
    }, 'user');
    eq(res.status, 200, `status (body: ${res.text.slice(0, 200)})`);
    eq(res.body?.user?.email, journal.userEmail, 'the account');
    journal.userId = res.body?.user?.id ?? null;
    return journal.userEmail;
  });

  await check('the session the core set survives the gateway (Set-Cookie is not stripped for CORE)', async () => {
    const res = await call('/api/auth/me', {}, 'user');
    eq(res.status, 200, 'status');
    eq(res.body?.user?.email, journal.userEmail, 'the signed-in user');
    return 'cookie round trip';
  });

  await check('signing in again through the gateway issues a working session', async () => {
    const login = await json('/api/auth/login', { email: journal.userEmail, password: 'battery-staple-7' }, 'user');
    eq(login.status, 200, `status (body: ${login.text.slice(0, 200)})`);
    const me = await call('/api/auth/me', {}, 'user');
    eq(me.body?.user?.email, journal.userEmail, 'the signed-in user after re-login');
    return 'POST /api/auth/login -> GET /api/auth/me';
  });

  // The admin half. Promotion happens OUTSIDE the API, exactly the way
  // `scripts/api-tests.mjs` bootstraps one — there is no endpoint that makes an
  // administrator, and there must not be. That needs the database, so on the
  // dark ZONE (`verify-dark.yml`, `--base https://<darkroot>`) this run buys
  // instead of creating: `api-tests.mjs` has already seeded that database and
  // is the step before this one, so the catalogue is there to shop in.
  if (withDb) {
    await check('an administrator can be bootstrapped and reaches the admin surface', async () => {
      const reg = await json('/api/auth/register', {
        email: journal.adminEmail, username: `dka${rnd}`, name: 'Dark Admin', password: 'correct-horse-9',
      }, 'admin');
      eq(reg.status, 200, `register (body: ${reg.text.slice(0, 200)})`);
      journal.adminId = reg.body?.user?.id ?? null;
      sql('core', `UPDATE users SET role='admin' WHERE email='${journal.adminEmail}'`);
      // The session was minted before the promotion, so sign in again: the role
      // is read from `users` on every request, but this proves it end to end.
      const login = await json('/api/auth/login', { email: journal.adminEmail, password: 'correct-horse-9' }, 'admin');
      eq(login.status, 200, 'login after promotion');
      const overview = await call('/api/admin/overview', {}, 'admin');
      eq(overview.status, 200, `GET /api/admin/overview (body: ${overview.text.slice(0, 200)})`);
      return journal.adminEmail;
    });

    // ----------------------------------------------------- the catalogue write
    await check('the admin creates the api-tests product through the gateway', async () => {
      const res = await json('/api/admin/products', {
        name: `Test Printer ${rnd}`, price_iqd: 10000, original_price_iqd: 12000, stock: 3, status: 'active',
        images: ['https://example.com/x.jpg'], membership_prices: { pro: 9000 },
      }, 'admin');
      eq(res.status, 200, `status (body: ${res.text.slice(0, 200)})`);
      journal.productId = res.body?.product?.id ?? null;
      journal.slug = res.body?.product?.slug ?? null;
      must(!!journal.productId, 'no product id in the response');
      return `${journal.productId} (${journal.slug})`;
    });

    await check('the product is visible to an anonymous reader through the gateway', async () => {
      const list = await call('/api/products');
      eq(list.status, 200, 'status');
      must((list.body?.products ?? []).some((p) => p.id === journal.productId), 'the product is not in the public list');
      const detail = await call(`/api/products/${journal.slug}?${fresh}`);
      eq(detail.status, 200, 'detail status');
      must(!('product_cost_iqd' in (detail.body?.product ?? {})), 'the public detail leaked the cost price');
      return 'list + detail, no cost price';
    });
  } else {
    await check('a purchasable product is on the public catalogue (the api-tests seed)', async () => {
      const list = await call('/api/products');
      eq(list.status, 200, 'status');
      const buyable = (list.body?.products ?? []).find((p) => Number(p.stock) >= 2 && Number(p.price_iqd) > 0);
      must(buyable, 'no product with stock — run scripts/api-tests.mjs against this base first, as verify-dark.yml does');
      journal.productId = buyable.id;
      journal.slug = buyable.slug;
      journal.unitPrice = Number(buyable.price_iqd);
      must(!('product_cost_iqd' in buyable), 'the public list leaked the cost price');
      return `${journal.productId} (${journal.slug}), ${journal.unitPrice} IQD, stock ${buyable.stock}`;
    });
  }

  // ---------------------------------------------------------- cart and order
  await check('add to cart, address, and the order api-tests places — same data, same total', async () => {
    const policies = await call('/api/policies');
    const acceptance = (policies.body?.policies ?? []).filter((p) => p.required_for_checkout).map((p) => ({ key: p.key, version: p.version }));
    const cart = await json('/api/cart/items', { productId: journal.productId, qty: 2 }, 'user');
    eq(cart.status, 200, `add to cart (body: ${cart.text.slice(0, 200)})`);
    eq(cart.body?.items?.length, 1, 'cart lines');
    const over = await json('/api/cart/items', { productId: journal.productId, qty: 50 }, 'user');
    eq(over.status, 400, 'a quantity over stock must be refused');
    const address = await json('/api/addresses', {
      label: 'Home', name: 'Test User', phone: '+9647701234567', address: 'Baghdad, Test St 1',
    }, 'user');
    eq(address.status, 200, 'create address');
    journal.addressId = address.body?.id ?? null;

    const idem = `dark-${rnd}-1`;
    const order = await json('/api/orders', {
      policyAcceptance: acceptance, addressId: journal.addressId, deliveryMethodId: 'standard',
      paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], idempotencyKey: idem,
    }, 'user');
    eq(order.status, 200, `place the order (body: ${order.text.slice(0, 300)})`);
    journal.orderId = order.body?.order?.id ?? null;
    must(!!journal.orderId, 'no order id');
    // The number `scripts/api-tests.mjs` asserts on the same data: 2×10 000 +
    // 5 000 shipping, computed by the server, through the gateway. When this
    // run bought a seeded product instead of creating one (the dark zone), the
    // unit price is that product's and the arithmetic is the same.
    const expectedTotal = 2 * (journal.unitPrice ?? 10000) + 5000;
    eq(order.body?.order?.total_iqd, expectedTotal, `the server-computed total (2 × ${journal.unitPrice ?? 10000} + 5000 shipping)`);
    const replay = await json('/api/orders', {
      policyAcceptance: acceptance, addressId: journal.addressId, deliveryMethodId: 'standard',
      paymentMethodId: 'cash', useWallet: false, usePoints: false, itemIds: [], idempotencyKey: idem,
    }, 'user');
    eq(replay.body?.order?.id, journal.orderId, 'the idempotent replay');
    eq(replay.body?.replay, true, 'the replay flag');
    return `${journal.orderId}, total 25000, replay is the same order`;
  });

  await check('the stock the order consumed is gone, and the cart is empty', async () => {
    const cart = await call('/api/cart', {}, 'user');
    eq(cart.body?.items?.length, 0, 'cart lines after the order');
    if (!withDb) {
      // A seeded product's starting stock is not this run's to know, so the
      // exact number is not asserted where this run did not create it. The
      // cart, which is always this run's own, is.
      return 'the cart emptied (this run bought a seeded product, so its stock is not this run’s number to assert)';
    }
    // The query parameter is not decoration. `/api/products/:slug` is on the
    // gateway's anonymous-read allowlist with a 60 s TTL
    // (`services/gateway/src/cache.ts`) and the key is host+path+sorted
    // query+lang — so the copy stored before the order answers `stock: 3` for
    // another minute. A query nothing has asked before is a cache MISS, which
    // is what "read the current row" means through a caching front door. The
    // staleness itself is asserted, on purpose, in the next check.
    const detail = await call(`/api/products/${journal.slug}?${fresh}-after`);
    eq(detail.body?.product?.stock, 1, 'stock after the order');
    return '3 - 2 = 1, and the cart emptied';
  });

  await check('the anonymous read cache is on, and it is the only reason a public read can be stale', async () => {
    // Two identical anonymous GETs of an allowlisted path: the second is a
    // HIT. The client-facing `cache-control` is rewritten to `private,
    // max-age=0` either way, so no browser and no downstream CDN ever holds a
    // shared copy of a body this Worker decided to share (§3.7).
    const key = `/api/products?cachecheck=${journal.rnd}`;
    const first = await call(key);
    eq(first.status, 200, 'the first read');
    const second = await call(key);
    eq(second.status, 200, 'the second read');
    eq(second.text, first.text, 'the two reads');
    eq(second.headers.get('cache-control'), 'private, max-age=0', 'the client-facing cache-control');
    const status = second.headers.get('cf-cache-status');
    // `caches.default` is inert on some local runtimes; when it is present the
    // second read has to be a HIT, and when it is not the check says so rather
    // than passing silently.
    must(status === 'HIT' || status === null, `cf-cache-status on the second read: ${status}`);
    // An authenticated read of the same path must never come from that store.
    const authed = await call(key, {}, 'user');
    must(authed.headers.get('cf-cache-status') !== 'HIT', 'a request carrying the session cookie was served from the shared cache');
    return status === 'HIT' ? 'second read HIT, client copy still private/max-age=0, cookie holders bypass it' : 'the Cache API is inert here; the client copy is private/max-age=0 and cookie holders bypass it';
  });

  // ------------------------------------------------------ the recorded corpus
  await check('every read route answers, and its exact response is recorded for the parity replay', async () => {
    for (const r of PARITY_REQUESTS) {
      // The same cache-busting query on both sides of the comparison: the
      // gateway must not answer phase 2's question from a copy it stored
      // before this run's writes, and the core ignores the parameter.
      const path = `${r.path}${r.path.includes('?') ? '&' : '?'}${fresh}`;
      const res = await call(path, r.body ? { method: r.method, body: JSON.stringify(r.body) } : { method: r.method }, r.as);
      journal.parity[r.name] = { path, method: r.method, as: r.as, body: r.body ?? null, status: res.status, text: res.text, headers: headerMap(res.headers) };
    }
    const statuses = Object.values(journal.parity).map((p) => p.status);
    must(statuses.every((s) => s > 0), 'a recorded request produced no status');
    return `${PARITY_REQUESTS.length} requests recorded`;
  });

  await check('the gateway echoes a correlation id and does not leak an internal header', async () => {
    const res = await call('/api/health');
    const cid = res.headers.get('x-correlation-id');
    must(!!cid, 'no x-correlation-id on the response');
    for (const leaked of ['x-levonis-principal', 'x-levonis-hop', 'x-levonis-challenge']) {
      must(!res.headers.get(leaked), `${leaked} reached the client`);
    }
    return `cid ${cid.slice(0, 8)}…`;
  });

  // ------------------------------------------------------------ the event bus
  if (withDb) {
    await check('the CORE wrote this run’s events to its outbox inside the request', async () =>
      eventually('the outbox rows', () => {
        const types = sql('core', "SELECT event_type, COUNT(*) AS n FROM core_outbox_events GROUP BY event_type")
          .reduce((acc, r) => ({ ...acc, [String(r.event_type)]: Number(r.n) }), {});
        for (const wanted of ['UserCreated', 'CheckoutStarted', 'OrderCreated']) {
          if (!types[wanted]) return null;
        }
        return Object.entries(types).map(([t, n]) => `${t}×${n}`).join(', ');
      })
    );

    await check('the request-scoped pump DELIVERED what it committed, and nothing is dead', async () =>
      eventually('the deliveries', () => {
        const total = count('core', 'SELECT COUNT(*) AS n FROM core_outbox_deliveries');
        if (total === 0) return null;
        const dead = count('core', "SELECT COUNT(*) AS n FROM core_outbox_deliveries WHERE state = 'dead'");
        if (dead > 0) throw new Error(`${dead} delivery/deliveries marked dead — read core_outbox_deliveries.last_error`);
        const acked = count('core', "SELECT COUNT(*) AS n FROM core_outbox_deliveries WHERE state = 'acked'");
        return acked > 0 ? `${acked}/${total} acked` : null;
      })
    );

    await check('AUDIT recorded the order in its own database', async () =>
      eventually('an audit_events row', () => {
        // Audit stores the catalogue KEY (`OrderCreated.v1`); Analytics stores
        // the bare type. Matching a prefix keeps this honest about both.
        const n = count('audit', "SELECT COUNT(*) AS n FROM audit_events WHERE event_type LIKE 'OrderCreated%'");
        if (n === 0) return null;
        const processed = count('audit', 'SELECT COUNT(*) AS n FROM audit_processed_events');
        return `${n} OrderCreated entry/entries, ${processed} processed_events row(s)`;
      })
    );

    await check('ANALYTICS projected the flow, and kept no raw person id', async () =>
      eventually('the analytics_events rows', () => {
        const n = count('analytics', "SELECT COUNT(*) AS n FROM analytics_events WHERE event_type LIKE 'OrderCreated%'");
        if (n === 0) return null;
        // The projection drops every `pii` field and hashes the actor. Neither
        // address this run registered may be anywhere in the store.
        const leaked = count(
          'analytics',
          `SELECT COUNT(*) AS n FROM analytics_events WHERE payload LIKE '%${journal.userEmail}%' OR payload LIKE '%${journal.adminEmail}%' OR actor_hash LIKE '%@%'`
        );
        if (leaked > 0) throw new Error('an address from this run is stored in analytics_events — the PII projection did not run');
        return `${n} OrderCreated event(s), no raw identifier stored`;
      })
    );

    await check('ADS is in SANDBOX: every delivery is terminal, none was sent', async () =>
      eventually('the ads rows', () => {
        const total = count('ads', 'SELECT COUNT(*) AS n FROM ads_deliveries');
        if (total === 0) return null;
        const sent = count('ads', "SELECT COUNT(*) AS n FROM ads_deliveries WHERE status = 'sent'");
        if (sent > 0) throw new Error(`${sent} ads delivery/deliveries say "sent" — no provider is configured, so nothing may leave`);
        const dead = count('ads', 'SELECT COUNT(*) AS n FROM ads_dead_letters');
        if (dead > 0) throw new Error(`${dead} ads dead letter(s)`);
        const byStatus = sql('ads', 'SELECT status, COUNT(*) AS n FROM ads_deliveries GROUP BY status')
          .map((r) => `${r.status}×${r.n}`).join(', ');
        return `${total} deliveries (${byStatus}), 0 sent, 0 dead`;
      })
    );

    await check('NOTIFICATIONS built the inbox and recorded honestly rather than pretending to send', async () =>
      eventually('the notifications rows', () => {
        const processed = count('notifications', 'SELECT COUNT(*) AS n FROM notifications_processed_events');
        if (processed === 0) return null;
        const inbox = count('notifications', 'SELECT COUNT(*) AS n FROM user_notifications');
        if (inbox === 0) return null;
        // With no transport secret and no `IDENTITY.contactFor` binding, the
        // handler writes a `skipped`/`dropped` row saying why. That is the
        // core's own behaviour, kept — and it is what makes the dark stack safe
        // to run: nothing can be mailed to a real person from here.
        const sent = count('notifications', "SELECT COUNT(*) AS n FROM notify_outbox WHERE state = 'sent'");
        if (sent > 0) throw new Error(`${sent} outbox row(s) say "sent" — the dark stack must not be able to deliver to anyone`);
        return `${processed} processed, ${inbox} inbox row(s), 0 sent`;
      })
    );

    await check('what the request pump did NOT deliver is left for the cron, and is named here', async () => {
      // A delivery ROW is created by the dispatcher, not by the publisher, so
      // "waiting for the cron" is `core_outbox_events.dispatched_at IS NULL` —
      // an event nothing has tried yet has no delivery row at all. That is
      // exactly `InventoryChanged`: written inside the order batch and
      // deliberately not pumped (`02-MIGRATION-PLAN.md` slice 1.6, D5), so
      // ANALYTICS always has cron work waiting.
      //
      // AUDIT's side is the audit facade's `pumpAfter` with no `waitUntil`:
      // whether that floating promise finishes before the response ends is up
      // to the runtime, so it is a coin toss, not a contract. In the run where
      // it wins, one already-acked audit delivery is put back the way
      // `BusHandle.redeliver()` puts it back — the DLQ replay path, i.e. a
      // consumer that was down when the request pumped. Either way the cron
      // has a real audit delivery to make.
      const pending = () => sql('core', 'SELECT event_id, event_type FROM core_outbox_events WHERE dispatched_at IS NULL ORDER BY seq');
      const auditWaiting = () => count('core', "SELECT COUNT(*) AS n FROM core_outbox_deliveries WHERE consumer = 'audit' AND state = 'pending'");
      let rearmed = null;
      if (auditWaiting() === 0) {
        const row = sql('core', "SELECT event_id FROM core_outbox_deliveries WHERE consumer = 'audit' ORDER BY rowid DESC LIMIT 1")[0];
        must(row, 'no audit delivery exists at all — audit subscribed to nothing this flow produced');
        rearmed = String(row.event_id);
        const now = new Date().toISOString();
        sql('core', `UPDATE core_outbox_deliveries SET state='pending', attempts=0, next_attempt_at='${now}', last_error='' WHERE event_id='${rearmed}' AND consumer='audit'`);
        sql('core', `UPDATE core_outbox_events SET dispatched_at=NULL WHERE event_id='${rearmed}'`);
      }
      const rows = pending();
      journal.pendingBefore = rows.map((r) => ({ event_id: String(r.event_id), event_type: String(r.event_type) }));
      journal.rearmedAuditEvent = rearmed;
      must(journal.pendingBefore.length > 0, 'nothing is pending, so phase 2 would prove nothing about the cron pump');
      const byType = journal.pendingBefore.reduce((acc, e) => ({ ...acc, [e.event_type]: (acc[e.event_type] ?? 0) + 1 }), {});
      return `${journal.pendingBefore.length} undelivered (${Object.entries(byType).map(([t, n]) => `${t}×${n}`).join(', ')})` +
        (rearmed ? ' — one audit delivery was re-armed through the replay path, because the facade’s floating pump had already finished it' : '');
    });
  } else {
    lines.push('  --   the database assertions were skipped (--no-db, or a non-local base URL)');
  }

  journal.cookies = { user: jars.user, admin: jars.admin };
  writeJournal(journal);
  return journal;
}

/**
 * wrangler's own local trigger for the PRIMARY Worker's `scheduled()` handler
 * (`worker/index.ts` runs `runDurableJobs`, whose step 0 is the event pump —
 * the same entry point the every-fifteen-minutes cron trigger uses).
 *
 * It is retried because the calls around it are separated by `wrangler d1
 * execute` sub-processes that take seconds, which is long enough for the
 * keep-alive socket Node pooled for this origin to be closed at the other end;
 * the reused dead socket surfaces as a bare `fetch failed` with no status. A
 * retry on a TRANSPORT error only — a non-200 is still a failure.
 */
async function triggerCron(which) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${base}/cdn-cgi/local/scheduled`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(30_000) });
      const body = await res.text();
      eq(res.status, 200, `${which} local cron trigger (body: ${body.slice(0, 200)})`);
      return body;
    } catch (e) {
      if (e instanceof Error && /expected|got/.test(e.message)) throw e;
      lastError = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`${which} local cron trigger could not be reached after 3 attempts: ${lastError}`);
}

// ============================================================== phase 2: core
async function phaseCore() {
  const journal = readJournal();
  must(journal, `no journal at ${journalPath} — run the gateway phase first`);
  jars.user = journal.cookies?.user ?? '';
  jars.admin = journal.cookies?.admin ?? '';

  await check('the CORE is the Worker on the port (the gateway is not in front of it)', async () => {
    const res = await call('/api/health');
    eq(res.status, 200, 'status');
    eq(res.body?.status, 'ok', 'the core’s own health body');
    must(!res.headers.get('x-correlation-id'), 'a correlation id means the gateway is still in front — is the core the FIRST -c config?');
    return 'core alone';
  });

  // ------------------------------------------------------------------ parity
  const recorded = Object.entries(journal.parity ?? {});
  must(recorded.length > 0, 'the journal recorded no responses');

  await check(`${recorded.length} read routes answer the same through the gateway and from the core alone`, async () => {
    const diffs = [];
    for (const [name, want] of recorded) {
      const res = await call(want.path, want.body ? { method: want.method, body: JSON.stringify(want.body) } : { method: want.method }, want.as);
      if (res.status !== want.status) diffs.push(`${name}: status ${want.status} through the gateway, ${res.status} from the core`);
      else if (res.text !== want.text) {
        diffs.push(`${name}: the body differs\n         gateway: ${want.text.slice(0, 160)}\n         core:    ${res.text.slice(0, 160)}`);
      }
    }
    must(diffs.length === 0, `${diffs.length} of ${recorded.length} differ:\n       ${diffs.join('\n       ')}`);
    return 'byte-identical bodies and identical statuses';
  });

  await check('the gateway passed every header the core sets through unchanged', async () => {
    const diffs = [];
    for (const [name, want] of recorded) {
      const res = await call(want.path, want.body ? { method: want.method, body: JSON.stringify(want.body) } : { method: want.method }, want.as);
      const core = headerMap(res.headers);
      for (const [k, v] of Object.entries(core)) {
        if (GATEWAY_MAY_ADD.has(k)) continue;
        if (want.headers[k] !== v) diffs.push(`${name}: ${k} — core "${v}", through the gateway "${want.headers[k] ?? '(absent)'}"`);
      }
    }
    must(diffs.length === 0, `${diffs.length} header difference(s):\n       ${diffs.join('\n       ')}`);
    return 'security headers, content types and cache directives all survive the hop';
  });

  // -------------------------------------------------------------- the cron
  await check('the CRON pump delivers to AUDIT and ANALYTICS what the request pumps left behind', async () => {
    const pendingBefore = journal.pendingBefore ?? [];
    must(pendingBefore.length > 0, 'the journal recorded nothing pending');
    const ids = pendingBefore.map((e) => `'${e.event_id}'`).join(',');
    const analyticsBefore = count('analytics', 'SELECT COUNT(*) AS n FROM analytics_events');
    const auditBefore = count('audit', 'SELECT COUNT(*) AS n FROM audit_events');

    await triggerCron('the first');

    const settled = await eventually('the cron pump to finish', () => {
      const stillPending = count('core', `SELECT COUNT(*) AS n FROM core_outbox_events WHERE event_id IN (${ids}) AND dispatched_at IS NULL`);
      if (stillPending > 0) return null;
      const dead = count('core', `SELECT COUNT(*) AS n FROM core_outbox_deliveries WHERE event_id IN (${ids}) AND state = 'dead'`);
      if (dead > 0) throw new Error(`${dead} of them are dead — read core_outbox_deliveries.last_error`);
      return sql('core', `SELECT consumer, COUNT(*) AS n FROM core_outbox_deliveries WHERE event_id IN (${ids}) AND state = 'acked' GROUP BY consumer`)
        .reduce((acc, r) => ({ ...acc, [String(r.consumer)]: Number(r.n) }), {});
    });
    // The tick has to have reached EVERY consumer that subscribes to something
    // in the pending set — and which consumers those are is read from the
    // dispatcher's own delivery rows rather than assumed. The request-scoped
    // pump now hands `pumpAfter` the inventory events as well as the order's,
    // so what it leaves behind is a function of the run, not a constant: an
    // assertion that named ANALYTICS unconditionally was really asserting that
    // some event had failed to be delivered promptly.
    const expected = sql('core', `SELECT DISTINCT consumer FROM core_outbox_deliveries WHERE event_id IN (${ids})`).map((r) => String(r.consumer));
    must(expected.length > 0, 'the pending events have no subscriber at all');
    for (const consumer of expected) {
      must((settled[consumer] ?? 0) > 0, `the cron acked no delivery to ${consumer.toUpperCase()} (acked: ${JSON.stringify(settled)})`);
    }

    // A consumer that acked without writing anything would be telling a lie the
    // ack cannot tell, so where ANALYTICS was among them its store must grow.
    const analyticsAfter = count('analytics', 'SELECT COUNT(*) AS n FROM analytics_events');
    if (expected.includes('analytics')) {
      must(analyticsAfter > analyticsBefore, `ANALYTICS acked the cron's delivery but stored nothing (${analyticsBefore} -> ${analyticsAfter})`);
    } else {
      eq(analyticsAfter, analyticsBefore, 'analytics_events with nothing pending for it');
    }

    // AUDIT's log is append-only and never holds the same event twice, so what
    // has to be true depends on what the tick delivered: a NEW `AuditRecorded`
    // must appear, and a RE-ARMED one (phase 1's replay path) must not, because
    // `audit_processed_events` already holds it. Both are asserted, neither is
    // optional.
    const auditAfter = count('audit', 'SELECT COUNT(*) AS n FROM audit_events');
    if (!expected.includes('audit')) {
      eq(auditAfter, auditBefore, 'audit_events with nothing pending for it');
    } else if (journal.rearmedAuditEvent) {
      eq(auditAfter, auditBefore, 'audit_events after a re-armed (already processed) delivery');
    } else {
      must(auditAfter > auditBefore, `AUDIT acked the cron's delivery but stored nothing (${auditBefore} -> ${auditAfter})`);
    }
    const distinct = count('audit', 'SELECT COUNT(DISTINCT event_id) AS n FROM audit_events');
    eq(auditAfter, distinct, 'audit_events rows vs distinct event ids');
    return `${pendingBefore.length} event(s) — acked ${Object.entries(settled).map(([c, n]) => `${c}×${n}`).join(', ')}; ` +
      `analytics ${analyticsBefore}→${analyticsAfter}, audit ${auditBefore}→${auditAfter}` +
      (journal.rearmedAuditEvent ? ' (the re-armed entry was refused as already processed, which is the idempotency contract)' : '');
  });

  await check('a second cron tick delivers nothing twice', async () => {
    const auditBefore = count('audit', 'SELECT COUNT(*) AS n FROM audit_events');
    const analyticsBefore = count('analytics', 'SELECT COUNT(*) AS n FROM analytics_events');
    await triggerCron('the second');
    await new Promise((r) => setTimeout(r, 2000));
    eq(count('audit', 'SELECT COUNT(*) AS n FROM audit_events'), auditBefore, 'audit_events after a second tick');
    eq(count('analytics', 'SELECT COUNT(*) AS n FROM analytics_events'), analyticsBefore, 'analytics_events after a second tick');
    const pending = count('core', "SELECT COUNT(*) AS n FROM core_outbox_deliveries WHERE state NOT IN ('acked','dead')");
    eq(pending, 0, 'deliveries still pending after two ticks');
    return `${auditBefore} audit / ${analyticsBefore} analytics row(s), unchanged; 0 pending`;
  });

  // The key material the consumer phases authenticate with. Generated here,
  // handed to `wrangler dev` as `ALLOWED_CALLER_KIDS` — the documented
  // bootstrap path (`packages/platform-kit/src/keys.ts` `fromAllowlist`) — and
  // never printed: `dev-stack.mjs` receives it as a var and the journal lives
  // inside the git-ignored persist directory.
  if (!journal.key) {
    journal.key = await generateKeyPair();
    writeJournal(journal);
  }
  return journal;
}

// ---------------------------------------------------- the consumer phases
/** An Identity-signed principal, as `IdentityEntrypoint.resolveSession` mints one. */
async function principalHeader(journal, over = {}) {
  must(journal.key, 'the journal holds no key pair — run the core phase first');
  const key = await importSigningKey(journal.key.privateKeyB64, journal.key.publicKeyB64);
  const now = Math.floor(Date.now() / 1000);
  return signCompact(key, buildPrincipal({
    sub: journal.adminId ?? 'usr_probe', role: 'admin', scope: 'full', host_kind: 'main',
    cid: `e2e-${journal.rnd}`, ...over,
  }, now));
}

const PRINCIPAL_HEADER = 'x-levonis-principal';

async function phaseAudit() {
  const journal = readJournal();
  must(journal, 'no journal — run the earlier phases first');

  await check('AUDIT answers its own health on the port, and its database check is real', async () => {
    const res = await call('/health');
    eq(res.status, 200, 'status');
    eq(res.body?.svc, 'audit', 'svc');
    eq(res.body?.ok, true, 'ok');
    // `checks.db` is the whole point of probing a dark twin: `SELECT 1`
    // succeeds on an EMPTY database, so a health route that never touches D1
    // says `ok` for a Worker with no tables at all.
    eq(res.body?.checks?.db, 'ok', 'the local D1 — did the migration step run?');
    eq(res.body?.status, 'ok', 'the legacy field is still there');
    return `ver=${res.body?.ver ?? res.body?.version}`;
  });

  await check('the admin read model refuses a caller with no principal', async () => {
    const res = await call('/api/v1/audit/admin/events');
    eq(res.status, 401, 'status');
    return res.body?.code ?? res.text.slice(0, 60);
  });

  await check('it refuses a principal that is not a full-scope administrator', async () => {
    const header = await principalHeader(journal, { role: 'customer', scope: null });
    const res = await call('/api/v1/audit/admin/events', { headers: { [PRINCIPAL_HEADER]: header } });
    eq(res.status, 403, 'status');
    return res.body?.code ?? res.text.slice(0, 60);
  });

  await check('an administrator reads the entries this run produced', async () => {
    const header = await principalHeader(journal);
    const res = await call('/api/v1/audit/admin/events?limit=100', { headers: { [PRINCIPAL_HEADER]: header } });
    eq(res.status, 200, `status (body: ${res.text.slice(0, 200)})`);
    const rows = res.body?.rows ?? [];
    must(rows.length > 0, 'the log is empty');
    must(rows.some((r) => String(r.action).startsWith('OrderCreated') || String(r.target) === journal.orderId || String(r.action).includes('order')),
      `no entry for this run's order (${rows.slice(0, 5).map((r) => r.action).join(', ')})`);
    return `${rows.length} entries`;
  });

  await check('the hash chain verifies from the genesis link to the head', async () => {
    const header = await principalHeader(journal);
    const res = await call('/api/v1/audit/admin/verify', { headers: { [PRINCIPAL_HEADER]: header } });
    eq(res.status, 200, `status (body: ${res.text.slice(0, 200)})`);
    eq(res.body?.ok, true, `the chain (broken at ${res.body?.broken_at ?? 'n/a'})`);
    must(Number(res.body?.checked) > 0, 'nothing was checked, so nothing was proved');
    must(typeof res.body?.head === 'string' && res.body.head.length > 0, 'the verify response carries no head hash');
    return `${res.body.checked} links verified, head ${String(res.body.head).slice(0, 12)}…`;
  });

  return journal;
}

async function phaseAnalytics() {
  const journal = readJournal();
  must(journal, 'no journal — run the earlier phases first');

  await check('ANALYTICS answers its own health on the port, and its database check is real', async () => {
    const res = await call('/health');
    eq(res.status, 200, 'status');
    eq(res.body?.svc, 'analytics', 'svc');
    eq(res.body?.ok, true, 'ok');
    eq(res.body?.checks?.db, 'ok', 'the local D1');
    eq(res.body?.status, 'ok', 'the legacy field is still there');
    return `ver=${res.body?.ver ?? res.body?.version}`;
  });

  await check('the overview refuses a caller with no principal', async () => {
    const res = await call('/api/v1/analytics/admin/overview');
    eq(res.status, 401, 'status');
    return res.body?.code ?? res.text.slice(0, 60);
  });

  await check('the overview counts the events this run produced', async () => {
    const header = await principalHeader(journal);
    const res = await call('/api/v1/analytics/admin/overview', { headers: { [PRINCIPAL_HEADER]: header } });
    eq(res.status, 200, `status (body: ${res.text.slice(0, 300)})`);
    const raw = count('analytics', 'SELECT COUNT(*) AS n FROM analytics_events');
    must(raw > 0, 'the raw table is empty');
    const users = Number(res.body?.users?.total ?? res.body?.users?.created ?? 0);
    const orders = Number(res.body?.orders?.total ?? res.body?.orders?.created ?? 0);
    must(users > 0, `the overview reports no users while ${raw} raw event(s) exist: ${res.text.slice(0, 300)}`);
    must(orders > 0, `the overview reports no orders while ${raw} raw event(s) exist: ${res.text.slice(0, 300)}`);
    return `${raw} raw events → users ${users}, orders ${orders}`;
  });

  await check('the daily read model has a point for today', async () => {
    const header = await principalHeader(journal);
    const res = await call('/api/v1/analytics/admin/daily', { headers: { [PRINCIPAL_HEADER]: header } });
    eq(res.status, 200, `status (body: ${res.text.slice(0, 200)})`);
    const points = res.body?.points ?? [];
    must(points.length > 0, 'no daily points');
    return `${points.length} point(s), metrics ${[...new Set(points.map((p) => p.metric))].slice(0, 6).join(', ')}`;
  });

  return journal;
}

async function phaseAds() {
  const journal = readJournal();
  must(journal, 'no journal — run the earlier phases first');

  await check('ADS answers its own health on the port, and its database check is real', async () => {
    const res = await call('/health');
    eq(res.status, 200, 'status');
    eq(res.body?.svc, 'ads', 'svc');
    eq(res.body?.ok, true, 'ok');
    eq(res.body?.checks?.db, 'ok', 'the local D1');
    return `ver=${res.body?.ver}`;
  });

  await check('the admin surface refuses a caller with no principal', async () => {
    for (const path of ['/api/v1/ads/admin/providers', '/api/v1/ads/admin/deliveries']) {
      const res = await call(path);
      eq(res.status, 401, `${path} status`);
    }
    // …and the mutation most worth protecting: the provider kill switch.
    const flags = await call('/api/v1/ads/admin/flags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ads.providers.meta_capi.enabled', enabled: false }),
    });
    eq(flags.status, 401, 'POST /flags status');
    return 'UNAUTHORIZED on every admin route, including POST /flags';
  });

  await check('every provider is UNCONFIGURED — the service is in sandbox and can reach nobody', async () => {
    const admin = { [PRINCIPAL_HEADER]: await principalHeader(journal) };
    const res = await call('/api/v1/ads/admin/providers', { headers: admin });
    eq(res.status, 200, `status (body: ${res.text.slice(0, 200)})`);
    const providers = res.body?.providers ?? [];
    must(providers.length > 0, 'the registry lists no provider');
    const configured = providers.filter((p) => p.configured).map((p) => p.name);
    must(configured.length === 0, `configured provider(s) in the dark stack: ${configured.join(', ')} — no secret may be set here`);
    const open = providers.filter((p) => p.breaker !== 'closed').map((p) => p.name);
    must(open.length === 0, `provider breaker(s) not closed: ${open.join(', ')}`);
    return `${providers.length} adapters, 0 configured, all breakers closed`;
  });

  await check('the deliveries this run produced are terminal, and none of them was sent', async () => {
    const admin = { [PRINCIPAL_HEADER]: await principalHeader(journal) };
    const res = await call('/api/v1/ads/admin/deliveries?limit=100', { headers: admin });
    eq(res.status, 200, `status (body: ${res.text.slice(0, 200)})`);
    const rows = res.body?.rows ?? res.body?.deliveries ?? [];
    must(rows.length > 0, 'no delivery rows — did phase 1 run against this persist directory?');
    const sent = rows.filter((r) => r.status === 'sent');
    must(sent.length === 0, `${sent.length} delivery/deliveries say "sent"`);
    const byStatus = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    return `${rows.length} deliveries (${Object.entries(byStatus).map(([s, n]) => `${s}×${n}`).join(', ')})`;
  });

  return journal;
}

async function phaseNotifications() {
  const journal = readJournal();
  must(journal, 'no journal — run the earlier phases first');

  await check('NOTIFICATIONS answers its own health on the port, and its database check is real', async () => {
    const res = await call('/health');
    eq(res.status, 200, 'status');
    eq(res.body?.svc, 'notifications', 'svc');
    eq(res.body?.ok, true, 'ok');
    eq(res.body?.checks?.db, 'ok', 'the local D1');
    return `ver=${res.body?.ver}`;
  });

  await check('the inbox refuses a reader it cannot identify', async () => {
    const res = await call('/api/notifications');
    eq(res.status, 401, 'status');
    return res.body?.code ?? res.text.slice(0, 60);
  });

  await check('the order this run placed is in the customer’s inbox', async () => {
    must(journal.userId, 'the journal holds no user id');
    const header = await principalHeader(journal, { sub: journal.userId, role: 'customer', scope: null });
    const res = await call('/api/notifications', { headers: { [PRINCIPAL_HEADER]: header } });
    eq(res.status, 200, `status (body: ${res.text.slice(0, 200)})`);
    const rows = res.body?.notifications ?? [];
    must(rows.length > 0, 'the inbox is empty for the customer who placed the order');
    return `${rows.length} row(s), unread ${res.body?.unread}, kinds ${[...new Set(rows.map((r) => r.kind))].join(', ')}`;
  });

  await check('nothing was delivered to anyone: the outbox holds no sent row', async () => {
    const sent = count('notifications', "SELECT COUNT(*) AS n FROM notify_outbox WHERE state = 'sent'");
    eq(sent, 0, 'notify_outbox rows in state "sent"');
    const byState = sql('notifications', 'SELECT state, COUNT(*) AS n FROM notify_outbox GROUP BY state')
      .map((r) => `${r.state}×${r.n}`).join(', ');
    const deliveries = count('notifications', 'SELECT COUNT(*) AS n FROM notify_deliveries');
    return `outbox ${byState || '(empty)'}, ${deliveries} transport attempt(s)`;
  });

  return journal;
}

const RUNNERS = {
  gateway: phaseGateway,
  core: phaseCore,
  audit: phaseAudit,
  analytics: phaseAnalytics,
  ads: phaseAds,
  notifications: phaseNotifications,
};

// ------------------------------------------------------------------- driving
/** Starts one dev-stack, waits for the port, and returns something that kills it by PID. */
async function startStack(phase, { migrate }) {
  const journal = readJournal();
  const args = [
    join(ROOT, 'scripts', 'dev-stack.mjs'),
    '--primary', phase.primary,
    '--port', port,
    '--persist-to', persistTo,
    ...(migrate ? [] : ['--no-migrate']),
    ...(phase.testScheduled ? ['--test-scheduled'] : []),
    // The consumer phases verify a principal against the bootstrap key list.
    // The key is this run's own, generated in phase 2 and never printed.
    // ALL FOUR consumers need it: Ads' admin surface and the Notifications
    // inbox verify the principal in the Worker, exactly as Audit and Analytics
    // do, so a phase without the key ring gets 401 on every authenticated read
    // — which is the correct answer, and would make the phase prove nothing.
    ...(journal?.key && ['audit', 'analytics', 'ads', 'notifications'].includes(phase.primary)
      ? ['--set', `ALLOWED_CALLER_KIDS=core:${journal.key.kid}:${journal.key.publicKeyB64}`]
      : []),
  ];
  const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 180_000;
  for (;;) {
    if (exited) throw new Error(`dev-stack for phase "${phase.name}" exited before the port answered:\n${log.join('').slice(-2000)}`);
    try {
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      break;
    } catch {
      try {
        await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
        break;
      } catch {
        /* not up yet */
      }
    }
    if (Date.now() > deadline) throw new Error(`dev-stack for phase "${phase.name}" never answered on ${base}:\n${log.join('').slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    pid: child.pid,
    log,
    async stop() {
      if (exited) return;
      // The whole process group: `dev-stack.mjs` spawns `npx wrangler dev`,
      // and killing only the parent leaves workerd holding the port.
      try {
        process.kill(-child.pid, 'SIGINT');
      } catch {
        /* already gone */
      }
      const until = Date.now() + 20_000;
      while (!exited && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      if (!exited) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      // The port has to be free before the next phase binds it.
      const free = Date.now() + 20_000;
      for (;;) {
        try {
          await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        } catch {
          return;
        }
        if (Date.now() > free) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    },
  };
}

// ---------------------------------------------------------------------- main
const started = Date.now();
if (runAll) {
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    console.error('e2e-dark: dist/index.html is missing — run `npm run build` first (the dark core serves the SPA from it).');
    process.exit(2);
  }
  if (has('--fresh')) {
    // A run that starts from rows an earlier run left behind can pass on
    // evidence it did not produce. `--fresh` throws the local state away; the
    // first phase migrates it back.
    rmSync(join(ROOT, persistTo), { recursive: true, force: true });
    console.log(`e2e-dark: ${persistTo} removed — this run starts from empty databases`);
  }
  console.log(`e2e-dark: ${PHASES.length} phases on ${base}, state in ${persistTo}\n`);
  for (const [i, phase] of PHASES.entries()) {
    lines.push(`\n— phase ${i + 1}/${PHASES.length}: ${phase.name} (${phase.why})`);
    let stack = null;
    try {
      stack = await startStack(phase, { migrate: i === 0 });
      lines.push(`  ..   dev-stack pid ${stack.pid}, primary ${phase.primary}`);
      console.log(`e2e-dark: phase ${phase.name} — dev-stack pid ${stack.pid}`);
      await RUNNERS[phase.name]();
    } catch (e) {
      failures++;
      lines.push(`  FAIL phase ${phase.name} could not run\n       ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (stack) await stack.stop();
    }
  }
} else {
  lines.push(`— phase ${phaseName} against ${base}${withDb ? ` (databases under ${persistTo})` : ''}`);
  await RUNNERS[phaseName]();
}

console.log(`\ne2e-dark against ${base}${withDb ? ` (databases under ${persistTo})` : ''}\n`);
console.log(lines.join('\n'));
console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'} in ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failures ? 1 : 0);
