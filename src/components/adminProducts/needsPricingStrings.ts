/**
 * «يحتاج تسعيرًا» — the clean start's strings (addendum A.13, DECISIONS rows
 * 183 and 222). Every string in Arabic, English and real Sorani; a Sorani slot
 * never copies the Arabic.
 */
import { PRICE_REQUEST_ADMIN_TEXT } from '../../../packages/contracts/src/priceRequests';

export type QueueLang = 'ar' | 'en' | 'ckb';

interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

export const NEEDS_PRICING = {
  badge: { ar: 'يحتاج تسعيرًا', en: 'Needs pricing', ckb: 'پێویستی بە نرخدانانە' },
  title: { ar: 'منتجات تحتاج تسعيرًا', en: 'Products that need pricing', ckb: 'ئەو بەرهەمانەی پێویستیان بە نرخدانانە' },
  // DECISIONS rows 239-240: an unpriced product is SHOWN to customers without a price and sold to nobody.
  intro: {
    ar: 'لا يُباع أي منتج هنا حتى يُنشر سعره الجديد بالدولار. الأكثر طلباً للسعر أولاً: افتحه، راجع أسعاره في ورقة المراجعة، ثم انشره.',
    en: 'Nothing here can be bought until its new dollar price is published. The most requested come first: open it, review its prices in the review sheet, then publish.',
    ckb: 'هیچ بەرهەمێک لێرە ناکڕدرێت تا نرخە نوێیەکەی بە دۆلار بڵاو دەکرێتەوە. زۆرترین داواکراوەکان یەکەمن: بیکەرەوە، نرخەکانی لە پەڕەی پێداچوونەوەدا ببینە، پاشان بڵاوی بکەرەوە.',
  },
  /** «تحديد السعر» (row 240): opens the existing V2 pricing section; no new pricing UI. */
  priceNow: PRICE_REQUEST_ADMIN_TEXT.set_price,
  ready: { ar: 'جاهز للنشر', en: 'Ready to publish', ckb: 'ئامادەیە بۆ بڵاوکردنەوە' },
  saved: { ar: 'محفوظ، غير مكتمل', en: 'Saved, not complete', ckb: 'پاشەکەوتکراوە، تەواو نییە' },
  belowMinProfit: { ar: 'تحت الحد الأدنى للربح', en: 'Below minimum profit', ckb: 'لە خوار کەمترین قازانجەوە' },
  hiddenChip: {
    ar: 'ظاهر بلا سعر — يحتاج تسعيرًا',
    en: 'Shown without a price — needs pricing',
    ckb: 'بێ نرخ پیشان دەدرێت — پێویستی بە نرخدانان هەیە',
  },
  // «طلب السعر» on a queue row (row 240): counts only — never a requester's name or id.
  lastRequest: PRICE_REQUEST_ADMIN_TEXT.last_request,
  bySelection: { ar: 'الطلبات حسب الاختيار', en: 'Requests by choice', ckb: 'داواکارییەکان بەپێی هەڵبژاردن' },
  wholeProduct: PRICE_REQUEST_ADMIN_TEXT.whole_product,
  requestsUnavailable: {
    ar: 'عدّ طلبات السعر غير متاح بعد على قاعدة البيانات هذه.',
    en: 'Price-request counts are not available on this database yet.',
    ckb: 'ژماردنی داواکارییەکانی نرخ هێشتا لەم بنکەدراوەیەدا بەردەست نییە.',
  },
  awaitingDecision: { ar: 'بانتظار قرار التسعير', en: 'Awaiting a pricing decision', ckb: 'چاوەڕێی بڕیاری نرخدانانە' },
  ownerOnly: {
    ar: 'تسعير هذا المنتج من التكلفة للمالك فقط',
    en: 'This product is priced from cost; only the owner prices it',
    ckb: 'ئەم بەرهەمە لە تێچووەوە نرخ دەدرێت؛ تەنها خاوەن نرخی دادەنێت',
  },
  purchaseReview: { ar: 'تكلفة شراء جديدة بانتظار مراجعتك', en: 'A new purchase cost awaits your review', ckb: 'تێچووی کڕینێکی نوێ چاوەڕێی پێداچوونەوەتە' },
  published: { ar: 'منشور', en: 'Published', ckb: 'بڵاوکراوەتەوە' },
  rateMissing: {
    ar: 'لا يوجد سعر صرف معتمد للدولار بعد — لا يمكن نشر أي سعر حتى يعتمده المالك في «التسعير والشحن».',
    en: 'No approved dollar exchange rate yet — no price can be published until the owner approves one in «Pricing & shipping».',
    ckb: 'هێشتا نرخی ئاڵوگۆڕی پەسەندکراوی دۆلار نییە — هیچ نرخێک بڵاو ناکرێتەوە تا خاوەن لە «نرخدانان و گواستنەوە» پەسەندی دەکات.',
  },
  missingPrefix: { ar: 'ناقص', en: 'Missing', ckb: 'کەموکوڕی' },
  ownerData: { ar: 'بيانات المالك', en: "Owner's data", ckb: 'زانیاریی خاوەن' },
  empty: {
    ar: 'لا شيء هنا — كل المنتجات مسعّرة ومنشورة.',
    en: 'Nothing here — every product is priced and published.',
    ckb: 'هیچ شتێک لێرە نییە — هەموو بەرهەمەکان نرخیان هەیە و بڵاوکراونەتەوە.',
  },
  /** «الأكثر طلباً» with nothing in it: no open request yet — never «every product is priced». */
  emptyRequests: {
    ar: 'لا طلبات سعر مفتوحة بعد.',
    en: 'No open price requests yet.',
    ckb: 'هێشتا هیچ داواکارییەکی نرخی کراوە نییە.',
  },
  /** Any other filter with nothing in it. */
  emptyFilter: {
    ar: 'لا منتجات تطابق هذا التصنيف.',
    en: 'No products match this filter.',
    ckb: 'هیچ بەرهەمێک لەگەڵ ئەم فلتەرە ناگونجێت.',
  },
  loadFailed: { ar: 'تعذّر تحميل القائمة.', en: 'The list could not be loaded.', ckb: 'لیستەکە بار نەکرا.' },
  retry: { ar: 'إعادة المحاولة', en: 'Retry', ckb: 'دووبارە هەوڵبدەوە' },
  back: { ar: 'كل المنتجات', en: 'All products', ckb: 'هەموو بەرهەمەکان' },
  composition: { ar: 'حزمة — بانتظار قرار التسعير', en: 'Bundle — awaiting a pricing decision', ckb: 'پاکێج — چاوەڕێی بڕیاری نرخدانانە' },
  page: { ar: 'صفحة', en: 'Page', ckb: 'پەڕە' },
  prev: { ar: 'السابق', en: 'Previous', ckb: 'پێشوو' },
  next: { ar: 'التالي', en: 'Next', ckb: 'پەڕەی دواتر' },
  filters: {
    all: { ar: 'الكل', en: 'All', ckb: 'هەموو' },
    most_requested: PRICE_REQUEST_ADMIN_TEXT.most_requested,
    ready: { ar: 'جاهز للنشر', en: 'Ready to publish', ckb: 'ئامادەیە بۆ بڵاوکردنەوە' },
    saved: { ar: 'محفوظ، غير مكتمل', en: 'Saved, not complete', ckb: 'پاشەکەوتکراوە، تەواو نییە' },
    usd: { ar: 'سعر بالدولار', en: 'Dollar price', ckb: 'نرخ بە دۆلار' },
    cost: { ar: 'من التكلفة', en: 'From cost', ckb: 'لە تێچووەوە' },
    below_min_profit: { ar: 'تحت الحد الأدنى للربح', en: 'Below minimum profit', ckb: 'لە خوار کەمترین قازانجەوە' },
    purchase_review: { ar: 'تكلفة شراء بانتظار المراجعة', en: 'Purchase cost to review', ckb: 'تێچووی کڕین بۆ پێداچوونەوە' },
    // DECISIONS row 245: a published price still on the old 1,000 step.
    rounding: { ar: 'بانتظار التقريب الجديد', en: 'Awaiting the new rounding', ckb: 'چاوەڕێی خڕکردنەوەی نوێ' },
  },
  /** The «rounding» filter's note (row 245): what the list is and the one way its prices move. */
  roundingNote: {
    ar: 'منتجات منشورة ما زالت أسعارها مقرّبة بالقاعدة القديمة (لأعلى إلى 1,000 د.ع). القاعدة الجديدة: فوق 1,000 د.ع لأعلى إلى أقرب 250، و1,000 فأقل بلا تقريب. افتح المنتج واحفظه: تعرض ورقة المراجعة كل سعر قديم ← جديد، ولا يرى الزبائن السعر الجديد إلا بعد تأكيدك.',
    en: 'Published products whose prices are still rounded the old way (up to 1,000 IQD). The new rule: above 1,000 IQD, up to the next 250; 1,000 or less, not rounded. Open a product and save it: the review sheet shows every old → new price, and customers see the new price only after you confirm.',
    ckb: 'بەرهەمی بڵاوکراوە کە نرخەکانیان هێشتا بە یاسای کۆن خڕ کراونەتەوە (بۆ سەرەوە بۆ 1,000 د.ع). یاسای نوێ: سەرووی 1,000 د.ع بۆ سەرەوە بۆ نزیکترین 250، و 1,000 و کەمتر خڕ ناکرێتەوە. بەرهەمەکە بکەرەوە و پاشەکەوتی بکە: پەڕەی پێداچوونەوە هەموو نرخێکی کۆن ← نوێ پیشان دەدات، و کڕیاران نرخە نوێیەکە تەنها دوای دڵنیاکردنەوەی تۆ دەبینن.',
  },
} as const satisfies Record<string, Tri | Record<string, Tri>>;

/** «{n} منتجًا ظاهرًا بلا سعر حتى يكتمل تسعيره» (rows 239-240: shown to customers, sold to nobody). */
export function hiddenBanner(n: number, lang: QueueLang): string {
  if (lang === 'en') return `${n} products are shown to customers without a price until their pricing is complete`;
  if (lang === 'ckb') return `${n} بەرهەم بێ نرخ بە کڕیاران پیشان دەدرێن تا نرخدانانیان تەواو دەبێت`;
  return `${n} منتجًا ظاهرًا للزبائن بلا سعر حتى يكتمل تسعيره`;
}

/** Arabic counting: the singular alone for 1, the dual for 2, the plural for 3–10, the singular after 11+. */
const arCount = (n: number, [one, two, few, many]: readonly [string, string, string, string]): string =>
  n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`;
const AR_MIN = ['دقيقة', 'دقيقتين', 'دقائق', 'دقيقة'] as const;
const AR_HOUR = ['ساعة', 'ساعتين', 'ساعات', 'ساعة'] as const;
const AR_DAY = ['يوم', 'يومين', 'أيام', 'يومًا'] as const;

/** «منذ 3 ساعات» — when the latest request arrived, in the reader's language. */
export function agoText(iso: string | null | undefined, lang: QueueLang, now = Date.now()): string {
  if (!iso) return '—';
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min)) return '—';
  if (min < 1) return lang === 'en' ? 'now' : lang === 'ckb' ? 'ئێستا' : 'الآن';
  if (min < 60) return lang === 'en' ? `${min}m ago` : lang === 'ckb' ? `${min} خولەک لەمەوبەر` : `منذ ${arCount(min, AR_MIN)}`;
  const h = Math.floor(min / 60);
  if (h < 24) return lang === 'en' ? `${h}h ago` : lang === 'ckb' ? `${h} کاتژمێر لەمەوبەر` : `منذ ${arCount(h, AR_HOUR)}`;
  const d = Math.floor(h / 24);
  return lang === 'en' ? `${d}d ago` : lang === 'ckb' ? `${d} ڕۆژ لەمەوبەر` : `منذ ${arCount(d, AR_DAY)}`;
}

export const tri = (t: Tri, lang: QueueLang): string => (lang === 'en' ? t.en : lang === 'ckb' ? t.ckb : t.ar);

/** The queue's empty state for its filter: «every product is priced and published» only when nothing at all is left. */
export const queueEmptyText = (filter: string, lang: QueueLang): string =>
  tri(filter === 'all' ? NEEDS_PRICING.empty : filter === 'most_requested' ? NEEDS_PRICING.emptyRequests : NEEDS_PRICING.emptyFilter, lang);

/**
 * The «منتجات نشطة» tile's line: how many of its products customers see without a price (DECISIONS row 240).
 */
export function activeTileSub(totals: { active_needs_pricing?: number | null; shown_unpriced?: number | null }, pct: number, lang: QueueLang): string {
  // «ظاهر بلا سعر» counts what customers see (DECISIONS row 240); an older server sends only the wider count.
  const n = totals.shown_unpriced ?? totals.active_needs_pricing ?? 0;
  if (n > 0) {
    if (lang === 'en') return `${pct}% of all · ${n} shown without a price`;
    if (lang === 'ckb') return `${pct}% · ${n} بێ نرخ پیشان دەدرێت`;
    return `${pct}% من الإجمالي · ${n} ظاهر بلا سعر`;
  }
  if (lang === 'en') return `${pct}% of all products`;
  if (lang === 'ckb') return `${pct}%`;
  return `${pct}% من إجمالي المنتجات`;
}

/**
 * The completeness card's note (C5): its own «مخفي الآن» count is the «ناقص» list's; the products still
 * «يحتاج تسعيرًا» are a separate list, hidden whatever the switch says.
 */
export function separateListNote(n: number, lang: QueueLang): string {
  if (lang === 'en') return `This count is the incomplete list only. ${n} more products are shown without a price until their pricing is published («Needs pricing»).`;
  if (lang === 'ckb') return `ئەم ژمارەیە تەنها لیستی ناتەواوەکانە. ${n} بەرهەمی تر بێ نرخ پیشان دەدرێن تا نرخدانانیان بڵاو دەکرێتەوە («پێویستی بە نرخدانانە»).`;
  return `هذا العدد لقائمة «ناقص» وحدها. ${n} منتجًا آخر ظاهر بلا سعر حتى يُنشر تسعيره («يحتاج تسعيرًا»).`;
}

/**
 * The products list's status badge. An active product still «يحتاج تسعيرًا» is SHOWN to customers without a
 * price (DECISIONS row 240), so its badge says so in the warning tone — never «نشط» beside «يحتاج تسعيرًا».
 * Unless customers cannot see it at all: a composition (D6) or a product held for a missing picture or section
 * reads «مخفي».
 */
export function statusBadgeKind(
  status: string,
  p: { needs_pricing?: boolean; composition?: string; catalog_held?: boolean } = {}
): 'active' | 'hidden' | 'draft' | 'unpriced' {
  const key = status === 'active' ? 'active' : status === 'hidden' ? 'hidden' : 'draft';
  if (key !== 'active' || !p.needs_pricing) return key;
  return (p.composition ?? '') !== '' || p.catalog_held ? 'hidden' : 'unpriced';
}
