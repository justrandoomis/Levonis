/**
 * «المال والأرباح» — EVERY WORD OF THE NEW FRAME AND OVERVIEW (redesign steps 2–3, owner 2026-11-11),
 * in Arabic, English and Sorani, in one table: a key added in one language and not the others does not
 * compile, and tests/financeOverviewScreen.test.ts holds that no Sorani slot is the Arabic pasted across
 * (DECISIONS row 183). Placeholders are {name}. Numbers stay Latin in all three, as on every money screen.
 * A count stands after a colon or in brackets, so no noun has to agree with it in any of the three.
 */
type Tri = readonly [ar: string, en: string, ckb: string];
export const FW = {
  title: ['المال والأرباح', 'Money & profit', 'پارە و قازانج'],
  crumb: ['الإدارة المالية', 'Finance', 'بەڕێوەبردنی دارایی'],
  sections: ['أقسام المالية', 'Finance sections', 'بەشەکانی دارایی'],
  overview: ['نظرة عامة', 'Overview', 'تێڕوانینی گشتی'],
  reports: ['التقارير', 'Reports', 'ڕاپۆرتەکان'],
  costs: ['التكاليف', 'Costs', 'تێچووەکان'],
  people: ['الأشخاص والدفعات', 'People & payouts', 'کەسەکان و پارەدانەکان'],
  accounting: ['المحاسبة', 'Accounting', 'ژمێریاری'],
  books: ['الدفاتر', 'Books', 'دەفتەرەکان'],
  courier: ['أموال لدى شركة التوصيل', 'Money with the courier', 'پارە لای کۆمپانیای گەیاندن'],
  orders: ['الطلبات', 'Orders', 'داواکارییەکان'],
  products: ['المنتجات', 'Products', 'بەرهەمەکان'],
  // Redesign step 4 (DECISIONS row 316): two more report pages.
  sectionsPage: ['الأقسام', 'Sections', 'بەشەکان'],
  daysPage: ['الأيام', 'Days', 'ڕۆژەکان'],
  missing: ['التكاليف الناقصة', 'Missing costs', 'تێچووە کەمەکان'],
  promotion: ['ترويج الشهر', 'Monthly promotion', 'بانگەشەی مانگ'],
  expenses: ['المصاريف العامة', 'General expenses', 'خەرجییە گشتییەکان'],
  staff: ['الموظفون', 'Staff', 'کارمەندان'],
  investors: ['المستثمرون', 'Investors', 'وەبەرهێنەران'],
  // The refusals of the wage settlement name this page by these words (personFinanceStrings settle.refusalAction).
  withdrawals: ['السحب والتسويات', 'Withdrawals', 'ڕاکێشان و یەکلاکردنەوەکان'],
  // The period bar.
  period: ['الفترة', 'Period', 'ماوە'],
  presetMonth: ['هذا الشهر حتى اليوم', 'Month to date', 'ئەم مانگە تا ئەمڕۆ'],
  preset7: ['آخر 7 أيام', 'Last 7 days', 'دوایین 7 ڕۆژ'],
  preset30: ['آخر 30 يومًا', 'Last 30 days', 'دوایین 30 ڕۆژ'],
  presetPrevious: ['الشهر السابق', 'Previous month', 'مانگی پێشوو'],
  presetYear: ['هذه السنة حتى اليوم', 'Year to date', 'ئەمساڵ تا ئەمڕۆ'],
  presetCustom: ['فترة مخصصة…', 'Custom range…', 'ماوەی تایبەت…'],
  from: ['من', 'From', 'لە'],
  to: ['إلى', 'To', 'بۆ'],
  apply: ['عرض الفترة', 'Apply range', 'ماوەکە پیشان بدە'],
  rangeError: ['أدخل تاريخين صحيحين؛ البداية قبل النهاية والفترة لا تتجاوز سنة. يُعرض آخر نطاق صالح.', 'Enter valid dates in order, within one year. The last valid range remains displayed.', 'دوو بەرواری دروست بنووسە؛ دەستپێک پێش کۆتایی و ماوەکە لە ساڵێک زیاتر نەبێت. دوایین ماوەی دروست پیشان دەدرێت.'],
  compare: ['المقارنة', 'Compare', 'بەراورد'],
  compareMonth: ['نفس الأيام من الشهر السابق', 'Same days last month', 'هەمان ڕۆژەکانی مانگی پێشوو'],
  comparePrevious: ['الفترة السابقة بنفس الطول', 'Previous period, same length', 'ماوەی پێشوو بە هەمان درێژی'],
  compareNone: ['بلا مقارنة', 'No comparison', 'بێ بەراورد'],
  refresh: ['تحديث الأرقام', 'Refresh figures', 'نوێکردنەوەی ژمارەکان'],
  updated: ['حُدّث {time}', 'Updated {time}', 'نوێکرایەوە {time}'],
  exportCsv: ['تصدير CSV', 'Export CSV', 'هەناردەکردنی CSV'],
  loading: ['تحميل أرقام الفترة…', 'Loading this period…', 'ژمارەکانی ماوەکە بار دەکرێن…'],
  retry: ['إعادة المحاولة', 'Retry', 'دووبارە هەوڵبدەرەوە'],
  truncated: ['عدد الطلبات يتجاوز حد التقرير؛ راجع الفترة قبل اعتماد الإجمالي.', 'Order count exceeds the report limit. Review the period before accepting totals.', 'ژمارەی داواکارییەکان لە سنووری ڕاپۆرت زیاترە؛ پێش پشتبەستن بە کۆی گشتی، ماوەکە بپشکنە.'],
  // The completeness banner.
  completeAll: ['كل طلبات الفترة محسوبة بتكاليف مؤكدة', 'Every order of the period is calculated on confirmed costs', 'هەموو داواکارییەکانی ماوەکە بە تێچووی دڵنیاکراو ژمێردراون'],
  completeTitle: ['الطلبات المحسوبة: {n} من {m}', 'Calculated orders: {n} of {m}', 'داواکارییە ژمێردراوەکان: {n} لە {m}'],
  estimatedTitle: ['كل الطلبات محسوبة؛ على تكلفة تقديرية: {n}', 'Every order is calculated; on estimated costs: {n}', 'هەموو داواکارییەکان ژمێردراون؛ لەسەر تێچووی خەمڵێنراو: {n}'],
  confirmedN: ['مؤكد {n}', 'Confirmed {n}', 'دڵنیاکراو {n}'],
  // A no-break space holds a count to its word: a chip that wraps (a narrow totals cell) never leaves the number alone on a line
  // (the third review of step 4).
  estimatedN: ['تقديري\u00A0{n}', 'Estimated\u00A0{n}', 'خەمڵێنراو\u00A0{n}'],
  waitingN: ['ينتظر\u00A0{n}', 'Waiting\u00A0{n}', 'چاوەڕوان\u00A0{n}'],
  waitsFor: ['ما تنتظره الطلبات الباقية: {list}.', 'What the other orders wait for: {list}.', 'ئەوەی داواکارییەکانی تر چاوەڕێی دەکەن: {list}.'],
  reasonNoPrice: ['سعر شراء ({n})', 'a purchase price ({n})', 'نرخی کڕین ({n})'],
  // The independent review of step 4: a piece returned to stock with no known cost — fixed in its order, not on «التكاليف الناقصة».
  reasonReturnCost: ['تكلفة قطعة مرتجعة إلى المخزون ({n})', 'the cost of a piece returned to stock ({n})', 'تێچووی پارچەیەکی گەڕاوە بۆ کۆگا ({n})'],
  reasonWage: ['أجر ينتظر تثبيت التكلفة ({n})', 'a wage waiting for a confirmed cost ({n})', 'کرێیەک چاوەڕێی جێگیرکردنی تێچووە ({n})'],
  reasonInvestor: ['حصة مستثمر تنتظر تسجيل النقد أو تثبيت التكلفة ({n})', 'an investor share waiting for its cash or a confirmed cost ({n})', 'بەشی وەبەرهێنەرێک چاوەڕێی تۆمارکردنی پارە یان جێگیرکردنی تێچووە ({n})'],
  reasonRefund: ['مبلغ مرتجع غير مثبت ({n})', 'an unconfirmed refund amount ({n})', 'بڕی گەڕاندنەوەی جێگیرنەکراو ({n})'],
  reasonOther: ['بند يحتاج مراجعة ({n})', 'a line to review ({n})', 'بڕگەیەک بۆ پێداچوونەوە ({n})'],
  estimatedNote: ['طلبات محسوبة على تقدير وقت البيع حتى تُثبَّت أسعار شرائها: {n}.', 'Orders calculated on the sale-time estimate until their purchase prices are confirmed: {n}.', 'داواکاریی ژمێردراو لەسەر خەمڵاندنی کاتی فرۆشتن تا نرخی کڕینیان جێگیر دەکرێت: {n}.'],
  completeCosts: ['أكمل التكاليف الناقصة ({n})', 'Complete the missing costs ({n})', 'تێچووە کەمەکان تەواو بکە ({n})'],
  // The cards.
  netSales: ['صافي المبيعات', 'Net sales', 'فرۆشی پوخت'],
  netSalesNote: ['بعد المرتجعات · الطلبات: {n}', 'After returns · orders: {n}', 'دوای گەڕاندنەوەکان · داواکاری: {n}'],
  grossProfit: ['ربح البضاعة', 'Gross profit', 'قازانجی کاڵا'],
  grossNoteAll: ['هامش {pct} من صافي المبيعات', 'Margin {pct} of net sales', 'پەراوێز {pct} لە فرۆشی پوخت'],
  grossMargin: ['هامش {pct}', 'Margin {pct}', 'پەراوێز {pct}'],
  // Owner decision 3 (2026-11-11): an estimate stays in the figure and is always named.
  estimatedOrders: ['طلبات بتكلفة تقديرية: {n}', 'Orders on estimated costs: {n}', 'داواکاری بە تێچووی خەمڵێنراو: {n}'],
  netShare: ['صافي حصتك', 'Your net share', 'سافی بەشی تۆ'],
  netNote: ['بعد كل التكاليف وحصص المستثمرين والخصومات', 'After every cost, investor share and deduction', 'دوای هەموو تێچوو و بەشی وەبەرهێنەران و داشکاندنەکان'],
  shareMargin: ['هامش حصتك {pct}', 'Your share margin {pct}', 'پەراوێزی بەشەکەت {pct}'],
  knownNote: ['من الطلبات المكتملة فقط ({n}/{m})', 'From complete orders only ({n}/{m})', 'تەنها لە داواکارییە تەواوەکانەوە ({n}/{m})'],
  overheadNote: ['، مع حصتها من المصاريف العامة بنسبة إيرادها', ', with their revenue-based share of general expenses', '، لەگەڵ بەشیان لە خەرجییە گشتییەکان بەپێی داهاتەکەیان'],
  confirmedPart: ['مؤكد', 'Confirmed', 'دڵنیاکراو'],
  estimatedPart: ['من طلبات فيها تكلفة تقديرية', 'from orders with estimated costs', 'لە داواکاری بە تێچووی خەمڵێنراو'],
  deducted: ['بعد الكوبونات وحماية السعر ورصيد الاستبدال المُعاد', 'After coupons, price protection and returned trade-in credit', 'دوای کۆپۆن و پاراستنی نرخ و باڵانسی گۆڕینەوەی گەڕاوە'],
  deliveredOrders: ['الطلبات المستلمة', 'Delivered orders', 'داواکارییە گەیەندراوەکان'],
  units: ['القطع المباعة: {n}', 'Pieces sold: {n}', 'پارچەی فرۆشراو: {n}'],
  averageOrder: ['متوسط الطلب {amount}', 'Average order {amount}', 'تێکڕای داواکاری {amount}'],
  vs: ['عن {range}', 'vs {range}', 'بەراورد بە {range}'],
  // The header: the period, then what it is compared with — or that the comparison could not be read.
  vsHeader: ['مقارنةً بـ {range}', 'compared with {range}', 'بەراورد بە {range}'],
  vsFailed: ['لا مقارنة: تعذّرت قراءة {range}', 'No comparison: {range} could not be read', 'بێ بەراورد: {range} نەخوێندرایەوە'],
  // A change across zero is no percentage: a loss that turned into a profit, or the reverse.
  lossToProfit: ['من خسارة إلى ربح', 'From a loss to a profit', 'لە زیانەوە بۆ قازانج'],
  profitToLoss: ['من ربح إلى خسارة', 'From a profit to a loss', 'لە قازانجەوە بۆ زیان'],
  partial: ['مقارنة جزئية', 'Partial comparison', 'بەراوردی بەشەکی'],
  partialWhy: ['إحدى الفترتين غير مكتملة، فلا تُعرض نسبة تغيّر', 'One of the two periods is incomplete, so no change is shown', 'یەکێک لە دوو ماوەکە تەواو نییە، بۆیە ڕێژەی گۆڕان پیشان نادرێت'],
  noCompare: ['لا شيء للمقارنة', 'Nothing to compare', 'هیچ بۆ بەراورد نییە'],
  // The chart.
  chartTitle: ['الإيراد منذ بداية الفترة', 'Revenue since the start of the period', 'داهات لە سەرەتای ماوەکەوە'],
  chartNote: ['تراكمي، حسب يوم التسليم بتوقيت بغداد · يشمل التوصيل ورسوم الدفع عند الاستلام', 'Cumulative, by delivery day in Baghdad time · includes delivery and the cash-on-delivery fee', 'کەڵەکەبوو، بەپێی ڕۆژی گەیاندن بە کاتی بەغدا · گەیاندن و کرێی پارەدان لە کاتی وەرگرتن لەخۆ دەگرێت'],
  thisPeriod: ['هذه الفترة', 'This period', 'ئەم ماوەیە'],
  noRevenue: ['لا إيراد في الفترة', 'No revenue in the period', 'هیچ داهاتێک لەم ماوەیەدا نییە'],
  // Needs your attention.
  attention: ['يحتاج انتباهك', 'Needs your attention', 'پێویستی بە سەرنجتە'],
  attentionNone: ['لا شيء ينتظرك في هذه الفترة', 'Nothing is waiting for you in this period', 'هیچ شتێک لەم ماوەیەدا چاوەڕێت ناکات'],
  aCostsNote: ['طلبات: {orders} · لا يُحفظ سعر قبل أن تؤكده', 'Orders: {orders} · no price is saved before you confirm it', 'داواکاری: {orders} · هیچ نرخێک پێش دڵنیاکردنەوەت پاشەکەوت ناکرێت'],
  aCash: ['سجّل النقد المستلم', 'Record cash received', 'پارەی وەرگیراو تۆمار بکە'],
  aCashNote: ['{amount} مستحق لم يُسجَّل استلامه · طلبات: {n}', '{amount} due, not recorded as received yet · orders: {n}', '{amount} ماوە و هێشتا وەک وەرگیراو تۆمار نەکراوە · داواکاری: {n}'],
  aPayouts: ['مستحقات جاهزة للدفع', 'Payouts ready to pay', 'پارەدانی ئامادە'],
  aPayoutsNote: ['{amount} لـ: {names}', '{amount} to: {names}', '{amount} بۆ: {names}'],
  aInvestor: ['حصة مستثمر تنتظر', 'An investor share is waiting', 'بەشی وەبەرهێنەرێک چاوەڕێ دەکات'],
  aInvestorNote: ['تُبقي صافي الفترة ناقصًا حتى يُسجَّل النقد أو تُثبَّت التكلفة · طلبات: {n}', 'Keeps the period net incomplete until the cash is recorded or the cost confirmed · orders: {n}', 'سافی ماوەکە ناتەواو دەهێڵێتەوە تا پارەکە تۆمار دەکرێت یان تێچووەکە جێگیر دەکرێت · داواکاری: {n}'],
  aExpenses: ['لا مصاريف عامة مسجّلة في الفترة', 'No general expenses recorded in the period', 'هیچ خەرجییەکی گشتی لەم ماوەیەدا تۆمار نەکراوە'],
  aExpensesNote: ['إيجار، كهرباء، اشتراكات… تُخصم من صافي الفترة', 'Rent, power, subscriptions… come off the period’s net', 'کرێی شوێن، کارەبا، بەشداری… لە سافی ماوەکە کەم دەکرێنەوە'],
  open: ['افتح', 'Open', 'بیکەرەوە'],
  record: ['سجّل', 'Record', 'تۆمار بکە'],
  review: ['راجِع', 'Review', 'پێداچوونەوە بکە'],
  add: ['أضف', 'Add', 'زیاد بکە'],
  complete: ['أكمل', 'Complete', 'تەواو بکە'],
  // The statement.
  statement: ['من المبيعات إلى حصتك', 'From sales to your share', 'لە فرۆشتنەوە بۆ بەشی تۆ'],
  statementNote: ['كل سطر حدٌّ من حساب الخادم نفسه وبترتيبه. «محسوبة» الطلبات التي عُرفت كل مبالغها، بأسعار شراء مؤكدة أو بتقدير وقت البيع، و«تنتظر» الباقية، و«الفترة» مجموعهما.', 'Every line is a term of the server’s own arithmetic, in its order. “Calculated” are the orders whose every amount is known, on confirmed purchase prices or the sale-time estimate; “Waiting” the rest; “Period” both together.', 'هەر هێڵێک بەشێکە لە ژمێریاریی ڕاژەکار خۆی، بە ڕیزبەندییەکەی. «ژمێردراو» ئەو داواکارییانەن کە هەموو بڕەکانیان زانراوە، بە نرخی کڕینی دڵنیاکراو یان بە خەمڵاندنی کاتی فرۆشتن؛ «چاوەڕوان» ئەوانی تر؛ و «کۆی ماوە» هەردووکیان پێکەوە.'],
  colCalculated: ['محسوبة ({n})', 'Calculated ({n})', 'ژمێردراو ({n})'],
  colCalculatedEst: ['محسوبة ({n} · تقديرية: {e})', 'Calculated ({n} · estimated: {e})', 'ژمێردراو ({n} · خەمڵێنراو: {e})'],
  colWaiting: ['تنتظر ({n})', 'Waiting ({n})', 'چاوەڕوان ({n})'],
  // The fourth review of step 4: a waiting column whose known goods cost rests on sale-time estimates names them, as «محسوبة» does.
  colWaitingEst: ['تنتظر ({n} · تقديرية: {e})', 'Waiting ({n} · estimated: {e})', 'چاوەڕوان ({n} · خەمڵێنراو: {e})'],
  colPeriod: ['الفترة ({n})', 'Period ({n})', 'کۆی ماوە ({n})'],
  colPeriodEst: ['الفترة ({n} · تقديرية: {e})', 'Period ({n} · estimated: {e})', 'کۆی ماوە ({n} · خەمڵێنراو: {e})'],
  cogs: ['تكلفة البضاعة', 'Cost of goods', 'تێچووی کاڵا'],
  delivery: ['التوصيل على الزبائن', 'Delivery charged', 'گەیاندن لەسەر کڕیار'],
  cod: ['رسوم الدفع عند الاستلام', 'Cash-on-delivery fee', 'کرێی پارەدان لە کاتی وەرگرتن'],
  wages: ['الأجور', 'Wages', 'کرێکان'],
  wagesWaiting: ['أجور تنتظر تكلفتها: {n}', 'Wages waiting for their cost: {n}', 'کرێی چاوەڕوانی تێچووەکەیان: {n}'],
  materials: ['المواد والتكاليف الإضافية', 'Materials and extra costs', 'کەرەستە و تێچووی زیادە'],
  fees: ['أجور التوصيل والدفع', 'Courier and payment fees', 'کرێی گەیاندن و پارەدان'],
  feesNote: ['لا يُعرف أجر شركة التوصيل قبل تسجيل التحصيل', 'A courier’s fee is known only once its collection is recorded', 'کرێی کۆمپانیای گەیاندن تەنها دوای تۆمارکردنی وەرگرتن دەزانرێت'],
  promo: ['الترويج (حسب قيمة المبيعات)', 'Promotion (by sales value)', 'بانگەشە (بەپێی بەهای فرۆشتن)'],
  investor: ['حصة المستثمرين', 'Investor share', 'بەشی وەبەرهێنەران'],
  investorLoss: ['سالبة: مساهمة المستثمرين في الخسارة', 'Negative: the investors’ part of a loss', 'نەرێنی: بەشی وەبەرهێنەران لە زیانەکە'],
  generalWaiting: ['لا تشمل تكاليف تنتظر تسليم طلباتها: {amount}', 'Excludes costs waiting for their orders to be delivered: {amount}', 'تێچووی چاوەڕوانی گەیاندنی داواکارییەکانیان ناگرێتەوە: {amount}'],
  // In dollars: the server has no cents for it, so the note names it without a dinar amount.
  generalWaitingShort: ['لا تشمل تكاليف تنتظر تسليم طلباتها', 'Excludes costs waiting for their orders to be delivered', 'تێچووی چاوەڕوانی گەیاندنی داواکارییەکانیان ناگرێتەوە'],
  deductions: ['الكوبونات وحماية السعر ورصيد الاستبدال المُعاد', 'Coupons, price protection and returned trade-in credit', 'کۆپۆن و پاراستنی نرخ و باڵانسی گۆڕینەوەی گەڕاوە'],
  missingCell: ['ناقص', 'Missing', 'ناتەواو'],
  waitingCell: ['ينتظر', 'Waiting', 'چاوەڕێ دەکات'],
  // Products, cash, payouts.
  topProducts: ['المنتجات حسب ربح البضاعة', 'Products by gross profit', 'بەرهەمەکان بەپێی قازانجی کاڵا'],
  fullReport: ['التقرير كاملًا', 'Full report', 'ڕاپۆرتی تەواو'],
  product: ['المنتج', 'Product', 'بەرهەم'],
  pieces: ['القطع', 'Pieces', 'پارچە'],
  marginCol: ['الهامش', 'Margin', 'پەراوێز'],
  noSales: ['بلا مبيعات', 'No sales', 'بێ فرۆشتن'],
  estimatedChip: ['تقديري', 'Estimated', 'خەمڵێنراو'],
  estimatedChipNote: ['«تقديري»: تكلفة بضاعته كلها أو بعضها تقدير وقت البيع حتى تُثبَّت أسعار شرائها.', '“Estimated”: some or all of its goods cost is the sale-time estimate until the purchase prices are confirmed.', '«خەمڵێنراو»: هەموو یان بەشێک لە تێچووی کاڵاکەی خەمڵاندنی کاتی فرۆشتنە تا نرخی کڕینەکانی جێگیر دەکرێن.'],
  noProducts: ['لا منتجات مستلمة في الفترة', 'No delivered products in the period', 'هیچ بەرهەمێکی گەیەندراو لەم ماوەیەدا نییە'],
  cash: ['النقد', 'Cash', 'پارە'],
  cashNote: ['الربح ليس نقدًا: ما سُجّل وصوله وما زال مستحقًا', 'Profit isn’t cash: what is recorded as received and what is still due', 'قازانج پارە نییە: ئەوەی وەک وەرگیراو تۆمارکراوە و ئەوەی هێشتا ماوە'],
  cashDue: ['مستحق عند التسليم أو من Gini', 'Due on delivery or from Gini', 'ماوە لە کاتی گەیاندن یان لە Gini'],
  cashRecorded: ['سُجّل استلامه', 'Recorded as received', 'وەک وەرگیراو تۆمارکراوە'],
  cashOpen: ['مستحق لم يُسجَّل استلامه', 'Due, not recorded as received yet', 'ماوە، هێشتا وەک وەرگیراو تۆمار نەکراوە'],
  cashOpenNote: ['ليس عجزًا: مبالغ الدفع عند التسليم أو من Gini التي لم يُسجَّل وصولها بعد', 'Not a shortfall: amounts paid on delivery or by Gini whose arrival is not recorded yet', 'کەمی نییە: بڕی پارەدان لە کاتی گەیاندن یان لە لایەن Gini کە گەیشتنی هێشتا تۆمار نەکراوە'],
  payouts: ['المستحقات', 'Payouts', 'پارەدانەکان'],
  payoutsNote: ['ما يمكن دفعه الآن وما هو محجوز، حتى اليوم لا للفترة وحدها', 'What can be paid now and what is held, as of today, not for the period alone', 'ئەوەی ئێستا دەدرێت و ئەوەی ڕاگیراوە، تا ئەمڕۆ، نەک تەنها بۆ ماوەکە'],
  payNow: ['جاهز للدفع', 'Ready to pay', 'ئامادەی پارەدان'],
  held: ['محجوز', 'Held', 'ڕاگیراو'],
  payoutsLoading: ['تحميل المستحقات…', 'Loading payouts…', 'پارەدانەکان بار دەکرێن…'],
  payoutsNone: ['لا مستحقات جاهزة للدفع الآن', 'No payouts ready to pay now', 'ئێستا هیچ پارەدانێکی ئامادە نییە'],
  payoutsError: ['تعذّر تحميل المستحقات', 'The payouts could not be loaded', 'پارەدانەکان بار نەکران'],
  details: ['التفاصيل', 'Details', 'وردەکاری'],
} as const satisfies Record<string, Tri>;
export type FwKey = keyof typeof FW;

type Loc = (ar: string, en: string, ckb?: string) => string;
/** One string in the reader's language, with {placeholders} filled. */
export function fw(loc: Loc, key: FwKey, vars: Record<string, string | number> = {}): string {
  const [ar, en, ckb] = FW[key];
  return loc(ar, en, ckb).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

/** Month names as each language writes them here: the Iraqi Arabic months, and their Sorani forms. */
const MONTHS: Record<'ar' | 'en' | 'ckb', readonly string[]> = {
  ar: ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ckb: ['کانوونی دووەم', 'شوبات', 'ئازار', 'نیسان', 'ئایار', 'حوزەیران', 'تەمموز', 'ئاب', 'ئەیلوول', 'تشرینی یەکەم', 'تشرینی دووەم', 'کانوونی یەکەم'],
};
/** One day without its year, for a table's cell: "10 تشرين الثاني", "Nov 10", "10 تشرینی دووەم"; Latin digits. */
export function dayText(lang: 'ar' | 'en' | 'ckb', day: string): string {
  const m = (MONTHS[lang] ?? MONTHS.ar)[Number(day.slice(5, 7)) - 1], d = Number(day.slice(8, 10));
  return lang === 'en' ? `${m} ${d}` : `${d} ${m}`;
}
/** A month with its year, «تشرين الثاني 2026», "Nov 2026", «تشرینی دووەم 2026» (redesign step 5: the promotion's month); Latin digits. */
export function monthText(lang: 'ar' | 'en' | 'ckb', month: string): string {
  return `${(MONTHS[lang] ?? MONTHS.ar)[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}
/**
 * A day in a table of the period `range`: without its year (dayText) — with it when the period spans two calendar years,
 * so a year-long range never shows two rows both «11 تشرين الثاني» (the independent review of step 4).
 */
export function dayIn(lang: 'ar' | 'en' | 'ckb', day: string, range?: { from: string; to: string }): string {
  return range && range.from.slice(0, 4) !== range.to.slice(0, 4) ? rangeText(lang, day, day) : dayText(lang, day);
}
/** "1–11 تشرين الثاني 2026", "Nov 1–11, 2026", across months and years as needed; Latin digits. */
export function rangeText(lang: 'ar' | 'en' | 'ckb', from: string, to: string): string {
  const [fy, fm, fd] = [Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10))];
  const [ty, tm, td] = [Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10))];
  const m = MONTHS[lang] ?? MONTHS.ar;
  if (lang === 'en') {
    if (fy === ty && fm === tm) return fd === td ? `${m[fm]} ${fd}, ${fy}` : `${m[fm]} ${fd}–${td}, ${fy}`;
    if (fy === ty) return `${m[fm]} ${fd} – ${m[tm]} ${td}, ${fy}`;
    return `${m[fm]} ${fd}, ${fy} – ${m[tm]} ${td}, ${ty}`;
  }
  if (fy === ty && fm === tm) return fd === td ? `${fd} ${m[fm]} ${fy}` : `${fd}–${td} ${m[fm]} ${fy}`;
  if (fy === ty) return `${fd} ${m[fm]} – ${td} ${m[tm]} ${fy}`;
  return `${fd} ${m[fm]} ${fy} – ${td} ${m[tm]} ${ty}`;
}
