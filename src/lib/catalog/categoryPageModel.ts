/**
 * THE CATEGORY PAGE, AS DATA (docs/ux/CATALOG_DISCOVERY.md §6).
 *
 * Pure. `GET /api/catalog/:slug` already decides WHICH shelves exist (a child
 * shelf per non-empty child; a smart shelf only with ≥ 3 items that does not
 * repeat a child; brands when ≥ 2 — worker/lib/catalogPresentation.ts). This
 * module decides what the page SAYS about them and where it goes: titles and
 * sub-lines, the jump chips, the hero's photograph and doors, the canonical
 * redirects, and the related-sections heading.
 */
import type { CatalogTreeNode, CategoryPayload, Shelf, ShelfKind } from './types';
import { authoredPhoto, photoOf, type BannerPhoto, type PhotoCandidate } from './explorerModel';
import type { CatalogLang } from './copy';

type Named = Pick<CatalogTreeNode, 'name_ar' | 'name_en' | 'name_ckb'>;
type Described = Pick<CatalogTreeNode, 'description_ar' | 'description_en' | 'description_ckb'>;

/** A section's name in `lang`, falling back to Arabic (the names are the admin's). */
export function nodeName(n: Named, lang: CatalogLang): string {
  if (lang === 'en') return n.name_en || n.name_ar;
  if (lang === 'ckb') return n.name_ckb || n.name_ar;
  return n.name_ar || n.name_en;
}

/** The admin's description, or '' — never invented (owner default Q1). */
export function nodeDescription(n: Described, lang: CatalogLang): string {
  const pick = lang === 'en' ? n.description_en || n.description_ar : lang === 'ckb' ? n.description_ckb || n.description_ar : n.description_ar;
  return (pick || '').trim();
}

/** Printers get the finder and compare doors; laser machines are their own root. */
export function isPrinterNode(n: Pick<CatalogTreeNode, 'product_type' | 'is_printer_catalog'>): boolean {
  return n.product_type === 'printer' || (n.is_printer_catalog && n.product_type !== 'laser');
}

// OWNER: Sorani to be written by hand (every ar/en pair in this file).
const SHELF_COPY: Record<Exclude<ShelfKind, 'child'>, { ar: string; en: string; chipAr: string; chipEn: string }> = {
  available: { ar: 'جاهزة للتسليم الآن', en: 'Ready to ship now', chipAr: 'متوفرة الآن', chipEn: 'Available now' },
  multicolor: { ar: 'للطباعة بأكثر من لون', en: 'For multicolour printing', chipAr: 'متعددة الألوان', chipEn: 'Multicolour' },
  material: { ar: 'حسب المادة', en: 'By material', chipAr: 'حسب المادة', chipEn: 'By material' },
  brand: { ar: 'حسب العلامة التجارية', en: 'By brand', chipAr: 'العلامات التجارية', chipEn: 'Brands' },
};

export function shelfTitle(shelf: Pick<Shelf, 'kind' | 'catalog'>, lang: CatalogLang): string {
  if (shelf.kind === 'child' && shelf.catalog) return nodeName(shelf.catalog, lang);
  const c = SHELF_COPY[shelf.kind === 'child' ? 'available' : shelf.kind];
  return lang === 'en' ? c.en : c.ar;
}

/** The short label of a shelf on the sticky jump row. */
export function shelfChipLabel(shelf: Pick<Shelf, 'kind' | 'catalog'>, lang: CatalogLang): string {
  if (shelf.kind === 'child' && shelf.catalog) return nodeName(shelf.catalog, lang);
  const c = SHELF_COPY[shelf.kind === 'child' ? 'available' : shelf.kind];
  return lang === 'en' ? c.chipEn : c.chipAr;
}

/** The one line under a shelf title: the child's description, or what the smart shelf means. */
export function shelfSubline(shelf: Pick<Shelf, 'kind' | 'catalog'>, lang: CatalogLang): string {
  switch (shelf.kind) {
    case 'child':
      return shelf.catalog ? nodeDescription(shelf.catalog, lang) : '';
    case 'available':
      return lang === 'en' ? 'Direct sale from Levonis stock in Iraq.' : 'بيع مباشر من مخزون Levonis في العراق.';
    case 'multicolor':
      return lang === 'en'
        ? '16 colours or more in one print, per each printer’s spec sheet.'
        : '16 لونًا فأكثر في الطبعة الواحدة، حسب ورقة مواصفات كل طابعة.';
    default:
      return '';
  }
}

/** A stable DOM id for a shelf (its API id holds a colon). */
export const shelfDomId = (shelf: Pick<Shelf, 'id'>) => `shelf-${shelf.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

export interface JumpChip {
  id: string;
  target: string;
  label: string;
  /** Products on the shelf; null for shelves that count something else (brands). */
  count: number | null;
}

/** One chip per shelf, drawn only when there are at least two shelves to jump between. */
export function jumpChips(shelves: readonly Shelf[], lang: CatalogLang): JumpChip[] {
  if (shelves.length < 2) return [];
  return shelves.map((s) => ({
    id: s.id,
    target: shelfDomId(s),
    label: shelfChipLabel(s, lang),
    count: s.kind === 'brand' || s.kind === 'material' ? null : s.count,
  }));
}

/**
 * The hero's photograph: the admin's hero or tile cover, else a product from
 * the page's own shelves — available now first.
 */
export function heroPhoto(payload: Pick<CategoryPayload, 'node' | 'shelves'>): BannerPhoto | null {
  const own = authoredPhoto(payload.node);
  if (own) return own;
  const cards = payload.shelves.flatMap((s) => (s.products ?? []) as PhotoCandidate[]);
  const withPhoto = cards.filter((c) => photoOf(c));
  const pick = withPhoto.find((c) => Number(c.direct_stock_available ?? 0) > 0) ?? withPhoto[0];
  return pick ? { src: photoOf(pick), productPhoto: true, productId: pick.id } : null;
}

/**
 * Where the page should send the reader instead of drawing itself, or null.
 *  - an old (renamed) slug → the canonical path (owner default Q11);
 *  - a leaf section (no non-empty children) that is not a root → its listing.
 */
export function categoryRedirect(payload: Pick<CategoryPayload, 'node' | 'moved' | 'children'>, pathname: string): string | null {
  const { node } = payload;
  const isRoot = !node.parent_id;
  if (!isRoot && payload.children.length === 0) return node.path;
  if (payload.moved && node.path !== pathname) return node.path;
  return null;
}

/** «يكمّل طابعتك» for printers, «تحتاجها مع الخيوط» for filament, else a neutral «تصفّح أيضًا». */
export function relatedHeading(node: Pick<CatalogTreeNode, 'product_type' | 'is_printer_catalog'>, lang: CatalogLang): string {
  if (isPrinterNode(node)) return lang === 'en' ? 'Goes with your printer' : 'يكمّل طابعتك';
  if (node.product_type === 'filament') return lang === 'en' ? 'You’ll need these with filament' : 'تحتاجها مع الخيوط';
  return lang === 'en' ? 'Browse also' : 'تصفّح أيضًا';
}
