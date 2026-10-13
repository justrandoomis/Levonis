/**
 * LEAK VERIFY (features) — the top-bar dollar reading moves when the owner
 * edits the adjustment while the USD/IQD pair is on MANUAL, though nothing the
 * shop charges moved.
 *
 * DECISIONS row 220 publishes `displayUsdRate` as `effective_rate −
 * market_adjustment_iqd` whenever `effective_source` is not 'manual'
 * (worker/lib/fx/displayRate.ts). But «إيقاف» (mode → MANUAL,
 * worker/lib/fx/ownerActs.ts) keeps `effective_source` as it was, and on
 * MANUAL the adjustment is NOT part of the rate in force (scheduler
 * `ADJUSTMENT_IN_FORCE`, the owner's card: «on manual it moves nothing»).
 * The owner may still save a new adjustment on MANUAL (FxPairCard
 * `saveAdjustment`, ownerActs `planSettings` refuses nothing on MANUAL and
 * only shifts the effective rate on AUTO). The public figure then subtracts
 * an adjustment the rate never contained: every visitor reading dollars sees
 * every price change, while every dinar price, the effective rate and
 * pricing_fx_rates are untouched.
 *
 * Expected: an act that moves no rate moves no public figure.
 *
 * FIXED (DECISIONS row 220, verification pass): the public figure is the
 * market sell of the newest rate the log records as built from market +
 * adjustment (effective_after − the adjustment THAT row carried), so an act
 * that applies no new market reading — a freeze, a typed rate, an adjustment
 * saved on MANUAL or on AUTO — never moves it.
 *
 * LOCAL ONLY: in-memory SQLite, the real admin pricing and misc routers, the
 * stub owner session of tests/fixtures/app.ts. No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, freshDb, get, json, put, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, derivedOf, pairOf } from './fixtures/fx';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { miscRoutes } from '../worker/routes/misc';

const BASE = '/api/admin/pricing';

function world(raw: DatabaseSync = freshDb()) {
  raw.exec(OWNER_ROW_SQL);
  const app = stubApp(asD1(raw), OWNER, (a) => {
    a.route(BASE, adminPricingRoutes);
    a.route('/api', miscRoutes);
  });
  return { raw, app };
}
const ownerVersion = (raw: DatabaseSync) => Number(pairOf(raw, 'USD_IQD').owner_version);
const publicRate = async (app: ReturnType<typeof world>['app']) =>
  (await json(await get(app, '/api/settings/public'))).settings.displayUsdRate as string | null;

test('MANUAL («إيقاف»), then a new adjustment: no rate moves, so the public dollar rate must not move either', async () => {
  const { raw, app } = world();
  // The owner's example, approved: market 1,660 + 20 dinars = 1,680 in force.
  raw.exec("UPDATE fx_rate_pairs SET market_adjustment_iqd = '20' WHERE pair = 'USD_IQD'");
  applyRate(raw, 'USD_IQD', '1680', '2026-10-08T00:00:00.000Z');
  raw.exec("UPDATE fx_rate_pairs SET market_rate = '1660' WHERE pair = 'USD_IQD'");

  // «إيقاف»: the effective rate becomes the manual one, prices stay where they are.
  const off = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), mode: 'MANUAL' });
  assert.equal(off.status, 200, await off.clone().text());
  assert.equal(pairOf(raw, 'USD_IQD').mode, 'MANUAL');
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1680');
  const onManual = await publicRate(app);
  assert.ok(onManual, 'a public dollar rate is served on MANUAL');

  // The owner saves a new adjustment on MANUAL — the card says it moves nothing here.
  const adj = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: '50' });
  assert.equal(adj.status, 200, await adj.clone().text());
  const usd = pairOf(raw, 'USD_IQD');
  assert.equal(usd.market_adjustment_iqd, '50');
  assert.equal(usd.effective_rate, '1680', 'the rate in force did not move');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1680', 'no dinar price moved');

  const after = await publicRate(app);
  assert.equal(
    after,
    onManual,
    `the public displayUsdRate moved from ${onManual} to ${after} although no rate moved: ` +
      'worker/lib/fx/displayRate.ts subtracts market_adjustment_iqd from a MANUAL rate that never contained it ' +
      '(effective_source stays non-manual after «إيقاف»), so every USD price shown to every visitor shifts'
  );
});
