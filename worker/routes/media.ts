import { Hono } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { requireAdmin, badRequest, notFound, str, unavailable } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { validateOutboundUrl } from '../lib/fetchGuard';
import { sniff } from './uploads';
import { extractPageImages, imageCandidates, isVendorHost } from '../lib/pageImages';
import { buildMediaKey, headMediaObject, isSafeMediaKey, mediaBucket, probeMediaBucket, putMediaObject, storeMedia } from '../lib/mediaStorage';
import { IMAGE_SOURCE_CAP, IMAGE_SOURCE_CAP_MB, isConvertibleToWebp } from '../lib/imageConvert';
import { currentMediaReferences, hasDedicatedBucket, inventoryLegacyMedia, planLegacyMediaKey } from '../lib/mediaMigration';
import { rasterDimensions, validRasterDimensions } from '../lib/imageMetadata';
import { newId } from '../lib/crypto';

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
/**
 * ONE CONSTANT, SHARED WITH THE ZIP HALF OF THE IMPORT.
 *
 * This was 4 MB while `adminImport.ts` allowed 8, so one import run could
 * accept a photograph supplied as a ZIP entry and refuse the identical
 * photograph supplied as a URL — the same two-numbers-for-one-rule problem the
 * import fix set out to remove, pointing the other way. See
 * `IMAGE_SOURCE_CAP` in worker/lib/imageConvert.ts for why it lives there.
 */
const IMAGE_CAP = IMAGE_SOURCE_CAP;
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
      return { source_url: sourceUrl, status: 'failed', reason: `Image exceeds the ${IMAGE_SOURCE_CAP_MB} MB limit` };
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

    /**
     * THE BIGGEST SOURCE OF UNCONVERTED IMAGES ON THE WHOLE SITE.
     *
     * This stored a vendor's PNG or JPEG byte-for-byte under
     * `products/import/<sha>.<ext>` — three segments where the layout is four,
     * and no conversion at all, because `imageConvert` was never imported
     * here. An import of one vendor page can pull in forty pictures, so a
     * single admin action wrote forty unconverted files.
     *
     * THE HASH STILL NAMES THE OBJECT, and that is worth keeping: it is the
     * digest of the bytes as they ARRIVED, so fetching the same vendor image
     * twice still recognises it and skips the second write. Hashing the
     * CONVERTED bytes instead would look tidier and would defeat the
     * deduplication, because a conversion is not guaranteed to be
     * byte-identical between runs.
     *
     * The `head` probe cannot know the stored extension before conversion, so
     * it asks for the WebP first — the shape every convertible image now takes
     * — and falls back to the arrival extension for the formats that pass
     * through (GIF, AVIF). Two cheap HEADs against forty avoided downloads.
     */
    const digest = await crypto.subtle.digest('SHA-256', buf as unknown as BufferSource);
    const sha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const converted = isConvertibleToWebp(kind.mime);
    const probeExt = converted ? 'webp' : kind.ext;
    const probeKey = `products/import/gallery/${sha}.${probeExt}`;

    const existing = await headMediaObject(env, 'public', probeKey);
    if (existing) return { source_url: sourceUrl, key: probeKey, url: `/files/${probeKey}`, status: 'stored' };

    const stored = await storeMedia(env, {
      placement: { visibility: 'public', domain: 'products', entityId: 'import', kind: 'gallery', objectId: sha },
      bytes: buf,
      mime: kind.mime,
      originalName: new URL(sourceUrl).pathname.split('/').pop() ?? null,
      cacheControl: 'public, max-age=31536000, immutable',
    });
    return { source_url: sourceUrl, key: stored.key, url: `/files/${stored.key}`, status: 'stored' };
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

// ------------------------------------------------------- safe R2 migration

/**
 * Read-only, cursor-based inventory. It names orphan CANDIDATES but never
 * deletes them; every known DB/JSON reference source is considered first.
 */
mediaRoutes.get('/migration/inventory', requireAdmin, async (c) => {
  await rateLimit(c, 'media_migration_inventory', 30, 3600);
  if (!c.env.BUCKET) throw unavailable('Legacy R2 binding is not configured', 'R2_NOT_CONFIGURED');
  const cursor = c.req.query('cursor') || undefined;
  const limitRaw = Number(c.req.query('limit') || 250);
  const page = await inventoryLegacyMedia(c.env, cursor, Number.isInteger(limitRaw) ? limitRaw : 250);
  return c.json({ success: true, dry_run: true, ...page });
});

/**
 * IS THE MIGRATION FINISHED, AND ARE THE DEDICATED BUCKETS REAL?
 *
 * Read-only. It answers the two questions a bucket move creates and that
 * nothing else in the product can answer.
 *
 * 1. DOES THE BUCKET EACH BINDING NAMES ACTUALLY EXIST. A wrangler config
 *    naming a bucket nobody created deploys perfectly happily — a bucket name
 *    is not checked against the account — and then fails per request, at the
 *    first R2 call. `probeMediaBucket` asks R2 directly instead of trusting
 *    the config, so an unprovisioned binding is visible BEFORE a customer
 *    finds it.
 *
 * 2. HOW MUCH IS STILL ONLY IN THE LEGACY BUCKET. That is exactly what the
 *    read-through fallback in `mediaStorage.ts` is covering for, so when this
 *    reaches zero the `media_legacy_fallback` log goes quiet and the legacy
 *    bucket has stopped being load-bearing.
 *
 * Bounded like the inventory: one cursor-driven page per call, and the
 * per-object destination check is capped, so a status call can never turn into
 * a full-bucket scan. `complete` is null — not false — for a partial page,
 * because a page that is not the whole bucket cannot support either answer.
 */
mediaRoutes.get('/migration/status', requireAdmin, async (c) => {
  await rateLimit(c, 'media_migration_status', 120, 3600);
  if (!c.env.BUCKET) throw unavailable('Legacy R2 binding is not configured', 'R2_NOT_CONFIGURED');

  const [publicBucket, privateBucket] = await Promise.all([
    probeMediaBucket(c.env, 'public'),
    probeMediaBucket(c.env, 'private'),
  ]);

  const cursor = c.req.query('cursor') || undefined;
  const limitRaw = Number(c.req.query('limit') || 50);
  const limit = Number.isInteger(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50;
  const page = await c.env.BUCKET.list({ cursor, limit });

  const objects: Array<{ key: string; size: number; visibility: string; copied: boolean }> = [];
  let pendingBytes = 0;
  for (const object of page.objects) {
    const plan = planLegacyMediaKey(object.key, true);
    // The destination key is the SOURCE key: `buildMediaKey` deliberately does
    // not encode visibility into the path, so a copy between buckets keeps
    // every database reference valid. `plan.destinationKey` differs only for
    // the UIUx/* rename, which is the apply endpoint's job because it has to
    // rewrite settings in the same D1 batch.
    let copied = false;
    if (publicBucket.reachable && privateBucket.reachable) {
      copied = (await mediaBucket(c.env, plan.visibility).head(object.key)) !== null;
    }
    if (!copied) pendingBytes += object.size;
    objects.push({ key: object.key, size: object.size, visibility: plan.visibility, copied });
  }

  const wholeBucket = !cursor && !page.truncated;
  const pending = objects.filter((o) => !o.copied).length;
  return c.json({
    success: true,
    dry_run: true,
    buckets: { public: publicBucket, private: privateBucket },
    legacy: {
      checked: objects.length,
      still_only_in_legacy: pending,
      already_copied: objects.length - pending,
      pending_bytes: pendingBytes,
      cursor: page.truncated ? page.cursor : null,
      truncated: page.truncated,
      objects,
    },
    // Never claim "finished" from a partial page, and never from a bucket the
    // destination probe could not even reach.
    complete:
      wholeBucket && publicBucket.reachable && privateBucket.reachable ? pending === 0 : null,
  });
});

function replaceExactMedia(value: unknown, oldKey: string, newKey: string): unknown {
  const oldUrl = `/files/${oldKey}`;
  const newUrl = `/files/${newKey}`;
  if (typeof value === 'string') return value === oldKey ? newKey : value === oldUrl ? newUrl : value;
  if (Array.isArray(value)) return value.map((item) => replaceExactMedia(item, oldKey, newKey));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, replaceExactMedia(v, oldKey, newKey)]));
  }
  return value;
}

async function convertedWebp(env: Env, oldKey: string): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  if (!env.APP_ORIGIN) throw unavailable('APP_ORIGIN is required for Cloudflare image conversion', 'MEDIA_TRANSFORM_NOT_CONFIGURED');
  const origin = new URL(env.APP_ORIGIN).origin;
  const encoded = oldKey.split('/').map(encodeURIComponent).join('/');
  const init = {
    redirect: 'error',
    cf: { image: { format: 'webp', quality: 87, fit: 'scale-down', width: 3000 } },
  } as RequestInit & { cf: { image: Record<string, string | number> } };
  const response = await fetch(`${origin}/files/${encoded}`, init);
  if (!response.ok) throw unavailable(`Image transform failed with HTTP ${response.status}`, 'MEDIA_TRANSFORM_UNAVAILABLE');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > IMAGE_CAP) throw badRequest(`Converted image exceeds the ${IMAGE_SOURCE_CAP_MB} MB migration limit`);
  const kind = sniff(bytes);
  const dimensions = kind?.mime === 'image/webp' ? rasterDimensions(bytes, kind.mime) : null;
  if (kind?.mime !== 'image/webp' || !validRasterDimensions(dimensions)) {
    // If Image Resizing is not enabled Cloudflare may return the original PNG.
    // Nothing is written and references remain untouched.
    throw unavailable('Cloudflare returned no valid WebP; enable Image Resizing before applying conversion', 'MEDIA_TRANSFORM_UNAVAILABLE');
  }
  return { bytes, width: dimensions.width, height: dimensions.height };
}

/**
 * Copy one referenced object to its dedicated bucket, or convert a referenced
 * product PNG/JPEG to WebP. `confirm:true` is mandatory; the default response
 * is a dry-run plan. The old object is NEVER deleted here.
 */
mediaRoutes.post('/migration/apply', requireAdmin, async (c) => {
  await rateLimit(c, 'media_migration_apply', 40, 3600);
  if (!c.env.BUCKET) throw unavailable('Legacy R2 binding is not configured', 'R2_NOT_CONFIGURED');
  const body = (await c.req.json().catch(() => ({}))) as { key?: unknown; confirm?: unknown };
  const key = str(body.key, 'key', { min: 5, max: 500 });
  if (!isSafeMediaKey(key)) throw badRequest('Unsafe media key');
  const refs = await currentMediaReferences(c.env.DB);
  const plan = planLegacyMediaKey(key, refs.has(key));
  if (plan.action === 'orphan_candidate' || plan.action === 'manual_review') {
    return c.json({ success: true, dry_run: true, plan, applied: false });
  }
  if (body.confirm !== true) return c.json({ success: true, dry_run: true, plan, applied: false });
  if (!hasDedicatedBucket(c.env, plan.visibility)) {
    throw unavailable(`The ${plan.visibility} R2 binding is not provisioned`, 'MEDIA_BUCKET_NOT_CONFIGURED');
  }

  const oldObject = await c.env.BUCKET.get(key);
  if (!oldObject) throw notFound('Legacy media object not found');
  const actor = c.get('user')!;

  if (plan.action === 'copy') {
    const bytes = await oldObject.arrayBuffer();
    const mime = oldObject.httpMetadata?.contentType || sniff(new Uint8Array(bytes))?.mime || 'application/octet-stream';
    const targetKey = plan.destinationKey;
    await putMediaObject(
      c.env,
      {
        key: targetKey,
        visibility: plan.visibility,
        domain: plan.domain,
        mime,
        bytes: bytes.byteLength,
      },
      bytes,
      { httpMetadata: { ...oldObject.httpMetadata, contentType: mime } }
    );
    const verified = await mediaBucket(c.env, plan.visibility).head(targetKey);
    if (!verified || verified.size !== bytes.byteLength) throw unavailable('Destination verification failed', 'MEDIA_VERIFY_FAILED');
    try {
      const statements: D1PreparedStatement[] = [];
      // The existing UIUx/Animation|Icons|Logo folders are copied into the
      // canonical public ui/levonis/* taxonomy. Settings are their source of
      // truth, so update exact references only; unrelated text is untouched.
      //
      // THE TABLE IS `admin_settings`, AND THERE HAS NEVER BEEN A BARE
      // `settings`. migrations/0001_init.sql:332 creates `admin_settings(key,
      // value)` and no migration in the repository creates anything else whose
      // name ends in `settings`. These two statements said `settings`, which
      // means this branch threw `no such table: settings` on every run — and
      // unlike the swallowed read in mediaMigration.ts, this throw is caught by
      // the handler below, which DELETES the object it has just copied and
      // returns a 500. So the UIUx/* → ui/levonis/* rename never once
      // completed: it copied, failed, rolled back, and reported nothing the
      // admin could act on. The rename only reaches this branch when
      // `targetKey !== key`, which is precisely the brand folder — the shop's
      // own logo and its service icons.
      if (targetKey !== key) {
        const { results: settings } = await c.env.DB.prepare('SELECT key, value FROM admin_settings').all<{ key: string; value: string }>();
        for (const setting of settings ?? []) {
          if (!setting.value.includes(key)) continue;
          let value: unknown = setting.value;
          try { value = JSON.parse(setting.value); } catch { /* a plain setting */ }
          const before = typeof value === 'string' ? value : JSON.stringify(value);
          const nextValue = replaceExactMedia(value, key, targetKey);
          const serialized = typeof nextValue === 'string' ? nextValue : JSON.stringify(nextValue);
          if (serialized !== before) {
            statements.push(c.env.DB.prepare('UPDATE admin_settings SET value = ? WHERE key = ?').bind(serialized, setting.key));
          }
        }
      }
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO file_migration_log (id, old_key, new_key, action, state, actor_id)
           VALUES (?, ?, ?, 'copy', 'verified_pending_cleanup', ?)`
        ).bind(newId('mm'), key, targetKey, actor.id)
      );
      await c.env.DB.batch(statements);
    } catch (error) {
      if (targetKey !== key) await mediaBucket(c.env, plan.visibility).delete(targetKey).catch(() => {});
      throw error;
    }
    await audit(c.env.DB, actor.id, 'media.migration.copy', key, {
      new_key: targetKey,
      visibility: plan.visibility,
      bytes: bytes.byteLength,
    });
    return c.json({ success: true, dry_run: false, applied: true, old_key: key, new_key: targetKey, old_deleted: false });
  }

  const rows = await c.env.DB.prepare(
    'SELECT product_id FROM product_images WHERE r2_key = ? OR url = ?'
  ).bind(key, `/files/${key}`).all<{ product_id: string }>();
  const productIds = [...new Set((rows.results ?? []).map((row) => row.product_id).filter(Boolean))];
  if (productIds.length === 0) throw badRequest('No product image row references this object; manual review required');

  const converted = await convertedWebp(c.env, key);
  const digest = await crypto.subtle.digest('SHA-256', converted.bytes as unknown as BufferSource);
  const objectId = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
  const entityId = productIds.length === 1 ? productIds[0] : 'shared';
  const newKey = buildMediaKey({
    visibility: 'public',
    domain: 'products',
    entityId,
    kind: 'gallery',
    extension: 'webp',
    objectId,
  });
  await putMediaObject(
    c.env,
    {
      key: newKey,
      visibility: 'public',
      domain: 'products',
      mime: 'image/webp',
      bytes: converted.bytes.byteLength,
      entityId,
      width: converted.width,
      height: converted.height,
    },
    converted.bytes,
    { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' } }
  );
  const verified = await mediaBucket(c.env, 'public').head(newKey);
  if (!verified || verified.size !== converted.bytes.byteLength) {
    await mediaBucket(c.env, 'public').delete(newKey).catch(() => {});
    throw unavailable('Converted object verification failed', 'MEDIA_VERIFY_FAILED');
  }

  try {
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `UPDATE product_images
            SET url = ?, r2_key = ?, content_type = 'image/webp', bytes = ?, width = ?, height = ?
          WHERE r2_key = ? OR url = ?`
      ).bind(`/files/${newKey}`, newKey, converted.bytes.byteLength, converted.width, converted.height, key, `/files/${key}`),
    ];
    for (const productId of productIds) {
      const product = await c.env.DB.prepare(
        'SELECT images, options, colors, description_images FROM products WHERE id = ?'
      ).bind(productId).first<Record<string, unknown>>();
      if (!product) continue;
      const next = ['images', 'options', 'colors', 'description_images'].map((column) => {
        const raw = String(product[column] ?? '[]');
        try { return JSON.stringify(replaceExactMedia(JSON.parse(raw), key, newKey)); }
        catch { return raw; }
      });
      statements.push(
        c.env.DB.prepare(
          `UPDATE products SET images = ?, options = ?, colors = ?, description_images = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
        ).bind(...next, productId)
      );
    }
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO file_migration_log (id, old_key, new_key, action, state, actor_id)
         VALUES (?, ?, ?, 'convert_webp', 'verified_pending_cleanup', ?)`
      ).bind(newId('mm'), key, newKey, actor.id)
    );
    await c.env.DB.batch(statements);
  } catch (error) {
    await mediaBucket(c.env, 'public').delete(newKey).catch(() => {});
    throw error;
  }

  await audit(c.env.DB, actor.id, 'media.migration.convert_webp', key, {
    new_key: newKey,
    products: productIds,
    bytes: converted.bytes.byteLength,
  });
  return c.json({ success: true, dry_run: false, applied: true, old_key: key, new_key: newKey, old_deleted: false });
});
