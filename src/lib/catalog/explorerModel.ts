/**
 * THE CATEGORIES EXPLORER, AS DATA (docs/ux/CATALOG_DISCOVERY.md §5).
 *
 * Pure. The page (src/pages/CategoriesExplorer.tsx) draws what this returns
 * from `GET /api/catalog/tree` plus a pool of product cards it borrows
 * photographs from; every rule the design states lives here, where a test can
 * hold it:
 *
 *   - one full-width banner ROW per section that holds products, in the
 *     admin's `sort` order — the explorer's roots, and on a category page (or
 *     a sub-section with sections of its own) that node's children. The owner,
 *     2026-09-26: «يظهر فئات الفرعية بشكل هيرو بانر بسطر واحد مستطيل» — no
 *     chips, no grid of tiles;
 *   - the photograph is the admin's banner for the theme on screen, else the
 *     other theme's, else the section's tile cover, else a representative
 *     product — available now first, never the same product on two rows
 *     (`authoredSrc`);
 *   - the call to action is «استكشف» where the section opens onto sections of
 *     its own, «تسوق الآن» where it is a list.
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
  /**
   * The picture for the light theme, only when it differs from `src`: a
   * product's light-theme main image (0138), or the section's light banner
   * (0142).
   */
  lightSrc?: string;
  /** A catalogue photograph (crop to its product band) vs a picture the owner uploaded (shown whole). */
  productPhoto: boolean;
  productId: string | null;
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

/** The admin's pictures for a section, as the storefront reads them. */
type AuthoredPictures = Pick<CatalogTreeNode, 'hero_image_url' | 'image_url'> &
  // Optional: a Worker older than migration 0142 does not send it.
  Partial<Pick<CatalogTreeNode, 'hero_light_image_url'>>;

/**
 * THE BANNER PICTURE FOR ONE THEME (owner, 2026-09-26: «صورتين تناسب الثيم
 * الفاتح والثيم الداكن»). In order: this theme's banner → the other theme's
 * banner → the home tile's cover → '' (the caller then borrows a product
 * photograph). `hero_image_url` IS the dark banner (0136, kept so every hero
 * already uploaded still shows); `hero_light_image_url` its light twin (0142).
 */
export function authoredSrc(node: AuthoredPictures, theme: 'light' | 'dark'): string {
  const dark = node.hero_image_url || '';
  const light = node.hero_light_image_url || '';
  const chain = theme === 'light' ? [light, dark] : [dark, light];
  return chain.find(Boolean) || node.image_url || '';
}

/**
 * The admin's own picture for a section, when there is one — both themes'
 * files, so `CropPhoto` requests only the one on screen (`themedImage`).
 */
export function authoredPhoto(node: AuthoredPictures): BannerPhoto | null {
  const src = authoredSrc(node, 'dark');
  if (!src) return null;
  const light = authoredSrc(node, 'light');
  return { src, productPhoto: false, productId: null, ...(light !== src ? { lightSrc: light } : {}) };
}

/** Would `/categories/<node>` draw shelves (true) or be the listing itself (false)? */
export function drawsShelves(node: Pick<CatalogTreeNode, 'children' | 'product_count'>): boolean {
  const kids = (node.children ?? []).filter((c) => c.product_count > 0).length;
  return !(kids <= 1 && node.product_count < LISTING_LAYOUT_BELOW);
}

/** One banner row: a section and the photograph it shows (null until one is found). */
export interface BannerRow {
  node: CatalogTreeNode;
  photo: BannerPhoto | null;
}

/**
 * The banner rows for a list of sections — the explorer's roots, a category's
 * children, a sub-section's own children. Only sections that hold products, in
 * the order given (the admin's `sort`). The admin's picture wins; else a
 * product photograph from `pool`, available now first and never the same
 * product on two rows. `avoid` names products already on screen (the page
 * hero's): skipped while another candidate exists, used rather than leave a
 * row bare.
 */
export function bannerRows(
  nodes: readonly CatalogTreeNode[],
  pool: readonly PhotoCandidate[],
  avoid: ReadonlySet<string> = new Set()
): BannerRow[] {
  const shown = nodes.filter((n) => n.product_count > 0);
  const used = new Set<string>();
  // Authored pictures first, so a product photograph is never borrowed for a
  // row that already has its own.
  const photos = new Map<string, BannerPhoto | null>(shown.map((n) => [n.id, authoredPhoto(n)]));
  for (const n of shown) {
    if (photos.get(n.id)) continue;
    const photo = representativePhoto(n, pool, new Set([...used, ...avoid])) ?? representativePhoto(n, pool, used);
    if (photo?.productId) used.add(photo.productId);
    photos.set(n.id, photo);
  }
  return shown.map((node) => ({ node, photo: photos.get(node.id) ?? null }));
}

/** Rows still without a photograph — the page asks the listing for these. */
export function rowsWithoutPhoto(rows: readonly BannerRow[]): CatalogTreeNode[] {
  return rows.filter((r) => !r.photo).map((r) => r.node);
}

/** «استكشف» for a section with sections of its own to open, «تسوق الآن» for one that is a list. */
export function bannerCta(node: Pick<CatalogTreeNode, 'children'>): 'explore' | 'shop' {
  return (node.children ?? []).some((c) => c.product_count > 0) ? 'explore' : 'shop';
}
