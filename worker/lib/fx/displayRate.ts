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
 * database without migration 0179: the client then reads prices in dinars,
 * never at the wallet's `exchangeRate` (owner decision 9 — the wallet's
 * 1 USD = 1,400 IQD is its own rate, not a market reading). Never throws. One
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

/**
 * IQD → US cents at the display rate, exactly — the same floor the browser
 * reads with (`iqdToUsdCentsExact`, src/lib/displayRate.ts): U = n / 10^k, so
 * cents = floor(|iqd| × 100 × 10^k / n), the sign put back. Null for an
 * unusable rate or dinar figure — never 0 for "unknown". For the admin price
 * preview (owner decision 9: it reads the shop's rate, never the wallet's).
 */
export function iqdToUsdCentsAtRate(iqd: number, rateText: string): number | null {
  const m = /^([0-9]{1,12})(?:\.([0-9]{1,12}))?$/.exec(rateText);
  if (!m || !Number.isFinite(iqd)) return null;
  const frac = m[2] ?? '';
  const den = BigInt(m[1]! + frac);
  if (den === 0n) return null;
  const cents = Number((BigInt(Math.floor(Math.abs(iqd))) * 100n * 10n ** BigInt(frac.length)) / den);
  return Number.isSafeInteger(cents) ? (iqd < 0 ? -cents : cents) : null;
}
