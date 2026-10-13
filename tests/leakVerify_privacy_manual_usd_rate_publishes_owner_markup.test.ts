/**
 * PRIVACY VERIFY (DECISIONS row 219 port, fix/leak-port 5e6f581c) — #4 / #9 /
 * #14 "the public FX display rate lets the owner's adjustment be derived".
 *
 * The port's rule, in its own words (worker/lib/fx/displayRate.ts, and the
 * changed walletRateSeparation test): the public `displayUsdRate` must never be
 * the rate the prices are APPLIED at when that rate carries the owner's figure
 * on top of the market sell — «Not the applied 1,680 either: beside the public
 * 1,660 it is the owner's adjustment». On AUTO it now publishes the market sell
 * to the dinar.
 *
 * ON A RATE THE OWNER TYPES, THE APPLIED RATE IS STILL PUBLISHED AS IT IS.
 * `getPublicDisplayRate` returns `rate_iqd` unchanged whenever
 * `effective_source` is 'manual' (the «سعر يدوي» act, PUT
 * /api/admin/pricing/rates/fx/USD_IQD/manual). The market sell the shop's
 * provider publishes is public (IQWealth's own page — the same figure the AUTO
 * branch publishes), so applied − market = the owner's markup over the market,
 * exactly the quantity the port hides on AUTO: the owner who stops following
 * the market and types «1,700» while the market sells at 1,660 tells every
 * visitor «+40 per dollar», and every later manual change as a step.
 *
 * The test: AUTO at market 1,660 + the owner's 20 (prices at 1,680) publishes
 * 1660 (the port's fix, control); the owner then types 1,700 through the real
 * admin door; the public figure must still not hand a visitor the owner's
 * markup (public − market sell). It does: 1700 − 1660 = 40.
 *
 * Needs the owner's ruling (DECISIONS row 219 keeps a typed rate public «as it
 * is»); recorded here because it is the same private quantity the port closed
 * on AUTO, reaching every anonymous visitor through the same field.
 *
 * FIXED (DECISIONS row 219, verification pass): the public figure is read
 * from the FX log — the market sell of the newest rate built as market +
 * adjustment — so a rate the owner types is never published; the reading
 * stays IQWealth's sell (worker/lib/fx/displayRate.ts).
 *
 * LOCAL ONLY: in-memory SQLite, the real admin pricing and misc routers, the
 * stub owner session of tests/fixtures/app.ts. No network.
 * Run: node --import tsx --test tests/leakVerify_privacy_manual_usd_rate_publishes_owner_markup.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, asD1, freshDb, get, json, put, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, derivedOf, pairOf } from './fixtures/fx';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { miscRoutes } from '../worker/routes/misc';

const BASE = '/api/admin/pricing';
/** IQWealth's public sell — the figure the AUTO branch itself publishes. */
const MARKET = 1660;

test('a rate the owner types is published as the applied rate: public − the market sell = the owner’s markup', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const owner = stubApp(asD1(raw), OWNER, (a) => {
    a.route(BASE, adminPricingRoutes);
  });
  const visitor = stubApp(asD1(raw), null, (a) => a.route('/api', miscRoutes));
  const publicRate = async () => (await json(await get(visitor, '/api/settings/public'))).settings.displayUsdRate as string | null;

  // AUTO, the owner's example: market 1,660 + 20 dinars = 1,680 in force.
  raw.exec("UPDATE fx_rate_pairs SET market_adjustment_iqd = '20' WHERE pair = 'USD_IQD'");
  applyRate(raw, 'USD_IQD', '1680', '2026-10-08T00:00:00.000Z');
  raw.exec(`UPDATE fx_rate_pairs SET market_rate = '${MARKET}', effective_source = 'provider' WHERE pair = 'USD_IQD'`);
  assert.equal(await publicRate(), String(MARKET), 'control: on AUTO the port publishes the market sell, never the applied 1,680');

  // The owner stops following the market and types the shop's own rate.
  const set = await put(owner, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: Number(pairOf(raw, 'USD_IQD').owner_version), rate: '1700' });
  assert.equal(set.status, 200, await set.clone().text());
  assert.equal(pairOf(raw, 'USD_IQD').effective_source, 'manual');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1700', 'control: every dinar price is now applied at 1,700');

  const shown = await publicRate();
  assert.ok(shown, 'a public dollar rate is served on the manual rate');
  const markup = Number(shown) - MARKET;
  assert.equal(
    markup,
    0,
    `GET /api/settings/public displayUsdRate = ${shown}: the applied manual rate, so a visitor subtracts the market sell ` +
      `(${MARKET}, public) and reads the owner's markup of ${markup} IQD per dollar — the quantity the port hides on AUTO ` +
      '(worker/lib/fx/displayRate.ts publishes `rate_iqd` unchanged when effective_source is manual)'
  );
});
