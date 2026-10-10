/**
 * FX-5: THE DOOR TO AUTOMATIC REPRICING (FX programme plan §7.1, §7.4).
 *
 * The engine's run (pricingEngine/autoReprice.ts) as the FX side calls it:
 *   - the six-hour scheduler, at the end of its run, with whatever is left of
 *     its 600-statement budget (scheduler.ts);
 *   - an owner act that commits an effective rate (approve a review, a manual
 *     rate, the adjustment) or a central shipping rate, inside the request's
 *     own budget (worker/routes/adminPricing.ts);
 *   - the quarter-hour sweep, LAST in that invocation, with its own
 *     sub-budget of 200 statements cut to what the tick's other jobs left of
 *     D1's 1,000 (`quarterHourSweepBudget`, worker/index.ts), so the jobs keep
 *     theirs and the invocation stays under the limit.
 * Each brings its statement budget; a product left over waits, in deficit
 * order, for the next tick. The owner's bell for a product that cannot be
 * repriced rings through notify.ts (the verified owner, no figure).
 *
 * The FX module itself still names no price column and writes no product
 * row: the engine's writer does (tests/pricingCurrencyRoles.test.ts).
 */
import type { Env } from '../types';
import { repriceStaleEngineProducts, type AutoRepriceReport, type AutoRepriceTrigger } from '../pricingEngine/autoReprice';
import { statementBudget, type StatementBudget } from './budget';
import { notifyOwnerRepriceBlocked } from './notify';
import { D1_INVOCATION_STATEMENT_LIMIT, QUARTER_HOUR_RESERVE } from '../quarterHourBudget';

/** The quarter-hour sweep's own sub-budget (plan §7.4): about 6–7 products a tick. */
export const AUTO_REPRICE_SWEEP_BUDGET = 200;
// D1's 1,000 queries per invocation and the quarter-hour reserve of 50 are the
// tick's share-out, defined once in worker/lib/quarterHourBudget.ts.
export { D1_INVOCATION_STATEMENT_LIMIT, QUARTER_HOUR_RESERVE };

/**
 * THE SWEEP'S SHARE OF THE QUARTER-HOUR INVOCATION (plan §7.4, critique H2):
 * its own 200, cut to what the tick's other jobs left of D1's 1,000 less the
 * reserve — never below zero. The sweep runs after those jobs and executes no
 * more than its budget (autoReprice.ts charges every statement first), so the
 * invocation's total is at most max(jobs, 1,000 − reserve): the sweep never
 * takes the tick over the limit, and the jobs never lose a statement to it.
 */
export function quarterHourSweepBudget(usedByJobs: number): number {
  const left = D1_INVOCATION_STATEMENT_LIMIT - QUARTER_HOUR_RESERVE - Math.max(0, Math.ceil(usedByJobs));
  return Math.max(0, Math.min(AUTO_REPRICE_SWEEP_BUDGET, left));
}

export interface SweepOptions {
  trigger: AutoRepriceTrigger;
  /** The invocation's budget; the sweep's own 200 when omitted. */
  budget?: StatementBudget;
  actorId?: string | null;
  now?: Date;
  origin?: string;
}

/** Reprice the stale engine products within the budget. Never throws. */
export function sweepStaleEnginePrices(env: Env, opts: SweepOptions): Promise<AutoRepriceReport> {
  return repriceStaleEngineProducts(env, {
    trigger: opts.trigger,
    budget: opts.budget ?? statementBudget(AUTO_REPRICE_SWEEP_BUDGET),
    actorId: opts.actorId ?? null,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
    onBlocked: (items) => notifyOwnerRepriceBlocked(env, items),
  });
}
