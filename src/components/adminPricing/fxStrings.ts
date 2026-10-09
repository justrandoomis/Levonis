/**
 * «أسعار الصرف» — EVERY WORD OF THE OWNER'S EXCHANGE-RATE PANEL, IN ARABIC,
 * ENGLISH AND SORANI (FX programme plan §12; docs/DECISIONS.md row 183).
 *
 * Its own module, beside strings.ts and re-exported from it, so the owner's
 * dashboard card (src/components/admin/OwnerRatesCard.tsx) can say «أسعار
 * الصرف» without loading the pricing tab's whole vocabulary. Pure: no React,
 * no request, no contract import.
 *
 * Every `ckb` is its own Sorani — never the Arabic or the English pasted
 * across — with at least one Sorani-only letter and none of the Arabic-only
 * ones (ة ى ي ك); tests/adminPricingStrings.test.ts walks the table. The
 * plan's own table (§12) is the source; where a row of it carried no
 * Sorani-only letter («زانیاری: IQWealth») the wording is the plural
 * «زانیارییەکان», which says the same.
 *
 * Figures arrive already written in the reader's digits (`readDecimal`); a
 * sentence never formats a number itself.
 */
import type { Language } from '../../translations';
import type { FxCheckResult, FxPairId, FxPendingReason, FxStatus } from './api';

type Lang = Language;
type One = (a: string) => string;
type Two = (a: string, b: string) => string;

export interface FxStrings {
  title: string;
  intro: string;
  pairName: Readonly<Record<FxPairId, string>>;
  srcParallel: string;
  srcEcb: string;
  attribution: string;
  ecbAttribution: string;
  tracking: string;
  trackingEcb: string;
  intOff: string;
  int6: string;
  int12: string;
  int24: string;
  int6Short: string;
  int12Short: string;
  int24Short: string;
  modeAuto: string;
  modeManual: string;
  marketSell: string;
  marketBuy: string;
  official: string;
  marketEcb: string;
  adjustment: string;
  adjustmentHint: string;
  effective: string;
  effectiveIqd: Readonly<Record<'EUR' | 'CNY', string>>;
  computedNote: string;
  lastUpdate: string;
  lastCheck: string;
  published: string;
  lkg: string;
  anchor: string;
  nextCheck: string;
  status: string;
  st: Readonly<Record<FxStatus, string>>;
  noRateYet: string;
  keyMissing: string;
  reviewTitle: string;
  reviewFirst: string;
  reviewBody: (next: string, old: string, pct: string, limit: string) => string;
  reviewOpen: string;
  pendingNew: string;
  pendingCurrent: string;
  pendingMarket: string;
  change: string;
  reason: string;
  reasons: Readonly<Record<FxPendingReason, One>>;
  waitingSince: One;
  rejectedRecently: Two;
  approve: string;
  reject: string;
  keepManual: string;
  refresh: string;
  refreshing: string;
  refreshBudget: Two;
  manual: string;
  manualLabel: string;
  manualSave: string;
  backAuto: string;
  manualNote: string;
  useObserved: One;
  observedAt: One;
  confirmCurrent: string;
  confirmCurrentHint: string;
  guards: string;
  guardsHint: string;
  threshold: string;
  drift: string;
  minChange: string;
  boundMin: string;
  boundMax: string;
  guardsSave: string;
  save: string;
  cancel: string;
  saved: string;
  invalidRate: string;
  invalidPct: string;
  invalidAdjustment: string;
  reauth: string;
  largeChange: string;
  largeConfirm: string;
  loadFailed: string;
  loading: string;
  unknown: string;
  history: string;
  historyTitle: string;
  historyEmpty: string;
  historyAll: string;
  loadMore: string;
  close: string;
  events: Readonly<Record<string, string>>;
  triggers: Readonly<Record<'cron' | 'refresh' | 'owner' | 'back_to_auto', string>>;
  checkResult: Readonly<Record<FxCheckResult, string>>;
  shipTitle: string;
  shipIntro: string;
  ship: Readonly<Record<'GERMANY_LAND' | 'CHINA_AIR' | 'CHINA_SEA', string>>;
  shipNotSet: string;
  shipUseSuggestion: One;
  shipEdit: string;
  shipRateLabel: string;
  ownerCardTitle: string;
  ownerCardOpen: string;
  ownerCardReview: One;
  ownerCardEmpty: string;
}

export const FX_STRINGS: Readonly<Record<Lang, FxStrings>> = {
  ar: {
    title: 'أسعار الصرف',
    intro: 'السعر المعتمد هنا هو سعر المتجر: به يقرأ الزبائن الأسعار بالدولار، وبه يحسب الحاسب. لا يتغيّر سعر أي منتج في هذا التحديث.',
    pairName: { USD_IQD: 'الدولار ← الدينار', EUR_USD: 'اليورو ← الدولار', CNY_USD: 'اليوان ← الدولار' },
    srcParallel: 'المصدر: السوق الموازية العراقية',
    srcEcb: 'المصدر: البنك المركزي الأوروبي (السعر المرجعي اليومي)',
    attribution: 'البيانات: IQWealth',
    ecbAttribution: 'البيانات: البنك المركزي الأوروبي',
    tracking: 'التتبع التلقائي للدولار',
    trackingEcb: 'التتبع التلقائي',
    intOff: 'متوقف',
    int6: 'كل 6 ساعات',
    int12: 'كل 12 ساعة',
    int24: 'كل 24 ساعة',
    int6Short: '6 ساعات',
    int12Short: '12 ساعة',
    int24Short: '24 ساعة',
    modeAuto: 'تلقائي',
    modeManual: 'يدوي',
    marketSell: 'سعر البيع في السوق',
    marketBuy: 'سعر الشراء في السوق',
    official: 'السعر الرسمي (البنك المركزي العراقي)',
    marketEcb: 'السعر المرجعي اليومي',
    adjustment: 'التعديل (دينار لكل دولار)',
    adjustmentHint: 'يُضاف إلى سعر البيع في السوق؛ اكتب رقمًا سالبًا للخصم.',
    effective: 'السعر المعتمد',
    effectiveIqd: { EUR: 'اليورو بالدينار (محسوب)', CNY: 'اليوان بالدينار (محسوب)' },
    computedNote: 'محسوب من سعر الدولار المعتمد',
    lastUpdate: 'آخر تحديث',
    lastCheck: 'آخر فحص',
    published: 'وقت نشر المصدر',
    lkg: 'آخر سعر موثوق',
    anchor: 'آخر سعر اعتمدته',
    nextCheck: 'الفحص القادم',
    status: 'الحالة',
    st: {
      OK: 'يعمل',
      REVIEW_REQUIRED: 'يحتاج مراجعتك',
      FAILED: 'تعذّر الجلب — يُستخدم آخر سعر موثوق',
      STALE: 'بيانات المصدر قديمة — لم تُطبَّق',
      NOT_CONFIGURED: 'لم يُضبط بعد',
    },
    noRateYet: 'لا يوجد سعر معتمد بعد',
    keyMissing: 'مفتاح IQWealth غير مضبوط، فلا يُجلب سعر الدولار تلقائيًا حتى يُضبط.',
    reviewTitle: 'تغيّر كبير في السعر',
    reviewFirst: 'أول سعر من المصدر — يحتاج اعتمادك مرة واحدة',
    reviewBody: (next, old, pct, limit) =>
      `السعر الجديد ${next} يختلف عن المعتمد ${old} بنسبة ${pct}٪، وهي أكثر من حد ${limit}٪. لم يُطبَّق ولم يتغير أي سعر حتى تقرر.`,
    reviewOpen: 'راجع السعر الجديد',
    pendingNew: 'السعر الجديد',
    pendingCurrent: 'السعر المعتمد الآن',
    pendingMarket: 'سعر السوق',
    change: 'التغيّر',
    reason: 'السبب',
    reasons: {
      FIRST_VALUE: () => 'أول سعر من المصدر',
      ANOMALY: (limit) => `قفزة أكبر من ${limit}٪ في خطوة واحدة`,
      ANOMALY_24H: (limit) => `تغيّر أكبر من ${limit}٪ خلال 24 ساعة`,
      DRIFT: (limit) => `ابتعاد أكبر من ${limit}٪ عن آخر سعر اعتمدته`,
      BACK_TO_AUTO: (limit) => `العودة إلى التلقائي بفرق أكبر من ${limit}٪`,
    },
    waitingSince: (date) => `بانتظارك منذ ${date}`,
    rejectedRecently: (rate, date) => `رفضت ${rate} في ${date} — لن يُعرض عليك مجددًا قبل 24 ساعة`,
    approve: 'اعتماد السعر الجديد',
    reject: 'رفض والإبقاء على الحالي',
    keepManual: 'أبقِ سعري الحالي يدويًا',
    refresh: 'تحديث الآن',
    refreshing: 'جارٍ التحديث…',
    refreshBudget: (used, limit) => `التحديثات اليوم: ${used} من ${limit}`,
    manual: 'تعيين سعر يدوي',
    manualLabel: 'السعر اليدوي',
    manualSave: 'اعتماد السعر اليدوي',
    backAuto: 'العودة إلى التلقائي',
    manualNote: 'السعر اليدوي لا يغيّره التحديث التلقائي أبدًا',
    useObserved: (rate) => `استخدم ${rate} سعرًا يدويًا`,
    observedAt: (date) => `رُصد في ${date}`,
    confirmCurrent: 'تأكيد السعر الحالي',
    confirmCurrentHint: 'يصبح السعر الحالي هو مرجع الابتعاد المسموح.',
    guards: 'إعدادات الحماية',
    guardsHint: 'حفظ هذه الإعدادات يطلب تسجيل دخول حديثًا.',
    threshold: 'التغيّر الذي يحتاج مراجعتك (٪)',
    drift: 'الابتعاد المسموح عن آخر سعر اعتمدته (٪)',
    minChange: 'تجاهل التغيّر الأصغر من (٪)',
    boundMin: 'أدنى سعر معقول',
    boundMax: 'أعلى سعر معقول',
    guardsSave: 'حفظ إعدادات الحماية',
    save: 'حفظ',
    cancel: 'إلغاء',
    saved: 'تم الحفظ',
    invalidRate: 'اكتب سعرًا أكبر من صفر، بنقطة للكسور.',
    invalidPct: 'اكتب نسبة مئوية صحيحة.',
    invalidAdjustment: 'اكتب عددًا من الدنانير، موجبًا أو سالبًا.',
    reauth: 'لحماية الأسعار، سجّل الدخول مجددًا ثم أعد المحاولة',
    largeChange: 'هذا تغيير كبير (أكثر من 15٪). أكّده صراحةً إن كان مقصودًا.',
    largeConfirm: 'نعم، أؤكد التغيير الكبير',
    loadFailed: 'تعذّر تحميل أسعار الصرف.',
    loading: 'جارٍ تحميل أسعار الصرف…',
    unknown: 'غير معروف',
    history: 'السجل',
    historyTitle: 'سجل أسعار الصرف',
    historyEmpty: 'لا يوجد شيء في السجل بعد.',
    historyAll: 'الكل',
    loadMore: 'عرض المزيد',
    close: 'إغلاق',
    events: {
      check: 'فحص',
      apply: 'طُبّق سعر جديد',
      review_held: 'أُوقف للمراجعة',
      review_approved: 'اعتمدتَه',
      review_rejected: 'رفضتَه',
      review_cleared: 'زال سبب المراجعة',
      review_expired: 'انتهت مهلة المراجعة',
      manual_set: 'سعر يدوي',
      mode_change: 'تغيّرت طريقة التحديث',
      settings_change: 'تغيّرت الإعدادات',
      failure: 'تعذّر الجلب',
      observed: 'رُصد سعر',
      deferred: 'أُجّل',
      superseded: 'تجاوزه سعر أحدث',
      commit_refused: 'رُفض الحفظ',
      anchor_confirmed: 'أكّدتَ السعر الحالي',
    },
    triggers: { cron: 'تلقائي', refresh: 'تحديث يدوي', owner: 'أنت', back_to_auto: 'العودة إلى التلقائي' },
    checkResult: {
      APPLIED: 'طُبّق',
      UNCHANGED: 'لم يتغيّر',
      REVIEW_HELD: 'بانتظار مراجعتك',
      DEFERRED: 'أُجّل',
      SUPERSEDED: 'تجاوزه سعر أحدث',
      FAILED: 'تعذّر',
      STALE: 'قديم',
      INVALID: 'غير صالح',
      NOT_CONFIGURED: 'غير مضبوط',
      OBSERVED: 'رُصد',
    },
    shipTitle: 'أسعار الشحن المركزية',
    shipIntro: 'بالدينار، لكل كغم أو لكل متر مكعب. لا تتحول بأي سعر صرف.',
    ship: {
      GERMANY_LAND: 'ألمانيا برًّا — دينار لكل كغم',
      CHINA_AIR: 'الصين جوًّا — دينار لكل كغم',
      CHINA_SEA: 'الصين بحرًا — دينار لكل متر مكعب',
    },
    shipNotSet: 'لم يُضبط',
    shipUseSuggestion: (v) => `استخدم ${v} من شاشة المشتريات`,
    shipEdit: 'تعديل',
    shipRateLabel: 'السعر بالدينار',
    ownerCardTitle: 'أسعار الصرف',
    ownerCardOpen: 'فتح «التسعير والشحن»',
    ownerCardReview: (n) => `بانتظار مراجعتك: ${n}`,
    ownerCardEmpty: 'لم يُعتمد سعر بعد',
  },
  en: {
    title: 'Exchange rates',
    intro: "The effective rate here is the shop's rate: customers read dollar prices at it, and the calculator uses it. No product price changes in this update.",
    pairName: { USD_IQD: 'USD → IQD', EUR_USD: 'EUR → USD', CNY_USD: 'CNY → USD' },
    srcParallel: 'Source: Iraqi parallel market',
    srcEcb: 'Source: European Central Bank (daily reference rate)',
    attribution: 'Data: IQWealth',
    ecbAttribution: 'Data: European Central Bank',
    tracking: 'Automatic USD tracking',
    trackingEcb: 'Automatic tracking',
    intOff: 'Off',
    int6: 'Every 6 hours',
    int12: 'Every 12 hours',
    int24: 'Every 24 hours',
    int6Short: '6 hours',
    int12Short: '12 hours',
    int24Short: '24 hours',
    modeAuto: 'Automatic',
    modeManual: 'Manual',
    marketSell: 'Market sell',
    marketBuy: 'Market buy',
    official: 'Official rate (CBI)',
    marketEcb: 'Daily reference rate',
    adjustment: 'Adjustment (IQD per USD)',
    adjustmentHint: 'Added to the market sell rate; type a negative number to lower it.',
    effective: 'Effective rate',
    effectiveIqd: { EUR: 'EUR in IQD (computed)', CNY: 'CNY in IQD (computed)' },
    computedNote: 'Computed from the effective dollar rate',
    lastUpdate: 'Last update',
    lastCheck: 'Last check',
    published: 'Published by the source',
    lkg: 'Last known good rate',
    anchor: 'Last rate you confirmed',
    nextCheck: 'Next check',
    status: 'Status',
    st: {
      OK: 'Working',
      REVIEW_REQUIRED: 'Needs your review',
      FAILED: 'Fetch failed — last known good rate in use',
      STALE: 'Source data is stale — not applied',
      NOT_CONFIGURED: 'Not set up yet',
    },
    noRateYet: 'No effective rate yet',
    keyMissing: 'The IQWealth key is not set, so the dollar rate is not fetched automatically until it is.',
    reviewTitle: 'Large rate change',
    reviewFirst: 'First value from the source — needs your approval once',
    reviewBody: (next, old, pct, limit) =>
      `The new rate ${next} differs from the effective ${old} by ${pct}%, above the ${limit}% limit. It was not applied, and no price changes until you decide.`,
    reviewOpen: 'Review the new rate',
    pendingNew: 'New rate',
    pendingCurrent: 'Effective now',
    pendingMarket: 'Market rate',
    change: 'Change',
    reason: 'Reason',
    reasons: {
      FIRST_VALUE: () => 'First value from the source',
      ANOMALY: (limit) => `A jump of more than ${limit}% in one step`,
      ANOMALY_24H: (limit) => `A change of more than ${limit}% within 24 hours`,
      DRIFT: (limit) => `More than ${limit}% away from the last rate you confirmed`,
      BACK_TO_AUTO: (limit) => `Back to automatic with a difference above ${limit}%`,
    },
    waitingSince: (date) => `Waiting for you since ${date}`,
    rejectedRecently: (rate, date) => `You rejected ${rate} on ${date} — it will not be offered again for 24 hours`,
    approve: 'Apply the new rate',
    reject: 'Reject and keep the current rate',
    keepManual: 'Keep my current rate as manual',
    refresh: 'Refresh now',
    refreshing: 'Refreshing…',
    refreshBudget: (used, limit) => `Refreshes today: ${used} of ${limit}`,
    manual: 'Set a manual rate',
    manualLabel: 'Manual rate',
    manualSave: 'Apply the manual rate',
    backAuto: 'Back to automatic',
    manualNote: 'Automatic updates never change a manual rate',
    useObserved: (rate) => `Use ${rate} as my manual rate`,
    observedAt: (date) => `Observed on ${date}`,
    confirmCurrent: 'Confirm the current rate',
    confirmCurrentHint: 'The current rate becomes the reference for the allowed drift.',
    guards: 'Safety settings',
    guardsHint: 'Saving these settings asks for a fresh sign-in.',
    threshold: 'Change that needs your review (%)',
    drift: 'Allowed drift from the last rate you confirmed (%)',
    minChange: 'Ignore changes smaller than (%)',
    boundMin: 'Lowest plausible rate',
    boundMax: 'Highest plausible rate',
    guardsSave: 'Save safety settings',
    save: 'Save',
    cancel: 'Cancel',
    saved: 'Saved',
    invalidRate: 'Type a rate above zero, with a point for decimals.',
    invalidPct: 'Type a valid percentage.',
    invalidAdjustment: 'Type a number of dinars, positive or negative.',
    reauth: 'To protect prices, sign in again, then retry',
    largeChange: 'This is a large change (more than 15%). Confirm it explicitly if you meant it.',
    largeConfirm: 'Yes, confirm the large change',
    loadFailed: 'Could not load the exchange rates.',
    loading: 'Loading the exchange rates…',
    unknown: 'Unknown',
    history: 'History',
    historyTitle: 'Exchange-rate history',
    historyEmpty: 'Nothing in the history yet.',
    historyAll: 'All',
    loadMore: 'Show more',
    close: 'Close',
    events: {
      check: 'Check',
      apply: 'New rate applied',
      review_held: 'Held for review',
      review_approved: 'You approved it',
      review_rejected: 'You rejected it',
      review_cleared: 'Review no longer needed',
      review_expired: 'Review expired',
      manual_set: 'Manual rate',
      mode_change: 'Update mode changed',
      settings_change: 'Settings changed',
      failure: 'Fetch failed',
      observed: 'Rate observed',
      deferred: 'Deferred',
      superseded: 'Superseded by a newer rate',
      commit_refused: 'Save refused',
      anchor_confirmed: 'You confirmed the current rate',
    },
    triggers: { cron: 'Automatic', refresh: 'Manual refresh', owner: 'You', back_to_auto: 'Back to automatic' },
    checkResult: {
      APPLIED: 'Applied',
      UNCHANGED: 'Unchanged',
      REVIEW_HELD: 'Waiting for your review',
      DEFERRED: 'Deferred',
      SUPERSEDED: 'Superseded',
      FAILED: 'Failed',
      STALE: 'Stale',
      INVALID: 'Invalid',
      NOT_CONFIGURED: 'Not set up',
      OBSERVED: 'Observed',
    },
    shipTitle: 'Central shipping rates',
    shipIntro: 'In dinars, per kg or per CBM. No exchange rate ever converts them.',
    ship: {
      GERMANY_LAND: 'Germany land — IQD per kg',
      CHINA_AIR: 'China air — IQD per kg',
      CHINA_SEA: 'China sea — IQD per CBM',
    },
    shipNotSet: 'Not set',
    shipUseSuggestion: (v) => `Use ${v} from the purchase screens`,
    shipEdit: 'Edit',
    shipRateLabel: 'Rate in dinars',
    ownerCardTitle: 'Exchange rates',
    ownerCardOpen: 'Open Pricing & shipping',
    ownerCardReview: (n) => `Waiting for your review: ${n}`,
    ownerCardEmpty: 'No rate approved yet',
  },
  ckb: {
    title: 'نرخەکانی ئاڵوگۆڕ',
    intro: 'نرخی کارپێکراوی ئێرە نرخی فرۆشگایە: کڕیاران نرخەکان بە دۆلار پێی دەخوێننەوە و ژمێرەرەکەش بەکاری دەهێنێت. لەم نوێکردنەوەیەدا نرخی هیچ بەرهەمێک ناگۆڕێت.',
    pairName: { USD_IQD: 'دۆلار ← دینار', EUR_USD: 'یۆرۆ ← دۆلار', CNY_USD: 'یوان ← دۆلار' },
    srcParallel: 'سەرچاوە: بازاڕی هاوتەریبی عێراق',
    srcEcb: 'سەرچاوە: بانکی ناوەندیی ئەورووپا (نرخی سەرچاوەی ڕۆژانە)',
    attribution: 'زانیارییەکان: IQWealth',
    ecbAttribution: 'زانیارییەکان: بانکی ناوەندیی ئەورووپا',
    tracking: 'بەدواداچوونی خۆکاری دۆلار',
    trackingEcb: 'بەدواداچوونی خۆکار',
    intOff: 'ڕاگیراو',
    int6: 'هەر ٦ کاتژمێر جارێک',
    int12: 'هەر ١٢ کاتژمێر جارێک',
    int24: 'هەر ٢٤ کاتژمێر جارێک',
    int6Short: '٦ کاتژمێر',
    int12Short: '١٢ کاتژمێر',
    int24Short: '٢٤ کاتژمێر',
    modeAuto: 'خۆکار',
    modeManual: 'دەستی',
    marketSell: 'نرخی فرۆشتن لە بازاڕ',
    marketBuy: 'نرخی کڕین لە بازاڕ',
    official: 'نرخی فەرمی (بانکی ناوەندیی عێراق)',
    marketEcb: 'نرخی سەرچاوەی ڕۆژانە',
    adjustment: 'ڕێکخستن (دینار بۆ هەر دۆلارێک)',
    adjustmentHint: 'بۆ نرخی فرۆشتنی بازاڕ زیاد دەکرێت؛ بۆ کەمکردنەوە ژمارەیەکی نێگەتیڤ بنووسە.',
    effective: 'نرخی کارپێکراو',
    effectiveIqd: { EUR: 'یۆرۆ بە دینار (هەژمارکراو)', CNY: 'یوان بە دینار (هەژمارکراو)' },
    computedNote: 'لە نرخی کارپێکراوی دۆلارەوە هەژمارکراوە',
    lastUpdate: 'دوایین نوێکردنەوە',
    lastCheck: 'دوایین پشکنین',
    published: 'کاتی بڵاوکردنەوەی سەرچاوە',
    lkg: 'دوایین نرخی متمانەپێکراو',
    anchor: 'دوایین نرخێک کە پەسەندت کرد',
    nextCheck: 'پشکنینی داهاتوو',
    status: 'دۆخ',
    st: {
      OK: 'کار دەکات',
      REVIEW_REQUIRED: 'پێویستی بە پێداچوونەوەی تۆیە',
      FAILED: 'وەرگرتن سەرکەوتوو نەبوو — دوایین نرخی متمانەپێکراو بەکاردێت',
      STALE: 'زانیاریی سەرچاوە کۆنە — جێبەجێ نەکرا',
      NOT_CONFIGURED: 'هێشتا ڕێکنەخراوە',
    },
    noRateYet: 'هێشتا نرخی کارپێکراو نییە',
    keyMissing: 'کلیلی IQWealth دانەنراوە، بۆیە نرخی دۆلار بە خۆکاری وەرناگیرێت تا دادەنرێت.',
    reviewTitle: 'گۆڕانێکی گەورە لە نرخدا',
    reviewFirst: 'یەکەم نرخ لە سەرچاوەوە — یەکجار پێویستی بە پەسەندکردنی تۆیە',
    reviewBody: (next, old, pct, limit) =>
      `نرخە نوێیەکە ${next} لەگەڵ نرخی کارپێکراو ${old} بە ڕێژەی ${pct}٪ جیاوازە، کە لە سنووری ${limit}٪ زیاترە. جێبەجێ نەکراوە و هیچ نرخێک ناگۆڕێت تا تۆ بڕیار دەدەیت.`,
    reviewOpen: 'پێداچوونەوە بە نرخە نوێیەکەدا بکە',
    pendingNew: 'نرخی نوێ',
    pendingCurrent: 'نرخی کارپێکراوی ئێستا',
    pendingMarket: 'نرخی بازاڕ',
    change: 'گۆڕان',
    reason: 'هۆکار',
    reasons: {
      FIRST_VALUE: () => 'یەکەم نرخ لە سەرچاوەوە',
      ANOMALY: (limit) => `بازدانێکی زیاتر لە ${limit}٪ لە یەک هەنگاودا`,
      ANOMALY_24H: (limit) => `گۆڕانێکی زیاتر لە ${limit}٪ لە ماوەی ٢٤ کاتژمێردا`,
      DRIFT: (limit) => `زیاتر لە ${limit}٪ دوور لە دوایین نرخێک کە پەسەندت کرد`,
      BACK_TO_AUTO: (limit) => `گەڕانەوە بۆ خۆکار بە جیاوازییەکی زیاتر لە ${limit}٪`,
    },
    // «لە … بەدواوە», not «لە …ەوە»: the date ends in a clock time, and a suffix glued to digits reorders.
    waitingSince: (date) => `لە ${date} بەدواوە چاوەڕێی تۆیە`,
    rejectedRecently: (rate, date) => `لە ${date} ڕەتت کردەوە ${rate} — تا ٢٤ کاتژمێر دووبارە پێشنیار ناکرێتەوە`,
    approve: 'نرخە نوێیەکە جێبەجێ بکە',
    reject: 'ڕەتی بکەرەوە و نرخی ئێستا بهێڵەوە',
    keepManual: 'نرخی ئێستام وەک دەستی بهێڵەوە',
    refresh: 'ئێستا نوێی بکەرەوە',
    refreshing: 'نوێ دەکرێتەوە…',
    refreshBudget: (used, limit) => `نوێکردنەوەکانی ئەمڕۆ: ${used} لە ${limit}`,
    manual: 'نرخێکی دەستی دابنێ',
    manualLabel: 'نرخی دەستی',
    manualSave: 'نرخە دەستییەکە جێبەجێ بکە',
    backAuto: 'گەڕانەوە بۆ خۆکار',
    manualNote: 'نوێکردنەوەی خۆکار هەرگیز نرخی دەستی ناگۆڕێت',
    useObserved: (rate) => `${rate} وەک نرخی دەستیم بەکاربهێنە`,
    observedAt: (date) => `لە ${date} بینرا`,
    confirmCurrent: 'نرخی ئێستا پشتڕاست بکەرەوە',
    confirmCurrentHint: 'نرخی ئێستا دەبێتە سەرچاوەی دوورکەوتنەوەی ڕێگەپێدراو.',
    guards: 'ڕێکخستنەکانی پاراستن',
    guardsHint: 'پاشەکەوتکردنی ئەم ڕێکخستنانە چوونەژوورەوەیەکی نوێ دەخوازێت.',
    threshold: 'ئەو گۆڕانەی پێویستی بە پێداچوونەوەی تۆیە (٪)',
    drift: 'ئەو دوورکەوتنەوەیەی ڕێگەپێدراوە لە دوایین نرخێک کە پەسەندت کرد (٪)',
    minChange: 'گوێ مەدە بە گۆڕانی بچووکتر لە (٪)',
    boundMin: 'نزمترین نرخی گونجاو',
    boundMax: 'بەرزترین نرخی گونجاو',
    guardsSave: 'ڕێکخستنەکانی پاراستن پاشەکەوت بکە',
    save: 'پاشەکەوت بکە',
    cancel: 'هەڵوەشاندنەوە',
    saved: 'پاشەکەوت کرا',
    invalidRate: 'نرخێکی سەروو سفر بنووسە، بە خاڵ بۆ کەرتەکان.',
    invalidPct: 'ڕێژەیەکی سەدی دروست بنووسە.',
    invalidAdjustment: 'ژمارەیەک دینار بنووسە، پۆزەتیڤ یان نێگەتیڤ.',
    reauth: 'بۆ پاراستنی نرخەکان، دووبارە بچۆ ژوورەوە و پاشان هەوڵ بدەرەوە',
    largeChange: 'ئەمە گۆڕانێکی گەورەیە (زیاتر لە ١٥٪). ئەگەر مەبەستت بوو، بە ڕوونی پشتڕاستی بکەرەوە.',
    largeConfirm: 'بەڵێ، گۆڕانە گەورەکە پشتڕاست دەکەمەوە',
    loadFailed: 'نەتوانرا نرخەکانی ئاڵوگۆڕ باربکرێن.',
    loading: 'نرخەکانی ئاڵوگۆڕ بار دەکرێن…',
    unknown: 'نەزانراو',
    history: 'مێژوو',
    historyTitle: 'مێژووی نرخەکانی ئاڵوگۆڕ',
    historyEmpty: 'هێشتا هیچ شتێک لە مێژوودا نییە.',
    historyAll: 'هەموو',
    loadMore: 'زیاتر پیشان بدە',
    close: 'دایبخە',
    events: {
      check: 'پشکنین',
      apply: 'نرخێکی نوێ جێبەجێ کرا',
      review_held: 'بۆ پێداچوونەوە ڕاگیرا',
      review_approved: 'پەسەندت کرد',
      review_rejected: 'ڕەتت کردەوە',
      review_cleared: 'پێداچوونەوە پێویست نەما',
      review_expired: 'ماوەی پێداچوونەوە تەواو بوو',
      manual_set: 'نرخی دەستی',
      mode_change: 'شێوازی نوێکردنەوە گۆڕا',
      settings_change: 'ڕێکخستنەکان گۆڕان',
      failure: 'وەرگرتن سەرکەوتوو نەبوو',
      observed: 'نرخێک بینرا',
      deferred: 'دواخرا بۆ دواتر',
      superseded: 'نرخێکی نوێتر جێی گرتەوە',
      commit_refused: 'پاشەکەوتکردن ڕەتکرایەوە',
      anchor_confirmed: 'نرخی ئێستات پشتڕاست کردەوە',
    },
    triggers: { cron: 'خۆکار', refresh: 'نوێکردنەوەی دەستی', owner: 'تۆ', back_to_auto: 'گەڕانەوە بۆ خۆکار' },
    checkResult: {
      APPLIED: 'جێبەجێ کرا',
      UNCHANGED: 'نەگۆڕا',
      REVIEW_HELD: 'چاوەڕێی پێداچوونەوەی تۆیە',
      DEFERRED: 'دواخرا بۆ دواتر',
      SUPERSEDED: 'نرخێکی نوێتر جێی گرتەوە',
      FAILED: 'سەرکەوتوو نەبوو',
      STALE: 'کۆنە',
      INVALID: 'نادروستە',
      NOT_CONFIGURED: 'ڕێکنەخراوە',
      OBSERVED: 'تێبینی کرا',
    },
    shipTitle: 'نرخەکانی ناردنی ناوەندی',
    shipIntro: 'بە دینار، بۆ هەر کیلۆیەک یان هەر مەترێکی سێجا. هیچ نرخێکی ئاڵوگۆڕ نایانگۆڕێت.',
    ship: {
      GERMANY_LAND: 'ئەڵمانیا بە وشکانی — دینار بۆ هەر کیلۆیەک',
      CHINA_AIR: 'چین بە ئاسمان — دینار بۆ هەر کیلۆیەک',
      CHINA_SEA: 'چین بە دەریا — دینار بۆ هەر مەتری سێجا',
    },
    shipNotSet: 'دانەنراوە',
    shipUseSuggestion: (v) => `${v} لە شاشەی کڕینەکانەوە بەکاربهێنە`,
    shipEdit: 'دەستکاری',
    shipRateLabel: 'نرخ بە دینار',
    ownerCardTitle: 'نرخەکانی ئاڵوگۆڕ',
    ownerCardOpen: '«نرخدانان و ناردنی بەرهەم» بکەرەوە',
    ownerCardReview: (n) => `چاوەڕێی پێداچوونەوەی تۆن: ${n}`,
    ownerCardEmpty: 'هێشتا هیچ نرخێک پەسەند نەکراوە',
  },
};

export const fxStrings = (lang: Lang): FxStrings => FX_STRINGS[lang] ?? FX_STRINGS.ar;

/** The event's words, or the code itself when a later push adds one this client does not know. */
export const fxEventLabel = (s: FxStrings, event: string) => s.events[event] ?? event;
