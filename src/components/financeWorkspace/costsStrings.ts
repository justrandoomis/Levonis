/**
 * «المال والأرباح» → التكاليف — EVERY NEW WORD OF THE COSTS SECTION (redesign step 5, owner 2026-11-11; DECISIONS row 317):
 * the missing-costs page, the month's promotion, the general expenses and the figure drawer's general line, in Arabic,
 * English and Sorani in one table. A key added in one language and not the others does not compile, and
 * tests/financeCostsPages.test.ts holds that no Sorani slot is the Arabic or the English pasted across (DECISIONS row 183),
 * that each has a Sorani letter and no Arabic-only one, that the placeholders agree, that no letter is glued to a placeholder
 * (a Sorani suffix after an amount read «د.عەوە» — the independent review of step 5) — and that no sentence of the promotion
 * page speaks of pieces or units: the month's promotion is shared by sales value (DECISIONS row 313), never per piece. The one
 * promotion word that names pieces is the count column of «من يحمل الترويج» (`carriersPieces`), a count, not the rule.
 * Words the overview, the reports or the old ledger already have (FW, RS, financeStrings) are reused, never repeated.
 * Placeholders are {name}; numbers stay Latin in all three, as on every money screen.
 */
import { refusalText } from '../../lib/refusalStrings';

type Tri = readonly [ar: string, en: string, ckb: string];
export const CS = {
  // «التكاليف الناقصة» (the mockup's cards).
  missSub: ['مجمّعة حسب المنتج والمقاس أو اللون. سعر الشراء للقطعة يُطبَّق على البنود بعد تأكيدك، ولا يُحفظ شيء قبله.', 'Grouped by product and size or colour. The purchase price per piece applies to the lines once you confirm; nothing is saved before that.', 'بەپێی بەرهەم و قەبارە یان ڕەنگ کۆکراونەتەوە. نرخی کڕینی هەر پارچەیەک دوای دڵنیاکردنەوەت لەسەر بڕگەکان دادەنرێت، و پێش ئەوە هیچ پاشەکەوت ناکرێت.'],
  missEstimate: ['تقدير وقت البيع: {range}', 'Sale-time estimate: {range}', 'خەمڵاندنی کاتی فرۆشتن: {range}'],
  missNoEstimate: ['لا تقدير ولا سعر', 'No estimate, no price', 'نە خەمڵاندن و نە نرخ'],
  missSnapshot: ['سعر مسجّل قديم غير مؤكد', 'An old recorded price, not confirmed', 'نرخێکی کۆنی تۆمارکراو، دڵنیانەکراو'],
  missPerPiece: ['سعر الشراء للقطعة (د.ع)', 'Purchase price per piece (IQD)', 'نرخی کڕین بۆ هەر پارچەیەک (د.ع)'],
  missReview: ['راجِع وثبّت', 'Review and confirm', 'پێداچوونەوە بکە و جێگیری بکە'],
  missRecordStock: ['سجّل الشراء في المخزون لتُحسب المبيعات القادمة تلقائيًا', 'Record the purchase in Inventory so future sales are costed automatically', 'کڕینەکە لە کۆگا تۆمار بکە بۆ ئەوەی فرۆشتنەکانی داهاتوو خۆکارانە تێچوویان بۆ بژمێردرێت'],

  // «ترويج الشهر».
  promoPick: ['شهر الترويج', 'Promotion month', 'مانگی بانگەشە'],
  promoSpan: ['الفترة تمتد من {from} إلى {to}؛ لكل شهر ترويجه، وهذه الصفحة تعرض شهرًا واحدًا في كل مرة.', 'The period runs from {from} to {to}; each month has its own promotion, and this page shows one month at a time.', 'ماوەکە {from} تا {to} دەگرێتەوە؛ هەر مانگێک بانگەشەی خۆی هەیە، و ئەم پەڕەیە هەر جارە یەک مانگ پیشان دەدات.'],
  promoProvisional: ['مؤقت حتى نهاية الشهر', 'Provisional until the month ends', 'کاتییە تا کۆتایی مانگ'],
  promoProvisionalNote: ['حصص المنتجات تتغير مع كل طلب يُسلَّم حتى يكتمل الشهر.', 'The products’ shares move with every order delivered until the month is over.', 'بەشی بەرهەمەکان لەگەڵ هەر داواکارییەکی گەیەندراو دەگۆڕێت تا مانگەکە تەواو دەبێت.'],
  promoAmount: ['مبلغ الترويج', 'Promotion amount', 'بڕی بانگەشە'],
  promoCurrency: ['العملة', 'Currency', 'جۆری دراو'],
  promoRecorded: ['المسجّل بالدينار: {amount}', 'Recorded in dinars: {amount}', 'تۆمارکراو بە دینار: {amount}'],
  promoSave: ['حفظ مبلغ الشهر', 'Save the month’s amount', 'بڕی مانگەکە پاشەکەوت بکە'],
  promoDisable: ['إيقاف ترويج هذا الشهر', 'Disable this month’s promotion', 'بانگەشەی ئەم مانگە ڕابگرە'],
  // Disabling asks first, as the missing costs' confirmation does (the independent review of step 5).
  promoDisableAsk: ['يُوقَف ترويج {month} ({amount}) فلا تحمله منتجات الشهر بعد الآن، ويبقى في سجل التعديلات. لإعادته أدخل مبلغه وسعره من جديد.', 'This stops the promotion of {month} ({amount}): the month’s products no longer carry it, and the history keeps it. To bring it back, enter its amount and rate again.', 'بانگەشەی {month} ({amount}) ڕادەگیرێت: ئیتر بەرهەمەکانی مانگەکە هەڵی ناگرن، و لە مێژووی دەستکارییەکاندا دەمێنێتەوە. بۆ گەڕاندنەوەی، بڕ و نرخەکەی دووبارە بنووسە.'],
  promoDisableConfirm: ['أوقف الترويج', 'Stop the promotion', 'بانگەشەکە ڕابگرە'],
  promoDisabled: ['أُوقف ترويج الشهر، ولم تعد منتجاته تحمله', 'The month’s promotion is stopped; its products no longer carry it', 'بانگەشەی مانگ ڕاگیرا؛ ئیتر بەرهەمەکانی هەڵی ناگرن'],
  promoSaved: ['حُفظ ترويج الشهر وأُعيد حساب حصص المنتجات', 'The month’s promotion is saved and the products’ shares worked out again', 'بانگەشەی مانگ پاشەکەوت کرا و بەشی بەرهەمەکان دووبارە ژمێردرایەوە'],
  promoInvalid: ['أدخل مبلغًا صحيحًا', 'Enter a valid amount', 'بڕێکی دروست بنووسە'],
  // A month whose read failed shows no form: what was typed for another month is never saved on this one.
  promoReadFailed: ['تعذّرت قراءة ترويج هذا الشهر، فلا يُعرض نموذجه حتى لا يُحفظ عليه مبلغ شهر آخر.', 'This month’s promotion could not be read, so its form is not shown: nothing typed for another month can be saved on it.', 'بانگەشەی ئەم مانگە نەخوێندرایەوە، بۆیە فۆرمەکەی پیشان نادرێت تا بڕی مانگێکی تر لەسەری پاشەکەوت نەکرێت.'],
  promoRetry: ['أعد المحاولة', 'Try again', 'دووبارە هەوڵ بدەرەوە'],
  promoRule: ['القاعدة: حسب قيمة المبيعات (قرارك، {day})', 'The rule: by sales value (your decision, {day})', 'یاسا: بەپێی بەهای فرۆشتن (بڕیاری تۆ، {day})'],
  promoRuleNote: ['كل منتج يحمل من ترويج الشهر بقدر حصته من مبيعات الشهر، ومجموع الحصص هو مبلغ الشهر تمامًا. يتحمله المالك وحده.', 'Each product carries the month’s promotion in proportion to its share of the month’s sales, and the shares add up to the month’s amount exactly. The owner alone bears it.', 'هەر بەرهەمێک بە ئەندازەی بەشی خۆی لە فرۆشتنی مانگەکە بانگەشەی مانگ هەڵدەگرێت، و کۆی بەشەکان ڕێک بڕی مانگەکەیە. تەنها خاوەن هەڵیدەگرێت.'],
  // The table's basis, said where its figures stand (the independent review of step 5): the invoice, before any return.
  promoInvoiced: ['الأرقام كما في الفاتورة: المرتجع والمبلغ المسترد لا يغيّران حصص الترويج.', 'Figures as invoiced: a return or a refund does not move the promotion’s shares.', 'ژمارەکان بەپێی پسوولەن: گەڕاندنەوە و پارە گەڕاندنەوە بەشەکانی بانگەشە ناگۆڕن.'],
  promoStaff: ['حصة الموظف والمستثمر لا يدخلها الترويج', 'The promotion never enters a staff member’s or an investor’s share', 'بانگەشە ناچێتە ناو بەشی کارمەند و وەبەرهێنەرەوە'],
  promoCarriers: ['من يحمل الترويج', 'Who carries it', 'کێ هەڵیدەگرێت'],
  promoColShare: ['حصته من المبيعات', 'Share of sales', 'بەشی لە فرۆشتن'],
  // A month whose every line was free (gifts): the server shares it equally by line, and the percent follows those shares.
  promoColShareGifts: ['نسبته من الترويج (هدايا: بالتساوي لكل بند)', 'Share of the promotion (gifts: equal per line)', 'ڕێژەی لە بانگەشە (دیاری: یەکسان بۆ هەر بڕگەیەک)'],
  promoColAmount: ['حصته من الترويج', 'Promotion share', 'بەشی لە بانگەشە'],
  promoWaiting: ['ينتظر مبيعات الشهر', 'Waiting for the month’s sales', 'چاوەڕێی فرۆشتنی مانگەکەیە'],
  promoWaitingNote: ['لا مبيعات مسلَّمة في هذا الشهر بعد: يُحسب المبلغ كاملًا في يومه الأول، ويتوزع على المبيعات حين تُسلَّم.', 'No sales delivered this month yet: the whole amount counts on its 1st, and is shared over the sales once they are delivered.', 'هێشتا هیچ فرۆشتنێکی گەیەندراو لەم مانگەدا نییە: هەموو بڕەکە لە یەکەم ڕۆژیدا دەژمێردرێت، و کاتێک فرۆشتنەکان دەگەیەنرێن بەسەریاندا دابەش دەکرێت.'],
  // A month that has ended with no sale: nothing waits any more (owner default 5.7.4).
  promoEnded: ['حُسب في يومه الأول', 'Counted on its 1st', 'لە یەکەم ڕۆژیدا ژمێردرا'],
  promoEndedNote: ['لا مبيعات مسلَّمة في هذا الشهر: حُسب المبلغ كاملًا في يومه الأول، ولا مبيعات بعده تحمله.', 'No sales were delivered in this month: the whole amount counted on its 1st, and no later sale carries it.', 'هیچ فرۆشتنێکی گەیەندراو لەم مانگەدا نەبوو: هەموو بڕەکە لە یەکەم ڕۆژیدا ژمێردرا، و هیچ فرۆشتنێکی دواتر هەڵی ناگرێت.'],
  promoNone: ['لا ترويج مسجّل لهذا الشهر', 'No promotion recorded for this month', 'هیچ بانگەشەیەک بۆ ئەم مانگە تۆمار نەکراوە'],
  promoLoading: ['تحميل ترويج الشهر…', 'Loading the month’s promotion…', 'بانگەشەی مانگ بار دەکرێت…'],
  promoHistory: ['سجل التعديلات', 'History of edits', 'مێژووی دەستکارییەکان'],
  histCreated: ['أُدخل: {after}', 'Entered: {after}', 'تۆمارکرا: {after}'],
  histChanged: ['من {before} إلى {after}', 'From {before} to {after}', 'گۆڕدرا: {before} ← {after}'],
  histSame: ['المبلغ كما هو: {after}', 'Amount unchanged: {after}', 'بڕەکە نەگۆڕا: {after}'],
  histMoved: ['نُقل من شهر {from} إلى شهر {to}', 'Moved from {from} to {to}', 'گوازرایەوە لە مانگی {from} بۆ مانگی {to}'],
  histDisabled: ['أُوقف: {before}', 'Disabled: {before}', 'ڕاگیرا: {before}'],
  histEnabled: ['أُعيد تفعيله: {after}', 'Enabled again: {after}', 'دووبارە چالاککرایەوە: {after}'],
  histUnknown: ['مستخدم محذوف', 'A deleted user', 'بەکارهێنەرێکی سڕاوە'],
  histNone: ['لا تعديلات بعد', 'No edits yet', 'هێشتا هیچ دەستکارییەک نییە'],
  histTruncated: ['تُعرض آخر {n} من التعديلات؛ الأقدم في سجل التدقيق.', 'The latest {n} edits are listed; older ones are in the audit log.', 'دوایین {n} دەستکاری پیشان دەدرێن؛ کۆنترەکان لە تۆماری وردبینیدا هەن.'],
  // «من يحمل الترويج»'s count and sales columns: what the invoice says, as the shares are worked out (row 313).
  carriersPieces: ['القطع المبيعة', 'Pieces sold', 'پارچەی فرۆشراو'],
  carriersSales: ['المبيعات كما في الفاتورة', 'Sales as invoiced', 'فرۆشتن بەپێی پسوولە'],

  // «المصاريف العامة».
  genSame: ['الرقم نفسه، بالدينار، في سطر «المصاريف العامة» من «من المبيعات إلى حصتك» ونافذته', 'The same figure, in dinars, as the “General expenses” line of “From sales to your share” and its drawer', 'هەمان ژمارە، بە دینار، وەک هێڵی «خەرجییە گشتییەکان» لە «لە فرۆشتنەوە بۆ بەشی تۆ» و پەنجەرەکەی'],
  genWhat: ['ما المصاريف العامة؟', 'What are general expenses?', 'خەرجییە گشتییەکان چین؟'],
  // Owner default 5.7.1, worded on the day that counts: the expense's day, as recorded on it (the independent review of step 5).
  genDefinition: ['إيجار، كهرباء، اشتراكات… تُحسب كاملة في يوم المصروف المسجّل عليها، ولا يحملها طلب: تُخصم من صافي الفترة التي فيها ذلك اليوم. والمرتبط بطلب انتهى دون تسليم يُحسب معها في يومه.', 'Rent, power, subscriptions… count in full on the expense’s own day, the day recorded on it, and no order carries them: they come off the net of the period that day is in. One linked to an order that ended without a delivery counts with them, on its own day.', 'کرێی شوێن، کارەبا، بەشداری… بە تەواوی لە ڕۆژی خەرجییەکەدا دەژمێردرێن، ئەو ڕۆژەی لەسەری تۆمارکراوە، و هیچ داواکارییەک هەڵیان ناگرێت: لە سافی ئەو ماوەیەی ئەو ڕۆژەی تێدایە کەم دەکرێنەوە. ئەوەی بە داواکارییەکەوە بەستراوە کە بێ گەیاندن کۆتایی هات، لەگەڵیاندا لە ڕۆژی خۆیدا دەژمێردرێت.'],
  genCentreRule: ['القيد الموسوم بمركز تكلفة يبقى في المصاريف العامة كما هو اليوم؛ قاعدته تنتظر قرارك.', 'An entry tagged to a cost centre stays in general expenses, as today; its rule awaits your decision.', 'تۆمارێک کە نیشانەی ناوەندی تێچووی لەسەرە وەک ئەمڕۆ لە خەرجییە گشتییەکاندا دەمێنێتەوە؛ یاساکەی چاوەڕێی بڕیاری تۆیە.'],
  genAll: ['كل القيود المسجّلة في الفترة {all} = المصاريف العامة {general} + ما يُحسب في مكان آخر {elsewhere}', 'Every entry recorded in the period, {all} = general expenses {general} + what counts elsewhere {elsewhere}', 'هەموو تۆمارەکانی ئەم ماوەیە، {all} = خەرجییە گشتییەکان {general} + ئەوەی لە شوێنێکی تر دەژمێردرێت {elsewhere}'],
  genByCategory: ['حسب الفئة', 'By category', 'بەپێی پۆل'],
  genEntries: ['القيود', 'Entries', 'تۆمارەکان'],
  genEmpty: ['لا مصاريف عامة في الفترة', 'No general expenses in the period', 'هیچ خەرجییەکی گشتی لەم ماوەیەدا نییە'],
  genEmptyNote: ['إيجار، كهرباء، اشتراكات… تُخصم من صافي الفترة حين تُسجَّل.', 'Rent, power, subscriptions… come off the period’s net once recorded.', 'کرێی شوێن، کارەبا، بەشداری… کاتێک تۆمار دەکرێن لە سافی ماوەکە کەم دەکرێنەوە.'],
  genAdd: ['أضف مصروفًا', 'Add an expense', 'خەرجییەک زیاد بکە'],
  genCategoryPick: ['اختر الفئة', 'Choose a category', 'پۆلێک هەڵبژێرە'],
  genElsewhere: ['قيود الفترة التي لا تُحسب مصاريف عامة', 'Entries of the period that are not general expenses', 'تۆمارەکانی ئەم ماوەیە کە وەک خەرجیی گشتی ناژمێردرێن'],
  genElsewhereNote: ['كل قيد يُحسب مرة واحدة، في مكانه:', 'Each counts once, in its own place:', 'هەر تۆمارێک یەک جار دەژمێردرێت، لە شوێنی خۆیدا:'],
  genCentre: ['مركز التكلفة: {name}', 'Cost centre: {name}', 'ناوەندی تێچوو: {name}'],
  genEdit: ['تعديل', 'Edit', 'دەستکاری'],
  genSave: ['حفظ التعديل', 'Save the change', 'گۆڕانکارییەکە پاشەکەوت بکە'],
  genCancel: ['تراجع', 'Cancel', 'پاشگەزبوونەوە'],
  genNothingChanged: ['لم يتغير شيء بعد', 'Nothing has changed yet', 'هێشتا هیچ نەگۆڕاوە'],
  // Voiding names what it does and asks first; «إلغاء» stays the Cancel of the section's confirmations (the review of step 5).
  genVoidAction: ['ألغِ هذا القيد…', 'Void this entry…', 'ئەم تۆمارە هەڵبوەشێنەوە…'],
  genVoidAsk: ['يُلغى هذا القيد ({amount}) فيخرج من كل رقم يُحسب فيه، ومن «المصاريف العامة» إن كان منها؛ ويبقى في السجل مشطوبًا، ويُسترجع من «أظهر الملغاة».', 'This voids the entry ({amount}): it leaves every figure it counts in, “General expenses” too if it is one, and stays in the ledger struck through; “Show voided” brings it back.', 'ئەم تۆمارە ({amount}) هەڵدەوەشێتەوە: لە هەموو ژمارەیەک دەردەچێت کە تێیدا دەژمێردرێت، و لە «خەرجییە گشتییەکان» ئەگەر لەوان بێت؛ لە تۆمارەکەدا بە هێڵکێشراوی دەمێنێتەوە و «هەڵوەشێنراوەکان پیشان بدە» دەیگەڕێنێتەوە.'],
  genVoidConfirm: ['ألغِ القيد', 'Void it', 'هەڵیبوەشێنەوە'],
  genEditedElsewhere: ['يُعدَّل من مكانه', 'Edited where it counts', 'لە شوێنی خۆیەوە دەستکاری دەکرێت'],
  // A disabled promotion's expense row: stopped and brought back on its own page, never restored here.
  genPromoDisabled: ['أُوقف من صفحة الترويج', 'Stopped on the promotion page', 'لە پەڕەی بانگەشەوە ڕاگیرا'],
  // A promotion's expense linked to an order too (possible before the review of step 5): it counts in both places.
  genPromoLinked: ['مرتبط أيضًا بطلب، فيُحسب مرتين: في الترويج وفي تكاليف الطلب', 'Also linked to an order, so it counts twice: in the promotion and in the order’s costs', 'بە داواکارییەکیشەوە بەستراوە، بۆیە دوو جار دەژمێردرێت: لە بانگەشەدا و لە تێچووی داواکارییەکەدا'],
  genClosed: ['شهر مغلق محاسبيًا', 'Month closed in accounting', 'مانگی داخراوی ژمێریاری'],
  genClosedNote: ['أشهر الفترة المغلقة محاسبيًا: {months}. قيودها لا تُعدَّل ولا تُلغى من هنا؛ سجّل التصحيح في شهر مفتوح.', 'Months of the period closed in accounting: {months}. Their entries are not edited or voided here; record a correction in an open month.', 'مانگە داخراوەکانی ژمێریاری لەم ماوەیەدا: {months}. تۆمارەکانیان لێرەوە دەستکاری یان هەڵناوەشێنرێنەوە؛ ڕاستکردنەوەکە لە مانگێکی کراوەدا تۆمار بکە.'],
  // A list cut at the page's limit says so, by its own counts (the totals stay the whole period's).
  genPartial: ['قيود هذا القسم: تُعرض {shown} من {all}؛ المجموع للفترة كلها.', 'This group’s entries: {shown} of {all} listed; the total is the whole period’s.', 'تۆمارەکانی ئەم بەشە: {shown} لە {all} پیشان دەدرێن؛ کۆکە هی هەموو ماوەکەیە.'],
  genLoading: ['تحميل المصاريف…', 'Loading the expenses…', 'خەرجییەکان بار دەکرێن…'],
  genNoTitle: ['بلا بيان', 'No description', 'بێ وەسف'],
  // Where each entry counts (the plan's table, 5.1).
  kindGeneral: ['مصروف عام', 'General expense', 'خەرجیی گشتی'],
  kindPromotion: ['ترويج الشهر ← صفحة الترويج', 'The month’s promotion → the promotion page', 'بانگەشەی مانگ ← پەڕەی بانگەشە'],
  kindOrderCost: ['أجر أو مواد طلب ← ذلك الطلب', 'An order’s wage or materials → that order', 'کرێ یان کەرەستەی داواکارییەک ← ئەو داواکارییە'],
  kindCollectionFee: ['أجر تحصيل شركة التوصيل ← «أجور التوصيل والدفع»', 'A courier’s collection fee → “Courier and payment fees”', 'کرێی وەرگرتنی کۆمپانیای گەیاندن ← «کرێی گەیاندن و پارەدان»'],
  kindOrderDelivered: ['مرتبط بطلب مُسلَّم ← «المواد والتكاليف الإضافية» لذلك الطلب', 'Linked to a delivered order → that order’s “Materials and extra costs”', 'بەستراو بە داواکارییەکی گەیەندراوەوە ← «کەرەستە و تێچووی زیادە»ی ئەو داواکارییە'],
  kindOrderWaiting: ['مرتبط بطلب في الطريق ← يُحسب عند التسليم', 'Linked to an order on its way → counted on delivery', 'بەستراو بە داواکارییەکی سەر ڕێگاوە ← لە کاتی گەیاندندا دەژمێردرێت'],
  kindOrderEnded: ['مرتبط بطلب انتهى دون تسليم ← يُحسب مصروفًا عامًا', 'Linked to an order that ended without a delivery → counted as a general expense', 'بەستراو بە داواکارییەکەوە کە بێ گەیاندن کۆتایی هات ← وەک خەرجیی گشتی دەژمێردرێت'],

  // The figure drawer's «المصاريف العامة» line: one note in place of the overview's two, and a total named for what it sums.
  drawerGeneralNote: ['لا يحملها طلب بعينه: يحمل كل عمود حصته منها بنسبة إيراده، وقيود الفترة كلها تحت.', 'No single order carries them: each column carries its share by its revenue, and every entry of the period is listed below.', 'هیچ داواکارییەکی دیاریکراو هەڵیان ناگرێت: هەر ستوونێک بەپێی داهاتەکەی بەشی خۆی لێیان هەڵدەگرێت، و هەموو تۆمارەکانی ماوەکە لە خوارەوەن.'],
  drawerEntries: ['قيود المصاريف العامة في الفترة', 'The period’s general expense entries', 'تۆمارەکانی خەرجیی گشتی لەم ماوەیەدا'],
  drawerTotal: ['مجموع قيود الفترة (كل الأعمدة)', 'All entries of the period (every column)', 'کۆی تۆمارەکانی ماوەکە (هەموو ستوونەکان)'],
  // In dollars the entries stay in dinars, as recorded; their total in dollars is the statement line's own cents.
  drawerInIqd: ['المبالغ هنا بالدينار كما سُجّلت؛ مجموعها بالدولار {usd}، كما في سطر الكشف.', 'These amounts are in dinars, as recorded; their total in dollars is {usd}, as on the statement line.', 'ئەم بڕانە بە دینارن وەک تۆمارکراون؛ کۆکەیان بە دۆلار دەکاتە {usd}، وەک لە هێڵی کەشفەکەدا.'],

  // A write the server refused with a code: the sentence in the reader's language (the review of step 5: never the server's raw one).
  refPeriodClosed: ['الشهر مغلق محاسبيًا: لا يتغير قيد من قيوده. سجّل التصحيح في شهر مفتوح.', 'This month’s accounting is closed: none of its entries can change. Record the correction in an open month.', 'ژمێریاریی ئەم مانگە داخراوە: هیچ تۆمارێکی ناگۆڕێت. ڕاستکردنەوەکە لە مانگێکی کراوەدا تۆمار بکە.'],
  refConflict: ['تغيّر هذا منذ فُتحت الصفحة؛ حدّثها ثم أعد المحاولة.', 'This changed since the page was opened; refresh it and try again.', 'ئەمە لەو کاتەوەی پەڕەکە کرایەوە گۆڕاوە؛ نوێی بکەرەوە و دووبارە هەوڵ بدەرەوە.'],
  refVoided: ['هذا القيد ملغى: استرجعه أولًا ثم عدّله.', 'This entry is voided: restore it first, then edit it.', 'ئەم تۆمارە هەڵوەشێنراوەتەوە: سەرەتا بیگەڕێنەوە، پاشان دەستکاری بکە.'],
  refCategory: ['الفئة غير موجودة؛ اختر فئة من القائمة.', 'That category does not exist; choose one from the list.', 'ئەو پۆلە بوونی نییە؛ پۆلێک لە لیستەکە هەڵبژێرە.'],
} as const satisfies Record<string, Tri>;
export type CsKey = keyof typeof CS;

type Loc = (ar: string, en: string, ckb?: string) => string;
/** One string in the reader's language, with {placeholders} filled. */
export function cs(loc: Loc, key: CsKey, vars: Record<string, string | number> = {}): string {
  const [ar, en, ckb] = CS[key];
  return loc(ar, en, ckb).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

/** The codes the costs pages' writes are refused with, and their sentence here. */
export const REFUSALS: Readonly<Record<string, CsKey>> = { PERIOD_CLOSED: 'refPeriodClosed', CONFLICT: 'refConflict', EXPENSE_VOIDED: 'refVoided', CATEGORY_UNKNOWN: 'refCategory' };
/**
 * A refused write in the reader's language: this table's sentence for its code, else the shop's refusal table's
 * (PROMOTION_RATE_REQUIRED and the like), else `fallback` — never the server's own sentence, which is Arabic or English
 * whatever the page's language (the independent review of step 5).
 */
export function refusalWords(loc: Loc, lang: string, error: unknown, fallback: string): string {
  const code = error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
  const key = REFUSALS[code];
  return key ? cs(loc, key) : refusalText(code, lang === 'en' || lang === 'ckb' ? lang : 'ar', fallback) || fallback;
}

/**
 * A COUNT WITH ITS NOUN, AS EACH LANGUAGE SAYS IT (the mockup's «n بندًا»). Arabic agrees the noun with the number — one,
 * two, three to ten, eleven to ninety-nine, and the rest (the CLDR plural categories, `Intl.PluralRules`); English has one
 * and many; Sorani keeps the noun as it is after any number.
 */
type Counted = { readonly ar: readonly [one: string, two: string, few: string, many: string, other: string]; readonly en: readonly [one: string, other: string]; readonly ckb: string };
export const COUNTED = {
  lines: { ar: ['بند واحد', 'بندان', '{n} بنود', '{n} بندًا', '{n} بند'], en: ['1 line', '{n} lines'], ckb: '{n} بڕگە' },
  pieces: { ar: ['قطعة واحدة', 'قطعتان', '{n} قطع', '{n} قطعة', '{n} قطعة'], en: ['1 piece', '{n} pieces'], ckb: '{n} پارچە' },
  orders: { ar: ['طلب واحد', 'طلبان', '{n} طلبات', '{n} طلبًا', '{n} طلب'], en: ['1 order', '{n} orders'], ckb: '{n} داواکاری' },
  missingHead: { ar: ['بند واحد بلا تكلفة مؤكدة', 'بندان بلا تكلفة مؤكدة', '{n} بنود بلا تكلفة مؤكدة', '{n} بندًا بلا تكلفة مؤكدة', '{n} بند بلا تكلفة مؤكدة'],
    en: ['1 line without a confirmed cost', '{n} lines without a confirmed cost'], ckb: '{n} بڕگە بێ تێچووی دڵنیاکراو' },
  // A card whose lines are partly estimated still names, in red, the ones with nothing at all (the review of step 5).
  linesNoPrice: { ar: ['بند واحد بلا تقدير ولا سعر', 'بندان بلا تقدير ولا سعر', '{n} بنود بلا تقدير ولا سعر', '{n} بندًا بلا تقدير ولا سعر', '{n} بند بلا تقدير ولا سعر'],
    en: ['1 line with no estimate and no price', '{n} lines with no estimate and no price'], ckb: '{n} بڕگە بێ خەمڵاندن و بێ نرخ' },
} as const satisfies Record<string, Counted>;
const AR_FORM: Record<string, number> = { one: 0, two: 1, few: 2, many: 3 };
let arRules: Intl.PluralRules | null = null;
/** `n` with its noun in `lang`; the number in Latin digits with thousands separators. */
export function counted(lang: string, key: keyof typeof COUNTED, n: number): string {
  const entry: Counted = COUNTED[key], num = n.toLocaleString('en-US');
  const text = lang === 'ckb' ? entry.ckb : lang === 'en' ? entry.en[n === 1 ? 0 : 1] : entry.ar[AR_FORM[(arRules ??= new Intl.PluralRules('ar')).select(n)] ?? 4];
  return text.replace('{n}', num);
}
