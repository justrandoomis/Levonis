/**
 * PRINT CLOUD'S WORDS — one accessor for every screen of cloud.<root>.
 *
 * Every user-facing string lives in a module under `src/cloud/strings/` as a
 * `Tri` — `{ ar, en, ckb }` — and is read through `tx` (outside React) or
 * `useCloudText()` (in a component). The Sorani is written by hand and is
 * never a copy of the Arabic (docs/DECISIONS.md row 183);
 * tests/printCloudUiShell.test.ts reads every module of that folder and
 * fails on an empty slot or a Sorani slot equal to the Arabic.
 *
 * Interpolation is `{name}` → `vars.name`, nothing more: a sentence is
 * written whole in each language, so word order is the translator's.
 * «Levonis» is written in Latin letters in every language
 * (tests/brandName.test.ts), and so is the product name «Print Cloud»
 * (src/cloud/brand.ts).
 */
import { useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import type { Language } from '../translations';
import type { Tri } from './types';

export type { Tri };

/** `{name}` → `vars.name`; an unknown name stays as written, so a typo shows instead of vanishing. */
export function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}

/** The text of `t` in `lang`, filled. A missing slot reads the English rather than nothing. */
export function tx(t: Tri, lang: Language, vars?: Record<string, string | number>): string {
  return fill(t[lang] || t.en, vars);
}

/** Pick one of a row's `name_ar` / `name_en` / `name_ckb` (catalogue rows the owner wrote). */
export function nameOf(row: { name_ar?: string | null; name_en?: string | null; name_ckb?: string | null }, lang: Language): string {
  const pick = lang === 'ar' ? row.name_ar : lang === 'ckb' ? row.name_ckb : row.name_en;
  return (pick || row.name_en || row.name_ar || '').trim();
}

/**
 * The hook every cloud screen uses:
 *
 *   const { t, lang, dir } = useCloudText();
 *   t(common.retry)                        → «إعادة المحاولة»
 *   t(home.ofTotal, { total: '24 h' })      → «من 24 ساعة»
 */
export function useCloudText() {
  const { lang, dir } = useLanguage();
  const t = useCallback((s: Tri, vars?: Record<string, string | number>) => tx(s, lang, vars), [lang]);
  return { t, lang, dir };
}
