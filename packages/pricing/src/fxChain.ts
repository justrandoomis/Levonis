/**
 * THE FX CHAIN — pure, exact (FX programme plan §2, §3, brief §36).
 *
 * THE FINAL RULE. Pricing: SOURCE (USD, EUR or CNY) → CANONICAL CURRENT USD →
 * CURRENT IQD (× U) → final price (ceil to 1,000 on R + T, plus the Direct Sale
 * Extra). Inventory: the actual IQD paid, never re-converted.
 *
 * The three source rates:
 *   U = IQD per 1 USD (USD_IQD, the Iraqi parallel market plus the owner's adjustment)
 *   E = USD per 1 EUR (EUR_USD, the ECB reference)
 *   C = USD per 1 CNY (CNY_USD, ECB USD ÷ ECB CNY, rounded UP at the 10th decimal)
 *
 * E1 (`costToPrice.ts`) is unchanged: it is fed the effective IQD rates
 * USD = U, EUR = E × U and CNY = C × U, and because every product here is an
 * exact rational, `(amount × E) × U` equals `amount × (E × U)` to the last digit.
 *
 * Every value in and out is canonical decimal TEXT (the `parseProcurementDecimal`
 * grammar); nothing passes through a binary float.
 */
import {
  addProcurementExact,
  ceilToPlaces,
  compareProcurementExact,
  floorToPlaces,
  mulProcurementExact,
  procurementExact,
  procurementExactText,
  quotientProcurementExact,
  type ProcurementExact,
} from '@levonis/contracts/procurementCost';

export type FxSourceCurrency = 'USD' | 'EUR' | 'CNY';

/** How many decimals each stored rate may carry (plan §3). */
export const FX_RATE_PLACES = { USD_IQD: 4, EUR_USD: 6, CNY_USD: 10 } as const;

const ex = (text: string): ProcurementExact => procurementExact(text);
const exSigned = (text: string): ProcurementExact => procurementExact(text, { signed: true });
const abs = (x: ProcurementExact): ProcurementExact => (x.num < 0n ? { num: -x.num, den: x.den } : x);
const sub = (a: ProcurementExact, b: ProcurementExact): ProcurementExact => addProcurementExact(a, { num: -b.num, den: b.den });

/** C = ceil10(USD per EUR ÷ CNY per EUR): rounded UP so a cost is never under-stated (plan §3). */
export function crossRateCnyUsd(usdPerEur: string, cnyPerEur: string): string {
  return procurementExactText(ceilToPlaces(quotientProcurementExact(ex(usdPerEur), ex(cnyPerEur)), FX_RATE_PLACES.CNY_USD));
}

/** U = market sell + the owner's signed adjustment (IQD per USD, Q1), exact. */
export function usdIqdCandidate(marketSell: string, adjustment: string): string {
  return procurementExactText(addProcurementExact(ex(marketSell), exSigned(adjustment)));
}

/** The effective IQD rates E1 reads: USD = U, EUR = E × U, CNY = C × U — each null when an input is missing. */
export function composeIqdRates(
  usdIqd: string | null,
  eurUsd: string | null,
  cnyUsd: string | null
): Record<FxSourceCurrency, string | null> {
  if (usdIqd === null) return { USD: null, EUR: null, CNY: null };
  const u = ex(usdIqd);
  return {
    USD: procurementExactText(u),
    EUR: eurUsd === null ? null : procurementExactText(mulProcurementExact(ex(eurUsd), u)),
    CNY: cnyUsd === null ? null : procurementExactText(mulProcurementExact(ex(cnyUsd), u)),
  };
}

/** The current USD cost of a supplier input: USD as is, EUR × E, CNY × C; null when its rate is missing. */
export function currentUsdCost(
  input: { amount: string; currency: FxSourceCurrency },
  eurUsd: string | null,
  cnyUsd: string | null
): string | null {
  const amount = ex(input.amount);
  if (input.currency === 'USD') return procurementExactText(amount);
  const rate = input.currency === 'EUR' ? eurUsd : cnyUsd;
  return rate === null ? null : procurementExactText(mulProcurementExact(amount, ex(rate)));
}

/**
 * The IQD convenience input (§12): `floor6(I ÷ U)`. Rounded DOWN to 6 places,
 * which guarantees `ceil(usd × U) = I` for any whole I and any U < 1,000,000.
 */
export function iqdToCanonicalUsd(iqd: number | string, usdIqd: string): string {
  return procurementExactText(floorToPlaces(quotientProcurementExact(procurementExact(iqd), ex(usdIqd)), 6));
}

/** |candidate − reference| × 100 > pct × reference — the anomaly and drift tests (§30); exactly pct is NOT more. */
export function movesMoreThanPct(candidate: string, reference: string, pct: string): boolean {
  const ref = ex(reference);
  const left = mulProcurementExact(abs(sub(ex(candidate), ref)), procurementExact(100));
  return compareProcurementExact(left, mulProcurementExact(ex(pct), ref)) > 0;
}

/** |candidate − applied| × 100 < pct × applied — the dead band (§31, Q6). A pct of 0 is never inside. */
export function movesLessThanPct(candidate: string, applied: string, pct: string): boolean {
  const ref = ex(applied);
  const left = mulProcurementExact(abs(sub(ex(candidate), ref)), procurementExact(100));
  return compareProcurementExact(left, mulProcurementExact(procurementExact(pct), ref)) < 0;
}

/** Exact equality of two decimal texts ('1660' and '1660.0' are equal). */
export function sameRate(a: string, b: string): boolean {
  return compareProcurementExact(ex(a), ex(b)) === 0;
}

/** |after − before| ÷ before × 1e6, floored — display only. */
export function changePpm(before: string, after: string): number {
  const b = ex(before);
  const q = quotientProcurementExact(mulProcurementExact(abs(sub(ex(after), b)), procurementExact(1_000_000)), b);
  return Number(q.num / q.den);
}

/** (after − before) ÷ before × 100, signed, rounded half away from zero to 2 places — display only. */
export function changePctText(before: string, after: string): string {
  const b = ex(before);
  const q = quotientProcurementExact(mulProcurementExact(sub(ex(after), b), procurementExact(100)), b);
  const negative = q.num < 0n;
  const scaled = abs(q);
  // half away from zero: floor(|x| × 100 + 0.5) / 100
  const hundredths = (scaled.num * 200n + scaled.den) / (scaled.den * 2n);
  const text = procurementExactText({ num: hundredths, den: 100n });
  return negative && text !== '0' ? `-${text}` : text;
}

/** True when a decimal text lies within [min, max]. */
export function withinBounds(value: string, min: string, max: string): boolean {
  const v = ex(value);
  return compareProcurementExact(v, ex(min)) >= 0 && compareProcurementExact(v, ex(max)) <= 0;
}

/** The sum of |after − before| ÷ before, as an exact ratio, over a list of moves (the 24-hour owner budget, §7.8). */
export function sumOfMoves(moves: readonly { before: string; after: string }[]): ProcurementExact {
  let total: ProcurementExact = { num: 0n, den: 1n };
  for (const m of moves) {
    const b = ex(m.before);
    total = addProcurementExact(total, quotientProcurementExact(abs(sub(ex(m.after), b)), b));
  }
  return total;
}

/** A ratio (0.15 = 15%) exceeds pct percent. */
export function ratioExceedsPct(ratio: ProcurementExact, pct: string): boolean {
  return compareProcurementExact(mulProcurementExact(ratio, procurementExact(100)), ex(pct)) > 0;
}
