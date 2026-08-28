import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppContext, SessionUser } from './types';
import { randomToken, sha256Hex } from './crypto';

const COOKIE_NAME = 'levonis_session';
const SESSION_TTL_DAYS = 14;

export async function createSession(c: Context<AppContext>, userId: string): Promise<void> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await c.env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)'
  )
    .bind(id, userId, expires.toISOString(), (c.req.header('User-Agent') || '').slice(0, 255))
    .run();
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    expires,
  });
}

export async function loadSessionUser(c: Context<AppContext>): Promise<void> {
  c.set('user', null);
  c.set('sessionId', null);
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return;
  const id = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT u.*, s.id AS session_id, s.expires_at AS session_expires
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
  const { session_id, session_expires, password_hash, google_sub, ...user } = row;
  c.set('user', user as unknown as SessionUser);
  c.set('sessionId', String(session_id));
}

export async function destroySession(c: Context<AppContext>): Promise<void> {
  const sessionId = c.get('sessionId');
  if (sessionId) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
  }
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}

export async function destroyAllSessions(c: Context<AppContext>, userId: string): Promise<void> {
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}
