import { Hono } from 'hono';
import { isPrinterProduct, printerProductIds } from '../lib/printerIdentity';
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
import { notifyStatement } from '../lib/notifications';
import {
  evaluateReviewQuality,
  normalizeReviewText,
  type ReviewQualityMedia,
  type ReviewQualityResult,
} from '../lib/reviewQuality';

/**
 * Product reviews with evidence, admin quality scoring and the five printer
 * gift levels (final-phase mandate §5).
 *
 * Separation of concerns enforced here:
 *  - PUBLIC review moderation (reviews.status) is a different decision from
 *    REWARD approval (review_rewards.state). A published review can have a
 *    rejected reward and vice versa.
 *  - Quality level (1..5) is a usefulness rubric — it is NEVER derived from
 *    praise or sentiment. The server produces a deterministic, auditable
 *    recommendation from text/media quality and anti-abuse signals; an admin
 *    can approve, change or reject that reward without changing publication.
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
 * Compatibility threshold used only for reward rows created before the
 * structured quality snapshot existed. New reviews use reviewQuality.ts.
 */
const MIN_DETAIL_CHARS = 80;
const PAGE_SIZE = 10;

const IMAGE_MAX = 8 * 1024 * 1024;
const VIDEO_MAX = 40 * 1024 * 1024;

type GiftKind = 'accessory' | 'filament' | 'nozzle' | 'plate' | 'other';

/** Composition of each gift box level (owner catalog, mandate §5). */
export const LEVEL_COMPOSITION: Readonly<Record<number, readonly GiftKind[]>> = {
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

type MediaEntry = ReviewQualityMedia;

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

async function ownMediaEntries(
  env: Env,
  keys: string[],
  prefix: string,
  kind: 'image' | 'video'
): Promise<MediaEntry[]> {
  const entries: MediaEntry[] = [];
  for (const key of keys) {
    if (!key.startsWith(prefix) || key.includes('..')) {
      throw badRequest('Invalid media reference', 'BAD_MEDIA_KEY');
    }
    const head = await headMediaObject(env, 'private', key);
    if (!head) throw badRequest('Uploaded file not found — please re-upload', 'MEDIA_MISSING');
    entries.push({
      key,
      kind,
      sha256: head.customMetadata?.sha256 || undefined,
      bytes: Number(head.size) || undefined,
      mime: head.httpMetadata?.contentType || undefined,
    });
  }
  return entries;
}

async function digestBytes(buf: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
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
    photos = await ownMediaEntries(c.env, photoKeys, mediaPrefix, 'image');
  }
  let videoEntry: MediaEntry | null;
  if (raw.videoKey === undefined && existing) {
    videoEntry = existing.media.find((m) => m.kind === 'video') ?? null;
  } else {
    const videoKey = str(raw.videoKey, 'videoKey', { max: 300, required: false });
    videoEntry = videoKey ? (await ownMediaEntries(c.env, [videoKey], mediaPrefix, 'video'))[0] : null;
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
    if (key) await ownMediaEntries(c.env, [key], `reviews-evidence/${userId}/`, 'image');
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

async function evaluateForUser(
  db: D1Database,
  userId: string,
  input: ReviewInput,
  facts: EligibilityFacts,
  excludeReviewId?: string
): Promise<ReviewQualityResult> {
  const query = excludeReviewId
    ? `SELECT body, media FROM reviews WHERE user_id = ? AND id != ? ORDER BY created_at DESC LIMIT 100`
    : `SELECT body, media FROM reviews WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`;
  const bound = excludeReviewId ? db.prepare(query).bind(userId, excludeReviewId) : db.prepare(query).bind(userId);
  const { results } = await bound.all<{ body: string; media: string }>();
  const previousBodies = (results ?? []).map((r) => normalizeReviewText(String(r.body ?? ''))).filter(Boolean);
  const previousMediaHashes = (results ?? []).flatMap((r) =>
    safeParse<MediaEntry[]>(r.media, []).map((m) => m.sha256 || '').filter(Boolean)
  );
  return evaluateReviewQuality({
    stars: input.stars,
    body: input.body,
    media: input.media,
    hasEvidence: !!input.evidence,
    isPrinter: facts.is_printer,
    previousBodies,
    previousMediaHashes,
  });
}

async function adminRewardNotifications(
  db: D1Database,
  reviewId: string,
  input: ReviewInput,
  quality: ReviewQualityResult
): Promise<D1PreparedStatement[]> {
  const { results } = await db.prepare("SELECT id FROM users WHERE role = 'admin'").all<{ id: string }>();
  return (results ?? []).map(({ id }) =>
    notifyStatement(db, {
      userId: id,
      kind: 'review_reward_pending',
      title_ar: 'مراجعة مؤهلة لمكافأة',
      title_en: 'Reward-eligible review',
      body_ar: `المنتج ${input.productId} · المستوى المتوقع ${quality.tier} · الجودة ${quality.score}/100`,
      body_en: `Product ${input.productId} · predicted level ${quality.tier} · quality ${quality.score}/100`,
      link: '/admin',
      entity_type: 'review',
      entity_id: reviewId,
      meta: { product_id: input.productId, predicted_tier: quality.tier, score: quality.score },
      eventKey: `review-reward:${reviewId}`,
    }).stmt
  );
}

/**
 * POST /api/reviews — create a review for a delivered, owned order.
 * One review per (user, product): DB UNIQUE from 0003. A manual review is
 * public immediately. A reward row is created ONLY when deterministic quality
 * qualifies for one of the existing five levels; publication never waits for
 * that separate admin decision.
 */
reviewRoutes.post('/', requireAuth, async (c) => {
  await rateLimit(c, 'review_submit', 10, 3600);
  const user = c.get('user')!;
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = await parseReviewInput(c, user.id, raw);
  const facts = await computeFacts(c.env.DB, user.id, input);
  const existing = await c.env.DB.prepare(
    'SELECT id, source FROM reviews WHERE user_id = ? AND product_id = ? LIMIT 1'
  ).bind(user.id, input.productId).first<{ id: string; source?: string }>();
  if (existing && (existing.source ?? 'user') !== 'system') {
    throw conflict('You already reviewed this product');
  }

  const reviewId = existing?.id ?? newId('rev');
  const now = new Date().toISOString();
  const quality = await evaluateForUser(c.env.DB, user.id, input, facts, existing?.id);
  const statements: D1PreparedStatement[] = [];

  if (existing) {
    // A real review replaces the clearly marked seven-day system marker. The
    // row identity remains stable, and no old reward exists to duplicate.
    statements.push(c.env.DB.prepare(
      `UPDATE reviews
          SET order_item_id = ?, order_id = ?, stars = ?, body = ?, media = ?,
              status = 'published', source = 'user', moderation_note = '',
              quality_score = ?, quality_summary = ?, fallback_points_awarded = 0,
              created_at = ?
        WHERE id = ? AND user_id = ? AND source = 'system'`
    ).bind(
      facts.order_item_id, input.orderId, input.stars, input.body, JSON.stringify(input.media),
      quality.score, JSON.stringify(quality), now, reviewId, user.id
    ));
  } else {
    statements.push(c.env.DB.prepare(
      `INSERT INTO reviews
         (id, user_id, product_id, order_item_id, order_id, stars, body, media,
          status, source, quality_score, quality_summary, fallback_points_awarded, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', 'user', ?, ?, 0, ?)`
    ).bind(
      reviewId, user.id, input.productId, facts.order_item_id, input.orderId,
      input.stars, input.body, JSON.stringify(input.media), quality.score, JSON.stringify(quality), now
    ));
  }

  if (quality.rewardEligible && quality.tier !== null) {
    const rewardId = newId('rr');
    statements.push(c.env.DB.prepare(
      `INSERT INTO review_rewards
         (id, review_id, user_id, kind, instagram_evidence, eligibility,
          quality_score, quality_snapshot, state, created_at)
       VALUES (?, ?, ?, 'printer_gift', ?, ?, ?, ?, 'submitted', ?)`
    ).bind(
      rewardId, reviewId, user.id,
      input.evidence ? JSON.stringify(input.evidence) : '',
      JSON.stringify(facts), quality.tier, JSON.stringify(quality), now
    ));
    statements.push(...(await adminRewardNotifications(c.env.DB, reviewId, input, quality)));
  } else {
    // A valid manual review outside the gift levels gets exactly twice the
    // existing configured base review points. Missing configuration stays
    // honest (zero); no value is invented in code.
    const basePoints = await getReviewPointsValue(c.env.DB);
    if (basePoints !== null) {
      const points = basePoints * 2;
      const sourceRef = `review-fallback:${reviewId}`;
      statements.push(
        c.env.DB.prepare('INSERT INTO points_awards (source_ref, user_id, points, created_at) VALUES (?, ?, ?, ?)')
          .bind(sourceRef, user.id, points, now),
        c.env.DB.prepare(
          `INSERT INTO wallet_transactions
             (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
           VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', ?)`
        ).bind(`wtx_review_fallback_${reviewId}`, user.id, points, 'Valid manual review fallback (2x base)', sourceRef, now),
        c.env.DB.prepare('UPDATE reviews SET fallback_points_awarded = ? WHERE id = ?')
          .bind(points, reviewId)
      );
    }
  }

  try {
    await c.env.DB.batch(statements);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw conflict('You already reviewed this product');
    }
    console.error('review insert failed', e instanceof Error ? e.message : e);
    throw badRequest('Review could not be saved. Please try again.');
  }

  return c.json({
    success: true,
    published: true,
    quality,
    review: await loadMyReview(c.env.DB, user.id, reviewId),
  });
});

/**
 * PUT /api/reviews/:id — edit the OWN published review while its reward is
 * still submitted or needs revision. Publication remains published; only the
 * separate reward evaluation is resubmitted.
 */
reviewRoutes.put('/:id', requireAuth, async (c) => {
  await rateLimit(c, 'review_submit', 10, 3600);
  const user = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const existing = await c.env.DB.prepare(
      `SELECT r.id, r.user_id, r.status, r.source, r.product_id, r.order_id, r.media,
            rr.id AS reward_id, rr.state AS reward_state, rr.instagram_evidence
       FROM reviews r JOIN review_rewards rr ON rr.review_id = r.id
      WHERE r.id = ?`
  )
    .bind(id)
    .first<{ id: string; user_id: string; status: string; source?: string; product_id: string; order_id: string | null; media: string; reward_id: string; reward_state: string; instagram_evidence: string }>();
  if (!existing || existing.user_id !== user.id) throw notFound('Review not found');
  if ((existing.source ?? 'user') !== 'user' || existing.status === 'rejected' || !['submitted', 'revision_needed'].includes(existing.reward_state)) {
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
  const quality = await evaluateForUser(c.env.DB, user.id, input, facts, id);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE reviews
          SET stars = ?, body = ?, media = ?, order_id = ?, order_item_id = ?,
              status = 'published', quality_score = ?, quality_summary = ?
        WHERE id = ? AND user_id = ? AND source = 'user' AND status != 'rejected'`
    ).bind(
      input.stars, input.body, JSON.stringify(input.media), input.orderId, facts.order_item_id,
      quality.score, JSON.stringify(quality), id, user.id
    ),
  ];
  if (quality.rewardEligible && quality.tier !== null) {
    statements.push(c.env.DB.prepare(
      `UPDATE review_rewards
          SET instagram_evidence = ?, eligibility = ?, quality_score = ?, quality_snapshot = ?,
              state = 'submitted', reason = '', decided_by = NULL, decided_at = NULL
        WHERE id = ? AND state IN ('submitted','revision_needed')`
    ).bind(
      input.evidence ? JSON.stringify(input.evidence) : '', JSON.stringify(facts),
      quality.tier, JSON.stringify(quality), existing.reward_id
    ));
    statements.push(...(await adminRewardNotifications(c.env.DB, id, input, quality)));
  } else {
    // The review stays public even when edited below a gift threshold. Its
    // old queue record becomes an auditable rejected reward and it receives
    // the same configured fallback as any other valid manual review.
    statements.push(c.env.DB.prepare(
      `UPDATE review_rewards
          SET instagram_evidence = ?, eligibility = ?, quality_score = NULL, quality_snapshot = ?,
              state = 'rejected', reason = 'Review no longer qualifies after edit',
              decided_by = 'system', decided_at = ?
        WHERE id = ? AND state IN ('submitted','revision_needed')`
    ).bind(
      input.evidence ? JSON.stringify(input.evidence) : '', JSON.stringify(facts),
      JSON.stringify(quality), now, existing.reward_id
    ));
    const basePoints = await getReviewPointsValue(c.env.DB);
    if (basePoints !== null) {
      const points = basePoints * 2;
      const sourceRef = `review-fallback:${id}`;
      statements.push(
        c.env.DB.prepare('INSERT INTO points_awards (source_ref, user_id, points, created_at) VALUES (?, ?, ?, ?)')
          .bind(sourceRef, user.id, points, now),
        c.env.DB.prepare(
          `INSERT INTO wallet_transactions
             (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
           VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', ?)`
        ).bind(`wtx_review_fallback_${id}`, user.id, points, 'Valid manual review fallback (2x base)', sourceRef, now),
        c.env.DB.prepare('UPDATE reviews SET fallback_points_awarded = ? WHERE id = ?').bind(points, id)
      );
    }
  }
  await c.env.DB.batch(statements);
  return c.json({ success: true, review: await loadMyReview(c.env.DB, user.id, id) });
});

async function loadMyReview(db: D1Database, userId: string, reviewId: string) {
  const row = await db
    .prepare(
      `SELECT r.*, rr.id AS reward_id, rr.kind, rr.state AS reward_state, rr.quality_score AS reward_quality_score,
              rr.reason AS reward_reason, rr.points_awarded, rr.instagram_evidence, rr.quality_snapshot,
              p.name AS product_name, p.name_ar AS product_name_ar, p.slug AS product_slug
         FROM reviews r
         LEFT JOIN review_rewards rr ON rr.review_id = r.id
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
    source: r.source ?? 'user',
    system_generated: (r.source ?? 'user') === 'system',
    quality: safeParse<ReviewQualityResult | null>(r.quality_summary, null),
    status: r.status, // pending | published | rejected
    moderation_note: r.moderation_note ?? '',
    created_at: r.created_at,
    fallback_points_awarded: Number(r.fallback_points_awarded) || 0,
    reward: r.reward_id ? {
      kind: r.kind,
      state: r.reward_state,
      quality_score: r.reward_quality_score ?? null,
      quality: safeParse<ReviewQualityResult | null>(r.quality_snapshot, null),
      reason: r.reward_reason ?? '',
      points_awarded: Number(r.points_awarded) || 0,
      // Own evidence back to its owner only — never in public payloads.
      instagram: evidence
        ? { link: evidence.link, file_url: evidence.key ? mediaUrl(evidence.key) : null }
        : null,
    } : null,
  };
}

/** GET /api/reviews/mine — the signed-in user's reviews with reward state. */
reviewRoutes.get('/mine', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, rr.id AS reward_id, rr.kind, rr.state AS reward_state, rr.quality_score AS reward_quality_score,
            rr.reason AS reward_reason, rr.points_awarded, rr.instagram_evidence, rr.quality_snapshot,
            p.name AS product_name, p.name_ar AS product_name_ar, p.slug AS product_slug
       FROM reviews r
       LEFT JOIN review_rewards rr ON rr.review_id = r.id
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
  const existing = await c.env.DB.prepare('SELECT id, source FROM reviews WHERE user_id = ? AND product_id = ?')
    .bind(user.id, productId)
    .first<{ id: string; source?: string }>();
  const existingView = existing ? await loadMyReview(c.env.DB, user.id, existing.id) : null;
  const isPrinter = await isPrinterProduct(c.env.DB, productId);
  const points = await getReviewPointsValue(c.env.DB);
  return c.json({
    success: true,
    eligible_orders: orders.map((o) => ({ id: o.id, delivered_at: o.delivered_at })),
    existing_review: existingView,
    can_replace_system_review: (existing?.source ?? 'user') === 'system',
    is_printer: isPrinter,
    // null = not configured (honest state); a number = configured award.
    review_points: points,
  });
});

/**
 * GET /api/reviews/order/:orderId — WHAT IS LEFT TO REVIEW IN ONE ORDER.
 *
 * The per-product `/eligibility/:productId` answers one product at a time, so
 * the order sheet had to ask again on every tap and could never say "nothing
 * left" before the customer had clicked through each line. This answers the
 * whole order in one round trip.
 *
 * It is a READ of the same rules POST / enforces, never a second set of them:
 *
 *  - the order must be the caller's own (someone else's id is a 404, exactly
 *    as `computeFacts` gives);
 *  - `delivered` is the same test — `delivered_at` present OR status
 *    'delivered' — and while it is false every line is `not_delivered`;
 *  - a line is reviewable only if its product still exists in the catalog,
 *    because `reviews.product_id` has a FK to it;
 *  - lines are DEDUPED BY PRODUCT, because UNIQUE(user_id, product_id) from
 *    0003 means two lines of the same product collapse into one review. The
 *    sheet must not offer a second row that the server would then refuse.
 *
 * `remaining` is what the caller needs to decide between a form and a
 * "nothing left to review" message, and it counts only what POST would accept.
 */
reviewRoutes.get('/order/:orderId', requireAuth, async (c) => {
  const user = c.get('user')!;
  const orderId = c.req.param('orderId') ?? '';
  const order = await c.env.DB.prepare('SELECT id, status, delivered_at FROM orders WHERE id = ? AND user_id = ?')
    .bind(orderId, user.id)
    .first<{ id: string; status: string; delivered_at: string | null }>();
  if (!order) throw notFound('Order not found');
  const delivered = !!order.delivered_at || order.status === 'delivered';

  // One pass: every catalog-backed line of the order with this customer's
  // review of that product beside it, if any. The JOIN on products drops
  // mystery spools (NULL product_id) and products since deleted — neither can
  // carry a review row.
  const { results: rows } = await c.env.DB.prepare(
    `SELECT oi.id AS order_item_id, oi.product_id,
            oi.name_snapshot, oi.image_snapshot, oi.option_snapshot,
            r.id AS review_id
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN reviews r ON r.product_id = oi.product_id AND r.user_id = ?
      WHERE oi.order_id = ?
      ORDER BY oi.rowid`
  )
    .bind(user.id, orderId)
    .all<{
      order_item_id: string;
      product_id: string;
      name_snapshot: string;
      image_snapshot: string;
      option_snapshot: string;
      review_id: string | null;
    }>();

  const seen = new Set<string>();
  const unique = (rows ?? []).filter((r) => !seen.has(r.product_id) && seen.add(r.product_id));
  const printers = await printerProductIds(c.env.DB, unique.map((r) => r.product_id));
  const points = await getReviewPointsValue(c.env.DB);

  const lines = [];
  for (const r of unique) {
    // The same view the per-product endpoint returns, so the sheet reads one
    // shape whichever endpoint answered.
    const existing = r.review_id ? await loadMyReview(c.env.DB, user.id, r.review_id) : null;
    const isSystem = !!existing && (existing.source === 'system' || existing.system_generated === true);
    lines.push({
      order_item_id: r.order_item_id,
      product_id: r.product_id,
      name: r.name_snapshot,
      image: r.image_snapshot,
      variant: r.option_snapshot,
      is_printer: printers.has(r.product_id),
      existing_review: existing,
      // A system-written marker is replaceable by the real buyer; a review
      // they wrote themselves is not (POST answers that with 409).
      can_replace_system_review: isSystem,
      state: !delivered ? 'not_delivered' : existing && !isSystem ? 'reviewed' : 'reviewable',
    });
  }

  return c.json({
    success: true,
    order_id: order.id,
    delivered,
    // null = not configured (honest state); a number = configured award.
    review_points: points,
    remaining: lines.filter((l) => l.state === 'reviewable').length,
    lines,
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
    `SELECT r.id, r.stars, r.body, r.media, r.created_at, r.order_id, r.source,
            u.name, u.username,
            (SELECT 1 FROM review_rewards rr WHERE rr.review_id = r.id AND rr.state = 'approved' LIMIT 1) AS has_reward
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
      source: r.source ?? 'user',
      system_generated: (r.source ?? 'user') === 'system',
      reviewer: (r.source ?? 'user') === 'system'
        ? 'Levonis'
        : maskName(r.name as string | null, r.username as string | null),
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
  const sha256 = await digestBytes(buf);
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
    {
      httpMetadata: { contentType: kind.mime, cacheControl: 'private, max-age=300' },
      customMetadata: { sha256 },
    }
  );
  return c.json({ success: true, key, kind: isVideo ? 'video' : 'image', sha256, bytes: buf.byteLength, url: mediaUrl(key) });
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
 * GET /api/reviews/admin/queue — reward-only queue with the deterministic
 * recommendation, its reasons, anti-abuse flags and compatibility facts.
 */
reviewRoutes.get('/admin/queue', async (c) => {
  const stateQ = c.req.query('state') || 'submitted';
  const allowed = ['submitted', 'revision_needed', 'approved', 'rejected', 'all'];
  const state = allowed.includes(stateQ) ? stateQ : 'submitted';

  const { results } = await c.env.DB.prepare(
    `SELECT r.id AS review_id, r.stars, r.body, r.media, r.status AS review_status, r.source, r.moderation_note,
            r.created_at, r.order_id, r.product_id,
            rr.id AS reward_id, rr.kind, rr.instagram_evidence, rr.eligibility, rr.quality_score,
            rr.quality_snapshot, rr.state AS reward_state, rr.reason, rr.points_awarded, rr.decided_at, rr.decided_by,
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
      source: r.source ?? 'user',
      moderation_note: r.moderation_note ?? '',
      kind: r.kind,
      reward_state: r.reward_state,
      quality_score: r.quality_score ?? null,
      quality: safeParse<ReviewQualityResult | null>(r.quality_snapshot, null),
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
    `SELECT r.id AS review_id, r.user_id, r.body, r.media, r.order_id, r.product_id, r.source,
            rr.id AS reward_id, rr.kind, rr.state, rr.instagram_evidence, rr.quality_score, rr.quality_snapshot,
            o.delivered_at AS order_delivered_at, o.status AS order_status
       FROM reviews r
       JOIN review_rewards rr ON rr.review_id = r.id
       LEFT JOIN orders o ON o.id = r.order_id
      WHERE r.id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('Review not found');
  if ((row.source ?? 'user') === 'system') throw badRequest('System-generated reviews cannot receive rewards', 'SYSTEM_REVIEW_NO_REWARD');
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
    const score = body.qualityScore === undefined
      ? int(row.quality_score, 'qualityScore', { min: 1, max: 5 })
      : int(body.qualityScore, 'qualityScore', { min: 1, max: 5 });
    const reason = str(body.reason, 'reason', { min: 10, max: 1000 });
    const quality = safeParse<ReviewQualityResult | null>(row.quality_snapshot, null);
    // New submissions are admitted to this queue only after deterministic
    // evaluation. Historical pre-0069 rows retain the former checklist so a
    // migration never silently upgrades an old pending reward.
    const media = safeParse<MediaEntry[]>(row.media, []);
    const legacyMissing: string[] = [];
    if (!quality) {
      if (!(row.order_delivered_at || row.order_status === 'delivered')) legacyMissing.push('delivered_order');
      if (String(row.body ?? '').length < MIN_DETAIL_CHARS) legacyMissing.push('written_detail');
      if (media.filter((m) => m.kind === 'image').length < 1) legacyMissing.push('photos');
      if (!media.some((m) => m.kind === 'video')) legacyMissing.push('video');
      if (!parseEvidence(row.instagram_evidence)) legacyMissing.push('instagram_evidence');
    }
    if (quality && !quality.rewardEligible) {
      throw badRequest('Review no longer meets reward-quality requirements', 'REWARD_NOT_ELIGIBLE');
    }
    if (legacyMissing.length > 0) {
      throw badRequest(
        `Printer-gift checklist incomplete: ${legacyMissing.join(', ')} — use "request changes" instead`,
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
