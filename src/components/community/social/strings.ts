/**
 * THE SOCIAL GRAPH'S WORDS — Arabic, English and Sorani, every key in all
 * three (docs/COMMUNITY_ECOSYSTEM.md D6: no Arabic standing in for Sorani).
 * Counted nouns follow src/components/community/hub/copy.ts's rule (one,
 * two, 3–10, 11–99, hundreds); Sorani counts with the bare noun.
 */
import { useLanguage } from '../../../LanguageContext';
import type { ReportReason } from './api';

const STRINGS = {
  ar: {
    like: 'إعجاب',
    liked: 'أعجبني',
    unlike: 'إلغاء الإعجاب',
    save: 'حفظ',
    saved: 'محفوظ',
    unsave: 'إزالة من المحفوظات',
    comment: 'تعليق',
    comments: 'التعليقات',
    reply: 'رد',
    replyTo: 'رد على {name}',
    follow: 'متابعة',
    following: 'تتابعه',
    unfollow: 'إلغاء المتابعة',
    followers: 'متابعون',
    block: 'حظر',
    unblock: 'إلغاء الحظر',
    mute: 'كتم',
    unmute: 'إلغاء الكتم',
    report: 'إبلاغ',
    reportTitle: 'الإبلاغ عن مخالفة',
    reportWhy: 'ما المشكلة؟',
    reportReasons: {
      spam: 'إعلان أو تكرار مزعج',
      abuse: 'إساءة أو تحرّش',
      nudity: 'محتوى غير لائق',
      fraud: 'احتيال أو نصب',
      copyright: 'انتهاك حقوق',
      offtopic: 'خارج الموضوع',
      other: 'سبب آخر',
    } as Record<ReportReason, string>,
    reportSent: 'وصل بلاغك. شكرًا لك.',
    reportedBefore: 'سبق أن أبلغت عن هذا.',
    reportDetails: 'تفاصيل',
    reportDetailsPh: 'ما الذي حدث؟',
    writeComment: 'اكتب تعليقًا…',
    send: 'إرسال',
    sending: 'جارٍ الإرسال…',
    removed: 'حُذف التعليق',
    remove: 'حذف',
    removeQ: 'حذف التعليق؟',
    removeConsequence: 'يبقى مكانه فارغًا كي تحتفظ الردود بترتيبها.',
    signIn: 'تسجيل الدخول',
    signInToLike: 'سجّل الدخول لتُعجب',
    signInToComment: 'سجّل الدخول لتعلّق',
    signInToFollow: 'سجّل الدخول لتتابع',
    signInToSave: 'سجّل الدخول لتحفظ',
    blockedNotice: 'حظرت هذا الحساب.',
    blockQ: 'حظر هذا الحساب؟',
    blockConsequence: 'لن تتراسلا ولن يتابع أحدكما الآخر، ولن ترى منشوراته.',
    unblockQ: 'إلغاء حظر هذا الحساب؟',
    emptyComments: 'لا تعليقات بعد',
    emptyCommentsHint: 'كن أول من يتكلم.',
    copyLink: 'نسخ الرابط',
    linkCopied: 'نُسخ الرابط',
    share: 'مشاركة',
    mutedToast: 'كُتم — لن تظهر منشوراته في «لك».',
    unmutedToast: 'أُلغي الكتم.',
    blockedToast: 'حُظر الحساب.',
    unblockedToast: 'أُلغي الحظر.',
    savedTitle: 'المحفوظات',
    savedEmpty: 'لم تحفظ شيئًا بعد',
    savedEmptyHint: 'المشاريع التي تحفظها تجتمع هنا.',
    browseProjects: 'تصفّح المشاريع',
    posts: 'المنشورات',
    noPostsYet: 'لا منشورات بعد',
    tooFast: 'على مهل — انتظر ثوانٍ قليلة.',
    actionFailed: 'تعذّر تنفيذ الإجراء. حاول مرة أخرى.',
    options: 'خيارات',
    muteAuthor: 'كتم الناشر',
    unmuteAuthor: 'إلغاء كتم الناشر',
    blockAuthor: 'حظر الناشر',
    reportPost: 'الإبلاغ عن المنشور',
    cancel: 'إلغاء',
    close: 'إغلاق',
    loadOlder: 'تعليقات أكثر',
    edit: 'تعديل',
    archive: 'أرشفة',
    restore: 'إعادة',
    delete: 'حذف',
  },
  en: {
    like: 'Like',
    liked: 'Liked',
    unlike: 'Unlike',
    save: 'Save',
    saved: 'Saved',
    unsave: 'Remove from saved',
    comment: 'Comment',
    comments: 'Comments',
    reply: 'Reply',
    replyTo: 'Reply to {name}',
    follow: 'Follow',
    following: 'Following',
    unfollow: 'Unfollow',
    followers: 'Followers',
    block: 'Block',
    unblock: 'Unblock',
    mute: 'Mute',
    unmute: 'Unmute',
    report: 'Report',
    reportTitle: 'Report a problem',
    reportWhy: 'What is wrong?',
    reportReasons: {
      spam: 'Spam or repeated ads',
      abuse: 'Abuse or harassment',
      nudity: 'Inappropriate content',
      fraud: 'Scam or fraud',
      copyright: 'Copyright violation',
      offtopic: 'Off topic',
      other: 'Something else',
    } as Record<ReportReason, string>,
    reportSent: 'Your report is in. Thank you.',
    reportedBefore: 'You already reported this.',
    reportDetails: 'Details',
    reportDetailsPh: 'What happened?',
    writeComment: 'Write a comment…',
    send: 'Send',
    sending: 'Sending…',
    removed: 'Comment removed',
    remove: 'Remove',
    removeQ: 'Remove this comment?',
    removeConsequence: 'Its place stays empty so the replies keep their order.',
    signIn: 'Sign in',
    signInToLike: 'Sign in to like',
    signInToComment: 'Sign in to comment',
    signInToFollow: 'Sign in to follow',
    signInToSave: 'Sign in to save',
    blockedNotice: 'You blocked this account.',
    blockQ: 'Block this account?',
    blockConsequence: 'Neither of you can message or follow the other, and you will not see their posts.',
    unblockQ: 'Unblock this account?',
    emptyComments: 'No comments yet',
    emptyCommentsHint: 'Be the first to say something.',
    copyLink: 'Copy link',
    linkCopied: 'Link copied',
    share: 'Share',
    mutedToast: 'Muted — their posts leave your For You feed.',
    unmutedToast: 'Unmuted.',
    blockedToast: 'Account blocked.',
    unblockedToast: 'Account unblocked.',
    savedTitle: 'Saved',
    savedEmpty: 'Nothing saved yet',
    savedEmptyHint: 'The projects you save gather here.',
    browseProjects: 'Browse projects',
    posts: 'Posts',
    noPostsYet: 'No posts yet',
    tooFast: 'Slow down — wait a few seconds.',
    actionFailed: 'Could not do that. Try again.',
    options: 'Options',
    muteAuthor: 'Mute author',
    unmuteAuthor: 'Unmute author',
    blockAuthor: 'Block author',
    reportPost: 'Report post',
    cancel: 'Cancel',
    close: 'Close',
    loadOlder: 'More comments',
    edit: 'Edit',
    archive: 'Archive',
    restore: 'Restore',
    delete: 'Delete',
  },
  ckb: {
    like: 'لایک',
    liked: 'لایک کراوە',
    unlike: 'لابردنی لایک',
    save: 'پاشەکەوتکردن',
    saved: 'پاشەکەوت کراوە',
    unsave: 'لابردن لە پاشەکەوتکراوەکان',
    comment: 'کۆمێنت',
    comments: 'کۆمێنتەکان',
    reply: 'وەڵام',
    replyTo: 'وەڵامدانەوەی {name}',
    follow: 'شوێنکەوتن',
    following: 'شوێنی دەکەویت',
    unfollow: 'وازهێنان لە شوێنکەوتن',
    followers: 'شوێنکەوتووان',
    block: 'بلۆککردن',
    unblock: 'لابردنی بلۆک',
    mute: 'بێدەنگکردن',
    unmute: 'لابردنی بێدەنگی',
    report: 'ڕاپۆرتکردن',
    reportTitle: 'ڕاپۆرتکردنی کێشەیەک',
    reportWhy: 'کێشەکە چییە؟',
    reportReasons: {
      spam: 'سپام یان ڕیکلامی دووبارە',
      abuse: 'سووکایەتی یان هەراسانکردن',
      nudity: 'ناوەڕۆکی نەشیاو',
      fraud: 'فێڵ یان ساختەکاری',
      copyright: 'پێشێلکردنی مافی بڵاوکردنەوە',
      offtopic: 'دەرەوەی بابەت',
      other: 'هۆکارێکی تر',
    } as Record<ReportReason, string>,
    reportSent: 'ڕاپۆرتەکەت گەیشت. سوپاس.',
    reportedBefore: 'پێشتر ئەمەت ڕاپۆرت کردووە.',
    reportDetails: 'وردەکاری',
    reportDetailsPh: 'چی ڕوویدا؟',
    writeComment: 'کۆمێنتێک بنووسە…',
    send: 'ناردن',
    sending: 'دەنێردرێت…',
    removed: 'کۆمێنتەکە سڕایەوە',
    remove: 'سڕینەوە',
    removeQ: 'کۆمێنتەکە بسڕدرێتەوە؟',
    removeConsequence: 'شوێنەکەی بەتاڵ دەمێنێتەوە بۆ ئەوەی وەڵامەکان ڕیزبەندییان بپارێزن.',
    signIn: 'چوونەژوورەوە',
    signInToLike: 'بۆ لایککردن بچۆ ژوورەوە',
    signInToComment: 'بۆ کۆمێنت نووسین بچۆ ژوورەوە',
    signInToFollow: 'بۆ شوێنکەوتن بچۆ ژوورەوە',
    signInToSave: 'بۆ پاشەکەوتکردن بچۆ ژوورەوە',
    blockedNotice: 'ئەم هەژمارەت بلۆک کردووە.',
    blockQ: 'ئەم هەژمارە بلۆک بکرێت؟',
    blockConsequence: 'ناتوانن پەیام بۆ یەکتر بنێرن یان شوێن یەکتر بکەون، و پۆستەکانی نابینیت.',
    unblockQ: 'بلۆکی ئەم هەژمارە لاببرێت؟',
    emptyComments: 'هێشتا هیچ کۆمێنتێک نییە',
    emptyCommentsHint: 'یەکەم کەس بە کە قسە دەکات.',
    copyLink: 'کۆپیکردنی لینک',
    linkCopied: 'لینکەکە کۆپی کرا',
    share: 'هاوبەشکردن',
    mutedToast: 'بێدەنگ کرا — پۆستەکانی لە «بۆ تۆ» دەرناکەون.',
    unmutedToast: 'بێدەنگی لابرا.',
    blockedToast: 'هەژمارەکە بلۆک کرا.',
    unblockedToast: 'بلۆکەکە لابرا.',
    savedTitle: 'پاشەکەوتکراوەکان',
    savedEmpty: 'هێشتا هیچت پاشەکەوت نەکردووە',
    savedEmptyHint: 'ئەو پڕۆژانەی پاشەکەوتیان دەکەیت لێرە کۆدەبنەوە.',
    browseProjects: 'گەڕان لە پڕۆژەکان',
    posts: 'پۆستەکان',
    noPostsYet: 'هێشتا هیچ پۆستێک نییە',
    tooFast: 'هێواشتر — چەند چرکەیەک چاوەڕێ بکە.',
    actionFailed: 'نەتوانرا ئەنجام بدرێت. دووبارە هەوڵ بدە.',
    options: 'هەڵبژاردەکان',
    muteAuthor: 'بێدەنگکردنی نووسەر',
    unmuteAuthor: 'لابردنی بێدەنگی نووسەر',
    blockAuthor: 'بلۆککردنی نووسەر',
    reportPost: 'ڕاپۆرتکردنی پۆست',
    cancel: 'هەڵوەشاندنەوە',
    close: 'داخستن',
    loadOlder: 'کۆمێنتی زیاتر',
    edit: 'دەستکاری',
    archive: 'ئەرشیفکردن',
    restore: 'گەڕاندنەوە',
    delete: 'سڕینەوە',
  },
} as const;

/** The table's shape with plain strings, so any language's table fits it. */
type Widen<T> = T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> };
export type SocialStrings = Widen<(typeof STRINGS)['ar']>;
export type SocialLang = keyof typeof STRINGS;

export const SOCIAL_STRINGS = STRINGS;

export function socialLang(lang: string): SocialLang {
  return lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
}

export function useSocialStrings(): SocialStrings {
  const { lang } = useLanguage();
  return STRINGS[socialLang(lang)] as SocialStrings;
}

// ------------------------------------------------------------ counted nouns

interface Forms {
  one: string;
  two: string;
  few: string;
  many: string;
  hundred: string;
  en1: string;
  enN: string;
  /** Sorani counts with the bare noun: «12 لایک». */
  ckb: string;
}

function counted(n: number, f: Forms, lang: SocialLang): string {
  const count = Math.max(0, Math.floor(n));
  if (lang === 'en') return `${count} ${count === 1 ? f.en1 : f.enN}`;
  if (lang === 'ckb') return `${count} ${f.ckb}`;
  if (count === 1) return f.one;
  if (count === 2) return f.two;
  const r = count % 100;
  if (r >= 3 && r <= 10) return `${count} ${f.few}`;
  if (r >= 11 && r <= 99) return `${count} ${f.many}`;
  return `${count} ${f.hundred}`;
}

const LIKES: Forms = { one: 'إعجاب واحد', two: 'إعجابان', few: 'إعجابات', many: 'إعجابًا', hundred: 'إعجاب', en1: 'like', enN: 'likes', ckb: 'لایک' };
const COMMENTS: Forms = { one: 'تعليق واحد', two: 'تعليقان', few: 'تعليقات', many: 'تعليقًا', hundred: 'تعليق', en1: 'comment', enN: 'comments', ckb: 'کۆمێنت' };
const FOLLOWERS: Forms = { one: 'متابع واحد', two: 'متابعان', few: 'متابعين', many: 'متابعًا', hundred: 'متابع', en1: 'follower', enN: 'followers', ckb: 'شوێنکەوتوو' };

export const likesLabel = (n: number, lang: SocialLang) => counted(n, LIKES, lang);
export const commentsLabel = (n: number, lang: SocialLang) => counted(n, COMMENTS, lang);
export const followersLabel = (n: number, lang: SocialLang) => counted(n, FOLLOWERS, lang);

/** «رد على سارة» — the composer's placeholder while replying. */
export const replyToLabel = (s: SocialStrings, name: string) => s.replyTo.replace('{name}', name);
