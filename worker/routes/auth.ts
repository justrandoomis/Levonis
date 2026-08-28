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
  const notice = buildPasswordChangedEmail(localeToApi(user.locale));
  c.executionCtx.waitUntil(sendEmail(c.env, user.email, notice.subject, notice.html));

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
      const notice = buildGoogleAccountEmail(lang);
      const sent = await sendEmail(c.env, user.email, notice.subject, notice.html);
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
      const msg = buildResetEmail(lang, link);
      const sent = await sendEmail(c.env, user.email, msg.subject, msg.html);
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

  const hash = await hashPassword(next);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token_hash = ?').bind(tokenHash),
    c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, row.user_id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
  ]);
  await audit(c.env.DB, row.user_id, 'auth.password_reset', row.user_id);

  // Best-effort security notice to the account owner, in their own locale.
  const owner = await c.env.DB.prepare('SELECT email, locale FROM users WHERE id = ?')
    .bind(row.user_id)
    .first<{ email: string; locale: string }>();
  if (owner) {
    const notice = buildPasswordChangedEmail(localeToApi(owner.locale));
    c.executionCtx.waitUntil(sendEmail(c.env, owner.email, notice.subject, notice.html));
  }

  return c.json({ success: true });
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

/** API email languages: Arabic (source), English, Sorani Kurdish (ckb). */
type EmailLang = 'ar' | 'en' | 'ckb';

function emailLang(v: unknown): EmailLang {
  return v === 'en' || v === 'ckb' ? v : 'ar';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const EMAIL_COPY_AR = {
  resetSubject: 'إعادة تعيين كلمة المرور — Levonis',
  resetIntro: 'وصلنا طلب لإعادة تعيين كلمة المرور لحسابك في Levonis.',
  resetCta: 'اختيار كلمة مرور جديدة',
  resetExpiry: 'هذا الرابط صالح لمدة 30 دقيقة ويمكن استخدامه مرة واحدة فقط.',
  resetIgnore: 'إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة بأمان.',
  googleSubject: 'محاولة إعادة تعيين كلمة المرور — Levonis',
  googleBody:
    'وصلنا طلب لإعادة تعيين كلمة المرور لهذا البريد، لكن هذا الحساب يسجّل الدخول عبر Google ولا يملك كلمة مرور. للدخول استخدم زر «المتابعة عبر Google» في صفحة تسجيل الدخول.',
  googleIgnore: 'إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة بأمان.',
  changedSubject: 'تم تغيير كلمة المرور — Levonis',
  changedBody: 'تم تغيير كلمة مرور حسابك في Levonis للتو، وتم تسجيل الخروج من الجلسات الأخرى.',
  changedWarn: 'إذا لم تقم بذلك، أعد تعيين كلمة المرور فورًا وتواصل مع الدعم.',
};

const EMAIL_COPY_EN: typeof EMAIL_COPY_AR = {
  resetSubject: 'Reset your Levonis password',
  resetIntro: 'We received a request to reset your Levonis password.',
  resetCta: 'Choose a new password',
  resetExpiry: 'This link expires in 30 minutes and can be used once.',
  resetIgnore: 'If you did not request this, you can safely ignore this email.',
  googleSubject: 'Password reset attempt — Levonis',
  googleBody:
    'We received a password reset request for this email, but this account signs in with Google and has no password. Use the "Continue with Google" button on the sign-in page instead.',
  googleIgnore: 'If you did not request this, you can safely ignore this email.',
  changedSubject: 'Your Levonis password was changed',
  changedBody: 'The password for your Levonis account was just changed, and your other sessions were signed out.',
  changedWarn: 'If this was not you, reset your password immediately and contact support.',
};

// Sorani (ckb): conservative fallback — reuse the Arabic source copy verbatim
// until reviewed native Sorani text lands. Per the mandate, translation status
// is tracked and NOTHING is machine-translated at runtime.
const EMAIL_COPY_CKB: typeof EMAIL_COPY_AR = { ...EMAIL_COPY_AR };

const EMAIL_COPY: Record<EmailLang, typeof EMAIL_COPY_AR> = {
  ar: EMAIL_COPY_AR,
  en: EMAIL_COPY_EN,
  ckb: EMAIL_COPY_CKB,
};

/**
 * Minimal, self-contained email HTML: inline styles only, no images, no
 * scripts, no third-party assets. Every dynamic value is HTML-escaped by the
 * builders below before it reaches this shell.
 */
function emailShell(lang: EmailLang, inner: string): string {
  const dir = lang === 'en' ? 'ltr' : 'rtl';
  return (
    `<div dir="${dir}" style="margin:0;padding:24px;background-color:#f4f4f2;font-family:Arial,Helvetica,sans-serif;">` +
    `<div style="max-width:480px;margin:0 auto;background-color:#ffffff;border-radius:14px;padding:28px;color:#111111;">` +
    `<p style="margin:0 0 20px 0;font-size:20px;font-weight:bold;letter-spacing:1px;">Levonis</p>` +
    inner +
    `</div></div>`
  );
}

function buildResetEmail(lang: EmailLang, link: string): { subject: string; html: string } {
  const t = EMAIL_COPY[lang];
  const safeLink = escapeHtml(link);
  const inner =
    `<p style="margin:0 0 16px 0;font-size:14px;line-height:1.7;">${escapeHtml(t.resetIntro)}</p>` +
    `<p style="margin:24px 0;text-align:center;">` +
    `<a href="${safeLink}" style="display:inline-block;background-color:#111111;color:#d4af37;text-decoration:none;padding:12px 28px;border-radius:12px;font-size:14px;font-weight:bold;">${escapeHtml(t.resetCta)}</a>` +
    `</p>` +
    `<p style="margin:0 0 8px 0;font-size:12px;color:#555555;line-height:1.7;">${escapeHtml(t.resetExpiry)}</p>` +
    `<p style="margin:0 0 16px 0;font-size:12px;color:#555555;line-height:1.7;">${escapeHtml(t.resetIgnore)}</p>` +
    `<p style="margin:0;font-size:11px;color:#888888;word-break:break-all;" dir="ltr">${safeLink}</p>`;
  return { subject: t.resetSubject, html: emailShell(lang, inner) };
}

function buildGoogleAccountEmail(lang: EmailLang): { subject: string; html: string } {
  const t = EMAIL_COPY[lang];
  const inner =
    `<p style="margin:0 0 16px 0;font-size:14px;line-height:1.7;">${escapeHtml(t.googleBody)}</p>` +
    `<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;">${escapeHtml(t.googleIgnore)}</p>`;
  return { subject: t.googleSubject, html: emailShell(lang, inner) };
}

function buildPasswordChangedEmail(lang: EmailLang): { subject: string; html: string } {
  const t = EMAIL_COPY[lang];
  const inner =
    `<p style="margin:0 0 16px 0;font-size:14px;line-height:1.7;">${escapeHtml(t.changedBody)}</p>` +
    `<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;">${escapeHtml(t.changedWarn)}</p>`;
  return { subject: t.changedSubject, html: emailShell(lang, inner) };
}

/**
 * Sends one email through the Resend API. Returns false (never throws) on
 * any failure. Staging safety: when EMAIL_ALLOWED_RECIPIENTS is set
 * (comma-separated), recipients outside the list are skipped — outward API
 * responses never change (no enumeration signal), only a console.warn is
 * logged for the operator. The API key is never logged.
 */
async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
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
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, html }),
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
