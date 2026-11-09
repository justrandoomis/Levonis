/**
 * WAGE SETTLEMENT — the shared SQL (owner 2026-11-10; DECISIONS row 306).
 *
 * No imports on purpose: the participant ledger, the wage planner, the payout
 * fence and the recovery scan all read these, and none of them may wait on
 * the settlement module itself.
 */

/** This wage row is inside an owner's wage settlement: its amount is final. */
export const settledCostSql = (costSql = 'c.id') =>
  `EXISTS(SELECT 1 FROM finance_staff_settled_costs fsc WHERE fsc.cost_id=${costSql})`;

/** This employee's orders delivered before the returned Baghdad day are settled (NULL: none). */
export const settledThroughSql = (staffSql = 's.id') =>
  `(SELECT MAX(fss.through_day) FROM finance_staff_settlements fss WHERE fss.staff_id=${staffSql})`;
