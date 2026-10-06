import { Hono } from 'hono';
import { isPrinterProduct, printerProductIds } from '../lib/printerIdentity';
import type { AppContext, Env } from '../lib/types';
import { safeParse } from '../lib/types';
import {
  HttpError,
  requireAuth,
  requireAdmin,
  badRequest,
  notFound,
  conflict,
  str,
  int,
  oneOf,
} from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { HEIF_REFUSAL, parseByteRange } from './uploads';
import { deleteMediaObject, getMediaObject, headMediaObject, storeMedia } from '../lib/mediaStorage';
import { enqueueMediaDetach } from '../lib/mediaRefs';
import { catalogIndexFor } from '../lib/catalogPresentation';
import {
  advisoryQuality,
  evaluateReviewQuality,
  normalizeReviewText,
  type ReviewQualityResult,
} from '../lib/reviewQuality';
import {
  closeReviewMediaStagingStatement,
  mediaUrl,
  parseEvidence,
  publicMedia,
  resolveReviewMedia,
  reviewMediaStagingStatement,
  sniffReviewUpload,
  type MediaEntry,
} from '../lib/reviews/media';
import { fallbackNote, getReviewPointsValue, reviewAward } from '../lib/reviews/points';
import { REVIEW_LIMITS, checkReviewText, type ReviewTextCode } from '../lib/reviews/text';
import {
  PRINTER_GIFT_SECTIONS,
  admitPrinterGiftStatement,
  giftOutcome,
  giftPreview,
  printerGiftFamily,
  printerGiftFamilyOf,
  rewardAfterEditStatements,
  type PrinterGiftFamily,
} from '../lib/reviews/eligibility';

// Kept importable from here: the points reader used to live in this file.
export { getReviewPointsValue } from '../lib/reviews/points';

/**
 * Product reviews for EVERY Levonis product, and the printer-review gift
 * admission (docs/REVIEWS_GIFTS.md — lane S1). The gift decision, the codes,
 * the levels and the granted gifts live in routes/gifts.ts (lane S2), mounted
 * at the same prefix.
 *
 * THREE STAGES, KEPT APART:
 *  1. PUBLICATION — a valid POST publishes at once. Moderation
 *     (/admin/:id/moderate) is the only thing that unpublishes; a reward
 *     decision never touches it, and a one-star review of anything stays up.
 *  2. GIFT ELIGIBILITY — one deterministic statement inside the review's own
 *     batch (worker/lib/reviews/eligibility.ts): a 5★, real-text, user-written
 *     review of a printer whose real unit the reviewer bought, received and
 *     linked to their account in the warranty centre — one reward per unit,
 *     ever. It inserts a `printer_gift` reward in 'submitted' with no level, or
 *     nothing. Never sentiment, never a quality tier.
 *  3. THE ADMIN DECISION — a human picks the level (routes/gifts.ts).
 *
 * Text: 30–4000 REAL characters by the shared rule (packages/catalog/src/
 * reviewRules.ts) — REVIEW_TEXT_TOO_SHORT, REVIEW_TEXT_TOO_LONG,
 * REVIEW_TEXT_REPETITIVE. Media: ≤ 10 photos and ≤ 2 videos, refused never
 * sliced, kind from the stored OBJECT, duplicates refused by SHA-256
 * (worker/lib/reviews/media.ts). Uploads that no review attaches are removed
 * by the existing guarded media cleanup.
 *
 * Instagram evidence is no longer collected. Legacy evidence stays PRIVATE:
 * stored on review_rewards, served only to its owner and admins, never in a
 * public payload.
 */

export const reviewRoutes = new Hono<AppContext>();
reviewRoutes.use('/admin/*', requireAdmin);

// ------------------------------------------------------------- constants

const PAGE_SIZE = 10;

// The upload door's byte caps. `VIDEO_MAX` keeps this exact spelling: the
// gateway's body-size class reads it (services/gateway/test/uploadClasses).
const IMAGE_MAX = 8 * 1024 * 1024;
const VIDEO_MAX = 40 * 1024 * 1024;

/** What the review sheet shows as its media limits (the server enforces the same numbers). */
const MEDIA_LIMITS = {
  max_images: REVIEW_LIMITS.maxImages,
  max_videos: REVIEW_LIMITS.maxVideos,
  image_mb: IMAGE_MAX / (1024 * 1024),
  video_mb: VIDEO_MAX / (1024 * 1024),
} as const;

/** The server's sentence for each text refusal; the client localises the CODE (src/lib/refusalStrings.ts). */
const TEXT_REFUSAL: Record<ReviewTextCode, string> = {
  REVIEW_TEXT_TOO_SHORT: 'Write at least 30 real characters about your experience with the product.',
  REVIEW_TEXT_TOO_LONG: 'The review is longer than 4000 characters. Please shorten it.',
  REVIEW_TEXT_REPETITIVE: 'The text looks repeated or made of symbols only. Write your opinion in real words.',
};

// --------------------------------------------------------------- helpers

/** Masked reviewer display name — never the full identity. */
export function maskName(name: string | null, username: string | null): string {
  const src = String(name ?? '').trim() || String(username ?? '').trim();
  if (!src) return 'Levonis';
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return `${parts[0]} ${parts[1].charAt(0)}.`;
  const p = parts[0];
  return p.length <= 2 ? p : `${p.slice(0, 2)}***`;
}

async function digestBytes(buf: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('UNIQUE') || msg.includes('PRIMARY KEY');
}

/**
 * The review text, trimmed, or the refusal. Mandatory: a missing or
 * non-string body is "too short". The SAME rule the sheet's live counter
 * runs, applied to every new and edited USER review (system markers never
 * reach it). Existing short reviews stay published; they are only judged
 * again if their author edits them.
 */
function reviewBodyOrRefuse(raw: unknown): string {
  const body = typeof raw === 'string' ? raw.trim() : '';
  const verdict = checkReviewText(body);
  if (!verdict.ok) {
    throw badRequest(TEXT_REFUSAL[verdict.code], verdict.code, {
      length: verdict.length,
      min: REVIEW_LIMITS.minChars,
      max: REVIEW_LIMITS.maxChars,
    });
  }
  return body;
}

interface OrderFacts {
  order_id: string;
  order_item_id: string;
  /**
   * The only line of this product in the order is a review GIFT line (0165).
   * A gift triggers no other reward (docs/REVIEWS_GIFTS.md S8): its review
   * publishes like any other but earns no fallback points.
   */
  gift_line: boolean;
}

/**
 * The caller's own order, containing the product, delivered. Someone else's
 * order is the same 404 its absence gives; an undelivered one is
 * ORDER_NOT_DELIVERED. A paid line is preferred over a gift line.
 */
async function computeFacts(db: D1Database, userId: string, productId: string, orderId: string): Promise<OrderFacts> {
  const order = await db
    .prepare(
      `SELECT o.id, o.delivered_at, o.status, oi.id AS order_item_id,
              (oi.gift_entitlement_id IS NOT NULL) AS gift_line
         FROM orders o JOIN order_items oi ON oi.order_id = o.id AND oi.product_id = ?
        WHERE o.id = ? AND o.user_id = ?
        ORDER BY (oi.gift_entitlement_id IS NULL) DESC, oi.rowid
        LIMIT 1`
    )
    .bind(productId, orderId, userId)
    .first<{ id: string; delivered_at: string | null; status: string; order_item_id: string; gift_line: number }>();
  if (!order) throw notFound('Order not found or it does not contain this product');
  const delivered = !!order.delivered_at || order.status === 'delivered';
  if (!delivered) {
    throw badRequest('You can review this product after your order is delivered', 'ORDER_NOT_DELIVERED');
  }
  return { order_id: order.id, order_item_id: order.order_item_id, gift_line: Number(order.gift_line) === 1 };
}

/** ADVISORY quality (score, reasons, signals) against this customer's other reviews. Gates nothing. */
async function evaluateForUser(
  db: D1Database,
  userId: string,
  input: { stars: number; body: string; media: MediaEntry[]; hasEvidence?: boolean },
  excludeReviewId?: string
): Promise<ReviewQualityResult> {
  const { results } = await db
    .prepare('SELECT body, media FROM reviews WHERE user_id = ? AND id <> ? ORDER BY created_at DESC LIMIT 100')
    .bind(userId, excludeReviewId ?? '')
    .all<{ body: string; media: string }>();
  const previousBodies = (results ?? []).map((r) => normalizeReviewText(String(r.body ?? ''))).filter(Boolean);
  const previousMediaHashes = (results ?? []).flatMap((r) =>
    safeParse<MediaEntry[]>(r.media, []).map((m) => m?.sha256 || '').filter(Boolean)
  );
  return evaluateReviewQuality({
    stars: input.stars,
    body: input.body,
    media: input.media,
    hasEvidence: !!input.hasEvidence,
    previousBodies,
    previousMediaHashes,
  });
}

/**
 * THE FALLBACK POINTS — base × 2 × the reviewer's membership multiplier, for
 * a valid review OUTSIDE the gift queue (policy 7.5/7.8). Exclusive with the
 * admission inside the same batch: every statement re-checks that the review
 * has no live (non-rejected) reward, that it is published and user-written,
 * and that this review was never paid before (`points_awards` and the wallet
 * transaction have deterministic keys). Nothing configured → nothing paid.
 */
async function fallbackPointsStatements(
  db: D1Database,
  userId: string,
  reviewId: string,
  nowIso: string
): Promise<D1PreparedStatement[]> {
  const basePoints = await getReviewPointsValue(db);
  if (basePoints === null) return [];
  // `* 2` is the long-standing fallback rule for a valid manual review; the
  // SUBSCRIPTION multiplier then applies on top of it, because the owner's
  // rule is about who the member is, not what they did.
  const { points, multiplierX100 } = await reviewAward(db, userId, basePoints * 2);
  const sourceRef = `review-fallback:${reviewId}`;
  const txId = `wtx_review_fallback_${reviewId}`;
  const eligible = `NOT EXISTS (SELECT 1 FROM review_rewards WHERE review_id = ?3 AND state <> 'rejected')
          AND EXISTS (SELECT 1 FROM reviews WHERE id = ?3 AND status = 'published' AND source = 'user')`;
  return [
    db
      .prepare(
        `INSERT INTO points_awards (source_ref, user_id, points, created_at)
         SELECT ?1, ?2, ?4, ?5
          WHERE ${eligible}
            AND NOT EXISTS (SELECT 1 FROM points_awards WHERE source_ref = ?1)`
      )
      .bind(sourceRef, userId, reviewId, points, nowIso),
    db
      .prepare(
        `INSERT INTO wallet_transactions
           (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?2, 'deposit', 'POINT', ?4, 'approved', ?5, ?6, 'system', ?7
          WHERE ${eligible}
            AND NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE id = ?1)`
      )
      .bind(txId, userId, reviewId, points, fallbackNote(multiplierX100), sourceRef, nowIso),
    db
      .prepare(
        `UPDATE reviews SET fallback_points_awarded = (SELECT points FROM points_awards WHERE source_ref = ?1)
          WHERE id = ?2 AND EXISTS (SELECT 1 FROM points_awards WHERE source_ref = ?1)`
      )
      .bind(sourceRef, reviewId),
  ];
}

/**
 * A POST that was never created must not leave its uploads waiting a day:
 * their staging jobs are moved to NOW, so the guarded cleanup takes them on
 * its next run (after the attach protection lapses) unless something
 * references them by then. Never fatal — the 24 h staging still applies.
 */
async function expediteStagedUploads(db: D1Database, keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    const now = Date.now();
    await db.batch(keys.map((key) => reviewMediaStagingStatement(db, key, now, 0)));
  } catch (error) {
    console.error('review upload cleanup could not be expedited', error instanceof Error ? error.message : error);
  }
}

/** May the owner still edit this review? (PUT answers REVIEW_NOT_EDITABLE otherwise.) */
function reviewEditable(row: { source?: unknown; status?: unknown; reward_id?: unknown; reward_state?: unknown }): boolean {
  if ((row.source ?? 'user') !== 'user' || row.status === 'rejected') return false;
  return !row.reward_id || row.reward_state === 'submitted' || row.reward_state === 'revision_needed';
}

/**
 * POST /api/reviews — create a review for a delivered, owned order.
 *
 * One review per (user, product): DB UNIQUE from 0003 (409
 * REVIEW_ALREADY_EXISTS). Published at once, whatever the stars. In the SAME
 * batch: the uploads it attaches leave the staging cleanup, the printer-gift
 * admission runs (a reward row or nothing — never a level), and the fallback
 * points are paid only when it was not admitted. A batch that fails creates
 * nothing and its uploads are handed to the cleanup's next run.
 */
reviewRoutes.post('/', requireAuth, async (c) => {
  await rateLimit(c, 'review_submit', 10, 3600);
  const user = c.get('user')!;
  const db = c.env.DB;
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const productId = str(raw.productId, 'productId', { min: 1, max: 60 });
  const orderId = str(raw.orderId, 'orderId', { min: 1, max: 60 });
  const stars = int(raw.stars, 'stars', { min: 1, max: 5 });
  const body = reviewBodyOrRefuse(raw.body);

  const facts = await computeFacts(db, user.id, productId, orderId);
  const existing = await db
    .prepare('SELECT id, source FROM reviews WHERE user_id = ? AND product_id = ? LIMIT 1')
    .bind(user.id, productId)
    .first<{ id: string; source?: string }>();
  if (existing && (existing.source ?? 'user') !== 'system') {
    throw conflict('You already reviewed this product', 'REVIEW_ALREADY_EXISTS');
  }

  const reviewId = existing?.id ?? newId('rev');
  const media = await resolveReviewMedia(c.env, { userId: user.id, reviewId: existing?.id ?? null, input: raw, existing: null });
  const quality = await evaluateForUser(db, user.id, { stars, body, media }, existing?.id);
  const family = await printerGiftFamilyOf(db, productId);
  const now = new Date().toISOString();
  const keys = media.map((m) => m.key);

  const statements: D1PreparedStatement[] = [];
  if (existing) {
    // A real review replaces the clearly marked seven-day system marker in
    // place: the row identity stays, and a marker never carries a reward.
    statements.push(
      db
        .prepare(
          `UPDATE reviews
              SET order_item_id = ?, order_id = ?, stars = ?, body = ?, media = ?,
                  status = 'published', source = 'user', moderation_note = '',
                  quality_score = ?, quality_summary = ?, fallback_points_awarded = 0,
                  created_at = ?
            WHERE id = ? AND user_id = ? AND source = 'system'`
        )
        .bind(facts.order_item_id, facts.order_id, stars, body, JSON.stringify(media), quality.score, JSON.stringify(quality), now, reviewId, user.id)
    );
  } else {
    statements.push(
      db
        .prepare(
          `INSERT INTO reviews
             (id, user_id, product_id, order_item_id, order_id, stars, body, media,
              status, source, quality_score, quality_summary, fallback_points_awarded, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', 'user', ?, ?, 0, ?)`
        )
        .bind(reviewId, user.id, productId, facts.order_item_id, facts.order_id, stars, body, JSON.stringify(media), quality.score, JSON.stringify(quality), now)
    );
  }
  if (keys.length) statements.push(closeReviewMediaStagingStatement(db, keys, reviewId));
  if (family && stars === 5) {
    statements.push(
      admitPrinterGiftStatement(db, {
        rewardId: newId('rr'),
        reviewId,
        textOk: true, // reviewBodyOrRefuse above: the text rule held
        familyOk: true,
        nowIso: now,
        qualitySnapshot: JSON.stringify(quality),
      })
    );
  }
  if (!facts.gift_line) statements.push(...(await fallbackPointsStatements(db, user.id, reviewId, now)));

  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('You already reviewed this product', 'REVIEW_ALREADY_EXISTS');
    await expediteStagedUploads(db, keys);
    console.error('review insert failed', e instanceof Error ? e.message : e);
    throw badRequest('Review could not be saved. Please try again.');
  }
  // A concurrent POST replaced the same system marker first: this one wrote
  // nothing of its own (every later statement is fenced on the stored row).
  if (existing && Number(results[0]?.meta?.changes ?? 0) === 0) {
    throw conflict('You already reviewed this product', 'REVIEW_ALREADY_EXISTS');
  }

  const gift = await giftOutcome(db, reviewId, family);

  /**
   * «📢 Review» — THE TOPIC THE OWNER OPENED FOR EXACTLY THIS.
   *
   * A review here is PUBLISHED THE MOMENT IT IS WRITTEN, so the shop must
   * hear about a one-star review as soon as it is live, not when a customer
   * mentions it. The stars come first because they decide whether anyone
   * opens it; the text is not in the message (the review is public and the
   * product page is the link). A printer review that entered the gift queue
   * says so — never with a predicted level: the level is the admin's call.
   *
   * After the batch has committed, and never able to throw: a review that was
   * saved must not report failure because Telegram was unreachable.
   */
  announceAfterResponse(
    c,
    'review',
    `📢 ${'★'.repeat(stars)}${'☆'.repeat(5 - stars)} (${stars}/5) review on ${productId}` +
      `\nReview: ${reviewId}` +
      `\nOrder: ${facts.order_id}` +
      `\nQuality: ${quality.score}/100` +
      (gift.queued ? '\nPrinter gift candidate — awaiting an admin decision' : '')
  );

  return c.json({
    success: true,
    published: true,
    quality,
    review: await loadMyReview(db, user.id, reviewId),
    gift,
  });
});

/**
 * PUT /api/reviews/:id — edit the OWN review while it is editable: written by
 * the customer, not rejected by moderation, and either without a reward or
 * with one still undecided (submitted / revision needed). Otherwise 409
 * REVIEW_NOT_EDITABLE. The product and the order never change. The same text
 * and media rules apply; omitting `media` keeps it, `[]` clears it, and media
 * the edit drops is handed to the cleanup after the edit commits.
 *
 * The gift program follows the edit in the same batch: a pending
 * printer-gift reward is re-checked (still eligible → back to 'submitted';
 * not any more → closed by the system, the review stays published, and the
 * fallback points apply); a review without a reward runs the admission.
 */
reviewRoutes.put('/:id', requireAuth, async (c) => {
  await rateLimit(c, 'review_submit', 10, 3600);
  const user = c.get('user')!;
  const db = c.env.DB;
  const id = c.req.param('id') ?? '';
  // LEFT JOIN: a review without a reward row is editable too.
  const existing = await db
    .prepare(
      `SELECT r.id, r.user_id, r.status, r.source, r.product_id, r.order_id, r.media,
              rr.id AS reward_id, rr.kind AS reward_kind, rr.state AS reward_state
         FROM reviews r LEFT JOIN review_rewards rr ON rr.review_id = r.id
        WHERE r.id = ?`
    )
    .bind(id)
    .first<{
      id: string;
      user_id: string;
      status: string;
      source?: string;
      product_id: string;
      order_id: string | null;
      media: string;
      reward_id: string | null;
      reward_kind: string | null;
      reward_state: string | null;
    }>();
  if (!existing || existing.user_id !== user.id) throw notFound('Review not found');
  if (!reviewEditable(existing)) {
    throw conflict('This review can no longer be edited', 'REVIEW_NOT_EDITABLE');
  }

  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const stars = int(raw.stars, 'stars', { min: 1, max: 5 });
  const body = reviewBodyOrRefuse(raw.body);
  // Product/order identity of a review is immutable — only content changes.
  // (An order deleted since — HISTORY unlinks it — is named again by the caller.)
  const orderId = existing.order_id ?? str(raw.orderId, 'orderId', { min: 1, max: 60 });
  const facts = await computeFacts(db, user.id, existing.product_id, orderId);
  const stored = safeParse<MediaEntry[]>(existing.media, []).filter((m) => m && typeof m.key === 'string');
  const media = await resolveReviewMedia(c.env, { userId: user.id, reviewId: id, input: raw, existing: stored });
  const quality = await evaluateForUser(db, user.id, { stars, body, media }, id);
  const family = await printerGiftFamilyOf(db, existing.product_id);
  const now = new Date().toISOString();

  const storedKeys = new Set(stored.map((m) => m.key));
  const keptKeys = new Set(media.map((m) => m.key));
  const newKeys = media.map((m) => m.key).filter((k) => !storedKeys.has(k));
  const droppedKeys = stored.map((m) => m.key).filter((k) => !keptKeys.has(k));

  const statements: D1PreparedStatement[] = [
    // Fenced on everything the editability check read: a moderation reject
    // or a reward decision that landed meanwhile makes this change 0 rows.
    db
      .prepare(
        `UPDATE reviews
            SET stars = ?, body = ?, media = ?, order_id = ?, order_item_id = ?,
                status = 'published', quality_score = ?, quality_summary = ?
          WHERE id = ? AND user_id = ? AND source = 'user' AND status <> 'rejected'
            AND NOT EXISTS (SELECT 1 FROM review_rewards x
                             WHERE x.review_id = reviews.id AND x.state IN ('approved', 'rejected'))`
      )
      .bind(stars, body, JSON.stringify(media), facts.order_id, facts.order_item_id, quality.score, JSON.stringify(quality), id, user.id),
  ];
  if (newKeys.length) statements.push(closeReviewMediaStagingStatement(db, newKeys, id));
  if (existing.reward_id && existing.reward_kind === 'printer_gift') {
    statements.push(
      ...rewardAfterEditStatements(db, {
        rewardId: existing.reward_id,
        reviewId: id,
        textOk: true,
        familyOk: !!family,
        nowIso: now,
        qualitySnapshot: JSON.stringify(quality),
      })
    );
  } else if (!existing.reward_id && family && stars === 5) {
    statements.push(
      admitPrinterGiftStatement(db, {
        rewardId: newId('rr'),
        reviewId: id,
        textOk: true,
        familyOk: true,
        nowIso: now,
        qualitySnapshot: JSON.stringify(quality),
      })
    );
  }
  if (!facts.gift_line) statements.push(...(await fallbackPointsStatements(db, user.id, id, now)));

  const results = await db.batch(statements);
  if (Number(results[0]?.meta?.changes ?? 0) === 0) {
    // Decided or moderated between the read and the write: nothing of this
    // edit was stored (every later statement is fenced on the stored row).
    throw conflict('This review can no longer be edited', 'REVIEW_NOT_EDITABLE');
  }
  if (droppedKeys.length) {
    // After the commit, never inside it (mediaRefs.enqueueMediaDetach): the
    // guarded cleanup re-checks every reference before deleting a byte.
    try {
      await enqueueMediaDetach(db, droppedKeys, existing.product_id);
    } catch (error) {
      console.error('review media detach could not be queued', error instanceof Error ? error.message : error);
    }
  }
  return c.json({
    success: true,
    review: await loadMyReview(db, user.id, id),
    gift: await giftOutcome(db, id, family),
  });
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

/**
 * The OWNER's view of their review (/mine, /eligibility, /order, POST, PUT).
 * Media items carry their `key` so the sheet can send the full list back on
 * an edit — it is in the URL anyway, and this view never leaves its owner.
 * Quality is advice; a reward shows a level only once an admin decided one.
 */
function myReviewView(r: Record<string, unknown>) {
  const evidence = parseEvidence(r.instagram_evidence);
  const stored = safeParse<MediaEntry[]>(r.media, []);
  const keys = (Array.isArray(stored) ? stored : []).filter((m) => m && typeof m.key === 'string').map((m) => m.key);
  const approvedLevel =
    r.reward_state === 'approved' && r.reward_quality_score != null ? Number(r.reward_quality_score) : null;
  return {
    id: r.id,
    product_id: r.product_id,
    product_name: r.product_name,
    product_name_ar: r.product_name_ar,
    product_slug: r.product_slug,
    order_id: r.order_id ?? null,
    stars: r.stars,
    body: r.body,
    media: publicMedia(r.media).map((m, i) => ({ ...m, key: keys[i] })),
    source: r.source ?? 'user',
    system_generated: (r.source ?? 'user') === 'system',
    quality: advisoryQuality(r.quality_summary),
    status: r.status, // pending | published | rejected
    moderation_note: r.moderation_note ?? '',
    created_at: r.created_at,
    fallback_points_awarded: Number(r.fallback_points_awarded) || 0,
    can_edit: reviewEditable(r),
    reward: r.reward_id ? {
      kind: r.kind,
      state: r.reward_state,
      // The ADMIN's level, once decided — never a predicted one.
      quality_score: approvedLevel,
      level: approvedLevel,
      quality: advisoryQuality(r.quality_snapshot),
      reason: r.reward_reason ?? '',
      points_awarded: Number(r.points_awarded) || 0,
      // Own legacy evidence back to its owner only — never in public payloads.
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
 * review (with `can_edit`), the printer-gift hint (`gift` — from the server's
 * own rule, never guessed by the client), the media limits and the honest
 * state of the review-points configuration (no invented values).
 */
reviewRoutes.get('/eligibility/:productId', requireAuth, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const productId = c.req.param('productId') ?? '';
  const { results: orders } = await db.prepare(
    `SELECT DISTINCT o.id, o.delivered_at, o.created_at
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = ? AND oi.product_id = ?
        AND (o.delivered_at IS NOT NULL OR o.status = 'delivered')
      ORDER BY o.created_at DESC LIMIT 20`
  )
    .bind(user.id, productId)
    .all<{ id: string; delivered_at: string | null; created_at: string }>();
  const existing = await db.prepare('SELECT id, source FROM reviews WHERE user_id = ? AND product_id = ?')
    .bind(user.id, productId)
    .first<{ id: string; source?: string }>();
  const existingView = existing ? await loadMyReview(db, user.id, existing.id) : null;
  const isPrinter = await isPrinterProduct(db, productId);
  const points = await getReviewPointsValue(db);
  return c.json({
    success: true,
    eligible_orders: orders.map((o) => ({ id: o.id, delivered_at: o.delivered_at })),
    existing_review: existingView,
    can_replace_system_review: (existing?.source ?? 'user') === 'system',
    can_edit: existingView?.can_edit ?? false,
    is_printer: isPrinter,
    gift: await giftPreview(db, { userId: user.id, productId }),
    media_limits: MEDIA_LIMITS,
    // null = not configured (honest state); a number = configured award.
    review_points: points,
  });
});

/**
 * GET /api/reviews/order/:orderId — WHAT IS LEFT TO REVIEW IN ONE ORDER.
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
 * Each line also carries the printer-gift hint (`gift`), whether its review
 * may still be edited (`can_edit`) and the media limits, so the sheet never
 * guesses any of them. `remaining` counts only what POST would accept.
 */
reviewRoutes.get('/order/:orderId', requireAuth, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const orderId = c.req.param('orderId') ?? '';
  const order = await db.prepare('SELECT id, status, delivered_at FROM orders WHERE id = ? AND user_id = ?')
    .bind(orderId, user.id)
    .first<{ id: string; status: string; delivered_at: string | null }>();
  if (!order) throw notFound('Order not found');
  const delivered = !!order.delivered_at || order.status === 'delivered';

  // One pass: every catalog-backed line of the order with this customer's
  // review of that product beside it, if any. The JOIN on products drops
  // mystery spools (NULL product_id) and products since deleted — neither can
  // carry a review row.
  const { results: rows } = await db.prepare(
    `SELECT oi.id AS order_item_id, oi.product_id,
            oi.name_snapshot, oi.image_snapshot, oi.option_snapshot,
            p.category_id, p.sub_category_id, p.template_family,
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
      category_id: string | null;
      sub_category_id: string | null;
      template_family: string | null;
      review_id: string | null;
    }>();

  const seen = new Set<string>();
  const unique = (rows ?? []).filter((r) => !seen.has(r.product_id) && seen.add(r.product_id));
  const printers = await printerProductIds(db, unique.map((r) => r.product_id));
  const points = await getReviewPointsValue(db);
  const idx = unique.length ? await catalogIndexFor(db) : null;

  const lines = [];
  for (const r of unique) {
    // The same view the per-product endpoint returns, so the sheet reads one
    // shape whichever endpoint answered.
    const existing = r.review_id ? await loadMyReview(db, user.id, r.review_id) : null;
    const isSystem = !!existing && (existing.source === 'system' || existing.system_generated === true);
    const family: PrinterGiftFamily | null = idx ? printerGiftFamily(r, idx) : null;
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
      can_edit: !!existing && !isSystem && existing.can_edit,
      state: !delivered ? 'not_delivered' : existing && !isSystem ? 'reviewed' : 'reviewable',
      gift: await giftPreview(db, { userId: user.id, productId: r.product_id, family }),
      media_limits: MEDIA_LIMITS,
    });
  }

  return c.json({
    success: true,
    order_id: order.id,
    delivered,
    // null = not configured (honest state); a number = configured award.
    review_points: points,
    media_limits: MEDIA_LIMITS,
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
 * Only a BUYER uploads review media. With `productId` (what the review sheet
 * sends) the caller must hold an order of that product, delivered — the same
 * answers POST gives (404, then ORDER_NOT_DELIVERED). An older client that
 * names no product must at least have one delivered order of a catalog
 * product: nobody else is ever shown a review form, so nobody else may fill
 * the private bucket.
 */
async function assertReviewUploader(db: D1Database, userId: string, productId: string): Promise<void> {
  if (productId) {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n,
                MAX(CASE WHEN o.delivered_at IS NOT NULL OR o.status = 'delivered' THEN 1 ELSE 0 END) AS delivered
           FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE o.user_id = ? AND oi.product_id = ?`
      )
      .bind(userId, productId)
      .first<{ n: number; delivered: number | null }>();
    if (!row || !Number(row.n)) throw notFound('Order not found or it does not contain this product');
    if (!Number(row.delivered)) {
      throw badRequest('You can review this product after your order is delivered', 'ORDER_NOT_DELIVERED');
    }
    return;
  }
  const any = await db
    .prepare(
      `SELECT 1 AS x FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id
        WHERE o.user_id = ? AND (o.delivered_at IS NOT NULL OR o.status = 'delivered')
        LIMIT 1`
    )
    .bind(userId)
    .first();
  if (!any) throw notFound('There is no delivered order to review');
}

const uploadTooLarge = (maxBytes: number) =>
  badRequest(
    `The file is too large: photos up to ${IMAGE_MAX / (1024 * 1024)} MB, videos up to ${VIDEO_MAX / (1024 * 1024)} MB`,
    'REVIEW_UPLOAD_TOO_LARGE',
    { max_bytes: maxBytes }
  );

const UPLOAD_REFUSAL: Record<'REVIEW_UPLOAD_UNSUPPORTED' | 'IMAGE_HEIC_UNSUPPORTED' | 'VIDEO_UNSUPPORTED', string> = {
  REVIEW_UPLOAD_UNSUPPORTED:
    'This file type is not supported — upload a JPEG, PNG or WebP photo, or an MP4, MOV or WebM video',
  IMAGE_HEIC_UNSUPPORTED: HEIF_REFUSAL,
  VIDEO_UNSUPPORTED: 'This video cannot be played in a browser — export it as MP4 and upload it again',
};

/**
 * POST /api/reviews/uploads — ONE review photo or video (multipart
 * `{purpose:'media', file, productId}`). The Instagram-evidence capture is no
 * longer collected (`purpose` other than 'media' is refused).
 *
 * The BYTES decide (worker/lib/reviews/media.ts `sniffReviewUpload`), never
 * the file name or the browser's type: JPEG/PNG/WebP/GIF/AVIF photos (JPEG
 * and PNG are converted to WebP by `storeMedia`), MP4/MOV/WebM videos with a
 * real, playable video track. HEIC → IMAGE_HEIC_UNSUPPORTED, a video a
 * browser cannot play → VIDEO_UNSUPPORTED, anything else →
 * REVIEW_UPLOAD_UNSUPPORTED; photos ≤ 8 MB, videos ≤ 40 MB →
 * REVIEW_UPLOAD_TOO_LARGE.
 *
 * THROUGH THE ONE DOOR: `storeMedia` files it privately under
 * `reviews/<uid>/photos|video/<id>.<ext>` with the SHA-256 of the bytes as
 * they arrived in the object's metadata (what the attach step reads to refuse
 * duplicates). Served only by GET /api/reviews/media/* below. Every upload
 * starts life as a 24-hour staging job of the existing media cleanup; the
 * review that attaches it closes the job, and an upload nobody attaches is
 * deleted by the guarded cron.
 */
reviewRoutes.post('/uploads', requireAuth, async (c) => {
  await rateLimit(c, 'review_upload', 40, 3600);
  const user = c.get('user')!;
  const db = c.env.DB;
  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data');
  oneOf(form.get('purpose') ?? 'media', 'purpose', ['media'] as const);
  const productId = str(form.get('productId') ?? '', 'productId', { max: 60, required: false });
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file uploaded');
  await assertReviewUploader(db, user.id, productId);
  if (file.size > VIDEO_MAX) throw uploadTooLarge(VIDEO_MAX);

  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.byteLength > VIDEO_MAX) throw uploadTooLarge(VIDEO_MAX);
  const sniffed = sniffReviewUpload(buf);
  if (!sniffed.ok) throw badRequest(UPLOAD_REFUSAL[sniffed.code], sniffed.code);
  if (sniffed.kind === 'image' && buf.byteLength > IMAGE_MAX) throw uploadTooLarge(IMAGE_MAX);

  const sha256 = await digestBytes(buf);
  let stored: Awaited<ReturnType<typeof storeMedia>>;
  try {
    stored = await storeMedia(c.env, {
      placement: {
        visibility: 'private',
        domain: 'reviews',
        entityId: user.id,
        kind: sniffed.kind === 'video' ? 'video' : 'photos',
        objectId: newId(),
      },
      bytes: buf,
      mime: sniffed.mime,
      ownerId: user.id,
      originalName: file.name,
      cacheControl: 'private, no-cache',
      customMetadata: { sha256 },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The signature said "image" but the image service could not decode it.
    if (message.startsWith('IMAGE_TOO_LARGE_TO_CONVERT')) throw uploadTooLarge(IMAGE_MAX);
    if (message.startsWith('IMAGE_CONVERT_FAILED')) {
      throw badRequest(UPLOAD_REFUSAL.REVIEW_UPLOAD_UNSUPPORTED, 'REVIEW_UPLOAD_UNSUPPORTED');
    }
    throw error;
  }
  try {
    await reviewMediaStagingStatement(db, stored.key, Date.now()).run();
  } catch (error) {
    // No cleanup intent, no upload: an object nothing would ever remove is
    // worse than a retry.
    try {
      await deleteMediaObject(c.env, 'private', stored.key);
    } catch {
      // The bucket is unreachable too; the error below is the answer.
    }
    throw error;
  }
  return c.json({
    success: true,
    key: stored.key,
    kind: sniffed.kind,
    sha256,
    bytes: stored.bytes,
    url: mediaUrl(stored.key),
  });
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
  // Strict charset: our keys are hex ids under fixed prefixes.
  //
  // THE CHARSET IS NOT WHAT KEEPS THE LOOKUP HONEST, AND IT ONCE CLAIMED TO BE.
  // This comment used to add "no %/_ wildcards can widen the match" — while
  // `_` sat inside the character class one line below, and `_` is a LIKE
  // wildcard matching any single character. The guard did not do the thing it
  // said it did. Nothing was reachable through it, because `newId` emits hex
  // and no stored key contains `_`, so a widened match could only ever agree
  // with a key that does not exist in R2 — but a rule that is wrong for an
  // incidental reason is a rule waiting for the key format to change.
  //
  // So the query below no longer uses LIKE at all, and this is back to being
  // exactly what it looks like: a path sanity check.
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
      /**
       * IS THIS EXACT KEY AN ITEM OF A PUBLISHED REVIEW'S MEDIA?
       *
       * `json_each` walks the stored array and `json_extract` reads the `key`
       * field of each entry, so the comparison is `=` on the field that means
       * what we are asking about — not a substring search over the
       * serialised JSON.
       *
       * INDEX-BACKED. A review key names its uploader (`reviews/<uid>/…`, and
       * only the uploader can attach it), so only THAT customer's reviews can
       * hold it: `user_id` is read out of the one bound key, in SQL, and the
       * lookup is a search of the (user_id, …) index — a handful of rows —
       * instead of a walk of every published review on every image request.
       */
      const hit = await c.env.DB.prepare(
        `SELECT 1 AS x FROM reviews
          WHERE user_id = substr(?1, 9, instr(substr(?1, 9), '/') - 1)
            AND status = 'published'
            AND EXISTS (
              SELECT 1 FROM json_each(reviews.media) AS m
               WHERE json_extract(m.value, '$.key') = ?1
            )
          LIMIT 1`
      )
        .bind(key)
        .first();
      allowed = !!hit;
      isPublic = allowed;
    }
  }
  if (!allowed) throw notFound();

  /**
   * A REVIEW VIDEO HAS TO PLAY ON AN IPHONE.
   *
   * Safari opens a `<video>` with `Range: bytes=0-1` and reads a 200 carrying
   * the whole clip as "this server cannot stream" — a forty-megabyte review
   * video showed as a dead player on exactly the phones most customers hold.
   * So a Range is answered with 206 and the bytes asked for, a range past the
   * end with 416, and `If-Range` against a changed object with the whole new
   * file. The size comes from a HEAD first, and all of it runs AFTER the
   * authorisation above — a range is a way of reading a file, never a way
   * around the question of whether you may.
   */
  const rangeHeader = c.req.header('Range');
  let range: { offset: number; length: number } | null = null;
  let totalSize = 0;
  if (rangeHeader) {
    const head = await headMediaObject(c.env, 'private', key);
    if (!head) throw notFound();
    const ifRange = c.req.header('If-Range');
    if (!ifRange || ifRange === head.httpEtag) {
      const parsed = parseByteRange(rangeHeader, head.size);
      if (parsed === 'unsatisfiable') {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${head.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' },
        });
      }
      if (parsed) {
        range = parsed;
        totalSize = head.size;
      }
    }
  }

  const obj = await getMediaObject(c.env, 'private', key, range ? { range } : undefined);
  if (!obj) throw notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  /**
   * PUBLIC HERE IS A REVOCABLE DECISION, SO THE CACHE MUST ASK EVERY TIME.
   *
   * `isPublic` is not a property of the object. It is the answer to a question
   * asked of the database a few lines above — "is this key an item of a
   * PUBLISHED review's media?" — and that answer changes. A review gets
   * moderated, an author retracts it, an admin unpublishes a whole product's
   * reviews. The object does not move; the permission does.
   *
   * A fixed public lifetime told every shared cache and every browser to serve
   * the photo for an hour WITHOUT asking again, so for that hour an
   * unpublished review's media stayed readable by anyone holding the URL, and
   * nothing in the unpublish path could reach into those caches to stop it.
   *
   * `no-cache` is the correct instruction and it is not the same as
   * `no-store`: caches may keep the bytes, they simply may not serve them
   * without revalidating. With the ETag above that revalidation is a 304 with
   * no body — so the bandwidth saving survives almost intact, and the
   * permission is re-checked on every single request, which is the point.
   *
   * `reviews-evidence/` keeps `no-store`: seller-dispute material should not
   * be sitting in a cache at all, revalidated or otherwise.
   */
  headers.set(
    'Cache-Control',
    key.startsWith('reviews-evidence/') ? 'no-store' : isPublic ? 'public, no-cache' : 'private, no-cache'
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Accept-Ranges', 'bytes');
  /**
   * …and the revalidation it asks for is answered properly.
   *
   * `no-cache` is only cheap if a conditional request can come back 304. This
   * handler always streamed the body, so telling caches to revalidate would
   * have turned every hit into a full re-download. The check happens AFTER the
   * authorisation above, so a 304 is never a way to learn that an object
   * exists without being allowed to see it.
   */
  if (c.req.header('If-None-Match') === obj.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${totalSize}`);
    headers.set('Content-Length', String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
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

// ------------------------------------------------------ admin: every review

/** Products whose OWN section puts them in the printer-gift program (the admin list's `printer` filter). */
async function printerProgramProductIds(db: D1Database): Promise<string[]> {
  const idx = await catalogIndexFor(db);
  // A family needs one of the program's sections on the product's own branch
  // (eligibility.ts PRINTER_GIFT_SECTIONS): narrow in SQL, decide in TS.
  const sections = new Set<string>([PRINTER_GIFT_SECTIONS.printersRoot, PRINTER_GIFT_SECTIONS.laserRoot]);
  for (const root of [PRINTER_GIFT_SECTIONS.fdm, PRINTER_GIFT_SECTIONS.resin, PRINTER_GIFT_SECTIONS.laser]) {
    for (const id of idx.subtree(root)) sections.add(id);
  }
  const { results } = await db
    .prepare(
      `SELECT id, category_id, sub_category_id, template_family FROM products
        WHERE COALESCE(NULLIF(sub_category_id, ''), category_id) IN (SELECT value FROM json_each(?))`
    )
    .bind(JSON.stringify([...sections]))
    .all<{ id: string; category_id: string | null; sub_category_id: string | null; template_family: string | null }>();
  return (results ?? []).filter((p) => printerGiftFamily(p, idx) !== null).map((p) => p.id);
}

function encodeAdminCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify([createdAt, id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeAdminCursor(raw: string | undefined): { at: string; id: string } | null {
  if (!raw || raw.length > 400) return null;
  try {
    const v = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') return { at: v[0], id: v[1] };
  } catch {
    // A malformed cursor reads as the first page.
  }
  return null;
}

/**
 * GET /api/reviews/admin/reviews — EVERY review, newest first: published,
 * pending and rejected; customer-written and the seven-day system markers;
 * with or without a reward (LEFT JOIN — a one-star review of a filament
 * reaches the panel exactly like a printer-gift candidate). Keyset paging on
 * (created_at DESC, id DESC).
 *
 * Filters: `status` (pending|published|rejected), `source` (user|system),
 * `stars` (1–5), `printer` (1 = the product is in the printer-gift program by
 * its own section, 0 = it is not), `has_media` (1|0), `q` (review, order or
 * product id; customer email, username or name; product name), `limit` ≤ 50,
 * `cursor`. Moderation stays POST /admin/:id/moderate; the gift decision is
 * routes/gifts.ts. A reward shows a level only once an admin decided it.
 */
reviewRoutes.get('/admin/reviews', async (c) => {
  const db = c.env.DB;
  const q = (name: string) => (c.req.query(name) ?? '').trim();
  const status = ['pending', 'published', 'rejected'].includes(q('status')) ? q('status') : '';
  const source = ['user', 'system'].includes(q('source')) ? q('source') : '';
  const stars = /^[1-5]$/.test(q('stars')) ? Number(q('stars')) : 0;
  const printer = q('printer') === '1' ? true : q('printer') === '0' ? false : null;
  const hasMedia = q('has_media') === '1' ? true : q('has_media') === '0' ? false : null;
  const search = q('q').slice(0, 100);
  const limit = Math.max(1, Math.min(50, Number.parseInt(q('limit'), 10) || 20));
  const cursor = decodeAdminCursor(q('cursor'));

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    where.push('r.status = ?');
    binds.push(status);
  }
  if (source) {
    where.push("COALESCE(r.source, 'user') = ?");
    binds.push(source);
  }
  if (stars) {
    where.push('r.stars = ?');
    binds.push(stars);
  }
  if (hasMedia !== null) {
    const withMedia = "(json_valid(r.media) AND json_array_length(r.media) > 0)";
    where.push(hasMedia ? withMedia : `NOT ${withMedia}`);
  }
  if (printer !== null) {
    where.push(`r.product_id ${printer ? '' : 'NOT '}IN (SELECT value FROM json_each(?))`);
    binds.push(JSON.stringify(await printerProgramProductIds(db)));
  }
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(
      `(r.id = ? OR r.order_id = ? OR r.product_id = ?
        OR u.email LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\'
        OR p.name LIKE ? ESCAPE '\\' OR p.name_ar LIKE ? ESCAPE '\\')`
    );
    binds.push(search, search, search, like, like, like, like, like);
  }
  if (cursor) {
    where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');
    binds.push(cursor.at, cursor.at, cursor.id);
  }

  const { results } = await db
    .prepare(
      `SELECT r.id, r.created_at, r.stars, r.body, r.media, r.status, r.source, r.moderation_note,
              r.order_id, r.order_item_id, r.fallback_points_awarded, r.quality_summary,
              u.id AS customer_id, u.email, u.username, u.name AS customer_name,
              p.id AS product_id, p.name AS product_name, p.name_ar AS product_name_ar, p.slug AS product_slug,
              p.category_id, p.sub_category_id, p.template_family,
              rr.id AS reward_id, rr.kind AS reward_kind, rr.state AS reward_state,
              rr.quality_score AS reward_level, rr.unit_id AS reward_unit_id
         FROM reviews r
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN products p ON p.id = r.product_id
         LEFT JOIN review_rewards rr ON rr.review_id = r.id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ?`
    )
    .bind(...binds, limit + 1)
    .all<Record<string, unknown>>();

  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const idx = page.length ? await catalogIndexFor(db) : null;
  const last = page[page.length - 1];
  return c.json({
    success: true,
    reviews: page.map((r) => {
      const source = String(r.source ?? 'user');
      return {
        review_id: r.id,
        created_at: r.created_at,
        stars: r.stars,
        body: r.body,
        media: publicMedia(r.media),
        status: r.status,
        source,
        system_generated: source === 'system',
        moderation_note: r.moderation_note ?? '',
        customer: { id: r.customer_id ?? null, email: r.email ?? null, username: r.username ?? null, name: r.customer_name ?? null },
        product: {
          id: r.product_id ?? null,
          name: r.product_name ?? null,
          name_ar: r.product_name_ar ?? null,
          slug: r.product_slug ?? null,
          family: idx && r.product_id ? printerGiftFamily(r, idx) : null,
        },
        order_id: r.order_id ?? null,
        order_item_id: r.order_item_id ?? null,
        fallback_points_awarded: Number(r.fallback_points_awarded) || 0,
        quality: advisoryQuality(r.quality_summary),
        reward: r.reward_id
          ? {
              id: r.reward_id,
              kind: r.reward_kind,
              state: r.reward_state,
              level: r.reward_state === 'approved' && r.reward_level != null ? Number(r.reward_level) : null,
              unit_id: r.reward_unit_id ?? null,
            }
          : null,
      };
    }),
    next_cursor: rows.length > limit && last ? encodeAdminCursor(String(last.created_at), String(last.id)) : null,
  });
});
