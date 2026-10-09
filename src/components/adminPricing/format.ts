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
import { roundDecimalText } from '../../lib/rateText';

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


/**
 * THE EXCHANGE-RATE PANEL WRITES ITS FIGURES IN LATIN DIGITS — «1,873.655»,
 * «0.149202», «3.6», «12» — in every language, and every number in it (rates,
 * percentages, counts, the digits of a date) the same way, so a card never
 * mixes two digit systems (FX-1 UX review #1, #10). On an Arabic system the
 * localized form of a rate with a fraction put U+066C (thousands) and U+066B
 * (decimal) side by side, which Cairo draws almost alike: EUR/IQD
 * «١٬٨٧٣٫٦٥٥» read as 1,873,655. A rate is a technical figure written as
 * the provider, the bank and the customer menu (src/lib/rateText.ts) write
 * it; the P1 product sheet keeps its dinars in the reader's digits.
 */
export const fxFigure = (text: string | null | undefined): string => groupDecimal(text);
export const fxCount = (n: number | null | undefined): string => groupWhole(n);

/** A figure as SHOWN: rounded for reading when `places` says so («≈»), the exact text kept for a tooltip. */
export interface ShownFigure {
  text: string;
  exact: string;
  approx: boolean;
}

/**
 * `places` null: the server's text, grouped. A number: rounded half up to
 * that many decimals AS TEXT (never through a float) — CNY/USD carries ten
 * decimals and EUR/IQD three, which no one reads (UX review #1).
 */
export function shownFigure(text: string, places: number | null): ShownFigure {
  if (places === null) return { text: groupDecimal(text), exact: groupDecimal(text), approx: false };
  const rounded = roundDecimalText(text, places);
  return { text: groupDecimal(rounded), exact: groupDecimal(text), approx: rounded !== text };
}
