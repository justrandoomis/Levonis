/**
 * «يحتاج تسعيرًا» — the clean start's strings (addendum A.13, DECISIONS rows
 * 183 and 222). Every string in Arabic, English and real Sorani; a Sorani slot
 * never copies the Arabic.
 */
export type QueueLang = 'ar' | 'en' | 'ckb';

interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

export const NEEDS_PRICING = {
  badge: { ar: 'يحتاج تسعيرًا', en: 'Needs pricing', ckb: 'پێویستی بە نرخدانانە' },
  title: { ar: 'منتجات تحتاج تسعيرًا', en: 'Products that need pricing', ckb: 'ئەو بەرهەمانەی پێویستیان بە نرخدانانە' },
  intro: {
    ar: 'كل منتج هنا مخفي عن الزبائن حتى يُنشر سعره الجديد بالدولار. افتحه، راجع أسعاره في ورقة المراجعة، ثم انشره.',
    en: 'Every product here is hidden from customers until its new dollar price is published. Open it, review its prices in the review sheet, then publish.',
    ckb: 'هەموو بەرهەمێک لێرە لە کڕیاران شاردراوەتەوە تا نرخە نوێیەکەی بە دۆلار بڵاو دەکرێتەوە. بیکەرەوە، نرخەکانی لە پەڕەی پێداچوونەوەدا ببینە، پاشان بڵاوی بکەرەوە.',
  },
  priceNow: { ar: 'سعّره الآن', en: 'Price it now', ckb: 'ئێستا نرخی دابنێ' },
  ready: { ar: 'جاهز للنشر', en: 'Ready to publish', ckb: 'ئامادەیە بۆ بڵاوکردنەوە' },
  saved: { ar: 'محفوظ، غير مكتمل', en: 'Saved, not complete', ckb: 'پاشەکەوتکراوە، تەواو نییە' },
  belowMinProfit: { ar: 'تحت الحد الأدنى للربح', en: 'Below minimum profit', ckb: 'لە خوار کەمترین قازانجەوە' },
  hiddenChip: { ar: 'مخفي: يحتاج تسعيرًا', en: 'Hidden: needs pricing', ckb: 'شاراوەیە: پێویستی بە نرخدانانە' },
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
    ready: { ar: 'جاهز للنشر', en: 'Ready to publish', ckb: 'ئامادەیە بۆ بڵاوکردنەوە' },
    saved: { ar: 'محفوظ، غير مكتمل', en: 'Saved, not complete', ckb: 'پاشەکەوتکراوە، تەواو نییە' },
    usd: { ar: 'سعر بالدولار', en: 'Dollar price', ckb: 'نرخ بە دۆلار' },
    cost: { ar: 'من التكلفة', en: 'From cost', ckb: 'لە تێچووەوە' },
    below_min_profit: { ar: 'تحت الحد الأدنى للربح', en: 'Below minimum profit', ckb: 'لە خوار کەمترین قازانجەوە' },
    purchase_review: { ar: 'تكلفة شراء بانتظار المراجعة', en: 'Purchase cost to review', ckb: 'تێچووی کڕین بۆ پێداچوونەوە' },
  },
} as const satisfies Record<string, Tri | Record<string, Tri>>;

/** «{n} منتجًا مخفيًا عن الزبائن حتى يكتمل تسعيره». */
export function hiddenBanner(n: number, lang: QueueLang): string {
  if (lang === 'en') return `${n} products are hidden from customers until their pricing is complete`;
  if (lang === 'ckb') return `${n} بەرهەم لە کڕیاران شاردراوەتەوە تا نرخدانانیان تەواو دەبێت`;
  return `${n} منتجًا مخفيًا عن الزبائن حتى يكتمل تسعيره`;
}

export const tri = (t: Tri, lang: QueueLang): string => (lang === 'en' ? t.en : lang === 'ckb' ? t.ckb : t.ar);

/**
 * The «منتجات نشطة» tile's line (C5, review 2026-10-14): an active product still «يحتاج تسعيرًا» is hidden
 * from every customer, so the tile says how many of its products customers cannot see yet.
 */
export function activeTileSub(totals: { active_needs_pricing?: number | null }, pct: number, lang: QueueLang): string {
  const n = totals.active_needs_pricing ?? 0;
  if (n > 0) {
    if (lang === 'en') return `${pct}% of all · ${n} hidden until priced`;
    if (lang === 'ckb') return `${pct}% · ${n} شاراوەیە تا نرخی بۆ دادەنرێت`;
    return `${pct}% من الإجمالي · ${n} مخفي حتى يُسعَّر`;
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
  if (lang === 'en') return `This count is the incomplete list only. ${n} more products are hidden until their pricing is published («Needs pricing»).`;
  if (lang === 'ckb') return `ئەم ژمارەیە تەنها لیستی ناتەواوەکانە. ${n} بەرهەمی تر شاراوەن تا نرخدانانیان بڵاو دەکرێتەوە («پێویستی بە نرخدانانە»).`;
  return `هذا العدد لقائمة «ناقص» وحدها. ${n} منتجًا آخر مخفي حتى يُنشر تسعيره («يحتاج تسعيرًا»).`;
}
