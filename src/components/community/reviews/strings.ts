/**
 * THE STORE-REVIEW FORM'S NEW WORDS — Arabic, English and Sorani, every key in
 * all three (D6, docs/COMMUNITY_ECOSYSTEM.md; DECISIONS row 169). The older
 * strings of the form still sit inline under the OWNER marker; what the photo
 * picker (storefront L12) adds lives here, with real Sorani.
 */
export const REVIEW_FORM_STRINGS = {
  ar: {
    photos: 'صور من طلبك (اختياري)',
    addPhoto: 'أضف صورة',
    removePhoto: (n: number) => `إزالة الصورة ${n}`,
    photoAlt: (n: number) => `الصورة ${n}`,
    photosHint: (max: number) => `حتى ${max} صور. تظهر مع تقييمك في صفحة المتجر.`,
    uploading: 'جارٍ رفع الصورة…',
    uploadFailed: 'تعذّر رفع الصورة — حاول مجددًا.',
    onlyImages: 'الصور فقط.',
  },
  en: {
    photos: 'Photos of your order (optional)',
    addPhoto: 'Add a photo',
    removePhoto: (n: number) => `Remove photo ${n}`,
    photoAlt: (n: number) => `Photo ${n}`,
    photosHint: (max: number) => `Up to ${max} photos. They show with your rating on the store’s page.`,
    uploading: 'Uploading the photo…',
    uploadFailed: 'The photo could not be uploaded — try again.',
    onlyImages: 'Pictures only.',
  },
  ckb: {
    photos: 'وێنە لە داواکاریەکەت (ئارەزوومەندانە)',
    addPhoto: 'وێنەیەک زیاد بکە',
    removePhoto: (n: number) => `لابردنی وێنەی ${n}`,
    photoAlt: (n: number) => `وێنەی ${n}`,
    photosHint: (max: number) => `تا ${max} وێنە. لەگەڵ هەڵسەنگاندنەکەت لە لاپەڕەی فرۆشگادا دەردەکەون.`,
    uploading: 'وێنەکە بار دەکرێت…',
    uploadFailed: 'وێنەکە بار نەکرا — دووبارە هەوڵ بدە.',
    onlyImages: 'تەنها وێنە.',
  },
} as const;

export type ReviewFormStrings = (typeof REVIEW_FORM_STRINGS)['ar'];

/** The table for the viewer's language; anything the app does not carry reads Arabic. */
export function reviewFormStrings(lang: string): ReviewFormStrings {
  return (REVIEW_FORM_STRINGS as unknown as Record<string, ReviewFormStrings>)[lang] ?? REVIEW_FORM_STRINGS.ar;
}
