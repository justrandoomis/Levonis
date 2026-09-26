/**
 * THE HOME PAGE'S DATA DECISIONS, as pure functions (homepage v2).
 *
 * Every section below the ticker is drawn from data the page ALREADY has —
 * `GET /api/home` (the category tree, the newest products, the graded shelf,
 * the owner's banners) and `GET /api/home/sections` (best sellers, the
 * materials sample, the featured flag). Nothing here fetches, and nothing
 * here invents: a tile whose category the shop does not stock is left out
 * rather than drawn over an empty listing, and a picture is always a real
 * product photograph or a picture the owner uploaded.
 *
 * Kept free of React and of the DOM so tests/homeV2Layout.test.ts can hold the
 * mapping and the ordering directly.
 */
import type { ApiProduct, BentoPosition, HomeBanner, HomeTaxon, LocalizedText, SiteMediaEntry } from './api';
import { productPrimaryImage } from './productImage';

// ------------------------------------------------------------- the taxonomy

/**
 * How a bento tile finds ITS category in the live tree.
 *
 * The taxonomy is admin-editable, and the seed (migration 0018) had to fall
 * back to suffixed slugs where a slug was taken — so a tile names the seeded
 * id first, then the slugs it may have been given, in order of preference.
 * Several ids for one tile mean "the nearest real section if the first has
 * nothing in it" — «الإكسسوارات والأدوات» is `cat_accessories` when that
 * section stocks anything, and the Maker tools section otherwise.
 */
export interface CategoryMatcher {
  ids: readonly string[];
  slugs: readonly string[];
}

export type BentoTileId = 'printers' | 'filament' | 'resin' | 'parts' | 'accessories' | 'used';

export const BENTO_MATCHERS: Record<Exclude<BentoTileId, 'used'>, CategoryMatcher> = {
  printers: { ids: ['cat_printers'], slugs: ['printers', 'printers-levo', '3d-printers'] },
  filament: { ids: ['cat_materials_fdm'], slugs: ['fdm-materials', 'fdm-materials-levo', 'filament', 'filaments'] },
  resin: { ids: ['cat_materials_resin'], slugs: ['resin-materials', 'resin-materials-levo', 'resin'] },
  // «قطع الغيار والمستلزمات» — nozzles, hot ends and the like are filed under
  // «ملحقات الطابعات» (Printer Accessories); there is no separate spare-parts
  // section in the taxonomy.
  parts: { ids: ['cat_pacc'], slugs: ['printer-accessories', 'printer-accessories-levo', 'spare-parts'] },
  accessories: {
    ids: ['cat_accessories', 'cat_makers_tools'],
    slugs: ['accessories', 'accessories-levo', 'maker-tools', 'maker-tools-levo'],
  },
};

/** The materials ROOT («مواد الطباعة»), for the second editorial banner. */
export const MATERIALS_MATCHER: CategoryMatcher = {
  ids: ['cat_materials'],
  slugs: ['printing-materials', 'printing-materials-levo'],
};

/** Every node of the tree, roots first, each child after its root. */
function flatten(tree: readonly HomeTaxon[]): HomeTaxon[] {
  const out: HomeTaxon[] = [];
  for (const root of tree) {
    out.push(root);
    for (const child of root.children ?? []) out.push(child);
  }
  return out;
}

/**
 * The category's own page (`/categories/<root>` or `/categories/<root>/<child>`,
 * the paths worker/lib/catalogPresentation.ts `path()` builds), so a home tile
 * opens the category gateway rather than the old flat `/products?category=`
 * list. A node the tree does not hold falls back to that old link.
 */
export function categoryHref(tree: readonly HomeTaxon[], node: HomeTaxon): string {
  const enc = encodeURIComponent;
  for (const root of tree) {
    if (root.id === node.id) return `/categories/${enc(root.slug)}`;
    if ((root.children ?? []).some((c) => c.id === node.id)) return `/categories/${enc(root.slug)}/${enc(node.slug)}`;
  }
  return `/products?category=${enc(node.id)}`;
}

/**
 * The first node the matcher names that the tree actually holds. The home
 * tree only carries sections WITH products (worker/lib/catalogMembership.ts
 * `homeCategoryTree`), so a match here is also a promise that the listing the
 * tile opens is not empty.
 */
export function findCategory(tree: readonly HomeTaxon[], matcher: CategoryMatcher): HomeTaxon | null {
  const nodes = flatten(tree);
  for (const id of matcher.ids) {
    const hit = nodes.find((n) => n.id === id);
    if (hit) return hit;
  }
  for (const slug of matcher.slugs) {
    const hit = nodes.find((n) => n.slug === slug);
    if (hit) return hit;
  }
  return null;
}

/** The ids a product may be filed under to count as "in" this section. */
export function subtreeIds(node: HomeTaxon): Set<string> {
  return new Set([node.id, ...(node.children ?? []).map((c) => c.id)]);
}

/** Is the product filed in one of these sections (classification columns)? */
export function inSections(p: Pick<ApiProduct, 'category_id' | 'sub_category_id'>, ids: ReadonlySet<string>): boolean {
  return (!!p.category_id && ids.has(p.category_id)) || (!!p.sub_category_id && ids.has(p.sub_category_id));
}

// ------------------------------------------------------------- availability

/**
 * AVAILABLE FOR DIRECT SALE, right now: the server's exact count of sellable
 * direct-sale units is positive. `direct_stock_available` is omitted when the
 * count is deliberately hidden and is 0 for an exhausted shelf — both mean
 * "not known to be in stock", so neither is promoted.
 */
export function isAvailableDirect(p: Pick<ApiProduct, 'direct_stock_available'>): boolean {
  return (p.direct_stock_available ?? 0) > 0;
}

/**
 * «أحدث المنتجات», ordered: products available for direct sale first, then the
 * rest — each group keeping the order the server sent (newest first). A
 * STABLE partition, not a sort by stock: 5 units is not "more new" than 2.
 * Duplicates (the same product from two shelves) keep their first position.
 */
export function orderLatest<T extends Pick<ApiProduct, 'id' | 'direct_stock_available'>>(products: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique = products.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  return [...unique.filter(isAvailableDirect), ...unique.filter((p) => !isAvailableDirect(p))];
}

// ------------------------------------------------------------- the pictures

/** A product's light-theme main image (0138), or '' — never the primary. */
function lightOf(p: ApiProduct | null | undefined): string {
  return typeof p?.light_image === 'string' ? p.light_image.trim() : '';
}

function hasImage(p: ApiProduct): boolean {
  return productPrimaryImage(p) !== '';
}

/**
 * THE OWNER'S PAIR FOR ONE HOME PICTURE (admin «صور وأيقونات الصفحة الرئيسية»,
 * site-media slots `home-<target>-light` / `home-<target>-dark`, see
 * worker/lib/siteMedia.ts HOME_PHOTO_SLOTS).
 *
 * Returned in the shape every home picture already takes — `image` is what the
 * DARK theme draws and `lightImage` what the LIGHT one draws when set
 * (src/lib/productImage.ts `themedImage`) — so the resolution is:
 *   - the current theme's picture;
 *   - only one uploaded: that one, for both themes;
 *   - neither: null, and the caller keeps its automatic product photograph.
 */
export function ownerPhoto(
  siteMedia: readonly SiteMediaEntry[],
  target: string
): { image: string; lightImage: string } | null {
  const url = (theme: 'light' | 'dark') =>
    siteMedia.find((m) => m.group === 'home' && m.target === target && m.theme === theme && m.url)?.url || '';
  const light = url('light');
  const dark = url('dark');
  if (!light && !dark) return null;
  return { image: dark || light, lightImage: light };
}

/**
 * A representative photograph for a section: a product IN the section that
 * has a picture, preferring one that can be bought right now, never one of
 * `avoid` (so two tiles do not show the same photo). Returns null rather than
 * a stock image when there is none — the tile then draws without a picture.
 */
export function representative(
  pool: readonly ApiProduct[],
  ids: ReadonlySet<string>,
  avoid: ReadonlySet<string> = new Set(),
  prefer?: (p: ApiProduct) => boolean
): ApiProduct | null {
  const candidates = pool.filter((p) => inSections(p, ids) && hasImage(p) && !avoid.has(p.id));
  const rank = (p: ApiProduct) => (prefer?.(p) ? 0 : 2) + (isAvailableDirect(p) ? 0 : 1);
  let best: ApiProduct | null = null;
  for (const p of candidates) if (!best || rank(p) < rank(best)) best = p;
  return best;
}

// ------------------------------------------------------------- the bento

/**
 * The six SQUARES, and the section each one shows when the owner has not
 * assigned it (admin «إعدادات الصفحة الرئيسية» → «تسوق حسب الفئة»,
 * worker/lib/homeBento.ts). `large` is the near-square tile — on the LEFT in
 * Arabic — `top-*` the two wide tiles above, `bottom-*` the three below.
 */
export const BENTO_POSITIONS: readonly BentoPosition[] = ['large', 'top-1', 'top-2', 'bottom-1', 'bottom-2', 'bottom-3'];

export const BENTO_DEFAULTS: Readonly<Record<BentoPosition, BentoTileId>> = {
  large: 'printers',
  'top-1': 'filament',
  'top-2': 'resin',
  'bottom-1': 'parts',
  'bottom-2': 'accessories',
  'bottom-3': 'used',
};

/** The owner's assignment, as `/api/home` sends it (`settings.homeBento`). */
export type BentoAssignments = Partial<Record<BentoPosition, { category: string; title?: LocalizedText | null }>>;

export interface BentoTile {
  /** The square it fills. */
  position: BentoPosition;
  /**
   * Which built-in section this is — it picks the tile's default copy and the
   * «أحدث المنتجات» chip it feeds — or null for a section the owner assigned
   * that none of the built-in matchers names (the tile then shows the
   * section's own name).
   */
  id: BentoTileId | null;
  /** An in-app route: the category page (`categoryHref`) or `/used-printers`. */
  to: string;
  /** The category the tile opens, or null for the graded-stock page. */
  category: HomeTaxon | null;
  /** The owner's title for the square, when they wrote one. */
  title: LocalizedText | null;
  /** The owner's picture for the square, else the section's, else a product photograph, else ''. */
  image: string;
  /**
   * The light-theme picture: the owner's light upload, or the borrowed
   * product's light-theme main image (migration 0138); '' when there is none.
   * The tile shows it on the light theme and `image` on the dark one
   * (src/lib/productImage.ts `themedImage`).
   */
  lightImage: string;
  /** The product whose photograph was borrowed, for `avoid` bookkeeping. */
  imageProductId: string | null;
}

/**
 * A PRODUCT photograph (as opposed to a picture the owner uploaded for a
 * section or a banner). The shop's catalogue photographs share one studio
 * template — the product lit on near-black in the middle band, the product's
 * title lettered across the top fifth and the shop's address along the bottom
 * — so a tile that borrows one crops to the middle band (`.lv-promo-photo`),
 * and never lays its own label over someone else's lettering. An uploaded
 * picture is the owner's composition and is shown whole.
 */
export function isProductPhoto(card: { imageProductId?: string | null; productPhoto?: boolean }): boolean {
  return card.productPhoto ?? !!card.imageProductId;
}

const USED = 'used';

/** The built-in section this node is, if a matcher names it. */
function presetOf(tree: readonly HomeTaxon[], node: HomeTaxon): BentoTileId | null {
  for (const id of Object.keys(BENTO_MATCHERS) as Array<Exclude<BentoTileId, 'used'>>) {
    if (findCategory(tree, BENTO_MATCHERS[id])?.id === node.id) return id;
  }
  return null;
}

/**
 * The six tiles, resolved against the live tree, one per square.
 *
 * 1. A square the owner ASSIGNED shows that section (or the graded shelf,
 *    `used`) with their title — found by id anywhere in the tree.
 * 2. An unassigned square keeps the automatic matching (`BENTO_DEFAULTS` +
 *    `BENTO_MATCHERS`), skipping a section already shown by another square.
 *
 * Either way a tile is returned only when its section has products — the tree
 * `/api/home` sends carries only stocked sections — or, for the graded shelf,
 * when it has units. No square ever opens an empty listing; the layout adapts
 * to the tiles it gets.
 */
export function resolveBento(
  tree: readonly HomeTaxon[],
  pool: readonly ApiProduct[],
  openBox: readonly ApiProduct[],
  siteMedia: readonly SiteMediaEntry[] = [],
  assignments: BentoAssignments | null | undefined = {}
): BentoTile[] {
  const nodes = flatten(tree);
  const assigned = assignments ?? {};
  type Target = { node: HomeTaxon | null; used: boolean; title: LocalizedText | null };
  /** An assigned square's section — null when it is not stocked (not in the tree). */
  const assignedTarget = (a: { category: string; title?: LocalizedText | null }): Target | null => {
    const title = a.title && (a.title.ar || a.title.en || a.title.ckb) ? a.title : null;
    if (a.category === USED) return openBox.length > 0 ? { node: null, used: true, title } : null;
    const node = nodes.find((n) => n.id === a.category);
    return node ? { node, used: false, title } : null;
  };

  // Pass 1: the owner's squares. Pass 2: the automatic ones, around them.
  const chosen = new Map<BentoPosition, Target>();
  const taken = new Set<string>();
  for (const position of BENTO_POSITIONS) {
    const a = assigned[position];
    if (!a || typeof a.category !== 'string') continue;
    const t = assignedTarget(a);
    if (!t) continue;
    chosen.set(position, t);
    taken.add(t.used ? USED : t.node!.id);
  }
  for (const position of BENTO_POSITIONS) {
    if (typeof assigned[position]?.category === 'string') continue;
    const preset = BENTO_DEFAULTS[position];
    if (preset === 'used') {
      if (openBox.length > 0 && !taken.has(USED)) chosen.set(position, { node: null, used: true, title: null });
      continue;
    }
    const node = findCategory(tree, BENTO_MATCHERS[preset]);
    if (node && !taken.has(node.id)) {
      chosen.set(position, { node, used: false, title: null });
      taken.add(node.id);
    }
  }

  const avoid = new Set<string>();
  const tiles: BentoTile[] = [];
  for (const position of BENTO_POSITIONS) {
    const t = chosen.get(position);
    if (!t) continue;
    // The admin's light/dark pair for the square first, then the section's
    // own cover from the taxonomy, then a borrowed product photograph.
    const own = ownerPhoto(siteMedia, `bento-${position}`);
    if (t.used) {
      const photo = own ? null : openBox.find((p) => hasImage(p) && !avoid.has(p.id)) ?? openBox.find(hasImage) ?? null;
      if (photo) avoid.add(photo.id);
      tiles.push({
        position,
        id: 'used',
        to: '/used-printers',
        category: null,
        title: t.title,
        image: own?.image || (photo ? productPrimaryImage(photo) : ''),
        lightImage: own ? own.lightImage : lightOf(photo),
        imageProductId: photo?.id ?? null,
      });
      continue;
    }
    const node = t.node!;
    const authored = own ? '' : node.image_url || '';
    const product = own || authored ? null : representative(pool, subtreeIds(node), avoid);
    if (product) avoid.add(product.id);
    tiles.push({
      position,
      id: presetOf(tree, node),
      to: categoryHref(tree, node),
      category: node,
      title: t.title,
      image: own?.image || authored || (product ? productPrimaryImage(product) : ''),
      lightImage: own ? own.lightImage : authored ? '' : lightOf(product),
      imageProductId: product?.id ?? null,
    });
  }
  return tiles;
}

// ------------------------------------------------------------- latest chips

export type LatestChipId = 'all' | 'printers' | 'filament' | 'resin' | 'accessories';

export interface LatestChip {
  id: LatestChipId;
  /** The sections this chip lists — empty for «الكل». */
  categoryIds: string[];
  /** Every id in those sections' subtrees, for filtering what is on the page. */
  memberIds: Set<string>;
}

/**
 * The filter chips of «أحدث المنتجات», from the bento's resolved tiles. A chip
 * exists only for a section the shop stocks. «الإكسسوارات» covers BOTH
 * accessory tiles: the taxonomy's «ملحقات الطابعات» is literally "Printer
 * Accessories", so a customer tapping «الإكسسوارات» expects it too.
 */
export function latestChips(tiles: readonly BentoTile[]): LatestChip[] {
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const chip = (id: LatestChipId, from: BentoTileId[]): LatestChip | null => {
    const nodes = from.map((f) => byId.get(f)?.category).filter((n): n is HomeTaxon => !!n);
    if (nodes.length === 0) return null;
    const memberIds = new Set<string>();
    for (const n of nodes) for (const m of subtreeIds(n)) memberIds.add(m);
    return { id, categoryIds: nodes.map((n) => n.id), memberIds };
  };
  return [
    { id: 'all' as const, categoryIds: [], memberIds: new Set<string>() },
    chip('printers', ['printers']),
    chip('filament', ['filament']),
    chip('resin', ['resin']),
    chip('accessories', ['parts', 'accessories']),
  ].filter((c): c is LatestChip => c !== null);
}

// ------------------------------------------------------------- editorial

export interface EditorialCard {
  key: string;
  image: string;
  /** Owner-authored copy wins; otherwise the component's own default copy. */
  title: string | null;
  subtitle: string | null;
  cta: string | null;
  to: string;
  /** Which default copy to use when the owner wrote none. */
  preset: 'multicolor' | 'materials' | 'owner';
  /** True when `image` is a borrowed catalogue photograph (see isProductPhoto). */
  productPhoto: boolean;
  /** The borrowed product's light-theme main image (0138), else ''. */
  lightImage: string;
}

/** The owner's editable slot for the two editorial banners (AdminHomeSettings). */
export const EDITORIAL_SLOT = 'editorial_banners';

const MULTICOLOR = /\b(AMS|combo|multi[- ]?colou?r)\b/i;

/**
 * The two editorial banners.
 *
 * 1. WHAT THE OWNER AUTHORED in the admin's «البانرات التحريرية» slot — image,
 *    copy in their own words and a link — up to two, in their order.
 * 2. Otherwise the two banners of the spec, each with a picture that exists:
 *    the owner's light/dark pair for that banner (`ownerPhoto`, targets
 *    `editorial-multicolor` / `editorial-materials`), else the older single
 *    site-media image (`banner-1`, `banner-2`), else a real product
 *    photograph from the section the banner opens — a
 *    multi-material machine (AMS / Combo) for «اطبع بأكثر من لون», a
 *    materials product for «مواد الطباعة». A default banner with no real
 *    picture and no real destination is not drawn.
 */
export function resolveEditorial(input: {
  ownerBanners: readonly HomeBanner[] | undefined;
  lang: string;
  pickText: (t: HomeBanner['title'], lang: string) => string;
  siteMedia: readonly SiteMediaEntry[];
  tree: readonly HomeTaxon[];
  pool: readonly ApiProduct[];
  avoid: ReadonlySet<string>;
}): EditorialCard[] {
  const owner = (input.ownerBanners ?? []).filter((b) => b.image).slice(0, 2);
  if (owner.length > 0) {
    return owner.map((b) => ({
      key: b.id,
      image: b.image,
      title: input.pickText(b.title, input.lang) || null,
      subtitle: input.pickText(b.subtitle, input.lang) || null,
      cta: input.pickText(b.cta, input.lang) || null,
      to: b.link || '',
      preset: 'owner' as const,
      productPhoto: false,
      lightImage: '',
    }));
  }

  const legacy = (slot: string) => input.siteMedia.find((m) => m.group === 'banner' && m.slot === slot)?.url || '';
  const uploaded = (target: string, slot: string) => {
    const pair = ownerPhoto(input.siteMedia, target);
    if (pair) return pair;
    const one = legacy(slot);
    return one ? { image: one, lightImage: '' } : null;
  };
  const avoid = new Set(input.avoid);
  const cards: EditorialCard[] = [];

  const printers = findCategory(input.tree, BENTO_MATCHERS.printers);
  if (printers) {
    const own = uploaded('editorial-multicolor', 'banner-1');
    let light = own?.lightImage ?? '';
    const photo =
      own?.image ||
      (() => {
        const ids = subtreeIds(printers);
        const multi = (x: ApiProduct) => MULTICOLOR.test(x.name);
        // A different photograph from the bento's when the shop has one; the
        // same one rather than none when it does not.
        const p = representative(input.pool, ids, avoid, multi) ?? representative(input.pool, ids, new Set(), multi);
        if (p) avoid.add(p.id);
        light = lightOf(p);
        return p ? productPrimaryImage(p) : '';
      })();
    if (photo) {
      cards.push({
        key: 'multicolor',
        image: photo,
        lightImage: light,
        title: null,
        subtitle: null,
        cta: null,
        to: categoryHref(input.tree, printers),
        preset: 'multicolor',
        productPhoto: !own,
      });
    }
  }

  const materials = findCategory(input.tree, MATERIALS_MATCHER) ?? findCategory(input.tree, BENTO_MATCHERS.filament);
  if (materials) {
    const own = uploaded('editorial-materials', 'banner-2');
    let light = own?.lightImage ?? '';
    const photo =
      own?.image ||
      (() => {
        const ids = subtreeIds(materials);
        const p = representative(input.pool, ids, avoid) ?? representative(input.pool, ids);
        light = lightOf(p);
        return p ? productPrimaryImage(p) : '';
      })();
    if (photo) {
      cards.push({
        key: 'materials',
        image: photo,
        lightImage: light,
        title: null,
        subtitle: null,
        cta: null,
        to: categoryHref(input.tree, materials),
        preset: 'materials',
        productPhoto: !own,
      });
    }
  }
  return cards;
}

// ------------------------------------------------------------- the hero

export interface HeroVisual {
  /** The dark-theme picture (also the light one when `lightImage` is ''). */
  image: string;
  lightImage: string;
  /** True for a borrowed catalogue photograph (cropped to its middle band). */
  productPhoto: boolean;
  /** Where tapping the visual goes: the product, or '' for the owner's picture. */
  to: string;
  /** The product's name, as the picture's accessible label; '' for the owner's. */
  alt: string;
}

/**
 * The picture on the far side of the brand hero (owner, 2026-09-26: «يبدو كله
 * على اليمين» — the left half was empty). The admin's light/dark pair
 * (target `hero`) first; otherwise a real printer the shop sells — a featured
 * one if there is one, one that can be bought now before one that cannot.
 * Null when there is neither: the hero then keeps its text-only composition.
 */
export function resolveHeroVisual(input: {
  siteMedia: readonly SiteMediaEntry[];
  tree: readonly HomeTaxon[];
  pool: readonly ApiProduct[];
}): HeroVisual | null {
  const own = ownerPhoto(input.siteMedia, 'hero');
  if (own) return { ...own, productPhoto: false, to: '', alt: '' };
  const printers = findCategory(input.tree, BENTO_MATCHERS.printers);
  if (!printers) return null;
  const featured = (p: ApiProduct) => Boolean(p.is_featured);
  const p = representative(input.pool, subtreeIds(printers), new Set(), featured);
  if (!p) return null;
  return {
    image: productPrimaryImage(p),
    lightImage: lightOf(p),
    productPhoto: true,
    to: `/product/${encodeURIComponent(p.slug || p.id)}`,
    alt: p.name,
  };
}
