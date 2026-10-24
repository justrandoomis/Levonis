/**
 * THE PICTURE A PRODUCT PAGE OPENS ON, IN EACH THEME — WHEN IT IS CERTAIN
 * (speed audit 2026-10-16, «the product's main photo is not preloaded on 25
 * of 26 live product pages»).
 *
 * The product document preloads the page's lead picture so it downloads with
 * the code instead of after the first render (−0.3 to −0.9 s of phone LCP,
 * measured on the live site). A WRONG preload is a second full download, so it
 * is written only when the opening picture is certain, in both themes:
 *
 *   dark   the lead of the opening gallery, at its stored size;
 *   light  Product.tsx shows the light-theme main image (`light_image`, 0138)
 *          in the primary's slot, at its own stored size when the answer
 *          carries one, else at the primary's (`lightMainImageSize`, before
 *          anything is measured) — the document preloads both, each under its
 *          own `media` query (`themeMedia`), the same bytes for every visitor.
 *
 * Ordinary arrivals leave options and colours empty, including stocked SKUs,
 * imported defaults and single-value groups (owner 2026-10-25). Only an
 * explicit selection link may change the opening picture.
 *
 * The answer is computed from the very body the page will read — the
 * anonymous `/api/products/<slug>` copy this colo holds (edgePolicy.ts
 * `peekAnonymousCopy`) — so the inputs are the page's own. The rule is
 * Product.tsx's, pinned to its source by tests/productLeadPreload.test.ts and
 * run against the page's own gallery functions on the live fixtures there.
 */

export interface LeadPicture {
  url: string;
  width: number | null;
  height: number | null;
}

/** The opening lead in each theme. `light` is null when the product has no light-theme main image. */
export interface OpeningLead {
  dark: LeadPicture;
  light: LeadPicture | null;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const size = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** The query parameters that restore a selection on the product page (Product.tsx's deep links). */
export const SELECTION_PARAMS = ['price_request', 'alert', 'v'] as const;

/** src/lib/productGallery.ts `mediaInStoredOrder` + `dedupeByUrl`, then the first: the lead of an empty selection. */
function storedLead(product: Rec): LeadPicture | null {
  const media = list(product.media).filter((m) => text(m.url) !== '');
  const rows = media.length
    ? media
    : (Array.isArray(product.images) ? product.images : []).filter((u): u is string => typeof u === 'string' && u !== '').map((url, i) => ({ url, order: i }) as Rec);
  const ordered = rows
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (!!b.item.primary !== !!a.item.primary) return b.item.primary ? 1 : -1;
      return (Number(a.item.order ?? 0) || 0) - (Number(b.item.order ?? 0) || 0) || a.index - b.index;
    });
  const first = ordered[0]?.item;
  return first ? { url: text(first.url), width: size(first.width), height: size(first.height) } : null;
}

/**
 * The lead in each theme when the page's opening selection is provably empty;
 * null when it is not (or the body is not a product detail answer).
 */
export function openingLeadFromDetail(detail: unknown, search = ''): OpeningLead | null {
  if (!isRec(detail) || detail.success === false || !isRec(detail.product)) return null;
  const query = new URLSearchParams(search);
  if (SELECTION_PARAMS.some((p) => query.has(p))) return null;
  const product = detail.product;
  // The selection is empty: the stored order, the primary first.
  const dark = storedLead(product);
  if (!dark || !dark.url) return null;
  const light = text(product.light_image).trim();
  return { dark, light: light ? { url: light, ...lightLeadSize(dark, product) } : null };
}

/**
 * src/lib/productGallery.ts `lightMainImageSize` on the page's first render
 * (no shape measured yet): the light file's own stored size when the answer
 * carries both numbers, else the primary's — so the preload asks for the rung
 * the page's `sizes` and srcset will ask for.
 */
function lightLeadSize(primary: LeadPicture, product: Rec): { width: number | null; height: number | null } {
  const ownW = size(product.light_image_width);
  const ownH = size(product.light_image_height);
  if (ownW && ownH) return { width: ownW, height: ownH };
  return primary.width && primary.height ? { width: primary.width, height: primary.height } : { width: null, height: null };
}
