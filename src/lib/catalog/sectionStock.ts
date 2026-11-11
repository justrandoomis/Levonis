/**
 * THE SECTION'S STOCK ON A LISTING PAGE (owner, 2026-11-11; docs/DECISIONS.md row 309).
 *
 * The map (GET /api/catalog/tree) stops counting stock past its cap and the live shop is past it, so a
 * listing page's section rows would carry no state. The section's own answer (GET /api/catalog/:slug)
 * counts every product of its subtree from the cards it reads — available, pre-order, unavailable — up to
 * CATEGORY_PAGE_CAP. Its counts are laid over the map's nodes here, and `sectionStockLabel` words them.
 */
import type { CatalogTreeNode } from './types';
import { nounKindFor, sectionStockLabel, type CatalogLang, type SectionStock } from './copy';

/**
 * The products one category answer reads (worker/routes/catalog.ts CATEGORY_PAGE_CAP: every product of the
 * section up to a thousand, DECISIONS row 311); past it its counts are null, so a bigger section is not asked.
 */
export const CATEGORY_PAGE_CAP = 1000;

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
    withheld_count: s.withheld_count ?? null,
  };
}

/**
 * THE LISTING HEADER'S SECTION WORD (DECISIONS row 309): beside the section's count, what it can do now —
 * «1 متوفر الآن», «بطلب مسبق», «غير متوفرة حالياً» — from the map's node with the section's own counts laid
 * over it. Nothing on a root's «all» (`wholeRoot`, src/lib/catalog/listingModel.ts `listingTarget`): that is the
 * whole department, asked for as such, whether the map named the root or the category route did.
 */
export function listingStockWord(
  target: { node: CatalogTreeNode; wholeRoot: boolean },
  counts: ReadonlyMap<string, SectionStock> | null,
  lang: CatalogLang
): string | null {
  if (target.wholeRoot) return null;
  const { node } = target;
  return sectionStockLabel(withStock(node, counts), nounKindFor(node.product_type, node.is_printer_catalog), lang);
}

/**
 * EVERY SECTION ANSWER, REMEMBERED A MINUTE. A parent's answer already carries its children's exact counts, so
 * opening PLA from «مواد FDM» (or coming Back) asks nothing again; the signed-in owner's answer is not cached
 * by the browser (private, no-store), and this keeps the listing from rebuilding it on every hop.
 */
const REMEMBER_MS = 60_000;
const remembered = new Map<string, { at: number; stock: SectionStock }>();

export function rememberSectionStock(nodes: Iterable<{ id: string } & SectionStock>, now = Date.now()): void {
  for (const n of nodes) {
    if (typeof n.available_count !== 'number') continue;
    remembered.set(n.id, {
      at: now,
      stock: {
        product_count: n.product_count,
        available_count: n.available_count,
        preorder_count: n.preorder_count ?? null,
        unavailable_count: n.unavailable_count ?? null,
        withheld_count: n.withheld_count ?? null,
      },
    });
  }
}

/** The remembered counts of every id, or null when any is missing or older than a minute. */
export function rememberedSectionStock(ids: readonly string[], now = Date.now()): Map<string, SectionStock> | null {
  const out = new Map<string, SectionStock>();
  for (const id of ids) {
    const hit = remembered.get(id);
    if (!hit || now - hit.at > REMEMBER_MS) return null;
    out.set(id, hit.stock);
  }
  return out;
}
