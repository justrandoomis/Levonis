import type { Context } from 'hono';
import type { AppContext } from './types';
import { tooMany } from './http';
import { sha256Hex } from './crypto';

/**
 * Fixed-window rate limiter backed by D1 so it holds across Worker isolates
 * (per-process memory is not a reliable limiter on Workers).
 */
/** The bucket key. Exported so the derivation is pinned by a test rather than re-read from a query. */
export function rateLimitKey(bucket: string, userId: string | null, ip: string, explicit?: string): string {
  if (explicit) return `${bucket}:k:${explicit}`;
  return userId ? `${bucket}:u:${userId}` : `${bucket}:${ip}`;
}

/**
 * A key for the ACCOUNT an anonymous request is aimed at, so a login or
 * password-reset limit holds across an attacker's IPs and not only per IP.
 *
 * Hashed, because the rate_limits table must not become a list of who tried
 * to sign in. Case- and whitespace-insensitive so 'Ali@x.com' and 'ali@x.com '
 * share one bucket. Applied to every identifier alike — one that exists and
 * one that does not — so the limit itself reveals nothing about which
 * accounts exist.
 */
export async function identifierKey(identifier: string): Promise<string> {
  return sha256Hex(identifier.trim().toLowerCase());
}

export async function rateLimit(
  c: Context<AppContext>,
  bucket: string,
  limit: number,
  windowSeconds: number,
  explicitKey?: string
): Promise<void> {
  // Key by user id when authenticated: Iraqi carriers NAT many customers
  // behind one IP, so an IP-only bucket would throttle unrelated users on
  // logged-in endpoints. Anonymous endpoints still fall back to the IP — or
  // to an explicit key, for a limit on the account being targeted.
  const user = c.get('user');
  const ip = c.req.header('CF-Connecting-IP') || 'unknown';
  const key = rateLimitKey(bucket, user?.id ?? null, ip, explicitKey);
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
