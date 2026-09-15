import type { Context, Next } from 'hono';
import { adminAllowedOn, classifyHost, rootDomainFrom, type HostInfo } from './hosts';
import { STATIC_SECURITY_HEADERS, STRICT_TRANSPORT_SECURITY, spaCsp } from './securityPolicy';
import type { AppContext } from './types';
import { canonicalUsername, usernameRejection, type UsernameRejection } from './usernames';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    /** Machine-readable context the CLIENT needs to act on the refusal — e.g.
     *  which shipping type the cart already holds, so the dialog can name it.
     *  Serialized as-is, so it must never carry anything private. */
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code?: string, details?: Record<string, unknown>) =>
  new HttpError(400, msg, code, details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'Not allowed') => new HttpError(403, msg, 'FORBIDDEN');
export const notFound = (msg = 'Not found') => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg: string, code = 'CONFLICT') => new HttpError(409, msg, code);
export const tooMany = (msg = 'Too many requests, try again later') => new HttpError(429, msg, 'RATE_LIMITED');
export const unavailable = (msg: string, code = 'NOT_CONFIGURED') => new HttpError(503, msg, code);

/** Requires a signed-in user. */
export async function requireAuth(c: Context<AppContext>, next: Next) {
  if (!c.get('user')) throw unauthorized();
  await next();
}

/**
 * The request's host classification. worker/index.ts sets it once per request;
 * a router mounted without that middleware (a test harness, a future second
 * entry point) gets the same classification computed from the Host header and
 * the configured root domain, so the admin host rule below never depends on
 * a middleware someone remembered to install.
 */
function requestHost(c: Context<AppContext>): HostInfo {
  return c.get('host') ?? classifyHost(c.req.header('Host'), rootDomainFrom(c.env ?? {}));
}

/**
 * Requires a PLATFORM admin (server-side role, never a client flag) — and
 * requires it on a host where platform administration may be served at all.
 *
 * WHY THE HOST CHECK LIVES HERE. The apex-only guard used to be a prefix
 * middleware on `/api/admin/*` alone, while seven admin surfaces mounted under
 * other prefixes (`/api/kyc/admin`, `/api/wallet/admin`, `/api/support/admin`,
 * …) used only this function. The session cookie is scoped to the parent
 * domain, so a page on a merchant storefront carries a visiting admin's own
 * session and is same-origin with its API: every one of those surfaces
 * answered on `somestore.levonis-iq.com`. Making the host rule part of admin
 * authorisation itself means a mount cannot forget it. Same 404 as
 * `requireMainHost`, for the same reason: a wrong-host caller learns the
 * route does not exist here, not that it exists elsewhere.
 */
export async function requireAdmin(c: Context<AppContext>, next: Next) {
  if (!adminAllowedOn(requestHost(c))) return c.json({ success: false, error: 'Not found' }, 404);
  const user = c.get('user');
  if (!user) throw unauthorized();
  if (user.role !== 'admin') throw forbidden('Administrator access required');
  await next();
}

export async function requireInvestor(c: Context<AppContext>, next: Next) {
  const user = c.get('user');
  if (!user) throw unauthorized();
  if (!user.is_investor && user.role !== 'admin') throw forbidden('Investor access required');
  await next();
}

/**
 * CSRF / origin protection for state-changing requests: browsers always send
 * Origin on cross-site POSTs; we reject any mutating request whose Origin is
 * present and not in the allowed set. Session cookies are additionally
 * SameSite=Lax.
 */
export function originCheck() {
  return async (c: Context<AppContext>, next: Next) => {
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = c.req.header('Origin');
      if (origin) {
        const self = new URL(c.req.url).origin;
        const extra = (c.env.EXTRA_ALLOWED_ORIGINS || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (origin !== self && !extra.includes(origin)) {
          throw forbidden('Cross-origin request rejected');
        }
      }
    }
    await next();
  };
}

export function securityHeaders() {
  return async (c: Context<AppContext>, next: Next) => {
    await next();
    for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) c.header(name, value);
    c.header('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
    // The SPA policy, unless the route already chose one: the print documents
    // (asDocument) and the R2 file sandbox set their own. See securityPolicy.ts
    // — and note the asset layer serves most of the pages themselves, from
    // dist/_headers. The product paths are the exception (run_worker_first, so
    // a shared link carries the product's own card); they arrive here already
    // carrying that file's policy, which is why this must not overwrite one.
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header('Content-Security-Policy', spaCsp());
    }
  };
}

/**
 * Refuses a route on every host but the platform's own — the guard that makes
 * wildcard merchant subdomains survivable (hosts.ts §53). Used for global
 * administration and for changing a signed-in account's credentials: the
 * session cookie is scoped to the parent domain, so a page on a merchant host
 * carries the visitor's session, and nothing those pages do needs either.
 *
 * 404, not 403: a wrong-host caller learns the route does not exist here
 * rather than that it exists elsewhere.
 */
export async function requireMainHost(c: Context<AppContext>, next: Next) {
  if (!adminAllowedOn(c.get('host'))) return c.json({ success: false, error: 'Not found' }, 404);
  await next();
}

/**
 * Own-property lookup for an allowlist map keyed by user input.
 *
 * A plain object literal answers 'constructor', 'toString' or 'hasOwnProperty'
 * with a builtin function — and when the map's values are SQL fragments, that
 * builtin's source text ends up inside the query text. Only keys the map
 * itself declares count; anything else is the fallback.
 */
export function pickFrom<T>(map: Record<string, T>, key: unknown, fallback: T): T {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback;
}

// Validation helpers ---------------------------------------------------------

export function str(v: unknown, name: string, opts: { min?: number; max?: number; required?: boolean } = {}): string {
  const { min = 0, max = 10_000, required = true } = opts;
  if (v === undefined || v === null || v === '') {
    if (required && min > 0) throw badRequest(`${name} is required`);
    return '';
  }
  if (typeof v !== 'string') throw badRequest(`${name} must be a string`);
  const t = v.trim();
  if (t.length < min) throw badRequest(`${name} is too short`);
  if (t.length > max) throw badRequest(`${name} is too long (max ${max} characters)`);
  return t;
}

export function int(v: unknown, name: string, opts: { min?: number; max?: number; def?: number } = {}): number {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, def } = opts;
  if (v === undefined || v === null || v === '') {
    if (def !== undefined) return def;
    throw badRequest(`${name} is required`);
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw badRequest(`${name} must be an integer`);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

export function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export function email(v: unknown): string {
  const s = str(v, 'email', { min: 5, max: 320 }).toLowerCase();
  if (!EMAIL_RE.test(s)) throw badRequest('Invalid email address');
  return s;
}

/**
 * One username rule, for every path that accepts one — signup, the account
 * page, the Telegram completion step. The rule itself (shape, reserved
 * handles, look-alike punctuation) lives in `lib/usernames.ts`; this wrapper
 * only turns a rejection into the HTTP error and the message a person reads.
 *
 * Reserved handles are refused HERE rather than at each call site, because
 * "somebody remembered to check" is not a guarantee: before this, an account
 * could be created holding `support` through signup even though the account
 * page would have refused it.
 */
const USERNAME_MESSAGES: Record<UsernameRejection, string> = {
  too_short: 'Username must be at least 3 characters',
  too_long: 'Username must be at most 30 characters',
  bad_characters: 'Username may only contain letters, numbers, dots, dashes and underscores',
  bad_edges: 'Username must start and end with a letter or a number',
  repeated_punctuation: 'Username may not contain two dots, dashes or underscores in a row',
  all_digits: 'Username must contain at least one letter',
  reserved: 'This username is reserved',
};

export function username(v: unknown): string {
  const s = str(v, 'username', { min: 1, max: 64 }).trim().toLowerCase();
  const rejection = usernameRejection(s);
  if (rejection) throw badRequest(USERNAME_MESSAGES[rejection], `USERNAME_${rejection.toUpperCase()}`);
  return canonicalUsername(s);
}

export function jsonArray(v: unknown, name: string, maxItems = 100): string {
  if (v === undefined || v === null) return '[]';
  if (!Array.isArray(v)) throw badRequest(`${name} must be an array`);
  if (v.length > maxItems) throw badRequest(`${name} has too many items (max ${maxItems})`);
  return JSON.stringify(v);
}
