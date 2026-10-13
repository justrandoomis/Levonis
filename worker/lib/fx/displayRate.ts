/**
 * THE ONE PUBLIC FX FIGURE (FX programme plan §8 "Public", §13, §14.4 risk 1).
 *
 * The top bar's display currency divides a dinar price by a USD/IQD rate. It is
 * public by necessity (anyone can read dollar prices) and it is the ONLY FX
 * figure that is: no adjustment, applied, typed, pending or history value ever
 * reaches `/api/settings/public` or `/api/home`.
 *
 * WHICH RATE (owner rule 2026-10-10, DECISIONS row 220). It used to be the
 * shop's EFFECTIVE rate — the parallel-market sell PLUS the owner's private
 * `market_adjustment_iqd` — credited to IQWealth beside a link to IQWealth's
 * own page. Subtracting the sell IQWealth publishes gave every visitor the
 * owner's adjustment exactly, and each later change of it as a step in the
 * public figure. The public figure is now the MARKET SELL that the last
 * market-built rate was built from: IQWealth's own public number, exactly
 * (no rounding — with a zero adjustment it is the applied rate to the last
 * decimal), which is what the credit says it is.
 *
 * WHERE IT IS READ. Not from the pair's live columns: on MANUAL («إيقاف») the
 * adjustment is no part of the rate in force, yet the owner may still save a
 * new one, and a rate the owner TYPES carries none at all — `effective −
 * current adjustment` then published a figure that moved with an act that
 * moved no rate, and a typed rate published as it is told every visitor the
 * owner's markup over the market (both found by the verification of row 220).
 * So it is read from the immutable FX log: the newest USD/IQD row that
 * APPLIED a rate built as market + adjustment (`apply`, `review_approved`,
 * `review_cleared` with result APPLIED — each records the adjustment it
 * carried), as `effective_after − market_adjustment_iqd`. Only a new market
 * reading the shop applies moves it. An adjustment change on AUTO shifts the
 * rate in force by its own amount and writes no such row; a freeze, a typed
 * rate and an adjustment saved on MANUAL write none either — the public
 * figure stays the market it was. With no such row yet (a typed rate before
 * any market reading was ever applied) it is the provider's last validated
 * reading, `fx_rate_pairs.market_rate`, and with neither, null.
 *
 * Beside it, one flag and no figure: `displayUsdRateAttributed` — true
 * whenever a figure is published, since every figure published is IQWealth's
 * own (the customer menu and Settings credit IQWealth, «based on IQWealth
 * data»). Prices are dinars and are built at the APPLIED rate
 * (`pricing_fx_rates`); this only converts them for reading, so no price
 * anyone pays moves — a dollar reading is the dinar price at the market rate.
 *
 * Null until the owner approves the first USD/IQD value (no applied rate, no
 * public rate), and null on a database without migration 0179: the client then
 * reads prices in dinars, never at the wallet's `exchangeRate` (owner decision
 * 9 — the wallet's 1 USD = 1,400 IQD is its own rate, not a market reading).
 * Never throws. One statement, read in the same wave as the settings.
 */
import { rebaseOnAdjustment } from '@levonis/pricing/fxChain';

const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;
const SIGNED = /^[+-]?[0-9]+(\.[0-9]+)?$/;

export interface PublicDisplayRate {
  displayUsdRate: string | null;
  displayUsdRateAttributed: boolean | null;
}

const usable = (v: unknown): v is string => typeof v === 'string' && DECIMAL.test(v) && v.length <= 32;

export async function getPublicDisplayRate(db: D1Database): Promise<PublicDisplayRate> {
  const none: PublicDisplayRate = { displayUsdRate: null, displayUsdRateAttributed: null };
  try {
    const row = await db
      .prepare(
        `SELECT r.rate_iqd,
                (SELECT market_rate FROM fx_rate_pairs WHERE pair = 'USD_IQD') AS last_market,
                l.effective_after AS built_rate,
                l.market_adjustment_iqd AS built_adjustment
           FROM pricing_fx_rates r
           LEFT JOIN (SELECT effective_after, market_adjustment_iqd FROM fx_rate_log
                       WHERE pair = 'USD_IQD' AND result = 'APPLIED'
                         AND event IN ('apply', 'review_approved', 'review_cleared')
                         AND effective_after IS NOT NULL AND market_adjustment_iqd IS NOT NULL
                       ORDER BY created_at DESC, rowid DESC LIMIT 1) l ON 1 = 1
          WHERE r.currency = 'USD'`
      )
      .first<{ rate_iqd: unknown; last_market: unknown; built_rate: unknown; built_adjustment: unknown }>();
    // No applied rate yet: nothing is published (the first value waits for the owner).
    if (!row || !usable(row.rate_iqd)) return none;
    let market: string | null = null;
    if (usable(row.built_rate) && typeof row.built_adjustment === 'string' && SIGNED.test(row.built_adjustment)) {
      market = rebaseOnAdjustment(row.built_rate, row.built_adjustment, '0');
    } else if (usable(row.last_market)) {
      market = row.last_market;
    }
    return market !== null && usable(market) ? { displayUsdRate: market, displayUsdRateAttributed: true } : none;
  } catch {
    return none;
  }
}

/** The public figure alone. */
export async function getDisplayUsdRate(db: D1Database): Promise<string | null> {
  return (await getPublicDisplayRate(db)).displayUsdRate;
}

/**
 * THE APPLIED USD/IQD — the rate every engine price is built at
 * (`pricing_fx_rates.rate_iqd`), market + the owner's adjustment or the rate he
 * typed. OWNER-ONLY: beside the public market figure it IS the adjustment.
 * Read by the owner's own price preview so the owner keeps reading the dollar
 * price he set; never by a public or staff answer. Null when unset or
 * unreadable. Never throws.
 */
export async function getAppliedUsdRate(db: D1Database): Promise<string | null> {
  try {
    const row = await db.prepare("SELECT rate_iqd FROM pricing_fx_rates WHERE currency = 'USD'").first<{ rate_iqd: unknown }>();
    const rate = row?.rate_iqd;
    return usable(rate) ? rate : null;
  } catch {
    return null;
  }
}

/**
 * IQD → US cents at a USD/IQD rate, exactly — the same floor the browser
 * reads with (`iqdToUsdCentsExact`, src/lib/displayRate.ts): U = n / 10^k, so
 * cents = floor(|iqd| × 100 × 10^k / n), the sign put back. Null for an
 * unusable rate or dinar figure — never 0 for "unknown". For the admin price
 * preview (owner decision 9: it reads the shop's rate, never the wallet's —
 * the applied rate for the owner, the public market figure for staff).
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
