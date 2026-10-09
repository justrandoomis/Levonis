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
type Three = (a: string, b: string, c: string) => string;

/** How an error code of the history or the card is said (UX review #11): a group, never the raw code. */
export type FxErrorGroup = 'key' | 'keyRejected' | 'quota' | 'limit' | 'timeout' | 'unreachable' | 'stale' | 'invalid' | 'bounds' | 'rejected' | 'save' | 'unverified' | 'other';
/** What «تحديث الآن» found, from the server's report (UX review #4). */
export type FxRefreshOutcome = 'applied' | 'held' | 'unchanged' | 'failed' | 'limit' | 'busy' | 'observed' | 'unverified';

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
  /** Every interval takes its hours as a figure written by the panel (`fxCount`), never a digit baked in (UX review #10). */
  int6: One;
  int12: One;
  int24: One;
  int6Short: One;
  int12Short: One;
  int24Short: One;
  modeAuto: string;
  modeManual: string;
  marketSell: string;
  marketBuy: string;
  official: string;
  marketEcb: string;
  /** USD/IQD `market_adjustment_iqd`: a FIXED number of dinars per dollar, never a percentage (owner decision 5). */
  adjustment: string;
  adjustmentHint: string;
  /** «market + adjustment = effective», each figure the server's, shown only when it holds (`formula_holds`). */
  formula: Three;
  /** A manual rate is final: the adjustment is not added to it. */
  manualFinal: string;
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
  /** The first-value sheet's body: what approving does — not the title again (UX review #15). */
  reviewFirstBody: string;
  reviewBody: (next: string, old: string, pct: string, limit: string) => string;
  reviewOpen: string;
  pendingNew: string;
  pendingCurrent: string;
  pendingMarket: string;
  change: string;
  reason: string;
  reasons: Readonly<Record<FxPendingReason, Two>>;
  /** A held value's reason in a few words, for the history (no limit). */
  reasonName: Readonly<Record<FxPendingReason, string>>;
  waitingSince: One;
  rejectedRecently: Three;
  approve: string;
  reject: string;
  keepManual: string;
  /** Said before the act, beside it: keep-as-manual changes the mode, so it asks for a fresh sign-in. */
  keepManualHint: string;
  refresh: string;
  refreshing: string;
  refreshBudget: Two;
  refreshOutcome: Readonly<Record<FxRefreshOutcome, string>>;
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
  /** The way through a fresh-sign-in refusal (UX review #2). */
  signInAgain: string;
  /** 409 PRICING_CHANGED on this panel: it already reloaded itself (UX review #5). */
  panelChanged: string;
  largeChange: One;
  largeConfirm: string;
  loadFailed: string;
  loading: string;
  unknown: string;
  /** A pair with no value yet, in one line instead of eight «غير معروف» (UX review #15). */
  notSetUp: One;
  notSetUpNoDate: string;
  errorText: Readonly<Record<FxErrorGroup, string>>;
  /** The history's old → new lines (owner decision 10): the names of the two settings no other label covers. */
  fieldMode: string;
  fieldInterval: string;
  /** The adjustment in force on a history row, in one word. */
  adjustmentShort: string;
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
    intro: 'السعر المعتمد هو سعر المتجر: به تُعرض الأسعار بالدولار للزبائن، وتستخدمه حاسبة التسعير. تغيير سعر الصرف هنا لا يغيّر أسعار المنتجات حاليًا.',
    pairName: { USD_IQD: 'الدولار ← الدينار', EUR_USD: 'اليورو ← الدولار', CNY_USD: 'اليوان ← الدولار' },
    srcParallel: 'المصدر: السوق الموازية العراقية',
    srcEcb: 'المصدر: البنك المركزي الأوروبي (السعر المرجعي اليومي)',
    attribution: 'البيانات: IQWealth',
    ecbAttribution: 'البيانات: البنك المركزي الأوروبي',
    tracking: 'التتبع التلقائي للدولار',
    trackingEcb: 'التتبع التلقائي',
    intOff: 'متوقف',
    int6: (n) => `كل ${n} ساعات`,
    int12: (n) => `كل ${n} ساعة`,
    int24: (n) => `كل ${n} ساعة`,
    int6Short: (n) => `${n} ساعات`,
    int12Short: (n) => `${n} ساعة`,
    int24Short: (n) => `${n} ساعة`,
    modeAuto: 'تلقائي',
    modeManual: 'يدوي',
    marketSell: 'سعر البيع في السوق',
    marketBuy: 'سعر الشراء في السوق',
    official: 'السعر الرسمي (البنك المركزي العراقي)',
    marketEcb: 'السعر المرجعي اليومي',
    adjustment: 'زيادة ثابتة على سعر السوق (دينار لكل دولار)',
    adjustmentHint: 'مبلغ ثابت بالدينار يُضاف إلى سعر بيع الدولار في السوق، وليس نسبة. اكتب رقمًا سالبًا للخصم.',
    formula: (market, adj, effective) => `سعر السوق ${market} + الزيادة ${adj} = السعر المعتمد ${effective}`,
    manualFinal: 'السعر اليدوي نهائي، ولا تُضاف إليه الزيادة.',
    effective: 'السعر المعتمد',
    effectiveIqd: { EUR: 'اليورو بالدينار (محسوب)', CNY: 'اليوان بالدينار (محسوب)' },
    computedNote: 'محسوب من سعر الدولار المعتمد',
    lastUpdate: 'آخر تحديث',
    lastCheck: 'آخر فحص',
    published: 'وقت نشر المصدر',
    lkg: 'آخر سعر موثوق',
    anchor: 'آخر سعر أكّدته',
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
    keyMissing: 'مفتاح IQWealth غير مضبوط، فلا يُجلب سعر الدولار تلقائيًا. يضبطه من يدير خادم المتجر، سرًّا في إعدادات Cloudflare؛ وحتى ذلك الحين عيّن سعرًا يدويًا.',
    reviewTitle: 'تغيّر كبير في السعر',
    reviewFirst: 'أول سعر من المصدر — يحتاج اعتمادك مرة واحدة',
    reviewFirstBody: 'هذا أول سعر يصل من المصدر. اعتماده يجعله السعر المعتمد ومرجع الابتعاد المسموح، ومن بعده يُتابَع المصدر تلقائيًا ضمن حدود الحماية. لا يتغيّر شيء حتى تقرر.',
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
      ANOMALY_24H: (limit, hours) => `تغيّر أكبر من ${limit}٪ خلال ${hours} ساعة`,
      DRIFT: (limit) => `ابتعاد أكبر من ${limit}٪ عن آخر سعر أكّدته`,
      BACK_TO_AUTO: (limit) => `العودة إلى التلقائي بفرق أكبر من ${limit}٪`,
    },
    reasonName: {
      FIRST_VALUE: 'أول سعر من المصدر',
      ANOMALY: 'قفزة في خطوة واحدة',
      ANOMALY_24H: 'تغيّر كبير خلال يوم',
      DRIFT: 'ابتعاد عن آخر سعر أكّدته',
      BACK_TO_AUTO: 'العودة إلى التلقائي',
    },
    waitingSince: (date) => `بانتظارك منذ ${date}`,
    rejectedRecently: (rate, date, hours) => `رفضتَ ${rate} في ${date} — لن يُعرض عليك مجددًا قبل مرور ${hours} ساعة`,
    approve: 'اعتماد السعر الجديد',
    reject: 'رفض والإبقاء على الحالي',
    keepManual: 'أبقِ سعري الحالي يدويًا',
    keepManualHint: '«أبقِ سعري الحالي يدويًا» يوقف التتبع التلقائي، فيطلب تسجيل دخول حديثًا.',
    refresh: 'تحديث الآن',
    refreshing: 'جارٍ التحديث…',
    refreshBudget: (used, limit) => `التحديثات اليوم: ${used} من ${limit}`,
    refreshOutcome: {
      applied: 'طُبّق سعر جديد.',
      held: 'وصل سعر جديد يحتاج مراجعتك.',
      unchanged: 'تم الفحص — لا تغيير.',
      failed: 'تعذّر جلب سعر — بقي آخر سعر موثوق.',
      limit: 'بلغت حد الفحص لليوم — يعود الفحص التلقائي في موعده.',
      busy: 'يجري فحص آخر الآن — أعد المحاولة بعد لحظات.',
      observed: 'رُصد سعر السوق — سعرك اليدوي لم يتغيّر.',
      unverified: 'تعذّر التحقق من حدود اليوم — لم يُطبَّق سعر، ويُعاد في الفحص القادم.',
    },
    manual: 'تعيين سعر يدوي',
    manualLabel: 'السعر اليدوي',
    manualSave: 'اعتماد السعر اليدوي',
    backAuto: 'العودة إلى التلقائي',
    manualNote: 'السعر اليدوي لا يغيّره التحديث التلقائي أبدًا',
    useObserved: (rate) => `استخدم ${rate} سعرًا يدويًا`,
    observedAt: (date) => `رُصد في ${date}`,
    confirmCurrent: 'تأكيد السعر الحالي',
    confirmCurrentHint: 'يصبح السعر الحالي مرجع الابتعاد المسموح. يطلب تسجيل دخول حديثًا.',
    guards: 'إعدادات الحماية',
    guardsHint: 'حفظ هذه الإعدادات يطلب تسجيل دخول حديثًا.',
    threshold: 'التغيّر الذي يحتاج مراجعتك (٪)',
    drift: 'الابتعاد المسموح عن آخر سعر أكّدته (٪)',
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
    signInAgain: 'سجّل الدخول مجددًا',
    panelChanged: 'تغيّرت الأسعار منذ فتحتَ اللوحة، فحدّثناها — راجعها ثم أعد المحاولة.',
    largeChange: (pct) => `هذا تغيير كبير (أكثر من ${pct}٪). أكّده صراحةً إن كان مقصودًا؛ وسيُطلب منك تسجيل دخول حديث.`,
    largeConfirm: 'نعم، أؤكد التغيير الكبير',
    loadFailed: 'تعذّر تحميل أسعار الصرف.',
    loading: 'جارٍ تحميل أسعار الصرف…',
    unknown: 'غير معروف',
    notSetUp: (date) => `لم يصل أول سعر بعد. الفحص القادم: ${date}؛ وحين يصل يُعرض عليك لتعتمده.`,
    notSetUpNoDate: 'لم يصل أول سعر بعد. اضغط «تحديث الآن» أو عيّن سعرًا يدويًا.',
    errorText: {
      key: 'مفتاح IQWealth غير مضبوط',
      keyRejected: 'رفض IQWealth المفتاح',
      quota: 'نفدت حصة المصدر لليوم',
      limit: 'بلغ حد الفحص لليوم',
      timeout: 'لم يُجب المصدر في الوقت',
      unreachable: 'تعذّر الوصول إلى المصدر أو قراءة جوابه',
      stale: 'بيانات المصدر قديمة',
      invalid: 'أرسل المصدر رقمًا غير صالح — لم يُطبَّق',
      bounds: 'خارج الحدود المعقولة — لم يُطبَّق',
      rejected: 'قريب من سعر رفضته — لن يُعرض الآن',
      save: 'تعذّر الحفظ — يُعاد في الفحص القادم',
      unverified: 'تعذّر التحقق من حدود اليوم — لم يُطبَّق، ويُعاد في الفحص القادم',
      other: 'سبب آخر',
    },
    fieldMode: 'طريقة التحديث',
    fieldInterval: 'تكرار الفحص',
    adjustmentShort: 'الزيادة',
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
    intro: "The effective rate is the shop's rate: customers see dollar prices at it, and the pricing calculator uses it. Changing an exchange rate here does not change product prices for now.",
    pairName: { USD_IQD: 'USD → IQD', EUR_USD: 'EUR → USD', CNY_USD: 'CNY → USD' },
    srcParallel: 'Source: Iraqi parallel market',
    srcEcb: 'Source: European Central Bank (daily reference rate)',
    attribution: 'Data: IQWealth',
    ecbAttribution: 'Data: European Central Bank',
    tracking: 'Automatic USD tracking',
    trackingEcb: 'Automatic tracking',
    intOff: 'Off',
    int6: (n) => `Every ${n} hours`,
    int12: (n) => `Every ${n} hours`,
    int24: (n) => `Every ${n} hours`,
    int6Short: (n) => `${n} hours`,
    int12Short: (n) => `${n} hours`,
    int24Short: (n) => `${n} hours`,
    modeAuto: 'Automatic',
    modeManual: 'Manual',
    marketSell: 'Market sell',
    marketBuy: 'Market buy',
    official: 'Official rate (CBI)',
    marketEcb: 'Daily reference rate',
    adjustment: 'Market adjustment (fixed IQD per USD)',
    adjustmentHint: 'A fixed number of dinars added to the market sell rate of one dollar — not a percentage. Type a negative number to lower it.',
    formula: (market, adj, effective) => `Market ${market} + adjustment ${adj} = effective ${effective}`,
    manualFinal: 'A manual rate is final; the adjustment is not added to it.',
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
    keyMissing: "The IQWealth key is not set, so the dollar rate is not fetched automatically. Whoever runs the shop's server sets it, as a secret in the Cloudflare settings; until then, set a manual rate.",
    reviewTitle: 'Large rate change',
    reviewFirst: 'First value from the source — needs your approval once',
    reviewFirstBody: 'This is the first value from the source. Approving it makes it the effective rate and the reference for the allowed drift; after that the source is followed automatically, within the safety limits. Nothing changes until you decide.',
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
      ANOMALY_24H: (limit, hours) => `A change of more than ${limit}% within ${hours} hours`,
      DRIFT: (limit) => `More than ${limit}% away from the last rate you confirmed`,
      BACK_TO_AUTO: (limit) => `Back to automatic with a difference above ${limit}%`,
    },
    reasonName: {
      FIRST_VALUE: 'First value from the source',
      ANOMALY: 'A jump in one step',
      ANOMALY_24H: 'A large change within a day',
      DRIFT: 'Drift from the last rate you confirmed',
      BACK_TO_AUTO: 'Back to automatic',
    },
    waitingSince: (date) => `Waiting for you since ${date}`,
    rejectedRecently: (rate, date, hours) => `You rejected ${rate} on ${date} — it will not be offered again for ${hours} hours`,
    approve: 'Apply the new rate',
    reject: 'Reject and keep the current rate',
    keepManual: 'Keep my current rate as manual',
    keepManualHint: '“Keep my current rate as manual” turns automatic tracking off, so it asks for a recent sign-in.',
    refresh: 'Refresh now',
    refreshing: 'Refreshing…',
    refreshBudget: (used, limit) => `Refreshes today: ${used} of ${limit}`,
    refreshOutcome: {
      applied: 'A new rate was applied.',
      held: 'A new rate is waiting for your review.',
      unchanged: 'Checked — no change.',
      failed: 'A rate could not be fetched — the last known good rate stays.',
      limit: "Today's check limit is reached — the automatic check runs at its usual time.",
      busy: 'Another check is running — try again in a moment.',
      observed: 'The market rate was observed — your manual rate did not change.',
      unverified: "The day's limits could not be checked — nothing applied; checked again next time.",
    },
    manual: 'Set a manual rate',
    manualLabel: 'Manual rate',
    manualSave: 'Apply the manual rate',
    backAuto: 'Back to automatic',
    manualNote: 'Automatic updates never change a manual rate',
    useObserved: (rate) => `Use ${rate} as my manual rate`,
    observedAt: (date) => `Observed on ${date}`,
    confirmCurrent: 'Confirm the current rate',
    confirmCurrentHint: 'The current rate becomes the reference for the allowed drift. Asks for a recent sign-in.',
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
    signInAgain: 'Sign in again',
    panelChanged: 'The rates changed since you opened the panel, so we reloaded it — check them, then try again.',
    largeChange: (pct) => `This is a large change (more than ${pct}%). Confirm it explicitly if you meant it; it also asks for a recent sign-in.`,
    largeConfirm: 'Yes, confirm the large change',
    loadFailed: 'Could not load the exchange rates.',
    loading: 'Loading the exchange rates…',
    unknown: 'Unknown',
    notSetUp: (date) => `No value has arrived yet. Next check: ${date}. When it arrives, it is offered to you for approval.`,
    notSetUpNoDate: 'No value has arrived yet. Press “Refresh now” or set a manual rate.',
    errorText: {
      key: 'The IQWealth key is not set',
      keyRejected: 'IQWealth refused the key',
      quota: "The source's daily quota is used up",
      limit: "Today's check limit was reached",
      timeout: 'The source did not answer in time',
      unreachable: 'The source could not be reached or read',
      stale: "The source's data is old",
      invalid: 'The source sent an invalid figure — not applied',
      bounds: 'Outside the plausible range — not applied',
      rejected: 'Close to a rate you rejected — not offered for now',
      save: 'Could not be saved — retried at the next check',
      unverified: "The day's limits could not be checked — not applied; checked again next time",
      other: 'Another reason',
    },
    fieldMode: 'Update mode',
    fieldInterval: 'Check interval',
    adjustmentShort: 'Adjustment',
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
    intro: 'نرخی کارپێکراو نرخی فرۆشگایە: نرخەکان بە دۆلار پێی بۆ کڕیاران پیشان دەدرێن و ژمێرەری نرخدانانیش بەکاری دەهێنێت. گۆڕینی نرخی ئاڵوگۆڕ لێرە بۆ ئێستا نرخی بەرهەمەکان ناگۆڕێت.',
    pairName: { USD_IQD: 'دۆلار ← دینار', EUR_USD: 'یۆرۆ ← دۆلار', CNY_USD: 'یوان ← دۆلار' },
    srcParallel: 'سەرچاوە: بازاڕی هاوتەریبی عێراق',
    srcEcb: 'سەرچاوە: بانکی ناوەندیی ئەورووپا (نرخی سەرچاوەی ڕۆژانە)',
    attribution: 'زانیارییەکان: IQWealth',
    ecbAttribution: 'زانیارییەکان: بانکی ناوەندیی ئەورووپا',
    tracking: 'بەدواداچوونی خۆکاری دۆلار',
    trackingEcb: 'بەدواداچوونی خۆکار',
    intOff: 'ڕاگیراو',
    int6: (n) => `هەر ${n} کاتژمێر جارێک`,
    int12: (n) => `هەر ${n} کاتژمێر جارێک`,
    int24: (n) => `هەر ${n} کاتژمێر جارێک`,
    int6Short: (n) => `${n} کاتژمێر`,
    int12Short: (n) => `${n} کاتژمێر`,
    int24Short: (n) => `${n} کاتژمێر`,
    modeAuto: 'خۆکار',
    modeManual: 'دەستی',
    marketSell: 'نرخی فرۆشتن لە بازاڕ',
    marketBuy: 'نرخی کڕین لە بازاڕ',
    official: 'نرخی فەرمی (بانکی ناوەندیی عێراق)',
    marketEcb: 'نرخی سەرچاوەی ڕۆژانە',
    adjustment: 'زیادەی جێگیر لەسەر نرخی بازاڕ (دینار بۆ هەر دۆلارێک)',
    adjustmentHint: 'بڕێکی جێگیری دینارە کە بۆ نرخی فرۆشتنی یەک دۆلار لە بازاڕدا زیاد دەکرێت — ڕێژەی سەدی نییە. بۆ کەمکردنەوە ژمارەیەکی نێگەتیڤ بنووسە.',
    formula: (market, adj, effective) => `نرخی بازاڕ ${market} + زیادە ${adj} = نرخی کارپێکراو ${effective}`,
    manualFinal: 'نرخی دەستی کۆتاییە و زیادەکەی بۆ زیاد ناکرێت.',
    effective: 'نرخی کارپێکراو',
    effectiveIqd: { EUR: 'یۆرۆ بە دینار (هەژمارکراو)', CNY: 'یوان بە دینار (هەژمارکراو)' },
    computedNote: 'لە نرخی کارپێکراوی دۆلارەوە هەژمارکراوە',
    lastUpdate: 'دوایین نوێکردنەوە',
    lastCheck: 'دوایین پشکنین',
    published: 'کاتی بڵاوکردنەوەی سەرچاوە',
    lkg: 'دوایین نرخی متمانەپێکراو',
    anchor: 'دوایین نرخێک کە پشتڕاستت کردەوە',
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
    keyMissing: 'کلیلی IQWealth دانەنراوە، بۆیە نرخی دۆلار بە خۆکاری وەرناگیرێت. ئەو کەسەی سێرڤەری فرۆشگا بەڕێوە دەبات وەک نهێنییەک لە ڕێکخستنەکانی Cloudflare دایدەنێت؛ تا ئەو کاتە نرخێکی دەستی دابنێ.',
    reviewTitle: 'گۆڕانێکی گەورە لە نرخدا',
    reviewFirst: 'یەکەم نرخ لە سەرچاوەوە — یەکجار پێویستی بە پەسەندکردنی تۆیە',
    reviewFirstBody: 'ئەمە یەکەم نرخە کە لە سەرچاوەوە گەیشتووە. پەسەندکردنی دەیکاتە نرخی کارپێکراو و سەرچاوەی دوورکەوتنەوەی ڕێگەپێدراو؛ دوای ئەوە سەرچاوەکە بە خۆکاری و لە نێو سنوورەکانی پاراستندا بەدواداچوونی بۆ دەکرێت. هیچ شتێک ناگۆڕێت تا تۆ بڕیار دەدەیت.',
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
      ANOMALY_24H: (limit, hours) => `گۆڕانێکی زیاتر لە ${limit}٪ لە ماوەی ${hours} کاتژمێردا`,
      DRIFT: (limit) => `زیاتر لە ${limit}٪ دوور لە دوایین نرخێک کە پشتڕاستت کردەوە`,
      BACK_TO_AUTO: (limit) => `گەڕانەوە بۆ خۆکار بە جیاوازییەکی زیاتر لە ${limit}٪`,
    },
    reasonName: {
      FIRST_VALUE: 'یەکەم نرخ لە سەرچاوەوە',
      ANOMALY: 'بازدانێک لە یەک هەنگاودا',
      ANOMALY_24H: 'گۆڕانێکی گەورە لە ماوەی ڕۆژێکدا',
      DRIFT: 'دوورکەوتنەوە لە دوایین نرخێک کە پشتڕاستت کردەوە',
      BACK_TO_AUTO: 'گەڕانەوە بۆ خۆکار',
    },
    // «لە … بەدواوە», not «لە …ەوە»: the date ends in a clock time, and a suffix glued to digits reorders.
    waitingSince: (date) => `لە ${date} بەدواوە چاوەڕێی تۆیە`,
    // The object before the verb («نرخی … ڕەتت کردەوە»), as Sorani orders it (UX review #15).
    rejectedRecently: (rate, date, hours) => `نرخی ${rate} لە ${date} ڕەتت کردەوە — تا ${hours} کاتژمێر دووبارە پێشنیار ناکرێتەوە`,
    approve: 'نرخە نوێیەکە جێبەجێ بکە',
    reject: 'ڕەتی بکەرەوە و نرخی ئێستا بهێڵەوە',
    keepManual: 'نرخی ئێستام وەک دەستی بهێڵەوە',
    keepManualHint: '«نرخی ئێستام وەک دەستی بهێڵەوە» بەدواداچوونی خۆکار ڕادەگرێت، بۆیە چوونەژوورەوەیەکی نوێ دەخوازێت.',
    refresh: 'ئێستا نوێی بکەرەوە',
    refreshing: 'نوێ دەکرێتەوە…',
    refreshBudget: (used, limit) => `نوێکردنەوەکانی ئەمڕۆ: ${used} لە ${limit}`,
    refreshOutcome: {
      applied: 'نرخێکی نوێ جێبەجێ کرا.',
      held: 'نرخێکی نوێ چاوەڕێی پێداچوونەوەی تۆیە.',
      unchanged: 'پشکنرا — هیچ گۆڕانێک نییە.',
      failed: 'نەتوانرا نرخێک وەربگیرێت — دوایین نرخی متمانەپێکراو ماوەتەوە.',
      limit: 'سنووری پشکنینی ئەمڕۆ تەواو بوو — پشکنینی خۆکار لە کاتی خۆیدا دەکرێت.',
      busy: 'پشکنینێکی تر ئێستا دەکرێت — دوای چەند چرکەیەک دووبارە هەوڵ بدەرەوە.',
      observed: 'نرخی بازاڕ بینرا — نرخە دەستییەکەت نەگۆڕا.',
      unverified: 'سنوورەکانی ڕۆژ پشکنین نەکران — هیچ نرخێک جێبەجێ نەکرا، لە پشکنینی داهاتوودا دووبارە دەکرێتەوە.',
    },
    manual: 'نرخێکی دەستی دابنێ',
    manualLabel: 'نرخی دەستی',
    manualSave: 'نرخە دەستییەکە جێبەجێ بکە',
    backAuto: 'گەڕانەوە بۆ خۆکار',
    manualNote: 'نوێکردنەوەی خۆکار هەرگیز نرخی دەستی ناگۆڕێت',
    useObserved: (rate) => `${rate} وەک نرخی دەستیم بەکاربهێنە`,
    observedAt: (date) => `لە ${date} بینرا`,
    confirmCurrent: 'نرخی ئێستا پشتڕاست بکەرەوە',
    confirmCurrentHint: 'نرخی ئێستا دەبێتە سەرچاوەی دوورکەوتنەوەی ڕێگەپێدراو. چوونەژوورەوەیەکی نوێ دەخوازێت.',
    guards: 'ڕێکخستنەکانی پاراستن',
    guardsHint: 'پاشەکەوتکردنی ئەم ڕێکخستنانە چوونەژوورەوەیەکی نوێ دەخوازێت.',
    threshold: 'ئەو گۆڕانەی پێویستی بە پێداچوونەوەی تۆیە (٪)',
    drift: 'ئەو دوورکەوتنەوەیەی ڕێگەپێدراوە لە دوایین نرخێک کە پشتڕاستت کردەوە (٪)',
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
    signInAgain: 'دووبارە بچۆ ژوورەوە',
    panelChanged: 'نرخەکان لەو کاتەوەی تابلۆکەت کردەوە گۆڕاون، بۆیە نوێمان کردەوە — سەیریان بکە و پاشان دووبارە هەوڵ بدەرەوە.',
    largeChange: (pct) => `ئەمە گۆڕانێکی گەورەیە (زیاتر لە ${pct}٪). ئەگەر مەبەستت بوو، بە ڕوونی پشتڕاستی بکەرەوە؛ چوونەژوورەوەیەکی نوێش دەخوازێت.`,
    largeConfirm: 'بەڵێ، گۆڕانە گەورەکە پشتڕاست دەکەمەوە',
    loadFailed: 'نەتوانرا نرخەکانی ئاڵوگۆڕ باربکرێن.',
    loading: 'نرخەکانی ئاڵوگۆڕ بار دەکرێن…',
    unknown: 'نەزانراو',
    notSetUp: (date) => `هێشتا یەکەم نرخ نەگەیشتووە. پشکنینی داهاتوو: ${date}؛ کاتێک گەیشت، بۆ پەسەندکردن پیشانت دەدرێت.`,
    notSetUpNoDate: 'هێشتا یەکەم نرخ نەگەیشتووە. «ئێستا نوێی بکەرەوە» دابگرە یان نرخێکی دەستی دابنێ.',
    errorText: {
      key: 'کلیلی IQWealth دانەنراوە',
      keyRejected: 'IQWealth کلیلەکەی ڕەتکردەوە',
      quota: 'بەشی ڕۆژانەی سەرچاوە تەواو بوو',
      limit: 'سنووری پشکنینی ئەمڕۆ تەواو بوو',
      timeout: 'سەرچاوە لە کاتی خۆیدا وەڵامی نەدایەوە',
      unreachable: 'نەتوانرا بگەینە سەرچاوە یان وەڵامەکەی بخوێنینەوە',
      stale: 'زانیاریی سەرچاوە کۆنە',
      invalid: 'سەرچاوە ژمارەیەکی نادروستی نارد — جێبەجێ نەکرا',
      bounds: 'لە دەرەوەی مەودای گونجاوە — جێبەجێ نەکرا',
      rejected: 'نزیکە لە نرخێک کە ڕەتت کردەوە — بۆ ئێستا پێشنیار ناکرێت',
      save: 'پاشەکەوت نەکرا — لە پشکنینی داهاتوودا دووبارە هەوڵ دەدرێتەوە',
      unverified: 'سنوورەکانی ڕۆژ پشکنین نەکران — جێبەجێ نەکرا، لە پشکنینی داهاتوودا دووبارە دەکرێتەوە',
      other: 'هۆکارێکی تر',
    },
    fieldMode: 'شێوازی نوێکردنەوە',
    fieldInterval: 'ماوەی نێوان پشکنینەکان',
    adjustmentShort: 'زیادە',
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

/**
 * An error code of the history or the card, said in words (UX review #11):
 * the server writes codes from a closed family (worker/lib/fx/providers,
 * decide.ts, scheduler.ts); a code this client does not know is «another
 * reason», never printed raw.
 */
export function fxErrorGroup(code: string): FxErrorGroup {
  if (code === 'KEY_MISSING' || code === 'KEY_MALFORMED') return 'key';
  if (code === 'KEY_REJECTED') return 'keyRejected';
  if (code === 'QUOTA') return 'quota';
  if (code === 'PROVIDER_BUDGET') return 'limit';
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'NETWORK' || code === 'REDIRECT_REFUSED' || code === 'TOO_LARGE' || code === 'PARSE' || /^HTTP_\d{3}$/.test(code)) return 'unreachable';
  if (code === 'STALE' || code === 'FX_TOO_OLD' || code === 'FX_NOT_MONOTONIC') return 'stale';
  if (code === 'FX_RATE_OUT_OF_BOUNDS') return 'bounds';
  if (code === 'FX_REJECTED_RECENTLY') return 'rejected';
  if (code === 'FX_FUTURE' || code === 'FX_UNIT_CHANGED' || code === 'FX_PUBLICATION_CONFLICT' || code.startsWith('FX_INVALID_')) return 'invalid';
  if (code === 'FX_GUARD_UNREAD') return 'unverified';
  if (code === 'COMMIT_REFUSED' || code === 'FX_COMMIT_CONFLICT' || code === 'FX_STATEMENT_BUDGET' || code === 'FX_DERIVED_STALE' || code === 'FX_VERSION_DISCIPLINE' || code === 'FX_DECIDE_FAILED') return 'save';
  return 'other';
}

/** A history row's code in words: a held value's reason by name, any other code by its group. */
export function fxCodeText(s: FxStrings, code: string): string {
  if (code in s.reasonName) return s.reasonName[code as FxPendingReason];
  return s.errorText[fxErrorGroup(code)];
}

/** «الدولار ← الدينار» → «الدولار»: the pair's source currency, as the pair's own name writes it (the history filter). */
export const pairShortName = (name: string): string => name.split(/\s*[←→]\s*/)[0] || name;

/** The event's words, or the code itself when a later push adds one this client does not know. */
export const fxEventLabel = (s: FxStrings, event: string) => s.events[event] ?? event;
