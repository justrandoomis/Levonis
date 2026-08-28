import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, Env, SessionUser } from '../lib/types';
import { publicUser, localeToApi } from '../lib/types';
import { badRequest, unauthorized, conflict, unavailable, requireAuth, str, email, username } from '../lib/http';
import { newId, hashPassword, verifyPassword, isLegacyHash, randomToken, sha256Hex } from '../lib/crypto';
import { createSession, destroySession, destroyAllSessions, loadSessionUser } from '../lib/session';
import { verifyGoogleIdToken } from '../lib/google';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { attributeReferral } from '../lib/membershipOps';
import { enqueue, processOutbox } from '../lib/outbox';
import {
  emailLang,
  renderVerifyEmail,
  renderResetPasswordEmail,
  renderPasswordChangedEmail,
  renderGoogleAccountNoticeEmail,
  type EmailLang,
} from '../lib/emailTemplates';

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

/** Optional referral code from a signup body — free-form, capped, never fatal. */
function referralCodeFrom(body: Record<string, unknown>): string {
  return typeof body.referralCode === 'string' ? body.referralCode.trim().slice(0, 64) : '';
}

/**
 * Best-effort referral attribution after a successful account CREATION
 * (mandate 9.1/9.2). Must never fail or slow down the signup itself.
 */
async function tryAttributeReferral(env: Env, newUserId: string, code: string): Promise<void> {
  if (!code) return;
  try {
    await attributeReferral(env, newUserId, code);
  } catch (e) {
    console.error('referral attribution failed for user', newUserId, e instanceof Error ? e.message : String(e));
  }
}

authRoutes.post('/register', async (c) => {
  await rateLimit(c, 'register', 30, 3600);
  const body = await c.req.json().catch(() => ({}));
  const mail = email(body.email);
  const uname = body.username ? username(body.username) : null;
  const name = str(body.name, 'name', { min: 0, max: 100, required: false });
  const password = String(body.password ?? '');
  const referralCode = referralCodeFrom(body);
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

  await tryAttributeReferral(c.env, id, referralCode);

  // Best-effort verification email right after signup (final-phase §3A).
  // Skipped silently when no email service is configured — the banner offers
  // an honest resend; a failure here never fails the registration itself.
  if (c.env.EMAIL_API_KEY && c.env.EMAIL_FROM) {
    try {
      await issueEmailVerification(c, id, mail, emailLang(body.lang));
    } catch (e) {
      console.error('signup verification email failed for user', id, e instanceof Error ? e.message : String(e));
    }
  }

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
  const referralCode = referralCodeFrom(body);

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
    // Referral attribution happens ONLY on account creation — an existing
    // account signing in with a ?ref= link must never be re-attributed.
    await tryAttributeReferral(c.env, id, referralCode);
  }

  // verifyGoogleIdToken only accepts identities whose email_verified claim is
  // true, so a Google sign-in proves ownership of that address: stamp THIS
  // account's own matching address as verified (first stamp wins; existing
  // stamps and other accounts are never touched — no bulk verification).
  await c.env.DB.prepare(
    'UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ? AND email = ?'
  )
    .bind(new Date().toISOString(), row.id, identity.email)
    .run();

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

  // Best-effort security notice to the account owner, in their own locale.
  // Never blocks or fails the response (and silently skips when no email
  // service is configured).
  const notice = renderPasswordChangedEmail(localeToApi(user.locale));
  c.executionCtx.waitUntil(sendEmail(c.env, user.email, notice.subject, notice.html, notice.text));

  return c.json({ success: true });
});

authRoutes.post('/forgot-password', async (c) => {
  await rateLimit(c, 'forgot', 5, 3600);
  const body = await c.req.json().catch(() => ({}));
  const mail = email(body.email);
  const lang = emailLang(body.lang);

  if (!c.env.EMAIL_API_KEY || !c.env.EMAIL_FROM) {
    // Honest unavailability: no email service is configured, so no reset
    // email can be sent. We never generate or reveal passwords instead.
    throw unavailable(
      'Password reset by email is not available yet because no email service is configured. Please contact support.',
      'EMAIL_NOT_CONFIGURED'
    );
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, google_sub, password_hash FROM users WHERE email = ?'
  )
    .bind(mail)
    .first<{ id: string; email: string; google_sub: string | null; password_hash: string | null }>();

  // Always report success so the endpoint cannot be used to enumerate accounts.
  if (user) {
    if (user.google_sub && !user.password_hash) {
      // Google-only account: there is no password to reset, so no token is
      // created. Instead, tell the owner (by email only — the outward HTTP
      // response stays identical) to use Google sign-in.
      const notice = renderGoogleAccountNoticeEmail(lang);
      const sent = await sendEmail(c.env, user.email, notice.subject, notice.html, notice.text);
      if (!sent) console.warn('Google-account notice email was not sent for user', user.id);
    } else {
      const token = randomToken(32);
      const tokenHash = await sha256Hex(token);
      const expires = new Date(Date.now() + 30 * 60_000).toISOString();
      await c.env.DB.prepare(
        'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
      )
        .bind(tokenHash, user.id, expires)
        .run();
      const link = `${trustedOrigin(c)}/auth?reset=${token}`;
      const msg = renderResetPasswordEmail(lang, link);
      const sent = await sendEmail(c.env, user.email, msg.subject, msg.html, msg.text);
      if (!sent) console.error('Password reset email send failed for user', user.id);
    }
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
  // One generic-safe message for every failure; only the machine-readable
  // code differs so the UI can offer "request a new link" where it helps.
  const genericMsg = 'This reset link is invalid or has expired';
  if (!row) throw badRequest(genericMsg, 'BAD_TOKEN');
  if (row.used) throw badRequest(genericMsg, 'TOKEN_USED');
  if (new Date(row.expires_at).getTime() < Date.now()) throw badRequest(genericMsg, 'TOKEN_EXPIRED');

  // Atomic single-use consumption FIRST: the conditional UPDATE lets exactly
  // one of two concurrent correct submissions proceed — the loser gets the
  // same generic error, so the token can never authorize two resets.
  const consumed = await c.env.DB.prepare(
    'UPDATE password_reset_tokens SET used = 1 WHERE token_hash = ? AND used = 0'
  )
    .bind(tokenHash)
    .run();
  if (consumed.meta.changes === 0) throw badRequest(genericMsg, 'TOKEN_USED');

  const hash = await hashPassword(next);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, row.user_id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
  ]);
  await audit(c.env.DB, row.user_id, 'auth.password_reset', row.user_id);

  // Best-effort security notice to the account owner, in their own locale.
  const owner = await c.env.DB.prepare('SELECT email, locale FROM users WHERE id = ?')
    .bind(row.user_id)
    .first<{ email: string; locale: string }>();
  if (owner) {
    const notice = renderPasswordChangedEmail(localeToApi(owner.locale));
    c.executionCtx.waitUntil(sendEmail(c.env, owner.email, notice.subject, notice.html, notice.text));
  }

  return c.json({ success: true });
});

// Email verification (final-phase §3A) ---------------------------------------

const VERIFY_TOKEN_TTL_HOURS = 24;

/**
 * Issues a fresh email-verification token for the user: any previously
 * unused tokens are invalidated in the same batch (single-active-token
 * policy), only the SHA-256 hash is stored, and the message goes through
 * the durable outbox (event key = token hash, so replays cannot double-
 * enqueue). The raw token exists only in the link inside the queued email.
 * With `newEmail` set this becomes an email-CHANGE token: the message goes
 * to the NEW address, and confirming it atomically applies the new address
 * plus its verified stamp (see /verify-email/confirm).
 */
async function issueEmailVerification(
  c: Context<AppContext>,
  userId: string,
  to: string,
  lang: EmailLang,
  newEmail: string | null = null
): Promise<void> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + VERIFY_TOKEN_TTL_HOURS * 3_600_000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE email_verification_tokens SET used = 1 WHERE user_id = ? AND used = 0').bind(userId),
    c.env.DB.prepare(
      'INSERT INTO email_verification_tokens (token_hash, user_id, new_email, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(tokenHash, userId, newEmail, expires),
  ]);
  // The link only OPENS a page; confirmation is a separate explicit POST, so
  // a mail scanner following the link can never consume the token.
  const link = `${trustedOrigin(c)}/?verify_email=${token}`;
  const msg = renderVerifyEmail(lang, link);
  await enqueue(c.env, `email_verify:${tokenHash}`, { kind: 'email', to, subject: msg.subject, html: msg.html, text: msg.text });
  c.executionCtx.waitUntil(processOutbox(c.env, 3));
}

/** Verification status for the signed-in user's OWN account (drives the
 *  banner). Fresh from the DB — the session cache may be stale. */
authRoutes.get('/verify-email/status', requireAuth, async (c) => {
  const user = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT email, email_verified_at FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ email: string; email_verified_at: string | null }>();
  c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    email: row?.email ?? user.email,
    verified: !!row?.email_verified_at,
    emailConfigured: !!(c.env.EMAIL_API_KEY && c.env.EMAIL_FROM),
  });
});

authRoutes.post('/verify-email/send', requireAuth, async (c) => {
  await rateLimit(c, 'verify-email-send', 6, 3600);
  const user = c.get('user')!;
  if (!c.env.EMAIL_API_KEY || !c.env.EMAIL_FROM) {
    // Honest unavailability — no email service means no message can be sent.
    throw unavailable(
      'Email verification is not available yet because no email service is configured.',
      'EMAIL_NOT_CONFIGURED'
    );
  }
  const row = await c.env.DB.prepare('SELECT email, email_verified_at, locale FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ email: string; email_verified_at: string | null; locale: string }>();
  if (!row) throw unauthorized();
  if (row.email_verified_at) return c.json({ success: true, verified: true });
  await issueEmailVerification(c, user.id, row.email, localeToApi(row.locale));
  // Generic wording — the response never says whether the address exists at
  // the provider or whether delivery succeeded.
  return c.json({ success: true, message: 'A verification message has been sent if your email still needs verification.' });
});

authRoutes.post('/verify-email/confirm', async (c) => {
  await rateLimit(c, 'verify-email-confirm', 20, 3600);
  const body = await c.req.json().catch(() => ({}));
  // Token comes in the BODY of an explicit POST only. GET landing pages just
  // render a button — a scanner's GET can never consume a token.
  const token = str(body.token, 'token', { min: 20, max: 128 });
  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    'SELECT token_hash, user_id, new_email, expires_at, used FROM email_verification_tokens WHERE token_hash = ?'
  )
    .bind(tokenHash)
    .first<{ token_hash: string; user_id: string; new_email: string | null; expires_at: string; used: number }>();
  const genericMsg = 'This verification link is invalid or has expired';
  if (!row) throw badRequest(genericMsg, 'BAD_TOKEN');
  if (row.used) throw badRequest(genericMsg, 'TOKEN_USED');
  if (new Date(row.expires_at).getTime() < Date.now()) throw badRequest(genericMsg, 'TOKEN_EXPIRED');

  // Atomic one-use consumption — concurrent confirms cannot both pass.
  const consumed = await c.env.DB.prepare(
    'UPDATE email_verification_tokens SET used = 1 WHERE token_hash = ? AND used = 0'
  )
    .bind(tokenHash)
    .run();
  if (consumed.meta.changes === 0) throw badRequest(genericMsg, 'TOKEN_USED');

  const now = new Date().toISOString();
  if (row.new_email) {
    // Email-change verification (issued by POST /change-email): applying the
    // new address and its verified stamp is one statement, so the account
    // never holds an unverified address with a verified stamp;
    // UNIQUE(users.email) rejects an address taken in the meantime.
    try {
      await c.env.DB.prepare(
        "UPDATE users SET email = ?, email_verified_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
      )
        .bind(row.new_email, now, row.user_id)
        .run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE')) throw conflict('This email is already used by another account');
      throw e;
    }
  } else {
    await c.env.DB.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?')
      .bind(now, row.user_id)
      .run();
  }
  await audit(c.env.DB, row.user_id, 'auth.email_verified', row.user_id, row.new_email ? { email_changed: true } : {});
  return c.json({ success: true, verified: true });
});

/**
 * Change the account email (final-phase §3A) — change-by-verification: the
 * stored address is NOT touched here. A verification token bound to the new
 * address (new_email) is issued and mailed to the NEW inbox; only the
 * explicit POST /verify-email/confirm applies the change, together with its
 * fresh verified stamp. The old (possibly verified) address keeps working
 * until that proof arrives, so a typo can never lock the account and an
 * unproven address never becomes the recovery channel.
 *
 * Reauthentication: accounts with a password must present the current one.
 * Google-only accounts are refused — their address is asserted by Google at
 * each sign-in, and diverging from it here would silently break that link.
 *
 * Enumeration safety: the response is identical whether or not the requested
 * address already belongs to another account (in that case no token is
 * issued and no mail is sent).
 */
authRoutes.post('/change-email', requireAuth, async (c) => {
  await rateLimit(c, 'change-email', 5, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const newMail = email(body.newEmail);
  if (!c.env.EMAIL_API_KEY || !c.env.EMAIL_FROM) {
    throw unavailable(
      'Changing the account email is not available yet because no email service is configured.',
      'EMAIL_NOT_CONFIGURED'
    );
  }

  const row = await c.env.DB.prepare('SELECT email, locale, password_hash, google_sub FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ email: string; locale: string; password_hash: string | null; google_sub: string | null }>();
  if (!row) throw unauthorized();
  if (newMail === row.email) throw badRequest('This is already the email of your account');

  if (row.password_hash) {
    const ok = await verifyPassword(String(body.currentPassword ?? ''), row.password_hash);
    if (!ok) throw unauthorized('Current password is incorrect');
  } else if (row.google_sub) {
    throw badRequest(
      'This account signs in with Google, so its email is managed by Google and cannot be changed here.',
      'GOOGLE_MANAGED_EMAIL'
    );
  }

  const taken = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id <> ?')
    .bind(newMail, user.id)
    .first();
  if (!taken) {
    const lang = emailLang(body.lang ?? localeToApi(row.locale));
    await issueEmailVerification(c, user.id, newMail, lang, newMail);
    // Audit with minimal personal data — the domain locates abuse patterns
    // without copying the full address into the log.
    await audit(c.env.DB, user.id, 'auth.email_change_requested', user.id, {
      new_email_domain: newMail.split('@')[1] ?? '',
    });
  }
  return c.json({
    success: true,
    message: 'If the new address can be used, a verification message has been sent to it. The change applies only after you confirm from that inbox.',
  });
});

// Email helpers --------------------------------------------------------------

/**
 * Origin used for links inside emails. NEVER derived from the request Host
 * header in deployed environments — a spoofed Host must not be able to point
 * reset links at an attacker's origin. The deploy workflows set APP_ORIGIN
 * per environment; the request-origin fallback exists only for local dev,
 * where APP_ORIGIN is empty.
 */
function trustedOrigin(c: Context<AppContext>): string {
  const configured = (c.env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return new URL(c.req.url).origin;
}

/**
 * Sends one email through the Resend API (immediate path for time-critical
 * auth mail — reset links must not sit in a queue). Returns false (never
 * throws) on any failure. Staging safety: when EMAIL_ALLOWED_RECIPIENTS is
 * set (comma-separated), recipients outside the list are skipped — outward
 * API responses never change (no enumeration signal), only a console.warn is
 * logged for the operator. The API key is never logged. Templates come from
 * worker/lib/emailTemplates.ts and always include a plain-text alternative.
 */
async function sendEmail(env: Env, to: string, subject: string, html: string, text: string): Promise<boolean> {
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) return false;

  const allowed = (env.EMAIL_ALLOWED_RECIPIENTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(to.toLowerCase())) {
    console.warn('sendEmail: recipient is not in EMAIL_ALLOWED_RECIPIENTS — send skipped (staging guard)');
    return false;
  }

  try {
    // Resend-compatible API; swap the URL for another provider if needed.
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, html, text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`sendEmail: provider responded ${res.status}: ${detail.slice(0, 500)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('sendEmail: request failed:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

export { loadSessionUser };
