/**
 * EVERY WORD ON THE PROFIT SCREEN, IN THE THREE LANGUAGES THE PLATFORM SPEAKS.
 *
 * Built from the context's own `loc(ar, en, ckb)` and never from
 * `dir === 'rtl' ? ar : en`. That idiom is banned across `src/` for a concrete
 * reason: 'ckb' is ALSO a right-to-left language, so the ternary hands Arabic
 * to every Kurdish reader and the bug is invisible to anyone testing in Arabic
 * or English. Passing all three strings at the call site makes a missing
 * Kurdish word a visible gap rather than a silent substitution.
 *
 * The copy is written Arabic-first because the owner reads Arabic and because
 * these are the words that have to be exactly right: «الربح الإجمالي» and
 * «الربح الصافي» are two different numbers and the screen must never let them
 * blur into one «الربح».
 */

export type Loc = (ar: string, en: string, ckb?: string) => string;

export function financeStrings(loc: Loc) {
  return {
    // ------------------------------------------------------------- the page
    title: loc('الأرباح والتكاليف', 'Profit & costs', 'قازانج و تێچوون'),
    intro: loc(
      'يُحتسب البيع ربحًا يوم تسليمه للزبون، بتوقيت بغداد — لا يوم الطلب ولا يوم الدفع. والمرتجع يُخصم من الشهر الذي تقرّر فيه.',
      'A sale becomes profit on the day it reaches the customer, in Baghdad time — not the day it was ordered or paid. A refund is deducted from the month it was decided in.',
      'فرۆشتنێک لەو ڕۆژەدا دەبێتە قازانج کە دەگاتە کڕیار، بە کاتی بەغدا — نەک ڕۆژی داواکردن یان پارەدان.'
    ),
    ownerOnly: loc(
      'هذه الشاشة للمالك أو للدور المالي فقط. مساعد الأدمن لا يرى التكلفة ولا الربح — لا هنا ولا في أي رد من الخادم.',
      'This screen is for the owner or a financial admin only. An assistant admin sees no cost and no profit — not here and not in any server response.',
      'ئەم شاشەیە تەنها بۆ خاوەن یان ڕۆڵی دارایییە.'
    ),

    // ------------------------------------------------------- the period row
    periodLabel: loc('الفترة', 'Period', 'ماوە'),
    today: loc('اليوم', 'Today', 'ئەمڕۆ'),
    last7: loc('آخر ٧ أيام', 'Last 7 days', 'دوا ٧ ڕۆژ'),
    last30: loc('آخر ٣٠ يومًا', 'Last 30 days', 'دوا ٣٠ ڕۆژ'),
    thisMonth: loc('هذا الشهر', 'This month', 'ئەم مانگە'),
    last90: loc('آخر ٩٠ يومًا', 'Last 90 days', 'دوا ٩٠ ڕۆژ'),
    custom: loc('مدة مخصّصة', 'Custom range', 'ماوەی دیاریکراو'),
    from: loc('من', 'From', 'لە'),
    to: loc('إلى', 'To', 'بۆ'),
    apply: loc('اعرض', 'Apply', 'پیشان بدە'),
    granularityLabel: loc('التقسيم', 'Grouping', 'دابەشکردن'),
    byDay: loc('يومي', 'Daily', 'ڕۆژانە'),
    byWeek: loc('أسبوعي', 'Weekly', 'هەفتانە'),
    byMonth: loc('شهري', 'Monthly', 'مانگانە'),
    wholeRange: loc('الفترة كاملة', 'Whole period', 'هەموو ماوەکە'),
    refresh: loc('تحديث', 'Refresh', 'نوێکردنەوە'),

    // range validation, said before the request leaves
    badFrom: loc('تاريخ البداية غير صالح', 'The start date is not a real day', 'بەرواری دەستپێک دروست نییە'),
    badTo: loc('تاريخ النهاية غير صالح', 'The end date is not a real day', 'بەرواری کۆتایی دروست نییە'),
    reversed: loc('البداية يجب أن تسبق النهاية', 'The start must come before the end', 'دەستپێک دەبێت پێش کۆتایی بێت'),
    tooLong: loc('أقصى مدة ٣٦٦ يومًا', 'The longest range is 366 days', 'درێژترین ماوە ٣٦٦ ڕۆژە'),

    // ------------------------------------------------------ the hero figures
    revenue: loc('المبيعات', 'Revenue', 'فرۆشتن'),
    grossProfit: loc('الربح الإجمالي', 'Gross profit', 'قازانجی گشتی'),
    netProfit: loc('الربح الصافي', 'Net profit', 'قازانجی ساف'),
    grossMargin: loc('هامش الربح الإجمالي', 'Gross margin', 'ڕێژەی قازانجی گشتی'),
    netMargin: loc('هامش الربح الصافي', 'Net margin', 'ڕێژەی قازانجی ساف'),
    orders: loc('طلبات مسلَّمة', 'Delivered orders', 'داواکاری گەیشتوو'),
    vsPrevious: loc('مقارنة بالفترة السابقة', 'vs the previous period', 'بەراورد بە ماوەی پێشوو'),
    previousPeriod: loc('الفترة السابقة', 'Previous period', 'ماوەی پێشوو'),
    noComparison: loc('لا شيء قبلها للمقارنة', 'Nothing before it to compare with', 'هیچی پێشوو نییە بۆ بەراورد'),
    equalLength: loc('بنفس الطول', 'of equal length', 'بە هەمان درێژی'),

    // the distinction the whole screen exists to keep
    grossShort: loc(
      'المبيعات ناقص تكلفة البضاعة المباعة.',
      'Revenue minus the cost of the goods sold.',
      'فرۆشتن کەم تێچووی کاڵا.'
    ),
    grossMeans: loc(
      'المبيعات ناقص تكلفة البضاعة المباعة. يخصّ المنتج، فيُقسَّم على المنتجات والتصنيفات.',
      'Revenue minus the cost of the goods sold. It belongs to a product, so it breaks down by product and by category.',
      'فرۆشتن کەم تێچووی کاڵا فرۆشراوەکان. سەر بە بەرهەمە، بۆیە بەپێی بەرهەم و بەپێی پۆل دابەش دەکرێت.'
    ),
    netMeans: loc(
      'الربح الإجمالي، زائد التوصيل وضريبة الدفع عند الاستلام المحصَّلَين، ناقص النقاط المستهلكة وكوبونات الطلبات والمصاريف التشغيلية. للفترة فقط — الإيجار لا يخصّ منتجًا بعينه.',
      'Gross profit, plus the delivery and cash-on-delivery fees collected, minus points redeemed, order coupons and operating expenses. Per period ONLY — rent belongs to no product.',
      'قازانجی گشتی، کۆی گەیاندن و باجی پارەدان لە کاتی وەرگرتن، کەم خاڵی بەکارهێنراو و کۆپۆنی داواکاری و خەرجی کارگێڕی. تەنها بۆ ماوەکە — کرێ سەر بە هیچ بەرهەمێک نییە.'
    ),
    noPerProductNet: loc(
      'لا يوجد ربح صافٍ لكل منتج، ولن يوجد: المصروف التشغيلي لا يخصّ منتجًا، وتوزيعه على المنتجات اختراع لا حساب.',
      'There is no per-product net profit, and there never will be: an operating expense belongs to no product, and splitting it across products is an invention, not a calculation.',
      'قازانجی ساف بۆ هەر بەرهەمێک بوونی نییە و هەرگیز نابێت: خەرجی کارگێڕی سەر بە هیچ بەرهەمێک نییە، و دابەشکردنی بەسەر بەرهەمەکاندا داهێنانە نەک ژمێرکاری.'
    ),

    // --------------------------------------------- honesty about the numbers
    honestyTitle: loc('ما الذي يجب أن تعرفه عن هذه الأرقام', 'What you need to know about these figures', 'ئەوەی پێویستە دەربارەی ئەم ژمارانە بزانیت'),
    estimatedBadge: loc('مقدَّر جزئيًا', 'Partly estimated', 'بەشێکی خەمڵێنراوە'),
    /*
     * COUNTED NOUNS ARE PHRASED AROUND THE AGREEMENT, NOT THROUGH IT.
     *
     * Arabic takes the broken plural after 3–10 («٧ أسطر») and the singular
     * after 11 and up («١٢ سطرًا»), so a template that hard-codes one form
     * reads as machine Arabic for the commonest counts — on the four sentences
     * that matter most, because disclosure IS the feature of this screen. The
     * count is a preformatted STRING here (Arabic-Indic digits already
     * applied), so the number itself is not available to branch on.
     *
     * «عدد أسطر البيع … : ٧» sidesteps the agreement entirely and is what a
     * shop owner would actually write. It costs nothing and is correct for
     * every count, which a table of four plural forms would not be.
     */
    estimatedLines: (lines: string, cost: string) =>
      loc(
        `عدد أسطر البيع بلا تكلفة محفوظة لحظة البيع: ${lines}. حُسبت تكلفتها بسعر الكلفة الحالي (${cost}). إذا غيّرت سعر تكلفة لاحقًا تغيّر هذا الرقم — وهو تقدير، لا قياس.`,
        `Sale lines with no cost captured at the moment of sale: ${lines}. Their cost was computed from today's catalogue price (${cost}). Change a supplier price later and this figure moves — it is an estimate, not a measurement.`,
        `ژمارەی هێڵە فرۆشتنەکان بەبێ تێچووی تۆمارکراو لە کاتی فرۆشتن: ${lines}. تێچوویان بە نرخی ئێستای کەتەلۆگ حیسابکراوە (${cost}). ئەگەر دواتر نرخی تێچوو بگۆڕیت ئەم ژمارەیە دەگۆڕێت — خەمڵاندنە، پێوانە نییە.`
      ),
    /**
     * THE GOOD-NEWS DISCLOSURE. Written to say what was MEASURED and against
     * what, because «محسوبة» on its own is a claim the reader cannot check.
     * Same count-agreement dodge as `estimatedLines` above: «عدد أسطر البيع …»
     * rather than a plural form that is wrong for two thirds of the counts.
     */
    fifoMeasured: (lines: string, cost: string, total: string) =>
      loc(
        `عدد أسطر البيع المحسوبة حسب دفعات الشراء الفعلية: ${lines}، بتكلفة ${cost} من أصل ${total}. هذه أدقّ أساس تكلفة في النظام: كل وحدة حُسبت بسعر الدفعة التي خرجت منها فعلًا، لا بمتوسط ولا بسعر اليوم.`,
        `Sale lines costed against the purchase batches they actually came from: ${lines}, worth ${cost} of ${total}. This is the strongest cost basis in the system — every unit priced at what its own batch cost, not an average and not today's price.`,
        `هێڵە فرۆشتنەکانی کە بەپێی ئەو کۆگایانەی بەڕاستی لێیان هاتوون حیسابکراون: ${lines}، بە تێچووی ${cost} لە کۆی ${total}. ئەمە بەهێزترین بنەمای تێچوویە لە سیستەمەکەدا — هەر یەکەیەک بە نرخی کۆگای خۆی حیسابکراوە، نە بە مامناوەند و نە بە نرخی ئەمڕۆ.`
      ),
    noSnapshotColumn: loc(
      'عمود التكلفة لحظة البيع غير موجود في قاعدة البيانات بعد (ترحيل 0095). كل تكلفة على هذه الشاشة مقدَّرة بسعر الكلفة الحالي، وكل ربح هنا تقدير.',
      'The cost-at-sale column is not in the database yet (migration 0095). Every cost on this screen is estimated from today’s catalogue price, and every profit here is an estimate.',
      'ستوونی تێچوو لە کاتی فرۆشتن هێشتا لە بنکەی دراوەکە نییە (گواستنەوەی 0095). هەموو تێچووەکانی ئەم شاشەیە بە نرخی تێچووی ئێستا خەمڵێنراون، و هەموو قازانجێکی لێرە خەمڵاندنە.'
    ),
    uncosted: (lines: string, revenue: string) =>
      loc(
        `مبيعات بقيمة ${revenue} (عدد الأسطر: ${lines}) لا تُعرف تكلفتها إطلاقًا. هذه المبيعات خارج حساب الهامش وخارج الربح الصافي معًا — المبلغ مقبوض، لكن ربحه غير محسوب. لم تُضَف بتكلفة صفر ولم تُحذف من المبيعات.`,
        `Sales worth ${revenue} (lines: ${lines}) have no known cost at all. They are outside the margin base AND outside net profit — the money was collected, but its profit is not computed. They are not counted as zero cost and not removed from revenue.`,
        `فرۆشتن بە بڕی ${revenue} (ژمارەی هێڵەکان: ${lines}) تێچوویان هیچ نازانرێت. ئەمانە دەرەوەی ژمێرکاری ڕێژە و دەرەوەی قازانجی ساف‌ن پێکەوە — پارەکە وەرگیراوە، بەڵام قازانجەکەی حیساب نەکراوە. بە تێچووی سفر دانەنراون و لە فرۆشتنیش لانەبراون.`
      ),
    noExpenseLedger: loc(
      'سجل المصاريف التشغيلية غير مثبّت، فالربح الصافي هنا يساوي الربح الإجمالي. هذا ليس معناه أنك لم تصرف شيئًا.',
      'The operating-expense ledger is not installed, so net profit here equals gross profit. That does not mean nothing was spent.',
      'دەفتەری خەرجی کارگێڕی دانەمەزراوە، بۆیە قازانجی ساف لێرە یەکسانە بە قازانجی گشتی. ئەمە مانای ئەوە نییە هیچت خەرج نەکردووە.'
    ),
    netOnKnownCostOnly: (share: string, revenue: string) =>
      loc(
        `تنبيه على هذا الرقم: ${share} من مبيعات الفترة (${revenue}) بلا تكلفة معروفة، فربحها غير محسوب في الربح الصافي — بينما المصاريف التشغيلية مطروحة كاملة. أدخل التكاليف الناقصة وسيتغيّر هذا الرقم للأعلى.`,
        `A caution on this figure: ${share} of the period’s sales (${revenue}) have no known cost, so their profit is NOT counted in net profit — while operating expenses are subtracted in full. Enter the missing costs and this figure will move up.`,
        `ئاگاداری لەسەر ئەم ژمارەیە: ${share} ی فرۆشتنی ماوەکە (${revenue}) تێچووی نەزانراوە، بۆیە قازانجەکەی لە قازانجی ساف حیساب نەکراوە — لە کاتێکدا خەرجی کارگێڕی بە تەواوی کەم کراوەتەوە. تێچووە کەموکوڕییەکان بنووسە و ئەم ژمارەیە بەرز دەبێتەوە.`
      ),
    noExpensesRecorded: loc(
      'لم تُسجَّل أي مصاريف تشغيلية في هذه الفترة، فالربح الصافي هنا يساوي الربح الإجمالي تمامًا. هذا لا يعني أنك لم تصرف شيئًا — افتح «سجل المصاريف» وأدخل الإيجار والرواتب والإعلانات.',
      'No operating expenses were recorded in this period, so net profit here equals gross profit exactly. That does not mean nothing was spent — open the expense ledger and enter rent, salaries and advertising.',
      'هیچ خەرجییەکی کارگێڕی لەم ماوەیەدا تۆمار نەکراوە، بۆیە قازانجی ساف لێرە تەواو یەکسانە بە قازانجی گشتی. ئەمە مانای ئەوە نییە هیچت خەرج نەکردووە — «دەفتەری خەرجی» بکەرەوە و کرێ و مووچە و ڕیکلام بنووسە.'
    ),
    unrecognizedOrders: (orders: string) =>
      loc(
        `عدد الطلبات المسلَّمة بلا تاريخ تسليم مسجَّل: ${orders}. لا تنتمي إلى أي فترة على هذه الشاشة — لا هذه ولا غيرها — فأرقامها غير محسوبة أصلًا.`,
        `Delivered orders carrying no delivery date: ${orders}. They belong to no period on this screen — this one or any other — so their figures are not counted anywhere.`,
        `ژمارەی داواکارییە گەیەنراوەکان بەبێ بەرواری گەیاندن: ${orders}. سەر بە هیچ ماوەیەکی ئەم شاشەیە نین — نە ئەمە و نە هیچی تر — بۆیە ژمارەکانیان لە هیچ شوێنێک حیساب نەکراون.`
      ),
    unbucketed: (lines: string, amount: string) =>
      loc(
        `صفوف بقيمة ${amount} (عددها: ${lines}) تاريخها غير مقروء، فسقطت خارج كل الفترات.`,
        `Rows worth ${amount} (count: ${lines}) carry a timestamp that could not be read, so they fell outside every bucket.`,
        `ڕیزەکان بە بڕی ${amount} (ژمارەیان: ${lines}) بەروارەکەیان نەخوێنرایەوە، بۆیە دەرەوەی هەموو ماوەکان کەوتن.`
      ),
    topSelection: (shown: string) =>
      loc(
        `أعلى ${shown} صفًا، مختارة حسب المبيعات ومرتّبة هنا حسب الربح الإجمالي.`,
        `The top ${shown} rows, selected by revenue and ordered here by gross profit.`,
        `${shown} ڕیزی سەرەوە، بەپێی فرۆشتن هەڵبژێردراون و لێرە بەپێی قازانجی گشتی ڕیزکراون.`
      ),
    truncated: (shown: string) =>
      loc(
        `معروض أعلى ${shown} صفًا فقط — هناك المزيد خلفها.`,
        `Only the top ${shown} rows are shown — there are more behind them.`,
        `تەنها ${shown} ڕیزی سەرەوە پیشان دراون.`
      ),

    // ------------------------------------------------------------- the charts
    overTimeTitle: loc('المبيعات والأرباح عبر الوقت', 'Revenue and profit over time', 'فرۆشتن و قازانج بەدرێژایی کات'),
    overTimeCaption: loc(
      'ثلاثة أرقام بالدينار على محور واحد. الهامش نسبة مئوية ولا يُرسم هنا: محوران مختلفان على رسم واحد يخترعان علاقة غير موجودة في الأرقام.',
      'Three dinar figures on ONE axis. Margin is a percentage and is not drawn here: two different scales on one plot invent a relationship that is not in the data.',
      'سێ ژمارە بە دینار لەسەر یەک تەوەر.'
    ),
    productsTitle: loc('الربح الإجمالي حسب المنتج', 'Gross profit by product', 'قازانجی گشتی بەپێی بەرهەم'),
    mainCategoriesTitle: loc('الربح الإجمالي حسب التصنيف الرئيسي', 'Gross profit by main category', 'قازانجی گشتی بەپێی پۆلی سەرەکی'),
    subCategoriesTitle: loc('الربح الإجمالي حسب التصنيف الفرعي', 'Gross profit by sub-category', 'قازانجی گشتی بەپێی پۆلی لاوەکی'),
    expensesTitle: loc('المصاريف التشغيلية حسب البند', 'Operating expenses by category', 'خەرجی کارگێڕی بەپێی بەش'),
    expensesCaption: loc(
      'مصاريف لا علاقة لها بأي منتج — تُطرح من الربح الصافي للفترة ولا تُوزَّع على المنتجات.',
      'Costs that belong to no product — subtracted from the period’s net profit and never spread across products.',
      'خەرجی سەر بە هیچ بەرهەمێک نییە.'
    ),
    unfiled: loc('بلا تصنيف', 'Unfiled', 'بێ پۆل'),
    unnamed: loc('بلا اسم', 'Unnamed', 'بێ ناو'),

    // table twin
    showTable: loc('اعرض كجدول', 'Show as a table', 'وەک خشتە پیشان بدە'),
    showChart: loc('اعرض كرسم', 'Show as a chart', 'وەک هێڵکاری پیشان بدە'),
    colName: loc('الاسم', 'Name', 'ناو'),
    colRevenue: loc('المبيعات', 'Revenue', 'فرۆشتن'),
    colCogs: loc('تكلفة البضاعة', 'Cost of goods', 'تێچووی کاڵا'),
    colGross: loc('الربح الإجمالي', 'Gross profit', 'قازانجی گشتی'),
    colMargin: loc('الهامش', 'Margin', 'ڕێژە'),
    colUnits: loc('القطع', 'Units', 'دانە'),
    colAmount: loc('المبلغ', 'Amount', 'بڕ'),
    colEntries: loc('عدد القيود', 'Entries', 'تۆمارەکان'),
    colPeriod: loc('الفترة', 'Period', 'ماوە'),

    // ------------------------------------------------------- the other lines
    breakdownTitle: loc('من أين جاء الرقم', 'Where the figure comes from', 'ژمارەکە لەکوێوە هات'),
    grossRevenue: loc('مبيعات قبل المرتجعات', 'Revenue before refunds', 'فرۆشتن پێش گەڕاندنەوە'),
    refundedRevenue: loc('مرتجعات هذه الفترة', 'Refunds decided this period', 'گەڕاندنەوەکانی ئەم ماوەیە'),
    cogs: loc('تكلفة البضاعة المباعة', 'Cost of goods sold', 'تێچووی کاڵا فرۆشراوەکان'),
    costedRevenue: loc('مبيعات تكلفتها معروفة', 'Revenue with a known cost', 'فرۆشتنی تێچوو زانراو'),
    uncostedRevenue: loc('مبيعات بلا تكلفة معروفة', 'Revenue with no known cost', 'فرۆشتنی بێ تێچووی زانراو'),
    shipping: loc('توصيل محصَّل', 'Delivery collected', 'گەیاندنی وەرگیراو'),
    codTax: loc('ضريبة الدفع عند الاستلام', 'Cash-on-delivery tax collected', 'باجی پارەدان لە کاتی وەرگرتن'),
    points: loc('نقاط استهلكها الزبائن', 'Points redeemed by customers', 'خاڵی بەکارهێنراو'),
    couponDiscount: loc('كوبونات خصم على الطلبات', 'Order-level coupon discounts', 'داشکاندنی کۆپۆن لەسەر داواکاری'),
    opex: loc('مصاريف تشغيلية', 'Operating expenses', 'خەرجی کارگێڕی'),
    refundCases: loc('حالات إرجاع', 'Refund cases', 'حاڵەتی گەڕاندنەوە'),
    units: loc('قطعة', 'units', 'دانە'),

    // ------------------------------------------------- loading / empty / error
    loading: loc('جارٍ التحميل…', 'Loading…', 'بار دەبێت…'),
    emptyTitle: loc('لا يوجد أي طلب مسلَّم في هذه الفترة', 'No delivered orders in this period', 'هیچ داواکارییەکی گەیەنراو لەم ماوەیەدا نییە'),
    emptyBody: (range: string) =>
      loc(
        `لا شيء سُلِّم بين ${range}. البيع يصبح ربحًا يوم التسليم، فالطلبات المفتوحة أو المدفوعة وغير المسلَّمة لا تظهر هنا بعد — وهذا ليس خطأ في الشاشة. جرّب مدة أطول.`,
        `Nothing was delivered between ${range}. A sale becomes profit on the day it is delivered, so open or paid-but-undelivered orders do not appear here yet — that is not a fault in the screen. Try a longer period.`,
        `هیچ شتێک لە نێوان ${range} نەگەیەنراوە. فرۆشتن لە ڕۆژی گەیاندندا دەبێتە قازانج، بۆیە داواکارییە کراوەکان یان ئەوانەی پارەیان دراوە بەڵام نەگەیەنراون هێشتا لێرە دەرناکەون — ئەمە هەڵەی شاشەکە نییە. ماوەیەکی درێژتر تاقی بکەرەوە.`
      ),
    emptyChart: loc('لا توجد بيانات لرسمها في هذه الفترة', 'Nothing to plot in this period', 'هیچ داتایەک نییە بۆ کێشان'),
    emptyExpenses: loc(
      'لم تُسجَّل أي مصاريف تشغيلية في هذه الفترة. المصاريف تُدخَل من لوحة المصاريف، وهي خاصة بلوحة الأدمن ولا يراها الزبون.',
      'No operating expenses were recorded in this period. Expenses are entered in the expenses panel; they are admin-only and no customer ever sees them.',
      'هیچ خەرجییەکی کارگێڕی تۆمار نەکراوە لەم ماوەیەدا.'
    ),
    onePoint: loc(
      'نقطة واحدة لا تصنع خطًا. اختر مدة أطول أو قسّمها بشكل أصغر لترى الاتجاه.',
      'One point does not make a line. Choose a longer period, or a smaller grouping, to see a trend.',
      'یەک خاڵ هێڵ دروست ناکات. ماوەیەکی درێژتر هەڵبژێرە، یان دابەشکردنێکی بچووکتر، تا ئاراستەکە ببینیت.'
    ),
    forbidden: loc(
      'هذه الشاشة تحتاج صلاحية مالية. حساب المساعد لا يرى التكلفة ولا الربح.',
      'This screen needs financial permission. An assistant account sees no cost and no profit.',
      'ئەم شاشەیە ڕێپێدانی دارایی پێویستە.'
    ),
    loadFailed: loc('تعذّر تحميل التقرير المالي.', 'Could not load the financial report.', 'نەتوانرا ڕاپۆرتی دارایی باربکرێت.'),
    retry: loc('إعادة المحاولة', 'Try again', 'دووبارە هەوڵ بدە'),

    // ------------------------------------- the operating-expense ledger
    // «يستطيع الادمن في لوحه الاداره اضافه تكاليف اخرى ... خاصه في لوحه الادمن»
    tabReport: loc('التقرير', 'Report', 'ڕاپۆرت'),
    tabLedger: loc('سجل المصاريف', 'Expense ledger', 'دەفتەری خەرجی'),
    ledgerTitle: loc('المصاريف التشغيلية', 'Operating expenses', 'خەرجی کارگێڕی'),
    ledgerIntro: loc(
      'التكاليف التي لا تخصّ منتجًا بعينه: الإيجار، الرواتب، الإعلانات، الشحن، الكمارك، الرسوم. تُطرح من الربح الصافي للفترة، ولا تُوزَّع على المنتجات أبدًا — ولا يراها الزبون في أي مكان.',
      'The costs that belong to no particular product: rent, salaries, advertising, shipping, customs, fees. They are subtracted from the period’s NET profit and are never split across products — and no customer sees them anywhere.',
      'ئەو تێچووانەی سەر بە هیچ بەرهەمێکی دیاریکراو نین: کرێ، مووچە، ڕیکلام، گواستنەوە، گومرگ، باج. لە قازانجی سافی ماوەکە کەم دەکرێنەوە و هەرگیز بەسەر بەرهەمەکاندا دابەش ناکرێن — و هیچ کڕیارێک لە هیچ شوێنێک نایانبینێت.'
    ),
    addExpense: loc('سجّل مصروفًا', 'Record an expense', 'خەرجییەک تۆمار بکە'),
    fieldCategory: loc('الفئة', 'Category', 'پۆل'),
    fieldAmount: loc('المبلغ (دينار)', 'Amount (IQD)', 'بڕ (دینار)'),
    fieldDay: loc('يوم المصروف', 'Expense day', 'ڕۆژی خەرجی'),
    fieldTitle: loc('الوصف', 'Title', 'ناونیشان'),
    fieldNote: loc('ملاحظة', 'Note', 'تێبینی'),
    fieldRepeat: loc('كرّره شهريًا (عدد الأشهر)', 'Repeat monthly (months)', 'مانگانە دووبارەی بکەرەوە (مانگ)'),
    repeatMeans: loc(
      'التكرار يكتب صفوفًا حقيقية الآن، شهرًا شهرًا، كلٌّ منها قابل للتعديل أو الإلغاء وحده. ليست قاعدة تُحسب لاحقًا — لأن قاعدة كهذه تجعل ربح كانون الثاني الماضي يتغيّر بتعديل تكتبه في حزيران.',
      'A repeat writes REAL rows now, one per month, each editable and voidable on its own. It is not a rule evaluated later — such a rule would make last January’s profit change because of an edit you make in June.',
      'دووبارەکردنەوە ڕیزی ڕاستەقینە دەنووسێت ئێستا، مانگ بە مانگ، هەریەکەیان بە تەنها دەستکاری یان هەڵوەشاندنەوەیان دەکرێت. یاسایەک نییە دواتر حیساب بکرێت — چونکە یاسایەکی وا وا دەکات قازانجی کانوونی دووەمی ڕابردوو بە دەستکارییەکی حوزەیران بگۆڕێت.'
    ),
    save: loc('احفظ', 'Save', 'پاشەکەوت بکە'),
    saving: loc('جارٍ الحفظ…', 'Saving…', 'پاشەکەوت دەکرێت…'),
    savedOne: loc('سُجِّل المصروف.', 'The expense was recorded.', 'خەرجییەکە تۆمارکرا.'),
    savedMany: (months: string) =>
      loc(
        `سُجِّلت ${months} صفوف شهرية، كلٌّ منها صف مستقل يمكن تعديله أو إلغاؤه وحده.`,
        `Recorded ${months} monthly rows, each a separate row you can edit or void on its own.`,
        `${months} ڕیزی مانگانە تۆمارکران، هەریەکەیان ڕیزێکی سەربەخۆیە کە بە تەنها دەستکاری یان هەڵوەشێنرێتەوە.`
      ),
    periodTotal: loc('إجمالي الفترة', 'Period total', 'کۆی ماوەکە'),
    ledgerTruncated: (shown: string, total: string) =>
      loc(
        `معروض ${shown} من ${total} صفًا. الإجمالي أعلاه للفترة كاملة، لا للمعروض فقط.`,
        `Showing ${shown} of ${total} rows. The total above is for the WHOLE period, not for what is shown.`,
        `${shown} لە ${total} ڕیز پیشان دراوە. کۆیەکەی سەرەوە بۆ هەموو ماوەکەیە، نەک تەنها بۆ ئەوەی پیشان دراوە.`
      ),
    showVoided: loc('أظهر الملغاة', 'Show voided', 'هەڵوەشێنراوەکان پیشان بدە'),
    voidAction: loc('إلغاء', 'Void', 'هەڵوەشاندنەوە'),
    restoreAction: loc('استرجاع', 'Restore', 'گەڕاندنەوە'),
    voidReason: loc('سبب الإلغاء', 'Reason for voiding', 'هۆکاری هەڵوەشاندنەوە'),
    voidMeans: loc(
      'الإلغاء لا يمحو الصف: يبقى مسجَّلًا مع من ألغاه ومتى ولماذا، ويمكن استرجاعه. هذا مقصود — حذف مصروف يغيّر ربحًا صافيًا ربما اتخذت قرارًا على أساسه.',
      'Voiding does not erase the row: it stays, with who voided it, when and why, and it can be restored. That is deliberate — deleting an expense changes a net profit you may already have acted on.',
      'هەڵوەشاندنەوە ڕیزەکە ناسڕێتەوە: دەمێنێتەوە، لەگەڵ ئەوەی کێ هەڵیوەشاندەوە و کەی و بۆچی، و دەکرێت بگەڕێنرێتەوە. ئەمە بە ئەنقەست وایە — سڕینەوەی خەرجییەک قازانجێکی ساف دەگۆڕێت کە لەوانەیە پێشتر بڕیارت لەسەری دابێت.'
    ),
    voidedBadge: loc('ملغى', 'Voided', 'هەڵوەشێنراوە'),
    ledgerEmpty: loc(
      'لا مصاريف مسجَّلة في هذه الفترة. سجّل أول مصروف من النموذج أعلاه — وحتى تفعل، «الربح الصافي» سيساوي «الربح الإجمالي»، وهذا لا يعني أنك لم تصرف شيئًا.',
      'No expenses recorded in this period. Record the first one in the form above — until you do, NET profit equals GROSS profit, and that does not mean nothing was spent.',
      'هیچ خەرجییەک لەم ماوەیەدا تۆمار نەکراوە. یەکەم خەرجی لە فۆڕمەکەی سەرەوە تۆمار بکە — تا ئەوکاتە، «قازانجی ساف» یەکسان دەبێت بە «قازانجی گشتی»، و ئەمە مانای ئەوە نییە هیچت خەرج نەکردووە.'
    ),
    newCategory: loc('فئة جديدة', 'New category', 'پۆلی نوێ'),
    categoryNamePlaceholder: loc('اسم الفئة بالعربية', 'Category name in Arabic', 'ناوی پۆل بە عەرەبی'),
    categoryAdded: loc('أُضيفت الفئة.', 'The category was added.', 'پۆلەکە زیادکرا.'),
    noCategoryDelete: loc(
      'لا يوجد حذف للفئة — فقط تعطيل، حتى لا يفقد مصروف قديم اسمه.',
      'A category is never deleted — only deactivated, so no past expense loses its label.',
      'پۆل هەرگیز ناسڕێتەوە — تەنها ناچالاک دەکرێت، تا خەرجییەکی کۆن ناوەکەی لەدەست نەدات.'
    ),
    deactivate: loc('عطّل', 'Deactivate', 'ناچالاک بکە'),
    activate: loc('فعّل', 'Activate', 'چالاک بکە'),
    inactive: loc('معطّلة', 'Inactive', 'ناچالاک'),

    // The refusals, said before the request leaves. See ./expenseForm.ts.
    errNoCategory: loc('اختر فئة أولًا.', 'Choose a category first.', 'سەرەتا پۆلێک هەڵبژێرە.'),
    errAmountNotNumber: loc('اكتب مبلغًا بالأرقام.', 'Enter an amount in digits.', 'بڕێک بە ژمارە بنووسە.'),
    errAmountNotWhole: loc(
      'المبلغ بالدينار العراقي عدد صحيح — لا كسور.',
      'An amount in Iraqi dinars is a whole number — no fractions.',
      'بڕ بە دیناری عێراقی ژمارەیەکی تەواوە — بەبێ بەش.'
    ),
    errAmountNotPositive: loc(
      'المصروف أكبر من صفر. المبلغ السالب مرتجع، وهو واقعة أخرى لا تُسجَّل هنا.',
      'An expense is greater than zero. A negative amount is a refund — a different fact, not recorded here.',
      'خەرجی لە سفر گەورەترە. بڕی نەرێنی گەڕاندنەوەیە — ڕووداوێکی جیاوازە، لێرە تۆمار ناکرێت.'
    ),
    errAmountTooLarge: loc('هذا المبلغ كبير إلى حدّ أنه خطأ طباعة.', 'That amount is large enough to be a typo.', 'ئەم بڕە ئەوەندە گەورەیە کە هەڵەی نووسینە.'),
    errDayNotADay: loc('اكتب يومًا حقيقيًا بصيغة YYYY-MM-DD.', 'Enter a real day as YYYY-MM-DD.', 'ڕۆژێکی ڕاستەقینە بە شێوەی YYYY-MM-DD بنووسە.'),
    errDayTooFar: loc(
      'لا يمكن تسجيل مصروف بعد أكثر من سنة من اليوم.',
      'An expense cannot be dated more than a year ahead.',
      'خەرجی ناتوانرێت زیاتر لە ساڵێک لە ئێستا دواتر بەروار بدرێت.'
    ),
    errRepeat: loc('التكرار بين شهر و٢٤ شهرًا.', 'A repeat is between 1 and 24 months.', 'دووبارەکردنەوە لە نێوان ١ و ٢٤ مانگدایە.'),
    saveFailed: loc('تعذّر الحفظ.', 'Could not save.', 'نەتوانرا پاشەکەوت بکرێت.'),
  };
}

export type FinanceStrings = ReturnType<typeof financeStrings>;
