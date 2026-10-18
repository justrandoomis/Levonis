/**
 * THE ONE PUBLIC FX FIGURE (FX programme plan §8 "Public", §13, §14.4 risk 1).
 *
 * The top bar's display currency divides a dinar price by a USD/IQD rate. It is
 * public by necessity (anyone can read dollar prices) and it is the ONLY FX
 * figure that is: no adjustment, typed-but-pending, guard or history value
 * ever reaches `/api/settings/public` or `/api/home`.
 *
 * WHICH RATE: THE OFFICIAL ONE (owner 2026-10-18, DECISIONS row 252, amending
 * rows 220, 246 and 248). «سعر الصرف يكون رسمي وسائد للموقع»: the figure is the
 * APPLIED USD/IQD every product is priced at (`pricing_fx_rates.rate_iqd`) —
 * on AUTO the market sell plus the owner's adjustment, on MANUAL the rate he
 * typed — exactly, as decimal text. It used to be the market sell the rate was
 * last built from (row 220) so that the adjustment stayed private; the owner
 * chose one official rate for the products, the storefront and the wallet,
 * accepting that the applied rate is visible (row 248 clause (7) resolved).
 * Beside it, `exchangeRate`: the same U in whole dinars
 * (worker/lib/fx/officialRate.ts), which overrides the legacy setting of that
 * name in the public answer, so the wallet the browser draws reads U too.
 *
 * `displayUsdRateAttributed`, one flag and no figure: true when the rate in
 * force was built from the provider's market reading (`effective_source`
 * 'provider' or 'review_approved', the menu reads «the shop's rate, based on
 * IQWealth data»), false when the owner typed it («a rate set by the shop», no
 * credit) — on MANUAL, and on AUTO too while U is still the rate he typed (a
 * back-to-AUTO fetch that failed, was held or moved nothing keeps
 * `effective_source` 'manual'; an adjustment shifts U and keeps it). Whether a
 * market reading merely exists says nothing about where U came from.
 *
 * Null (and no `exchangeRate`, so the legacy setting stands) until the owner
 * approves or types the first USD/IQD value, and on a database without
 * migration 0179: the client then reads prices in dinars and says so. Never
 * throws. One statement, read in the same wave as the settings. Every move of
 * U purges every cached answer that carries it (commit.ts
 * `displayRateChanged`; adminPricing.ts `commitAct`).
 */
import { sameRate } from '@levonis/pricing/fxChain';

const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

export interface PublicDisplayRate {
  displayUsdRate: string | null;
  displayUsdRateAttributed: boolean | null;
  /** The official rate in whole dinars — present only when an applied rate exists. */
  exchangeRate?: number;
}

const usable = (v: unknown): v is string => typeof v === 'string' && DECIMAL.test(v) && v.length <= 32;

/**
 * A USD/IQD decimal text as whole dinars per dollar (nearest), or null when
 * unusable. The wallet, the snapshots and the orders count whole dinars
 * (worker/lib/fx/officialRate.ts).
 */
export function wholeDinarRate(rateText: unknown): number | null {
  if (typeof rateText !== 'string' || !/^[0-9]{1,12}(\.[0-9]{1,12})?$/.test(rateText)) return null;
  const rounded = Math.round(Number(rateText));
  return Number.isSafeInteger(rounded) && rounded >= 1 ? rounded : null;
}

export async function getPublicDisplayRate(db: D1Database): Promise<PublicDisplayRate> {
  const none: PublicDisplayRate = { displayUsdRate: null, displayUsdRateAttributed: null };
  try {
    const row = await db
      .prepare(
        `SELECT r.rate_iqd, p.manual_rate AS typed_rate, p.effective_rate, p.effective_source
           FROM pricing_fx_rates r
           LEFT JOIN fx_rate_pairs p ON p.pair = 'USD_IQD'
          WHERE r.currency = 'USD'`
      )
      .first<{ rate_iqd: unknown; typed_rate: unknown; effective_rate: unknown; effective_source: unknown }>();
    // No applied rate yet: nothing is published (the first value waits for the owner).
    if (!row || !usable(row.rate_iqd)) return none;
    const whole = wholeDinarRate(row.rate_iqd);
    if (whole === null) return none;
    // MANUAL: the rate in force IS `manual_rate` (the table's CHECK) — the shop's own, never credited.
    const typed = usable(row.typed_rate) && sameRate(row.rate_iqd, row.typed_rate);
    // Credited only when the rate in force is the pair's market-built one: its source says how U was
    // made (a typed rate stays 'manual' back on AUTO until the market replaces it).
    const fromMarket =
      (row.effective_source === 'provider' || row.effective_source === 'review_approved') &&
      usable(row.effective_rate) &&
      sameRate(row.rate_iqd, row.effective_rate);
    return { displayUsdRate: row.rate_iqd, displayUsdRateAttributed: fromMarket && !typed, exchangeRate: whole };
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
 * typed: since DECISIONS row 252 the shop's one official rate, the same figure
 * the public display rate carries. Null when unset or unreadable. Never throws.
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
 * preview (it reads the shop's official rate, DECISIONS row 252).
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
