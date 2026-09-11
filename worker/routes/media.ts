import { Hono } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { requireAdmin, badRequest, str } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { validateOutboundUrl } from '../lib/fetchGuard';
import { sniff } from './uploads';
import { extractPageImages, imageCandidates, isVendorHost } from '../lib/pageImages';

/**
 * Image ingestion — POST /api/admin/media/ingest.
 *
 * A URL is fetched and stored only if the BYTES are an image: magic bytes
 * decide, never the extension and never the remote Content-Type. Discipline
 * on every fetch: SSRF check on each redirect hop, 10s timeout, 4MB cap,
 * content-addressed at products/import/<sha256>.<ext> with a HEAD probe first
 * so re-importing the same bytes is a no-op, and writes only under the public
 * products/import/ prefix.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED ON 2026-09-04, AND WHY
 * ---------------------------------------------------------------------------
 * Product-form mandate §2 said this endpoint must never read a product page,
 * and the refusal was total: an HTML body matches no magic signature, so a
 * vendor URL came back "The URL must point directly at an image file".
 *
 * The owner then asked for exactly that, in these words:
 *
 *   «دعم الصور بشكل احترافي خاصه من مواقع مثل bambulab + qidi + biqu + esun + creality»
 *
 * It is their store, so page reading is now supported — as a NARROW, NAMED
 * capability rather than by loosening the old rule:
 *
 *   - only hosts on `VENDOR_HOSTS` may be parsed as HTML. Every other URL
 *     still has to be a real image file, exactly as before;
 *   - only image ADDRESSES are read. Nothing extracts prices, titles,
 *     descriptions or any other text, so no product copy is ever lifted;
 *   - every address found goes back through this same pipeline, so extraction
 *     decides WHICH urls to try and never what is safe to store;
 *   - the page fetch is capped, timed out and SSRF-checked like any other, and
 *     one page can queue at most PAGE_IMAGE_LIMIT images.
 */

export const mediaRoutes = new Hono<AppContext>();

const USER_AGENT = 'Mozilla/5.0 (compatible; LevonisBot/1.0; +https://levonis-iq.com)';
const IMAGE_CAP = 4 * 1024 * 1024;
const MAX_PER_CALL = 12;
/** The most pictures one vendor page may queue. A gallery is a dozen shots;
 *  a page that offers fifty is offering cross-sells, not this product. */
const PAGE_IMAGE_LIMIT = 10;

export interface IngestResult {
  source_url: string;
  status: 'stored' | 'failed';
  key?: string;
  url?: string;
  reason?: string;
  /** Set when this image was found ON a page rather than requested directly. */
  from_page?: string;
  /** Alt text the page carried for it. Never invented. */
  alt?: string;
  /** Internal: the decoded page, when this URL turned out to be a vendor page.
   *  Stripped before the result ever reaches a response. */
  page_body?: string;
}

/**
 * The internal marker `ingestImageUrl` returns when the address turned out to
 * be a readable vendor PAGE rather than an image. It never leaves this module:
 * `ingestUrlOrPage` swaps it for the images the page named.
 */
const PAGE_MARKER = '__LEVONIS_VENDOR_PAGE__';

/** Read a response body up to `cap` bytes, then stop. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.length;
  }
  return out;
}

/**
 * Fetch one address and store it if the bytes are an image.
 *
 * `allowPage` is what separates the two callers: the public endpoint lets a
 * vendor page through to the extractor, while the recursive call the extractor
 * makes for each found image does NOT — so a page can never lead to another
 * page, and there is no crawl.
 */
export async function ingestImageUrl(
  env: Env,
  rawUrl: string,
  opts: { allowPage?: boolean; budget?: IngestBudget } = {}
): Promise<IngestResult> {
  let sourceUrl = rawUrl;
  const budget = opts.budget;
  if (budget && (budget.fetches <= 0 || budget.bytes <= 0)) {
    return {
      source_url: rawUrl,
      status: 'failed',
      reason: 'تجاوز هذا الطلب حدّ التنزيل — أعد المحاولة بعدد أقل من الروابط',
    };
  }
  try {
    let target = validateOutboundUrl(rawUrl);
    sourceUrl = target.toString();

    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (budget) {
        if (budget.fetches <= 0) {
          return { source_url: sourceUrl, status: 'failed', reason: 'تجاوز هذا الطلب حدّ التنزيل' };
        }
        budget.fetches -= 1;
      }
      res = await fetch(target.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': USER_AGENT },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('Location');
        if (!loc) break;
        target = validateOutboundUrl(new URL(loc, target).toString());
        continue;
      }
      break;
    }
    if (!res || !res.ok) {
      return { source_url: sourceUrl, status: 'failed', reason: `HTTP ${res ? res.status : 'error'}` };
    }

    const buf = await readCapped(res, Math.min(IMAGE_CAP + 1, budget ? budget.bytes : IMAGE_CAP + 1));
    if (budget) budget.bytes -= buf.length;
    if (buf.length > IMAGE_CAP) {
      return { source_url: sourceUrl, status: 'failed', reason: 'Image exceeds the 4 MB limit' };
    }
    // Magic bytes decide, not the extension and not the remote Content-Type.
    const kind = sniff(buf);
    if (!kind || !kind.mime.startsWith('image/')) {
      /**
       * Not an image. On a vendor host it may be the product PAGE, which the
       * owner asked to be able to paste. Anywhere else the answer is the same
       * refusal it has always been.
       */
      if (opts.allowPage && isVendorHost(target.hostname)) {
        // Signals the caller to run the extractor; the page bytes are already
        // in hand, so it is handed back rather than fetched a second time.
        return {
          source_url: target.toString(),
          status: 'failed',
          reason: PAGE_MARKER,
          page_body: new TextDecoder().decode(buf),
        };
      }
      return {
        source_url: sourceUrl,
        status: 'failed',
        reason: isVendorHost(target.hostname)
          ? 'The URL must point directly at an image file (JPEG/PNG/WebP/GIF/AVIF)'
          : 'The URL must point directly at an image file (JPEG/PNG/WebP/GIF/AVIF). ' +
            'Product PAGES can be read only for the supported vendors — ' +
            'paste the image address itself, or the page URL of a supported vendor.',
      };
    }

    const digest = await crypto.subtle.digest('SHA-256', buf as unknown as BufferSource);
    const sha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const key = `products/import/${sha}.${kind.ext}`;

    const existing = await env.BUCKET.head(key);
    if (!existing) {
      await env.BUCKET.put(key, buf, {
        httpMetadata: { contentType: kind.mime, cacheControl: 'public, max-age=31536000, immutable' },
      });
    }
    return { source_url: sourceUrl, key, url: `/files/${key}`, status: 'stored' };
  } catch (e) {
    const reason =
      e instanceof DOMException && e.name === 'TimeoutError'
        ? 'Timed out'
        : e && typeof e === 'object' && 'message' in e && typeof (e as Error).message === 'string'
          ? (e as Error).message.slice(0, 200)
          : 'Fetch failed';
    return { source_url: sourceUrl, status: 'failed', reason };
  }
}

/**
 * One address in, every picture it leads to out.
 *
 * A direct image URL yields one result, exactly as before. A product page on
 * a supported vendor yields one result per picture the page names — each of
 * which went through the same fetch, the same SSRF check and the same
 * magic-byte test, because extraction only decides which addresses to TRY.
 */
export interface IngestBudget {
  /** Outbound fetches left for this request, across every URL in it. */
  fetches: number;
  /** Bytes left to download for this request. */
  bytes: number;
}

/**
 * ONE REQUEST, ONE BUDGET.
 *
 * MAX_PER_CALL bounds the URLs, PAGE_IMAGE_LIMIT bounds the images per page and
 * imageCandidates adds up to two tries each — which multiplied out to 12 × (1
 * page + 10 × 2) ≈ 250 fetches and, at the 4 MB cap apiece, most of a gigabyte
 * for a single POST. Neither the per-fetch timeout nor the per-fetch cap sees
 * the total. This does: the budget is created per request and every fetch
 * decrements it, so the worst case is bounded no matter what a page names.
 */
export function newIngestBudget(): IngestBudget {
  return { fetches: 40, bytes: 64 * 1024 * 1024 };
}

export async function ingestUrlOrPage(
  env: Env,
  rawUrl: string,
  budget: IngestBudget = newIngestBudget()
): Promise<IngestResult[]> {
  const first = await ingestImageUrl(env, rawUrl, { allowPage: true, budget });
  if (first.reason !== PAGE_MARKER) return [first];

  const pageUrl = first.source_url;
  const found = extractPageImages(first.page_body ?? '', pageUrl, PAGE_IMAGE_LIMIT);
  if (found.length === 0) {
    return [
      {
        source_url: pageUrl,
        status: 'failed',
        reason:
          'قرأنا الصفحة ولم نجد فيها صور منتج — انسخ رابط الصورة نفسها / ' +
          'the page was read but named no product image; paste the image address itself',
      },
    ];
  }

  const out: IngestResult[] = [];
  const storedKeys = new Set<string>();
  for (const image of found) {
    // A known CDN is asked for the ORIGINAL file first and the rendered size
    // second, so a wrong guess costs one failed fetch and never the picture.
    let stored: IngestResult | null = null;
    let lastReason = '';
    for (const candidate of imageCandidates(image.url)) {
      if (budget.fetches <= 0 || budget.bytes <= 0) {
        lastReason = 'تجاوز هذا الطلب حدّ التنزيل — أعد المحاولة بعدد أقل من الروابط';
        break;
      }
      const r = await ingestImageUrl(env, candidate, { budget });
      if (r.status === 'stored') {
        stored = r;
        break;
      }
      lastReason = r.reason ?? 'failed';
    }
    if (stored) {
      // The same photo offered twice at two addresses is one photo: the key is
      // the SHA-256 of the bytes, so this catches it after the download that
      // proved it, which is the only point at which it can be known.
      if (stored.key && storedKeys.has(stored.key)) continue;
      if (stored.key) storedKeys.add(stored.key);
      out.push({ ...stored, from_page: pageUrl, alt: image.alt || undefined });
    } else {
      out.push({ source_url: image.url, status: 'failed', reason: lastReason, from_page: pageUrl });
    }
  }
  return out;
}

mediaRoutes.post('/ingest', requireAdmin, async (c) => {
  await rateLimit(c, 'media_ingest', 60, 3600);
  const body = (await c.req.json().catch(() => ({}))) as { urls?: unknown; url?: unknown };
  const raw = Array.isArray(body.urls) ? body.urls : body.url !== undefined ? [body.url] : [];
  if (raw.length === 0) throw badRequest('Provide one or more image URLs');
  if (raw.length > MAX_PER_CALL) throw badRequest(`At most ${MAX_PER_CALL} image URLs per request`);

  const urls = raw.map((u, i) => str(u, `urls[${i}]`, { min: 8, max: 2000 }));
  const results: IngestResult[] = [];
  const budget = newIngestBudget();
  for (const u of urls) results.push(...(await ingestUrlOrPage(c.env, u, budget)));
  // The decoded page never leaves this module — it is working state, not a
  // payload, and returning someone else's markup to the browser is not this
  // endpoint's job.
  for (const r of results) delete r.page_body;

  const user = c.get('user');
  await audit(c.env.DB, user?.id ?? null, 'media.ingest', 'products/import', {
    requested: urls.length,
    stored: results.filter((r) => r.status === 'stored').length,
    // Which vendor pages were read, so the audit trail says where the store's
    // photography came from.
    pages: [...new Set(results.map((r) => r.from_page).filter(Boolean))],
  });

  return c.json({ success: true, results });
});
