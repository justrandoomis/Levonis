/**
 * «الأرباح والتكاليف» — THE P-A STRINGS (owner brief 2026-10-09, "Accounting
 * Currency"; design §7.2 and §8).
 *
 * Accounting stays in IQD. These are the sentences the profit page adds for
 * the read-only fixes (F2, F3), the report-only deductions (F4/F5) and the
 * IQD/USD display toggle, in Arabic, English and Sorani. They live in one
 * module so `tests/financeDisplayStrings.test.ts` can hold every entry to the
 * rule of docs/DECISIONS.md row 183: the `ckb` slot is its own Sorani — never
 * the Arabic or the English pasted across — and it carries Sorani letters.
 *
 * Placeholders are `{name}`; `fill` replaces them. Pure data: no imports.
 */
export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

export const PA_STRINGS = {
  // ---- F2: a delivered order with no cost recorded at the time of sale
  noRecordedCost: {
    ar: 'لا توجد تكلفة مسجلة وقت البيع؛ أدخل التكلفة الفعلية إن كانت معروفة',
    en: 'No cost was recorded at the time of sale; enter the actual cost if you know it',
    ckb: 'لە کاتی فرۆشتندا هیچ تێچوویەک تۆمار نەکراوە؛ ئەگەر تێچووی ڕاستەقینە دەزانیت بینووسە',
  },

  // ---- F3: a promotion in a foreign currency needs the rate actually paid
  promotionRateLabel: {
    ar: 'سعر التحويل المدفوع فعلًا',
    en: 'Exchange rate actually paid',
    ckb: 'ئەو نرخی گۆڕینەوەیەی بەڕاستی دراوە',
  },
  promotionRateHint: {
    ar: 'مطلوب لأي مبلغ بغير الدينار: كم دينارًا دفعت للوحدة الواحدة. يُثبَّت مع المصروف ولا يتبع سعر اليوم.',
    en: 'Required for any amount not in dinars: how many dinars you paid for one unit. It is locked with the expense and never follows today’s rate.',
    ckb: 'پێویستە بۆ هەر بڕێک کە بە دینار نییە: بۆ یەک یەکە چەند دینارت داوە. لەگەڵ خەرجییەکەدا جێگیر دەکرێت و بەدوای نرخی ئەمڕۆدا ناڕوات.',
  },
  promotionRateKeep: {
    ar: 'فارغ = السعر المسجل لهذا الترويج: {rate}',
    en: 'Blank keeps this promotion’s recorded rate: {rate}',
    ckb: 'بەتاڵ = نرخی تۆمارکراوی ئەم بانگەشەیە دەمێنێتەوە: {rate}',
  },
  promotionRateSuggestion: {
    ar: 'اقتراح: سعر الدولار المعتمد في {date}: {rate}',
    en: 'Suggestion: the shop’s dollar rate on {date}: {rate}',
    ckb: 'پێشنیار: نرخی دۆلاری فرۆشگا لە {date}: {rate}',
  },

  // ---- F4/F5: report-only deductions (owner question Q3, default "report only")
  couponDeduction: {
    ar: 'خصم القسيمة',
    en: 'Coupon discount',
    ckb: 'داشکانی کوپۆن',
  },
  priceProtectionCredit: {
    ar: 'تعويض حماية السعر',
    en: 'Price-protection credit',
    ckb: 'قەرەبووی پاراستنی نرخ',
  },
  netAfterReportDeductions: {
    ar: 'الصافي بعد خصومات التقرير',
    en: 'Net after report deductions',
    ckb: 'پوختە دوای داشکانەکانی ڕاپۆرت',
  },
  reportOnlyNote: {
    ar: 'خصم للعرض في التقرير فقط؛ لا يغيّر حصص المستثمرين ولا الأجور ولا القيود المسجلة',
    en: 'Deducted in this report only; it does not change recorded investor shares, wages or journal entries',
    ckb: 'تەنها لەم ڕاپۆرتەدا دەردەکرێت؛ بەشی وەبەرهێنەران و کرێ و تۆمارە ژمێریارییەکان ناگۆڕێت',
  },

  // ---- §8: the IQD/USD display toggle (display only; accounting stays IQD)
  displayCurrency: {
    ar: 'عملة العرض',
    en: 'Display currency',
    ckb: 'دراوی پیشاندان',
  },
  dinarOption: {
    ar: 'دينار',
    en: 'IQD',
    ckb: 'دینار',
  },
  dollarOption: {
    ar: 'دولار',
    en: 'USD',
    ckb: 'دۆلار',
  },
  usdNote: {
    ar: 'عرض بالدولار فقط. المبالغ المحاسبية محفوظة بالدينار ولا تتغير.',
    en: 'Shown in US dollars only. Accounting amounts are kept in dinars and do not change.',
    ckb: 'تەنها بە دۆلار پیشان دەدرێت. بڕە ژمێریارییەکان بە دینار پارێزراون و ناگۆڕێن.',
  },
  usdAtTime: {
    ar: 'بسعر الدولار المعتمد في المتجر وقت الطلب: {rate}',
    en: 'At the shop’s dollar rate when ordered: {rate}',
    ckb: 'بە نرخی دۆلاری فرۆشگا لە کاتی داواکردن: {rate}',
  },
  usdAtTimeEach: {
    ar: 'كل طلب بسعر الدولار المعتمد في المتجر وقت إنشائه.',
    en: 'Each order at the shop’s dollar rate when it was placed.',
    ckb: 'هەر داواکارییەک بە نرخی دۆلاری فرۆشگا لە کاتی دروستکردنیدا.',
  },
  usdToday: {
    ar: '≈ بسعر اليوم {rate} — لم يُسجَّل سعر وقت هذا الطلب',
    en: '≈ at today’s rate {rate} — no rate was recorded when this order was placed',
    ckb: '≈ بە نرخی ئەمڕۆ {rate} — لە کاتی ئەم داواکارییەدا هیچ نرخێک تۆمار نەکرابوو',
  },
  usdMixed: {
    ar: '≈ المجموع يضم {n} طلبًا حُوِّل بسعر اليوم',
    en: '≈ The total includes {n} orders converted at today’s rate',
    ckb: '≈ کۆی گشتی {n} داواکاری لەخۆ دەگرێت کە بە نرخی ئەمڕۆ گۆڕدراون',
  },
  usdNone: {
    ar: 'لا يوجد سعر دولار معتمد بعد؛ تبقى الأرقام بالدينار.',
    en: 'No approved dollar rate yet; figures stay in dinars.',
    ckb: 'هێشتا نرخی دۆلاری پەسەندکراو نییە؛ ژمارەکان بە دینار دەمێننەوە.',
  },
  accountingValue: {
    ar: 'القيمة المحاسبية: {amount}',
    en: 'Accounting value: {amount}',
    ckb: 'بەهای ژمێریاری: {amount}',
  },
  chartsInUsd: {
    ar: 'القيم بالدولار للعرض، كل طلب بسعر وقت إنشائه؛ حسب يوم استلام الطلب بتوقيت بغداد.',
    en: 'Values in US dollars for display, each order at the rate of its own time; by delivered date in Baghdad time.',
    ckb: 'بەهاکان بە دۆلار بۆ پیشاندان، هەر داواکارییەک بە نرخی کاتی خۆی؛ بەپێی ڕۆژی گەیاندن بە کاتی بەغدا.',
  },
} as const satisfies Record<string, Tri>;

export type PaStringKey = keyof typeof PA_STRINGS;

/** Replace each `{name}` with its value; an unknown placeholder stays as written. */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{([a-z_]+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

/** The viewer's sentence through the screen's own `loc`. */
export function tri(loc: (ar: string, en: string, ckb?: string) => string, entry: Tri, values?: Record<string, string | number>): string {
  const text = loc(entry.ar, entry.en, entry.ckb);
  return values ? fill(text, values) : text;
}
