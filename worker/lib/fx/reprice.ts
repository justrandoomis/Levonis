/**
 * FX-5: THE DOOR TO AUTOMATIC REPRICING (FX programme plan §7.1, §7.4).
 *
 * The engine's run (pricingEngine/autoReprice.ts) as the FX side calls it:
 *   - the six-hour scheduler, at the end of its run, with whatever is left of
 *     its 600-statement budget (scheduler.ts);
 *   - an owner act that commits an effective rate (approve a review, a manual
 *     rate, the adjustment) or a central shipping rate, inside the request's
 *     own budget (worker/routes/adminPricing.ts);
 *   - the quarter-hour sweep, with its own sub-budget of 200 statements, so
 *     the jobs of that invocation keep theirs (worker/index.ts).
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

/** The quarter-hour sweep's own sub-budget (plan §7.4): about 6–7 products a tick. */
export const AUTO_REPRICE_SWEEP_BUDGET = 200;

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
