import { Hono } from 'hono';
import { isPrinterProduct } from '../lib/printerIdentity';
import type { AppContext, Env } from '../lib/types';
import { safeParse } from '../lib/types';
import {
  requireAuth,
  requireAdmin,
  badRequest,
  notFound,
  conflict,
  unavailable,
  str,
  int,
  oneOf,
} from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { sniff } from './uploads';
import { getMediaObject, headMediaObject, putMediaObject } from '../lib/mediaStorage';

/**
 * Product reviews with evidence, admin quality scoring and the five printer
 * gift levels (final-phase mandate §5).
 *
 * Separation of concerns enforced here:
 *  - PUBLIC review moderation (reviews.status) is a different decision from
 *    REWARD approval (review_rewards.state). A published review can have a
 *    rejected reward and vice versa.
 *  - Quality score (1..5) is a usefulness rubric — it is NEVER derived from
 *    stars or sentiment, and approval never requires praise. The server
 *    computes only a deterministic eligibility CHECKLIST (delivered order,
 *    written detail, photos, video, Instagram evidence present); a human
 *    assigns the score with a written rubric reason.
 *  - Distinct ledgers: printer gifts live in gift_entitlements (UNIQUE per
 *    reward → per review), review points in points_awards with source_ref
 *    'review:<id>' + a deterministic wallet_transactions id. Purchase points
 *    and referral rewards use different source keys/tables and can never be
 *    minted from here.
 *  - Instagram evidence is PRIVATE: stored on review_rewards, served only to
 *    the owner and admins, and never included in any public payload.
 */

export const reviewRoutes = new Hono<AppContext>();
reviewRoutes.use('/admin/*', requireAdmin);

// ------------------------------------------------------------- constants

const MAX_PHOTOS = 6;
const MAX_BODY_CHARS = 4000;
/**
 * Deterministic "written detail" checklist threshold for the PRINTER reward
 * path (mandate §5: written detail + photos + video + Instagram evidence).
 * This is an eligibility fact shown to the admin, not a quality judgement —
 * the human rubric decision stays final. Rubric thresholds are decision
 * register row 5 material.
 */
const MIN_DETAIL_CHARS = 80;
const PAGE_SIZE = 10;

const IMAGE_MAX = 8 * 1024 * 1024;
const VIDEO_MAX = 40 * 1024 * 1024;

type GiftKind = 'accessory' | 'filament' | 'nozzle' | 'plate' | 'other';

/** Composition of each gift box level (owner catalog, mandate §5). */
const LEVEL_COMPOSITION: Record<number, GiftKind[]> = {
  1: ['accessory'],
  2: ['filament'],
  3: ['filament', 'accessory'],
  4: ['nozzle'],
  5: ['nozzle', 'plate'],
};

// --------------------------------------------------------------- helpers

interface InstagramEvidence {
  link: string;
  key: string;
}

interface EligibilityFacts {
  order_id: string;
  order_item_id: string;
  delivered_at: string | null;
  unit_delivered: boolean;
  is_printer: boolean;
  photos: number;
  has_video: boolean;
  has_instagram: boolean;
  text_chars: number;
}

interface MediaEntry {
  key: string;
  kind: 'image' | 'video';
}

/**
 * Per-review point value for NON-printer approved reviews. Read generically
 * from admin_settings key 'reviewPointsConfig' — no invented number: a
 * missing/disabled/invalid config returns null and the award path renders an
 * honest not-configured state. (Key registration in worker/lib/settings.ts
 * SETTING_DEFAULTS is an orchestrator integration step; this reader works
 * with or without it.)
 */
export async function getReviewPointsValue(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT value FROM admin_settings WHERE key = 'reviewPointsConfig'")
    .first<{ value: string }>();
  if (!row) return null;
  const v = safeParse<unknown>(row.value, null);
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (v && typeof v === 'object') {
    const o = v as { enabled?: unknown; points?: unknown };
    if (o.enabled === true && typeof o.points === 'number' && Number.isInteger(o.points) && o.points > 0) {
      return o.points;
    }
  }
  return null;
}

/** Masked reviewer display name — never the full identity. */
export function maskName(name: string | null, username: string | null): string {
  const src = String(name ?? '').trim() || String(username ?? '').trim();
  if (!src) return 'Levonis';
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return `${parts[0]} ${parts[1].charAt(0)}.`;
  const p = parts[0];
  return p.length <= 2 ? p : `${p.slice(0, 2)}***`;
}

function parseEvidence(raw: unknown): InstagramEvidence | null {
  const v = safeParse<Partial<InstagramEvidence> | null>(raw, null);
  if (!v || (typeof v.link !== 'string' && typeof v.key !== 'string')) return null;
  const link = typeof v.link === 'string' ? v.link : '';
  const key = typeof v.key === 'string' ? v.key : '';
  if (!link && !key) return null;
  return { link, key };
}

function mediaUrl(key: string): string {
  return `/api/reviews/media/${key}`;
}

function publicMedia(raw: unknown): Array<{ url: string; kind: 'image' | 'video' }> {
  const list = safeParse<MediaEntry[]>(raw, []);
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && typeof m.key === 'string')
    .map((m) => ({ url: mediaUrl(m.key), kind: m.kind === 'video' ? 'video' : 'image' }));
}

async function assertOwnKeys(env: Env, keys: string[], prefix: string): Promise<void> {
  for (const key of keys) {
    if (!key.startsWith(prefix) || key.includes('..')) {
      throw badRequest('Invalid media reference', 'BAD_MEDIA_KEY');
    }
    const head = await headMediaObject(env, 'private', key);
    if (!head) throw badRequest('Uploaded file not found — please re-upload', 'MEDIA_MISSING');
  }
}

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('UNIQUE') || msg.includes('PRIMARY KEY');
}

function isCheckViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('CHECK');
}

/** Unbiased random index via WebCrypto. */
function randomIndex(n: number): number {
  if (n <= 1) return 0;
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / n) * n;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

// ---------------------------------------------------- review submission

interface ReviewInput {
  productId: string;
  orderId: string;
  stars: number;
  body: string;
  media: MediaEntry[];
  evidence: InstagramEvidence | null;
}

async function parseReviewInput(
  c: { env: Env },
  userId: string,
  raw: Record<string, unknown>,
  /** On EDIT: omitted fields keep what the review already has (never a silent wipe). */
  existing?: { media: MediaEntry[]; evidence: InstagramEvidence | null }
): Promise<ReviewInput> {
  const productId = str(raw.productId, 'productId', { min: 1, max: 60 });
  const orderId = str(raw.orderId, 'orderId', { min: 1, max: 60 });
  const stars = int(raw.stars, 'stars', { min: 1, max: 5 });
  const body = str(raw.body, 'body', { min: 1, max: MAX_BODY_CHARS });

  const mediaPrefix = `reviews/${userId}/`;
  let photos: MediaEntry[];
  if (raw.photoKeys === undefined && existing) {
    photos = existing.media.filter((m) => m.kind === 'image');
  } else {
    const photoKeys: string[] = Array.isArray(raw.photoKeys) ? raw.photoKeys.map(String).slice(0, MAX_PHOTOS) : [];
    await assertOwnKeys(c.env, photoKeys, mediaPrefix);
    photos = photoKeys.map((k): MediaEntry => ({ key: k, kind: 'image' }));
  }
  let videoEntry: MediaEntry | null;
  if (raw.videoKey === undefined && existing) {
    videoEntry = existing.media.find((m) => m.kind === 'video') ?? null;
  } else {
    const videoKey = str(raw.videoKey, 'videoKey', { max: 300, required: false });
    if (videoKey) await assertOwnKeys(c.env, [videoKey], mediaPrefix);
    videoEntry = videoKey ? { key: videoKey, kind: 'video' } : null;
  }
  const media: MediaEntry[] = [...photos, ...(videoEntry ? [videoEntry] : [])];

  // Instagram evidence: PRIVATE link and/or uploaded capture. Stories expire,
  // so an uploaded screenshot/recording is the durable form — both accepted.
  let evidence: InstagramEvidence | null = null;
  const igRaw = raw.instagram;
  if (igRaw === undefined && existing) {
    evidence = existing.evidence;
  } else if (igRaw && typeof igRaw === 'object') {
    const ig = igRaw as { link?: unknown; key?: unknown };
    const link = str(ig.link, 'instagram.link', { max: 300, required: false });
    if (link && !/^https?:\/\//i.test(link)) {
      throw badRequest('Instagram evidence link must be a URL', 'BAD_EVIDENCE_LINK');
    }
    const key = str(ig.key, 'instagram.key', { max: 300, required: false });
    if (key) await assertOwnKeys(c.env, [key], `reviews-evidence/${userId}/`);
    if (link || key) evidence = { link, key };
  }

  return { productId, orderId, stars, body, media, evidence };
}

async function computeFacts(
  db: D1Database,
  userId: string,
  input: ReviewInput
): Promise<EligibilityFacts> {
  const order = await db
    .prepare(
      `SELECT o.id, o.delivered_at, o.status, oi.id AS order_item_id
         FROM orders o JOIN order_items oi ON oi.order_id = o.id AND oi.product_id = ?
        WHERE o.id = ? AND o.user_id = ?
        LIMIT 1`
    )
    .bind(input.productId, input.orderId, userId)
    .first<{ id: string; delivered_at: string | null; status: string; order_item_id: string }>();
  if (!order) throw notFound('Order not found or it does not contain this product');
  const delivered = !!order.delivered_at || order.status === 'delivered';
  if (!delivered) {
    throw badRequest('You can review this product after your order is delivered', 'ORDER_NOT_DELIVERED');
  }
  const unit = await db
    .prepare('SELECT 1 AS x FROM order_item_units WHERE order_item_id = ? AND delivered_at IS NOT NULL LIMIT 1')
    .bind(order.order_item_id)
    .first();
  return {
    order_id: order.id,
    order_item_id: order.order_item_id,
    delivered_at: order.delivered_at,
    unit_delivered: !!unit,
    is_printer: await isPrinterProduct(db, input.productId),
    photos: input.media.filter((m) => m.kind === 'image').length,
    has_video: input.media.some((m) => m.kind === 'video'),
    has_instagram: !!input.evidence,
    text_chars: input.body.length,
  };
}

/**
 * POST /api/reviews — create a review for a delivered, owned order.
 * One review per (user, product): DB UNIQUE from 0003 (stricter than
 * one-per-order — documented). A review_rewards row is created with it
 * (kind by printer-catalog membership) in the same atomic batch.
 */
reviewRoutes.post('/', requireAuth, async (c) => {
  await rateLimit(c, 'review_submit', 10, 3600);
  const user = c.get('user')!;
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = await parseReviewInput(c, user.id, raw);
  const facts = await computeFacts(c.env.DB, user.id, input);

  const reviewId = newId('rev');
  const rewardId = newId('rr');
  const now = new Date().toISOString();
  const kind = facts.is_printer ? 'printer_gift' : 'points';

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO reviews (id, user_id, product_id, order_item_id, order_id, stars, body, media, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).bind(
        reviewId, user.id, input.productId, facts.order_item_id, input.orderId,
        input.stars, input.body, JSON.stringify(input.media), now
      ),
      c.env.DB.prepare(
        `INSERT INTO review_rewards (id, review_id, user_id, kind, instagram_evidence, eligibility, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?)`
      ).bind(
        rewardId, reviewId, user.id, kind,
        input.evidence ? JSON.stringify(input.evidence) : '',
        JSON.stringify(facts), now
      ),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw conflict('You already reviewed this product — you can edit your pending review instead');
    }
    console.error('review insert failed', e instanceof Error ? e.message : e);
    throw badRequest('Review could not be saved. Please try again.');
  }

  return c.json({ success: true, review: await loadMyReview(c.env.DB, user.id, reviewId) });
});

/**
 * PUT /api/reviews/:id — edit the OWN review while it is still pending and
 * its reward is undecided (submitted/revision_needed). Editing resubmits the
 * reward for evaluation; it can never duplicate rewards because approval
 * paths are keyed UNIQUE per review (gift_entitlements.reward_id,
 * points_awards.source_ref).
 */
reviewRoutes.put('/:id', requireAuth, async (c) => {
  await rateLimit(c, 'review_submit', 10, 3600);
  const user = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const existing = await c.env.DB.prepare(
    `SELECT r.id, r.user_id, r.status, r.product_id, r.order_id, r.media,
            rr.id AS reward_id, rr.state AS reward_state, rr.instagram_evidence
       FROM reviews r JOIN review_rewards rr ON rr.review_id = r.id
      WHERE r.id = ?`
  )
    .bind(id)
    .first<{ id: string; user_id: string; status: string; product_id: string; order_id: string | null; media: string; reward_id: string; reward_state: string; instagram_evidence: string }>();
  if (!existing || existing.user_id !== user.id) throw notFound('Review not found');
  if (existing.status !== 'pending' || !['submitted', 'revision_needed'].includes(existing.reward_state)) {
    throw conflict('This review has already been decided and can no longer be edited');
  }

  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // Product/order identity of a review is immutable — only content changes.
  raw.productId = existing.product_id;
  raw.orderId = existing.order_id ?? String(raw.orderId ?? '');
  const input = await parseReviewInput(c, user.id, raw, {
    media: safeParse<MediaEntry[]>(existing.media, []),
    evidence: parseEvidence(existing.instagram_evidence),
  });
  const facts = await computeFacts(c.env.DB, user.id, input);
  const now = new Date().toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE reviews SET stars = ?, body = ?, media = ?, order_id = ?, order_item_id = ?
        WHERE id = ? AND user_id = ? AND status = 'pending'`
    ).bind(input.stars, input.body, JSON.stringify(input.media), input.orderId, facts.order_item_id, id, user.id),
    c.env.DB.prepare(
      `UPDATE review_rewards SET instagram_evidence = ?, eligibility = ?, state = 'submitted', decided_by = NULL, decided_at = NULL
        WHERE id = ? AND state IN ('submitted','revision_needed')`
    ).bind(input.evidence ? JSON.stringify(input.evidence) : '', JSON.stringify(facts), existing.reward_id),
  ]);
  void now;
  return c.json({ success: true, review: await loadMyReview(c.env.DB, user.id, id) });
});

async function loadMyReview(db: D1Database, userId: string, reviewId: string) {
  const row = await db
    .prepare(
      `SELECT r.*, rr.kind, rr.state AS reward_state, rr.quality_score, rr.reason AS reward_reason,
              rr.points_awarded, rr.instagram_evidence,
              p.name AS product_name, p.name_ar AS product_name_ar, p.slug AS product_slug
         FROM reviews r
         JOIN review_rewards rr ON rr.review_id = r.id
         LEFT JOIN products p ON p.id = r.product_id
        WHERE r.id = ? AND r.user_id = ?`
    )
    .bind(reviewId, userId)
    .first<Record<string, unknown>>();
  return row ? myReviewView(row) : null;
}

function myReviewView(r: Record<string, unknown>) {
  const evidence = parseEvidence(r.instagram_evidence);
  return {
    id: r.id,
    product_id: r.product_id,
    product_name: r.product_name,
    product_name_ar: r.product_name_ar,
    product_slug: r.product_slug,
    order_id: r.order_id ?? null,
    stars: r.stars,
    body: r.body,
    media: publicMedia(r.media),
    status: r.status, // pending | published | rejected
    moderation_note: r.moderation_note ?? '',
    created_at: r.created_at,
    reward: {
      kind: r.kind,
      state: r.reward_state,
      quality_score: r.quality_score ?? null,
      reason: r.reward_reason ?? '',
      points_awarded: Number(r.points_awarded) || 0,
      // Own evidence back to its owner only — never in public payloads.
      instagram: evidence
        ? { link: evidence.link, file_url: evidence.key ? mediaUrl(evidence.key) : null }
        : null,
    },
  };
}

/** GET /api/reviews/mine — the signed-in user's reviews with reward state. */
reviewRoutes.get('/mine', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, rr.kind, rr.state AS reward_state, rr.quality_score, rr.reason AS reward_reason,
            rr.points_awarded, rr.instagram_evidence,
            p.name AS product_name, p.name_ar AS product_name_ar, p.slug AS product_slug
       FROM reviews r
       JOIN review_rewards rr ON rr.review_id = r.id
       LEFT JOIN products p ON p.id = r.product_id
      WHERE r.user_id = ?
      ORDER BY r.created_at DESC LIMIT 100`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  return c.json({ success: true, reviews: results.map(myReviewView) });
});

/**
 * GET /api/reviews/eligibility/:productId — can the signed-in user review
 * this product? Returns their delivered orders containing it, any existing
 * review, whether the printer-gift path applies and the honest state of the
 * review-points configuration (no invented values).
 */
reviewRoutes.get('/eligibility/:productId', requireAuth, async (c) => {
  const user = c.get('user')!;
  const productId = c.req.param('productId') ?? '';
  const { results: orders } = await c.env.DB.prepare(
    `SELECT DISTINCT o.id, o.delivered_at, o.created_at
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = ? AND oi.product_id = ?
        AND (o.delivered_at IS NOT NULL OR o.status = 'delivered')
      ORDER BY o.created_at DESC LIMIT 20`
  )
    .bind(user.id, productId)
    .all<{ id: string; delivered_at: string | null; created_at: string }>();
  const existing = await c.env.DB.prepare('SELECT id FROM reviews WHERE user_id = ? AND product_id = ?')
    .bind(user.id, productId)
    .first<{ id: string }>();
  const isPrinter = await isPrinterProduct(c.env.DB, productId);
  const points = isPrinter ? null : await getReviewPointsValue(c.env.DB);
  return c.json({
    success: true,
    eligible_orders: orders.map((o) => ({ id: o.id, delivered_at: o.delivered_at })),
    existing_review: existing ? await loadMyReview(c.env.DB, user.id, existing.id) : null,
    is_printer: isPrinter,
    // null = not configured (honest state); a number = configured award.
    review_points: points,
  });
});

// ------------------------------------------------------ public listing

/**
 * GET /api/reviews/product/:idOrSlug — approved (published) reviews only.
 * Masked reviewer names, incentivized-review disclosure flag, stars, text,
 * media. NO Instagram evidence, NO user ids, NO private data. Paginated.
 */
reviewRoutes.get('/product/:idOrSlug', async (c) => {
  const idOrSlug = c.req.param('idOrSlug') ?? '';
  const product = await c.env.DB.prepare('SELECT id FROM products WHERE id = ? OR slug = ?')
    .bind(idOrSlug, idOrSlug)
    .first<{ id: string }>();
  if (!product) throw notFound('Product not found');
  const page = Math.max(1, Math.min(1000, parseInt(c.req.query('page') || '1', 10) || 1));
  const offset = (page - 1) * PAGE_SIZE;

  const summary = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, AVG(stars) AS avg_stars FROM reviews WHERE product_id = ? AND status = 'published'`
  )
    .bind(product.id)
    .first<{ n: number; avg_stars: number | null }>();

  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.stars, r.body, r.media, r.created_at, r.order_id,
            u.name, u.username,
            (SELECT 1 FROM review_rewards rr WHERE rr.review_id = r.id LIMIT 1) AS has_reward
       FROM reviews r JOIN users u ON u.id = r.user_id
      WHERE r.product_id = ? AND r.status = 'published'
      ORDER BY r.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(product.id, PAGE_SIZE, offset)
    .all<Record<string, unknown>>();

  return c.json({
    success: true,
    product_id: product.id,
    total: Number(summary?.n) || 0,
    avg_stars: summary?.avg_stars != null ? Math.round(Number(summary.avg_stars) * 10) / 10 : null,
    page,
    page_size: PAGE_SIZE,
    reviews: results.map((r) => ({
      id: r.id,
      stars: r.stars,
      body: r.body,
      media: publicMedia(r.media),
      created_at: r.created_at,
      reviewer: maskName(r.name as string | null, r.username as string | null),
      // Reviews in the rewards program may receive a gift/points — disclosed.
      incentivized: !!r.has_reward,
      verified_purchase: !!r.order_id,
    })),
  });
});

// ------------------------------------------------------------- uploads

/**
 * POST /api/reviews/uploads — review media (photos/video, may become public
 * when the review is published) and Instagram evidence captures (always
 * private). Magic-byte sniffed; client MIME is never trusted. Keys are
 * owner-scoped; serving happens through GET /api/reviews/media/* below,
 * never through a public R2 domain.
 */
reviewRoutes.post('/uploads', requireAuth, async (c) => {
  await rateLimit(c, 'review_upload', 40, 3600);
  const user = c.get('user')!;
  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data');
  const purpose = oneOf(form.get('purpose'), 'purpose', ['media', 'evidence'] as const);
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file uploaded');
  if (file.size > VIDEO_MAX) throw badRequest(`File is too large (max ${Math.round(VIDEO_MAX / 1024 / 1024)} MB)`);

  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(buf);
  if (!kind) throw badRequest('Unsupported file type — please upload a JPEG, PNG, WebP or GIF image or an MP4 video');
  const isVideo = kind.mime.startsWith('video/');
  if (!isVideo && file.size > IMAGE_MAX) {
    throw badRequest(`Image is too large (max ${Math.round(IMAGE_MAX / 1024 / 1024)} MB)`);
  }

  const prefix = purpose === 'evidence' ? `reviews-evidence/${user.id}` : `reviews/${user.id}`;
  const key = `${prefix}/${newId()}.${kind.ext}`;
  await putMediaObject(
    c.env,
    {
      key,
      visibility: 'private',
      domain: purpose === 'evidence' ? 'reviews-evidence' : 'reviews',
      mime: kind.mime,
      bytes: buf.byteLength,
      ownerId: user.id,
      entityId: user.id,
      originalName: file.name,
    },
    buf,
    { httpMetadata: { contentType: kind.mime, cacheControl: 'private, max-age=300' } }
  );
  return c.json({ success: true, key, kind: isVideo ? 'video' : 'image', url: mediaUrl(key) });
});

/**
 * GET /api/reviews/media/* — authorized delivery of review media/evidence.
 *  - reviews-evidence/<uid>/…: owner or admin ONLY, never cached publicly.
 *  - reviews/<uid>/…: owner, admin, or anyone when the key belongs to a
 *    PUBLISHED review (public product-page media).
 */
reviewRoutes.get('/media/*', async (c) => {
  const marker = '/media/';
  const idx = c.req.path.indexOf(marker);
  const key = decodeURIComponent(c.req.path.slice(idx + marker.length));
  // Strict charset: our keys are hex ids under fixed prefixes. This also
  // keeps LIKE below literal (no %/_ wildcards can widen the match).
  if (!key || key.includes('..') || !/^[A-Za-z0-9/._-]+$/.test(key)) throw notFound();
  const user = c.get('user');

  let allowed = false;
  let isPublic = false;
  if (key.startsWith('reviews-evidence/')) {
    if (!user) throw notFound();
    allowed = key.startsWith(`reviews-evidence/${user.id}/`) || user.role === 'admin';
  } else if (key.startsWith('reviews/')) {
    if (user && (key.startsWith(`reviews/${user.id}/`) || user.role === 'admin')) {
      allowed = true;
    } else {
      const hit = await c.env.DB.prepare(
        `SELECT 1 AS x FROM reviews WHERE status = 'published' AND media LIKE ? LIMIT 1`
      )
        .bind(`%"${key}"%`)
        .first();
      allowed = !!hit;
      isPublic = allowed;
    }
  }
  if (!allowed) throw notFound();

  const obj = await getMediaObject(c.env, 'private', key);
  if (!obj) throw notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set(
    'Cache-Control',
    key.startsWith('reviews-evidence/') ? 'no-store' : isPublic ? 'public, max-age=3600' : 'private, max-age=300'
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(obj.body, { headers });
});

// ------------------------------------------------------- gift catalog

interface PoolItemRow {
  id: string;
  level: number;
  kind: GiftKind;
  label_ar: string;
  label_en: string;
  label_ckb: string;
  brand: string;
  material: string;
  color: string;
  option_value: string;
  compat_products: string;
  stock: number;
  active: number;
}

function itemFitsPrinter(item: PoolItemRow, printerProductId: string): boolean {
  const compat = safeParse<string[]>(item.compat_products, []);
  return Array.isArray(compat) && compat.includes(printerProductId);
}

function contentsSnapshot(item: PoolItemRow) {
  return {
    item_id: item.id,
    kind: item.kind,
    label_ar: item.label_ar,
    label_en: item.label_en,
    label_ckb: item.label_ckb,
    brand: item.brand,
    material: item.material,
    color: item.color,
    option_value: item.option_value,
  };
}

/**
 * Availability of one level for one entitlement, computed from live pool
 * stock. Never fabricates availability: unconfigured pools and unconfigured
 * nozzle/plate compatibility surface as explicit honest states.
 */
function levelAvailability(items: PoolItemRow[], level: number, printerProductId: string) {
  const pool = items.filter((i) => i.level === level && i.active === 1 && i.stock > 0);
  const composition = LEVEL_COMPOSITION[level] ?? [];
  const out: {
    level: number;
    available: boolean;
    reason: 'ok' | 'pool_unconfigured' | 'compat_unconfigured';
    nozzle_sizes: string[];
    plates: Array<{ id: string; label_ar: string; label_en: string; label_ckb: string; brand: string }>;
  } = { level, available: true, reason: 'ok', nozzle_sizes: [], plates: [] };

  for (const slot of composition) {
    const slotItems = pool.filter((i) => i.kind === slot);
    if (slotItems.length === 0) {
      out.available = false;
      out.reason = 'pool_unconfigured';
      continue;
    }
    if (slot === 'nozzle' || slot === 'plate') {
      const compatible = slotItems.filter((i) => itemFitsPrinter(i, printerProductId));
      if (compatible.length === 0) {
        out.available = false;
        if (out.reason === 'ok') out.reason = 'compat_unconfigured';
        continue;
      }
      if (slot === 'nozzle') {
        out.nozzle_sizes = [...new Set(compatible.map((i) => i.option_value).filter(Boolean))];
        if (out.nozzle_sizes.length === 0) {
          out.available = false;
          if (out.reason === 'ok') out.reason = 'pool_unconfigured'; // nozzles without a size are not selectable
        }
      } else {
        out.plates = compatible.map((i) => ({
          id: i.id, label_ar: i.label_ar, label_en: i.label_en, label_ckb: i.label_ckb, brand: i.brand,
        }));
      }
    }
  }
  return out;
}

async function loadEntitlement(db: D1Database, entitlementId: string) {
  return db
    .prepare(
      `SELECT ge.*, rr.review_id, r.product_id,
              p.name AS product_name, p.name_ar AS product_name_ar
         FROM gift_entitlements ge
         JOIN review_rewards rr ON rr.id = ge.reward_id
         JOIN reviews r ON r.id = rr.review_id
         LEFT JOIN products p ON p.id = r.product_id
        WHERE ge.id = ?`
    )
    .bind(entitlementId)
    .first<Record<string, unknown>>();
}

function entitlementView(ge: Record<string, unknown>, redemption: Record<string, unknown> | null) {
  return {
    id: ge.id,
    max_level: Number(ge.max_level),
    chosen_level: ge.chosen_level != null ? Number(ge.chosen_level) : null,
    chosen_options: safeParse(ge.chosen_options, {}),
    contents: safeParse(ge.contents, []),
    state: ge.state, // available | selected | fulfilled | cancelled
    created_at: ge.created_at,
    selected_at: ge.selected_at ?? null,
    fulfilled_at: ge.fulfilled_at ?? null,
    product: { id: ge.product_id, name: ge.product_name, name_ar: ge.product_name_ar },
    redeemed: !!redemption,
  };
}

/** GET /api/reviews/gifts — my entitlements with live level availability. */
reviewRoutes.get('/gifts', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results: ents } = await c.env.DB.prepare(
    `SELECT ge.*, rr.review_id, r.product_id,
            p.name AS product_name, p.name_ar AS product_name_ar
       FROM gift_entitlements ge
       JOIN review_rewards rr ON rr.id = ge.reward_id
       JOIN reviews r ON r.id = rr.review_id
       LEFT JOIN products p ON p.id = r.product_id
      WHERE ge.user_id = ?
      ORDER BY ge.created_at DESC LIMIT 50`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();

  const { results: items } = await c.env.DB.prepare(
    'SELECT * FROM gift_pool_items WHERE active = 1 AND stock > 0'
  ).all<PoolItemRow>();

  const { results: redemptions } = await c.env.DB.prepare(
    'SELECT * FROM gift_redemptions WHERE user_id = ?'
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  const redemptionByEnt = new Map(redemptions.map((r) => [String(r.entitlement_id), r]));

  return c.json({
    success: true,
    gifts: ents.map((ge) => {
      const maxLevel = Number(ge.max_level);
      const productId = String(ge.product_id ?? '');
      const levels =
        ge.state === 'available'
          ? Array.from({ length: maxLevel }, (_, i) => levelAvailability(items, i + 1, productId))
          : [];
      return { ...entitlementView(ge, redemptionByEnt.get(String(ge.id)) ?? null), levels };
    }),
  });
});

/**
 * POST /api/reviews/gifts/:entitlementId/redeem — choose exactly ONE box
 * with level L <= quality score. Contents are picked SERVER-side from real
 * in-stock pool rows, persisted once (gift_redemptions PK aborts replays)
 * and never rerolled; stock decrements atomically (CHECK stock >= 0 aborts
 * the whole batch on concurrent depletion).
 */
reviewRoutes.post('/gifts/:entitlementId/redeem', requireAuth, async (c) => {
  await rateLimit(c, 'gift_redeem', 10, 3600);
  const user = c.get('user')!;
  const entId = c.req.param('entitlementId') ?? '';
  const ge = await loadEntitlement(c.env.DB, entId);
  if (!ge || ge.user_id !== user.id) throw notFound('Gift not found');

  const existingRedemption = await c.env.DB.prepare('SELECT * FROM gift_redemptions WHERE entitlement_id = ?')
    .bind(entId)
    .first<Record<string, unknown>>();
  if (existingRedemption) {
    // Already redeemed — return the persisted selection, never reroll.
    const fresh = (await loadEntitlement(c.env.DB, entId))!;
    return c.json({ success: true, gift: entitlementView(fresh, existingRedemption), replay: true });
  }
  if (ge.state !== 'available') throw conflict('This gift can no longer be redeemed');

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const level = int(body.level, 'level', { min: 1, max: 5 });
  const maxLevel = Number(ge.max_level);
  if (level > maxLevel) {
    throw badRequest(`Your quality score unlocks boxes 1 to ${maxLevel} — box ${level} is locked`, 'LEVEL_LOCKED');
  }
  const opts = (body.options && typeof body.options === 'object' ? body.options : {}) as Record<string, unknown>;
  const nozzleSize = str(opts.nozzleSize, 'options.nozzleSize', { max: 20, required: false });
  const plateItemId = str(opts.plateItemId, 'options.plateItemId', { max: 60, required: false });

  const printerProductId = String(ge.product_id ?? '');
  const { results: pool } = await c.env.DB.prepare(
    'SELECT * FROM gift_pool_items WHERE level = ? AND active = 1 AND stock > 0'
  )
    .bind(level)
    .all<PoolItemRow>();

  const composition = LEVEL_COMPOSITION[level];
  const picks: PoolItemRow[] = [];
  for (const slot of composition) {
    const slotItems = pool.filter((i) => i.kind === slot);
    if (slotItems.length === 0) {
      throw unavailable(
        `The level ${level} gift pool is not stocked/configured yet — your gift stays reserved, please try later or contact support`,
        'GIFT_POOL_UNCONFIGURED'
      );
    }
    if (slot === 'nozzle') {
      const compatible = slotItems.filter((i) => itemFitsPrinter(i, printerProductId));
      if (compatible.length === 0) {
        throw unavailable(
          'Nozzle compatibility for your printer model is not configured yet — your gift stays reserved',
          'GIFT_COMPAT_UNCONFIGURED'
        );
      }
      const sizes = [...new Set(compatible.map((i) => i.option_value).filter(Boolean))];
      if (!nozzleSize) {
        throw badRequest(`Please choose a nozzle size (${sizes.join(', ')})`, 'NOZZLE_SIZE_REQUIRED');
      }
      const sized = compatible.filter((i) => i.option_value === nozzleSize);
      if (sized.length === 0) {
        throw badRequest(`Nozzle size not available — choose one of: ${sizes.join(', ')}`, 'NOZZLE_SIZE_UNAVAILABLE');
      }
      picks.push(sized[randomIndex(sized.length)]);
    } else if (slot === 'plate') {
      const compatible = slotItems.filter((i) => itemFitsPrinter(i, printerProductId));
      if (compatible.length === 0) {
        throw unavailable(
          'Plate compatibility for your printer model is not configured yet — your gift stays reserved',
          'GIFT_COMPAT_UNCONFIGURED'
        );
      }
      let plate: PoolItemRow | undefined;
      if (plateItemId) plate = compatible.find((i) => i.id === plateItemId);
      else if (compatible.length === 1) plate = compatible[0];
      if (!plate) throw badRequest('Please choose a plate from the available options', 'PLATE_CHOICE_REQUIRED');
      picks.push(plate);
    } else {
      // accessory / filament: random server-side pick from real stock.
      picks.push(slotItems[randomIndex(slotItems.length)]);
    }
  }

  const now = new Date().toISOString();
  const optionsJson = JSON.stringify({ nozzle_size: nozzleSize || null, plate_item_id: plateItemId || null });
  const contentsJson = JSON.stringify(picks.map(contentsSnapshot));

  const stmts = [
    // PK(entitlement_id): a concurrent/replayed redeem aborts the whole batch.
    c.env.DB.prepare(
      `INSERT INTO gift_redemptions (entitlement_id, user_id, level, options, contents, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(entId, user.id, level, optionsJson, contentsJson, now),
    ...picks.map((p) =>
      // CHECK (stock >= 0) aborts if another redemption took the last unit.
      c.env.DB.prepare('UPDATE gift_pool_items SET stock = stock - 1 WHERE id = ?').bind(p.id)
    ),
    c.env.DB.prepare(
      `UPDATE gift_entitlements SET state = 'selected', chosen_level = ?, chosen_options = ?, contents = ?, selected_at = ?
        WHERE id = ? AND state = 'available'`
    ).bind(level, optionsJson, contentsJson, now, entId),
  ];

  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    if (isUniqueViolation(e)) {
      const red = await c.env.DB.prepare('SELECT * FROM gift_redemptions WHERE entitlement_id = ?')
        .bind(entId)
        .first<Record<string, unknown>>();
      const fresh = (await loadEntitlement(c.env.DB, entId))!;
      return c.json({ success: true, gift: entitlementView(fresh, red), replay: true });
    }
    if (isCheckViolation(e)) {
      throw conflict('Gift stock changed while redeeming — nothing was consumed, please try again');
    }
    console.error('gift redeem failed', e instanceof Error ? e.message : e);
    throw badRequest('Redemption failed. Please try again.');
  }

  const fresh = (await loadEntitlement(c.env.DB, entId))!;
  const red = await c.env.DB.prepare('SELECT * FROM gift_redemptions WHERE entitlement_id = ?')
    .bind(entId)
    .first<Record<string, unknown>>();
  return c.json({ success: true, gift: entitlementView(fresh, red) });
});

// ---------------------------------------------------------- admin: queue

/**
 * GET /api/reviews/admin/queue — review/reward queue with deterministic
 * eligibility FACTS (delivered order, printer product, media present,
 * Instagram evidence present). Facts inform the human decision; they never
 * auto-decide anything.
 */
reviewRoutes.get('/admin/queue', async (c) => {
  const stateQ = c.req.query('state') || 'submitted';
  const allowed = ['submitted', 'revision_needed', 'approved', 'rejected', 'all'];
  const state = allowed.includes(stateQ) ? stateQ : 'submitted';

  const { results } = await c.env.DB.prepare(
    `SELECT r.id AS review_id, r.stars, r.body, r.media, r.status AS review_status, r.moderation_note,
            r.created_at, r.order_id, r.product_id,
            rr.id AS reward_id, rr.kind, rr.instagram_evidence, rr.eligibility, rr.quality_score,
            rr.state AS reward_state, rr.reason, rr.points_awarded, rr.decided_at, rr.decided_by,
            u.email, u.username,
            p.name AS product_name, p.name_ar AS product_name_ar,
            o.delivered_at AS order_delivered_at, o.status AS order_status,
            (SELECT ge.id FROM gift_entitlements ge WHERE ge.reward_id = rr.id) AS entitlement_id
       FROM reviews r
       JOIN review_rewards rr ON rr.review_id = r.id
       JOIN users u ON u.id = r.user_id
       LEFT JOIN products p ON p.id = r.product_id
       LEFT JOIN orders o ON o.id = r.order_id
      WHERE (?1 = 'all' OR rr.state = ?1)
      ORDER BY r.created_at ASC LIMIT 100`
  )
    .bind(state)
    .all<Record<string, unknown>>();

  // Live printer-catalog membership for the listed products (one query).
  const productIds = [...new Set(results.map((r) => String(r.product_id ?? '')).filter(Boolean))];
  const printerSet = new Set<string>();
  if (productIds.length > 0) {
    const { results: printers } = await c.env.DB.prepare(
      `SELECT DISTINCT pc.product_id FROM product_catalogs pc
         JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
        WHERE pc.product_id IN (${productIds.map(() => '?').join(',')})`
    )
      .bind(...productIds)
      .all<{ product_id: string }>();
    for (const p of printers) printerSet.add(p.product_id);
  }

  const queue = results.map((r) => {
    const media = safeParse<MediaEntry[]>(r.media, []);
    const evidence = parseEvidence(r.instagram_evidence);
    const photos = media.filter((m) => m.kind === 'image').length;
    const hasVideo = media.some((m) => m.kind === 'video');
    const delivered = !!r.order_delivered_at || r.order_status === 'delivered';
    const textChars = String(r.body ?? '').length;
    return {
      review_id: r.review_id,
      reward_id: r.reward_id,
      created_at: r.created_at,
      customer: { email: r.email, username: r.username },
      product: { id: r.product_id, name: r.product_name, name_ar: r.product_name_ar },
      order_id: r.order_id,
      stars: r.stars,
      body: r.body,
      media: publicMedia(r.media),
      review_status: r.review_status,
      moderation_note: r.moderation_note ?? '',
      kind: r.kind,
      reward_state: r.reward_state,
      quality_score: r.quality_score ?? null,
      reason: r.reason ?? '',
      points_awarded: Number(r.points_awarded) || 0,
      decided_at: r.decided_at ?? null,
      entitlement_id: r.entitlement_id ?? null,
      // Private evidence — this endpoint is admin-only.
      instagram: evidence
        ? { link: evidence.link, file_url: evidence.key ? mediaUrl(evidence.key) : null }
        : null,
      facts: {
        delivered,
        is_printer: printerSet.has(String(r.product_id ?? '')),
        photos,
        has_video: hasVideo,
        has_instagram: !!evidence,
        text_chars: textChars,
        written_detail: textChars >= MIN_DETAIL_CHARS,
        submitted_facts: safeParse<Partial<EligibilityFacts>>(r.eligibility, {}),
      },
    };
  });

  const pointsValue = await getReviewPointsValue(c.env.DB);
  return c.json({ success: true, state, queue, review_points_configured: pointsValue });
});

/**
 * POST /api/reviews/admin/:id/moderate — PUBLIC visibility decision only
 * (approve = publish, reject, request_changes). Entirely separate from the
 * reward decision below.
 */
reviewRoutes.post('/admin/:id/moderate', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = oneOf(body.action, 'action', ['approve', 'reject', 'request_changes'] as const);
  const reason = str(body.reason, 'reason', { max: 1000, required: action !== 'approve', min: action !== 'approve' ? 3 : 0 });

  const review = await c.env.DB.prepare('SELECT id, status FROM reviews WHERE id = ?').bind(id).first<{ id: string; status: string }>();
  if (!review) throw notFound('Review not found');

  const nextStatus = action === 'approve' ? 'published' : action === 'reject' ? 'rejected' : 'pending';
  await c.env.DB.prepare('UPDATE reviews SET status = ?, moderation_note = ? WHERE id = ?')
    .bind(nextStatus, reason, id)
    .run();
  await audit(c.env.DB, admin.id, 'review.moderate', id, { action, reason });
  return c.json({ success: true, review_id: id, status: nextStatus });
});

/**
 * POST /api/reviews/admin/:id/reward — reward decision (:id = review id).
 * approve (printer_gift): requires quality_score 1..5 + a written rubric
 *   reason; the deterministic checklist must pass. Creates ONE entitlement
 *   (max_level = score) — idempotent via UNIQUE(reward_id); a decided reward
 *   is never silently re-decided.
 * approve (points): awards the CONFIGURED review-point value through the
 *   points_awards guard (source_ref 'review:<id>') — honest 503 when the
 *   value is not configured.
 * reject / request_changes: reason required.
 */
reviewRoutes.post('/admin/:id/reward', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = oneOf(body.action, 'action', ['approve', 'reject', 'request_changes'] as const);

  const row = await c.env.DB.prepare(
    `SELECT r.id AS review_id, r.user_id, r.body, r.media, r.order_id, r.product_id,
            rr.id AS reward_id, rr.kind, rr.state, rr.instagram_evidence,
            o.delivered_at AS order_delivered_at, o.status AS order_status
       FROM reviews r
       JOIN review_rewards rr ON rr.review_id = r.id
       LEFT JOIN orders o ON o.id = r.order_id
      WHERE r.id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('Review not found');
  if (row.state === 'approved') {
    throw conflict('This reward was already approved — granted rewards are preserved, not re-decided');
  }
  const now = new Date().toISOString();

  if (action !== 'approve') {
    const reason = str(body.reason, 'reason', { min: 3, max: 1000 });
    const nextState = action === 'reject' ? 'rejected' : 'revision_needed';
    const res = await c.env.DB.prepare(
      `UPDATE review_rewards SET state = ?, reason = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state != 'approved'`
    )
      .bind(nextState, reason, admin.id, now, row.reward_id)
      .run();
    if (res.meta.changes === 0) throw conflict('Reward was already decided');
    await audit(c.env.DB, admin.id, 'review.reward', id, { action, reason });
    return c.json({ success: true, review_id: id, reward_state: nextState });
  }

  // ---- approve ----
  if (row.kind === 'printer_gift') {
    const score = int(body.qualityScore, 'qualityScore', { min: 1, max: 5 });
    const reason = str(body.reason, 'reason', { min: 10, max: 1000 });
    // Deterministic checklist — NOT sentiment, NOT stars. A critical 1-star
    // review with full evidence passes and can score 5.
    const media = safeParse<MediaEntry[]>(row.media, []);
    const missing: string[] = [];
    if (!(row.order_delivered_at || row.order_status === 'delivered')) missing.push('delivered_order');
    if (String(row.body ?? '').length < MIN_DETAIL_CHARS) missing.push('written_detail');
    if (media.filter((m) => m.kind === 'image').length < 1) missing.push('photos');
    if (!media.some((m) => m.kind === 'video')) missing.push('video');
    if (!parseEvidence(row.instagram_evidence)) missing.push('instagram_evidence');
    if (missing.length > 0) {
      throw badRequest(
        `Printer-gift checklist incomplete: ${missing.join(', ')} — use "request changes" instead`,
        'CHECKLIST_INCOMPLETE'
      );
    }
    const entId = newId('gent');
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE review_rewards SET state = 'approved', quality_score = ?, reason = ?, decided_by = ?, decided_at = ?
            WHERE id = ? AND state != 'approved'`
        ).bind(score, reason, admin.id, now, row.reward_id),
        // ONE entitlement per review (default multiplicity — decision row 5/19):
        // UNIQUE(reward_id) makes concurrent/replayed approval abort here.
        c.env.DB.prepare(
          `INSERT INTO gift_entitlements (id, reward_id, user_id, max_level, state, created_at)
           VALUES (?, ?, ?, ?, 'available', ?)`
        ).bind(entId, row.reward_id, row.user_id, score, now),
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('This reward was already approved');
      console.error('gift approval failed', e instanceof Error ? e.message : e);
      throw badRequest('Approval failed. Please try again.');
    }
    await audit(c.env.DB, admin.id, 'review.reward', id, { action: 'approve', kind: 'printer_gift', quality_score: score, reason, entitlement_id: entId });
    return c.json({ success: true, review_id: id, reward_state: 'approved', quality_score: score, entitlement_id: entId });
  }

  // kind === 'points'
  const reason = str(body.reason, 'reason', { min: 3, max: 1000 });
  const points = await getReviewPointsValue(c.env.DB);
  if (points === null) {
    throw unavailable(
      'Review point value is not configured yet (admin setting reviewPointsConfig) — no invented amounts',
      'REVIEW_POINTS_UNCONFIGURED'
    );
  }
  const sourceRef = `review:${row.review_id}`;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE review_rewards SET state = 'approved', points_awarded = ?, reason = ?, decided_by = ?, decided_at = ?
          WHERE id = ? AND state != 'approved'`
      ).bind(points, reason, admin.id, now, row.reward_id),
      // Guard table PK: each review awards points exactly once — a separate
      // ledger key space from purchase points ('order:…') and referrals.
      c.env.DB.prepare('INSERT INTO points_awards (source_ref, user_id, points, created_at) VALUES (?, ?, ?, ?)')
        .bind(sourceRef, row.user_id, points, now),
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', ?)`
      ).bind(`wtx_review_${row.review_id}`, row.user_id, points, `Review reward points`, sourceRef, now),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Points for this review were already awarded');
    console.error('review points award failed', e instanceof Error ? e.message : e);
    throw badRequest('Approval failed. Please try again.');
  }
  await audit(c.env.DB, admin.id, 'review.reward', id, { action: 'approve', kind: 'points', points, reason });
  return c.json({ success: true, review_id: id, reward_state: 'approved', points_awarded: points });
});

// ---------------------------------------------------------- admin: pools

function poolItemView(i: PoolItemRow) {
  return {
    id: i.id,
    level: i.level,
    kind: i.kind,
    label_ar: i.label_ar,
    label_en: i.label_en,
    label_ckb: i.label_ckb,
    brand: i.brand,
    material: i.material,
    color: i.color,
    option_value: i.option_value,
    compat_products: safeParse<string[]>(i.compat_products, []),
    stock: i.stock,
    active: !!i.active,
  };
}

reviewRoutes.get('/admin/pools', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM gift_pool_items ORDER BY level ASC, kind ASC, created_at ASC'
  ).all<PoolItemRow>();
  return c.json({ success: true, items: results.map(poolItemView) });
});

function parsePoolItemBody(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || body.level !== undefined) out.level = int(body.level, 'level', { min: 1, max: 5 });
  if (!partial || body.kind !== undefined) out.kind = oneOf(body.kind, 'kind', ['accessory', 'filament', 'nozzle', 'plate', 'other'] as const);
  if (!partial || body.label_ar !== undefined) out.label_ar = str(body.label_ar, 'label_ar', { min: 1, max: 200 });
  if (!partial || body.label_en !== undefined) out.label_en = str(body.label_en, 'label_en', { max: 200, required: false });
  if (!partial || body.label_ckb !== undefined) out.label_ckb = str(body.label_ckb, 'label_ckb', { max: 200, required: false });
  if (!partial || body.brand !== undefined) out.brand = str(body.brand, 'brand', { max: 100, required: false });
  if (!partial || body.material !== undefined) out.material = str(body.material, 'material', { max: 100, required: false });
  if (!partial || body.color !== undefined) out.color = str(body.color, 'color', { max: 100, required: false });
  if (!partial || body.option_value !== undefined) out.option_value = str(body.option_value, 'option_value', { max: 40, required: false });
  if (!partial || body.compat_products !== undefined) {
    const list = Array.isArray(body.compat_products) ? body.compat_products.map(String).slice(0, 100) : [];
    out.compat_products = JSON.stringify(list);
  }
  if (!partial || body.stock !== undefined) out.stock = int(body.stock, 'stock', { min: 0, max: 100000 });
  if (!partial || body.active !== undefined) out.active = body.active === false ? 0 : 1;
  return out;
}

reviewRoutes.post('/admin/pools', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const f = parsePoolItemBody(body, false);
  const id = newId('gpi');
  await c.env.DB.prepare(
    `INSERT INTO gift_pool_items (id, level, kind, label_ar, label_en, label_ckb, brand, material, color, option_value, compat_products, stock, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, f.level, f.kind, f.label_ar, f.label_en ?? '', f.label_ckb ?? '', f.brand ?? '', f.material ?? '',
      f.color ?? '', f.option_value ?? '', f.compat_products ?? '[]', f.stock, f.active ?? 1
    )
    .run();
  await audit(c.env.DB, admin.id, 'gift.pool.create', id, f);
  const row = await c.env.DB.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(id).first<PoolItemRow>();
  return c.json({ success: true, item: poolItemView(row!) });
});

reviewRoutes.put('/admin/pools/:itemId', async (c) => {
  const admin = c.get('user')!;
  const itemId = c.req.param('itemId') ?? '';
  const existing = await c.env.DB.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(itemId).first<PoolItemRow>();
  if (!existing) throw notFound('Pool item not found');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const f = parsePoolItemBody(body, true);
  const keys = Object.keys(f);
  if (keys.length === 0) throw badRequest('Nothing to update');
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await c.env.DB.prepare(`UPDATE gift_pool_items SET ${sets} WHERE id = ?`)
    .bind(...keys.map((k) => f[k]), itemId)
    .run();
  await audit(c.env.DB, admin.id, 'gift.pool.update', itemId, { before: { stock: existing.stock, active: existing.active }, changes: f });
  const row = await c.env.DB.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(itemId).first<PoolItemRow>();
  return c.json({ success: true, item: poolItemView(row!) });
});

reviewRoutes.delete('/admin/pools/:itemId', async (c) => {
  const admin = c.get('user')!;
  const itemId = c.req.param('itemId') ?? '';
  const existing = await c.env.DB.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(itemId).first<PoolItemRow>();
  if (!existing) throw notFound('Pool item not found');
  // Granted gifts keep their own contents snapshot — deleting a pool item
  // never touches an existing entitlement/redemption.
  await c.env.DB.prepare('DELETE FROM gift_pool_items WHERE id = ?').bind(itemId).run();
  await audit(c.env.DB, admin.id, 'gift.pool.delete', itemId, { label_ar: existing.label_ar, level: existing.level, stock: existing.stock });
  return c.json({ success: true });
});

// ------------------------------------------------- admin: grant history

reviewRoutes.get('/admin/gifts', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ge.*, rr.review_id, rr.quality_score, r.product_id, u.email, u.username,
            p.name AS product_name, p.name_ar AS product_name_ar,
            gr.options AS redemption_options, gr.created_at AS redeemed_at
       FROM gift_entitlements ge
       JOIN review_rewards rr ON rr.id = ge.reward_id
       JOIN reviews r ON r.id = rr.review_id
       JOIN users u ON u.id = ge.user_id
       LEFT JOIN products p ON p.id = r.product_id
       LEFT JOIN gift_redemptions gr ON gr.entitlement_id = ge.id
      ORDER BY ge.created_at DESC LIMIT 200`
  ).all<Record<string, unknown>>();
  return c.json({
    success: true,
    gifts: results.map((ge) => ({
      ...entitlementView(ge, ge.redeemed_at ? { entitlement_id: ge.id } : null),
      customer: { email: ge.email, username: ge.username },
      review_id: ge.review_id,
      quality_score: ge.quality_score ?? null,
      redeemed_at: ge.redeemed_at ?? null,
    })),
  });
});

/** Mark a selected gift as delivered/fulfilled. */
reviewRoutes.post('/admin/gifts/:id/fulfill', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const res = await c.env.DB.prepare(
    `UPDATE gift_entitlements SET state = 'fulfilled', fulfilled_at = ? WHERE id = ? AND state = 'selected'`
  )
    .bind(new Date().toISOString(), id)
    .run();
  if (res.meta.changes === 0) throw badRequest('Only a selected (redeemed) gift can be marked fulfilled');
  await audit(c.env.DB, admin.id, 'gift.fulfill', id, {});
  return c.json({ success: true });
});

/**
 * Cancel an UNREDEEMED entitlement (fraud/return handling) — an explicit,
 * audited, reason-required operation; never an invisible debit. A redeemed
 * gift is preserved (returns/fraud on redeemed gifts go through the case
 * review process, not this endpoint).
 */
reviewRoutes.post('/admin/gifts/:id/cancel', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = str(body.reason, 'reason', { min: 5, max: 1000 });
  const res = await c.env.DB.prepare(
    `UPDATE gift_entitlements SET state = 'cancelled' WHERE id = ? AND state = 'available'`
  )
    .bind(id)
    .run();
  if (res.meta.changes === 0) throw conflict('Only an unredeemed (available) gift can be cancelled');
  await audit(c.env.DB, admin.id, 'gift.cancel', id, { reason });
  return c.json({ success: true });
});
