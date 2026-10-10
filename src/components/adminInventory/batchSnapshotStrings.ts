/**
 * «الدفعة وأسعار الشراء» — EVERY WORD OF THE OWNER'S BATCH SNAPSHOT CARD, IN
 * ARABIC, ENGLISH AND SORANI (FX programme plan §9 §16-§19; push FX-6;
 * docs/DECISIONS.md row 183: the `ckb` slot is its own Sorani, never the
 * Arabic or the English pasted across).
 *
 * The card shows, for the owner only, the two costs never mixed: what a batch
 * actually cost in dinars (fixed), and apart from it the purchase-time
 * snapshot — the supplier's own currency and amount, the document's rate, the
 * USD/IQD, EUR/USD and CNY/USD in force with their versions, the supplier
 * cost in USD and the historical USD equivalent. A batch received before the
 * snapshot existed says «بالدينار فقط» and is never converted at today's rate;
 * a figure derived from its own purchase says so.
 *
 * Placeholders are `{name}`. Pure data: no imports.
 */
export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

export const BATCH_STRINGS = {
  title: {
    ar: 'الدفعة وأسعار الشراء',
    en: 'Batch and purchase rates',
    ckb: 'وەجبە و نرخەکانی کڕین',
  },
  purchaseTitle: {
    ar: 'دفعات هذا الشراء وأسعار الصرف وقت الشراء',
    en: 'Batches from this purchase and their exchange rates at purchase',
    ckb: 'وەجبەکانی ئەم کڕینە و نرخی ئاڵوگۆڕیان لە کاتی کڕین',
  },
  loading: {
    ar: 'جارٍ تحميل لقطة الشراء…',
    en: 'Loading the purchase snapshot…',
    ckb: 'وێنەی کڕین باردەکرێت…',
  },
  failed: {
    ar: 'تعذّر تحميل لقطة الشراء.',
    en: 'Could not load the purchase snapshot.',
    ckb: 'نەتوانرا وێنەی کڕین باربکرێت.',
  },
  empty: {
    ar: 'لا توجد دفعات مستلمة بعد.',
    en: 'No batches received yet.',
    ckb: 'هێشتا هیچ وەجبەیەک وەرنەگیراوە.',
  },
  batch: {
    ar: 'الدفعة {id} · استُلمت {date}',
    en: 'Batch {id} · received {date}',
    ckb: 'وەجبەی {id} · لە {date} وەرگیرا',
  },
  // ---- §19: the batch's own cost, fixed in IQD
  batchCostTitle: {
    ar: 'تكلفة الدفعة الفعلية (ثابتة بالدينار)',
    en: 'Actual batch cost (fixed in IQD)',
    ckb: 'تێچووی ڕاستەقینەی وەجبە (جێگیر بە دینار)',
  },
  bookedUnit: {
    ar: 'تكلفة الوحدة المسجّلة عند الاستلام',
    en: 'Unit cost booked at receipt',
    ckb: 'تێچووی یەکە کە لە کاتی وەرگرتندا تۆمارکرا',
  },
  actualUnit: {
    ar: 'تكلفة الوحدة الفعلية بعد أي تسوية',
    en: 'Actual unit cost after any reconciliation',
    ckb: 'تێچووی ڕاستەقینەی یەکە دوای هەر ڕێکخستنەوەیەک',
  },
  actualTotal: {
    ar: 'إجمالي تكلفة الدفعة',
    en: 'Batch total cost',
    ckb: 'کۆی تێچووی وەجبە',
  },
  immutableNote: {
    ar: 'لا تتغير هذه الأرقام بعد الاستلام، ولا يغيّرها سعر الصرف؛ تسوية التكلفة تُسجَّل نسخةً جديدة.',
    en: 'These figures never change after receipt, and no exchange rate moves them; a cost reconciliation is recorded as a new version.',
    ckb: 'ئەم ژمارانە دوای وەرگرتن ناگۆڕێن و هیچ نرخێکی ئاڵوگۆڕ نایانگۆڕێت؛ ڕێکخستنەوەی تێچوو وەک وەشانێکی نوێ تۆمار دەکرێت.',
  },
  // ---- §17: the purchase-time snapshot, apart
  snapshotTitle: {
    ar: 'لقطة الشراء',
    en: 'Purchase snapshot',
    ckb: 'وێنەی کڕین',
  },
  supplierAmount: {
    ar: 'عملة المورد والمبلغ للوحدة',
    en: 'Supplier currency and amount per unit',
    ckb: 'دراو و بڕی دابینکەر بۆ هەر یەکەیەک',
  },
  lineTotal: {
    ar: 'إجمالي البند بعملة المورد',
    en: 'Line total in the supplier’s currency',
    ckb: 'کۆی هێڵەکە بە دراوی دابینکەر',
  },
  documentRate: {
    ar: 'سعر مستند الشراء (دينار للوحدة من عملته)',
    en: 'Purchase document rate (IQD per unit of its currency)',
    ckb: 'نرخی بەڵگەنامەی کڕین (دینار بۆ هەر یەکەیەکی دراوەکەی)',
  },
  usdIqd: {
    ar: 'الدولار بالدينار وقت الشراء',
    en: 'USD/IQD at purchase',
    ckb: 'دۆلار بە دینار لە کاتی کڕین',
  },
  eurUsd: {
    ar: 'اليورو بالدولار وقت الشراء',
    en: 'EUR/USD at purchase',
    ckb: 'یۆرۆ بە دۆلار لە کاتی کڕین',
  },
  cnyUsd: {
    ar: 'اليوان بالدولار وقت الشراء',
    en: 'CNY/USD at purchase',
    ckb: 'یوانی چینی بە دۆلار لە کاتی کڕین',
  },
  supplierUsd: {
    ar: 'تكلفة المورد بالدولار وقت الشراء',
    en: 'Supplier cost in USD at purchase',
    ckb: 'تێچووی دابینکەر بە دۆلار لە کاتی کڕین',
  },
  historicalUsd: {
    ar: 'المكافئ التاريخي بالدولار لتكلفة الوحدة',
    en: 'Historical USD equivalent of the unit cost',
    ckb: 'هاوتای مێژوویی تێچووی یەکە بە دۆلار',
  },
  version: {
    ar: 'الإصدار {n}',
    en: 'version {n}',
    ckb: 'وەشانی {n}',
  },
  fromDocument: {
    ar: 'سعر مستند الشراء نفسه',
    en: 'the purchase document’s own rate',
    ckb: 'نرخی خودی بەڵگەنامەی کڕین',
  },
  fromCentral: {
    ar: 'السعر المعتمد في المتجر وقت تأكيد الشراء',
    en: 'the shop’s rate when the purchase was confirmed',
    ckb: 'نرخی فرۆشگا لە کاتی پشتڕاستکردنەوەی کڕین',
  },
  ratesTakenAt: {
    ar: 'أُخذت الأسعار المركزية في {date}',
    en: 'Central rates taken on {date}',
    ckb: 'نرخە ناوەندییەکان لە {date} وەرگیران',
  },
  recordedAt: {
    ar: 'سُجّلت اللقطة عند الاستلام في {date}',
    en: 'Snapshot recorded at receipt on {date}',
    ckb: 'وێنەکە لە کاتی وەرگرتن لە {date} تۆمارکرا',
  },
  splitFrom: {
    ar: 'جزء منقول من الدفعة {id}، بلقطتها نفسها',
    en: 'A moved part of batch {id}, with its own snapshot',
    ckb: 'بەشێکی گوازراوەی وەجبەی {id}، بە هەمان وێنەی خۆی',
  },
  unknown: {
    ar: 'غير معروف',
    en: 'Unknown',
    ckb: 'نەزانراو',
  },
  // ---- §18: a historical batch known only in IQD
  iqdOnly: {
    ar: 'بالدينار فقط',
    en: 'Known only in IQD',
    ckb: 'تەنها بە دینار',
  },
  iqdOnlyNote: {
    ar: 'دفعة أقدم من تسجيل أسعار الصرف: لم يُسجَّل سعر وقت شرائها، ولا تُحوَّل أبدًا بسعر اليوم.',
    en: 'A batch older than exchange-rate recording: no rate was recorded when it was bought, and it is never converted at today’s rate.',
    ckb: 'وەجبەیەک کە لە تۆمارکردنی نرخی ئاڵوگۆڕ کۆنترە: لە کاتی کڕینیدا هیچ نرخێک تۆمار نەکراوە، و هەرگیز بە نرخی ئەمڕۆ ناگۆڕدرێت.',
  },
  derivedDocument: {
    ar: 'مشتق من مستند الشراء',
    en: 'derived from the purchase document',
    ckb: 'لە بەڵگەنامەی کڕینەوە دەرهێنراوە',
  },
  derivedSnapshot: {
    ar: 'مشتق من سعر الشراء المسجَّل',
    en: 'derived from the purchase’s recorded rate',
    ckb: 'لە نرخی تۆمارکراوی کڕینەکەوە دەرهێنراوە',
  },
  derivedNote: {
    ar: 'دفعة أقدم من اللقطة: هذا الرقم محسوب للعرض من سعر شرائها، ولم يُخزَّن عليها.',
    en: 'A batch older than the snapshot: this figure is computed for display from its own purchase rate and is not stored on it.',
    ckb: 'وەجبەیەک کە لە وێنەکە کۆنترە: ئەم ژمارەیە بۆ پیشاندان لە نرخی کڕینی خۆی هەژمار کراوە و لەسەری هەڵنەگیراوە.',
  },
} as const satisfies Record<string, Tri>;

export type BatchStringKey = keyof typeof BATCH_STRINGS;

/** Replace each `{name}` with its value; an unknown placeholder stays as written. */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{([a-z_]+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

/** The viewer's sentence through the screen's own `loc`. */
export function tri(loc: (ar: string, en: string, ckb?: string) => string, entry: Tri, values?: Record<string, string | number>): string {
  const text = loc(entry.ar, entry.en, entry.ckb);
  return values ? fill(text, values) : text;
}
