/**
 * «المال والأرباح» — EVERY WORD OF THE REPORTS AND THE FIGURE DRAWER (redesign step 4, owner 2026-11-11;
 * DECISIONS row 316), in Arabic, English and Sorani in one table: a key added in one language and not the
 * others does not compile, and tests/financeReportTables.test.ts holds that no Sorani slot is the Arabic or
 * the English pasted across (DECISIONS row 183), that each has a Sorani letter and no Arabic-only one, and
 * that the placeholders agree. Words the overview already has stay in overviewStrings.ts (FW) and are
 * reused, never repeated. A count stands after a colon or in brackets, as there.
 */
type Tri = readonly [ar: string, en: string, ckb: string];
export const RS = {
  // The toolbars.
  search: ['ابحث برقم الطلب أو اسم الزبون', 'Search order number or customer', 'بە ژمارەی داواکاری یان ناوی کڕیار بگەڕێ'],
  searchProducts: ['ابحث عن منتج', 'Search a product', 'بەدوای بەرهەمێکدا بگەڕێ'],
  searchSections: ['ابحث عن قسم', 'Search a section', 'بەدوای بەشێکدا بگەڕێ'],
  status: ['الحالة', 'Status', 'دۆخ'],
  stateAll: ['الكل ({n})', 'All ({n})', 'هەموو ({n})'],
  stateWaitingFor: ['ينتظر: {reason}', 'Waiting: {reason}', 'چاوەڕوان: {reason}'],
  kind: ['النوع', 'Type', 'جۆر'],
  kindAll: ['كل الأنواع', 'All types', 'هەموو جۆرەکان'],
  kindNormal: ['طلب عادي', 'Regular order', 'داواکاری ئاسایی'],
  kindQuick: ['شراء سريع', 'Quick Buy', 'کڕینی خێرا'],
  kindGift: ['هدية', 'Gift', 'دیاری'],
  amountsIqd: ['المبالغ بالدينار', 'Amounts in IQD', 'بڕەکان بە دینار'],
  amountsUsd: ['المبالغ بالدولار', 'Amounts in USD', 'بڕەکان بە دۆلار'],
  // The independent review of step 4: the export is the page as shown; its file is in dinars whatever the toggle says.
  exportIqd: ['تصدير CSV بالدينار', 'Export CSV in IQD', 'هەناردەکردنی CSV بە دینار'],
  kindFilter: ['النوع: {name}', 'Type: {name}', 'جۆر: {name}'],
  // The columns.
  colOrder: ['الطلب', 'Order', 'داواکاری'],
  colDelivered: ['التسليم', 'Delivered', 'گەیاندن'],
  colSales: ['المبيعات', 'Sales', 'فرۆشتن'],
  colPromotion: ['الترويج', 'Promotion', 'بانگەشە'],
  colInvestor: ['المستثمر', 'Investor', 'وەبەرهێنەر'],
  colNet: ['صافيك', 'Your net', 'سافی تۆ'],
  colSection: ['القسم', 'Section', 'بەش'],
  colDay: ['اليوم', 'Day', 'ڕۆژ'],
  colWeek: ['الأسبوع', 'Week', 'هەفتە'],
  colMonth: ['الشهر', 'Month', 'مانگ'],
  colRevenue: ['الإيراد', 'Revenue', 'بڕی داهات'],
  colDeductions: ['الخصومات', 'Deductions', 'داشکاندنەکان'],
  netBefore: ['قبل المصاريف العامة', 'before general expenses', 'پێش خەرجییە گشتییەکان'],
  // The totals row and what stands under a table.
  total: ['المجموع', 'Total', 'کۆ'],
  netTotal: ['صافيك من الطلبات المحسوبة ({n})', 'Your net from calculated orders ({n})', 'سافی تۆ لە داواکارییە ژمێردراوەکان ({n})'],
  // A no-break space holds each count to its word, as FW.waitingN (the third review of step 4): a wrapped chip never leaves it alone.
  missingN: ['ناقص\u00A0{n}', 'Missing\u00A0{n}', 'ناتەواو\u00A0{n}'],
  // The independent review of step 4: sales that count a refund nobody recorded as 0, said beside the figure.
  refundN: ['مرتجع غير مثبت\u00A0{n}', 'Unconfirmed refund\u00A0{n}', 'گەڕاندنەوەی جێگیرنەکراو\u00A0{n}'],
  ordersNote: ['«صافيك» هنا قبل المصاريف العامة وترويج شهر بلا مبيعات: يُخصمان في «من المبيعات إلى حصتك»، لا من كل طلب.', '“Your net” here is before general expenses and the promotion of a month without sales: they come off in “From sales to your share”, not per order.', '«سافی تۆ» لێرەدا پێش خەرجییە گشتییەکان و بانگەشەی مانگێکی بێ فرۆشتنە: لە «لە فرۆشتنەوە بۆ بەشی تۆ» کەم دەکرێنەوە، نەک لە هەر داواکارییەک.'],
  // The second review of step 4: every term of a product's «صافيك», in the statement's own words — the COD fee's share added, the
  // extra costs taken off (tests/financeReportTables.test.ts holds each one in each language).
  productsNote: ['«القطع» ما احتفظ به الزبائن، والمرتجع تحتها. «صافيك» ربح بضاعة المنتج ونصيبه من التوصيل على الزبائن ومن رسوم الدفع عند الاستلام، بعد أجوره وموادّه وتكاليفه الإضافية، وأجور التوصيل والدفع، والترويج حسب قيمة المبيعات، وحصة المستثمرين، ونصيبه من الكوبونات والأرصدة — قبل المصاريف العامة وترويج شهر بلا مبيعات. وما زاد من كوبون أو رصيد على بضاعة طلبه ففي سطر «خصومات على مستوى الطلب».', '“Pieces” are what the customers kept, with returns under them. “Your net” is the product’s gross profit with its share of the delivery charged and the cash-on-delivery fee, after its wages, materials and extra costs, courier and payment fees, the promotion by sales value, the investors’ share and its share of coupons and credits — before general expenses and a month’s promotion without sales. A coupon or credit beyond an order’s goods is on the “Order-level deductions” row.', '«پارچە» ئەوەیە کە کڕیاران هێشتوویانەتەوە، گەڕاوەکان لە ژێریدان. «سافی تۆ» قازانجی کاڵای بەرهەمەکەیە لەگەڵ بەشی لە گەیاندن لەسەر کڕیار و کرێی پارەدان لە کاتی وەرگرتن، دوای کرێ و کەرەستە و تێچووی زیادەی، کرێی گەیاندن و پارەدان، بانگەشە بەپێی بەهای فرۆشتن، بەشی وەبەرهێنەران و بەشی لە کۆپۆن و باڵانسەکان — پێش خەرجییە گشتییەکان و بانگەشەی مانگێکی بێ فرۆشتن. ئەوەی کۆپۆن یان باڵانس لە کاڵای داواکارییەکەی زیاترە لە ڕیزی «داشکاندنەکانی ئاستی داواکاری»دایە.'],
  // «تقديري» counts every order whose known goods cost is the sale-time estimate — a waiting one's too (the second review).
  daysNote: ['«التكاليف» كل تكلفة كما في الرسم: البضاعة والأجور والمواد والتوصيل والدفع والترويج، والمصاريف العامة وترويج شهر بلا مبيعات في يومهما. «صافيك» بعد حصة المستثمرين والخصومات. «تقديري»: طلبات تكلفة بضاعتها على تقدير وقت البيع لسعر الشراء؛ «ينتظر»: طلبات لم يُعرف بعد ما في العمود منها.', '“Costs” is every cost, as on the chart: goods, wages, materials, delivery and payment fees, promotion, and general expenses and a month’s promotion without sales on their own day. “Your net” is after the investors’ share and the deductions. “Estimated”: orders whose goods cost is the sale-time estimate of their purchase price; “Waiting”: orders whose part of the column is not known yet.', '«تێچووەکان» هەموو تێچوویەکە وەک لە هێڵکارییەکەدا: کاڵا، کرێ، کەرەستە، گەیاندن و پارەدان، بانگەشە، و خەرجییە گشتییەکان و بانگەشەی مانگێکی بێ فرۆشتن لە ڕۆژی خۆیاندا. «سافی تۆ» دوای بەشی وەبەرهێنەران و داشکاندنەکانە. «خەمڵێنراو»: داواکاری کە تێچووی کاڵاکەیان لەسەر خەمڵاندنی کاتی فرۆشتنی نرخی کڕینە؛ «چاوەڕوان»: داواکاری کە بەشیان لەم ستوونەدا هێشتا نەزانراوە.'],
  // The products' and the sections' row of what no product carries (the review of step 4).
  orderLevel: ['خصومات على مستوى الطلب', 'Order-level deductions', 'داشکاندنەکانی ئاستی داواکاری'],
  showAll: ['عرض الكل ({n})', 'Show all ({n})', 'هەمووی پیشان بدە ({n})'],
  noMatch: ['لا شيء يطابق البحث أو الفلتر', 'Nothing matches the search or the filter', 'هیچ شتێک لەگەڵ گەڕان یان پاڵاوتنەکە ناگونجێت'],
  noneInPeriod: ['لا شيء في هذه الفترة', 'Nothing in this period', 'هیچ شتێک لەم ماوەیەدا نییە'],
  // A table opened on part of the orders.
  filterProduct: ['المنتج: {name}', 'Product: {name}', 'بەرهەم: {name}'],
  filterSection: ['القسم: {name}', 'Section: {name}', 'بەش: {name}'],
  filterDay: ['اليوم: {name}', 'Day: {name}', 'ڕۆژ: {name}'],
  clearFilter: ['إزالة الفلتر', 'Clear the filter', 'لابردنی پاڵاوتن'],
  openGroupOrders: ['اعرض طلبات «{name}»', 'Show the orders of “{name}”', 'داواکارییەکانی «{name}» پیشان بدە'],
  openOrder: ['افتح الطلب {id}', 'Open order {id}', 'داواکاری {id} بکەرەوە'],
  // Where an order, a product or a section stands; the cash of an order.
  stConfirmed: ['مؤكد', 'Confirmed', 'دڵنیاکراو'],
  stEstimated: ['تكلفة تقديرية', 'Estimated cost', 'تێچووی خەمڵێنراو'],
  stNoPrice: ['بلا سعر شراء', 'No purchase price', 'بێ نرخی کڕین'],
  stWage: ['أجر ينتظر التكلفة', 'Wage waits for cost', 'کرێ چاوەڕێی تێچووە'],
  stInvestor: ['حصة مستثمر تنتظر', 'Investor share waiting', 'بەشی وەبەرهێنەر چاوەڕوانە'],
  stRefund: ['مبلغ مرتجع غير مثبت', 'Refund amount unconfirmed', 'بڕی گەڕاندنەوە جێگیر نەکراوە'],
  stReturnCost: ['تكلفة قطعة مرتجعة غير معروفة', 'Returned piece cost unknown', 'تێچووی پارچەی گەڕاوە نەزانراوە'],
  stOther: ['بند يحتاج مراجعة', 'A line to review', 'بڕگەیەک بۆ پێداچوونەوە'],
  toCosts: ['افتح التكاليف الناقصة', 'Open the missing costs', 'تێچووە کەمەکان بکەرەوە'],
  toOrderStep: ['افتح الطلب عند ما ينتظره', 'Open the order at what it waits for', 'داواکارییەکە لەسەر ئەوەی چاوەڕێی دەکات بکەرەوە'],
  cashPrepaid: ['مدفوع مسبقًا', 'Prepaid', 'پێشوەخت دراوە'],
  cashRecorded: ['سُجّل', 'Recorded', 'تۆمارکراوە'],
  cashPart: ['سُجّل جزء', 'Part recorded', 'بەشێکی تۆمارکراوە'],
  cashNot: ['لم يُسجَّل', 'Not recorded', 'تۆمار نەکراوە'],
  toCollections: ['سجّل النقد المستلم لهذا الطلب', 'Record the cash received for this order', 'پارەی وەرگیراو بۆ ئەم داواکارییە تۆمار بکە'],
  returnedN: ['مرتجع {n}', 'Returned {n}', 'گەڕاوە {n}'],
  // Sections.
  levelMain: ['الأقسام الرئيسية', 'Main sections', 'بەشە سەرەکییەکان'],
  levelSub: ['الأقسام الفرعية', 'Subsections', 'بەشە لاوەکییەکان'],
  unclassified: ['غير مصنف', 'Unclassified', 'پۆلێننەکراو'],
  noSub: ['بلا قسم فرعي', 'No subsection', 'بێ بەشی لاوەکی'],
  // Days.
  groupBy: ['التجميع', 'Group by', 'کۆکردنەوە'],
  byDay: ['يوم', 'Day', 'ڕۆژ'],
  byWeek: ['أسبوع يبدأ السبت', 'Week from Saturday', 'هەفتە لە شەممەوە'],
  byMonth: ['شهر', 'Month', 'مانگ'],
  // «حسب نوع الطلب» (moved here from the frame with the orders page).
  kindsTitle: ['حسب نوع الطلب', 'By order type', 'بەپێی جۆری داواکاری'],
  kindsNote: ['الطلبات المستلمة في الفترة نفسها، مقسومة حسب طريقة إنشائها.', 'The same delivered orders, split by how each was placed.', 'هەمان داواکارییە گەیەندراوەکان، بەپێی شێوازی دروستکردنیان.'],
  kindsGift: ['الهدية تُطلب بـ0 د.ع وتبقى كلفة بضاعتها، فربحها السالب هو كلفة الهدايا. مبلغ الشراء السريع المحجوز في المحفظة ليس إيراداً؛ يدخل الطلب هنا بعد تسليمه فقط.', 'A gift is ordered at 0 IQD and keeps its goods cost, so its negative profit is what the gifts cost. A Quick Buy amount held in the wallet is not revenue; the order counts here only once delivered.', 'دیاری بە 0 دینار داوا دەکرێت و تێچووی کاڵاکەی دەمێنێتەوە، بۆیە قازانجە نەرێنییەکەی تێچووی دیارییەکانە. بڕی کڕینی خێرای گیراو لە جزدان داهات نییە؛ داواکاری تەنها دوای گەیاندن لێرە دەژمێردرێت.'],
  // The figure drawer.
  drawerOpen: ['افتح طلبات «{name}»', 'Open the orders behind “{name}”', 'داواکارییەکانی پشت «{name}» بکەرەوە'],
  periodBasis: ['كل طلبات الفترة: {n}', 'Every order of the period: {n}', 'هەموو داواکارییەکانی ماوەکە: {n}'],
  // A cash figure stands on the orders with cash in it, not on every order (the review of step 4).
  cashDueBasis: ['طلبات عليها نقد: {n}', 'Orders with cash due: {n}', 'داواکاری بە پارەی ماوە: {n}'],
  cashOpenBasis: ['طلبات لم يُسجَّل نقدها كله: {n}', 'Orders whose cash is not all recorded: {n}', 'داواکاری کە هەموو پارەکەیان تۆمار نەکراوە: {n}'],
  tabOrders: ['الطلبات ({n})', 'Orders ({n})', 'داواکارییەکان ({n})'],
  overheadRow: ['حصة المصاريف العامة وترويج بلا مبيعات', 'Share of general expenses and promotion without sales', 'بەشی خەرجییە گشتییەکان و بانگەشەی بێ فرۆشتن'],
  unallocatedRow: ['ترويج شهر بلا مبيعات، في يومه الأول', 'Promotion of a month without sales, on its 1st', 'بانگەشەی مانگێکی بێ فرۆشتن، لە یەکەم ڕۆژیدا'],
  generalRow: ['حصة المصاريف العامة', 'Share of general expenses', 'بەشی خەرجییە گشتییەکان'],
  openPromotion: ['افتح ترويج الشهر', 'Open the monthly promotion', 'بانگەشەی مانگ بکەرەوە'],
  openExpenses: ['افتح المصاريف العامة', 'Open general expenses', 'خەرجییە گشتییەکان بکەرەوە'],
  revenueShort: ['الإيراد {amount}', 'Revenue {amount}', 'داهاتەکەی {amount}'],
  promoShort: ['الترويج {amount}', 'Promotion {amount}', 'بانگەشە {amount}'],
  noOrdersHere: ['لا طلبات في هذا العمود', 'No orders in this column', 'هیچ داواکارییەک لەم ستوونەدا نییە'],
  // The formula of every figure, in words.
  fSales: ['صافي المبيعات = قيمة البضاعة المباعة بعد الخصم على سعرها − المرتجعات', 'Net sales = the goods sold, after discounts on their price − returns', 'فرۆشی پوخت = کاڵای فرۆشراو دوای داشکاندن لە نرخەکەی − گەڕاوەکان'],
  fCogs: ['تكلفة البضاعة = تكلفة القطع التي احتفظ بها الزبائن: من دفعات المخزون، أو سعر مؤكد، أو تقدير وقت البيع حتى يُثبَّت', 'Cost of goods = what the pieces the customers kept cost: from stock batches, a confirmed price, or the sale-time estimate until one is confirmed', 'تێچووی کاڵا = تێچووی ئەو پارچانەی کڕیاران هێشتوویانەتەوە: لە بارەکانی کۆگا، یان نرخێکی دڵنیاکراو، یان خەمڵاندنی کاتی فرۆشتن تا جێگیر دەکرێت'],
  fGross: ['ربح البضاعة = صافي المبيعات − تكلفة البضاعة', 'Gross profit = net sales − cost of goods', 'قازانجی کاڵا = فرۆشی پوخت − تێچووی کاڵا'],
  fDelivery: ['ما دفعه الزبائن للتوصيل', 'What the customers paid for delivery', 'ئەوەی کڕیاران بۆ گەیاندن دایان'],
  fCod: ['رسوم الدفع عند الاستلام التي دفعها الزبائن', 'The cash-on-delivery fee the customers paid', 'ئەو کرێی پارەدان لە کاتی وەرگرتنەی کڕیاران دایان'],
  fWages: ['أجور الموظفين على هذه الطلبات؛ أجر بنسبة الربح ينتظر تثبيت التكلفة', 'Staff wages on these orders; a profit-based wage waits for a confirmed cost', 'کرێی کارمەندان لەسەر ئەم داواکارییانە؛ کرێی بەپێی قازانج چاوەڕێی جێگیرکردنی تێچووە'],
  fMaterials: ['كل تكلفة مباشرة غير الأجر، والتكلفة التي أدخلتها يدويًا على الطلب', 'Every direct cost that is not a wage, and the cost you entered on the order by hand', 'هەموو تێچوویەکی ڕاستەوخۆ جگە لە کرێ، و ئەو تێچووەی بە دەست لەسەر داواکارییەکە تۆمارت کرد'],
  fFees: ['أجر شركة التوصيل ورسوم الدفع، كما سُجّلت مع التحصيل', 'The courier’s fee and payment fees, as recorded with the collection', 'کرێی کۆمپانیای گەیاندن و کرێی پارەدان، وەک لەگەڵ وەرگرتن تۆمارکران'],
  fPromotion: ['ترويج الشهر موزعًا على مبيعاته حسب قيمتها، وترويج شهر بلا مبيعات في يومه الأول', 'The month’s promotion shared over its sales by value, and a month’s promotion without sales on its 1st', 'بانگەشەی مانگ بەسەر فرۆشتنەکانیدا بەپێی بەهاکەیان دابەشکراو، و بانگەشەی مانگێکی بێ فرۆشتن لە یەکەم ڕۆژیدا'],
  fInvestor: ['حصة المستثمرين من ربح القطع التي موّلوها؛ سالبة إن كانت خسارة', 'The investors’ share of the profit on the pieces they funded; negative for a loss', 'بەشی وەبەرهێنەران لە قازانجی ئەو پارچانەی پارەیان بۆ دانا؛ نەرێنی ئەگەر زیان بێت'],
  // Owner default 5.7.1, as the general expenses page words it since step 5's review: the day that counts is the expense's own.
  fGeneral: ['المصاريف العامة: إيجار وكهرباء واشتراكات… تُحسب كاملة في يوم المصروف المسجّل عليها، ولا يحملها طلب', 'General expenses: rent, power, subscriptions… count in full on the expense’s own day, and no order carries them', 'خەرجییە گشتییەکان: کرێی شوێن، کارەبا، بەشداری… بە تەواوی لە ڕۆژی خەرجییەکەدا دەژمێردرێن، و هیچ داواکارییەک هەڵیان ناگرێت'],
  fDeductions: ['الكوبونات وحماية السعر المسترجعة ورصيد الاستبدال المُعاد', 'Coupons, price protection paid back and returned trade-in credit', 'کۆپۆن و پاراستنی نرخی گەڕێندراوە و باڵانسی گۆڕینەوەی گەڕاوە'],
  fNet: ['صافي حصتك = ربح البضاعة + التوصيل + رسوم الدفع عند الاستلام − الأجور − المواد − أجور التوصيل والدفع − الترويج − حصة المستثمرين − المصاريف العامة − الخصومات', 'Your net share = gross profit + delivery + COD fee − wages − materials − courier and payment fees − promotion − investor share − general expenses − deductions', 'سافی بەشی تۆ = قازانجی کاڵا + گەیاندن + کرێی پارەدان لە کاتی وەرگرتن − کرێکان − کەرەستە − کرێی گەیاندن و پارەدان − بانگەشە − بەشی وەبەرهێنەران − خەرجییە گشتییەکان − داشکاندنەکان'],
  fCashDue: ['ما يُحصَّل عند التسليم وما يحوّله Gini، بعد ما رُدّ عبره', 'What is collected on delivery and what Gini transfers, after what was refunded through it', 'ئەوەی لە کاتی گەیاندندا وەردەگیرێت و ئەوەی Gini دەینێرێت، دوای ئەوەی لە ڕێگەیەوە گەڕێندرایەوە'],
  fCashOpen: ['المستحق − ما سُجّل استلامه. ليس عجزًا: مبالغ لم يُسجَّل وصولها بعد', 'Due − what is recorded as received. Not a shortfall: amounts whose arrival is not recorded yet', 'ماوە − ئەوەی وەک وەرگیراو تۆمارکراوە. کەمی نییە: ئەو بڕانەی هێشتا گەیشتنیان تۆمار نەکراوە'],
} as const satisfies Record<string, Tri>;
export type RsKey = keyof typeof RS;

type Loc = (ar: string, en: string, ckb?: string) => string;
/** One string in the reader's language, with {placeholders} filled. */
export function rs(loc: Loc, key: RsKey, vars: Record<string, string | number> = {}): string {
  const [ar, en, ckb] = RS[key];
  return loc(ar, en, ckb).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}
