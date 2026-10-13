/**
 * LEAK AUDIT — cache-headers: the owner's PRINT-SERVICE MARGIN and the inputs
 * of the print price calculation are put in the SHARED caches by the anonymous
 * public-settings answer, served from there to every visitor, and outlive the
 * owner's own change on every host the write did not come from.
 *
 * The owner's rule: anyone other than the main admin / super admin receives
 * ONLY the final price — never a margin, never an engine input, never an
 * intermediate value of the pricing chain — and not from a cache either.
 * `printServicePricing` is `margin_percent` (the markup the calculator adds),
 * `machine_iqd_per_hour` and `setup_fee_iqd` (two inputs it is applied to).
 * It is in PUBLIC_SETTING_KEYS (worker/lib/settings.ts), so:
 *
 *   1. COLO CACHE. GET /api/settings/public is session-free and goes through
 *      `anonymousCached` (worker/routes/misc.ts): the guest's 200 is stamped
 *      `public, max-age=60, s-maxage=120, stale-while-revalidate=600` and
 *      `caches.default.put` under `https://<host>/api/settings/public`; the
 *      next visitor is answered from that one stored body.
 *   2. STALE AFTER THE OWNER'S WRITE. The settings PUT purges only
 *      `pathsChangedBySetting('printServicePricing')` = ['/api/settings/public']
 *      and only on the request's own host (`afterSettingsWrite` →
 *      `purgeAnonymousCache(originOf(c))`). The www host's entry, and the
 *      apex's /api/home entry (which carries the same public settings), keep
 *      serving the withdrawn margin.
 *   3. DARK GATEWAY. services/gateway/src/cache.ts has /api/settings/public on
 *      CACHE_ALLOWLIST (ttl 30) and the route row is `cacheable`, so the
 *      gateway would store the same body for every anonymous caller.
 *
 * Exercised on the real Worker (worker/index.ts fetch) as a signed-out visitor,
 * with a stand-in `caches.default` that behaves like the live zone (the same
 * one tests/edgeCachePolicy.test.ts uses); the owner writes through the real
 * owner path (PUT /api/admin/settings/printServicePricing).
 *
 * LOCAL ONLY: an in-memory SQLite database with every migration, no network.
 *
 * Run: node --import tsx --test tests/leakAudit_cache-headers_settings_public_print_margin_anon_edge_cached.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { APEX, OWNER, asD1, ctx, freshDb, json, pending, put, stubApp, type Mount } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { adminRoutes } from '../worker/routes/admin';
import { ANONYMOUS_CACHE_CONTROL, pathsChangedBySetting } from '../worker/lib/edgePolicy';
import { CACHE_ALLOWLIST, canCache, canStore } from '../services/gateway/src/cache';
import { matchRoute } from '../services/gateway/src/routes';

const WWW = `www.${APEX}`;

/** The owner's print-service rates — figures no price, id, count or timestamp here can equal. */
const RATES = {
  machine_iqd_per_hour: 8_263,
  setup_fee_iqd: 5_179,
  margin_percent: 29.35,
} as const;
const WITHDRAWN = { machine_iqd_per_hour: null, setup_fee_iqd: null, margin_percent: null };
const PRIVATE_KEYS = Object.keys(RATES);
const EXTRA = {
  numbers: Object.values(RATES) as number[],
  decimals: ['29.35', '8263', '8,263', '5179', '5,179'],
};

/** Every place one of the owner's rates sits in a body: the shared leak walk, each private key with a value, the sentinels in any form. */
function rateLeaks(body: unknown): string[] {
  const out = leaks(body, EXTRA);
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (PRIVATE_KEYS.includes(k) && x !== null && x !== undefined) out.push(`${path}.${k} = ${JSON.stringify(x)}`);
        walk(x, `${path}.${k}`);
      }
    } else if (typeof v === 'number' && EXTRA.numbers.includes(v)) out.push(`${path} = ${v}`);
    else if (typeof v === 'string') for (const t of EXTRA.decimals) if (v.includes(t)) out.push(`${path} ⊃ "${t}"`);
  };
  walk(body, '$');
  return [...new Set(out)];
}

/** `caches.default` as the live zone behaves (tests/edgeCachePolicy.test.ts): a hit says CF-Cache-Status: HIT. */
function zoneCache() {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req: Request) {
      const stored = store.get(req.url);
      if (!stored) return undefined;
      const copy = stored.clone();
      const headers = new Headers(copy.headers);
      headers.set('Cache-Control', (headers.get('Cache-Control') ?? '').replace(/max-age=\d+/, 'max-age=14400'));
      headers.set('CF-Cache-Status', 'HIT');
      return new Response(copy.body, { status: copy.status, headers });
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res);
    },
    async delete(req: Request) {
      return store.delete(req.url);
    },
  };
}

async function withZoneCache(run: (cache: ReturnType<typeof zoneCache>) => Promise<void>) {
  const scope = globalThis as { caches?: unknown };
  const cache = zoneCache();
  scope.caches = { default: cache };
  try {
    await run(cache);
  } finally {
    delete scope.caches;
  }
}

const settle = () => Promise.all(pending.splice(0));

const adminMount: Mount = (a) => {
  a.route('/api/admin', adminRoutes);
};

/** The OWNER writes printServicePricing through the real owner route, on the apex. */
async function ownerSets(raw: DatabaseSync, value: unknown): Promise<void> {
  const res = await put(stubApp(asD1(raw), OWNER, adminMount), '/api/admin/settings/printServicePricing', { value }, { Host: APEX });
  assert.equal(res.status, 200, `the owner could not set the rates: ${JSON.stringify(await json(res))}`);
  await settle();
}

/** The real Worker, as a signed-out visitor. */
async function guestGet(raw: DatabaseSync, host: string, path: string, ip = '9.9.9.9', headers: Record<string, string> = {}) {
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: {
      fetch: async () =>
        new Response('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    },
  };
  const res = await worker.fetch(
    new Request(`https://${host}${path}`, { headers: { Host: host, 'CF-Connecting-IP': ip, ...headers } }),
    env as never,
    ctx
  );
  const text = await res.text();
  await settle();
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) as Record<string, any> };
}

/** The body the colo cache holds for `https://<host><path>`, or null. */
async function storedBody(cache: ReturnType<typeof zoneCache>, host: string, path: string): Promise<Record<string, any> | null> {
  const entry = cache.store.get(`https://${host}${path}`);
  return entry ? ((await entry.clone().json()) as Record<string, any>) : null;
}

// ------------------------------------------------------------------ 1 — colo cache

test('the colo cache never holds the print margin: the anonymous /api/settings/public entry is shared with every visitor', async () => {
  await withZoneCache(async (cache) => {
    const raw = freshDb();
    await ownerSets(raw, RATES);

    // Visitor A fills the colo cache.
    const first = await guestGet(raw, APEX, '/api/settings/public', '9.9.9.9');
    assert.equal(first.status, 200, first.text.slice(0, 300));
    assert.equal(first.body.success, true);
    // The shared policy really applies (browser 60 s, edge 120 s, +600 s stale).
    assert.equal(first.headers.get('Cache-Control'), ANONYMOUS_CACHE_CONTROL, 'the anonymous policy did not apply');
    assert.doesNotMatch(first.headers.get('Vary') ?? '', /cookie/i, 'one body for everyone: no Vary: Cookie');
    const stored = await storedBody(cache, APEX, '/api/settings/public');
    assert.ok(stored, `the guest answer was not stored in caches.default (keys: ${[...cache.store.keys()].join(', ') || 'none'})`);

    // Visitor B — another IP, another language — is answered from that one stored body.
    const second = await guestGet(raw, APEX, '/api/settings/public', '10.20.30.40', { 'Accept-Language': 'en' });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('CF-Cache-Status'), 'HIT', 'the second visitor was not served from the shared entry');
    assert.equal(second.headers.get('Cache-Control'), ANONYMOUS_CACHE_CONTROL);

    const found = rateLeaks(stored);
    assert.deepEqual(
      found,
      [],
      `caches.default entry https://${APEX}/api/settings/public (Cache-Control: ${first.headers.get('Cache-Control')}) ` +
        `holds the owner's print margin / calculation inputs and serves them to every anonymous visitor: ${found.join('; ')}`
    );
    assert.deepEqual(rateLeaks(second.body), [], `the cache HIT served to a second visitor carries: ${rateLeaks(second.body).join('; ')}`);
  });
});

// ------------------------------------------------------------------ 2 — stale after the owner's write

test('after the owner withdraws the print rates, no cached copy on any host or path keeps serving them', async () => {
  await withZoneCache(async (cache) => {
    const raw = freshDb();
    await ownerSets(raw, RATES);

    // Guests on both hosts the Worker answers /api/ on, and the guest first screen.
    for (const [host, path] of [
      [APEX, '/api/settings/public'],
      [WWW, '/api/settings/public'],
      [APEX, '/api/home'],
    ] as const) {
      const r = await guestGet(raw, host, path);
      assert.equal(r.status, 200, `${host}${path}: ${r.text.slice(0, 300)}`);
      assert.ok(cache.store.has(`https://${host}${path}`), `${host}${path} was not stored`);
    }

    // The owner withdraws the rates on the apex. The seam purges ONLY these paths, ONLY on the apex.
    await ownerSets(raw, WITHDRAWN);
    assert.deepEqual(pathsChangedBySetting('printServicePricing'), ['/api/settings/public']);
    assert.equal(cache.store.has(`https://${APEX}/api/settings/public`), false, 'precondition: the apex settings entry was purged');

    // A fresh build no longer carries the rates — so whatever still does is a cached copy.
    const fresh = await guestGet(raw, APEX, '/api/settings/public');
    assert.equal(fresh.headers.get('CF-Cache-Status'), null, 'the apex answer is rebuilt after the purge');
    assert.deepEqual(rateLeaks(fresh.body), [], 'precondition: the withdrawn rates are gone from a fresh build');

    const stale: string[] = [];
    for (const [host, path] of [
      [WWW, '/api/settings/public'],
      [APEX, '/api/home'],
    ] as const) {
      const r = await guestGet(raw, host, path, '172.16.0.9');
      const found = rateLeaks(r.body);
      if (found.length) stale.push(`${host}${path} [CF-Cache-Status: ${r.headers.get('CF-Cache-Status')}; Cache-Control: ${r.headers.get('Cache-Control')}] → ${found.join('; ')}`);
    }
    assert.deepEqual(
      stale,
      [],
      `the owner withdrew printServicePricing, yet anonymous visitors are still served the old margin / rates from the colo cache: ${stale.join(' | ')}`
    );
  });
});

// ------------------------------------------------------------------ 3 — dark gateway cache

test('the dark gateway would not store the print margin for anonymous callers', async () => {
  const raw = freshDb();
  await ownerSets(raw, RATES);
  const url = `https://${APEX}/api/settings/public`;
  const r = await guestGet(raw, APEX, '/api/settings/public');
  assert.equal(r.status, 200);

  // The gateway's own decisions, with CACHE_MODE on, for an anonymous GET of this path.
  const rule = matchRoute('/api/settings/public', 'GET');
  assert.equal(rule?.cacheable, true, 'precondition: the gateway route row is cacheable');
  const decision = canCache({ method: 'GET', url, headers: new Headers() }, true);
  assert.ok(decision, 'precondition: the gateway admits an anonymous GET of /api/settings/public to its cache');
  assert.equal(decision.rule, CACHE_ALLOWLIST.find((x) => x.pattern.test('/api/settings/public')));
  const willStore = canStore({ status: r.status, headers: r.headers }, r.text);
  assert.equal(willStore, true, 'precondition: the gateway would store the Worker\'s body');

  const found = rateLeaks(r.body);
  assert.deepEqual(
    found,
    [],
    `the dark gateway stores ${decision.key} for ${decision.rule.ttl}s and serves it to every anonymous caller, with the owner's print margin / rates: ${found.join('; ')}`
  );
});
