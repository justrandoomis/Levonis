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

/** The four things a chat app reads off a link, already absolute and escaped. */
export interface SocialPreview {
  title: string;
  /** '' means "leave the document's own description alone". */
  description: string;
  /** Absolute URL. '' means "leave the document's own image alone". */
  image: string;
  /** Absolute URL of the page itself. */
  url: string;
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
 * A remote absolute address (an imported vendor image that was never mirrored
 * into R2) is passed through as-is over https only: a crawler will not load a
 * plaintext image into a page it serves over TLS.
 */
export function absoluteImageUrl(url: unknown, origin: string): string {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('/files/')) {
    const key = raw.slice('/files/'.length).split('?')[0];
    if (!isAnonymousPublicMediaKey(key)) return '';
    return `${origin}${raw}`;
  }
  if (raw.startsWith('https://')) return raw;
  // Relative to the app but not a media route, http://, data:, or anything
  // else a crawler may refuse: not worth risking an empty card over.
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
  if (existing.test(html)) return html.replace(existing, tag);
  return html.replace(/<\/head>/i, `  ${tag}\n  </head>`);
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
    out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeAttribute(preview.title)}</title>`);
    out = setMeta(out, 'property', 'og:title', preview.title);
    out = setMeta(out, 'name', 'twitter:title', preview.title);
  }
  if (preview.description) {
    out = setMeta(out, 'property', 'og:description', preview.description);
    out = setMeta(out, 'name', 'twitter:description', preview.description);
  }
  if (preview.image) {
    out = setMeta(out, 'property', 'og:image', preview.image);
    out = setMeta(out, 'name', 'twitter:image', preview.image);
  }
  if (preview.url) out = setMeta(out, 'property', 'og:url', preview.url);
  return out;
}

/** The two shapes a slug can resolve to. Only the columns the card needs. */
interface PreviewRow {
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
  origin: string
): Promise<Pick<SocialPreview, 'title' | 'description' | 'image'> | null> {
  const row =
    (await db
      .prepare("SELECT name, name_ar, name_en, description, description_ar, description_en, images FROM products WHERE slug = ? AND status = 'active'")
      .bind(slug)
      .first<PreviewRow>()) ??
    (await db
      .prepare("SELECT name, name_ar, description, description_ar, images FROM community_products WHERE slug = ? AND status = 'active'")
      .bind(slug)
      .first<PreviewRow>());
  if (!row) return null;

  const title = pickText(row.name_ar, row.name, row.name_en);
  if (!title) return null; // nothing to identify it by; keep the shop's card

  return {
    title,
    description: shortDescription(pickText(row.description_ar, row.description, row.description_en)),
    image: absoluteImageUrl(primaryMedia(upgradeMedia(row.images))?.url, origin),
  };
}
