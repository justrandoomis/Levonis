/**
 * NUMBERS AS PEOPLE IN IRAQ TYPE THEM.
 *
 * A merchant typing a price on an Arabic or a Kurdish keyboard types ١٢٬٠٠٠ —
 * Arabic-Indic digits, and the Arabic thousands separator U+066C — and a
 * Kurdish (Sorani) layout often produces the Extended forms ۱۲۰۰۰ instead.
 * `Number('١٢٠٠٠')` is NaN, so a field that only understands ASCII silently
 * throws the price away, or worse, a naive `parseInt` keeps the "12" of
 * "12,000" and saves a price a thousand times too small.
 *
 * This module is the one place that reading happens. It is pure (no DOM, no
 * React), so it is tested directly (`tests/uiPrimitivesLogic.test.ts`) and
 * shared by `NumberInput` and anything else that accepts a typed figure.
 *
 * MONEY IS WHOLE DINARS. With `decimals = 0` a decimal point is not rounded
 * away — the input is INVALID, and the field says so. Silently turning a typed
 * «12.5» into 13 or 12 is changing a price nobody asked to change.
 */

/** ٠-٩ (U+0660…) and ۰-۹ (U+06F0…) → 0-9. Everything else is left alone. */
export function toAsciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
    const c = ch.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

export interface ParsedNumber {
  /** The number, or null for an empty field or an unreadable one. */
  value: number | null;
  /** False only when something was typed and it is not a number this field takes. */
  valid: boolean;
}

/**
 * Reads what a person typed.
 *
 * Accepted: ASCII, Arabic-Indic and Extended Arabic-Indic digits; thousands
 * grouped with `,` `٬` `،` a space or a thin/no-break space; `.` or `٫` as the
 * decimal point when `decimals > 0`; a leading `-` or `−` (the caller decides
 * whether a negative figure is allowed — `min`).
 */
export function parseLocaleNumber(raw: string, decimals = 0): ParsedNumber {
  let s = toAsciiDigits(raw).trim();
  if (s === '') return { value: null, valid: true };
  s = s
    .replace(/[\s\u00A0\u202F\u066C,\u060C'_]/g, '')
    .replace(/\u066B/g, '.')
    .replace(/^[\u2212\u2013]/, '-');
  const shape = decimals > 0 ? new RegExp(`^-?\\d+(?:\\.\\d{1,${decimals}})?$`) : /^-?\d+$/;
  if (!shape.test(s) || s.replace(/\D/g, '').length > 15) return { value: null, valid: false };
  const value = Number(s);
  if (!Number.isFinite(value)) return { value: null, valid: false };
  return { value: Object.is(value, -0) ? 0 : value, valid: true };
}

/**
 * The text a field shows for a stored value while it is being EDITED: plain
 * ASCII digits, no grouping, so the caret never jumps over a separator.
 */
export function editableNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '' : String(value);
}

/** The text a field shows at rest: grouped, Latin digits (a figure is an LTR island). */
export function groupedNumber(value: number | null | undefined, decimals = 0): string {
  if (value == null || !Number.isFinite(value)) return '';
  return value.toLocaleString('en-US', { maximumFractionDigits: decimals, useGrouping: true });
}

/**
 * A figure for READING — a count, a percentage — in the same digits the
 * app's money uses: `formatIqd` writes the dinar with the browser's own
 * locale digits, so in Arabic and Kurdish a percentage beside a price follows
 * the same locale (١٢٫٥ next to ١٬٢٥٠٬٠٠٠) rather than mixing digit systems
 * in one tile. English is Latin, explicitly.
 */
export function formatFigure(value: number, lang: 'ar' | 'en' | 'ckb', maximumFractionDigits = 0, signed = false): string {
  return value.toLocaleString(lang === 'en' ? 'en-US' : undefined, {
    maximumFractionDigits,
    signDisplay: signed ? 'exceptZero' : 'auto',
  });
}

/**
 * «12.5%» / «١٢٫٥٪» — a percentage (12.5 means 12.5%) in the same digits as
 * `formatFigure`. `signed` writes «+» for a rise. The locale places the sign
 * and «٪» itself (with its own bidi marks), so render it in an isolate whose
 * direction is automatic, not a forced LTR one.
 */
export function formatPercent(value: number, lang: 'ar' | 'en' | 'ckb', maximumFractionDigits = 1, signed = false): string {
  return (value / 100).toLocaleString(lang === 'en' ? 'en-US' : undefined, {
    style: 'percent',
    maximumFractionDigits,
    signDisplay: signed ? 'exceptZero' : 'auto',
  });
}
