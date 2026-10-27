/**
 * The words of Print Cloud's ACCOUNT section (src/cloud/pages/account): the
 * customer's own records — hours and their purchases, material, shipments,
 * sell-backs, every movement — and the settings.
 *
 * Every slot is written for this product in Arabic, English and Sorani; the
 * Sorani is never the Arabic (docs/DECISIONS.md row 183). No sentence here
 * carries a figure: every amount, date and count arrives through a
 * `{placeholder}` from the server's own answer (tests/printCloudUiAccount.test.ts).
 */
import type { Tri } from '../types';

/** The account page itself: the profile, the two balances and the menu. */
export const account = {
  title: { ar: 'حسابي', en: 'My account', ckb: 'هەژمارەکەم' },
  profile: { ar: 'ملفك في Levonis', en: 'Your Levonis profile', ckb: 'پرۆفایلەکەت لە Levonis' },
  noName: { ar: 'حساب Levonis', en: 'Levonis account', ckb: 'هەژماری Levonis' },
  editProfile: { ar: 'تعديل الملف في Levonis', en: 'Edit profile on Levonis', ckb: 'دەستکاریی پرۆفایل لە Levonis' },
  hoursCard: { ar: 'ساعات الطباعة', en: 'Printing hours', ckb: 'کاتژمێرەکانی چاپ' },
  acrossClasses: { ar: 'موزّعة على {n} من فئات الطابعات', en: 'Across {n} printer classes', ckb: 'لە {n} پۆلی چاپکەردا' },
  ofTotal: { ar: 'من {total}', en: 'of {total}', ckb: 'لە {total}' },
  hoursLeft: { ar: 'الساعات المتبقية من رصيدك', en: 'Hours left of your balance', ckb: 'ئەو کاتژمێرانەی لە باڵانسەکەت ماون' },
  noHours: { ar: 'لا ساعات بعد', en: 'No hours yet', ckb: 'هێشتا کاتژمێرت نییە' },
  filamentCard: { ar: 'خيوطي', en: 'My filament', ckb: 'فیلامێنتەکەم' },
  filamentLeft: { ar: 'المتبقي من خيوطك', en: 'Filament left', ckb: 'ئەو فیلامێنتەی ماوە' },
  noFilament: { ar: 'لا خيوط بعد', en: 'No filament yet', ckb: 'هێشتا فیلامێنتت نییە' },
  materialsCount: { ar: 'عدد المواد: {n}', en: 'Materials: {n}', ckb: 'ژمارەی کەرەستە: {n}' },
  runningLow: { ar: 'أوشكت على النفاد', en: 'Running low', ckb: 'خەریکە تەواو دەبێت' },
  shortcuts: { ar: 'اختصارات', en: 'Shortcuts', ckb: 'کورتەڕێکان' },
  groupRecords: { ar: 'طباعاتك ومشترياتك', en: 'Your prints and purchases', ckb: 'چاپ و کڕینەکانت' },
  groupMoves: { ar: 'الاستلام والبيع والمال', en: 'Pickup, sell-back and money', ckb: 'وەرگرتن، فرۆشتنەوە و پارە' },
  groupMore: { ar: 'الإعدادات والمساعدة', en: 'Settings and help', ckb: 'ڕێکخستن و یارمەتی' },
  myPrints: { ar: 'طباعاتي', en: 'My prints', ckb: 'چاپەکانم' },
  myPrintsSub: { ar: 'طباعاتك وقائمة الانتظار وسجلّها', en: 'Your prints, the queue and their history', ckb: 'چاپەکانت، ڕیزەکە و مێژووەکەیان' },
  orders: { ar: 'طلباتي', en: 'My orders', ckb: 'داواکارییەکانم' },
  ordersSub: { ar: 'مشترياتك ومدفوعاتها', en: 'Your purchases and their payments', ckb: 'کڕینەکانت و پارەدانەکانیان' },
  hoursSub: { ar: 'الرصيد لكل فئة طابعة، والصلاحية والحجوزات', en: 'Balance per printer class, expiry and holds', ckb: 'باڵانس بۆ هەر پۆلێکی چاپکەر، بەسەرچوون و گیراوەکان' },
  materials: { ar: 'الخيوط والمواد', en: 'Filament & materials', ckb: 'فیلامێنت و کەرەستەکان' },
  materialsSub: { ar: 'ما تملكه في الورشة', en: 'What you own at the workshop', ckb: 'ئەوەی لە کارگەدا هی تۆیە' },
  files: { ar: 'مكتبة الملفات', en: 'File library', ckb: 'کتێبخانەی فایلەکان' },
  filesSub: { ar: 'نماذجك وملفاتك المرفوعة', en: 'Your models and uploads', ckb: 'مۆدێل و فایلە بارکراوەکانت' },
  shipments: { ar: 'الاستلام والتوصيل', en: 'Shipments & pickup', ckb: 'ناردن و وەرگرتن' },
  shipmentsSub: {
    ar: 'استلم طباعاتك وموادك أو اطلب توصيلها',
    en: 'Collect your prints and material, or have them delivered',
    ckb: 'چاپ و کەرەستەکانت وەربگرە یان بۆت بنێردرێن',
  },
  buyback: { ar: 'بيع الخيوط للورشة', en: 'Sell back filament', ckb: 'فرۆشتنەوەی فیلامێنت' },
  buybackSub: { ar: 'الخيوط غير المستعملة، بنسبة تحددها الورشة', en: 'Unused filament, at the workshop’s rate', ckb: 'فیلامێنتی بەکارنەهاتوو، بە ڕێژەی کارگە' },
  transactions: { ar: 'الحركات', en: 'Transactions', ckb: 'مامەڵەکان' },
  transactionsSub: {
    ar: 'كل حركة لساعاتك وموادك وأموالك',
    en: 'Every movement of your hours, material and money',
    ckb: 'هەموو جووڵەیەکی کاتژمێر و کەرەستە و پارەکەت',
  },
  wallet: { ar: 'محفظة Levonis', en: 'Levonis wallet', ckb: 'جزدانی Levonis' },
  walletSub: { ar: 'رصيدك في Levonis، ويُشحن هناك', en: 'Your balance on Levonis — add funds there', ckb: 'باڵانسەکەت لە Levonis — لەوێ پارە زیاد بکە' },
  walletOff: { ar: 'الدفع من المحفظة متوقف حاليًا', en: 'Wallet payments are off right now', ckb: 'پارەدان لە جزدانەوە ئێستا ڕاگیراوە' },
  settings: { ar: 'الإعدادات', en: 'Settings', ckb: 'ڕێکخستنەکان' },
  settingsSub: { ar: 'اللغة والمظهر', en: 'Language and appearance', ckb: 'زمان و ڕووکار' },
  help: { ar: 'المساعدة والدعم', en: 'Help & support', ckb: 'یارمەتی و پشتگیری' },
  helpSub: { ar: 'تواصل مع دعم Levonis', en: 'Contact Levonis support', ckb: 'پەیوەندی بە پشتگیریی Levonis بکە' },
  opensLevonis: { ar: '(يفتح Levonis)', en: '(opens Levonis)', ckb: '(Levonis دەکاتەوە)' },
} satisfies Record<string, Tri>;

/** Words every account screen shares. */
export const sect = {
  loadMore: { ar: 'عرض المزيد', en: 'Load more', ckb: 'زیاتر پیشان بدە' },
  latestShown: { ar: 'تُعرض آخر {n} فقط.', en: 'Only the latest {n} are shown.', ckb: 'تەنها دوایین {n} پیشان دەدرێن.' },
  fullHistory: { ar: 'السجل الكامل في صفحة الحركات', en: 'The full history is in Transactions', ckb: 'مێژووی تەواو لە پەڕەی مامەڵەکاندایە' },
  goBack: { ar: 'تراجع', en: 'Go back', ckb: 'گەڕانەوە' },
  statusCode: { ar: 'الحالة: {code}', en: 'Status: {code}', ckb: 'دۆخ: {code}' },
  unknownMaterial: { ar: 'مادة غير معروفة', en: 'Unknown material', ckb: 'کەرەستەی نەناسراو' },
  viewPrint: { ar: 'عرض الطباعة', en: 'View the print', ckb: 'بینینی چاپەکە' },
  required: { ar: 'هذا الحقل مطلوب.', en: 'This is required.', ckb: 'ئەمە پێویستە.' },
  tooLong: { ar: 'النص أطول من المسموح.', en: 'This is too long.', ckb: 'ئەمە زۆر درێژە.' },
  untitledPrint: { ar: 'طباعة بلا عنوان', en: 'Untitled print', ckb: 'چاپی بێ ناونیشان' },
} satisfies Record<string, Tri>;

/** Hours: the balance per printer class, its purchases, its holds, its movements and the conversion. */
export const hoursText = {
  title: { ar: 'ساعات الطباعة', en: 'Printing hours', ckb: 'کاتژمێرەکانی چاپ' },
  subtitle: {
    ar: 'تُشترى الساعات لفئة طابعة، ولا تُصرف إلا على طابعات تلك الفئة.',
    en: 'Hours are bought for a printer class and spent only on printers of that class.',
    ckb: 'کاتژمێرەکان بۆ پۆلێکی چاپکەر دەکڕدرێن و تەنها لەسەر چاپکەرەکانی هەمان پۆل خەرج دەکرێن.',
  },
  emptyTitle: { ar: 'لا ساعات طباعة بعد', en: 'No printing hours yet', ckb: 'هێشتا کاتژمێری چاپت نییە' },
  emptyBody: {
    ar: 'اشترِ ساعات لفئة الطابعة التي تريدها، وتُحجز حين تؤكد طباعة.',
    en: 'Buy hours for the printer class you want; they are held when you confirm a print.',
    ckb: 'کاتژمێر بۆ ئەو پۆلە چاپکەرەی دەتەوێت بکڕە؛ کاتێک چاپێک پشتڕاست دەکەیتەوە دەگیرێن.',
  },
  buy: { ar: 'شراء ساعات', en: 'Buy hours', ckb: 'کڕینی کاتژمێر' },
  inAccount: { ar: 'في حسابك', en: 'In your account', ckb: 'لە هەژمارەکەتدا' },
  available: { ar: 'متاحة', en: 'Available', ckb: 'بەردەست' },
  held: { ar: 'محجوزة لطباعات', en: 'Held for prints', ckb: 'بۆ چاپەکان گیراوە' },
  used: { ar: 'استُهلكت', en: 'Used', ckb: 'بەکارهاتوو' },
  lotsTitle: { ar: 'المشتريات وصلاحيتها', en: 'Purchases and their expiry', ckb: 'کڕینەکان و بەسەرچوونیان' },
  lotLeft: { ar: 'متبقٍّ {left} من {total}', en: '{left} left of {total}', ckb: '{left} ماوە لە {total}' },
  lotHeld: { ar: '{amount} منها محجوزة لطباعات', en: '{amount} of it held for prints', ckb: '{amount}ی بۆ چاپەکان گیراوە' },
  neverExpires: { ar: 'لا تنتهي صلاحيتها', en: 'Does not expire', ckb: 'بەسەرناچێت' },
  expiresOn: { ar: 'تنتهي صلاحيتها في {date}', en: 'Expires on {date}', ckb: 'لە {date} بەسەردەچێت' },
  expiresSoon: { ar: 'تنتهي صلاحيتها قريبًا: {date}', en: 'Expires soon: {date}', ckb: 'بەم زووانە بەسەردەچێت: {date}' },
  expiredOn: { ar: 'انتهت صلاحيتها في {date}', en: 'Expired on {date}', ckb: 'لە {date} بەسەرچوو' },
  expiryUnknown: { ar: 'تاريخ انتهاء الصلاحية غير مقروء', en: 'The expiry date cannot be read', ckb: 'بەرواری بەسەرچوون ناخوێندرێتەوە' },
  expiredNote: {
    ar: 'تبقى الساعات المحجوزة لطباعة مع تلك الطباعة، ويُزال الباقي منها.',
    en: 'Hours a print already holds stay with that print; the rest are removed.',
    ckb: 'ئەو کاتژمێرانەی چاپێک گرتوونی بۆ هەمان چاپ دەمێننەوە؛ ئەوانی تر لادەبرێن.',
  },
  paid: { ar: 'المدفوع: {amount}', en: 'Paid: {amount}', ckb: 'پارەی دراو: {amount}' },
  lotsEmpty: { ar: 'لا مشتريات فيها ساعات متبقية.', en: 'No purchase has hours left.', ckb: 'هیچ کڕینێک کاتژمێری تێدا نەماوە.' },
  usedUpHidden: {
    ar: 'المشتريات التي نفدت ساعاتها غير معروضة.',
    en: 'Purchases with no hours left are not shown.',
    ckb: 'ئەو کڕینانەی کاتژمێریان تێدا نەماوە پیشان نادرێن.',
  },
  lotsCapped: { ar: 'تُعرض آخر {n} من مشترياتك.', en: 'Showing your latest {n} purchases.', ckb: 'دوایین {n} کڕینت پیشان دەدرێن.' },
  holdsTitle: { ar: 'محجوزة لطباعاتك', en: 'Held for your prints', ckb: 'بۆ چاپەکانت گیراون' },
  holdsEmpty: { ar: 'لا ساعات محجوزة لطباعات الآن.', en: 'No hours are held for prints right now.', ckb: 'ئێستا هیچ کاتژمێرێک بۆ چاپ نەگیراوە.' },
  holdLine: { ar: 'محجوز {amount}', en: '{amount} held', ckb: '{amount} گیراوە' },
  holdOn: { ar: 'حُجزت في {date}', en: 'Held on {date}', ckb: 'لە {date} گیرا' },
  settledTitle: { ar: 'حجوزات سُوّيت مؤخرًا', en: 'Recently settled holds', ckb: 'گیراوە یەکلاکراوەکانی ئەم دواییە' },
  settledLine: { ar: 'استُهلك {used} · أُعيد {returned}', en: '{used} used · {returned} returned', ckb: '{used} بەکارهات · {returned} گەڕایەوە' },
  releasedLine: { ar: 'أُعيدت كلها إلى رصيدك', en: 'All returned to your balance', ckb: 'هەمووی گەڕایەوە بۆ باڵانسەکەت' },
  ledgerTitle: { ar: 'آخر الحركات', en: 'Latest movements', ckb: 'دوایین جووڵەکان' },
  ledgerEmpty: { ar: 'لا حركات بعد.', en: 'No movements yet.', ckb: 'هێشتا هیچ جووڵەیەک نییە.' },
  convertTitle: { ar: 'تحويل الساعات بين الفئات', en: 'Convert hours between classes', ckb: 'گۆڕینی کاتژمێر لە نێوان پۆلەکاندا' },
  convertIntro: {
    ar: 'يجوز التحويل فقط حيث تسمح به الورشة. إن لم يكن مسموحًا لاختيارك فسيُقال لك ذلك ولن يتغيّر شيء.',
    en: 'Conversion works only where the workshop allows it. If it is not allowed for your choice, you will be told so and nothing changes.',
    ckb: 'گۆڕین تەنها ئەو کاتە دەکرێت کە کارگە ڕێگەی پێدابێت. ئەگەر بۆ هەڵبژاردنەکەت ڕێگەپێدراو نەبێت، پێت دەوترێت و هیچ ناگۆڕێت.',
  },
  convertOpen: { ar: 'ابدأ تحويلًا', en: 'Start a conversion', ckb: 'گۆڕینێک دەست پێبکە' },
  convertHide: { ar: 'إخفاء', en: 'Hide', ckb: 'شاردنەوە' },
  from: { ar: 'من فئة', en: 'From class', ckb: 'لە پۆلی' },
  to: { ar: 'إلى فئة', en: 'To class', ckb: 'بۆ پۆلی' },
  choose: { ar: 'اختر فئة', en: 'Choose a class', ckb: 'پۆلێک هەڵبژێرە' },
  hoursField: { ar: 'ساعات', en: 'Hours', ckb: 'کاتژمێر' },
  minutesField: { ar: 'دقائق', en: 'Minutes', ckb: 'خولەک' },
  convertAvailable: { ar: 'المتاح في هذه الفئة: {amount}', en: 'Available in this class: {amount}', ckb: 'بەردەست لەم پۆلەدا: {amount}' },
  tooMuch: { ar: 'أكثر من المتاح لك في هذه الفئة.', en: 'More than you have available in this class.', ckb: 'زیاترە لەوەی لەم پۆلەدا بەردەستتە.' },
  tooLittle: { ar: 'دقيقة واحدة على الأقل.', en: 'At least one minute.', ckb: 'لانیکەم یەک خولەک.' },
  sameClass: { ar: 'اختر فئتين مختلفتين.', en: 'Choose two different classes.', ckb: 'دوو پۆلی جیاواز هەڵبژێرە.' },
  review: { ar: 'مراجعة التحويل', en: 'Review the conversion', ckb: 'پێداچوونەوە بە گۆڕینەکەدا' },
  confirmTitle: { ar: 'تحويل هذه الساعات؟', en: 'Convert these hours?', ckb: 'ئەم کاتژمێرانە بگۆڕدرێن؟' },
  confirmGive: { ar: 'تخرج {amount} من فئة {from}.', en: '{amount} leave the {from} class.', ckb: '{amount} لە پۆلی {from} دەردەچن.' },
  confirmReceive: {
    ar: 'عدد الساعات التي تصلك في فئة {to} تحدده قاعدة الورشة، ويظهر بعد إتمام التحويل.',
    en: 'How many hours you receive in {to} is set by the workshop’s rule and shown once it is done.',
    ckb: 'ژمارەی ئەو کاتژمێرانەی لە پۆلی {to} وەریدەگریت ڕێسای کارگە دیاری دەکات و دوای تەواوبوون پیشان دەدرێت.',
  },
  confirmRules: {
    ar: 'لا تُحوَّل الساعات المحجوزة لطباعات ولا المنتهية صلاحيتها، وتحتفظ الساعات المحوّلة بتاريخ انتهائها.',
    en: 'Hours held for prints or past their expiry do not move; converted hours keep their expiry date.',
    ckb: 'ئەو کاتژمێرانەی بۆ چاپ گیراون یان بەسەرچوون ناگوازرێنەوە؛ کاتژمێرە گۆڕدراوەکان بەرواری بەسەرچوونی خۆیان دەپارێزن.',
  },
  confirm: { ar: 'حوّل', en: 'Convert', ckb: 'بیگۆڕە' },
  done: {
    ar: 'تم التحويل: صارت {given} من {from} تساوي {received} في {to}.',
    en: 'Done: {given} of {from} became {received} of {to}.',
    ckb: 'تەواو بوو: {given} لە {from} بوو بە {received} لە {to}.',
  },
  noTarget: { ar: 'لا توجد فئة أخرى للتحويل إليها.', en: 'There is no other class to convert to.', ckb: 'هیچ پۆلێکی تر نییە بۆ گۆڕین بۆی.' },
  nothingToConvert: { ar: 'لا ساعات متاحة للتحويل.', en: 'You have no available hours to convert.', ckb: 'هیچ کاتژمێرێکی بەردەستت نییە بۆ گۆڕین.' },
} satisfies Record<string, Tri>;

/** Where a purchase lot of hours came from (`pc_credit_lots.source`). */
export const lotSource = {
  purchase: { ar: 'شراء في {date}', en: 'Bought on {date}', ckb: 'لە {date} کڕدرا' },
  adjustment: { ar: 'أضافتها الورشة في {date}', en: 'Added by the workshop on {date}', ckb: 'کارگە لە {date} زیادی کرد' },
  compensation: { ar: 'تعويض في {date}', en: 'Compensation on {date}', ckb: 'قەرەبوو لە {date}' },
  conversion: { ar: 'تحويل في {date}', en: 'Converted on {date}', ckb: 'لە {date} گۆڕدرا' },
  other: { ar: 'أُضيفت في {date}', en: 'Added on {date}', ckb: 'لە {date} زیادکرا' },
} satisfies Record<string, Tri>;

/** A row of the hours ledger, by its entry type (pc_credit_ledger.entry_type). */
export const creditEntry = {
  purchase: { ar: 'شراء ساعات', en: 'Hours bought', ckb: 'کڕینی کاتژمێر' },
  reserve: { ar: 'حجز لطباعة', en: 'Held for a print', ckb: 'بۆ چاپێک گیرا' },
  release: { ar: 'إعادة إلى رصيدك', en: 'Returned to your balance', ckb: 'گەڕایەوە بۆ باڵانسەکەت' },
  consume: { ar: 'استهلاك في الطباعة', en: 'Used in printing', ckb: 'لە چاپدا بەکارهات' },
  refund: { ar: 'استرداد', en: 'Refunded', ckb: 'گەڕێندرایەوە' },
  adjust_credit: { ar: 'إضافة من الورشة', en: 'Added by the workshop', ckb: 'کارگە زیادی کرد' },
  adjust_debit: { ar: 'خصم من الورشة', en: 'Removed by the workshop', ckb: 'کارگە لای برد' },
  conversion_in: { ar: 'تحويل وارد', en: 'Converted in', ckb: 'گۆڕین بۆ ئێرە' },
  conversion_out: { ar: 'تحويل صادر', en: 'Converted out', ckb: 'گۆڕین بۆ پۆلێکی تر' },
  expire: { ar: 'انتهاء صلاحية', en: 'Expired', ckb: 'بەسەرچوو' },
  compensation: { ar: 'تعويض', en: 'Compensation', ckb: 'قەرەبوو' },
} satisfies Record<string, Tri>;

/** A row of the material ledger, by its entry type (pc_inventory_ledger.entry_type). */
export const inventoryEntry = {
  purchase: { ar: 'شراء', en: 'Bought', ckb: 'کڕدرا' },
  reserve: { ar: 'حجز', en: 'Held', ckb: 'گیرا' },
  release: { ar: 'إعادة إلى رصيدك', en: 'Returned to your balance', ckb: 'گەڕایەوە بۆ باڵانسەکەت' },
  consume: { ar: 'استهلاك في الطباعة', en: 'Used in printing', ckb: 'لە چاپدا بەکارهات' },
  deliver: { ar: 'تسليم لك', en: 'Handed over to you', ckb: 'ڕادەستی تۆ کرا' },
  buyback: { ar: 'بيع للورشة', en: 'Sold back to the workshop', ckb: 'بە کارگە فرۆشرایەوە' },
  refund: { ar: 'استرداد', en: 'Refunded', ckb: 'گەڕێندرایەوە' },
  adjust_credit: { ar: 'إضافة من الورشة', en: 'Added by the workshop', ckb: 'کارگە زیادی کرد' },
  adjust_debit: { ar: 'خصم من الورشة', en: 'Removed by the workshop', ckb: 'کارگە لای برد' },
  compensation: { ar: 'تعويض', en: 'Compensation', ckb: 'قەرەبوو' },
} satisfies Record<string, Tri>;

/** Material: what the customer owns at the workshop, a reminder, a top-up and the movements. */
export const materialsText = {
  title: { ar: 'الخيوط والمواد', en: 'Filament & materials', ckb: 'فیلامێنت و کەرەستەکان' },
  subtitle: {
    ar: 'ما تشتريه يُحفظ لك في الورشة حتى تطبع به أو تستلمه أو تبيعه للورشة.',
    en: 'What you buy is kept for you at the workshop until you print with it, collect it or sell it back.',
    ckb: 'ئەوەی دەیکڕیت لە کارگە بۆت هەڵدەگیرێت تا چاپی پێ دەکەیت، وەریدەگریتەوە یان دەیفرۆشیتەوە.',
  },
  emptyTitle: { ar: 'لا مواد في مخزونك بعد', en: 'No material in your inventory yet', ckb: 'هێشتا هیچ کەرەستەیەک لە کۆگاکەتدا نییە' },
  emptyBody: {
    ar: 'تُشترى الخيوط بالغرام والملحقات بالقطعة، وتبقى لك حتى تستعملها.',
    en: 'Filament is bought by the gram and accessories by the piece; they stay yours until you use them.',
    ckb: 'فیلامێنت بە گرام و پاشکۆکان بە دانە دەکڕدرێن، و هی تۆ دەمێننەوە تا بەکاریان دەهێنیت.',
  },
  buy: { ar: 'شراء خيوط', en: 'Buy filament', ckb: 'کڕینی فیلامێنت' },
  owned: { ar: 'تملكه', en: 'Yours', ckb: 'هی تۆیە' },
  held: { ar: 'محجوز', en: 'Held', ckb: 'گیراوە' },
  available: { ar: 'متاح', en: 'Free to use', ckb: 'بەردەستە' },
  used: { ar: 'استُهلك حتى الآن', en: 'Used so far', ckb: 'تا ئێستا بەکارهاتوو' },
  heldLine: { ar: '{amount} محجوزة', en: '{amount} held', ckb: '{amount} گیراوە' },
  kindFilament: { ar: 'الخيوط', en: 'Filament', ckb: 'فیلامێنت' },
  kindAccessory: { ar: 'الملحقات', en: 'Accessories', ckb: 'پاشکۆکان' },
  kindTool: { ar: 'الأدوات', en: 'Tools', ckb: 'ئامرازەکان' },
  kindOther: { ar: 'مواد أخرى', en: 'Other material', ckb: 'کەرەستەی تر' },
  reorderTitle: { ar: 'طباعاتك تحتاج المزيد', en: 'Your prints need more', ckb: 'چاپەکانت زیاتریان پێویستە' },
  reorderBody: {
    ar: 'الطباعات التي تنتظر تأكيدك تحتاج أكثر مما تملك.',
    en: 'Prints waiting for your confirmation need more than you own.',
    ckb: 'ئەو چاپانەی چاوەڕێی پشتڕاستکردنەوەی تۆن زیاتر لەوەی هەتە پێویستیان پێیە.',
  },
  reorderLine: { ar: 'المطلوب {needed}، لديك {owned}، ينقص {short}', en: 'Needed {needed}, you have {owned}, short by {short}', ckb: '{needed} پێویستە، {owned}ت هەیە، {short} کەمە' },
  reorderSuggest: { ar: 'الشراء المقترح: {qty}', en: 'Suggested purchase: {qty}', ckb: 'کڕینی پێشنیارکراو: {qty}' },
  priceIt: { ar: 'اعرف السعر', en: 'Get a price', ckb: 'نرخەکە وەربگرە' },
  paidRemaining: { ar: 'دفعت {amount} ثمنًا لما تبقّى لديك', en: 'You paid {amount} for what you have left', ckb: '{amount}ت داوە بۆ ئەوەی ماوەتەوە' },
  notFoundTitle: { ar: 'لا تملك هذه المادة', en: 'You do not own this material', ckb: 'ئەم کەرەستەیەت نییە' },
  alertTitle: { ar: 'تذكير عند انخفاض الرصيد', en: 'Low-balance reminder', ckb: 'بیرخستنەوە کاتی کەمبوونەوە' },
  alertBody: {
    ar: 'نذكّرك حين ينخفض المتاح من هذه المادة إلى هذه الكمية.',
    en: 'We remind you when what is free to use of this material falls to this amount.',
    ckb: 'کاتێک بەردەستی ئەم کەرەستەیە دادەبەزێتە ئەم بڕە بیرت دەخەینەوە.',
  },
  alertCurrent: { ar: 'التذكير عند {qty}', en: 'Reminder at {qty}', ckb: 'بیرخستنەوە لە {qty}' },
  alertDefault: { ar: 'التذكير عند الكمية الافتراضية للورشة', en: 'Reminder at the workshop’s default amount', ckb: 'بیرخستنەوە لە بڕی بنەڕەتیی کارگە' },
  alertLabel: { ar: 'ذكّرني عند', en: 'Remind me at', ckb: 'بیرم بخەرەوە لە' },
  alertSave: { ar: 'حفظ التذكير', en: 'Save reminder', ckb: 'پاشەکەوتکردنی بیرخستنەوە' },
  alertUseDefault: { ar: 'استخدم الافتراضي', en: 'Use the default', ckb: 'بنەڕەتی بەکاربهێنە' },
  alertSaved: { ar: 'حُفظ التذكير', en: 'Reminder saved', ckb: 'بیرخستنەوە پاشەکەوت کرا' },
  topUpTitle: { ar: 'زيادة الرصيد', en: 'Top up', ckb: 'زیادکردنی باڵانس' },
  topUpBody: {
    ar: 'حدّد الكمية التي تريد امتلاكها، ونسعّر الناقص كشراء جديد.',
    en: 'Say how much you want to own; what is missing is priced as a new purchase.',
    ckb: 'بڵێ چەندت دەوێت هەتبێت؛ ئەوەی کەمە وەک کڕینێکی نوێ نرخی بۆ دادەنرێت.',
  },
  topUpTarget: { ar: 'زِد رصيدي إلى', en: 'Top up to', ckb: 'باڵانسەکەم بگەیەنە' },
  topUpHint: { ar: 'اتركه فارغًا لاعتماد الكمية المعتادة لدى الورشة.', en: 'Leave it empty for the workshop’s usual amount.', ckb: 'بەتاڵی بهێڵەوە بۆ بڕی ئاسایی کارگە.' },
  topUpPrice: { ar: 'سعّر الزيادة', en: 'Price the top-up', ckb: 'نرخی زیادکردنەکە دابنێ' },
  topUpEnough: { ar: 'تملك {owned}، وهذا يبلغ {target} أو يزيد.', en: 'You own {owned}, already {target} or more.', ckb: '{owned}ت هەیە، کە {target} یان زیاترە.' },
  topUpBuy: { ar: 'اشترِ {qty} لتملك {after}', en: 'Buy {qty} to own {after}', ckb: '{qty} بکڕە بۆ ئەوەی {after}ت هەبێت' },
  price: { ar: 'السعر', en: 'Price', ckb: 'نرخ' },
  priceUntil: { ar: 'هذا السعر صالح حتى {time}', en: 'This price holds until {time}', ckb: 'ئەم نرخە تا {time} دەمێنێت' },
  outOfStock: {
    ar: 'لا تتوفر هذه الكمية في الورشة الآن.',
    en: 'The workshop does not have this quantity in stock right now.',
    ckb: 'ئێستا ئەم بڕە لە کارگەدا بەردەست نییە.',
  },
  continueInStore: { ar: 'تابع في المتجر', en: 'Continue in the store', ckb: 'لە فرۆشگا بەردەوام بە' },
  historyTitle: { ar: 'حركات هذه المادة', en: 'Movements of this material', ckb: 'جووڵەکانی ئەم کەرەستەیە' },
  sellBack: { ar: 'بيعها للورشة', en: 'Sell it back', ckb: 'بیفرۆشەوە' },
  ship: { ar: 'استلام أو توصيل', en: 'Collect or deliver', ckb: 'وەرگرتن یان گەیاندن' },
  buyMore: { ar: 'اشترِ المزيد', en: 'Buy more', ckb: 'زیاتر بکڕە' },
} satisfies Record<string, Tri>;

/** Shipments: pickup at the workshop or delivery, of finished prints and owned material. */
export const shipText = {
  title: { ar: 'الاستلام والتوصيل', en: 'Shipments & pickup', ckb: 'ناردن و وەرگرتن' },
  subtitle: {
    ar: 'استلم طباعاتك المكتملة وموادك من الورشة، أو اطلب توصيلها إليك.',
    en: 'Collect your finished prints and material at the workshop, or have them delivered.',
    ckb: 'چاپە تەواوبووەکان و کەرەستەکانت لە کارگە وەربگرە، یان داوا بکە بۆت بنێردرێن.',
  },
  request: { ar: 'طلب استلام أو توصيل', en: 'Request pickup or delivery', ckb: 'داوای وەرگرتن یان گەیاندن' },
  emptyTitle: { ar: 'لا شحنات بعد', en: 'No shipments yet', ckb: 'هێشتا هیچ ناردنێک نییە' },
  emptyBody: {
    ar: 'حين تكتمل طباعة يمكنك استلامها من الورشة أو طلب توصيلها.',
    en: 'Once a print is finished you can collect it at the workshop or ask for delivery.',
    ckb: 'کاتێک چاپێک تەواو دەبێت دەتوانیت لە کارگە وەریبگریت یان داوای گەیاندنی بکەیت.',
  },
  unavailable: { ar: 'الاستلام والتوصيل غير متاحين الآن.', en: 'Pickup and delivery are not available right now.', ckb: 'وەرگرتن و گەیاندن ئێستا بەردەست نین.' },
  fee: { ar: 'أجرة التوصيل', en: 'Delivery fee', ckb: 'کرێی گەیاندن' },
  noFee: { ar: 'بلا أجرة', en: 'No fee', ckb: 'بێ کرێ' },
  tracking: { ar: 'رقم التتبع: {ref}', en: 'Tracking: {ref}', ckb: 'ژمارەی بەدواداچوون: {ref}' },
  requestedOn: { ar: 'طُلبت في {date}', en: 'Requested on {date}', ckb: 'لە {date} داواکرا' },
  closedOn: { ar: 'أُغلقت في {date}', en: 'Closed on {date}', ckb: 'لە {date} داخرا' },
  detailTitle: { ar: 'شحنة', en: 'Shipment', ckb: 'ناردن' },
  itemsTitle: { ar: 'ما تحمله', en: 'What it carries', ckb: 'ئەوەی تێدایە' },
  itemRemoved: { ar: 'أُزيلت من الشحنة', en: 'Taken off the shipment', ckb: 'لە ناردنەکە لابرا' },
  addressTitle: { ar: 'عنوان التوصيل', en: 'Delivery address', ckb: 'ناونیشانی گەیاندن' },
  carrier: { ar: 'شركة التوصيل: {name}', en: 'Carrier: {name}', ckb: 'گواستەرەوە: {name}' },
  notesLine: { ar: 'ملاحظات: {text}', en: 'Notes: {text}', ckb: 'تێبینی: {text}' },
  payFee: { ar: 'ادفع أجرة التوصيل', en: 'Pay the delivery fee', ckb: 'کرێی گەیاندن بدە' },
  payFeeBody: { ar: 'لا يغادر شيء الورشة قبل دفع الأجرة.', en: 'Nothing leaves the workshop until the fee is paid.', ckb: 'تا کرێکە نەدرێت هیچ شتێک لە کارگە دەرناچێت.' },
  cancel: { ar: 'إلغاء الشحنة', en: 'Cancel the shipment', ckb: 'هەڵوەشاندنەوەی ناردنەکە' },
  cancelTitle: { ar: 'إلغاء هذه الشحنة؟', en: 'Cancel this shipment?', ckb: 'ئەم ناردنە هەڵبوەشێنرێتەوە؟' },
  cancelBody: {
    ar: 'تعود المواد المحجوزة لها إلى رصيدك، وتُغلق أجرة التوصيل إن لم تُدفع.',
    en: 'The material held for it returns to your balance, and an unpaid delivery fee is closed.',
    ckb: 'ئەو کەرەستانەی بۆی گیراون دەگەڕێنەوە بۆ باڵانسەکەت و کرێی نەدراوی گەیاندن دادەخرێت.',
  },
  cancelled: { ar: 'أُلغيت الشحنة', en: 'Shipment cancelled', ckb: 'ناردنەکە هەڵوەشێنرایەوە' },
  how: { ar: 'الطريقة', en: 'How', ckb: 'شێوە' },
  printsTitle: { ar: 'الطباعات المكتملة', en: 'Finished prints', ckb: 'چاپە تەواوبووەکان' },
  printsEmpty: { ar: 'لا طباعات مكتملة بانتظار الخروج.', en: 'No finished prints are waiting to leave.', ckb: 'هیچ چاپێکی تەواوبوو چاوەڕێی دەرچوون نییە.' },
  inShipment: { ar: 'ضمن شحنة أخرى', en: 'Already in a shipment', ckb: 'پێشتر لە ناردنێکدایە' },
  materialTitle: { ar: 'من موادك', en: 'From your material', ckb: 'لە کەرەستەکانت' },
  materialEmpty: {
    ar: 'لا مواد متاحة لديك يمكن أن تغادر الورشة.',
    en: 'You have no free material that can leave the workshop.',
    ckb: 'هیچ کەرەستەیەکی بەردەستت نییە کە بتوانێت لە کارگە دەربچێت.',
  },
  notDeliverable: {
    ar: 'بعض المواد تُستعمل في الورشة فقط، فلا تظهر هنا.',
    en: 'Some materials are used only at the workshop, so they are not listed here.',
    ckb: 'هەندێک کەرەستە تەنها لە کارگەدا بەکاردێن، بۆیە لێرە پیشان نادرێن.',
  },
  qty: { ar: 'الكمية', en: 'Quantity', ckb: 'بڕ' },
  upTo: { ar: 'حتى {qty}', en: 'Up to {qty}', ckb: 'تا {qty}' },
  recipient: { ar: 'اسم المستلم', en: 'Recipient’s name', ckb: 'ناوی وەرگر' },
  phone: { ar: 'رقم الهاتف', en: 'Phone number', ckb: 'ژمارەی تەلەفۆن' },
  phoneHint: { ar: 'أرقام فقط، ويمكن أن يبدأ بـ +', en: 'Digits only; it may start with +', ckb: 'تەنها ژمارە؛ دەتوانێت بە + دەست پێبکات' },
  phoneFormat: { ar: 'اكتب رقم هاتف صحيحًا.', en: 'Enter a valid phone number.', ckb: 'ژمارەی تەلەفۆنێکی دروست بنووسە.' },
  governorate: { ar: 'المحافظة', en: 'Governorate', ckb: 'پارێزگا' },
  chooseGovernorate: { ar: 'اختر المحافظة', en: 'Choose a governorate', ckb: 'پارێزگایەک هەڵبژێرە' },
  city: { ar: 'المدينة', en: 'City', ckb: 'شار' },
  addressLine: { ar: 'العنوان', en: 'Address', ckb: 'ناونیشان' },
  courierNotes: { ar: 'ملاحظات للمندوب', en: 'Notes for the courier', ckb: 'تێبینی بۆ گەیەنەر' },
  pickupNotice: {
    ar: 'الاستلام من الورشة بلا أجرة، وسنخبرك حين يصبح جاهزًا.',
    en: 'Pickup at the workshop has no fee; you will be told when it is ready.',
    ckb: 'وەرگرتن لە کارگە بێ کرێیە؛ کاتێک ئامادە بوو پێت دەوترێت.',
  },
  feeNotice: {
    ar: 'أجرة التوصيل إلى محافظتك تحددها الورشة، وتظهر بعد إرسال الطلب كدفعة منفصلة. لا يغادر شيء قبل دفعها، ويمكنك الإلغاء حتى ذلك الحين.',
    en: 'The delivery fee for your governorate is set by the workshop and shown after you send the request, as a separate payment. Nothing leaves before it is paid, and you can cancel until then.',
    ckb: 'کرێی گەیاندن بۆ پارێزگاکەت کارگە دیاری دەکات و دوای ناردنی داواکارییەکە وەک پارەدانێکی جیا پیشان دەدرێت. پێش دانی هیچ شتێک دەرناچێت و تا ئەو کاتە دەتوانیت هەڵیبوەشێنیتەوە.',
  },
  nothingChosen: { ar: 'اختر طباعة أو مادة واحدة على الأقل.', en: 'Choose at least one print or material.', ckb: 'لانیکەم چاپێک یان کەرەستەیەک هەڵبژێرە.' },
  review: { ar: 'مراجعة الطلب', en: 'Review the request', ckb: 'پێداچوونەوە بە داواکارییەکەدا' },
  confirmTitle: { ar: 'إرسال هذا الطلب؟', en: 'Send this request?', ckb: 'ئەم داواکارییە بنێردرێت؟' },
  confirmCounts: { ar: 'الطباعات: {prints} · المواد: {materials}', en: 'Prints: {prints} · Materials: {materials}', ckb: 'چاپەکان: {prints} · کەرەستەکان: {materials}' },
  confirmHold: {
    ar: 'تُحجز المواد التي اخترتها لهذه الشحنة حتى تغادر الورشة أو تلغيها.',
    en: 'The material you chose is held for this shipment until it leaves or you cancel.',
    ckb: 'ئەو کەرەستانەی هەڵتبژاردوون بۆ ئەم ناردنە دەگیرێن تا دەردەچن یان هەڵیدەوەشێنیتەوە.',
  },
  send: { ar: 'أرسل الطلب', en: 'Send request', ckb: 'داواکارییەکە بنێرە' },
  sent: { ar: 'أُرسل الطلب', en: 'Request sent', ckb: 'داواکارییەکە نێردرا' },
  feeDue: {
    ar: 'أجرة التوصيل {amount} — ادفعها ليبدأ التوصيل.',
    en: 'Delivery fee {amount} — pay it to start the delivery.',
    ckb: 'کرێی گەیاندن {amount} — بیدە بۆ ئەوەی گەیاندن دەست پێبکات.',
  },
  stepsLabel: { ar: 'مراحل الشحنة', en: 'Shipment progress', ckb: 'قۆناغەکانی ناردن' },
  checkingShipments: {
    ar: 'لم نتمكن من قراءة كل شحناتك، فقد تظهر طباعة مضافة سابقًا.',
    en: 'Some of your shipments could not be read, so a print already on one may still be listed.',
    ckb: 'هەندێک لە ناردنەکانت نەخوێندرانەوە، بۆیە لەوانەیە چاپێک کە پێشتر خراوەتە ناردنێکەوە هێشتا پیشان بدرێت.',
  },
} satisfies Record<string, Tri>;

/** pickup or delivery (pc_shipments.kind). */
export const shipmentKind = {
  pickup: { ar: 'استلام من الورشة', en: 'Pickup at the workshop', ckb: 'وەرگرتن لە کارگە' },
  delivery: { ar: 'توصيل', en: 'Delivery', ckb: 'گەیاندن' },
} satisfies Record<string, Tri>;

/** A shipment's status (pc_shipments.status), as the customer reads it. */
export const shipmentStatus = {
  awaiting_payment: { ar: 'بانتظار دفع الأجرة', en: 'Awaiting the fee', ckb: 'چاوەڕێی دانی کرێ' },
  preparing: { ar: 'قيد التجهيز', en: 'Being prepared', ckb: 'ئامادە دەکرێت' },
  ready_for_pickup: { ar: 'جاهزة للاستلام', en: 'Ready for pickup', ckb: 'ئامادەیە بۆ وەرگرتن' },
  shipped: { ar: 'في الطريق إليك', en: 'On its way', ckb: 'لە ڕێگادایە' },
  delivered: { ar: 'وصلت', en: 'Delivered', ckb: 'گەیشت' },
  picked_up: { ar: 'استُلمت', en: 'Collected', ckb: 'وەرگیرا' },
  cancelled: { ar: 'أُلغيت', en: 'Cancelled', ckb: 'هەڵوەشێنرایەوە' },
} satisfies Record<string, Tri>;

/** Selling unused material back to the workshop. */
export const buybackText = {
  title: { ar: 'بيع الخيوط للورشة', en: 'Sell back filament', ckb: 'فرۆشتنەوەی فیلامێنت' },
  subtitle: {
    ar: 'تشتري الورشة المواد غير المستعملة من بعض الفئات بنسبة مما دفعت. تُحدَّد القيمة النهائية عند الموافقة، وتبقى الكمية محجوزة حتى ذلك الحين.',
    en: 'The workshop buys back unused material of some categories at a share of what you paid. The final amount is set on approval; the quantity is held until then.',
    ckb: 'کارگە کەرەستەی بەکارنەهاتووی هەندێک پۆل بە بەشێک لەوەی داوتە دەکڕێتەوە. بەهای کۆتایی کاتی پەسەندکردن دیاری دەکرێت و بڕەکە تا ئەو کاتە دەگیرێت.',
  },
  closed: { ar: 'لا تشتري الورشة أي مواد حاليًا.', en: 'The workshop is not buying back any material right now.', ckb: 'ئێستا کارگە هیچ کەرەستەیەک ناکڕێتەوە.' },
  rates: { ar: 'النسب الحالية', en: 'Current rates', ckb: 'ڕێژەکانی ئێستا' },
  rateLine: { ar: '{category}: {rate} مما دفعت', en: '{category}: {rate} of what you paid', ckb: '{category}: {rate} لەوەی داوتە' },
  formTitle: { ar: 'بيع جديد', en: 'New sell-back', ckb: 'فرۆشتنەوەی نوێ' },
  material: { ar: 'المادة', en: 'Material', ckb: 'کەرەستە' },
  choose: { ar: 'اختر مادة', en: 'Choose a material', ckb: 'کەرەستەیەک هەڵبژێرە' },
  nothingToSell: {
    ar: 'لا تملك مواد متاحة من الفئات التي تشتريها الورشة.',
    en: 'You have no free material in the categories the workshop buys back.',
    ckb: 'هیچ کەرەستەیەکی بەردەستت نییە لەو پۆلانەی کارگە دەیانکڕێتەوە.',
  },
  qty: { ar: 'الكمية', en: 'Quantity', ckb: 'بڕ' },
  freeToSell: { ar: 'المتاح للبيع: {qty}', en: 'Free to sell: {qty}', ckb: 'بەردەست بۆ فرۆشتن: {qty}' },
  tooMuch: { ar: 'أكثر من المتاح لك.', en: 'More than you have free.', ckb: 'زیاترە لەوەی بەردەستتە.' },
  getQuote: { ar: 'احسب القيمة', en: 'Get a quote', ckb: 'بەهاکە بزانە' },
  quoteRate: { ar: 'النسبة', en: 'Rate', ckb: 'ڕێژە' },
  quotePaid: { ar: 'ما دفعته ثمنًا لها', en: 'What you paid for it', ckb: 'ئەوەی بۆی داوتە' },
  quoteValue: { ar: 'القيمة التقديرية', en: 'Estimated value', ckb: 'بەهای خەمڵێنراو' },
  quoteNote: {
    ar: 'تُحسب من مشترياتك الأقدم أولًا. القيمة النهائية تحددها الورشة عند الموافقة.',
    en: 'Worked out from your oldest purchases first. The final amount is set by the workshop on approval.',
    ckb: 'لە کۆنترین کڕینەکانتەوە حیساب دەکرێت. بەهای کۆتایی کارگە کاتی پەسەندکردن دیاری دەکات.',
  },
  request: { ar: 'اطلب البيع', en: 'Request the sell-back', ckb: 'داوای فرۆشتنەوە بکە' },
  confirmTitle: { ar: 'بيع هذه الكمية للورشة؟', en: 'Sell this back to the workshop?', ckb: 'ئەم بڕە بە کارگە بفرۆشرێتەوە؟' },
  confirmBody: {
    ar: 'تُحجز {qty} من {name} حتى تقرر الورشة. القيمة التقديرية {amount}.',
    en: '{qty} of {name} is held until the workshop decides. Estimated value: {amount}.',
    ckb: '{qty} لە {name} دەگیرێت تا کارگە بڕیار دەدات. بەهای خەمڵێنراو: {amount}.',
  },
  requested: { ar: 'أُرسل طلب البيع', en: 'Sell-back requested', ckb: 'داوای فرۆشتنەوە نێردرا' },
  listTitle: { ar: 'طلبات البيع', en: 'Your sell-backs', ckb: 'فرۆشتنەوەکانت' },
  listEmpty: { ar: 'لم تبع شيئًا للورشة بعد.', en: 'You have not sold anything back yet.', ckb: 'هێشتا هیچت نەفرۆشتووەتەوە.' },
  estimated: { ar: 'تقديريًا {amount}', en: 'Estimated {amount}', ckb: 'بە خەمڵاندن {amount}' },
  final: { ar: 'نهائيًا {amount}', en: 'Final {amount}', ckb: 'کۆتایی {amount}' },
  rateOf: { ar: 'بنسبة {rate}', en: 'at {rate}', ckb: 'بە ڕێژەی {rate}' },
  cancel: { ar: 'إلغاء الطلب', en: 'Cancel request', ckb: 'هەڵوەشاندنەوەی داواکاری' },
  cancelTitle: { ar: 'إلغاء طلب البيع؟', en: 'Cancel this sell-back?', ckb: 'ئەم فرۆشتنەوەیە هەڵبوەشێنرێتەوە؟' },
  cancelBody: { ar: 'تعود الكمية المحجوزة إلى رصيدك.', en: 'The held quantity returns to your balance.', ckb: 'بڕە گیراوەکە دەگەڕێتەوە بۆ باڵانسەکەت.' },
  cancelled: { ar: 'أُلغي طلب البيع', en: 'Sell-back cancelled', ckb: 'فرۆشتنەوەکە هەڵوەشێنرایەوە' },
} satisfies Record<string, Tri>;

/** A sell-back's status (pc_buyback_requests.status). */
export const buybackStatus = {
  requested: { ar: 'بانتظار قرار الورشة', en: 'Awaiting the workshop', ckb: 'چاوەڕێی بڕیاری کارگە' },
  approved: { ar: 'قُبلت', en: 'Approved', ckb: 'پەسەندکرا' },
  rejected: { ar: 'رُفضت', en: 'Declined', ckb: 'ڕەتکرایەوە' },
  cancelled: { ar: 'أُلغيت', en: 'Cancelled', ckb: 'هەڵوەشێنرایەوە' },
} satisfies Record<string, Tri>;

/** Whether an approved sell-back was paid out (pc_buyback_requests.payout_status). */
export const payoutStatus = {
  none: { ar: 'لا دفعة', en: 'No payout', ckb: 'هیچ پارەدانێک نییە' },
  pending: { ar: 'بانتظار الدفع لك', en: 'Payout pending', ckb: 'چاوەڕێی پێدانی پارە' },
  paid: { ar: 'دُفعت لك', en: 'Paid to you', ckb: 'پارەکەت پێدرا' },
} satisfies Record<string, Tri>;

/** The unified history (GET /me/transactions). */
export const txText = {
  title: { ar: 'الحركات', en: 'Transactions', ckb: 'مامەڵەکان' },
  subtitle: {
    ar: 'كل حركة لساعاتك وموادك وطلباتك، الأحدث أولًا.',
    en: 'Every movement of your hours, material and orders, newest first.',
    ckb: 'هەموو جووڵەیەکی کاتژمێر و کەرەستە و داواکارییەکانت، نوێترین یەکەم.',
  },
  filter: { ar: 'عرض', en: 'Show', ckb: 'پیشاندان' },
  all: { ar: 'كل الحركات', en: 'Everything', ckb: 'هەموو جووڵەکان' },
  empty: { ar: 'لا حركات بعد.', en: 'No movements yet.', ckb: 'هێشتا هیچ جووڵەیەک نییە.' },
  filteredEmpty: { ar: 'لا شيء من هذا النوع فيما حُمّل حتى الآن.', en: 'Nothing of this kind in what is loaded so far.', ckb: 'هیچ شتێکی لەم جۆرە لەوەی تا ئێستا بارکراوە نییە.' },
  end: { ar: 'هذا كل شيء.', en: 'That is everything.', ckb: 'ئەوە هەمووی بوو.' },
  order: { ar: 'طلب: {status}', en: 'Order: {status}', ckb: 'داواکاری: {status}' },
  refund: { ar: 'استرداد مبلغ', en: 'Money refunded', ckb: 'گەڕاندنەوەی پارە' },
  buyback: { ar: 'بيع للورشة: {status}', en: 'Sell-back: {status}', ckb: 'فرۆشتنەوە: {status}' },
  shipment: { ar: 'شحنة ({kind}): {status}', en: 'Shipment ({kind}): {status}', ckb: 'ناردن ({kind}): {status}' },
  total: { ar: 'الإجمالي {amount}', en: 'Total {amount}', ckb: 'کۆی گشتی {amount}' },
} satisfies Record<string, Tri>;

/** The six histories GET /me/transactions merges (`ledger`). */
export const txLedger = {
  credits: { ar: 'الساعات', en: 'Hours', ckb: 'کاتژمێرەکان' },
  inventory: { ar: 'المواد', en: 'Material', ckb: 'کەرەستەکان' },
  orders: { ar: 'الطلبات', en: 'Orders', ckb: 'داواکارییەکان' },
  refunds: { ar: 'المبالغ المستردة', en: 'Refunds', ckb: 'پارە گەڕێندراوەکان' },
  buybacks: { ar: 'البيع للورشة', en: 'Sell-backs', ckb: 'فرۆشتنەوەکان' },
  shipments: { ar: 'الشحنات', en: 'Shipments', ckb: 'ناردنەکان' },
} satisfies Record<string, Tri>;

/** An order's status inside a sentence (pc_orders.status). */
export const orderStatusWord = {
  awaiting_payment: { ar: 'بانتظار الدفع', en: 'awaiting payment', ckb: 'چاوەڕێی پارەدان' },
  fulfilled: { ar: 'مدفوع ومُنفَّذ', en: 'paid and fulfilled', ckb: 'پارەدراو و جێبەجێکراو' },
  cancelled: { ar: 'ملغى', en: 'cancelled', ckb: 'هەڵوەشێنراوە' },
  expired: { ar: 'انتهت مهلته', en: 'expired', ckb: 'ماوەکەی بەسەرچوو' },
  refunded: { ar: 'مسترد', en: 'refunded', ckb: 'گەڕێندراوە' },
  partially_refunded: { ar: 'مسترد جزئيًا', en: 'partly refunded', ckb: 'بەشێکی گەڕێندراوە' },
} satisfies Record<string, Tri>;

/** Settings: how Print Cloud reads and looks, and the way to the Levonis account. */
export const settingsText = {
  title: { ar: 'الإعدادات', en: 'Settings', ckb: 'ڕێکخستنەکان' },
  subtitle: { ar: 'كيف تُعرض لك Print Cloud.', en: 'How Print Cloud reads and looks for you.', ckb: 'Print Cloud چۆن بۆت پیشان دەدرێت.' },
  language: { ar: 'اللغة', en: 'Language', ckb: 'زمان' },
  appearance: { ar: 'المظهر', en: 'Appearance', ckb: 'ڕووکار' },
  themeLight: { ar: 'فاتح', en: 'Light', ckb: 'ڕووناک' },
  themeDark: { ar: 'داكن', en: 'Dark', ckb: 'تاریک' },
  themeSystem: { ar: 'حسب الجهاز', en: 'System', ckb: 'بەپێی ئامێر' },
  account: { ar: 'حسابك في Levonis', en: 'Your Levonis account', ckb: 'هەژمارەکەت لە Levonis' },
  accountBody: {
    ar: 'اسمك وصورتك وكلمة المرور والإشعارات تُدار في Levonis.',
    en: 'Your name, photo, password and notifications are managed on Levonis.',
    ckb: 'ناو، وێنە، وشەی نهێنی و ئاگادارکردنەوەکانت لە Levonis بەڕێوە دەبرێن.',
  },
  openSettings: { ar: 'إعدادات الحساب في Levonis', en: 'Account settings on Levonis', ckb: 'ڕێکخستنەکانی هەژمار لە Levonis' },
} satisfies Record<string, Tri>;
