/**
 * THE READER'S WORDS, in the three languages the store answers in.
 *
 * They live beside the components rather than in src/translations.ts because
 * nothing outside /policies says any of them, and because a legal library has
 * a register of its own: «الوثيقة» and «المادة», not «الصفحة» and «القسم». A
 * customer arguing a clause and an owner showing a document to a bank are both
 * reading the same page, and it has to sound like a register of documents.
 *
 * ckb falls back to ar the way the rest of the app does — Sorani is the third
 * language, not a third authority.
 */
import { useLanguage } from '../../LanguageContext';

export interface PolicyStrings {
  libraryTitle: string;
  libraryIntro: string;
  governing: string;
  documentCount: (n: number) => string;
  searchLabel: string;
  searchPlaceholder: string;
  searchOpen: string;
  searchClear: string;
  searchResults: (n: number) => string;
  searchEmpty: string;
  searchEmptyHint: string;
  searchLoading: (done: number, total: number) => string;
  searchPartial: string;
  version: string;
  effective: string;
  requiredBadge: string;
  requiredExplain: string;
  back: string;
  toLibrary: string;
  contents: string;
  contentsShow: string;
  article: string;
  copyLink: string;
  copied: string;
  copyFailed: string;
  print: string;
  readingLang: string;
  langName: { ar: string; en: string; ckb: string };
  langFallback: string;
  loadError: string;
  retry: string;
  loading: string;
  notFound: string;
  invalidVersion: string;
  historical: (v: number) => string;
  printedFrom: string;
  printedOn: string;
}

const AR: PolicyStrings = {
  libraryTitle: 'وثائق المتجر',
  libraryIntro:
    'النصوص الرسمية التي تحكم الشراء والدفع والتوصيل والضمان والاسترجاع في Levonis. كل وثيقة تحمل رقم نسختها وتاريخ سريانها، وكل مادة فيها لها رابط مستقل يمكن إرساله.',
  governing:
    'النص العربي هو النص المعتمد. الترجمتان الإنجليزية والكردية أمينتان له وبالترقيم نفسه، وعند أي اختلاف في الفهم يُرجع إلى النص العربي.',
  documentCount: (n) => (n === 1 ? 'وثيقة واحدة' : n === 2 ? 'وثيقتان' : `${n} وثائق`),
  searchLabel: 'البحث في الوثائق',
  searchPlaceholder: 'ابحث عن مادة… أو اكتب رقمها مثل ٤٫٢',
  searchOpen: 'بحث',
  searchClear: 'مسح البحث',
  searchResults: (n) => (n === 1 ? 'مادة واحدة مطابقة' : n === 2 ? 'مادتان مطابقتان' : `${n} مادة مطابقة`),
  searchEmpty: 'لا توجد مادة مطابقة.',
  searchEmptyHint: 'جرّب كلمة واحدة بدل الجملة، أو اكتب رقم المادة مباشرة.',
  searchLoading: (done, total) => `يجري تحضير البحث… ${done} من ${total}`,
  searchPartial: 'البحث يشمل الوثائق المحمّلة حتى الآن، ويتوسّع كلما اكتمل التحميل.',
  version: 'النسخة',
  effective: 'تاريخ السريان',
  requiredBadge: 'مطلوبة عند الشراء',
  requiredExplain: 'لا يُتمّ الطلب قبل قبول هذه الوثيقة.',
  back: 'رجوع',
  toLibrary: 'كل الوثائق',
  contents: 'محتويات الوثيقة',
  contentsShow: 'عرض المحتويات',
  article: 'المادة',
  copyLink: 'نسخ رابط هذه المادة',
  copied: 'نُسخ الرابط',
  copyFailed: 'تعذّر النسخ — انسخ الرابط من شريط العنوان.',
  print: 'طباعة',
  readingLang: 'لغة العرض',
  langName: { ar: 'العربية', en: 'English', ckb: 'کوردی' },
  langFallback: 'لا توجد ترجمة منشورة بهذه اللغة، والنص المعروض هو النص العربي المعتمد.',
  loadError: 'تعذّر تحميل الوثائق.',
  retry: 'إعادة المحاولة',
  loading: 'جارٍ التحميل…',
  notFound: 'لا توجد وثيقة بهذا الاسم في المتجر.',
  invalidVersion: 'رقم النسخة غير صالح، ولم تُعرض نسخة بديلة عنه.',
  historical: (v) => `هذه نسخة محفوظة رقم ${v}، وليست النسخة السارية اليوم.`,
  printedFrom: 'المصدر',
  printedOn: 'تاريخ الطباعة',
};

const EN: PolicyStrings = {
  libraryTitle: 'Store Documents',
  libraryIntro:
    'The official texts governing purchase, payment, delivery, warranty and returns at Levonis. Every document carries its version number and effective date, and every article in it has its own link that can be sent.',
  governing:
    'The Arabic text is the authoritative text. The English and Kurdish translations are faithful to it and carry the same article numbering; where an understanding differs, the Arabic text governs.',
  documentCount: (n) => `${n} document${n === 1 ? '' : 's'}`,
  searchLabel: 'Search the documents',
  searchPlaceholder: 'Search for an article… or type its number, e.g. 4.2',
  searchOpen: 'Search',
  searchClear: 'Clear search',
  searchResults: (n) => `${n} matching article${n === 1 ? '' : 's'}`,
  searchEmpty: 'No article matches.',
  searchEmptyHint: 'Try one word instead of a phrase, or type the article number directly.',
  searchLoading: (done, total) => `Preparing search… ${done} of ${total}`,
  searchPartial: 'Search covers the documents loaded so far, and widens as the rest arrive.',
  version: 'Version',
  effective: 'Effective',
  requiredBadge: 'Required at checkout',
  requiredExplain: 'An order is not completed until this document is accepted.',
  back: 'Back',
  toLibrary: 'All documents',
  contents: 'Contents',
  contentsShow: 'Show contents',
  article: 'Article',
  copyLink: 'Copy a link to this article',
  copied: 'Link copied',
  copyFailed: 'Could not copy — take the link from the address bar.',
  print: 'Print',
  readingLang: 'Reading language',
  langName: { ar: 'العربية', en: 'English', ckb: 'کوردی' },
  langFallback: 'No translation is published in this language; the text shown is the authoritative Arabic.',
  loadError: 'Could not load the documents.',
  retry: 'Retry',
  loading: 'Loading…',
  notFound: 'The store has no document by that name.',
  invalidVersion: 'That version number is not valid, and no replacement version has been shown in its place.',
  historical: (v) => `This is archived version ${v}, not the version in force today.`,
  printedFrom: 'Source',
  printedOn: 'Printed',
};

const CKB: PolicyStrings = {
  libraryTitle: 'بەڵگەنامەکانی فرۆشگا',
  libraryIntro:
    'دەقە فەرمییەکانی کڕین و پارەدان و گەیاندن و گەرەنتی و گەڕاندنەوە لە Levonis. هەر بەڵگەنامەیەک ژمارەی وەشان و بەرواری جێبەجێبوونی هەڵدەگرێت، و هەر بڕگەیەکی بەستەرێکی سەربەخۆی هەیە کە دەنێردرێت.',
  governing:
    'دەقی عەرەبی دەقی پەسەندکراوە. وەرگێڕانی ئینگلیزی و کوردی دڵسۆزن بۆی و هەمان ژمارەی بڕگەیان هەیە؛ لە کاتی جیاوازی لە تێگەیشتندا دەقی عەرەبی حوکم دەدات.',
  documentCount: (n) => `${n} بەڵگەنامە`,
  searchLabel: 'گەڕان لە بەڵگەنامەکان',
  searchPlaceholder: 'بەدوای بڕگەیەکدا بگەڕێ… یان ژمارەکەی بنووسە وەک ٤٫٢',
  searchOpen: 'گەڕان',
  searchClear: 'سڕینەوەی گەڕان',
  searchResults: (n) => `${n} بڕگەی هاوتا`,
  searchEmpty: 'هیچ بڕگەیەکی هاوتا نییە.',
  searchEmptyHint: 'وشەیەک تاق بکەرەوە لە جیاتی ڕستە، یان ژمارەی بڕگەکە ڕاستەوخۆ بنووسە.',
  searchLoading: (done, total) => `ئامادەکردنی گەڕان… ${done} لە ${total}`,
  searchPartial: 'گەڕان ئەو بەڵگەنامانە دەگرێتەوە کە تا ئێستا بارکراون، و فراوان دەبێت کە ئەوانی تر دێن.',
  version: 'وەشان',
  effective: 'بەرواری جێبەجێبوون',
  requiredBadge: 'پێویستە لە کاتی کڕیندا',
  requiredExplain: 'داواکاری تەواو نابێت پێش پەسەندکردنی ئەم بەڵگەنامەیە.',
  back: 'گەڕانەوە',
  toLibrary: 'هەموو بەڵگەنامەکان',
  contents: 'ناوەڕۆکی بەڵگەنامە',
  contentsShow: 'پیشاندانی ناوەڕۆک',
  article: 'بڕگە',
  copyLink: 'لەبەرگرتنەوەی بەستەری ئەم بڕگەیە',
  copied: 'بەستەر لەبەرگیرایەوە',
  copyFailed: 'لەبەرگرتنەوە نەکرا — بەستەرەکە لە شریتی ناونیشانەوە ببە.',
  print: 'چاپکردن',
  readingLang: 'زمانی خوێندنەوە',
  langName: { ar: 'العربية', en: 'English', ckb: 'کوردی' },
  langFallback: 'هیچ وەرگێڕانێک بەم زمانە بڵاونەکراوەتەوە؛ ئەو دەقەی پیشان دەدرێت دەقی پەسەندکراوی عەرەبییە.',
  loadError: 'بەڵگەنامەکان بار نەبوون.',
  retry: 'هەوڵدانەوە',
  loading: 'باردەکرێت…',
  notFound: 'فرۆشگا هیچ بەڵگەنامەیەکی بەم ناوە نییە.',
  invalidVersion: 'ژمارەی وەشانەکە نادروستە، و هیچ وەشانێکی جێگرەوە لە جیاتی پیشان نەدرا.',
  historical: (v) => `ئەمە وەشانی ئەرشیفکراوی ${v}ە، نەک ئەو وەشانەی ئەمڕۆ کار دەکات.`,
  printedFrom: 'سەرچاوە',
  printedOn: 'بەرواری چاپ',
};

const TABLE = { ar: AR, en: EN, ckb: CKB } as const;

export function policyStrings(lang: string): PolicyStrings {
  return TABLE[lang as keyof typeof TABLE] ?? AR;
}

export function usePolicyStrings(): PolicyStrings {
  const { lang } = useLanguage();
  return policyStrings(lang);
}

/**
 * A policy's effective date, in the reader's language and ALWAYS Gregorian.
 *
 * `toLocaleDateString('ar')` follows the runtime's idea of the Arabic calendar,
 * and on a device configured for a Hijri calendar that turns 2026-01-01 into a
 * different year entirely. An effective date is the operative fact of a legal
 * document — the day a version starts binding people — so the calendar is
 * pinned rather than inherited, and a reader comparing the date on screen with
 * the date on a printed receipt sees the same one.
 */
export function formatPolicyDate(iso: string | null | undefined, lang: string): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  const locale = lang === 'en' ? 'en-GB' : lang === 'ckb' ? 'ckb-IQ' : 'ar-IQ';
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric', calendar: 'gregory' };
  try {
    return new Date(iso).toLocaleDateString(locale, options);
  } catch {
    // An unknown locale tag (older engines reject ckb-IQ) must not cost the
    // reader the date itself.
    return new Date(iso).toLocaleDateString('en-GB', options);
  }
}
