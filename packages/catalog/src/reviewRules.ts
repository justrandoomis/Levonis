/**
 * THE REVIEW RULES, ONCE, FOR THE SERVER AND THE SPA (docs/REVIEWS_GIFTS.md §Text).
 *
 * The Worker imports this as `@levonis/catalog/reviewRules` (POST/PUT
 * /api/reviews refuse with the codes below; the printer-gift admission binds
 * the verdict), and the SPA imports it by relative path
 * (`../../../packages/catalog/src/reviewRules`) for the live «x/30» counter in
 * ReviewSheet. Pure: no I/O, no imports.
 *
 * WHAT "30 REAL CHARACTERS" MEANS — decided, not left to taste:
 *  1. The body is trimmed; more than 4000 UTF-16 units of the trimmed body is
 *     TOO_LONG (the existing server boundary, unchanged).
 *  2. It is normalised: NFKC, format characters (zero-width joiners, bidi
 *     marks — \p{Cf}) and the Arabic tatweel «ـ» are removed, every run of
 *     whitespace becomes one space, and it is trimmed again.
 *  3. `length` is the number of code points of that normalised text; fewer
 *     than 30 is TOO_SHORT. Thirty spaces normalise to nothing.
 *  4. It is REPETITIVE (refused) when any of these holds:
 *       - fewer than 20 letters or digits (\p{L}\p{N}) — punctuation and
 *         emoji do not make a review;
 *       - fewer than 5 distinct letters or digits — «هههههه…», «!!!!…»,
 *         «ababab…»;
 *       - fewer than 3 distinct words — «ممتاز ممتاز ممتاز …»;
 *       - the text without spaces is one unit of 1–6 characters repeated
 *         5 or more times — «جيد جيد جيد جيد جيد جيد».
 *     An honest short sentence in Arabic, Sorani or English passes.
 *  System reviews (empty body, source 'system') never pass through this.
 */

export const REVIEW_LIMITS = {
  /** Real characters (code points after normalisation). */
  minChars: 30,
  /** UTF-16 length of the trimmed raw body — the server's long-standing cap. */
  maxChars: 4000,
  minLettersOrDigits: 20,
  minDistinctLettersOrDigits: 5,
  minDistinctWords: 3,
  maxImages: 10,
  maxVideos: 2,
  /** Byte caps of the existing review upload door (worker/routes/reviews.ts
   *  IMAGE_MAX / VIDEO_MAX, pinned by services/gateway/test/uploadClasses). */
  imageMaxBytes: 8 * 1024 * 1024,
  videoMaxBytes: 40 * 1024 * 1024,
} as const;

export type ReviewTextCode = 'REVIEW_TEXT_TOO_SHORT' | 'REVIEW_TEXT_TOO_LONG' | 'REVIEW_TEXT_REPETITIVE';

export type ReviewTextVerdict =
  | { ok: true; length: number; normalized: string }
  | { ok: false; code: ReviewTextCode; length: number; normalized: string };

/** Step 2 of the rule: what the counter counts. */
export function normalizeReviewBody(raw: string): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cf}ـ]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function checkReviewText(raw: string): ReviewTextVerdict {
  const trimmed = String(raw ?? '').trim();
  const normalized = normalizeReviewBody(trimmed);
  const length = Array.from(normalized).length;
  if (trimmed.length > REVIEW_LIMITS.maxChars) return { ok: false, code: 'REVIEW_TEXT_TOO_LONG', length, normalized };
  if (length < REVIEW_LIMITS.minChars) return { ok: false, code: 'REVIEW_TEXT_TOO_SHORT', length, normalized };

  const alnum = normalized.match(/[\p{L}\p{N}]/gu) ?? [];
  const distinctAlnum = new Set(alnum.map((ch) => ch.toLowerCase())).size;
  const words = normalized
    .split(' ')
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())
    .filter(Boolean);
  const distinctWords = new Set(words).size;
  const compact = normalized.replace(/ /g, '');
  const repeatedUnit = /^(.{1,6}?)\1{4,}$/u.test(compact);
  if (
    alnum.length < REVIEW_LIMITS.minLettersOrDigits ||
    distinctAlnum < REVIEW_LIMITS.minDistinctLettersOrDigits ||
    distinctWords < REVIEW_LIMITS.minDistinctWords ||
    repeatedUnit
  ) {
    return { ok: false, code: 'REVIEW_TEXT_REPETITIVE', length, normalized };
  }
  return { ok: true, length, normalized };
}
