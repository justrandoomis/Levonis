/**
 * The review text rule on the server — the SAME function the SPA's ReviewSheet
 * counter runs (packages/catalog/src/reviewRules.ts). Owner: lane S1.
 *
 * POST/PUT /api/reviews call `checkReviewText(body)` for `source='user'`
 * writes and answer 400 with `verdict.code` (REVIEW_TEXT_TOO_SHORT |
 * REVIEW_TEXT_TOO_LONG | REVIEW_TEXT_REPETITIVE). The printer-gift admission
 * binds `verdict.ok ? 1 : 0` as its text condition. Existing published
 * reviews are never re-judged by it.
 */
export {
  REVIEW_LIMITS,
  checkReviewText,
  normalizeReviewBody,
  type ReviewTextCode,
  type ReviewTextVerdict,
} from '@levonis/catalog/reviewRules';
