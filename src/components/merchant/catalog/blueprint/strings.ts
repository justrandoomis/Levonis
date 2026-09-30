/**
 * «التخصيص · Customization · خۆگونجاندن» — THE BUILDER'S WORDS, ONE LANGUAGE AT
 * A TIME (Programme C, phase C1). The tables are ./strings.ar.ts,
 * ./strings.en.ts and ./strings.ckb.ts (written Sorani, never the Arabic
 * standing in), each its own lazy chunk: the door asks for the merchant's
 * language while it reads the builder's state, and the builder opens with it
 * already here. This file is only the loader — a hundred bytes or so, shared
 * by the door and the builder (`fill` and the words «أضف مقاسات» writes live
 * in ./model.ts, in the builder's chunk).
 */
import { useEffect, useState } from 'react';
import type { BuilderStrings } from './strings.ar';

export type { BuilderStrings };
export type BuilderLang = 'ar' | 'en' | 'ckb';

export const langOf = (lang: string): BuilderLang => (lang === 'en' || lang === 'ckb' ? lang : 'ar');

const tables: Partial<Record<BuilderLang, BuilderStrings>> = {};
const LOAD: Record<BuilderLang, () => Promise<{ default: BuilderStrings }>> = {
  ar: () => import('./strings.ar'),
  en: () => import('./strings.en'),
  ckb: () => import('./strings.ckb'),
};

/**
 * The words of `lang` once they are here (each table is fetched once);
 * meanwhile the last language that arrived (a language switched while the
 * builder is open), else null. A state set after unmounting is a no-op.
 */
export function useWords(lang: string): BuilderStrings | null {
  const l = langOf(lang);
  const [, arrived] = useState(0);
  const now = tables[l];
  useEffect(() => {
    if (!now)
      LOAD[l]().then(
        (m) => {
          tables[l] = m.default;
          arrived((n) => n + 1);
        },
        () => undefined
      );
  }, [l, now]);
  return now ?? tables.ar ?? tables.en ?? tables.ckb ?? null;
}

