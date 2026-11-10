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
  profitDebt: string;
  wageDebt: string;
  notRecovered: string;
  holdAction: Partial<Record<HoldReasonKey, string>>;
  wageAction: Partial<Record<HoldReasonKey, string>>;
  wageHold: Partial<Record<HoldReasonKey, (n: number) => string>>;
  profitUnknown: (n: number) => string;
  wholeAgreement: string;
  /** Wage settlement (DECISIONS row 306): «wages settled through <day> · agreed still owed <amount>». */
  settledThrough: string;
  agreedOwed: string;
  stillOwed: string;
  nothingOwed: string;
  /** The owner's «تسوية الأجور» dialog (DECISIONS row 306; WageSettlementDialog.tsx). */
  settle: SettleStrings;
}

/** The server's settlement refusals the dialog says itself (SETTLE_* codes, worker/lib/staffSettlement.ts). */
export type SettleRefusalKey = 'withdrawal' | 'advance' | 'recalculation' | 'settled' | 'changed' | 'future' | 'noWages' | 'unpriced' | 'reused';

export interface SettleStrings {
  action: string;
  title: string;
  intro: string;
  stepAgree: string;
  stepReview: string;
  dayLabel: string;
  dayHint: string;
  settledToday: string;
  owedLabel: string;
  owedHint: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  reasonShort: string;
  preview: string;
  ordersThrough: string;
  rowsLine: (rows: number, adjusted: number, reversed: number) => string;
  earned: string;
  paid: string;
  owedBefore: string;
  agreed: string;
  change: string;
  paidStays: string;
  investorTitle: string;
  investorWhy: string;
  investorShare: string;
  investorOrders: (n: number) => string;
  investorWages: string;
  investorUp: string;
  investorDown: string;
  investorLess: string;
  ordersTitle: (n: number) => string;
  noOrders: string;
  final: string;
  apply: string;
  back: string;
  cancel: string;
  again: string;
  done: (name: string, day: string, amount: string) => string;
  refusedTitle: string;
  refusal: Record<SettleRefusalKey, string>;
  refusalAction: Record<SettleRefusalKey, string>;
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
    profitDebt: 'دين أرباح متبقٍ',
    wageDebt: 'الدين المتبقي',
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
    settledThrough: 'سُوّيت الأجور حتى',
    agreedOwed: 'المتبقي المتفق عليه',
    stillOwed: 'المتبقي له الآن',
    nothingOwed: 'لا شيء متبقٍ له',
    settle: {
      action: 'تسوية الأجور',
      title: 'تسوية الأجور بمبلغ متفق عليه',
      intro: 'مبلغ واحد نهائي متفق عليه عن كل الطلبات المسلّمة قبل يوم تختاره. ما دُفع يبقى مدفوعًا، وما يُسلَّم من ذلك اليوم يُستحق كالمعتاد.',
      stepAgree: 'الاتفاق',
      stepReview: 'المراجعة والتطبيق',
      dayLabel: 'يوم بداية الفترة الجديدة',
      dayHint: 'تُسوّى كل الطلبات المسلّمة قبل هذا اليوم بتوقيت بغداد. اليوم نفسه وما بعده يُستحق كالمعتاد.',
      settledToday: 'سُوّيت الأجور حتى أمس، فلا يوم يمكن اختياره اليوم. تُتاح تسوية جديدة ابتداءً من الغد.',
      owedLabel: 'المبلغ المتفق عليه المتبقي له',
      owedHint: 'الصافي النهائي لأجور الفترة بعد ما دُفع له. اكتب 0 إن لم يبقَ له شيء.',
      reasonLabel: 'سبب التسوية',
      reasonPlaceholder: 'مثال: اتفاق نهائي عند ترك العمل',
      reasonShort: 'اكتب سببًا من ثلاثة أحرف على الأقل.',
      preview: 'معاينة التسوية',
      ordersThrough: 'الطلبات المسلّمة حتى',
      rowsLine: (rows, adjusted, reversed) => `أجور الفترة ${rows} · يتغيّر منها ${adjusted}${reversed ? ` · وتُلغى ${reversed} كانت تنتظر تكلفة طلبها` : ''}`,
      earned: 'المكتسب',
      paid: 'المدفوع',
      owedBefore: 'المتبقي قبل التسوية',
      agreed: 'المتبقي المتفق عليه',
      change: 'التغيير في الأجور',
      paidStays: 'ما دُفع يبقى مدفوعًا. يُوزَّع المبلغ المتفق عليه على أجور الطلبات بالنسبة نفسها، ويُسجَّل الفرق في الحسابات بقيد واحد.',
      investorTitle: 'ربح المستثمر يتغيّر',
      investorWhy: 'تخفيض أجر الطلب يرفع ربحه بالمبلغ نفسه، ويأخذ المستثمر حصته المتفق عليها من الربح على بضاعته.',
      investorShare: 'حصته من الربح',
      investorOrders: ar('طلب واحد باع من بضاعته', 'طلبات باعت من بضاعته'),
      investorWages: 'أجورها',
      investorUp: 'يرتفع ربحه نحو',
      investorDown: 'ينخفض ربحه نحو',
      investorLess: 'أو أقل إن باع الطلب أيضًا بضاعة ليست له.',
      ordersTitle: (n) => `الطلبات التي يتغيّر أجرها (${n})`,
      noOrders: 'لا يتغيّر أجر أي طلب.',
      final: 'التسوية نهائية: لا تُعدَّل ولا تُحذف بعد تطبيقها.',
      apply: 'تطبيق التسوية',
      back: 'السابق',
      cancel: 'إلغاء',
      again: 'إعادة المعاينة',
      done: (name, day, amount) => `سُوّيت أجور ${name} حتى ${day} · المتبقي المتفق عليه ${amount}`,
      refusedTitle: 'لا يمكن التسوية الآن',
      refusal: {
        withdrawal: 'طلب سحب مفتوح يحجز جزءًا من هذه الأجور.',
        advance: 'على الموظف سلفة نقدية لم تُسوَّ بعد.',
        recalculation: 'أجور الموظف يُعاد حسابها الآن.',
        settled: 'هذه الفترة سُوّيت من قبل.',
        changed: 'تغيّرت الأجور منذ المعاينة.',
        future: 'لا يُسوّى يوم بعد اليوم.',
        noWages: 'لا يوجد في هذه الفترة أجر مسجّل يحمل المبلغ المتفق عليه.',
        unpriced: 'أجر مدفوع في هذه الفترة ما زال ينتظر تكلفة طلبه.',
        reused: 'رقم هذه العملية استُخدم لتسوية أخرى.',
      },
      refusalAction: {
        withdrawal: 'ادفعه أو ارفضه من «السحب والتسويات»، ثم أعد المعاينة.',
        advance: 'اخصم السلفة من أجوره أولًا («الاستحقاقات والرواتب» ← «خصم سلفة من الأجور»)، ثم أعد المعاينة.',
        recalculation: 'انتظر حتى يكتمل الحساب (يظهر تقدمه في بطاقة الموظف)، ثم أعد المعاينة.',
        settled: 'اختر يومًا بعد آخر تسوية.',
        changed: 'أعد المعاينة لترى الأرقام الجديدة قبل التطبيق.',
        future: 'اختر اليوم أو يومًا قبله.',
        noWages: 'اختر يومًا يشمل طلبات مسلّمة لها أجر، أو اكتب 0.',
        unpriced: 'أدخل تكلفة الطلب من تفاصيله، ثم أعد المعاينة.',
        reused: 'أعد المعاينة ثم طبّق التسوية من جديد.',
      },
    },
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
    profitDebt: 'Profit owed back',
    wageDebt: 'Remaining debt',
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
    settledThrough: 'Wages settled through',
    agreedOwed: 'agreed still owed',
    stillOwed: 'Still owed now',
    nothingOwed: 'Nothing owed',
    settle: {
      action: 'Settle wages',
      title: 'Settle wages at an agreed amount',
      intro: 'One final agreed amount for every order delivered before the day you choose. What was paid stays paid, and deliveries from that day earn as usual.',
      stepAgree: 'Agreement',
      stepReview: 'Review and apply',
      dayLabel: 'First day of the new period',
      dayHint: 'Every order delivered before this day (Baghdad time) is settled. The day itself and later earn as usual.',
      settledToday: 'Wages are settled through yesterday, so no day can be chosen today. A new settlement is possible from tomorrow.',
      owedLabel: 'Agreed amount still owed',
      owedHint: 'The final net for the period after what was paid. Enter 0 if nothing is owed.',
      reasonLabel: 'Reason for the settlement',
      reasonPlaceholder: 'e.g. Final agreement on leaving',
      reasonShort: 'Write a reason of at least three characters.',
      preview: 'Preview settlement',
      ordersThrough: 'Orders delivered through',
      rowsLine: (rows, adjusted, reversed) => `${rows} wage${rows === 1 ? '' : 's'} in the period · ${adjusted} change${adjusted === 1 ? 's' : ''}${reversed ? ` · ${reversed} waiting for an order cost ${reversed === 1 ? 'is' : 'are'} cancelled` : ''}`,
      earned: 'Earned',
      paid: 'Paid',
      owedBefore: 'Owed before',
      agreed: 'Agreed still owed',
      change: 'Change in wages',
      paidStays: 'What was paid stays paid. The agreed amount is spread over the orders\' wages in the same proportion, and the difference is posted to the books as one entry.',
      investorTitle: 'Investor profit changes',
      investorWhy: 'Cutting an order\'s wage raises its profit by the same amount, and the investor takes their agreed share of the profit on their goods.',
      investorShare: 'Profit share',
      investorOrders: (n) => (n === 1 ? '1 order sold their goods' : `${n} orders sold their goods`),
      investorWages: 'their wages',
      investorUp: 'Their profit rises by about',
      investorDown: 'Their profit falls by about',
      investorLess: 'or less if an order also sold goods that are not theirs.',
      ordersTitle: (n) => `Orders whose wage changes (${n})`,
      noOrders: 'No order\'s wage changes.',
      final: 'A settlement is final: it cannot be edited or deleted once applied.',
      apply: 'Apply settlement',
      back: 'Back',
      cancel: 'Cancel',
      again: 'Preview again',
      done: (name, day, amount) => `${name}'s wages settled through ${day} · agreed still owed ${amount}`,
      refusedTitle: 'Cannot settle now',
      refusal: {
        withdrawal: 'An open withdrawal request holds part of these wages.',
        advance: 'The employee has a cash advance that is not settled yet.',
        recalculation: 'The employee\'s wages are being recalculated.',
        settled: 'This period has already been settled.',
        changed: 'Wages changed since the preview.',
        future: 'A day after today cannot be settled.',
        noWages: 'No recorded wage in this period can carry the agreed amount.',
        unpriced: 'A paid wage in this period is still waiting for its order cost.',
        reused: 'This operation number was used for another settlement.',
      },
      refusalAction: {
        withdrawal: 'Pay or reject it under Withdrawals, then preview again.',
        advance: 'First apply the advance to their wages (Dues and payroll → Apply advance to dues), then preview again.',
        recalculation: 'Wait until the calculation finishes (its progress shows on the employee\'s card), then preview again.',
        settled: 'Choose a day after the last settlement.',
        changed: 'Preview again to see the new figures before applying.',
        future: 'Choose today or an earlier day.',
        noWages: 'Choose a day that includes delivered orders with a wage, or enter 0.',
        unpriced: 'Enter the order cost in its details, then preview again.',
        reused: 'Preview again, then apply the settlement.',
      },
    },
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
    profitDebt: 'قەرزی ماوەی قازانج',
    wageDebt: 'قەرزی ماوە',
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
    settledThrough: 'کرێکان یەکلاکرانەوە تا',
    agreedOwed: 'بڕی ڕێککەوتوو کە ماوە',
    stillOwed: 'ئێستا ماوە بۆی',
    nothingOwed: 'هیچی بۆ نەماوە',
    settle: {
      action: 'یەکلاکردنەوەی کرێ',
      title: 'یەکلاکردنەوەی کرێ بە بڕێکی ڕێککەوتوو',
      intro: 'یەک بڕی کۆتایی ڕێککەوتوو بۆ هەموو ئەو داواکارییانەی پێش ئەو ڕۆژەی هەڵیدەبژێریت گەیەندراون. ئەوەی دراوە وەک خۆی دەمێنێتەوە، و ئەوەی لەو ڕۆژەوە دەگەیەندرێت وەک هەمیشە کرێی بۆ حیساب دەکرێت.',
      stepAgree: 'ڕێککەوتن',
      stepReview: 'پێداچوونەوە و جێبەجێکردن',
      dayLabel: 'یەکەم ڕۆژی ماوەی نوێ',
      dayHint: 'هەموو ئەو داواکارییانەی پێش ئەم ڕۆژە بە کاتی بەغدا گەیەندراون یەکلا دەکرێنەوە. خودی ئەم ڕۆژە و دوای ئەو وەک هەمیشە حیساب دەکرێن.',
      settledToday: 'کرێکان تا دوێنێ یەکلاکراونەتەوە، بۆیە ئەمڕۆ هیچ ڕۆژێک هەڵنابژێردرێت. یەکلاکردنەوەی نوێ لە سبەینێوە دەکرێت.',
      owedLabel: 'بڕی ڕێککەوتوو کە بۆی ماوە',
      owedHint: 'بڕی کۆتایی کرێی ماوەکە دوای ئەوەی پێی دراوە. ئەگەر هیچی بۆ نەماوە 0 بنووسە.',
      reasonLabel: 'هۆکاری یەکلاکردنەوە',
      reasonPlaceholder: 'نموونە: ڕێککەوتنی کۆتایی لە کاتی جێهێشتنی کار',
      reasonShort: 'هۆکارێک بنووسە کە لانیکەم سێ پیت بێت.',
      preview: 'پێشبینینی یەکلاکردنەوە',
      ordersThrough: 'داواکارییە گەیەندراوەکان تا',
      rowsLine: (rows, adjusted, reversed) => `${rows} کرێ لە ماوەکەدا · ${adjusted} دەگۆڕێن${reversed ? ` · ${reversed} کە چاوەڕێی تێچووی داواکارییەکەیان بوون هەڵدەوەشێنرێنەوە` : ''}`,
      earned: 'بەدەستهاتوو',
      paid: 'دراوە',
      owedBefore: 'بڕی ماوە پێش یەکلاکردنەوە',
      agreed: 'بڕی ڕێککەوتوو کە ماوە',
      change: 'گۆڕانی کرێکان',
      paidStays: 'ئەوەی دراوە وەک خۆی دەمێنێتەوە. بڕی ڕێککەوتوو بە هەمان ڕێژە بەسەر کرێی داواکارییەکاندا دابەش دەکرێت، و جیاوازییەکە بە یەک تۆمار لە حیساباتدا دەنووسرێت.',
      investorTitle: 'قازانجی وەبەرهێنەر دەگۆڕێت',
      investorWhy: 'کەمکردنەوەی کرێی داواکارییەک قازانجەکەی بە هەمان بڕ زیاد دەکات، و وەبەرهێنەر بەشە ڕێککەوتووەکەی خۆی لە قازانجی کاڵاکانی وەردەگرێت.',
      investorShare: 'بەشی قازانج',
      investorOrders: (n) => `${n} داواکاری لە کاڵاکانی ئەوی فرۆشتووە`,
      investorWages: 'کرێکانیان',
      investorUp: 'زیادبوونی قازانجەکەی: نزیکەی',
      investorDown: 'کەمبوونەوەی قازانجەکەی: نزیکەی',
      investorLess: 'یان کەمتر، ئەگەر داواکارییەکە کاڵای تریشی فرۆشتبێت کە هی ئەو نییە.',
      ordersTitle: (n) => `ئەو داواکارییانەی کرێیان دەگۆڕێت (${n})`,
      noOrders: 'کرێی هیچ داواکارییەک ناگۆڕێت.',
      final: 'یەکلاکردنەوە کۆتاییە: دوای جێبەجێکردن دەستکاری ناکرێت و ناسڕدرێتەوە.',
      apply: 'جێبەجێکردنی یەکلاکردنەوە',
      back: 'گەڕانەوە',
      cancel: 'هەڵوەشاندنەوە',
      again: 'دووبارە پێشبینین',
      done: (name, day, amount) => `کرێکانی ${name} یەکلاکرانەوە تا ${day} · بڕی ڕێککەوتوو کە ماوە ${amount}`,
      refusedTitle: 'ئێستا یەکلاکردنەوە ناکرێت',
      refusal: {
        withdrawal: 'داواکارییەکی ڕاکێشانی کراوە بەشێک لەم کرێیانە دەگرێت.',
        advance: 'کارمەندەکە پێشەکییەکی نەختینەی هەیە کە هێشتا یەکلا نەکراوەتەوە.',
        recalculation: 'کرێکانی کارمەندەکە ئێستا دووبارە حیساب دەکرێنەوە.',
        settled: 'ئەم ماوەیە پێشتر یەکلاکراوەتەوە.',
        changed: 'کرێکان لە دوای پێشبینینەکەوە گۆڕاون.',
        future: 'ڕۆژێکی دوای ئەمڕۆ یەکلا ناکرێتەوە.',
        noWages: 'لەم ماوەیەدا هیچ کرێیەکی تۆمارکراو نییە کە بڕی ڕێککەوتوو هەڵبگرێت.',
        unpriced: 'کرێیەکی دراو لەم ماوەیەدا هێشتا چاوەڕێی تێچووی داواکارییەکەیەتی.',
        reused: 'ژمارەی ئەم کردارە بۆ یەکلاکردنەوەیەکی تر بەکارهاتووە.',
      },
      refusalAction: {
        withdrawal: 'لە «ڕاکێشان و یەکلاکردنەوەکان» بیدە یان ڕەتی بکەرەوە، پاشان دووبارە پێشبینی بکە.',
        advance: 'سەرەتا پێشەکییەکە لە کرێکانی ببڕە («شایستەکان و مووچە» ← «بڕینی پێشەکی لە کرێ»)، پاشان دووبارە پێشبینی بکە.',
        recalculation: 'چاوەڕێ بکە تا حیسابەکە تەواو دەبێت (پێشکەوتنەکەی لە کارتی کارمەندەکەدا دەردەکەوێت)، پاشان دووبارە پێشبینی بکە.',
        settled: 'ڕۆژێک دوای کۆتا یەکلاکردنەوە هەڵبژێرە.',
        changed: 'دووبارە پێشبینی بکە بۆ بینینی ژمارە نوێیەکان پێش جێبەجێکردن.',
        future: 'ئەمڕۆ یان ڕۆژێکی پێشتر هەڵبژێرە.',
        noWages: 'ڕۆژێک هەڵبژێرە کە داواکاریی گەیەندراوی خاوەن کرێ بگرێتەوە، یان 0 بنووسە.',
        unpriced: 'تێچووی داواکارییەکە لە وردەکارییەکەیدا بنووسە، پاشان دووبارە پێشبینی بکە.',
        reused: 'دووبارە پێشبینی بکە، پاشان یەکلاکردنەوەکە جێبەجێ بکە.',
      },
    },
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
