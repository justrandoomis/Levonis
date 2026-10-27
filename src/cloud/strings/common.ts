/**
 * The words of Print Cloud's shell and of the pieces every screen shares
 * (src/cloud/ui). Read through `useCloudText()` (src/cloud/text.ts).
 *
 * Each section has its own module beside this one — home.ts, printers.ts,
 * guide.ts, and the print / store / account modules their screens bring —
 * so a screen's words travel with that screen's chunk. Every slot is real
 * Arabic, English and Sorani written for this product; a Sorani slot is
 * never the Arabic one (docs/DECISIONS.md row 183, enforced by
 * tests/printCloudUiShell.test.ts).
 */
import type { Tri } from '../types';

/** The four sections and the pages every visitor may open. */
export const nav = {
  home: { ar: 'الرئيسية', en: 'Home', ckb: 'سەرەکی' },
  print: { ar: 'الطباعة', en: 'Print', ckb: 'چاپ' },
  store: { ar: 'المتجر', en: 'Store', ckb: 'فرۆشگا' },
  account: { ar: 'حسابي', en: 'Account', ckb: 'هەژمار' },
  printers: { ar: 'الطابعات', en: 'Printers', ckb: 'چاپکەرەکان' },
  howItWorks: { ar: 'كيف تعمل الخدمة', en: 'How it works', ckb: 'چۆن کار دەکات' },
  sections: { ar: 'أقسام Print Cloud', en: 'Print Cloud sections', ckb: 'بەشەکانی Print Cloud' },
  home_link: { ar: 'الصفحة الرئيسية لـ Print Cloud', en: 'Print Cloud home', ckb: 'سەرەکیی Print Cloud' },
} satisfies Record<string, Tri>;

/** The header's buttons and the wallet sheet. */
export const header = {
  wallet: { ar: 'المحفظة', en: 'Wallet', ckb: 'جزدان' },
  account: { ar: 'حسابي', en: 'My account', ckb: 'هەژمارەکەم' },
  signIn: { ar: 'تسجيل الدخول', en: 'Sign in', ckb: 'چوونە ژوورەوە' },
  walletTitle: { ar: 'محفظة Levonis', en: 'Levonis wallet', ckb: 'جزدانی Levonis' },
  walletAvailable: { ar: 'الرصيد المتاح', en: 'Available balance', ckb: 'باڵانسی بەردەست' },
  walletUse: {
    ar: 'يمكنك دفع طلبات Print Cloud من هذا الرصيد.',
    en: 'You can pay Print Cloud orders from this balance.',
    ckb: 'دەتوانیت پارەی داواکارییەکانی Print Cloud لەم باڵانسەوە بدەیت.',
  },
  walletOff: {
    ar: 'الدفع من المحفظة متوقف حاليًا. ما زال رصيدك في Levonis كما هو.',
    en: 'Wallet payments are switched off right now. Your balance on Levonis is unchanged.',
    ckb: 'پارەدان لە جزدانەوە ئێستا ڕاگیراوە. باڵانسەکەت لە Levonis وەک خۆی ماوە.',
  },
  walletRate: { ar: 'سعر الدولار الأمريكي الرسمي', en: 'Official rate of one US dollar', ckb: 'نرخی فەرمیی یەک دۆلاری ئەمریکی' },
  walletAddFunds: { ar: 'إضافة رصيد في Levonis', en: 'Add funds on Levonis', ckb: 'زیادکردنی پارە لە Levonis' },
  walletSignedOut: {
    ar: 'سجّل الدخول لترى رصيد محفظتك.',
    en: 'Sign in to see your wallet balance.',
    ckb: 'بچۆ ژوورەوە بۆ بینینی باڵانسی جزدانەکەت.',
  },
} satisfies Record<string, Tri>;

/** Whether the service is open, and what an admin's preview means. */
export const service = {
  previewBanner: { ar: 'معاينة — الخدمة مغلقة أمام العموم', en: 'Preview — closed to the public', ckb: 'پێشبینین — خزمەتگوزارییەکە بۆ گشتی داخراوە' },
  previewHint: {
    ar: 'تراها لأنك مدير المنصة. لا يصل إليها العملاء حتى يفتحها المالك.',
    en: 'You see it because you are a platform admin. Customers cannot reach it until the owner opens it.',
    ckb: 'تۆ دەیبینیت چونکە بەڕێوەبەری پلاتفۆرمیت. کڕیاران ناگەنە پێی تا خاوەنەکەی نەیکاتەوە.',
  },
  notInstalled: {
    ar: 'قاعدة البيانات لم تُجهَّز للخدمة بعد: القوائم فارغة وكل عملية تُرفض.',
    en: 'The database is not set up for the service yet: lists are empty and every action is refused.',
    ckb: 'بنکەدراوەکە هێشتا بۆ خزمەتگوزارییەکە ئامادە نەکراوە: لیستەکان بەتاڵن و هەموو کردارێک ڕەت دەکرێتەوە.',
  },
  openingSoon: { ar: 'قريبًا', en: 'Opening soon', ckb: 'بەم زووانە' },
  closedTitle: { ar: 'لم تُفتح Print Cloud بعد', en: 'Print Cloud is not open yet', ckb: 'Print Cloud هێشتا نەکراوەتەوە' },
  closedBody: {
    ar: 'نجهّز الورشة والطابعات. ستعمل هذه الصفحة عند افتتاح الخدمة.',
    en: 'We are preparing the workshop and the printers. This page will work once the service opens.',
    ckb: 'کارگە و چاپکەرەکان ئامادە دەکەین. ئەم پەڕەیە کاتێک خزمەتگوزارییەکە دەکرێتەوە کار دەکات.',
  },
  unreachableTitle: { ar: 'تعذّر الوصول إلى الخدمة', en: 'The service could not be reached', ckb: 'نەتوانرا پەیوەندی بە خزمەتگوزارییەکەوە بکرێت' },
  unreachableBody: {
    ar: 'تحقّق من اتصالك ثم أعد المحاولة.',
    en: 'Check your connection, then try again.',
    ckb: 'پەیوەندییەکەت بپشکنە، پاشان دووبارە هەوڵ بدەرەوە.',
  },
  slicerConnected: {
    ar: 'برنامج التقطيع في الورشة متصل: تصل التقديرات تلقائيًا.',
    en: 'The workshop slicer is connected: estimates arrive on their own.',
    ckb: 'بەرنامەی بڕینی کارگە پەیوەستە: خەمڵاندنەکان خۆیان دەگەن.',
  },
  slicerStale: {
    ar: 'لم يتواصل برنامج التقطيع مؤخرًا — قد يتأخر التقدير.',
    en: 'The slicer has not checked in recently — estimates may be delayed.',
    ckb: 'بەرنامەی بڕین ماوەیەکە پەیوەندی نەکردووە — لەوانەیە خەمڵاندن دوابکەوێت.',
  },
  slicerOff: {
    ar: 'برنامج التقطيع غير متصل الآن — تنتظر المهام الجديدة تقديرًا من الورشة.',
    en: 'The slicer is not connected right now — new jobs wait for an estimate from the workshop.',
    ckb: 'بەرنامەی بڕین ئێستا پەیوەست نییە — کارە نوێیەکان چاوەڕێی خەمڵاندنی کارگە دەکەن.',
  },
} satisfies Record<string, Tri>;

/** Shared verbs and states. */
export const common = {
  retry: { ar: 'إعادة المحاولة', en: 'Try again', ckb: 'دووبارە هەوڵ بدەرەوە' },
  close: { ar: 'إغلاق', en: 'Close', ckb: 'داخستن' },
  viewAll: { ar: 'عرض الكل', en: 'View all', ckb: 'هەمووی ببینە' },
  backHome: { ar: 'العودة إلى الرئيسية', en: 'Back to home', ckb: 'گەڕانەوە بۆ سەرەکی' },
  loading: { ar: 'جارٍ التحميل…', en: 'Loading…', ckb: 'بار دەکرێت…' },
  errorTitle: { ar: 'تعذّر التحميل', en: 'Could not load', ckb: 'بار نەکرا' },
  networkTitle: { ar: 'لا يوجد اتصال', en: 'No connection', ckb: 'پەیوەندی نییە' },
  networkBody: {
    ar: 'تحقّق من اتصالك بالإنترنت ثم أعد المحاولة.',
    en: 'Check your internet connection and try again.',
    ckb: 'پەیوەندیت بە ئینتەرنێتەوە بپشکنە و دووبارە هەوڵ بدەرەوە.',
  },
  unknownError: { ar: 'حدث خطأ غير متوقع.', en: 'Something went wrong.', ckb: 'هەڵەیەکی چاوەڕواننەکراو ڕوویدا.' },
  signInTitle: { ar: 'سجّل الدخول للمتابعة', en: 'Sign in to continue', ckb: 'بچۆ ژوورەوە بۆ بەردەوامبوون' },
  signInBody: {
    ar: 'هذه الصفحة لحسابك في Levonis. سننقلك إلى صفحة الدخول ثم نعيدك إلى هنا.',
    en: 'This page belongs to your Levonis account. We will take you to sign in and bring you back here.',
    ckb: 'ئەم پەڕەیە پەیوەستە بە هەژمارەکەتەوە لە Levonis. دەتبەینە پەڕەی چوونەژوورەوە و دواتر دەتگەڕێنینەوە ئێرە.',
  },
  notFoundTitle: { ar: 'هذه الصفحة غير موجودة', en: 'This page does not exist', ckb: 'ئەم پەڕەیە بوونی نییە' },
  notFoundBody: {
    ar: 'ربما تغيّر الرابط أو كُتب خطأ.',
    en: 'The link may have changed or been mistyped.',
    ckb: 'لەوانەیە بەستەرەکە گۆڕابێت یان بە هەڵە نووسرابێت.',
  },
  estimate: { ar: 'تقدير', en: 'Estimate', ckb: 'خەمڵاندن' },
  yes: { ar: 'نعم', en: 'Yes', ckb: 'بەڵێ' },
  no: { ar: 'لا', en: 'No', ckb: 'نەخێر' },
} satisfies Record<string, Tri>;

/**
 * A print job's state as the customer reads it (worker/lib/printCloud/jobs.ts
 * JOB_STATUSES), plus the one state the server expresses another way: a job
 * that is analysing with no estimate yet is «awaiting estimate».
 */
export const jobStatus = {
  draft: { ar: 'مسودة', en: 'Draft', ckb: 'ڕەشنووس' },
  uploaded: { ar: 'بانتظار التحليل', en: 'Waiting for analysis', ckb: 'چاوەڕێی شیکاری' },
  analyzing: { ar: 'قيد التحليل', en: 'Analysing', ckb: 'شیکار دەکرێت' },
  awaiting_estimate: { ar: 'بانتظار التقدير', en: 'Awaiting estimate', ckb: 'چاوەڕێی خەمڵاندن' },
  ready: { ar: 'التقدير جاهز', en: 'Estimate ready', ckb: 'خەمڵاندن ئامادەیە' },
  awaiting_confirmation: { ar: 'بانتظار تأكيدك', en: 'Awaiting your confirmation', ckb: 'چاوەڕێی پشتڕاستکردنەوەی تۆ' },
  confirmed: { ar: 'بانتظار موافقة الورشة', en: 'Awaiting workshop approval', ckb: 'چاوەڕێی ڕەزامەندیی کارگە' },
  queued: { ar: 'في قائمة الانتظار', en: 'Queued', ckb: 'لە ڕیزدایە' },
  preparing: { ar: 'قيد التحضير', en: 'Preparing', ckb: 'ئامادە دەکرێت' },
  printing: { ar: 'تُطبع الآن', en: 'Printing now', ckb: 'ئێستا چاپ دەکرێت' },
  paused: { ar: 'متوقفة مؤقتًا', en: 'Paused', ckb: 'ڕاگیراوە' },
  completed: { ar: 'اكتملت', en: 'Completed', ckb: 'تەواو بوو' },
  failed: { ar: 'تعذّرت', en: 'Failed', ckb: 'سەرکەوتوو نەبوو' },
  cancelled: { ar: 'أُلغيت', en: 'Cancelled', ckb: 'هەڵوەشێنرایەوە' },
  reprint_requested: { ar: 'أُعيدت جدولتها', en: 'Reprint scheduled', ckb: 'چاپکردنەوە ڕێکخرا' },
} satisfies Record<string, Tri>;

/**
 * A printer's state, from what the server reported — never an assumption:
 * `stale` is a last reading older than the window, `offline` a machine its
 * agent cannot reach, `unknown` a printer that never reported.
 */
export const printerStatus = {
  live: { ar: 'مباشر', en: 'Live', ckb: 'ڕاستەوخۆ' },
  stale: { ar: 'آخر قراءة قديمة', en: 'Last report is old', ckb: 'دوایین ڕاپۆرت کۆنە' },
  offline: { ar: 'غير متصلة', en: 'Offline', ckb: 'پەیوەندی پچڕاوە' },
  idle: { ar: 'خاملة', en: 'Idle', ckb: 'بێکار' },
  preparing: { ar: 'تتحضّر', en: 'Preparing', ckb: 'ئامادە دەبێت' },
  printing: { ar: 'تطبع', en: 'Printing', ckb: 'چاپ دەکات' },
  paused: { ar: 'متوقفة مؤقتًا', en: 'Paused', ckb: 'ڕاگیراوە' },
  finished: { ar: 'أنهت الطباعة', en: 'Finished', ckb: 'تەواوی کرد' },
  error: { ar: 'خطأ في الطابعة', en: 'Printer error', ckb: 'هەڵەی چاپکەر' },
  maintenance: { ar: 'في الصيانة', en: 'In maintenance', ckb: 'لە چاککردنەوەدایە' },
  available: { ar: 'متاحة الآن', en: 'Free now', ckb: 'ئێستا بەتاڵە' },
  notFree: { ar: 'غير متاحة الآن', en: 'Not free right now', ckb: 'ئێستا بەتاڵ نییە' },
  noMachine: { ar: 'لا آلة في الخدمة', en: 'No machine in service', ckb: 'هیچ ئامێرێک لە کاردا نییە' },
  unknown: { ar: 'لا بيانات', en: 'No data', ckb: 'زانیاری نییە' },
} satisfies Record<string, Tri>;
