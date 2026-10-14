/**
 * A checkout, delivery or cart-shipping method in the reader's language.
 *
 * The three lists are the owner's settings, so the words are theirs: Arabic and
 * English always, Sorani when the owner wrote one or the row still carries the
 * shipped Arabic (worker/lib/settings.ts `withShippedSorani`). A row with no
 * Sorani reads its Arabic to a Sorani reader, the same fallback `loc` applies —
 * never a machine guess at an owner's own wording (DECISIONS row 183).
 *
 * It replaces `dir === 'rtl' ? m.titleAr : m.titleEn`, which handed every
 * Sorani reader the Arabic because Sorani is right-to-left too.
 */
export interface MethodWords {
  titleAr: string;
  titleEn: string;
  titleCkb?: string;
  descAr?: string;
  descEn?: string;
  descCkb?: string;
}

function pick(lang: string, ar: string | undefined, en: string | undefined, ckb: string | undefined): string {
  if (lang === 'en') return en || '';
  if (lang === 'ckb') return (ckb && ckb.trim()) || ar || '';
  return ar || '';
}

export function methodTitle(m: MethodWords, lang: string): string {
  return pick(lang, m.titleAr, m.titleEn, m.titleCkb);
}

export function methodDesc(m: MethodWords, lang: string): string {
  return pick(lang, m.descAr, m.descEn, m.descCkb);
}
