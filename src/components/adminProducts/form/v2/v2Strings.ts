/**
 * PRICING V2 IN THE PRODUCT FORM — EVERY WORD, IN ARABIC, ENGLISH AND SORANI
 * (implementation spec §5.7; docs/PRICING-V2.md §2; DECISIONS row 183: a `ckb`
 * slot never carries the Arabic, and holds a Sorani-only letter).
 *
 * Section ٣ «الأسعار», the price selectors of section ٥ «الخيارات والألوان»,
 * the review sheet, the status chip and the grouped readiness (and the clean
 * start's «مخفي: يحتاج تسعيرًا», spec addendum A.13). The pricing
 * vocabulary of the other pricing screens holds here too: shipping «ناردن»,
 * product «بەرهەم», cost «تێچوو», a route «ڕێڕەو»; never «گواستنەوە» (freight)
 * or «کاڵا» (tests/productFormV2.test.ts walks every key).
 *
 * Pure: no React, no request.
 */
import type { Language } from '../../../../translations';

type Fill = (v: string) => string;
type Fill2 = (a: string, b: string) => string;

export interface V2Strings {
  section: string;
  method: string;
  fromCost: string;
  usdPrice: string;
  costOwnerOnly: string;
  supplier: string;
  supplierCurrency: string;
  stockRoute: string;
  stockRouteNone: string;
  weightKg: string;
  boxCm: string;
  boxLength: string;
  boxWidth: string;
  boxHeight: string;
  fromDimensions: string;
  change: string;
  extras: string;
  minProfit: string;
  discount: string;
  discountHint: string;
  directPrice: string;
  profitAndPreorder: string;
  exceptions: string;
  finalTable: string;
  source: string;
  details: string;
  detailsHide: string;
  followsProduct: string;
  ownCost: string;
  priceDelta: string;
  fixedPrice: string;
  followsModel: string;
  overModel: string;
  exception: string;
  backToInherited: string;
  allColoursOne: string;
  applySelected: string;
  selectColour: string;
  chipCurrent: string;
  chipReview: Fill;
  chipMissing: Fill;
  chipHeld: string;
  chipHeldStaff: string;
  chipPaused: string;
  chipRate: Fill;
  rateHistory: string;
  publish: string;
  /** The form's «مسودة» button (C13: the buttons speak the reader's language). */
  draft: string;
  /** The form header's status chip (C5): a product customers see, and one they do not. */
  statusPublished: string;
  statusHidden: string;
  /** The weight unit beside a number, in the reader's language. */
  kgUnit: string;
  /** «المنتج: $40.00» — the inherited value shown as a placeholder or hint. */
  inheritedProduct: Fill;
  /** «الموديل: $40.00». */
  inheritedModel: Fill;
  /** The two separate resets of a model (its price, its discount exception). */
  resetPrice: string;
  resetDiscount: string;
  reviewTitle: string;
  reviewIntro: string;
  confirm: string;
  cancel: string;
  largeTick: string;
  largeNote: string;
  dropFlag: string;
  discountTooBig: string;
  routeBlocked: string;
  preorderOnly: string;
  costOptional: string;
  price: string;
  preorderDiscount: string;
  sells: string;
  directSale: string;
  preorder: string;
  routeLand: string;
  routeSea: string;
  routeAir: string;
  modelColour: string;
  direct: string;
  preorderVia: Fill;
  edit: string;
  show: string;
  foldRows: Fill;
  perModel: Fill;
  result: Fill;
  cost: string;
  profit: string;
  finalUsd: string;
  preorderLine: Fill2;
  sourceProduct: string;
  sourceModelFixed: string;
  sourceModelDelta: string;
  sourceModelCost: Fill;
  sourceColourDelta: string;
  sourceSkuFixed: string;
  discountNone: string;
  readinessTitle: string;
  missingCount: Fill;
  levelProduct: string;
  levelModel: string;
  levelColour: string;
  levelSku: string;
  computing: string;
  previewFailed: Fill;
  noPriceYet: string;
  includesDrafts: string;
  noChanges: string;
  oldPrice: string;
  newPrice: string;
  changePercent: string;
  replacement: string;
  rate: string;
  floorWithdrawn: string;
  floorMinProfit: string;
  belowCost: string;
  skuSpecial: string;
  skuDiscount: string;
  savedPriced: string;
  savedDataOnly: string;
  signInAgain: string;
  reauth: string;
  from: Fill;
  inherit: string;
  pending: string;
  methodLabel: Fill;
  chipHidden: string;
  chipHiddenReady: string;
  hiddenNote: string;
  hiddenNoteReady: string;
  purchasePrefill: string;
  belowMinProfit: string;
  rateMissing: string;
  notInstalled: string;
  newRow: string;
  staffUsd: string;
  costFirstNoMoney: string;
  firstPublishNote: string;
  noTable: string;
  channel: string;
  unsaved: string;
  saved: string;
  leaveUnsaved: string;
}

const AR: V2Strings = {
  section: 'الأسعار',
  method: 'كيف يُحسب السعر؟',
  fromCost: 'من التكلفة',
  usdPrice: 'سعر بالدولار',
  costOwnerOnly: 'التكلفة — للمالك فقط',
  supplier: 'سعر المورد',
  supplierCurrency: 'عملة المورد',
  stockRoute: 'مسار شحن المخزون',
  stockRouteNone: '— اختر المسار —',
  weightKg: 'الوزن (كغ)',
  boxCm: 'الصندوق (سم)',
  boxLength: 'الطول',
  boxWidth: 'العرض',
  boxHeight: 'الارتفاع',
  fromDimensions: 'مأخوذ من «الأبعاد والوزن»',
  change: 'غيّر',
  extras: 'تكاليف إضافية للقطعة (د.ع)',
  minProfit: 'الحد الأدنى للربح ($)',
  discount: 'خصم الطلب المسبق ($)',
  discountHint: 'يُطرح من سعر البيع المباشر',
  directPrice: 'سعر البيع المباشر',
  profitAndPreorder: 'الربح والطلب المسبق',
  exceptions: 'استثناءات:',
  finalTable: 'الأسعار النهائية للزبون',
  source: 'من أين جاء السعر',
  details: 'التفاصيل',
  detailsHide: 'إخفاء التفاصيل',
  followsProduct: 'يتبع المنتج',
  ownCost: 'تكلفة مختلفة',
  priceDelta: 'فرق في السعر ± $',
  fixedPrice: 'سعر خاص $',
  followsModel: 'يتبع الموديل',
  overModel: '± $ فوق الموديل',
  exception: 'استثناء',
  backToInherited: 'رجوع للموروث',
  allColoursOne: 'كل الألوان بسعر واحد',
  applySelected: 'طبّق على الألوان المحددة',
  selectColour: 'حدّد',
  chipCurrent: 'محدّثة',
  chipReview: (n) => `بانتظار مراجعتك (${n} أسعار)`,
  chipMissing: (what) => `ناقص: ${what}`,
  chipHeld: 'متوقف: سعر الصرف بانتظار اعتمادك',
  chipHeldStaff: 'متوقف: سعر الصرف بانتظار اعتماد المالك',
  chipPaused: 'متوقف: التسعير التلقائي موقوف مؤقتًا',
  chipRate: (r) => `1 USD = ${r} د.ع (معتمد)`,
  rateHistory: 'السجل',
  publish: 'نشر',
  draft: 'مسودة',
  statusPublished: 'منشور',
  statusHidden: 'مخفي',
  kgUnit: 'كغ',
  inheritedProduct: (v) => `المنتج: ${v}`,
  inheritedModel: (v) => `الموديل: ${v}`,
  resetPrice: 'السعر: رجوع للموروث',
  resetDiscount: 'الخصم: رجوع للموروث',
  reviewTitle: 'راجع الأسعار التي ستتغيّر',
  reviewIntro: 'هذه الأسعار فقط تتغيّر بهذا الحفظ. لا يُحفظ شيء قبل اعتمادك.',
  confirm: 'اعتمد ونشر',
  cancel: 'إلغاء — أبقِ ما كتبته',
  largeTick: 'أؤكد تغييرًا أكبر من 15%',
  largeNote: 'التغيير الكبير يحتاج تسجيل دخول حديثًا.',
  dropFlag: 'انخفاض أكبر من 30%',
  discountTooBig: 'الخصم أكبر من ربح هذا المسار — يُباع بسعر البيع المباشر',
  routeBlocked: 'متوقف: أقل من التكلفة',
  preorderOnly: 'لا خصم — يُباع مسبقًا فقط',
  costOptional: 'التكلفة (اختياري — للأرباح والتقدير فقط)',
  price: 'السعر',
  preorderDiscount: 'خصم المسبق',
  sells: 'يُباع',
  directSale: 'بيع مباشر',
  preorder: 'طلب مسبق',
  routeLand: 'بري',
  routeSea: 'بحري',
  routeAir: 'جوي',
  modelColour: 'الموديل · اللون',
  direct: 'مباشر',
  preorderVia: (r) => `طلب مسبق (${r})`,
  edit: 'عدّل',
  show: 'اعرض',
  foldRows: (n) => `${n} صفوف أخرى تتبع موديلها`,
  perModel: (n) => `الأسعار لكل موديل ولون (${n})`,
  result: (m) => `النتيجة (${m})`,
  cost: 'التكلفة',
  profit: 'الربح',
  finalUsd: 'السعر النهائي',
  preorderLine: (usd, iqd) => `طلب مسبق: ${usd} ← ${iqd}`,
  sourceProduct: 'المنتج',
  sourceModelFixed: 'سعر خاص للموديل',
  sourceModelDelta: 'فرق الموديل',
  sourceModelCost: (m) => `تكلفة ${m}`,
  sourceColourDelta: 'فرق اللون',
  sourceSkuFixed: 'سعر خاص لهذا الصف',
  discountNone: 'بلا خصم',
  readinessTitle: 'ما ينقص لحساب الأسعار',
  missingCount: (n) => `${n} صفوف`,
  levelProduct: 'المنتج',
  levelModel: 'موديل',
  levelColour: 'لون',
  levelSku: 'صف',
  computing: 'يجري حساب الأسعار…',
  previewFailed: (m) => `تعذّر حساب الأسعار الآن: ${m}`,
  noPriceYet: 'لا سعر بعد',
  includesDrafts: 'الأسعار المعروضة تشمل تعديلاتك غير المحفوظة.',
  noChanges: 'لا يتغيّر أي سعر.',
  oldPrice: 'القديم',
  newPrice: 'الجديد',
  changePercent: 'التغيّر',
  replacement: 'تكلفة الاستبدال',
  rate: 'سعر الصرف',
  floorWithdrawn: 'سُحب الخصم',
  floorMinProfit: 'رُفع إلى الحد الأدنى للربح',
  belowCost: 'أقل من التكلفة',
  skuSpecial: 'سعر خاص $',
  skuDiscount: 'خصم $',
  savedPriced: 'حُفظ المنتج ونُشرت أسعاره.',
  savedDataOnly: 'حُفظت البيانات؛ لا تُنشر الأسعار حتى تكتمل.',
  signInAgain: 'سجّل الدخول مرة أخرى',
  reauth: 'التغيير الكبير يحتاج تسجيل دخول حديثًا. سجّل الدخول ثم أعد الحفظ.',
  from: (v) => `من ${v}`,
  inherit: 'يرث',
  pending: 'بانتظار الحساب',
  methodLabel: (m) => `طريقة التسعير: ${m}`,
  // DECISIONS rows 239-240: an unpriced product is shown to customers without a price, sold to nobody.
  chipHidden: 'ظاهر بلا سعر — يحتاج تسعيرًا',
  chipHiddenReady: 'ظاهر بلا سعر — جاهز للنشر',
  hiddenNote: 'لا يُباع هذا المنتج حتى يكتمل تسعيره بالدولار ويُنشر؛ وما دام نشطًا يراه الزبائن بلا سعر.',
  hiddenNoteReady: 'الأسعار مكتملة. اضغط «نشر» لمراجعتها وفتح الشراء للزبائن.',
  purchasePrefill: 'تكلفة آخر شراء مؤكد مُدرجة في التكلفة أدناه. راجع الأسعار الناتجة؛ تُعتمد التكلفة مع أول نشر.',
  belowMinProfit: 'سعر البيع المباشر أقل من التكلفة + الحد الأدنى للربح',
  rateMissing: 'لا يوجد سعر صرف دولار معتمد بعد — لا تُحسب الأسعار حتى يعتمده المالك.',
  notInstalled: 'التسعير بالدولار غير مفعّل على هذه النسخة من قاعدة البيانات بعد.',
  newRow: 'جديد',
  staffUsd: 'تكتب السعر بالدولار، ويُحوَّل إلى الدينار بسعر الصرف المعتمد.',
  costFirstNoMoney: 'تسعير هذا المنتج من التكلفة للمالك فقط',
  firstPublishNote: 'أول نشر لهذا المنتج: كل الأسعار أدناه جديدة.',
  noTable: 'أضف موديلًا أو فعّل طريقة بيع ليظهر جدول الأسعار.',
  channel: 'طريقة البيع',
  unsaved: 'تعديلات غير محفوظة',
  saved: 'محفوظ',
  leaveUnsaved: 'لديك أسعار لم تُحفظ بعد. هل تغادر وتفقدها؟',
};

const EN: V2Strings = {
  section: 'Prices',
  method: 'How is the price set?',
  fromCost: 'From cost',
  usdPrice: 'Dollar price',
  costOwnerOnly: 'Cost — owner only',
  supplier: 'Supplier price',
  supplierCurrency: 'Supplier currency',
  stockRoute: 'Stock shipping route',
  stockRouteNone: '— choose a route —',
  weightKg: 'Weight (kg)',
  boxCm: 'Box (cm)',
  boxLength: 'Length',
  boxWidth: 'Width',
  boxHeight: 'Height',
  fromDimensions: 'Taken from "Dimensions & weight"',
  change: 'Change',
  extras: 'Extra cost per unit (IQD)',
  minProfit: 'Minimum profit ($)',
  discount: 'Pre-order discount ($)',
  discountHint: 'Taken off the direct-sale price',
  directPrice: 'Direct-sale price',
  profitAndPreorder: 'Profit and pre-order',
  exceptions: 'Exceptions:',
  finalTable: 'Final customer prices',
  source: 'Where the price comes from',
  details: 'Details',
  detailsHide: 'Hide details',
  followsProduct: 'Follows the product',
  ownCost: 'Different cost',
  priceDelta: 'Price difference ± $',
  fixedPrice: 'Special price $',
  followsModel: 'Follows the model',
  overModel: '± $ over the model',
  exception: 'Exception',
  backToInherited: 'Back to inherited',
  allColoursOne: 'All colours one price',
  applySelected: 'Apply to the selected colours',
  selectColour: 'Select',
  chipCurrent: 'Up to date',
  chipReview: (n) => `Awaiting your review (${n} prices)`,
  chipMissing: (what) => `Missing: ${what}`,
  chipHeld: 'Paused: the exchange rate awaits your approval',
  chipHeldStaff: 'Paused: the exchange rate awaits the owner',
  chipPaused: 'Paused: automatic pricing is on hold',
  chipRate: (r) => `1 USD = ${r} IQD (approved)`,
  rateHistory: 'History',
  publish: 'Publish',
  draft: 'Draft',
  statusPublished: 'Published',
  statusHidden: 'Hidden',
  kgUnit: 'kg',
  inheritedProduct: (v) => `Product: ${v}`,
  inheritedModel: (v) => `Model: ${v}`,
  resetPrice: 'Price: back to inherited',
  resetDiscount: 'Discount: back to inherited',
  reviewTitle: 'Review the prices that will change',
  reviewIntro: 'Only these prices change with this save. Nothing is saved before you confirm.',
  confirm: 'Confirm and publish',
  cancel: 'Cancel — keep what I typed',
  largeTick: 'I confirm a change above 15%',
  largeNote: 'A large change needs a recent sign-in.',
  dropFlag: 'Drop above 30%',
  discountTooBig: "The discount exceeds this route's profit — it sells at the direct price",
  routeBlocked: 'Stopped: below cost',
  preorderOnly: 'No discount — pre-order only',
  costOptional: 'Cost (optional — profit and estimates only)',
  price: 'Price',
  preorderDiscount: 'Pre-order discount',
  sells: 'Sells',
  directSale: 'Direct sale',
  preorder: 'Pre-order',
  routeLand: 'Land',
  routeSea: 'Sea',
  routeAir: 'Air',
  modelColour: 'Model · colour',
  direct: 'Direct',
  preorderVia: (r) => `Pre-order (${r})`,
  edit: 'Edit',
  show: 'Show',
  foldRows: (n) => `${n} more rows follow their model`,
  perModel: (n) => `Prices per model and colour (${n})`,
  result: (m) => `Result (${m})`,
  cost: 'Cost',
  profit: 'Profit',
  finalUsd: 'Final price',
  preorderLine: (usd, iqd) => `Pre-order: ${usd} → ${iqd}`,
  sourceProduct: 'The product',
  sourceModelFixed: "The model's own price",
  sourceModelDelta: "The model's difference",
  sourceModelCost: (m) => `${m}'s cost`,
  sourceColourDelta: "The colour's difference",
  sourceSkuFixed: "This row's own price",
  discountNone: 'No discount',
  readinessTitle: 'What pricing still needs',
  missingCount: (n) => `${n} rows`,
  levelProduct: 'product',
  levelModel: 'model',
  levelColour: 'colour',
  levelSku: 'row',
  computing: 'Computing prices…',
  previewFailed: (m) => `Prices could not be computed now: ${m}`,
  noPriceYet: 'No price yet',
  includesDrafts: 'The prices shown include your unsaved edits.',
  noChanges: 'No price changes.',
  oldPrice: 'Old',
  newPrice: 'New',
  changePercent: 'Change',
  replacement: 'Replacement cost',
  rate: 'Exchange rate',
  floorWithdrawn: 'Discount withdrawn',
  floorMinProfit: 'Lifted to the minimum profit',
  belowCost: 'Below cost',
  skuSpecial: 'Special price $',
  skuDiscount: 'Discount $',
  savedPriced: 'The product is saved and its prices are published.',
  savedDataOnly: 'The data is saved; prices are not published until they are complete.',
  signInAgain: 'Sign in again',
  reauth: 'A large change needs a recent sign-in. Sign in, then save again.',
  from: (v) => `from ${v}`,
  inherit: 'Inherit',
  pending: 'Waiting to compute',
  methodLabel: (m) => `Pricing method: ${m}`,
  chipHidden: 'Shown without a price — needs pricing',
  chipHiddenReady: 'Shown without a price — ready to publish',
  hiddenNote: 'This product is not sold until its dollar pricing is complete and published; while it is active, customers see it without a price.',
  hiddenNoteReady: 'The prices are complete. Press "Publish" to review them and open it for purchase.',
  purchasePrefill: 'The cost of the latest confirmed purchase is filled in below. Review the resulting prices; the cost is applied with the first publish.',
  belowMinProfit: 'The direct price is below cost plus the minimum profit',
  rateMissing: 'No approved dollar rate yet — prices are not computed until the owner approves one.',
  notInstalled: 'Dollar pricing is not enabled on this database version yet.',
  newRow: 'New',
  staffUsd: 'You type the price in dollars; it is converted to dinars at the approved rate.',
  costFirstNoMoney: 'This product is priced from cost; only the owner prices it',
  firstPublishNote: "This product's first publication: every price below is new.",
  noTable: 'Add a model or switch on a way of selling to see the price table.',
  channel: 'Way of selling',
  unsaved: 'Unsaved changes',
  saved: 'Saved',
  leaveUnsaved: 'You have prices that are not saved yet. Leave and lose them?',
};

const CKB: V2Strings = {
  section: 'نرخەکان',
  method: 'نرخ چۆن دادەنرێت؟',
  fromCost: 'لە تێچووەوە',
  usdPrice: 'نرخ بە دۆلار',
  costOwnerOnly: 'تێچوو — تەنها بۆ خاوەن',
  supplier: 'نرخی دابینکەر',
  supplierCurrency: 'دراوی دابینکەر',
  stockRoute: 'ڕێڕەوی ناردنی کۆگا',
  stockRouteNone: '— ڕێڕەوێک هەڵبژێرە —',
  weightKg: 'کێش (کیلۆگرام)',
  boxCm: 'سندوق (سانتیمەتر)',
  boxLength: 'درێژی',
  boxWidth: 'پانییەکە',
  boxHeight: 'بەرزی',
  fromDimensions: 'لە «قەبارە و کێش» وەرگیراوە',
  change: 'گۆڕین',
  extras: 'تێچووی زیادە بۆ هەر پارچەیەک (دینار)',
  minProfit: 'کەمترین قازانج ($)',
  discount: 'داشکاندنی پێشداواکردن ($)',
  discountHint: 'لە نرخی فرۆشتنی ڕاستەوخۆ کەم دەکرێتەوە',
  directPrice: 'نرخی فرۆشتنی ڕاستەوخۆ',
  profitAndPreorder: 'قازانج و پێشداواکردن',
  exceptions: 'حاڵەتە تایبەتەکان:',
  finalTable: 'نرخە کۆتاییەکان بۆ کڕیار',
  source: 'نرخەکە لە کوێوە هات',
  details: 'وردەکارییەکان',
  detailsHide: 'شاردنەوەی وردەکارییەکان',
  followsProduct: 'شوێن بەرهەم دەکەوێت',
  ownCost: 'تێچووی جیاواز',
  priceDelta: 'جیاوازی لە نرخدا ± $',
  fixedPrice: 'نرخی تایبەت $',
  followsModel: 'شوێن مۆدێل دەکەوێت',
  overModel: '± $ لەسەر مۆدێل',
  exception: 'حاڵەتی تایبەت',
  backToInherited: 'گەڕانەوە بۆ نرخی بنەڕەت',
  allColoursOne: 'هەموو ڕەنگەکان بە یەک نرخ',
  applySelected: 'لەسەر ڕەنگە دیاریکراوەکان جێبەجێی بکە',
  selectColour: 'دیاری بکە',
  chipCurrent: 'نوێکراوەتەوە',
  chipReview: (n) => `چاوەڕێی پێداچوونەوەتە (${n} نرخ)`,
  chipMissing: (what) => `کەمە: ${what}`,
  chipHeld: 'وەستاوە: نرخی ئاڵوگۆڕ چاوەڕێی پەسەندکردنتە',
  chipHeldStaff: 'وەستاوە: نرخی ئاڵوگۆڕ چاوەڕێی پەسەندکردنی خاوەنە',
  chipPaused: 'وەستاوە: نرخدانانی خۆکار بۆ ماوەیەک ڕاگیراوە',
  chipRate: (r) => `1 USD = ${r} دینار (پەسەندکراو)`,
  rateHistory: 'تۆمار',
  publish: 'بڵاوکردنەوە',
  draft: 'ڕەشنووس',
  statusPublished: 'بڵاوکراوەتەوە',
  statusHidden: 'شاراوە',
  kgUnit: 'کیلۆ',
  inheritedProduct: (v) => `بەرهەم: ${v}`,
  inheritedModel: (v) => `مۆدێل: ${v}`,
  resetPrice: 'نرخ: گەڕانەوە بۆ نرخی بنەڕەت',
  resetDiscount: 'داشکاندن: گەڕانەوە بۆ نرخی بنەڕەت',
  reviewTitle: 'ئەو نرخانە ببینە کە دەگۆڕێن',
  reviewIntro: 'تەنها ئەم نرخانە بەم پاشەکەوتکردنە دەگۆڕێن. پێش پەسەندکردنت هیچ پاشەکەوت ناکرێت.',
  confirm: 'پەسەندکردن و بڵاوکردنەوە',
  cancel: 'هەڵوەشاندنەوە — ئەوەی نووسیوتە بمێنێتەوە',
  largeTick: 'گۆڕانکاریی سەرووی 15% پشتڕاست دەکەمەوە',
  largeNote: 'گۆڕانکاریی گەورە پێویستی بە چوونەژوورەوەی نوێ هەیە.',
  dropFlag: 'دابەزینی سەرووی 30%',
  discountTooBig: 'داشکاندنەکە لە قازانجی ئەم ڕێڕەوە زیاترە — بە نرخی ڕاستەوخۆ دەفرۆشرێت',
  routeBlocked: 'وەستاوە: لە تێچوو کەمترە',
  preorderOnly: 'داشکاندن نییە — تەنها پێشداواکردن',
  costOptional: 'تێچوو (ئارەزوومەندانە — تەنها بۆ قازانج و خەمڵاندن)',
  price: 'نرخەکە',
  preorderDiscount: 'داشکاندنی پێشداواکردن',
  sells: 'دەفرۆشرێت',
  directSale: 'فرۆشتنی ڕاستەوخۆ',
  preorder: 'پێشداواکردن',
  routeLand: 'ڕێگای وشکانی',
  routeSea: 'ڕێگای دەریایی',
  routeAir: 'ڕێگای ئاسمانی',
  modelColour: 'مۆدێل · ڕەنگ',
  direct: 'ڕاستەوخۆ',
  preorderVia: (r) => `پێشداواکردن (${r})`,
  edit: 'دەستکاری',
  show: 'پیشانی بدە',
  foldRows: (n) => `${n} ڕیزی تر شوێن مۆدێلەکەیان دەکەون`,
  perModel: (n) => `نرخ بۆ هەر مۆدێل و ڕەنگێک (${n})`,
  result: (m) => `ئەنجامەکە (${m})`,
  cost: 'تێچوو',
  profit: 'بڕی قازانج',
  finalUsd: 'نرخی کۆتایی',
  preorderLine: (usd, iqd) => `پێشداواکردن: ${usd} ← ${iqd}`,
  sourceProduct: 'بەرهەمەکە',
  sourceModelFixed: 'نرخی تایبەتی مۆدێل',
  sourceModelDelta: 'جیاوازیی مۆدێل',
  sourceModelCost: (m) => `تێچووی ${m}`,
  sourceColourDelta: 'جیاوازیی ڕەنگ',
  sourceSkuFixed: 'نرخی تایبەتی ئەم ڕیزە',
  discountNone: 'بێ داشکاندن',
  readinessTitle: 'ئەوەی بۆ نرخدانان کەمە',
  missingCount: (n) => `${n} ڕیز`,
  levelProduct: 'بەرهەم',
  levelModel: 'مۆدێل',
  levelColour: 'ڕەنگ',
  levelSku: 'ڕیز',
  computing: 'نرخەکان دەژمێردرێن…',
  previewFailed: (m) => `ئێستا نرخەکان نەژمێردران: ${m}`,
  noPriceYet: 'هێشتا نرخ نییە',
  includesDrafts: 'نرخە پیشاندراوەکان دەستکارییە پاشەکەوتنەکراوەکانت لەخۆ دەگرن.',
  noChanges: 'هیچ نرخێک ناگۆڕێت.',
  oldPrice: 'کۆن',
  newPrice: 'نوێ',
  changePercent: 'گۆڕان',
  replacement: 'تێچووی جێگرتنەوە',
  rate: 'نرخی ئاڵوگۆڕ',
  floorWithdrawn: 'داشکاندنەکە لابرا',
  floorMinProfit: 'بەرزکرایەوە بۆ کەمترین قازانج',
  belowCost: 'لە تێچوو کەمترە',
  skuSpecial: 'نرخی تایبەت $',
  skuDiscount: 'بڕی داشکاندن $',
  savedPriced: 'بەرهەمەکە پاشەکەوت کرا و نرخەکانی بڵاو کرانەوە.',
  savedDataOnly: 'زانیارییەکان پاشەکەوت کران؛ نرخەکان تا تەواو نەبن بڵاو ناکرێنەوە.',
  signInAgain: 'دووبارە بچۆرە ژوورەوە',
  reauth: 'گۆڕانکاریی گەورە پێویستی بە چوونەژوورەوەی نوێ هەیە. بچۆرە ژوورەوە و دووبارە پاشەکەوتی بکە.',
  from: (v) => `لە ${v}ەوە`,
  inherit: 'بەهای بنەڕەت',
  pending: 'چاوەڕێی ژماردنە',
  methodLabel: (m) => `شێوازی نرخدانان: ${m}`,
  chipHidden: 'بێ نرخ پیشان دەدرێت — پێویستی بە نرخدانان هەیە',
  chipHiddenReady: 'بێ نرخ پیشان دەدرێت — ئامادەیە بۆ بڵاوکردنەوە',
  hiddenNote: 'ئەم بەرهەمە نافرۆشرێت تا نرخدانانی بە دۆلار تەواو دەبێت و بڵاو دەکرێتەوە؛ تا چالاک بێت کڕیاران بێ نرخ دەیبینن.',
  hiddenNoteReady: 'نرخەکان تەواون. «بڵاوکردنەوە» دابگرە بۆ پێداچوونەوە و کردنەوەی کڕین بۆ کڕیاران.',
  purchasePrefill: 'تێچووی دوایین کڕینی پشتڕاستکراو لە خوارەوە پڕکراوەتەوە. نرخە دەرچووەکان ببینە؛ تێچووەکە لەگەڵ یەکەم بڵاوکردنەوە پەسەند دەکرێت.',
  belowMinProfit: 'نرخی فرۆشتنی ڕاستەوخۆ لە تێچوو + کەمترین قازانج کەمترە',
  rateMissing: 'هێشتا نرخی ئاڵوگۆڕی دۆلاری پەسەندکراو نییە — نرخەکان ناژمێردرێن تا خاوەن پەسەندی دەکات.',
  notInstalled: 'نرخدانان بە دۆلار هێشتا لەسەر ئەم وەشانەی بنکەدراوە چالاک نەکراوە.',
  newRow: 'نوێ',
  staffUsd: 'نرخەکە بە دۆلار دەنووسیت و بە نرخی ئاڵوگۆڕی پەسەندکراو دەگۆڕدرێت بۆ دینار.',
  costFirstNoMoney: 'ئەم بەرهەمە لە تێچووەوە نرخ دەدرێت؛ تەنها خاوەن نرخی دادەنێت',
  firstPublishNote: 'یەکەم بڵاوکردنەوەی ئەم بەرهەمە: هەموو نرخەکانی خوارەوە نوێن.',
  noTable: 'مۆدێلێک زیاد بکە یان شێوازێکی فرۆشتن چالاک بکە بۆ ئەوەی خشتەی نرخەکان دەربکەوێت.',
  channel: 'شێوازی فرۆشتن',
  unsaved: 'گۆڕانکاریی پاشەکەوتنەکراو',
  saved: 'پاشەکەوتکراوە',
  leaveUnsaved: 'نرخی پاشەکەوتنەکراوت هەیە. دەڕۆیت و لەدەستیان دەدەیت؟',
};

export const V2_STRINGS: Readonly<Record<'ar' | 'en' | 'ckb', V2Strings>> = { ar: AR, en: EN, ckb: CKB };

/** The strings of the reader's language (Arabic for anything unknown). */
export function v2Strings(lang: Language | string): V2Strings {
  return lang === 'en' ? EN : lang === 'ckb' ? CKB : AR;
}

/**
 * The form header's status chip (C5): an active product still «يحتاج تسعيرًا» (or a new one, before its first
 * V2 write) is hidden from customers, so the header never says «منشور» beside section ٣'s «مخفي».
 */
export function headerStatusText(status: string, needsPricing: boolean, s: Pick<V2Strings, 'statusPublished' | 'statusHidden' | 'draft' | 'chipHidden'>): string {
  if (status === 'draft') return s.draft;
  if (status === 'active') return needsPricing ? s.chipHidden : s.statusPublished;
  return s.statusHidden;
}
