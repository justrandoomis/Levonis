import type { CompareLensId } from '../../lib/compare';

/**
 * THE NEW WORDS OF THE COMPARE PAGE (catalog discovery S7-client): the «أفضل
 * لـ» lenses, the sticky columns, the direction hints and the share control.
 *
 * Kept apart from ./strings.ts on purpose: that dictionary carries hand-written
 * Sorani for every key (and tests count its keys per language). These are
 * ar/en only — Sorani readers get the Arabic, the same fallback `loc()` makes.
 *
 * OWNER: Sorani to be written by hand.
 */
type Lang = 'ar' | 'en' | 'ckb';

export interface LensStrings {
  lensAll: string;
  lensChip: Record<CompareLensId, string>;
  lensRow: Record<CompareLensId, string>;
  lensGroup: string;
  summaryTitle: string;
  tie: string;
  noData: string;
  selectLens: (name: string) => string;
  subtitle: (n: number, basis: string) => string;
  share: string;
  copied: string;
  details: string;
  hintHigher: string;
  hintLower: string;
  hintInfo: string;
  hintUnscored: string;
  priceHint: string;
  cheapest: string;
  litres: (l: string) => string;
  hiddenRows: (n: number, columns: number) => string;
  showAll: string;
  onlyDiffs: string;
  columnsLabel: string;
  moveStart: (name: string) => string;
  moveEnd: (name: string) => string;
  remove: (name: string) => string;
  addNth: (n: number) => string;
  best: string;
  more: string;
  less: string;
  lensTinted: (lens: string) => string;
}

const ORDINAL_AR = ['', 'أولى', 'ثانية', 'ثالثة', 'رابعة'];

const AR: LensStrings = {
  lensAll: 'الكل',
  lensChip: { business: 'للأعمال', beginners: 'للمبتدئين', value: 'أفضل قيمة', multicolor: 'الألوان', precision: 'الدقة' },
  lensRow: { business: 'للأعمال', beginners: 'للمبتدئين', value: 'أفضل قيمة', multicolor: 'تعدد الألوان', precision: 'أعلى دقة' },
  lensGroup: 'أفضل لـ',
  summaryTitle: 'الخلاصة: الأفضل لـ',
  tie: 'متقاربة — لا فرق حاسم',
  noData: 'لا توجد بيانات كافية',
  selectLens: (name) => `اعرض ما يعتمد عليه «${name}»`,
  subtitle: (n, basis) => `${n} · ${basis}`,
  share: 'مشاركة المقارنة',
  copied: 'نُسخ الرابط',
  details: 'التفاصيل الكاملة للنتيجة',
  hintHigher: 'الأعلى أفضل',
  hintLower: 'الأقل أفضل',
  hintInfo: 'للمعلومة، لا يُحتسب',
  hintUnscored: 'لا يُحتسب: قيمة غير مذكورة',
  priceHint: 'مفاضلة، لا يدخل في النتيجة',
  cheapest: 'الأقل',
  litres: (l) => `${l} لتر`,
  hiddenRows: (n, columns) =>
    `أُخفيت ${n} ${n >= 3 && n <= 10 ? 'مواصفات متطابقة' : 'مواصفة متطابقة'} بين ${columns === 2 ? 'الاثنين' : columns === 3 ? 'الثلاث' : 'الأربع'}`,
  showAll: 'إظهار الكل',
  onlyDiffs: 'الفروقات فقط',
  columnsLabel: 'المنتجات المقارَنة',
  moveStart: (name) => `انقل ${name} يمينًا`,
  moveEnd: (name) => `انقل ${name} يسارًا`,
  remove: (name) => `أزل ${name} من المقارنة`,
  addNth: (n) => (n >= 2 && n <= 4 ? `أضف طابعة ${ORDINAL_AR[n]}` : 'أضف منتجًا'),
  best: 'الأفضل',
  more: 'المزيد',
  less: 'أقل',
  lensTinted: (lens) => `صفوف «${lens}» مظللة`,
};

const EN: LensStrings = {
  lensAll: 'All',
  lensChip: { business: 'Business', beginners: 'Beginners', value: 'Best value', multicolor: 'Colours', precision: 'Precision' },
  lensRow: { business: 'Business', beginners: 'Beginners', value: 'Best value', multicolor: 'Multicolour', precision: 'Precision' },
  lensGroup: 'Best for',
  summaryTitle: 'In short: best for',
  tie: 'Too close to call',
  noData: 'Not enough data',
  selectLens: (name) => `Show what «${name}» rests on`,
  subtitle: (n, basis) => `${n} · ${basis}`,
  share: 'Share this comparison',
  copied: 'Link copied',
  details: 'Full scoring details',
  hintHigher: 'Higher is better',
  hintLower: 'Lower is better',
  hintInfo: 'For information, not scored',
  hintUnscored: 'Not scored: a value is missing',
  priceHint: 'A trade-off, not scored',
  cheapest: 'Lowest',
  litres: (l) => `${l} L`,
  hiddenRows: (n, columns) => `${n} identical ${n === 1 ? 'spec' : 'specs'} hidden across the ${columns}`,
  showAll: 'Show all',
  onlyDiffs: 'Differences only',
  columnsLabel: 'Products compared',
  moveStart: (name) => `Move ${name} left`,
  moveEnd: (name) => `Move ${name} right`,
  remove: (name) => `Remove ${name} from the comparison`,
  addNth: (n) => (n === 2 ? 'Add a second printer' : n === 3 ? 'Add a third printer' : n === 4 ? 'Add a fourth printer' : 'Add a product'),
  best: 'Best',
  more: 'More',
  less: 'Less',
  lensTinted: (lens) => `«${lens}» rows highlighted`,
};

export function lensStrings(lang: Lang | string): LensStrings {
  return lang === 'en' ? EN : AR;
}
