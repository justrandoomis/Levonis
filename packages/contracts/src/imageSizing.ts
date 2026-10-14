/**
 * ONE LIST OF PICTURE SIZES, FOR THE SERVER AND EVERY PAGE (owner 2026-10-13:
 * «أريد تحويل الصور كلها وضغطها بتكون بحجم صغير وليس بحجمها الأصلي الكبير»).
 *
 * `GET /files/<key>?w=<width>` (worker/routes/uploads.ts) answers a public
 * still picture at exactly one of these widths, made once by the `IMAGES`
 * binding and then kept in R2 (worker/lib/imageVariants.ts). Every page asks
 * for them through `variantSrcSet` below — `ui/SafeImage`, `ui/VariantImg`,
 * the storefront's `storeImgProps`, `CropPhoto`, `PromoPhoto` and the document
 * preloads (worker/lib/socialPreview.ts) — so the browser downloads the
 * smallest copy that covers the box it draws, instead of the stored original.
 *
 * EIGHT WIDTHS, NOT A FREE PARAMETER. Each width × format is one stored copy
 * and one edge-cache entry; an open `?w=` would let a single visitor mint a
 * thousand of both. This file is the only place the list is written
 * (tests/imageVariants.test.ts fails if another file declares one):
 *   160  a 36–64 CSS px thumbnail at DPR 2, an avatar, a logo;
 *   320  a card in a 2–3 column phone grid at DPR 1–2;
 *   480  a wider phone card at DPR 2;
 *   640  the same card at DPR 3, a desktop product picture of ~550 px;
 *   800  a 230–270 CSS px banner at DPR 3, a 700 px desktop tile;
 *   1080 a full-width phone picture at DPR 3;
 *   1280 a phone hero at DPR 3+, a desktop hero;
 *   1600 a wide desktop hero.
 * A copy is never wider than its original (`fit: scale-down`).
 *
 * Pure: no imports, so the storefront (tests/storefrontBlocks.test.ts), the
 * entry chunk and the Worker can all carry it.
 */
export const IMAGE_VARIANT_WIDTHS = [160, 320, 480, 640, 800, 1080, 1280, 1600] as const;
export type ImageVariantWidth = (typeof IMAGE_VARIANT_WIDTHS)[number];

/**
 * A `/files/` still picture with no query of its own — the only source a copy
 * can be cut from. Same-origin relative (`/files/…`) or the absolute form older
 * catalogue rows carry. GIF (one frame would be kept), video, SVG, a data URI,
 * a blob preview and anybody else's URL never match.
 */
export const VARIANT_SOURCE = /^(?:https?:\/\/[^/?#]+)?\/files\/([^?#]+\.(?:webp|jpe?g|png))$/i;

/**
 * THE KEYS ANYONE MAY READ — the client's copy of worker/lib/mediaStorage.ts
 * `isAnonymousPublicMediaKey` (tests/imageVariants.test.ts holds the two to
 * the same answers). The server cuts copies of PUBLIC pictures only and
 * answers `?w=` on any other key with a 400, so a srcset on a chat photo, a
 * receipt or a review's evidence would break the picture: those keep their
 * one address, read after the per-request access check. Exact prefixes, except
 * the brand folder, which is case-insensitive there too.
 */
const PUBLIC_MEDIA_KEY = /^(?:products|avatars|community|link-cards|brands|services|users\/[^/]+\/(?:avatar|public-avatars|posts)|merchants\/[^/]+\/(?:public|logos|covers)|[Uu][Ii](?:[Uu][Xx])?)\//;

/** A key anyone may read (never the copy store's own `variants/`, which no public prefix matches). */
export function isPublicVariantKey(key: string): boolean {
  return PUBLIC_MEDIA_KEY.test(key);
}

export function isVariantSource(src: unknown): src is string {
  const match = typeof src === 'string' ? VARIANT_SOURCE.exec(src) : null;
  return !!match && PUBLIC_MEDIA_KEY.test(match[1]);
}

export interface VariantSrcSetOptions {
  /** The stored original's width when the caller knows it (media JSON). */
  width?: number | null;
  /** The widest copy this context may ask for (the home hero keeps 1080). */
  max?: number;
}

/**
 * The `srcset` of the server's copies of `src`, or undefined when `src` is not
 * a picture the server can resize (it is then used exactly as it is).
 *
 * With the original's width known, the list stops at the first rung at or
 * above it and that rung's descriptor is the TRUE width — `?w=1280` of a
 * 1254 px photo is a 1254 px file, so it says `1254w` — and an original wider
 * than the top rung is offered itself, at its own width, as the last
 * candidate. `max` caps a context: no candidate above it.
 */
export function variantSrcSet(src: string, options: VariantSrcSetOptions = {}): string | undefined {
  if (!isVariantSource(src)) return undefined;
  const width = Number(options.width) > 0 ? Math.round(Number(options.width)) : 0;
  const max = Number(options.max) > 0 ? Number(options.max) : Infinity;
  const out: string[] = [];
  for (const rung of IMAGE_VARIANT_WIDTHS) {
    if (rung > max && out.length) break;
    const last = (width > 0 && rung >= width) || rung >= max;
    out.push(`${src}?w=${rung} ${width > 0 && rung >= width ? width : rung}w`);
    if (last) return out.join(', ');
  }
  // An original wider than the top rung is its own last candidate.
  if (width > IMAGE_VARIANT_WIDTHS[IMAGE_VARIANT_WIDTHS.length - 1] && width <= max) out.push(`${src} ${width}w`);
  return out.join(', ');
}

/**
 * The store home's hero cover (storefront/blocks/Hero.tsx) and a store product
 * page's lead picture (catalog/ProductGallery.tsx, a `max-w-2xl` page), each
 * shared with its document preload (worker/lib/socialPreview.ts
 * `storeImagePreload`). Here rather than with the other presets
 * (packages/contracts/src/imageSizes.ts) because a store visit already holds
 * this module and must not download the other one for two strings.
 *
 * The hero is cropped to fill its box, and on a phone that box is far less
 * wide than a cover photograph (390 × 240 for the cover hero, 1.6:1): a
 * 2.4:1 cover is drawn at 1.5 × the screen's width, so a phone asks for that
 * (the verification of DECISIONS row 226 measured 0.74 image pixels per
 * screen pixel at `100vw`).
 */
export const STORE_HERO_SIZES = '(max-width: 639px) 150vw, 100vw';
export const STORE_GALLERY_SIZES = '(min-width: 672px) 672px, 100vw';
