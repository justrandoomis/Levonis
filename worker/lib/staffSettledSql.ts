/**
 * WAGE SETTLEMENT — the shared SQL (owner 2026-11-10; DECISIONS row 306).
 *
 * No imports on purpose: the participant ledger, the wage planner, the payout
 * fence and the recovery scan all read these, and none of them may wait on
 * the settlement module itself.
 *
 * Every reader tolerates a database without migration 0230 (CLAUDE.md rule 2):
 * it asks `settlementInstalled` and passes the answer, and a missing table
 * reads as «nothing is settled».
 */

const seen = new WeakMap<object, true>();
/** Is migration 0230 applied? Remembered once true (the tables are never
 * dropped); asked again while not, so an older database is never wrong. */
export async function settlementInstalled(db: D1Database): Promise<boolean> {
  if (seen.has(db)) return true;
  const row = await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_staff_settled_costs'").first();
  if (row) seen.set(db, true);
  return !!row;
}

/** This wage row is inside an owner's wage settlement: its amount is final. */
export const settledCostSql = (costSql: string, installed: boolean) =>
  installed ? `EXISTS(SELECT 1 FROM finance_staff_settled_costs fsc WHERE fsc.cost_id=${costSql})` : '0';

/** This employee's orders delivered before the returned Baghdad day are settled (NULL: none). */
export const settledThroughSql = (staffSql: string, installed: boolean) =>
  installed ? `(SELECT MAX(fss.through_day) FROM finance_staff_settlements fss WHERE fss.staff_id=${staffSql})` : 'NULL';
