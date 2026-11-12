/**
 * «المال والأرباح» → المحاسبة → «أموال لدى شركة التوصيل» — THE WORDS OF THE COURIER'S MONEY (the owner's brief, 2026-11-12,
 * part 3; DECISIONS row 332; worker/lib/courierCollections.ts). One table in Arabic, English and Sorani: a key missing a
 * language does not compile, and tests/courierMoneyPage.test.ts holds the Sorani rules of DECISIONS row 183 — the Sorani
 * slot is neither the Arabic nor the English pasted across, has a Sorani letter and no Arabic-only one, and its placeholders
 * agree. Never an amount here: the page shows the server's money beside the words. Placeholders are {name}.
 */
type Tri = readonly [ar: string, en: string, ckb: string];
type Loc = (ar: string, en: string, ckb?: string) => string;

export const CS = {
  title: ['أموال لدى شركة التوصيل', 'Money with the courier', 'پارە لای کۆمپانیای گەیاندن'],
  sub: ['ما جمعه الزعيم من الزبائن ولم يحوّله بعد، والتحويلات التي وصلت ومطابقتها مع كشفه', 'What Al-Zaeem collected from customers and has not transferred yet, and the transfers that arrived and their check against its statement', 'ئەوەی زەعیم لە کڕیاران وەریگرتووە و هێشتا نەیگواستووەتەوە، و ئەو گواستنەوانەی گەیشتوون و بەراوردکردنیان لەگەڵ کەشفەکەی'],
  firstTime: ['قبل أول تحويل: حدّد كل طرد دفعه الزعيم لك من قبل — كل الطرود عدا التي لم يدفعها بعد — ثم اضغط «سجّل كرصيد افتتاحي». يُسجَّل كل منها مدفوعًا بتاريخ اليوم وبأجرته المقدّرة، وتصبح حصص المستثمرين التي تنتظر تحصيله قابلة للسحب. ويبقى هذا الزر حتى يُسجَّل أول تحويل.', 'Before the first transfer: select every parcel Al-Zaeem has already paid you for — all of them except the ones still unpaid — then press «Record as opening balance». Each is recorded as paid today with its estimated fee, and investors’ shares waiting for that cash become withdrawable. The button stays until the first transfer is recorded.', 'پێش یەکەم گواستنەوە: هەموو ئەو پاکەتانە دیاری بکە کە زەعیم پێشتر پارەکەیانی داویتێ — هەموویان جگە لەوانەی هێشتا نەدراون — پاشان «وەک باڵانسی سەرەتایی تۆمار بکە» دابگرە. هەریەکەیان وەک دراو بە ڕێکەوتی ئەمڕۆ و بە کرێی خەمڵێنراوی تۆمار دەکرێت، و بەشی وەبەرهێنەران کە چاوەڕێی ئەو پارەیەن دەبنە شیاوی ڕاکێشان. ئەم دوگمەیە دەمێنێت تا یەکەم گواستنەوە تۆمار دەکرێت.'],
  howTo: ['عند وصول تحويل: حدّد طروده، واكتب المبلغ ورقم الكشف، ثم «سجّل التحويل». وبعد مطابقته مع كشف الزعيم اضغط «تمت المطابقة».', 'When a transfer arrives: select its parcels, enter the amount and the statement number, then «Record the transfer». After checking it against Al-Zaeem’s statement, press «Mark checked».', 'کاتێک گواستنەوەیەک گەیشت: پاکەتەکانی دیاری بکە، بڕەکە و ژمارەی کەشفەکە بنووسە، پاشان «گواستنەوەکە تۆمار بکە». دوای بەراوردکردنی لەگەڵ کەشفی زەعیم «بەراوردکرا» دابگرە.'],
  withCourier: ['لدى الزعيم', 'With Al-Zaeem', 'لای زەعیم'],
  withCourierHint: ['{n} طرد · أقدمها منذ {days} يومًا', 'Parcels: {n} · the oldest {days} days ago', '{n} پاکەت · کۆنترینیان {days} ڕۆژ لەمەوبەر'],
  afterFees: ['بعد الأجور المقدّرة', 'After estimated fees', 'دوای کرێی خەمڵێنراو'],
  afterFeesHint: ['الأجرة المقدّرة: أجرة التوصيل المعروضة للطرد، وتُصحَّح عند تسجيل التحويل', 'Estimated fee: the delivery fee quoted for the parcel, corrected when you record the transfer', 'کرێی خەمڵێنراو: کرێی گەیاندنی پاکەتەکە، لە کاتی تۆمارکردنی گواستنەوەدا ڕاست دەکرێتەوە'],
  unchecked: ['وصل ولم يُطابَق', 'Arrived, not checked', 'گەیشتووە و بەراورد نەکراوە'],
  uncheckedHint: ['{n} تحويل', 'Transfers: {n}', '{n} گواستنەوە'],
  pendingTitle: ['الطرود لدى الزعيم', 'Parcels with Al-Zaeem', 'پاکەتەکانی لای زەعیم'],
  nonePending: ['لا نقد لدى الزعيم: دُفع نقد كل الطرود المسلَّمة.', 'No cash with Al-Zaeem: every delivered parcel has been paid.', 'هیچ پارەیەک لای زەعیم نییە: پارەی هەموو پاکەتە گەیەنراوەکان دراوە.'],
  colOrder: ['الطلب', 'Order', 'داواکاری'],
  colCustomer: ['الزبون', 'Customer', 'کڕیار'],
  colGovernorate: ['المحافظة', 'Governorate', 'پارێزگا'],
  colDelivered: ['سُلّم', 'Delivered', 'گەیەنرا'],
  colDays: ['الأيام', 'Days', 'ڕۆژەکان'],
  colCash: ['النقد', 'Cash', 'پارەی نەختینە'],
  colFee: ['الأجرة', 'Fee', 'کرێ'],
  colNet: ['الصافي', 'Net', 'پوخت'],
  selectAll: ['تحديد الكل', 'Select all', 'هەموو دیاری بکە'],
  selectParcel: ['تحديد الطلب {id}', 'Select order {id}', 'داواکاری {id} دیاری بکە'],
  selected: ['المحدَّد: {n} طرد', 'Parcels selected: {n}', 'دیاریکراو: {n} پاکەت'],
  expected: ['نقد المحدَّد بعد الأجور', 'Selected cash after fees', 'پارەی دیاریکراو دوای کرێ'],
  amount: ['المبلغ الذي وصل', 'Amount that arrived', 'ئەو بڕەی گەیشت'],
  day: ['يوم الوصول', 'Day it arrived', 'ڕۆژی گەیشتن'],
  reference: ['رقم الكشف أو الوصل', 'Statement or receipt number', 'ژمارەی کەشف یان پسوولە'],
  category: ['تصنيف أجور التوصيل', 'Courier fee category', 'پۆلی کرێی گەیاندن'],
  categoryPick: ['اختر تصنيفًا', 'Choose a category', 'پۆلێک هەڵبژێرە'],
  note: ['ملاحظة', 'Note', 'تێبینی'],
  difference: ['الفرق', 'Difference', 'جیاوازی'],
  short: ['وصل أقل مما يُظهره الموقع لهذه الطرود. يجب أن يساوي ما يصل من شركة التوصيل ما في الموقع أو يزيد عليه: صحّح نقد الطرد أو أجرته من كشف الشركة.', 'Less arrived than the site shows for these parcels. What a delivery company pays must equal the site’s figure or exceed it: correct a parcel’s cash or fee from the company’s statement.', 'کەمتر لەوەی ماڵپەڕەکە بۆ ئەم پاکەتانە نیشانی دەدات گەیشت. ئەوەی کۆمپانیای گەیاندن دەیدات دەبێت یەکسان بێت بە ژمارەی ماڵپەڕ یان زیاتر بێت: پارەی پاکەت یان کرێکەی لە کەشفی کۆمپانیاکەوە ڕاست بکەرەوە.'],
  surplus: ['وصل أكثر مما يُظهره الموقع: أخذت الشركة أجورًا أقل من المقدّرة. يُسجَّل الفرق تخفيضًا لأجور التوصيل.', 'More arrived than the site shows: the company kept less than the estimated fees. The difference is recorded as lower courier fees.', 'زیاتر لەوەی ماڵپەڕەکە نیشانی دەدات گەیشت: کۆمپانیاکە کرێی کەمتری لە خەمڵێنراو بردووە. جیاوازییەکە وەک کەمبوونەوەی کرێی گەیاندن تۆمار دەکرێت.'],
  record: ['سجّل التحويل', 'Record the transfer', 'گواستنەوەکە تۆمار بکە'],
  recordOpening: ['سجّل كرصيد افتتاحي', 'Record as opening balance', 'وەک باڵانسی سەرەتایی تۆمار بکە'],
  tooMany: ['التحويل الواحد حتى {max} طردًا؛ سجّله على دفعات.', 'One transfer holds up to {max} parcels; record it in parts.', 'هەر گواستنەوەیەک تا {max} پاکەت؛ بە چەند جار تۆماری بکە.'],
  recorded: ['سُجّل: {n} طرد. تُحدَّث أرباح الطلبات وحصص المستثمرين خلال دقائق.', 'Parcels recorded: {n}. Order profits and investor shares update within minutes.', 'تۆمارکرا: {n} پاکەت. قازانجی داواکارییەکان و بەشی وەبەرهێنەران لە ماوەی چەند خولەکێکدا نوێ دەبنەوە.'],
  openingProgress: ['يُسجَّل الرصيد الافتتاحي: {done} من {total}…', 'Recording the opening balance: {done} of {total}…', 'باڵانسی سەرەتایی تۆمار دەکرێت: {done} لە {total}…'],
  failed: ['تعذّر تحميل أموال شركة التوصيل.', 'Could not load the courier’s money.', 'بارکردنی پارەی کۆمپانیای گەیاندن سەرنەکەوت.'],
  saveFailed: ['تعذّر الحفظ.', 'Could not save.', 'پاشەکەوتکردن سەرنەکەوت.'],
  transfersTitle: ['التحويلات', 'Transfers', 'گواستنەوەکان'],
  noTransfers: ['لم يُسجَّل أي تحويل بعد.', 'No transfer recorded yet.', 'هێشتا هیچ گواستنەوەیەک تۆمار نەکراوە.'],
  colDay: ['اليوم', 'Day', 'ڕۆژ'],
  colReference: ['رقم الكشف', 'Statement no.', 'ژمارەی کەشف'],
  colParcels: ['الطرود', 'Parcels', 'پاکەتەکان'],
  colFees: ['الأجور', 'Fees', 'کرێکان'],
  colArrived: ['وصل', 'Arrived', 'گەیشت'],
  colState: ['الحالة', 'State', 'دۆخ'],
  kindOpening: ['رصيد افتتاحي', 'Opening balance', 'باڵانسی سەرەتایی'],
  stateReceived: ['وصل', 'Received', 'گەیشتووە'],
  stateReconciled: ['مُطابَق', 'Checked', 'بەراوردکراو'],
  reconcile: ['تمت المطابقة', 'Mark checked', 'بەراوردکرا'],
  reconcileConfirm: ['تأكيد المطابقة', 'Confirm the check', 'بەراوردکردن پشتڕاست بکەرەوە'],
  reconcileNote: ['ملاحظة المطابقة (اختيارية)', 'Note on the check (optional)', 'تێبینیی بەراوردکردن (ئارەزوومەندانە)'],
  reconciledBy: ['طابقه {name} يوم {day}', 'Checked by {name} on {day}', '{name} لە {day} بەراوردی کرد'],
  showParcels: ['الطرود', 'Parcels', 'پاکەتەکان'],
  hideParcels: ['إخفاء', 'Hide', 'شاردنەوە'],
  cancel: ['إلغاء', 'Cancel', 'پاشگەزبوونەوە'],
} as const satisfies Record<string, Tri>;

export type CsKey = keyof typeof CS;

export function crs(loc: Loc, key: CsKey, vars: Record<string, string | number> = {}): string {
  const [ar, en, ckb] = CS[key];
  return loc(ar, en, ckb).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}
