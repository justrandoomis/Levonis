/**
 * THE ONE PUBLIC FX FIGURE (FX programme plan §8 "Public", §13, §14.4 risk 1).
 *
 * The top bar's display currency divides a dinar price by the shop's
 * effective USD/IQD: `pricing_fx_rates.rate_iqd` for USD, as decimal text —
 * the parallel-market sell plus the owner's adjustment, once approved. It is
 * public by necessity (anyone can read dollar prices) and it is the ONLY FX
 * figure that is: no provider, market, adjustment, pending or history value
 * ever reaches `/api/settings/public` or `/api/home`.
 *
 * Null until the owner approves the first USD/IQD value, and null on a
 * database without migration 0179 (the client then falls back to the wallet's
 * `exchangeRate`, so nothing regresses the day this lands). Never throws.
 */
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

export async function getDisplayUsdRate(db: D1Database): Promise<string | null> {
  try {
    const row = await db.prepare("SELECT rate_iqd FROM pricing_fx_rates WHERE currency = 'USD'").first<{ rate_iqd: unknown }>();
    const rate = row?.rate_iqd;
    return typeof rate === 'string' && DECIMAL.test(rate) && rate.length <= 32 ? rate : null;
  } catch {
    return null;
  }
}
