/**
 * «قيّم طابعتك»: THE GIFT CODE (owner, 2026-11-05; docs/DECISIONS.md row 301;
 * rewards policy version 7, chapter 8). The owner: «system reviwes from 1-100 to
 * give admin to user code to redeem his gift».
 *
 *   review ─► the system's score (worker/lib/reviewQuality.ts)
 *          ─► the admin confirms 1..100 and approves: `final_score` and a CODE,
 *             and NO gift yet (POST /api/reviews/admin/:id/reward)
 *          ─► the admin gives the code to the customer; nothing sends it
 *          ─► the customer writes it (POST /api/rewards/program/gift-code):
 *             ONE batch stamps the code used and creates the gift, a level gift
 *             of the highest level the score opened with `choice_scope = 'up_to'`
 *          ─► the analysis, the score, the levels, one gift, the cart, the order.
 *
 * WHAT THE CUSTOMER NEVER HEARS. Unknown, someone else's and regenerated codes
 * all answer one sentence (GIFT_CODE_INVALID), so the door tells a stranger
 * nothing. GIFT_CODE_USED goes only to the code's owner.
 *
 * WHAT THE CUSTOMER READS IS REAL. `reviewBreakdown` reads the parts the system
 * actually counted, and when the final score is not their sum the difference is
 * its own line (`adjustment`), never spread over the parts.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2). Before 0228 no row holds a code: a read that
 * names the new columns treats their absence as no code (`rewardCodeFacts`, the
 * door below), so every code answers GIFT_CODE_INVALID like any other.
 */
import type { Env } from '../types';
import { safeParse } from '../types';
import { HttpError } from '../http';
import { auditStatements } from '../audit';
import { isSchemaMissing } from '../membershipBenefits';
import { GIFT_SCORE_PARTS, clampGiftScore, giftLevelThreshold, giftLevelsForScore, maxGiftLevel } from '../../../packages/contracts/src/giftScore';
import { evaluateReviewQuality, reviewTextCounts, type ReviewQualityMedia, type ReviewQualityResult } from '../reviewQuality';
import { planGrant } from './grant';
import {
  activeLevelItems,
  changedExactlyOne,
  giftChoiceScope,
  isLostRace,
  levelItemChoice,
  loadCustomerGift,
  loadGiftRow,
  loadLevels,
  type GiftView,
  type Tri,
} from './model';
import { loadGiftProducts } from './selection';

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

// ---------------------------------------------------------------- the code

export const GIFT_CODE_PREFIX = 'GFT';
/** No 0, O, 1 or I: a code is read aloud over the phone and copied by hand. 32 letters, 5 bits each. */
export const GIFT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** The code's whole shape: ten characters, its prefix among them. */
export const GIFT_CODE_SHAPE = /^GFT[A-HJ-NP-Z2-9]{7}$/;

/** A new code: 7 random characters after the prefix, about 34 billion of them. */
export function newGiftCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return GIFT_CODE_PREFIX + [...bytes].map((b) => GIFT_CODE_ALPHABET[b & 31]).join('');
}

/**
 * What the customer wrote, as a code: upper case, without spaces or dashes, with
 * Arabic and Persian digits read as digits (a phone's Arabic keyboard writes ٢).
 */
export function normalizeGiftCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .slice(0, 64)
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[^0-9A-Za-z]/g, '')
    .toUpperCase();
}

/** The last characters only: enough for an audit row to tell two codes apart. A code never goes in the log whole. */
export const codeTail = (code: string): string => code.slice(-3);

// --------------------------------------------------------------- the offer

/** What one level offers right now. `sellable` is what a customer could actually choose today. */
export interface LevelOffer {
  level: number;
  active: boolean;
  items: number;
  sellable: number;
}

export type LevelWarningCode = 'GIFT_LEVEL_OFF' | 'GIFT_LEVEL_NO_ITEMS' | 'GIFT_LEVEL_SOLD_OUT';
export interface LevelWarning {
  level: number;
  code: LevelWarningCode;
}

/** Each of `levels`, read once: the levels' switches, their live items and whether those can be ordered. */
export async function levelOffer(env: { DB: D1Database }, levels: readonly number[] = [1, 2, 3, 4, 5]): Promise<LevelOffer[]> {
  const [views, items] = await Promise.all([loadLevels(env.DB), activeLevelItems(env.DB, levels)]);
  const products = await loadGiftProducts(env, items.map((i) => text(i.product_id)));
  return levels.map((level) => {
    const own = items.filter((i) => Number(i.level) === level);
    return {
      level,
      active: views.get(level)?.view.active === true,
      items: own.length,
      sellable: own.filter((i) => levelItemChoice(i, products.get(text(i.product_id)))?.available === true).length,
    };
  });
}

/** An opened level the customer will find nothing in, and why: the admin's screen says so. */
export function offerWarnings(offer: readonly LevelOffer[]): LevelWarning[] {
  return offer.flatMap((o): LevelWarning[] => {
    if (!o.active) return [{ level: o.level, code: 'GIFT_LEVEL_OFF' }];
    if (o.items === 0) return [{ level: o.level, code: 'GIFT_LEVEL_NO_ITEMS' }];
    if (o.sellable === 0) return [{ level: o.level, code: 'GIFT_LEVEL_SOLD_OUT' }];
    return [];
  });
}

/** Every opened level is empty: approving now would land the customer on nothing. */
export const offerIsEmpty = (offer: readonly LevelOffer[]): boolean => offer.every((o) => !o.active || o.sellable === 0);

// ------------------------------------------------------------ the breakdown

export interface GiftBreakdown {
  text: { score: number; max: number; chars: number; words: number };
  images: { score: number; max: number; count: number };
  video: { score: number; max: number; present: boolean };
  story: { score: number; max: number; present: boolean };
  stars: { score: number; max: number; stars: number };
  /** The final score less the parts: the system's penalties and the admin's own change. 0 when they agree. */
  adjustment: number;
}

const part = (v: unknown, max: number): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
};

/** The real parts of one review, from what the system recorded. Never an invented figure. */
export function reviewBreakdown(input: {
  finalScore: number;
  quality: Partial<ReviewQualityResult>;
  stars: number;
  body: string;
  hasStory: boolean;
}): GiftBreakdown {
  const { quality: q } = input;
  const counts = reviewTextCounts(input.body);
  const parts = {
    text: { score: part(q.textQuality, GIFT_SCORE_PARTS.text), max: GIFT_SCORE_PARTS.text, chars: Number(q.textChars) || counts.chars, words: Number(q.wordCount) || counts.words },
    images: { score: part(q.imageQuality, GIFT_SCORE_PARTS.images), max: GIFT_SCORE_PARTS.images, count: Number(q.imageCount) || 0 },
    video: { score: part(q.videoQuality, GIFT_SCORE_PARTS.video), max: GIFT_SCORE_PARTS.video, present: q.videoPresent === true },
    story: { score: input.hasStory ? GIFT_SCORE_PARTS.story : 0, max: GIFT_SCORE_PARTS.story, present: input.hasStory },
    stars: { score: input.stars >= 1 && input.stars <= 5 ? GIFT_SCORE_PARTS.stars : 0, max: GIFT_SCORE_PARTS.stars, stars: input.stars },
  };
  const sum = parts.text.score + parts.images.score + parts.video.score + parts.story.score + parts.stars.score;
  return { ...parts, adjustment: input.finalScore - sum };
}

// ---------------------------------------------------------------- the answer

export interface GiftRevealLevel {
  level: number;
  name: Tri;
  /** «يفتح عند 40»: the score that opens it. */
  threshold: number;
  opened: boolean;
}

/** POST /api/rewards/program/gift-code and GET /gift-reveal/:giftId. Everything the analysis draws, and nothing it invents. */
export interface GiftRevealAnswer {
  score: number;
  levels: number[];
  /** The five steps of the track, opened or not. Names only: a closed level's gifts are never sent. */
  track: GiftRevealLevel[];
  breakdown: GiftBreakdown;
  review: { product_id: string; slug: string; name: Tri; image: string; stars: number };
  gift: GiftView;
}

/** The reward row with everything the answer reads. */
const REWARD_SELECT = `
SELECT rr.*, r.stars AS review_stars, r.body AS review_body, r.media AS review_media, r.product_id AS review_product_id,
       p.slug AS product_slug, p.name AS product_name, p.name_ar AS product_name_ar, p.name_ku AS product_name_ku,
       p.images AS product_images
  FROM review_rewards rr
  JOIN reviews r ON r.id = rr.review_id
  LEFT JOIN products p ON p.id = r.product_id`;

/** The review came with its Instagram story: a link or a screenshot (`parseEvidence` in worker/routes/reviews.ts). */
function hasStoryEvidence(raw: unknown): boolean {
  const v = safeParse<{ link?: unknown; key?: unknown } | null>(raw, null);
  return !!v && (!!text(v.link) || !!text(v.key));
}

/** The score's parts as recorded; a row from before the snapshot is scored now, from the same review. */
function qualityOf(row: Record<string, unknown>, hasStory: boolean): Partial<ReviewQualityResult> {
  const stored = safeParse<Partial<ReviewQualityResult> | null>(row.quality_snapshot, null);
  if (stored && typeof stored.score === 'number') return stored;
  return evaluateReviewQuality({
    stars: Number(row.review_stars) || 0,
    body: text(row.review_body),
    media: (safeParse<ReviewQualityMedia[]>(row.review_media, []) ?? []).filter((m) => m && typeof m.key === 'string'),
    hasEvidence: hasStory,
    isPrinter: true,
  });
}

async function answerFor(env: Env, row: Record<string, unknown>, gift: GiftView): Promise<GiftRevealAnswer> {
  const score = clampGiftScore(Number(row.final_score));
  const levels = giftLevelsForScore(score);
  const names = await loadLevels(env.DB);
  const images = safeParse<unknown>(text(row.product_images) || '[]', []);
  const en = text(row.product_name);
  const hasStory = hasStoryEvidence(row.instagram_evidence);
  return {
    score,
    levels,
    track: [1, 2, 3, 4, 5].map((level) => ({
      level,
      name: names.get(level)?.view.name ?? { ar: '', en: '', ckb: '' },
      threshold: giftLevelThreshold(level),
      opened: levels.includes(level),
    })),
    breakdown: reviewBreakdown({
      finalScore: score,
      quality: qualityOf(row, hasStory),
      stars: Number(row.review_stars) || 0,
      body: text(row.review_body),
      hasStory,
    }),
    review: {
      product_id: text(row.review_product_id),
      slug: text(row.product_slug),
      name: { ar: text(row.product_name_ar) || en, en, ckb: text(row.product_name_ku) || en },
      image: Array.isArray(images) && typeof images[0] === 'string' ? (images[0] as string) : '',
      stars: Number(row.review_stars) || 0,
    },
    gift,
  };
}

const invalid = () => new HttpError(404, 'This code is not valid.', 'GIFT_CODE_INVALID');
const used = () => new HttpError(409, 'This code has already been used.', 'GIFT_CODE_USED');

/** The states a replay still shows: the gift is on its way. Once delivered or cancelled the code is simply used. */
const REPLAY_STATES: ReadonlySet<string> = new Set(['granted', 'ready_to_redeem', 'redeemed', 'ordered']);

async function replayAnswer(env: Env, userId: string, row: Record<string, unknown>): Promise<GiftRevealAnswer> {
  const giftRow = await env.DB.prepare('SELECT id, state FROM gift_entitlements WHERE reward_id = ? AND user_id = ?')
    .bind(text(row.id), userId)
    .first<{ id: string; state: string }>();
  if (!giftRow || !REPLAY_STATES.has(giftRow.state)) throw used();
  const gift = await loadCustomerGift(env, userId, giftRow.id);
  if (!gift) throw used();
  return answerFor(env, row, gift);
}

/**
 * THE CUSTOMER WRITES THE CODE. In ONE batch: the code is stamped used, the gift
 * is born (no «وصلتك هدية»: the customer is looking at it), and both audit rows.
 * The UPDATE names the code and that it is unused, and its fence rolls everything
 * back on a lost race; UNIQUE(reward_id) refuses a second gift whatever happens.
 * Whoever loses a race, or presses again, answers exactly what the winner did.
 */
export async function redeemGiftCode(env: Env, userId: string, raw: unknown): Promise<GiftRevealAnswer & { replay: boolean }> {
  const code = normalizeGiftCode(raw);
  if (!GIFT_CODE_SHAPE.test(code)) throw invalid();
  const row = await env.DB.prepare(`${REWARD_SELECT} WHERE rr.redeem_code = ?`)
    .bind(code)
    .first<Record<string, unknown>>()
    .catch((e: unknown) => {
      // No column, no code: the same answer as an unknown one.
      if (isSchemaMissing(e)) return null;
      throw e;
    });
  if (!row || text(row.user_id) !== userId || text(row.state) !== 'approved') throw invalid();
  if (row.code_redeemed_at) return { ...(await replayAnswer(env, userId, row)), replay: true };

  const score = clampGiftScore(Number(row.final_score));
  const now = new Date().toISOString();
  const level = maxGiftLevel(score);
  const plan = await planGrant(env.DB, {
    userId,
    level,
    reason: 'review',
    note: text(row.reason),
    actorId: text(row.decided_by) || 'system',
    rewardId: text(row.id),
    now,
    choiceScope: 'up_to',
    silent: true,
    auditExtra: {
      review_id: text(row.review_id),
      reward_id: text(row.id),
      product_id_reviewed: text(row.review_product_id) || null,
      final_score: score,
      levels: giftLevelsForScore(score),
      code_tail: codeTail(code),
      redeemed_by_customer: userId,
    },
  });
  const audit = await auditStatements(env.DB, userId, 'review.code.redeem', text(row.review_id), {
    user_id: userId,
    reward_id: text(row.id),
    final_score: score,
    level,
    gift_id: plan.id,
    code_tail: codeTail(code),
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE review_rewards SET code_redeemed_at = ?
          WHERE id = ? AND redeem_code = ? AND code_redeemed_at IS NULL AND state = 'approved'`
      ).bind(now, text(row.id), code),
      ...changedExactlyOne(env.DB),
      ...plan.statements,
      ...audit.statements,
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!isLostRace(e) && !message.includes('UNIQUE')) throw e;
    const fresh = await env.DB.prepare(`${REWARD_SELECT} WHERE rr.id = ?`).bind(text(row.id)).first<Record<string, unknown>>();
    // Regenerated in that instant: the code in hand no longer exists.
    if (!fresh || text(fresh.redeem_code) !== code) throw invalid();
    return { ...(await replayAnswer(env, userId, fresh)), replay: true };
  }
  const gift = await loadCustomerGift(env, userId, plan.id);
  if (!gift) throw invalid();
  return { ...(await answerFor(env, row, gift)), replay: false };
}

/**
 * THE SAME ANSWER FOR A GIFT ALREADY OPENED: the customer left, and comes back to
 * /rewards/rate at the right step without the code in hand. 404 for a gift that is
 * not this customer's or did not come from a code.
 */
export async function giftRevealFor(env: Env, userId: string, giftId: string): Promise<GiftRevealAnswer> {
  const g = await loadGiftRow(env.DB, giftId, userId);
  if (!g || !g.reward_id || giftChoiceScope(g) !== 'up_to') throw new HttpError(404, 'We could not find this gift on your account.', 'GIFT_NOT_FOUND');
  const [row, gift] = await Promise.all([
    env.DB.prepare(`${REWARD_SELECT} WHERE rr.id = ? AND rr.user_id = ?`).bind(text(g.reward_id), userId).first<Record<string, unknown>>(),
    loadCustomerGift(env, userId, giftId),
  ]);
  if (!row || !gift) throw new HttpError(404, 'We could not find this gift on your account.', 'GIFT_NOT_FOUND');
  return answerFor(env, row, gift);
}

// -------------------------------------------------------------- the readers

export interface RewardCodeFacts {
  final_score: number | null;
  code: string | null;
  code_issued_at: string | null;
  code_redeemed_at: string | null;
}

/**
 * The code columns of some rewards, for the admin's queue and the customer's
 * printers. Its own read, so those two keep their tested selects and a database
 * before 0228 answers an empty map.
 */
export async function rewardCodeFacts(db: D1Database, rewardIds: readonly string[]): Promise<Map<string, RewardCodeFacts>> {
  const ids = [...new Set(rewardIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  try {
    const { results } = await db
      .prepare('SELECT id, final_score, redeem_code, code_issued_at, code_redeemed_at FROM review_rewards WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids))
      .all<Record<string, unknown>>();
    return new Map(
      (results ?? []).map((r) => [
        text(r.id),
        {
          final_score: r.final_score == null ? null : Number(r.final_score),
          code: text(r.redeem_code) || null,
          code_issued_at: text(r.code_issued_at) || null,
          code_redeemed_at: text(r.code_redeemed_at) || null,
        },
      ])
    );
  } catch (e) {
    if (isSchemaMissing(e)) return new Map();
    throw e;
  }
}
