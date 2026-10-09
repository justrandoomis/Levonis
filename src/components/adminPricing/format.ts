/**
 * «التسعير والشحن» — FIGURES FOR READING, NEVER FOR COMPUTING.
 *
 * Exact decimal TEXT from the server is grouped and written in the reader's
 * digits without ever passing through a binary float. Pure: no React, no
 * request, no contract vocabulary — so the owner's dashboard card
 * (src/components/admin/OwnerRatesCard.tsx) reads rates the way the pricing
 * tab does without loading the tab's words.
 */
import type { Language } from '../../translations';

type Lang = Language;

/**
 * An exact decimal TEXT from the server («1610.25»), grouped for reading
 * («1,610.25») without ever passing through a binary float.
 */
export function groupDecimal(text: string | null | undefined): string {
  if (text == null || text === '') return '—';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return text;
  const [, sign, int, frac] = m;
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${frac ? `.${frac}` : ''}`;
}

/** A whole number for reading (grams, millimetres): Latin digits, grouped. */
export function groupWhole(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return groupDecimal(String(Math.round(n)));
}

/**
 * THE SAME DIGITS AS EVERY DINAR ON THE SCREEN. `Money` writes Arabic and
 * Sorani figures with the browser's own number format (`toLocaleString()`,
 * src/lib/money.ts), which on an Arabic system is ١٢٬٠٠٠. A rate or a measure
 * written beside it must not switch to 12,000 — so an exact text already
 * grouped with ASCII symbols is transliterated, character by character, into
 * the same format's digits and separators. No number is parsed: the exact
 * text stays exact. English keeps Latin digits, as `Money` does.
 */
let symbolsCache: { digits: string[]; group: string; decimal: string } | null | undefined;
function localeSymbols(): { digits: string[]; group: string; decimal: string } | null {
  if (symbolsCache !== undefined) return symbolsCache;
  try {
    const nf = new Intl.NumberFormat();
    const digits = Array.from({ length: 10 }, (_, i) => nf.format(i));
    const parts = nf.formatToParts(12345.5);
    const group = parts.find((p) => p.type === 'group')?.value ?? ',';
    const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
    symbolsCache = digits.join('') === '0123456789' && group === ',' && decimal === '.' ? null : { digits, group, decimal };
  } catch {
    symbolsCache = null;
  }
  return symbolsCache;
}

export function localizeDigits(text: string, lang: Lang): string {
  if (lang === 'en') return text;
  const sym = localeSymbols();
  if (!sym) return text;
  return text.replace(/[0-9.,]/g, (ch) => (ch === '.' ? sym.decimal : ch === ',' ? sym.group : sym.digits[Number(ch)]!));
}

/** An exact decimal text for reading in the reader's digits. */
export const readDecimal = (text: string | null | undefined, lang: Lang) => localizeDigits(groupDecimal(text), lang);
/** A whole number (grams, millimetres, a count) for reading in the reader's digits. */
export const readWhole = (n: number | null | undefined, lang: Lang) => localizeDigits(groupWhole(n), lang);

