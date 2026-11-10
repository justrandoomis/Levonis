/**
 * THE SECTION'S STOCK ON A LISTING PAGE (owner, 2026-11-11; docs/DECISIONS.md row 309).
 *
 * The map (GET /api/catalog/tree) stops counting stock past its cap and the live shop is past it, so a
 * listing page's section rows would carry no state. The section's own answer (GET /api/catalog/:slug)
 * counts every product of its subtree from the cards it reads — available, pre-order, unavailable — up to
 * CATEGORY_PAGE_CAP. Its counts are laid over the map's nodes here, and `sectionStockLabel` words them.
 */
import type { CatalogTreeNode } from './types';
import type { SectionStock } from './copy';

/** The products one category answer reads (worker/routes/catalog.ts CATEGORY_PAGE_CAP); past it its counts are null. */
export const CATEGORY_PAGE_CAP = 200;

/**
 * The node with the section answer's state counts — only when that answer counted the same products as the
 * map (a cached map and a fresher answer can disagree; then nothing is laid over and the line adds nothing).
 */
export function withStock(node: CatalogTreeNode, counts: ReadonlyMap<string, SectionStock> | null): CatalogTreeNode {
  const s = counts?.get(node.id);
  if (!s || s.product_count !== node.product_count) return node;
  return {
    ...node,
    available_count: s.available_count,
    preorder_count: s.preorder_count ?? null,
    unavailable_count: s.unavailable_count ?? null,
  };
}
