/**
 * The rewards area's words in the reader's language (copy.ts, spec §8):
 * - `t(key, vars)` for text;
 * - `tx(key, { x: <Money … /> })` for a sentence with an element in one of its marks;
 * - `count(key, n)` for a counted sentence, `{n}` filled in every form;
 * - `ord(place)` for «الثاني» / «2nd» / «دووەم»;
 * - `tri(value)` for the owner's three-language text (own language, then English, then Arabic);
 *   a product, option or colour is `pickName` (./model) instead: English in every language.
 */
import React, { useCallback, useMemo } from 'react';
import { useLanguage } from '../../LanguageContext';
import { copyParts, copyText, countText, ordinal, type CopyKey, type CopyVars, type CountedKey } from './copy';
import { pickTri } from './model';
import type { Tri } from './types';

export function useRewardsT() {
  const { lang, dir } = useLanguage();
  const t = useCallback((key: CopyKey, vars?: CopyVars) => copyText(key, lang, vars), [lang]);
  const tx = useCallback(
    (key: CopyKey, nodes: Record<string, React.ReactNode>) => (
      <>
        {copyParts(key, lang).map((p, i) => (
          <React.Fragment key={i}>{'text' in p ? p.text : (nodes[p.slot] ?? null)}</React.Fragment>
        ))}
      </>
    ),
    [lang]
  );
  const count = useCallback((key: CountedKey, n: number, shown?: string) => countText(key, n, lang, shown), [lang]);
  const ord = useCallback((place: number) => ordinal(place, lang), [lang]);
  const tri = useCallback((value: Partial<Tri> | null | undefined) => pickTri(value, lang), [lang]);
  return useMemo(() => ({ t, tx, count, ord, tri, lang, dir }), [t, tx, count, ord, tri, lang, dir]);
}
