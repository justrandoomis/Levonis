/**
 * CATALOG DISCOVERY — COUNTED WORDS (docs/ux/CATALOG_DISCOVERY.md §5–§7).
 *
 * Arabic nouns change with the number: «طابعة واحدة», «طابعتان», «4 طابعات»,
 * «11 طابعة», «14 منتجًا». A page that prints «2 طابعات» or «14 منتجات» reads
 * as machine-made, and every count on the explorer, the category page and the
 * listing goes through here so they all say it the same way. The compare
 * tray's own words (src/components/compare/trayStrings.ts) follow the same
 * rule for its narrower vocabulary.
 *
 * Pure: no React, no DOM. `lang` is passed in, so the functions are testable
 * and usable from a model as well as from a component.
 *
 * OWNER: Sorani to be written by hand — every phrase here is ar/en only, and
 * Sorani falls back to Arabic (docs/DECISIONS.md row 11).
 */

export type CatalogLang = 'ar' | 'en' | 'ckb';

/** Which noun a section counts in. Printers say «طابعة»; everything else «منتج». */
export type NounKind = 'printer' | 'product';

export function nounKindFor(productType: string | null | undefined, isPrinterCatalog = false): NounKind {
  if (productType === 'printer') return 'printer';
  if (productType == null && isPrinterCatalog) return 'printer';
  return 'product';
}

interface Forms {
  /** «طابعة واحدة» */
  one: string;
  /** «طابعتان» (nominative — a subject or a label) */
  two: string;
  /** «طابعتين» (accusative/genitive — after a verb: «عرض طابعتين») */
  twoAcc: string;
  /** «طابعات» (3–10) */
  few: string;
  /** «طابعة» / «منتجًا» (11–99, the accusative singular of tamyīz) */
  many: string;
  /** «طابعة» / «منتج» (100, 200 … the genitive singular) */
  hundred: string;
  /** «طابعة» / «منتجًا» after «عرض» with 11–99 — the same word as `many`. */
  en1: string;
  enN: string;
}

const NOUNS: Record<NounKind, Forms> = {
  printer: {
    one: 'طابعة واحدة',
    two: 'طابعتان',
    twoAcc: 'طابعتين',
    few: 'طابعات',
    many: 'طابعة',
    hundred: 'طابعة',
    en1: 'printer',
    enN: 'printers',
  },
  product: {
    one: 'منتج واحد',
    two: 'منتجان',
    twoAcc: 'منتجين',
    few: 'منتجات',
    many: 'منتجًا',
    hundred: 'منتج',
    en1: 'product',
    enN: 'products',
  },
};

/** The Arabic counted-noun form for n ≥ 3. */
function arabicPlural(n: number, f: Forms): string {
  const r = n % 100;
  if (r >= 3 && r <= 10) return `${n} ${f.few}`;
  if (r >= 11 && r <= 99) return `${n} ${f.many}`;
  // 100, 101, 102, 200 … : the hundreds govern a genitive singular.
  return `${n} ${f.hundred}`;
}

/** «10 طابعات», «طابعة واحدة», «طابعتان», «14 منتجًا»; en «10 printers». */
export function countNoun(n: number, kind: NounKind, lang: CatalogLang): string {
  const f = NOUNS[kind];
  const count = Math.max(0, Math.floor(n));
  if (lang === 'en') return `${count} ${count === 1 ? f.en1 : f.enN}`;
  if (count === 0) return kind === 'printer' ? 'لا طابعات' : 'لا منتجات';
  if (count === 1) return f.one;
  if (count === 2) return f.two;
  return arabicPlural(count, f);
}

/**
 * The noun alone, agreeing with `n` — the label under a big stat figure:
 * «10» over «طابعات», «1» over «طابعة», «14» over «منتجًا».
 */
export function countWord(n: number, kind: NounKind, lang: CatalogLang): string {
  const f = NOUNS[kind];
  const count = Math.max(0, Math.floor(n));
  if (lang === 'en') return count === 1 ? f.en1 : f.enN;
  if (count === 1) return f.hundred;
  if (count === 2) return f.two;
  const r = count % 100;
  if (r >= 3 && r <= 10) return f.few;
  if (r >= 11 && r <= 99) return f.many;
  return count === 0 ? f.few : f.hundred;
}

/**
 * The count as the object of a verb — the filter sheet's button:
 * «عرض طابعة واحدة», «عرض طابعتين», «عرض 4 طابعات»; en «Show 4 printers».
 * Zero is a sentence of its own, never «عرض 0».
 */
export function showCountLabel(n: number, kind: NounKind, lang: CatalogLang): string {
  const f = NOUNS[kind];
  const count = Math.max(0, Math.floor(n));
  if (lang === 'en') {
    if (count === 0) return 'No matches';
    return `Show ${count} ${count === 1 ? f.en1 : f.enN}`;
  }
  if (count === 0) return 'لا نتائج بهذه الشروط';
  if (count === 1) return `عرض ${f.one}`;
  if (count === 2) return `عرض ${f.twoAcc}`;
  return `عرض ${arabicPlural(count, f)}`;
}

/** The listing's result line: «10 طابعات», or «4 من 10 طابعات» after filters. */
export function resultCountLabel(shown: number, of: number | null, kind: NounKind, lang: CatalogLang): string {
  if (of === null || of === shown) return countNoun(shown, kind, lang);
  if (lang === 'en') return `${shown} of ${countNoun(of, kind, lang)}`;
  // «4 من 10 طابعات» — the noun agrees with the total it counts.
  return `${shown} من ${of <= 2 ? countNoun(of, kind, lang) : arabicPlural(of, NOUNS[kind])}`;
}

/**
 * The «متوفرة الآن» pill: «● 4 متوفرة الآن», «● متوفر الآن» for a single
 * product that is available, «● كلها متوفرة» when every one is. `null`
 * when none is available (the pill is not drawn) or the count is unknown.
 */
export function availableLabel(available: number | null, total: number, lang: CatalogLang): string | null {
  if (available === null || available <= 0) return null;
  if (lang === 'en') {
    if (total === 1) return 'Available now';
    if (available === total) return 'All available';
    return `${available} available now`;
  }
  if (total === 1) return 'متوفر الآن';
  if (available === total) return 'كلها متوفرة';
  return `${available} متوفرة الآن`;
}

const FEMININE_WORDS = ['', 'واحدة', 'فئتان', 'ثلاث', 'أربع', 'خمس', 'ست', 'سبع', 'ثماني', 'تسع', 'عشر'];

/**
 * «أربع فئات» — the explorer's sub-line counts its categories in words, as
 * the design reads («أربع فئات و14 منتجًا»). Past ten, a number.
 */
export function categoriesCount(n: number, lang: CatalogLang): string {
  if (lang === 'en') return `${n} ${n === 1 ? 'category' : 'categories'}`;
  if (n === 1) return 'فئة واحدة';
  if (n === 2) return 'فئتان';
  if (n >= 3 && n <= 10) return `${FEMININE_WORDS[n]} فئات`;
  return n % 100 >= 11 && n % 100 <= 99 ? `${n} فئة` : `${n} فئات`;
}

/**
 * The explorer's sub-line. With ten categories or fewer it carries the live
 * counts («أربع فئات و14 منتجًا. اختر فئة لتتصفح أقسامها.»); with more, the
 * numbers stop helping and only the instruction stays (§5).
 */
export function explorerSubline(roots: number, products: number, lang: CatalogLang): string {
  const tail = lang === 'en' ? 'Pick one to browse its sections.' : 'اختر فئة لتتصفح أقسامها.';
  if (roots > 10 || roots === 0) return tail;
  if (lang === 'en') return `${categoriesCount(roots, lang)} and ${countNoun(products, 'product', lang)}. ${tail}`;
  return `${categoriesCount(roots, lang)} و${countNoun(products, 'product', lang)}. ${tail}`;
}
