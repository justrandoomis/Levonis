/**
 * «متوفر الآن» — THE HOME SECTION OF WHAT IS ON THE SHELF RIGHT NOW
 * (owner, 2026-11-18: «add product on stock now, that show catalogs for
 * products on stock only», just below the two editorial banners).
 *
 * ONE REQUEST PER MAIN CATALOG, IN PARALLEL (owner, 2026-11-18, round 2:
 * «doesnot include all products on stock like printers and accessories»).
 * The all-shop `avail=1` list is answered from a capped slice of the newest
 * candidates (`truncated: true`) — on the live shop it found 4 of the 14
 * products in stock and no printer. Asked catalog by catalog, the same filter
 * is complete (`truncated: false`) and each answer is edge-cached for 60 s.
 *
 * The filter is the server's «المتوفر الآن فقط» (`avail=1`,
 * packages/catalog/src/discovery.ts) — direct-sale units available now,
 * proved over the option graph — and the browser checks it once more with the
 * home's own rule (`isAvailableDirect`), so a card from a cached answer whose
 * last unit has since sold never sits under this title.
 *
 * FAST (same round: «delayed very slow»). The home page mounts the section
 * right after its first paint, long before it is scrolled to, and mounting
 * sends the requests (`startInStock`); the section shows its title and
 * placeholder cards at once and
 * fills in catalog by catalog as the answers land. The answers are kept for
 * a minute, so coming back to the home page draws the section at once.
 *
 * THE CHIPS ARE THE CATALOGS THAT HOLD STOCK, in the tree's order; a catalog
 * with nothing on the shelf has no chip. A chip's «عرض الكل» opens that
 * catalog's whole list with the same filter on
 * (`/categories/<slug>/all?avail=1`, the smart shelves' door).
 */
import { api, type ApiProduct, type HomeTaxon } from './api';
import { isAvailableDirect } from './homeLayout';

/** Only what can be bought for direct sale now, each product once, in the given order. */
export function inStockOnly<T extends Pick<ApiProduct, 'id' | 'direct_stock_available'>>(products: readonly T[]): T[] {
  const seen = new Set<string>();
  return products.filter((p) => isAvailableDirect(p) && (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

/** One catalog's in-stock list. 20 is the card rail's most; «عرض الكل» opens the rest. */
export function inStockCatalogPath(catalogId: string): string {
  return `/api/products?avail=1&category=${encodeURIComponent(catalogId)}&limit=20`;
}

/** Where «عرض الكل» goes: the chosen catalog's whole in-stock list, or none for «الكل» (no all-shop in-stock page). */
export function inStockSeeAll(catalog: Pick<HomeTaxon, 'slug'> | undefined): string | undefined {
  return catalog ? `/categories/${encodeURIComponent(catalog.slug)}/all?avail=1` : undefined;
}

/**
 * «الكل»: the catalogs taken in turn — one from each, then the next from each
 * — so twelve printers cannot push every part and kit off the rail.
 */
export function interleave<T extends { id: string }>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const p = list[i];
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ the loader

/** Per catalog id: its in-stock products, or `undefined` while its answer is on the way. */
export type InStockResults = Readonly<Record<string, ApiProduct[] | undefined>>;

interface Load {
  key: string;
  at: number;
  results: Record<string, ApiProduct[] | undefined>;
  listeners: Set<() => void>;
}

/** A minute, like the answers' own `max-age`: stock changes, the home page is revisited. */
const FRESH_MS = 60_000;
let load: Load | null = null;

const keyOf = (tree: readonly HomeTaxon[]) => tree.map((n) => n.id).join(',');

/**
 * Ask every main catalog for its in-stock list, once per minute per tree.
 * Safe to call on every render: a load already under way (or fresh) is kept.
 */
export function startInStock(tree: readonly HomeTaxon[], now: number = Date.now()): void {
  const key = keyOf(tree);
  if (!key || (load && load.key === key && now - load.at < FRESH_MS)) return;
  const listeners = load?.listeners ?? new Set<() => void>();
  const current: Load = { key, at: now, results: {}, listeners };
  load = current;
  for (const node of tree) {
    api
      .get<{ products?: ApiProduct[] }>(inStockCatalogPath(node.id))
      .then((r) => inStockOnly(r.products ?? []))
      // A catalog that failed shows nothing rather than holding the others back.
      .catch(() => [] as ApiProduct[])
      .then((products) => {
        if (load !== current) return;
        current.results = { ...current.results, [node.id]: products };
        current.listeners.forEach((fn) => fn());
      });
  }
}

/** What has arrived for this tree so far (an empty object before `startInStock`). */
export function inStockResults(tree: readonly HomeTaxon[]): InStockResults {
  return load && load.key === keyOf(tree) ? load.results : {};
}

/** Be told when another catalog's answer lands. */
export function subscribeInStock(fn: () => void): () => void {
  if (!load) load = { key: '', at: 0, results: {}, listeners: new Set() };
  const listeners = load.listeners;
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests only: forget the current load. */
export function resetInStockForTests(): void {
  load = null;
}
