/**
 * «متوفر الآن» — THE HOME SECTION OF WHAT IS ON THE SHELF RIGHT NOW
 * (owner, 2026-11-18: «add product on stock now, that show catalogs for
 * products on stock only», just below the two editorial banners).
 *
 * The list is the server's own «المتوفر الآن فقط» filter (`avail=1`,
 * packages/catalog/src/discovery.ts) — direct-sale units available now,
 * proved over the option graph — and the browser checks it once more with the
 * home's own rule (`isAvailableDirect`), so a card from a cached answer whose
 * last unit has since sold never sits under this title.
 *
 * THE CHIPS ARE THE CATALOGS THAT HOLD STOCK. One chip per main catalog of the
 * tree that has at least one of these products, most-stocked first; a catalog
 * with nothing on the shelf has no chip, so a chip never opens an empty rail.
 * A chip's «عرض الكل» opens that catalog's whole list with the same filter on
 * (`/categories/<slug>/all?avail=1`, the smart shelves' door).
 */
import type { ApiProduct, HomeTaxon } from './api';
import { inSections, isAvailableDirect, subtreeIds } from './homeLayout';

export interface InStockCatalog {
  id: string;
  slug: string;
  node: HomeTaxon;
  /** The catalog and every section below it. */
  memberIds: Set<string>;
  /** How many of the products on hand fall in it. */
  count: number;
}

/** Only what can be bought for direct sale now, each product once, in the server's order. */
export function inStockOnly<T extends Pick<ApiProduct, 'id' | 'direct_stock_available'>>(products: readonly T[]): T[] {
  const seen = new Set<string>();
  return products.filter((p) => isAvailableDirect(p) && (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

/** The main catalogs that hold at least one of `products`, most-stocked first (ties keep the tree's order). */
export function inStockCatalogs(
  tree: readonly HomeTaxon[],
  products: readonly Pick<ApiProduct, 'category_id' | 'sub_category_id'>[]
): InStockCatalog[] {
  return tree
    .map((node, index) => {
      const memberIds = subtreeIds(node);
      return { id: node.id, slug: node.slug, node, memberIds, count: products.filter((p) => inSections(p, memberIds)).length, index };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ index: _index, ...c }) => c);
}

/** Where «عرض الكل» goes: the chosen catalog's whole in-stock list, or none for «الكل» (no all-shop in-stock page). */
export function inStockSeeAll(catalog: Pick<InStockCatalog, 'slug'> | undefined): string | undefined {
  return catalog ? `/categories/${encodeURIComponent(catalog.slug)}/all?avail=1` : undefined;
}

/** The request for the section's opening list, and for one catalog's. */
export const IN_STOCK_PATH = '/api/products?avail=1&limit=50';
export function inStockCatalogPath(catalogId: string): string {
  return `/api/products?avail=1&category=${encodeURIComponent(catalogId)}&limit=20`;
}
