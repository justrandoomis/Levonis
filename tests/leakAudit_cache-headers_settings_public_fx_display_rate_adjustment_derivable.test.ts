/**
 * LEAK AUDIT — cache-headers: the anonymous COLO CACHE of /api/settings/public
 * and /api/home holds, and serves to every visitor, a public figure from which
 * the owner's PRIVATE USD/IQD market adjustment is computed exactly.
 *
 * The owner's rule: anyone other than the main admin / super admin receives
 * ONLY the final price — no cost and no step of how a price was computed, and
 * not from a cache either. `fx_rate_pairs.market_adjustment_iqd` is such a
 * step: the fixed number of dinars per dollar the owner adds on top of the
 * IQWealth parallel-market sell (FINANCIAL_FIELDS, worker/lib/adminScope.ts;
 * docs/PRICING.md «The rates»; the brief lists «market adjustment» as private).
 *
 *   pricing_fx_rates.rate_iqd  =  IQWealth parallel-market SELL + market_adjustment_iqd
 *       (packages/pricing/src/fxChain.ts usdIqdCandidate, worker/lib/fx/decide.ts candidateOf)
 *
 * worker/lib/fx/displayRate.ts (getPublicDisplayRate) publishes that sum
 * verbatim as `displayUsdRate`, with `displayUsdRateAttributed: true` whenever
 * the rate came from the provider (so the visitor knows which public figure to
 * subtract). worker/routes/misc.ts spreads it into the `anonymousCached` body
 * of GET /api/settings/public, worker/routes/products.ts into GET /api/home;
 * both are stamped `public, max-age=60, s-maxage=120, stale-while-revalidate=600`
 * and `caches.default.put` under one canonical key per host, so ONE stored body
 * answers every visitor of the colo. The FX purge seam (edgePolicy.ts
 * purgeCatalogueFromJob, settings: true) drops those entries whenever the rate
 * or its source moves, so the cache tracks every change of the adjustment too.
 *
 *     displayUsdRate − IQWealth's published sell  =  market_adjustment_iqd   (exactly)
 *
 * Exercised LOCALLY on the real chain: the owner saves a private adjustment
 * through PUT /api/admin/pricing/rates/fx/USD_IQD/settings, the real scheduler
 * reads a FAKE IQWealth (no network), the owner approves the first value
 * through the real review route; signed-out visitors go through the real
 * Worker (worker/index.ts fetch) with a stand-in `caches.default` that behaves
 * like the live zone (as tests/edgeCachePolicy.test.ts does); every non-owner
 * role of tests/fixtures/roleMatrix.ts reads the same two routes through the
 * stub session. The literal leak scanner (tests/fixtures/costlyProduct.ts
 * `leaks`) passes on every body — it only knows literal values and keys — and
 * tests/publicSettingsDisplayRate.test.ts sets effective = market + adjustment
 * and checks only that the two addends are not spelled out. Neither treats the
 * derivation as a leak; these tests do.
 *
 * LOCAL ONLY: in-memory SQLite with every migration, no request to any host.
 *
 * Run: node --import tsx --test tests/leakAudit_cache-headers_settings_public_fx_display_rate_adjustment_derivable.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { APEX, OWNER, asD1, ctx, freshDb, get, json, pending, post, put, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, fxEnv, market, pairOf } from './fixtures/fx';
import { leaks } from './fixtures/costlyProduct';
import { ROLES } from './fixtures/roleMatrix';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { miscRoutes } from '../worker/routes/misc';
import { homeRoutes } from '../worker/routes/products';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { ANONYMOUS_CACHE_CONTROL } from '../worker/lib/edgePolicy';
import { withCacheEpoch } from '../worker/lib/publicApi/cache';

const BASE = '/api/admin/pricing';
/** IQWealth's published parallel-market SELL — the provider's own public quote, not a Levonis figure. */
const IQWEALTH_SELL = 1653.5;
/** The owner's PRIVATE adjustment (dinars per dollar). */
const PRIVATE_ADJUSTMENT = '26.125';
/** A later private adjustment the owner moves to (IQWealth unchanged). */
const PRIVATE_ADJUSTMENT_2 = '44.875';
/** The anonymous answers the FX purge seam names (pathsChangedBySetting('exchangeRate')). */
const CACHED_PATHS = ['/api/settings/public', '/api/home', '/api/home/sections'] as const;

// ---------------------------------------------------------------- exact decimal-text arithmetic (≤ 8 places)
const SCALE = 8;
const toFixedInt = (s: string): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not decimal text: ${s}`);
  const v = BigInt(m[2]! + (m[3] ?? '').padEnd(SCALE, '0').slice(0, SCALE));
  return m[1] === '-' ? -v : v;
};
const fromFixedInt = (v: bigint): string => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(SCALE + 1, '0');
  const frac = s.slice(s.length - SCALE).replace(/0+$/, '');
  return `${neg ? '-' : ''}${s.slice(0, s.length - SCALE)}${frac ? `.${frac}` : ''}`;
};
const sub = (a: string, b: string) => fromFixedInt(toFixedInt(a) - toFixedInt(b));
const same = (a: string, b: string) => toFixedInt(a) === toFixedInt(b);

/**
 * The visitor's arithmetic on a body: when the shop says its rate is the
 * provider's (attributed), that rate minus the provider's own published sell.
 * Null when the body carries no rate, or a rate the owner typed.
 */
function derivedAdjustment(body: Record<string, any> | null, iqwealthSell: string): string | null {
  const s = body?.settings;
  if (!s || typeof s.displayUsdRate !== 'string' || s.displayUsdRateAttributed !== true) return null;
  return sub(s.displayUsdRate, iqwealthSell);
}

// ---------------------------------------------------------------- `caches.default` as the live zone behaves
function zoneCache() {
  const store = new Map<string, Response>();
  const deleted: string[] = [];
  return {
    store,
    deleted,
    async match(req: Request) {
      const stored = store.get(req.url);
      if (!stored) return undefined;
      const copy = stored.clone();
      const headers = new Headers(copy.headers);
      headers.set('CF-Cache-Status', 'HIT');
      return new Response(copy.body, { status: copy.status, headers });
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res);
    },
    async delete(req: Request) {
      deleted.push(req.url);
      return store.delete(req.url);
    },
  };
}
type Zone = ReturnType<typeof zoneCache>;

async function withZoneCache(run: (cache: Zone) => Promise<void>) {
  const scope = globalThis as { caches?: unknown };
  const before = scope.caches;
  const cache = zoneCache();
  scope.caches = { default: cache };
  try {
    await run(cache);
  } finally {
    if (before === undefined) delete scope.caches;
    else scope.caches = before;
  }
}

const settle = () => Promise.all(pending.splice(0));

async function storedBody(cache: Zone, path: string): Promise<Record<string, any> | null> {
  const entry = cache.store.get(withCacheEpoch(`https://${APEX}${path}`));
  return entry ? ((await entry.clone().json()) as Record<string, any>) : null;
}

// ---------------------------------------------------------------- the owner's side (real routes, real scheduler, fake provider)
const ownerApp = (raw: DatabaseSync) => stubApp(asD1(raw), OWNER, (a) => a.route(BASE, adminPricingRoutes));
const ownerVersion = (raw: DatabaseSync) => Number(pairOf(raw, 'USD_IQD').owner_version);

async function ownerSetsAdjustment(raw: DatabaseSync, adjustment: string) {
  const res = await put(ownerApp(raw), `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: adjustment }, { Host: APEX });
  assert.equal(res.status, 200, `the owner could not save the adjustment: ${JSON.stringify(await json(res)).slice(0, 300)}`);
  await settle();
}

/** The scheduler's refresh against a FAKE IQWealth publishing `sell` (no network). */
async function iqwealthPublishes(raw: DatabaseSync, sell: number) {
  const m = market({ sell });
  m.state.at = new Date();
  await runFxScheduler(fxEnv(raw), { now: new Date() }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: m.f.fetch, actorId: 'usr_owner' });
  assert.ok(m.f.calls.length > 0, 'the scheduler read the fake provider');
  assert.ok(m.f.calls.every((c) => new URL(c.url).hostname === 'iraqsm.com'), 'only the fake provider was called');
  await settle();
}

/** The private state after: owner saves the adjustment, IQWealth publishes, owner approves the first value. */
async function shopWithPrivateAdjustment(): Promise<{ raw: DatabaseSync; iqwealthSell: string }> {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  await ownerSetsAdjustment(raw, PRIVATE_ADJUSTMENT);
  await iqwealthPublishes(raw, IQWEALTH_SELL);
  assert.equal(pairOf(raw, 'USD_IQD').pending_reason, 'FIRST_VALUE');
  const approved = await post(ownerApp(raw), `${BASE}/rates/fx/USD_IQD/review`, { owner_version: ownerVersion(raw), decision: 'approve' }, { Host: APEX });
  assert.equal(approved.status, 200, `the owner could not approve: ${JSON.stringify(await json(approved)).slice(0, 300)}`);
  await settle();
  const usd = pairOf(raw, 'USD_IQD');
  assert.equal(usd.market_adjustment_iqd, PRIVATE_ADJUSTMENT, 'the private adjustment is in force');
  assert.ok(same(String(usd.market_rate), String(IQWEALTH_SELL)), `the market figure is IQWealth's sell (${usd.market_rate})`);
  return { raw, iqwealthSell: String(IQWEALTH_SELL) };
}

// ---------------------------------------------------------------- the visitor's side (the real Worker)
async function guestGet(raw: DatabaseSync, path: string, ip: string, headers: Record<string, string> = {}) {
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: {
      fetch: async () => new Response('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { headers: { 'content-type': 'text/html' } }),
    },
  };
  const res = await worker.fetch(new Request(`https://${APEX}${path}`, { headers: { Host: APEX, 'CF-Connecting-IP': ip, ...headers } }), env as never, ctx);
  const text = await res.text();
  await settle();
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) as Record<string, any> };
}

// ------------------------------------------------------------------ 1 — the colo cache entry every visitor is served

test('colo cache: the shared anonymous /api/settings/public and /api/home entries must not let a visitor compute the private market adjustment', async () => {
  await withZoneCache(async (cache) => {
    const { raw, iqwealthSell } = await shopWithPrivateAdjustment();
    const found: string[] = [];

    for (const path of CACHED_PATHS) {
      // Visitor A fills the colo cache.
      const first = await guestGet(raw, path, '9.9.9.9');
      assert.equal(first.status, 200, `${path}: ${first.text.slice(0, 300)}`);
      assert.equal(first.headers.get('Cache-Control'), ANONYMOUS_CACHE_CONTROL, `${path}: the shared anonymous policy applies`);
      const stored = await storedBody(cache, path);
      assert.ok(stored, `${path}: the guest answer was stored in caches.default (keys: ${[...cache.store.keys()].join(', ') || 'none'})`);

      // Visitor B — another IP, another language — is answered from that one stored body.
      const second = await guestGet(raw, path, '10.20.30.40', { 'Accept-Language': 'en' });
      assert.equal(second.status, 200);
      assert.equal(second.headers.get('CF-Cache-Status'), 'HIT', `${path}: the second visitor was served from the shared entry`);

      // The existing literal scanner is blind to it: neither addend is spelled out.
      assert.deepEqual(leaks(stored, { decimals: [PRIVATE_ADJUSTMENT] }), [], `${path}: the literal scan passes`);
      assert.equal(JSON.stringify(stored).includes(PRIVATE_ADJUSTMENT), false, `${path}: the adjustment is not spelled out`);

      for (const [who, body] of [['caches.default entry', stored], ['cache HIT to visitor B', second.body]] as const) {
        const derived = derivedAdjustment(body, iqwealthSell);
        if (derived !== null && same(derived, PRIVATE_ADJUSTMENT)) {
          found.push(
            `${who} https://${APEX}${path} (Cache-Control: ${first.headers.get('Cache-Control')}): displayUsdRate ${body.settings.displayUsdRate} ` +
              `(displayUsdRateAttributed=${body.settings.displayUsdRateAttributed}) − IQWealth's published sell ${iqwealthSell} = ${derived} = private market_adjustment_iqd`
          );
        }
      }
    }
    assert.deepEqual(found, [], `LEAK — the anonymous colo cache serves every visitor the owner's private market adjustment by subtraction:\n  ${found.join('\n  ')}`);
  });
});

// ------------------------------------------------------------------ 2 — every non-owner role reads the same figure

test('every non-owner role (roleMatrix ROLES): /api/settings/public and /api/home must not let them compute the private market adjustment', async () => {
  const { raw, iqwealthSell } = await shopWithPrivateAdjustment();
  const found: string[] = [];
  for (const [role, user] of Object.entries(ROLES)) {
    const app = stubApp(asD1(raw), user, (a) => {
      a.route('/api/home', homeRoutes);
      a.route('/api', miscRoutes);
    });
    for (const path of ['/api/settings/public', '/api/home']) {
      const res = await get(app, path, { Host: APEX });
      assert.equal(res.status, 200, `${role} ${path}`);
      const body = await json(res);
      assert.deepEqual(leaks(body, { decimals: [PRIVATE_ADJUSTMENT] }), [], `${role} ${path}: the literal scan passes`);
      const derived = derivedAdjustment(body, iqwealthSell);
      if (derived !== null && same(derived, PRIVATE_ADJUSTMENT)) {
        found.push(`${role} ${path} (Cache-Control: ${res.headers.get('cache-control')}): ${body.settings.displayUsdRate} − ${iqwealthSell} = ${derived}`);
      }
    }
  }
  assert.deepEqual(found, [], `LEAK — non-owner roles compute the owner's private market_adjustment_iqd ${PRIVATE_ADJUSTMENT}:\n  ${found.join('\n  ')}`);
});

// ------------------------------------------------------------------ 3 — the purge seam keeps the cache in step with the private value

test('purge seam: after the owner moves the adjustment, the refilled colo entry must not give the new private adjustment (nor the private before→after step)', async () => {
  await withZoneCache(async (cache) => {
    const { raw, iqwealthSell } = await shopWithPrivateAdjustment();
    const before = await guestGet(raw, '/api/settings/public', '9.9.9.9');
    assert.ok(await storedBody(cache, '/api/settings/public'), 'the first answer is in the colo cache');
    const rateBefore = before.body.settings.displayUsdRate as string;

    // The owner moves the adjustment; IQWealth publishes nothing new. The act purges the apex entries.
    cache.deleted.length = 0;
    await ownerSetsAdjustment(raw, PRIVATE_ADJUSTMENT_2);
    assert.equal(pairOf(raw, 'USD_IQD').market_adjustment_iqd, PRIVATE_ADJUSTMENT_2);
    assert.ok(cache.deleted.includes(withCacheEpoch(`https://${APEX}/api/settings/public`)), `the act purged the apex entry (deleted: ${cache.deleted.join(', ') || 'none'})`);

    // The next visitor refills the shared entry with the new figure.
    const after = await guestGet(raw, '/api/settings/public', '10.20.30.40');
    assert.notEqual(after.headers.get('CF-Cache-Status'), 'HIT', 'rebuilt after the purge');
    const stored = await storedBody(cache, '/api/settings/public');
    assert.ok(stored, 'the refilled answer is in the colo cache');
    const rateAfter = stored.settings.displayUsdRate as string;

    const derived = derivedAdjustment(stored, iqwealthSell);
    const privateStep = sub(PRIVATE_ADJUSTMENT_2, PRIVATE_ADJUSTMENT);
    const problems: string[] = [];
    if (derived !== null && same(derived, PRIVATE_ADJUSTMENT_2)) {
      problems.push(`refilled caches.default entry: displayUsdRate ${rateAfter} − IQWealth's unchanged sell ${iqwealthSell} = ${derived} = the new private market_adjustment_iqd`);
    }
    if (typeof rateBefore === 'string' && typeof rateAfter === 'string' && same(sub(rateAfter, rateBefore), privateStep)) {
      problems.push(`the public step ${rateBefore} → ${rateAfter} with no new IQWealth publication = ${sub(rateAfter, rateBefore)} = the private adjustment change ${PRIVATE_ADJUSTMENT} → ${PRIVATE_ADJUSTMENT_2}`);
    }
    assert.deepEqual(problems, [], `LEAK — the purge-and-refill keeps the shared anonymous entry in step with the owner's private adjustment:\n  ${problems.join('\n  ')}`);
  });
});
