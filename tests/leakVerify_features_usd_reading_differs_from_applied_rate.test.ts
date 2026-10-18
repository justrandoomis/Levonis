/**
 * LEAK VERIFY (features) — what a dollar reader sees for a price the shop set
 * in dollars.
 *
 * The FX programme prices in USD and charges in dinars at the APPLIED rate
 * (`pricing_fx_rates.rate_iqd`, market + the owner's adjustment). Row 220
 * publishes the market sell (to hide the adjustment), and until row 248 every
 * dollar reading was the dinar price at that market rate: with the owner's
 * own example (1,660 + 20) a $100 product read $101.20.
 *
 * THE OWNER'S RULING (DECISIONS row 248, 2026-10-17): «الدولار هو الاساس …
 * الدولار هو الثابت والدينار العراقي هو المتغير بسعر الصرف». A product the
 * shop priced at $100 reads $100.00: the server sends the shop's own dollar
 * price beside the dinar price (`*_usd_cents`), and the client prints it.
 * Only a DINAR-NATIVE amount — a fee, points, a coupon — is still read at the
 * public display rate, and the public figure itself still gives nothing away.
 *
 * THE OPEN QUESTION, ANSWERED (owner 2026-10-18, DECISIONS row 252, resolving
 * row 248 (7)): «سعر الصرف يكون رسمي وسائد للموقع». The public figure is now
 * the APPLIED rate itself — one official rate for the products, the
 * storefront and the wallet — and the owner accepts that the applied rate is
 * visible. A dollar price beside its dinar price and the public figure agree:
 * there is one rate, and nothing to tell apart.
 *
 * LOCAL ONLY: in-memory SQLite, the real misc router (/api/settings/public),
 * the client's own exact converter (src/lib/displayRate.ts) and money()
 * (src/CurrencyContext.tsx), the server's own cent rounding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { applyRate, derivedOf } from './fixtures/fx';
import { miscRoutes } from '../worker/routes/misc';
import { iqdToUsdCentsExact } from '../src/lib/displayRate';
import { currencyValue } from '../src/CurrencyContext';
import { usdCeilCentsOf } from '../packages/pricing/src/usdCents';

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

test('a dinar-native amount (a 5,000 IQD delivery fee) reads at the official 1,680 — the applied rate is the public figure', async () => {
  const { settings } = await world();
  assert.equal(settings.displayUsdRate, '1680', 'the public figure is the rate the prices are built at');
  assert.equal(settings.displayUsdRateAttributed, true, 'built from IQWealth’s sell: «based on IQWealth data»');
  // A fee has no dollar base: it is read at the public rate, floored to the cent.
  assert.equal(iqdToUsdCentsExact(5_000, settings.displayUsdRate), 297, '$2.97 at the official rate');
  const money = currencyValue('USD', () => {}, { text: settings.displayUsdRate, source: 'shop' }).money;
  assert.equal(money(5_000), '$2.97');
});

test('a product the shop priced at $100 (168,000 IQD at the applied 1,680) reads $100.00 to a dollar reader — with or without the server’s dollar figure', async () => {
  const { settings } = await world();
  // The server's dollar price of the row (`usd_ceil6` '100' ceiled to the cent) travels beside its dinars.
  const cents = usdCeilCentsOf('100.000000');
  assert.equal(cents, 10_000);
  const view = currencyValue('USD', () => {}, { text: settings.displayUsdRate, source: 'shop' });
  assert.equal(view.money(100 * 1680, cents), '$100.00', 'the shop’s own dollars');
  // Without the server's figure (an older server, a legacy product) the reading at the official rate agrees.
  assert.equal(view.money(100 * 1680), '$100.00');
  // In dinars nothing moves.
  assert.equal(currencyValue('IQD', () => {}, { text: settings.displayUsdRate, source: 'shop' }).money(100 * 1680, cents), '168,000 د.ع');
});

test('one official rate (DECISIONS row 252): the dollar price beside its dinar price IS the public figure — the owner accepted the applied rate is visible', async () => {
  const { settings } = await world();
  const dinars = 100 * 1680;
  const cents = usdCeilCentsOf('100.000000')!;
  assert.equal(dinars / (cents / 100), Number(settings.displayUsdRate), 'one rate, nothing to tell apart');
});
