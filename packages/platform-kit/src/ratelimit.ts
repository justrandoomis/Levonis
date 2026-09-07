/**
 * Rate limiting (`01-TARGET.md` §3.6, ADR-016). The cross-isolate D1 fixed
 * window behind `IDENTITY.rateLimitHit` is authoritative from day one
 * (`D1RpcRateLimiter`); the `ratelimits` binding is the per-colo first layer
 * (`BindingRateLimiter`); a Durable Object counter comes later
 * (`DoRateLimiter`); `MemoryRateLimiter` is dark/local only. `rateLimitKey`
 * and `identifierKey` are byte-identical copies of `worker/lib/ratelimit.ts`
 * (pinned by `tests/edgeParity.test.ts`; `tests/rateLimitKey.test.ts` still
 * pins the core's), and `rateLimit(c, bucket, limit, window)` keeps today's
 * signature so a moved route file changes only its import.
 */
import type { Context } from 'hono';
import { sha256Hex } from '@levonis/contracts/canonical';
import { tooMany, dependencyUnavailable } from './errors';

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

export interface RateLimitVerdict {
  allowed: boolean;
  count: number;
}

export interface RateLimiter {
  /** Counts one hit against `key` in `cls`; `allowed` is false once `count > limit` inside the window. */
  hit(cls: string, key: string, limit: number, windowSeconds: number): Promise<RateLimitVerdict>;
}

/** The SQL the core runs today (`lib/ratelimit.ts`) — `IdentityEntrypoint.rateLimitHit` executes it verbatim. */
export const RATE_LIMIT_UPSERT_SQL = `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`;

/** Runs today's upsert against a D1 that owns `rate_limits` (Identity only). */
export async function d1RateLimitHit(db: D1Database, key: string, limit: number, windowSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<RateLimitVerdict> {
  const windowStart = nowSeconds - (nowSeconds % windowSeconds);
  const row = await db.prepare(RATE_LIMIT_UPSERT_SQL).bind(key, windowStart).first<{ count: number }>();
  const count = row?.count ?? 1;
  return { allowed: count <= limit, count };
}

/** The interface the gateway and every extracted service reach `rate_limits` through. */
export interface RateLimitRpc {
  rateLimitHit(cls: string, key: string, limit: number, windowSeconds: number, ...rest: unknown[]): Promise<RateLimitVerdict>;
}

/** Authoritative: the D1 window behind `IDENTITY.rateLimitHit`. */
export class D1RpcRateLimiter implements RateLimiter {
  constructor(private readonly identity: RateLimitRpc, private readonly ctx?: () => unknown) {}
  hit(cls: string, key: string, limit: number, windowSeconds: number): Promise<RateLimitVerdict> {
    return this.ctx ? this.identity.rateLimitHit(cls, key, limit, windowSeconds, this.ctx()) : this.identity.rateLimitHit(cls, key, limit, windowSeconds);
  }
}

/** wrangler `ratelimits: [{ name, namespace_id, simple: { limit, period } }]` — per colo; the cheap first layer. */
export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export class BindingRateLimiter implements RateLimiter {
  constructor(private readonly bindings: Partial<Record<string, RateLimitBinding>>) {}
  async hit(cls: string, key: string, _limit?: number, _windowSeconds?: number): Promise<RateLimitVerdict> {
    const b = this.bindings[cls];
    if (!b) return { allowed: true, count: 0 }; // an unconfigured class is not limited by this layer
    const r = await b.limit({ key });
    return { allowed: r.success, count: r.success ? 0 : Number.MAX_SAFE_INTEGER };
  }
}

/** The `RateLimitCounter` Durable Object (SQLite, sharded by key hash) — when approved. */
export interface DoNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export class DoRateLimiter implements RateLimiter {
  constructor(private readonly ns: DoNamespaceLike, private readonly shards = 64) {}
  async hit(cls: string, key: string, limit: number, windowSeconds: number): Promise<RateLimitVerdict> {
    const shard = (await sha256Hex(key)).slice(0, 8);
    const stub = this.ns.get(this.ns.idFromName(`rl-${parseInt(shard, 16) % this.shards}`));
    const res = await stub.fetch('https://do/hit', { method: 'POST', body: JSON.stringify({ cls, key, limit, windowSeconds }) });
    if (!res.ok) throw dependencyUnavailable('RateLimitCounter');
    return (await res.json()) as RateLimitVerdict;
  }
}

/** Per-isolate fixed window. Dark/local only — it is trivially bypassed by spreading requests over colos. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  async hit(cls: string, key: string, limit: number, windowSeconds: number): Promise<RateLimitVerdict> {
    const nowS = Math.floor(this.now() / 1000);
    const start = nowS - (nowS % windowSeconds);
    const k = `${cls}|${key}`;
    const w = this.windows.get(k);
    if (!w || w.start !== start) {
      this.windows.set(k, { start, count: 1 });
      return { allowed: 1 <= limit, count: 1 };
    }
    w.count += 1;
    return { allowed: w.count <= limit, count: w.count };
  }
}

/** Layers: the first layer that refuses wins; the last layer is the authority. */
export class LayeredRateLimiter implements RateLimiter {
  constructor(private readonly layers: RateLimiter[]) {}
  async hit(cls: string, key: string, limit: number, windowSeconds: number): Promise<RateLimitVerdict> {
    let last: RateLimitVerdict = { allowed: true, count: 0 };
    for (const l of this.layers) {
      last = await l.hit(cls, key, limit, windowSeconds);
      if (!last.allowed) return last;
    }
    return last;
  }
}

/** The Hono context shape the facade reads: today's `c.get('user')` and the client IP header. */
type LimitContext = Context<{ Variables: { user?: { id: string } | null; rateLimiter?: RateLimiter }; Bindings: { IDENTITY?: RateLimitRpc; RATE_LIMIT_MODE?: string } }>;

/**
 * `rateLimit(c, bucket, limit, window, explicitKey?)` — today's signature
 * (`worker/lib/ratelimit.ts`). The limiter comes from `c.get('rateLimiter')`
 * (set once by the service's middleware), else from `env.IDENTITY`; with
 * neither it refuses with 503 unless `RATE_LIMIT_MODE=memory` (dark/local)
 * — never a silent per-isolate fallback in production.
 */
export function makeRateLimit(limiter: RateLimiter) {
  return async function rateLimit(c: LimitContext, bucket: string, limit: number, windowSeconds: number, explicitKey?: string): Promise<void> {
    // Key by user id when authenticated: Iraqi carriers NAT many customers
    // behind one IP, so an IP-only bucket would throttle unrelated users on
    // logged-in endpoints. Anonymous endpoints still fall back to the IP — or
    // to an explicit key, for a limit on the account being targeted.
    const user = c.get('user');
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const key = rateLimitKey(bucket, user?.id ?? null, ip, explicitKey);
    const verdict = await limiter.hit(bucket, key, limit, windowSeconds);
    if (!verdict.allowed) throw tooMany();
  };
}

const memoryFallback = new MemoryRateLimiter();

export async function rateLimit(c: LimitContext, bucket: string, limit: number, windowSeconds: number, explicitKey?: string): Promise<void> {
  const limiter = c.get('rateLimiter') ?? (c.env?.IDENTITY ? new D1RpcRateLimiter(c.env.IDENTITY) : c.env?.RATE_LIMIT_MODE === 'memory' ? memoryFallback : null);
  if (!limiter) throw dependencyUnavailable('rate limiter (bind IDENTITY or set RATE_LIMIT_MODE=memory in dark)');
  return makeRateLimit(limiter)(c, bucket, limit, windowSeconds, explicitKey);
}
