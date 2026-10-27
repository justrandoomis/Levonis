/**
 * THE DIRECTORY WORDS (community UI plan C5): the stores page (IMG_8469) and
 * the makers page (IMG_8476), in Arabic, English and Sorani, every key in all
 * three (docs/DECISIONS.md row 183: a Sorani slot never carries the Arabic).
 * The words the home already says (the section names, the empty lists, the
 * search placeholders, «مسح الفلاتر») stay in hub/strings.ts and are read
 * from there, so one idea has one wording.
 *
 * «FDM» is the process name in every language, as the printers write it.
 */
import { useLanguage } from '../../../LanguageContext';

export interface DirectoryWords {
  /** The chips row, read before the chips. */
  storeFilters: string;
  governorate: string;
  allGovernorates: string;
  fdm: string;
  resin: string;
  design: string;
  takesRequests: string;
  visitStore: string;
  noStoresFiltered: string;
  viewProfile: string;
  filter: string;
  /** «تصفية، 2 مفعّلة»: the filter button when filters are on. */
  filtersOn: (n: number) => string;
  sort: string;
  sortRecent: string;
  sortFeatured: string;
  sortFollowers: string;
  show: string;
  hasStore: string;
  approved: string;
  noMakersFiltered: string;
  done: string;
  /** The place line, read aloud before the governorate. */
  place: string;
}

export const DIRECTORY_STRINGS: Record<'ar' | 'en' | 'ckb', DirectoryWords> = {
  ar: {
    storeFilters: 'تصفية المتاجر',
    governorate: 'المحافظة',
    allGovernorates: 'كل المحافظات',
    fdm: 'FDM',
    resin: 'ريزن',
    design: 'تصميم',
    takesRequests: 'يقبل طلبات خاصة',
    visitStore: 'زيارة المتجر',
    noStoresFiltered: 'لا متاجر تطابق هذه الفلاتر',
    viewProfile: 'عرض الملف',
    filter: 'تصفية',
    filtersOn: (n) => `تصفية، ${n} مفعّلة`,
    sort: 'الترتيب',
    sortRecent: 'الأحدث نشاطًا',
    sortFeatured: 'الأكثر مشاريع',
    sortFollowers: 'الأكثر متابعين',
    show: 'إظهار',
    hasStore: 'لديهم متجر',
    approved: 'مزوّد معتمد',
    noMakersFiltered: 'لا صنّاع يطابقون البحث',
    done: 'تم',
    place: 'المحافظة',
  },
  en: {
    storeFilters: 'Filter stores',
    governorate: 'Governorate',
    allGovernorates: 'All governorates',
    fdm: 'FDM',
    resin: 'Resin',
    design: 'Design',
    takesRequests: 'Takes custom requests',
    visitStore: 'Visit store',
    noStoresFiltered: 'No stores match these filters',
    viewProfile: 'View profile',
    filter: 'Filter',
    filtersOn: (n) => `Filter, ${n} on`,
    sort: 'Order',
    sortRecent: 'Recently active',
    sortFeatured: 'Most projects',
    sortFollowers: 'Most followed',
    show: 'Show',
    hasStore: 'Has a store',
    approved: 'Approved provider',
    noMakersFiltered: 'No makers match',
    done: 'Done',
    place: 'Governorate',
  },
  ckb: {
    storeFilters: 'پاڵاوتنی فرۆشگاکان',
    governorate: 'پارێزگا',
    allGovernorates: 'هەموو پارێزگاکان',
    fdm: 'FDM',
    resin: 'ڕێزن',
    design: 'دیزاین',
    takesRequests: 'داواکاریی تایبەت وەردەگرێت',
    visitStore: 'بینینی فرۆشگا',
    noStoresFiltered: 'هیچ فرۆشگایەک لەگەڵ ئەم پاڵاوتنانە ناگونجێت',
    viewProfile: 'بینینی پرۆفایل',
    filter: 'پاڵاوتن',
    filtersOn: (n) => `پاڵاوتن، ${n} چالاکە`,
    sort: 'ڕیزبەندی',
    sortRecent: 'چالاکترینی ئەم دواییە',
    sortFeatured: 'زۆرترین پڕۆژە',
    sortFollowers: 'زۆرترین شوێنکەوتوو',
    show: 'پیشاندان',
    hasStore: 'فرۆشگای هەیە',
    approved: 'دابینکەری پەسەندکراو',
    noMakersFiltered: 'هیچ دروستکەرێک ناگونجێت',
    done: 'تەواو',
    place: 'پارێزگا',
  },
};

export function useDirectoryStrings(): DirectoryWords {
  const { lang } = useLanguage();
  return DIRECTORY_STRINGS[lang === 'en' || lang === 'ckb' ? lang : 'ar'];
}

/** The first line of the bio: the specialty line the maker card draws (plan D-12; no `headline` field is built). */
export function specialtyLine(bio: string | null | undefined): string {
  return (bio ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}
