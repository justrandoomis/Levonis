/**
 * THE COMMUNITY HOME'S WORDS — Arabic, English and Sorani, every key in all
 * three (docs/COMMUNITY_ECOSYSTEM.md decision D6: no Arabic standing in for
 * Sorani). The counted nouns follow src/components/community/hub/copy.ts's
 * rule for Arabic and count with the bare noun in Sorani, as
 * src/components/community/social/strings.ts does.
 */
import { useLanguage } from '../../../LanguageContext';
import type { PostKind } from '../projects/api';

const STRINGS = {
  ar: {
    kicker: 'مجتمع ليفو · ما صنعه الصنّاع',
    title: 'مجتمع ليفو',
    dek: 'ما يطبعه الصنّاع، وما تحتاجه الورش.',
    back: 'رجوع',
    clearSearch: 'مسح البحث',
    sections: 'أقسام المجتمع',
    shortcuts: 'اختصارات المجتمع',
    search: {
      projects: 'ابحث في المشاريع',
      stores: 'ابحث عن متجر أو ورشة',
      requests: 'ابحث في طلبات الطباعة',
      products: 'ابحث في منتجات المجتمع',
      creators: 'ابحث عن صانع',
    },
    tabs: {
      foryou: 'لك',
      following: 'أتابعهم',
      projects: 'المشاريع',
      requests: 'طلبات الطباعة',
      stores: 'المتاجر',
      creators: 'الصنّاع',
    },
    printRequest: 'طلب طباعة',
    shareProject: 'شارك مشروعًا',
    myRequests: 'طلباتي',
    followed: 'أتابعهم',
    coverKicker: 'مشروع الغلاف',
    trending: 'الرائج هذا الأسبوع',
    requestsForYou: 'طلبات تناسبك',
    printRequests: 'طلبات الطباعة',
    featuredCreators: 'صنّاع مميزون',
    featuredStores: 'متاجر مميزة',
    communityProducts: 'منتجات المجتمع',
    latestProjects: 'أحدث المشاريع',
    makerTools: 'أدوات الصانع',
    all: 'الكل',
    feedEmpty: 'العدد الأول يُكتب الآن',
    feedEmptyHint: 'شارك أول مشروع، وسيظهر هنا.',
    signInToFollowMakers: 'سجّل الدخول لمتابعة الصنّاع',
    signIn: 'تسجيل الدخول',
    followNobody: 'لا تتابع أحدًا بعد',
    startWithThese: 'ابدأ بهؤلاء',
    noCreators: 'لا صنّاع بعد — كن أول من ينشر مشروعه',
    noProjectsFiltered: 'لا مشاريع بهذه الفلاتر بعد',
    clearFilters: 'مسح الفلاتر',
    noResults: 'لا نتائج لـ «{q}»',
    noResultsHint: 'جرّب كلمة أقصر، أو ابحث في قسم آخر.',
    resultsFor: '{n} لـ «{q}»',
    printIt: 'اطلب طباعته',
    buyMaterials: 'اشترِ المواد',
    more: 'المزيد',
    video: 'فيديو',
    kinds: { project: 'مشروع مطبوع', post: 'صورة', tutorial: 'شرح', timelapse: 'طبعة زمنية', before_after: 'قبل وبعد' } as Record<PostKind, string>,
    calculator: 'احسب سعر طباعتك',
    openCalculator: 'افتح الحاسبة',
    library: 'مكتبة ملفات الطباعة',
    requestsHint: 'طلبات طباعة تنتظر عروض الورش.',
    postRequest: 'انشر طلب طباعة',
    noOpenRequests: 'لا توجد طلبات مفتوحة',
    describeHint: 'صف ما تريد طباعته، وتصلك عروض الورش.',
    noProducts: 'لا منتجات في المجتمع بعد',
    noProductsHint: 'ما تنشره المتاجر يظهر هنا أولًا بأول.',
    noStores: 'لا متاجر في المجتمع بعد',
    followFailed: 'تعذّر تحديث المتابعة. حاول مرة أخرى.',
    yourStore: 'متجرك في مجتمع ليفو',
    createStore: 'أنشئ متجرك في ليفو',
    yourStoreHint: 'اعرض منتجاتك واستقبل طلبات الطباعة.',
    takesRequests: 'يقبل طلبات خاصة',
    rating: 'تقييم',
    byDeadline: 'حتى {d}',
    filesAttached: 'ملفات مرفقة',
    was: 'بدلًا من',
    opensNewTab: ' (يفتح في نافذة جديدة)',
    verified: 'موثّق من Levonis',
    verifiedMerchant: 'تاجر موثّق',
    theirStore: 'متجره',
    projects: 'مشاريع',
    workshops: 'ورش',
    kind: 'النوع',
    tags: 'وسوم',
  },
  en: {
    kicker: 'Levo Community · what the makers made',
    title: 'Levo Community',
    dek: 'What makers print, and what workshops need.',
    back: 'Back',
    clearSearch: 'Clear search',
    sections: 'Community sections',
    shortcuts: 'Community shortcuts',
    search: {
      projects: 'Search projects',
      stores: 'Search stores and workshops',
      requests: 'Search print requests',
      products: 'Search community products',
      creators: 'Search makers',
    },
    tabs: {
      foryou: 'For you',
      following: 'Following',
      projects: 'Projects',
      requests: 'Print requests',
      stores: 'Stores',
      creators: 'Makers',
    },
    printRequest: 'Print request',
    shareProject: 'Share a project',
    myRequests: 'My requests',
    followed: 'Following',
    coverKicker: 'Cover story',
    trending: 'Trending this week',
    requestsForYou: 'Requests for your workshop',
    printRequests: 'Print requests',
    featuredCreators: 'Featured makers',
    featuredStores: 'Featured stores',
    communityProducts: 'Community products',
    latestProjects: 'Latest projects',
    makerTools: 'Maker tools',
    all: 'All',
    feedEmpty: 'The first issue is being written',
    feedEmptyHint: 'Share the first project and it appears here.',
    signInToFollowMakers: 'Sign in to follow makers',
    signIn: 'Sign in',
    followNobody: 'You follow nobody yet',
    startWithThese: 'Start with these',
    noCreators: 'No makers yet — be the first to publish',
    noProjectsFiltered: 'No projects with these filters yet',
    clearFilters: 'Clear filters',
    noResults: 'No results for “{q}”',
    noResultsHint: 'Try a shorter word, or search another section.',
    resultsFor: '{n} for “{q}”',
    printIt: 'Print this',
    buyMaterials: 'Buy the materials',
    more: 'More',
    video: 'Video',
    kinds: { project: 'Printed project', post: 'Photo', tutorial: 'Tutorial', timelapse: 'Timelapse', before_after: 'Before & after' } as Record<PostKind, string>,
    calculator: 'Calculate your print price',
    openCalculator: 'Open the calculator',
    library: '3D models library',
    requestsHint: 'Print requests waiting for offers from workshops.',
    postRequest: 'Post a print request',
    noOpenRequests: 'No open requests',
    describeHint: 'Describe what you want printed and the workshops will send offers.',
    noProducts: 'No community products yet',
    noProductsHint: 'What the stores publish appears here as it goes up.',
    noStores: 'No community stores yet',
    followFailed: 'Could not update the follow. Try again.',
    yourStore: 'Your store in the Levo community',
    createStore: 'Create your Levo store',
    yourStoreHint: 'Sell your prints and take print requests.',
    takesRequests: 'Takes custom requests',
    rating: 'rating',
    byDeadline: 'By {d}',
    filesAttached: 'files attached',
    was: 'was',
    opensNewTab: ' (opens in a new tab)',
    verified: 'Verified by Levonis',
    verifiedMerchant: 'Verified merchant',
    theirStore: 'Their store',
    projects: 'projects',
    workshops: 'workshops',
    kind: 'Kind',
    tags: 'Tags',
  },
  ckb: {
    kicker: 'کۆمەڵگەی لیڤۆ · ئەوەی دروستکەران دروستیان کردووە',
    title: 'کۆمەڵگەی لیڤۆ',
    dek: 'ئەوەی دروستکەران چاپی دەکەن، و ئەوەی وۆرکشۆپەکان پێویستیانە.',
    back: 'گەڕانەوە',
    clearSearch: 'گەڕان بسڕەوە',
    sections: 'بەشەکانی کۆمەڵگە',
    shortcuts: 'کورتەڕێگاکانی کۆمەڵگە',
    search: {
      projects: 'لە پڕۆژەکان بگەڕێ',
      stores: 'بگەڕێ بۆ فرۆشگا یان وۆرکشۆپ',
      requests: 'لە داواکارییەکانی چاپ بگەڕێ',
      products: 'لە بەرهەمەکانی کۆمەڵگە بگەڕێ',
      creators: 'بگەڕێ بۆ دروستکەر',
    },
    tabs: {
      foryou: 'بۆ تۆ',
      following: 'شوێنکەوتووەکانم',
      projects: 'پڕۆژەکان',
      requests: 'داواکارییەکانی چاپ',
      stores: 'فرۆشگاکان',
      creators: 'دروستکەران',
    },
    printRequest: 'داواکاری چاپ',
    shareProject: 'پڕۆژەیەک هاوبەش بکە',
    myRequests: 'داواکارییەکانم',
    followed: 'شوێنکەوتووەکان',
    coverKicker: 'پڕۆژەی بەرگ',
    trending: 'باوی ئەم هەفتەیە',
    requestsForYou: 'داواکاری گونجاو بۆ تۆ',
    printRequests: 'داواکارییەکانی چاپ',
    featuredCreators: 'دروستکەرانی دیار',
    featuredStores: 'فرۆشگا دیارەکان',
    communityProducts: 'بەرهەمەکانی کۆمەڵگە',
    latestProjects: 'نوێترین پڕۆژەکان',
    makerTools: 'ئامرازەکانی دروستکەر',
    all: 'هەموو',
    feedEmpty: 'یەکەم ژمارە ئێستا دەنووسرێت',
    feedEmptyHint: 'یەکەم پڕۆژە هاوبەش بکە، لێرە دەردەکەوێت.',
    signInToFollowMakers: 'بچۆ ژوورەوە بۆ شوێنکەوتنی دروستکەران',
    signIn: 'چوونەژوورەوە',
    followNobody: 'هێشتا شوێن کەس نەکەوتوویت',
    startWithThese: 'بەمانە دەست پێ بکە',
    noCreators: 'هێشتا دروستکەر نییە — یەکەم کەس بە کە پڕۆژەکەی بڵاو دەکاتەوە',
    noProjectsFiltered: 'هێشتا هیچ پڕۆژەیەک بەم فلتەرانە نییە',
    clearFilters: 'فلتەرەکان بسڕەوە',
    noResults: 'هیچ ئەنجامێک نییە بۆ «{q}»',
    noResultsHint: 'وشەیەکی کورتتر تاقی بکەرەوە، یان لە بەشێکی تر بگەڕێ.',
    resultsFor: '{n} بۆ «{q}»',
    printIt: 'داوای چاپکردنی بکە',
    buyMaterials: 'کەرەستەکان بکڕە',
    more: 'زیاتر',
    video: 'ڤیدیۆ',
    kinds: { project: 'پڕۆژەی چاپکراو', post: 'وێنە', tutorial: 'فێرکاری', timelapse: 'تایم‌لاپس', before_after: 'پێش و پاش' } as Record<PostKind, string>,
    calculator: 'نرخی چاپەکەت بژمێرە',
    openCalculator: 'ژمێرەر بکەرەوە',
    library: 'کتێبخانەی فایلی چاپ',
    requestsHint: 'داواکارییەکانی چاپ چاوەڕێی ئۆفەری وۆرکشۆپەکانن.',
    postRequest: 'داواکارییەکی چاپ بڵاو بکەرەوە',
    noOpenRequests: 'هیچ داواکارییەکی کراوە نییە',
    describeHint: 'ئەوەی دەتەوێت چاپی بکەیت باسی بکە، ئۆفەری وۆرکشۆپەکانت بۆ دێت.',
    noProducts: 'هێشتا هیچ بەرهەمێک لە کۆمەڵگە نییە',
    noProductsHint: 'ئەوەی فرۆشگاکان بڵاوی دەکەنەوە یەکسەر لێرە دەردەکەوێت.',
    noStores: 'هێشتا هیچ فرۆشگایەک لە کۆمەڵگە نییە',
    followFailed: 'شوێنکەوتن نوێ نەکرایەوە. دووبارە هەوڵ بدە.',
    yourStore: 'فرۆشگاکەت لە کۆمەڵگەی Levo',
    createStore: 'فرۆشگای Levo خۆت دروست بکە',
    yourStoreHint: 'بەرهەمەکانت پیشان بدە و داواکاری چاپ وەربگرە.',
    takesRequests: 'داواکاری تایبەت وەردەگرێت',
    rating: 'هەڵسەنگاندن',
    byDeadline: 'تا {d}',
    filesAttached: 'فایلی هاوپێچ',
    was: 'لە جیاتی',
    opensNewTab: ' (لە پەنجەرەیەکی نوێ دەکرێتەوە)',
    verified: 'پشتڕاستکراوە لەلایەن Levonis',
    verifiedMerchant: 'بازرگانی پشتڕاستکراو',
    theirStore: 'فرۆشگاکەی',
    projects: 'پڕۆژە',
    workshops: 'وۆرکشۆپ',
    kind: 'جۆر',
    tags: 'تاگەکان',
  },
} as const;

/** The table's shape with plain strings, so any language's table fits it. */
type Widen<T> = T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> };
export type HubStrings = Widen<(typeof STRINGS)['ar']>;
export type HubLang = keyof typeof STRINGS;

export const HUB_STRINGS = STRINGS;

export function hubLang(lang: string): HubLang {
  return lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
}

export function useHubStrings(): HubStrings {
  const { lang } = useLanguage();
  return STRINGS[hubLang(lang)] as HubStrings;
}

/** «{q}» and friends filled in. */
export const fill = (s: string, values: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));

// ------------------------------------------------------------ the numbering

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';

/**
 * «٠١», «٠٢» … the section numbers of the issue. Arabic-Indic digits for the
 * two right-to-left readerships, Latin for English — the ONE place the app
 * uses them; dates and counts keep Latin digits everywhere (hub/copy.ts).
 */
export function sectionNumber(index: number, lang: string): string {
  const two = String(Math.max(0, Math.floor(index))).padStart(2, '0');
  if (lang === 'ar' || lang === 'ckb') return two.replace(/\d/g, (d) => ARABIC_INDIC[Number(d)]);
  return two;
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
  /** Sorani counts with the bare noun: «12 پڕۆژە». */
  ckb: string;
}

function counted(n: number, f: Forms, lang: HubLang): string {
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

const PROJECTS: Forms = { one: 'مشروع واحد', two: 'مشروعان', few: 'مشاريع', many: 'مشروعًا', hundred: 'مشروع', en1: 'project', enN: 'projects', ckb: 'پڕۆژە' };
const WORKSHOPS: Forms = { one: 'ورشة واحدة', two: 'ورشتان', few: 'ورش', many: 'ورشة', hundred: 'ورشة', en1: 'workshop', enN: 'workshops', ckb: 'وۆرکشۆپ' };
const RESULTS: Forms = { one: 'نتيجة واحدة', two: 'نتيجتان', few: 'نتائج', many: 'نتيجة', hundred: 'نتيجة', en1: 'result', enN: 'results', ckb: 'ئەنجام' };

export const projectsLabel = (n: number, lang: HubLang) => counted(n, PROJECTS, lang);
export const workshopsLabel = (n: number, lang: HubLang) => counted(n, WORKSHOPS, lang);
export const resultsCount = (n: number, lang: HubLang) => counted(n, RESULTS, lang);

/** «صُنع هذا العدد من 12 مشروعًا و3 ورش» — the issue's colophon. */
export function colophon(projects: number, workshops: number, lang: HubLang): string {
  const p = projectsLabel(projects, lang);
  const w = workshopsLabel(workshops, lang);
  if (lang === 'en') return `This issue was made from ${p} and ${w}`;
  if (lang === 'ckb') return `ئەم ژمارەیە لە ${p} و ${w} دروست کراوە`;
  return `صُنع هذا العدد من ${p} و${w}`;
}
