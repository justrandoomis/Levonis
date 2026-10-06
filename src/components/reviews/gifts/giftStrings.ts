/**
 * THE WORDS OF /gifts — Arabic, English and written Sorani (docs/REVIEWS_GIFTS.md §8 C3, §9).
 *
 * One flat table per language with the SAME keys (the `en` and `ckb` tables
 * are typed against the Arabic one, so a missing key does not compile) and
 * `{hole}` placeholders that are identical in the three languages. The
 * sentences the plan fixes («تم اعتماد مراجعتك للحصول على هدية», «استرداد
 * الهدية», «أضف الهدية إلى السلة» …) are copied from §9 verbatim, in all three
 * columns. The Sorani is written, never the Arabic pasted across (rule D6);
 * tests/giftStringsUi.test.ts holds every row to that.
 *
 * The store is «Levonis» in Latin letters in every language. Numerals are
 * Latin, like every other number on the order screens.
 *
 * Refusal CODES are not here: their sentences live in src/lib/refusalStrings.ts,
 * which /gifts loads on the first refusal only.
 */

export type GiftLang = 'ar' | 'en' | 'ckb';

export function giftLang(lang: string): GiftLang {
  return lang === 'en' || lang === 'ckb' ? lang : 'ar';
}

const ar = {
  title: 'هداياي',
  intro: 'هدايا مراجعات الطابعات تظهر هنا.',
  refresh: 'تحديث',
  loading: 'جارٍ تحميل هداياك…',
  loadError: 'تعذّر تحميل الهدايا.',
  retry: 'إعادة المحاولة',
  emptyTitle: 'لا توجد هدايا بعد',
  emptyBody: 'عندما يعتمد فريق Levonis مراجعتك لطابعتك للحصول على هدية، تظهر هنا.',
  emptyAction: 'طلباتي',
  printerGiftFor: 'هدية مراجعتك لهذه الطابعة',
  levelChip: 'المستوى {level}',

  statePending: 'قيد المراجعة',
  stateAwaitingCode: 'بانتظار الكود',
  stateLocked: 'الكود موقوف',
  stateChooseItem: 'اختر هديتك',
  stateReady: 'جاهزة للطلب',
  stateInCart: 'في السلة',
  stateOrdered: 'تم الطلب',
  stateDelivered: 'تم التسليم',
  stateCancelled: 'ملغاة',
  stateLegacy: 'هدية سابقة',

  pendingTitle: 'مراجعتك قيد اعتماد الهدية',
  pendingBody: 'يراجع فريق Levonis مراجعتك الآن. إن اعتُمدت ستصلك رسالة بكود من 6 أرقام لتُدخله هنا.',
  sentOn: 'أُرسلت في {date}',
  revisionTitle: 'طلب فريق Levonis تعديلًا على مراجعتك',
  revisionBody: 'عدّل مراجعتك من صفحة طلباتك، وستبقى هنا حتى يُبتّ فيها.',
  stateRevision: 'بانتظار تعديلك',

  approvedTitle: 'تم اعتماد مراجعتك للحصول على هدية',
  codePrompt: 'أدخل الكود المكوّن من 6 أرقام',
  codeHint: 'أرسل لك فريق Levonis هذا الكود. لا تشاركه مع أحد.',
  codeGroupLabel: 'كود الهدية (6 أرقام)',
  redeem: 'استرداد الهدية',
  redeeming: 'جارٍ التحقق من الكود…',
  tooManyTries: 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.',
  networkError: 'تعذّر الاتصال. تحقّق من الإنترنت وحاول مرة أخرى.',
  actionFailed: 'تعذّر إتمام العملية. حاول مرة أخرى.',

  lockedTitle: 'أُوقف هذا الكود',
  lockedBody: 'أُدخل كود خاطئ عدة مرات فأُوقف لحماية هديتك. تواصل مع الدعم ليُصدر لك كودًا جديدًا.',
  contactSupport: 'تواصل مع الدعم',

  chooseTitle: 'تم استرداد الهدية — اختر هديتك',
  chooseHint: 'اختر منتجًا واحدًا من هدايا هذا المستوى.',
  chooseGroup: 'اختر {name}',
  optionLabel: 'الخيار',
  colorLabel: 'اللون',
  confirmChoice: 'تأكيد الاختيار',
  confirming: 'جارٍ الحفظ…',
  pickFirst: 'اختر كل الخيارات المطلوبة أولًا.',
  choicesUnavailable: 'خيارات هذه الهدية غير متاحة حاليًا. تواصل مع الدعم.',
  changeChoice: 'تغيير الاختيار',
  cancel: 'إلغاء',

  readyTitle: 'تم استرداد الهدية — الهدية جاهزة للطلب',
  saleType: 'نوع البيع',
  saleDirect: 'بيع مباشر',
  salePreorder: 'طلب مسبق',
  level: 'المستوى',
  fixedChoice: 'هذه الهدية محددة ولا يمكن تغييرها.',
  freeNote: 'الهدية مجانية (0 د.ع)، وتُحسب أجرة التوصيل على الطلب كالمعتاد.',
  addToCart: 'أضف الهدية إلى السلة',
  adding: 'جارٍ الإضافة…',
  added: 'أُضيفت الهدية إلى سلتك.',
  notOrderableNow: 'لا يمكن طلب هذه الهدية الآن.',

  inCartTitle: 'الهدية موجودة في السلة',
  inCartBody: 'أكمل الطلب من السلة. إن حذفتها من السلة تعود إلى هنا جاهزة للطلب.',
  goToCart: 'الذهاب إلى السلة',

  orderedTitle: 'تم استرداد الهدية وطلبها',
  orderNumber: 'رقم الطلب',
  orderStatus: 'حالة الطلب',
  viewOrder: 'عرض الطلب',
  orderedOn: 'طُلبت في {date}',

  deliveredTitle: 'تم تسليم الهدية',
  deliveredOn: 'سُلّمت في {date}',

  cancelledTitle: 'أُلغيت هذه الهدية',
  cancelledBody: 'إن كان لديك سؤال عنها، تواصل مع الدعم.',

  legacyTitle: 'هدية من برنامج الهدايا السابق',
  legacyBody: 'مُنحت هذه الهدية قبل تحديث برنامج الهدايا، ويتابعها فريق Levonis كما هي.',
  legacyContents: 'محتوى الهدية',
  legacyAvailable: 'سيتواصل معك فريق Levonis بخصوص هذه الهدية.',
  legacySelected: 'قيد التجهيز',
  legacyFulfilled: 'سُلّمت',

  sellerConflictTitle: 'سلتك فيها منتجات من متجر آخر',
  sellerConflictBody: 'لإضافة الهدية يجب إفراغ السلة الحالية أولًا.',
  replaceCart: 'إفراغ السلة وإضافة الهدية',
};

export type GiftStringKey = keyof typeof ar;

const en: Record<GiftStringKey, string> = {
  title: 'My gifts',
  intro: 'Your printer review gifts appear here.',
  refresh: 'Refresh',
  loading: 'Loading your gifts…',
  loadError: 'Could not load your gifts.',
  retry: 'Try again',
  emptyTitle: 'No gifts yet',
  emptyBody: 'When the Levonis team approves your printer review for a gift, it appears here.',
  emptyAction: 'My orders',
  printerGiftFor: 'A gift for your review of this printer',
  levelChip: 'Level {level}',

  statePending: 'Under review',
  stateAwaitingCode: 'Awaiting code',
  stateLocked: 'Code locked',
  stateChooseItem: 'Choose your gift',
  stateReady: 'Ready to order',
  stateInCart: 'In your cart',
  stateOrdered: 'Ordered',
  stateDelivered: 'Delivered',
  stateCancelled: 'Cancelled',
  stateLegacy: 'Earlier gift',

  pendingTitle: 'Your review is being considered for a gift',
  pendingBody: 'The Levonis team is reviewing it now. If it is approved, you will receive a 6-digit code to enter here.',
  sentOn: 'Sent on {date}',
  revisionTitle: 'The Levonis team asked for a change to your review',
  revisionBody: 'Edit your review from your orders page; it stays here until it is decided.',
  stateRevision: 'Awaiting your edit',

  approvedTitle: 'Your review was approved for a gift',
  codePrompt: 'Enter the 6-digit code',
  codeHint: 'The Levonis team sent you this code. Do not share it with anyone.',
  codeGroupLabel: 'Gift code (6 digits)',
  redeem: 'Redeem gift',
  redeeming: 'Checking the code…',
  tooManyTries: 'Too many attempts. Wait a little, then try again.',
  networkError: 'Could not connect. Check your internet and try again.',
  actionFailed: 'That did not go through. Please try again.',

  lockedTitle: 'This code is locked',
  lockedBody: 'A wrong code was entered too many times, so it was locked to protect your gift. Contact support to get a new code.',
  contactSupport: 'Contact support',

  chooseTitle: 'Gift redeemed — choose your gift',
  chooseHint: 'Pick one product from this level’s gifts.',
  chooseGroup: 'Choose {name}',
  optionLabel: 'Option',
  colorLabel: 'Colour',
  confirmChoice: 'Confirm choice',
  confirming: 'Saving…',
  pickFirst: 'Choose every required option first.',
  choicesUnavailable: 'This gift’s choices are not available right now. Contact support.',
  changeChoice: 'Change choice',
  cancel: 'Cancel',

  readyTitle: 'Gift redeemed — ready to order',
  saleType: 'Sale type',
  saleDirect: 'Direct sale',
  salePreorder: 'Pre-order',
  level: 'Level',
  fixedChoice: 'This gift is fixed and cannot be changed.',
  freeNote: 'The gift is free (0 IQD); delivery is charged on the order as usual.',
  addToCart: 'Add the gift to cart',
  adding: 'Adding…',
  added: 'The gift was added to your cart.',
  notOrderableNow: 'This gift cannot be ordered right now.',

  inCartTitle: 'The gift is in your cart',
  inCartBody: 'Complete the order from your cart. If you remove it from the cart, it comes back here ready to order.',
  goToCart: 'Go to cart',

  orderedTitle: 'Gift redeemed and ordered',
  orderNumber: 'Order number',
  orderStatus: 'Order status',
  viewOrder: 'View order',
  orderedOn: 'Ordered on {date}',

  deliveredTitle: 'Gift delivered',
  deliveredOn: 'Delivered on {date}',

  cancelledTitle: 'This gift was cancelled',
  cancelledBody: 'If you have a question about it, contact support.',

  legacyTitle: 'A gift from the earlier gift program',
  legacyBody: 'This gift was granted before the gift program changed, and the Levonis team handles it as it was.',
  legacyContents: 'Gift contents',
  legacyAvailable: 'The Levonis team will contact you about this gift.',
  legacySelected: 'Being prepared',
  legacyFulfilled: 'Delivered',

  sellerConflictTitle: 'Your cart holds another store’s items',
  sellerConflictBody: 'To add the gift, your current cart must be emptied first.',
  replaceCart: 'Empty the cart and add the gift',
};

const ckb: Record<GiftStringKey, string> = {
  title: 'دیارییەکانم',
  intro: 'دیارییەکانی هەڵسەنگاندنی چاپکەر لێرە دەردەکەون.',
  refresh: 'نوێکردنەوە',
  loading: 'دیارییەکانت بار دەکرێن…',
  loadError: 'دیارییەکان بار نەبوون.',
  retry: 'دووبارە هەوڵ بدەرەوە',
  emptyTitle: 'هێشتا هیچ دیارییەکت نییە',
  emptyBody: 'کاتێک تیمی Levonis هەڵسەنگاندنی چاپکەرەکەت بۆ دیاری پەسەند دەکات، لێرە دەردەکەوێت.',
  emptyAction: 'داواکارییەکانم',
  printerGiftFor: 'دیاری بۆ هەڵسەنگاندنەکەت لەسەر ئەم چاپکەرە',
  levelChip: 'ئاستی {level}',

  statePending: 'لە پێداچوونەوەدایە',
  stateAwaitingCode: 'چاوەڕێی کۆد',
  stateLocked: 'کۆدەکە ڕاگیراوە',
  stateChooseItem: 'دیارییەکەت هەڵبژێرە',
  stateReady: 'ئامادەیە بۆ داواکردن',
  stateInCart: 'لە سەبەتەکەدایە',
  stateOrdered: 'داواکراوە',
  stateDelivered: 'گەیەنراوە',
  stateCancelled: 'هەڵوەشێنراوەتەوە',
  stateLegacy: 'دیاریی پێشوو',

  pendingTitle: 'هەڵسەنگاندنەکەت لە ژێر پێداچوونەوەدایە بۆ دیاری',
  pendingBody: 'تیمی Levonis ئێستا هەڵسەنگاندنەکەت دەپشکنێت. ئەگەر پەسەند کرا، کۆدێکی 6 ژمارەیی وەردەگریت بۆ ئەوەی لێرە بینووسیت.',
  sentOn: 'نێردرا لە {date}',
  revisionTitle: 'تیمی Levonis داوای گۆڕانکاری لە هەڵسەنگاندنەکەت کردووە',
  revisionBody: 'هەڵسەنگاندنەکەت لە پەڕەی داواکارییەکانتەوە دەستکاری بکە؛ تا بڕیاری لەسەر دەدرێت لێرە دەمێنێتەوە.',
  stateRevision: 'چاوەڕێی دەستکاریی تۆیە',

  approvedTitle: 'هەڵسەنگاندنەکەت بۆ وەرگرتنی دیاری پەسەند کرا',
  codePrompt: 'کۆدە 6 ژمارەییەکە بنووسە',
  codeHint: 'تیمی Levonis ئەم کۆدەی بۆت ناردووە. لەگەڵ کەس بەشی مەکە.',
  codeGroupLabel: 'کۆدی دیاری (6 ژمارە)',
  redeem: 'وەرگرتنەوەی دیاری',
  redeeming: 'پشکنینی کۆدەکە…',
  tooManyTries: 'هەوڵی زۆرت دا. کەمێک چاوەڕێ بکە و دووبارە هەوڵ بدەرەوە.',
  networkError: 'پەیوەندی نەکرا. ئینتەرنێتەکەت بپشکنە و دووبارە هەوڵ بدەرەوە.',
  actionFailed: 'کردارەکە تەواو نەبوو. دووبارە هەوڵ بدەرەوە.',

  lockedTitle: 'ئەم کۆدە ڕاگیرا',
  lockedBody: 'کۆدی هەڵە چەند جارێک نووسرا، بۆیە بۆ پاراستنی دیارییەکەت ڕاگیرا. پەیوەندی بە پشتگیرییەوە بکە بۆ وەرگرتنی کۆدێکی نوێ.',
  contactSupport: 'پەیوەندی بە پشتگیرییەوە بکە',

  chooseTitle: 'دیارییەکە وەرگیرایەوە — دیارییەکەت هەڵبژێرە',
  chooseHint: 'یەک بەرهەم لە دیارییەکانی ئەم ئاستە هەڵبژێرە.',
  chooseGroup: '{name} هەڵبژێرە',
  optionLabel: 'هەڵبژاردە',
  colorLabel: 'ڕەنگ',
  confirmChoice: 'پشتڕاستکردنەوەی هەڵبژاردن',
  confirming: 'پاشەکەوت دەکرێت…',
  pickFirst: 'سەرەتا هەموو هەڵبژاردنە پێویستەکان دیاری بکە.',
  choicesUnavailable: 'هەڵبژاردنەکانی ئەم دیارییە ئێستا بەردەست نین. پەیوەندی بە پشتگیرییەوە بکە.',
  changeChoice: 'گۆڕینی هەڵبژاردن',
  cancel: 'پاشگەزبوونەوە',

  readyTitle: 'دیارییەکە وەرگیرایەوە — ئامادەیە بۆ داواکردن',
  saleType: 'جۆری فرۆشتن',
  saleDirect: 'فرۆشتنی ڕاستەوخۆ',
  salePreorder: 'پێش-داواکاری',
  level: 'ئاست',
  fixedChoice: 'ئەم دیارییە دیاریکراوە و ناگۆڕدرێت.',
  freeNote: 'دیارییەکە بێبەرامبەرە (0 د.ع)، و تێچووی گەیاندن وەک هەمیشە لەسەر داواکارییەکە دەژمێردرێت.',
  addToCart: 'دیارییەکە زیاد بکە بۆ سەبەتە',
  adding: 'زیاد دەکرێت…',
  added: 'دیارییەکە زیادکرا بۆ سەبەتەکەت.',
  notOrderableNow: 'ئێستا ناتوانرێت ئەم دیارییە داوا بکرێت.',

  inCartTitle: 'دیارییەکە لە سەبەتەکەدایە',
  inCartBody: 'داواکارییەکە لە سەبەتەکەوە تەواو بکە. ئەگەر لە سەبەتەکە لای ببەیت، دیارییەکە دەگەڕێتەوە ئێرە و ئامادە دەبێت بۆ داواکردن.',
  goToCart: 'بڕۆ بۆ سەبەتە',

  orderedTitle: 'دیارییەکە وەرگیرایەوە و داواکرا',
  orderNumber: 'ژمارەی داواکاری',
  orderStatus: 'دۆخی داواکاری',
  viewOrder: 'بینینی داواکاری',
  orderedOn: 'داواکرا لە {date}',

  deliveredTitle: 'دیارییەکە گەیەنرا',
  deliveredOn: 'گەیەنرا لە {date}',

  cancelledTitle: 'ئەم دیارییە هەڵوەشێنرایەوە',
  cancelledBody: 'ئەگەر پرسیارێکت دەربارەی هەیە، پەیوەندی بە پشتگیرییەوە بکە.',

  legacyTitle: 'دیارییەک لە بەرنامەی پێشووی دیاری',
  legacyBody: 'ئەم دیارییە پێش نوێکردنەوەی بەرنامەی دیاری بەخشرا، و تیمی Levonis وەک خۆی بەدواداچوونی بۆ دەکات.',
  legacyContents: 'ناوەڕۆکی دیاری',
  legacyAvailable: 'تیمی Levonis دەربارەی ئەم دیارییە پەیوەندیت پێوە دەکات.',
  legacySelected: 'ئامادە دەکرێت',
  legacyFulfilled: 'گەیەنرا',

  sellerConflictTitle: 'سەبەتەکەت بەرهەمی فرۆشگایەکی تری تێدایە',
  sellerConflictBody: 'بۆ زیادکردنی دیارییەکە، پێویستە سەرەتا سەبەتەکەت بەتاڵ بکرێتەوە.',
  replaceCart: 'سەبەتەکە بەتاڵ بکەرەوە و دیارییەکە زیاد بکە',
};

export const GIFT_STRINGS: Readonly<Record<GiftLang, Readonly<Record<GiftStringKey, string>>>> = { ar, en, ckb };

/** A sentence, with its `{hole}`s filled. An unfilled hole stays visible rather than becoming «undefined». */
export function giftText(lang: GiftLang, key: GiftStringKey, vars?: Record<string, string | number>): string {
  const raw = GIFT_STRINGS[lang][key] ?? GIFT_STRINGS.ar[key];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
