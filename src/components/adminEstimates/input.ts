/**
 * WHAT THE OWNER TYPES, READ EXACTLY (docs/SMART_PRICING.md §3.6, §4.1).
 *
 * Decimals stay TEXT from the keyboard to the wire — a supplier price, a
 * minimum profit in dollars, a volume in m³ — because the server refuses a
 * binary float (the 0181 decimal grammar). Whole numbers (grams, millimetres,
 * dinars, days, units) travel as integers. Nothing here is ever computed with:
 * no price, rate or profit is derived in the browser.
 *
 * The digits people in Iraq type are read as they are meant — Arabic-Indic
 * (٠–٩) and Persian (۰–۹) digits, the Arabic decimal separator «٫» and the
 * thousands separator «٬». A comma is a thousands separator only between
 * groups of three digits (1,599); anything else that is not a plain decimal
 * is refused, never guessed («27,99» is refused: the owner types 27.99).
 */

const DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/** Latin digits and a point: the reader's digits transliterated, spaces and the Arabic thousands mark dropped. */
export function latinDigits(raw: string): string {
  return raw
    .replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d] ?? d)
    .replace(/٫/g, '.')
    .replace(/[\u066c\s\u00a0\u202f]/g, '');
}

/** A comma between groups of three digits is a thousands separator (1,599 → 1599); any other comma is not read. */
function withoutGroupCommas(s: string): string | null {
  if (!s.includes(',')) return s;
  const [int = '', ...rest] = s.split('.');
  if (rest.length > 1 || !/^\d{1,3}(,\d{3})+$/.test(int)) return null;
  return int.replace(/,/g, '') + (rest.length ? `.${rest[0]}` : '');
}

/**
 * A positive decimal as TEXT in the server's grammar (digits, at most one
 * point, never a trailing point, > 0 — or ≥ 0 with `allowZero`, for a figure
 * whose grammar takes 0, the profit ceiling's), canonical: leading zeros
 * dropped and trailing fraction zeros kept as typed. `max` decimals and
 * `maxLength` characters, else null. Empty input is `''`.
 */
export function decimalText(raw: string, opts: { maxDecimals?: number; maxLength?: number; allowZero?: boolean } = {}): string | '' | null {
  const s0 = latinDigits(raw);
  if (s0 === '') return '';
  const s = withoutGroupCommas(s0);
  if (s === null) return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const int = m[1]!.replace(/^0+(?=\d)/, '');
  const frac = m[2] ?? '';
  if (opts.maxDecimals !== undefined && frac.length > opts.maxDecimals) return null;
  const text = frac ? `${int}.${frac}` : int;
  if (!opts.allowZero && !/[1-9]/.test(text)) return null;
  if (text.length > (opts.maxLength ?? 24)) return null;
  return text;
}

/** A whole number within [min, max], or null; empty input is `''`. */
export function wholeNumber(raw: string, min: number, max: number): number | '' | null {
  const s0 = latinDigits(raw);
  if (s0 === '') return '';
  const s = withoutGroupCommas(s0);
  if (s === null || !/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** A short note (≤ `max` characters, no control or bidi-override character), trimmed; null when it fails. */
export function noteText(raw: string, max = 300): string | null {
  const t = raw.trim();
  return t.length <= max && !CONTROL.test(t) ? t : null;
}
