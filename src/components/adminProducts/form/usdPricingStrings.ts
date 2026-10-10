/**
 * «التسعير بالدولار والشحن» IN THE PRODUCT FORM — EVERY WORD, IN ARABIC,
 * ENGLISH AND SORANI (owner brief 2026-10-09; docs/DECISIONS.md row 183: a
 * `ckb` slot never carries the Arabic). The 4-cell bar, its «تفاصيل» and the
 * six-figure table keep the procurement card's words (src/components/
 * adminOperations/procurementPricingStrings.ts); these are the form's own
 * fields and notes — section ٣ «الأسعار», each model in section ٥ «الخيارات
 * والألوان», and section ٨ «المعاينة والحفظ».
 * ckb uses the pricing terms: shipping «ناردن», product «بەرهەم» (never
 * «گواستنەوە» or «کاڵا»: tests/procurementPricingStrings.test.ts).
 *
 * Pure: no React, no request.
 */
import type { Language } from '../../../translations';

type Fill = (v: string) => string;
type Fill2 = (a: string, b: string) => string;
type Fill3 = (a: string, b: string, c: string) => string;

export interface UsdPricingFormStrings {
  formTitle: string;
  formIntro: string;
  productLevel: string;
  supplierCost: string;
  supplierCostIqd: string;
  supplierCurrency: string;
  currencyIqd: string;
  iqdHint: string;
  iqdWillConvert: Fill2;
  convertedOn: Fill3;
  reconvert: Fill;
  iqdInvalid: string;
  route: string;
  routeNone: string;
  weightKg: string;
  boxWidth: string;
  boxDepth: string;
  boxHeight: string;
  measureFromForm: string;
  boxIncomplete: string;
  cbmComputed: Fill;
  manualCbm: string;
  manualCbmHint: string;
  measureAdopted: string;
  measureWillAdopt: string;
  measureDiffers: Fill2;
  measurePricingOnly: Fill;
  adoptMeasure: string;
  measureInherits: string;
  additional: string;
  minProfit: string;
  minProfitHint: string;
  extra: string;
  extraHint: string;
  inheritPlaceholder: Fill;
  save: string;
  saveHint: string;
  saved: string;
  savedWithProduct: string;
  pricingNotSaved: Fill;
  reviewConversion: string;
  unsaved: string;
  discard: string;
  summaryAfterFirstSave: string;
  edit: string;
  modelsSummary: Fill2;
  pricesLater: string;
  decimalInvalid: string;
  extraInvalid: string;
  pricingWeightWins: string;
  loading: string;
  retry: string;
  storePrice: string;
  storePriceEngine: string;
  storePriceManual: string;
  legacyCost: string;
  legacyCostTip: string;
  modelTitle: string;
  customerPrice: Fill;
  directPrice: Fill;
  modelBlocked: string;
  coloursFollow: string;
  /** FX-7 (with the SKU rung): each colour's own pricing lives in its card. */
  coloursOwn: string;
  colourTitle: string;
  colourInherits: string;
  colourSavedLater: string;
  skuTitle: string;
  skuInherits: string;
  perSkuNote: string;
  modelSavedLater: string;
  previewTitle: string;
  previewNote: string;
  previewIncludesDrafts: string;
  previewEmpty: string;
  // ---- the save is never silent (owner report 2026-10-10) ----
  /** A decimal written with a thousands separator or a comma the server cannot read. */
  decimalSeparator: string;
  decimalTooLong: string;
  /** A stored amount whose currency was cleared: the server needs the currency of every amount. */
  currencyNeeded: string;
  /** Dinars typed while no dollar rate is approved: they cannot convert. */
  iqdNeedsRate: string;
  currencyIqdNoRate: string;
  ratesNoUsd: string;
  ratesDerivedStale: string;
  centralMissing: Fill;
  openPricingTab: string;
  routeFirst: string;
  legacyCostStays: string;
  savedDataReady: string;
  readyWaiting: string;
  reviewAndAdopt: string;
  heldNotSaved: string;
  heldCancelled: string;
  savedLater: string;
  later: string;
  sheetDataSaved: string;
  sheetNothingSaved: string;
  signInAgain: string;
  pricingUnsaved: string;
  leaveUnsaved: string;
  show: string;
  saveBlocked: Fill;
  notSavedAlone: Fill;
  boxLabel: string;
  converted: Fill3;
  // ---- after the verifiers' round (2026-10-10) ----
  /** The product form's own chrome (the bar and section ٨'s summary): saved. */
  savedShort: string;
  /** An engine product's held save after «نشر»/«مسودة»: the product's own edits were saved a moment ago. */
  sheetProductSaved: string;
  /** A ready review's confirm refused: the data is stored, the price was not adopted. */
  adoptNotDone: Fill;
  /** After adoption: the store price follows this data (instead of «pricesLater»). */
  pricesEngine: string;
  /** Under the dinar field before the preview's conversion is in: the rate a save converts at. */
  iqdAtRate: Fill;
  /** Dinars not converted at a rate the owner had not seen (FX plan §12): the new conversion, and save again. */
  rateUnseen: Fill3;
  /** The rest of a save was stored; the typed dinars were not (their reason follows). */
  restSavedWithheld: Fill;
  /** The box or weight a pricing save carried is stored for pricing; the product's own measures wait for «نشر». */
  measuresForPricingOnly: string;
  /** Leaving with package measures not saved with the product. */
  leaveMeasures: string;
}

const ar: UsdPricingFormStrings = {
  formTitle: 'التسعير بالدولار والشحن',
  formIntro: 'تكلفة المورد بعملته، ومسار الشحن والوزن أو الحجم، والتكاليف الإضافية، والحد الأدنى للربح بالدولار. يُحسب السعر النهائي للزبون من هذه القيم.',
  productLevel: 'المنتج (كل الموديلات)',
  supplierCost: 'تكلفة المورد للقطعة',
  supplierCostIqd: 'تكلفة المورد بالدينار',
  supplierCurrency: 'عملة المورد',
  currencyIqd: 'دينار (يُحوَّل مرة واحدة إلى USD)',
  iqdHint: 'دنانير كاملة؛ تُحوَّل إلى الدولار مرة واحدة عند الحفظ بسعر الدولار المعتمد، ولا تتغير بعدها مع السعر',
  iqdWillConvert: (usd, rate) => `يُحفظ $${usd} بسعر ${rate} د.ع للدولار`,
  convertedOn: (amount, rate, date) => `${amount} د.ع حُوّلت مرة واحدة بسعر ${rate} في ${date}`,
  reconvert: (rate) => `حوّل مرة أخرى بسعر اليوم ${rate}`,
  iqdInvalid: 'أدخل مبلغًا صحيحًا بالدينار أكبر من صفر',
  route: 'مسار الشحن الأساسي',
  routeNone: '— بلا مسار —',
  weightKg: 'الوزن مع التغليف (كغم)',
  boxWidth: 'عرض الصندوق (سم)',
  boxDepth: 'عمق الصندوق (سم)',
  boxHeight: 'ارتفاع الصندوق (سم)',
  measureFromForm: 'الحقل نفسه في «الأبعاد والوزن»: يُحفظ مع المنتج، ويُعتمد للتسعير عند الحفظ',
  boxIncomplete: 'أكمل أبعاد الصندوق الثلاثة ليُحسب الحجم',
  cbmComputed: (cbm) => `الحجم المحسوب من الصندوق: ${cbm} CBM`,
  manualCbm: 'حجم يدوي (CBM) — اختياري',
  manualCbmHint: 'يتقدّم على الحجم المحسوب من الصندوق؛ اتركه فارغًا ليُحسب من الأبعاد',
  measureAdopted: 'معتمد للتسعير',
  measureWillAdopt: 'يُعتمد للتسعير عند الحفظ',
  measureDiffers: (pricing, form) => `التسعير يستعمل ${pricing} المحفوظة للتسعير، وقياس الصندوق في المنتج ${form}`,
  measurePricingOnly: (pricing) => `التسعير يستعمل ${pricing} المحفوظة للتسعير`,
  adoptMeasure: 'اعتمد قياس الصندوق للتسعير',
  measureInherits: 'يرث قياس المنتج',
  additional: 'تكاليف إضافية للقطعة (د.ع)',
  minProfit: 'الحد الأدنى للربح (USD)',
  minProfitHint: 'أقل ربح بالدولار فوق التكلفة الحالية؛ اتركه فارغًا ليرث',
  extra: 'زيادة البيع المباشر (د.ع)',
  extraHint: 'بالدينار ومن مضاعفات 1,000؛ تُضاف للبيع المباشر بعد التقريب',
  inheritPlaceholder: (v) => `يرث: ${v}`,
  save: 'حفظ التسعير بالدولار',
  saveHint: 'يُحفظ أيضًا مع زر «نشر» أو «مسودة» أسفل الصفحة',
  saved: 'حُفظت بيانات التسعير',
  savedWithProduct: 'حُفظ التسعير بالدولار مع المنتج',
  pricingNotSaved: (m) => `حُفظ المنتج، ولم يُحفظ التسعير بالدولار: ${m}`,
  reviewConversion: 'راجع تحويل الدينار في المعاينة، ثم احفظ التسعير',
  unsaved: 'تغييرات غير محفوظة',
  discard: 'تجاهل التغييرات',
  summaryAfterFirstSave: 'يظهر الملخص بعد الحفظ الأول للمنتج؛ تُحفظ هذه القيم معه',
  edit: 'تعديل',
  modelsSummary: (ok, all) => `${ok} من ${all} موديلات محسوبة السعر — الملخص لكل موديل في «الخيارات والألوان»`,
  pricesLater: 'هذه بيانات التسعير فقط؛ يبقى سعر المتجر كما هو حتى يُعتمد السعر الجديد',
  decimalInvalid: 'أدخل رقمًا أكبر من صفر',
  extraInvalid: 'أدخل مبلغًا بالدينار من مضاعفات 1,000',
  pricingWeightWins: 'وزن التسعير المحفوظ يُستعمل بدل هذا الوزن',
  loading: 'جارٍ تحميل التسعير…',
  retry: 'إعادة المحاولة',
  storePrice: 'سعر المتجر الحالي',
  storePriceEngine: 'يكتبه محرك التسعير من «التسعير بالدولار والشحن» أدناه؛ لا يُعدَّل يدويًا',
  storePriceManual: 'يبقى السعر يدويًا حتى يُعتمد هذا المنتج في محرك التسعير',
  legacyCost: 'التكلفة القديمة (د.ع)',
  legacyCostTip: 'إداري فقط. تُستعمل في الأرباح للمنتجات التي لا دفعات شراء لها؛ لا يقرؤها التسعير بالدولار.',
  modelTitle: 'التسعير بالدولار لهذا الموديل',
  customerPrice: (p) => `سعر الزبون المحسوب: ${p}`,
  directPrice: (p) => `البيع المباشر: ${p}`,
  modelBlocked: 'لم يُحسب السعر بعد — افتح «تعديل»',
  coloursFollow: 'ألوان هذا الموديل تتبع تسعيره حتى يتوفر تسعير كل لون على حدة',
  coloursOwn: 'لكل لون تسعيره في بطاقته ضمن «الألوان» — الحقل الفارغ هناك يرث قيمة هذا الموديل',
  colourTitle: 'التسعير بالدولار لهذا اللون',
  colourInherits: 'فارغ = يرث من موديله ثم من المنتج؛ أي قيمة هنا تخص هذا اللون وحده',
  colourSavedLater: 'لون جديد: يُحفظ تسعيره بعد حفظ المنتج، ويظهر سعره بعدها',
  skuTitle: 'التسعير بالدولار لهذه النسخة',
  skuInherits: 'فارغ = يرث من لونه ثم موديله ثم المنتج',
  perSkuNote: 'يُسعَّر هذا المنتج لكل لون ونسخة: صف لكل نسخة وطريقة بيع',
  modelSavedLater: 'موديل جديد: يُحفظ تسعيره بعد حفظ المنتج، ويظهر ملخصه بعدها',
  previewTitle: 'الأسعار الجديدة لكل موديل وطريقة بيع',
  previewNote: 'معاينة فقط: لا تُكتب أسعار الزبون في هذه المرحلة، ويبقى سعر المتجر كما هو',
  previewIncludesDrafts: 'تشمل تغييرات التسعير غير المحفوظة',
  previewEmpty: 'لا يوجد موديل معروض للبيع الآن',
  decimalSeparator: 'اكتب الكسر بنقطة (مثل 899.5)، ولا تفصل الآلاف بفاصلة',
  decimalTooLong: 'الرقم أطول من المسموح به في هذا الحقل',
  currencyNeeded: 'اختر عملة المورد لهذا المبلغ',
  iqdNeedsRate: 'لا يوجد سعر دولار معتمد بعد، فلا يمكن تحويل الدينار. اعتمد سعر الصرف من «التسعير والشحن»، أو أدخل التكلفة بعملة المورد (USD أو EUR أو CNY).',
  currencyIqdNoRate: 'دينار — يحتاج سعر دولار معتمد',
  ratesNoUsd: 'لا يوجد سعر دولار معتمد بعد: ما تكتبه هنا يُحفظ بزر «حفظ التسعير بالدولار» أو «نشر» أو «مسودة»، ولا يُحسب سعر جديد حتى تعتمد أسعار الصرف في «التسعير والشحن».',
  ratesDerivedStale: 'أسعار الصرف المشتقة تحتاج تحديثًا في «التسعير والشحن»؛ لا يُحفظ التسعير قبل ذلك.',
  centralMissing: (l) => `ينقص من الإعدادات المركزية: ${l}`,
  openPricingTab: 'افتح «التسعير والشحن»',
  routeFirst: 'اختر «مسار الشحن الأساسي» أولًا لتظهر حقول الوزن أو أبعاد الصندوق',
  legacyCostStays: '«التكلفة القديمة» لا يغيّرها هذا القسم؛ بعد اعتماد السعر يحسب المحرك التكلفة من هذه البيانات',
  savedDataReady: 'حُفظت بيانات التسعير، وهي مكتملة: راجع السعر الجديد واعتمده. يبقى سعر المتجر كما هو حتى تعتمده.',
  readyWaiting: 'البيانات مكتملة — السعر الجديد بانتظار اعتمادك',
  reviewAndAdopt: 'راجع السعر الجديد واعتمده',
  heldNotSaved: 'لم يُحفظ التسعير بعد: الأسعار الجديدة تنتظر مراجعتك في النافذة المفتوحة',
  heldCancelled: 'لم يُحفظ التسعير: أُلغيت مراجعة الأسعار الجديدة، وما كتبته باقٍ في الحقول',
  savedLater: 'بيانات التسعير محفوظة؛ يبقى سعر المتجر كما هو حتى تعتمد السعر الجديد',
  later: 'لاحقًا — البيانات محفوظة',
  sheetDataSaved: 'بيانات التسعير محفوظة مسبقًا. الحفظ هنا لا يحفظها من جديد: يكتب الأسعار أدناه في المتجر فقط، و«لاحقًا» يُبقي سعر المتجر كما هو.',
  sheetNothingSaved: 'لم يُحفظ شيء بعد: هذا المنتج مسعّر تلقائيًا، فتُحفظ تغييراتك مع أسعاره الجديدة معًا.',
  signInAgain: 'سجّل الدخول مجددًا (البيانات محفوظة)',
  pricingUnsaved: 'تغييرات تسعير غير محفوظة',
  leaveUnsaved: 'في «التسعير بالدولار والشحن» تغييرات لم تُحفظ وستضيع إن خرجت الآن. هل تخرج؟',
  show: 'اعرض',
  saveBlocked: (w) => `لا يُحفظ قبل تصحيح: ${w}`,
  notSavedAlone: (m) => `لم يُحفظ التسعير بالدولار: ${m}`,
  boxLabel: 'أبعاد الصندوق',
  converted: (a, u, r) => `حُوِّل ${a} د.ع إلى $${u} بسعر ${r}`,
  savedShort: 'محفوظ',
  sheetProductSaved: 'حُفظ المنتج نفسه، أما تغييرات التسعير فلم تُحفظ بعد: هذا المنتج مسعّر تلقائيًا، فتُحفظ مع أسعاره الجديدة معًا عند التأكيد أدناه.',
  adoptNotDone: (m) => `بيانات التسعير محفوظة، ولم يُعتمد السعر الجديد: ${m}`,
  pricesEngine: 'هذا المنتج مسعّر تلقائيًا: يُكتب سعر المتجر من هذه البيانات، وتُعرض عليك الأسعار الجديدة قبل كل حفظ.',
  iqdAtRate: (rate) => `يُحوَّل عند الحفظ بسعر الدولار المعتمد: ${rate} د.ع للدولار`,
  rateUnseen: (a, u, r) => `سعر الدولار المعتمد الآن ${r} د.ع: ${a} د.ع تصبح $${u}. لم تُحفظ تكلفة المورد بالدينار لأنك لم ترَ هذا السعر قبل الحفظ؛ احفظ مرة أخرى لتُحفظ به.`,
  restSavedWithheld: (m) => `حُفظت بقية بيانات التسعير، ولم تُحفظ تكلفة المورد بالدينار: ${m}`,
  measuresForPricingOnly: 'حُفظ قياس الصندوق أو الوزن للتسعير؛ أما قياسات المنتج نفسه في «الأبعاد والوزن» فتُحفظ بزر «نشر» أو «مسودة».',
  leaveMeasures: 'قياسات الصندوق أو الوزن التي عدّلتها لم تُحفظ مع المنتج بعد، وستضيع إن خرجت الآن. هل تخرج؟',
};

const en: UsdPricingFormStrings = {
  formTitle: 'USD pricing and shipping',
  formIntro: 'The supplier cost in its currency, the shipping route and weight or volume, additional costs and the minimum profit in USD. The final customer price is computed from these values.',
  productLevel: 'Product (every model)',
  supplierCost: 'Supplier cost per piece',
  supplierCostIqd: 'Supplier cost in IQD',
  supplierCurrency: 'Supplier currency',
  currencyIqd: 'IQD (converted once to USD)',
  iqdHint: 'Whole dinars; converted to USD once when saved, at the effective dollar rate, and not changed by later rate moves',
  iqdWillConvert: (usd, rate) => `Saved as $${usd} at ${rate} IQD per dollar`,
  convertedOn: (amount, rate, date) => `${amount} IQD converted once at ${rate} on ${date}`,
  reconvert: (rate) => `Convert again at today’s rate ${rate}`,
  iqdInvalid: 'Enter a whole amount in dinars above zero',
  route: 'Base shipping route',
  routeNone: '— No route —',
  weightKg: 'Packed weight (kg)',
  boxWidth: 'Box width (cm)',
  boxDepth: 'Box depth (cm)',
  boxHeight: 'Box height (cm)',
  measureFromForm: 'The same field as in “Dimensions & weight”: saved with the product, and adopted for pricing on save',
  boxIncomplete: 'Fill in all three box dimensions to compute the volume',
  cbmComputed: (cbm) => `Volume from the box: ${cbm} CBM`,
  manualCbm: 'Manual volume (CBM) — optional',
  manualCbmHint: 'Wins over the volume from the box; leave it empty to use the dimensions',
  measureAdopted: 'Adopted for pricing',
  measureWillAdopt: 'Adopted for pricing when saved',
  measureDiffers: (pricing, form) => `Pricing uses the stored ${pricing}; the product’s box says ${form}`,
  measurePricingOnly: (pricing) => `Pricing uses the stored ${pricing}`,
  adoptMeasure: 'Use the box measurement for pricing',
  measureInherits: 'Inherits the product’s measurement',
  additional: 'Additional costs per piece (IQD)',
  minProfit: 'Minimum profit (USD)',
  minProfitHint: 'The least profit in USD above today’s cost; leave it empty to inherit',
  extra: 'Direct Sale Extra (IQD)',
  extraHint: 'In dinars, a multiple of 1,000; added to direct sale after rounding',
  inheritPlaceholder: (v) => `Inherits: ${v}`,
  save: 'Save USD pricing',
  saveHint: 'Also saved with “Publish” or “Draft” at the bottom of the page',
  saved: 'Pricing data saved',
  savedWithProduct: 'USD pricing saved with the product',
  pricingNotSaved: (m) => `The product was saved, but the USD pricing was not: ${m}`,
  reviewConversion: 'Check the dinar conversion in the preview, then save the pricing',
  unsaved: 'Unsaved changes',
  discard: 'Discard changes',
  summaryAfterFirstSave: 'The summary appears after the product’s first save; these values are saved with it',
  edit: 'Edit',
  modelsSummary: (ok, all) => `${ok} of ${all} models priced — each model’s summary is under “Options & colours”`,
  pricesLater: 'This is pricing data only; the store price stays as it is until the new price is applied',
  decimalInvalid: 'Enter a number above zero',
  extraInvalid: 'Enter an amount in dinars that is a multiple of 1,000',
  pricingWeightWins: 'The stored pricing weight is used instead of this weight',
  loading: 'Loading pricing…',
  retry: 'Retry',
  storePrice: 'Current store price',
  storePriceEngine: 'Written by the pricing engine from “USD pricing and shipping” below; not edited by hand',
  storePriceManual: 'The price stays manual until this product is adopted by the pricing engine',
  legacyCost: 'Legacy cost (IQD)',
  legacyCostTip: 'Admin only. Used by profit for products with no purchase batches; the USD pricing does not read it.',
  modelTitle: 'USD pricing for this model',
  customerPrice: (p) => `Computed customer price: ${p}`,
  directPrice: (p) => `Direct sale: ${p}`,
  modelBlocked: 'Not priced yet — open “Edit”',
  coloursFollow: 'This model’s colours follow its pricing until per-colour pricing is available',
  coloursOwn: 'Each colour has its own pricing in its card under “Colours” — an empty field there takes this model’s value',
  colourTitle: 'USD pricing for this colour',
  colourInherits: 'Empty = its model’s value, then the product’s; a value here is this colour’s alone',
  colourSavedLater: 'A new colour: its pricing is saved after the product is saved, and its price appears then',
  skuTitle: 'USD pricing for this variant',
  skuInherits: 'Empty = its colour’s value, then its model’s, then the product’s',
  perSkuNote: 'This product is priced per colour and variant: one row per variant and sale channel',
  modelSavedLater: 'A new model: its pricing is saved after the product is saved, and its summary appears then',
  previewTitle: 'New prices per model and sale channel',
  previewNote: 'Preview only: customer prices are not written at this stage, and the store price stays as it is',
  previewIncludesDrafts: 'Includes unsaved pricing changes',
  previewEmpty: 'No model is on sale now',
  decimalSeparator: 'Write decimals with a point (e.g. 899.5) and no thousands separators',
  decimalTooLong: 'The number is longer than this field allows',
  currencyNeeded: 'Choose the supplier currency for this amount',
  iqdNeedsRate: 'There is no approved dollar rate yet, so dinars cannot be converted. Approve the rate in «Pricing & shipping», or enter the cost in the supplier’s currency (USD, EUR or CNY).',
  currencyIqdNoRate: 'IQD — needs an approved dollar rate',
  ratesNoUsd: 'No approved dollar rate yet: what you enter here is saved with «Save USD pricing», «Publish» or «Draft», and no new price is computed until you approve the exchange rates in «Pricing & shipping».',
  ratesDerivedStale: 'The derived exchange rates need refreshing in «Pricing & shipping»; pricing cannot be saved until then.',
  centralMissing: (l) => `Missing from the central settings: ${l}`,
  openPricingTab: 'Open «Pricing & shipping»',
  routeFirst: 'Choose the «Base shipping route» first to show the weight or box fields',
  legacyCostStays: '«Legacy cost» is not changed by this section; once the price is adopted the engine computes the cost from this data',
  savedDataReady: 'Pricing data saved, and it is complete: review and adopt the new price. The store price stays as it is until you do.',
  readyWaiting: 'Data complete — the new price awaits your approval',
  reviewAndAdopt: 'Review and adopt the new price',
  heldNotSaved: 'Pricing not saved yet: the new prices await your review in the open window',
  heldCancelled: 'Pricing not saved: the price review was cancelled; what you typed is still in the fields',
  savedLater: 'The pricing data is saved; the store price stays as it is until you adopt the new price',
  later: 'Later — the data is saved',
  sheetDataSaved: 'The pricing data is already saved. Saving here does not save it again: it only writes the prices below to the store, and «Later» keeps the store price as it is.',
  sheetNothingSaved: 'Nothing is saved yet: this product is priced automatically, so your changes are saved together with its new prices.',
  signInAgain: 'Sign in again (the data is saved)',
  pricingUnsaved: 'Unsaved pricing changes',
  leaveUnsaved: '«USD pricing and shipping» has unsaved changes that will be lost if you leave now. Leave anyway?',
  show: 'Show',
  saveBlocked: (w) => `Cannot be saved until you fix: ${w}`,
  notSavedAlone: (m) => `USD pricing not saved: ${m}`,
  boxLabel: 'Box dimensions',
  converted: (a, u, r) => `${a} IQD converted to $${u} at ${r}`,
  savedShort: 'Saved',
  sheetProductSaved: 'The product itself is saved, but the pricing changes are not saved yet: this product is priced automatically, so they are saved together with its new prices when you confirm below.',
  adoptNotDone: (m) => `The pricing data is saved, but the new price was not adopted: ${m}`,
  pricesEngine: 'This product is priced automatically: its store price is written from this data, and the new prices are shown to you before every save.',
  iqdAtRate: (rate) => `Converted when saved at the approved dollar rate: ${rate} IQD per dollar`,
  rateUnseen: (a, u, r) => `The approved dollar rate is now ${r} IQD: ${a} IQD becomes $${u}. The supplier cost in dinars was not saved because you had not seen this rate before saving; save again to store it at this rate.`,
  restSavedWithheld: (m) => `The rest of the pricing data is saved; the supplier cost in dinars is not: ${m}`,
  measuresForPricingOnly: 'The box or weight is saved for pricing; the product’s own measurements in “Dimensions & weight” are saved with “Publish” or “Draft”.',
  leaveMeasures: 'The box or weight you changed is not saved with the product yet and will be lost if you leave now. Leave anyway?',
};

const ckb: UsdPricingFormStrings = {
  formTitle: 'نرخدانان بە دۆلار و ناردن',
  formIntro: 'تێچووی دابینکەر بە دراوەکەی خۆی، ڕێگای ناردن و کێش یان قەبارە، تێچووە زیادەکان و کەمترین قازانجی مەبەست بە دۆلار. نرخی کۆتایی بۆ کڕیار لەم بەهایانە هەژمار دەکرێت.',
  productLevel: 'بەرهەم (هەموو مۆدێلەکان)',
  supplierCost: 'تێچووی دابینکەر بۆ هەر پارچەیەک',
  supplierCostIqd: 'تێچووی دابینکەر بە دینار',
  supplierCurrency: 'دراوی دابینکەر',
  currencyIqd: 'دینار (یەکجار دەگۆڕدرێت بۆ USD)',
  iqdHint: 'دیناری تەواو؛ لە کاتی پاشەکەوتکردندا یەکجار بە نرخی کارپێکراوی دۆلار دەگۆڕدرێت بۆ دۆلار، و دواتر بە گۆڕانی نرخ ناگۆڕێت',
  iqdWillConvert: (usd, rate) => `وەک $${usd} پاشەکەوت دەکرێت، بە نرخی ${rate} د.ع بۆ هەر دۆلارێک`,
  convertedOn: (amount, rate, date) => `${amount} د.ع یەکجار بە نرخی ${rate} لە ${date} گۆڕدرا`,
  reconvert: (rate) => `دووبارە بە نرخی ئەمڕۆ ${rate} بیگۆڕە`,
  iqdInvalid: 'بڕێکی تەواو بە دینار لە سەرووی سفر بنووسە',
  route: 'ڕێگای بنەڕەتیی ناردن',
  routeNone: '— بێ ڕێگا —',
  weightKg: 'کێش لەگەڵ پاکێج (کگم)',
  boxWidth: 'پانیی سندوقەکە (سم)',
  boxDepth: 'قووڵیی سندوقەکە (سم)',
  boxHeight: 'بەرزیی سندوقەکە (سم)',
  measureFromForm: 'هەمان خانەی «پێوانەکان و کێش»: لەگەڵ بەرهەمەکە پاشەکەوت دەکرێت، و لە کاتی پاشەکەوتکردندا بۆ نرخدانان پەسەند دەکرێت',
  boxIncomplete: 'هەر سێ پێوانەی سندوقەکە پڕ بکەرەوە بۆ ئەوەی قەبارە هەژمار بکرێت',
  cbmComputed: (cbm) => `قەبارە لە سندوقەکەوە: ${cbm} CBM`,
  manualCbm: 'قەبارەی دەستی (CBM) — ئارەزوومەندانە',
  manualCbmHint: 'لە قەبارەی سندوقەکە پێشتر دێت؛ بەتاڵی بهێڵەوە بۆ ئەوەی لە پێوانەکان هەژمار بکرێت',
  measureAdopted: 'بۆ نرخدانان پەسەندکراوە',
  measureWillAdopt: 'لە کاتی پاشەکەوتکردندا بۆ نرخدانان پەسەند دەکرێت',
  measureDiffers: (pricing, form) => `نرخدانان ${pricing}ی پاشەکەوتکراو بەکاردەهێنێت، و پێوانەی سندوقی بەرهەمەکە ${form}ە`,
  measurePricingOnly: (pricing) => `نرخدانان ${pricing}ی پاشەکەوتکراو بەکاردەهێنێت`,
  adoptMeasure: 'پێوانەی سندوقەکە بۆ نرخدانان بەکاربهێنە',
  measureInherits: 'پێوانەی بەرهەمەکە وەردەگرێت',
  additional: 'تێچووە زیادەکان بۆ هەر پارچەیەک (د.ع)',
  minProfit: 'کەمترین قازانجی مەبەست (USD)',
  minProfitHint: 'کەمترین قازانج بە دۆلار لە سەرووی تێچووی ئێستا؛ بەتاڵی بهێڵەوە بۆ ئەوەی لە ئاستی سەرەوە وەربگیرێت',
  extra: 'زیادەی فرۆشتنی ڕاستەوخۆ (د.ع)',
  extraHint: 'بە دینار و چەندجارەی 1,000؛ دوای خڕکردنەوە بۆ فرۆشتنی ڕاستەوخۆ زیاد دەکرێت',
  inheritPlaceholder: (v) => `وەرگیراو: ${v}`,
  save: 'پاشەکەوتکردنی نرخدانان بە دۆلار',
  saveHint: 'لەگەڵ دوگمەی «بڵاوکردنەوە» یان «ڕەشنووس»ی خوارەوەی پەڕەکەش پاشەکەوت دەکرێت',
  saved: 'زانیارییەکانی نرخدانان پاشەکەوت کران',
  savedWithProduct: 'نرخدانان بە دۆلار لەگەڵ بەرهەمەکە پاشەکەوت کرا',
  pricingNotSaved: (m) => `بەرهەمەکە پاشەکەوت کرا، بەڵام نرخدانان بە دۆلار پاشەکەوت نەکرا: ${m}`,
  reviewConversion: 'گۆڕینی دینار لە پێشبینینەکەدا بپشکنە، پاشان نرخدانانەکە پاشەکەوت بکە',
  unsaved: 'گۆڕانکاریی پاشەکەوتنەکراو',
  discard: 'وازهێنان لە گۆڕانکارییەکان',
  summaryAfterFirstSave: 'پوختەکە دوای یەکەم پاشەکەوتکردنی بەرهەمەکە دەردەکەوێت؛ ئەم بەهایانە لەگەڵیدا پاشەکەوت دەکرێن',
  edit: 'دەستکاری',
  modelsSummary: (ok, all) => `${ok} لە ${all} مۆدێل نرخیان هەژمار کراوە — پوختەی هەر مۆدێلێک لە «هەڵبژاردەکان و ڕەنگەکان»`,
  pricesLater: 'ئەمە تەنها زانیاریی نرخدانانە؛ نرخی فرۆشگا وەک خۆی دەمێنێتەوە تا نرخە نوێیەکە جێبەجێ دەکرێت',
  decimalInvalid: 'ژمارەیەکی سەرووی سفر بنووسە',
  extraInvalid: 'بڕێک بە دینار بنووسە کە چەندجارەی 1,000 بێت',
  pricingWeightWins: 'کێشی نرخدانانی پاشەکەوتکراو لە جیاتی ئەم کێشە بەکاردێت',
  loading: 'نرخدانان بار دەکرێت…',
  retry: 'دووبارە هەوڵبدەرەوە',
  storePrice: 'نرخی ئێستای فرۆشگا',
  storePriceEngine: 'بزوێنەری نرخدانان لە «نرخدانان بە دۆلار و ناردن»ی خوارەوە دەینووسێت؛ بە دەست دەستکاری ناکرێت',
  storePriceManual: 'نرخەکە دەستی دەمێنێتەوە تا ئەم بەرهەمە لە بزوێنەری نرخداناندا پەسەند دەکرێت',
  legacyCost: 'تێچووی کۆن (د.ع)',
  legacyCostTip: 'تەنها بۆ بەڕێوەبەر. لە قازانجدا بۆ ئەو بەرهەمانە بەکاردێت کە هیچ وەجبەیەکی کڕینیان نییە؛ نرخدانان بە دۆلار نایخوێنێتەوە.',
  modelTitle: 'نرخدانان بە دۆلار بۆ ئەم مۆدێلە',
  customerPrice: (p) => `نرخی هەژمارکراوی کڕیار: ${p}`,
  directPrice: (p) => `فرۆشتنی ڕاستەوخۆ: ${p}`,
  modelBlocked: 'هێشتا نرخ هەژمار نەکراوە — «دەستکاری» بکەرەوە',
  coloursFollow: 'ڕەنگەکانی ئەم مۆدێلە نرخدانانەکەی پەیڕەو دەکەن تا نرخدانانی هەر ڕەنگێک بە جیا بەردەست دەبێت',
  coloursOwn: 'هەر ڕەنگێک نرخدانانی خۆی لە کارتەکەیدا لە ژێر «ڕەنگەکان» هەیە — خانەی بەتاڵ لەوێ بەهای ئەم مۆدێلە وەردەگرێت',
  colourTitle: 'نرخدانان بە دۆلار بۆ ئەم ڕەنگە',
  colourInherits: 'بەتاڵ = بەهای مۆدێلەکەی، پاشان بەهای بەرهەمەکە؛ هەر بەهایەک لێرە تەنها هی ئەم ڕەنگەیە',
  colourSavedLater: 'ڕەنگی نوێ: نرخدانانەکەی دوای پاشەکەوتکردنی بەرهەمەکە پاشەکەوت دەکرێت و نرخەکەی ئەو کاتە دەردەکەوێت',
  skuTitle: 'نرخدانان بە دۆلار بۆ ئەم جۆرە',
  skuInherits: 'بەتاڵ = بەهای ڕەنگەکەی، پاشان مۆدێلەکەی، پاشان بەرهەمەکە',
  perSkuNote: 'ئەم بەرهەمە بۆ هەر ڕەنگ و جۆرێک نرخی بۆ دادەنرێت: ڕیزێک بۆ هەر جۆر و ڕێگایەکی فرۆشتن',
  modelSavedLater: 'مۆدێلی نوێ: نرخدانانەکەی دوای پاشەکەوتکردنی بەرهەمەکە پاشەکەوت دەکرێت و پوختەکەی ئەو کاتە دەردەکەوێت',
  previewTitle: 'نرخە نوێیەکان بۆ هەر مۆدێل و ڕێگایەکی فرۆشتن',
  previewNote: 'تەنها پێشبینین: لەم قۆناغەدا نرخی کڕیار نانووسرێت و نرخی فرۆشگا وەک خۆی دەمێنێتەوە',
  previewIncludesDrafts: 'گۆڕانکارییە پاشەکەوتنەکراوەکانی نرخدانان لەخۆ دەگرێت',
  previewEmpty: 'ئێستا هیچ مۆدێلێک بۆ فرۆشتن پیشان نادرێت',
  decimalSeparator: 'کەرت بە خاڵ بنووسە (وەک 899.5)، و هەزارەکان بە فاریزە جیا مەکەرەوە',
  decimalTooLong: 'ژمارەکە لەوە درێژترە کە ئەم خانەیە ڕێگەی پێدەدات',
  currencyNeeded: 'دراوی دابینکەر بۆ ئەم بڕە هەڵبژێرە',
  iqdNeedsRate: 'هێشتا نرخێکی پەسەندکراوی دۆلار نییە، بۆیە دینار ناگۆڕدرێت. نرخی ئاڵوگۆڕ لە «نرخدانان و ناردنی بەرهەم» پەسەند بکە، یان تێچووەکە بە دراوی دابینکەر بنووسە (USD یان EUR یان CNY).',
  currencyIqdNoRate: 'دینار — نرخێکی پەسەندکراوی دۆلاری دەوێت',
  ratesNoUsd: 'هێشتا نرخێکی پەسەندکراوی دۆلار نییە: ئەوەی لێرە دەینووسیت بە دوگمەی «پاشەکەوتکردنی نرخدانان بە دۆلار» یان «بڵاوکردنەوە» یان «ڕەشنووس» پاشەکەوت دەکرێت، و هیچ نرخێکی نوێ هەژمار ناکرێت تا نرخەکانی ئاڵوگۆڕ لە «نرخدانان و ناردنی بەرهەم» پەسەند دەکەیت.',
  ratesDerivedStale: 'نرخە دەرهێنراوەکانی ئاڵوگۆڕ پێویستیان بە نوێکردنەوە هەیە لە «نرخدانان و ناردنی بەرهەم»؛ تا ئەو کاتە نرخدانان پاشەکەوت ناکرێت.',
  centralMissing: (l) => `لە ڕێکخستنە ناوەندییەکاندا کەمە: ${l}`,
  openPricingTab: '«نرخدانان و ناردنی بەرهەم» بکەرەوە',
  routeFirst: 'سەرەتا «ڕێگای بنەڕەتیی ناردن» هەڵبژێرە بۆ ئەوەی خانەکانی کێش یان پێوانەی سندوق دەربکەون',
  legacyCostStays: '«تێچووی کۆن» بەم بەشە ناگۆڕێت؛ دوای پەسەندکردنی نرخەکە، بزوێنەرەکە تێچوو لەم زانیارییانە هەژمار دەکات',
  savedDataReady: 'زانیارییەکانی نرخدانان پاشەکەوت کران و تەواون: نرخە نوێیەکە ببینە و پەسەندی بکە. نرخی فرۆشگا وەک خۆی دەمێنێتەوە تا پەسەندی دەکەیت.',
  readyWaiting: 'زانیارییەکان تەواون — نرخە نوێیەکە چاوەڕێی پەسەندکردنی تۆیە',
  reviewAndAdopt: 'نرخە نوێیەکە ببینە و پەسەندی بکە',
  heldNotSaved: 'نرخدانان هێشتا پاشەکەوت نەکراوە: نرخە نوێیەکان لە پەنجەرە کراوەکەدا چاوەڕێی پێداچوونەوەی تۆن',
  heldCancelled: 'نرخدانان پاشەکەوت نەکرا: پێداچوونەوەی نرخە نوێیەکان هەڵوەشێنرایەوە؛ ئەوەی نووسیوتە هێشتا لە خانەکاندایە',
  savedLater: 'زانیارییەکانی نرخدانان پاشەکەوت کراون؛ نرخی فرۆشگا وەک خۆی دەمێنێتەوە تا نرخە نوێیەکە پەسەند دەکەیت',
  later: 'دواتر — زانیارییەکان پاشەکەوت کراون',
  sheetDataSaved: 'زانیارییەکانی نرخدانان پێشتر پاشەکەوت کراون. پاشەکەوتکردن لێرەدا دووبارە پاشەکەوتیان ناکاتەوە: تەنها نرخەکانی خوارەوە لە فرۆشگادا دەنووسێت، و «دواتر» نرخی فرۆشگا وەک خۆی دەهێڵێتەوە.',
  sheetNothingSaved: 'هێشتا هیچ پاشەکەوت نەکراوە: ئەم بەرهەمە بە خۆکاری نرخی بۆ دادەنرێت، بۆیە گۆڕانکارییەکانت لەگەڵ نرخە نوێیەکانیدا پێکەوە پاشەکەوت دەکرێن.',
  signInAgain: 'دووبارە بچۆ ژوورەوە (زانیارییەکان پاشەکەوت کراون)',
  pricingUnsaved: 'گۆڕانکاریی نرخدانانی پاشەکەوتنەکراو',
  leaveUnsaved: '«نرخدانان بە دۆلار و ناردن» گۆڕانکاریی پاشەکەوتنەکراوی هەیە کە ئەگەر ئێستا دەربچیت لەدەست دەچن. هەر دەردەچیت؟',
  show: 'پیشانی بدە',
  saveBlocked: (w) => `پاشەکەوت ناکرێت تا ئەمە ڕاست دەکەیتەوە: ${w}`,
  notSavedAlone: (m) => `نرخدانان بە دۆلار پاشەکەوت نەکرا: ${m}`,
  boxLabel: 'پێوانەکانی سندوق',
  converted: (a, u, r) => `${a} د.ع گۆڕدرا بۆ $${u} بە نرخی ${r}`,
  savedShort: 'پاشەکەوت کراوە',
  sheetProductSaved: 'بەرهەمەکە خۆی پاشەکەوت کرا، بەڵام گۆڕانکارییەکانی نرخدانان هێشتا پاشەکەوت نەکراون: ئەم بەرهەمە بە خۆکاری نرخی بۆ دادەنرێت، بۆیە لەگەڵ نرخە نوێیەکانیدا پێکەوە پاشەکەوت دەکرێن کاتێک لە خوارەوە پشتڕاستی دەکەیتەوە.',
  adoptNotDone: (m) => `زانیارییەکانی نرخدانان پاشەکەوت کراون، بەڵام نرخە نوێیەکە پەسەند نەکرا: ${m}`,
  pricesEngine: 'ئەم بەرهەمە بە خۆکاری نرخی بۆ دادەنرێت: نرخی فرۆشگا لەم زانیارییانەوە دەنووسرێت، و نرخە نوێیەکان پێش هەر پاشەکەوتکردنێک پیشانت دەدرێن.',
  iqdAtRate: (rate) => `لە کاتی پاشەکەوتکردندا بە نرخی پەسەندکراوی دۆلار دەگۆڕدرێت: ${rate} د.ع بۆ هەر دۆلارێک`,
  rateUnseen: (a, u, r) => `نرخی پەسەندکراوی دۆلار ئێستا ${r} د.ع یە: ${a} د.ع دەبێتە $${u}. تێچووی دابینکەر بە دینار پاشەکەوت نەکرا چونکە پێش پاشەکەوتکردن ئەم نرخەت نەبینیبوو؛ دووبارە پاشەکەوت بکە بۆ ئەوەی بەم نرخە پاشەکەوت بکرێت.`,
  restSavedWithheld: (m) => `باقی زانیارییەکانی نرخدانان پاشەکەوت کران، بەڵام تێچووی دابینکەر بە دینار پاشەکەوت نەکرا: ${m}`,
  measuresForPricingOnly: 'پێوانەی سندوق یان کێش بۆ نرخدانان پاشەکەوت کرا؛ بەڵام پێوانەکانی خودی بەرهەمەکە لە «پێوانەکان و کێش» بە دوگمەی «بڵاوکردنەوە» یان «ڕەشنووس» پاشەکەوت دەکرێن.',
  leaveMeasures: 'ئەو پێوانەی سندوق یان کێشەی گۆڕیوتە هێشتا لەگەڵ بەرهەمەکە پاشەکەوت نەکراوە، و ئەگەر ئێستا دەربچیت لەدەست دەچێت. هەر دەردەچیت؟',
};

export const USD_PRICING_FORM_STRINGS: Readonly<Record<Language, UsdPricingFormStrings>> = { ar, en, ckb };

export const usdPricingFormStrings = (lang: Language): UsdPricingFormStrings => USD_PRICING_FORM_STRINGS[lang] ?? ar;
