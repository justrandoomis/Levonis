import type { Context } from 'hono';
import type { AppContext } from './types';
import { tooMany } from './http';

/**
 * Fixed-window rate limiter backed by D1 so it holds across Worker isolates
 * (per-process memory is not a reliable limiter on Workers).
 */
export async function rateLimit(
  c: Context<AppContext>,
  bucket: string,
  limit: number,
  windowSeconds: number
): Promise<void> {
  // Key by user id when authenticated: Iraqi carriers NAT many customers
  // behind one IP, so an IP-only bucket would throttle unrelated users on
  // logged-in endpoints. Anonymous endpoints still fall back to the IP.
  const user = c.get('user');
  const ip = c.req.header('CF-Connecting-IP') || 'unknown';
  const key = user ? `${bucket}:u:${user.id}` : `${bucket}:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);

  const row = await c.env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`
  )
    .bind(key, windowStart)
    .first<{ count: number }>();

  // Opportunistically drop stale windows so the table stays small.
  if (row && row.count === 1 && Math.random() < 0.02) {
    await c.env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
      .bind(now - 86_400)
      .run();
  }

  if (row && row.count > limit) throw tooMany();
}
