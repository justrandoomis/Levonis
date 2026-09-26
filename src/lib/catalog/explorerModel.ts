/**
 * THE CATEGORIES EXPLORER, AS DATA (docs/ux/CATALOG_DISCOVERY.md §5).
 *
 * Pure. The page (src/pages/CategoriesExplorer.tsx) draws what this returns
 * from `GET /api/catalog/tree` plus a pool of product cards it borrows
 * photographs from; every rule the design states lives here, where a test can
 * hold it:
 *
 *   - one banner per root, in the admin's `sort` order;
 *   - the LEAD banner is the printers root (`is_printer_catalog`), else the
 *     root with the most products;
 *   - the photograph is the admin's hero, else the section's tile cover, else
 *     a representative product — available now first, never the same product
 *     on two banners;
 *   - sub-category chips only under a root whose own page would show shelves
 *     (≥ 2 non-empty children, or 1 child and ≥ 8 products). Under a root that
 *     renders as a listing the chip would lead to the same list twice.
 */
import type { CatalogTreeNode } from './types';

/** worker/lib/catalogPresentation.ts LISTING_LAYOUT_BELOW (a test holds them equal). */
export const LISTING_LAYOUT_BELOW = 8;

/** What a card must carry to lend its photograph. */
export interface PhotoCandidate {
  id: string;
  category_id?: string | null;
  sub_category_id?: string | null;
  direct_stock_available?: number | null;
  images?: readonly string[] | null;
  media?: readonly { url?: string | null; primary?: boolean | null }[] | null;
  /** «الصورة الرئيسية للوضع الفاتح» (migration 0138). */
  light_image?: string | null;
}

export interface BannerPhoto {
  src: string;
  /** The product's light-theme main image (0138), only when it has one. */
  lightSrc?: string;
  /** A catalogue photograph (crop to its product band) vs a picture the owner uploaded (shown whole). */
  productPhoto: boolean;
  productId: string | null;
}

export interface ExplorerBanner {
  node: CatalogTreeNode;
  variant: 'lead' | 'regular';
  photo: BannerPhoto | null;
  /** Chips under the banner — empty when none should be drawn. */
  subs: CatalogTreeNode[];
}

/** The first image a card shows (primary media, else the published list). */
export function photoOf(p: PhotoCandidate): string {
  const media = p.media ?? [];
  const primary = media.find((m) => m?.primary && m.url) ?? media.find((m) => m?.url);
  if (primary?.url) return primary.url;
  return (p.images ?? []).find((u) => typeof u === 'string' && u.trim() !== '') ?? '';
}

/** Every catalog id at or below `node`. */
export function subtreeIds(node: CatalogTreeNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: CatalogTreeNode) => {
    out.add(n.id);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

const inSubtree = (p: PhotoCandidate, ids: Set<string>) =>
  (!!p.category_id && ids.has(p.category_id)) || (!!p.sub_category_id && ids.has(p.sub_category_id));

/**
 * A product photograph for `node`: available-now first, then pool order,
 * skipping products another banner already used.
 */
export function representativePhoto(
  node: CatalogTreeNode,
  pool: readonly PhotoCandidate[],
  avoid: ReadonlySet<string> = new Set()
): BannerPhoto | null {
  const ids = subtreeIds(node);
  let best: PhotoCandidate | null = null;
  let bestRank = Infinity;
  for (const p of pool) {
    if (avoid.has(p.id) || !inSubtree(p, ids) || !photoOf(p)) continue;
    const rank = Number(p.direct_stock_available ?? 0) > 0 ? 0 : 1;
    if (rank < bestRank) {
      best = p;
      bestRank = rank;
    }
  }
  return best ? productBannerPhoto(best) : null;
}

/** A product's photograph for a banner: its primary, and its light-theme twin when it has one. */
export function productBannerPhoto(p: PhotoCandidate): BannerPhoto {
  const light = typeof p.light_image === 'string' ? p.light_image.trim() : '';
  return { src: photoOf(p), productPhoto: true, productId: p.id, ...(light ? { lightSrc: light } : {}) };
}

/** The admin's own picture for a section, when there is one. */
export function authoredPhoto(node: Pick<CatalogTreeNode, 'hero_image_url' | 'image_url'>): BannerPhoto | null {
  const src = node.hero_image_url || node.image_url;
  return src ? { src, productPhoto: false, productId: null } : null;
}

/** The lead root: printers, else the most products (ties keep `sort` order). */
export function leadRootId(roots: readonly CatalogTreeNode[]): string | null {
  const printers = roots.find((r) => r.is_printer_catalog);
  if (printers) return printers.id;
  let best: CatalogTreeNode | null = null;
  for (const r of roots) if (!best || r.product_count > best.product_count) best = r;
  return best?.id ?? null;
}

/** Would `/categories/<node>` draw shelves (true) or be the listing itself (false)? */
export function drawsShelves(node: Pick<CatalogTreeNode, 'children' | 'product_count'>): boolean {
  const kids = (node.children ?? []).filter((c) => c.product_count > 0).length;
  return !(kids <= 1 && node.product_count < LISTING_LAYOUT_BELOW);
}

/** The chips under a banner: its non-empty children, only where they add a door. */
export function subChipsFor(node: CatalogTreeNode): CatalogTreeNode[] {
  const kids = (node.children ?? []).filter((c) => c.product_count > 0);
  return kids.length > 0 && drawsShelves(node) ? kids : [];
}

export function explorerBanners(roots: readonly CatalogTreeNode[], pool: readonly PhotoCandidate[]): ExplorerBanner[] {
  const lead = leadRootId(roots);
  const used = new Set<string>();
  const shown = roots.filter((r) => r.product_count > 0);
  // Authored pictures first, so a product photograph is never borrowed for a
  // banner that already has its own.
  const photos = new Map<string, BannerPhoto | null>();
  for (const r of shown) photos.set(r.id, authoredPhoto(r));
  // The lead banner picks first: it is the largest photograph on the page.
  const order = [...shown].sort((a, b) => Number(b.id === lead) - Number(a.id === lead));
  for (const r of order) {
    if (photos.get(r.id)) continue;
    const photo = representativePhoto(r, pool, used);
    if (photo?.productId) used.add(photo.productId);
    photos.set(r.id, photo);
  }
  return shown.map((node) => ({
    node,
    variant: node.id === lead ? 'lead' : 'regular',
    photo: photos.get(node.id) ?? null,
    subs: subChipsFor(node),
  }));
}

/** Roots whose banner still has no photograph — the page asks the listing for these. */
export function rootsWithoutPhoto(banners: readonly ExplorerBanner[]): CatalogTreeNode[] {
  return banners.filter((b) => !b.photo).map((b) => b.node);
}
