/**
 * THE ORDER TIMELINE'S WORDS — Arabic, English and hand-written Sorani, every
 * key in all three (docs/COMMUNITY_ECOSYSTEM.md D6, §9.5 Client 5d).
 *
 * One table for the spine, the workshop's composer, the customer's «اطلب
 * تعديلًا» and the cancel / dispute doors (./OrderTimeline.tsx), and for the
 * two words the customer's order row draws before that chunk is fetched
 * (src/pages/Requests.tsx MyCommunityOrders: the row's button and the sheet's
 * title). It is its own small module ON PURPOSE: the request page's table
 * (./strings.ts, ~13 KB gzip) would otherwise ride into the /requests chunk
 * and the merchant's custom-order screen for two words; ./strings.ts
 * re-exports this table so the request page reads it from its usual door.
 *
 * The server sends kinds and roles, never copy: an event is worded here by
 * its `kind`, its actor by its role — «أنت» for the reader's own side.
 */
import { useLanguage } from '../../../LanguageContext';

export type TimelineLang = 'ar' | 'en' | 'ckb';

const ar = {
  title: 'سير التنفيذ',
  open: 'تابع التنفيذ',
  empty: 'لا أحداث على الطلب بعد.',
  /** The read carries the newest 200 updates (worker TIMELINE_UPDATES_MAX); said when older ones exist. */
  older: 'تظهر هنا أحدث 200 تحديث، والأقدم منها محفوظ على الطلب.',
  you: 'أنت',
  actor: {
    customer: 'الزبون',
    merchant: 'الورشة',
    admin: 'إدارة Levonis',
    system: 'تلقائيًا',
  },
  amount: 'المبلغ',
  readyMark: 'جاهز',
  openPhoto: 'افتح الصورة',
  photoAlt: 'صورة من الورشة',
  event: {
    created: 'أُنشئ الطلب',
    funded: 'حُجز المبلغ لدى Levonis',
    started: 'بدأ العمل',
    progress: 'تحديث على العمل',
    photo: 'صورة من الورشة',
    ready: 'القطعة جاهزة',
    note: 'ملاحظة',
    modification_request: 'طلب تعديل',
    delivered: 'سُلِّم العمل',
    confirmed: 'تأكّد الاستلام',
    released: 'حُوِّل المبلغ إلى الورشة',
    refunded: 'أُعيد المبلغ',
    dispute: 'فُتح نزاع',
    dispute_resolved: 'حُسم النزاع',
    cancelled: 'أُلغي الطلب',
    completed: 'اكتمل الطلب',
    other: 'حدث على الطلب',
  },
  composer: {
    title: 'أخبر الزبون',
    kindLabel: 'نوع التحديث',
    kindProgress: 'تقدّم',
    kindNote: 'ملاحظة',
    placeholder: 'ما الذي أُنجز؟ ما الذي بقي؟',
    send: 'أرسل',
    photo: 'صورة',
    ready: 'جاهز',
    readyTitle: 'القطعة جاهزة؟',
    readyConsequence: 'يُبلَّغ الزبون أن القطعة جاهزة. لا يتحرك المبلغ ولا حالة الطلب — التسليم خطوة بعدها.',
    readyConfirm: 'نعم، جاهزة',
    notNow: 'ليس الآن',
    sent: 'وصل التحديث إلى الزبون.',
    failed: 'تعذّر إرسال التحديث.',
  },
  change: {
    ask: 'اطلب تعديلًا',
    hint: 'اكتب ما تريد تغييره. تصل رسالتك إلى الورشة وتبقى في سجل الطلب.',
    placeholder: 'مثل: اجعل اللون أغمق قليلًا',
    send: 'أرسل الطلب',
    sent: 'وصل طلبك إلى الورشة.',
  },
  actions: {
    cancel: 'إلغاء الطلب',
    cancelTitle: 'إلغاء هذا الطلب؟',
    cancelMerchant: 'يُلغى الطلب قبل بدء العمل، ويعود المبلغ المحجوز كاملًا إلى الزبون.',
    cancelCustomer: 'يُلغى الطلب قبل أن تبدأ الورشة، ويعود المبلغ المحجوز إلى رصيدك.',
    keep: 'أبقِ الطلب',
    dispute: 'فتح نزاع',
    disputeHint: 'صِف المشكلة (10 أحرف على الأقل). يُجمَّد المبلغ حتى تفصل إدارة Levonis.',
    disputeSend: 'افتح النزاع',
    disputeReady: 'الوصف كافٍ — يمكنك فتح النزاع الآن.',
    back: 'رجوع',
    failed: 'تعذّر إتمام العملية.',
  },
};

export type TimelineStrings = typeof ar;

const en: TimelineStrings = {
  title: 'Order progress',
  open: 'Follow the work',
  empty: 'Nothing has happened on this order yet.',
  older: 'The newest 200 updates are shown here; older ones stay on the order.',
  you: 'You',
  actor: {
    customer: 'The customer',
    merchant: 'The workshop',
    admin: 'Levonis staff',
    system: 'Automatically',
  },
  amount: 'Amount',
  readyMark: 'Ready',
  openPhoto: 'Open the photo',
  photoAlt: 'A photo from the workshop',
  event: {
    created: 'Order created',
    funded: 'Payment held by Levonis',
    started: 'Work started',
    progress: 'Progress update',
    photo: 'Photo from the workshop',
    ready: 'The piece is ready',
    note: 'Note',
    modification_request: 'Change requested',
    delivered: 'Marked delivered',
    confirmed: 'Receipt confirmed',
    released: 'Payment released to the workshop',
    refunded: 'Payment refunded',
    dispute: 'Dispute opened',
    dispute_resolved: 'Dispute resolved',
    cancelled: 'Order cancelled',
    completed: 'Order completed',
    other: 'Order event',
  },
  composer: {
    title: 'Update the customer',
    kindLabel: 'Kind of update',
    kindProgress: 'Progress',
    kindNote: 'Note',
    placeholder: 'What is done? What is left?',
    send: 'Send',
    photo: 'Photo',
    ready: 'Ready',
    readyTitle: 'Is the piece ready?',
    readyConsequence: 'The customer is told the piece is ready. Neither the money nor the order’s state moves — delivery is the next step.',
    readyConfirm: 'Yes, it is ready',
    notNow: 'Not now',
    sent: 'The customer has your update.',
    failed: 'Could not send the update.',
  },
  change: {
    ask: 'Ask for a change',
    hint: 'Write what you would like changed. The workshop gets it, and it stays on the order’s record.',
    placeholder: 'e.g. make the colour a little darker',
    send: 'Send the request',
    sent: 'The workshop has your request.',
  },
  actions: {
    cancel: 'Cancel the order',
    cancelTitle: 'Cancel this order?',
    cancelMerchant: 'The order is cancelled before work starts, and the held money goes back to the customer in full.',
    cancelCustomer: 'The order is cancelled before the workshop starts, and the held money returns to your balance.',
    keep: 'Keep the order',
    dispute: 'Open a dispute',
    disputeHint: 'Describe the problem (at least 10 characters). The money is frozen until Levonis decides.',
    disputeSend: 'Open the dispute',
    disputeReady: 'That is enough — you can open the dispute now.',
    back: 'Back',
    failed: 'Could not complete that.',
  },
};

const ckb: TimelineStrings = {
  title: 'ڕەوتی جێبەجێکردن',
  open: 'بەدواداچوونی کارەکە',
  empty: 'هێشتا هیچ شتێک لەسەر ئەم داواکاریە ڕووی نەداوە.',
  older: 'نوێترین 200 نوێکردنەوە لێرە دەردەکەون، کۆنەکانیش لەسەر داواکاریەکە پارێزراون.',
  you: 'تۆ',
  actor: {
    customer: 'کڕیارەکە',
    merchant: 'وۆرکشۆپەکە',
    admin: 'بەڕێوەبەرایەتی Levonis',
    system: 'بە شێوەی خۆکار',
  },
  amount: 'بڕی پارە',
  readyMark: 'ئامادەیە',
  openPhoto: 'وێنەکە بکەرەوە',
  photoAlt: 'وێنەیەک لە وۆرکشۆپەکەوە',
  event: {
    created: 'داواکاریەکە دروست کرا',
    funded: 'پارەکە لای Levonis ڕاگیرا',
    started: 'کارەکە دەستی پێکرد',
    progress: 'نوێکردنەوەی کارەکە',
    photo: 'وێنەیەک لە وۆرکشۆپەکەوە',
    ready: 'پارچەکە ئامادەیە',
    note: 'تێبینی',
    modification_request: 'داوای گۆڕانکاری',
    delivered: 'کارەکە ڕادەست کرا',
    confirmed: 'وەرگرتن پشتڕاست کرایەوە',
    released: 'پارەکە درایە وۆرکشۆپەکە',
    refunded: 'پارەکە گەڕێندرایەوە',
    dispute: 'ناکۆکی کرایەوە',
    dispute_resolved: 'ناکۆکیەکە یەکلا کرایەوە',
    cancelled: 'داواکاریەکە هەڵوەشێنرایەوە',
    completed: 'داواکاریەکە تەواو بوو',
    other: 'ڕووداوێک لەسەر داواکاریەکە',
  },
  composer: {
    title: 'کڕیارەکە ئاگادار بکەرەوە',
    kindLabel: 'جۆری نوێکردنەوە',
    kindProgress: 'پێشکەوتن',
    kindNote: 'تێبینی',
    placeholder: 'چی تەواو بووە؟ چی ماوە؟',
    send: 'بنێرە',
    photo: 'وێنە',
    ready: 'ئامادەیە',
    readyTitle: 'پارچەکە ئامادەیە؟',
    readyConsequence: 'کڕیارەکە ئاگادار دەکرێتەوە کە پارچەکە ئامادەیە. نە پارەکە دەجوڵێت نە دۆخی داواکاریەکە — ڕادەستکردن هەنگاوی دواترە.',
    readyConfirm: 'بەڵێ، ئامادەیە',
    notNow: 'ئێستا نا',
    sent: 'نوێکردنەوەکە گەیشتە کڕیارەکە.',
    failed: 'نەتوانرا نوێکردنەوەکە بنێردرێت.',
  },
  change: {
    ask: 'داوای گۆڕانکاری بکە',
    hint: 'بنووسە چیت دەوێت بگۆڕدرێت. نامەکەت دەگاتە وۆرکشۆپەکە و لە تۆماری داواکاریەکەدا دەمێنێتەوە.',
    placeholder: 'بۆ نموونە: ڕەنگەکە کەمێک تۆختر بکە',
    send: 'داواکاریەکە بنێرە',
    sent: 'داواکاریەکەت گەیشتە وۆرکشۆپەکە.',
  },
  actions: {
    cancel: 'داواکاریەکە هەڵبوەشێنەوە',
    cancelTitle: 'ئەم داواکاریە هەڵبوەشێنرێتەوە؟',
    cancelMerchant: 'داواکاریەکە پێش دەستپێکردنی کار هەڵدەوەشێتەوە و پارە ڕاگیراوەکە بە تەواوی دەگەڕێتەوە بۆ کڕیارەکە.',
    cancelCustomer: 'داواکاریەکە پێش دەستپێکردنی وۆرکشۆپەکە هەڵدەوەشێتەوە و پارە ڕاگیراوەکە دەگەڕێتەوە بۆ باڵانسەکەت.',
    keep: 'داواکاریەکە بهێڵەرەوە',
    dispute: 'ناکۆکی بکەرەوە',
    disputeHint: 'کێشەکە باس بکە (لانیکەم 10 پیت). پارەکە دەبەسترێت تا بەڕێوەبەرایەتی Levonis بڕیار دەدات.',
    disputeSend: 'ناکۆکیەکە بکەرەوە',
    disputeReady: 'بەسە — ئێستا دەتوانیت ناکۆکیەکە بکەیتەوە.',
    back: 'گەڕانەوە',
    failed: 'نەتوانرا تەواو بکرێت.',
  },
};

export const TIMELINE_STRINGS: Record<TimelineLang, TimelineStrings> = { ar, en, ckb };

export function timelineLang(lang: string): TimelineLang {
  return lang === 'en' || lang === 'ckb' ? lang : 'ar';
}

export function timelineStrings(lang: string): TimelineStrings {
  return TIMELINE_STRINGS[timelineLang(lang)];
}

export function useTimelineStrings(): TimelineStrings {
  const { lang } = useLanguage();
  return timelineStrings(lang);
}

/**
 * «پێش 3 کاتژمێر» — WHEN, IN SORANI: the shared rule (hub/copy.ts `soraniAgo`,
 * which `timeAgo` itself now uses for a Sorani reader), re-exported so the
 * timeline and everything beside it print one sentence with one rounding.
 */
export { soraniAgo } from '../hub/copy';
