/**
 * Product-page image extraction.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists, and what it changes
 * ---------------------------------------------------------------------------
 * The product-form mandate §2 said an image URL must point DIRECTLY at a media
 * file and must never be used to scrape a product page. `media.ts` enforced
 * that with a magic-byte check, and `fetchGuard.ts` carried no HTML parsing at
 * all. On 2026-09-04 the owner asked for the opposite, in these words:
 *
 *   «دعم الصور بشكل احترافي خاصه من مواقع مثل bambulab + qidi + biqu + esun + creality»
 *
 * That is their store and their call, so page extraction is now supported —
 * but as a NARROW, NAMED capability rather than by loosening the old rule:
 *
 *   - only hosts on VENDOR_HOSTS below may be parsed as HTML. Every other URL
 *     still has to be a real image file, exactly as before;
 *   - only IMAGE ADDRESSES are read. Nothing here extracts prices, titles,
 *     descriptions or any other text, so no product copy is ever lifted from
 *     someone else's page;
 *   - every extracted address goes back through the SAME ingest pipeline —
 *     SSRF check per redirect hop, 10s timeout, 4MB cap, magic-byte sniff,
 *     content-addressed R2 key. Extraction decides WHICH urls to try; it never
 *     decides what is safe to store.
 *
 * The parser is a pure function over a string so it is testable under
 * `node --test` without a Workers runtime. HTMLRewriter would be the idiomatic
 * Workers tool, but it is streaming-only and absent from the test runtime, and
 * a page is already read into memory under a cap before we look at it.
 */

/** One image address found on a page, with why we believe in it. */
export interface PageImage {
  /** Absolute URL, resolved against the page. */
  url: string;
  /** Where on the page it came from — drives the order we try them in. */
  source: 'og' | 'jsonld' | 'preload' | 'srcset' | 'img';
  /** Declared pixel width when the page stated one, else null. */
  width: number | null;
  /** Alt text the page carried, '' when it carried none. Never invented. */
  alt: string;
}

/**
 * Hosts whose pages may be parsed as HTML. Suffix-matched, so
 * `us.store.bambulab.com` matches `bambulab.com`.
 *
 * These are the five the owner named plus the storefront hosts those brands
 * actually sell from. Adding a vendor is a one-line change here — deliberately
 * a code change and not a runtime setting, so widening what the server will
 * parse always goes through review.
 */
export const VENDOR_HOSTS: readonly string[] = [
  'bambulab.com',
  'bambulab.cn',
  'makerworld.com',
  'qidi3d.com',
  'qidytech.com',
  'biqu.equipment',
  'bigtree-tech.com',
  'biqu3d.com',
  'esun3d.com',
  'esun3d.net',
  'creality.com',
  'creality3d.shop',
  'crealitycloud.com',
];

/** True when this host may be read as a page rather than as an image file. */
export function isVendorHost(hostname: string, allow: readonly string[] = VENDOR_HOSTS): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return allow.some((v) => h === v || h.endsWith(`.${v}`));
}

/**
 * Filenames that are page furniture rather than product photography. A store
 * page carries dozens of them and each one costs a fetch, so they are dropped
 * before the network is touched — not after.
 */
const CHROME_RE =
  /(sprite|logo|favicon|icon[-_.]|placeholder|loading|spinner|skeleton|avatar|profile[-_]|payment|visa|mastercard|paypal|amex|klarna|apple[-_]?pay|google[-_]?pay|flag[-_]|badge[-_]|arrow|chevron|close|search|cart[-_]|menu[-_])/i;

/** Extensions the ingest sniffer cannot store — fetching them is wasted work. */
const UNSUPPORTED_EXT_RE = /\.(svg|ico|avif|bmp|tiff?|heic|heif|mp4|webm|mov|pdf)(\?|#|$)/i;

/** The smallest declared width we accept when a width IS declared. Thumbnails
 *  below this are navigation chrome, not the product shot. An UNKNOWN width is
 *  never rejected — most pages declare none. */
const MIN_DECLARED_WIDTH = 300;

function absolute(href: string, pageUrl: string): string | null {
  const raw = href.trim();
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('#')) return null;
  try {
    const u = new URL(raw, pageUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function isPlausibleImage(url: string): boolean {
  if (UNSUPPORTED_EXT_RE.test(url)) return false;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return !CHROME_RE.test(path);
}

/** Decode the handful of entities that actually appear inside HTML attributes. */
function unescapeAttr(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Read one attribute off a tag's raw text. */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return unescapeAttr(m[2] ?? m[3] ?? m[4] ?? '');
}

/**
 * The widest entry of a srcset. `srcset` is the page telling us, in its own
 * words, which file is the big one — far more reliable than guessing from a
 * filename.
 *
 * Entries are found by anchoring on the DESCRIPTOR rather than by splitting on
 * commas, because a comma is legal inside a URL (Cloudinary writes transforms
 * as `/w_800,h_800/`) and a naive split cuts those addresses in half. A srcset
 * with no descriptor at all is one URL, which is the fallback.
 */
function widestFromSrcset(srcset: string): { url: string; width: number | null } | null {
  const entry = /([^\s,]+(?:,[^\s,]+)*?)\s+(\d+)(w)(?=\s*(?:,|$))|([^\s,]+(?:,[^\s,]+)*?)\s+([\d.]+)(x)(?=\s*(?:,|$))/g;
  let best: { url: string; width: number | null } | null = null;
  let bestRank = -1;
  let hasWidthDescriptor = false;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(srcset)) !== null) {
    const isW = m[3] === 'w';
    const url = (isW ? m[1] : m[4]).trim();
    const num = Number(isW ? m[2] : m[5]);
    if (!url || !Number.isFinite(num)) continue;
    // A width descriptor is real information; a density descriptor is not a
    // width and is never reported as one. When both appear (invalid HTML, but
    // it happens) the widths win outright.
    if (isW && !hasWidthDescriptor) {
      hasWidthDescriptor = true;
      bestRank = -1;
    }
    if (!isW && hasWidthDescriptor) continue;
    if (num > bestRank) {
      bestRank = num;
      best = { url, width: isW ? num : null };
    }
  }
  if (best) return best;
  const only = srcset.trim();
  return only && !/\s/.test(only) ? { url: only, width: null } : null;
}

/**
 * Ask a known CDN for the ORIGINAL file instead of the resized copy the page
 * happened to render. Returns candidates in the order they should be tried:
 * the upgrade first, the untouched URL always last, so a wrong guess costs one
 * failed fetch and never costs the image.
 */
export function imageCandidates(url: string): string[] {
  const out: string[] = [];
  const push = (u: string) => {
    if (u && !out.includes(u)) out.push(u);
  };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const host = parsed.hostname.toLowerCase();

  // Shopify — bambulab, esun and creality storefronts all run on it. Two
  // resize dialects: a `_1200x1200` (or `_1200x`) infix, and width/height
  // query parameters. Stripping either yields the master file.
  if (host.endsWith('cdn.shopify.com') || parsed.pathname.includes('/cdn/shop/')) {
    const bare = new URL(parsed.toString());
    for (const p of ['width', 'height', 'crop', 'quality', 'format']) bare.searchParams.delete(p);
    bare.pathname = bare.pathname.replace(/_(\d+)x(\d*)(@\d+x)?(?=\.[a-z0-9]+$)/i, '');
    push(bare.toString());
  }

  // WordPress / WooCommerce write `-800x800` before the extension.
  if (/-\d+x\d+(?=\.[a-z0-9]+$)/i.test(parsed.pathname)) {
    const bare = new URL(parsed.toString());
    bare.pathname = bare.pathname.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, '');
    push(bare.toString());
  }

  push(url);
  return out;
}

/** Every `<script type="application/ld+json">` payload on the page. */
function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      // A page with one malformed block still has its other blocks; a parse
      // failure here is not a reason to abandon the page.
    }
  }
  return out;
}

/** Walk a JSON-LD graph and collect every `image` on a Product node. */
function productImagesFromJsonLd(node: unknown, into: string[], depth = 0): void {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) productImagesFromJsonLd(n, into, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  const isProduct =
    type === 'Product' ||
    type === 'ProductGroup' ||
    (Array.isArray(type) && type.some((t) => t === 'Product' || t === 'ProductGroup'));
  if (isProduct && obj.image !== undefined) {
    const collect = (v: unknown) => {
      if (typeof v === 'string') into.push(v);
      else if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).url === 'string') {
        into.push((v as Record<string, string>).url);
      } else if (Array.isArray(v)) v.forEach(collect);
    };
    collect(obj.image);
  }
  for (const key of ['@graph', 'hasVariant', 'itemListElement', 'mainEntity', 'offers']) {
    if (obj[key] !== undefined) productImagesFromJsonLd(obj[key], into, depth + 1);
  }
}

/**
 * Every image address a product page advertises, best first.
 *
 * Order is by CONFIDENCE, not by page order: the metadata a store writes for
 * social previews and for search engines names the product shot deliberately,
 * while `<img>` tags include every thumbnail and cross-sell on the page.
 */
export function extractPageImages(html: string, pageUrl: string, limit = 24): PageImage[] {
  const found: PageImage[] = [];
  const seen = new Set<string>();
  const add = (rawUrl: string | null, source: PageImage['source'], width: number | null, alt: string) => {
    if (!rawUrl) return;
    const abs = absolute(rawUrl, pageUrl);
    if (!abs || seen.has(abs) || !isPlausibleImage(abs)) return;
    if (width !== null && width < MIN_DECLARED_WIDTH) return;
    seen.add(abs);
    found.push({ url: abs, source, width, alt });
  };

  // 1. Open Graph / Twitter card — the store's own answer to "which picture is
  //    this product?".
  const metaRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let ogWidth: number | null = null;
  const ogTags: string[] = [];
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const prop = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    if (prop === 'og:image:width') {
      const w = Number(attr(tag, 'content'));
      if (Number.isFinite(w) && w > 0) ogWidth = w;
    }
    if (prop === 'og:image' || prop === 'og:image:secure_url' || prop === 'og:image:url' || prop === 'twitter:image' || prop === 'twitter:image:src') {
      const content = attr(tag, 'content');
      if (content) ogTags.push(content);
    }
  }
  for (const t of ogTags) add(t, 'og', ogWidth, '');

  // 2. JSON-LD Product.image — usually the whole gallery, in order.
  const ld: string[] = [];
  for (const block of jsonLdBlocks(html)) productImagesFromJsonLd(block, ld);
  for (const u of ld) add(u, 'jsonld', null, '');

  // 3. <link rel="preload" as="image"> — what the page itself rushes to load.
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?preload/i.test(tag) || !/\bas\s*=\s*["']?image/i.test(tag)) continue;
    const set = attr(tag, 'imagesrcset');
    if (set) {
      const best = widestFromSrcset(set);
      if (best) add(best.url, 'preload', best.width, '');
    }
    add(attr(tag, 'href'), 'preload', null, '');
  }

  // 4. <img> — srcset first (the page names the widest file itself), then the
  //    lazy-loading attributes, then plain src.
  const imgRe = /<img\b[^>]*>/gi;
  const fromImgs: PageImage[] = [];
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const alt = attr(tag, 'alt') ?? '';
    const declared = Number(attr(tag, 'width'));
    const declaredWidth = Number.isFinite(declared) && declared > 0 ? declared : null;
    const set = attr(tag, 'srcset') ?? attr(tag, 'data-srcset');
    if (set) {
      const best = widestFromSrcset(set);
      if (best) {
        const abs = absolute(best.url, pageUrl);
        if (abs && !seen.has(abs) && isPlausibleImage(abs) && !(best.width !== null && best.width < MIN_DECLARED_WIDTH)) {
          seen.add(abs);
          fromImgs.push({ url: abs, source: 'srcset', width: best.width, alt });
          continue;
        }
      }
    }
    const src = attr(tag, 'src') ?? attr(tag, 'data-src') ?? attr(tag, 'data-original') ?? attr(tag, 'data-lazy-src');
    const abs = absolute(src ?? '', pageUrl);
    if (!abs || seen.has(abs) || !isPlausibleImage(abs)) continue;
    if (declaredWidth !== null && declaredWidth < MIN_DECLARED_WIDTH) continue;
    seen.add(abs);
    fromImgs.push({ url: abs, source: 'img', width: declaredWidth, alt });
  }
  // Widest declared first; an undeclared width keeps page order behind them.
  fromImgs.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  found.push(...fromImgs);

  return found.slice(0, limit);
}
