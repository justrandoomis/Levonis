/**
 * OWNER DECISION 5 (2026-10-09): THE USD ADJUSTMENT IS A FIXED NUMBER OF
 * DINARS, NEVER A PERCENTAGE — `market_adjustment_iqd`.
 *
 *   example      the owner's binding example end to end: market 1,660 with
 *                `market_adjustment_iqd` 20 is held as the first value at
 *                1,680; approved, the pair, the engine's dinar rate and the
 *                public display rate all read 1,680
 *   change       +20 → +60 moves the effective rate 1,680 → 1,720 and the
 *                drift anchor with it, keeping the anchor's time
 *   history      every log row says which adjustment was in force: USD/IQD
 *                carries it, the ECB pairs carry NULL
 *   input        «0.5%», an exponent or five decimals → 400
 *                PRICING_INPUT_INVALID naming market_adjustment_iqd; the old
 *                body key → 400 UNKNOWN_FIELD; a refusal writes nothing
 *   card         «market + adjustment = effective» only when it holds, in ar,
 *                en and ckb; a manual rate says the adjustment is not added
 *
 * Run: node --import tsx --test tests/fxMarketAdjustment.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OWNER, asD1, count, freshDb, get, json, post, put, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, derivedOf, fxEnv, logsOf, market, pairOf } from './fixtures/fx';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { miscRoutes } from '../worker/routes/misc';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { LanguageProvider } from '../src/LanguageContext';
import FxPairCard from '../src/components/adminPricing/FxPairCard';
import { FX_STRINGS } from '../src/components/adminPricing/fxStrings';
import type { FxPairDto, FxRatesAnswer } from '../src/components/adminPricing/api';

const BASE = '/api/admin/pricing';

function world(raw: DatabaseSync = freshDb()) {
  raw.exec(OWNER_ROW_SQL);
  const app = stubApp(asD1(raw), OWNER, (a) => {
    a.route(BASE, adminPricingRoutes);
    a.route('/api', miscRoutes);
  });
  return { raw, app };
}
const ownerVersion = (raw: DatabaseSync, pair = 'USD_IQD') => Number(pairOf(raw, pair as never).owner_version);
/** «تحديث الآن» on the wall clock, with the provider fake publishing a few minutes before it. */
async function refreshNow(raw: DatabaseSync, sell: number) {
  const m = market({ sell });
  m.state.at = new Date();
  return runFxScheduler(fxEnv(raw), { now: new Date() }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: m.f.fetch, actorId: 'usr_owner' });
}

test("the owner's example: market 1,660 + market_adjustment_iqd 20 → held at 1,680; approved, the pair, pricing_fx_rates and displayUsdRate all read 1,680", async () => {
  const { raw, app } = world();
  // The owner types the adjustment before the first value arrives (the first value is always held).
  const typed = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: '20' });
  assert.equal(typed.status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').market_adjustment_iqd, '20');

  await refreshNow(raw, 1660);
  let usd = pairOf(raw, 'USD_IQD');
  assert.equal(usd.pending_reason, 'FIRST_VALUE');
  assert.equal(usd.pending_market_rate, '1660');
  assert.equal(usd.pending_effective_rate, '1680', '1,660 + 20 dinars — not 1,660 × 1.20, not 1,660 × 1.002');
  assert.equal(usd.effective_rate, null, 'nothing applied before the owner approves');

  const approved = await post(app, `${BASE}/rates/fx/USD_IQD/review`, { owner_version: ownerVersion(raw), decision: 'approve' });
  assert.equal(approved.status, 200);
  usd = pairOf(raw, 'USD_IQD');
  assert.equal(usd.effective_rate, '1680');
  assert.equal(usd.drift_anchor_rate, '1680', 'the approval is the Confirmed Rate');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1680');
  const pub = await json(await get(app, '/api/settings/public'));
  assert.equal(pub.settings.displayUsdRate, '1680');
  assert.equal(pub.settings.exchangeRate, 1400, 'the wallet rate is untouched (decision 9)');

  // The owner's panel shows the sum, and that it holds.
  const rates = await json(await get(app, `${BASE}/rates`));
  const p = rates.pairs.find((x: { pair: string }) => x.pair === 'USD_IQD');
  assert.equal(p.market_adjustment_iqd, '20');
  assert.equal(p.market_rate, '1660');
  assert.equal(p.formula_holds, true);
  assert.equal('adjustment_iqd_per_usd' in p, false, 'the old wire name is gone from the answer');
  for (const ecb of rates.pairs.filter((x: { pair: string }) => x.pair !== 'USD_IQD')) {
    assert.equal(ecb.market_adjustment_iqd, null);
    assert.equal(ecb.formula_holds, false);
  }
});

test('+20 → +60: the effective rate moves 1,680 → 1,720, the anchor moves with it and keeps its time; the history rows carry the adjustment in force', async () => {
  const { raw, app } = world();
  raw.exec("UPDATE fx_rate_pairs SET market_adjustment_iqd = '20' WHERE pair = 'USD_IQD'");
  applyRate(raw, 'USD_IQD', '1680', '2026-10-08T00:00:00.000Z');
  raw.exec("UPDATE fx_rate_pairs SET market_rate = '1660' WHERE pair = 'USD_IQD'");
  const anchorAt = pairOf(raw, 'USD_IQD').drift_anchor_at;
  assert.equal(logsOf(raw, 'USD_IQD').at(-1)!.market_adjustment_iqd, '20', 'the approval row carries +20');

  const res = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: '60' });
  assert.equal(res.status, 200);
  const usd = pairOf(raw, 'USD_IQD');
  assert.equal(usd.market_adjustment_iqd, '60');
  assert.equal(usd.effective_rate, '1720');
  assert.equal(usd.drift_anchor_rate, '1720', 'the anchor moves by the change');
  assert.equal(usd.drift_anchor_at, anchorAt, 'and keeps its time: an adjustment is not a confirmation');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1720');
  const row = logsOf(raw, 'USD_IQD').at(-1)!;
  assert.equal(row.event, 'settings_change');
  assert.equal(row.effective_before, '1680');
  assert.equal(row.effective_after, '1720');
  assert.equal(row.market_adjustment_iqd, '60', 'the row carries the adjustment in force after it');
  assert.deepEqual(JSON.parse(String(row.settings_diff)), [{ field: 'market_adjustment_iqd', before: '20', after: '60' }]);
  const p = (await json(await get(app, `${BASE}/rates`))).pairs[0];
  assert.equal(p.formula_holds, true, '1,660 + 60 = 1,720');
});

test('every log row says which adjustment was in force: USD/IQD carries it, EUR/USD and CNY/USD carry NULL — on applies, holds, failures and budget deferrals', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  raw.exec("UPDATE fx_rate_pairs SET market_adjustment_iqd = '-12.5' WHERE pair = 'USD_IQD'");
  const T = new Date('2026-10-08T06:00:00.000Z');
  const m = market({ sell: 1660 });
  m.state.at = T;
  await runFxScheduler(fxEnv(raw), { now: new Date(T.getTime() + 60_000), scheduledTime: T }, { trigger: 'cron', fetchImpl: m.f.fetch });
  m.state.usdDown = true;
  m.state.at = new Date(T.getTime() + 6 * 3_600_000);
  await runFxScheduler(fxEnv(raw), { now: new Date(m.state.at.getTime() + 60_000), scheduledTime: m.state.at }, { trigger: 'cron', fetchImpl: m.f.fetch });
  const usd = logsOf(raw, 'USD_IQD');
  assert.ok(usd.length >= 2);
  assert.deepEqual([...new Set(usd.map((l) => l.market_adjustment_iqd))], ['-12.5'], 'every USD/IQD row');
  assert.equal(usd[0]!.pending_rate, '1647.5', '1,660 − 12.5 dinars');
  const ecb = [...logsOf(raw, 'EUR_USD'), ...logsOf(raw, 'CNY_USD')];
  assert.ok(ecb.length >= 2);
  assert.ok(ecb.every((l) => l.market_adjustment_iqd === null), 'every ECB row is NULL');
});

test('the door takes dinars only: «0.5%», an exponent, five decimals → 400 PRICING_INPUT_INVALID {field: market_adjustment_iqd}; the old key → 400 UNKNOWN_FIELD; a refusal writes nothing', async () => {
  const { raw, app } = world();
  applyRate(raw, 'USD_IQD', '1660');
  const before = { logs: count(raw, 'SELECT COUNT(*) n FROM fx_rate_log'), audits: count(raw, 'SELECT COUNT(*) n FROM audit_log'), row: JSON.stringify(pairOf(raw, 'USD_IQD')) };
  for (const bad of ['0.5%', '2e1', '20.12345', '1.2.3', '', ' ', 20]) {
    const res = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: bad });
    const b = await json(res);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(b.code, 'PRICING_INPUT_INVALID');
    assert.deepEqual(b.details, { field: 'market_adjustment_iqd' });
    assert.doesNotMatch(JSON.stringify(b), /0\.5%|2e1|20\.12345/, 'the value is never echoed');
  }
  const old = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), adjustment_iqd_per_usd: '20' });
  assert.equal(old.status, 400);
  const ob = await json(old);
  assert.equal(ob.code, 'UNKNOWN_FIELD');
  assert.deepEqual(ob.details, { fields: ['adjustment_iqd_per_usd'] });
  // An ECB pair has no adjustment.
  const ecb = await put(app, `${BASE}/rates/fx/EUR_USD/settings`, { owner_version: ownerVersion(raw, 'EUR_USD'), market_adjustment_iqd: '5' });
  assert.deepEqual((await json(ecb)).details, { field: 'market_adjustment_iqd' });
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM fx_rate_log'), before.logs, 'no log row');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM audit_log'), before.audits, 'no audit row');
  assert.equal(JSON.stringify(pairOf(raw, 'USD_IQD')), before.row, 'the pair is unchanged');
  // Arabic-Indic digits and a sign are dinars too.
  const ok = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: '-٢٠' });
  assert.equal(ok.status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').market_adjustment_iqd, '-20');
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1640');
});

// ------------------------------------------------------------- the card

const LANGS = ['ar', 'en', 'ckb'] as const;
const usdPair = (over: Partial<FxPairDto> = {}): FxPairDto => ({
  pair: 'USD_IQD',
  provider: 'iqwealth',
  attribution: { text: 'IQWealth', url: 'https://iraqsm.com' },
  mode: 'AUTO',
  interval_hours: 6,
  market_rate: '1660',
  market_buy: '1655',
  official_rate: '1310',
  market_adjustment_iqd: '20',
  formula_holds: true,
  manual_rate: null,
  effective_rate: '1680',
  effective_version: 1,
  effective_source: 'review_approved',
  effective_applied_at: '2026-10-09T00:00:00.000Z',
  last_known_good_rate: '1680',
  drift_anchor_rate: '1680',
  drift_anchor_at: '2026-10-09T00:00:00.000Z',
  published_at: '2026-10-08T23:58:00.000Z',
  last_checked_at: '2026-10-09T00:00:00.000Z',
  last_check_result: 'APPLIED',
  last_successful_at: '2026-10-09T00:00:00.000Z',
  status: 'OK',
  fetch_status: 'OK',
  last_error_code: null,
  failing_since: null,
  pending: null,
  rejected: null,
  last_observed: null,
  anomaly_threshold_pct: '3',
  drift_threshold_pct: '6',
  min_change_pct: '0.5',
  bound_min: '1000',
  bound_max: '3000',
  next_check_at: '2026-10-09T12:00:00.000Z',
  owner_version: 2,
  ...over,
});
const ratesOf = (p: FxPairDto): FxRatesAnswer => ({
  success: true,
  pairs: [p],
  effective_rates_iqd: { USD: { rate_iqd: p.effective_rate, version: 1, updated_at: null } },
  shipping: [],
  key_configured: true,
  refresh_budget: { used_today: 0, limit: 40 },
  provider_budget: { USD_IQD: { used_today: 0, cap: 150 } },
  engine_products: 0,
  reprice_blocked: 0,
  stale_products: 0,
});
const card = (p: FxPairDto, lang: (typeof LANGS)[number]) =>
  renderToStaticMarkup(
    createElement(LanguageProvider, {
      children: createElement(FxPairCard, { pair: p, rates: ratesOf(p), lang, s: FX_STRINGS[lang], onAnswer: () => {}, onStale: () => {}, onReview: () => {} }),
    })
  );
const formulaOf = (html: string) => /<p[^>]*data-fx-formula[^>]*>([^<]*)<\/p>/.exec(html)?.[1] ?? null;

test('the card: «market + adjustment = effective» in ar, en and ckb when it holds; nothing when it does not; a manual rate says the adjustment is not added', () => {
  for (const lang of LANGS) {
    const s = FX_STRINGS[lang];
    const shown = formulaOf(card(usdPair(), lang));
    assert.equal(shown, s.formula('1,660', '20', '1,680'), lang);
    assert.match(shown!, /1,660.*20.*1,680/, `${lang}: the server's three figures`);
    assert.equal(formulaOf(card(usdPair({ formula_holds: false, market_rate: '1662' }), lang)), null, `${lang}: inside the dead band, no sum`);
    const negative = formulaOf(card(usdPair({ market_adjustment_iqd: '-20', effective_rate: '1640' }), lang));
    assert.match(negative!, /−20/, `${lang}: a minus when it lowers the rate`);
    const manual = card(usdPair({ mode: 'MANUAL', manual_rate: '1700', effective_rate: '1700', effective_source: 'manual', formula_holds: false }), lang);
    assert.equal(formulaOf(manual), null);
    assert.ok(manual.includes(s.manualFinal), `${lang}: the manual hint`);
    assert.equal(card(usdPair(), lang).includes(s.manualFinal), false, `${lang}: no manual hint in AUTO`);
    assert.ok(card(usdPair(), lang).includes(s.adjustment), `${lang}: the label names the fixed dinars`);
  }
  assert.match(FX_STRINGS.en.adjustment, /fixed IQD per USD/);
  assert.match(FX_STRINGS.en.adjustmentHint, /not a percentage/);
  assert.doesNotMatch(FX_STRINGS.ar.adjustment + FX_STRINGS.ar.adjustmentHint, /%|٪|نسبة مئوية/);
});
