/**
 * THE MODERATION DESK'S WORDS — Arabic, English and written Sorani, every key
 * in all three (docs/COMMUNITY_ECOSYSTEM.md D6, §9.6 Moderation V2).
 *
 *   the desk       «الإشراف» in the community admin: the report queue, the
 *                  thing each report names, the account ladder, hiding
 *                  content, the history of one target, the appeals
 *                  (./ModerationDesk.tsx and its parts);
 *
 * The dispute desk's «المحادثة» / «الطلب» and the chat's evidence banner have
 * their own small table (./evidenceStrings.ts): they ride in the community
 * admin's chunk and the chat's, which must not carry the whole desk.
 *
 * The desk's refusals (MODERATION_LADDER, APPEAL_DECIDED …) are worded by
 * src/lib/refusalStrings.ts. The report reasons repeat the reporter's own
 * words (src/components/community/social/strings.ts `reportReasons`) so the
 * desk reads a report as it was filed.
 */
import { useLanguage } from '../../../LanguageContext';
import type { AppealState, LadderStep, ModerationAction, ModerationTargetType, ReportKind, ReportReason, ReportState, UserStatus } from './api';

export type DeskLang = 'ar' | 'en' | 'ckb';

export function deskLang(lang: string): DeskLang {
  return lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
}

/** A day and an hour the reader's calendar writes; ISO when the engine lacks the locale. */
export function deskDate(iso: string | null | undefined, lang: DeskLang, withTime = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    // Sorani where the engine has its calendar names, else the Arabic ones —
    // Latin digits either way, as every date in the app is written.
    const locale = lang === 'en' ? 'en-GB' : lang === 'ckb' ? ['ckb-IQ-u-nu-latn', 'ar-IQ-u-nu-latn'] : 'ar-IQ-u-nu-latn';
    return new Intl.DateTimeFormat(locale, withTime ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
  } catch {
    return d.toISOString().slice(0, withTime ? 16 : 10).replace('T', ' ');
  }
}

export interface DeskStrings {
  title: string;
  intro: string;
  views: { reports: string; appeals: string };
  viewsLabel: string;
  reportStates: Record<ReportState | 'all', string>;
  stateLabel: string;
  typeLabel: string;
  anyType: string;
  kinds: Record<ReportKind, string>;
  reasons: Record<ReportReason, string>;
  reporter: string;
  onTarget: (all: number, open: number) => string;
  details: string;
  resolution: string;
  gone: string;
  hidden: string;
  attachment: string;
  staff: string;
  roles: { author: string; account: string; owner: string; customer: string };
  statuses: Record<UserStatus, string>;
  until: (date: string) => string;
  open: string;
  hide: string;
  unhide: string;
  accountAction: string;
  steps: Record<LadderStep, string>;
  consequence: Record<LadderStep, string>;
  lighter: string;
  staffTarget: string;
  markReviewed: string;
  dismiss: string;
  history: string;
  reasonLabel: string;
  reasonRequired: string;
  noteLabel: string;
  untilLabel: string;
  untilPresets: { none: string; d1: string; d7: string; d30: string; custom: string };
  untilDate: string;
  /** «تاريخ» was chosen and no day picked: never sent as «no end». */
  untilRequired: string;
  cancel: string;
  continue: string;
  confirmTitle: Record<LadderStep, (name: string) => string>;
  hideTitle: string;
  unhideTitle: string;
  hideConsequence: string;
  unhideConsequence: string;
  reviewTitle: string;
  reviewConsequence: string;
  dismissTitle: string;
  dismissConsequence: string;
  done: {
    status: (step: LadderStep, name: string) => string;
    hidden: string;
    unhidden: string;
    report: string;
    replayed: string;
    storeSuspended: string;
    storeKept: string;
  };
  failed: string;
  empty: string;
  emptyAppeals: string;
  loadFailed: string;
  retry: string;
  more: string;
  appealStates: Record<AppealState | 'all', string>;
  appealStateLabel: string;
  appealBy: (name: string) => string;
  appealOn: string;
  actions: Record<ModerationAction, string>;
  targets: Record<ModerationTargetType, string>;
  accept: string;
  reject: string;
  acceptTitle: string;
  rejectTitle: string;
  acceptConsequence: string;
  rejectConsequence: string;
  decisionLabel: string;
  accepted: (restored: boolean) => string;
  rejected: string;
  deskAnswer: string;
  historyTitle: string;
  historyActions: string;
  historyAudit: string;
  historyEmpty: string;
  now: string;
  by: (name: string) => string;
  appealLine: (state: AppealState) => string;
  auditActions: Record<string, string>;
}

const STRINGS: Record<DeskLang, DeskStrings> = {
  ar: {
    title: 'الإشراف',
    intro: 'بلاغات المجتمع، وقرارات الحسابات، والاعتراضات. كل قرار يُسجَّل، ويُبلَّغ صاحبه بالسبب ويستطيع الاعتراض.',
    views: { reports: 'البلاغات', appeals: 'الاعتراضات' },
    viewsLabel: 'قسم الإشراف',
    reportStates: { open: 'مفتوحة', reviewed: 'رُوجعت', actioned: 'اتُّخذ قرار', dismissed: 'مرفوضة', all: 'الكل' },
    stateLabel: 'حالة البلاغ',
    typeLabel: 'نوع المُبلَّغ عنه',
    anyType: 'كل الأنواع',
    kinds: {
      post: 'منشور',
      comment: 'تعليق',
      request_comment: 'تعليق على طلب',
      order_update: 'تحديث طلب',
      user: 'حساب',
      store: 'متجر',
      product: 'منتج',
      request: 'طلب طباعة',
    },
    reasons: {
      spam: 'إعلان أو تكرار مزعج',
      abuse: 'إساءة أو تحرّش',
      nudity: 'محتوى غير لائق',
      fraud: 'احتيال أو نصب',
      copyright: 'انتهاك حقوق',
      offtopic: 'خارج الموضوع',
      other: 'سبب آخر',
    },
    reporter: 'أبلغ:',
    onTarget: (all, open) => (all <= 1 ? 'بلاغ واحد على هذا' : `${all} بلاغات على هذا · ${open} مفتوحة`),
    details: 'ما كتبه المُبلِّغ:',
    resolution: 'قرار البلاغ:',
    gone: 'لم يعد موجودًا',
    hidden: 'مخفي',
    attachment: 'فيه مرفق',
    staff: 'فريق Levonis',
    roles: { author: 'الكاتب', account: 'الحساب', owner: 'صاحب المتجر', customer: 'صاحب الطلب' },
    statuses: { active: 'نشط', restricted: 'مقيَّد', suspended: 'معلَّق', banned: 'محظور' },
    until: (date) => `حتى ${date}`,
    open: 'فتح',
    hide: 'إخفاء',
    unhide: 'إظهار',
    accountAction: 'قرار على الحساب',
    steps: { warn: 'تنبيه', restrict: 'تقييد', suspend: 'تعليق', ban: 'حظر', restore: 'استعادة' },
    consequence: {
      warn: 'يُسجَّل التنبيه ويصل إلى صاحب الحساب مع السبب. لا يتغير شيء في حسابه.',
      restrict: 'لن يستطيع النشر أو التعليق أو إرسال العروض والطلبات والرسائل. يبقى التصفح وطلباته الجارية.',
      suspend: 'كالتقييد، ولا إعجاب ولا متابعة، وتُخفى صفحته ومحتواه عن الجميع حتى ينتهي.',
      ban: 'يُمنع من كل كتابة، ويُخفى محتواه، ويُعلَّق متجره إن كان له متجر. لا ينتهي إلا بالاستعادة.',
      restore: 'يعود الحساب إلى وضعه الطبيعي. المتجر المعلَّق يبقى معلَّقًا — فتحه قرار منفصل.',
    },
    lighter: 'أخف من العقوبة السارية — استعد الحساب أولًا',
    staffTarget: 'حسابات فريق Levonis لا تُدار من هنا',
    markReviewed: 'رُوجع',
    dismiss: 'رفض البلاغ',
    history: 'السجل',
    reasonLabel: 'السبب — يراه صاحبه',
    reasonRequired: 'اكتب السبب (3 أحرف على الأقل).',
    noteLabel: 'ملاحظة',
    untilLabel: 'ينتهي',
    untilPresets: { none: 'لا ينتهي (حتى يُرفع)', d1: 'بعد يوم', d7: 'بعد أسبوع', d30: 'بعد شهر', custom: 'في تاريخ محدد' },
    untilDate: 'تاريخ الانتهاء',
    untilRequired: 'اختر يوم الانتهاء، أو «لا ينتهي».',
    cancel: 'إلغاء',
    continue: 'متابعة',
    confirmTitle: {
      warn: (name) => `تنبيه ${name}؟`,
      restrict: (name) => `تقييد حساب ${name}؟`,
      suspend: (name) => `تعليق حساب ${name}؟`,
      ban: (name) => `حظر حساب ${name}؟`,
      restore: (name) => `استعادة حساب ${name}؟`,
    },
    hideTitle: 'إخفاء هذا المحتوى؟',
    unhideTitle: 'إظهار هذا المحتوى من جديد؟',
    hideConsequence: 'يختفي من كل القوائم، ويُبلَّغ صاحبه بالسبب ويستطيع الاعتراض.',
    unhideConsequence: 'يعود ظاهرًا كما كان، ويُبلَّغ صاحبه.',
    reviewTitle: 'تمت مراجعة البلاغ؟',
    reviewConsequence: 'يبقى في السجل مراجَعًا دون قرار. لا يُبلَّغ أحد.',
    dismissTitle: 'رفض البلاغ؟',
    dismissConsequence: 'يُغلق البلاغ دون قرار. لا يُبلَّغ صاحب المحتوى.',
    done: {
      status: (step, name) =>
        step === 'warn' ? `وصل التنبيه إلى ${name}.` : step === 'restore' ? `عاد حساب ${name} إلى وضعه الطبيعي.` : `طُبِّق القرار على حساب ${name}، وأُبلغ بالسبب.`,
      hidden: 'أُخفي، وأُبلغ صاحبه بالسبب.',
      unhidden: 'عاد ظاهرًا، وأُبلغ صاحبه.',
      report: 'حُفظ قرار البلاغ.',
      replayed: 'لم يتغير شيء — هذا هو الساري الآن.',
      storeSuspended: 'وعُلِّق متجره معه.',
      storeKept: 'متجره باقٍ على حاله — إعادة فتحه قرار منفصل من قسم التجار.',
    },
    failed: 'تعذّر تنفيذ القرار.',
    empty: 'لا بلاغات هنا.',
    emptyAppeals: 'لا اعتراضات هنا.',
    loadFailed: 'تعذّر تحميل القائمة.',
    retry: 'إعادة المحاولة',
    more: 'المزيد',
    appealStates: { open: 'مفتوحة', accepted: 'مقبولة', rejected: 'مرفوضة', all: 'الكل' },
    appealStateLabel: 'حالة الاعتراض',
    appealBy: (name) => `اعتراض من ${name}`,
    appealOn: 'على قرار:',
    actions: { hide: 'إخفاء', remove: 'إزالة', warn: 'تنبيه', restrict: 'تقييد', suspend: 'تعليق', ban: 'حظر', restore: 'استعادة' },
    targets: {
      post: 'منشور',
      comment: 'تعليق',
      request_comment: 'تعليق على طلب',
      user: 'حساب',
      store: 'متجر',
      product: 'منتج',
      request: 'طلب طباعة',
      review: 'تقييم',
    },
    accept: 'قبول',
    reject: 'رفض',
    acceptTitle: 'قبول الاعتراض؟',
    rejectTitle: 'رفض الاعتراض؟',
    acceptConsequence: 'يُلغى القرار إن كان ما زال هو الساري، ويُبلَّغ صاحب الاعتراض.',
    rejectConsequence: 'يبقى القرار كما هو، ويُبلَّغ صاحب الاعتراض بردك.',
    decisionLabel: 'ردك — يراه صاحب الاعتراض',
    accepted: (restored) => (restored ? 'قُبل الاعتراض وأُلغي القرار.' : 'قُبل الاعتراض. القرار لم يعد هو الساري، فلم يُلغَ شيء.'),
    rejected: 'رُفض الاعتراض، وأُبلغ صاحبه.',
    deskAnswer: 'رد الإدارة:',
    historyTitle: 'سجل القرارات',
    historyActions: 'القرارات',
    historyAudit: 'سجل التدقيق',
    historyEmpty: 'لا قرارات بعد.',
    now: 'الآن:',
    by: (name) => `بواسطة ${name}`,
    appealLine: (state) => (state === 'open' ? 'عليه اعتراض مفتوح' : state === 'accepted' ? 'قُبل الاعتراض عليه' : 'رُفض الاعتراض عليه'),
    auditActions: {
      'admin.moderation.post_hidden': 'أُخفي المنشور',
      'admin.moderation.post_restored': 'أُعيد إظهار المنشور',
      'admin.moderation.comment_hidden': 'أُخفي التعليق',
      'admin.moderation.comment_restored': 'أُعيد إظهار التعليق',
      'admin.moderation.request_comment_hidden': 'أُخفي التعليق',
      'admin.moderation.request_comment_restored': 'أُعيد إظهار التعليق',
      'admin.moderation.user_status': 'تغيّرت حالة الحساب',
      'admin.moderation.report': 'قرار على بلاغ',
      'admin.moderation.appeal_decided': 'بُتّ في اعتراض',
      'moderation.appeal_filed': 'قُدّم اعتراض',
      'admin.store_status': 'تغيّرت حالة المتجر',
      'admin.merchant_status': 'تغيّرت حالة التاجر',
    },
  },
  en: {
    title: 'Moderation',
    intro: 'Community reports, account decisions and appeals. Every decision is recorded, and the person is told the reason and can appeal.',
    views: { reports: 'Reports', appeals: 'Appeals' },
    viewsLabel: 'Moderation section',
    reportStates: { open: 'Open', reviewed: 'Reviewed', actioned: 'Actioned', dismissed: 'Dismissed', all: 'All' },
    stateLabel: 'Report state',
    typeLabel: 'What was reported',
    anyType: 'Everything',
    kinds: {
      post: 'Post',
      comment: 'Comment',
      request_comment: 'Request comment',
      order_update: 'Order update',
      user: 'Account',
      store: 'Store',
      product: 'Product',
      request: 'Print request',
    },
    reasons: {
      spam: 'Spam or repeated ads',
      abuse: 'Abuse or harassment',
      nudity: 'Inappropriate content',
      fraud: 'Scam or fraud',
      copyright: 'Copyright violation',
      offtopic: 'Off topic',
      other: 'Something else',
    },
    reporter: 'Reported by',
    onTarget: (all, open) => (all <= 1 ? 'One report on this' : `${all} reports on this · ${open} open`),
    details: 'What the reporter wrote:',
    resolution: 'Decision on the report:',
    gone: 'No longer exists',
    hidden: 'Hidden',
    attachment: 'Has an attachment',
    staff: 'Levonis staff',
    roles: { author: 'Author', account: 'Account', owner: 'Store owner', customer: 'Requester' },
    statuses: { active: 'Active', restricted: 'Restricted', suspended: 'Suspended', banned: 'Banned' },
    until: (date) => `until ${date}`,
    open: 'Open',
    hide: 'Hide',
    unhide: 'Unhide',
    accountAction: 'Account decision',
    steps: { warn: 'Warn', restrict: 'Restrict', suspend: 'Suspend', ban: 'Ban', restore: 'Restore' },
    consequence: {
      warn: 'The warning is recorded and reaches the person with the reason. Nothing about the account changes.',
      restrict: 'They can’t post, comment, or send offers, requests or messages. Browsing and their orders in progress stay.',
      suspend: 'Like a restriction, plus no likes or follows, and their page and content are hidden from everyone until it ends.',
      ban: 'Every write is refused, their content is hidden, and their store is suspended if they have one. It ends only with a restore.',
      restore: 'The account goes back to normal. A suspended store stays suspended — reopening it is a separate decision.',
    },
    lighter: 'Lighter than the sanction in force — restore the account first',
    staffTarget: 'Levonis staff accounts are not managed here',
    markReviewed: 'Reviewed',
    dismiss: 'Dismiss report',
    history: 'History',
    reasonLabel: 'Reason — the person will see it',
    reasonRequired: 'Write the reason (at least 3 characters).',
    noteLabel: 'Note',
    untilLabel: 'Ends',
    untilPresets: { none: 'Never (until lifted)', d1: 'In 1 day', d7: 'In 1 week', d30: 'In 1 month', custom: 'On a set date' },
    untilDate: 'End date',
    untilRequired: 'Pick the day it ends, or choose “Never”.',
    cancel: 'Cancel',
    continue: 'Continue',
    confirmTitle: {
      warn: (name) => `Warn ${name}?`,
      restrict: (name) => `Restrict ${name}’s account?`,
      suspend: (name) => `Suspend ${name}’s account?`,
      ban: (name) => `Ban ${name}’s account?`,
      restore: (name) => `Restore ${name}’s account?`,
    },
    hideTitle: 'Hide this content?',
    unhideTitle: 'Show this content again?',
    hideConsequence: 'It disappears from every list; the author is told the reason and can appeal.',
    unhideConsequence: 'It is visible again as it was, and the author is told.',
    reviewTitle: 'Mark the report reviewed?',
    reviewConsequence: 'It stays on record as reviewed, with no decision. Nobody is told.',
    dismissTitle: 'Dismiss the report?',
    dismissConsequence: 'The report closes with no decision. The author is not told.',
    done: {
      status: (step, name) =>
        step === 'warn' ? `The warning reached ${name}.` : step === 'restore' ? `${name}’s account is back to normal.` : `The decision is applied to ${name}’s account, and they were told the reason.`,
      hidden: 'Hidden, and the author was told the reason.',
      unhidden: 'Visible again, and the author was told.',
      report: 'The report’s decision is saved.',
      replayed: 'Nothing changed — this is already in force.',
      storeSuspended: 'Their store was suspended with it.',
      storeKept: 'Their store is left as it is — reopening it is a separate decision in Merchants.',
    },
    failed: 'The decision could not be applied.',
    empty: 'No reports here.',
    emptyAppeals: 'No appeals here.',
    loadFailed: 'The list could not be loaded.',
    retry: 'Try again',
    more: 'Load more',
    appealStates: { open: 'Open', accepted: 'Accepted', rejected: 'Rejected', all: 'All' },
    appealStateLabel: 'Appeal state',
    appealBy: (name) => `Appeal from ${name}`,
    appealOn: 'Against:',
    actions: { hide: 'Hide', remove: 'Remove', warn: 'Warn', restrict: 'Restrict', suspend: 'Suspend', ban: 'Ban', restore: 'Restore' },
    targets: {
      post: 'Post',
      comment: 'Comment',
      request_comment: 'Request comment',
      user: 'Account',
      store: 'Store',
      product: 'Product',
      request: 'Print request',
      review: 'Review',
    },
    accept: 'Accept',
    reject: 'Reject',
    acceptTitle: 'Accept the appeal?',
    rejectTitle: 'Reject the appeal?',
    acceptConsequence: 'The decision is undone if it is still the one in force, and the person is told.',
    rejectConsequence: 'The decision stands, and the person is told your answer.',
    decisionLabel: 'Your answer — the person will see it',
    accepted: (restored) => (restored ? 'Appeal accepted and the decision undone.' : 'Appeal accepted. The decision is no longer the one in force, so nothing was undone.'),
    rejected: 'Appeal rejected, and the person was told.',
    deskAnswer: 'Moderation’s answer:',
    historyTitle: 'Decision history',
    historyActions: 'Decisions',
    historyAudit: 'Audit log',
    historyEmpty: 'No decisions yet.',
    now: 'Now:',
    by: (name) => `by ${name}`,
    appealLine: (state) => (state === 'open' ? 'Has an open appeal' : state === 'accepted' ? 'Appeal accepted' : 'Appeal rejected'),
    auditActions: {
      'admin.moderation.post_hidden': 'Post hidden',
      'admin.moderation.post_restored': 'Post shown again',
      'admin.moderation.comment_hidden': 'Comment hidden',
      'admin.moderation.comment_restored': 'Comment shown again',
      'admin.moderation.request_comment_hidden': 'Comment hidden',
      'admin.moderation.request_comment_restored': 'Comment shown again',
      'admin.moderation.user_status': 'Account standing changed',
      'admin.moderation.report': 'Report decided',
      'admin.moderation.appeal_decided': 'Appeal decided',
      'moderation.appeal_filed': 'Appeal filed',
      'admin.store_status': 'Store status changed',
      'admin.merchant_status': 'Merchant status changed',
    },
  },
  ckb: {
    title: 'چاودێری',
    intro: 'ڕاپۆرتەکانی کۆمەڵگە، بڕیارەکانی هەژمار و ناڕەزاییەکان. هەموو بڕیارێک تۆمار دەکرێت، و خاوەنەکەی هۆکارەکەی پێ دەگوترێت و دەتوانێت ناڕەزایی دەرببڕێت.',
    views: { reports: 'ڕاپۆرتەکان', appeals: 'ناڕەزاییەکان' },
    viewsLabel: 'بەشی چاودێری',
    reportStates: { open: 'کراوە', reviewed: 'پشکنراو', actioned: 'بڕیاردراو', dismissed: 'ڕەتکراوە', all: 'هەموو' },
    stateLabel: 'دۆخی ڕاپۆرت',
    typeLabel: 'چی ڕاپۆرت کراوە',
    anyType: 'هەموو',
    kinds: {
      post: 'پۆست',
      comment: 'کۆمێنت',
      request_comment: 'کۆمێنتی داواکاری',
      order_update: 'نوێکردنەوەی داواکاری',
      user: 'هەژمار',
      store: 'فرۆشگا',
      product: 'بەرهەم',
      request: 'داواکاریی چاپ',
    },
    reasons: {
      spam: 'سپام یان ڕیکلامی دووبارە',
      abuse: 'سووکایەتی یان هەراسانکردن',
      nudity: 'ناوەڕۆکی نەشیاو',
      fraud: 'فێڵ یان ساختەکاری',
      copyright: 'پێشێلکردنی مافی بڵاوکردنەوە',
      offtopic: 'دەرەوەی بابەت',
      other: 'هۆکارێکی تر',
    },
    reporter: 'ڕاپۆرتکەر:',
    onTarget: (all, open) => (all <= 1 ? 'یەک ڕاپۆرت لەسەر ئەمە' : `${all} ڕاپۆرت لەسەر ئەمە · ${open} کراوە`),
    details: 'ئەوەی ڕاپۆرتکەر نووسیویەتی:',
    resolution: 'بڕیاری ڕاپۆرتەکە:',
    gone: 'چیتر بوونی نییە',
    hidden: 'شاردراوە',
    attachment: 'پاشکۆی تێدایە',
    staff: 'ستافی Levonis',
    roles: { author: 'نووسەر', account: 'هەژمار', owner: 'خاوەنی فرۆشگا', customer: 'خاوەنی داواکاری' },
    statuses: { active: 'چالاک', restricted: 'سنووردار', suspended: 'ڕاگیراو', banned: 'قەدەغەکراو' },
    until: (date) => `تا ${date}`,
    open: 'کردنەوە',
    hide: 'شاردنەوە',
    unhide: 'دەرخستنەوە',
    accountAction: 'بڕیار لەسەر هەژمار',
    steps: { warn: 'ئاگادارکردنەوە', restrict: 'سنووردارکردن', suspend: 'ڕاگرتن', ban: 'قەدەغەکردن', restore: 'گەڕاندنەوە' },
    consequence: {
      warn: 'ئاگادارکردنەوەکە تۆمار دەکرێت و لەگەڵ هۆکارەکەی دەگاتە خاوەنی هەژمارەکە. هیچ شتێک لە هەژمارەکەیدا ناگۆڕێت.',
      restrict: 'ناتوانێت پۆست بکات، کۆمێنت بنووسێت، یان ئۆفەر و داواکاری و پەیام بنێرێت. گەڕان و داواکارییە بەردەوامەکانی دەمێننەوە.',
      suspend: 'وەک سنووردارکردن، و لایک و شوێنکەوتنیش نییە، و پەڕە و ناوەڕۆکەکەی تا کۆتایی لە هەمووان دەشاردرێتەوە.',
      ban: 'هەموو نووسینێکی ڕەت دەکرێتەوە، ناوەڕۆکەکەی دەشاردرێتەوە، و ئەگەر فرۆشگای هەبێت ڕادەگیرێت. تەنها بە گەڕاندنەوە کۆتایی دێت.',
      restore: 'هەژمارەکە دەگەڕێتەوە دۆخی ئاسایی. فرۆشگای ڕاگیراو ڕاگیراو دەمێنێتەوە — کردنەوەی بڕیارێکی جیایە.',
    },
    lighter: 'لە سزای ئێستا سووکترە — سەرەتا هەژمارەکە بگەڕێنەوە',
    staffTarget: 'هەژمارەکانی ستافی Levonis لێرەوە بەڕێوە نابرێن',
    markReviewed: 'پێداچوونەوەی بۆ کرا',
    dismiss: 'ڕەتکردنەوەی ڕاپۆرت',
    history: 'مێژوو',
    reasonLabel: 'هۆکار — خاوەنەکەی دەیبینێت',
    reasonRequired: 'هۆکارەکە بنووسە (لانیکەم 3 پیت).',
    noteLabel: 'تێبینی',
    untilLabel: 'کۆتایی دێت',
    untilPresets: { none: 'هەرگیز', d1: 'دوای ڕۆژێک', d7: 'دوای هەفتەیەک', d30: 'دوای مانگێک', custom: 'لە بەروارێکی دیاریکراودا' },
    untilDate: 'بەرواری کۆتایی',
    untilRequired: 'ڕۆژی کۆتایی هەڵبژێرە، یان «هەرگیز».',
    cancel: 'هەڵوەشاندنەوە',
    continue: 'بەردەوامبوون',
    confirmTitle: {
      warn: (name) => `ئاگادارکردنەوەی ${name}؟`,
      restrict: (name) => `سنووردارکردنی هەژماری ${name}؟`,
      suspend: (name) => `ڕاگرتنی هەژماری ${name}؟`,
      ban: (name) => `قەدەغەکردنی هەژماری ${name}؟`,
      restore: (name) => `گەڕاندنەوەی هەژماری ${name}؟`,
    },
    hideTitle: 'ئەم ناوەڕۆکە بشاردرێتەوە؟',
    unhideTitle: 'ئەم ناوەڕۆکە دووبارە دەربخرێتەوە؟',
    hideConsequence: 'لە هەموو لیستەکان ون دەبێت؛ خاوەنەکەی هۆکارەکەی پێ دەگوترێت و دەتوانێت ناڕەزایی دەرببڕێت.',
    unhideConsequence: 'وەک خۆی دووبارە دەردەکەوێتەوە، و خاوەنەکەی ئاگادار دەکرێتەوە.',
    reviewTitle: 'ڕاپۆرتەکە وەک پێداچوونەوەکراو دیاری بکرێت؟',
    reviewConsequence: 'وەک پێداچوونەوەکراو بێ بڕیار لە تۆماردا دەمێنێتەوە. کەس ئاگادار ناکرێتەوە.',
    dismissTitle: 'ڕاپۆرتەکە ڕەت بکرێتەوە؟',
    dismissConsequence: 'ڕاپۆرتەکە بێ بڕیار دادەخرێت. خاوەنی ناوەڕۆکەکە ئاگادار ناکرێتەوە.',
    done: {
      status: (step, name) =>
        step === 'warn' ? `ئاگادارکردنەوەکە گەیشتە ${name}.` : step === 'restore' ? `هەژماری ${name} گەڕایەوە دۆخی ئاسایی.` : `بڕیارەکە لەسەر هەژماری ${name} جێبەجێ کرا، و هۆکارەکەی پێ گوترا.`,
      hidden: 'شاردرایەوە، و هۆکارەکە بە خاوەنەکەی گوترا.',
      unhidden: 'دووبارە دەرخرایەوە، و خاوەنەکەی ئاگادار کرایەوە.',
      report: 'بڕیاری ڕاپۆرتەکە پاشەکەوت کرا.',
      replayed: 'هیچ شتێک نەگۆڕا — ئەمە ئێستا جێبەجێیە.',
      storeSuspended: 'فرۆشگاکەشی لەگەڵیدا ڕاگیرا.',
      storeKept: 'فرۆشگاکەی وەک خۆی دەمێنێتەوە — کردنەوەی بڕیارێکی جیایە لە بەشی بازرگانان.',
    },
    failed: 'بڕیارەکە جێبەجێ نەکرا.',
    empty: 'لێرە هیچ ڕاپۆرتێک نییە.',
    emptyAppeals: 'لێرە هیچ ناڕەزاییەک نییە.',
    loadFailed: 'لیستەکە بار نەکرا.',
    retry: 'دووبارە هەوڵ بدەرەوە',
    more: 'زیاتر',
    appealStates: { open: 'کراوە', accepted: 'پەسەندکراو', rejected: 'ڕەتکراوە', all: 'هەموو' },
    appealStateLabel: 'دۆخی ناڕەزایی',
    appealBy: (name) => `ناڕەزایی لەلایەن ${name}`,
    appealOn: 'لەسەر بڕیاری:',
    actions: { hide: 'شاردنەوە', remove: 'لابردن', warn: 'ئاگادارکردنەوە', restrict: 'سنووردارکردن', suspend: 'ڕاگرتن', ban: 'قەدەغەکردن', restore: 'گەڕاندنەوە' },
    targets: {
      post: 'پۆست',
      comment: 'کۆمێنت',
      request_comment: 'کۆمێنتی داواکاری',
      user: 'هەژمار',
      store: 'فرۆشگا',
      product: 'بەرهەم',
      request: 'داواکاریی چاپ',
      review: 'هەڵسەنگاندن',
    },
    accept: 'پەسەندکردن',
    reject: 'ڕەتکردنەوە',
    acceptTitle: 'ناڕەزاییەکە پەسەند بکرێت؟',
    rejectTitle: 'ناڕەزاییەکە ڕەت بکرێتەوە؟',
    acceptConsequence: 'ئەگەر بڕیارەکە هێشتا جێبەجێ بێت هەڵدەوەشێتەوە، و خاوەنی ناڕەزاییەکە ئاگادار دەکرێتەوە.',
    rejectConsequence: 'بڕیارەکە وەک خۆی دەمێنێتەوە، و وەڵامەکەت بە خاوەنی ناڕەزاییەکە دەگوترێت.',
    decisionLabel: 'وەڵامەکەت — خاوەنی ناڕەزاییەکە دەیبینێت',
    accepted: (restored) => (restored ? 'ناڕەزاییەکە پەسەند کرا و بڕیارەکە هەڵوەشێنرایەوە.' : 'ناڕەزاییەکە پەسەند کرا. بڕیارەکە چیتر جێبەجێ نییە، بۆیە هیچ شتێک هەڵنەوەشێنرایەوە.'),
    rejected: 'ناڕەزاییەکە ڕەتکرایەوە، و خاوەنەکەی ئاگادار کرایەوە.',
    deskAnswer: 'وەڵامی بەڕێوەبردن:',
    historyTitle: 'مێژووی بڕیارەکان',
    historyActions: 'بڕیارەکان',
    historyAudit: 'تۆماری پشکنین',
    historyEmpty: 'هێشتا هیچ بڕیارێک نییە.',
    now: 'ئێستا:',
    by: (name) => `لەلایەن ${name}`,
    appealLine: (state) => (state === 'open' ? 'ناڕەزاییەکی کراوەی لەسەرە' : state === 'accepted' ? 'ناڕەزاییەکەی پەسەند کرا' : 'ناڕەزاییەکەی ڕەتکرایەوە'),
    auditActions: {
      'admin.moderation.post_hidden': 'پۆستەکە شاردرایەوە',
      'admin.moderation.post_restored': 'پۆستەکە دووبارە دەرخرایەوە',
      'admin.moderation.comment_hidden': 'کۆمێنتەکە شاردرایەوە',
      'admin.moderation.comment_restored': 'کۆمێنتەکە دووبارە دەرخرایەوە',
      'admin.moderation.request_comment_hidden': 'کۆمێنتەکە شاردرایەوە',
      'admin.moderation.request_comment_restored': 'کۆمێنتەکە دووبارە دەرخرایەوە',
      'admin.moderation.user_status': 'دۆخی هەژمارەکە گۆڕا',
      'admin.moderation.report': 'بڕیار لەسەر ڕاپۆرت درا',
      'admin.moderation.appeal_decided': 'بڕیار لەسەر ناڕەزایی درا',
      'moderation.appeal_filed': 'ناڕەزایی دەربڕدرا',
      'admin.store_status': 'دۆخی فرۆشگاکە گۆڕا',
      'admin.merchant_status': 'دۆخی بازرگانەکە گۆڕا',
    },
  },
};

export const DESK_STRINGS = STRINGS;

export function deskStrings(lang: string): DeskStrings {
  return STRINGS[deskLang(lang)];
}

export function useDeskStrings(): DeskStrings {
  const { lang } = useLanguage();
  return deskStrings(lang);
}
