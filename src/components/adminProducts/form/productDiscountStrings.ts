/**
 * «تخفيض السعر» — THE PRODUCT FORM'S DISCOUNT CARD, IN THREE LANGUAGES (docs/ux/PRODUCT-DISCOUNT.md §6.6).
 *
 * Every key exists in Arabic, English and Sorani, and the Sorani is its own (DECISIONS row 183):
 * tests/productDiscountCard.test.ts walks the table. Vocabulary: the discount here is «تخفيض /
 * داشکاندنی نرخ» — never «الخصم ($)» alone, which in section ٣ already names the PRE-ORDER discount
 * (v2Strings `discount`) — and the Sorani avoids «گواستنەوە» and «کاڵا» (tests/productFormV2.test.ts).
 */
export type DiscountLang = 'ar' | 'en' | 'ckb';

export interface DiscountStrings {
  title: string;
  intro: string;
  modeUsd: string;
  modePercent: string;
  scopeProduct: string;
  scopeModel: string;
  colModel: string;
  colBefore: string;
  colAfter: string;
  colSaving: string;
  allColours: string;
  preorder: (n: number) => string;
  emptyKeeps: string;
  noSale: string;
  notLower: string;
  belowFloor: string;
  belowCost: string;
  belowMinProfit: string;
  startsAt: string;
  endsAt: string;
  tz: string;
  active: string;
  rateNote: string;
  percentNote: string;
  otherSettings: (list: string) => string;
  membersOnly: (tiers: string) => string;
  perCustomer: (n: number) => string;
  totalLimit: (n: number) => string;
  otherMode: (amount: string) => string;
  draftNote: string;
  newProduct: string;
  notPublished: string;
  usdOwnerOnly: string;
  usdNotDirect: string;
  usdMixed: string;
  usdNotInstalled: string;
  suspended: string;
  suspendedSave: string;
  none: string;
  add: string;
  save: string;
  saving: string;
  saved: string;
  remove: string;
  removeTitle: string;
  removeBody: string;
  removed: string;
  cancel: string;
  openOffers: string;
  state: { upcoming: string; live: string; ended: string };
  endsIn: string;
  usdOne: string;
  percentLabel: string;
  previewing: string;
}

const AR: DiscountStrings = {
  title: 'تخفيض السعر',
  intro: 'السعر الحالي هو السعر قبل الخصم تلقائيًا — اكتب السعر بعد الخصم بالدولار أو نسبة الخصم.',
  modeUsd: 'سعر بعد الخصم ($)',
  modePercent: 'نسبة الخصم (٪)',
  scopeProduct: 'سعر واحد للمنتج كله',
  scopeModel: 'سعر لكل موديل',
  colModel: 'الموديل · اللون',
  colBefore: 'الآن (قبل الخصم)',
  colAfter: 'بعد الخصم',
  colSaving: 'التخفيض',
  allColours: 'كل الألوان',
  preorder: (n) => `الطلب المسبق (${n})`,
  emptyKeeps: 'اتركه فارغًا ليبقى هذا الموديل بسعره',
  noSale: 'بلا تخفيض',
  notLower: 'ليس أقل من السعر الحالي — لا يظهر خصم',
  belowFloor: 'يجعل السعر صفرًا أو أقل',
  belowCost: 'تحت التكلفة',
  belowMinProfit: 'تحت الحد الأدنى للربح',
  startsAt: 'يبدأ في (اختياري)',
  endsAt: 'ينتهي في (اختياري)',
  tz: 'بتوقيت بغداد',
  active: 'مفعّل',
  rateNote:
    'يُحوَّل الدولار إلى الدينار بسعر الصرف نفسه الذي سُعِّر به المنتج، ويُقرَّب لأعلى إلى ألف دينار؛ فإذا تغيّر سعر الصرف تغيّر السعران قبل الخصم وبعده معًا.',
  percentNote: 'تُحسب النسبة من السعر المنشور لكل موديل ولون، وتتبع سعر الصرف معه.',
  otherSettings: (list) => `إعدادات أخرى لهذا العرض من «العروض الخاصة»: ${list}`,
  membersOnly: (tiers) => `للمشتركين فقط: ${tiers}`,
  perCustomer: (n) => `حد ${n} لكل زبون`,
  totalLimit: (n) => `حد إجمالي ${n}`,
  otherMode: (amount) => `هذا المنتج عليه خصم بالدينار من «العروض الخاصة» (${amount}). الحفظ هنا يستبدل طريقة السعر فقط.`,
  draftNote: 'السعر «قبل» هو المنشور الآن. احفظ تغييرات الأسعار أعلاه لتظهر هنا.',
  newProduct: 'احفظ المنتج أولًا، ثم أضف التخفيض.',
  notPublished: 'انشر أسعار المنتج أولًا؛ يُحسب الخصم من السعر المنشور.',
  usdOwnerOnly: 'هذا المنتج مسعَّر من التكلفة، والسعر بعد الخصم بالدولار يضعه المالك. يمكنك استعمال نسبة الخصم.',
  usdNotDirect: 'هذا المنتج لا يُباع بيعًا مباشرًا، فلا يوجد سعر حالي واحد يُخفَّض منه. استعمل نسبة الخصم.',
  usdMixed: 'ألوان هذا المنتج بأسعار مختلفة، فلا يصلح لها سعر واحد بعد الخصم. استعمل نسبة الخصم.',
  usdNotInstalled: 'سعر الخصم بالدولار غير متاح بعد على هذه القاعدة. نسبة الخصم تعمل.',
  suspended: 'موقوف: أُنشئ قبل التسعير الجديد',
  suspendedSave: 'احفظ لتشغيله من جديد',
  none: 'لا يوجد تخفيض على هذا المنتج.',
  add: '+ إضافة تخفيض',
  save: 'حفظ التخفيض',
  saving: 'جارٍ الحفظ…',
  saved: 'حُفظ التخفيض.',
  remove: 'حذف التخفيض',
  removeTitle: 'حذف التخفيض؟',
  removeBody: 'يُحذف العرض من «العروض الخاصة» أيضًا، ومعه شرط الاشتراك والحدود إن وُجدت. ما بيع سابقًا لا يتغيّر.',
  removed: 'حُذف التخفيض.',
  cancel: 'إلغاء',
  openOffers: 'فتح في «العروض الخاصة»',
  state: { upcoming: 'لم يبدأ', live: 'يعمل الآن', ended: 'انتهى' },
  endsIn: 'ينتهي خلال',
  usdOne: 'السعر بعد الخصم ($)',
  percentLabel: 'نسبة الخصم',
  previewing: 'يُحسب…',
};

const EN: DiscountStrings = {
  title: 'Sale price',
  intro: 'The current price is the before price, automatically — enter the price after the discount in dollars, or a discount percent.',
  modeUsd: 'Price after discount ($)',
  modePercent: 'Discount percent (%)',
  scopeProduct: 'One price for the whole product',
  scopeModel: 'A price for each model',
  colModel: 'Model · colour',
  colBefore: 'Now (before)',
  colAfter: 'After',
  colSaving: 'Off',
  allColours: 'All colours',
  preorder: (n) => `Pre-order (${n})`,
  emptyKeeps: 'Leave empty to keep this model at its price',
  noSale: 'No sale',
  notLower: 'Not below the current price — no sale is shown',
  belowFloor: 'Brings the price to zero or less',
  belowCost: 'Below cost',
  belowMinProfit: 'Below the minimum profit',
  startsAt: 'Starts (optional)',
  endsAt: 'Ends (optional)',
  tz: 'Baghdad time',
  active: 'Active',
  rateNote:
    'Dollars convert to dinars at the same exchange rate the product is priced at, rounded up to the next 1,000 IQD; when the rate moves, the before and after prices move together.',
  percentNote: "The percent is taken off each model and colour's published price, and follows the exchange rate with it.",
  otherSettings: (list) => `More settings of this offer, from Special offers: ${list}`,
  membersOnly: (tiers) => `Members only: ${tiers}`,
  perCustomer: (n) => `Limit ${n} per customer`,
  totalLimit: (n) => `Total limit ${n}`,
  otherMode: (amount) => `This product has a dinar amount-off from Special offers (${amount}). Saving here replaces the price method only.`,
  draftNote: 'The before price is the one published now. Apply the price changes above to see them here.',
  newProduct: 'Save the product first, then add a sale.',
  notPublished: "Publish the product's prices first; the sale is taken from the published price.",
  usdOwnerOnly: 'This product is priced from cost; the owner sets a dollar price after the discount. You can use a discount percent.',
  usdNotDirect: 'This product is not sold direct, so there is no single current price to discount from. Use a discount percent.',
  usdMixed: "This product's colours have different prices, so one price after the discount cannot fit them. Use a discount percent.",
  usdNotInstalled: 'A dollar sale price is not available on this database yet. A discount percent works.',
  suspended: 'Paused: created before the new pricing',
  suspendedSave: 'Save to run it again',
  none: 'This product has no sale.',
  add: '+ Add a sale',
  save: 'Save sale',
  saving: 'Saving…',
  saved: 'Sale saved.',
  remove: 'Remove sale',
  removeTitle: 'Remove the sale?',
  removeBody: 'The offer is removed from Special offers too, with its membership gate and limits if any. Past orders do not change.',
  removed: 'Sale removed.',
  cancel: 'Cancel',
  openOffers: 'Open in Special offers',
  state: { upcoming: 'Not started', live: 'Live now', ended: 'Ended' },
  endsIn: 'Ends in',
  usdOne: 'Price after discount ($)',
  percentLabel: 'Discount percent',
  previewing: 'Working…',
};

const CKB: DiscountStrings = {
  title: 'داشکاندنی نرخ',
  intro: 'نرخی ئێستا خۆکارانە نرخی پێش داشکاندنە — نرخی دوای داشکاندن بە دۆلار بنووسە، یان ڕێژەی داشکاندن.',
  modeUsd: 'نرخی دوای داشکاندن ($)',
  modePercent: 'ڕێژەی داشکاندن (٪)',
  scopeProduct: 'یەک نرخ بۆ هەموو بەرهەمەکە',
  scopeModel: 'نرخێک بۆ هەر مۆدێلێک',
  colModel: 'مۆدێل · ڕەنگ',
  colBefore: 'ئێستا (پێش داشکاندن)',
  colAfter: 'دوای داشکاندن',
  colSaving: 'داشکاندن',
  allColours: 'هەموو ڕەنگەکان',
  preorder: (n) => `پێشداواکردن (${n})`,
  emptyKeeps: 'بەتاڵی بهێڵەوە تا ئەم مۆدێلە بە نرخی خۆی بمێنێتەوە',
  noSale: 'بێ داشکاندن',
  notLower: 'لە نرخی ئێستا کەمتر نییە — هیچ داشکاندنێک پیشان نادرێت',
  belowFloor: 'نرخەکە دەکاتە سفر یان کەمتر',
  belowCost: 'لە خوار تێچوو',
  belowMinProfit: 'لە خوار کەمترین قازانج',
  startsAt: 'دەست پێدەکات لە (ئارەزوومەندانە)',
  endsAt: 'کۆتایی دێت لە (ئارەزوومەندانە)',
  tz: 'بە کاتی بەغدا',
  active: 'چالاک',
  rateNote:
    'دۆلار بە هەمان نرخی ئاڵوگۆڕ کە بەرهەمەکەی پێ نرخ دانراوە دەکرێتە دینار و بۆ سەرەوە دەگەیەنرێتە هەزار دینار؛ کاتێک نرخی ئاڵوگۆڕ دەگۆڕێت، نرخی پێش و دوای داشکاندن پێکەوە دەگۆڕێن.',
  percentNote: 'ڕێژەکە لە نرخی بڵاوکراوەی هەر مۆدێل و ڕەنگێک دەبڕدرێت، و لەگەڵیدا شوێن نرخی ئاڵوگۆڕ دەکەوێت.',
  otherSettings: (list) => `ڕێکخستنی تری ئەم ئۆفەرە لە «ئۆفەرە تایبەتەکان»: ${list}`,
  membersOnly: (tiers) => `تەنها بۆ ئەندامان: ${tiers}`,
  perCustomer: (n) => `سنووری ${n} بۆ هەر کڕیارێک`,
  totalLimit: (n) => `سنووری گشتی ${n}`,
  otherMode: (amount) => `ئەم بەرهەمە داشکاندنێکی دیناری لە «ئۆفەرە تایبەتەکان»ـەوە هەیە (${amount}). پاشەکەوتکردن لێرە تەنها شێوازی نرخ دەگۆڕێت.`,
  draftNote: 'نرخی «پێش» ئەوەیە کە ئێستا بڵاوکراوەتەوە. گۆڕانکارییەکانی نرخ لە سەرەوە جێبەجێ بکە تا لێرە دەربکەون.',
  newProduct: 'سەرەتا بەرهەمەکە پاشەکەوت بکە، پاشان داشکاندن زیاد بکە.',
  notPublished: 'سەرەتا نرخەکانی بەرهەمەکە بڵاو بکەرەوە؛ داشکاندن لە نرخی بڵاوکراوە دەکرێت.',
  usdOwnerOnly: 'ئەم بەرهەمە لە تێچووەوە نرخ دانراوە، و نرخی دوای داشکاندن بە دۆلار خاوەنەکە دایدەنێت. دەتوانیت ڕێژەی داشکاندن بەکاربهێنیت.',
  usdNotDirect: 'ئەم بەرهەمە ڕاستەوخۆ نافرۆشرێت، بۆیە یەک نرخی ئێستا نییە بۆ داشکاندن. ڕێژەی داشکاندن بەکاربهێنە.',
  usdMixed: 'ڕەنگەکانی ئەم بەرهەمە نرخی جیاوازیان هەیە، بۆیە یەک نرخی دوای داشکاندن بۆیان ناگونجێت. ڕێژەی داشکاندن بەکاربهێنە.',
  usdNotInstalled: 'نرخی داشکاندن بە دۆلار هێشتا لەم بنکەدراوەیە بەردەست نییە. ڕێژەی داشکاندن کار دەکات.',
  suspended: 'ڕاگیراوە: پێش نرخدانانی نوێ دروستکراوە',
  suspendedSave: 'پاشەکەوتی بکە تا دووبارە کار بکات',
  none: 'ئەم بەرهەمە هیچ داشکاندنێکی نییە.',
  add: '+ زیادکردنی داشکاندن',
  save: 'پاشەکەوتکردنی داشکاندن',
  saving: 'پاشەکەوت دەکرێت…',
  saved: 'داشکاندنەکە پاشەکەوت کرا.',
  remove: 'لابردنی داشکاندن',
  removeTitle: 'داشکاندنەکە لاببرێت؟',
  removeBody: 'ئۆفەرەکە لە «ئۆفەرە تایبەتەکان»یش لادەبرێت، لەگەڵ مەرجی ئەندامێتی و سنوورەکانی ئەگەر هەبن. داواکارییە پێشووەکان ناگۆڕێن.',
  removed: 'داشکاندنەکە لابرا.',
  cancel: 'پاشگەزبوونەوە',
  openOffers: 'کردنەوە لە «ئۆفەرە تایبەتەکان»',
  state: { upcoming: 'دەستی پێنەکردووە', live: 'ئێستا کار دەکات', ended: 'کۆتایی هات' },
  endsIn: 'کۆتایی دێت لە ماوەی',
  usdOne: 'نرخی دوای داشکاندن ($)',
  percentLabel: 'ڕێژەی داشکاندن',
  previewing: 'هەژمار دەکرێت…',
};

export const DISCOUNT_STRINGS: Readonly<Record<DiscountLang, DiscountStrings>> = { ar: AR, en: EN, ckb: CKB };

export const discountStrings = (lang: DiscountLang): DiscountStrings => DISCOUNT_STRINGS[lang];
