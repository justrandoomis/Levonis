/**
 * Rate limiting at the edge (`01-TARGET.md` §3.6, ADR-016).
 *
 * THE RULE THAT SHAPES EVERY NUMBER BELOW: **no gateway class may be tighter
 * than the bucket the core enforces today for the same route.** A gateway that
 * throttles harder than the Worker behind it is not a security improvement, it
 * is an outage with a 429 body — and the first version of this design had
 * exactly one: the Telegram status poll, which `auth.ts` allows at 240/min per
 * IP because Iraqi carriers NAT many customers behind one address and the SPA
 * polls every three seconds. `test/rateLimitParity.test.ts` extracts every
 * `rateLimit(c, bucket, limit, window)` call site from `worker/routes/`, maps
 * it to its mounted prefix, and fails if the class this file gives that prefix
 * is slower in requests per second.
 *
 * LAYERS (all four adapters live in the platform kit; this file only chooses):
 *  - `BindingRateLimiter` — the `ratelimits` binding, per COLO, no resource to
 *    create. The cheap first layer for `ip` and `public-read`, which have no
 *    counter at all today.
 *  - `D1RpcRateLimiter` — `IDENTITY.rateLimitHit`, today's D1 fixed window,
 *    cross-isolate and therefore AUTHORITATIVE. Every class that exists in the
 *    core goes through it, so no extraction ever loses a limit.
 *  - `MemoryRateLimiter` — per isolate, trivially bypassed by spreading
 *    requests over colos. Dark/local only, and only when `RATE_LIMIT_MODE`
 *    says `memory`; there is never a silent fallback to it (ADR-016).
 *
 * NEW CLASSES SHIP IN SHADOW. `ip` and `public-read` limit surfaces that have
 * no counter today, so their numbers are placeholders until the observed p99
 * of one NAT IP's boot fan-out replaces them (§3.6). They count and log; they
 * do not refuse. Flipping them to enforcement is a var, `RATE_LIMIT_ENFORCE`.
 */
import type { RateClass } from '@levonis/platform-kit/edge/capabilities';
import type { RateLimiter, RateLimitVerdict } from '@levonis/platform-kit/ratelimit';
import { BindingRateLimiter, D1RpcRateLimiter, LayeredRateLimiter, MemoryRateLimiter, rateLimitKey } from '@levonis/platform-kit/ratelimit';
import type { Env, IdentityGatewayApi } from './env';

export type LimitMode = 'enforce' | 'shadow';
export type LimitKeyBy = 'ip' | 'user';

export interface LimitSpec {
  cls: RateClass;
  /** the counter bucket name — the key prefix in `rate_limits`, kept distinct from the core's own buckets */
  bucket: string;
  limit: number;
  windowSeconds: number;
  keyBy: LimitKeyBy;
  mode: LimitMode;
  note?: string;
}

/** Per-second budget, the only comparable unit between a 10/10-min and a 240/min bucket. */
export const ratePerSecond = (spec: { limit: number; windowSeconds: number }): number => spec.limit / spec.windowSeconds;

export const CLASS_LIMITS: Readonly<Record<RateClass, LimitSpec>> = {
  ip: { cls: 'ip', bucket: 'gw_ip', limit: 1200, windowSeconds: 60, keyBy: 'ip', mode: 'shadow', note: 'no counter exists today; placeholder until the shadow fortnight' },
  'public-read': { cls: 'public-read', bucket: 'gw_public', limit: 600, windowSeconds: 60, keyBy: 'ip', mode: 'shadow', note: 'catalogue, home, storefront, leaderboard — previously unlimited' },
  user: { cls: 'user', bucket: 'gw_user', limit: 300, windowSeconds: 60, keyBy: 'user', mode: 'enforce' },
  auth: { cls: 'auth', bucket: 'gw_auth', limit: 240, windowSeconds: 60, keyBy: 'ip', mode: 'enforce', note: 'the class floor is the Telegram status poll; the tighter per-route buckets stay in the core' },
  money: { cls: 'money', bucket: 'gw_money', limit: 60, windowSeconds: 60, keyBy: 'user', mode: 'enforce' },
  write: { cls: 'write', bucket: 'gw_write', limit: 120, windowSeconds: 60, keyBy: 'user', mode: 'enforce' },
  upload: { cls: 'upload', bucket: 'gw_upload', limit: 60, windowSeconds: 60, keyBy: 'user', mode: 'enforce' },
  'admin-write': { cls: 'admin-write', bucket: 'gw_admin', limit: 600, windowSeconds: 60, keyBy: 'user', mode: 'enforce', note: 'previously unlimited' },
  webhook: { cls: 'webhook', bucket: 'gw_webhook', limit: 300, windowSeconds: 60, keyBy: 'ip', mode: 'enforce' },
};

/**
 * Prefixes exempt from the GENERIC `ip` class: bearer-authenticated
 * server-to-server calls arrive from shared Cloudflare egress addresses, so one
 * IP bucket would count every tenant's traffic as a single caller (§3.6). They
 * are not left unlimited — each keeps its own class in PATH_LIMITS below.
 */
export const IP_CLASS_EXEMPT: readonly string[] = ['/api/studio/', '/api/telegram/webhook'];

/**
 * Per-path overrides inside a class. These exist only where one prefix mixes
 * traffic shapes; the tight per-route buckets (login 10/10 min, register 5/h,
 * deposit 10/h) stay where they are today — inside the route, keyed by
 * identifier, through the same cross-isolate store.
 */
export const PATH_LIMITS: readonly { prefix: string; spec: LimitSpec }[] = [
  { prefix: '/api/telegram/webhook', spec: CLASS_LIMITS.webhook },
  { prefix: '/api/studio', spec: { ...CLASS_LIMITS.auth, bucket: 'gw_studio', limit: 600, windowSeconds: 60, note: 'Studio server-to-server: shared egress IPs' } },
];

export function limitFor(path: string, cls: RateClass): LimitSpec {
  let best: { prefix: string; spec: LimitSpec } | null = null;
  for (const p of PATH_LIMITS) {
    if (!path.startsWith(p.prefix)) continue;
    if (!best || p.prefix.length > best.prefix.length) best = p;
  }
  return best ? best.spec : CLASS_LIMITS[cls];
}

export const isIpExempt = (path: string): boolean => IP_CLASS_EXEMPT.some((p) => path.startsWith(p));

/**
 * `RATE_LIMIT_ENFORCE="ip,public-read"` promotes a shadow class to enforcement
 * without a deploy — the end of the shadow fortnight is a var change. It can
 * only tighten: a class that enforces by default cannot be turned into a
 * shadow class from configuration, because "the limit is off" must never be
 * one typo away.
 */
export function effectiveSpec(spec: LimitSpec, enforceVar: string | undefined): LimitSpec {
  if (spec.mode === 'enforce') return spec;
  const list = (enforceVar ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(spec.cls) ? { ...spec, mode: 'enforce' } : spec;
}

/**
 * The layered limiter for this request.
 *
 * Returns null when neither an authoritative counter nor an explicit
 * `RATE_LIMIT_MODE=memory` is configured: the caller then refuses the request
 * rather than pretending it was limited (ADR-016). The binding layer alone is
 * never enough for an `auth` or `money` route — it counts per colo.
 */
export function buildLimiter(env: Env, identity?: IdentityGatewayApi): RateLimiter | null {
  const layers: RateLimiter[] = [];
  const bindings: Record<string, { limit(input: { key: string }): Promise<{ success: boolean }> }> = {};
  if (env.RL_IP) bindings.ip = env.RL_IP;
  if (env.RL_PUBLIC_READ) bindings['public-read'] = env.RL_PUBLIC_READ;
  if (Object.keys(bindings).length) layers.push(new BindingRateLimiter(bindings));

  const counter = identity ?? env.IDENTITY;
  if (counter) layers.push(new D1RpcRateLimiter(counter));
  else if ((env.RATE_LIMIT_MODE ?? '').trim().toLowerCase() === 'memory') layers.push(sharedMemoryLimiter);
  else return null;

  return new LayeredRateLimiter(layers);
}

/** One per isolate, so a dark run actually accumulates counts across requests. */
const sharedMemoryLimiter = new MemoryRateLimiter();

export interface LimitCheck {
  spec: LimitSpec;
  verdict: RateLimitVerdict;
  /** true when the verdict refuses AND the class enforces */
  refused: boolean;
}

/** Counts one hit. A shadow class always returns `refused:false` — it only observes. */
export async function checkLimit(limiter: RateLimiter, spec: LimitSpec, userId: string | null, ip: string): Promise<LimitCheck> {
  const key = rateLimitKey(spec.bucket, spec.keyBy === 'user' ? userId : null, ip);
  const verdict = await limiter.hit(spec.cls, key, spec.limit, spec.windowSeconds);
  return { spec, verdict, refused: !verdict.allowed && spec.mode === 'enforce' };
}

/** Today's 429 body (`worker/lib/http.ts` `tooMany`), byte for byte. */
export const TOO_MANY_BODY = { success: false as const, error: 'Too many requests, try again later', code: 'RATE_LIMITED' as const };
