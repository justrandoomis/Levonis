/**
 * «الأشخاص» — ONE PERSON, ONE PICTURE, IN THREE LANGUAGES (owner request
 * 2026-11-09; DECISIONS row 304). The words of worker/lib/personFinance.ts on
 * the owner's people screens and on the person's own «أرباحي».
 *
 * Every string exists in Arabic, English and Sorani; the Sorani is its own,
 * never the Arabic (docs/DECISIONS.md row 183, tests/personFinanceView.test.ts).
 * Labels are neutral (no "you" / "he"), so the owner and the person read the
 * same words. A count that would need Arabic number agreement is written after
 * the phrase, in brackets. Pure: no React, no request.
 */
import type { Language } from '../translations';

export type HoldReasonKey = 'collection' | 'cost' | 'recalculation' | 'cancelled' | 'funding' | 'agreement';

export interface PersonFinanceStrings {
  peopleHint: string;
  investor: string;
  works: string;
  earnedTotal: string;
  fromInvesting: string;
  fromWork: string;
  availableNow: string;
  paidOut: string;
  heldNow: string;
  investmentTitle: string;
  capitalPutIn: string;
  inGoods: string;
  backFromSales: string;
  heldOf: string;
  availableOf: string;
  reservedNow: string;
  earningsPart: string;
  soldHeld: string;
  returned: string;
  unusedReturned: string;
  capitalLoss: string;
  share: string;
  byAgreement: string;
  defaultShare: string;
  noAgreements: string;
  profitEarned: string;
  roi: string;
  roiHint: string;
  holdsTitle: string;
  workTitle: string;
  active: string;
  paused: string;
  archived: string;
  since: string;
  resumesOn: string;
  wagesEarned: string;
  wagesPaid: string;
  wagesAvailable: string;
  wagesHeld: string;
  agreementsTitle: string;
  capital: string;
  heldSales: string;
  details: string;
  period: string;
  periodWages: string;
  periodProfit: string;
  settings: string;
  allAgreements: (n: number) => string;
  agreementUnits: (received: number, sold: number, stock: number) => string;
  unitsLine: (stock: number, orders: number, sold: number, notReceived: number) => string;
  moreSales: (n: number) => string;
  hold: Record<HoldReasonKey, (n: number) => string>;
  /** The same reasons for a group of settled sales, without a count. */
  holdGroup: Record<HoldReasonKey, string>;
  capitalDebt: string;
  notRecovered: string;
  holdAction: Partial<Record<HoldReasonKey, string>>;
  wageAction: Partial<Record<HoldReasonKey, string>>;
  wageHold: Partial<Record<HoldReasonKey, (n: number) => string>>;
  profitUnknown: (n: number) => string;
  wholeAgreement: string;
}

/** «بيع واحد ينتظر …» / «مبيعات تنتظر … (4)»: singular and plural agree, the count follows. */
const ar = (one: string, many: string) => (n: number) => (n === 1 ? one : `${many} (${n})`);
const en = (noun: string, rest: string) => (n: number) => `${n} ${noun}${n === 1 ? '' : 's'} ${rest}`;

export const PERSON_FINANCE_STRINGS: Readonly<Record<Language, PersonFinanceStrings>> = {
  ar: {
    peopleHint: 'لكل شخص: رأس ماله وأين هو الآن، حصته من الربح، ما كسبه من الاستثمار والعمل، وما يستطيع سحبه الآن.',
    investor: 'مستثمر',
    works: 'يعمل',
    earnedTotal: 'المكتسب من الاستثمار والعمل',
    fromInvesting: 'من الاستثمار',
    fromWork: 'من العمل',
    availableNow: 'متاح للسحب الآن',
    paidOut: 'المدفوع حتى الآن',
    heldNow: 'محجوز مؤقتًا',
    investmentTitle: 'الاستثمار',
    capitalPutIn: 'رأس المال المدفوع',
    inGoods: 'في المخزون أو في طلبات لم تُسلَّم',
    backFromSales: 'رجع من المبيعات',
    heldOf: 'منه محجوز',
    availableOf: 'منه متاح للسحب',
    reservedNow: 'محجوز لطلب سحب',
    earningsPart: 'أرباح',
    soldHeld: 'بيع وينتظر الإفراج',
    returned: 'أُعيد إلى الحساب',
    unusedReturned: 'منه مبلغ لم يُستخدم في الشراء',
    capitalLoss: 'خسارة رأس المال',
    share: 'حصة الربح',
    byAgreement: 'حسب الاتفاق',
    defaultShare: 'الافتراضي للاتفاقات الجديدة',
    noAgreements: 'لا اتفاقات بعد.',
    profitEarned: 'الربح المكتسب',
    roi: 'العائد على رأس المال',
    roiHint: 'الربح المكتسب ÷ رأس المال المدفوع',
    holdsTitle: 'لماذا هو محجوز',
    workTitle: 'العمل',
    active: 'يعمل',
    paused: 'متوقف',
    archived: 'محذوف',
    since: 'منذ',
    resumesOn: 'يعود للعمل في',
    wagesEarned: 'الأجور المكتسبة',
    wagesPaid: 'المدفوع',
    wagesAvailable: 'المتاح',
    wagesHeld: 'بانتظار اكتمال الحساب',
    agreementsTitle: 'الاتفاقات',
    capital: 'رأس المال',
    heldSales: 'مبيعات محجوزة',
    details: 'التفاصيل',
    period: 'في الفترة المختارة',
    periodWages: 'أجور',
    periodProfit: 'ربح استثمار',
    settings: 'الإعدادات',
    allAgreements: (n) => (n === 1 ? 'في الاتفاق' : `في كل الاتفاقات (${n})`),
    agreementUnits: (received, sold, stock) => `مستلم ${received} · مباع ${sold} · في المخزون ${stock}`,
    unitsLine: (stock, orders, sold, notReceived) => `في المخزون ${stock} · في طلبات لم تُسلَّم ${orders} · مباع ${sold}${notReceived ? ` · لم يصل ${notReceived}` : ''}`,
    moreSales: (n) => `و${n} أخرى`,
    hold: {
      collection: ar('بيع واحد ينتظر تسجيل استلام نقد المندوب', 'مبيعات تنتظر تسجيل استلام نقد المندوب'),
      cost: ar('بيع واحد تنقصه تكلفة البضاعة', 'مبيعات تنقصها تكلفة البضاعة'),
      agreement: ar('بيع مكتمل ينتظر بيعًا آخر في الاتفاق نفسه', 'مبيعات مكتملة تنتظر بيعًا آخر في الاتفاق نفسه'),
      recalculation: ar('بيع واحد يُعاد حسابه الآن', 'مبيعات يُعاد حسابها الآن'),
      cancelled: ar('بيع واحد أُلغي بعد التسليم', 'مبيعات أُلغيت بعد التسليم'),
      funding: () => 'تمويل الاتفاق لم يكتمل بعد',
    },
    holdGroup: {
      collection: 'مبيعات تنتظر تسجيل استلام نقد المندوب',
      cost: 'مبيعات تنقصها تكلفة البضاعة',
      agreement: 'رأس مال مبيعات مكتملة ينتظر بيعًا آخر في الاتفاق نفسه',
      recalculation: 'مبيعات يُعاد حسابها الآن',
      cancelled: 'مبيعات أُلغيت بعد التسليم',
      funding: 'تمويل الاتفاق لم يكتمل بعد',
    },
    capitalDebt: 'دين رأس مال: سُحب أكثر مما استُرد الآن',
    notRecovered: 'لم يُسترد من مبيعات بأقل من التكلفة',
    holdAction: {
      collection: 'يُسجَّل من «المالية ← التحصيل وشركات التوصيل».',
      cost: 'تُدخل التكلفة من تفاصيل الطلب أو دفعة المخزون.',
      cancelled: 'يُحسم الإلغاء أو المرتجع من تفاصيل الطلب.',
      recalculation: 'يكتمل تلقائيًا خلال دقائق.',
    },
    wageAction: {
      cost: 'تُدخل تكلفة الطلب من تفاصيله.',
      cancelled: 'يُصحَّح الأجر من «السجل والتفاصيل».',
      recalculation: 'يكتمل تلقائيًا خلال دقائق.',
    },
    wageHold: {
      cost: ar('أجر نسبة من الربح ينتظر تكلفة الطلب', 'أجور نسبة من الربح تنتظر تكلفة الطلب'),
      cancelled: ar('أجر على طلب أُلغي بعد التسليم', 'أجور على طلبات أُلغيت بعد التسليم'),
      recalculation: ar('أجر يُعاد حسابه', 'أجور يُعاد حسابها'),
    },
    profitUnknown: ar('ربح بيع واحد لم يُحسب بعد', 'أرباح مبيعات لم تُحسب بعد'),
    wholeAgreement: 'رأس مال هذا الاتفاق يتحمّل الخسارة، فيبقى كله محجوزًا حتى يُحل هذا البيع.',
  },
  en: {
    peopleHint: 'For each person: their capital and where it is now, their profit share, what they earned from investing and working, and what they can withdraw now.',
    investor: 'Investor',
    works: 'Works',
    earnedTotal: 'Earned from investing and working',
    fromInvesting: 'From investing',
    fromWork: 'From work',
    availableNow: 'Available to withdraw now',
    paidOut: 'Paid out so far',
    heldNow: 'Held for now',
    investmentTitle: 'Investment',
    capitalPutIn: 'Capital put in',
    inGoods: 'In stock or on undelivered orders',
    backFromSales: 'Back from sales',
    heldOf: 'of which held',
    availableOf: 'of which available to withdraw',
    reservedNow: 'Reserved for a withdrawal request',
    earningsPart: 'Earnings',
    soldHeld: 'Sold, waiting to be released',
    returned: 'Returned to the account',
    unusedReturned: 'of which never used in a purchase',
    capitalLoss: 'Capital loss',
    share: 'Profit share',
    byAgreement: 'by agreement',
    defaultShare: 'Default for new agreements',
    noAgreements: 'No agreements yet.',
    profitEarned: 'Profit earned',
    roi: 'Return on capital',
    roiHint: 'Profit earned ÷ capital put in',
    holdsTitle: 'Why it is held',
    workTitle: 'Work',
    active: 'Working',
    paused: 'Paused',
    archived: 'Removed',
    since: 'since',
    resumesOn: 'back to work on',
    wagesEarned: 'Wages earned',
    wagesPaid: 'Paid',
    wagesAvailable: 'Available',
    wagesHeld: 'Waiting for calculation',
    agreementsTitle: 'Agreements',
    capital: 'Capital',
    heldSales: 'Held sales',
    details: 'Details',
    period: 'In the selected period',
    periodWages: 'wages',
    periodProfit: 'investment profit',
    settings: 'Settings',
    allAgreements: (n) => (n === 1 ? 'on the agreement' : `on all ${n} agreements`),
    agreementUnits: (received, sold, stock) => `Received ${received} · sold ${sold} · in stock ${stock}`,
    unitsLine: (stock, orders, sold, notReceived) => `In stock ${stock} · on undelivered orders ${orders} · sold ${sold}${notReceived ? ` · not received ${notReceived}` : ''}`,
    moreSales: (n) => `and ${n} more`,
    hold: {
      collection: en('sale', 'waiting for the courier cash to be recorded'),
      cost: en('sale', 'missing a cost of goods'),
      agreement: en('settled sale', 'waiting for another sale in the same agreement'),
      recalculation: en('sale', 'being recalculated'),
      cancelled: en('sale', 'cancelled after delivery'),
      funding: () => 'Agreement funding not complete yet',
    },
    holdGroup: {
      collection: 'Sales waiting for the courier cash to be recorded',
      cost: 'Sales missing a cost of goods',
      agreement: 'Capital of settled sales waiting for another sale in the same agreement',
      recalculation: 'Sales being recalculated',
      cancelled: 'Sales cancelled after delivery',
      funding: 'Agreement funding not complete yet',
    },
    capitalDebt: 'Capital owed back: more withdrawn than is recovered now',
    notRecovered: 'Not recovered from sales below cost',
    holdAction: {
      collection: 'Recorded in Finance → Collections and couriers.',
      cost: 'Enter the cost in the order details or the stock batch.',
      cancelled: 'Settle the cancellation or return in the order details.',
      recalculation: 'Finishes by itself within minutes.',
    },
    wageAction: {
      cost: 'Enter the order cost in its details.',
      cancelled: 'Correct the wage under History and details.',
      recalculation: 'Finishes by itself within minutes.',
    },
    wageHold: {
      cost: en('profit-share wage', 'waiting for the order cost'),
      cancelled: en('wage', 'on an order cancelled after delivery'),
      recalculation: en('wage', 'being recalculated'),
    },
    profitUnknown: (n) => `Profit of ${n} sale${n === 1 ? '' : 's'} not calculated yet`,
    wholeAgreement: 'This agreement\'s capital shares losses, so all of it waits until this sale is resolved.',
  },
  ckb: {
    peopleHint: 'بۆ هەر کەسێک: سەرمایەکەی و ئێستا لە کوێیە، بەشی قازانجەکەی، ئەوەی لە وەبەرهێنان و کار بەدەستی هێناوە، و ئەوەی ئێستا دەتوانێت ڕایبکێشێت.',
    investor: 'وەبەرهێنەر',
    works: 'کار دەکات',
    earnedTotal: 'بەدەستهاتوو لە وەبەرهێنان و کار',
    fromInvesting: 'لە وەبەرهێنان',
    fromWork: 'لە کار',
    availableNow: 'ئێستا بەردەستە بۆ ڕاکێشان',
    paidOut: 'تا ئێستا دراوە',
    heldNow: 'بۆ ئێستا ڕاگیراوە',
    investmentTitle: 'وەبەرهێنان',
    capitalPutIn: 'سەرمایەی دانراو',
    inGoods: 'لە کۆگادایە یان لە داواکاریی نەگەیەندراودا',
    backFromSales: 'لە فرۆشتنەوە گەڕاوەتەوە',
    heldOf: 'لەوە ڕاگیراوە',
    availableOf: 'لەوە بەردەستە بۆ ڕاکێشان',
    reservedNow: 'گیراوە بۆ داواکاریی ڕاکێشان',
    earningsPart: 'قازانجەکان',
    soldHeld: 'فرۆشراوە و چاوەڕێی ئازادکردنە',
    returned: 'گەڕایەوە بۆ هەژمارەکە',
    unusedReturned: 'لەوە بڕێک لە کڕیندا بەکارنەهاتووە',
    capitalLoss: 'زیانی سەرمایە',
    share: 'بەشی قازانج',
    byAgreement: 'بەپێی ڕێککەوتن',
    defaultShare: 'بنەڕەت بۆ ڕێککەوتنە نوێیەکان',
    noAgreements: 'هێشتا هیچ ڕێککەوتنێک نییە.',
    profitEarned: 'قازانجی بەدەستهاتوو',
    roi: 'ڕێژەی قازانج بە بەراورد بە سەرمایە',
    roiHint: 'قازانجی بەدەستهاتوو ÷ سەرمایەی دانراو',
    holdsTitle: 'بۆچی ڕاگیراوە',
    workTitle: 'کار',
    active: 'کار دەکات',
    paused: 'وەستاوە',
    archived: 'لابراوە',
    since: 'لە بەرواری',
    resumesOn: 'گەڕانەوە بۆ کار:',
    wagesEarned: 'کرێی بەدەستهاتوو',
    wagesPaid: 'دراوە',
    wagesAvailable: 'بەردەستە',
    wagesHeld: 'چاوەڕێی تەواوبوونی حیسابە',
    agreementsTitle: 'ڕێککەوتنەکان',
    capital: 'سەرمایە',
    heldSales: 'فرۆشتنە ڕاگیراوەکان',
    details: 'وردەکاری',
    period: 'لە ماوەی هەڵبژێردراودا',
    periodWages: 'کرێ',
    periodProfit: 'قازانجی وەبەرهێنان',
    settings: 'ڕێکخستنەکان',
    allAgreements: (n) => (n === 1 ? 'لە ڕێککەوتنەکەدا' : `لە هەموو ${n} ڕێککەوتنەکەدا`),
    agreementUnits: (received, sold, stock) => `وەرگیراو ${received} · فرۆشراو ${sold} · لە کۆگا ${stock}`,
    unitsLine: (stock, orders, sold, notReceived) => `لە کۆگا ${stock} · لە داواکاریی نەگەیەندراو ${orders} · فرۆشراو ${sold}${notReceived ? ` · نەگەیشتوو ${notReceived}` : ''}`,
    moreSales: (n) => `و ${n} فرۆشتنی تر`,
    hold: {
      collection: (n) => `${n} فرۆشتن چاوەڕێی تۆمارکردنی وەرگرتنی پارەی گەیەنەرە`,
      cost: (n) => `${n} فرۆشتن تێچووی کاڵاکەی تەواو نییە`,
      agreement: (n) => `${n} فرۆشتنی تەواو چاوەڕێی فرۆشتنێکی تری هەمان ڕێککەوتنە`,
      recalculation: (n) => `${n} فرۆشتن ئێستا دووبارە حیساب دەکرێتەوە`,
      cancelled: (n) => `${n} فرۆشتن دوای گەیاندن هەڵوەشێنرایەوە`,
      funding: () => 'پارەدارکردنی ڕێککەوتنەکە هێشتا تەواو نەبووە',
    },
    holdGroup: {
      collection: 'فرۆشتنەکان چاوەڕێی تۆمارکردنی وەرگرتنی پارەی گەیەنەرن',
      cost: 'فرۆشتنەکان تێچووی کاڵایان تەواو نییە',
      agreement: 'سەرمایەی فرۆشتنە تەواوەکان چاوەڕێی فرۆشتنێکی تری هەمان ڕێککەوتنە',
      recalculation: 'فرۆشتنەکان ئێستا دووبارە حیساب دەکرێنەوە',
      cancelled: 'فرۆشتنەکان دوای گەیاندن هەڵوەشێنرانەوە',
      funding: 'پارەدارکردنی ڕێککەوتنەکە هێشتا تەواو نەبووە',
    },
    capitalDebt: 'قەرزی سەرمایە: زیاتر لەوەی ئێستا گەڕاوەتەوە ڕاکێشراوە',
    notRecovered: 'لە فرۆشتنی خوار تێچوو نەگەڕاوەتەوە',
    holdAction: {
      collection: 'لە «دارایی ← کۆکردنەوەی پارە و گەیەنەرەکان» تۆمار دەکرێت.',
      cost: 'تێچووەکە لە وردەکاریی داواکارییەکە یان لە بەشی کۆگا دەنووسرێت.',
      cancelled: 'هەڵوەشاندنەوە یان گەڕاندنەوەکە لە وردەکاریی داواکارییەکەدا یەکلا دەکرێتەوە.',
      recalculation: 'لە ماوەی چەند خولەکێکدا خۆی تەواو دەبێت.',
    },
    wageAction: {
      cost: 'تێچووی داواکارییەکە لە وردەکارییەکەیدا دەنووسرێت.',
      cancelled: 'کرێکە لە «تۆمار و وردەکاری» ڕاست دەکرێتەوە.',
      recalculation: 'لە ماوەی چەند خولەکێکدا خۆی تەواو دەبێت.',
    },
    wageHold: {
      cost: (n) => `${n} کرێی بەشی قازانج چاوەڕێی تێچووی داواکارییەکەیە`,
      cancelled: (n) => `${n} کرێ لەسەر داواکاریی هەڵوەشاوە دوای گەیاندن`,
      recalculation: (n) => `${n} کرێ دووبارە حیساب دەکرێتەوە`,
    },
    profitUnknown: (n) => `قازانجی ${n} فرۆشتن هێشتا حیساب نەکراوە`,
    wholeAgreement: 'سەرمایەی ئەم ڕێککەوتنە بەشداری زیان دەکات، بۆیە هەمووی ڕادەگیرێت تا ئەم فرۆشتنە چارەسەر دەکرێت.',
  },
};

export const personFinanceStrings = (lang: Language): PersonFinanceStrings => PERSON_FINANCE_STRINGS[lang] ?? PERSON_FINANCE_STRINGS.ar;

/** Basis points as a percentage: 4500 → «45%», 702 → «7.0%» with one decimal. */
export function percentText(bps: number | null | undefined, decimals = 0): string {
  if (bps == null || !Number.isFinite(bps)) return '—';
  const scaled = Math.round(bps / Math.pow(10, 2 - decimals));
  const text = decimals ? `${Math.trunc(scaled / Math.pow(10, decimals))}.${String(Math.abs(scaled) % Math.pow(10, decimals)).padStart(decimals, '0')}` : String(scaled);
  return `${text}%`;
}
