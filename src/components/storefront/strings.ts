/**
 * THE STOREFRONT'S OWN WORDS — Arabic, English and Sorani, every key in all
 * three (docs/DECISIONS.md row 169 extends D6 here: a new string is a real
 * Sorani sentence written by hand, never the Arabic standing in).
 *
 * Only the words the storefront's blocks need beyond what they already carry
 * inline: the in-store search and sort (L11), the review filters, photos and
 * «المزيد» (L12), and the card's video mark (L10). Merchant text — names,
 * bodies, titles — never passes through here; that is `pickText`.
 *
 * Shape: `STRINGS[lang]`, read through `storefrontStrings(lang)`, which falls
 * back to Arabic for any language code the app does not carry.
 */
export const STOREFRONT_STRINGS = {
  ar: {
    search: {
      placeholder: 'ابحث في المتجر',
      label: 'ابحث في منتجات المتجر',
      clear: 'مسح البحث',
      empty: (q: string) => `لا نتائج لـ «${q}»`,
      error: 'تعذّر البحث الآن.',
    },
    sort: {
      label: 'ترتيب المنتجات',
      new: 'الأحدث',
      priceAsc: 'الأرخص',
      priceDesc: 'الأغلى',
    },
    reviews: {
      filterLabel: 'تصفية التقييمات',
      all: 'الكل',
      withPhotos: 'بالصور',
      stars: (n: number) => `${n} نجوم`,
      more: 'المزيد',
      loadingMore: 'جارٍ التحميل…',
      photoAlt: (n: number) => `صورة ${n} من التقييم`,
      noneFiltered: 'لا تقييمات بهذا التصنيف بعد.',
    },
    card: {
      hasVideo: 'يحتوي على فيديو',
    },
    // Files on products (§9.4): the block under the description, by role.
    files: {
      title: 'الملفات',
      view3d: 'عرض ثلاثي الأبعاد',
      download: 'تنزيل',
      afterPurchase: 'يتاح بعد الشراء',
      opening: 'جارٍ الفتح…',
      noPreview: 'لا معاينة ثلاثية الأبعاد لهذا الملف.',
      viewerFailed: 'تعذّر فتح المعاينة الآن. حاول مجددًا.',
      roles: {
        preview: 'معاينة',
        download_after_purchase: 'تنزيل بعد الشراء',
        reference: 'مرجع',
        instruction: 'تعليمات',
        source_model: 'ملف المصدر',
      },
      units: ['بايت', 'ك.ب', 'م.ب', 'غ.ب'],
    },
  },
  en: {
    search: {
      placeholder: 'Search this store',
      label: 'Search this store’s products',
      clear: 'Clear search',
      empty: (q: string) => `No results for “${q}”`,
      error: 'Search is unavailable right now.',
    },
    sort: {
      label: 'Sort products',
      new: 'Newest',
      priceAsc: 'Cheapest',
      priceDesc: 'Priciest',
    },
    reviews: {
      filterLabel: 'Filter reviews',
      all: 'All',
      withPhotos: 'With photos',
      stars: (n: number) => `${n} stars`,
      more: 'More',
      loadingMore: 'Loading…',
      photoAlt: (n: number) => `Review photo ${n}`,
      noneFiltered: 'No reviews in this filter yet.',
    },
    card: {
      hasVideo: 'Has a video',
    },
    files: {
      title: 'Files',
      view3d: 'View in 3D',
      download: 'Download',
      afterPurchase: 'Available after purchase',
      opening: 'Opening…',
      noPreview: 'This file has no 3D preview.',
      viewerFailed: 'The preview could not be opened right now. Try again.',
      roles: {
        preview: 'Preview',
        download_after_purchase: 'Download after purchase',
        reference: 'Reference',
        instruction: 'Instructions',
        source_model: 'Source file',
      },
      units: ['B', 'KB', 'MB', 'GB'],
    },
  },
  ckb: {
    search: {
      placeholder: 'لە فرۆشگادا بگەڕێ',
      label: 'لە بەرهەمەکانی فرۆشگادا بگەڕێ',
      clear: 'سڕینەوەی گەڕان',
      empty: (q: string) => `هیچ ئەنجامێک بۆ «${q}» نییە`,
      error: 'ئێستا گەڕان بەردەست نییە.',
    },
    sort: {
      label: 'ڕیزکردنی بەرهەمەکان',
      new: 'نوێترین',
      priceAsc: 'هەرزانترین',
      priceDesc: 'گرانترین',
    },
    reviews: {
      filterLabel: 'پاڵاوتنی هەڵسەنگاندنەکان',
      all: 'هەموو',
      withPhotos: 'بە وێنە',
      stars: (n: number) => `${n} ئەستێرە`,
      more: 'زیاتر',
      loadingMore: 'بار دەکرێت…',
      photoAlt: (n: number) => `وێنەی ${n}ی هەڵسەنگاندن`,
      noneFiltered: 'هێشتا هیچ هەڵسەنگاندنێک بەم پاڵاوتنە نییە.',
    },
    card: {
      hasVideo: 'ڤیدیۆی تێدایە',
    },
    files: {
      title: 'فایلەکان',
      view3d: 'بینینی سێ ڕەهەندی',
      download: 'داگرتن',
      afterPurchase: 'دوای کڕین بەردەست دەبێت',
      opening: 'دەکرێتەوە…',
      noPreview: 'ئەم فایلە پێشبینینی سێ ڕەهەندی نییە.',
      viewerFailed: 'ئێستا پێشبینینەکە ناکرێتەوە. دووبارە هەوڵبدەوە.',
      roles: {
        preview: 'پێشبینین',
        download_after_purchase: 'داگرتن دوای کڕین',
        reference: 'سەرچاوە',
        instruction: 'ڕێنمایی',
        source_model: 'فایلی سەرچاوە',
      },
      units: ['بایت', 'کیلۆبایت', 'مێگابایت', 'گیگابایت'],
    },
  },
} as const;

export type StorefrontLang = keyof typeof STOREFRONT_STRINGS;
export type StorefrontStrings = (typeof STOREFRONT_STRINGS)[StorefrontLang];

/** The table for the viewer's language; anything the app does not carry reads Arabic. */
export function storefrontStrings(lang: string): StorefrontStrings {
  return (STOREFRONT_STRINGS as unknown as Record<string, StorefrontStrings>)[lang] ?? STOREFRONT_STRINGS.ar;
}
