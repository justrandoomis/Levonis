/**
 * WHAT A PRODUCT LINK LOOKS LIKE WHEN IT IS PASTED INTO A CHAT.
 *
 * ---------------------------------------------------------------------------
 * The problem
 * ---------------------------------------------------------------------------
 * A customer taps "share" on a product, pastes the link into Instagram,
 * Telegram, WhatsApp or Messenger, and the card that unfurls shows the SHOP —
 * the shop's logo, the shop's one-line description — for every product in the
 * catalogue. The owner's words for it:
 *
 *   «عندما يشارك مستخدم المنتج من الرابط المعاينة يجب أن تفتح صورة المنتج
 *    وليس صورة الموقع والوصف يكون وصف المنتج بشكل قصير وليس وصف الموقع»
 *
 * The cause is structural, not a missing tag. Levonis is a single-page app:
 * `/product/<slug>` is served the SAME `index.html` as every other route, and
 * the product's name, picture and description are written into the document by
 * React after it boots. A social crawler does not boot React. It reads the
 * bytes it is given and leaves. Whatever is in the shipped `index.html` is the
 * only thing it will ever see — so every product shared the shop's own card.
 *
 * ---------------------------------------------------------------------------
 * The fix
 * ---------------------------------------------------------------------------
 * The document is rewritten at the edge, before it is sent, for the handful of
 * paths that name a product. `index.html` keeps the SHOP's card as its
 * defaults (a share of the front page should still say LEVONIS); this module
 * overwrites the four tags that identify the thing being shared — title,
 * description, image, url — with the product's own.
 *
 * WHY A STRING REWRITE AND NOT `HTMLRewriter`. HTMLRewriter is the idiomatic
 * Workers tool and it streams, which is the right shape for a large document.
 * This document is the app shell — a few kilobytes, fully buffered by the
 * asset layer already — and HTMLRewriter is absent from the `node --test`
 * runtime the rest of this repository is verified in. The same trade-off, for
 * the same reason, as `pageImages.ts`. Everything here is a pure function over
 * a string, so the tags a crawler will read are asserted directly in tests
 * rather than inferred from a mock of a runtime API.
 *
 * ---------------------------------------------------------------------------
 * What is NOT here
 * ---------------------------------------------------------------------------
 * No price. A card is cached by the chat app for days; Telegram and WhatsApp
 * will keep serving the first one they fetched long after the shop has changed
 * the number. A stale price in a shared card is worse than no price, so the
 * card carries only what stays true: the name, the picture, and the shop's own
 * description of the item.
 *
 * No invented text either. A product with an empty description keeps the
 * shop's default line rather than getting a sentence written for it here.
 */
import { canonicalProductMediaUrl, primaryMedia, upgradeMedia } from './productModel';
import { isAnonymousPublicMediaKey } from './mediaStorage';
import { productImageFromRelations } from './productSelectionImage';
import { isActiveProductImageRow, type ImageRow } from './productOverlay';
import { logoSourceKey, readStoreIconsQuietly, servableStoreIcons } from './storeIcons';
import { cleanIdentityText, storeDescription } from './webManifest';
import { DOCUMENT_CACHE_CONTROL } from './securityPolicy';
import { IMAGE_VARIANT_WIDTHS, variantSourceMime } from './imageConvert';
import { PRODUCT_GALLERY_SIZES } from '../../packages/contracts/src/imageSizing';

/** The four things a chat app reads off a link, already absolute and escaped. */
export interface SocialPreview {
  title: string;
  /** '' means "leave the document's own description alone". */
  description: string;
  /** Absolute URL. '' means "leave the document's own image alone". */
  image: string;
  /** Absolute URL of the page itself. */
  url: string;
  /**
   * `og:site_name` — whose site this card is on. Absent keeps the document's
   * «LEVONIS»; on a store's own host the site IS the store (see
   * `resolveStorePreview`).
   */
  siteName?: string;
  /**
   * `twitter:card`. A store card's picture is its square logo, which the
   * shell's `summary_large_image` would crop into a 2:1 banner; `summary`
   * shows it whole. Absent keeps the document's value.
   */
  twitterCard?: 'summary' | 'summary_large_image';
}

/**
 * THE ROUTES THAT NAME A PRODUCT, and nothing else.
 *
 * Every one of these is a real `<Route>` in `src/App.tsx` that renders a
 * product detail page, and each of their slugs resolves through the SAME two
 * tables `GET /api/products/:slug` reads — the catalogue first, then the
 * merchant community. Keeping the list explicit means an unrelated SPA route
 * never pays for a database read on its way to the browser.
 *
 *   /product/<slug>                     the catalogue product page
 *   /bundles/<slug>                     a composition — a real `products` row
 *   /p/<slug>                           a product on a merchant subdomain
 *   /community/store/<store>/p/<slug>   the same product on the main site
 *
 * A referral share needs no entry of its own: `productSupportPath` attaches
 * the supporter's handle as `?ref=`, which leaves the PATH untouched. That is
 * what keeps the existing referral link working through this — the crawler
 * fetches the same path, gets the product's card, and the visitor who taps it
 * still arrives carrying the handle.
 */
const PRODUCT_PATHS: readonly RegExp[] = [
  /^\/product\/([^/]+)\/?$/,
  /^\/bundles\/([^/]+)\/?$/,
  /^\/p\/([^/]+)\/?$/,
  /^\/community\/store\/[^/]+\/p\/([^/]+)\/?$/,
];

/**
 * The product slug this document request is asking for, or null when the path
 * is not a product page.
 *
 * A slug containing a dot is refused. Not for safety — the value only ever
 * reaches a bound parameter — but because `/p/favicon.ico` is a request for a
 * FILE that fell through to the SPA, and spending a database read on it on the
 * way to a 200-with-app-shell is pure waste on exactly the requests that come
 * in bursts.
 */
export function productSlugFromPath(path: string): string | null {
  for (const pattern of PRODUCT_PATHS) {
    const match = pattern.exec(path);
    if (!match) continue;
    let slug: string;
    try {
      slug = decodeURIComponent(match[1]);
    } catch {
      return null; // malformed percent-encoding — not a slug we can look up
    }
    if (!slug || slug.length > 160 || slug.includes('.')) return null;
    return slug;
  }
  return null;
}

/**
 * A product's own description, cut to something a chat card will actually
 * show.
 *
 * Telegram renders roughly 160 characters and WhatsApp fewer; past that the
 * text is cut mid-word by whoever is rendering it. Cutting here means the cut
 * lands on a word boundary and ends in an ellipsis that says there is more,
 * instead of stopping mid-syllable — which in Arabic can leave a word that
 * reads as a different word.
 *
 * Markup is stripped rather than escaped away: descriptions are entered by the
 * shop and some carry HTML from a vendor page import. A crawler shows the
 * attribute verbatim, so a stray `<br>` would be visible text in the card.
 */
export function shortDescription(raw: unknown, limit = 160): string {
  const text = String(raw ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  // A single word longer than the limit has no boundary to fall back to; a
  // boundary in the first quarter of the text is not worth honouring either.
  const body = lastSpace > limit * 0.4 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * The image a crawler can actually FETCH, made absolute.
 *
 * A crawler arrives with no cookie and no session. `/files/<key>` is only
 * anonymously readable for the public prefixes — a product photo is
 * `products/…`, which is public, but an admin could have pasted any URL into
 * the gallery. A key outside the public set would answer the crawler with 403
 * and the card would fall back to showing nothing at all, so anything this
 * function is not sure of returns '' and the shop's own logo stays.
 *
 * Remote addresses are never passed through. Product imagery is an object the
 * shop owns and verifies in R2, not permission to make every crawler hotlink a
 * vendor. Returning '' keeps the shop's own default card image.
 */
export function absoluteImageUrl(url: unknown, origin: string): string {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('/files/')) {
    const key = raw.slice('/files/'.length).split('?')[0];
    if (!isAnonymousPublicMediaKey(key)) return '';
    return `${origin}${raw}`;
  }
  // Relative to the app but not a media route, remote http(s), data:, or
  // anything else a crawler may refuse: keep the shop card instead.
  return '';
}

/** HTML attribute escaping. `&` first, or the later replacements re-escape it. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Replace a meta tag's whole element, or add one before `</head>` when the
 * document does not carry it.
 *
 * `[^>]*` is what makes this safe against the shell's formatting: the tags in
 * `index.html` are wrapped across three lines by the formatter, and a class
 * that excludes `>` spans newlines while still stopping at the end of the tag
 * it matched.
 */
function setMeta(html: string, attr: 'property' | 'name', key: string, value: string): string {
  const tag = `<meta ${attr}="${key}" content="${escapeAttribute(value)}" />`;
  const existing = new RegExp(`<meta\\s+${attr}="${key}"[^>]*>`, 'i');
  // A FUNCTION replacement, never a string: in a replacement string `$&`,
  // `$\``, `$'` and `$$` are commands, so a store name or an og:url query
  // carrying one spliced raw document text into the attribute and broke out
  // of the escaping above (security review of 644e3ea, H1).
  if (existing.test(html)) return html.replace(existing, () => tag);
  return html.replace(/<\/head>/i, () => `  ${tag}\n  </head>`);
}

/**
 * Write a product's identity into the shipped app shell.
 *
 * Only the tags that IDENTIFY the shared thing are touched. `og:site_name`,
 * `og:type`, `og:locale`, the icons, the font links and the anti-flash style
 * are the shop's and are left exactly as they are — which is why the card
 * still reads "LEVONIS" above the product's name in Telegram.
 *
 * `<title>` is rewritten alongside them because a crawler that understands no
 * Open Graph at all (several link scanners, and every plain RSS-style reader)
 * falls back to it, and because it is what the browser tab says for the second
 * before React takes over.
 */
export function injectSocialPreview(html: string, preview: SocialPreview): string {
  let out = html;
  if (preview.title) {
    out = out.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeAttribute(preview.title)}</title>`);
    out = setMeta(out, 'property', 'og:title', preview.title);
    out = setMeta(out, 'name', 'twitter:title', preview.title);
  }
  if (preview.description) {
    /**
     * `name="description"` IS NOT AN OPEN GRAPH TAG, AND IT IS THE ONE SEARCH
     * ENGINES READ.
     *
     * The three lines below used to be two. Open Graph is what a CHAT CARD
     * unfurls from — Telegram, WhatsApp, Instagram — and every one of the
     * shop's product pages had it. What none of them had was the ordinary
     * meta description, because `index.html` carried no such tag for this
     * function to rewrite: PageSpeed's SEO section reports «Document does not
     * have a meta description», and Google writes the search snippet from
     * whatever scrap of the page it can find instead of from the product's
     * own words.
     *
     * `setMeta` adds a tag the document does not have, so this works for both
     * the shell's new default and any older cached copy without it.
     */
    out = setMeta(out, 'name', 'description', preview.description);
    out = setMeta(out, 'property', 'og:description', preview.description);
    out = setMeta(out, 'name', 'twitter:description', preview.description);
  }
  if (preview.image) {
    out = setMeta(out, 'property', 'og:image', preview.image);
    out = setMeta(out, 'name', 'twitter:image', preview.image);
  }
  if (preview.url) out = setMeta(out, 'property', 'og:url', preview.url);
  if (preview.siteName) out = setMeta(out, 'property', 'og:site_name', preview.siteName);
  if (preview.twitterCard) out = setMeta(out, 'name', 'twitter:card', preview.twitterCard);
  return out;
}

/** The two shapes a slug can resolve to. Only the columns the card needs. */
interface PreviewRow {
  id?: unknown;
  name?: unknown;
  name_ar?: unknown;
  name_en?: unknown;
  description?: unknown;
  description_ar?: unknown;
  description_en?: unknown;
  images?: unknown;
  light_image?: unknown;
}

/** Internal document metadata; never written into social tags or public JSON. */
interface ProductPreview extends Pick<SocialPreview, 'title' | 'description' | 'image'> {
  /** null explicitly suppresses a speculative catalogue preload; absent preserves merchant behaviour. */
  preloadImage?: string | null;
}

/** Arabic first — the store's own default language — then English, then any. */
function pickText(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const text = String(candidate ?? '').trim();
    if (text) return text;
  }
  return '';
}

/**
 * Build one product's card from the database.
 *
 * TWO TABLES, IN THE SAME ORDER `GET /api/products/:slug` READS THEM. The
 * catalogue owns most slugs; a merchant's own product lives in
 * `community_products` and shares the same detail page. Matching that order
 * here is what keeps the card and the page agreeing about which product a slug
 * means — a second, differently-ordered lookup would eventually show one
 * product's picture above another product's page.
 *
 * ONE PRIMARY IMAGE RULE. `primaryMedia(upgradeMedia(images))` is the same
 * resolver the product page, the cards, the cart and the order snapshot use.
 * The card cannot drift from the page it links to, because neither of them
 * picks its own lead image.
 *
 * Returns null when the slug is unknown or the row is not published — a draft
 * or hidden product must not leak its name and picture to anyone who guesses a
 * URL, and the page it links to would 404 anyway.
 */
export async function resolveProductPreview(
  db: D1Database,
  slug: string,
  origin: string,
  /**
   * WHICH STORE THIS CARD MAY COME FROM (audit 01 B15). On a merchant host the
   * host's own slug; on `/community/store/<ref>/p/<slug>` the ref (slug, store
   * id or merchant id — the page accepts all three). With a scope, only that
   * store's published product is a card: `/p/<any slug>` on ali3d's host used
   * to unfurl ANY merchant's product, or a catalogue product, under ali3d's
   * address. A sanctioned store (suspended, or its merchant suspended) gives
   * no card at all — its page is «المتجر غير متاح حاليًا».
   */
  scope: { storeSlug?: string | null; storeRef?: string | null } = {}
): Promise<ProductPreview | null> {
  const storeKey = scope.storeSlug || scope.storeRef || '';
  if (storeKey) {
    const scoped = await db
      .prepare(
        `SELECT p.name, p.name_ar, p.description, p.description_ar, p.images
           FROM community_products p
           JOIN merchant_stores s ON s.id = p.store_id
           JOIN community_merchants m ON m.id = s.merchant_id
          WHERE p.slug = ?1 AND p.status = 'active' AND p.lifecycle = 'active'
            AND (s.slug = ?2 OR (?3 = 1 AND (s.id = ?2 OR s.merchant_id = ?2)))
            AND s.status <> 'suspended' AND m.status <> 'suspended'`
      )
      .bind(slug, storeKey, scope.storeSlug ? 0 : 1)
      .first<PreviewRow>();
    return scoped ? previewFrom(scoped, null, origin, db) : null;
  }
  // `products` has `name`/`name_ar`/`name_ku` and no `_en` columns (0001):
  // naming `name_en` here made SQLite refuse the whole read, the caller's
  // catch served the shop's card, and no catalogue product ever unfurled as
  // itself — invisible to the fake-database tests, caught by a real one
  // (tests/storeShareCards.test.ts).
  const product = await db
    .prepare(
      "SELECT id, name, name_ar, description, description_ar, light_image FROM products WHERE slug = ? AND status = 'active'"
    )
    .bind(slug)
    .first<PreviewRow>();
  const row = product ??
    (await db
      .prepare(
        `SELECT p.name, p.name_ar, p.description, p.description_ar, p.images
           FROM community_products p
           JOIN community_merchants m ON m.id = p.merchant_id
           LEFT JOIN merchant_stores s ON s.id = p.store_id
          WHERE p.slug = ? AND p.status = 'active'
            AND m.status <> 'suspended' AND COALESCE(s.status, '') <> 'suspended'`
      )
      .bind(slug)
      .first<PreviewRow>());
  if (!row) return null;
  return previewFrom(row, product, origin, db);
}

/** The card for a row found above: title, trimmed description, lead image. */
async function previewFrom(
  row: PreviewRow,
  product: PreviewRow | null,
  origin: string,
  db: D1Database
): Promise<ProductPreview | null> {
  const title = pickText(row.name_ar, row.name, row.name_en);
  if (!title) return null; // nothing to identify it by; keep the shop's card

  let images: ImageRow[] = [];
  if (product) {
    try {
      // The same single authoritative read as the card already needed. No
      // inventory/pricing read or visitor-dependent choice in shareable HTML.
      const { results } = await db.prepare(
        'SELECT * FROM product_images WHERE product_id IN (?) ORDER BY product_id, sort_order, id'
      ).bind(String(product.id ?? '')).all<ImageRow>();
      images = (results ?? []).filter(isActiveProductImageRow);
    } catch (error) {
      // Authority unavailable must not resurrect the stale products.images.
      console.error(`product image authority unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const image = product
    ? productImageFromRelations(images)
    : primaryMedia(upgradeMedia(row.images))?.url ?? '';
  const lightImage = product ? canonicalProductMediaUrl(product.light_image) : '';
  // Product may open on a shelf-backed option/colour/variant instead of the
  // primary. Its saved theme also lives only in this browser, so a system
  // media query cannot choose the light override reliably. Preload only when
  // every possible opening selection/theme must use this same image. False
  // negatives cost a head start; a wrong preload costs a second full request.
  const selectionCanChangeImage = new Set(images.map((entry) => entry.url)).size > 1 &&
    images.some((entry) => entry.option_value_id || entry.color_id || entry.variant_id);
  const preloadImage = image && !selectionCanChangeImage && (!lightImage || lightImage === image)
    ? image
    : null;

  return {
    title,
    description: shortDescription(pickText(row.description_ar, row.description, row.description_en)),
    image: absoluteImageUrl(image, origin),
    ...(product ? { preloadImage } : {}),
  };
}

/**
 * The store a `/community/store/<ref>/p/<slug>` path names — its slug, store
 * id or merchant id — so that card is scoped like the page it links to. Null
 * for every other product path.
 */
export function previewStoreRef(path: string): string | null {
  const m = /^\/community\/store\/([^/]+)\/p\/[^/]+\/?$/.exec(path);
  if (!m) return null;
  try {
    const ref = decodeURIComponent(m[1]);
    return ref && ref.length <= 64 ? ref : null;
  } catch {
    return null;
  }
}

// ===========================================================================
//  THE STORE'S OWN CARD — decision 11: «every merchant has an independent
//  store — identity, subdomain, PWA» (docs/MERCHANT_PLATFORM.md §2, §4.5)
// ===========================================================================

/**
 * The store a `/community/store/<ref>` path names — the store's own page on
 * the main site (`CommunityStorePage`, which accepts a slug, a store id or a
 * merchant id) — or null. Only the page itself: `/community/store/<ref>/p/…`
 * is a product and is `previewStoreRef`'s.
 */
export function storeHomeRef(path: string): string | null {
  const m = /^\/community\/store\/([^/]+)\/?$/.exec(path);
  if (!m) return null;
  try {
    const ref = decodeURIComponent(m[1]);
    return ref && ref.length <= 64 && !ref.includes('.') ? ref : null;
  } catch {
    return null;
  }
}

/** A store's own card: what its home unfurls as, and the frame of its products' cards. */
export type StoreCard = Required<Pick<SocialPreview, 'title' | 'description' | 'image' | 'siteName' | 'twitterCard'>>;

interface StoreCardRow {
  id: string;
  name: unknown;
  tagline: unknown;
  description: unknown;
  logo_key: string | null;
  accent: string | null;
}

/**
 * A STORE LINK UNFURLS AS THE STORE.
 *
 * Before this, `https://ali3d.levonis-iq.com/` — the link a merchant shares
 * more than any other, and the one the share kit hands them — unfurled in
 * every chat as LEVONIS, with the platform's logo and the platform's
 * description of itself, because the shell's defaults were all a crawler ever
 * read on a store's home.
 *
 *   title        the store's name (cleaned like the manifest's: no bidi
 *                overrides, no zero-width characters, a whole character cut);
 *   description  its tagline, else its own description cut for a card, else
 *                the manifest's sentence «متجر X على منصة Levonis» — never the
 *                platform's description of the PLATFORM;
 *   image        its 512 px app-icon rendition when that is cut for the
 *                current logo (a PNG every crawler decodes), else the logo
 *                itself when a crawler may fetch it, else the shell's own
 *                image — the platform mark only as a true fallback;
 *   site name    the store: on its own host, the site IS the store.
 *
 * Scoped exactly like `resolveProductPreview`: a store HOST by slug only; the
 * main site's `/community/store/<ref>` by slug, store id or merchant id. A
 * sanctioned store (suspended, or its merchant suspended) gives NO card —
 * its page is «المتجر غير متاح حاليًا», and its name or logo may be what it
 * was suspended for. A paused store still does: that is the merchant's own
 * switch, and its page still renders under its own name.
 */
export async function resolveStorePreview(
  db: D1Database,
  origin: string,
  scope: { storeSlug?: string | null; storeRef?: string | null }
): Promise<StoreCard | null> {
  const storeKey = scope.storeSlug || scope.storeRef || '';
  if (!storeKey) return null;
  const store = await db
    .prepare(
      `SELECT s.id, s.name, s.tagline, s.description, s.logo_key, s.accent
         FROM merchant_stores s
         JOIN community_merchants m ON m.id = s.merchant_id
        WHERE (s.slug = ?1 OR (?2 = 1 AND (s.id = ?1 OR s.merchant_id = ?1)))
          AND s.status <> 'suspended' AND m.status <> 'suspended'
        LIMIT 1`
    )
    .bind(storeKey, scope.storeSlug ? 0 : 1)
    .first<StoreCardRow>();
  if (!store) return null;

  const title = cleanIdentityText(store.name, 60);
  if (!title) return null;
  const description =
    cleanIdentityText(store.tagline, 200) ||
    shortDescription(cleanIdentityText(store.description, 4000)) ||
    storeDescription(title);

  // The rendition, read quietly: before migration 0123 reaches the database
  // (or on any read failure) the card simply uses the logo.
  const icons = servableStoreIcons(store, await readStoreIconsQuietly(db, store.id));
  const logo = logoSourceKey(store.logo_key);
  const image = icons
    ? absoluteImageUrl(`/files/${icons.keys.icon512}`, origin)
    : logo
      ? absoluteImageUrl(`/files/${logo}`, origin)
      : '';

  return { title, description, image, siteName: title, twitterCard: 'summary' };
}

/**
 * A PRODUCT CARD ON A STORE'S HOST IS FRAMED BY THE STORE.
 *
 * The product keeps its own title, picture and description — that is what
 * the owner asked of product links. What changes on a store's host is the
 * frame: `og:site_name` names the store rather than LEVONIS, and where the
 * product has no description or no picture of its own the card falls back to
 * the STORE's line and logo, not the platform's — the rule «keep the shop's
 * default» applied to the shop the link is actually on.
 */
export function framedByStore(
  product: Pick<SocialPreview, 'title' | 'description' | 'image'>,
  store: StoreCard | null
): Pick<SocialPreview, 'title' | 'description' | 'image' | 'siteName'> {
  if (!store) return product;
  return {
    title: product.title,
    description: product.description || store.description,
    image: product.image || store.image,
    siteName: store.siteName,
  };
}

// ===========================================================================
//  THE DOCUMENT'S HEAD START — preloads, the inline resolve answer, and the
//  validators that let a rewritten document be revalidated and shared
//  (docs/MERCHANT_PLATFORM_V2.md §B.1 #3, §B.2 «Cache Rules» / «Early Hints»;
//  measured in docs/PERFORMANCE_LOG.md «P2b»).
// ===========================================================================
//
// The Worker already buffers and rewrites the documents that name a product or
// a store (for the share card above). Once the document is in hand, three more
// things can be written into it that the browser otherwise learns only after
// the whole bundle has been parsed and React has mounted:
//
//   1. WHICH CHUNK THIS ROUTE NEEDS. Every page is a lazy chunk; the browser
//      discovers it when the router renders, one full round trip after the
//      entry ran. `<link rel="modulepreload">` from Vite's manifest names it in
//      the head, so it downloads beside the entry. Vite's own preload helper
//      sees the link and does not add a second one.
//   2. THE PICTURE THE PAGE WILL PAINT LARGEST — the product's lead image, the
//      store's cover — as `<link rel="preload" as="image" fetchpriority="high">`,
//      so the request leaves with the document rather than after the data.
//   3. THE RESOLVE ANSWER. `src/StoreContext.tsx` held every first paint until
//      `GET /api/storefront/resolve` came back. The ANONYMOUS answer is written
//      into the document as a JSON data block (`<script type="application/json"
//      id="lv-resolve">`, never executed, outside the CSP's script allowance)
//      and read synchronously. Only the anonymous answer: the document must
//      stay the same bytes for every visitor, or it could not be shared.
//
// Everything here is a pure function over strings and the manifest, so the
// tests assert the tags directly (tests/documentPreloads.test.ts).

/** One chunk of Vite's `.vite/manifest.json` (`build.manifest = true`). */
export interface ViteManifestChunk {
  file: string;
  src?: string;
  name?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}
export type ViteManifest = Record<string, ViteManifestChunk>;

/** The manifest key of the document's entry, and the path the build ships the manifest at. */
export const MANIFEST_ENTRY = 'index.html';
export const MANIFEST_PATH = '/.vite/manifest.json';
/** The Arabic Cairo subset index.html preloads (P1a) — named again in the Early Hints `Link`. */
export const ARABIC_FONT_PRELOAD = '/fonts/cairo/cairo-v31-arabic.woff2';
/** The id `src/lib/bootFetch.ts` reads. */
export const INLINE_RESOLVE_ID = 'lv-resolve';

/**
 * THE POLICY OF A DOCUMENT THAT IS THE SAME FOR EVERY VISITOR.
 *
 * `max-age=0`: the browser revalidates every navigation (a cheap 304 now that
 * the ETag survives the rewrite). `s-maxage=60`: the edge may hold it a
 * minute — a store's name, cover and card are not a price — which is the
 * Iraqi-PoP answer the plan's «Cache Rules for HTML» row needs (Cloudflare
 * only caches HTML under such a rule; until the owner adds it this header
 * changes nothing at the edge). NO `stale-while-revalidate` (P2 review): the
 * document names content-hashed chunks and inlines the store's resolve, so
 * a colo answering stale while it refreshes could hand out the previous
 * build's chunk names, or a suspended store's name, for ten minutes more.
 * With the plain `s-maxage` the worst case is a minute, and the deploy
 * workflows purge the zone (scripts/purge-zone-cache.mjs) so a deploy is
 * not even that. A document whose rewrite read a session keeps `no-cache` —
 * see `documentCacheControl`.
 */
export const DOCUMENT_SHARED_CACHE_CONTROL = 'public, max-age=0, s-maxage=60';

/**
 * Shared when nothing about the response depends on WHO asked: no session was
 * loaded for the request, no cookie is being set, and every byte written in
 * came from public rows and the anonymous resolve answer. Otherwise the
 * document's ordinary `no-cache` (worker/lib/securityPolicy.ts), which no
 * shared cache stores.
 */
export function documentCacheControl(viewerDependent: boolean): string {
  return viewerDependent ? DOCUMENT_CACHE_CONTROL : DOCUMENT_SHARED_CACHE_CONTROL;
}

/**
 * The page module a document path renders — a key of the manifest — or null
 * for a path whose chunk this file does not know. Mirrors the `<Route>`s in
 * src/App.tsx for exactly the paths `assetWithPreview` rewrites.
 */
export function routeModuleFor(path: string, onStore: boolean): string | null {
  if (onStore) {
    if (path === '/') return 'src/pages/Storefront.tsx';
    if (/^\/p\/[^/]+\/?$/.test(path)) return 'src/pages/StorefrontProduct.tsx';
    return null;
  }
  if (/^\/product\/[^/]+\/?$/.test(path)) return 'src/pages/Product.tsx';
  if (/^\/bundles\/[^/]+\/?$/.test(path)) return 'src/pages/BundleDetail.tsx';
  if (/^\/community\/store\/[^/]+\/p\/[^/]+\/?$/.test(path)) return 'src/pages/StorefrontProduct.tsx';
  if (/^\/community\/store\/[^/]+\/?$/.test(path)) return 'src/pages/CommunityStorePage.tsx';
  return null;
}

/** Every manifest key reachable from `key` through STATIC imports, `key` first. */
function staticClosure(manifest: ViteManifest, key: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [key];
  while (queue.length) {
    const k = queue.shift()!;
    if (seen.has(k) || !manifest[k]) continue;
    seen.add(k);
    order.push(k);
    for (const dep of manifest[k].imports ?? []) if (!seen.has(dep)) queue.push(dep);
  }
  return order;
}

/**
 * What a route's chunk needs that the document does not already load: the
 * chunk itself and the static imports it shares with other lazy pages (the
 * icon chunk, a storefront helper), minus everything in the entry's own
 * closure, which the built index.html already names. The route chunk is
 * always first; the cap is a guard against a runaway graph, not a tuning
 * knob — MEASURED (docs/PERFORMANCE_LOG.md «P2b»): naming the WHOLE closure
 * (12–18 chunks for these pages) beat naming the first eight by ~200–260 ms
 * of LCP on the store home, because the browser otherwise discovers the rest
 * only when the route chunk arrives, one more round trip late; and naming
 * none at all lost ~250 ms against either. The entry's own arrival did not
 * move in any variant (the document lists its files first).
 */
export function chunkPreloads(
  manifest: ViteManifest,
  key: string,
  cap = 24
): { scripts: string[]; styles: string[] } {
  let routeKey = key;
  if (!manifest[routeKey]) {
    // Rollup can emit a dynamic route under a shared-chunk alias (for
    // example `_Product-<hash>.js`) with no src field. Resolve only a unique
    // dynamic entry of that route's name; never guess a static helper or a
    // different source module that happens to share the basename.
    const name = /^src\/pages\/([A-Za-z][\w]*)\.tsx$/.exec(key)?.[1];
    const candidates = name ? Object.entries(manifest).filter(([alias, chunk]) =>
      alias.startsWith('_') && !chunk.src && chunk.isDynamicEntry === true && chunk.name === name
    ) : [];
    if (candidates.length !== 1) return { scripts: [], styles: [] };
    routeKey = candidates[0][0];
  }
  const entry = new Set(staticClosure(manifest, MANIFEST_ENTRY));
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const k of staticClosure(manifest, routeKey)) {
    if (entry.has(k)) continue;
    const chunk = manifest[k];
    if (scripts.length < cap) scripts.push(`/${chunk.file}`);
    for (const css of chunk.css ?? []) if (styles.length < cap && !styles.includes(`/${css}`)) styles.push(`/${css}`);
  }
  return { scripts, styles };
}

/** The entry's stylesheets (`/assets/index-<hash>.css`), for the Early Hints line. */
export function entryStylesheets(manifest: ViteManifest): string[] {
  return (manifest[MANIFEST_ENTRY]?.css ?? []).map((css) => `/${css}`);
}

/**
 * The `Link` header Cloudflare turns into a 103 Early Hints response once the
 * owner switches Early Hints on (plan §B.2): the entry stylesheet and the
 * Arabic font start one round trip before the document body arrives. Only
 * `preload`/`preconnect` are honoured there, so the route chunk stays in the
 * HTML as a modulepreload.
 */
export function earlyHintsLink(styles: string[], font: string | null = ARABIC_FONT_PRELOAD): string {
  // Vite emits crossorigin stylesheets: the hint must use the same fetch mode
  // or Chromium downloads the render-blocking CSS twice.
  const parts = styles.map((href) => `<${href}>; rel=preload; as=style; crossorigin`);
  if (font) parts.push(`<${font}>; rel=preload; as=font; crossorigin`);
  return parts.join(', ');
}

/**
 * The image a document may preload: a same-origin `/files/<public key>` path
 * only — the URL the page's own `<img>` will ask for, without the origin the
 * share card needs. Anything else is not preloaded (a wasted download costs
 * more than a late one).
 */
export function preloadImagePath(url: unknown): string | null {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      path = `${u.pathname}${u.search}`;
    } catch {
      return null;
    }
  }
  if (!path.startsWith('/files/')) return null;
  const key = path.slice('/files/'.length).split('?')[0];
  return isAnonymousPublicMediaKey(key) ? path : null;
}

/**
 * The store home's largest picture, from the anonymous resolve answer: the
 * published hero block's own image when it has one (the same `mediaSrc` rule
 * `blocks/Hero.tsx` applies: `/files/<key>`), else the store's banner.
 */
export function heroCoverFrom(resolve: unknown): string | null {
  const store = (resolve as { store?: Record<string, unknown> | null } | null)?.store;
  if (!store || typeof store !== 'object') return null;
  const layout = store.layout as { blocks?: unknown[] } | undefined;
  for (const block of layout?.blocks ?? []) {
    const b = block as { type?: unknown; hidden?: unknown; settings?: { image?: unknown } };
    if (b?.type !== 'hero') continue;
    if (b.hidden) break;
    const image = typeof b.settings?.image === 'string' ? b.settings.image.trim() : '';
    if (image) return preloadImagePath(image.startsWith('/files/') ? image : `/files/${image}`);
    break;
  }
  return preloadImagePath(store.bannerUrl);
}

/**
 * A JSON data block. `<`, `>` and `&` are written as escapes inside the JSON
 * text (still valid JSON, so `JSON.parse` on the client reads the same value)
 * so no value — a store name, a tagline — can close the element and inject
 * markup; U+2028/2029 likewise, for any reader that is not a JSON parser.
 */
export function inlineJsonScript(id: string, value: unknown): string {
  const json = JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script type="application/json" id="${id}">${json}</script>`;
}

export interface DocumentPreloads {
  /** Opening same-origin API requests, reused by fetch(credentials: 'same-origin'). */
  fetches?: string[];
  /** `/assets/<chunk>.js` files for `<link rel="modulepreload">`. */
  scripts: string[];
  /** `/assets/<chunk>.css` files for `<link rel="preload" as="style">`. */
  styles: string[];
  /** The one image preloaded at high priority, or null. */
  image: string | null;
  /** The same candidates/sizes the product gallery renders; absent for a store's cover. */
  imageSrcSet?: string;
  imageSizes?: string;
  /** The anonymous resolve answer, or null when the document must not carry one. */
  resolve: unknown | null;
}

/** Public still pictures only. A private key, GIF or pre-existing query keeps its original preload. */
export function productImagePreload(image: string | null): Pick<DocumentPreloads, 'imageSrcSet' | 'imageSizes'> {
  if (!image || image.includes('?') || !image.startsWith('/files/') || !variantSourceMime(image.slice('/files/'.length))) return {};
  if (!preloadImagePath(image)) return {};
  return {
    imageSrcSet: IMAGE_VARIANT_WIDTHS.map((w) => `${image}?w=${w} ${w}w`).join(', '),
    imageSizes: PRODUCT_GALLERY_SIZES,
  };
}

/**
 * Write the head start into the document: preloads and the data block, just
 * before `</head>` — after the entry's own modulepreloads and stylesheet, so
 * the preload scanner queues them behind the code the first paint needs.
 * Idempotent on the data block: a document that already carries one (a test
 * feeding the output back in) has it replaced, never doubled.
 */
export function injectDocumentPreloads(html: string, p: DocumentPreloads): string {
  const lines: string[] = [];
  for (const href of p.fetches ?? []) {
    if (!href.startsWith('/api/') || href.startsWith('//')) continue;
    lines.push(`<link rel="preload" as="fetch" crossorigin href="${escapeAttribute(href)}">`);
  }
  for (const href of p.scripts) lines.push(`<link rel="modulepreload" crossorigin href="${escapeAttribute(href)}">`);
  for (const href of p.styles) lines.push(`<link rel="preload" as="style" crossorigin href="${escapeAttribute(href)}">`);
  if (p.image) {
    const responsive = p.imageSrcSet && p.imageSizes
      ? ` imagesrcset="${escapeAttribute(p.imageSrcSet)}" imagesizes="${escapeAttribute(p.imageSizes)}"`
      : '';
    lines.push(`<link rel="preload" as="image" fetchpriority="high" href="${escapeAttribute(p.image)}"${responsive}>`);
  }
  if (p.resolve !== null && p.resolve !== undefined) lines.push(inlineJsonScript(INLINE_RESOLVE_ID, p.resolve));
  if (!lines.length) return html;
  const existing = new RegExp(`<script type="application/json" id="${INLINE_RESOLVE_ID}">[\\s\\S]*?</script>\\s*`, 'i');
  const out = html.replace(existing, '');
  const block = lines.map((l) => `  ${l}`).join('\n');
  // A FUNCTION replacement: `$&`, `$'` and friends are commands in a string one.
  return out.replace(/<\/head>/i, () => `${block}\n  </head>`);
}
