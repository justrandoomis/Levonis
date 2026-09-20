import type { FinancePeriodReport, FinanceTotals, FinanceReportMeta } from '../../lib/api';

/**
 * WHAT THIS SCREEN MUST ADMIT ABOUT ITS OWN NUMBERS.
 *
 * ###########################################################################
 * #  A PROFIT FIGURE THAT HIDES HOW MUCH OF ITS COST BASIS WAS GUESSED IS   #
 * #  THE WORST THING THIS SCREEN COULD DO.                                  #
 * ###########################################################################
 * Somebody sets a supplier price from these numbers. Somebody decides whether
 * a product is worth restocking. If half the cost basis behind «الربح
 * الإجمالي» was reconstructed from today's catalogue rather than recorded at
 * the moment of sale, the figure still has a use — but only to a reader who
 * KNOWS. So the disclosure is not a footnote, not a tooltip and not a line in
 * a help page: it is a panel directly under the figures, and the estimate
 * badge sits inline with the number it qualifies.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PURE FUNCTION AND NOT A `&&` INSIDE THE JSX.
 *
 * "The warning appears when, and only when, the server reported estimated
 * rows" is the single most important behaviour on this screen, and a condition
 * buried in a render tree can only be tested by a regular expression over the
 * source — which passes just as happily when the condition is inverted. Here
 * it is a function over the server's own response, so `tests/financeDashboard
 * .test.ts` can hand it a report WITH estimates and a report WITHOUT and
 * assert the difference, which is the actual promise.
 *
 * The notices carry IDS AND NUMBERS, never sentences: the wording lives in
 * strings.ts in all three languages, and a module that returned Arabic text
 * would be a second place for copy to drift.
 */

export type NoticeId =
  | 'no_cost_snapshot'
  | 'fifo_measured'
  | 'estimated'
  | 'uncosted'
  | 'no_expense_ledger'
  | 'no_expenses_recorded'
  | 'unrecognized_orders'
  | 'unbucketed';

export interface Notice {
  id: NoticeId;
  /** `warning` = this number is less certain than it looks. `info` = context.
   *  `good` = this number is MORE certain than the reader might assume, which
   *  is a disclosure too: a panel that only ever admits doubt teaches the
   *  reader to discount everything on the screen equally. */
  tone: 'warning' | 'info' | 'good';
  /** The counts the sentence needs. Never pre-formatted — the UI owns digits. */
  values: Record<string, number>;
}

/**
 * The disclosures a period report owes its reader, in the order they change a
 * decision: first "this cost was never recorded at all", then "part of it was
 * reconstructed", then "part of it is unknown and excluded", then the two
 * facts about coverage.
 *
 * ORDER IS EDITORIAL, NOT COSMETIC. `no_cost_snapshot` means EVERY figure on
 * the screen is an estimate, which is a different statement from "142 lines of
 * 9,000 are estimated", so it leads — and when it is present the per-line
 * count is still shown beneath it, because the owner's next question is how
 * much of it that actually is.
 */
export function honestyNotices(
  report: Pick<FinancePeriodReport, 'totals' | 'meta'>
): Notice[] {
  const t: FinanceTotals = report.totals;
  const meta: FinanceReportMeta = report.meta;
  const out: Notice[] = [];

  if (!meta.cost_snapshot_available) {
    out.push({ id: 'no_cost_snapshot', tone: 'warning', values: {} });
  }
  /**
   * THE ONE NOTICE ON THIS PANEL THAT IS GOOD NEWS, and it earns its place for
   * the same reason the warnings do: the reader is owed the BASIS, not just
   * the number.
   *
   * «محسوبة حسب دفعات الشراء» means those lines were costed against the layers
   * the sale actually consumed — the strongest cost basis this system has. An
   * owner who cannot tell that from a snapshot estimate discounts both equally,
   * which is exactly the reasoning the estimate warning exists to prevent, run
   * backwards.
   *
   * BOTH CONDITIONS, and the second is the substantive one: `fifo_available`
   * says the machinery exists, `fifo_lines` says it had something to read. A
   * shop whose stock all predates migration 0098 has the first and not the
   * second, and announcing a FIFO basis there would be a claim about nothing.
   */
  if (meta.fifo_available && t.fifo_lines > 0) {
    out.push({
      id: 'fifo_measured',
      tone: 'good',
      values: { lines: t.fifo_lines, cost: t.fifo_cogs_iqd, total: t.cogs_iqd },
    });
  }
  if (t.estimated_lines > 0) {
    out.push({
      id: 'estimated',
      tone: 'warning',
      values: { lines: t.estimated_lines, units: t.estimated_units, cost: t.estimated_cogs_iqd },
    });
  }
  /**
   * THE UNCOSTED NOTICE KEYS ON THE MONEY, NOT ON THE LINE COUNT.
   *
   * It used to fire on `uncosted_lines > 0` as well, and that produced the one
   * sentence this panel must never produce: «سطر بيع واحد بقيمة ٠ د.ع لا تُعرف
   * تكلفته» — a warning that reads as "nothing to worry about". It happens for
   * real: a bundle's COMPONENT rows carry `line_total_iqd = 0` (the money is
   * on the parent), and a fully refunded composition leaves its parent line
   * standing with its revenue reversed to zero, because worker/routes/returns.ts
   * raises a case per component and never one against the parent.
   *
   * What this notice exists to say is that REVENUE sits outside the margin
   * base. Lines with no revenue left in the period put nothing outside it, so
   * there is nothing to disclose about them — and the count is still printed
   * INSIDE the sentence, beside the amount it belongs to.
   */
  if (t.uncosted_revenue_iqd > 0) {
    out.push({
      id: 'uncosted',
      tone: 'warning',
      values: { lines: t.uncosted_lines, units: t.uncosted_units, revenue: t.uncosted_revenue_iqd },
    });
  }
  if (!meta.operating_expenses_available) {
    out.push({ id: 'no_expense_ledger', tone: 'warning', values: {} });
  } else if (t.expense_entries === 0) {
    /**
     * THE LEDGER IS THERE AND NOBODY HAS WRITTEN IN IT.
     *
     * This is a DIFFERENT statement from "there is no ledger", and for a long
     * while it was the one the screen could not make: `no_expense_ledger`
     * fires on a missing TABLE, the table exists the moment migration 0095
     * lands, and so a net profit that silently ignored every unrecorded
     * riyal of rent came with no warning at all. On a shop that has just been
     * given an expense screen to fill in, this is the FIRST state the owner
     * sees, and «الربح الصافي = الربح الإجمالي» is a number they would price
     * against.
     *
     * A zero is a claim. This notice is what stops the reader making it.
     */
    out.push({ id: 'no_expenses_recorded', tone: 'warning', values: {} });
  }
  if (meta.unrecognized_orders > 0) {
    out.push({ id: 'unrecognized_orders', tone: 'info', values: { orders: meta.unrecognized_orders } });
  }
  const unbucketedLines = meta.unbucketed.sale_lines + meta.unbucketed.expense_entries + meta.unbucketed.refund_cases;
  if (unbucketedLines > 0) {
    out.push({
      id: 'unbucketed',
      tone: 'info',
      values: {
        lines: unbucketedLines,
        amount: meta.unbucketed.sale_revenue_iqd + meta.unbucketed.expense_amount_iqd,
      },
    });
  }
  return out;
}

/**
 * Is any part of THIS figure's cost basis reconstructed rather than recorded?
 *
 * Used for the badge that rides beside the gross and net profit numbers. It is
 * deliberately true when the snapshot column is missing even if the server
 * reported zero estimated lines: with no column there is nothing to count, and
 * "0 estimated lines" would read as "nothing was estimated" when in fact
 * everything was.
 */
export function isEstimated(report: Pick<FinancePeriodReport, 'totals' | 'meta'>): boolean {
  return report.totals.estimated || !report.meta.cost_snapshot_available;
}
