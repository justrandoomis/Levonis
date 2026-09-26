/**
 * The tray's words, counted properly. Arabic nouns change with the count (one,
 * two, three-to-ten) and «طابعتان» is not «2 طابعات»; this file is the one
 * place that knows that, so the tray, the badge and the toasts agree.
 *
 * OWNER: Sorani to be written by hand — every phrase here is ar/en only and
 * falls back to Arabic in ckb (docs/DECISIONS.md row 11).
 */
import { COMPARE_TRAY_MAX } from '../../lib/compareTray';

type Lang = 'ar' | 'en' | 'ckb';

interface Noun {
  one: string;
  two: string;
  few: string;
  enOne: string;
  enMany: string;
}

const NOUNS: Record<string, Noun> = {
  printer: { one: 'طابعة واحدة', two: 'طابعتان', few: 'طابعات', enOne: 'printer', enMany: 'printers' },
  generic: { one: 'منتج واحد', two: 'منتجان', few: 'منتجات', enOne: 'product', enMany: 'products' },
};
/** Accusative forms, for «يمكنك إضافة …». */
const ACC: Record<string, { one: string; two: string; few: string }> = {
  printer: { one: 'طابعة أخرى', two: 'طابعتين', few: 'طابعات' },
  generic: { one: 'منتجًا آخر', two: 'منتجين', few: 'منتجات' },
};

const nounFor = (type: string | null) => (type === 'printer' ? 'printer' : 'generic');

/** «طابعتان للمقارنة» / «2 printers to compare». */
export function trayTitle(count: number, type: string | null, lang: Lang): string {
  const k = nounFor(type);
  const n = NOUNS[k];
  if (lang === 'en') return `${count} ${count === 1 ? n.enOne : n.enMany} to compare`;
  const phrase = count === 1 ? n.one : count === 2 ? n.two : `${count} ${n.few}`;
  return `${phrase} للمقارنة`;
}

/** What the shopper can still do: add more, or that the tray is full. */
export function traySubline(count: number, type: string | null, lang: Lang): string {
  const k = nounFor(type);
  const left = COMPARE_TRAY_MAX - count;
  if (lang === 'en') {
    if (count === 1) return `Add another ${NOUNS[k].enOne} to compare`;
    if (left <= 0) return 'The comparison is full';
    return `You can add ${left} more`;
  }
  if (count === 1) return `أضف ${ACC[k].one} للمقارنة`;
  if (left <= 0) return 'اكتملت المقارنة: أربعة كحد أقصى';
  const a = ACC[k];
  return `يمكنك إضافة ${left === 1 ? a.one : left === 2 ? a.two : `${left} ${a.few}`}`;
}

/** The badge's accessible name: «قارن الآن (3)». */
export function badgeLabel(count: number, lang: Lang): string {
  return lang === 'en' ? `Compare now (${count})` : `قارن الآن (${count})`;
}
