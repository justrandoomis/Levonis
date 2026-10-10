/**
 * THE QUARTER-HOUR TICK'S SHARE-OUT OF D1'S 1,000 STATEMENTS (FX programme
 * plan §7.4, critique H2; docs/DECISIONS.md row 201).
 *
 * D1 allows 1,000 queries per Worker invocation, a batch counting each of its
 * statements, and the `*\/15` trigger runs all of these in ONE invocation, on
 * the counting view of worker/lib/d1Count.ts, in this order:
 *
 *   1. TOGETHER, each with its own fixed bound: the staff wage recalculation
 *      (`STAFF_RECONCILIATION_TICK`), the durable jobs (worker/lib/jobs.ts,
 *      every step but the search-index catch-up) and the upload-session sweep
 *      (200 expired, 200 deleted).
 *   2. ONCE THEY HAVE SETTLED, the search-index catch-up, spending only what
 *      they left of `QUARTER_HOUR_TICK_LIMIT` (`quarterHourSearchBudget`).
 *      Every statement it sends is charged before it is sent, and a product
 *      whose index rows do not fit waits, stale and untouched, for the next
 *      tick (worker/lib/search/store.ts `backfillSearchIndex`).
 *   3. LAST, FX-5's engine sweep: its own 200, cut to what is left
 *      (`quarterHourSweepBudget`, worker/lib/fx/reprice.ts).
 *
 * So the invocation's total is at most max(step 1, `QUARTER_HOUR_TICK_LIMIT`):
 * steps 2 and 3 never take it over the limit, and step 1 is bounded by its
 * jobs' own bounds — measured at those bounds, together with steps 2 and 3,
 * by tests/fxSweepBudget.test.ts on the real `scheduled()`.
 *
 * WHY THE STAFF RECALCULATION IS PACED, NOT BUDGETED. Its unit is one order's
 * financial effects (the wage rules at both milestones, then the investor
 * reconciliation): about 150 statements plus about 7 per order line, decided
 * by the order's data while it runs, so no budget can price an order before
 * it starts. One order is also the least a pass can do and still move: the
 * same work that order's own delivery did in its own invocation. So the tick
 * takes ONE job and ONE order of it — the job's durable cursor resumes on the
 * next tick (an order cut off before its cursor moved is replayed, and a
 * replay reuses the source costs and appends only real deltas: no pay twice),
 * and the jobs take turns, oldest `updated_at` first. Before this it took
 * 2 jobs × 10 orders, about 3,581 statements: over D1's limit on its own. The
 * owner's page drives a recalculation at the same pace while it is open — one
 * order a request (worker/routes/adminFinancePeople.ts).
 */

/** D1's queries per Worker invocation (the paid plan's limit; a batch counts each statement). */
export const D1_INVOCATION_STATEMENT_LIMIT = 1000;

/** Kept free under that limit in the quarter-hour invocation, for anything a counter could miss. */
export const QUARTER_HOUR_RESERVE = 50;

/** The staff wage recalculation per quarter-hour tick: one job, one order. */
export const STAFF_RECONCILIATION_TICK = Object.freeze({ maxJobs: 1, maxOrders: 1 });

/** What one quarter-hour invocation may spend in all: D1's 1,000 less the reserve. */
export const QUARTER_HOUR_TICK_LIMIT = D1_INVOCATION_STATEMENT_LIMIT - QUARTER_HOUR_RESERVE;

/**
 * THE SEARCH-INDEX CATCH-UP'S SHARE: what the tick's jobs left of
 * `QUARTER_HOUR_TICK_LIMIT`, never below zero. It runs before the engine
 * sweep, which then yields to it (the sweep's share is lowered, never a
 * job's: plan §7.4).
 */
export function quarterHourSearchBudget(usedByJobs: number): number {
  return Math.max(0, QUARTER_HOUR_TICK_LIMIT - Math.max(0, Math.ceil(usedByJobs)));
}
