import type { Context, MiddlewareHandler } from 'hono';
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

/**
 * ONE CHARGE PER BUCKET PER REQUEST. Doors nest: `/api/admin/finance`'s
 * `use('*')` also runs on `/api/admin/finance/report/*`, whose own router
 * wears the same door — so one owner GET of the profit report was counted
 * twice against the budget every finance router shares. The request object is
 * the same through every mounted router, so it keys the buckets already
 * charged for it.
 */
const charged = new WeakMap<Request, Set<string>>();
function firstCharge(c: Context<AppContext>, bucket: string): boolean {
  const raw = c.req.raw;
  let seen = charged.get(raw);
  if (!seen) {
    seen = new Set();
    charged.set(raw, seen);
  }
  if (seen.has(bucket)) return false;
  seen.add(bucket);
  return true;
}

/**
 * A rate limit worn on the route declaration (S1). Mounted BEFORE the cost
 * guard on a router door, so a refused caller still spends budget: probing a
 * cost router id by id costs the prober, not the database.
 */
export const limitRoute = (bucket: string, limit: number, windowSeconds = 3600): MiddlewareHandler<AppContext> =>
  async (c, next) => {
    if (firstCharge(c, bucket)) await rateLimit(c, bucket, limit, windowSeconds);
    await next();
  };

/**
 * A ROUTE WITH ITS OWN BUCKET IN PLACE OF THE DOOR'S. Charges `bucket`, then
 * marks every bucket in `replaces` as already charged for this request, so the
 * door's `limitByMethod` / `limitRoute` further down the chain spends nothing.
 * Mounted on the route BEFORE the door (and still before the cost guard, so a
 * refused caller spends this bucket instead).
 *
 * Why: the staff reconciliation runner pages one order per POST, 1.2 s apart.
 * On the door's shared write budget (120 an hour, per user) a recalculation of
 * more than 120 orders locked the owner out of every finance write —
 * withdrawals, staff payments, expenses, closing a period — until the hour
 * turned. Paging gets its own, larger bucket; the shared one still stops abuse
 * of every other write route.
 */
export const limitInstead = (
  bucket: string,
  limit: number,
  replaces: readonly string[],
  windowSeconds = 3600
): MiddlewareHandler<AppContext> =>
  async (c, next) => {
    if (firstCharge(c, bucket)) await rateLimit(c, bucket, limit, windowSeconds);
    for (const other of replaces) firstCharge(c, other);
    await next();
  };

/** One bucket for reads (GET, HEAD), another for every write, on the same door. */
export const limitByMethod = (
  read: readonly [string, number],
  write: readonly [string, number],
  windowSeconds = 3600
): MiddlewareHandler<AppContext> =>
  async (c, next) => {
    const [bucket, limit] = c.req.method === 'GET' || c.req.method === 'HEAD' ? read : write;
    if (firstCharge(c, bucket)) await rateLimit(c, bucket, limit, windowSeconds);
    await next();
  };
