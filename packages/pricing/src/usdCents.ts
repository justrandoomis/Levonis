/**
 * THE SHOP'S DOLLAR PRICE, IN WHOLE CENTS (DECISIONS row 248; the owner,
 * 2026-10-17: «الدولار هو الاساس … الدولار هو الثابت والدينار العراقي هو
 * المتغير بسعر الصرف»).
 *
 * Pricing V2 builds every price from dollars: each `pricing_v2_sku_results`
 * row keeps `usd_ceil6`, the selling price in dollars to six decimals, beside
 * the dinar price derived from it at the applied rate. A customer reading
 * dollars is shown that figure — never the rounded dinar price divided back
 * by a rate, which turns the dinar round-up into extra cents ($15.20 read as
 * $15.66).
 *
 * ONE ROUNDING, UP TO THE CENT, exact: the figure the product form prints
 * («≈ $15.20», worker/lib/offerDiscount.ts) and the storefront prints are the
 * same function. A price-first row's `usd_ceil6` is the typed dollars, so
 * nothing moves; a cost-first row never reads below its price — the same
 * direction as the dinar side's round-up (row 245).
 *
 * NO FLOAT EVER: decimal text in, BigInt rational arithmetic, an integer out.
 */
import { procurementExact, type ProcurementExact } from '@levonis/contracts/procurementCost';

/** The most cents a dollar price may be ($100,000,000): anything larger is a broken row, not a price. */
const MAX_CENTS = 10_000_000_000;

/**
 * A stored dollar figure (`usd_ceil6`, decimal text, > 0) rounded UP to the
 * whole cent, exactly. Null for anything that is not one — absent, empty,
 * zero, negative, a number, an exponent — so a caller falls back to the
 * conversion rather than printing a guessed figure.
 */
export function usdCeilCentsOf(text: string | null | undefined): number | null {
  if (typeof text !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(text.trim())) return null;
  try {
    const exact = procurementExact(text.trim());
    if (exact.num <= 0n) return null;
    const cents = usdCeilCentsOfExact(exact);
    return cents >= 1 && cents <= MAX_CENTS ? cents : null;
  } catch {
    return null;
  }
}

/** An exact non-negative dollar rational rounded UP to the whole cent (the one rounding above). Throws past a safe integer. */
export function usdCeilCentsOfExact(exact: ProcurementExact): number {
  if (exact.den <= 0n || exact.num < 0n) throw new RangeError('A dollar figure is a non-negative rational');
  const scaled = exact.num * 100n;
  const cents = Number(scaled / exact.den + (scaled % exact.den > 0n ? 1n : 0n));
  if (!Number.isSafeInteger(cents)) throw new RangeError('A dollar figure beyond a safe number of cents');
  return cents;
}

/**
 * A percent off a dollar price, rounded UP to the cent: ceil(before × (100 − p) / 100) — the dollar
 * twin of the dinar side's `roundPriceIqd` of the same product. Null for an unusable input or a result
 * below one cent.
 */
export function percentOffUsdCents(beforeCents: number, percent: number): number | null {
  if (!Number.isSafeInteger(beforeCents) || beforeCents < 1 || !Number.isInteger(percent) || percent < 1 || percent > 99) return null;
  const scaled = BigInt(beforeCents) * BigInt(100 - percent);
  const cents = Number(scaled / 100n + (scaled % 100n > 0n ? 1n : 0n));
  return cents >= 1 ? cents : null;
}

/** A dollar figure a payload may carry: a whole, non-negative, safe number of cents. */
export function isUsdCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
