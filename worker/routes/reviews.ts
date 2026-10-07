import { Hono } from 'hono';
import { isPrinterProduct, printerProductIds } from '../lib/printerIdentity';
import type { AppContext, Env } from '../lib/types';
import { getTierStatus } from '../lib/entitlements';
import { applyMultiplierX100, multiplierLabel, rewardMultiplierX100 } from '../lib/pointsMultiplier';
import { safeParse } from '../lib/types';
import {
  HttpError,
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
import { audit, auditStatements } from '../lib/audit';
import { notifyGiftGranted, planGrant } from '../lib/gifts/grant';
import { changedExactlyOne, isLostRace, loadLevels } from '../lib/gifts/model';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { parseByteRange, sniff } from './uploads';
import { getMediaObject, headMediaObject, storeMedia } from '../lib/mediaStorage';
import { notifyStatement } from '../lib/notifications';
import { isSchemaMissing } from '../lib/membershipBenefits';
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

/**
 * The legacy review boxes' composition now lives with the rest of the gift
 * code (worker/lib/gifts/legacy.ts); it is re-exported here for the readers
 * that have always found it on this module.
 */
export { LEVEL_COMPOSITION } from '../lib/gifts/legacy';

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
  /** 0175: the order line proving the purchase was a GIFT (S8) — no review reward. */
  gift_line?: boolean;
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

/**
 * THE REVIEW AWARD, AT THE REVIEWER'S SUBSCRIPTION MULTIPLIER.
 *
 * The owner's rule covers four surfaces — signing in, earning from tasks,
 * buying, and RATING — and this is the rating one. PREMIUM earns 1.5x and PRO
 * 2x on a review exactly as they do on a check-in, and for the same reason:
 * the multiplier belongs to the member, not to the kind of thing they did.
 *
 * SNAPSHOTTED, NEVER RECOMPUTED. The multiplier is resolved at the moment of
 * the award and the resulting number is what is written; an expired
 * subscription must not rewrite what a member already earned, and a new one
 * must not retroactively inflate it. That is the same discipline
 * `points_accruals` uses for a purchase.
 *
 * The 1x case is byte-identical to the previous behaviour, so a shop with no
 * subscribers sees no change at all.
 */
async function reviewAward(
  db: D1Database,
  userId: string,
  basePoints: number
): Promise<{ points: number; base: number; multiplierX100: number }> {
  const status = await getTierStatus(db, userId);
  const multiplierX100 = rewardMultiplierX100(status);
  return { points: applyMultiplierX100(basePoints, multiplierX100), base: basePoints, multiplierX100 };
}

/**
 * THE NOTE THE CUSTOMER READS IN THEIR OWN WALLET.
 *
 * It has to add up. `2x base` described the whole award while the fallback
 * was the only multiplier in play; once a membership multiplies it again, a
 * PRO sees 100 points credited under a note that explains 50. The 1x string
 * is left byte-identical, so nothing changes for a shop with no subscribers.
 */
function fallbackNote(multiplierX100: number): string {
  return multiplierX100 <= 100
    ? 'Valid manual review fallback (2x base)'
    : `Valid manual review fallback (2x base x ${multiplierLabel(multiplierX100)} membership)`;
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
  /**
   * THE PURCHASE PROOF IS A BOUGHT LINE (0175, decision S8). A gift line — a
   * product the customer was given at 0 IQD — never proves a purchase for a
   * review reward, so a bought line of the same product in the same order is
   * preferred, and a review proved only by a gift line earns nothing. A
   * database behind 0175 has no gift line at all, and is read without the
   * column rather than failing the review.
   */
  const read = (giftAware: boolean) =>
    db
      .prepare(
        `SELECT o.id, o.delivered_at, o.status, oi.id AS order_item_id${giftAware ? ', oi.gift_entitlement_id AS gift_id' : ''}
           FROM orders o JOIN order_items oi ON oi.order_id = o.id AND oi.product_id = ?
          WHERE o.id = ? AND o.user_id = ?
          ${giftAware ? 'ORDER BY (oi.gift_entitlement_id IS NOT NULL), oi.rowid' : ''}
          LIMIT 1`
      )
      .bind(input.productId, input.orderId, userId)
      .first<{ id: string; delivered_at: string | null; status: string; order_item_id: string; gift_id?: string | null }>();
  let order: Awaited<ReturnType<typeof read>>;
  try {
    order = await read(true);
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
    order = await read(false);
  }
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
    gift_line: !!order.gift_id,
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

  if (facts.gift_line) {
    // A GIFT TRIGGERS NO OTHER REWARD (S8): the review is published like any
    // other, and earns neither a reward row nor the fallback points.
  } else if (quality.rewardEligible && quality.tier !== null) {
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
      // `* 2` is the long-standing fallback rule for a valid manual review;
      // the SUBSCRIPTION multiplier then applies on top of it, because the
      // owner's rule is about who the member is, not what they did.
      const { points, multiplierX100 } = await reviewAward(c.env.DB, user.id, basePoints * 2);
      const sourceRef = `review-fallback:${reviewId}`;
      statements.push(
        c.env.DB.prepare('INSERT INTO points_awards (source_ref, user_id, points, created_at) VALUES (?, ?, ?, ?)')
          .bind(sourceRef, user.id, points, now),
        c.env.DB.prepare(
          `INSERT INTO wallet_transactions
             (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
           VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', ?)`
        ).bind(`wtx_review_fallback_${reviewId}`, user.id, points, fallbackNote(multiplierX100), sourceRef, now),
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

  /**
   * «📢 Review» — THE TOPIC THE OWNER OPENED FOR EXACTLY THIS, AND WHICH WAS
   * RECEIVING NOTHING.
   *
   * A review here is PUBLISHED THE MOMENT IT IS WRITTEN (see the route note
   * above): publication never waits for the reward decision. So the first time
   * anyone at the shop learned that a one-star review was live on a product
   * page was when a customer mentioned it. The only admin signal that existed
   * was `adminRewardNotifications` — an in-app row, and only for the minority
   * of reviews that qualify for a gift level. A complaint is not a gift
   * candidate, which means the reviews worth reacting to were precisely the
   * ones nobody was told about.
   *
   * THE TEXT IS NOT IN THE MESSAGE and does not need to be: the review is
   * public, the link is the product page, and a body of up to 4,000 characters
   * pasted into a group turns the topic into the thing the topic replaced. The
   * stars come first because they are what decides whether anyone opens it.
   *
   * After the batch has committed, and never able to throw: a review that was
   * saved must not report failure because Telegram was unreachable.
   */
  announceAfterResponse(
    c,
    'review',
    `📢 ${'★'.repeat(input.stars)}${'☆'.repeat(5 - input.stars)} (${input.stars}/5) review on ${input.productId}` +
      `\nReview: ${reviewId}` +
      `\nOrder: ${input.orderId}` +
      `\nQuality: ${quality.score}/100` +
      (!facts.gift_line && quality.rewardEligible && quality.tier !== null ? `\nReward level ${quality.tier} — awaiting an admin decision` : '')
  );

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
      // `* 2` is the long-standing fallback rule for a valid manual review;
      // the SUBSCRIPTION multiplier then applies on top of it, because the
      // owner's rule is about who the member is, not what they did.
      const { points, multiplierX100 } = await reviewAward(c.env.DB, user.id, basePoints * 2);
      const sourceRef = `review-fallback:${id}`;
      statements.push(
        c.env.DB.prepare('INSERT INTO points_awards (source_ref, user_id, points, created_at) VALUES (?, ?, ?, ?)')
          .bind(sourceRef, user.id, points, now),
        c.env.DB.prepare(
          `INSERT INTO wallet_transactions
             (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
           VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', ?)`
        ).bind(`wtx_review_fallback_${id}`, user.id, points, fallbackNote(multiplierX100), sourceRef, now),
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

  const sha256 = await digestBytes(buf);
  /**
   * THROUGH THE ONE DOOR — converted on the server, and filed where the rule
   * says.
   *
   * This wrote `reviews/<userId>/<id>.jpg` by hand: three segments where the
   * layout is four, and whatever the customer's phone produced, stored as it
   * arrived. A review photo is the commonest image on a product page after the
   * catalogue's own, and it was the one nobody converted.
   *
   * `storeMedia` takes the PARTS of a key and never the key, so the missing
   * `kind` segment cannot be forgotten again, and it decides the extension
   * from the bytes it actually stored — which is what stops a key claiming
   * `.jpg` over WebP or the reverse. A video passes through untouched: a
   * transform keeps one frame, and one frame of a video is not the video.
   */
  const stored = await storeMedia(c.env, {
    placement: {
      visibility: 'private',
      domain: purpose === 'evidence' ? 'reviews-evidence' : 'reviews',
      entityId: user.id,
      kind: isVideo ? 'video' : purpose === 'evidence' ? 'evidence' : 'photos',
      objectId: newId(),
    },
    bytes: buf,
    mime: kind.mime,
    ownerId: user.id,
    originalName: file.name,
    cacheControl: 'private, max-age=300',
  });
  const key = stored.key;
  return c.json({
    success: true,
    key,
    kind: isVideo ? 'video' : 'image',
    sha256,
    bytes: stored.bytes,
    url: mediaUrl(key),
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
       * field of each entry (worker/lib/reviewQuality.ts ReviewQualityMedia),
       * so the comparison is `=` on the field that means what we are asking
       * about — not a substring search over the serialised JSON.
       *
       * The previous `media LIKE '%"key"%'` had two problems beyond the
       * wildcard above: it matched the key ANYWHERE in the row, including in a
       * `mime` or a future field that happened to contain it, and it could
       * never use an index. This asks the real question.
       */
      const hit = await c.env.DB.prepare(
        `SELECT 1 AS x FROM reviews
          WHERE status = 'published'
            AND EXISTS (
              SELECT 1 FROM json_each(reviews.media) AS m
               WHERE json_extract(m.value, '$.key') = ?
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
   * A REVIEW'S VIDEO HAS TO PLAY ON AN iPHONE (plan §B.1 #9).
   *
   * Safari opens every `<video>` with `Range: bytes=0-1` and reads a 200
   * carrying the whole clip as «this server cannot stream» — so a customer's
   * review video, the most persuasive thing on a product page, was a dead
   * player on exactly the phones most customers hold. The same three answers
   * `/files/*` gives (worker/routes/uploads.ts): 206 with the bytes asked
   * for, 416 past the end, `Accept-Ranges: bytes` on everything; the size
   * from a HEAD so an unsatisfiable range reads no byte; `If-Range` honoured.
   * All of it AFTER the authorisation above — review media is private
   * storage with a per-request permission, never edge-cached, so the ranged
   * read goes to the bucket each time and a range is a way of reading, not a
   * way around the question of whether you may.
   */
  const rangeHeader = c.req.header('Range') ?? '';
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
  headers.set('Accept-Ranges', 'bytes');
  /**
   * PUBLIC HERE IS A REVOCABLE DECISION, SO THE CACHE MUST ASK EVERY TIME.
   *
   * `isPublic` is not a property of the object. It is the answer to a question
   * asked of the database a few lines above — "is this key an item of a
   * PUBLISHED review's media?" — and that answer changes. A review gets
   * moderated, an author retracts it, an admin unpublishes a whole product's
   * reviews. The object does not move; the permission does.
   *
   * `public, max-age=3600` told every shared cache and every browser to serve
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
    // The rule of the admin's «منح هدية» (routes/gifts.ts): a level the owner
    // switched off is granted by no one — not by hand, not by a review. The
    // admin approves with another quality score, or switches the level on.
    if (!(await loadLevels(c.env.DB)).get(score)!.view.active) {
      throw new HttpError(409, `Gift level ${score} is switched off — approve with another quality score, or switch the level on first.`, 'GIFT_LEVEL_INACTIVE', { level: score });
    }
    /**
     * THE APPROVAL GRANTS A LEVEL GIFT OF THE NEW FLOW (docs/GIFTS_QUICK_BUY.md
     * §1.2): level = the quality score, reason 'review', linked to the reward.
     * The customer then chooses one of the level's real store products on
     * /gifts and orders it through the cart at 0 IQD. The reward flip, the
     * grant, its audit row, the review audit row and the in-app notice are ONE
     * batch; the fence after the flip and UNIQUE(reward_id) make a concurrent
     * or replayed approval write nothing.
     */
    const plan = await planGrant(c.env.DB, {
      userId: String(row.user_id),
      level: score,
      reason: 'review',
      note: reason,
      actorId: admin.id,
      rewardId: String(row.reward_id),
      now,
      auditExtra: { review_id: id, reward_id: row.reward_id, product_id_reviewed: row.product_id ?? null },
    });
    const reviewAudit = await auditStatements(c.env.DB, admin.id, 'review.reward', id, {
      action: 'approve',
      kind: 'printer_gift',
      quality_score: score,
      reason,
      entitlement_id: plan.id,
    });
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE review_rewards SET state = 'approved', quality_score = ?, reason = ?, decided_by = ?, decided_at = ?
            WHERE id = ? AND state != 'approved'`
        ).bind(score, reason, admin.id, now, row.reward_id),
        ...changedExactlyOne(c.env.DB),
        ...plan.statements,
        ...reviewAudit.statements,
      ]);
    } catch (e) {
      if (isUniqueViolation(e) || isLostRace(e)) throw conflict('This reward was already approved');
      console.error('gift approval failed', e instanceof Error ? e.message : e);
      throw badRequest('Approval failed. Please try again.');
    }
    try {
      c.executionCtx.waitUntil(notifyGiftGranted(c.env, plan.id));
    } catch {
      /* no execution context (a test harness): the in-app notice already landed in the batch */
    }
    return c.json({ success: true, review_id: id, reward_state: 'approved', quality_score: score, entitlement_id: plan.id });
  }

  // kind === 'points'
  const reason = str(body.reason, 'reason', { min: 3, max: 1000 });
  const configured = await getReviewPointsValue(c.env.DB);
  if (configured === null) {
    throw unavailable(
      'Review point value is not configured yet (admin setting reviewPointsConfig) — no invented amounts',
      'REVIEW_POINTS_UNCONFIGURED'
    );
  }
  // The multiplier belongs to the REVIEWER, not to the admin approving it.
  const { points } = await reviewAward(c.env.DB, String(row.user_id), configured);
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
