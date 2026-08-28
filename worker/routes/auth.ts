import { Hono } from 'hono';
import type { AppContext, SessionUser } from '../lib/types';
import { publicUser } from '../lib/types';
import { badRequest, unauthorized, conflict, unavailable, requireAuth, str, email, username } from '../lib/http';
import { newId, hashPassword, verifyPassword, isLegacyHash, randomToken, sha256Hex } from '../lib/crypto';
import { createSession, destroySession, destroyAllSessions, loadSessionUser } from '../lib/session';
import { verifyGoogleIdToken } from '../lib/google';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';

export const authRoutes = new Hono<AppContext>();

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

function checkPassword(pw: string): void {
  if (pw.length < PASSWORD_MIN) throw badRequest(`Password must be at least ${PASSWORD_MIN} characters`);
  if (pw.length > PASSWORD_MAX) throw badRequest('Password is too long');
}

async function getFullUser(db: D1Database, id: string): Promise<SessionUser | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<SessionUser>();
}

authRoutes.post('/register', async (c) => {
  await rateLimit(c, 'register', 10, 3600);
  const body = await c.req.json().catch(() => ({}));
  const mail = email(body.email);
  const uname = body.username ? username(body.username) : null;
  const name = str(body.name, 'name', { min: 0, max: 100, required: false });
  const password = String(body.password ?? '');
  checkPassword(password);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(mail).first();
  if (existing) throw conflict('An account with this email already exists');
  if (uname) {
    const taken = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(uname).first();
    if (taken) throw conflict('This username is taken');
  }

  const id = newId('usr');
  const hash = await hashPassword(password);
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, username, name, password_hash) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, mail, uname, name, hash)
    .run();

  await createSession(c, id);
  const user = await getFullUser(c.env.DB, id);
  return c.json({ success: true, user: publicUser(user!) });
});

authRoutes.post('/login', async (c) => {
  await rateLimit(c, 'login', 20, 900);
  const body = await c.req.json().catch(() => ({}));
  const identifier = str(body.email, 'email or username', { min: 3, max: 320 }).toLowerCase();
  const password = String(body.password ?? '');
  if (!password) throw badRequest('Password is required');

  const row = await c.env.DB.prepare(
    'SELECT * FROM users WHERE email = ? OR username = ?'
  )
    .bind(identifier, identifier)
    .first<SessionUser & { password_hash: string | null }>();

  // Uniform error to avoid account enumeration.
  const fail = () => unauthorized('Incorrect email/username or password');
  if (!row) throw fail();
  if (!row.password_hash) {
    throw unauthorized('This account uses Google Sign-In. Please continue with Google.');
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) throw fail();

  if (isLegacyHash(row.password_hash)) {
    const newHash = await hashPassword(password);
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, row.id).run();
  }

  await createSession(c, row.id);
  const user = await getFullUser(c.env.DB, row.id);
  return c.json({ success: true, user: publicUser(user!) });
});

authRoutes.post('/google', async (c) => {
  await rateLimit(c, 'google', 30, 900);
  const body = await c.req.json().catch(() => ({}));
  const credential = str(body.credential, 'credential', { min: 20, max: 4096 });

  let identity;
  try {
    identity = await verifyGoogleIdToken(credential, c.env.GOOGLE_CLIENT_ID);
  } catch (e) {
    if (!c.env.GOOGLE_CLIENT_ID) {
      throw unavailable('Google Sign-In is not configured yet (GOOGLE_CLIENT_ID missing)', 'GOOGLE_NOT_CONFIGURED');
    }
    throw unauthorized(e instanceof Error ? e.message : 'Google sign-in failed');
  }

  // Match by google_sub first (stable), then link by verified email.
  let row = await c.env.DB.prepare('SELECT * FROM users WHERE google_sub = ?')
    .bind(identity.sub)
    .first<SessionUser>();

  if (!row) {
    const byEmail = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?')
      .bind(identity.email)
      .first<SessionUser & { google_sub: string | null }>();
    if (byEmail) {
      if (byEmail.google_sub && byEmail.google_sub !== identity.sub) {
        throw conflict('This email is already linked to a different Google account');
      }
      await c.env.DB.prepare('UPDATE users SET google_sub = ? WHERE id = ?').bind(identity.sub, byEmail.id).run();
      row = byEmail;
    }
  }

  if (!row) {
    const id = newId('usr');
    const base = identity.email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24) || 'user';
    // Ensure a unique username without leaking whether the base exists.
    let uname = base;
    for (let i = 0; i < 3; i++) {
      const taken = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(uname).first();
      if (!taken) break;
      uname = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    }
    await c.env.DB.prepare(
      'INSERT INTO users (id, email, username, name, google_sub) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(id, identity.email, uname, identity.name || 'User', identity.sub)
      .run();
    row = (await getFullUser(c.env.DB, id))!;
  }

  // Controlled initial-admin bootstrap: promote only on a VERIFIED Google
  // identity matching INITIAL_ADMIN_EMAIL, and only while no admin exists.
  if (
    c.env.INITIAL_ADMIN_EMAIL &&
    identity.email === c.env.INITIAL_ADMIN_EMAIL.toLowerCase().trim() &&
    row.role !== 'admin'
  ) {
    const adminExists = await c.env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first();
    if (!adminExists) {
      await c.env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(row.id).run();
      await audit(c.env.DB, row.id, 'auth.initial_admin_bootstrap', row.id, { email: identity.email });
    }
  }

  await createSession(c, row.id);
  const user = await getFullUser(c.env.DB, row.id);
  return c.json({ success: true, user: publicUser(user!) });
});

authRoutes.get('/me', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ success: true, user: null });
  return c.json({ success: true, user: publicUser(user) });
});

authRoutes.post('/logout', async (c) => {
  await destroySession(c);
  return c.json({ success: true });
});

authRoutes.post('/change-password', requireAuth, async (c) => {
  await rateLimit(c, 'change-password', 10, 900);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const current = String(body.currentPassword ?? '');
  const next = String(body.newPassword ?? '');
  checkPassword(next);

  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ password_hash: string | null }>();
  if (row?.password_hash) {
    const ok = await verifyPassword(current, row.password_hash);
    if (!ok) throw unauthorized('Current password is incorrect');
  }
  const hash = await hashPassword(next);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, user.id).run();
  // Revoke every other session, then start a fresh one for this device.
  await destroyAllSessions(c, user.id);
  await createSession(c, user.id);
  await audit(c.env.DB, user.id, 'auth.password_changed', user.id);
  return c.json({ success: true });
});

authRoutes.post('/forgot-password', async (c) => {
  await rateLimit(c, 'forgot', 5, 3600);
  const body = await c.req.json().catch(() => ({}));
  const mail = email(body.email);

  if (!c.env.EMAIL_API_KEY || !c.env.EMAIL_FROM) {
    // Honest unavailability: no email service is configured, so no reset
    // email can be sent. We never generate or reveal passwords instead.
    throw unavailable(
      'Password reset by email is not available yet because no email service is configured. Please contact support.',
      'EMAIL_NOT_CONFIGURED'
    );
  }

  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ?')
    .bind(mail)
    .first<{ id: string; email: string }>();

  // Always report success so the endpoint cannot be used to enumerate accounts.
  if (user) {
    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    const expires = new Date(Date.now() + 30 * 60_000).toISOString();
    await c.env.DB.prepare(
      'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
    )
      .bind(tokenHash, user.id, expires)
      .run();
    const origin = new URL(c.req.url).origin;
    const link = `${origin}/auth?reset=${token}`;
    const sent = await sendEmail(c.env.EMAIL_API_KEY, c.env.EMAIL_FROM, user.email, 'Reset your Levonis password',
      `<p>We received a request to reset your Levonis password.</p>
       <p><a href="${link}">Click here to choose a new password</a>. This link expires in 30 minutes and can be used once.</p>
       <p>If you did not request this, you can ignore this email.</p>`);
    if (!sent) console.error('Password reset email send failed for user', user.id);
  }
  return c.json({ success: true, message: 'If an account exists for that email, a reset link has been sent.' });
});

authRoutes.post('/reset-password', async (c) => {
  await rateLimit(c, 'reset', 10, 3600);
  const body = await c.req.json().catch(() => ({}));
  const token = str(body.token, 'token', { min: 20, max: 128 });
  const next = String(body.password ?? '');
  checkPassword(next);

  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    'SELECT token_hash, user_id, expires_at, used FROM password_reset_tokens WHERE token_hash = ?'
  )
    .bind(tokenHash)
    .first<{ token_hash: string; user_id: string; expires_at: string; used: number }>();
  if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) {
    throw badRequest('This reset link is invalid or has expired', 'BAD_TOKEN');
  }

  const hash = await hashPassword(next);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token_hash = ?').bind(tokenHash),
    c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, row.user_id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
  ]);
  await audit(c.env.DB, row.user_id, 'auth.password_reset', row.user_id);
  return c.json({ success: true });
});

async function sendEmail(apiKey: string, from: string, to: string, subject: string, html: string): Promise<boolean> {
  // Resend-compatible API; swap the URL for another provider if needed.
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  return res.ok;
}

export { loadSessionUser };
