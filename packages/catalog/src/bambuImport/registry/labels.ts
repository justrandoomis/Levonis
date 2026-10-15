/**
 * The authored three-language strings of the import (spec §C.8): repository
 * strings reviewed like every UI string (DECISIONS rows 2 and 183), never
 * machine translation of imported prose. A ckb slot is real Sorani and never
 * a copy of the Arabic; tests/bambuOptions.test.ts walks every registry and
 * asserts it.
 */
export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

export const tri = (ar: string, en: string, ckb: string): Tri => ({ ar, en, ckb });

/** Value states of a spec row (§G.2) — never 0 or false for an absent value. */
export const VALUE_STATE_LABELS: Readonly<Record<'not_found' | 'not_published' | 'not_applicable' | 'unknown' | 'unverified', Tri>> = {
  not_found: tri('غير متوفر في المصادر التي رُوجعت', 'Not in the sources checked', 'لەو سەرچاوانەی پشکنران نییە'),
  not_published: tri('لم تنشره الشركة المصنّعة', 'Not published by the manufacturer', 'لەلایەن بەرهەمهێنەرەوە بڵاو نەکراوەتەوە'),
  not_applicable: tri('لا ينطبق', 'Not applicable', 'پەیوەندی پێوە نییە'),
  unknown: tri('غير متوفر', 'Not available', 'بەردەست نییە'),
  unverified: tri('غير مؤكَّد', 'Unverified', 'پشتڕاست نەکراوەتەوە'),
};

/** The region notes of §C.6. */
export const REGION_LABELS: Readonly<Record<'us_110v' | 'intl_220v', Tri>> = {
  us_110v: tri('النسخة الأمريكية (100–120 فولت)', 'US version (100–120 V)', 'وەشانی ئەمریکی (100–120 ڤۆڵت)'),
  intl_220v: tri('النسخة الدولية (220–240 فولت)', 'International version (220–240 V)', 'وەشانی نێودەوڵەتی (220–240 ڤۆڵت)'),
};

/** The test condition written on every us_110v row (§C.6). */
export const US_VERSION_CONDITION = 'US version (100–120 V)';

/** Image alt text (§C.4): the source has none worth keeping. */
export function altText(title: string, selection = ''): Tri {
  const tail = selection ? ` — ${selection}` : '';
  return { en: `${title}${tail}`, ar: `صورة ${title}${tail}`, ckb: `وێنەی ${title}${tail}` };
}

/** Section titles the import writes as content blocks (§C.5). */
export const BLOCK_TITLES: Readonly<Record<'highlights' | 'faq' | 'comparison', Tri>> = {
  highlights: tri('أبرز المزايا', 'Highlights', 'تایبەتمەندییە سەرەکییەکان'),
  faq: tri('الأسئلة الشائعة', 'FAQ', 'پرسیارە باوەکان'),
  comparison: tri('مقارنة', 'Comparison', 'بەراوردکردن'),
};
