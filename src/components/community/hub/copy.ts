/**
 * THE COMMUNITY PAGE'S COUNTED WORDS AND TIMES.
 *
 * Arabic nouns change with the number — «متابع واحد», «متابعان», «5 متابعين»,
 * «12 متابعًا», «100 متابع» — and a card that prints «2 عروض» or «12 طلبات»
 * reads as machine-made. The rule is src/lib/catalog/copy.ts's (1, 2, 3–10,
 * 11–99, hundreds), applied to this page's nouns; products go through that
 * file itself.
 *
 * OWNER: Sorani to be written by hand — these phrases are ar/en and Sorani
 * falls back to Arabic (see docs/DECISIONS.md rows 166–168 (D6)), except the offer count,
 * which reuses the board's own hand-written «ئۆفەر» (src/pages/Requests.tsx).
 */
import { countNoun } from '../../../lib/catalog/copy';
import { dateLocale } from '../../orders/format';

export type HubLang = 'ar' | 'en' | 'ckb';

interface Forms {
  one: string;
  two: string;
  few: string;
  many: string;
  hundred: string;
  en1: string;
  enN: string;
}

/** `show` writes the number (a screen with its own digits passes its formatter). */
function counted(n: number, f: Forms, lang: HubLang, show: (n: number) => string = String): string {
  const count = Math.max(0, Math.floor(n));
  if (lang === 'en') return `${show(count)} ${count === 1 ? f.en1 : f.enN}`;
  if (count === 1) return f.one;
  if (count === 2) return f.two;
  const r = count % 100;
  if (r >= 3 && r <= 10) return `${show(count)} ${f.few}`;
  if (r >= 11 && r <= 99) return `${show(count)} ${f.many}`;
  return `${show(count)} ${f.hundred}`;
}

const FOLLOWERS: Forms = {
  one: 'متابع واحد',
  two: 'متابعان',
  few: 'متابعين',
  many: 'متابعًا',
  hundred: 'متابع',
  en1: 'follower',
  enN: 'followers',
};

const COMPLETED: Forms = {
  one: 'طلب منجز واحد',
  two: 'طلبان منجزان',
  few: 'طلبات منجزة',
  many: 'طلبًا منجزًا',
  hundred: 'طلب منجز',
  en1: 'completed order',
  enN: 'completed orders',
};

const OFFERS: Forms = {
  one: 'عرض واحد',
  two: 'عرضان',
  few: 'عروض',
  many: 'عرضًا',
  hundred: 'عرض',
  en1: 'offer',
  enN: 'offers',
};

const RESULTS: Forms = {
  one: 'نتيجة واحدة',
  two: 'نتيجتان',
  few: 'نتائج',
  many: 'نتيجة',
  hundred: 'نتيجة',
  en1: 'result',
  enN: 'results',
};

const STORES: Forms = {
  one: 'متجر واحد',
  two: 'متجران',
  few: 'متاجر',
  many: 'متجرًا',
  hundred: 'متجر',
  en1: 'store',
  enN: 'stores',
};

export const resultsLabel = (n: number, lang: HubLang) => counted(n, RESULTS, lang);
export const storesLabel = (n: number, lang: HubLang) => counted(n, STORES, lang);
export const followersLabel = (n: number, lang: HubLang) => counted(n, FOLLOWERS, lang);
export const completedLabel = (n: number, lang: HubLang) => counted(n, COMPLETED, lang);
export const productsLabel = (n: number, lang: HubLang) => countNoun(n, 'product', lang);

/** «لا عروض بعد», «عرض واحد», «عرضان», «3 عروض», «12 عرضًا». */
export function offersLabel(n: number, lang: HubLang, show: (n: number) => string = String): string {
  const count = Math.max(0, Math.floor(n));
  if (lang === 'ckb') return `${show(count)} ئۆفەر`;
  if (count === 0) return lang === 'en' ? 'No offers yet' : 'لا عروض بعد';
  return counted(count, OFFERS, lang, show);
}

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** «قبل 3 ساعات», «أمس», «الآن» — the language's own words, from Intl. */
export function timeAgo(iso: string | null | undefined, lang: HubLang, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const seconds = Math.round((t - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(dateLocale(lang), { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'second');
}

/** «5 أكتوبر» — a deadline, without the year the card has no room for. */
export function shortDate(iso: string | null | undefined, lang: HubLang): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat(dateLocale(lang), { day: 'numeric', month: 'short' }).format(t);
}
