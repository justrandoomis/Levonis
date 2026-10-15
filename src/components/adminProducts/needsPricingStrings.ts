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
    ar: 'كل منتج هنا ظاهر للزبائن بلا سعر ولا يُباع حتى يُنشر سعره الجديد بالدولار. الأكثر طلباً للسعر أولاً: افتحه، راجع أسعاره في ورقة المراجعة، ثم انشره.',
    en: 'Every product here is shown to customers without a price and cannot be bought until its new dollar price is published. The most requested come first: open it, review its prices in the review sheet, then publish.',
    ckb: 'هەموو بەرهەمێک لێرە بێ نرخ بە کڕیاران پیشان دەدرێت و ناکڕدرێت تا نرخە نوێیەکەی بە دۆلار بڵاو دەکرێتەوە. زۆرترین داواکراوەکان یەکەمن: بیکەرەوە، نرخەکانی لە پەڕەی پێداچوونەوەدا ببینە، پاشان بڵاوی بکەرەوە.',
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
  },
} as const satisfies Record<string, Tri | Record<string, Tri>>;

/** «{n} منتجًا ظاهرًا بلا سعر حتى يكتمل تسعيره» (rows 239-240: shown to customers, sold to nobody). */
export function hiddenBanner(n: number, lang: QueueLang): string {
  if (lang === 'en') return `${n} products are shown to customers without a price until their pricing is complete`;
  if (lang === 'ckb') return `${n} بەرهەم بێ نرخ بە کڕیاران پیشان دەدرێن تا نرخدانانیان تەواو دەبێت`;
  return `${n} منتجًا ظاهرًا للزبائن بلا سعر حتى يكتمل تسعيره`;
}

/** «منذ 3 ساعات» — when the latest request arrived, in the reader's language. */
export function agoText(iso: string | null | undefined, lang: QueueLang, now = Date.now()): string {
  if (!iso) return '—';
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min)) return '—';
  if (min < 1) return lang === 'en' ? 'now' : lang === 'ckb' ? 'ئێستا' : 'الآن';
  if (min < 60) return lang === 'en' ? `${min}m ago` : lang === 'ckb' ? `${min} خولەک لەمەوبەر` : `منذ ${min} دقيقة`;
  const h = Math.floor(min / 60);
  if (h < 24) return lang === 'en' ? `${h}h ago` : lang === 'ckb' ? `${h} کاتژمێر لەمەوبەر` : `منذ ${h} ساعة`;
  const d = Math.floor(h / 24);
  return lang === 'en' ? `${d}d ago` : lang === 'ckb' ? `${d} ڕۆژ لەمەوبەر` : `منذ ${d} يوم`;
}

export const tri = (t: Tri, lang: QueueLang): string => (lang === 'en' ? t.en : lang === 'ckb' ? t.ckb : t.ar);

/**
 * The «منتجات نشطة» tile's line (C5, review 2026-10-14): an active product still «يحتاج تسعيرًا» is hidden
 * from every customer, so the tile says how many of its products customers cannot see yet.
 */
export function activeTileSub(totals: { active_needs_pricing?: number | null }, pct: number, lang: QueueLang): string {
  const n = totals.active_needs_pricing ?? 0;
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
