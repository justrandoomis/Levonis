/**
 * LEAK VERIFY (features) — what a dollar reader sees for a price the shop set
 * in dollars.
 *
 * The FX programme prices in USD and charges in dinars at the APPLIED rate
 * (`pricing_fx_rates.rate_iqd`, market + the owner's adjustment). Until
 * DECISIONS row 219 the top-bar dollar reading divided by that same rate, so
 * a product the engine priced at $100 read «$100.00». Row 219 publishes the
 * market sell instead (to hide the adjustment), so every dollar reading is
 * now the dinar price at the market rate: with the owner's own example
 * (1,660 + 20) a $100 product reads $101.20, on every product, for every
 * visitor who reads dollars. No dinar price moves.
 *
 * WHY THIS CANNOT BE "FIXED" HERE. A dollar figure equal to the owner's
 * dollar price, shown beside the dinar price every visitor pays, IS the
 * applied rate (dinars ÷ dollars) — and the applied rate minus IQWealth's
 * public sell IS the owner's private adjustment. So the first test pins what
 * the shop does now (dinars unchanged, the reading at the market rate, no
 * adjustment derivable), and the second — the pre-219 reading — is kept,
 * failing, as `todo` for the owner's ruling: showing the applied rate is his
 * call to make, and it gives the adjustment away.
 *
 * LOCAL ONLY: in-memory SQLite, the real misc router (/api/settings/public),
 * the client's own exact converter (src/lib/displayRate.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { applyRate, derivedOf } from './fixtures/fx';
import { miscRoutes } from '../worker/routes/misc';
import { iqdToUsdCentsExact } from '../src/lib/displayRate';

async function world() {
  const raw = freshDb();
  raw.exec("UPDATE fx_rate_pairs SET market_adjustment_iqd = '20' WHERE pair = 'USD_IQD'");
  applyRate(raw, 'USD_IQD', '1680');
  raw.exec("UPDATE fx_rate_pairs SET market_rate = '1660' WHERE pair = 'USD_IQD'");
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1680', 'prices are built at 1,680');
  const app = stubApp(asD1(raw), null, (a) => a.route('/api', miscRoutes));
  const settings = (await json(await get(app, '/api/settings/public'))).settings as { displayUsdRate: string; displayUsdRateAttributed: boolean };
  return { settings };
}

test('a product the shop priced at $100 keeps its 168,000 IQD; dollars read at the market 1,660, and the reading gives no adjustment away', async () => {
  const { settings } = await world();
  assert.equal(settings.displayUsdRate, '1660', 'the public figure is IQWealth’s sell');
  assert.equal(settings.displayUsdRateAttributed, true);
  const dinars = 100 * 1680; // what the cart charges for a $100 engine price — unchanged
  assert.equal(iqdToUsdCentsExact(dinars, settings.displayUsdRate), 10_120, '$101.20 at the market rate');
  // public − IQWealth's sell: nothing of the owner's 20.
  assert.equal(Number(settings.displayUsdRate) - 1660, 0);
});

const OWNER_RULING =
  'OWNER RULING NEEDED (DECISIONS row 219): a dollar reading equal to the dollar price the owner set is the applied rate (dinars ÷ dollars), and the applied rate less IQWealth’s public sell is the private adjustment — the reading follows the market until the owner chooses to publish his own rate';

test('a product the shop priced at $100 (168,000 IQD at the applied 1,680) reads $100.00 to a dollar reader', { todo: OWNER_RULING }, async () => {
  const { settings } = await world();
  const cents = iqdToUsdCentsExact(100 * 1680, settings.displayUsdRate);
  assert.equal(cents, 10_000, `a $100 product reads $${((cents ?? 0) / 100).toFixed(2)} at the public displayUsdRate ${settings.displayUsdRate}`);
});
