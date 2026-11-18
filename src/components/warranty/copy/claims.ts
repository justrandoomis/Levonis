import type { Language } from '../../../translations';

/**
 * THE REQUESTS: «مطالباتي», the form that opens one (with the choice between a
 * warranty fault and a Levo Care discount, DECISIONS row 358 D8), and the
 * conversation. The Sorani is Sorani of its own, never the Arabic (row 183).
 */
export interface ClaimStrings {
  claims: string;
  claimsEmpty: string;
  claimsEmptyDesc: string;
  newClaimTitle: string;
  /** D8: what the request is for — shown only on a device with Levo Care in force. */
  kindLegend: string;
  kindWarranty: string;
  kindWarrantySub: string;
  kindCare: string;
  kindCareSub: string;
  subject: string;
  subjectPh: string;
  description: string;
  descriptionPh: string;
  attachments: string;
  /** What warranty policy 5.7 asks a claim to carry — said plainly instead of «optional». */
  evidenceHint: string;
  /** The upload limits the route enforces (8 MB an image, 40 MB a video). */
  evidenceLimits: string;
  uploading: string;
  submit: string;
  submitCare: string;
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
  claimSubmitted: string;
  /** A Levo Care request went in: the team answers with the part at its discount, in the conversation. */
  careSubmitted: string;
  /** The retried submit landed on the claim already recorded (`replay: true`):
   *  its edits were NOT saved, and the thread is where to add them. */
  claimReplayNotice: string;
  /** One line under «مطالباتي»: tapping a claim opens its conversation. */
  claimsHint: string;
  /** The row on every claim card that says it is a door to a conversation. */
  openThread: string;
  messagesCount: (n: number, formatted: string) => string;
  /** The warranty team wrote since the customer last looked. */
  newReply: string;
  /** One line at the top of the thread: who is on the other side. */
  threadIntro: string;
  /** In place of the reply box once the claim is closed (rejected, replaced or resolved). */
  threadClosed: string;
  /** W-1 (row 237): the cover the claim was FILED under, as its INSERT recorded it (policy 5.16). */
  filedInCover: (end: string) => string;
  filedInUsedSale: (end: string) => string;
  filedOutOfCover: string;
  /** W-3: the device already has an open claim of the caller's own — open that one instead. */
  openThatClaim: string;
}

const ar: ClaimStrings = {
  claims: 'مطالباتي',
  claimsEmpty: 'ليس لديك أي مطالبات ضمان.',
  claimsEmptyDesc: 'افتح طلبًا من بطاقة الطابعة عند حدوث مشكلة.',
  newClaimTitle: 'طلب جديد',
  kindLegend: 'ما الذي تطلبه؟',
  kindWarranty: 'عطل يغطيه الضمان',
  kindWarrantySub: 'إصلاح أو استبدال مجاني للعيب المصنعي ما دام الضمان ساريًا.',
  kindCare: 'ليفو كير — خصم على القطع',
  kindCareSub: 'خصم على القطعة التي تحتاجها، إذا انتهى الضمان أو كان الضرر من الاستخدام.',
  subject: 'الموضوع',
  subjectPh: 'مثال: توقّف السخان عن العمل',
  description: 'وصف المشكلة',
  descriptionPh: 'صف المشكلة بالتفصيل (10 أحرف على الأقل)…',
  attachments: 'الصور والفيديو (حتى 6 ملفات)',
  evidenceHint:
    'لقبول المطالبة تطلب سياسة الضمان (المادة 5.7): صورة للطابعة كاملة، وصورة للقطعة المعطلة، وصورة لملصق الرقم التسلسلي، وفيديو قصيرًا يُظهر العطل وقت حدوثه. ما لا ترفقه الآن أرسله لاحقًا في محادثة المطالبة.',
  evidenceLimits: 'الصورة حتى 8 ميغابايت والفيديو حتى 40 ميغابايت — صوّر لحظة حدوث العطل فقط.',
  uploading: 'جارٍ الرفع…',
  submit: 'إرسال المطالبة',
  submitCare: 'إرسال طلب ليفو كير',
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
  claimSubmitted: 'تم إرسال المطالبة. محادثتها مع فريق الضمان على بطاقة الطابعة وفي «مطالباتي» أدناه — اضغط عليها لفتحها، ويصلك إشعار عند كل رد.',
  careSubmitted: 'تم إرسال طلب ليفو كير. يرسل لك الفريق القطعة بخصمها في محادثة الطلب، فتضيفها إلى السلة وتطلبها كأي قطعة. يصلك إشعار عند الرد.',
  claimReplayNotice: 'هذه المطالبة مسجّلة من قبل، ولم تُحفظ تعديلاتك الأخيرة عليها. أضف الصور أو التصحيح في المحادثة المفتوحة الآن.',
  claimsHint: 'اضغط على المطالبة لفتح المحادثة مع فريق الضمان — هناك تصلك ردودهم، ومنها ترسل الصور والتوضيحات.',
  openThread: 'فتح المحادثة',
  messagesCount: (n, f) => {
    if (n === 0) return 'لا توجد رسائل بعد';
    if (n === 1) return 'رسالة واحدة';
    if (n === 2) return 'رسالتان';
    if (n >= 3 && n <= 10) return `${f} رسائل`;
    return `${f} رسالة`;
  },
  newReply: 'رد جديد من الفريق',
  threadIntro: 'هنا تتحدث مع فريق الضمان، ويصلك إشعار عند كل رد منهم.',
  threadClosed: 'هذه المطالبة مغلقة، فلا تُضاف إليها رسائل. إن عادت المشكلة فافتح مطالبة جديدة من بطاقة الطابعة.',
  filedInCover: (end) => `قُدِّم الطلب والجهاز ضمن الضمان (حتى ${end})`,
  filedInUsedSale: (end) => `قُدِّم الطلب ضمن مدة بيع المستعمل (حتى ${end})`,
  filedOutOfCover: 'قُدِّم الطلب بعد انتهاء الضمان',
  openThatClaim: 'افتح المطالبة المفتوحة',
};

const en: ClaimStrings = {
  claims: 'My claims',
  claimsEmpty: 'You do not have any warranty claims.',
  claimsEmptyDesc: 'Open a request from a printer’s card when something goes wrong.',
  newClaimTitle: 'New request',
  kindLegend: 'What are you asking for?',
  kindWarranty: 'A fault the warranty covers',
  kindWarrantySub: 'A factory defect repaired or replaced free while the warranty runs.',
  kindCare: 'Levo Care — a discount on parts',
  kindCareSub: 'A discount on the part you need, when the warranty has ended or the damage comes from use.',
  subject: 'Subject',
  subjectPh: 'e.g. Heater stopped working',
  description: 'Problem description',
  descriptionPh: 'Describe the issue in detail (at least 10 characters)…',
  attachments: 'Photos and video (up to 6 files)',
  evidenceHint:
    'To accept a claim, the warranty policy (article 5.7) asks for a photo of the whole printer, a photo of the faulty part, a photo of the serial-number label, and a short video showing the fault as it happens. Anything you do not attach now can be sent later in the claim’s conversation.',
  evidenceLimits: 'Images up to 8 MB, video up to 40 MB — film only the moment the fault happens.',
  uploading: 'Uploading…',
  submit: 'Submit claim',
  submitCare: 'Send the Levo Care request',
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
  claimSubmitted: 'Claim submitted. Its conversation with the warranty team is on the printer’s card and under “My claims” below — tap it to open; you will be notified of every reply.',
  careSubmitted: 'Levo Care request sent. The team sends you the part at its discount in the request’s conversation; you add it to the cart and order it like any part. You will be notified of the reply.',
  claimReplayNotice: 'This claim was already recorded, and your latest edits were not saved to it. Add the photos or the correction in the conversation now open.',
  claimsHint: 'Tap a claim to open its conversation with the warranty team — their replies arrive there, and you can send photos and details from it.',
  openThread: 'Open conversation',
  messagesCount: (n, f) => (n === 0 ? 'No messages yet' : n === 1 ? '1 message' : `${f} messages`),
  newReply: 'New reply from the team',
  threadIntro: 'This is your conversation with the warranty team; you are notified of every reply.',
  threadClosed: 'This claim is closed, so no more messages can be added. If the problem comes back, open a new claim from the printer’s card.',
  filedInCover: (end) => `Filed within the warranty (until ${end})`,
  filedInUsedSale: (end) => `Filed within the used-sale period (until ${end})`,
  filedOutOfCover: 'Filed after the warranty had ended',
  openThatClaim: 'Open that claim',
};

const ckb: ClaimStrings = {
  claims: 'داواکارییەکانم',
  claimsEmpty: 'هیچ داواکارییەکی گەرەنتیت نییە.',
  claimsEmptyDesc: 'کاتێک کێشەیەک ڕوودەدات، لە کارتی پرینتەرەکە داواکاری بکەرەوە.',
  newClaimTitle: 'داواکاریی نوێ',
  kindLegend: 'داوای چی دەکەیت؟',
  kindWarranty: 'تێکچوونێک کە گەرەنتی دەیگرێتەوە',
  kindWarrantySub: 'چاککردنەوە یان گۆڕینی بەخۆڕایی بۆ کەموکوڕیی کارگە تا گەرەنتی کارا بێت.',
  kindCare: 'لیڤۆ کێر — داشکاندن لەسەر پارچە',
  kindCareSub: 'داشکاندن لەسەر ئەو پارچەیەی پێویستتە، کاتێک گەرەنتی تەواو بووە یان زیانەکە لە بەکارهێنانەوەیە.',
  subject: 'بابەت',
  subjectPh: 'نموونە: گەرمکەرەوەکە لە کارکەوت',
  description: 'وەسفی کێشەکە',
  descriptionPh: 'کێشەکە بە وردی باس بکە (لانیکەم ١٠ پیت)…',
  attachments: 'وێنە و ڤیدیۆ (تا ٦ فایل)',
  evidenceHint:
    'بۆ وەرگرتنی داواکاری، سیاسەتی گەرەنتی (ماددەی 5.7) ئەمانە داوا دەکات: وێنەیەکی هەموو پرینتەرەکە، وێنەیەکی پارچە تێکچووەکە، وێنەیەکی لەیبڵی ژمارە زنجیرەییەکە، و ڤیدیۆیەکی کورت کە تێکچوونەکە لە کاتی ڕوودانیدا نیشان بدات. ئەوەی ئێستا هاوپێچی ناکەیت، دواتر لە گفتوگۆی داواکارییەکەدا بینێرە.',
  evidenceLimits: 'وێنە تا ٨ میگابایت و ڤیدیۆ تا ٤٠ میگابایت — تەنها ئەو ساتە تۆمار بکە کە تێکچوونەکە ڕوودەدات.',
  uploading: 'بارکردن…',
  submit: 'ناردنی داواکاری',
  submitCare: 'ناردنی داواکاریی لیڤۆ کێر',
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
  // Sorani of its own, never the Arabic (DECISIONS row 183): the sentences
  // that say where the claim's conversation lives, written with this table's
  // own words («داواکارییەکانم», «گفتوگۆ», «تیمی گەرەنتی»).
  claimSubmitted: 'داواکارییەکە نێردرا. گفتوگۆکەی لەگەڵ تیمی گەرەنتی لەسەر کارتی پرینتەرەکە و لە «داواکارییەکانم» لە خوارەوەیە — کرتەی لێ بکە بۆ کردنەوەی، و بۆ هەر وەڵامێک ئاگادار دەکرێیتەوە.',
  careSubmitted: 'داواکاریی لیڤۆ کێر نێردرا. تیمەکە پارچەکە بە داشکاندنەکەیەوە لە گفتوگۆی داواکارییەکەدا بۆت دەنێرێت؛ دەیخەیتە سەبەتەوە و وەک هەر پارچەیەک داوای دەکەیت. کاتێک وەڵام دێت ئاگادار دەکرێیتەوە.',
  claimReplayNotice: 'ئەم داواکارییە پێشتر تۆمارکراوە، و دوایین گۆڕانکارییەکانت تێیدا پاشەکەوت نەکران. وێنەکان یان ڕاستکردنەوەکە لەو گفتوگۆیەی ئێستا کراوەیە زیاد بکە.',
  claimsHint: 'کرتە لە داواکارییەک بکە بۆ کردنەوەی گفتوگۆکەی لەگەڵ تیمی گەرەنتی — وەڵامەکانیان لەوێ دەگات، و دەتوانیت وێنە و ڕوونکردنەوە لەوێوە بنێریت.',
  openThread: 'کردنەوەی گفتوگۆ',
  // Zero says «no messages yet» rather than «0 نامە».
  messagesCount: (n, f) => (n === 0 ? 'هێشتا هیچ نامەیەک نییە' : `${f} نامە`),
  newReply: 'وەڵامی نوێ',
  threadIntro: 'ئێرە گفتوگۆی تۆیە لەگەڵ تیمی گەرەنتی؛ بۆ هەر وەڵامێکیان ئاگادار دەکرێیتەوە.',
  threadClosed: 'ئەم داواکارییە داخراوە، بۆیە نامەی تر زیاد ناکرێت. ئەگەر کێشەکە گەڕایەوە، لە کارتی پرینتەرەکەوە داواکارییەکی نوێ بکەرەوە.',
  filedInCover: (end) => `داواکارییەکە لە ماوەی گەرەنتیدا پێشکەشکرا (تا ${end})`,
  filedInUsedSale: (end) => `داواکارییەکە لە ماوەی فرۆشتنی بەکارهاتوودا پێشکەشکرا (تا ${end})`,
  filedOutOfCover: 'داواکارییەکە دوای تەواوبوونی گەرەنتی پێشکەشکرا',
  openThatClaim: 'داواکارییە کراوەکە بکەرەوە',
};

export const CLAIM_STRINGS: Record<Language, ClaimStrings> = { ar, en, ckb };
