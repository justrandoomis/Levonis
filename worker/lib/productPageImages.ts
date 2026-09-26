/**
 * PRODUCT-PAGE IMAGE FALLBACK FOR THE TEMPLATE IMPORTER.
 *
 * A template often carries image links that were guessed from a store's
 * naming scheme (for example `…/cdn/shop/files/Yellow_720x.jpg`). When the
 * store moves its images those links answer 404 while the product page named
 * in `images.N.source_url` still lists every image. This module reads that
 * page's own published data — schema.org JSON-LD (`Product` /
 * `ProductGroup.hasVariant[].image`) and `og:image` — and picks the image that
 * belongs to the row: the colour code in its id (`yellow-10400` ↔
 * "PLA Basic - Yellow (10400) / …") first, then the colour words.
 *
 * Pure parsing lives here; the network read goes through guardedFetchBytes, so
 * the same outbound rules (http(s) only, no private addresses, byte and fetch
 * budget) apply to the page as to any image.
 */
import { guardedFetchBytes, type GuardedFetchBudget } from './fetchGuard';

export interface PageImageVariant {
  name: string;
  image: string;
}

export interface PageImages {
  /** The page's own hero image (og:image, else the first product image). */
  primary: string | null;
  variants: PageImageVariant[];
}

const PAGE_BYTE_CAP = 4 * 1024 * 1024;

function absolute(raw: unknown, base: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim(), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function firstImage(raw: unknown, base: string): string | null {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = firstImage(item, base);
      if (found) return found;
    }
    return null;
  }
  if (raw && typeof raw === 'object') return absolute((raw as { url?: unknown }).url, base);
  return absolute(raw, base);
}

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Read the images a product page publishes about itself. Never throws. */
export function extractPageImages(html: string, pageUrl: string): PageImages {
  const variants: PageImageVariant[] = [];
  let productImage: string | null = null;

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) visit(obj['@graph']);
    const type = Array.isArray(obj['@type']) ? obj['@type'].map(String) : [String(obj['@type'] ?? '')];
    if (type.includes('ProductGroup') || type.includes('Product')) {
      const own = firstImage(obj.image, pageUrl);
      if (own && !productImage) productImage = own;
      if (own && type.includes('Product') && typeof obj.name === 'string') {
        variants.push({ name: obj.name, image: own });
      }
      if (Array.isArray(obj.hasVariant)) visit(obj.hasVariant);
    }
  };

  const scripts = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      visit(JSON.parse(match[1]));
    } catch {
      // One malformed block does not hide the others.
    }
  }

  let og: string | null = null;
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const t = tag[0];
    if (!/(?:property|name)=["']og:image(?::url)?["']/i.test(t)) continue;
    const content = /content=["']([^"']+)["']/i.exec(t);
    og = content ? absolute(decodeEntities(content[1]), pageUrl) : null;
    if (og) break;
  }

  const seen = new Set<string>();
  const unique = variants.filter((v) => {
    const key = `${v.name}|${v.image}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { primary: og ?? productImage, variants: unique };
}

export interface PageImageHint {
  /** A colour / option id such as `yellow-10400`; empty for a product image. */
  bindingId: string;
  /** Any human label for the row (colour name, alt text). */
  labels: string[];
}

const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * The page image for one template row, or null when nothing on the page is
 * clearly that row. A product-level row (no binding) takes the page's primary.
 */
export function pickPageImage(page: PageImages, hint: PageImageHint): string | null {
  if (!hint.bindingId) return page.primary;

  // 1. A colour code (4+ digits) in the id that the variant name also carries.
  const codes = hint.bindingId.match(/\d{4,}/g) ?? [];
  for (const code of codes) {
    const byCode = page.variants.find((v) => new RegExp(`(^|\\D)${code}(\\D|$)`).test(v.name));
    if (byCode) return byCode.image;
  }

  // 2. The colour words. The variant name "PLA Basic - Blue Grey (10602) / …"
  // is split at " - " and "/" and the colour segment must equal the words of
  // the id or a label, so "Blue" never takes "Blue Grey".
  const segmentsOf = (name: string): string[][] =>
    name.split(/\s[-–]\s|\//).map((part) => words(part.replace(/\([^)]*\)/g, ''))).filter((w) => w.length);
  const wanted = [hint.bindingId.replace(/\d+/g, ' '), ...hint.labels]
    .map((s) => words(s).join(' '))
    .filter(Boolean);
  for (const want of wanted) {
    const hit = page.variants.find((v) => segmentsOf(v.name).some((seg) => seg.join(' ') === want));
    if (hit) return hit.image;
  }
  return null;
}

/** Fetch a product page through the outbound guard and read its images. */
export async function fetchPageImages(
  pageUrl: string,
  options: { budget?: GuardedFetchBudget; fetcher?: typeof fetch } = {}
): Promise<PageImages> {
  const fetched = await guardedFetchBytes(pageUrl, {
    maxBytes: PAGE_BYTE_CAP,
    budget: options.budget,
    fetcher: options.fetcher,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LevonisBot/1.0; +https://levonis-iq.com)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  const html = new TextDecoder().decode(fetched.bytes);
  return extractPageImages(html, fetched.url);
}
