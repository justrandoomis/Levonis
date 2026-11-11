/**
 * THE SECTION'S STOCK ON A LISTING PAGE (owner, 2026-11-11; docs/DECISIONS.md rows 309 and 311).
 *
 * The map (GET /api/catalog/tree) stops counting stock past its cap and the live shop is past it, so a
 * listing page's section rows would carry no state. The section's counts (GET /api/catalog/:slug/counts)
 * count every product of its subtree from the cards' own states — available, pre-order, unavailable — up to
 * CATEGORY_PAGE_CAP, for the section and every visible descendant at any depth. They are public: built at
 * the guest's prices (no count depends on a price), the same for every viewer and cached for all, never the
 * per-viewer page. src/pages/CategoryListing.tsx asks them through `followSectionStock`, they are laid over
 * the map's nodes here, and `sectionStockLabel` words them.
 */
import type { CatalogTreeNode } from './types';
import { nounKindFor, sectionStockLabel, type CatalogLang, type SectionStock } from './copy';
import { loadSectionCounts } from './data';
import { listingCategory } from '../bootFetch';

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
 * EVERY SECTION'S COUNTS, REMEMBERED A MINUTE. A parent's counts already carry every visible descendant's, at
 * any depth, so opening PLA from «مواد FDM» asks nothing again (PLA's own counts are another URL, another
 * request), and coming Back draws the word at once. A minute is the counts' own lifetime (`max-age=60`).
 */
const REMEMBER_MS = 60_000;
const remembered = new Map<string, { at: number; stock: SectionStock }>();

/** For tests: a clean slate. Never called by the app. */
export function forgetSectionStock(): void {
  remembered.clear();
}

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

/**
 * WHETHER A LISTING PAGE ASKS ITS SECTION'S COUNTS: only for one section (`shown` is null on a root's «all»,
 * the whole department, whether the map or the category route named it), only when the map did not count it
 * (past TREE_AVAILABILITY_CAP; an older map without the states), and only when it is small enough for its
 * counts to be exact (CATEGORY_PAGE_CAP: past it they are null, so asking would add nothing).
 */
export function asksSectionStock(shown: CatalogTreeNode | null): shown is CatalogTreeNode {
  return (
    !!shown &&
    (typeof shown.available_count !== 'number' || shown.preorder_count === undefined) &&
    shown.product_count <= CATEGORY_PAGE_CAP
  );
}

/**
 * THE SECTION'S COUNTS FOR ITS LISTING PAGE (src/pages/CategoryListing.tsx; DECISIONS rows 309 and 311). `got`
 * receives the section's and its children's counts: at once when they are remembered, else from ONE silent GET
 * /api/catalog/:slug/counts — by id when the slug is too long to ask by (src/lib/bootFetch.ts
 * `listingCategory`), never the section's per-viewer page — whose every node is then remembered, so opening a
 * child from here asks nothing again for a minute. Returns the effect's cleanup: a page that has moved on gets
 * nothing handed over, though the answer is still remembered. A failure hands nothing over: the line simply
 * goes without its word.
 */
export function followSectionStock(shown: CatalogTreeNode, got: (counts: Map<string, SectionStock>) => void): () => void {
  const ids = [shown.id, ...(shown.children ?? []).map((c) => c.id)];
  const known = rememberedSectionStock(ids);
  if (known) {
    got(known);
    return () => {};
  }
  let alive = true;
  loadSectionCounts(listingCategory(shown))
    .then((p) => {
      rememberSectionStock(p.counts);
      if (!alive) return;
      const counts = new Map<string, SectionStock>();
      for (const n of p.counts) counts.set(n.id, n);
      got(counts);
    })
    .catch(() => {});
  return () => {
    alive = false;
  };
}
