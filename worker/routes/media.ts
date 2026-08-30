import { Hono } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { requireAdmin, badRequest, str } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { validateOutboundUrl } from '../lib/fetchGuard';
import { sniff } from './uploads';

/**
 * Direct image-file ingestion — POST /api/admin/media/ingest.
 *
 * This is the ONLY outbound fetch the admin product surface performs, and it
 * is deliberately narrow (product-form mandate §2): the URL must resolve to a
 * real image file, verified by MAGIC BYTES, not by its extension or by the
 * server's Content-Type header. An HTML page is rejected outright — nothing
 * here parses markup, reads metadata or extracts text, so a product page URL
 * cannot be scraped through it.
 *
 * Discipline: SSRF check on every redirect hop, 10s timeout, 4MB cap, images
 * only, content-addressed at products/import/<sha256>.<ext> with a HEAD probe
 * first so re-importing the same bytes is a no-op. Writes only under the
 * public products/import/ prefix — never a private one.
 */

export const mediaRoutes = new Hono<AppContext>();

const USER_AGENT = 'Mozilla/5.0 (compatible; LevonisBot/1.0)';
const IMAGE_CAP = 4 * 1024 * 1024;
const MAX_PER_CALL = 12;

export interface IngestResult {
  source_url: string;
  status: 'stored' | 'failed';
  key?: string;
  url?: string;
  reason?: string;
}

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

export async function ingestImageUrl(env: Env, rawUrl: string): Promise<IngestResult> {
  let sourceUrl = rawUrl;
  try {
    let target = validateOutboundUrl(rawUrl);
    sourceUrl = target.toString();

    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
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

    const buf = await readCapped(res, IMAGE_CAP + 1);
    if (buf.length > IMAGE_CAP) {
      return { source_url: sourceUrl, status: 'failed', reason: 'Image exceeds the 4 MB limit' };
    }
    // Magic bytes decide, not the extension and not the remote Content-Type.
    // An HTML product page fails here, which is what keeps §2 enforced.
    const kind = sniff(buf);
    if (!kind || !kind.mime.startsWith('image/')) {
      return {
        source_url: sourceUrl,
        status: 'failed',
        reason: 'The URL must point directly at an image file (JPEG/PNG/WebP/GIF)',
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

mediaRoutes.post('/ingest', requireAdmin, async (c) => {
  await rateLimit(c, 'media_ingest', 60, 3600);
  const body = (await c.req.json().catch(() => ({}))) as { urls?: unknown; url?: unknown };
  const raw = Array.isArray(body.urls) ? body.urls : body.url !== undefined ? [body.url] : [];
  if (raw.length === 0) throw badRequest('Provide one or more image URLs');
  if (raw.length > MAX_PER_CALL) throw badRequest(`At most ${MAX_PER_CALL} image URLs per request`);

  const urls = raw.map((u, i) => str(u, `urls[${i}]`, { min: 8, max: 2000 }));
  const results: IngestResult[] = [];
  for (const u of urls) results.push(await ingestImageUrl(c.env, u));

  const user = c.get('user');
  await audit(c.env.DB, user?.id ?? null, 'media.ingest', 'products/import', {
    requested: urls.length,
    stored: results.filter((r) => r.status === 'stored').length,
  });

  return c.json({ success: true, results });
});
