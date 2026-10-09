/**
 * «التسعير والشحن» — EVERY WORD OF THE OWNER'S PRICING PREVIEW, IN ARABIC,
 * ENGLISH AND SORANI (docs/DECISIONS.md row 183).
 *
 * Two sources, never a third:
 *   - the CONTRACTS' vocabulary for anything the server also names — the six
 *     product statuses, the derived-value states, every reason and readiness
 *     code, the field, channel and shipping-profile names, and the §6.2
 *     banners (`packages/contracts/src/pricing*`). The screen reads them by
 *     code, so the word on the screen is the word the server means;
 *   - `PRICING_UI_STRINGS` below for the screen's own furniture: headings,
 *     column names, buttons, hints.
 *
 * Every `ckb` is its own Sorani — never the Arabic or the English pasted
 * across — with at least one Sorani-only letter and none of the Arabic-only
 * ones (ة ى ي ك); tests/adminPricingStrings.test.ts walks the table. Terms
 * follow the pricing vocabulary: cost «تێچوو», shipping «ناردن», product
 * «بەرهەم», minimum target profit «کەمترین قازانجی مەبەست» (owner
 * clarification 2026-10-07).
 *
 * Pure: no React, no request. The screen formats; it never computes a price.
 */
import type { Language } from '../../translations';
import {
  LEGACY_REASONS,
  LEGACY_VALUE_STATE_LABELS,
  PRICING_MIGRATION_LABELS,
  PRICING_MIGRATION_STATUS_LABELS,
  isLegacyReasonCode,
  migrationText,
  type LegacyReasonSeverity,
  type LegacyValueState,
  type PricingMigrationStatus,
} from '../../../packages/contracts/src/pricingMigrationLabels';
import { PRICING_ISSUES, isPricingIssueCode, pricingIssueLabel } from '../../../packages/contracts/src/pricingIssues';
import {
  PRICING_CHANNEL_LABELS,
  PRICING_FIELD_LABELS,
  PRICING_PROFILE_LABELS,
  type PricingFieldName,
  type PricingLabel,
} from '../../../packages/contracts/src/pricingFieldLabels';
import type { PricingChannel, PricingProfile, PricingRoute, PricingSaleMix, PricingNames } from './api';

type Lang = Language;
/** A sentence around a figure the screen has already written in the reader's digits (`readWhole`). */
type Count = (n: string) => string;

interface UiStrings {
  title: string;
  subtitle: string;
  previewBody: string;
  productsHeading: string;
  productsCount: Count;
  shownCount: Count;
  searchLabel: string;
  searchPlaceholder: string;
  filterLabel: string;
  all: string;
  noMatch: string;
  noProducts: string;
  clearFilters: string;
  models: Count;
  modelsLabel: string;
  typedMemberPrices: string;
  typedMemberSummary: Count;
  truncated: Count;
  notLive: string;
  back: string;
  decisionHeading: string;
  decisionLater: string;
  nothingHeld: string;
  notesHeading: string;
  factsSale: string;
  factsRoutes: string;
  factsMembers: string;
  none: string;
  yes: string;
  no: string;
  membersDropped: string;
  landedNoteTitle: string;
  productItself: string;
  todayHeading: string;
  colChannel: string;
  colItem: string;
  colFee: string;
  colPrepaid: string;
  colCod: string;
  colCost: string;
  codAsDirect: string;
  channelUnpriced: string;
  derivedHeading: string;
  minProfit: string;
  directSaleExtra: string;
  baseRoute: string;
  candidates: string;
  candFloor: string;
  candCeiling: string;
  roundtripOk: string;
  measuresHeading: string;
  measureMissing: string;
  scopeProduct: string;
  scopeModel: string;
  missingHeading: string;
  missingNone: string;
  whatIfTitle: string;
  whatIfIntro: string;
  supplierCostHint: string;
  modelLabel: string;
  allModels: string;
  moreInputs: string;
  moreHint: string;
  profileAuto: string;
  ratesSection: string;
  perKg: string;
  perCbm: string;
  calculate: string;
  calculating: string;
  clear: string;
  invalidCost: string;
  decimalComma: string;
  invalidWhole: string;
  invalidWholeZero: string;
  invalidDecimal: string;
  boxAllThree: string;
  resultHeading: string;
  resultFor: string;
  colToday: string;
  colNew: string;
  colChange: string;
  noChange: string;
  notPriced: string;
  minimumKept: string;
  minimumKeptHow: Count;
  breakdown: string;
  ratesUsed: string;
  weightUsed: string;
  cbmUsed: string;
  ratesHeading: string;
  ratesIntro: string;
  fxHeading: string;
  shippingHeading: string;
  notConfirmed: string;
  fromWhatIf: string;
  missingRate: string;
  loadFailed: string;
  retry: string;
  whatIfFailed: string;
  loading: string;
  grams: string;
  mm: string;
}

/** The screen's own words. Keys are identical in the three languages (the test checks). */
export const PRICING_UI_STRINGS: Readonly<Record<Lang, UiStrings>> = {
  ar: {
    title: 'التسعير والشحن',
    subtitle: 'ما يدفعه الزبون اليوم، والحد الأدنى للربح المستخرج من أسعارك القديمة، وكم سيصبح السعر بالتسعير الجديد.',
    previewBody: 'لا يُحفظ من هذه الصفحة أي سعر أو تكلفة أو إعداد. تتغير أسعار المتجر فقط عندما تحفظ الأسعار الجديدة لمنتج، في تحديث لاحق.',
    productsHeading: 'المنتجات',
    productsCount: (n) => `عدد المنتجات: ${n}`,
    shownCount: (n) => `المنتجات المعروضة: ${n}`,
    searchLabel: 'ابحث في المنتجات',
    searchPlaceholder: 'الاسم أو الرابط',
    filterLabel: 'تصفية حسب الحالة',
    all: 'الكل',
    noMatch: 'لا يوجد منتج يطابق البحث.',
    noProducts: 'لا توجد منتجات عادية للتسعير.',
    clearFilters: 'مسح البحث والتصفية',
    models: (n) => `الموديلات: ${n}`,
    modelsLabel: 'الموديلات',
    typedMemberPrices: 'أسعار عضوية مكتوبة يدوياً',
    typedMemberSummary: (n) => `منتجات فيها أسعار PRIME/PRO مكتوبة يدوياً: ${n}`,
    truncated: (n) => `تُعرض أول ${n} منتج فقط.`,
    notLive: 'غير معروض في المتجر',
    back: 'كل المنتجات',
    decisionHeading: 'ما يحتاج قرارك',
    decisionLater: 'هذه الصفحة تعرض ما يحتاج قرارك فقط؛ تتخذ هذه القرارات هنا في التحديث القادم.',
    nothingHeld: 'لا شيء يوقف هذا المنتج سوى تكلفة المورد، وتُدخلها في التحديث القادم.',
    notesHeading: 'للعلم',
    factsSale: 'طريقة البيع',
    factsRoutes: 'مسارات الطلب المسبق',
    factsMembers: 'أسعار PRIME/PRO مكتوبة يدوياً',
    none: 'لا يوجد',
    yes: 'نعم',
    no: 'لا',
    membersDropped: 'لن تُستخدم بعد حفظ الأسعار الجديدة؛ تُطبَّق مزايا العضوية العامة.',
    landedNoteTitle: 'كيف استُخرج الحد الأدنى للربح',
    productItself: 'المنتج نفسه',
    todayHeading: 'ما يدفعه الزبون اليوم',
    colChannel: 'طريقة البيع',
    colItem: 'سعر القطعة',
    colFee: 'عمولة المسار',
    colPrepaid: 'الدفع المسبق',
    colCod: 'الدفع عند الاستلام',
    colCost: 'التكلفة القديمة (واصلة)',
    codAsDirect: 'يُحسب كبيع مباشر',
    channelUnpriced: 'لا يمكن حساب السعر الحالي',
    derivedHeading: 'المستخرج من الأسعار القديمة',
    minProfit: 'الحد الأدنى للربح',
    directSaleExtra: 'زيادة البيع المباشر',
    baseRoute: 'تُقاس من',
    candidates: 'القيم الممكنة',
    candFloor: 'الأقرب الأدنى',
    candCeiling: 'الأقرب الأعلى',
    roundtripOk: 'تحقق: إعادة الحساب من هذه القيم تعطي الأسعار الحالية نفسها.',
    measuresHeading: 'قياسات الشحن — من صفحة المنتج، غير مؤكدة',
    measureMissing: 'غير موجود',
    scopeProduct: 'للمنتج كله',
    scopeModel: 'لهذا الموديل',
    missingHeading: 'ما ينقص السعر الجديد',
    missingNone: 'لا شيء.',
    whatIfTitle: 'كم سيصبح السعر؟',
    whatIfIntro: 'اكتب تكلفة المورد وعملتها. يُحسب السعر على الخادم بالقواعد الجديدة، ولا يُحفظ شيء.',
    supplierCostHint: 'بعملة المورد، مثل 250 أو 12.5',
    modelLabel: 'الموديل',
    allModels: 'كل الموديلات',
    moreInputs: 'قياسات وأسعار أخرى',
    moreHint: 'اتركها فارغة لاستخدام قياسات صفحة المنتج والأسعار المأخوذة من مشترياتك.',
    profileAuto: 'حسب المسار',
    ratesSection: 'أسعار لهذا الحساب فقط',
    perKg: 'د.ع لكل كغم',
    perCbm: 'د.ع لكل CBM',
    calculate: 'احسب',
    calculating: 'جارٍ الحساب…',
    clear: 'مسح',
    invalidCost: 'اكتب رقماً أكبر من صفر، بأربعة منازل عشرية على الأكثر.',
    decimalComma: 'استخدم النقطة للكسور (12.5) أو «٫»؛ الفاصلة تفصل الآلاف فقط (1,250).',
    invalidWhole: 'اكتب عدداً صحيحاً أكبر من صفر.',
    invalidWholeZero: 'اكتب عدداً صحيحاً، صفراً أو أكثر.',
    invalidDecimal: 'اكتب رقماً أكبر من صفر.',
    boxAllThree: 'اكتب الأبعاد الثلاثة معاً، أو اتركها كلها فارغة.',
    resultHeading: 'النتيجة',
    resultFor: 'لتكلفة مورد',
    colToday: 'اليوم',
    colNew: 'السعر الجديد',
    colChange: 'التغيير',
    noChange: 'بلا تغيير',
    notPriced: 'لا يمكن تسعيره بعد',
    minimumKept: 'الحد الأدنى للربح محفوظ',
    minimumKeptHow: (step) => `السعر الجديد يغطي تكلفة الاستبدال الحالية والحد الأدنى للربح، ثم يُقرَّب للأعلى إلى أقرب ${step}؛ وفي البيع المباشر تُضاف إليه بعد ذلك زيادة البيع المباشر.`,
    breakdown: 'التفاصيل',
    ratesUsed: 'الأسعار المستخدمة',
    weightUsed: 'الوزن المعتمد',
    cbmUsed: 'الحجم المعتمد',
    ratesHeading: 'الأسعار المرجعية',
    ratesIntro: 'هذه هي الأسعار التي تستخدمها الحاسبة ما لم تكتب غيرها.',
    fxHeading: 'أسعار الصرف إلى الدينار',
    shippingHeading: 'أسعار الشحن',
    notConfirmed: 'غير مؤكد',
    fromWhatIf: 'من حسابك',
    missingRate: 'غير موجود',
    loadFailed: 'تعذّر تحميل التسعير.',
    retry: 'إعادة المحاولة',
    whatIfFailed: 'تعذّر الحساب.',
    loading: 'جارٍ التحميل…',
    grams: 'غم',
    mm: 'ملم',
  },
  en: {
    title: 'Pricing & shipping',
    subtitle: 'What a customer pays today, the minimum profit your old prices carry, and what the new pricing would charge.',
    previewBody: "Nothing on this page saves a price, a cost or a setting. Store prices change only when you save a product's new prices, in a later update.",
    productsHeading: 'Products',
    productsCount: (n) => `Products: ${n}`,
    shownCount: (n) => `Products shown: ${n}`,
    searchLabel: 'Search products',
    searchPlaceholder: 'Name or slug',
    filterLabel: 'Filter by status',
    all: 'All',
    noMatch: 'No product matches.',
    noProducts: 'There are no ordinary products to price.',
    clearFilters: 'Clear search and filter',
    models: (n) => `Models: ${n}`,
    modelsLabel: 'Models',
    typedMemberPrices: 'Typed member prices',
    typedMemberSummary: (n) => `Products with typed PRIME/PRO prices: ${n}`,
    truncated: (n) => `Only the first ${n} products are shown.`,
    notLive: 'Not shown in the store',
    back: 'All products',
    decisionHeading: 'What needs your decision',
    decisionLater: 'This page only shows what needs your decision; you make these choices here in the next update.',
    nothingHeld: 'Nothing holds this product except the supplier cost, which you enter in the next update.',
    notesHeading: 'For your information',
    factsSale: 'Sold as',
    factsRoutes: 'Pre-order routes',
    factsMembers: 'Typed PRIME/PRO prices',
    none: 'None',
    yes: 'Yes',
    no: 'No',
    membersDropped: 'They will not be used once you save the new prices; the general membership benefits apply.',
    landedNoteTitle: 'How the minimum profit was worked out',
    productItself: 'The product itself',
    todayHeading: 'What a customer pays today',
    colChannel: 'Channel',
    colItem: 'Item price',
    colFee: 'Route fee',
    colPrepaid: 'Prepaid',
    colCod: 'Cash on delivery',
    colCost: 'Old landed cost',
    codAsDirect: 'charged as a direct sale',
    channelUnpriced: "Today's price cannot be calculated",
    derivedHeading: 'Taken from the old prices',
    minProfit: 'Minimum target profit',
    directSaleExtra: 'Direct Sale Extra',
    baseRoute: 'Measured from',
    candidates: 'Possible values',
    candFloor: 'Nearest lower',
    candCeiling: 'Nearest higher',
    roundtripOk: "Check: recomputing from these values gives back today's prices.",
    measuresHeading: 'Shipping measures — from the product page, not confirmed',
    measureMissing: 'Missing',
    scopeProduct: 'whole product',
    scopeModel: 'this model',
    missingHeading: 'What the new price still needs',
    missingNone: 'Nothing.',
    whatIfTitle: 'What would the price be?',
    whatIfIntro: 'Type the supplier cost and its currency. The price is worked out on the server with the new rules; nothing is saved.',
    supplierCostHint: "In the supplier's currency, e.g. 250 or 12.5",
    modelLabel: 'Model',
    allModels: 'All models',
    moreInputs: 'Other measures and rates',
    moreHint: "Leave empty to use the product page's measures and the rates taken from your purchases.",
    profileAuto: 'By route',
    ratesSection: 'Rates for this calculation only',
    perKg: 'IQD per kg',
    perCbm: 'IQD per CBM',
    calculate: 'Calculate',
    calculating: 'Calculating…',
    clear: 'Clear',
    invalidCost: 'Enter a number above zero, with at most four decimal places.',
    decimalComma: 'Use a point for decimals (12.5); a comma only separates thousands (1,250).',
    invalidWhole: 'Enter a whole number above zero.',
    invalidWholeZero: 'Enter a whole number, zero or more.',
    invalidDecimal: 'Enter a number above zero.',
    boxAllThree: 'Enter all three sides together, or leave all three empty.',
    resultHeading: 'Result',
    resultFor: 'For a supplier cost of',
    colToday: 'Today',
    colNew: 'New price',
    colChange: 'Change',
    noChange: 'No change',
    notPriced: 'Cannot be priced yet',
    minimumKept: 'Minimum profit kept',
    minimumKeptHow: (step) => `The new price covers the current replacement cost and the minimum profit, then rounds up to the next ${step}; a direct sale then adds the Direct Sale Extra on top.`,
    breakdown: 'Breakdown',
    ratesUsed: 'Rates used',
    weightUsed: 'Weight used',
    cbmUsed: 'Volume used',
    ratesHeading: 'Reference rates',
    ratesIntro: 'These are the rates the calculator uses unless you type others.',
    fxHeading: 'Exchange rates to IQD',
    shippingHeading: 'Shipping rates',
    notConfirmed: 'Not confirmed',
    fromWhatIf: 'From your calculation',
    missingRate: 'Missing',
    loadFailed: 'Could not load pricing.',
    retry: 'Try again',
    whatIfFailed: 'Could not calculate.',
    loading: 'Loading…',
    grams: 'g',
    mm: 'mm',
  },
  ckb: {
    title: 'نرخدانان و ناردنی بەرهەم',
    subtitle: 'ئەوەی کڕیار ئەمڕۆ دەیدات، کەمترین قازانجی دەرهێنراو لە نرخە کۆنەکانت، و نرخ بە نرخدانانی نوێ چەند دەبێت.',
    previewBody: 'لەم پەڕەیەوە هیچ نرخ، تێچوو یان ڕێکخستنێک پاشەکەوت ناکرێت. نرخەکانی فرۆشگا تەنها ئەو کاتە دەگۆڕێن کە نرخە نوێیەکانی بەرهەمێک پاشەکەوت دەکەیت، لە نوێکردنەوەیەکی داهاتوودا.',
    productsHeading: 'بەرهەمەکان',
    productsCount: (n) => `ژمارەی بەرهەمەکان: ${n}`,
    shownCount: (n) => `بەرهەمە پیشاندراوەکان: ${n}`,
    searchLabel: 'گەڕان لە بەرهەمەکان',
    searchPlaceholder: 'ناو یان بەستەر',
    filterLabel: 'پاڵاوتن بەپێی دۆخ',
    all: 'هەموو',
    noMatch: 'هیچ بەرهەمێک لەگەڵ گەڕانەکەدا ناگونجێت.',
    noProducts: 'هیچ بەرهەمێکی ئاسایی بۆ نرخدانان نییە.',
    clearFilters: 'سڕینەوەی گەڕان و پاڵاوتن',
    models: (n) => `مۆدێلەکان: ${n}`,
    modelsLabel: 'مۆدێلەکان',
    typedMemberPrices: 'نرخی ئەندامێتیی دەستنووس',
    typedMemberSummary: (n) => `بەرهەمەکان کە نرخی PRIME/PRO-ی دەستنووسیان هەیە: ${n}`,
    truncated: (n) => `تەنها یەکەم ${n} بەرهەم پیشان دەدرێن.`,
    notLive: 'لە فرۆشگادا پیشان نادرێت',
    back: 'هەموو بەرهەمەکان',
    decisionHeading: 'ئەوەی پێویستی بە بڕیاری تۆیە',
    decisionLater: 'ئەم پەڕەیە تەنها ئەوە پیشان دەدات کە پێویستی بە بڕیاری تۆیە؛ لە نوێکردنەوەی داهاتوودا لێرەوە ئەم بڕیارانە دەدەیت.',
    nothingHeld: 'جگە لە تێچووی دابینکەر هیچ شتێک ئەم بەرهەمە ڕاناگرێت، کە لە نوێکردنەوەی داهاتوودا دەینووسیت.',
    notesHeading: 'بۆ زانیاریت',
    factsSale: 'شێوەی فرۆشتن',
    factsRoutes: 'ڕێگاکانی پێشداواکاری',
    factsMembers: 'نرخی PRIME/PRO-ی دەستنووس',
    none: 'هیچ',
    yes: 'بەڵێ',
    no: 'نەخێر',
    membersDropped: 'دوای پاشەکەوتکردنی نرخە نوێیەکان بەکارناهێنرێن؛ سوودە گشتییەکانی ئەندامێتی جێبەجێ دەکرێن.',
    landedNoteTitle: 'کەمترین قازانج چۆن دەرهێنرا',
    productItself: 'خودی بەرهەمەکە',
    todayHeading: 'ئەوەی کڕیار ئەمڕۆ دەیدات',
    colChannel: 'ڕێگای فرۆشتن',
    colItem: 'نرخی پارچە',
    colFee: 'کرێی ڕێگا',
    colPrepaid: 'پارەدانی پێشوەختە',
    colCod: 'پارەدان لە کاتی وەرگرتن',
    colCost: 'تێچووی کۆنی گەیشتوو',
    codAsDirect: 'وەک فرۆشتنی ڕاستەوخۆ حیساب دەکرێت',
    channelUnpriced: 'نرخی ئێستا حیساب ناکرێت',
    derivedHeading: 'دەرهێنراو لە نرخە کۆنەکان',
    minProfit: 'کەمترین قازانجی مەبەست',
    directSaleExtra: 'زیادەی فرۆشتنی ڕاستەوخۆ',
    baseRoute: 'دەپێورێت لە',
    candidates: 'بەها گونجاوەکان',
    candFloor: 'نزیکترین بەهای خوارتر',
    candCeiling: 'نزیکترین بەهای سەرتر',
    roundtripOk: 'پشکنین: حیسابکردنەوە لەم بەهایانەوە هەمان نرخەکانی ئێستا دەداتەوە.',
    measuresHeading: 'پێوانەکانی ناردن — لە پەڕەی بەرهەمەوە، پشتڕاست نەکراونەتەوە',
    measureMissing: 'نییە',
    scopeProduct: 'بۆ هەموو بەرهەمەکە',
    scopeModel: 'بۆ ئەم مۆدێلە',
    missingHeading: 'ئەوەی نرخی نوێ هێشتا پێویستیەتی',
    missingNone: 'هیچ.',
    whatIfTitle: 'نرخەکە چەند دەبێت؟',
    whatIfIntro: 'تێچووی دابینکەر و دراوەکەی بنووسە. نرخەکە لە ڕاژەکار بە ڕێسا نوێیەکان حیساب دەکرێت، و هیچ شتێک پاشەکەوت ناکرێت.',
    supplierCostHint: 'بە دراوی دابینکەر، بۆ نموونە 250 یان 12.5',
    modelLabel: 'مۆدێل',
    allModels: 'هەموو مۆدێلەکان',
    moreInputs: 'پێوانە و نرخی تر',
    moreHint: 'بەتاڵیان بهێڵەرەوە بۆ بەکارهێنانی پێوانەکانی پەڕەی بەرهەم و ئەو نرخانەی لە کڕینەکانتەوە وەرگیراون.',
    profileAuto: 'بەپێی ڕێگا',
    ratesSection: 'نرخ تەنها بۆ ئەم حیسابە',
    perKg: 'د.ع بۆ هەر کیلۆگرام',
    perCbm: 'د.ع بۆ هەر CBM',
    calculate: 'حیسابی بکە',
    calculating: 'حیساب دەکرێت…',
    clear: 'پاککردنەوە',
    invalidCost: 'ژمارەیەکی سەرووی سفر بنووسە، لە چوار ژمارەی دوای خاڵ زیاتر نەبێت.',
    decimalComma: 'بۆ ژمارەی دوای خاڵ، خاڵ بەکاربهێنە (12.5) یان «٫»؛ فاریزە تەنها هەزارەکان جیا دەکاتەوە (1,250).',
    invalidWhole: 'ژمارەیەکی تەواوی سەرووی سفر بنووسە.',
    invalidWholeZero: 'ژمارەیەکی تەواو بنووسە، سفر یان زیاتر.',
    invalidDecimal: 'ژمارەیەکی سەرووی سفر بنووسە.',
    boxAllThree: 'هەر سێ لاکە پێکەوە بنووسە، یان هەر سێکیان بەتاڵ بهێڵەرەوە.',
    resultHeading: 'ئەنجام',
    resultFor: 'بۆ تێچووی دابینکەری',
    colToday: 'ئەمڕۆ',
    colNew: 'نرخی نوێ',
    colChange: 'گۆڕان',
    noChange: 'بێ گۆڕان',
    notPriced: 'هێشتا نرخی بۆ دانانرێت',
    minimumKept: 'کەمترین قازانج پارێزراوە',
    minimumKeptHow: (step) => `نرخی نوێ تێچووی ئێستای جێگرتنەوە و کەمترین قازانج دەگرێتەوە، پاشان بۆ سەرەوە بۆ نزیکترین ${step} خڕ دەکرێتەوە؛ لە فرۆشتنی ڕاستەوخۆدا دواتر زیادەی فرۆشتنی ڕاستەوخۆی بۆ زیاد دەکرێت.`,
    breakdown: 'وردەکاری',
    ratesUsed: 'نرخە بەکارهاتووەکان',
    weightUsed: 'کێشی بەکارهاتوو',
    cbmUsed: 'قەبارەی بەکارهاتوو',
    ratesHeading: 'نرخە ئاماژەییەکان',
    ratesIntro: 'ئەمانە ئەو نرخانەن کە حیسابکەرەکە بەکاریان دەهێنێت، مەگەر خۆت نرخی تر بنووسیت.',
    fxHeading: 'نرخی ئاڵوگۆڕ بۆ دینار',
    shippingHeading: 'نرخەکانی ناردن',
    notConfirmed: 'پشتڕاست نەکراوەتەوە',
    fromWhatIf: 'لە حیسابەکەتەوە',
    missingRate: 'نییە',
    loadFailed: 'نرخدانان بار نەکرا.',
    retry: 'دووبارە هەوڵبدەرەوە',
    whatIfFailed: 'حیسابەکە نەکرا.',
    loading: 'بار دەکرێت…',
    grams: 'گرام',
    mm: 'میلیمەتر',
  },
};

export type PricingUiStrings = UiStrings;

export function pricingStrings(lang: Lang): UiStrings {
  return PRICING_UI_STRINGS[lang] ?? PRICING_UI_STRINGS.ar;
}

// ------------------------------------------------------------- the contracts

const pick = (label: PricingLabel, lang: Lang): string => label[lang] || label.en;

export const previewOnlyText = (lang: Lang) => pick(PRICING_MIGRATION_LABELS['b.previewOnly'], lang);
export const landedNoteText = (lang: Lang) => pick(PRICING_MIGRATION_LABELS['b.landedNote'], lang);
export const ratesFromPurchasesText = (lang: Lang) => pick(PRICING_MIGRATION_LABELS['b.ratesFromPurchases'], lang);
export const usdMissingText = (lang: Lang) => pick(PRICING_MIGRATION_LABELS['b.usdRateMissing'], lang);
export const noAdditionalCostsText = (lang: Lang) => pick(PRICING_MIGRATION_LABELS['L.NO_ADDITIONAL_COSTS'], lang);

export const statusLabel = (s: PricingMigrationStatus, lang: Lang) => pick(PRICING_MIGRATION_STATUS_LABELS[s], lang);
export const valueStateLabel = (s: LegacyValueState, lang: Lang) => pick(LEGACY_VALUE_STATE_LABELS[s], lang);
export const channelLabel = (c: PricingChannel, lang: Lang) => pick(PRICING_CHANNEL_LABELS[c], lang);
export const profileLabel = (p: PricingProfile, lang: Lang) => pick(PRICING_PROFILE_LABELS[p], lang);
export const fieldLabel = (f: PricingFieldName, lang: Lang) => pick(PRICING_FIELD_LABELS[f], lang);
export const routeChannel = (r: PricingRoute): PricingChannel => `pre_order_${r}` as PricingChannel;

export const PRICING_MIX_LABELS: Readonly<Record<PricingSaleMix, PricingLabel>> = {
  BOTH: { ar: 'بيع مباشر وطلب مسبق', en: 'Direct sale and pre-order', ckb: 'فرۆشتنی ڕاستەوخۆ و پێشداواکاری' },
  DIRECT_ONLY: { ar: 'بيع مباشر فقط', en: 'Direct sale only', ckb: 'تەنها فرۆشتنی ڕاستەوخۆ' },
  PREORDER_ONLY: { ar: 'طلب مسبق فقط', en: 'Pre-order only', ckb: 'تەنها پێشداواکاری' },
  NOT_SELLABLE: { ar: 'لا يُباع اليوم', en: 'Not on sale today', ckb: 'ئەمڕۆ نافرۆشرێت' },
};
export const mixLabel = (m: PricingSaleMix, lang: Lang) => pick(PRICING_MIX_LABELS[m], lang);

export const PRICING_ROUTE_LABELS: Readonly<Record<PricingRoute, PricingLabel>> = {
  air: { ar: 'جوي', en: 'Air', ckb: 'ڕێگای ئاسمانی' },
  sea: { ar: 'بحري', en: 'Sea', ckb: 'ڕێگای دەریایی' },
  land: { ar: 'بري', en: 'Land', ckb: 'ڕێگای وشکانی' },
};
export const routeLabel = (r: PricingRoute, lang: Lang) => pick(PRICING_ROUTE_LABELS[r], lang);

/** A product's or a model's name in the reader's language, falling back to the others. */
export function nameOf(n: PricingNames | null | undefined, lang: Lang, fallback = ''): string {
  if (!n) return fallback;
  const order = lang === 'en' ? [n.name_en, n.name_ar, n.name_ckb] : lang === 'ckb' ? [n.name_ckb, n.name_ar, n.name_en] : [n.name_ar, n.name_en, n.name_ckb];
  return order.find((s) => typeof s === 'string' && s.trim() !== '')?.trim() ?? fallback;
}

// --------------------------------------------------------------- the codes

export type ReasonTone = 'danger' | 'warning' | 'info' | 'neutral';

/** How heavily a code weighs: a conflict, a hold, or a note that explains. */
export function reasonTone(code: string): ReasonTone {
  if (isLegacyReasonCode(code)) {
    const severity: LegacyReasonSeverity = LEGACY_REASONS[code].severity;
    return severity === 'conflict' ? 'danger' : severity === 'info' ? 'info' : 'warning';
  }
  if (isPricingIssueCode(code)) return PRICING_ISSUES[code].severity === 'error' ? 'warning' : 'neutral';
  return 'warning';
}

/**
 * The sentence for a reason or readiness code — the contracts' own, by code.
 * `{method}` and `{iqd}` are filled with the caller's figures (already
 * formatted); a code no contract owns is shown as the code, never dropped.
 */
export function reasonText(code: string, lang: Lang, params: { method?: string; iqd?: string; currency?: string } = {}): string {
  if (isLegacyReasonCode(code)) {
    const filled: Record<string, string> = {};
    if (params.method !== undefined) filled.method = params.method;
    if (params.iqd !== undefined) filled.iqd = params.iqd;
    return migrationText(LEGACY_REASONS[code].label, lang, filled);
  }
  if (isPricingIssueCode(code)) return pricingIssueLabel(code, lang, { currency: params.currency ?? null });
  return code;
}

// ------------------------------------------------------------- formatting
//
// The formatters live in ./format (no contract imports) so the dashboard's
// owner rates card can use them without the pricing vocabulary; re-exported
// here for every existing import.
export { groupDecimal, groupWhole, localizeDigits, readDecimal, readWhole } from './format';

// The exchange-rate panel's words (FX programme plan §12) live in ./fxStrings,
// pure and contract-free, so the dashboard card can read them alone.
export { FX_STRINGS, fxStrings, fxEventLabel, type FxStrings } from './fxStrings';

/**
 * The change as a share of today's price, one decimal, for reading only —
 * never fed back into a price. null when there is no base to compare with.
 */
export function changePercent(change: number | null, today: number | null): number | null {
  if (change == null || today == null || today <= 0) return null;
  return Math.round((change * 1000) / today) / 10;
}
