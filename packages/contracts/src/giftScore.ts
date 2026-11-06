/**
 * WHAT A REVIEW'S SCORE OPENS (owner, 2026-11-05; docs/DECISIONS.md row 301).
 * The owner: «every 20 score the level appear … like he eran 5 so only level 1
 * can select and appear, or 20 so 1 2 appear only and can select one only».
 *
 * ONE PURE RULE, used by the server (the approval, the code, «اختر هديتك») and by
 * the screens (the admin's live line, the customer's track):
 *
 *   levels opened = 1 + floor(score / 20), at most 5
 *
 *   5 → {1}   19 → {1}   20 → {1,2}   26 → {1,2}   40 → {1,2,3}
 *   60 → {1,2,3,4}   80 → {1,2,3,4,5}   100 → {1,2,3,4,5}
 *
 * The score is clamped to 1..100: the system's 0 still opens level 1 when an
 * admin approves it, and nothing opens a sixth level.
 */
export const GIFT_SCORE_MIN = 1;
export const GIFT_SCORE_MAX = 100;
export const GIFT_SCORE_STEP = 20;
export const GIFT_LEVEL_COUNT = 5;

/** The most each part of the system's score can give (worker/lib/reviewQuality.ts). They add up to 100. */
export const GIFT_SCORE_PARTS = { text: 42, images: 27, video: 18, story: 8, stars: 5 } as const;

/** A whole score in 1..100. Anything unreadable is the lowest score: it opens least. */
export function clampGiftScore(score: number): number {
  const n = Math.trunc(Number(score));
  if (!Number.isFinite(n)) return GIFT_SCORE_MIN;
  return Math.min(GIFT_SCORE_MAX, Math.max(GIFT_SCORE_MIN, n));
}

/** The highest level a score opens. */
export function maxGiftLevel(score: number): number {
  return Math.min(GIFT_LEVEL_COUNT, 1 + Math.floor(clampGiftScore(score) / GIFT_SCORE_STEP));
}

/** Every level a score opens, in order. */
export function giftLevelsForScore(score: number): number[] {
  return Array.from({ length: maxGiftLevel(score) }, (_, i) => i + 1);
}

/** The lowest score that opens a level: «يفتح عند 40» for level 3. Level 1 opens from the lowest score. */
export function giftLevelThreshold(level: number): number {
  const n = Math.min(GIFT_LEVEL_COUNT, Math.max(1, Math.trunc(Number(level)) || 1));
  return n === 1 ? GIFT_SCORE_MIN : (n - 1) * GIFT_SCORE_STEP;
}

/**
 * THE OLD SCREEN'S ANSWER, READ IN THE NEW SCALE. A tab opened before this rule
 * sends `qualityScore` 1..5, a level. It becomes the score that opens exactly
 * that level: the system's own when it already does, otherwise the nearest one
 * that does.
 */
export function scoreForOldLevel(level: number, systemScore: number | null | undefined): number {
  const n = Math.min(GIFT_LEVEL_COUNT, Math.max(1, Math.trunc(Number(level)) || 1));
  const low = giftLevelThreshold(n);
  const high = n === GIFT_LEVEL_COUNT ? GIFT_SCORE_MAX : n * GIFT_SCORE_STEP - 1;
  const system = typeof systemScore === 'number' && Number.isFinite(systemScore) ? Math.trunc(systemScore) : low;
  return Math.min(high, Math.max(low, system));
}
