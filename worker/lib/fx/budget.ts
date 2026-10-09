/**
 * THE STATEMENT BUDGET OF ONE INVOCATION (FX programme plan §7.4, critique H2).
 *
 * D1 allows 1,000 queries per Worker invocation and the project budgets a cron
 * run at no more than 600 (docs/architecture/03-EVENTS.md). The six-hourly FX run,
 * an owner request and (from FX-5) the repricing and the sweep share ONE budget
 * object: every read and every statement of every batch is charged to it — a
 * `fence()` counts as its two statements — and a batch the remaining budget
 * cannot cover is not sent.
 */

export const FX_INVOCATION_STATEMENT_BUDGET = 600;

export interface StatementBudget {
  readonly limit: number;
  /** Statements charged so far. */
  readonly used: number;
  remaining(): number;
  /** True when `n` more statements fit. */
  canSpend(n: number): boolean;
  /** Charges `n` statements; false (and nothing charged) when they do not fit. */
  spend(n: number): boolean;
}

export function statementBudget(limit: number = FX_INVOCATION_STATEMENT_BUDGET): StatementBudget {
  let used = 0;
  return {
    limit,
    get used() {
      return used;
    },
    remaining: () => limit - used,
    canSpend: (n) => used + n <= limit,
    spend(n) {
      if (used + n > limit) return false;
      used += n;
      return true;
    },
  };
}
