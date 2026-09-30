/**
 * THE PERSON'S OWN STANDING, IN WORDS — Arabic, English and written Sorani,
 * every key in all three (docs/COMMUNITY_ECOSYSTEM.md D6, §9.6 Moderation V2).
 *
 *   the banner     «حسابك مقيَّد / معلَّق / محظور», what it takes away, the
 *                  reason the desk wrote, the end date, and the appeal door
 *                  (./StatusBanner.tsx — the community home, the composer);
 *   the page       /moderation, «حالة حسابي»: the standing and each decision
 *                  about the account or its content, with its appeal
 *                  (./ModerationPage.tsx);
 *   the appeal     one per decision (./AppealSheet.tsx).
 *
 * The desk's refusals (APPEAL_EXISTS, USER_RESTRICTED …) are worded by
 * src/lib/refusalStrings.ts, not here. The reason and the desk's answer are the
 * desk's own words and are shown as written.
 */
import { useLanguage } from '../../../LanguageContext';
import type { AppealState, ModerationAction, ModerationTargetType, UserStatus } from './api';

export type ModLang = 'ar' | 'en' | 'ckb';
export type Sanction = Exclude<UserStatus, 'active'>;

export function modLang(lang: string): ModLang {
  return lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
}

/** A date the reader's calendar writes, ISO when the engine lacks the locale. */
export function modDate(iso: string | null | undefined, lang: ModLang): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    // Sorani where the engine has its calendar names, else the Arabic ones —
    // Latin digits either way, as every date in the app is written.
    const locale = lang === 'en' ? 'en-GB' : lang === 'ckb' ? ['ckb-IQ-u-nu-latn', 'ar-IQ-u-nu-latn'] : 'ar-IQ-u-nu-latn';
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** The chip tone of an appeal's state. */
export const appealTone = (state: string): 'success' | 'danger' | 'warning' => (state === 'accepted' ? 'success' : state === 'rejected' ? 'danger' : 'warning');

export interface ModerationStrings {
  /** The banner's title, by standing — with the end date when there is one. */
  title: Record<Sanction, (until: string) => string>;
  /** What the standing takes away, in one sentence. */
  meaning: Record<Sanction, string>;
  reason: (text: string) => string;
  appealDoor: string;
  /** The banner's accessible name. */
  bannerLabel: string;
  page: {
    title: string;
    back: string;
    good: string;
    goodHint: string;
    decisions: string;
    none: string;
    failed: string;
    retry: string;
  };
  /** A decision's headline: what was decided about what. */
  decision: (action: ModerationAction, target: ModerationTargetType, label: string | null) => string;
  on: (date: string) => string;
  until: (date: string) => string;
  appealState: Record<AppealState, string>;
  deskAnswer: string;
  appeal: string;
  openTarget: string;
  sheet: {
    title: string;
    intro: string;
    label: string;
    placeholder: string;
    send: string;
    sent: string;
    tooShort: string;
    counter: (n: number, max: number) => string;
    failed: string;
    about: string;
  };
}

const STRINGS: Record<ModLang, ModerationStrings> = {
  ar: {
    title: {
      restricted: (until) => (until ? `حسابك مقيَّد حتى ${until}` : 'حسابك مقيَّد'),
      suspended: (until) => (until ? `حسابك معلَّق حتى ${until}` : 'حسابك معلَّق'),
      banned: () => 'حسابك محظور',
    },
    meaning: {
      restricted: 'لا يمكنك النشر أو التعليق أو إرسال العروض والطلبات والرسائل الآن. التصفح متاح كالمعتاد، وطلباتك الجارية تكمل طريقها.',
      suspended: 'لا يمكنك النشر أو التعليق أو الإعجاب أو المتابعة أو المراسلة حتى ينتهي التعليق، وصفحتك ومنشوراتك مخفية عن الآخرين.',
      banned: 'لا يمكنك الكتابة في Levonis، ومحتواك مخفي عن الجميع. يبقى لك تسجيل الخروج والاعتراض على القرار.',
    },
    reason: (text) => `السبب: ${text}`,
    appealDoor: 'الاعتراض على القرار',
    bannerLabel: 'حالة حسابك',
    page: {
      title: 'حالة حسابي',
      back: 'رجوع',
      good: 'حسابك بحالة جيدة',
      goodHint: 'لا قيود على حسابك الآن. إن اتخذت الإدارة قرارًا بشأنك أو بشأن محتواك فستجده هنا مع سببه.',
      decisions: 'قرارات الإدارة',
      none: 'لا قرارات بشأن حسابك أو محتواك.',
      failed: 'تعذّر تحميل حالة حسابك.',
      retry: 'إعادة المحاولة',
    },
    decision: (action, target, label) => {
      const q = label ? ` «${label}»` : '';
      if (action === 'restore') {
        if (target === 'post') return `أُعيد إظهار مشروعك${q}`;
        if (target === 'comment' || target === 'request_comment') return 'أُعيد إظهار تعليقك';
        return 'عاد حسابك إلى وضعه الطبيعي';
      }
      if (target === 'post') return `أُخفي مشروعك${q}`;
      if (target === 'comment' || target === 'request_comment') return `أُخفي تعليقك${q}`;
      if (target === 'store') return action === 'suspend' ? `عُلِّق متجرك${q}` : `قرار بشأن متجرك${q}`;
      if (action === 'warn') return 'تنبيه من إدارة Levonis';
      if (action === 'restrict') return 'قُيِّد حسابك';
      if (action === 'suspend') return 'عُلِّق حسابك';
      if (action === 'ban') return 'حُظر حسابك';
      return 'قرار من إدارة Levonis';
    },
    on: (date) => `في ${date}`,
    until: (date) => `حتى ${date}`,
    appealState: {
      open: 'اعتراضك قيد المراجعة',
      accepted: 'قُبل اعتراضك',
      rejected: 'رُفض اعتراضك',
    },
    deskAnswer: 'رد الإدارة:',
    appeal: 'اعتراض',
    openTarget: 'عرض',
    sheet: {
      title: 'الاعتراض على القرار',
      intro: 'اشرح لماذا ترى أن القرار خاطئ. يقرأ فريق Levonis اعتراضك ويرد عليه، ولكل قرار اعتراض واحد.',
      label: 'اعتراضك',
      placeholder: 'ماذا حدث، ولماذا ترى أن القرار لا يناسبه؟',
      send: 'إرسال الاعتراض',
      sent: 'أُرسل اعتراضك. سنبلغك بالنتيجة.',
      tooShort: 'اكتب ثلاثة أحرف على الأقل.',
      counter: (n, max) => `${n} من ${max}`,
      failed: 'تعذّر إرسال الاعتراض. حاول مرة أخرى.',
      about: 'القرار',
    },
  },
  en: {
    title: {
      restricted: (until) => (until ? `Your account is restricted until ${until}` : 'Your account is restricted'),
      suspended: (until) => (until ? `Your account is suspended until ${until}` : 'Your account is suspended'),
      banned: () => 'Your account is banned',
    },
    meaning: {
      restricted: 'You can’t post, comment, or send offers, requests or messages right now. You can browse as usual, and your orders in progress carry on.',
      suspended: 'You can’t post, comment, like, follow or message until the suspension ends, and your page and posts are hidden from others.',
      banned: 'You can’t write anything on Levonis, and your content is hidden from everyone. You can still sign out and appeal the decision.',
    },
    reason: (text) => `Reason: ${text}`,
    appealDoor: 'Appeal the decision',
    bannerLabel: 'Your account’s standing',
    page: {
      title: 'Account standing',
      back: 'Back',
      good: 'Your account is in good standing',
      goodHint: 'There are no limits on your account. If moderation ever decides something about you or your content, you’ll find it here with the reason.',
      decisions: 'Moderation decisions',
      none: 'No decisions about your account or your content.',
      failed: 'Your account standing could not be loaded.',
      retry: 'Try again',
    },
    decision: (action, target, label) => {
      const q = label ? ` “${label}”` : '';
      if (action === 'restore') {
        if (target === 'post') return `Your project${q} is visible again`;
        if (target === 'comment' || target === 'request_comment') return 'Your comment is visible again';
        return 'Your account is back to normal';
      }
      if (target === 'post') return `Your project${q} was hidden`;
      if (target === 'comment' || target === 'request_comment') return `Your comment${q} was hidden`;
      if (target === 'store') return action === 'suspend' ? `Your store${q} was suspended` : `A decision about your store${q}`;
      if (action === 'warn') return 'A warning from Levonis moderation';
      if (action === 'restrict') return 'Your account was restricted';
      if (action === 'suspend') return 'Your account was suspended';
      if (action === 'ban') return 'Your account was banned';
      return 'A decision from Levonis moderation';
    },
    on: (date) => `On ${date}`,
    until: (date) => `Until ${date}`,
    appealState: {
      open: 'Your appeal is being reviewed',
      accepted: 'Your appeal was accepted',
      rejected: 'Your appeal was rejected',
    },
    deskAnswer: 'Moderation’s answer:',
    appeal: 'Appeal',
    openTarget: 'View',
    sheet: {
      title: 'Appeal the decision',
      intro: 'Explain why you think the decision is wrong. The Levonis team reads your appeal and answers it; each decision can be appealed once.',
      label: 'Your appeal',
      placeholder: 'What happened, and why doesn’t the decision fit it?',
      send: 'Send appeal',
      sent: 'Your appeal was sent. We’ll tell you the outcome.',
      tooShort: 'Write at least three characters.',
      counter: (n, max) => `${n} of ${max}`,
      failed: 'The appeal could not be sent. Try again.',
      about: 'The decision',
    },
  },
  ckb: {
    title: {
      restricted: (until) => (until ? `هەژمارەکەت تا ${until} سنووردار کراوە` : 'هەژمارەکەت سنووردار کراوە'),
      suspended: (until) => (until ? `هەژمارەکەت تا ${until} ڕاگیراوە` : 'هەژمارەکەت ڕاگیراوە'),
      banned: () => 'هەژمارەکەت قەدەغە کراوە',
    },
    meaning: {
      restricted: 'ئێستا ناتوانیت پۆست بکەیت، کۆمێنت بنووسیت، یان ئۆفەر و داواکاری و پەیام بنێریت. وەک هەمیشە دەتوانیت بگەڕێیت، و داواکارییە بەردەوامەکانت درێژە دەکێشن.',
      suspended: 'تا کۆتایی ڕاگرتنەکە ناتوانیت پۆست بکەیت، کۆمێنت بنووسیت، لایک بکەیت، شوێن کەس بکەویت یان پەیام بنێریت، و پەڕە و پۆستەکانت لە کەسانی تر شاراونەتەوە.',
      banned: 'ناتوانیت هیچ شتێک لە Levonis بنووسیت، و ناوەڕۆکەکەت لە هەمووان شاراوەتەوە. هێشتا دەتوانیت دەربچیت و ناڕەزایی لەسەر بڕیارەکە دەرببڕیت.',
    },
    reason: (text) => `هۆکار: ${text}`,
    appealDoor: 'ناڕەزایی لەسەر بڕیارەکە',
    bannerLabel: 'دۆخی هەژمارەکەت',
    page: {
      title: 'دۆخی هەژمارەکەم',
      back: 'گەڕانەوە',
      good: 'هەژمارەکەت لە دۆخێکی باشدایە',
      goodHint: 'ئێستا هیچ سنووردارکردنێک لەسەر هەژمارەکەت نییە. ئەگەر بەڕێوەبردن بڕیارێکی لەسەر تۆ یان ناوەڕۆکەکەت دا، لێرە لەگەڵ هۆکارەکەی دەیبینیت.',
      decisions: 'بڕیارەکانی بەڕێوەبردن',
      none: 'هیچ بڕیارێک لەسەر هەژمار یان ناوەڕۆکەکەت نییە.',
      failed: 'دۆخی هەژمارەکەت بار نەکرا.',
      retry: 'دووبارە هەوڵ بدەرەوە',
    },
    decision: (action, target, label) => {
      const q = label ? ` «${label}»` : '';
      if (action === 'restore') {
        if (target === 'post') return `پڕۆژەکەت${q} دووبارە دەرخرایەوە`;
        if (target === 'comment' || target === 'request_comment') return 'کۆمێنتەکەت دووبارە دەرخرایەوە';
        return 'هەژمارەکەت گەڕایەوە دۆخی ئاسایی';
      }
      if (target === 'post') return `پڕۆژەکەت${q} شاردرایەوە`;
      if (target === 'comment' || target === 'request_comment') return `کۆمێنتەکەت${q} شاردرایەوە`;
      if (target === 'store') return action === 'suspend' ? `فرۆشگاکەت${q} ڕاگیرا` : `بڕیارێک دەربارەی فرۆشگاکەت${q}`;
      if (action === 'warn') return 'ئاگادارکردنەوەیەک لە بەڕێوەبردنی Levonis';
      if (action === 'restrict') return 'هەژمارەکەت سنووردار کرا';
      if (action === 'suspend') return 'هەژمارەکەت ڕاگیرا';
      if (action === 'ban') return 'هەژمارەکەت قەدەغە کرا';
      return 'بڕیارێک لە بەڕێوەبردنی Levonis';
    },
    on: (date) => `لە ${date}`,
    until: (date) => `تا ${date}`,
    appealState: {
      open: 'ناڕەزاییەکەت لە پێداچوونەوەدایە',
      accepted: 'ناڕەزاییەکەت پەسەند کرا',
      rejected: 'ناڕەزاییەکەت ڕەتکرایەوە',
    },
    deskAnswer: 'وەڵامی بەڕێوەبردن:',
    appeal: 'ناڕەزایی',
    openTarget: 'بینین',
    sheet: {
      title: 'ناڕەزایی لەسەر بڕیارەکە',
      intro: 'ڕوونی بکەرەوە بۆچی پێتوایە بڕیارەکە هەڵەیە. تیمی Levonis ناڕەزاییەکەت دەخوێنێتەوە و وەڵامی دەداتەوە؛ بۆ هەر بڕیارێک یەک ناڕەزایی هەیە.',
      label: 'ناڕەزاییەکەت',
      placeholder: 'چی ڕوویدا، و بۆچی بڕیارەکە لەگەڵیدا ناگونجێت؟',
      send: 'ناردنی ناڕەزایی',
      sent: 'ناڕەزاییەکەت نێردرا. ئەنجامەکەت پێ ڕادەگەیەنین.',
      tooShort: 'لانیکەم سێ پیت بنووسە.',
      counter: (n, max) => `${n} لە ${max}`,
      failed: 'ناڕەزاییەکە نەنێردرا. دووبارە هەوڵ بدەرەوە.',
      about: 'بڕیارەکە',
    },
  },
};

export const MODERATION_STRINGS = STRINGS;

export function moderationStrings(lang: string): ModerationStrings {
  return STRINGS[modLang(lang)];
}

export function useModerationStrings(): ModerationStrings {
  const { lang } = useLanguage();
  return moderationStrings(lang);
}
