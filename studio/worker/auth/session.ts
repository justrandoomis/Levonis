/**
 * Studio sessions — host-scoped, modeled on the main worker's
 * worker/lib/session.ts (STUDIO_PLAN decision 3):
 *
 *   * the raw session token lives ONLY in an HttpOnly Secure SameSite=Lax
 *     cookie scoped to the Studio host (NEVER `Domain=.levonis-iq.com` —
 *     community-store subdomains exist and must not receive it),
 *   * the database stores only the token's SHA-256 digest,
 *   * sessions are server-side rows in the Studio's own D1, so logout and
 *     account switching revoke access for real (not just hidden menus),
 *   * the row carries the minimum identity handed over by the main site
 *     ({user_id, display_name, locale}) — the Studio DB has no users table
 *     and never joins store tables (owner identity stays opaque).
 *
 * This module also owns the defense-in-depth request hygiene: stripping the
 * legacy-hosting `oai-*` identity headers (spoofable by any client on a
 * public server — never trusted) and the internal `x-levo-*` headers, which
 * only the Studio worker itself may set after validating a session.
 */

/** Studio session cookie — host-scoped by omitting any Domain attribute. */
export const STUDIO_SESSION_COOKIE = 'levo_studio_session';
/** Short-lived handoff state cookie used between /auth/login and /auth/callback. */
export const STUDIO_HANDOFF_COOKIE = 'levo_studio_handoff';
/**
 * Internal identity header set by the Studio worker for the SSR app after a
 * session was validated. Inbound copies are ALWAYS stripped first, so the
 * app may trust it (see sanitizeRequestHeaders / withUserHeader).
 */
export const STUDIO_USER_HEADER = 'x-levo-user';

const SESSION_TTL_DAYS = 14;
const HANDOFF_COOKIE_MAX_AGE_SECONDS = 600;

export type StudioLocale = 'ar' | 'en' | 'ckb';

export interface StudioSessionUser {
  id: string;
  display_name: string;
  locale: StudioLocale;
}

export interface StudioSession {
  sessionId: string;
  user: StudioSessionUser;
}

/**
 * Bindings/vars the auth layer needs from studio/wrangler.jsonc:
 *   DB                     Studio D1 (levonis-studio-db)
 *   MAIN_SITE_ORIGIN       trusted main-site origin, e.g. https://levonis-iq.com
 *                          (per environment; never derived from a request
 *                          header). MAIN_ORIGIN is accepted as an alias.
 *   STUDIO_HANDOFF_SECRET  shared secret for server-to-server calls to the
 *                          main worker (wrangler secret; never committed)
 * The string values are optional so sign-in stays HONESTLY disabled (503,
 * guest editing untouched) until deploy wiring configures them.
 */
export interface StudioAuthEnv {
  DB: D1Database;
  MAIN_SITE_ORIGIN?: string;
  MAIN_ORIGIN?: string;
  STUDIO_HANDOFF_SECRET?: string;
}

/** Trusted main-site origin from config — '' while unconfigured. */
export function mainSiteOrigin(env: StudioAuthEnv): string {
  return (env.MAIN_SITE_ORIGIN || env.MAIN_ORIGIN || '').trim().replace(/\/+$/, '');
}

// Crypto helpers (WebCrypto; duplicated from worker/lib/crypto.ts because
// the Studio workspace never imports across the workspace boundary) --------

const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string equality via fixed-length SHA-256 digests. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const da = enc.encode(await sha256Hex(a));
  const db = enc.encode(await sha256Hex(b));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

// Session table --------------------------------------------------------------
//
// The Studio D1 migration pipeline belongs to the storage slice (studio/db +
// studio/drizzle). Until studio_sessions is part of those migrations the
// auth layer provisions its own table idempotently (CREATE TABLE IF NOT
// EXISTS, once per isolate) so sign-in cannot dead-end on a fresh database.

const SESSION_TABLE_SQL = [
  `CREATE TABLE IF NOT EXISTS studio_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    locale TEXT NOT NULL DEFAULT 'ar',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  )`,
  'CREATE INDEX IF NOT EXISTS idx_studio_sessions_user ON studio_sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_studio_sessions_expires ON studio_sessions(expires_at)',
];

let sessionTableEnsured = false;

async function ensureSessionTable(db: D1Database): Promise<void> {
  if (sessionTableEnsured) return;
  for (const sql of SESSION_TABLE_SQL) await db.prepare(sql).run();
  sessionTableEnsured = true;
}

// Cookie helpers -------------------------------------------------------------

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

/** Host-scoped session cookie (deliberately NO Domain attribute). */
export function sessionCookie(token: string, expires: Date): string {
  return `${STUDIO_SESSION_COOKIE}=${token}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${STUDIO_SESSION_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

/** Transient state cookie for the login → callback round-trip. */
export function handoffCookie(value: string): string {
  return `${STUDIO_HANDOFF_COOKIE}=${value}; Path=/auth; Max-Age=${HANDOFF_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearHandoffCookie(): string {
  return `${STUDIO_HANDOFF_COOKIE}=; Path=/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

// Session lifecycle ----------------------------------------------------------

export function normalizeLocale(value: unknown): StudioLocale {
  return value === 'en' || value === 'ckb' ? value : 'ar';
}

/**
 * Creates a fresh session row for the redeemed identity and returns the raw
 * cookie token (mint-on-login means session fixation is impossible — a
 * pre-auth cookie value is never promoted).
 */
export async function createStudioSession(
  env: StudioAuthEnv,
  user: StudioSessionUser,
  userAgent: string
): Promise<{ token: string; expires: Date }> {
  await ensureSessionTable(env.DB);
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await env.DB.prepare(
    'INSERT INTO studio_sessions (id, user_id, display_name, locale, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, user.id, user.display_name, user.locale, expires.toISOString(), userAgent.slice(0, 255))
    .run();
  return { token, expires };
}

/** Loads and validates the session referenced by the request cookie. */
export async function loadStudioSession(request: Request, env: StudioAuthEnv): Promise<StudioSession | null> {
  const token = parseCookies(request.headers.get('Cookie')).get(STUDIO_SESSION_COOKIE);
  if (!token || token.length > 256) return null;
  await ensureSessionTable(env.DB);
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    'SELECT id, user_id, display_name, locale, expires_at FROM studio_sessions WHERE id = ?'
  )
    .bind(id)
    .first<{ id: string; user_id: string; display_name: string; locale: string; expires_at: string }>();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM studio_sessions WHERE id = ?').bind(id).run();
    return null;
  }
  return {
    sessionId: row.id,
    user: { id: row.user_id, display_name: row.display_name, locale: normalizeLocale(row.locale) },
  };
}

export async function destroyStudioSession(env: StudioAuthEnv, sessionId: string): Promise<void> {
  await ensureSessionTable(env.DB);
  await env.DB.prepare('DELETE FROM studio_sessions WHERE id = ?').bind(sessionId).run();
}

/** Revokes every Studio session of one user (account switch / remote invalidation). */
export async function destroyUserStudioSessions(env: StudioAuthEnv, userId: string): Promise<void> {
  await ensureSessionTable(env.DB);
  await env.DB.prepare('DELETE FROM studio_sessions WHERE user_id = ?').bind(userId).run();
}

// Request hygiene ------------------------------------------------------------

/**
 * Strips every inbound `oai-*` header (legacy-hosting identity headers any
 * client can forge — mandate §3 forbids trusting them) and every inbound
 * `x-levo-*` header (reserved for the worker's own post-validation use).
 * Runs BEFORE any routing or session handling.
 */
export function sanitizeRequestHeaders(request: Request): Request {
  let dirty = false;
  for (const name of request.headers.keys()) {
    const lower = name.toLowerCase();
    if (lower.startsWith('oai-') || lower.startsWith('x-levo-')) {
      dirty = true;
      break;
    }
  }
  if (!dirty) return request;
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (lower.startsWith('oai-') || lower.startsWith('x-levo-')) headers.delete(name);
  }
  return new Request(request, { headers });
}

/** Attaches the validated identity for the SSR app (after sanitization only). */
export function withUserHeader(request: Request, user: StudioSessionUser): Request {
  const headers = new Headers(request.headers);
  headers.set(STUDIO_USER_HEADER, encodeURIComponent(JSON.stringify(user)));
  return new Request(request, { headers });
}

// Return-path safety ---------------------------------------------------------

const RESERVED_AUTH_PREFIXES = ['/auth', '/signin-with-chatgpt', '/signout-with-chatgpt'];

/**
 * Same rules the previous safeRelativeReturnPath applied: same-origin
 * RELATIVE paths only — anything absolute, protocol-relative, malformed or
 * pointing back into the auth endpoints falls back to "/".
 */
export function safeRelativeReturnPath(value: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  let url: URL;
  try {
    url = new URL(value, 'https://studio.local');
  } catch {
    return '/';
  }
  if (url.origin !== 'https://studio.local') return '/';
  const p = url.pathname;
  if (RESERVED_AUTH_PREFIXES.some((r) => p === r || p.startsWith(`${r}/`))) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

// Main-site liveness (server-to-server) --------------------------------------

/**
 * Asks the MAIN worker whether this user still has any live main-site
 * session, so sensitive Studio APIs can honor main-site logout (mandate §3).
 * 'unknown' means the check could not run (not configured / unreachable) —
 * callers decide their own failure posture and must not treat it as 'active'.
 */
export async function verifyMainSessionLiveness(
  env: StudioAuthEnv,
  userId: string
): Promise<'active' | 'inactive' | 'unknown'> {
  const origin = mainSiteOrigin(env);
  const secret = (env.STUDIO_HANDOFF_SECRET || '').trim();
  if (!origin || !secret) return 'unknown';
  try {
    const res = await fetch(`${origin}/api/studio/handoff/introspect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    });
    if (!res.ok) return 'unknown';
    const data = (await res.json().catch(() => null)) as { success?: boolean; active?: boolean } | null;
    if (!data || data.success !== true) return 'unknown';
    return data.active ? 'active' : 'inactive';
  } catch {
    return 'unknown';
  }
}
