import type { Language } from '../../translations';

/**
 * Every visible string on the warranty surface, in the three UI languages.
 * One interface, three literal tables: a key missing from any language is a
 * type error, not a blank label in production.
 */
export interface WarrantyStrings {
  // page
  title: string;
  intro: string;
  back: string;
  proStrip: string;
  proStripLink: string;
  proTeaser: string;
  coverageNote: string;
  loading: string;
  error: string;
  close: string;
  cancel: string;

  // add a printer
  addTitle: string;
  addIntro: string;
  tabSerial: string;
  tabOrders: string;
  tabScan: string;
  serialLabel: string;
  serialPlaceholder: string;
  link: string;
  linking: string;
  linkedOk: string;
  alreadyLinked: string;
  registerHint: string;
  notFound: string;
  notFoundNext: string;
  rateLimited: string;
  eligibleIntro: string;
  eligibleEmpty: string;
  eligibleEmptyDesc: string;
  linkedElsewhere: string;
  linkRow: string;
  unitN: (n: number) => string;
  scanIntro: string;
  scanCta: string;
  scanCaptured: string;

  // scanner
  scanTitle: string;
  scanStarting: string;
  scanSlow: string;
  scanLooking: string;
  scanDenied: string;
  scanUnavailable: string;
  scanFailed: string;
  scanNothing: string;
  scanDecoding: string;
  choosePhoto: string;
  scanHint: string;

  // my printers
  myPrinters: string;
  devicesEmpty: string;
  devicesEmptyDesc: string;
  orderRef: string;
  deliveredAt: string;
  warrantyEnd: string;
  today: string;
  stActive: string;
  stExpired: string;
  stNeedsConfig: string;
  stNotDelivered: string;
  daysLeft: (n: number, formatted: string) => string;
  /** A purchased extension on the device: the badge, and the split under the
   *  timeline ("12 months base + 12 months extended") — both server fields,
   *  nothing summed in the browser. */
  extendedBadge: string;
  coverageSplit: (base: string, ext: string) => string;
  transferredBadge: string;
  replacedBadge: string;
  openClaimsBadge: (n: number, formatted: string) => string;
  openClaim: string;
  contactSupport: string;
  receipt: string;
  verifyReceipt: string;
  printReceipt: string;
  viewOrder: string;
  more: string;
  removeFromAccount: string;
  unlinkTitle: string;
  unlinkBody: string;
  unlinkConfirm: string;
  unlinking: string;
  unlinkedOk: string;
  claimOpenBlock: string;

  // claims
  claims: string;
  claimsEmpty: string;
  claimsEmptyDesc: string;
  newClaimTitle: string;
  subject: string;
  subjectPh: string;
  description: string;
  descriptionPh: string;
  attachments: string;
  uploading: string;
  submit: string;
  submitting: string;
  thread: string;
  reply: string;
  send: string;
  attach: string;
  removeAttachment: string;
  decisionReason: string;
  adminNote: string;
  priorityBadge: string;
  stageLabels: Record<string, string>;
  decisionStep: string;
  submittedAt: string;
  claimSubmitted: string;
}

const ar: WarrantyStrings = {
  title: 'مركز الضمان',
  intro: 'اربط طابعاتك بحسابك، تابع تغطية الضمان، وافتح المطالبات من مكان واحد.',
  back: 'رجوع',
  proStrip: 'خدمة أولوية PRO — مطالباتك تُعالَج في مقدمة الطابور.',
  proStripLink: 'بطاقة العضوية',
  proTeaser: 'أعضاء PRO يحصلون على خدمة ضمان بأولوية.',
  coverageNote: 'العضوية لا تغيّر مدة الضمان أو تواريخه.',
  loading: 'جارٍ التحميل…',
  error: 'حدث خطأ، حاول مجددًا.',
  close: 'إغلاق',
  cancel: 'إلغاء',

  addTitle: 'إضافة طابعة',
  addIntro: 'بالرقم التسلسلي، من طلباتك المُسلَّمة، أو بمسح الرمز.',
  tabSerial: 'الرقم التسلسلي',
  tabOrders: 'من طلباتي',
  tabScan: 'مسح',
  serialLabel: 'الرقم التسلسلي أو رقم الإيصال',
  serialPlaceholder: 'كما هو مطبوع على ملصق الجهاز أو الإيصال (WR-…)',
  link: 'ربط هذه الطابعة',
  linking: 'جارٍ التحقق…',
  linkedOk: 'تم ربط الطابعة بحسابك.',
  alreadyLinked: 'هذه الطابعة مرتبطة بحسابك مسبقًا.',
  registerHint: 'الربط لا يغيّر تواريخ الضمان إطلاقًا.',
  notFound: 'غير موجود أو مستخدم مسبقًا.',
  notFoundNext: 'تحقق من الرقم، أو جرّب «من طلباتي»، أو تواصل مع الدعم.',
  rateLimited: 'محاولات كثيرة — حاول مجددًا بعد بضع دقائق.',
  eligibleIntro: 'الأجهزة المُسلَّمة في طلباتك التي لم تُربط بحسابك بعد.',
  eligibleEmpty: 'لا توجد أجهزة غير مرتبطة في طلباتك المُسلَّمة.',
  eligibleEmptyDesc: 'كل طابعاتك المُسلَّمة مرتبطة بحسابك، أو لم يُسلَّم أي طلب بعد.',
  linkedElsewhere: 'مرتبط بحساب آخر — يجب أن يفكّ ذلك الحساب الارتباط أولًا، أو تواصل مع الدعم.',
  linkRow: 'ربط',
  unitN: (n) => `وحدة ${n}`,
  scanIntro: 'امسح رمز QR على إيصال الضمان أو الباركود على ملصق الجهاز.',
  scanCta: 'افتح الكاميرا',
  scanCaptured: 'تم التقاط الرمز — جارٍ التحقق…',

  scanTitle: 'مسح الرمز',
  scanStarting: 'جارٍ تشغيل الكاميرا…',
  scanSlow: 'ما زلنا ننتظر إذن الكاميرا — يمكنك كتابة الرقم أو اختيار صورة بدلًا من ذلك.',
  scanLooking: 'ضع الرمز داخل الإطار.',
  scanDenied: 'تم رفض الوصول إلى الكاميرا — اكتب الرقم بدلًا من ذلك.',
  scanUnavailable: 'لا توجد كاميرا متاحة على هذا الجهاز — اكتب الرقم أو اختر صورة.',
  scanFailed: 'تعذّر تشغيل الكاميرا — اكتب الرقم أو اختر صورة.',
  scanNothing: 'لم يُعثر على رمز في الصورة — جرّب صورة أوضح أو اكتب الرقم.',
  scanDecoding: 'جارٍ قراءة الصورة…',
  choosePhoto: 'اختر صورة',
  scanHint: 'يُقبل رمز QR الخاص بالإيصال والباركود المطبوع على ملصق الجهاز.',

  myPrinters: 'طابعاتي',
  devicesEmpty: 'لا توجد طابعات مرتبطة بعد.',
  devicesEmptyDesc: 'أضف طابعتك بالرقم التسلسلي أو من طلباتك المُسلَّمة.',
  orderRef: 'الطلب',
  deliveredAt: 'التسليم',
  warrantyEnd: 'نهاية الضمان',
  today: 'اليوم',
  stActive: 'الضمان ساري',
  stExpired: 'الضمان منتهٍ',
  stNeedsConfig: 'مدة الضمان بحاجة إعداد من المتجر',
  stNotDelivered: 'لم يُسلَّم بعد',
  daysLeft: (n, f) => {
    if (n === 1) return 'يوم واحد متبقٍ';
    if (n === 2) return 'يومان متبقيان';
    if (n >= 3 && n <= 10) return `${f} أيام متبقية`;
    return `${f} يومًا متبقيًا`;
  },
  extendedBadge: 'ضمان ممدد',
  coverageSplit: (base, ext) => `${base} ضمان أساسي + ${ext} تمديد مدفوع`,
  transferredBadge: 'منقولة إليك',
  replacedBadge: 'مُستبدَل',
  openClaimsBadge: (n, f) => (n === 1 ? 'مطالبة مفتوحة' : n === 2 ? 'مطالبتان مفتوحتان' : `${f} مطالبات مفتوحة`),
  openClaim: 'فتح مطالبة',
  contactSupport: 'تواصل مع الدعم',
  receipt: 'الإيصال',
  verifyReceipt: 'التحقق من الإيصال',
  printReceipt: 'طباعة الإيصال',
  viewOrder: 'الطلب',
  more: 'المزيد',
  removeFromAccount: 'إزالة من حسابي',
  unlinkTitle: 'إزالة هذه الطابعة من حسابك؟',
  unlinkBody: 'ستُفكّ الطابعة من حسابك ويمكن لحساب آخر ربطها. تواريخ الضمان لا تتغيّر. هذه هي الخطوة قبل تسليم الطابعة لشخص آخر.',
  unlinkConfirm: 'إزالة من حسابي',
  unlinking: 'جارٍ الإزالة…',
  unlinkedOk: 'تمت إزالة الطابعة من حسابك.',
  claimOpenBlock: 'لا يمكن إزالة الطابعة أثناء وجود مطالبة مفتوحة عليها. انتظر إغلاق المطالبة أو تواصل مع الدعم.',

  claims: 'مطالباتي',
  claimsEmpty: 'ليس لديك أي مطالبات ضمان.',
  claimsEmptyDesc: 'افتح مطالبة من بطاقة الطابعة عند حدوث مشكلة.',
  newClaimTitle: 'مطالبة ضمان جديدة',
  subject: 'الموضوع',
  subjectPh: 'مثال: توقّف السخان عن العمل',
  description: 'وصف المشكلة',
  descriptionPh: 'صف المشكلة بالتفصيل (10 أحرف على الأقل)…',
  attachments: 'صور / فيديو (اختياري، حتى 6)',
  uploading: 'جارٍ الرفع…',
  submit: 'إرسال المطالبة',
  submitting: 'جارٍ الإرسال…',
  thread: 'المحادثة',
  reply: 'اكتب رسالة…',
  send: 'إرسال',
  attach: 'إرفاق ملف',
  removeAttachment: 'إزالة المرفق',
  decisionReason: 'سبب القرار',
  adminNote: 'ملاحظة الفريق',
  priorityBadge: 'أولوية PRO',
  stageLabels: {
    received: 'مُستلَمة',
    diagnosing: 'قيد الفحص',
    approved: 'مقبولة',
    rejected: 'مرفوضة',
    repairing: 'قيد الإصلاح',
    replaced: 'استبدال',
    resolved: 'منتهية',
  },
  decisionStep: 'القرار',
  submittedAt: 'تاريخ التقديم',
  claimSubmitted: 'تم إرسال المطالبة.',
};

const en: WarrantyStrings = {
  title: 'Warranty Center',
  intro: 'Link your printers to your account, follow their coverage, and open claims — all in one place.',
  back: 'Back',
  proStrip: 'PRO priority service — your claims go to the front of the queue.',
  proStripLink: 'Membership card',
  proTeaser: 'PRO members get priority warranty service.',
  coverageNote: 'Membership never changes the warranty period or its dates.',
  loading: 'Loading…',
  error: 'Something went wrong, please try again.',
  close: 'Close',
  cancel: 'Cancel',

  addTitle: 'Add a printer',
  addIntro: 'By serial number, from your delivered orders, or by scanning a code.',
  tabSerial: 'Serial number',
  tabOrders: 'From my orders',
  tabScan: 'Scan',
  serialLabel: 'Serial number or receipt number',
  serialPlaceholder: 'As printed on the device label or receipt (WR-…)',
  link: 'Link this printer',
  linking: 'Checking…',
  linkedOk: 'Printer linked to your account.',
  alreadyLinked: 'This printer is already linked to your account.',
  registerHint: 'Linking never changes any warranty date.',
  notFound: 'Not found or already in use.',
  notFoundNext: 'Check the number, try “From my orders”, or contact support.',
  rateLimited: 'Too many attempts — try again in a few minutes.',
  eligibleIntro: 'Delivered devices on your orders that are not linked to your account yet.',
  eligibleEmpty: 'No unlinked devices on your delivered orders.',
  eligibleEmptyDesc: 'Every delivered printer is already linked to your account, or no order has been delivered yet.',
  linkedElsewhere: 'Linked to another account — that account must unlink it first, or contact support.',
  linkRow: 'Link',
  unitN: (n) => `Unit ${n}`,
  scanIntro: 'Scan the QR code on the warranty receipt or the barcode on the device label.',
  scanCta: 'Open the camera',
  scanCaptured: 'Code captured — checking…',

  scanTitle: 'Scan a code',
  scanStarting: 'Starting the camera…',
  scanSlow: 'Still waiting for camera permission — you can type the serial or choose a photo instead.',
  scanLooking: 'Hold the code inside the frame.',
  scanDenied: 'Camera access was denied — type the serial instead.',
  scanUnavailable: 'No camera is available on this device — type the serial or choose a photo.',
  scanFailed: 'The camera could not be started — type the serial or choose a photo.',
  scanNothing: 'No code found in the photo — try a clearer photo or type the serial.',
  scanDecoding: 'Reading the photo…',
  choosePhoto: 'Choose a photo',
  scanHint: 'The receipt’s QR code and the barcode printed on the device label are both accepted.',

  myPrinters: 'My printers',
  devicesEmpty: 'No printers linked yet.',
  devicesEmptyDesc: 'Add your printer by serial number or from your delivered orders.',
  orderRef: 'Order',
  deliveredAt: 'Delivered',
  warrantyEnd: 'Warranty ends',
  today: 'Today',
  stActive: 'Warranty active',
  stExpired: 'Warranty expired',
  stNeedsConfig: 'Warranty duration awaits store configuration',
  stNotDelivered: 'Not delivered yet',
  daysLeft: (n, f) => (n === 1 ? '1 day left' : `${f} days left`),
  extendedBadge: 'Extended warranty',
  coverageSplit: (base, ext) => `${base} base warranty + ${ext} purchased extension`,
  transferredBadge: 'Transferred to you',
  replacedBadge: 'Replaced',
  openClaimsBadge: (n, f) => (n === 1 ? '1 open claim' : `${f} open claims`),
  openClaim: 'Open claim',
  contactSupport: 'Contact support',
  receipt: 'Receipt',
  verifyReceipt: 'Verify receipt',
  printReceipt: 'Print receipt',
  viewOrder: 'Order',
  more: 'More',
  removeFromAccount: 'Remove from my account',
  unlinkTitle: 'Remove this printer from your account?',
  unlinkBody: 'The printer will be unlinked from your account and another account will be able to link it. Warranty dates do not change. This is the step before handing the printer to someone else.',
  unlinkConfirm: 'Remove from my account',
  unlinking: 'Removing…',
  unlinkedOk: 'Printer removed from your account.',
  claimOpenBlock: 'The printer cannot be removed while a claim on it is open. Wait for the claim to close, or contact support.',

  claims: 'My claims',
  claimsEmpty: 'You do not have any warranty claims.',
  claimsEmptyDesc: 'Open a claim from a printer’s card when something goes wrong.',
  newClaimTitle: 'New warranty claim',
  subject: 'Subject',
  subjectPh: 'e.g. Heater stopped working',
  description: 'Problem description',
  descriptionPh: 'Describe the issue in detail (at least 10 characters)…',
  attachments: 'Photos / video (optional, up to 6)',
  uploading: 'Uploading…',
  submit: 'Submit claim',
  submitting: 'Submitting…',
  thread: 'Conversation',
  reply: 'Write a message…',
  send: 'Send',
  attach: 'Attach file',
  removeAttachment: 'Remove attachment',
  decisionReason: 'Decision reason',
  adminNote: 'Team note',
  priorityBadge: 'PRO priority',
  stageLabels: {
    received: 'Received',
    diagnosing: 'Diagnosing',
    approved: 'Approved',
    rejected: 'Rejected',
    repairing: 'Repairing',
    replaced: 'Replaced',
    resolved: 'Resolved',
  },
  decisionStep: 'Decision',
  submittedAt: 'Submitted',
  claimSubmitted: 'Claim submitted.',
};

const ckb: WarrantyStrings = {
  title: 'ناوەندی گەرەنتی',
  intro: 'پرینتەرەکانت بە هەژمارەکەت ببەستە، گەرەنتییەکەیان بەدواداچوون بکە و داواکاری بکەرەوە — هەمووی لە یەک شوێن.',
  back: 'گەڕانەوە',
  proStrip: 'خزمەتگوزاری پێشینەی PRO — داواکارییەکانت لە پێشەوەی ڕیزەکە دەبن.',
  proStripLink: 'کارتی ئەندامێتی',
  proTeaser: 'ئەندامانی PRO خزمەتگوزاری گەرەنتی بە پێشینە وەردەگرن.',
  coverageNote: 'ئەندامێتی ماوەی گەرەنتی یان بەروارەکانی ناگۆڕێت.',
  loading: 'باردەکرێت…',
  error: 'هەڵەیەک ڕوویدا، دووبارە هەوڵبدەوە.',
  close: 'داخستن',
  cancel: 'هەڵوەشاندنەوە',

  addTitle: 'زیادکردنی پرینتەر',
  addIntro: 'بە ژمارە زنجیرەیی، لە داواکارییە گەیەنراوەکانت، یان بە سکانکردنی کۆد.',
  tabSerial: 'ژمارە زنجیرەیی',
  tabOrders: 'لە داواکارییەکانم',
  tabScan: 'سکان',
  serialLabel: 'ژمارە زنجیرەیی یان ژمارەی پسووڵە',
  serialPlaceholder: 'وەک لەسەر لەیبڵی ئامێر یان پسووڵە نووسراوە (WR-…)',
  link: 'بەستنی ئەم پرینتەرە',
  linking: 'پشکنین…',
  linkedOk: 'پرینتەرەکە بە هەژمارەکەت بەسترا.',
  alreadyLinked: 'ئەم پرینتەرە پێشتر بە هەژمارەکەت بەستراوە.',
  registerHint: 'بەستن هەرگیز بەرواری گەرەنتی ناگۆڕێت.',
  notFound: 'نەدۆزرایەوە یان پێشتر بەکارهاتووە.',
  notFoundNext: 'ژمارەکە بپشکنە، «لە داواکارییەکانم» تاقی بکەرەوە، یان پەیوەندی بە پشتگیری بکە.',
  rateLimited: 'هەوڵی زۆر — دوای چەند خولەکێک دووبارە هەوڵ بدەوە.',
  eligibleIntro: 'ئامێرە گەیەنراوەکانی داواکارییەکانت کە هێشتا بە هەژمارەکەت نەبەستراون.',
  eligibleEmpty: 'هیچ ئامێرێکی نەبەستراو لە داواکارییە گەیەنراوەکانت نییە.',
  eligibleEmptyDesc: 'هەموو پرینتەرە گەیەنراوەکانت بە هەژمارەکەت بەستراون، یان هێشتا هیچ داواکارییەک نەگەیەنراوە.',
  linkedElsewhere: 'بە هەژمارێکی دیکە بەستراوە — پێویستە ئەو هەژمارە سەرەتا بەستنەکە لاببات، یان پەیوەندی بە پشتگیری بکە.',
  linkRow: 'بەستن',
  unitN: (n) => `یەکە ${n}`,
  scanIntro: 'کۆدی QR ی سەر پسووڵەی گەرەنتی یان بارکۆدی سەر لەیبڵی ئامێر سکان بکە.',
  scanCta: 'کامێرا بکەرەوە',
  scanCaptured: 'کۆد گیرا — پشکنین…',

  scanTitle: 'سکانکردنی کۆد',
  scanStarting: 'کامێرا دەکرێتەوە…',
  scanSlow: 'هێشتا چاوەڕوانی مۆڵەتی کامێراین — دەتوانیت ژمارەکە بنووسیت یان وێنەیەک هەڵبژێریت.',
  scanLooking: 'کۆدەکە لەناو چوارچێوەکە ڕابگرە.',
  scanDenied: 'ڕێگە بە کامێرا نەدرا — لەبری ئەوە ژمارەکە بنووسە.',
  scanUnavailable: 'کامێرا لەم ئامێرە بەردەست نییە — ژمارەکە بنووسە یان وێنەیەک هەڵبژێرە.',
  scanFailed: 'کامێرا نەکرایەوە — ژمارەکە بنووسە یان وێنەیەک هەڵبژێرە.',
  scanNothing: 'هیچ کۆدێک لە وێنەکە نەدۆزرایەوە — وێنەیەکی ڕوونتر تاقی بکەرەوە یان ژمارەکە بنووسە.',
  scanDecoding: 'وێنەکە دەخوێنرێتەوە…',
  choosePhoto: 'وێنەیەک هەڵبژێرە',
  scanHint: 'کۆدی QR ی پسووڵە و بارکۆدی سەر لەیبڵی ئامێر هەردووکیان قبووڵ دەکرێن.',

  myPrinters: 'پرینتەرەکانم',
  devicesEmpty: 'هێشتا هیچ پرینتەرێک نەبەستراوە.',
  devicesEmptyDesc: 'پرینتەرەکەت بە ژمارە زنجیرەیی یان لە داواکارییە گەیەنراوەکانت زیاد بکە.',
  orderRef: 'داواکاری',
  deliveredAt: 'گەیاندن',
  warrantyEnd: 'کۆتایی گەرەنتی',
  today: 'ئەمڕۆ',
  stActive: 'گەرەنتی کارایە',
  stExpired: 'گەرەنتی بەسەرچووە',
  stNeedsConfig: 'ماوەی گەرەنتی چاوەڕوانی ڕێکخستنی فرۆشگایە',
  stNotDelivered: 'هێشتا نەگەیەنراوە',
  daysLeft: (_n, f) => `${f} ڕۆژ ماوە`,
  extendedBadge: 'گەرەنتی درێژکراوە',
  coverageSplit: (base, ext) => `${base} گەرەنتی بنەڕەتی + ${ext} درێژکردنەوەی کڕدراو`,
  transferredBadge: 'بۆ تۆ گوازراوەتەوە',
  replacedBadge: 'گۆڕدراوەتەوە',
  openClaimsBadge: (_n, f) => `${f} داواکاری کراوە`,
  openClaim: 'کردنەوەی داواکاری',
  contactSupport: 'پەیوەندی بە پشتگیری',
  receipt: 'پسووڵە',
  verifyReceipt: 'پشتڕاستکردنەوەی پسووڵە',
  printReceipt: 'چاپکردنی پسووڵە',
  viewOrder: 'داواکاری',
  more: 'زیاتر',
  removeFromAccount: 'لابردن لە هەژمارەکەم',
  unlinkTitle: 'ئەم پرینتەرە لە هەژمارەکەت لابردرێت؟',
  unlinkBody: 'پرینتەرەکە لە هەژمارەکەت دەکرێتەوە و هەژمارێکی دیکە دەتوانێت بیبەستێت. بەروارەکانی گەرەنتی ناگۆڕێن. ئەمە هەنگاوی پێش دانی پرینتەرەکە بە کەسێکی دیکەیە.',
  unlinkConfirm: 'لابردن لە هەژمارەکەم',
  unlinking: 'لابردن…',
  unlinkedOk: 'پرینتەرەکە لە هەژمارەکەت لابرا.',
  claimOpenBlock: 'پرینتەرەکە لابردرێت کاتێک داواکارییەکی کراوە لەسەریەتی. چاوەڕوانی داخستنی داواکارییەکە بکە یان پەیوەندی بە پشتگیری بکە.',

  claims: 'داواکارییەکانم',
  claimsEmpty: 'هیچ داواکارییەکی گەرەنتیت نییە.',
  claimsEmptyDesc: 'کاتێک کێشەیەک ڕوودەدات، لە کارتی پرینتەرەکە داواکاری بکەرەوە.',
  newClaimTitle: 'داواکاری گەرەنتی نوێ',
  subject: 'بابەت',
  subjectPh: 'نموونە: گەرمکەرەوەکە لە کارکەوت',
  description: 'وەسفی کێشەکە',
  descriptionPh: 'کێشەکە بە وردی باس بکە (لانیکەم ١٠ پیت)…',
  attachments: 'وێنە / ڤیدیۆ (ئارەزوومەندانە، تا ٦)',
  uploading: 'بارکردن…',
  submit: 'ناردنی داواکاری',
  submitting: 'ناردن…',
  thread: 'گفتوگۆ',
  reply: 'نامەیەک بنووسە…',
  send: 'ناردن',
  attach: 'هاوپێچکردنی فایل',
  removeAttachment: 'لابردنی هاوپێچ',
  decisionReason: 'هۆکاری بڕیار',
  adminNote: 'تێبینی تیم',
  priorityBadge: 'پێشینەی PRO',
  stageLabels: {
    received: 'وەرگیراوە',
    diagnosing: 'لە پشکنیندایە',
    approved: 'پەسەندکراوە',
    rejected: 'ڕەتکراوەتەوە',
    repairing: 'لە چاککردنەوەدایە',
    replaced: 'گۆڕدراوەتەوە',
    resolved: 'تەواوبووە',
  },
  decisionStep: 'بڕیار',
  submittedAt: 'بەرواری پێشکەشکردن',
  claimSubmitted: 'داواکارییەکە نێردرا.',
};

export const WARRANTY_STRINGS: Record<Language, WarrantyStrings> = { ar, en, ckb };
