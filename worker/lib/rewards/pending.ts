/**
 * POINTS ON THE WAY — purchase points still pending (policy art. 3.7: not
 * spendable), with the day the first of them is released.
 *
 * One reader for both pages that state them: the points page (GET /api/rewards,
 * policy art. 12.6 — «صفحة النقاط» shows the settled balance, the pending
 * points and the record) and the rewards area (GET /api/rewards/program).
 * `points_accruals` dates from migration 0014, so no older database lacks it.
 */
export interface PendingPoints {
  points: number;
  next_available_at: string | null;
}

export async function readPendingPoints(db: D1Database, userId: string): Promise<PendingPoints> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(points), 0) AS points,
              MIN(CASE WHEN kind = 'purchase' THEN available_at END) AS next_available_at
         FROM points_accruals WHERE user_id = ? AND state = 'pending'`
    )
    .bind(userId)
    .first<{ points: number; next_available_at: string | null }>();
  return { points: Math.max(0, Number(row?.points) || 0), next_available_at: row?.next_available_at ?? null };
}
