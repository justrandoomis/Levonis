/**
 * WHAT COUNTS AS SOLD — and why this shop deliberately has TWO answers.
 *
 * There were three, which is one too many. `worker/lib/compositionAnalytics.ts`
 * had its own local constant, `worker/routes/adminProducts.ts` counted
 * `status != 'cancelled'` (which includes an unpaid `pending` order that may
 * never be paid), and `worker/lib/salesBadge.ts` counts `delivered` only. The
 * first two disagreed about the same question; the third answers a different
 * question and is right to.
 *
 * THE TWO QUESTIONS.
 *
 *   "HAS THIS MOVED?" — demand. An order that is confirmed has been paid for
 *   and its stock has been deducted; the shop has sold the unit whatever the
 *   courier does next. This is the right measure for RANKING — a best-seller
 *   shelf that ignored everything still in transit would be a fortnight behind
 *   the shop, and a new product that sold out this week would not appear on it
 *   at all.
 *
 *   "HOW MANY HAVE ACTUALLY SOLD?" — a public claim, printed on the product
 *   page as «+50 مبيعات». `salesBadge.ts` answers that one, `delivered` only,
 *   and its own header explains why: a unit in a van may still be refused at
 *   the door, and the badge is read as "at least this many". That rule is
 *   STRICTER ON PURPOSE and must not be relaxed to match this file.
 *
 * So: rank with `SOLD_STATES`, claim with `delivered`. Both are defensible;
 * having each written down once is the part that was missing.
 */

/**
 * The order states in which stock has actually moved — the same set
 * `worker/lib/orderStageOps.ts` calls STOCK_DEDUCTED_STATES, which is what
 * makes revenue here match revenue there.
 */
export const SOLD_STATES = ['confirmed', 'processing', 'shipped', 'delivered'] as const;

/** The same set as a SQL list, ready to inline. Contains no user input. */
export const SOLD_STATES_SQL = `(${SOLD_STATES.map((s) => `'${s}'`).join(',')})`;
