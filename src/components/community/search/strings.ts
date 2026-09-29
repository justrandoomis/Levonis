/**
 * THE SEARCH OVERLAY'S WORDS — Arabic, English and Sorani, every key in all
 * three (docs/COMMUNITY_ECOSYSTEM.md decision D6: no Arabic standing in for
 * Sorani). The counted «N نتيجة» comes from hub/strings.ts's `resultsCount`,
 * so the overlay and the tabs agree on the noun.
 */
import { useLanguage } from '../../../LanguageContext';
import { hubLang, resultsCount, type HubLang } from '../hub/strings';

const STRINGS = {
  ar: {
    search: 'بحث',
    panel: 'نتائج البحث في المجتمع',
    searchIn: 'ابحث عن «{q}» في {tab}',
    submitHint: 'Enter للبحث في {tab}',
    recent: 'عمليات بحث أخيرة',
    clearRecent: 'مسح السجل',
    removeRecent: 'احذف «{q}»',
    removedRecent: 'حُذف «{q}» من السجل',
    deleteHint: 'مفتاح Delete يحذف هذا المصطلح من السجل',
    completes: 'يكمل إلى «{text}»',
    trendingTags: 'وسوم رائجة',
    trendingNow: 'رائج الآن',
    suggestions: 'اقتراحات',
    results: 'نتائج',
    noResultsFor: 'لا نتائج لـ «{q}»',
    tryShorter: 'جرّب كلمة أقصر، أو أحد الوسوم الرائجة.',
    typeMore: 'اكتب حرفين على الأقل',
    searching: 'جارٍ البحث…',
    seeAll: 'الكل',
    close: 'إغلاق',
    youMayLike: 'قد يعجبك',
    relatedStores: 'متاجر مشابهة',
    relatedProducts: 'منتجات مشابهة',
    sections: {
      projects: 'مشاريع',
      stores: 'متاجر',
      creators: 'صنّاع',
      products: 'منتجات',
      requests: 'طلبات طباعة',
      materials: 'خامات',
      brands: 'علامات',
    },
    types: { project: 'مشروع', store: 'متجر', creator: 'صانع', product: 'منتج', tag: 'وسم' },
  },
  en: {
    search: 'Search',
    panel: 'Community search results',
    searchIn: 'Search for “{q}” in {tab}',
    submitHint: 'Enter searches {tab}',
    recent: 'Recent searches',
    clearRecent: 'Clear history',
    removeRecent: 'Remove “{q}”',
    removedRecent: 'Removed “{q}” from history',
    deleteHint: 'Delete removes this term from history',
    completes: 'Completes to “{text}”',
    trendingTags: 'Trending tags',
    trendingNow: 'Trending now',
    suggestions: 'Suggestions',
    results: 'Results',
    noResultsFor: 'No results for “{q}”',
    tryShorter: 'Try a shorter word, or one of the trending tags.',
    typeMore: 'Type at least two characters',
    searching: 'Searching…',
    seeAll: 'All',
    close: 'Close',
    youMayLike: 'You may also like',
    relatedStores: 'Similar stores',
    relatedProducts: 'Similar products',
    sections: {
      projects: 'Projects',
      stores: 'Stores',
      creators: 'Makers',
      products: 'Products',
      requests: 'Print requests',
      materials: 'Materials',
      brands: 'Brands',
    },
    types: { project: 'Project', store: 'Store', creator: 'Maker', product: 'Product', tag: 'Tag' },
  },
  ckb: {
    search: 'گەڕان',
    panel: 'ئەنجامەکانی گەڕان لە کۆمەڵگە',
    searchIn: 'بگەڕێ بۆ «{q}» لە {tab}',
    submitHint: 'Enter دابگرە بۆ گەڕان لە {tab}',
    recent: 'گەڕانە دواییەکان',
    clearRecent: 'مێژوو بسڕەوە',
    removeRecent: '«{q}» بسڕەوە',
    removedRecent: '«{q}» لە مێژوو سڕایەوە',
    deleteHint: 'دوگمەی Delete ئەم وشەیە لە مێژوو دەسڕێتەوە',
    completes: 'تەواو دەبێت بۆ «{text}»',
    trendingTags: 'تاگە باوەکان',
    trendingNow: 'ئێستا باوە',
    suggestions: 'پێشنیارەکان',
    results: 'ئەنجامەکان',
    noResultsFor: 'هیچ ئەنجامێک نییە بۆ «{q}»',
    tryShorter: 'وشەیەکی کورتتر تاقی بکەرەوە، یان یەکێک لە تاگە باوەکان.',
    typeMore: 'لانیکەم دوو پیت بنووسە',
    searching: 'دەگەڕێت…',
    seeAll: 'هەموو',
    close: 'داخستن',
    youMayLike: 'لەوانەیە بەدڵت بێت',
    relatedStores: 'فرۆشگا هاوشێوەکان',
    relatedProducts: 'بەرهەمە هاوشێوەکان',
    sections: {
      projects: 'پڕۆژەکان',
      stores: 'فرۆشگاکان',
      creators: 'دروستکەران',
      products: 'بەرهەمەکان',
      requests: 'داواکارییەکانی چاپ',
      materials: 'کەرەستەکان',
      brands: 'براندەکان',
    },
    types: { project: 'پڕۆژە', store: 'فرۆشگا', creator: 'دروستکەر', product: 'بەرهەم', tag: 'تاگ' },
  },
} as const;

type Widen<T> = T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> };
export type SearchStrings = Widen<(typeof STRINGS)['ar']>;

export const SEARCH_STRINGS = STRINGS;

export function useSearchStrings(): SearchStrings {
  const { lang } = useLanguage();
  return STRINGS[hubLang(lang)] as SearchStrings;
}

/** «{q}» and friends filled in. */
export const fillIn = (s: string, values: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));

/**
 * «12 نتيجة», and «+200 نتيجة» when the bounded count hit its ceiling: the
 * server counts at most 200 rows per section (docs/COMMUNITY_ECOSYSTEM.md
 * §9.3), so a total of 200 means «at least».
 */
export const SEARCH_COUNT_CEILING = 200;

export function boundedCount(total: number, lang: HubLang): string {
  const n = Math.max(0, Math.floor(total));
  const label = resultsCount(Math.min(n, SEARCH_COUNT_CEILING), lang);
  if (n < SEARCH_COUNT_CEILING) return label;
  return lang === 'en' ? label.replace(/^(\d+)/, '$1+') : `+${label}`;
}
