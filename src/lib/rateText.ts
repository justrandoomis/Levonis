/**
 * The shop's display rate WRITTEN FOR READING — «1,703.9167» — as text, never
 * through a float (FX programme plan §13). Its own module so the first paint
 * does not carry it: only the top-bar menu, the Settings page and the owner's
 * rates panel print a rate.
 */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** «1,703.9167» — the rate grouped for reading; an unexpected shape is shown as sent. */
export function groupRateText(rateText: string): string {
  const m = DECIMAL.exec(rateText);
  if (!m) return rateText;
  const grouped = m[1]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return m[2] ? `${grouped}.${m[2]}` : grouped;
}

/**
 * A non-negative decimal text rounded HALF UP to `places` decimals, as text
 * (BigInt on the digits — never a float): «1703.9167» → «1704» at 0,
 * «0.1392023689» → «0.139202» at 6. Trailing zeros dropped; an unexpected
 * shape comes back as sent. For READING only — a figure that is stored or
 * sent is always the server's exact text.
 */
export function roundDecimalText(text: string, places: number): string {
  const m = DECIMAL.exec(text);
  if (!m) return text;
  const int = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length <= places) return text;
  let digits = int + frac.slice(0, places);
  if (frac.charCodeAt(places) - 48 >= 5) digits = (BigInt(digits) + 1n).toString().padStart(digits.length, '0');
  const whole = digits.slice(0, digits.length - places).replace(/^0+(?=\d)/, '') || '0';
  const fraction = places ? digits.slice(digits.length - places).replace(/0+$/, '') : '';
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * «1 $ ≈ 1,704» — the CUSTOMER's reading of the shop's rate: whole dinars.
 * The rate carries up to four decimals (the owner's adjustment is decimal
 * text); four decimals after «≈» is false precision on a line that only
 * explains a conversion (FX-1 UX review #15). The conversion itself still
 * divides by the exact text (src/lib/displayRate.ts).
 */
export const wholeRateText = (rateText: string): string => groupRateText(roundDecimalText(rateText, 0));
