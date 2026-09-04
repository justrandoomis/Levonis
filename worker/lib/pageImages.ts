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
/**
 * Directories a store keeps its furniture in. A file under one of these is
 * chrome whatever it is called.
 */
const CHROME_DIRS = new Set([
  'icon', 'icons', 'sprite', 'sprites', 'assets', 'asset', 'ui', 'chrome', 'theme',
  'payment', 'payments', 'pay', 'flags', 'badges', 'avatars', 'logos', 'static',
]);

/** Words that are never part of a product's name. */
const HARD_WORDS = new Set([
  'sprite', 'favicon', 'placeholder', 'visa', 'mastercard', 'paypal', 'amex', 'klarna',
  'applepay', 'googlepay', 'apay', 'gpay',
]);

/**
 * Words that MEAN furniture on their own and mean nothing on their own inside
 * a product name.
 *
 * The first version tested these as substrings of the whole path, and it ate
 * real photography: `close` matched `k1-max-closeup.jpg`, `arrow` matched
 * `narrow-nozzle-0.2.jpg`, `icon-` matched `silicon-carbide-nozzle.jpg`, and
 * `profile-` matched `aluminium-profile-2020.jpg` — a part BIQU sells.
 * Matching whole TOKENS instead was better and still wrong: `close-up-nozzle`,
 * `fidget-spinner-blue`, `skeleton-hand-model` and `aluminium-profile-2020`
 * all contain one of these as a real word.
 *
 * The rule that works: a file is furniture only when EVERY word of its name is
 * one of these (or a bare number). `cart-icon.png` and `menu-arrow.png` are;
 * `close-up-nozzle.jpg` is not, because `nozzle` is a real word about a real
 * thing.
 */
const SOFT_WORDS = new Set([
  'logo', 'icon', 'cart', 'menu', 'arrow', 'chevron', 'close', 'search', 'profile',
  'spinner', 'skeleton', 'avatar', 'badge', 'flag', 'loading', 'load', 'nav', 'header',
  'footer', 'bg', 'background', 'btn', 'button', 'thumb', 'thumbnail', 'blank', 'empty',
  'up', 'down', 'left', 'right', 'small', 'mini', 'x', 'default',
]);

function isChrome(pathname: string): boolean {
  const parts = pathname.toLowerCase().split('/').filter(Boolean);
  const file = parts.pop() ?? '';
  if (parts.some((d) => CHROME_DIRS.has(d))) return true;
  const stem = file.replace(/\.[a-z0-9]+$/i, '');
  const tokens = stem.split(/[-_.\s]+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some((t) => HARD_WORDS.has(t))) return true;
  return tokens.every((t) => SOFT_WORDS.has(t) || /^\d+$/.test(t) || /^\d+x\d+$/.test(t));
}

/**
 * Extensions the ingest sniffer cannot store — fetching them is wasted work.
 * AVIF is NOT here: the sniffer learned it in the same change that added this
 * file, and Shopify serves AVIF by default, so refusing it here would drop a
 * whole vendor's gallery for a format the pipeline can store.
 */
const UNSUPPORTED_EXT_RE = /\.(svg|ico|bmp|tiff?|heic|heif|mp4|webm|mov|pdf)(\?|#|$)/i;

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
  return !isChrome(path);
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

/**
 * Every attribute of a tag, read once, in order.
 *
 * The first version matched `\bname\s*=` anywhere in the tag's raw text, which
 * is wrong twice over: `\b` also matches after a hyphen, so `srcset` matched
 * `data-srcset`; and the search ran over the whole tag INCLUDING attribute
 * values, so a Shopify `src="…?v=1&width=1946"` made `attr(tag,'width')`
 * return 1946 instead of the real `width="64"`. A 64px thumbnail then sailed
 * past the minimum-width check and sorted to the FRONT of the gallery.
 *
 * A tokenizer instead: walk the tag, take name=value pairs, and never look
 * inside a value.
 */
function parseAttrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  // Skip "<img" / "<meta" and stop before the closing ">".
  let i = tag.indexOf('<') + 1;
  while (i < tag.length && !/[\s/>]/.test(tag[i])) i += 1;
  while (i < tag.length) {
    while (i < tag.length && /[\s/]/.test(tag[i])) i += 1;
    if (i >= tag.length || tag[i] === '>') break;
    const nameStart = i;
    while (i < tag.length && !/[\s=/>]/.test(tag[i])) i += 1;
    const name = tag.slice(nameStart, i).toLowerCase();
    while (i < tag.length && /\s/.test(tag[i])) i += 1;
    let value = '';
    if (tag[i] === '=') {
      i += 1;
      while (i < tag.length && /\s/.test(tag[i])) i += 1;
      const quote = tag[i];
      if (quote === '"' || quote === "'") {
        i += 1;
        const end = tag.indexOf(quote, i);
        // An unterminated quote is a malformed tag; take the rest and stop.
        value = end === -1 ? tag.slice(i) : tag.slice(i, end);
        i = end === -1 ? tag.length : end + 1;
      } else {
        const start = i;
        while (i < tag.length && !/[\s>]/.test(tag[i])) i += 1;
        value = tag.slice(start, i);
      }
    }
    if (name && !out.has(name)) out.set(name, unescapeAttr(value));
  }
  return out;
}

/**
 * The widest entry of a srcset.
 *
 * `srcset` is the page telling us, in its own words, which file is the big
 * one — far more reliable than guessing from a filename.
 *
 * Parsed by a LINEAR scan rather than a regex. The regex version anchored on
 * the descriptor to survive commas inside URLs (Cloudinary writes transforms
 * as `/w_800,h_800/`), and its lazy `(?:,[^\s,]+)*?` group re-expanded at
 * every start position: measured on comma-joined URL lists with no
 * descriptors, 5 KB cost 81 ms and 84 KB cost 19.5 seconds — clean quadratic,
 * on an attribute read straight out of a third-party page capped at 4 MB. CPU
 * is not bounded by the fetch timeout, so that was a hang waiting to be
 * pasted. This walks the string once.
 *
 * The rule the scan implements is the HTML one: an entry ends at a comma that
 * FOLLOWS whitespace or a descriptor, so a comma inside a URL — which never
 * has whitespace before it — does not split.
 */
function widestFromSrcset(srcset: string): { url: string; width: number | null } | null {
  if (srcset.length > 64_000) return null; // far past any real gallery
  let best: { url: string; width: number | null } | null = null;
  let bestRank = -1;
  let hasWidthDescriptor = false;

  let i = 0;
  const n = srcset.length;
  while (i < n) {
    while (i < n && (srcset[i] === ',' || /\s/.test(srcset[i]))) i += 1;
    if (i >= n) break;
    // The URL runs to the next whitespace or to the end.
    const urlStart = i;
    while (i < n && !/\s/.test(srcset[i])) i += 1;
    let url = srcset.slice(urlStart, i);
    // A URL may legally end with the comma that separates it from the next
    // entry when no descriptor was written.
    let sawTrailingComma = false;
    while (url.endsWith(',')) {
      url = url.slice(0, -1);
      sawTrailingComma = true;
    }
    if (!url) continue;

    // A descriptor, if this entry has one, is the next token before the comma.
    let width: number | null = null;
    let rank = 0;
    let isW = false;
    if (!sawTrailingComma) {
      while (i < n && /\s/.test(srcset[i])) i += 1;
      const descStart = i;
      while (i < n && srcset[i] !== ',') i += 1;
      const desc = srcset.slice(descStart, i).trim();
      const w = /^(\d+)w$/.exec(desc);
      const x = /^([\d.]+)x$/.exec(desc);
      if (w) {
        isW = true;
        width = Number(w[1]);
        rank = width;
      } else if (x) {
        rank = Number(x[1]);
      }
    }

    // A width descriptor is real information; a density is not a width and is
    // never reported as one. When both appear (invalid HTML, but it happens)
    // the widths win outright.
    if (isW && !hasWidthDescriptor) {
      hasWidthDescriptor = true;
      bestRank = -1;
    }
    if (!isW && hasWidthDescriptor) continue;
    if (rank > bestRank) {
      bestRank = rank;
      best = { url, width };
    }
  }
  return best;
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
  //
  //    `og:image:width` belongs to the og:image it FOLLOWS, per the Open Graph
  //    spec's structured properties. One page-wide variable applied to every
  //    tag meant a small second og:image (a swatch, a Yoast-generated
  //    thumbnail) set the width for the 2000px hero above it and dropped it —
  //    and gave twitter:image a width it never declared.
  const metaRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  const ogTags: Array<{ url: string; width: number | null }> = [];
  while ((m = metaRe.exec(html)) !== null) {
    const at = parseAttrs(m[0]);
    const prop = (at.get('property') ?? at.get('name') ?? '').toLowerCase();
    const content = at.get('content') ?? '';
    if (prop === 'og:image:width') {
      const w = Number(content);
      // Attach it to the most recent og:image that has none yet.
      const last = ogTags[ogTags.length - 1];
      if (last && last.width === null && Number.isFinite(w) && w > 0) last.width = w;
      continue;
    }
    if (
      prop === 'og:image' ||
      prop === 'og:image:secure_url' ||
      prop === 'og:image:url' ||
      prop === 'twitter:image' ||
      prop === 'twitter:image:src'
    ) {
      if (content) ogTags.push({ url: content, width: null });
    }
  }
  for (const t of ogTags) add(t.url, 'og', t.width, '');

  // 2. JSON-LD Product.image — usually the whole gallery, in order.
  const ld: string[] = [];
  for (const block of jsonLdBlocks(html)) productImagesFromJsonLd(block, ld);
  for (const u of ld) add(u, 'jsonld', null, '');

  // 3. <link rel="preload" as="image"> — what the page itself rushes to load.
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const at = parseAttrs(m[0]);
    if (!(at.get('rel') ?? '').toLowerCase().includes('preload')) continue;
    if ((at.get('as') ?? '').toLowerCase() !== 'image') continue;
    const set = at.get('imagesrcset');
    if (set) {
      const best = widestFromSrcset(set);
      if (best) add(best.url, 'preload', best.width, '');
    }
    add(at.get('href') ?? null, 'preload', null, '');
  }

  // 4. <img> — srcset first (the page names the widest file itself), then the
  //    lazy-loading attributes, then plain src.
  const imgRe = /<img\b[^>]*>/gi;
  const fromImgs: PageImage[] = [];
  while ((m = imgRe.exec(html)) !== null) {
    const at = parseAttrs(m[0]);
    const alt = at.get('alt') ?? '';
    const declared = Number(at.get('width'));
    const declaredWidth = Number.isFinite(declared) && declared > 0 ? declared : null;
    // A tag that declares itself a thumbnail is a thumbnail whichever
    // attribute its address is in — the src fallback below must not smuggle it
    // back in with an unknown width.
    if (declaredWidth !== null && declaredWidth < MIN_DECLARED_WIDTH) continue;
    const set = at.get('srcset') ?? at.get('data-srcset');
    if (set) {
      const best = widestFromSrcset(set);
      // The page said its WIDEST candidate is below the floor. Falling through
      // to `src` — which declares no width at all — smuggled the same
      // thumbnail back in as "size unknown".
      if (best && best.width !== null && best.width < MIN_DECLARED_WIDTH) continue;
      if (best) {
        const abs = absolute(best.url, pageUrl);
        if (abs && !seen.has(abs) && isPlausibleImage(abs)) {
          seen.add(abs);
          fromImgs.push({ url: abs, source: 'srcset', width: best.width, alt });
          continue;
        }
      }
    }
    const src =
      at.get('src') ?? at.get('data-src') ?? at.get('data-original') ?? at.get('data-lazy-src') ?? '';
    const abs = absolute(src, pageUrl);
    if (!abs || seen.has(abs) || !isPlausibleImage(abs)) continue;
    seen.add(abs);
    fromImgs.push({ url: abs, source: 'img', width: declaredWidth, alt });
  }
  // Widest declared first; an undeclared width keeps page order behind them.
  fromImgs.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  found.push(...fromImgs);

  return found.slice(0, limit);
}
