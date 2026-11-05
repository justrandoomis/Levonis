/**
 * FIGURES FOR READING, NEVER FOR COMPUTING (docs/SMART_PRICING.md §7).
 *
 * The workspace writes the owner's figures — supplier prices, R and D in
 * dinars, grams, millimetres, ids, dates — in Latin digits, as the exchange
 * rate panel does, each an LTR island so it never reorders in an Arabic or
 * Sorani row. Exact decimal TEXT from the server is grouped without passing
 * through a binary float; no figure is derived here. Pure: no React.
 */
import { COMMON, say, type UiLang } from './strings';

/** «1599.5» → «1,599.5» — exact text, grouped; '—' when absent. */
export function groupDecimal(text: string | null | undefined): string {
  if (text === null || text === undefined || text === '') return '—';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return text;
  const grouped = m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${m[1]}${grouped}${m[3] ? `.${m[3]}` : ''}`;
}

/** A whole number (grams, millimetres, dinars, a count) grouped; '—' when absent. */
export function groupWhole(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return groupDecimal(String(Math.trunc(n)));
}

/** A supplier amount with its currency: «CNY 99» (the ISO code, language-neutral). */
export function moneyText(amount: string | null | undefined, currency: string | null | undefined): string {
  if (!amount) return '—';
  return currency ? `${currency} ${groupDecimal(amount)}` : groupDecimal(amount);
}

/** Dinars with the reader's unit: «17,500 د.ع». */
export function iqdText(n: number | null | undefined, lang: UiLang): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${groupWhole(n)} ${say(COMMON.iqd, lang)}`;
}

/**
 * Whole grams or millimetres as the pricing form shows them, in kilograms or centimetres: «100» → «0.1», «165» →
 * «16.5». Integer division and remainder only, never a binary float (the product form's `formatScaledInteger`,
 * copied: this chunk imports nothing of the form's).
 */
function scaledText(n: number, scale: 10 | 1000): string {
  if (!Number.isSafeInteger(n) || n < 0) return '—';
  const whole = Math.floor(n / scale);
  const rest = n % scale;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(String(scale).length - 1, '0').replace(/0+$/, '')}`;
}

/** Grams as kilograms («0.1»), for the measures the confirmation shows. */
export const kgText = (grams: number): string => scaledText(grams, 1000);
/** Millimetres as centimetres («16.5»). */
export const cmText = (millimetres: number): string => scaledText(millimetres, 10);

/** The day of an ISO stamp or a YYYY-MM-DD date: «2026-10-31». */
export function dayOf(stamp: string | null | undefined): string {
  if (!stamp) return '—';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(stamp);
  return m ? m[1]! : '—';
}

/** A server percentage («12.50», «-3.1») for reading: two decimals at most, never through a float; signed. */
export function pctText(text: string | null | undefined): string {
  if (!text) return '—';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return text;
  const frac = (m[3] ?? '').slice(0, 2).replace(/0+$/, '');
  const sign = m[1] === '-' ? '−' : m[2] === '0' && !frac ? '' : '+';
  return `${sign}${m[2]}${frac ? `.${frac}` : ''}%`;
}

/** The options of a supplier SKU as one line: «商品规格: 手捻钻 · …». */
export function optionsLine(options: Record<string, string> | null | undefined): string {
  if (!options) return '';
  return Object.entries(options)
    .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
    .map(([k, v]) => (/^option\d+$/.test(k) ? v : `${k}: ${v}`))
    .join(' · ');
}

/** A product's or SKU's name in the reader's language, falling back across the other two. */
export function nameIn(names: { ar: string; en: string; ckb: string } | null | undefined, lang: UiLang, fallback = ''): string {
  if (!names) return fallback;
  const order: UiLang[] = lang === 'en' ? ['en', 'ar', 'ckb'] : lang === 'ckb' ? ['ckb', 'ar', 'en'] : ['ar', 'en', 'ckb'];
  return order.map((l) => names[l]).find((s) => typeof s === 'string' && s.trim() !== '') ?? fallback;
}
