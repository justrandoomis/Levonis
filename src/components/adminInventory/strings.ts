/**
 * Every word the inventory workspace says, in the platform's three languages.
 *
 * Arabic is written FIRST and is the one that had to read naturally — this is
 * the owner's own screen and «إدارة المخزون» is how they think about it.
 * English and Kurdish follow the same sentence, not a shorter one: a screen
 * that explains itself in Arabic and shrugs in English is a screen that teaches
 * two different things about the same number.
 *
 * COUNTS ARE INTERPOLATED AS PREFORMATTED STRINGS, so the digits are already
 * in the reader's script when they arrive. That also means the number is not
 * available to branch on, which is why the Arabic sentences use «عدد … : ٧»
 * rather than a plural form — the same dodge adminFinance/strings.ts uses, and
 * for the same reason: Arabic has six count agreements and a table of them
 * would be wrong for most of the counts this screen prints.
 */
export function inventoryStrings(loc: (ar: string, en: string, ckb?: string) => string) {
  return {
    title: loc('إدارة المخزون', 'Inventory', 'بەڕێوەبردنی کۆگا'),

    tabs: {
      stock: loc('المخزون الحالي', 'Current stock', 'کۆگای ئێستا'),
      incoming: loc('المشتريات القادمة', 'Incoming', 'کڕینە داهاتووەکان'),
      movements: loc('الحركات', 'Movements', 'جوڵەکان'),
      suppliers: loc('الموردون', 'Suppliers', 'دابینکەرەکان'),
    },

    stats: {
      onHand: loc('الوحدات على الرف', 'Units on hand', 'یەکەکان لە کۆگا'),
      value: loc('قيمة المخزون', 'Inventory value', 'بەهای کۆگا'),
      valueHint: loc(
        'مجموع (المتبقي × تكلفة دفعته) — وليس المخزون × آخر سعر.',
        'Sum of (remaining × its own batch cost) — not stock × the latest price.',
        'کۆی (ماوە × تێچووی کۆگای خۆی) — نەک کۆگا × دوا نرخ.'
      ),
      lots: loc('دفعات نشطة', 'Active batches', 'کۆگا چالاکەکان'),
      incoming: loc('في الطريق', 'On the way', 'لە ڕێگادا'),
      unpriced: (units: string) =>
        loc(
          `${units} وحدة بلا تكلفة معروفة — غير محسوبة في القيمة أعلاه.`,
          `${units} units with no known cost — not counted in the value above.`,
          `${units} یەکە بەبێ تێچووی زانراو — لە بەهای سەرەوە حیساب نەکراون.`
        ),
      aging: loc('عمر المخزون', 'Stock age', 'تەمەنی کۆگا'),
      agingHint: loc(
        'حسب تاريخ استلام كل دفعة. الأقدم يُباع أولًا.',
        'By each batch’s receipt date. The oldest sells first.',
        'بەپێی ڕێکەوتی وەرگرتنی هەر کۆگایەک. کۆنترین یەکەم دەفرۆشرێت.'
      ),
    },

    stock: {
      search: loc('ابحث باسم المنتج أو الرمز', 'Search by product name or SKU', 'گەڕان بە ناوی بەرهەم یان کۆد'),
      product: loc('المنتج', 'Product', 'بەرهەم'),
      onHand: loc('المتوفر', 'On hand', 'بەردەست'),
      batches: loc('الدفعات', 'Batches', 'کۆگاکان'),
      nextCost: loc('تكلفة الوحدة التالية', 'Next unit cost', 'تێچووی یەکەی داهاتوو'),
      nextCostHint: loc(
        'تكلفة أقدم دفعة متبقية — هذه هي التكلفة التي ستُحتسب على أول قطعة تُباع.',
        'The oldest remaining batch’s cost — what the very next unit sold will be costed at.',
        'تێچووی کۆنترین کۆگای ماوە — ئەوەی یەکەم یەکەی فرۆشراو پێی حیساب دەکرێت.'
      ),
      newestCost: loc('أحدث تكلفة', 'Newest cost', 'نوێترین تێچوو'),
      value: loc('القيمة', 'Value', 'بەها'),
      oldest: loc('أقدم دفعة', 'Oldest batch', 'کۆنترین کۆگا'),
      unknown: loc('غير معروفة', 'Not known', 'نەزانراو'),
      empty: loc('لا توجد دفعات مخزون بعد.', 'No stock batches yet.', 'هێشتا هیچ کۆگایەک نییە.'),
      viewLots: loc('عرض الدفعات', 'View batches', 'بینینی کۆگاکان'),
      adjust: loc('تعديل الكمية', 'Adjust quantity', 'ڕێکخستنی بڕ'),
      days: (n: string) => loc(`منذ ${n} يومًا`, `${n} days ago`, `${n} ڕۆژ لەمەوپێش`),
      /** The one sentence that explains the whole feature. */
      manyCosts: loc(
        'المخزون الواحد قد يحمل أكثر من تكلفة. كل بيعة تستهلك أقدم دفعة أولًا.',
        'One product’s stock may carry several costs. Every sale consumes the oldest batch first.',
        'کۆگای یەک بەرهەم لەوانەیە چەند تێچووێکی هەبێت. هەر فرۆشتنێک یەکەم کۆنترین کۆگا بەکاردەهێنێت.'
      ),
    },

    lots: {
      title: loc('دفعات هذا المنتج', 'This product’s batches', 'کۆگاکانی ئەم بەرهەمە'),
      received: loc('استُلمت', 'Received', 'وەرگیراوە'),
      remaining: loc('المتبقي', 'Remaining', 'ماوە'),
      sold: loc('بيع منها', 'Sold from it', 'لێی فرۆشراوە'),
      unitCost: loc('تكلفة الوحدة', 'Unit cost', 'تێچووی یەکە'),
      breakdown: loc('شراء + شحن + توصيل', 'Purchase + freight + delivery', 'کڕین + گواستنەوە + گەیاندن'),
      supplier: loc('المورد', 'Supplier', 'دابینکەر'),
      date: loc('تاريخ الاستلام', 'Received on', 'ڕێکەوتی وەرگرتن'),
      basis: {
        received: loc('استلام موثّق', 'Recorded receipt', 'وەرگرتنی تۆمارکراو'),
        opening: loc('رصيد افتتاحي', 'Opening balance', 'باڵانسی کردنەوە'),
        opening_unpriced: loc('رصيد افتتاحي بلا تكلفة', 'Opening, no cost', 'کردنەوە، بێ تێچوو'),
      },
      openingHint: loc(
        'دفعة أُنشئت عند تفعيل نظام الدفعات من المخزون الذي كان موجودًا. تكلفتها مأخوذة من سعر الكلفة المسجّل وقتها.',
        'A batch created when batch tracking was switched on, from the stock that already existed. Its cost is the cost price recorded at the time.',
        'کۆگایەک کە لە کاتی کارخستنی سیستەمی کۆگادا دروستکراوە لەو کۆگایەی پێشتر هەبوو. تێچووەکەی لە نرخی تۆمارکراوی ئەو کاتەوەیە.'
      ),
    },

    incoming: {
      newPurchase: loc('تسجيل شراء جديد', 'Record a purchase', 'تۆمارکردنی کڕینێکی نوێ'),
      product: loc('المنتج', 'Product', 'بەرهەم'),
      qty: loc('الكمية المطلوبة', 'Quantity ordered', 'بڕی داواکراو'),
      unitPrice: loc('سعر شراء الوحدة', 'Purchase price per unit', 'نرخی کڕینی یەکە'),
      shipping: loc('كلفة الشحن الإجمالية', 'Total freight cost', 'کۆی تێچووی گواستنەوە'),
      internal: loc('التوصيل إلى المخزن', 'Delivery to the warehouse', 'گەیاندن بۆ کۆگا'),
      zeroIsValid: loc(
        'الصفر إجابة صحيحة — اكتب ٠ إذا لم تدفع شيئًا. اتركه فارغًا فقط إذا كنت لا تعرف بعد.',
        'Zero is a valid answer — type 0 if you paid nothing. Leave it empty only if you do not know yet.',
        'سفر وەڵامێکی دروستە — ٠ بنووسە ئەگەر هیچت نەداوە. تەنها بەتاڵی بهێڵەوە ئەگەر هێشتا نازانیت.'
      ),
      supplier: loc('المورد', 'Supplier', 'دابینکەر'),
      supplierRef: loc('رقم الفاتورة لدى المورد', 'Supplier’s invoice number', 'ژمارەی پسووڵەی دابینکەر'),
      purchaseDate: loc('تاريخ الشراء', 'Purchase date', 'ڕێکەوتی کڕین'),
      expected: loc('الوصول المتوقع', 'Expected arrival', 'گەیشتنی چاوەڕوانکراو'),
      tracking: loc('رقم التتبع', 'Tracking number', 'ژمارەی شوێنپێهەڵگرتن'),
      notes: loc('ملاحظات', 'Notes', 'تێبینییەکان'),
      status: loc('الحالة', 'Status', 'دۆخ'),
      statuses: {
        draft: loc('مسودّة', 'Draft', 'ڕەشنووس'),
        incoming: loc('في الطريق', 'On the way', 'لە ڕێگادا'),
        partial: loc('استُلم جزئيًا', 'Partly received', 'بەشێکی وەرگیراوە'),
        received: loc('مكتمل', 'Complete', 'تەواو'),
        cancelled: loc('ملغى', 'Cancelled', 'هەڵوەشێنراوە'),
      },
      outstanding: loc('المتبقي', 'Outstanding', 'ماوە'),
      total: loc('إجمالي الشراء', 'Purchase total', 'کۆی کڕین'),
      receive: loc('استلام', 'Receive', 'وەرگرتن'),
      receiveTitle: loc('إضافة إلى المخزون الحالي', 'Add to current stock', 'زیادکردن بۆ کۆگای ئێستا'),
      receiveQty: loc('الكمية المستلمة الآن', 'Quantity received now', 'بڕی ئێستا وەرگیراو'),
      confirmReceive: loc('تأكيد الاستلام', 'Confirm receipt', 'پشتڕاستکردنەوەی وەرگرتن'),
      costsFrozen: loc(
        'استُلم جزء من هذه الدفعة، فتكاليفها مثبّتة ولا يمكن تعديلها. الوحدات المستلمة بيعت أو قد تُباع بهذه التكلفة، وتغييرها الآن يعيد كتابة ربح سبق أن أُبلغ عنه.',
        'Part of this purchase has been received, so its costs are frozen. The received units may already have sold at that cost, and changing it now would rewrite profit that has been reported.',
        'بەشێک لەم کڕینە وەرگیراوە، بۆیە تێچووەکانی جێگیرن. یەکە وەرگیراوەکان لەوانەیە فرۆشرابن بەو تێچووە، و گۆڕینی ئێستا قازانجێک دەنووسێتەوە کە پێشتر ڕاپۆرت کراوە.'
      ),
      empty: loc('لا توجد مشتريات مسجّلة.', 'No purchases recorded.', 'هیچ کڕینێک تۆمار نەکراوە.'),
      profitPreview: loc('الربح المتوقع', 'Expected profit', 'قازانجی چاوەڕوانکراو'),
      sellingPrice: loc('سعر البيع الحالي', 'Current selling price', 'نرخی فرۆشتنی ئێستا'),
      perUnitProfit: loc('ربح الوحدة', 'Profit per unit', 'قازانجی یەکە'),
      margin: loc('هامش الربح', 'Margin', 'ڕێژەی قازانج'),
      wholeBatch: loc('ربح الدفعة كاملة', 'Profit on the whole batch', 'قازانجی هەموو کۆگاکە'),
      previewOnly: loc(
        'هذا عرض فقط ولا يغيّر أي سعر.',
        'A preview only — it changes no price.',
        'تەنها پێشبینینە — هیچ نرخێک ناگۆڕێت.'
      ),
    },

    receipt: {
      unitCost: loc('تكلفة الوحدة بعد الاستلام', 'Unit cost after receiving', 'تێچووی یەکە دوای وەرگرتن'),
      purchaseShare: loc('سعر الشراء', 'Purchase price', 'نرخی کڕین'),
      freightShare: loc('حصة الشحن', 'Freight share', 'بەشی گواستنەوە'),
      deliveryShare: loc('حصة التوصيل', 'Delivery share', 'بەشی گەیاندن'),
      totalCost: loc('التكلفة الإجمالية لهذه الدفعة', 'Total cost of this batch', 'کۆی تێچووی ئەم کۆگایە'),
      spreadNote: loc(
        'الشحن والتوصيل مقسومان على الكمية المطلوبة كاملة، لا على المستلم اليوم — وإلا لظهرت الشحنة الواحدة بتكلفتين.',
        'Freight and delivery are spread over the whole ordered quantity, not over what arrived today — otherwise one shipment would show two different costs.',
        'گواستنەوە و گەیاندن بەسەر هەموو بڕی داواکراودا دابەشکراون، نەک بەسەر ئەوەی ئەمڕۆ گەیشتووە.'
      ),
      irreversible: loc(
        'بعد التأكيد تُضاف الوحدات إلى المخزون وتُثبَّت تكلفتها. التراجع يكون بتعديل كمية، لا بحذف.',
        'Once confirmed the units join your stock and their cost is fixed. Undoing it means an adjustment, not a deletion.',
        'دوای پشتڕاستکردنەوە یەکەکان دەچنە کۆگاوە و تێچوویان جێگیر دەبێت.'
      ),
    },

    adjust: {
      title: loc('تعديل كمية المخزون', 'Adjust the stock quantity', 'ڕێکخستنی بڕی کۆگا'),
      counted: loc('الكمية التي عددتها', 'The quantity you counted', 'ئەو بڕەی ژماردت'),
      current: loc('المسجّل حاليًا', 'Currently recorded', 'ئێستا تۆمارکراوە'),
      delta: loc('الفرق', 'Difference', 'جیاوازی'),
      reason: loc('السبب', 'Reason', 'هۆکار'),
      reasons: {
        count: loc('جرد', 'Stock count', 'ژمێرکردن'),
        damaged: loc('تلف', 'Damaged', 'زیانی پێگەیشتووە'),
        lost: loc('مفقود', 'Lost', 'ونبووە'),
        supplier_shortage: loc('نقص من المورد', 'Supplier shortage', 'کەمی لە دابینکەر'),
        other: loc('أخرى', 'Other', 'هیتر'),
      },
      note: loc('ملاحظة', 'Note', 'تێبینی'),
      fifoNote: loc(
        'النقص يُخصم من أقدم دفعة أولًا — لأن الوحدات الناقصة وحدات اشتُريت، وأقدمها هو ما كانت البيعة التالية ستستهلكه.',
        'A shortfall comes out of the oldest batch first — the missing units were bought, and the oldest is what the next sale would have consumed.',
        'کەمییەکە لە کۆنترین کۆگاوە کەم دەکرێتەوە.'
      ),
      apply: loc('تسجيل التعديل', 'Record the adjustment', 'تۆمارکردنی ڕێکخستن'),
      neverNegative: loc(
        'لا يمكن أن ينزل المخزون تحت الصفر.',
        'Stock can never go below zero.',
        'کۆگا ناتوانێت بچێتە خوارەوەی سفر.'
      ),
    },

    movements: {
      when: loc('متى', 'When', 'کەی'),
      what: loc('الحركة', 'Movement', 'جوڵە'),
      qty: loc('الكمية', 'Quantity', 'بڕ'),
      who: loc('بواسطة', 'By', 'لەلایەن'),
      why: loc('السبب', 'Reason', 'هۆکار'),
      kinds: {
        reserve: loc('حجز', 'Reserved', 'حیجازکراو'),
        release: loc('فكّ حجز', 'Released', 'ئازادکراو'),
        deduct: loc('بيع', 'Sold', 'فرۆشراو'),
        restore: loc('إرجاع', 'Returned', 'گەڕێنراوە'),
        adjust_in: loc('إضافة', 'Added', 'زیادکراو'),
        adjust_out: loc('خصم', 'Removed', 'لابراو'),
        adjust: loc('تعديل', 'Adjusted', 'ڕێکخراو'),
      },
      empty: loc('لا توجد حركات بعد.', 'No movements yet.', 'هێشتا هیچ جوڵەیەک نییە.'),
    },

    suppliers: {
      add: loc('إضافة مورد', 'Add a supplier', 'زیادکردنی دابینکەر'),
      name: loc('الاسم', 'Name', 'ناو'),
      contact: loc('وسيلة التواصل', 'Contact', 'پەیوەندی'),
      notes: loc('ملاحظات', 'Notes', 'تێبینییەکان'),
      empty: loc('لا يوجد موردون بعد.', 'No suppliers yet.', 'هێشتا هیچ دابینکەرێک نییە.'),
      optional: loc(
        'اختياري تمامًا. المورد اسم لتتذكّر منه اشتريت، لا أكثر.',
        'Entirely optional. A supplier is a name so you remember who you bought from, nothing more.',
        'بە تەواوی ئارەزوومەندانەیە.'
      ),
    },

    common: {
      cancel: loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە'),
      save: loc('حفظ', 'Save', 'پاشەکەوت'),
      close: loc('إغلاق', 'Close', 'داخستن'),
      loading: loc('جارٍ التحميل…', 'Loading…', 'بارکردن…'),
      refresh: loc('تحديث', 'Refresh', 'نوێکردنەوە'),
      saved: loc('تم الحفظ', 'Saved', 'پاشەکەوت کرا'),
      failed: loc('تعذّر تنفيذ العملية', 'The operation could not be completed', 'نەتوانرا کارەکە تەواو بکرێت'),
      required: loc('أكمل الحقول المطلوبة', 'Fill in the required fields', 'خانە پێویستەکان پڕ بکەوە'),
      none: loc('—', '—', '—'),
      all: loc('الكل', 'All', 'هەموو'),
    },
  };
}

export type InvStrings = ReturnType<typeof inventoryStrings>;
