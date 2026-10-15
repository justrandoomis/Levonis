/**
 * The trade-in screens' words in the reader's language (copy.ts): `t(key, vars)` for text,
 * `tx(key, { x: <Money … /> })` for a sentence that carries an element in one of its marks.
 */
import React, { useCallback } from 'react';
import { useLanguage } from '../../LanguageContext';
import { copyParts, copyText, type CopyKey, type CopyVars } from './copy';

export function useT() {
  const { lang } = useLanguage();
  const t = useCallback((key: CopyKey, vars?: CopyVars) => copyText(key, lang, vars), [lang]);
  const tx = useCallback(
    (key: CopyKey, nodes: Record<string, React.ReactNode>) => (
      <>
        {copyParts(key, lang).map((p, i) => ('text' in p ? <React.Fragment key={i}>{p.text}</React.Fragment> : <React.Fragment key={i}>{nodes[p.slot] ?? null}</React.Fragment>))}
      </>
    ),
    [lang]
  );
  return { t, tx, lang };
}
