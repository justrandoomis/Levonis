/**
 * THE KIT WORDS — every key in Arabic, English and Sorani (docs/DECISIONS.md
 * row 183: a Sorani slot is written in Sorani, never the Arabic copied).
 * The primitives of src/components/community/kit/ say only these; a screen
 * passes its own labels. tests/communityScope.test.ts holds the three
 * languages to the same keys and every Sorani value to its own text.
 *
 * Counters and steps are Latin digits in every language (plan R13).
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
  },
};

export const KIT_STRINGS = STRINGS;

export function useKitStrings(): KitStrings {
  const { lang } = useLanguage();
  return STRINGS[lang as 'ar' | 'en' | 'ckb'] ?? STRINGS.ar;
}
