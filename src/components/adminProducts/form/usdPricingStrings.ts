/**
 * «التسعير بالدولار والشحن» IN THE PRODUCT FORM — EVERY WORD, IN ARABIC,
 * ENGLISH AND SORANI (owner brief 2026-10-09; docs/DECISIONS.md row 183: a
 * `ckb` slot never carries the Arabic). The 4-cell bar and its «تفاصيل» keep
 * the procurement card's words (src/components/adminOperations/
 * procurementPricingStrings.ts); these are the form's own fields and notes.
 * ckb uses the pricing terms: shipping «ناردن», product «بەرهەم» (never
 * «گواستنەوە» or «کاڵا»: tests/procurementPricingStrings.test.ts).
 *
 * Pure: no React, no request.
 */
import type { Language } from '../../../translations';

type Fill = (v: string) => string;
type Fill2 = (a: string, b: string) => string;

export interface UsdPricingFormStrings {
  formTitle: string;
  formIntro: string;
  productLevel: string;
  supplierCost: string;
  supplierCurrency: string;
  route: string;
  routeNone: string;
  weightKg: string;
  volumeCbm: string;
  additional: string;
  minProfit: string;
  minProfitHint: string;
  extra: string;
  extraHint: string;
  inheritPlaceholder: Fill;
  save: string;
  saveHint: string;
  saved: string;
  unsaved: string;
  discard: string;
  saveFirst: string;
  optionsTitle: string;
  optionsIntro: string;
  newOptionsSaveFirst: string;
  edit: string;
  modelsSummary: Fill2;
  pricesLater: string;
  weightInvalid: string;
  decimalInvalid: string;
  extraInvalid: string;
  pricingWeightWins: string;
  convertedNote: Fill2;
  loading: string;
  retry: string;
}

const ar: UsdPricingFormStrings = {
  formTitle: 'التسعير بالدولار والشحن',
  formIntro: 'تكلفة المورد بعملته، ومسار الشحن والوزن أو الحجم، والتكاليف الإضافية، والحد الأدنى للربح بالدولار. يُحسب السعر النهائي للزبون من هذه القيم.',
  productLevel: 'المنتج (كل الموديلات)',
  supplierCost: 'تكلفة المورد للقطعة',
  supplierCurrency: 'عملة المورد',
  route: 'مسار الشحن الأساسي',
  routeNone: '— بلا مسار —',
  weightKg: 'الوزن مع التغليف (كغم)',
  volumeCbm: 'الحجم مع التغليف (CBM)',
  additional: 'تكاليف إضافية للقطعة (د.ع)',
  minProfit: 'الحد الأدنى للربح (USD)',
  minProfitHint: 'أقل ربح بالدولار فوق التكلفة الحالية؛ اتركه فارغًا ليرث',
  extra: 'زيادة البيع المباشر (د.ع)',
  extraHint: 'بالدينار ومن مضاعفات 1,000؛ تُضاف للبيع المباشر بعد التقريب',
  inheritPlaceholder: (v) => `يرث: ${v}`,
  save: 'حفظ التسعير بالدولار',
  saveHint: 'يُحفظ مستقلًا عن زر حفظ المنتج',
  saved: 'حُفظت بيانات التسعير',
  unsaved: 'تغييرات غير محفوظة',
  discard: 'تجاهل التغييرات',
  saveFirst: 'احفظ المنتج أولًا، ثم أدخل تسعيره بالدولار هنا',
  optionsTitle: 'التسعير بالدولار لكل موديل',
  optionsIntro: 'الحقل الفارغ يرث قيمة المنتج. الألوان تتبع تسعير موديلها حتى يتوفر تسعير كل لون على حدة.',
  newOptionsSaveFirst: 'الموديلات الجديدة تظهر هنا بعد حفظ المنتج',
  edit: 'تعديل',
  modelsSummary: (ok, all) => `${ok} من ${all} موديلات محسوبة السعر — الملخص لكل موديل في «الخيارات والألوان»`,
  pricesLater: 'هذه بيانات التسعير فقط؛ يبقى سعر المتجر كما هو حتى يُعتمد السعر الجديد',
  weightInvalid: 'أدخل وزنًا أكبر من صفر بثلاث منازل عشرية على الأكثر',
  decimalInvalid: 'أدخل رقمًا أكبر من صفر',
  extraInvalid: 'أدخل مبلغًا بالدينار من مضاعفات 1,000',
  pricingWeightWins: 'وزن التسعير المحفوظ يُستعمل بدل هذا الوزن',
  convertedNote: (amount, rate) => `أُدخلت ${amount} د.ع وحُوّلت مرة واحدة بسعر ${rate}`,
  loading: 'جارٍ تحميل التسعير…',
  retry: 'إعادة المحاولة',
};

const en: UsdPricingFormStrings = {
  formTitle: 'USD pricing and shipping',
  formIntro: 'The supplier cost in its currency, the shipping route and weight or volume, additional costs and the minimum profit in USD. The final customer price is computed from these values.',
  productLevel: 'Product (every model)',
  supplierCost: 'Supplier cost per piece',
  supplierCurrency: 'Supplier currency',
  route: 'Base shipping route',
  routeNone: '— No route —',
  weightKg: 'Packed weight (kg)',
  volumeCbm: 'Packed volume (CBM)',
  additional: 'Additional costs per piece (IQD)',
  minProfit: 'Minimum profit (USD)',
  minProfitHint: 'The least profit in USD above today’s cost; leave it empty to inherit',
  extra: 'Direct Sale Extra (IQD)',
  extraHint: 'In dinars, a multiple of 1,000; added to direct sale after rounding',
  inheritPlaceholder: (v) => `Inherits: ${v}`,
  save: 'Save USD pricing',
  saveHint: 'Saved separately from the product’s save button',
  saved: 'Pricing data saved',
  unsaved: 'Unsaved changes',
  discard: 'Discard changes',
  saveFirst: 'Save the product first, then enter its USD pricing here',
  optionsTitle: 'USD pricing per model',
  optionsIntro: 'An empty field inherits the product’s value. Colours follow their model’s pricing until per-colour pricing is available.',
  newOptionsSaveFirst: 'New models appear here after the product is saved',
  edit: 'Edit',
  modelsSummary: (ok, all) => `${ok} of ${all} models priced — each model’s summary is under “Options & colours”`,
  pricesLater: 'This is pricing data only; the store price stays as it is until the new price is applied',
  weightInvalid: 'Enter a weight above zero with at most three decimals',
  decimalInvalid: 'Enter a number above zero',
  extraInvalid: 'Enter an amount in dinars that is a multiple of 1,000',
  pricingWeightWins: 'The stored pricing weight is used instead of this weight',
  convertedNote: (amount, rate) => `${amount} IQD was entered and converted once at ${rate}`,
  loading: 'Loading pricing…',
  retry: 'Retry',
};

const ckb: UsdPricingFormStrings = {
  formTitle: 'نرخدانان بە دۆلار و ناردن',
  formIntro: 'تێچووی دابینکەر بە دراوەکەی خۆی، ڕێگای ناردن و کێش یان قەبارە، تێچووە زیادەکان و کەمترین قازانجی مەبەست بە دۆلار. نرخی کۆتایی بۆ کڕیار لەم بەهایانە هەژمار دەکرێت.',
  productLevel: 'بەرهەم (هەموو مۆدێلەکان)',
  supplierCost: 'تێچووی دابینکەر بۆ هەر پارچەیەک',
  supplierCurrency: 'دراوی دابینکەر',
  route: 'ڕێگای بنەڕەتیی ناردن',
  routeNone: '— بێ ڕێگا —',
  weightKg: 'کێش لەگەڵ پاکێج (کگم)',
  volumeCbm: 'قەبارە لەگەڵ پاکێج (CBM)',
  additional: 'تێچووە زیادەکان بۆ هەر پارچەیەک (د.ع)',
  minProfit: 'کەمترین قازانجی مەبەست (USD)',
  minProfitHint: 'کەمترین قازانج بە دۆلار لە سەرووی تێچووی ئێستا؛ بەتاڵی بهێڵەوە بۆ ئەوەی لە ئاستی سەرەوە وەربگیرێت',
  extra: 'زیادەی فرۆشتنی ڕاستەوخۆ (د.ع)',
  extraHint: 'بە دینار و چەندجارەی 1,000؛ دوای خڕکردنەوە بۆ فرۆشتنی ڕاستەوخۆ زیاد دەکرێت',
  inheritPlaceholder: (v) => `وەرگیراو: ${v}`,
  save: 'پاشەکەوتکردنی نرخدانان بە دۆلار',
  saveHint: 'جیا لە دوگمەی پاشەکەوتکردنی بەرهەمەکە پاشەکەوت دەکرێت',
  saved: 'زانیارییەکانی نرخدانان پاشەکەوت کران',
  unsaved: 'گۆڕانکاریی پاشەکەوتنەکراو',
  discard: 'وازهێنان لە گۆڕانکارییەکان',
  saveFirst: 'سەرەتا بەرهەمەکە پاشەکەوت بکە، پاشان نرخدانانی بە دۆلار لێرە بنووسە',
  optionsTitle: 'نرخدانان بە دۆلار بۆ هەر مۆدێلێک',
  optionsIntro: 'خانەی بەتاڵ بەهای بەرهەمەکە وەردەگرێت. ڕەنگەکان نرخدانانی مۆدێلەکەیان پەیڕەو دەکەن تا نرخدانانی هەر ڕەنگێک بە جیا بەردەست دەبێت.',
  newOptionsSaveFirst: 'مۆدێلە نوێیەکان دوای پاشەکەوتکردنی بەرهەمەکە لێرە دەردەکەون',
  edit: 'دەستکاری',
  modelsSummary: (ok, all) => `${ok} لە ${all} مۆدێل نرخیان هەژمار کراوە — پوختەی هەر مۆدێلێک لە «هەڵبژاردەکان و ڕەنگەکان»`,
  pricesLater: 'ئەمە تەنها زانیاریی نرخدانانە؛ نرخی فرۆشگا وەک خۆی دەمێنێتەوە تا نرخە نوێیەکە جێبەجێ دەکرێت',
  weightInvalid: 'کێشێکی سەرووی سفر بنووسە بە زۆرترین سێ ژمارەی دوای فاریزە',
  decimalInvalid: 'ژمارەیەکی سەرووی سفر بنووسە',
  extraInvalid: 'بڕێک بە دینار بنووسە کە چەندجارەی 1,000 بێت',
  pricingWeightWins: 'کێشی نرخدانانی پاشەکەوتکراو لە جیاتی ئەم کێشە بەکاردێت',
  convertedNote: (amount, rate) => `${amount} د.ع نووسرا و یەکجار بە نرخی ${rate} گۆڕدرا`,
  loading: 'نرخدانان بار دەکرێت…',
  retry: 'دووبارە هەوڵبدەرەوە',
};

export const USD_PRICING_FORM_STRINGS: Readonly<Record<Language, UsdPricingFormStrings>> = { ar, en, ckb };

export const usdPricingFormStrings = (lang: Language): UsdPricingFormStrings => USD_PRICING_FORM_STRINGS[lang] ?? ar;
