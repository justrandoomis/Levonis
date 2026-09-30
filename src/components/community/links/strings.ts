/**
 * LINK CARDS' WORDS — Arabic, English and Sorani, every key in all three
 * (docs/COMMUNITY_ECOSYSTEM.md D6: no Arabic standing in for Sorani). The
 * card itself is drawn by the client wave; these are the words it will use.
 */
import { useLanguage } from '../../../LanguageContext';

export interface LinkStrings {
  open: string;
  print: string;
  hostLine: string;
  noPreview: string;
  loading: string;
  kinds: { model_page: string; video: string; article: string; unknown: string };
  remove: string;
  /** The composer's attachment-menu action: «رابط». */
  link: string;
  /** The chat's link sheet title. */
  sendLink: string;
  urlLabel: string;
  urlPlaceholder: string;
  send: string;
  sending: string;
  /** The sheet's own check before the server sees it: not a web address. */
  invalidUrl: string;
  /** A card whose fetch failed — the bare link went out anyway. */
  fetchFailed: string;
  /** Screen-reader tail on the card's anchor. */
  opensNewTab: string;
}
export type LinkLang = 'ar' | 'en' | 'ckb';

const STRINGS: Record<LinkLang, LinkStrings> = {
  ar: {
    /** The card's primary action — opens the address in a new tab. */
    open: 'افتح الرابط',
    /** On a `model_page` card: pre-fills the request wizard with this link. */
    print: 'اطلب طباعته',
    /** The host line under the title: «من printables.com». */
    hostLine: 'من {host}',
    /** A bare card, a failed fetch, or a page that offered no title. */
    noPreview: 'معاينة غير متاحة',
    /** While the composer waits for the resolve. */
    loading: 'جارٍ تجهيز المعاينة…',
    /** The kind, as a small label. */
    kinds: {
      model_page: 'مجسم للطباعة',
      video: 'فيديو',
      article: 'صفحة',
      unknown: 'رابط',
    },
    /** Remove the card from a draft (the address stays in the text). */
    remove: 'إزالة المعاينة',
    link: 'رابط',
    sendLink: 'إرسال رابط',
    urlLabel: 'عنوان الرابط',
    urlPlaceholder: 'https://…',
    send: 'إرسال',
    sending: 'جارٍ الإرسال…',
    invalidUrl: 'ألصق عنوانًا يبدأ بـ https://',
    fetchFailed: 'تعذّر جلب المعاينة — أُرسل الرابط كما هو',
    opensNewTab: '(يفتح في نافذة جديدة)',
  },
  en: {
    open: 'Open link',
    print: 'Request a print',
    hostLine: 'From {host}',
    noPreview: 'Preview unavailable',
    loading: 'Preparing the preview…',
    kinds: {
      model_page: 'Printable model',
      video: 'Video',
      article: 'Page',
      unknown: 'Link',
    },
    remove: 'Remove preview',
    link: 'Link',
    sendLink: 'Send a link',
    urlLabel: 'Link address',
    urlPlaceholder: 'https://…',
    send: 'Send',
    sending: 'Sending…',
    invalidUrl: 'Paste an address that starts with https://',
    fetchFailed: 'The preview could not be fetched — the link was sent as it is',
    opensNewTab: '(opens in a new tab)',
  },
  ckb: {
    open: 'لینکەکە بکەرەوە',
    print: 'داوای چاپکردنی بکە',
    hostLine: 'لە {host}',
    noPreview: 'پێشبینین بەردەست نییە',
    loading: 'پێشبینینەکە ئامادە دەکرێت…',
    kinds: {
      model_page: 'مۆدێلی چاپکردن',
      video: 'ڤیدیۆ',
      article: 'پەڕە',
      unknown: 'لینک',
    },
    remove: 'پێشبینینەکە لاببە',
    link: 'لینک',
    sendLink: 'ناردنی لینک',
    urlLabel: 'ناونیشانی لینک',
    urlPlaceholder: 'https://…',
    send: 'ناردن',
    sending: 'دەنێردرێت…',
    invalidUrl: 'ناونیشانێک بلکێنە کە بە https:// دەست پێدەکات',
    fetchFailed: 'پێشبینینەکە نەهێنرا — لینکەکە وەک خۆی نێردرا',
    opensNewTab: '(لە پەنجەرەیەکی نوێ دەکرێتەوە)',
  },
};

export function linkStrings(lang: string): LinkStrings {
  return lang === 'en' || lang === 'ckb' ? STRINGS[lang] : STRINGS.ar;
}

export function useLinkStrings(): LinkStrings {
  const { lang } = useLanguage();
  return linkStrings(lang);
}

/** «من printables.com» — the host line with the card's host in it. */
export const hostLine = (s: LinkStrings, host: string): string => s.hostLine.replace('{host}', host);

export { STRINGS as LINK_STRINGS };
