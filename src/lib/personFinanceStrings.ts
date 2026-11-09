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
  inStock: string;
  inTransit: string;
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
  unitsLine: (sold: number, stock: number) => string;
  hold: Record<HoldReasonKey, (n: number) => string>;
  holdAction: Partial<Record<HoldReasonKey, string>>;
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
    inStock: 'في المخزون (لم يُبع بعد)',
    inTransit: 'في الطريق (لم يصل المخزن)',
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
    unitsLine: (sold, stock) => `مباع ${sold} · في المخزون ${stock}`,
    hold: {
      collection: ar('بيع واحد ينتظر تسجيل استلام نقد المندوب', 'مبيعات تنتظر تسجيل استلام نقد المندوب'),
      cost: ar('بيع واحد تنقصه تكلفة البضاعة', 'مبيعات تنقصها تكلفة البضاعة'),
      agreement: ar('بيع مكتمل ينتظر بيعًا آخر في الاتفاق نفسه', 'مبيعات مكتملة تنتظر بيعًا آخر في الاتفاق نفسه'),
      recalculation: ar('بيع واحد يُعاد حسابه الآن', 'مبيعات يُعاد حسابها الآن'),
      cancelled: ar('بيع واحد أُلغي بعد التسليم', 'مبيعات أُلغيت بعد التسليم'),
      funding: () => 'تمويل الاتفاق لم يكتمل بعد',
    },
    holdAction: {
      collection: 'يُسجَّل من «المالية ← التحصيل وشركات التوصيل».',
      cost: 'تُدخل التكلفة من تفاصيل الطلب أو دفعة المخزون.',
      cancelled: 'يُصحَّح الأجر من «السجل والتفاصيل».',
      recalculation: 'يكتمل تلقائيًا خلال دقائق.',
    },
    wageHold: {
      cost: ar('أجر نسبة من الربح ينتظر تكلفة الطلب', 'أجور نسبة من الربح تنتظر تكلفة الطلب'),
      cancelled: ar('أجر على طلب أُلغي بعد التسليم', 'أجور على طلبات أُلغيت بعد التسليم'),
      recalculation: ar('أجر يُعاد حسابه', 'أجور يُعاد حسابها'),
    },
    profitUnknown: ar('ربح بيع واحد لم يُحسب بعد', 'أرباح مبيعات لم تُحسب بعد'),
    wholeAgreement: 'بالقاعدة الحالية يبقى الاتفاق كله محجوزًا حتى يُحل هذا البيع.',
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
    inStock: 'In stock (not sold yet)',
    inTransit: 'On the way (not received yet)',
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
    unitsLine: (sold, stock) => `Sold ${sold} · in stock ${stock}`,
    hold: {
      collection: en('sale', 'waiting for the courier cash to be recorded'),
      cost: en('sale', 'missing a cost of goods'),
      agreement: en('settled sale', 'waiting for another sale in the same agreement'),
      recalculation: en('sale', 'being recalculated'),
      cancelled: en('sale', 'cancelled after delivery'),
      funding: () => 'Agreement funding not complete yet',
    },
    holdAction: {
      collection: 'Recorded in Finance → Collections and couriers.',
      cost: 'Enter the cost in the order details or the stock batch.',
      cancelled: 'Correct the wage under History and details.',
      recalculation: 'Finishes by itself within minutes.',
    },
    wageHold: {
      cost: en('profit-share wage', 'waiting for the order cost'),
      cancelled: en('wage', 'on an order cancelled after delivery'),
      recalculation: en('wage', 'being recalculated'),
    },
    profitUnknown: (n) => `Profit of ${n} sale${n === 1 ? '' : 's'} not calculated yet`,
    wholeAgreement: 'Under the current rule the whole agreement stays held until this sale is resolved.',
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
    inStock: 'لە کۆگادایە (هێشتا نەفرۆشراوە)',
    inTransit: 'لە ڕێگادایە (هێشتا نەگەیشتووە)',
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
    unitsLine: (sold, stock) => `فرۆشراو ${sold} · لە کۆگا ${stock}`,
    hold: {
      collection: (n) => `${n} فرۆشتن چاوەڕێی تۆمارکردنی وەرگرتنی پارەی گەیەنەرە`,
      cost: (n) => `${n} فرۆشتن تێچووی کاڵاکەی تەواو نییە`,
      agreement: (n) => `${n} فرۆشتنی تەواو چاوەڕێی فرۆشتنێکی تری هەمان ڕێککەوتنە`,
      recalculation: (n) => `${n} فرۆشتن ئێستا دووبارە حیساب دەکرێتەوە`,
      cancelled: (n) => `${n} فرۆشتن دوای گەیاندن هەڵوەشێنرایەوە`,
      funding: () => 'پارەدارکردنی ڕێککەوتنەکە هێشتا تەواو نەبووە',
    },
    holdAction: {
      collection: 'لە «دارایی ← کۆکردنەوەی پارە و گەیەنەرەکان» تۆمار دەکرێت.',
      cost: 'تێچووەکە لە وردەکاریی داواکارییەکە یان لە بەشی کۆگا دەنووسرێت.',
      cancelled: 'کرێکە لە «تۆمار و وردەکاری» ڕاست دەکرێتەوە.',
      recalculation: 'لە ماوەی چەند خولەکێکدا خۆی تەواو دەبێت.',
    },
    wageHold: {
      cost: (n) => `${n} کرێی بەشی قازانج چاوەڕێی تێچووی داواکارییەکەیە`,
      cancelled: (n) => `${n} کرێ لەسەر داواکاریی هەڵوەشاوە دوای گەیاندن`,
      recalculation: (n) => `${n} کرێ دووبارە حیساب دەکرێتەوە`,
    },
    profitUnknown: (n) => `قازانجی ${n} فرۆشتن هێشتا حیساب نەکراوە`,
    wholeAgreement: 'بەپێی یاسای ئێستا هەموو ڕێککەوتنەکە ڕادەگیرێت تا ئەم فرۆشتنە چارەسەر دەکرێت.',
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
