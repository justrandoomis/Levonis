import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, Env, SessionUser } from '../lib/types';
import { publicUser, localeToApi } from '../lib/types';
import {
  HttpError,
  badRequest,
  unauthorized,
  notFound,
  conflict,
  unavailable,
  requireAuth,
  str,
  email,
  username,
  oneOf,
} from '../lib/http';
import { newId, hashPassword, verifyPassword, isLegacyHash, randomToken, sha256Hex } from '../lib/crypto';
import { trustedOrigin } from '../lib/appOrigin';
import { createSession, destroySession, destroyAllSessions, loadSessionUser } from '../lib/session';
import { verifyGoogleIdToken } from '../lib/google';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { normalizePhone, maskPhone } from '../lib/phone';
import {
  getBotUsername,
  sendToChat,
  toAsciiDigits,
  publicAuthChallengeState,
  cooldownRemaining,
  resolveAuthLinkability,
  maybeSendAuthChallengeOtp,
  sendChallengeOtp,
  verifyChallengeOtp,
  TG_AUTH_PURPOSES,
  OTP_RESEND_COOLDOWN_SECONDS,
  type TgAuthPurpose,
  type AuthChallengeRow,
} from '../lib/telegram';
import { resolveSupportRef, type SupportRef } from '../lib/supportCode';
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

/**
 * A syntactically valid but unmatchable PBKDF2 record (all-zero salt and
 * digest, same iteration count as hashPassword). Used ONLY to spend the same
 * verification time on logins for identifiers that have no password, so the
 * uniform login error is uniform in latency too. It is not a credential and
 * can never authenticate anyone: the derived digest of any password is
 * compared against 32 zero bytes.
 */
export const DUMMY_PASSWORD_HASH = `pbkdf2$100000$${'A'.repeat(22)}$${'A'.repeat(43)}`;

function checkPassword(pw: string): void {
  if (pw.length < PASSWORD_MIN) throw badRequest(`Password must be at least ${PASSWORD_MIN} characters`);
  if (pw.length > PASSWORD_MAX) throw badRequest('Password is too long');
}

async function getFullUser(db: D1Database, id: string): Promise<SessionUser | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<SessionUser>();
}

/**
 * Optional referral ref explicitly carried by a signup body — free-form,
 * capped, never fatal (§2.6: an empty or unknown code never blocks signup).
 * `referralCode` is the primary field name; `ref` is accepted as an alias so
 * a client that forwards the raw `?ref=` query parameter still attributes.
 * Pure — unit-tested in tests/authPhone.test.ts.
 *
 * NOTE (§3.2): only a *code/username* is ever read from the client. An
 * arbitrary `referrer_user_id` in the body is deliberately ignored
 * everywhere in this file — the owner is always resolved server-side.
 */
export function referralCodeFrom(body: Record<string, unknown>): string {
  for (const key of ['referralCode', 'ref'] as const) {
    const v = body[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 64);
  }
  return '';
}

/**
 * Ordered lookup candidates for a referral ref (integrated mandate §3.1):
 * usernames are the public referral handle AND legacy codes stay working as
 * aliases. Precedence is deterministic and matches the frozen supportCode
 * contract (username branch first): the lowercase form is tried before the
 * uppercase form, because usernames are stored lowercase and legacy
 * referral codes uppercase — so a username always resolves to its CURRENT
 * holder and can never be shadowed by a same-spelling legacy code.
 * Pure — unit-tested in tests/authPhone.test.ts.
 */
export function referrerLookupCandidates(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const ref = raw.trim();
  if (!ref || ref.length > 64) return [];
  const lower = ref.toLowerCase();
  const upper = ref.toUpperCase();
  return lower === upper ? [lower] : [lower, upper];
}

/**
 * Resolve a public referral ref (username of the CURRENT holder, or a
 * legacy referral code) to its owner — always server-side; an arbitrary
 * client-sent referrer_user_id is never accepted anywhere (§3.2).
 *
 * Username changes, honestly (§3.1): past attributions are rows keyed to
 * stable user ids (referral_attributions.referrer_id), so renaming — or a
 * later person taking the freed name — can never move an already-earned
 * referral to somebody else. This lookup therefore only affects NEW
 * signups, and for those a username always maps to whoever holds it NOW.
 * The consequence to state plainly rather than hide: a link with an OLD
 * username stops crediting its original owner once they rename (it credits
 * the new holder if the name was taken, otherwise nothing). The identifier
 * that never moves is the legacy referral code (referral_codes.code, one
 * per user, never reassigned) — it stays a working alias for exactly that
 * reason. A release-cooldown on freed usernames is an owner policy
 * decision, not something this resolver may invent.
 */
async function resolveReferrer(env: Env, raw: string): Promise<SupportRef | null> {
  for (const candidate of referrerLookupCandidates(raw)) {
    const hit = await resolveSupportRef(env, candidate);
    if (hit) return hit;
  }
  return null;
}

/**
 * Best-effort referral attribution after a successful account CREATION
 * (§3.2). Binds exactly ONCE at account creation — UNIQUE(referred_id,
 * campaign) makes the first attribution final; self-referral never binds.
 * Accepts ref-by-username and legacy codes (see resolveReferrer). Must
 * never fail or slow down the signup itself, and an unknown ref simply
 * leaves the account unattributed (signup still succeeds — §2.6).
 */
async function tryAttributeReferral(env: Env, newUserId: string, ref: string): Promise<void> {
  if (!ref) return;
  try {
    const resolved = await resolveReferrer(env, ref);
    if (!resolved) return;
    await bindReferral(env, newUserId, resolved.userId);
  } catch (e) {
    console.error('referral attribution failed for user', newUserId, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Write the attribution rows for an ALREADY server-resolved referrer id
 * (never a client-supplied one — §3.2). Idempotent by construction:
 * UNIQUE(referred_id, campaign) makes the first binding final, so a retry,
 * a replayed request or a second signup attempt can never rebind an account
 * to a different referrer. Self-referral never binds.
 */
async function bindReferral(env: Env, newUserId: string, referrerId: string): Promise<void> {
  if (!referrerId || referrerId === newUserId) return; // self-referral never binds
  for (const campaign of ['printer', 'pro_sub'] as const) {
    try {
      await env.DB.prepare(
        'INSERT INTO referral_attributions (id, referrer_id, referred_id, campaign) VALUES (?, ?, ?, ?)'
      )
        .bind(newId('rat'), referrerId, newUserId, campaign)
        .run();
    } catch (e) {
      // UNIQUE(referred_id, campaign): already bound once — never rebind.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('UNIQUE')) throw e;
    }
  }
}

/**
 * Which referral source wins for a signup that travelled through an
 * external app (§3.2). The code the user typed/confirmed in THIS submission
 * wins over the one captured when the flow started — and when an explicit
 * code is present it is used *alone*: silently falling back to the stored
 * one would swap a code the user can see for one they cannot. With no
 * explicit code, the server-resolved referrer captured at flow start (bound
 * to that challenge, expiry-limited with it) is used. Pure — unit-tested.
 */
export function pickSignupReferralSource(
  explicitRef: string,
  storedReferrerId: string | null
): { kind: 'explicit'; ref: string } | { kind: 'stored'; referrerId: string } | { kind: 'none' } {
  const ref = typeof explicitRef === 'string' ? explicitRef.trim() : '';
  if (ref) return { kind: 'explicit', ref };
  if (typeof storedReferrerId === 'string' && storedReferrerId) {
    return { kind: 'stored', referrerId: storedReferrerId };
  }
  return { kind: 'none' };
}

authRoutes.post('/register', async (c) => {
  await rateLimit(c, 'register', 30, 3600);
  const body = await c.req.json().catch(() => ({}));
  // §2.3: a phone is an identity key whose ownership must be PROVEN before
  // the password is accepted — this email-registration endpoint has no
  // ownership proof, so it never stores a phone. Rejecting (not silently
  // dropping) keeps the client honest about which flow it is in: phone
  // signup goes through /telegram/start → verified contact → OTP →
  // /telegram/complete (which accepts the password there).
  if (typeof body.phone === 'string' && body.phone.trim() !== '') {
    throw badRequest(
      'إنشاء حساب برقم الهاتف يتطلب توثيق ملكية الرقم أولًا — استخدم مسار التسجيل بالهاتف عبر تيليغرام. / ' +
        'Registering with a phone number requires proving ownership first — use the phone sign-up flow (Telegram verification).',
      'PHONE_REQUIRES_VERIFICATION'
    );
  }
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

/**
 * Classify one login identifier (§2.3): the lowercased form for
 * email/username lookup, plus the normalized E.164 phone when (and only
 * when) the input is a valid phone per worker/lib/phone.ts — the single
 * source of phone validity on the server; there is no length-only
 * acceptance here. Arabic-Indic digits are mapped first so a phone typed
 * as ٠٧٧٠١٢٣٤٥٦٧ matches its account. Pure — unit-tested.
 */
export function classifyLoginIdentifier(raw: string): { identifier: string; phone: string | null } {
  const trimmed = raw.trim();
  return { identifier: trimmed.toLowerCase(), phone: normalizePhone(toAsciiDigits(trimmed)) };
}

authRoutes.post('/login', async (c) => {
  await rateLimit(c, 'login', 20, 900);
  const body = await c.req.json().catch(() => ({}));
  // One identifier field accepts email OR username OR phone (§2.3).
  // `identifier` is the preferred name; `email` stays accepted so every
  // existing client keeps working unchanged.
  const raw = str(body.identifier ?? body.email, 'email, username or phone', { min: 3, max: 320 });
  const { identifier, phone } = classifyLoginIdentifier(raw);
  const password = String(body.password ?? '');
  if (!password) throw badRequest('Password is required');

  // Deterministic resolution order: a valid phone form is looked up as a
  // phone FIRST — users.phone_e164, then a live verified Telegram link
  // (covers accounts that linked their phone before migration 0013's
  // column existed) — so a digits-only username can never shadow another
  // person's phone. Anything else resolves as email/username, unchanged.
  let row: (SessionUser & { password_hash: string | null }) | null = null;
  if (phone) {
    row = await c.env.DB.prepare('SELECT * FROM users WHERE phone_e164 = ?')
      .bind(phone)
      .first<SessionUser & { password_hash: string | null }>();
    if (!row) {
      const link = await c.env.DB.prepare(
        'SELECT user_id FROM telegram_links WHERE phone_e164 = ? AND revoked_at IS NULL ORDER BY verified_at DESC LIMIT 1'
      )
        .bind(phone)
        .first<{ user_id: string }>();
      if (link) {
        row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
          .bind(link.user_id)
          .first<SessionUser & { password_hash: string | null }>();
      }
    }
  }
  if (!row) {
    row = await c.env.DB.prepare('SELECT * FROM users WHERE email = ? OR username = ?')
      .bind(identifier, identifier)
      .first<SessionUser & { password_hash: string | null }>();
  }

  // ONE uniform failure for every identifier kind and every cause — unknown
  // identifier, wrong password, and provider-only account (no password at
  // all) are indistinguishable from outside, so this endpoint cannot be used
  // to discover which addresses/usernames/phones exist or which sign in with
  // Google/Telegram. The Google/Telegram hint is part of the SAME message for
  // everyone, so it stays useful without becoming a signal.
  const fail = () =>
    unauthorized(
      'البريد أو اسم المستخدم أو الهاتف أو كلمة المرور غير صحيحة. إن أنشأت حسابك عبر Google أو تيليغرام فاستخدم زره. / ' +
        'Incorrect email/username/phone or password. If you created your account with Google or Telegram, use that button.'
    );
  // Uniform in TIME as well as in wording: when there is no account, or the
  // account is provider-only, the same PBKDF2 work is still performed
  // against a fixed dummy hash, so response latency does not reveal which
  // identifiers exist. (Cost is bounded by the login rate limit above.)
  if (!row || !row.password_hash) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    throw fail();
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
      .first<SessionUser & { google_sub: string | null; email_verified_at: string | null }>();
    if (byEmail) {
      if (byEmail.google_sub && byEmail.google_sub !== identity.sub) {
        throw conflict('This email is already linked to a different Google account');
      }
      // §2.3: NO silent merge into an account whose ownership of this address
      // was never proven. Google proves that THIS person owns the address —
      // it does not prove that the existing local account (created by anyone
      // who could type that address, and holding a password only they know)
      // belongs to the same person. Adopting it would hand the account, its
      // orders and its wallet to whoever registered the address first — or
      // the reverse. So linking requires the existing account to have proven
      // the address itself (email_verified_at), and the refusal names the
      // exact recovery path instead of merging.
      if (!byEmail.email_verified_at) {
        throw new HttpError(
          409,
          'يوجد حساب بهذا البريد لم يُوثَّق بريده بعد، ولن نربطه بحساب Google تلقائيًا. سجّل الدخول بكلمة المرور ووثّق بريدك، ثم سيُربط Google تلقائيًا. / ' +
            'An account with this email exists but its address was never verified, so it will not be linked to Google automatically. Sign in with your password and verify your email — Google then links automatically.',
          'EMAIL_NOT_VERIFIED'
        );
      }
      // Conditional link: only claims an unclaimed google_sub, so two
      // concurrent sign-ins can never overwrite an existing link.
      const linked = await c.env.DB.prepare(
        'UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL'
      )
        .bind(identity.sub, byEmail.id)
        .run();
      if (linked.meta.changes === 0) {
        // Someone linked a Google identity to this account in between; only
        // the same sub may proceed (a different one is the conflict above).
        const fresh = await c.env.DB.prepare('SELECT google_sub FROM users WHERE id = ?')
          .bind(byEmail.id)
          .first<{ google_sub: string | null }>();
        if (fresh?.google_sub !== identity.sub) {
          throw conflict('This email is already linked to a different Google account');
        }
      }
      await audit(c.env.DB, byEmail.id, 'auth.google_linked', byEmail.id, {});
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

/**
 * Attach a Google identity to the account the caller is ALREADY signed into
 * (§2.5). This is the safe counterpart to the refusal in POST /google: an
 * unverified email is not proof that the local account and the Google
 * identity belong to the same person, but holding the account's session AND
 * its current password AND a valid Google credential is. Nothing is merged
 * across two accounts here — one row gains a second sign-in method.
 *
 * Guards: the Google sub must not already belong to another account, the
 * account must not already carry a different sub, and the linking UPDATE is
 * conditional so concurrent calls cannot overwrite an existing link. The
 * email is stamped verified only when it is the SAME address Google proved.
 */
authRoutes.post('/google/link', requireAuth, async (c) => {
  await rateLimit(c, 'google-link', 10, 900);
  const me = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const credential = str(body.credential, 'credential', { min: 20, max: 4096 });

  const row = await c.env.DB.prepare('SELECT email, password_hash, google_sub FROM users WHERE id = ?')
    .bind(me.id)
    .first<{ email: string; password_hash: string | null; google_sub: string | null }>();
  if (!row) throw unauthorized();
  // Re-authentication for a sensitive credential change, matching the policy
  // /change-password already applies: prove the current password when the
  // account has one. Accounts without a password (Telegram-only) rely on the
  // session, and can set a password first from the settings page.
  if (row.password_hash) {
    const ok = await verifyPassword(String(body.currentPassword ?? ''), row.password_hash);
    if (!ok) throw unauthorized('Current password is incorrect');
  }

  let identity;
  try {
    identity = await verifyGoogleIdToken(credential, c.env.GOOGLE_CLIENT_ID);
  } catch (e) {
    if (!c.env.GOOGLE_CLIENT_ID) {
      throw unavailable('Google Sign-In is not configured yet (GOOGLE_CLIENT_ID missing)', 'GOOGLE_NOT_CONFIGURED');
    }
    throw unauthorized(e instanceof Error ? e.message : 'Google sign-in failed');
  }

  if (row.google_sub && row.google_sub !== identity.sub) {
    throw conflict('This account is already linked to a different Google account');
  }
  const linked = await c.env.DB.prepare(
    'UPDATE users SET google_sub = ?1 WHERE id = ?2 AND (google_sub IS NULL OR google_sub = ?1)'
  )
    .bind(identity.sub, me.id)
    .run()
    .catch((e: unknown) => {
      // UNIQUE(google_sub): that identity already signs into another account.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE')) {
        throw conflict('This Google account is already linked to another LEVONIS account');
      }
      throw e;
    });
  if (linked.meta.changes === 0) throw conflict('This account is already linked to a different Google account');

  // Same-address proof only — never stamp a different address as verified.
  await c.env.DB.prepare(
    'UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ? AND email = ?'
  )
    .bind(new Date().toISOString(), me.id, identity.email)
    .run();
  await audit(c.env.DB, me.id, 'auth.google_linked', me.id, { same_email: identity.email === row.email });

  const user = await getFullUser(c.env.DB, me.id);
  return c.json({ success: true, user: publicUser(user!), same_email: identity.email === row.email });
});

/**
 * Public referrer preview for the signup referral bar (§2.6/§3.1):
 * GET /api/auth/referrer-info?ref=<username-or-legacy-code> →
 * { username, display_name } or 404. Intentionally public and anonymous —
 * a visitor opening /auth?ref=<username> must see WHO invited them before
 * creating an account — but it reveals nothing beyond what the referral
 * link itself already displays (the handle) plus the display name, and it
 * is rate-limited per IP. Resolution maps a username to its CURRENT
 * holder; legacy codes keep working as aliases (same precedence as
 * attribution, so the preview can never disagree with the signup binding).
 */
authRoutes.get('/referrer-info', async (c) => {
  await rateLimit(c, 'referrer-info', 60, 300);
  const ref = str(c.req.query('ref'), 'ref', { min: 1, max: 64 });
  const resolved = await resolveReferrer(c.env, ref);
  c.header('Cache-Control', 'no-store');
  if (!resolved) throw notFound('No referrer matches this code');
  return c.json({
    success: true,
    username: resolved.username || null,
    display_name: resolved.displayName,
  });
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

// Telegram-verified phone + OTP registration & sign-in (§4) ------------------
//
// Builds ON the existing linking machinery (link_challenges + the
// purpose-agnostic webhook contact verification + otp_challenges) — no
// parallel webhook or account system. The anonymous browser is bound to its
// challenge by a continuation token whose SHA-256 digest alone is stored
// (link_challenges.continuation_hash); the deep-link nonce and the OTP are
// separate secrets with separate lifetimes. Flow:
//   POST /telegram/start   → challenge + deep link + continuation token
//   (Telegram: /start → share contact → webhook marks phone_verified and
//    dispatches the OTP through the one-shot otp_sent_at guard)
//   GET  /telegram/status  → honest state for the polling browser; also
//                            triggers the guarded OTP dispatch if the
//                            webhook-side send didn't happen yet
//   POST /telegram/resend  → re-send the code (60s cooldown)
//   POST /telegram/complete→ verify + atomically consume code & challenge,
//                            then create the session like password login
// Enumeration safety: /start responds identically whether or not an account
// exists for the phone; ownership-specific hints (use login / use signup /
// contact support) appear only AFTER the person proved ownership of the
// phone via their own Telegram contact.

const TG_AUTH_TTL_MINUTES = 15;

const GENERIC_AUTH_FAIL_MSG =
  'تعذر إكمال العملية عبر تيليغرام. تحقق من الرقم وابدأ من جديد. / ' +
  'The Telegram verification could not be completed. Check the number and start again.';

const TG_SIGNUP_DONE_MSG =
  'LEVONIS ✅\n' +
  'تم إنشاء حسابك في LEVONIS بنجاح بهذا الرقم الموثّق.\n' +
  'Your LEVONIS account has been created with this verified number.\n' +
  'هەژماری LEVONISەکەت بەم ژمارە پشتڕاستکراوە دروستکرا.';

interface TgAuthChallengeDbRow extends AuthChallengeRow {
  purpose: TgAuthPurpose;
  /** Server-resolved referrer captured at /telegram/start (§3.2) — never a
   *  client-supplied id. NULL when the flow started without a ref. */
  signup_referrer_id: string | null;
}

async function findAuthChallenge(db: D1Database, continuationToken: string): Promise<TgAuthChallengeDbRow | null> {
  const hash = await sha256Hex(continuationToken);
  return db
    .prepare(
      `SELECT id, purpose, phone_entered, state, telegram_user_id, chat_id, otp_sent_at, expires_at, consumed_at,
              signup_referrer_id
         FROM link_challenges
        WHERE continuation_hash = ? AND purpose IN ('signup','login')`
    )
    .bind(hash)
    .first<TgAuthChallengeDbRow>();
}

authRoutes.post('/telegram/start', async (c) => {
  await rateLimit(c, 'tg-auth-start', 6, 600);
  const body = await c.req.json().catch(() => ({}));
  const purpose = oneOf(body.purpose, 'purpose', TG_AUTH_PURPOSES);
  const raw = str(body.phone, 'phone', { min: 7, max: 32 });
  // Arabic-Indic digits are accepted; mapping happens here because
  // lib/phone.ts belongs to another workstream this round (see toAsciiDigits).
  const phone = normalizePhone(toAsciiDigits(raw));
  if (!phone) {
    throw badRequest(
      'رقم الهاتف غير صالح — أدخل رقم موبايل عراقي مثل 07XXXXXXXXX / Invalid phone number — enter an Iraqi mobile number like 07XXXXXXXXX',
      'INVALID_PHONE'
    );
  }

  if (!c.env.TELEGRAM_BOT_TOKEN) {
    // Honest unavailability — never a dead-end fake flow.
    throw unavailable('Telegram sign-in is not configured yet (TELEGRAM_BOT_TOKEN is unset)');
  }
  const botUsername = await getBotUsername(c.env);
  if (!botUsername) {
    throw unavailable('Telegram is unreachable right now — please try again later', 'TELEGRAM_UNAVAILABLE');
  }

  // Two independent secrets: the deep-link nonce (goes to Telegram) and the
  // continuation token (stays in THIS browser). Only their SHA-256 digests
  // are stored, so a DB leak exposes neither.
  const nonce = randomToken(32);
  const challengeId = await sha256Hex(nonce);
  const continuationToken = randomToken(32);
  const continuationHash = await sha256Hex(continuationToken);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TG_AUTH_TTL_MINUTES * 60_000).toISOString();

  // §2.6/§3.2: the signup referral must survive the trip through the
  // Telegram app (the browser may be reloaded or restored meanwhile). The
  // ref is RESOLVED here and only the resulting stable user id is stored on
  // the challenge — a client can never inject a referrer id, and the state
  // expires with the challenge (minutes). An unknown ref simply resolves to
  // NULL: it never blocks the sign-up (§2.6). The explicit code sent at
  // /telegram/complete still wins over this captured value.
  let signupReferrerId: string | null = null;
  if (purpose === 'signup') {
    const ref = referralCodeFrom(body);
    if (ref) {
      try {
        signupReferrerId = (await resolveReferrer(c.env, ref))?.userId ?? null;
      } catch (e) {
        console.error('referral capture failed at telegram/start:', e instanceof Error ? e.message : String(e));
      }
    }
  }

  // NOTE: deliberately NO account lookup here — the response below is
  // byte-identical whether or not the phone belongs to an account (no
  // enumeration). A login for an unlinked phone, or a signup for a linked
  // one, surfaces only AFTER Telegram-side phone-ownership proof.
  await c.env.DB.batch([
    // One active auth challenge per phone: retire earlier signup/login
    // attempts so a stale deep link cannot race a newer one. The
    // authenticated 'link' flow is untouched.
    c.env.DB.prepare(
      `UPDATE link_challenges SET state = 'expired', consumed_at = ?
        WHERE purpose IN ('signup','login') AND phone_entered = ? AND consumed_at IS NULL`
    ).bind(now, phone),
    c.env.DB.prepare(
      `INSERT INTO link_challenges (id, purpose, user_id, session_ref, phone_entered, state, continuation_hash, expires_at, signup_referrer_id)
       VALUES (?, ?, NULL, '', ?, 'pending', ?, ?, ?)`
    ).bind(challengeId, purpose, phone, continuationHash, expiresAt, signupReferrerId),
  ]);

  return c.json({
    success: true,
    deep_link: `https://t.me/${botUsername}?start=${nonce}`,
    bot_username: botUsername,
    continuation_token: continuationToken,
    expires_at: expiresAt,
    phone_masked: maskPhone(phone),
    purpose,
    // Honest echo for the referral bar: whether the ref sent with this
    // request actually resolved to a referrer and is now held for the
    // account this flow will create. Says nothing about the phone, so the
    // no-enumeration property of this response is unaffected.
    referral_captured: signupReferrerId !== null,
  });
});

authRoutes.get('/telegram/status', async (c) => {
  // Anonymous polling keyed by IP; generous because Iraqi carrier NAT can
  // put many customers behind one address and polls are cheap reads.
  await rateLimit(c, 'tg-auth-status', 240, 60);
  const token = str(c.req.query('token'), 'token', { min: 20, max: 128 });
  const ch = await findAuthChallenge(c.env.DB, token);
  if (!ch) throw badRequest('This request is no longer valid — start again', 'NO_CHALLENGE');
  c.header('Cache-Control', 'no-store');

  let state: string = publicAuthChallengeState(ch, Date.now());
  let hint: string | null = null;
  let resendIn: number | null = null;

  if (state === 'phone_verified') {
    // Phone ownership proven — dispatch the OTP exactly once (the webhook
    // may already have; the otp_sent_at claim makes the race harmless).
    const r = await maybeSendAuthChallengeOtp(c.env, ch);
    if (r.status === 'sent') {
      state = 'otp_sent';
      resendIn = OTP_RESEND_COOLDOWN_SECONDS;
    } else if (r.status === 'already_sent') {
      state = 'otp_sent';
      resendIn = cooldownRemaining(ch.otp_sent_at, Date.now());
    } else if (r.status === 'not_linkable') {
      // Post-proof only: guides an existing owner to login, a new phone to
      // signup, or a recycled/transferred number to support.
      state = 'not_linkable';
      hint = r.hint;
    } else if (r.status === 'send_failed') {
      state = 'send_failed';
    } else {
      state = 'expired';
    }
  } else if (state === 'otp_sent') {
    resendIn = cooldownRemaining(ch.otp_sent_at, Date.now());
  }

  return c.json({
    success: true,
    state,
    purpose: ch.purpose,
    phone_masked: maskPhone(ch.phone_entered),
    expires_at: ch.expires_at,
    resend_in: resendIn,
    hint,
  });
});

authRoutes.post('/telegram/resend', async (c) => {
  await rateLimit(c, 'tg-auth-resend', 6, 600);
  const body = await c.req.json().catch(() => ({}));
  const token = str(body.token, 'token', { min: 20, max: 128 });
  const ch = await findAuthChallenge(c.env.DB, token);
  if (!ch) throw badRequest('This request is no longer valid — start again', 'NO_CHALLENGE');
  if (ch.consumed_at || new Date(ch.expires_at).getTime() <= Date.now()) {
    throw badRequest('This request has expired — start again', 'CHALLENGE_EXPIRED');
  }
  if (ch.state !== 'phone_verified' || ch.chat_id === null) {
    throw badRequest('Phone ownership is not verified yet — finish the steps in Telegram first', 'NOT_VERIFIED');
  }

  const linkability = await resolveAuthLinkability(c.env, ch.purpose, ch.phone_entered, ch.telegram_user_id);
  if (!linkability.linkable) throw badRequest(GENERIC_AUTH_FAIL_MSG, 'AUTH_FAILED');

  if (!ch.otp_sent_at) {
    // First dispatch goes through the one-shot guard.
    const first = await maybeSendAuthChallengeOtp(c.env, ch);
    if (first.status === 'sent' || first.status === 'already_sent') {
      return c.json({ success: true, resend_in: OTP_RESEND_COOLDOWN_SECONDS });
    }
    throw unavailable('Could not deliver the code via Telegram — please try again', 'TELEGRAM_UNAVAILABLE');
  }

  const r = await sendChallengeOtp(c.env, ch.id, ch.purpose, ch.chat_id);
  if (!r.ok) {
    if (r.error === 'COOLDOWN') {
      throw new HttpError(
        429,
        `الرجاء الانتظار ${r.retry_after_seconds ?? OTP_RESEND_COOLDOWN_SECONDS} ثانية قبل إعادة الإرسال / Please wait ${r.retry_after_seconds ?? OTP_RESEND_COOLDOWN_SECONDS}s before resending`,
        'OTP_COOLDOWN'
      );
    }
    if (r.error === 'NOT_CONFIGURED') throw unavailable('Telegram sign-in is not configured yet');
    throw unavailable('Could not deliver the code via Telegram — please try again', 'TELEGRAM_UNAVAILABLE');
  }
  // Move the cooldown anchor forward for status polls.
  await c.env.DB.prepare("UPDATE link_challenges SET otp_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(ch.id)
    .run();
  return c.json({ success: true, resend_in: OTP_RESEND_COOLDOWN_SECONDS });
});

authRoutes.post('/telegram/complete', async (c) => {
  await rateLimit(c, 'tg-auth-complete', 10, 300);
  const body = await c.req.json().catch(() => ({}));
  const token = str(body.token, 'token', { min: 20, max: 128 });
  const code = str(body.code, 'code', { min: 1, max: 12 });

  const ch = await findAuthChallenge(c.env.DB, token);
  if (!ch) throw badRequest('This request is no longer valid — start again', 'NO_CHALLENGE');
  if (ch.consumed_at) throw badRequest('This request is no longer valid — start again', 'CHALLENGE_CONSUMED');
  if (new Date(ch.expires_at).getTime() <= Date.now()) {
    throw badRequest('This request has expired — start again', 'CHALLENGE_EXPIRED');
  }
  if (ch.state !== 'phone_verified' || ch.telegram_user_id === null || ch.chat_id === null) {
    throw badRequest('Phone ownership is not verified yet — finish the steps in Telegram first', 'NOT_VERIFIED');
  }
  if (!ch.otp_sent_at) throw badRequest('No active code — request a new one', 'OTP_NOT_FOUND');

  // Signup inputs are validated BEFORE the OTP is consumed so a taken
  // username or an invalid password doesn't burn a correct code.
  let uname: string | null = null;
  let name = '';
  let rawPassword: string | null = null;
  let realEmail: string | null = null;
  if (ch.purpose === 'signup') {
    uname = body.username ? username(body.username) : null;
    name = str(body.name, 'name', { min: 0, max: 100, required: false });
    // §2.3: a phone account is NOT a fabricated email address. When the
    // person also gives a real address it is stored as-is and stays
    // UNVERIFIED (email_verified_at NULL) until they confirm it from that
    // inbox — no placeholder is invented for them. Without one, the account
    // keeps the honest non-routable placeholder (decision row 27).
    if (typeof body.email === 'string' && body.email.trim() !== '') {
      realEmail = email(body.email);
      if (realEmail.endsWith('@telegram.local')) {
        // Reserved, non-routable placeholder domain — never accepted as a
        // real address, so a placeholder can never be claimed by hand.
        throw badRequest('Invalid email address');
      }
      const mailTaken = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(realEmail).first();
      if (mailTaken) throw conflict('An account with this email already exists');
    }
    // §2.1/§2.3: phone + password accounts. The password is OPTIONAL here —
    // the pure Telegram-OTP path is never forced to set one — and it is
    // only ever accepted AFTER phone ownership was proven (the
    // state = 'phone_verified' guard above) and the OTP below confirms
    // this same verified session.
    if (body.password !== undefined && body.password !== null && body.password !== '') {
      rawPassword = String(body.password);
      checkPassword(rawPassword);
    }
    if (uname) {
      const taken = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(uname).first();
      if (taken) throw conflict('This username is taken');
    }
  }

  // Atomic single-use OTP consumption (exactly one concurrent submit wins);
  // keyed by challenge + purpose, so a code issued for login can never
  // complete a signup and vice versa.
  const otp = await verifyChallengeOtp(c.env, ch.id, ch.purpose, code);
  if (!otp.ok) {
    switch (otp.reason) {
      case 'no_challenge':
        throw badRequest('No active code — request a new one', 'OTP_NOT_FOUND');
      case 'expired':
        throw badRequest('The code has expired — request a new one', 'OTP_EXPIRED');
      case 'too_many_attempts':
        throw badRequest('Too many wrong attempts — request a new code', 'OTP_LOCKED');
      default:
        throw badRequest('Incorrect code', 'OTP_WRONG');
    }
  }

  const now = new Date().toISOString();

  if (ch.purpose === 'login') {
    // The account is resolved through the VERIFIED telegram link: same phone
    // AND same Telegram account. A recycled number never signs into the
    // previous owner's account.
    const linkability = await resolveAuthLinkability(c.env, 'login', ch.phone_entered, ch.telegram_user_id);
    if (!linkability.linkable || !linkability.userId) throw badRequest(GENERIC_AUTH_FAIL_MSG, 'AUTH_FAILED');

    const consumed = await c.env.DB.prepare(
      `UPDATE link_challenges SET consumed_at = ?, state = 'linked'
        WHERE id = ? AND consumed_at IS NULL AND state = 'phone_verified'`
    )
      .bind(now, ch.id)
      .run();
    if (!consumed.meta || consumed.meta.changes === 0) {
      throw badRequest('This request is no longer valid — start again', 'CHALLENGE_CONSUMED');
    }

    // Best-effort self-heal (§2.3 / migration 0013): this phone was just
    // proven owned by this account's own Telegram, so stamp
    // users.phone_e164 when the account has none and the phone is free.
    // The guard means it can never steal a phone already held by another
    // account; a lost race on the UNIQUE index is swallowed (the login
    // itself must never fail because of this stamp).
    try {
      await c.env.DB.prepare(
        `UPDATE users SET phone_e164 = ?1
          WHERE id = ?2 AND phone_e164 IS NULL
            AND NOT EXISTS (SELECT 1 FROM users WHERE phone_e164 = ?1)`
      )
        .bind(ch.phone_entered, linkability.userId)
        .run();
    } catch (e) {
      console.error('phone_e164 self-heal failed for user', linkability.userId, e instanceof Error ? e.message : String(e));
    }

    await audit(c.env.DB, linkability.userId, 'auth.telegram_login', `user:${linkability.userId}`, {
      phone_masked: maskPhone(ch.phone_entered),
    });
    await createSession(c, linkability.userId);
    const user = await getFullUser(c.env.DB, linkability.userId);
    if (!user) throw badRequest(GENERIC_AUTH_FAIL_MSG, 'AUTH_FAILED');
    return c.json({ success: true, user: publicUser(user), created: false });
  }

  // signup — the account is created HERE, first time, in ONE transaction
  // with the challenge consumption. Guards inside the batch make it
  // race-proof: if the phone or Telegram account got linked meanwhile, or a
  // concurrent complete already consumed the challenge, nothing is created
  // and nothing is half-written. Never an auto-merge into an existing
  // account by phone alone.
  const id = newId('usr');
  // users.email is NOT NULL UNIQUE — Telegram/phone accounts get a
  // deterministic placeholder on a reserved (non-routable) domain, unique
  // via the user id and NEVER stamped verified (email_verified_at stays
  // NULL). The phone itself is stored ONLY in users.phone_e164 (0013) —
  // never encoded into an email (§2.3), and the placeholder is refused by
  // /verify-email/send (NO_REAL_EMAIL) so it can never masquerade as a
  // real address.
  // A real address supplied above replaces it entirely (still unverified).
  const accountEmail = realEmail ?? `tg-${id}@telegram.local`;
  // Password (optional, §2.1/§2.3): hashed only AFTER the OTP proved this
  // verified session — a phone + password account cannot exist without
  // ownership proof. NULL = OTP-only account (no password forced on it).
  const passwordHash = rawPassword === null ? null : await hashPassword(rawPassword);

  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO users (id, email, username, name, password_hash, phone_e164)
         SELECT ?1, ?2, ?3, ?4, ?9, ?7
          WHERE EXISTS (
             SELECT 1 FROM link_challenges
              WHERE id = ?5 AND consumed_at IS NULL AND state = 'phone_verified' AND expires_at > ?6
           )
           AND NOT EXISTS (SELECT 1 FROM telegram_links WHERE phone_e164 = ?7 AND revoked_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM telegram_links WHERE telegram_user_id = ?8 AND revoked_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM users WHERE phone_e164 = ?7)`
      ).bind(id, accountEmail, uname, name, ch.id, now, ch.phone_entered, ch.telegram_user_id, passwordHash),
      c.env.DB.prepare(
        `INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
         SELECT ?1, ?2, ?3, ?4, ?5
          WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1)`
      ).bind(id, ch.telegram_user_id, ch.chat_id, ch.phone_entered, now),
      c.env.DB.prepare(
        `UPDATE link_challenges SET consumed_at = ?1, state = 'linked'
          WHERE id = ?2 AND consumed_at IS NULL AND state = 'phone_verified'
            AND EXISTS (SELECT 1 FROM users WHERE id = ?3)`
      ).bind(now, ch.id, id),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('username')) throw conflict('This username is taken');
    if (msg.includes('UNIQUE') && msg.includes('users.email')) {
      // A real address supplied here was taken between the pre-check and the
      // insert — name the actual cause instead of blaming the phone.
      throw conflict('An account with this email already exists');
    }
    if (msg.includes('UNIQUE')) {
      // telegram_user_id (possibly on a revoked row) or email collision —
      // the person already has account history: guide to login/support.
      throw conflict(
        'هذا الرقم أو حساب تيليغرام مرتبط بحساب موجود — سجّل الدخول بدلًا من إنشاء حساب، أو تواصل مع الدعم. / ' +
          'This phone or Telegram account already belongs to an existing account — please sign in instead, or contact support.'
      );
    }
    throw e;
  }

  const userCreated = results[0]?.meta?.changes === 1;
  const challengeConsumed = results[2]?.meta?.changes === 1;
  if (!userCreated || !challengeConsumed) {
    // The phone/Telegram became linked concurrently, or a parallel complete
    // won the race — honest conflict, no half-created account (the batch is
    // one transaction and its guards made every statement a no-op).
    throw conflict(
      'هذا الرقم مرتبط بحساب موجود بالفعل — سجّل الدخول بدلًا من إنشاء حساب. / ' +
        'This phone already belongs to an account — please sign in instead.'
    );
  }

  // Referral binds ONCE, here, at account creation (§3.2) — never on a link
  // visit and never on a later sign-in. An explicit code in THIS request
  // wins over the one captured when the flow started; with none, the
  // server-resolved referrer stored on the challenge is used, which is what
  // carries the attribution across the Telegram round-trip.
  const referralSource = pickSignupReferralSource(referralCodeFrom(body), ch.signup_referrer_id);
  if (referralSource.kind === 'explicit') {
    await tryAttributeReferral(c.env, id, referralSource.ref);
  } else if (referralSource.kind === 'stored') {
    try {
      await bindReferral(c.env, id, referralSource.referrerId);
    } catch (e) {
      console.error('referral attribution failed for user', id, e instanceof Error ? e.message : String(e));
    }
  }
  await audit(c.env.DB, id, 'auth.telegram_signup', `user:${id}`, {
    phone_masked: maskPhone(ch.phone_entered),
    telegram_user_id: ch.telegram_user_id,
    // Honest signal for the operator: whether the account carries a real
    // address or the non-routable placeholder (decision row 27).
    email_placeholder: realEmail === null,
    // Whether the person chose a phone+password account (§2.3) — a boolean
    // only; the password itself never reaches logs or audit rows.
    password_set: passwordHash !== null,
  });
  await createSession(c, id);
  const user = await getFullUser(c.env.DB, id);
  c.executionCtx.waitUntil(sendToChat(c.env, ch.chat_id, TG_SIGNUP_DONE_MSG).then(() => undefined));
  // email_placeholder tells the UI the account has no real email yet, so it
  // can honestly invite the user to add one — never pretending otherwise.
  return c.json({
    success: true,
    user: publicUser(user!),
    created: true,
    email_placeholder: realEmail === null,
  });
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
  if (row.email.toLowerCase().endsWith('@telegram.local')) {
    // Telegram-signup placeholder address — non-routable by construction, so
    // "sending a verification message" could never be true. Refuse honestly
    // instead of returning the generic sent wording for mail that cannot exist.
    throw badRequest('This account has no real email address yet — add an email first.', 'NO_REAL_EMAIL');
  }
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
