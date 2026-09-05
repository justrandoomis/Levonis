import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppContext, SessionUser } from './types';
import { randomToken, sha256Hex } from './crypto';
import { rootDomainFrom, sessionCookieDomain } from './hosts';

const COOKIE_NAME = 'levonis_session';
const SESSION_TTL_DAYS = 14;

/**
 * Where the session cookie is valid.
 *
 * ONE Levonis identity, everywhere (§8). A customer signed in on
 * levonis-iq.com must already be signed in when they open
 * ali3d.levonis-iq.com — so in production the cookie is scoped to the parent
 * domain and every storefront shares it. There is no second account system
 * and no token in JavaScript: the cookie stays HttpOnly.
 *
 * Environment-aware because it has to be. `localhost` has no dot and
 * `*.workers.dev` is a public suffix, so a browser SILENTLY DISCARDS a
 * Set-Cookie naming either as Domain. No error is raised anywhere; sign-in
 * just never sticks. `sessionCookieDomain` returns null for those, and
 * omitting Domain gives a host-only cookie that works.
 *
 * Every write and every delete goes through this one function, because a
 * cookie deleted with different Domain/Path attributes than it was created
 * with is not deleted at all — the browser keeps offering the old one and
 * "log out" becomes a lie.
 */
function cookieOptions(c: Context<AppContext>) {
  const domain = sessionCookieDomain(c.req.header('Host'), rootDomainFrom(c.env));
  return {
    httpOnly: true,
    secure: true,
    // Lax, not None. The cookie must survive a top-level navigation from the
    // main site to a storefront, which Lax allows; it must NOT ride along on
    // a cross-site POST, which is the protection §53 says not to weaken.
    sameSite: 'Lax' as const,
    path: '/',
    ...(domain ? { domain } : {}),
  };
}

export async function createSession(c: Context<AppContext>, userId: string): Promise<void> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await c.env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)'
  )
    .bind(id, userId, expires.toISOString(), (c.req.header('User-Agent') || '').slice(0, 255))
    .run();
  setCookie(c, COOKIE_NAME, token, { ...cookieOptions(c), expires });
}

export async function loadSessionUser(c: Context<AppContext>): Promise<void> {
  c.set('user', null);
  c.set('sessionId', null);
  c.set('sessionCreatedAt', null);
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return;
  const id = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT u.*, s.id AS session_id, s.expires_at AS session_expires, s.created_at AS session_created
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return;
  if (new Date(String(row.session_expires)).getTime() < Date.now()) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return;
  }
  const { session_id, session_expires, session_created, password_hash, google_sub, ...user } = row;
  c.set('user', user as unknown as SessionUser);
  c.set('sessionId', String(session_id));
  c.set('sessionCreatedAt', session_created ? String(session_created) : null);
}

/** The window in which "you just signed in" still counts as proof of presence. */
export const FRESH_SESSION_SECONDS = 10 * 60;

/**
 * How old the current session is, in seconds; Infinity when unknown.
 *
 * A live session cookie proves the browser holds a session, not that the
 * person is present: a stolen cookie is exactly as live. Where an account has
 * no password to prove (Google/Telegram sign-ups), setting its FIRST password
 * or changing its email asks for a sign-in within the last few minutes
 * instead — a re-authentication the cookie's holder cannot perform.
 */
export function sessionAgeSeconds(c: Context<AppContext>): number {
  const created = c.get('sessionCreatedAt');
  if (!created) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(created);
  if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - ms) / 1000);
}

/**
 * Deleting must mirror creating. `deleteCookie` sends an expired Set-Cookie,
 * and the browser only matches it to the stored cookie when Domain and Path
 * agree. Signing out on a storefront with a host-only delete would leave the
 * parent-domain cookie in place and the customer still signed in everywhere
 * else — so the same options are used here, minus the expiry.
 */
function clearCookie(c: Context<AppContext>): void {
  const { httpOnly, secure, sameSite, path, ...rest } = cookieOptions(c);
  const domain = (rest as { domain?: string }).domain;
  deleteCookie(c, COOKIE_NAME, {
    path,
    secure,
    sameSite,
    httpOnly,
    ...(domain ? { domain } : {}),
  });
}

export async function destroySession(c: Context<AppContext>): Promise<void> {
  const sessionId = c.get('sessionId');
  if (sessionId) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
  }
  clearCookie(c);
}

export async function destroyAllSessions(c: Context<AppContext>, userId: string): Promise<void> {
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  clearCookie(c);
}
