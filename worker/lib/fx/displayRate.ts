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
 * Beside it, one flag and no figure: `displayUsdRateAttributed` — true when
 * the rate came from the provider's data (applied or approved, even if since
 * frozen as manual), false when the owner TYPED it (a manual rate). The
 * customer menu and Settings credit IQWealth («based on IQWealth data») only
 * when it is true; a typed rate is «a rate set by the shop» (FX-1 review #10).
 * It says nothing the effective rate does not already show over a few days.
 *
 * Null until the owner approves the first USD/IQD value, and null on a
 * database without migration 0179 (the client then falls back to the wallet's
 * `exchangeRate`, so nothing regresses the day this lands). Never throws. One
 * statement, read in the same wave as the settings.
 */
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

export interface PublicDisplayRate {
  displayUsdRate: string | null;
  displayUsdRateAttributed: boolean | null;
}

export async function getPublicDisplayRate(db: D1Database): Promise<PublicDisplayRate> {
  try {
    const row = await db
      .prepare("SELECT rate_iqd, (SELECT effective_source FROM fx_rate_pairs WHERE pair = 'USD_IQD') AS source FROM pricing_fx_rates WHERE currency = 'USD'")
      .first<{ rate_iqd: unknown; source: unknown }>();
    const rate = row?.rate_iqd;
    const ok = typeof rate === 'string' && DECIMAL.test(rate) && rate.length <= 32;
    return ok ? { displayUsdRate: rate, displayUsdRateAttributed: row?.source !== 'manual' } : { displayUsdRate: null, displayUsdRateAttributed: null };
  } catch {
    return { displayUsdRate: null, displayUsdRateAttributed: null };
  }
}

/** The figure alone. */
export async function getDisplayUsdRate(db: D1Database): Promise<string | null> {
  return (await getPublicDisplayRate(db)).displayUsdRate;
}
