/**
 * LEAK VERIFY (money) — the dollar reading moves even when the owner has NO
 * adjustment, because DECISIONS row 220 publishes the provider's figure
 * rounded to the whole dinar (`Math.round`, worker/lib/fx/displayRate.ts).
 *
 * With `market_adjustment_iqd = '0'` there is nothing private to hide: the
 * applied rate IS the market sell. On 10c6541a a dollar reader saw prices at
 * that rate, exactly (decimal text, BigInt conversion in src/lib/displayRate.ts).
 * On HEAD the public figure is that rate rounded, so a price the engine built
 * at 1,703.9167 IQD/USD for $1,000.00 reads $999.95.
 *
 * Expected (base): with no adjustment, the public display rate is the applied rate.
 *
 * FIXED (DECISIONS row 220, verification pass): the public figure is the
 * market sell the applied rate was built from, EXACTLY — no rounding — so
 * with no adjustment it is the applied rate to the last decimal again.
 *
 * LOCAL ONLY: in-memory SQLite, the real misc router (/api/settings/public), the
 * client's own exact converter. No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { applyRate, derivedOf } from './fixtures/fx';
import { miscRoutes } from '../worker/routes/misc';
import { iqdToUsdCentsExact } from '../src/lib/displayRate';

test('no adjustment: a dollar reader reads prices at the applied USD/IQD rate, to the cent', async () => {
  const raw = freshDb();
  // The provider's sell, approved, with the owner's adjustment left at zero.
  raw.exec("UPDATE fx_rate_pairs SET market_adjustment_iqd = '0' WHERE pair = 'USD_IQD'");
  applyRate(raw, 'USD_IQD', '1703.9167');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1703.9167', 'prices are built at 1,703.9167');

  const app = stubApp(asD1(raw), null, (a) => a.route('/api', miscRoutes));
  const rate = (await json(await get(app, '/api/settings/public'))).settings.displayUsdRate as string;
  const dinars = 1_703_917; // what the cart charges for a $1,000 engine price
  const cents = iqdToUsdCentsExact(dinars, rate);
  console.log(JSON.stringify({ displayUsdRate: rate, usd: cents === null ? null : cents / 100 }));
  assert.equal(
    rate,
    '1703.9167',
    `CHANGED AMOUNT: with no adjustment the public rate is ${rate}, not the applied 1703.9167 — ` +
      `${dinars} IQD now reads $${cents === null ? '?' : (cents / 100).toFixed(2)} (base $1000.00)`
  );
});
