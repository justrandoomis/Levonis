/**
 * WHAT THE OWNER TYPES ON THE EXCHANGE-RATE PANEL, AS THE TEXT THE SERVER
 * TAKES (FX programme plan §8, §12).
 *
 * Pure. It checks the SHAPE only — the server's exact parser decides — and it
 * never turns a decimal into a number: a rate, a percentage, an adjustment
 * and a shipping rate all travel as decimal TEXT, read from the digits people
 * in Iraq type (Arabic-Indic, Extended, the Arabic decimal point, thousands
 * grouping that really groups) by the what-if form's own reader. The client
 * never computes a rate (§12 "Rules").
 */
import { toAsciiDigits } from '../../lib/localeNumber';
import { decimalOf } from './whatIfRequest';
import type { FxPairId } from './api';

/** Fraction digits the server keeps per pair (worker/lib/fx/ownerActs.ts RATE_PLACES). */
export const FX_RATE_PLACES: Readonly<Record<FxPairId, number>> = { USD_IQD: 4, EUR_USD: 6, CNY_USD: 10 };

/** A rate for a pair: decimal text above zero, or null. */
export const fxRateInput = (raw: string, pair: FxPairId): string | null => decimalOf(raw, 6, FX_RATE_PLACES[pair]);

/** A central shipping rate in dinars per kg or per CBM: decimal text above zero, or null. */
export const shippingRateInput = (raw: string): string | null => decimalOf(raw, 9, 6);

/** A percentage (the «%» may be typed): decimal text, «0» only where zero is allowed, or null. */
export function pctInput(raw: string, allowZero: boolean): string | null {
  const t = toAsciiDigits(raw).replace(/[%٪]/g, '').trim();
  if (allowZero && /^0+(?:[.٫]0+)?$/.test(t)) return '0';
  return decimalOf(t, 2, 3);
}

/** The USD/IQD adjustment (Q1: signed dinars per dollar): «-25», «12.5», «0», or null. */
export function adjustmentInput(raw: string): string | null {
  const t = toAsciiDigits(raw).trim().replace(/^[−–]/, '-');
  const m = /^([+-]?)\s*(.+)$/.exec(t);
  if (!m) return null;
  const body = m[2]!;
  if (/^0+(?:[.٫]0+)?$/.test(body)) return '0';
  const d = decimalOf(body, 5, 4);
  if (!d) return null;
  return m[1] === '-' ? `-${d}` : d;
}
