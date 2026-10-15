/** The desk's words and figures in the reader's language (copy.ts; src/lib/money.ts for dinars). */
import { useCallback } from 'react';
import { useLanguage } from '../../LanguageContext';
import { formatMoney } from '../../lib/money';
import { adminText, type AdminKey, type AdminVars } from './copy';

export function useA() {
  const { lang, loc, dir } = useLanguage();
  const a = useCallback((key: AdminKey, vars?: AdminVars) => adminText(key, lang, vars), [lang]);
  /** A dinar figure («—» when there is none), the house way for the reader's language. */
  const money = useCallback((n: number | null | undefined) => (n === null || n === undefined ? '—' : formatMoney(n, lang)), [lang]);
  return { a, money, lang, loc, dir };
}
