/**
 * REPUTATION V2'S WORDS — Arabic, English and written Sorani, every key in all
 * three (docs/COMMUNITY_ECOSYSTEM.md D6, §9.6). The server answers closed keys
 * (`BADGE_KEYS`) and numbers (`rule_params`, the merchant's own figures); every
 * sentence a person reads is built here, from those numbers, so a rule the
 * owner re-tunes on the server reads right the same night.
 *
 *   the chips      a badge's name, «لماذا؟», «تحمله منذ …», «عن الشارات»
 *                  (./BadgeChips.tsx — on the store hero, the directory card,
 *                  the creator page);
 *   the page       /community/badges — each rule, how the badges are made
 *                  (src/pages/community/Badges.tsx);
 *   the merchant   «سمعتك»: the evidence per badge, what is missing for the
 *                  rest, the 30- and 90-day figures
 *                  (src/components/merchant/analytics/ReputationCard.tsx);
 *   the store      «يرد عادةً خلال …» (`respondsWithin`).
 *
 * Numbers are written with Latin digits, as the rest of the community's
 * counts are; an Arabic counted noun takes the form its number asks for
 * (`arCount`), a Sorani one stays singular after a number, as Sorani does.
 */
import { useLanguage } from '../../../LanguageContext';
import type { BadgeKey, BadgeRuleParams } from './api';

export type RepLang = 'ar' | 'en' | 'ckb';

export function repLang(lang: string): RepLang {
  return lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
}

// ------------------------------------------------------------ numbers

/** An Arabic counted noun: «يوم واحد», «يومان», «3 أيام», «30 يومًا», «100 يوم». */
interface ArForms {
  one: string;
  two: string;
  few: string;
  many: string;
  hundred: string;
}

export function arCount(n: number, f: ArForms): string {
  const v = Math.max(0, Math.round(n));
  if (v === 1) return f.one;
  if (v === 2) return f.two;
  const r = v % 100;
  if (r >= 3 && r <= 10) return `${v} ${f.few}`;
  if (r >= 11 && r <= 99) return `${v} ${f.many}`;
  return `${v} ${f.hundred}`;
}

const AR_DAYS: ArForms = { one: 'يوم واحد', two: 'يومان', few: 'أيام', many: 'يومًا', hundred: 'يوم' };
const AR_ORDERS: ArForms = { one: 'طلب واحد', two: 'طلبان', few: 'طلبات', many: 'طلبًا', hundred: 'طلب' };
const AR_THREADS: ArForms = { one: 'محادثة واحدة', two: 'محادثتان', few: 'محادثات', many: 'محادثة', hundred: 'محادثة' };

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * «ساعة», «ربع ساعة», «يوم» — how long, as the bounds the server counts in
 * (15, 30, 60, 120, 240, 480, 1440 minutes) and any other number of minutes.
 * English and Sorani return the phrase that follows «within» / «لە ماوەی».
 */
export function withinWords(minutes: number, lang: RepLang): string {
  const m = Math.max(1, Math.round(minutes));
  if (lang === 'en') {
    if (m === 30) return 'half an hour';
    if (m === 60) return 'an hour';
    if (m === 1440) return 'a day';
    if (m % 1440 === 0) return `${m / 1440} days`;
    if (m % 60 === 0) return `${m / 60} hours`;
    return `${m} minutes`;
  }
  if (lang === 'ckb') {
    if (m === 30) return 'نیو کاتژمێر';
    if (m === 60) return 'کاتژمێرێک';
    if (m === 1440) return 'ڕۆژێک';
    if (m % 1440 === 0) return `${m / 1440} ڕۆژ`;
    if (m % 60 === 0) return `${m / 60} کاتژمێر`;
    return `${m} خولەک`;
  }
  if (m === 15) return 'ربع ساعة';
  if (m === 30) return 'نصف ساعة';
  if (m === 1440) return 'يوم';
  if (m % 1440 === 0) return arCount(m / 1440, AR_DAYS);
  if (m % 60 === 0) {
    const h = m / 60;
    return h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : h <= 10 ? `${h} ساعات` : `${h} ساعة`;
  }
  return m <= 10 ? `${m} دقائق` : `${m} دقيقة`;
}

/** A Baghdad day ('YYYY-MM-DD') or an instant, as the reader's calendar writes it; ISO when the engine lacks the locale. */
export function repDate(iso: string | null | undefined, lang: RepLang): string {
  if (!iso) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00.000Z` : iso);
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

// ------------------------------------------------------------ the rules

/**
 * The numbers each rule compares, as the server published them on the day
 * this build was written (worker/lib/reputation.ts `BADGE_RULES`). Used only
 * until `GET /api/community/badges` answers, or when it cannot (a store host,
 * the community closed): a sentence with the published numbers is better than
 * none, and the catalogue replaces it the moment it lands.
 */
export const DEFAULT_RULE_PARAMS: Record<BadgeKey, BadgeRuleParams> = {
  verified_merchant: { verified: true },
  fast_response: { window_days: 30, median_within_minutes: 60, min_threads: 10 },
  reliable_seller: { window_days: 90, min_completed: 20, max_merchant_cancel_percent: 3, max_disputes_lost: 0 },
  custom_specialist: { window_days: 90, min_custom_completed: 10, accepts_custom_requests: true },
  high_completion: { window_days: 90, min_completion_percent: 95, min_orders: 20 },
};

/** A badge's rule, as one sentence, from the numbers it compares. */
export function ruleSentence(key: BadgeKey, params: BadgeRuleParams | null | undefined, lang: RepLang): string {
  const p = { ...DEFAULT_RULE_PARAMS[key], ...(params ?? {}) };
  const days = num(p.window_days, 30);
  switch (key) {
    case 'verified_merchant':
      return lang === 'en'
        ? 'Levonis has reviewed this merchant and verified them.'
        : lang === 'ckb'
          ? 'Levonis ئەم بازرگانەی پشکنیوە و پشتڕاستی کردووەتەوە.'
          : 'راجعت Levonis هذا التاجر ووثّقته.';
    case 'fast_response': {
      const within = num(p.median_within_minutes, 60);
      const min = num(p.min_threads, 10);
      return lang === 'en'
        ? `Over the last ${days} days, at least half of its first replies came within ${withinWords(within, 'en')}, across ${min} or more conversations.`
        : lang === 'ckb'
          ? `لە ${days} ڕۆژی ڕابردوودا، لانیکەم نیوەی یەکەم وەڵامەکانی لە ماوەی ${withinWords(within, 'ckb')}دا بوون، لە ${min} گفتوگۆ یان زیاتردا.`
          : `في آخر ${arCount(days, AR_DAYS)}، جاء نصف ردوده الأولى على الأقل خلال ${withinWords(within, 'ar')}، على ${arCount(min, AR_THREADS)} أو أكثر.`;
    }
    case 'reliable_seller': {
      const min = num(p.min_completed, 20);
      const cancel = num(p.max_merchant_cancel_percent, 3);
      const lost = num(p.max_disputes_lost, 0);
      if (lang === 'en') {
        return `Completed at least ${min} orders in the last ${days} days, cancelled ${cancel}% or fewer of them itself, and ${lost === 0 ? 'lost no dispute' : `lost no more than ${lost} disputes`}.`;
      }
      if (lang === 'ckb') {
        return `لە ${days} ڕۆژی ڕابردوودا لانیکەم ${min} داواکاریی تەواو کردووە، ${cancel}٪ یان کەمتری خۆی هەڵوەشاندووەتەوە، و ${lost === 0 ? 'هیچ ناکۆکییەکی نەدۆڕاندووە' : `زیاتر لە ${lost} ناکۆکیی نەدۆڕاندووە`}.`;
      }
      return `أنجز ${arCount(min, AR_ORDERS)} على الأقل في آخر ${arCount(days, AR_DAYS)}، وألغى بنفسه ${cancel}٪ منها أو أقل، و${lost === 0 ? 'لم يخسر أي نزاع' : `لم يخسر أكثر من ${lost} نزاعات`}.`;
    }
    case 'custom_specialist': {
      const min = num(p.min_custom_completed, 10);
      return lang === 'en'
        ? `Takes custom print requests, and completed at least ${min} of them in the last ${days} days.`
        : lang === 'ckb'
          ? `داواکاریی چاپی تایبەت وەردەگرێت، و لە ${days} ڕۆژی ڕابردوودا لانیکەم ${min} دانەی لێ تەواو کردووە.`
          : `يستقبل طلبات الطباعة المخصصة، وأنجز ${arCount(min, AR_ORDERS)} منها على الأقل في آخر ${arCount(days, AR_DAYS)}.`;
    }
    case 'high_completion': {
      const pct = num(p.min_completion_percent, 95);
      const min = num(p.min_orders, 20);
      return lang === 'en'
        ? `Completed at least ${pct}% of its orders in the last ${days} days, across ${min} or more orders.`
        : lang === 'ckb'
          ? `لە ${days} ڕۆژی ڕابردوودا لانیکەم ${pct}٪ی داواکارییەکانی تەواو کردووە، لە ${min} داواکاری یان زیاتردا.`
          : `أنجز ${pct}٪ على الأقل من طلباته في آخر ${arCount(days, AR_DAYS)}، على ${arCount(min, AR_ORDERS)} أو أكثر.`;
    }
  }
}

/** «يرد عادةً خلال ساعة» — the store's response line, from `responds_within_minutes`. */
export function respondsWithin(minutes: number, lang: RepLang): string {
  return lang === 'en'
    ? `Usually replies within ${withinWords(minutes, 'en')}`
    : lang === 'ckb'
      ? `بە زۆری لە ماوەی ${withinWords(minutes, 'ckb')}دا وەڵام دەداتەوە`
      : `يرد عادةً خلال ${withinWords(minutes, 'ar')}`;
}

// ------------------------------------------------------------ the table

export interface ReputationStrings {
  /** The popover's question, and the chip's accessible hint. */
  why: string;
  /** The chip list's accessible name. */
  badgesLabel: string;
  names: Record<BadgeKey, string>;
  /** «تحمله منذ 3 أكتوبر 2026». */
  since: (date: string) => string;
  /** The popover's way to the page. */
  aboutBadges: string;
  close: string;
  page: {
    kicker: string;
    title: string;
    intro: string;
    how: string;
    rule: string;
    back: string;
    failed: string;
  };
  card: {
    title: string;
    through: (date: string) => string;
    earned: string;
    notEarned: string;
    none: string;
    calculating: string;
    window: (days: number) => string;
    median: string;
    firstReplies: string;
    completed: string;
    customCompleted: string;
    completion: string;
    cancelled: string;
    disputesLost: string;
    under: (min: number) => string;
    progress: (have: number, need: number) => string;
    respondsLine: string;
    noResponseLine: string;
    evidence: {
      median: string;
      threads: string;
      completed: string;
      cancel: string;
      lost: string;
      custom: string;
      completion: string;
      orders: string;
      verified: string;
    };
    failed: string;
    retry: string;
  };
}

const STRINGS: Record<RepLang, ReputationStrings> = {
  ar: {
    why: 'لماذا؟',
    badgesLabel: 'شارات الثقة',
    names: {
      verified_merchant: 'تاجر موثّق',
      fast_response: 'يرد بسرعة',
      reliable_seller: 'بائع موثوق',
      custom_specialist: 'متخصص بالطباعة حسب الطلب',
      high_completion: 'نسبة إنجاز عالية',
    },
    since: (date) => `تحمله منذ ${date}`,
    aboutBadges: 'عن الشارات',
    close: 'إغلاق',
    page: {
      kicker: 'مجتمع ليفو',
      title: 'شارات الثقة',
      intro: 'شارات تحسبها Levonis من أرقام المتجر الفعلية — كي تعرف من يرد بسرعة ومن يُنجز ما يعد به قبل أن تطلب.',
      how: 'تُحسب كل ليلة من محادثات المتجر وطلباته في آخر 30 أو 90 يومًا. لا تُشترى، ولا يختارها التاجر، وتزول حين تزول أرقامها.',
      rule: 'القاعدة',
      back: 'رجوع',
      failed: 'تعذّر تحميل الشارات الآن. القواعد أدناه كما نُشرت آخر مرة.',
    },
    card: {
      title: 'سمعتك',
      through: (date) => `تُحسب كل ليلة من محادثاتك وطلباتك — حتى ${date}`,
      earned: 'شاراتك',
      notEarned: 'لم تكسبها بعد',
      none: 'لا شارات بعد — كل شارة تشرح أدناه ما ينقصها.',
      calculating: 'قيد الحساب — تظهر أرقامك بعد أول ليلة.',
      window: (days) => `آخر ${arCount(days, AR_DAYS)}`,
      median: 'الرد الأول عادةً',
      firstReplies: 'محادثات محسوبة',
      completed: 'طلبات منجزة',
      customCompleted: 'طلبات مخصصة منجزة',
      completion: 'نسبة الإنجاز',
      cancelled: 'ألغيتها أنت',
      disputesLost: 'نزاعات خسرتها',
      under: (min) => `أقل من ${arCount(min, AR_THREADS)}`,
      progress: (have, need) => `${have} من ${need}`,
      respondsLine: 'ما يقرؤه زبائنك على متجرك',
      noResponseLine: 'لا يظهر سطر «يرد عادةً» حتى تُحسب 10 محادثات على الأقل.',
      evidence: {
        median: 'نصف ردودك الأولى خلال',
        threads: 'محادثات',
        completed: 'منجزة',
        cancel: 'ألغيتها أنت',
        lost: 'نزاعات خسرتها',
        custom: 'مخصصة منجزة',
        completion: 'الإنجاز',
        orders: 'طلبات منتهية',
        verified: 'وثّقت Levonis متجرك',
      },
      failed: 'تعذّر تحميل سمعتك الآن.',
      retry: 'إعادة المحاولة',
    },
  },
  en: {
    why: 'Why?',
    badgesLabel: 'Trust badges',
    names: {
      verified_merchant: 'Verified merchant',
      fast_response: 'Fast response',
      reliable_seller: 'Reliable seller',
      custom_specialist: 'Custom printing specialist',
      high_completion: 'High completion rate',
    },
    since: (date) => `Held since ${date}`,
    aboutBadges: 'About badges',
    close: 'Close',
    page: {
      kicker: 'Levo Community',
      title: 'Trust badges',
      intro: 'Badges Levonis computes from a store’s actual figures — so you know who answers fast and who delivers what they promise, before you order.',
      how: 'They are computed every night from the store’s conversations and orders over the last 30 or 90 days. They can’t be bought, the merchant doesn’t choose them, and they go away when the figures do.',
      rule: 'The rule',
      back: 'Back',
      failed: 'The badges could not be loaded right now. The rules below are as last published.',
    },
    card: {
      title: 'Your reputation',
      through: (date) => `Computed every night from your conversations and orders — through ${date}`,
      earned: 'Your badges',
      notEarned: 'Not earned yet',
      none: 'No badges yet — each one below says what it still needs.',
      calculating: 'Being computed — your figures appear after the first night.',
      window: (days) => `Last ${days} days`,
      median: 'Usual first reply',
      firstReplies: 'Conversations counted',
      completed: 'Orders completed',
      customCompleted: 'Custom orders completed',
      completion: 'Completion rate',
      cancelled: 'Cancelled by you',
      disputesLost: 'Disputes lost',
      under: (min) => `Under ${min} conversations`,
      progress: (have, need) => `${have} of ${need}`,
      respondsLine: 'What customers read on your store',
      noResponseLine: 'The “usually replies” line appears once at least 10 conversations are counted.',
      evidence: {
        median: 'Half your first replies within',
        threads: 'conversations',
        completed: 'completed',
        cancel: 'cancelled by you',
        lost: 'disputes lost',
        custom: 'custom completed',
        completion: 'completion',
        orders: 'orders ended',
        verified: 'Levonis verified your store',
      },
      failed: 'Your reputation could not be loaded right now.',
      retry: 'Try again',
    },
  },
  ckb: {
    why: 'بۆچی؟',
    badgesLabel: 'نیشانەکانی متمانە',
    names: {
      verified_merchant: 'بازرگانی پشتڕاستکراو',
      fast_response: 'وەڵامدانەوەی خێرا',
      reliable_seller: 'فرۆشیاری متمانەپێکراو',
      custom_specialist: 'پسپۆڕی چاپی تایبەت',
      high_completion: 'ڕێژەی تەواوکردنی بەرز',
    },
    since: (date) => `لە ${date}ەوە هەیەتی`,
    aboutBadges: 'دەربارەی نیشانەکان',
    close: 'داخستن',
    page: {
      kicker: 'کۆمەڵگەی لیڤۆ',
      title: 'نیشانەکانی متمانە',
      intro: 'ئەو نیشانانەی Levonis لە ژمارە ڕاستەقینەکانی فرۆشگاکەوە هەژماریان دەکات — بۆ ئەوەی پێش داواکردن بزانیت کێ خێرا وەڵام دەداتەوە و کێ بەڵێنەکەی جێبەجێ دەکات.',
      how: 'هەموو شەوێک لە گفتوگۆ و داواکارییەکانی فرۆشگاکە لە 30 یان 90 ڕۆژی ڕابردوودا هەژمار دەکرێن. ناکڕدرێن، بازرگان هەڵیان نابژێرێت، و کاتێک ژمارەکان نەمان نیشانەکانیش نامێنن.',
      rule: 'یاساکە',
      back: 'گەڕانەوە',
      failed: 'ئێستا نیشانەکان بار نەکران. یاساکانی خوارەوە وەک دوایین جار بڵاوکرانەوەن.',
    },
    card: {
      title: 'ناوبانگەکەت',
      through: (date) => `هەموو شەوێک لە گفتوگۆ و داواکارییەکانتەوە هەژمار دەکرێت — تا ${date}`,
      earned: 'نیشانەکانت',
      notEarned: 'هێشتا بەدەستت نەهێناوە',
      none: 'هێشتا هیچ نیشانەیەکت نییە — هەر یەکێکیان لە خوارەوە دەڵێت چی کەمە.',
      calculating: 'لە هەژمارکردندایە — ژمارەکانت دوای یەکەم شەو دەردەکەون.',
      window: (days) => `${days} ڕۆژی ڕابردوو`,
      median: 'یەکەم وەڵامی ئاسایی',
      firstReplies: 'گفتوگۆی هەژمارکراو',
      completed: 'داواکاریی تەواوکراو',
      customCompleted: 'داواکاریی تایبەتی تەواوکراو',
      completion: 'ڕێژەی تەواوکردن',
      cancelled: 'خۆت هەڵتوەشاندووەتەوە',
      disputesLost: 'ناکۆکیی دۆڕاو',
      under: (min) => `کەمتر لە ${min} گفتوگۆ`,
      progress: (have, need) => `${have} لە ${need}`,
      respondsLine: 'ئەوەی کڕیارەکانت لەسەر فرۆشگاکەت دەیخوێننەوە',
      noResponseLine: 'دێڕی «بە زۆری وەڵام دەداتەوە» دەرناکەوێت تا لانیکەم 10 گفتوگۆ هەژمار نەکرێن.',
      evidence: {
        median: 'نیوەی یەکەم وەڵامەکانت لە ماوەی',
        threads: 'گفتوگۆ',
        completed: 'تەواوکراو',
        cancel: 'خۆت هەڵتوەشاندووەتەوە',
        lost: 'ناکۆکیی دۆڕاو',
        custom: 'تایبەتی تەواوکراو',
        completion: 'تەواوکردن',
        orders: 'داواکاریی کۆتاییهاتوو',
        verified: 'Levonis فرۆشگاکەتی پشتڕاست کردووەتەوە',
      },
      failed: 'ئێستا ناوبانگەکەت بار نەکرا.',
      retry: 'دووبارە هەوڵ بدەرەوە',
    },
  },
};

export const REPUTATION_STRINGS = STRINGS;

export function reputationStrings(lang: string): ReputationStrings {
  return STRINGS[repLang(lang)];
}

export function useReputationStrings(): ReputationStrings {
  const { lang } = useLanguage();
  return reputationStrings(lang);
}
