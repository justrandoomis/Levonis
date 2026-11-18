import type { Language } from '../../../translations';
import { monthsWords, timeLeftWords } from '../../../../packages/pricing/src/warrantyTime';

/**
 * THE PAGE AND THE PRINTER CARD: the header, the notices, «طابعاتي», the cover
 * of one printer said in words (warranty, then Levo Care after it), the two
 * actions and the device's own links. One interface, three literal tables: a key
 * missing from a language is a type error. The Sorani is Sorani (DECISIONS row 183).
 */
export interface PageStrings {
  title: string;
  intro: string;
  back: string;
  proStrip: string;
  proStripLink: string;
  proTeaser: string;
  coverageNote: string;
  error: string;
  close: string;
  cancel: string;
  /** The X on a notice. */
  dismiss: string;

  // my printers
  myPrinters: string;
  devicesEmpty: string;
  devicesEmptyDesc: string;
  emptyCta: string;
  unitN: (n: number) => string;
  orderRef: string;
  deliveredAt: string;
  warrantyEnd: string;
  today: string;
  stActive: string;
  stExpired: string;
  stNeedsConfig: string;
  stNotDelivered: string;
  daysLeft: (n: number, formatted: string) => string;
  /** What is left of the cover in force, in calendar months and then days (plural-aware). */
  left: (months: number, days: number, fmt: (n: number) => string) => string;

  // the cover, in words
  /** The headline while the warranty runs. */
  coveredUntil: (date: string) => string;
  /** The headline once the warranty is over and Levo Care is the cover. */
  careOnlyUntil: (date: string) => string;
  /** The headline once every cover is over. */
  coverEnded: (date: string) => string;
  coverStarts: string;
  /** Under the timeline: one row per cover. */
  rowWarranty: string;
  rowCare: string;
  rowMonths: (months: number, fmt: (n: number) => string) => string;
  /** «+12 شهرًا بعد الضمان». */
  rowCareMonths: (months: number, fmt: (n: number) => string) => string;
  untilDate: (date: string) => string;
  endedOn: (date: string) => string;
  rowActive: string;
  rowEnded: string;
  /** The device was bought without a warranty: Levo Care is its only cover. */
  noWarranty: string;
  /** The whole cover from delivery (12 / 24 / 36 months). */
  totalCover: (months: number, fmt: (n: number) => string) => string;

  /** A purchased extension on the device, and the split under the timeline. */
  extendedBadge: string;
  coverageSplit: (base: string, ext: string) => string;
  /** Owner decision 3 (2026-10-09): a resold device's warranty runs from its FIRST delivery, never from zero. */
  continuesFrom: (date: string) => string;
  /** The ORIGINAL warranty's window, said in full when the timeline draws the used-sale period instead. */
  originalWindow: (start: string, end: string) => string;
  /** The used-sale period of a resale, in the warranty policy's own term (version 4). */
  usedSale: (months: number, end: string, fmt: (n: number) => string) => string;
  usedSaleUntil: (end: string) => string;
  historyTitle: string;
  hFirst: string;
  hTradedIn: string;
  hReturned: string;
  hResold: string;
  transferredBadge: string;
  replacedBadge: string;
  openClaimsBadge: (n: number, formatted: string) => string;

  // the card's actions
  openClaim: string;
  askCare: string;
  /** In place of the two actions while the device has an open request of the customer's own. */
  followOpen: string;
  oneOpenNote: string;
  requestsOnDevice: string;
  contactSupport: string;
  verifyReceipt: string;
  printReceipt: string;
  viewOrder: string;
  /** 0148 — «مواد الصيانة المتوافقة» with its count. */
  maintenanceParts: (n: number, formatted: string) => string;
  more: string;
  removeFromAccount: string;
  unlinkTitle: string;
  unlinkBody: string;
  unlinkConfirm: string;
  unlinking: string;
  unlinkedOk: string;
  claimOpenBlock: string;

  // how the cover works (the foot of the page)
  howTitle: string;
  howWarranty: string;
  howCare: string;
  howRequest: string;
}

const ar: PageStrings = {
  title: 'مركز الضمان',
  intro: 'طابعاتك، ما يغطيها وحتى متى، وطلباتك — في مكان واحد.',
  back: 'رجوع',
  proStrip: 'خدمة أولوية PRO — مطالباتك تُعالَج في مقدمة الطابور.',
  proStripLink: 'بطاقة العضوية',
  proTeaser: 'أعضاء PRO يحصلون على خدمة ضمان بأولوية.',
  coverageNote: 'العضوية لا تغيّر مدة الضمان أو تواريخه.',
  error: 'حدث خطأ، حاول مجددًا.',
  close: 'إغلاق',
  cancel: 'إلغاء',
  dismiss: 'إخفاء',

  myPrinters: 'طابعاتي',
  devicesEmpty: 'أضف طابعتك لتظهر تغطيتها هنا',
  devicesEmptyDesc: 'اربطها برقمها التسلسلي أو من طلباتك المُسلَّمة، ثم تابع الضمان وليفو كير وافتح طلباتك من بطاقتها.',
  emptyCta: 'أضف طابعتك الأولى',
  unitN: (n) => `وحدة ${n}`,
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
  left: (m, d, f) => `المتبقي: ${timeLeftWords({ months: m, days: d }, 'ar', f)}`,

  coveredUntil: (d) => `مغطّاة بالضمان حتى ${d}`,
  careOnlyUntil: (d) => `انتهى الضمان — ليفو كير ساري حتى ${d}`,
  coverEnded: (d) => `انتهت التغطية في ${d}`,
  coverStarts: 'تبدأ التغطية يوم استلام الطابعة',
  rowWarranty: 'الضمان',
  rowCare: 'ليفو كير',
  rowMonths: (m, f) => monthsWords(m, 'ar', f),
  rowCareMonths: (m, f) => `+${monthsWords(m, 'ar', f)} بعد الضمان`,
  untilDate: (d) => `حتى ${d}`,
  endedOn: (d) => `انتهى في ${d}`,
  rowActive: 'ساري',
  rowEnded: 'انتهى',
  noWarranty: 'اشتُريت بدون ضمان — تغطيتها ليفو كير فقط.',
  totalCover: (m, f) => `مجموع التغطية ${monthsWords(m, 'ar', f)} من يوم الاستلام`,

  extendedBadge: 'ضمان ممدد',
  coverageSplit: (base, ext) => `${base} ضمان أساسي + ${ext} تمديد مدفوع`,
  continuesFrom: (d) => `يستمر من أول تسليم في ${d}`,
  originalWindow: (st, e) => `الضمان الأصلي: من أول تسليم في ${st} حتى ${e}`,
  usedSale: (m, e, f) => `مدة بيع المستعمل: ${monthsWords(m, 'ar', f)} حتى ${e}`,
  usedSaleUntil: (e) => `مدة بيع المستعمل حتى ${e}`,
  historyTitle: 'سجلّ الجهاز',
  hFirst: 'أول تسليم',
  hTradedIn: 'استُبدل لدى Levonis',
  hReturned: 'أُعيد إلى Levonis',
  hResold: 'أُعيد بيعه',
  transferredBadge: 'منقولة إليك',
  replacedBadge: 'مُستبدَل',
  openClaimsBadge: (n, f) => (n === 1 ? 'مطالبة مفتوحة' : n === 2 ? 'مطالبتان مفتوحتان' : `${f} مطالبات مفتوحة`),

  openClaim: 'افتح طلب ضمان',
  askCare: 'اطلب خصم ليفو كير',
  followOpen: 'تابع طلبك المفتوح',
  oneOpenNote: 'لكل طابعة طلب مفتوح واحد. أكمل في محادثته، وافتح طلبًا جديدًا بعد إغلاقه.',
  requestsOnDevice: 'طلباتك على هذه الطابعة',
  contactSupport: 'تواصل مع الدعم',
  verifyReceipt: 'التحقق من الإيصال',
  printReceipt: 'طباعة الإيصال',
  viewOrder: 'الطلب',
  maintenanceParts: (_n, f) => `مواد الصيانة المتوافقة (${f})`,
  more: 'المزيد',
  removeFromAccount: 'إزالة من حسابي',
  unlinkTitle: 'إزالة هذه الطابعة من حسابك؟',
  unlinkBody: 'ستُفكّ الطابعة من حسابك ويمكن لحساب آخر ربطها. تواريخ الضمان لا تتغيّر. هذه هي الخطوة قبل تسليم الطابعة لشخص آخر.',
  unlinkConfirm: 'إزالة من حسابي',
  unlinking: 'جارٍ الإزالة…',
  unlinkedOk: 'تمت إزالة الطابعة من حسابك.',
  claimOpenBlock: 'لا يمكن إزالة الطابعة أثناء وجود مطالبة مفتوحة عليها. انتظر إغلاق المطالبة أو تواصل مع الدعم.',

  howTitle: 'كيف تعمل التغطية؟',
  howWarranty: 'الضمان: إصلاح أو استبدال مجاني للعيب المصنعي طوال مدته.',
  howCare: 'ليفو كير: 12 شهرًا بعد الضمان. ليس استبدالًا مجانيًا، بل خصم على القطعة التي تحتاجها — بعد انتهاء الضمان، أو إذا كان الضرر من الاستخدام.',
  howRequest: 'افتح الطلب من بطاقة الطابعة، وتابع الرد في محادثته. يصلك إشعار عند كل رد.',
};

const en: PageStrings = {
  title: 'Warranty Center',
  intro: 'Your printers, what covers them and until when, and your requests — in one place.',
  back: 'Back',
  proStrip: 'PRO priority service — your claims go to the front of the queue.',
  proStripLink: 'Membership card',
  proTeaser: 'PRO members get priority warranty service.',
  coverageNote: 'Membership never changes the warranty period or its dates.',
  error: 'Something went wrong, please try again.',
  close: 'Close',
  cancel: 'Cancel',
  dismiss: 'Dismiss',

  myPrinters: 'My printers',
  devicesEmpty: 'Add your printer to see its cover here',
  devicesEmptyDesc: 'Link it by serial number or from your delivered orders, then follow its warranty and Levo Care and open requests from its card.',
  emptyCta: 'Add your first printer',
  unitN: (n) => `Unit ${n}`,
  orderRef: 'Order',
  deliveredAt: 'Delivered',
  warrantyEnd: 'Warranty ends',
  today: 'Today',
  stActive: 'Warranty active',
  stExpired: 'Warranty expired',
  stNeedsConfig: 'Warranty duration awaits store configuration',
  stNotDelivered: 'Not delivered yet',
  daysLeft: (n, f) => (n === 1 ? '1 day left' : `${f} days left`),
  left: (m, d, f) => `${timeLeftWords({ months: m, days: d }, 'en', f)} left`,

  coveredUntil: (d) => `Under warranty until ${d}`,
  careOnlyUntil: (d) => `Warranty ended — Levo Care active until ${d}`,
  coverEnded: (d) => `Cover ended on ${d}`,
  coverStarts: 'Cover starts the day the printer is delivered',
  rowWarranty: 'Warranty',
  rowCare: 'Levo Care',
  rowMonths: (m, f) => monthsWords(m, 'en', f),
  rowCareMonths: (m, f) => `+${monthsWords(m, 'en', f)} after the warranty`,
  untilDate: (d) => `until ${d}`,
  endedOn: (d) => `ended on ${d}`,
  rowActive: 'Active',
  rowEnded: 'Ended',
  noWarranty: 'Bought without a warranty — Levo Care is its only cover.',
  totalCover: (m, f) => `${monthsWords(m, 'en', f)} of cover in total, from delivery`,

  extendedBadge: 'Extended warranty',
  coverageSplit: (base, ext) => `${base} base warranty + ${ext} purchased extension`,
  continuesFrom: (d) => `Continues from the first delivery on ${d}`,
  originalWindow: (st, e) => `Original warranty: from the first delivery on ${st} until ${e}`,
  usedSale: (m, e, f) => `Used-sale period: ${monthsWords(m, 'en', f)} until ${e}`,
  usedSaleUntil: (e) => `Used-sale period until ${e}`,
  historyTitle: 'Device history',
  hFirst: 'First delivered',
  hTradedIn: 'Traded in to Levonis',
  hReturned: 'Returned to Levonis',
  hResold: 'Resold',
  transferredBadge: 'Transferred to you',
  replacedBadge: 'Replaced',
  openClaimsBadge: (n, f) => (n === 1 ? '1 open claim' : `${f} open claims`),

  openClaim: 'Open a warranty request',
  askCare: 'Ask for a Levo Care discount',
  followOpen: 'Continue your open request',
  oneOpenNote: 'One open request per printer. Continue in its conversation, and open a new one once it is closed.',
  requestsOnDevice: 'Your requests on this printer',
  contactSupport: 'Contact support',
  verifyReceipt: 'Verify receipt',
  printReceipt: 'Print receipt',
  viewOrder: 'Order',
  maintenanceParts: (_n, f) => `Compatible maintenance parts (${f})`,
  more: 'More',
  removeFromAccount: 'Remove from my account',
  unlinkTitle: 'Remove this printer from your account?',
  unlinkBody: 'The printer will be unlinked from your account and another account will be able to link it. Warranty dates do not change. This is the step before handing the printer to someone else.',
  unlinkConfirm: 'Remove from my account',
  unlinking: 'Removing…',
  unlinkedOk: 'Printer removed from your account.',
  claimOpenBlock: 'The printer cannot be removed while a claim on it is open. Wait for the claim to close, or contact support.',

  howTitle: 'How does the cover work?',
  howWarranty: 'Warranty: a factory defect is repaired or replaced free for as long as it runs.',
  howCare: 'Levo Care: 12 months after the warranty. Not a free replacement — a discount on the part you need, once the warranty has ended or when the damage comes from use.',
  howRequest: 'Open the request from the printer’s card and follow the answer in its conversation. You are notified of every reply.',
};

const ckb: PageStrings = {
  title: 'ناوەندی گەرەنتی',
  intro: 'پرینتەرەکانت، چی دەیانپارێزێت و تا کەی، و داواکارییەکانت — لە یەک شوێن.',
  back: 'گەڕانەوە',
  proStrip: 'خزمەتگوزاری پێشینەی PRO — داواکارییەکانت لە پێشەوەی ڕیزەکە دەبن.',
  proStripLink: 'کارتی ئەندامێتی',
  proTeaser: 'ئەندامانی PRO خزمەتگوزاری گەرەنتی بە پێشینە وەردەگرن.',
  coverageNote: 'ئەندامێتی ماوەی گەرەنتی یان بەروارەکانی ناگۆڕێت.',
  error: 'هەڵەیەک ڕوویدا، دووبارە هەوڵبدەوە.',
  close: 'داخستن',
  cancel: 'هەڵوەشاندنەوە',
  dismiss: 'شاردنەوە',

  myPrinters: 'پرینتەرەکانم',
  devicesEmpty: 'پرینتەرەکەت زیاد بکە تا پاراستنەکەی لێرە دەربکەوێت',
  devicesEmptyDesc: 'بە ژمارە زنجیرەییەکەی یان لە داواکارییە گەیەنراوەکانت بیبەستە، پاشان گەرەنتی و لیڤۆ کێرەکەی ببینە و لە کارتەکەیەوە داواکاری بکەرەوە.',
  emptyCta: 'یەکەم پرینتەرت زیاد بکە',
  unitN: (n) => `یەکە ${n}`,
  orderRef: 'داواکاری',
  deliveredAt: 'گەیاندن',
  warrantyEnd: 'کۆتایی گەرەنتی',
  today: 'ئەمڕۆ',
  stActive: 'گەرەنتی کارایە',
  stExpired: 'گەرەنتی بەسەرچووە',
  stNeedsConfig: 'ماوەی گەرەنتی چاوەڕوانی ڕێکخستنی فرۆشگایە',
  stNotDelivered: 'هێشتا نەگەیەنراوە',
  daysLeft: (_n, f) => `${f} ڕۆژ ماوە`,
  left: (m, d, f) => `ماوە: ${timeLeftWords({ months: m, days: d }, 'ckb', f)}`,

  coveredUntil: (d) => `تا ${d} لەژێر گەرەنتیدایە`,
  careOnlyUntil: (d) => `گەرەنتی تەواو بوو — لیڤۆ کێر تا ${d} کارایە`,
  coverEnded: (d) => `پاراستنەکە لە ${d} تەواو بوو`,
  coverStarts: 'پاراستنەکە لە ڕۆژی وەرگرتنی پرینتەرەکەوە دەست پێدەکات',
  rowWarranty: 'گەرەنتی',
  rowCare: 'لیڤۆ کێر',
  rowMonths: (m, f) => monthsWords(m, 'ckb', f),
  rowCareMonths: (m, f) => `+${monthsWords(m, 'ckb', f)} دوای گەرەنتی`,
  untilDate: (d) => `تا ${d}`,
  endedOn: (d) => `لە ${d} تەواو بوو`,
  rowActive: 'کارایە',
  rowEnded: 'تەواو بوو',
  noWarranty: 'بەبێ گەرەنتی کڕدراوە — تەنها لیڤۆ کێر دەیپارێزێت.',
  totalCover: (m, f) => `کۆی پاراستن ${monthsWords(m, 'ckb', f)} لە ڕۆژی وەرگرتنەوە`,

  extendedBadge: 'گەرەنتی درێژکراوە',
  coverageSplit: (base, ext) => `${base} گەرەنتی بنەڕەتی + ${ext} درێژکردنەوەی کڕدراو`,
  continuesFrom: (d) => `لە یەکەم گەیاندنەوە لە ${d} بەردەوامە`,
  originalWindow: (st, e) => `گەرەنتیی ڕەسەن: لە یەکەم گەیاندنەوە لە ${st} تا ${e}`,
  usedSale: (m, e, f) => `ماوەی فرۆشتنی بەکارهاتوو: ${monthsWords(m, 'ckb', f)} تا ${e}`,
  usedSaleUntil: (e) => `ماوەی فرۆشتنی بەکارهاتوو تا ${e}`,
  historyTitle: 'مێژووی ئامێر',
  hFirst: 'یەکەم گەیاندن',
  hTradedIn: 'لای Levonis گۆڕدرایەوە',
  hReturned: 'گەڕێنرایەوە بۆ Levonis',
  hResold: 'دووبارە فرۆشرایەوە',
  transferredBadge: 'بۆ تۆ گوازراوەتەوە',
  replacedBadge: 'گۆڕدراوەتەوە',
  openClaimsBadge: (_n, f) => `${f} داواکاری کراوە`,

  openClaim: 'داواکاری گەرەنتی بکەرەوە',
  askCare: 'داوای داشکاندنی لیڤۆ کێر بکە',
  followOpen: 'داواکارییە کراوەکەت بەردەوام بکە',
  oneOpenNote: 'بۆ هەر پرینتەرێک یەک داواکاری کراوە هەیە. لە گفتوگۆکەیدا بەردەوام بە، و دوای داخستنی داواکارییەکی نوێ بکەرەوە.',
  requestsOnDevice: 'داواکارییەکانت لەسەر ئەم پرینتەرە',
  contactSupport: 'پەیوەندی بە پشتگیری',
  verifyReceipt: 'پشتڕاستکردنەوەی پسووڵە',
  printReceipt: 'چاپکردنی پسووڵە',
  viewOrder: 'داواکاری',
  maintenanceParts: (_n, f) => `کەرەستەی چاککردنەوەی گونجاو (${f})`,
  more: 'زیاتر',
  removeFromAccount: 'لابردن لە هەژمارەکەم',
  unlinkTitle: 'ئەم پرینتەرە لە هەژمارەکەت لابردرێت؟',
  unlinkBody: 'پرینتەرەکە لە هەژمارەکەت دەکرێتەوە و هەژمارێکی دیکە دەتوانێت بیبەستێت. بەروارەکانی گەرەنتی ناگۆڕێن. ئەمە هەنگاوی پێش دانی پرینتەرەکە بە کەسێکی دیکەیە.',
  unlinkConfirm: 'لابردن لە هەژمارەکەم',
  unlinking: 'لابردن…',
  unlinkedOk: 'پرینتەرەکە لە هەژمارەکەت لابرا.',
  claimOpenBlock: 'ناتوانرێت پرینتەرەکە لاببرێت کاتێک داواکارییەکی کراوە لەسەریەتی. چاوەڕوانی داخستنی داواکارییەکە بکە یان پەیوەندی بە پشتگیری بکە.',

  howTitle: 'پاراستنەکە چۆن کار دەکات؟',
  howWarranty: 'گەرەنتی: کەموکوڕیی کارگە بە درێژایی ماوەکەی بەخۆڕایی چاک دەکرێتەوە یان دەگۆڕدرێت.',
  howCare: 'لیڤۆ کێر: ١٢ مانگ دوای گەرەنتی. گۆڕینی بەخۆڕایی نییە، بەڵکو داشکاندنە لەسەر ئەو پارچەیەی پێویستتە — دوای تەواوبوونی گەرەنتی، یان کاتێک زیانەکە لە بەکارهێنانەوەیە.',
  howRequest: 'لە کارتی پرینتەرەکەوە داواکاری بکەرەوە و وەڵامەکە لە گفتوگۆکەیدا ببینە. بۆ هەر وەڵامێک ئاگادار دەکرێیتەوە.',
};

export const PAGE_STRINGS: Record<Language, PageStrings> = { ar, en, ckb };
