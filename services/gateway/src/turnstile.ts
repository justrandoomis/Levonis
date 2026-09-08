/**
 * The Turnstile hook (`01-TARGET.md` §3.8).
 *
 * OFF UNTIL THE SECRET EXISTS. `isEnabled()` is the only switch: with no
 * `TURNSTILE_SECRET` no route is challenged, no token is read, nothing is
 * fetched, and `/api/auth/capabilities` advertises no sitekey — which is
 * exactly the platform's behaviour today. That is what makes shipping this
 * code dark a no-op rather than a change.
 *
 * THE LOGIN HOOK DOES NOT MAKE THE GATEWAY READ CREDENTIALS. Challenging login
 * "after 3 failures per identifier" would otherwise force the Worker that
 * faces the internet to parse and remember credential bodies. It does not:
 * Identity (the core until Phase 9) knows the failures and answers the third
 * one with an internal `x-levonis-challenge: turnstile` header; the gateway
 * records the marker (see `ChallengeMarkers` below for where, and why not in
 * the limiter store) and challenges the next attempt for that key. The header
 * is stripped before the response leaves (`pipeline.ts` strips every
 * `x-levonis-*`).
 */
import type { ApiFailure } from '@levonis/contracts/http/common';
import { fetchWithBudget } from '@levonis/platform-kit/httpx';

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_TIMEOUT_MS = 3_000;
export const TURNSTILE_TOKEN_HEADER = 'x-turnstile-token';
/** The internal header Identity sets on the third failure; never reaches the client. */
export const CHALLENGE_HEADER = 'x-levonis-challenge';
/** How long a `challenge:<key>` marker stays armed. */
export const CHALLENGE_WINDOW_S = 900;

/** Prefixes challenged unconditionally once Turnstile is on (`01-TARGET.md` §3.8). */
export const TURNSTILE_ROUTES: readonly { prefix: string; methods: readonly string[] }[] = [
  { prefix: '/api/auth/register', methods: ['POST'] },
  { prefix: '/api/auth/signup', methods: ['POST'] },
  { prefix: '/api/auth/forgot-password', methods: ['POST'] },
  { prefix: '/api/auth/telegram/start', methods: ['POST'] },
  { prefix: '/api/wallet', methods: ['POST'] },
  { prefix: '/api/marketplace/requests', methods: ['POST'] },
  { prefix: '/api/marketplace/print', methods: ['POST'] },
  { prefix: '/api/chats/open', methods: ['POST'] },
  { prefix: '/api/reviews', methods: ['POST'] },
  { prefix: '/api/support/tickets', methods: ['POST'] },
];

/** Challenged only when a `challenge:<identifierKey>` marker is armed for the caller. */
export const CONDITIONAL_ROUTES: readonly { prefix: string; methods: readonly string[] }[] = [
  { prefix: '/api/auth/login', methods: ['POST'] },
];

export const isEnabled = (secret: string | undefined): boolean => !!(secret ?? '').trim();

export function isChallengedRoute(path: string, method: string, routes: readonly { prefix: string; methods: readonly string[] }[] = TURNSTILE_ROUTES): boolean {
  const m = method.toUpperCase();
  return routes.some((r) => path.startsWith(r.prefix) && r.methods.includes(m));
}

export interface TurnstileVerification {
  ok: boolean;
  reason?: string;
}

/**
 * Verifies a token. Returns `ok:false` — never throws — because a refusal and
 * a provider outage must be the same shape to the caller of this function; the
 * pipeline decides which of the two becomes a 403.
 */
export async function verifyToken(secret: string, token: string, remoteIp: string | null, fetchImpl?: typeof fetch): Promise<TurnstileVerification> {
  if (!token) return { ok: false, reason: 'missing-input-response' };
  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set('remoteip', remoteIp);
  try {
    const res = await fetchWithBudget(
      TURNSTILE_VERIFY_URL,
      { method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      { timeoutMs: TURNSTILE_TIMEOUT_MS, retries: 0, provider: 'turnstile', ...(fetchImpl ? { fetchImpl } : {}) }
    );
    const body = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    return body.success === true ? { ok: true } : { ok: false, reason: (body['error-codes'] ?? []).join(',') || 'rejected' };
  } catch (e) {
    return { ok: false, reason: `unavailable: ${(e as Error).name}` };
  }
}

/** The refusal body: `403 TURNSTILE_REQUIRED` with the sitekey the client needs to render the widget. */
export function challengeRequired(sitekey: string | undefined): { status: 403; body: ApiFailure } {
  return {
    status: 403,
    body: {
      success: false,
      error: 'Verification required',
      code: 'TURNSTILE_REQUIRED',
      ...(sitekey ? { details: { turnstile_sitekey: sitekey } } : {}),
    },
  };
}

/**
 * The key a marker is stored under.
 *
 * IT IS THE CALLER'S ADDRESS, not the account — and that is a consequence of
 * the rule that made this design safe in the first place. Identity may name
 * the account it armed the challenge for (`turnstile; key=<identifierKey>`),
 * but the gateway cannot RECOGNISE that account on the next request without
 * reading the credential body, which is exactly what §3.8 refuses to make the
 * internet-facing Worker do. So the marker the gateway can act on is the one
 * it can compute from the request itself.
 *
 * The account half of the rule is not lost: Identity counts failures per
 * identifier and refuses per identifier, on every colo, whatever the gateway
 * does. The gateway's marker only decides whether a widget is shown first.
 */
export function challengeKeyFrom(_header: string, ip: string): string {
  return `ip:${ip}`;
}

/**
 * The challenge markers.
 *
 * WHY THESE ARE PER ISOLATE, AND SAID SO OUT LOUD. §3.8 puts the marker in the
 * cross-isolate limiter store, and that is where it belongs — but a fixed
 * WINDOW COUNTER cannot be read without incrementing it, so "is this caller
 * armed?" would arm every caller who asked twice. Reading it without counting
 * needs a peek, and a peek needs an Identity method the gateway is not allowed
 * to hold: `tests/leastPrivilege.test.ts` pins its calls to `resolveSession`,
 * `revoke`, `getPublicKeys` and `rateLimitHit` (ADR-015), and widening that set
 * so the edge can ask a question about login failures is a worse trade than
 * this one.
 *
 * So the marker lives in the isolate that saw Identity's header, with a
 * 15-minute TTL. The consequence is bounded and stated: an attacker who lands
 * on a different isolate for the next attempt is not challenged by the
 * GATEWAY — Identity still counts their failures and still refuses them, and
 * the third failure arms the marker there too. When the `RateLimitCounter`
 * Durable Object of §3.6 exists it can be read without being written, and this
 * store becomes one line of adapter.
 */
export class ChallengeMarkers {
  private readonly armed = new Map<string, number>();
  constructor(private readonly ttlMs = CHALLENGE_WINDOW_S * 1000, private readonly now: () => number = () => Date.now()) {}

  arm(key: string): void {
    this.armed.set(key, this.now() + this.ttlMs);
  }

  /** A pure read: asking does not arm. */
  isArmed(key: string): boolean {
    const until = this.armed.get(key);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.armed.delete(key);
      return false;
    }
    return true;
  }

  clear(key?: string): void {
    if (key === undefined) this.armed.clear();
    else this.armed.delete(key);
  }

  get size(): number {
    return this.armed.size;
  }
}
