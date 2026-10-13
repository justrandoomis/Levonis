/**
 * LEAK AUDIT — customer-api: the public `displayUsdRate` hands any anonymous
 * visitor the owner's PRIVATE USD/IQD market adjustment.
 *
 * The owner's rule: anyone other than the main admin / super admin gets ONLY
 * the final price — no cost and no step of how a price was computed. The
 * owner's adjustment `fx_rate_pairs.market_adjustment_iqd` is such a step
 * (it is in FINANCIAL_FIELDS; docs/PRICING.md «The rates»; the brief lists
 * «market adjustment» as private). The engine's dinar rate is
 *
 *     pricing_fx_rates.rate_iqd  =  IQWealth parallel-market SELL  +  market_adjustment_iqd
 *
 * (packages/pricing/src/fxChain.ts usdIqdCandidate, worker/lib/fx/decide.ts
 * candidateOf), and worker/lib/fx/displayRate.ts publishes that SUM verbatim as
 * `displayUsdRate` on GET /api/settings/public and GET /api/home — anonymous,
 * edge-cached — together with `displayUsdRateAttributed`, which tells the
 * visitor the figure is IQWealth's (not typed by the owner). IQWealth's
 * parallel-market sell is the provider's own published quote: the visitor
 * reads it from IQWealth, never from Levonis. So:
 *
 *     displayUsdRate − IQWealth's published sell  =  market_adjustment_iqd   (exactly)
 *
 * The tests drive the REAL chain, locally: the owner saves a private
 * adjustment through PUT /api/admin/pricing/rates/fx/USD_IQD/settings, the
 * real scheduler fetches a quote from a FAKE IQWealth (no network), the owner
 * approves it through the real review route, and an ANONYMOUS stub session
 * reads the two public answers. They assert that what the visitor holds does
 * NOT give the private adjustment (nor, after a change, the private
 * before→after delta of the settings_change row). Today it does.
 *
 * The existing guards (tests/publicSettingsDisplayRate.test.ts,
 * tests/securityPricingLeak.test.ts, the leak scanner of
 * tests/fixtures/costlyProduct.ts, tests/liveCostProbes.test.ts) only look for
 * the adjustment as a literal value or key; they treat `displayUsdRate` as the
 * one public FX figure «by design», so none of them flags this derivation —
 * the first assertion of each test below shows the scanner passing.
 *
 * LOCAL ONLY: in-memory SQLite with every migration, the real route modules,
 * the stub session of tests/fixtures/app.ts, a fake provider fetch.
 *
 * Run: node --import tsx --test tests/leakAudit_customer-api_fx_display_rate_reveals_market_adjustment.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, freshDb, get, json, post, put, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, fxEnv, market, pairOf } from './fixtures/fx';
import { leaks } from './fixtures/costlyProduct';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { miscRoutes } from '../worker/routes/misc';
import { homeRoutes } from '../worker/routes/products';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { ANONYMOUS_CACHE_CONTROL } from '../worker/lib/edgePolicy';

const BASE = '/api/admin/pricing';
/** IQWealth's published parallel-market SELL — the provider's public quote, not a Levonis figure. */
const IQWEALTH_PUBLIC_SELL = 1666.6666;
/** The owner's PRIVATE adjustment (dinars per dollar) — a figure no public number here equals. */
const PRIVATE_ADJUSTMENT = '37.2501';
/** A later private adjustment (the settings_change row's `after`). */
const PRIVATE_ADJUSTMENT_2 = '52.5';

// ---------------------------------------------------------------- exact decimal text arithmetic (≤ 8 places)
const SCALE = 8;
const toFixedInt = (s: string): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not decimal text: ${s}`);
  const frac = (m[3] ?? '').padEnd(SCALE, '0').slice(0, SCALE);
  const v = BigInt(m[2]! + frac);
  return m[1] === '-' ? -v : v;
};
const fromFixedInt = (v: bigint): string => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(SCALE + 1, '0');
  const whole = s.slice(0, s.length - SCALE);
  const frac = s.slice(s.length - SCALE).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};
const sub = (a: string, b: string) => fromFixedInt(toFixedInt(a) - toFixedInt(b));
const same = (a: string, b: string) => toFixedInt(a) === toFixedInt(b);

// ---------------------------------------------------------------- the two worlds: the owner's panel, the anonymous storefront
function world() {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const owner = stubApp(asD1(raw), OWNER, (a) => a.route(BASE, adminPricingRoutes));
  const anonymous = stubApp(asD1(raw), null, (a) => {
    a.route('/api/home', homeRoutes);
    a.route('/api', miscRoutes);
  });
  return { raw, owner, anonymous };
}
const ownerVersion = (raw: DatabaseSync) => Number(pairOf(raw, 'USD_IQD').owner_version);

/** The scheduler's refresh against a FAKE IQWealth publishing `sell` (no network). */
async function providerPublishes(raw: DatabaseSync, sell: number) {
  const m = market({ sell });
  m.state.at = new Date();
  await runFxScheduler(fxEnv(raw), { now: new Date() }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: m.f.fetch, actorId: 'usr_owner' });
  assert.ok(m.f.calls.every((c) => new URL(c.url).hostname === 'iraqsm.com'), 'only the fake provider was called');
}

/** What an anonymous visitor reads from both public answers. */
async function visitorReads(anonymous: ReturnType<typeof world>['anonymous']) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Array<{ path: string; body: Record<string, any>; cacheControl: string | null }> = [];
  for (const path of ['/api/settings/public', '/api/home']) {
    const res = await get(anonymous, path);
    assert.equal(res.status, 200, path);
    out.push({ path, body: await json(res), cacheControl: res.headers.get('cache-control') });
  }
  return out;
}

/**
 * The visitor's arithmetic: when the shop credits IQWealth (attributed), its
 * rate minus IQWealth's own published sell. Null when there is nothing to
 * subtract from (no rate, or a rate the owner typed).
 */
function adjustmentAVisitorDerives(settings: Record<string, unknown>, iqwealthSell: string): string | null {
  const rate = settings.displayUsdRate;
  if (typeof rate !== 'string' || settings.displayUsdRateAttributed !== true) return null;
  return sub(rate, iqwealthSell);
}

test('anonymous /api/settings/public and /api/home: displayUsdRate − IQWealth\'s published sell must not give the private market_adjustment_iqd', async () => {
  const { raw, owner, anonymous } = world();

  // The owner saves a PRIVATE adjustment, the provider publishes, the owner approves the first value.
  const saved = await put(owner, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: PRIVATE_ADJUSTMENT });
  assert.equal(saved.status, 200, 'the owner saves the adjustment');
  await providerPublishes(raw, IQWEALTH_PUBLIC_SELL);
  assert.equal(pairOf(raw, 'USD_IQD').pending_reason, 'FIRST_VALUE');
  const approved = await post(owner, `${BASE}/rates/fx/USD_IQD/review`, { owner_version: ownerVersion(raw), decision: 'approve' });
  assert.equal(approved.status, 200, 'the owner approves the first value');

  // The private state, as the owner's panel holds it.
  const usd = pairOf(raw, 'USD_IQD');
  assert.equal(usd.market_adjustment_iqd, PRIVATE_ADJUSTMENT);
  assert.equal(usd.market_rate, IQWEALTH_PUBLIC_SELL.toFixed(4));
  const iqwealthSell = String(usd.market_rate);

  for (const { path, body, cacheControl } of await visitorReads(anonymous)) {
    assert.equal(cacheControl, ANONYMOUS_CACHE_CONTROL, `${path}: shared by every visitor through the anonymous edge cache`);
    // The existing scanner is blind to it: no private value or key appears literally.
    assert.deepEqual(leaks(body, { decimals: [PRIVATE_ADJUSTMENT] }), [], `${path}: the literal scan passes`);
    // Since DECISIONS row 220 the public figure IS IQWealth's own sell, exactly.
    assert.equal(body.settings.displayUsdRate, iqwealthSell, `${path}: the public figure is the market sell`);
    assert.equal(JSON.stringify(body).includes(PRIVATE_ADJUSTMENT), false, `${path}: the adjustment is not spelled out`);

    // …and yet the visitor computes it.
    const derived = adjustmentAVisitorDerives(body.settings, iqwealthSell);
    assert.ok(
      derived === null || !same(derived, PRIVATE_ADJUSTMENT),
      `LEAK ${path}: anonymous displayUsdRate ${body.settings.displayUsdRate} (displayUsdRateAttributed=${body.settings.displayUsdRateAttributed}, i.e. IQWealth's) − IQWealth's published sell ${iqwealthSell} = ${derived} = the owner's private market_adjustment_iqd ${PRIVATE_ADJUSTMENT}`
    );
  }
});

test('anonymous: an owner change of the adjustment (market unchanged) shows the private new adjustment and its private before→after delta', async () => {
  const { raw, owner, anonymous } = world();
  await put(owner, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: PRIVATE_ADJUSTMENT });
  await providerPublishes(raw, IQWEALTH_PUBLIC_SELL);
  assert.equal((await post(owner, `${BASE}/rates/fx/USD_IQD/review`, { owner_version: ownerVersion(raw), decision: 'approve' })).status, 200);
  const before = (await visitorReads(anonymous))[0]!.body.settings.displayUsdRate as string;

  // The owner moves the adjustment; IQWealth publishes nothing new.
  const changed = await put(owner, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: PRIVATE_ADJUSTMENT_2 });
  assert.equal(changed.status, 200, 'the owner changes the adjustment');
  assert.equal(pairOf(raw, 'USD_IQD').market_adjustment_iqd, PRIVATE_ADJUSTMENT_2);
  const privateDelta = sub(PRIVATE_ADJUSTMENT_2, PRIVATE_ADJUSTMENT); // the settings_change row's before → after, private

  for (const { path, body } of await visitorReads(anonymous)) {
    const after = body.settings.displayUsdRate as string;
    const derived = adjustmentAVisitorDerives(body.settings, String(pairOf(raw, 'USD_IQD').market_rate));
    assert.ok(
      derived === null || !same(derived, PRIVATE_ADJUSTMENT_2),
      `LEAK ${path}: after the owner's change, displayUsdRate ${after} − IQWealth's unchanged sell = ${derived} = the private new market_adjustment_iqd ${PRIVATE_ADJUSTMENT_2}`
    );
    assert.ok(
      !same(sub(after, before), privateDelta),
      `LEAK ${path}: with no new IQWealth publication, the public step ${before} → ${after} (${sub(after, before)}) is the private adjustment delta ${privateDelta}`
    );
  }
});
