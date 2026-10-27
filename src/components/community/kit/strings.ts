/**
 * THE KIT WORDS — every key in Arabic, English and Sorani (docs/DECISIONS.md
 * row 183: a Sorani slot is written in Sorani, never the Arabic copied).
 * The primitives of src/components/community/kit/ say only these; a screen
 * passes its own labels. tests/communityScope.test.ts holds the three
 * languages to the same keys and every Sorani value to its own text.
 *
 * Counters and steps are Latin digits in every language (plan R13).
 *
 * The shared parts of community UI plan B2 say their words here too: the
 * section page header, the sections and account menu (IMG_8478) and the
 * follow button. A Sorani word marked for review in the plan is written in
 * Sorani all the same, never left as the Arabic.
 */
import { useLanguage } from '../../../LanguageContext';

export interface KitStrings {
  clear: string;
  clearSearch: string;
  optional: string;
  /** The counter read aloud: «12 من 140 حرفًا». */
  counter: (n: number, max: number) => string;
  opensNewTab: string;
  seeAll: string;
  selected: string;
  choose: string;
  removeFilter: string;
  remove: string;
  reorder: string;
  /** The chosen cover photo, read after its picture (the badge is drawn, this is said). */
  cover: string;
  /** The progress steps read aloud: «الخطوة 2 من 4». */
  step: (n: number, total: number) => string;
  /** A photo counter read aloud: «الصورة 1 من 3». */
  photo: (n: number, total: number) => string;
  decrease: string;
  increase: string;
  /** The back chevron of a section page header. */
  back: string;
  /** The kicker over a section title. */
  communityName: string;
  /** The door to the sections menu in a section header. */
  sections: string;
  /** The sections menu (IMG_8478): its title, the account door, the two groups. */
  sectionsAndAccount: string;
  myAccount: string;
  community: string;
  communityHint: string;
  communityHome: string;
  yourAccount: string;
  yourAccountHint: string;
  storesIFollow: string;
  langTheme: string;
  myStore: string;
  openStore: string;
  close: string;
  /** The follow button, for a person and for a store (plan R12: one form). */
  follow: string;
  following: string;
}

const STRINGS: Record<'ar' | 'en' | 'ckb', KitStrings> = {
  ar: {
    clear: 'مسح',
    clearSearch: 'مسح البحث',
    optional: '(اختياري)',
    counter: (n, max) => `${n} من ${max} حرفًا`,
    opensNewTab: '(يفتح في نافذة جديدة)',
    seeAll: 'عرض الكل',
    selected: 'محدد',
    choose: 'اختر',
    removeFilter: 'إزالة التصفية',
    remove: 'إزالة',
    reorder: 'اسحب لإعادة الترتيب',
    cover: 'الغلاف',
    step: (n, total) => `الخطوة ${n} من ${total}`,
    photo: (n, total) => `الصورة ${n} من ${total}`,
    decrease: 'إنقاص',
    increase: 'زيادة',
    back: 'رجوع',
    communityName: 'مجتمع ليفو',
    sections: 'الأقسام',
    sectionsAndAccount: 'الأقسام والحساب',
    myAccount: 'حسابي',
    community: 'المجتمع',
    communityHint: 'اكتشف وتواصل مع مجتمع ليفو',
    communityHome: 'صفحة المجتمع',
    yourAccount: 'حسابك',
    yourAccountHint: 'إدارة حسابك وتفضيلاتك',
    storesIFollow: 'المتاجر التي أتابعها',
    langTheme: 'اللغة والمظهر',
    myStore: 'متجري',
    openStore: 'افتح متجرك',
    close: 'إغلاق',
    follow: 'متابعة',
    following: 'تتابعه',
  },
  en: {
    clear: 'Clear',
    clearSearch: 'Clear search',
    optional: '(optional)',
    counter: (n, max) => `${n} of ${max} characters`,
    opensNewTab: '(opens in a new tab)',
    seeAll: 'See all',
    selected: 'Selected',
    choose: 'Choose',
    removeFilter: 'Remove filter',
    remove: 'Remove',
    reorder: 'Drag to reorder',
    cover: 'Cover',
    step: (n, total) => `Step ${n} of ${total}`,
    photo: (n, total) => `Photo ${n} of ${total}`,
    decrease: 'Decrease',
    increase: 'Increase',
    back: 'Back',
    communityName: 'Levo Community',
    sections: 'Sections',
    sectionsAndAccount: 'Sections and account',
    myAccount: 'My account',
    community: 'Community',
    communityHint: 'Discover and connect with Levo Community',
    communityHome: 'Community home',
    yourAccount: 'Your account',
    yourAccountHint: 'Manage your account and preferences',
    storesIFollow: 'Stores I follow',
    langTheme: 'Language and appearance',
    myStore: 'My store',
    openStore: 'Open your store',
    close: 'Close',
    follow: 'Follow',
    following: 'Following',
  },
  ckb: {
    clear: 'سڕینەوە',
    clearSearch: 'سڕینەوەی گەڕان',
    optional: '(ئارەزوومەندانە)',
    counter: (n, max) => `${n} لە ${max} پیت`,
    opensNewTab: '(لە پەنجەرەیەکی نوێ دەکرێتەوە)',
    seeAll: 'هەمووی ببینە',
    selected: 'هەڵبژێردراو',
    choose: 'هەڵبژێرە',
    removeFilter: 'لابردنی فلتەر',
    remove: 'لابردن',
    reorder: 'ڕایبکێشە بۆ گۆڕینی ڕیزبەندی',
    cover: 'بەرگ',
    step: (n, total) => `هەنگاوی ${n} لە ${total}`,
    photo: (n, total) => `وێنەی ${n} لە ${total}`,
    decrease: 'کەمکردنەوە',
    increase: 'زیادکردن',
    back: 'گەڕانەوە',
    communityName: 'کۆمەڵگەی لیڤۆ',
    sections: 'بەشەکان',
    sectionsAndAccount: 'بەشەکان و هەژمار',
    myAccount: 'هەژمارەکەم',
    community: 'کۆمەڵگە',
    communityHint: 'کۆمەڵگەی لیڤۆ بدۆزەرەوە و پەیوەندی پێوە بکە',
    communityHome: 'پەڕەی کۆمەڵگە',
    yourAccount: 'هەژمارەکەت',
    yourAccountHint: 'هەژمار و ڕێکخستنەکانت بەڕێوە ببە',
    // † for the Sorani reader: the word of the «شوێنکەوتووەکانم» tab, one line in the menu row
    // from 360px (B2R3-FID-1; «ئەو فرۆشگایانەی شوێنیان دەکەوم» lost its verb to an ellipsis).
    storesIFollow: 'فرۆشگا شوێنکەوتووەکانم',
    langTheme: 'زمان و ڕووکار',
    myStore: 'فرۆشگاکەم',
    openStore: 'فرۆشگاکەت بکەرەوە',
    close: 'داخستن',
    follow: 'شوێنکەوتن',
    following: 'شوێنی دەکەویت',
  },
};

export const KIT_STRINGS = STRINGS;

export function useKitStrings(): KitStrings {
  const { lang } = useLanguage();
  return STRINGS[lang as 'ar' | 'en' | 'ckb'] ?? STRINGS.ar;
}
