/**
 * «المال والأرباح» → التكاليف — EVERY NEW WORD OF THE COSTS SECTION (redesign step 5, owner 2026-11-11; DECISIONS row 317):
 * the missing-costs page, the month's promotion, the general expenses and the figure drawer's general line, in Arabic,
 * English and Sorani in one table. A key added in one language and not the others does not compile, and
 * tests/financeCostsPages.test.ts holds that no Sorani slot is the Arabic or the English pasted across (DECISIONS row 183),
 * that each has a Sorani letter and no Arabic-only one, that the placeholders agree — and that no sentence of the promotion
 * page speaks of pieces or units: the month's promotion is shared by sales value (DECISIONS row 313), never per piece.
 * Words the overview, the reports or the old ledger already have (FW, RS, financeStrings) are reused, never repeated.
 * Placeholders are {name}; numbers stay Latin in all three, as on every money screen.
 */
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
  promoSpan: ['الفترة تمتد من {from} إلى {to}؛ لكل شهر ترويجه، وهذه الصفحة تعرض شهرًا واحدًا في كل مرة.', 'The period runs from {from} to {to}; each month has its own promotion, and this page shows one month at a time.', 'ماوەکە لە {from}ەوە بۆ {to} درێژ دەبێتەوە؛ هەر مانگێک بانگەشەی خۆی هەیە، و ئەم پەڕەیە هەر جارە یەک مانگ پیشان دەدات.'],
  promoProvisional: ['مؤقت حتى نهاية الشهر', 'Provisional until the month ends', 'کاتییە تا کۆتایی مانگ'],
  promoProvisionalNote: ['حصص المنتجات تتغير مع كل طلب يُسلَّم حتى يكتمل الشهر.', 'The products’ shares move with every order delivered until the month is over.', 'بەشی بەرهەمەکان لەگەڵ هەر داواکارییەکی گەیەندراو دەگۆڕێت تا مانگەکە تەواو دەبێت.'],
  promoAmount: ['مبلغ الترويج', 'Promotion amount', 'بڕی بانگەشە'],
  promoCurrency: ['العملة', 'Currency', 'جۆری دراو'],
  promoRecorded: ['المسجّل بالدينار: {amount}', 'Recorded in dinars: {amount}', 'تۆمارکراو بە دینار: {amount}'],
  promoSave: ['حفظ مبلغ الشهر', 'Save the month’s amount', 'بڕی مانگەکە پاشەکەوت بکە'],
  promoDisable: ['إيقاف ترويج هذا الشهر', 'Disable this month’s promotion', 'بانگەشەی ئەم مانگە ڕابگرە'],
  promoSaved: ['حُفظ ترويج الشهر وأُعيد حساب حصص المنتجات', 'The month’s promotion is saved and the products’ shares worked out again', 'بانگەشەی مانگ پاشەکەوت کرا و بەشی بەرهەمەکان دووبارە ژمێردرایەوە'],
  promoInvalid: ['أدخل مبلغًا صحيحًا', 'Enter a valid amount', 'بڕێکی دروست بنووسە'],
  promoRule: ['القاعدة: حسب قيمة المبيعات (قرارك، {day})', 'The rule: by sales value (your decision, {day})', 'یاسا: بەپێی بەهای فرۆشتن (بڕیاری تۆ، {day})'],
  promoRuleNote: ['كل منتج يحمل من ترويج الشهر بقدر حصته من مبيعات الشهر، ومجموع الحصص هو مبلغ الشهر تمامًا. يتحمله المالك وحده.', 'Each product carries the month’s promotion in proportion to its share of the month’s sales, and the shares add up to the month’s amount exactly. The owner alone bears it.', 'هەر بەرهەمێک بە ئەندازەی بەشی خۆی لە فرۆشتنی مانگەکە بانگەشەی مانگ هەڵدەگرێت، و کۆی بەشەکان ڕێک بڕی مانگەکەیە. تەنها خاوەن هەڵیدەگرێت.'],
  promoStaff: ['حصة الموظف والمستثمر لا يدخلها الترويج', 'The promotion never enters a staff member’s or an investor’s share', 'بانگەشە ناچێتە ناو بەشی کارمەند و وەبەرهێنەرەوە'],
  promoCarriers: ['من يحمل الترويج', 'Who carries it', 'کێ هەڵیدەگرێت'],
  promoColShare: ['حصته من المبيعات', 'Share of sales', 'بەشی لە فرۆشتن'],
  promoColAmount: ['حصته من الترويج', 'Promotion share', 'بەشی لە بانگەشە'],
  promoWaiting: ['ينتظر مبيعات الشهر', 'Waiting for the month’s sales', 'چاوەڕێی فرۆشتنی مانگەکەیە'],
  promoWaitingNote: ['لا مبيعات مسلَّمة في هذا الشهر بعد: يُحسب المبلغ كاملًا في يومه الأول، ويتوزع على المبيعات حين تُسلَّم.', 'No sales delivered this month yet: the whole amount counts on its 1st, and is shared over the sales once they are delivered.', 'هێشتا هیچ فرۆشتنێکی گەیەندراو لەم مانگەدا نییە: هەموو بڕەکە لە یەکەم ڕۆژیدا دەژمێردرێت، و کاتێک فرۆشتنەکان دەگەیەنرێن بەسەریاندا دابەش دەکرێت.'],
  promoNone: ['لا ترويج مسجّل لهذا الشهر', 'No promotion recorded for this month', 'هیچ بانگەشەیەک بۆ ئەم مانگە تۆمار نەکراوە'],
  promoLoading: ['تحميل ترويج الشهر…', 'Loading the month’s promotion…', 'بانگەشەی مانگ بار دەکرێت…'],
  promoHistory: ['سجل التعديلات', 'History of edits', 'مێژووی دەستکارییەکان'],
  histCreated: ['أُدخل: {after}', 'Entered: {after}', 'تۆمارکرا: {after}'],
  histChanged: ['من {before} إلى {after}', 'From {before} to {after}', 'لە {before}ەوە بۆ {after}'],
  histDisabled: ['أُوقف: {before}', 'Disabled: {before}', 'ڕاگیرا: {before}'],
  histEnabled: ['أُعيد تفعيله: {after}', 'Enabled again: {after}', 'دووبارە چالاککرایەوە: {after}'],
  histUnknown: ['مستخدم محذوف', 'A deleted user', 'بەکارهێنەرێکی سڕاوە'],
  histNone: ['لا تعديلات بعد', 'No edits yet', 'هێشتا هیچ دەستکارییەک نییە'],

  // «المصاريف العامة».
  genSame: ['الرقم نفسه في سطر «المصاريف العامة» من «من المبيعات إلى حصتك» ونافذته', 'The same figure as the “General expenses” line of “From sales to your share” and its drawer', 'هەمان ژمارەی هێڵی «خەرجییە گشتییەکان» لە «لە فرۆشتنەوە بۆ بەشی تۆ» و پەنجەرەکەی'],
  genWhat: ['ما المصاريف العامة؟', 'What are general expenses?', 'خەرجییە گشتییەکان چین؟'],
  genDefinition: ['إيجار، كهرباء، اشتراكات… تُحسب كاملة في يوم إدخالها، ولا يحملها طلب: تُخصم من صافي الفترة التي فيها يومها. والمرتبط بطلب انتهى دون تسليم يُحسب معها في يومه.', 'Rent, power, subscriptions… count in full on the day they are entered, and no order carries them: they come off the net of the period their day is in. One linked to an order that ended without a delivery counts with them, on its own day.', 'کرێی شوێن، کارەبا، بەشداری… بە تەواوی لە ڕۆژی تۆمارکردنیاندا دەژمێردرێن، و هیچ داواکارییەک هەڵیان ناگرێت: لە سافی ئەو ماوەیەی ڕۆژەکەیانی تێدایە کەم دەکرێنەوە. ئەوەی بە داواکارییەکەوە بەستراوە کە بێ گەیاندن کۆتایی هات، لەگەڵیاندا لە ڕۆژی خۆیدا دەژمێردرێت.'],
  genCentreRule: ['القيد الموسوم بمركز تكلفة يبقى في المصاريف العامة كما هو اليوم؛ قاعدته تنتظر قرارك.', 'An entry tagged to a cost centre stays in general expenses, as today; its rule awaits your decision.', 'تۆمارێک کە نیشانەی ناوەندی تێچووی لەسەرە وەک ئەمڕۆ لە خەرجییە گشتییەکاندا دەمێنێتەوە؛ یاساکەی چاوەڕێی بڕیاری تۆیە.'],
  genAll: ['كل القيود المسجّلة في الفترة {all} = المصاريف العامة {general} + ما يُحسب في مكان آخر {elsewhere}', 'Every entry recorded in the period, {all} = general expenses {general} + what counts elsewhere {elsewhere}', 'هەموو تۆمارەکانی ئەم ماوەیە، {all} = خەرجییە گشتییەکان {general} + ئەوەی لە شوێنێکی تر دەژمێردرێت {elsewhere}'],
  genByCategory: ['حسب الفئة', 'By category', 'بەپێی پۆل'],
  genEntries: ['القيود', 'Entries', 'تۆمارەکان'],
  genEmpty: ['لا مصاريف عامة في الفترة', 'No general expenses in the period', 'هیچ خەرجییەکی گشتی لەم ماوەیەدا نییە'],
  genEmptyNote: ['إيجار، كهرباء، اشتراكات… تُخصم من صافي الفترة حين تُسجَّل.', 'Rent, power, subscriptions… come off the period’s net once recorded.', 'کرێی شوێن، کارەبا، بەشداری… کاتێک تۆمار دەکرێن لە سافی ماوەکە کەم دەکرێنەوە.'],
  genAdd: ['أضف مصروفًا', 'Add an expense', 'خەرجییەک زیاد بکە'],
  genElsewhere: ['قيود الفترة التي لا تُحسب مصاريف عامة', 'Entries of the period that are not general expenses', 'تۆمارەکانی ئەم ماوەیە کە وەک خەرجیی گشتی ناژمێردرێن'],
  genElsewhereNote: ['كل قيد يُحسب مرة واحدة، في مكانه:', 'Each counts once, in its own place:', 'هەر تۆمارێک یەک جار دەژمێردرێت، لە شوێنی خۆیدا:'],
  genCentre: ['مركز التكلفة: {name}', 'Cost centre: {name}', 'ناوەندی تێچوو: {name}'],
  genEdit: ['تعديل', 'Edit', 'دەستکاری'],
  genSave: ['حفظ التعديل', 'Save the change', 'گۆڕانکارییەکە پاشەکەوت بکە'],
  genCancel: ['تراجع', 'Cancel', 'پاشگەزبوونەوە'],
  genEditedElsewhere: ['يُعدَّل من مكانه', 'Edited where it counts', 'لە شوێنی خۆیەوە دەستکاری دەکرێت'],
  genTruncated: ['تُعرض أحدث {n} قيد؛ المجاميع للفترة كلها.', 'The latest {n} entries are listed; the totals are the whole period’s.', 'نوێترین {n} تۆمار پیشان دەدرێن؛ کۆکان هی هەموو ماوەکەن.'],
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

  // The figure drawer's «المصاريف العامة» line.
  drawerEntries: ['قيود المصاريف العامة في الفترة', 'The period’s general expense entries', 'تۆمارەکانی خەرجیی گشتی لەم ماوەیەدا'],
  drawerEntriesNote: ['القيود للفترة كلها ({total})؛ يحمل كل عمود حصته منها بنسبة إيراده.', 'The entries are the whole period’s ({total}); each column carries its share of them by its revenue.', 'تۆمارەکان هی هەموو ماوەکەن ({total})؛ هەر ستوونێک بەپێی داهاتەکەی بەشی خۆی لێیان هەڵدەگرێت.'],
} as const satisfies Record<string, Tri>;
export type CsKey = keyof typeof CS;

type Loc = (ar: string, en: string, ckb?: string) => string;
/** One string in the reader's language, with {placeholders} filled. */
export function cs(loc: Loc, key: CsKey, vars: Record<string, string | number> = {}): string {
  const [ar, en, ckb] = CS[key];
  return loc(ar, en, ckb).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

/**
 * A COUNT WITH ITS NOUN, AS EACH LANGUAGE SAYS IT (the mockup's «19 بندًا», «30 قطعة»). Arabic agrees the noun with the
 * number — one, two, three to ten, eleven to ninety-nine, and the rest (the CLDR plural categories, `Intl.PluralRules`);
 * English has one and many; Sorani keeps the noun as it is after any number.
 */
type Counted = { readonly ar: readonly [one: string, two: string, few: string, many: string, other: string]; readonly en: readonly [one: string, other: string]; readonly ckb: string };
export const COUNTED = {
  lines: { ar: ['بند واحد', 'بندان', '{n} بنود', '{n} بندًا', '{n} بند'], en: ['1 line', '{n} lines'], ckb: '{n} بڕگە' },
  pieces: { ar: ['قطعة واحدة', 'قطعتان', '{n} قطع', '{n} قطعة', '{n} قطعة'], en: ['1 piece', '{n} pieces'], ckb: '{n} پارچە' },
  orders: { ar: ['طلب واحد', 'طلبان', '{n} طلبات', '{n} طلبًا', '{n} طلب'], en: ['1 order', '{n} orders'], ckb: '{n} داواکاری' },
  missingHead: { ar: ['بند واحد بلا تكلفة مؤكدة', 'بندان بلا تكلفة مؤكدة', '{n} بنود بلا تكلفة مؤكدة', '{n} بندًا بلا تكلفة مؤكدة', '{n} بند بلا تكلفة مؤكدة'],
    en: ['1 line without a confirmed cost', '{n} lines without a confirmed cost'], ckb: '{n} بڕگە بێ تێچووی دڵنیاکراو' },
} as const satisfies Record<string, Counted>;
const AR_FORM: Record<string, number> = { one: 0, two: 1, few: 2, many: 3 };
let arRules: Intl.PluralRules | null = null;
/** `n` with its noun in `lang`; the number in Latin digits with thousands separators. */
export function counted(lang: string, key: keyof typeof COUNTED, n: number): string {
  const entry: Counted = COUNTED[key], num = n.toLocaleString('en-US');
  const text = lang === 'ckb' ? entry.ckb : lang === 'en' ? entry.en[n === 1 ? 0 : 1] : entry.ar[AR_FORM[(arRules ??= new Intl.PluralRules('ar')).select(n)] ?? 4];
  return text.replace('{n}', num);
}
