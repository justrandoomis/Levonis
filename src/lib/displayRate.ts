/**
 * THE SHOP'S DOLLAR, AS A READING OF A DINAR PRICE (FX programme plan §3,
 * §13 "Rate source" and "Conversion").
 *
 * `/api/settings/public` carries `displayUsdRate`: the effective USD/IQD —
 * the Iraqi parallel-market sell plus the owner's adjustment, once approved —
 * as DECIMAL TEXT ("1703.9167"). It is the one FX figure that is public, and
 * this module is the only place the browser reads it.
 *
 * NO FLOAT EVER TOUCHES IT. U = n / 10^k is read as two BigInts and a dinar
 * price becomes cents as `floor(iqd × 100 × 10^k / n)` — the same floor the
 * wallet reads with (src/CurrencyContext.tsx «وعند الدولار يقرب الى عدد صحيح
 * اقل»). 1,500,000 IQD at "1500" is 100,000 cents: $1,000.00, exactly.
 *
 * THE CACHE. The last good display rate is kept per device under
 * `levonis.displayRate.v1` as `{rate, at}`, so a returning dollar reader sees
 * dollars at first paint instead of a hard-coded 1,400 or a flash of dinars.
 * It is public data (the same figure every visitor is served) and only ever a
 * display: no request, no cart and no charge reads it. Storage can throw
 * (private mode, blocked site data); every read and write is wrapped.
 *
 * Pure apart from the two storage helpers: no React, no request, no provider.
 * Nothing here fetches — the browser never calls an exchange-rate provider
 * (tests/displayCurrency.test.ts, tests/bundlePrivateNames.test.ts).
 *
 * SMALL ON PURPOSE: this module is in every visitor's first paint, under the
 * storefront payload budget (tests/bundleBudget.test.ts). The rate written
 * for reading («1,703.9167») lives in ./rateText, loaded only by the screens
 * that print it.
 */

/** Decimal text the server may send: digits, an optional fraction, no sign, no exponent. */
const DECIMAL = /^(\d{1,12})(?:\.(\d{1,12}))?$/;

/** The per-device cache of the last rate a price was shown at. */
export const DISPLAY_RATE_CACHE_KEY = 'levonis.displayRate.v1';
/** A cached rate older than this is not used for a first paint. */
export const DISPLAY_RATE_CACHE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

/**
 * The rate as usable decimal text, or null: strictly positive, at most 12 + 12
 * digits, nothing else. A number, an exponent, a sign, a comma — all null. A
 * NUMBER rate (the wallet's `exchangeRate`, 1400) is read with `String(n)`
 * first by the caller; anything that prints with an exponent is refused here.
 */
export function usableRate(value: unknown): string | null {
  return typeof value === 'string' && DECIMAL.test(value) && /[1-9]/.test(value) ? value : null;
}

/**
 * IQD → US cents at a decimal-text rate, exactly: U = n / 10^k, so cents =
 * floor(|iqd| × 100 × 10^k / n), with the sign put back. Null when there is no
 * usable rate or no finite dinar figure — never 0 for "unknown", so a caller
 * cannot print «$0.00» for a real price.
 */
export function iqdToUsdCentsExact(iqd: number, rateText: string | null | undefined): number | null {
  const m = usableRate(rateText) && DECIMAL.exec(rateText!);
  if (!m || !Number.isFinite(iqd)) return null;
  const frac = m[2] ?? '';
  const cents = Number((BigInt(Math.floor(Math.abs(iqd))) * 100n * 10n ** BigInt(frac.length)) / BigInt(m[1] + frac));
  return Number.isSafeInteger(cents) ? (iqd < 0 ? -cents : cents) : null;
}

// ------------------------------------------------------------- the cache

/** The cached rate, when it is usable and recent; null otherwise (and when storage refuses). */
export function readCachedDisplayRate(now: number = Date.now()): string | null {
  try {
    const c = JSON.parse(localStorage.getItem(DISPLAY_RATE_CACHE_KEY) || 'null') as { rate?: unknown; at?: unknown } | null;
    const at = c && typeof c.at === 'number' ? c.at : NaN;
    return at <= now + 60_000 && now - at <= DISPLAY_RATE_CACHE_MAX_AGE_MS ? usableRate(c!.rate) : null;
  } catch {
    return null;
  }
}

/** Remember the rate prices were just shown at. Storage that refuses changes nothing. */
export function rememberDisplayRate(rate: string, now: number = Date.now()): void {
  try {
    if (usableRate(rate)) localStorage.setItem(DISPLAY_RATE_CACHE_KEY, JSON.stringify({ rate, at: now }));
  } catch {
    /* A device that will not store it reads dinars until the settings arrive. */
  }
}
