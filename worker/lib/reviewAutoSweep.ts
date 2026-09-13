import { newId } from './crypto';

export interface AutomaticReviewSweepReport {
  scanned: number;
  created: number;
  skipped: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Creates the existing seven-day automatic rating only when no review exists
 * for that customer/product. The database UNIQUE(user_id, product_id) is the
 * final concurrency guard, so overlapping cron runs cannot create two.
 *
 * System reviews are published but carry no review_rewards row and no points
 * ledger entry. A later manual submission may explicitly replace this marker.
 */
export async function sweepAutomaticReviews(
  db: D1Database,
  nowIso = new Date().toISOString(),
  limit = 200
): Promise<AutomaticReviewSweepReport> {
  const cutoff = new Date(new Date(nowIso).getTime() - SEVEN_DAYS_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT o.user_id, o.id AS order_id, oi.id AS order_item_id, oi.product_id
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
        WHERE oi.product_id IS NOT NULL
          AND (o.status = 'delivered' OR o.delivered_at IS NOT NULL)
          AND COALESCE(o.delivered_at, o.updated_at, o.created_at) <= ?
          AND NOT EXISTS (
            SELECT 1 FROM reviews r
             WHERE r.user_id = o.user_id AND r.product_id = oi.product_id
          )
        ORDER BY COALESCE(o.delivered_at, o.updated_at, o.created_at), oi.id
        LIMIT ?`
    )
    .bind(cutoff, Math.max(1, Math.min(1000, Math.trunc(limit))))
    .all<{ user_id: string; order_id: string; order_item_id: string; product_id: string }>();

  let created = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const row of results ?? []) {
    const key = `${row.user_id}\u0000${row.product_id}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO reviews
           (id, user_id, product_id, order_item_id, order_id, stars, body, media,
            status, source, quality_score, quality_summary, fallback_points_awarded, created_at)
         VALUES (?, ?, ?, ?, ?, 5, '', '[]', 'published', 'system', NULL, '{}', 0, ?)`
      )
      .bind(newId('rev'), row.user_id, row.product_id, row.order_item_id, row.order_id, nowIso)
      .run();
    if ((result.meta.changes ?? 0) > 0) created += 1;
    else skipped += 1;
  }

  return { scanned: results?.length ?? 0, created, skipped };
}

