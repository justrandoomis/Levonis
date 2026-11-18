/**
 * HOW MANY CLAUDE TURNS TODAY (DECISIONS row 348).
 *
 * Counted in the `rate_limits` table every limiter already uses, so there is
 * no migration and the rows are pruned by the same sweep. Every check here is
 * ONE conditional statement: the increment happens only while the count is
 * under its cap, so two parallel turns can never both take the last slot (the
 * second one's WHERE sees the first one's count and returns no row).
 *
 * NEVER THROWS, NEVER A 429. A refused turn is not an error for the customer:
 * the assistant simply answers on its rules (basic mode), as it did before.
 *
 * Buckets:
 *   assist-ai-day:all          the shop's daily cap (owner setting)
 *   assist-ai-day:guest        the signed-out share of it
 *   assist-ai-viewer:<who>     20 turns per 5 minutes per account or IP
 *   assist-ai-viewer-day:<who> 80 turns per day per account or IP
 */
import { rateLimitKey } from '../../ratelimit';

export const VIEWER_BURST = { limit: 20, window: 300 } as const;
export const VIEWER_DAY = { limit: 80, window: 86_400 } as const;

/** Take one slot in a fixed window if the count stays at or under `cap`. True = taken. */
export async function takeSlot(db: D1Database, key: string, cap: number, windowSeconds: number, nowMs = Date.now()): Promise<boolean> {
  if (cap <= 0) return false;
  const now = Math.floor(nowMs / 1000);
  const windowStart = now - (now % windowSeconds);
  try {
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
           window_start = ?2
         WHERE rate_limits.window_start <> ?2 OR rate_limits.count < ?3
         RETURNING count`
      )
      .bind(key, windowStart, cap)
      .first<{ count: number }>();
    return !!row;
  } catch {
    return false;
  }
}

/** Today's count for the admin page (0 when the window has turned). */
export async function slotsUsed(db: D1Database, key: string, windowSeconds: number, nowMs = Date.now()): Promise<number> {
  const now = Math.floor(nowMs / 1000);
  const windowStart = now - (now % windowSeconds);
  try {
    const row = await db.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?').bind(key).first<{ window_start: number; count: number }>();
    return row && row.window_start === windowStart ? row.count : 0;
  } catch {
    return 0;
  }
}

export const DAY_KEY_ALL = 'assist-ai-day:all';
export const DAY_KEY_GUEST = 'assist-ai-day:guest';

/**
 * Every cap at once, cheapest-to-refuse first. A turn refused after it took a
 * viewer slot has spent that slot: that is the safe direction (it can only
 * make the assistant fall back to rules sooner, never spend more).
 */
export async function reserveTurn(
  db: D1Database,
  who: { userId: string | null; ip: string },
  caps: { daily: number; guestSharePct: number },
  nowMs = Date.now()
): Promise<boolean> {
  if (!(await takeSlot(db, rateLimitKey('assist-ai-viewer', who.userId, who.ip), VIEWER_BURST.limit, VIEWER_BURST.window, nowMs))) return false;
  if (!(await takeSlot(db, rateLimitKey('assist-ai-viewer-day', who.userId, who.ip), VIEWER_DAY.limit, VIEWER_DAY.window, nowMs))) return false;
  if (!who.userId) {
    const guestCap = Math.floor((caps.daily * caps.guestSharePct) / 100);
    if (!(await takeSlot(db, DAY_KEY_GUEST, guestCap, 86_400, nowMs))) return false;
  }
  return takeSlot(db, DAY_KEY_ALL, caps.daily, 86_400, nowMs);
}
