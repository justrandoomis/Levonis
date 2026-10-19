/**
 * Studio API rate limit (P1-10) — a D1 fixed window, the main site's pattern.
 *
 * Same shape as worker/lib/ratelimit.ts on the main worker, ported rather than
 * imported (the Studio workspace never imports across the workspace boundary):
 *
 *   - a FIXED window held in D1 (`studio_rate_limits`), so the count holds
 *     across Worker isolates — per-isolate memory is not a limiter on Workers;
 *   - the same key derivation: `<bucket>:u:<userId>` when signed in (Iraqi
 *     carriers put many customers behind one IP, so an IP bucket would
 *     throttle strangers), `<bucket>:<ip>` otherwise, `<bucket>:k:<key>` for an
 *     explicit key;
 *   - one atomic upsert per request that resets the count when the window
 *     turns (`ON CONFLICT … CASE WHEN window_start = ?2 …`).
 *
 * WHAT IT GUARDS. Only signed-in account calls are charged: they are the ones
 * that reach D1 and R2. A guest call is refused with a 401 before any database
 * work, and charging it would ADD a D1 write to the cheapest request there is.
 * `/api/health` is free for the same reason.
 *
 * Reads (GET/HEAD) and writes have separate buckets, as on the main site
 * (`limitByMethod`): a project panel full of thumbnails must not eat the
 * budget an autosave needs.
 *
 * THE NUMBERS are engineering defaults, not product quotas, and every one is
 * an env var. They sit far above what the editor itself does: an autosave is
 * debounced to one per 2.5 s and is OPEN + one PUT per changed file + COMMIT,
 * so even a 64-file revision saved back to back stays under the write budget
 * for a minute. What they stop is a script or a runaway loop hammering one
 * account's storage — the per-account quota caps bytes, not requests.
 *
 * Stale windows are deleted by the cleanup cron (worker/api/cleanup.ts), not
 * on the request path.
 */
import type { StudioSession } from "../auth/session";
import { jsonResponse, type StudioApiEnv } from "./router";

/** The bucket key. Exported so the derivation is pinned by a test. */
export function rateLimitKey(bucket: string, userId: string | null, ip: string, explicit?: string): string {
  if (explicit) return `${bucket}:k:${explicit}`;
  return userId ? `${bucket}:u:${userId}` : `${bucket}:${ip}`;
}

export const READ_BUCKET = "studio_api_read";
export const WRITE_BUCKET = "studio_api_write";

export interface StudioRateLimits {
  windowSeconds: number;
  reads: number;
  writes: number;
}

export const DEFAULT_RATE_LIMITS: StudioRateLimits = { windowSeconds: 60, reads: 1200, writes: 600 };

function intVar(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function studioRateLimits(env: StudioApiEnv): StudioRateLimits {
  return {
    windowSeconds: intVar(env.STUDIO_RATE_LIMIT_WINDOW_SECONDS, DEFAULT_RATE_LIMITS.windowSeconds, 1, 3600),
    reads: intVar(env.STUDIO_RATE_LIMIT_READS, DEFAULT_RATE_LIMITS.reads, 1, 1_000_000),
    writes: intVar(env.STUDIO_RATE_LIMIT_WRITES, DEFAULT_RATE_LIMITS.writes, 1, 1_000_000),
  };
}

export function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/**
 * Charges one request against its bucket. Returns the 429 to send, or null
 * when the request may proceed. `now` is injectable for the window tests.
 */
export async function chargeStudioRateLimit(
  env: StudioApiEnv,
  request: Request,
  session: StudioSession | null,
  now: number = Date.now()
): Promise<Response | null> {
  const limits = studioRateLimits(env);
  const read = isReadMethod(request.method);
  const bucket = read ? READ_BUCKET : WRITE_BUCKET;
  const limit = read ? limits.reads : limits.writes;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = rateLimitKey(bucket, session?.user.id ?? null, ip);

  const nowSeconds = Math.floor(now / 1000);
  const windowStart = nowSeconds - (nowSeconds % limits.windowSeconds);

  const row = await env.DB.prepare(
    `INSERT INTO studio_rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`
  )
    .bind(key, windowStart)
    .first<{ count: number }>();

  if (row && Number(row.count) > limit) {
    const retryAfter = Math.max(1, windowStart + limits.windowSeconds - nowSeconds);
    return jsonResponse(
      {
        success: false,
        code: "RATE_LIMITED",
        error: "Too many requests. Wait a moment and try again.",
        retry_after_seconds: retryAfter,
      },
      429,
      { "Retry-After": String(retryAfter) }
    );
  }
  return null;
}

/** Cleanup-cron step: drop windows older than a day. Returns rows removed. */
export async function purgeStaleRateLimitWindows(db: D1Database, now: number = Date.now()): Promise<number> {
  const cutoff = Math.floor(now / 1000) - 86_400;
  const res = await db.prepare("DELETE FROM studio_rate_limits WHERE window_start < ?").bind(cutoff).run();
  return res.meta.changes ?? 0;
}
