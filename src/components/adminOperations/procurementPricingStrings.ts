/**
 * «التكاليف والشحن» — EVERY WORD OF THE PROCUREMENT CARD'S PRICING, IN ARABIC,
 * ENGLISH AND SORANI (USD design §5.3-§5.4; owner brief 2026-10-09;
 * docs/DECISIONS.md row 183).
 *
 * The minimum profit in USD that replaces «سعر البيع المرجعي للقطعة بالدينار»,
 * the 4-cell summary at the end of each product card, its «تفاصيل» (the brief's
 * 13 items and the three notes), the review step's preview of the new prices,
 * and the apply results. Every `ckb` is its own Sorani — never the Arabic or
 * the English pasted across — with Sorani letters and the pricing terms:
 * shipping «ناردن», product «بەرهەم», minimum target profit «کەمترین قازانجی
 * مەبەست» (never «گواستنەوە» or «کاڵا»: tests/procurementPricingStrings.test.ts).
 *
 * Pure: no React, no request. Figures arrive already formatted by the caller.
 */
import type { Language } from '../../translations';
import { isPricingIssueCode, pricingIssueLabel } from '../../../packages/contracts/src/pricingIssues';
import { PRICING_CHANNEL_LABELS, PRICING_PROFILE_LABELS } from '../../../packages/contracts/src/pricingFieldLabels';

type Fill = (v: string) => string;
type Fill2 = (a: string, b: string) => string;
type Fill3 = (a: string, b: string, c: string) => string;

export interface ProcurementPricingStrings {
  // field and hint
  fieldLabel: string;
  fieldHint: Fill;
  levelProduct: string;
  levelOption: string;
  levelColour: string;
  levelVariant: string;
  inherits: Fill2;
  nothingToInherit: string;
  invalid: string;
  variantLine: string;
  colourLine: string;
  storePrice: Fill;
  lineHint: string;
  // the bar
  cellCost: string;
  cellProfit: string;
  cellFinalUsd: string;
  cellCustomer: string;
  cellSuggested: string;
  basedOn: Fill;
  directSale: Fill;
  barAria: Fill;
  details: string;
  detailsAria: Fill;
  landedRow: string;
  current: string;
  computing: string;
  // «تفاصيل»: the brief's 13 items
  row1: string;
  row2: string;
  row3: string;
  row4: string;
  row5: string;
  row6: string;
  row7: string;
  row8: string;
  row9: string;
  row10: string;
  row11: string;
  row12: string;
  row13: string;
  convertedOnce: Fill2;
  fromLevel: Fill;
  perKg: Fill;
  perCbm: Fill;
  excludedListed: Fill;
  migratedDinars: string;
  n1: string;
  n1Doc: Fill;
  n2: Fill3;
  n3: Fill;
  n3Tooltip: string;
  // manual lines and charges
  manualOptIn: string;
  excludedCharge: string;
  confirmNotFreight: string;
  countedInPricing: string;
  // blocked reasons and banners
  shippingRateMissing: string;
  targetProfitMissing: string;
  reviewBanner: Fill;
  notInstalled: string;
  blockedOther: string;
  // the review step's preview
  previewTitle: string;
  colModel: string;
  colChannel: string;
  colReplacement: string;
  colMinProfit: string;
  colNewPreorder: string;
  colExtra: string;
  colNewDirect: string;
  colOldNew: string;
  usePurchase: string;
  preferPurchase: string;
  shadowed: string;
  estimated: string;
  proposedProfile: Fill;
  cod: string;
  legacyStep: string;
  incomplete: Fill;
  largeChange: string;
  savePc: string;
  saveConfirmApply: string;
  partial: Fill;
  retry: string;
  appliedNotice: string;
  // the saved document
  notApplied: string;
  applyNow: string;
  cancelledSource: string;
  // a stock purchase is reviewed for direct sale (owner request 2026-10-10)
  sectionDirect: string;
  extraLabel: string;
  extraHint: string;
  noExtra: string;
  todayExtra: Fill;
  extraNeeded: string;
  extraInvalid: string;
  preorderFollow: Fill;
  preorderWhy: Fill;
  preorderOnly: string;
  colBeforeExtra: string;
  directRoute: Fill;
  cellDirectCustomer: string;
  cellDirectSuggested: string;
  cellPreorderBase: string;
  directCaption: Fill2;
  extraInReview: string;
}

const ar: ProcurementPricingStrings = {
  fieldLabel: 'الحد الأدنى للربح (USD)',
  fieldHint: (level) => `أقل ربح بالدولار فوق التكلفة الحالية لـ${level}. يُحفظ عند اعتماد تكلفة الشراء في التسعير بعد تأكيد الشراء؛ اتركه فارغًا ليرث.`,
  levelProduct: 'المنتج',
  levelOption: 'الخيار',
  levelColour: 'اللون',
  levelVariant: 'النسخة',
  inherits: (level, amount) => `يرث من ${level}: ${amount}`,
  nothingToInherit: 'لا يوجد حد أدنى في المستويات الأعلى — أدخله',
  invalid: 'أدخل مبلغًا أكبر من صفر بالدولار، بمنزلتين عشريتين على الأكثر، حتى 100,000',
  variantLine: 'يُحفظ على مستوى الخيار ويشمل كل ألوانه',
  colourLine: 'يُحفظ على مستوى المنتج ويشمل كل ألوانه',
  storePrice: (price) => `سعر المتجر الحالي: ${price}`,
  lineHint: 'ابحث عن المنتج ثم حدد الخيار واللون. نجلب الوزن المعبّأ، ثم آخر سعر خام محفوظ لمسار المورد الذي تختاره في التكاليف والشحن.',
  cellCost: 'التكلفة النهائية',
  cellProfit: 'الحد الأدنى للربح',
  cellFinalUsd: 'السعر النهائي بالدولار',
  cellCustomer: 'السعر النهائي للزبون',
  cellSuggested: 'السعر المقترح للزبون',
  basedOn: (profile) => `على أساس ${profile}`,
  directSale: (direct) => `البيع المباشر: ${direct}`,
  barAria: (label) => `ملخص التسعير — ${label}`,
  details: 'تفاصيل',
  detailsAria: (label) => `تفاصيل التسعير — ${label}`,
  landedRow: 'تكلفة القطعة الفعلية لهذه الشحنة',
  current: 'الحالي',
  computing: 'جارٍ حساب السعر…',
  row1: 'تكلفة المورد الأصلية',
  row2: 'العملة الأصلية',
  row3: 'سعر EUR/USD أو CNY/USD المستخدم',
  row4: 'تكلفة المورد بالدولار',
  row5: 'الوزن / CBM',
  row6: 'تكلفة الشحن بالدينار',
  row7: 'تكلفة الشحن بالدولار',
  row8: 'التكاليف الإضافية',
  row9: 'التكلفة الحالية الإجمالية بالدولار',
  row10: 'الحد الأدنى للربح بالدولار',
  row11: 'السعر النهائي بالدولار',
  row12: 'سعر الدولار الفعّال (USD/IQD)',
  row13: 'السعر النهائي بالدينار',
  convertedOnce: (rate, date) => `حُوّل مرة واحدة بسعر ${rate} في ${date}`,
  fromLevel: (level) => `من ${level}`,
  perKg: (rate) => `× ${rate} د.ع/كغم`,
  perCbm: (rate) => `× ${rate} د.ع/CBM`,
  excludedListed: (titles) => `مستبعد من التسعير: ${titles}`,
  migratedDinars: 'قيمة مرحّلة بالدينار، معروضة بالدولار بسعر اليوم',
  n1: 'التسعير يستخدم أسعار الصرف والشحن المركزية الحالية، لا أسعار هذا المستند',
  n1Doc: (rate) => `سعر هذا المستند: ${rate}`,
  n2: (pre, x, direct) => `سعر البيع المباشر = ${pre} + زيادة البيع المباشر ${x} = ${direct}`,
  n3: (n) => `يُقرَّب السعر لأعلى إلى أقرب 1,000 د.ع (+${n})`,
  n3Tooltip: 'الأرقام بالدولار مقرّبة إلى السنت للعرض؛ السعر يُحسب من القيم الدقيقة',
  manualOptIn: 'اعتمد سعر المورد هذا (دون الشحن) للتسعير',
  excludedCharge: 'مستبعد من التسعير: يبدو شحنًا وقد يكرر شحن المسار. أكّد أنه ليس شحنًا لاحتسابه',
  confirmNotFreight: 'ليست شحنًا، احتسبها في التسعير أيضًا',
  countedInPricing: 'تُحتسب في التسعير أيضًا',
  shippingRateMissing: 'لا يوجد سعر شحن مركزي لهذا المسار بعد',
  targetProfitMissing: 'أدخل الحد الأدنى للربح لهذا المنتج أو أحد مستوياته',
  reviewBanner: (rate) => `سعر صرف جديد بانتظار اعتمادك؛ تُحسب هذه الأسعار بالسعر المعتمد الحالي ${rate}، وتُعاد حين تعتمده`,
  notInstalled: 'حساب الأسعار غير متاح بعد على قاعدة البيانات هذه',
  blockedOther: 'لا يمكن حساب السعر بعد؛ أكمل بيانات التسعير',
  previewTitle: 'معاينة الأسعار الجديدة قبل الحفظ',
  colModel: 'الموديل',
  colChannel: 'طريقة البيع',
  colReplacement: 'التكلفة الحالية',
  colMinProfit: 'الحد الأدنى للربح',
  colNewPreorder: 'سعر الطلب المسبق الجديد',
  colExtra: 'زيادة البيع المباشر',
  colNewDirect: 'سعر البيع المباشر الجديد',
  colOldNew: 'القديم ← الجديد',
  usePurchase: 'استعمل هذا الشراء لتسعير هذا المنتج',
  preferPurchase: 'استعمل قيمة هذا الشراء حتى لو كانت أقل من الحالية',
  shadowed: 'لن تُستعمل في السعر: قيمة محددة على مستوى أدق',
  estimated: 'تكلفة الشراء تقديرية — لن تُعتمد في التسعير حتى تثبيتها',
  proposedProfile: (profile) => `مسار الشحن الأساسي: ${profile} (مقترح من هذا الشراء)`,
  cod: 'الدفع عند الاستلام للطلب المسبق يدفع سعر البيع المباشر',
  legacyStep: 'يرتفع السعر 1,000 د.ع بسبب تقريب الحد الأدنى إلى السنت',
  incomplete: (list) => `تُحفظ البيانات فقط؛ ينقص: ${list}`,
  largeChange: 'تغيّر أكبر من 15٪ — أكّد، وقد يُطلب تسجيل دخول حديث',
  savePc: 'حفظ البيانات — تُطبَّق الأسعار الجديدة بعد التحديث 4',
  saveConfirmApply: 'تأكيد الشراء وتطبيق الأسعار',
  partial: (n) => `حُفظ الشراء. لم تُحدَّث أسعار ${n} منتجات — راجعها`,
  retry: 'إعادة المحاولة',
  appliedNotice: 'اعتُمدت تكلفة الشراء والحد الأدنى للربح في بيانات التسعير',
  notApplied: 'لم تُعتمد تكلفة هذا الشراء في التسعير بعد',
  applyNow: 'اعتمدها الآن',
  cancelledSource: 'مصدر التكلفة شراء مُلغى — راجع التكلفة',
  sectionDirect: 'البيع المباشر',
  extraLabel: 'زيادة البيع المباشر (د.ع)',
  extraHint: 'تُضاف زيادة البيع المباشر إلى سعر الطلب المسبق الأساسي لتعطي سعر البيع المباشر، لكل موديل في المنتج لم تُحدَّد له زيادة البيع المباشر الخاصة به. 0 مقبول.',
  noExtra: 'بدون زيادة البيع المباشر (0)',
  todayExtra: (x) => `زيادة البيع المباشر الحالية: ${x}`,
  extraNeeded: 'لتسعير البيع المباشر أدخل زيادة البيع المباشر أعلاه (0 مقبول). بدونها تُحفظ البيانات فقط.',
  extraInvalid: 'أدخل زيادة البيع المباشر بالدينار، مضاعفًا لـ 1,000 (0 مقبول)',
  preorderFollow: (n) => `وتتغير معها أسعار الطلب المسبق لأنها من التكلفة نفسها (${n})`,
  preorderWhy: (route) => `يظهر الطلب المسبق لأن المنتج معروض للطلب المسبق — ${route}. لإيقافه أطفئ الطلب المسبق في إعدادات المنتج.`,
  preorderOnly: 'هذا المنتج لا يملك بيعًا مباشرًا مفعّلًا؛ لن يغيّر شراء المخزون أسعاره.',
  colBeforeExtra: 'السعر قبل زيادة البيع المباشر',
  directRoute: (route) => `يُبنى سعر البيع المباشر على: ${route} (مقترح من هذا الشراء)`,
  cellDirectCustomer: 'سعر البيع المباشر للزبون',
  cellDirectSuggested: 'سعر البيع المباشر المقترح',
  cellPreorderBase: 'السعر قبل زيادة البيع المباشر',
  directCaption: (pre, x) => `السعر الأساسي ${pre} + زيادة البيع المباشر ${x}`,
  extraInReview: 'أدخل زيادة البيع المباشر في المراجعة لتسعير البيع المباشر',
};

const en: ProcurementPricingStrings = {
  fieldLabel: 'Minimum profit (USD)',
  fieldHint: (level) => `The least profit in USD above today's cost, for the ${level}. Saved when the purchase cost is applied to pricing after you confirm the purchase; leave it empty to inherit.`,
  levelProduct: 'product',
  levelOption: 'option',
  levelColour: 'colour',
  levelVariant: 'variant',
  inherits: (level, amount) => `Inherits from ${level}: ${amount}`,
  nothingToInherit: 'No minimum is set at a higher level — enter one',
  invalid: 'Enter an amount above zero in USD, with at most two decimals, up to 100,000',
  variantLine: 'Saved at option level; it covers every colour of the option',
  colourLine: 'Saved at product level; it covers every colour',
  storePrice: (price) => `Current store price: ${price}`,
  lineHint: 'Choose the exact item. Its packed measurements load here; saved raw supplier prices load when you choose the route in Costs & freight.',
  cellCost: 'Final cost',
  cellProfit: 'Minimum profit',
  cellFinalUsd: 'Final price (USD)',
  cellCustomer: 'Final customer price',
  cellSuggested: 'Suggested customer price',
  basedOn: (profile) => `Based on ${profile}`,
  directSale: (direct) => `Direct sale: ${direct}`,
  barAria: (label) => `Pricing summary — ${label}`,
  details: 'Details',
  detailsAria: (label) => `Pricing details — ${label}`,
  landedRow: "This shipment's landed unit cost",
  current: 'Current',
  computing: 'Calculating the price…',
  row1: 'Original supplier cost',
  row2: 'Original currency',
  row3: 'EUR/USD or CNY/USD used',
  row4: 'Supplier cost in USD',
  row5: 'Weight / CBM',
  row6: 'Shipping cost in IQD',
  row7: 'Shipping cost in USD',
  row8: 'Additional costs',
  row9: 'Current total cost in USD',
  row10: 'Minimum target profit in USD',
  row11: 'Final price in USD',
  row12: 'Effective USD/IQD',
  row13: 'Final price in IQD',
  convertedOnce: (rate, date) => `Converted once at ${rate} on ${date}`,
  fromLevel: (level) => `from ${level}`,
  perKg: (rate) => `× ${rate} IQD/kg`,
  perCbm: (rate) => `× ${rate} IQD/CBM`,
  excludedListed: (titles) => `Left out of pricing: ${titles}`,
  migratedDinars: "A migrated amount in dinars, shown in USD at today's rate",
  n1: "Pricing uses today's central exchange and shipping rates, not this document's rates",
  n1Doc: (rate) => `This document's rate: ${rate}`,
  n2: (pre, x, direct) => `Direct sale price = ${pre} + Direct Sale Extra ${x} = ${direct}`,
  n3: (n) => `Rounded up to the next 1,000 IQD (+${n})`,
  n3Tooltip: 'USD figures are rounded to the cent for display; the price is computed from exact values',
  manualOptIn: 'Use this supplier price (without freight) for pricing',
  excludedCharge: 'Left out of pricing: it looks like freight and may repeat the route freight. Confirm it is not freight to count it',
  confirmNotFreight: 'Not freight — count it in pricing too',
  countedInPricing: 'Counted in pricing too',
  shippingRateMissing: 'There is no central shipping rate for this route yet',
  targetProfitMissing: 'Enter the minimum profit for this product or one of its levels',
  reviewBanner: (rate) => `A new exchange rate awaits your approval; these prices use the current approved rate ${rate} and are recomputed when you approve it`,
  notInstalled: 'Price calculation is not available on this database yet',
  blockedOther: 'The price cannot be calculated yet; complete the pricing data',
  previewTitle: 'New prices — preview before saving',
  colModel: 'Model',
  colChannel: 'Sale type',
  colReplacement: 'Current replacement cost',
  colMinProfit: 'Minimum profit',
  colNewPreorder: 'New pre-order price',
  colExtra: 'Direct Sale Extra',
  colNewDirect: 'New direct sale price',
  colOldNew: 'Old → new',
  usePurchase: 'Use this purchase to price this product',
  preferPurchase: "Use this purchase's value even if it is lower than the current one",
  shadowed: 'Not used in the price: a value is set at a more specific level',
  estimated: 'The purchase cost is estimated — it is not used for pricing until it is final',
  proposedProfile: (profile) => `Base shipping route: ${profile} (proposed from this purchase)`,
  cod: 'Cash-on-delivery pre-orders pay the direct-sale price',
  legacyStep: 'The price rises by 1,000 IQD because the minimum is rounded up to the cent',
  incomplete: (list) => `Data is saved only; missing: ${list}`,
  largeChange: 'A change above 15% — confirm; a fresh sign-in may be asked',
  savePc: 'Save data — the new prices apply after update 4',
  saveConfirmApply: 'Confirm purchase and apply prices',
  partial: (n) => `The purchase is saved. Prices of ${n} products were not updated — review them`,
  retry: 'Retry',
  appliedNotice: 'The purchase cost and minimum profit were saved to the pricing data',
  notApplied: "This purchase's cost has not been applied to pricing yet",
  applyNow: 'Apply it now',
  cancelledSource: 'The cost came from a cancelled purchase — review it',
  sectionDirect: 'Direct sale',
  extraLabel: 'Direct Sale Extra (IQD)',
  extraHint: 'The Direct Sale Extra is added to the base pre-order price to give the direct sale price, for every model of the product without its own. 0 is allowed.',
  noExtra: 'No Direct Sale Extra (0)',
  todayExtra: (x) => `Current Direct Sale Extra: ${x}`,
  extraNeeded: 'To price direct sale, enter the Direct Sale Extra above (0 is allowed). Without it only the data is saved.',
  extraInvalid: 'Enter the Direct Sale Extra in whole dinars, a multiple of 1,000 (0 is allowed)',
  preorderFollow: (n) => `Pre-order prices move with it, from the same cost (${n})`,
  preorderWhy: (route) => `Pre-order shows because the product is offered for pre-order — ${route}. To stop it, turn pre-order off in the product settings.`,
  preorderOnly: 'This product has no enabled direct sale; this stock purchase will not change its prices.',
  colBeforeExtra: 'Price before Direct Sale Extra',
  directRoute: (route) => `The direct sale price is built on: ${route} (proposed by this purchase)`,
  cellDirectCustomer: 'Direct sale price to the customer',
  cellDirectSuggested: 'Suggested direct sale price',
  cellPreorderBase: 'Price before Direct Sale Extra',
  directCaption: (pre, x) => `Base price ${pre} + Direct Sale Extra ${x}`,
  extraInReview: 'Enter the Direct Sale Extra in the review to price direct sale',
};

const ckb: ProcurementPricingStrings = {
  fieldLabel: 'کەمترین قازانجی مەبەست (USD)',
  fieldHint: (level) => `کەمترین قازانج بە دۆلار لە سەرووی تێچووی ئێستا بۆ ${level}. کاتێک تێچووی کڕینەکە لە نرخداناندا جێبەجێ دەکرێت، دوای پشتڕاستکردنەوەی کڕینەکە، پاشەکەوت دەکرێت؛ بەتاڵی بهێڵەوە بۆ ئەوەی لە ئاستی سەرەوە وەربگیرێت.`,
  levelProduct: 'بەرهەم',
  levelOption: 'هەڵبژاردە',
  levelColour: 'ڕەنگ',
  levelVariant: 'جۆر',
  inherits: (level, amount) => `وەرگیراو لە ${level}: ${amount}`,
  nothingToInherit: 'هیچ کەمترینێک لە ئاستە سەرووترەکان دانەنراوە — بینووسە',
  invalid: 'بڕێکی سەرووی سفر بە دۆلار بنووسە، بە زۆرترین دوو ژمارەی دوای فاریزە، تا 100,000',
  variantLine: 'لە ئاستی هەڵبژاردەدا پاشەکەوت دەکرێت و هەموو ڕەنگەکانی دەگرێتەوە',
  colourLine: 'لە ئاستی بەرهەمدا پاشەکەوت دەکرێت و هەموو ڕەنگەکانی دەگرێتەوە',
  storePrice: (price) => `نرخی ئێستای فرۆشگا: ${price}`,
  lineHint: 'بەرهەمەکە بدۆزەرەوە، پاشان هەڵبژاردە و ڕەنگ دیاری بکە. کێشی پاکێجکراو لێرە دێت، و دوایین نرخی خاوی پاشەکەوتکراو بۆ ڕێگای دابینکەر کاتێک لە تێچوو و ناردندا هەڵیدەبژێریت.',
  cellCost: 'تێچووی کۆتایی',
  cellProfit: 'کەمترین قازانجی مەبەست',
  cellFinalUsd: 'نرخی کۆتایی بە دۆلار',
  cellCustomer: 'نرخی کۆتایی بۆ کڕیار',
  cellSuggested: 'نرخی پێشنیارکراو بۆ کڕیار',
  basedOn: (profile) => `لەسەر بنەمای ${profile}`,
  directSale: (direct) => `فرۆشتنی ڕاستەوخۆ: ${direct}`,
  barAria: (label) => `پوختەی نرخدانان — ${label}`,
  details: 'وردەکاری',
  detailsAria: (label) => `وردەکاریی نرخدانان — ${label}`,
  landedRow: 'تێچووی ڕاستەقینەی هەر پارچەیەک لەم بارەدا',
  current: 'ئێستا',
  computing: 'نرخەکە هەژمار دەکرێت…',
  row1: 'تێچووی ڕەسەنی دابینکەر',
  row2: 'دراوی ڕەسەن',
  row3: 'نرخی EUR/USD یان CNY/USD کە بەکارهاتووە',
  row4: 'تێچووی دابینکەر بە دۆلار',
  row5: 'کێش / CBM',
  row6: 'تێچووی ناردن بە دینار',
  row7: 'تێچووی ناردن بە دۆلار',
  row8: 'تێچووە زیادەکان',
  row9: 'کۆی تێچووی ئێستا بە دۆلار',
  row10: 'کەمترین قازانجی مەبەست بە دۆلار',
  row11: 'نرخی کۆتایی بە دۆلار',
  row12: 'نرخی کارپێکراوی USD/IQD',
  row13: 'نرخی کۆتایی بە دینار',
  convertedOnce: (rate, date) => `یەکجار بە نرخی ${rate} لە ${date} گۆڕدرا`,
  fromLevel: (level) => `لە ${level}`,
  perKg: (rate) => `× ${rate} د.ع بۆ هەر کیلۆگرامێک`,
  perCbm: (rate) => `× ${rate} د.ع بۆ هەر مەتری سێجا (CBM)`,
  excludedListed: (titles) => `لە نرخدانان دەرکراوە: ${titles}`,
  migratedDinars: 'بڕێکی گوازراوە بە دینار، بە نرخی ئەمڕۆ بە دۆلار پیشان دراوە',
  n1: 'نرخدانان نرخە ناوەندییەکانی ئێستای ئاڵوگۆڕ و ناردن بەکاردەهێنێت، نەک نرخەکانی ئەم بەڵگەنامەیە',
  n1Doc: (rate) => `نرخی ئەم بەڵگەنامەیە: ${rate}`,
  n2: (pre, x, direct) => `نرخی فرۆشتنی ڕاستەوخۆ = ${pre} + زیادەی فرۆشتنی ڕاستەوخۆ ${x} = ${direct}`,
  n3: (n) => `بەرەو سەرەوە بۆ نزیکترین 1,000 د.ع خڕ دەکرێتەوە (+${n})`,
  n3Tooltip: 'ژمارەکانی دۆلار بۆ پیشاندان تا سەنت خڕ کراونەتەوە؛ نرخەکە لە بەها وردەکان هەژمار دەکرێت',
  manualOptIn: 'ئەم نرخەی دابینکەر (بەبێ کرێی ناردن) بۆ نرخدانان بەکاربهێنە',
  excludedCharge: 'لە نرخدانان دەرکراوە: وەک کرێی ناردن دەردەکەوێت و لەوانەیە کرێی ناردنی ڕێگاکە دووبارە بکاتەوە. دڵنیابەرەوە کە کرێی ناردن نییە بۆ ئەوەی حیساب بکرێت',
  confirmNotFreight: 'کرێی ناردن نییە، لە نرخدانانیشدا حیسابی بکە',
  countedInPricing: 'لە نرخدانانیشدا حیساب دەکرێت',
  shippingRateMissing: 'هێشتا نرخی ناوەندیی ناردن بۆ ئەم ڕێگایە نییە',
  targetProfitMissing: 'کەمترین قازانجی مەبەست بۆ ئەم بەرهەمە یان یەکێک لە ئاستەکانی بنووسە',
  reviewBanner: (rate) => `نرخێکی نوێی ئاڵوگۆڕ چاوەڕێی پەسەندکردنی تۆیە؛ ئەم نرخانە بە نرخی پەسەندکراوی ئێستا ${rate} هەژمار دەکرێن و کاتێک پەسەندی دەکەیت دووبارە هەژمار دەکرێنەوە`,
  notInstalled: 'هەژمارکردنی نرخ هێشتا لەسەر ئەم بنکەدراوەیە بەردەست نییە',
  blockedOther: 'هێشتا ناتوانرێت نرخەکە هەژمار بکرێت؛ زانیارییەکانی نرخدانان تەواو بکە',
  previewTitle: 'پێشبینینی نرخە نوێیەکان پێش پاشەکەوتکردن',
  colModel: 'مۆدێل',
  colChannel: 'جۆری فرۆشتن',
  colReplacement: 'تێچووی ئێستای جێگرتنەوە',
  colMinProfit: 'کەمترین قازانجی مەبەست',
  colNewPreorder: 'نرخی نوێی پێشداواکاری',
  colExtra: 'زیادەی فرۆشتنی ڕاستەوخۆ',
  colNewDirect: 'نرخی نوێی فرۆشتنی ڕاستەوخۆ',
  colOldNew: 'کۆن ← نوێ',
  usePurchase: 'ئەم کڕینە بۆ نرخدانانی ئەم بەرهەمە بەکاربهێنە',
  preferPurchase: 'بەهای ئەم کڕینە بەکاربهێنە ئەگەر لە بەهای ئێستاش کەمتر بێت',
  shadowed: 'لە نرخەکەدا بەکارناهێنرێت: بەهایەک لە ئاستێکی وردتردا دانراوە',
  estimated: 'تێچووی کڕینەکە خەمڵێنراوە — تا کۆتایی نەکرێت بۆ نرخدانان بەکارناهێنرێت',
  proposedProfile: (profile) => `ڕێگای بنەڕەتیی ناردن: ${profile} (لەم کڕینەوە پێشنیار کراوە)`,
  cod: 'پێشداواکاریی پارەدان لە کاتی گەیاندن نرخی فرۆشتنی ڕاستەوخۆ دەدات',
  legacyStep: 'نرخەکە 1,000 د.ع بەرز دەبێتەوە بەهۆی خڕکردنەوەی کەمترین قازانج بۆ سەنت',
  incomplete: (list) => `تەنها زانیارییەکان پاشەکەوت دەکرێن؛ کەمە: ${list}`,
  largeChange: 'گۆڕانێکی سەرووی 15٪ — پشتڕاستی بکەرەوە؛ لەوانەیە چوونەژوورەوەی نوێ داوا بکرێت',
  savePc: 'پاشەکەوتکردنی زانیاری — نرخە نوێیەکان دوای نوێکردنەوەی 4 جێبەجێ دەکرێن',
  saveConfirmApply: 'پشتڕاستکردنەوەی کڕین و جێبەجێکردنی نرخەکان',
  partial: (n) => `کڕینەکە پاشەکەوت کرا. نرخی ${n} بەرهەم نوێ نەکرایەوە — پێیاندا بچۆرەوە`,
  retry: 'دووبارە هەوڵبدەرەوە',
  appliedNotice: 'تێچووی کڕینەکە و کەمترین قازانجی مەبەست لە زانیارییەکانی نرخداناندا پاشەکەوت کران',
  notApplied: 'تێچووی ئەم کڕینە هێشتا لە نرخداناندا جێبەجێ نەکراوە',
  applyNow: 'ئێستا جێبەجێی بکە',
  cancelledSource: 'تێچووەکە لە کڕینێکی هەڵوەشێنراوەوە هاتووە — پێیدا بچۆرەوە',
  sectionDirect: 'فرۆشتنی ڕاستەوخۆ',
  extraLabel: 'زیادەی فرۆشتنی ڕاستەوخۆ (د.ع)',
  extraHint: 'زیادەی فرۆشتنی ڕاستەوخۆ دەخرێتە سەر نرخی بنەڕەتیی پێشداواکاری بۆ نرخی فرۆشتنی ڕاستەوخۆ، بۆ هەموو مۆدێلەکانی بەرهەمەکە کە زیادەی فرۆشتنی ڕاستەوخۆی تایبەتیان نییە. 0 قبوڵە.',
  noExtra: 'بێ زیادەی فرۆشتنی ڕاستەوخۆ (0)',
  todayExtra: (x) => `زیادەی فرۆشتنی ڕاستەوخۆی ئێستا: ${x}`,
  extraNeeded: 'بۆ نرخدانانی فرۆشتنی ڕاستەوخۆ، زیادەی فرۆشتنی ڕاستەوخۆ لە سەرەوە بنووسە (0 قبوڵە). بەبێ ئەوە تەنها زانیارییەکان پاشەکەوت دەکرێن.',
  extraInvalid: 'زیادەی فرۆشتنی ڕاستەوخۆ بە دیناری تەواو بنووسە، چەندجارەیەکی 1,000 (0 قبوڵە)',
  preorderFollow: (n) => `نرخەکانی پێشداواکاریش لەگەڵیدا دەگۆڕێن چونکە لە هەمان تێچوونەوەن (${n})`,
  preorderWhy: (route) => `پێشداواکاری دەردەکەوێت چونکە بەرهەمەکە بۆ پێشداواکاری پێشکەش کراوە — ${route}. بۆ ڕاگرتنی، پێشداواکاری لە ڕێکخستنەکانی بەرهەمەکەدا بکوژێنەوە.`,
  preorderOnly: 'ئەم بەرهەمە فرۆشتنی ڕاستەوخۆی چالاک نییە؛ ئەم کڕینی کۆگایە نرخەکانی ناگۆڕێت.',
  colBeforeExtra: 'نرخ پێش زیادەی فرۆشتنی ڕاستەوخۆ',
  directRoute: (route) => `نرخی فرۆشتنی ڕاستەوخۆ لەسەر ئەمە دادەنرێت: ${route} (لەم کڕینەوە پێشنیار کراوە)`,
  cellDirectCustomer: 'نرخی فرۆشتنی ڕاستەوخۆ بۆ کڕیار',
  cellDirectSuggested: 'نرخی پێشنیارکراوی فرۆشتنی ڕاستەوخۆ',
  cellPreorderBase: 'نرخ پێش زیادەی فرۆشتنی ڕاستەوخۆ',
  directCaption: (pre, x) => `نرخی بنەڕەت ${pre} + زیادەی فرۆشتنی ڕاستەوخۆ ${x}`,
  extraInReview: 'زیادەی فرۆشتنی ڕاستەوخۆ لە پێداچوونەوەدا بنووسە بۆ نرخدانانی فرۆشتنی ڕاستەوخۆ',
};

export const PROCUREMENT_PRICING_STRINGS: Readonly<Record<Language, ProcurementPricingStrings>> = { ar, en, ckb };

export const procurementPricingStrings = (lang: Language): ProcurementPricingStrings => PROCUREMENT_PRICING_STRINGS[lang] ?? ar;

/** A readiness code's sentence (the contracts' own words), or the code itself when no contract owns it. */
export function issueText(code: string, lang: Language): string {
  return isPricingIssueCode(code) ? pricingIssueLabel(code, lang) : code;
}

/** The shipping profile's name, as the pricing vocabulary says it. */
export const profileName = (profile: string | null, lang: Language): string =>
  profile && profile in PRICING_PROFILE_LABELS ? PRICING_PROFILE_LABELS[profile as keyof typeof PRICING_PROFILE_LABELS][lang] : '—';

/** A sale channel's name. */
export const channelName = (channel: string, lang: Language): string =>
  channel in PRICING_CHANNEL_LABELS ? PRICING_CHANNEL_LABELS[channel as keyof typeof PRICING_CHANNEL_LABELS][lang] : channel;
