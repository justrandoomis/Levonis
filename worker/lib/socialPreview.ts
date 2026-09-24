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
import { primaryMedia, upgradeMedia } from './productModel';
import { isAnonymousPublicMediaKey } from './mediaStorage';
import { loadAuthoritativeProductImages } from './productSelectionImage';
import { logoSourceKey, readStoreIconsQuietly, servableStoreIcons } from './storeIcons';
import { cleanIdentityText, storeDescription } from './webManifest';

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
): Promise<Pick<SocialPreview, 'title' | 'description' | 'image'> | null> {
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
      "SELECT id, name, name_ar, description, description_ar FROM products WHERE slug = ? AND status = 'active'"
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
): Promise<Pick<SocialPreview, 'title' | 'description' | 'image'> | null> {
  const title = pickText(row.name_ar, row.name, row.name_en);
  if (!title) return null; // nothing to identify it by; keep the shop's card

  const productImages = product
    ? await loadAuthoritativeProductImages(db, [String(product.id ?? '')])
    : null;
  const image = product
    ? productImages?.get(String(product.id ?? '')) ?? ''
    : primaryMedia(upgradeMedia(row.images))?.url ?? '';

  return {
    title,
    description: shortDescription(pickText(row.description_ar, row.description, row.description_en)),
    image: absoluteImageUrl(image, origin),
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
