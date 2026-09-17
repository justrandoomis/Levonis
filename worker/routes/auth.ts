import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, Env, SessionUser } from '../lib/types';
import { publicUser, localeToApi, localeToDb } from '../lib/types';
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
  requireMainHost,
} from '../lib/http';
import { newId, hashPassword, verifyPassword, isLegacyHash, randomToken, sha256Hex } from '../lib/crypto';
import { trustedOrigin } from '../lib/appOrigin';
import { createSession, destroySession, destroyAllSessions, loadSessionUser , FRESH_SESSION_SECONDS, sessionAgeSeconds } from '../lib/session';
import { verifyGoogleIdToken } from '../lib/google';
import { identifierKey, rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { emitEvent, emitFromRequest, eventsEnabled } from '../lib/eventBus';
import { UserCreatedV1 } from '@levonis/contracts/events/v1/UserCreated';
import { ReferralUsedV1 } from '@levonis/contracts/events/v1/ReferralUsed';
import { normalizePhone, maskPhone, DEFAULT_COUNTRY, allCountries } from '../lib/phone';
import { canonicalUsername, usernameRejection, suggestUsername } from '../lib/usernames';
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
import { emailConfigured, sendEmailNow } from '../lib/emailSend';
import { sendWhatsAppText, wasenderConfigured } from '../lib/wasender';
import { isPlaceholderEmail } from '../lib/profileCompletion';
import {
  AUTH_OTP_CHANNELS,
  authOtpMessage,
  startAuthOtp,
  verifyAuthOtp,
  type AuthOtpChannel,
} from '../lib/authOtp';
import { enqueue, processOutbox } from '../lib/outbox';
import {
  emailLang,
  renderVerifyEmail,
  renderResetPasswordEmail,
  renderPasswordChangedEmail,
  renderGoogleAccountNoticeEmail,
  renderFinishSignupEmail,
  renderAccountExistsEmail,
  renderSignInCodeEmail,
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

/**
 * A country the person selected, or null for "they have not said".
 *
 * Deliberately forgiving: an unrecognised value becomes null instead of an
 * error, because a country dropdown is not worth failing a signup over, and
 * "unknown" is a truthful answer that the profile-completion prompt can act
 * on later. Validated against the real ISO list rather than a length check —
 * `ZZ` is two letters and is not a country.
 */
function countryCodeOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const iso = v.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso)) return null;
  return allCountries().some((c) => c.iso === iso) ? iso : null;
}

/** The DB locale for whatever the client claimed, defaulting to English. */
function localeOrDefault(v: unknown): 'ar' | 'en' | 'ku' {
  return localeToDb(typeof v === 'string' ? v : 'en');
}

/**
 * Run a background promise without letting its absence break the request.
 *
 * `c.executionCtx` throws when there is no ExecutionContext at all. Reaching
 * for it inside an after-the-fact notice is how a completed action reports
 * itself as failed.
 */
function waitUntil(c: Context<AppContext>, work: Promise<unknown>): void {
  const swallow = () => work.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(swallow());
  } catch {
    void swallow();
  }
}

/**
 * CODED, so the screen can say it in the reader's language.
 *
 * These two threw a bare English sentence with no code, and the client's
 * CODE_MESSAGES table can only translate what it can name — so an Arabic or
 * Kurdish customer met «Password must be at least 8 characters» at the one
 * moment they are least able to guess what is wanted. The wording stays as the
 * fallback for anything that does not know the code; the code is what makes a
 * translation possible at all.
 */
function checkPassword(pw: string): void {
  if (pw.length < PASSWORD_MIN) {
    throw badRequest(`Password must be at least ${PASSWORD_MIN} characters`, 'PASSWORD_TOO_SHORT');
  }
  if (pw.length > PASSWORD_MAX) throw badRequest('Password is too long', 'PASSWORD_TOO_LONG');
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
 * `UserCreated` (03-EVENTS.md §3.1) — one event per account, whichever of the
 * four signup paths created it, seq 1 of the user aggregate. No contact and no
 * hash: at signup `marketing_consent` is necessarily `none`, so a hash here
 * would reach Ads before any consent exists. Never throws and never delays the
 * response — while the bus is off (today) it does not even run.
 */
async function emitUserCreated(
  c: { env: Env },
  p: { userId: string; method: 'password' | 'google' | 'telegram' | 'email_first'; localeDb: string; referrerCode: string; emailVerified: boolean; createdAt?: string }
): Promise<void> {
  if (!eventsEnabled(c.env)) return;
  await emitFromRequest(
    c,
    UserCreatedV1,
    {
      user_id: p.userId,
      method: p.method,
      locale: localeToApi(p.localeDb),
      referrer_code: p.referrerCode ? p.referrerCode.slice(0, 64) : null,
      email_verified: p.emailVerified,
      created_at: p.createdAt ?? new Date().toISOString(),
    },
    { aggregateId: p.userId, actorId: p.userId, aggregateSeq: 1 }
  );
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
    await bindReferral(env, newUserId, resolved.userId, ref);
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
async function bindReferral(env: Env, newUserId: string, referrerId: string, code = ''): Promise<void> {
  if (!referrerId || referrerId === newUserId) return; // self-referral never binds
  for (const campaign of ['printer', 'pro_sub'] as const) {
    const attributionId = newId('rat');
    try {
      await env.DB.prepare(
        'INSERT INTO referral_attributions (id, referrer_id, referred_id, campaign) VALUES (?, ?, ?, ?)'
      )
        .bind(attributionId, referrerId, newUserId, campaign)
        .run();
      // `ReferralUsed` (03-EVENTS.md §3.15) — the attribution that was actually
      // created, never the one that was refused by UNIQUE(referred_id, campaign).
      if (campaign === 'printer') {
        await emitEvent(
          env.DB,
          ReferralUsedV1,
          { referrer_id: referrerId, referee_id: newUserId, code: code || referrerId, attribution_id: attributionId, context: 'signup', order_id: null },
          { aggregateId: attributionId, actorId: newUserId, aggregateSeq: 1 }
        );
      }
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

/**
 * WHICH SIGN-IN METHODS ACTUALLY WORK ON THIS DEPLOYMENT.
 *
 * THE BUG THIS ENDPOINT EXISTS TO KILL. The Google button used to be decided
 * by `import.meta.env.VITE_GOOGLE_CLIENT_ID` — a value baked into the
 * JavaScript bundle at BUILD time. So the button's presence depended on
 * whether the build runner happened to hold a repository secret, while
 * whether the sign-in could actually succeed depended on a variable on the
 * Worker. Two different values, set in two different places, either of which
 * silently produced "Google sign-in is not enabled on this deployment".
 *
 * There is now one source of truth, read at RUNTIME from the Worker that
 * would have to verify the token anyway. A build can no longer disagree with
 * the deployment it is served from, and re-pointing the platform at a
 * different Google project is a variable change rather than a rebuild.
 *
 * The client id is public by construction — Google puts it in the page, in
 * the redirect and in every token audience. `GOOGLE_CLIENT_SECRET` is NOT
 * used anywhere in this architecture and is not exposed here: LEVONIS
 * verifies a Google Identity Services ID token against Google's published
 * JWKS (worker/lib/google.ts), so there is no authorization-code exchange
 * and therefore no client secret and no callback URL to protect.
 *
 * Nothing secret is returned. Every value below is either a public
 * identifier or a boolean saying whether a secret is present — never its
 * contents, and never its length.
 */
authRoutes.get('/capabilities', async (c) => {
  const clientId = (c.env.GOOGLE_CLIENT_ID || '').trim();
  const mail = emailConfigured(c.env);
  // getBotUsername answers from an in-memory cache, then a persisted one, and
  // returns null rather than guessing — so `telegram: true` means a bot that
  // actually answered, not merely a token that is present.
  const botUsername = await getBotUsername(c.env).catch(() => null);

  // The auth page is read before sign-in and changes only when the
  // deployment's configuration changes.
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({
    success: true,
    // Always available: the account system is LEVONIS's own.
    emailPassword: true,
    // Both of these need an outbound mail provider, and they fail together.
    passwordReset: mail,
    emailVerification: mail,
    /**
     * With a mail provider, an email sign-up collects NO password: /register
     * only mails a link, and the password is chosen on the finish page
     * (migration 0051). The sign-up form hides its password fields when this
     * is true; a server in this mode ignores a password it is sent anyway.
     */
    emailFirstSignup: mail,
    google: clientId.length > 0,
    googleClientId: clientId,
    telegram: !!botUsername,
    telegramBot: botUsername ?? '',
    /**
     * A phone number is a valid thing to SIGN IN with (it is matched against
     * the account's verified `phone_e164`), and it is never a way to sign UP
     * on its own — creating an account on a phone number requires proving
     * ownership of it, which happens through Telegram. `phoneOtp` says
     * whether an SMS provider exists to do that without Telegram. It does
     * not, so the UI must not offer an SMS flow.
     */
    phoneSignIn: true,
    phoneOtp: false,
    /**
     * Passwordless sign-in by a six-digit code, per channel. Both are
     * SIGN-IN only — neither creates an account (see /otp/start).
     *
     * `whatsappOtp` is true when a WasenderAPI key is present, which is NOT
     * the same as the shop's WhatsApp being linked: that session can be
     * logged out while the key stays valid, and only the provider can say so
     * (admin diagnostics asks it; this cached, unauthenticated endpoint must
     * not). The sign-in form should therefore treat a failed send as a real
     * possibility rather than an impossible one.
     */
    emailOtp: mail,
    whatsappOtp: wasenderConfigured(c.env),
    defaultCountry: DEFAULT_COUNTRY,
  });
});

/**
 * Is this username free? Answered while somebody types, so it is rate
 * limited and says nothing an attacker could not learn by trying to sign up.
 *
 * The reason is returned rather than a bare boolean: "unavailable" makes a
 * person try variations of a name that will never be accepted, when what
 * they need to be told is that it is too short, or that it is reserved.
 */
authRoutes.get('/username-available', async (c) => {
  await rateLimit(c, 'username-check', 60, 300);
  const raw = canonicalUsername(c.req.query('u') ?? '');
  const rejection = usernameRejection(raw);
  if (rejection) {
    return c.json({ success: true, username: raw, available: false, reason: rejection });
  }
  const taken = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(raw).first();
  return c.json({
    success: true,
    username: raw,
    available: !taken,
    reason: taken ? 'taken' : null,
  });
});

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
  // Both optional, both only ever affect what this person is shown. An
  // unknown value is stored as "not said" rather than rejected — a signup
  // must not fail over a country dropdown.
  const country = countryCodeOrNull(body.country);
  const locale = localeOrDefault(body.locale ?? body.lang);
  const referralCode = referralCodeFrom(body);

  // Usernames are public handles (/username-available tells anyone), so a
  // taken one is still named — and it is checked against CONFIRMED accounts
  // only (a pending sign-up holds no row in `users`), so the answer depends on
  // the handle alone and never on whether the address has an account.
  if (uname) {
    const taken = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(uname).first();
    if (taken) throw conflict('This username is taken', 'USERNAME_TAKEN');
  }

  // EMAIL-FIRST SIGN-UP (migration 0051). When the deployment can send mail,
  // registering with an address creates NOTHING in `users` and stores NO
  // password: the attempt waits in pending_signups until the person holding
  // the emailed link chooses a password on the finish page, and only THAT
  // request (POST /signup/complete) creates the account and its username. A
  // free address and a taken one get the identical body, set no cookie and do
  // the same database work (one lookup, two writes, one queued mail), and
  // neither claims a username, so nothing anywhere — this response,
  // /username-available, /login, the referral count, the admin list —
  // reveals whether the address has an account. Only its owner learns, by
  // reading the inbox. Because no password is collected here, a stranger who
  // plants a sign-up for someone else's address gains nothing: the owner
  // ignores the mail or sets their own password.
  const emailFirst = emailConfigured(c.env);
  if (emailFirst) {
    // One address must not be floodable from many IPs — and since every
    // attempt for a free address mails a fresh link, the day is capped too, so
    // nobody can be made to receive a stream of sign-up mail. Both limits run
    // before the branch, identically for a free and a taken address.
    const addressKey = await identifierKey(mail);
    await rateLimit(c, 'register-id', 5, 3600, addressKey);
    await rateLimit(c, 'register-id-day', 12, 86400, addressKey);
    const mailLang = emailLang(body.lang ?? localeToApi(locale));
    const account = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(mail).first();
    if (account) {
      // A real account already exists. Its owner alone learns someone tried —
      // one notice per address per day, however many attempts. The pending
      // row for this address (if any) is dropped: an account now exists, so
      // nothing may finish a sign-up for it — and this write, with the
      // expiry sweep below, keeps the two branches the same shape.
      await c.env.DB.prepare('DELETE FROM pending_signups WHERE email = ?').bind(mail).run();
      await c.env.DB.prepare('DELETE FROM pending_signups WHERE expires_at < ?').bind(new Date().toISOString()).run();
      const notice = renderAccountExistsEmail(mailLang, `${trustedOrigin(c)}/auth`);
      const day = new Date().toISOString().slice(0, 10);
      await enqueue(c.env, `email_exists:${await sha256Hex(mail)}:${day}`, {
        kind: 'email', to: mail, subject: notice.subject, html: notice.html, text: notice.text,
      });
      c.executionCtx.waitUntil(processOutbox(c.env, 3));
    } else {
      // No account yet: hold the profile (never a password) and mail the link.
      await issuePendingSignup(c, { email: mail, username: uname, name, country, locale, referral: referralCode, lang: mailLang });
    }
    return c.json({
      success: true,
      pending_email: true,
      message:
        'أرسلنا رسالة إلى بريدك — افتح الرابط داخلها لاختيار كلمة المرور وفتح حسابك. / ' +
        'We sent a message to your email — open the link inside it to choose a password and open your account.',
    });
  }

  // NO MAIL SERVICE: there is no private channel to prove an address, so the
  // account opens straight away with the password typed here, and a taken
  // address is named — as it always was. Development and test deployments
  // only; every real deployment has a mail provider.
  const password = String(body.password ?? '');
  checkPassword(password);
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(mail).first();
  if (existing) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');

  const id = newId('usr');
  const hash = await hashPassword(password);
  try {
    await c.env.DB.prepare(
      'INSERT INTO users (id, email, username, name, password_hash, country, locale) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(id, mail, uname, name, hash, country, locale)
      .run();
  } catch (e) {
    // THE RACE THE CHECKS ABOVE CANNOT CLOSE. Two signups a millisecond
    // apart both read "free" and both insert; the database is what actually
    // decides, so its refusal is translated into the same 409 the check
    // would have produced rather than surfacing as a 500 that reads like the
    // site is broken.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('UNIQUE')) throw e;
    if (msg.includes('username')) throw conflict('This username is taken', 'USERNAME_TAKEN');
    throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
  }

  await emitUserCreated(c, { userId: id, method: 'password', localeDb: locale, referrerCode: referralCode, emailVerified: false });
  await tryAttributeReferral(c.env, id, referralCode);
  await createSession(c, id);
  const user = await getFullUser(c.env.DB, id);
  return c.json({ success: true, user: publicUser(user!) });
});

// ------------------------------------------------ email-first sign-up: finish

const PENDING_SIGNUP_TTL_HOURS = 24;
const PENDING_LINK_MSG = 'This sign-up link is invalid or has expired — sign up again to get a new one';

interface PendingSignupRow {
  email: string;
  username: string | null;
  name: string;
  country: string | null;
  locale: string;
  referral_code: string;
  expires_at: string;
}

/**
 * Holds an email sign-up until the inbox is proven, WITHOUT creating anything
 * in `users` and WITHOUT a password (migration 0051). Keyed by address, so a
 * re-signup overwrites the previous attempt and re-issues the link — the
 * latest attempt is the only one that can be finished, and nothing an earlier
 * (possibly hostile) attempt chose survives. The account, its username and
 * its password are born together in POST /signup/complete.
 */
async function issuePendingSignup(
  c: Context<AppContext>,
  p: { email: string; username: string | null; name: string; country: string | null; locale: string; referral: string; lang: EmailLang }
): Promise<void> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + PENDING_SIGNUP_TTL_HOURS * 3_600_000).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO pending_signups (email, token_hash, username, name, country, locale, referral_code, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(email) DO UPDATE SET
       token_hash = ?2, username = ?3, name = ?4, country = ?5,
       locale = ?6, referral_code = ?7, expires_at = ?8,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  )
    .bind(p.email, tokenHash, p.username, p.name, p.country, p.locale, p.referral, expires)
    .run();
  // Opportunistic cleanup of expired attempts so the table stays small.
  await c.env.DB.prepare('DELETE FROM pending_signups WHERE expires_at < ?').bind(new Date().toISOString()).run();
  // The link OPENS the finish page on the main origin; nothing is consumed by
  // opening it (a mail scanner's GET spends nothing) — the token is used only
  // by the explicit POST that carries the chosen password.
  const link = `${trustedOrigin(c)}/auth?finish=${token}`;
  const msg = renderFinishSignupEmail(p.lang, link);
  await enqueue(c.env, `signup_link:${tokenHash}`, { kind: 'email', to: p.email, subject: msg.subject, html: msg.html, text: msg.text });
  c.executionCtx.waitUntil(processOutbox(c.env, 3));
}

/** The live pending sign-up behind a link token, or the one generic refusal. */
async function loadPendingSignup(db: D1Database, tokenHash: string): Promise<PendingSignupRow> {
  const p = await db
    .prepare('SELECT email, username, name, country, locale, referral_code, expires_at FROM pending_signups WHERE token_hash = ?')
    .bind(tokenHash)
    .first<PendingSignupRow>();
  if (!p) throw badRequest(PENDING_LINK_MSG, 'BAD_TOKEN');
  if (new Date(p.expires_at).getTime() < Date.now()) throw badRequest(PENDING_LINK_MSG, 'TOKEN_EXPIRED');
  return p;
}

/**
 * What the finish page shows before the password is typed: the address the
 * account will belong to and the profile the person asked for. Read-only —
 * opening the link never spends it. The holder of the token got it from that
 * inbox, so the address is theirs to see.
 */
authRoutes.get('/signup/pending', async (c) => {
  await rateLimit(c, 'signup-pending', 30, 600);
  const token = str(c.req.query('token'), 'token', { min: 20, max: 128 });
  const p = await loadPendingSignup(c.env.DB, await sha256Hex(token));
  c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    email: p.email,
    name: p.name,
    username: p.username,
    country: p.country,
    // Shown on the finish page so the person sees — and may remove — the
    // referral a sign-up attempt attached to their address.
    referral_code: p.referral_code,
    expires_at: p.expires_at,
  });
});

/**
 * Finishes an email-first sign-up (migration 0051). The token proved the
 * inbox and the PASSWORD ARRIVES HERE, chosen by the person holding the link,
 * so the account is created NOW — its username claimed only if still free
 * (otherwise left null for onboarding to ask), the referral bound, a session
 * opened. This is the ONLY place an email-first account is born.
 *
 * Order matters: the password is validated and hashed BEFORE the row is
 * claimed, so a weak password never burns the link; the claim is one DELETE,
 * so of two concurrent completions exactly one creates the account.
 */
authRoutes.post('/signup/complete', async (c) => {
  await rateLimit(c, 'signup-complete', 20, 3600);
  const body = await c.req.json().catch(() => ({}));
  const token = str(body.token, 'token', { min: 20, max: 128 });
  const password = String(body.password ?? '');
  checkPassword(password);
  const tokenHash = await sha256Hex(token);
  const p = await loadPendingSignup(c.env.DB, tokenHash);

  // The finish page may correct the profile typed at sign-up — same
  // validators as /register. A handle typed HERE that is taken is named
  // before anything is spent, so the person picks another without losing
  // the link; the handle carried from /register falls back silently below.
  const overrideUname = typeof body.username === 'string' && body.username.trim() !== '' ? username(body.username) : null;
  if (overrideUname && overrideUname !== p.username) {
    const taken = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(overrideUname).first();
    if (taken) throw conflict('This username is taken', 'USERNAME_TAKEN');
  }
  const uname = overrideUname ?? p.username;
  const name = typeof body.name === 'string' ? str(body.name, 'name', { min: 0, max: 100, required: false }) : p.name;
  const country = body.country !== undefined ? countryCodeOrNull(body.country) : p.country;
  // The referral is decided by the person FINISHING, not by whoever submitted
  // the sign-up: the finish page shows the pending code and sends back what
  // the person kept (an empty string removes it). Otherwise anyone could plant
  // sign-ups for other people's addresses and collect the referral on every
  // one that gets completed. An old client that sends nothing keeps the code.
  const referral = typeof body.referralCode === 'string' ? referralCodeFrom(body) : p.referral_code;

  const hash = await hashPassword(password);
  // Claim the row atomically: exactly one of two concurrent completions wins.
  const claimed = await c.env.DB.prepare('DELETE FROM pending_signups WHERE token_hash = ?').bind(tokenHash).run();
  if (claimed.meta.changes === 0) throw badRequest(PENDING_LINK_MSG, 'TOKEN_USED');

  const id = newId('usr');
  const now = new Date().toISOString();
  const insert = (u: string | null) =>
    c.env.DB.prepare(
      'INSERT INTO users (id, email, username, name, password_hash, country, locale, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(id, p.email, u, name, hash, country, p.locale, now)
      .run();
  let usernameDropped = false;
  try {
    await insert(uname);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('username') && uname) {
      // The handle was taken while the link waited in the inbox — keep the
      // account, drop the handle; onboarding asks for a new one (username null).
      try {
        await insert(null);
        usernameDropped = true;
      } catch (e2) {
        const m2 = e2 instanceof Error ? e2.message : String(e2);
        if (m2.includes('UNIQUE')) throw conflict('Your account is already set up — please sign in', 'ALREADY_REGISTERED');
        throw e2;
      }
    } else if (msg.includes('UNIQUE')) {
      // The address already has an account (e.g. its owner signed in with
      // Google before opening this link). Nothing to create.
      throw conflict('Your account is already set up — please sign in', 'ALREADY_REGISTERED');
    } else {
      throw e;
    }
  }
  await emitUserCreated(c, { userId: id, method: 'email_first', localeDb: p.locale, referrerCode: referral, emailVerified: true, createdAt: now });
  await tryAttributeReferral(c.env, id, referral);
  await createSession(c, id);
  await audit(c.env.DB, id, 'auth.signup_completed', id, usernameDropped ? { username_dropped: true } : {});
  const user = await getFullUser(c.env.DB, id);
  return c.json({ success: true, user: publicUser(user!), username_dropped: usernameDropped });
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
  // A second limit on the ACCOUNT being tried, so a guess spread across many
  // addresses is still a guess against one account. Keyed on a hash of the
  // identifier, applied before any lookup and to every identifier alike, so it
  // reveals nothing about which accounts exist.
  await rateLimit(c, 'login-id', 10, 900, await identifierKey(raw));
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
  // The CODE is what the UI reads, so the message can be rendered in the
  // reader's own language instead of showing them two languages at once. The
  // text stays for anything that is not the browser app.
  const fail = () =>
    new HttpError(
      401,
      'البريد أو اسم المستخدم أو الهاتف أو كلمة المرور غير صحيحة. إن أنشأت حسابك عبر Google أو تيليغرام فاستخدم زره. / ' +
        'Incorrect email/username/phone or password. If you created your account with Google or Telegram, use that button.',
      'LOGIN_FAILED'
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

/**
 * Match a verified Google identity to a LEVONIS account, or create one.
 *
 * EXTRACTED SO IT CAN BE TESTED. The rules below decide whether two people
 * are one person, and they were only reachable through a route that first
 * verifies an RS256 token against Google's live JWKS — which means the four
 * cases that matter (known subject, link to a verified address, refuse an
 * unverified one, create a new account) could not be exercised at all
 * without a real Google token. They are now a function over a database.
 *
 * The caller must have ALREADY verified the identity. Nothing here checks a
 * signature; passing an unverified identity to this function would hand an
 * account to whoever asked for it.
 */
export async function resolveGoogleIdentity(
  env: Env,
  identity: { sub: string; email: string; name?: string },
  referralCode = ''
): Promise<SessionUser> {
  // Match by google_sub first (stable), then link by verified email.
  let row = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?')
    .bind(identity.sub)
    .first<SessionUser>();

  if (!row) {
    const byEmail = await env.DB.prepare('SELECT * FROM users WHERE email = ?')
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
      const linked = await env.DB.prepare(
        'UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL'
      )
        .bind(identity.sub, byEmail.id)
        .run();
      if (linked.meta.changes === 0) {
        // Someone linked a Google identity to this account in between; only
        // the same sub may proceed (a different one is the conflict above).
        const fresh = await env.DB.prepare('SELECT google_sub FROM users WHERE id = ?')
          .bind(byEmail.id)
          .first<{ google_sub: string | null }>();
        if (fresh?.google_sub !== identity.sub) {
          throw conflict('This email is already linked to a different Google account');
        }
      }
      await audit(env.DB, byEmail.id, 'auth.google_linked', byEmail.id, {});
      row = byEmail;
    }
  }

  if (!row) {
    const id = newId('usr');
    // The handle is DERIVED, so it has to pass the same rules a typed one
    // does — including the reserved list. `admin@gmail.com` used to become
    // the handle `admin`; `suggestUsername` returns '' for anything reserved
    // or malformed, and a numeric suffix is added until the name is free.
    // A null username is an acceptable outcome: the account works, and the
    // onboarding step asks for a handle.
    let uname: string | null = suggestUsername(identity.email) || null;
    for (let i = 0; uname && i < 4; i++) {
      const taken = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(uname).first();
      if (!taken) break;
      const candidate = `${suggestUsername(identity.email).slice(0, 24)}${Math.floor(1000 + Math.random() * 9000)}`;
      uname = usernameRejection(candidate) === null ? candidate : null;
    }
    await env.DB.prepare(
      'INSERT INTO users (id, email, username, name, google_sub) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(id, identity.email, uname, identity.name || 'User', identity.sub)
      .run();
    row = (await getFullUser(env.DB, id))!;
    await emitUserCreated({ env }, { userId: id, method: 'google', localeDb: row.locale, referrerCode: referralCode, emailVerified: true, createdAt: row.created_at });
    // Referral attribution happens ONLY on account creation — an existing
    // account signing in with a ?ref= link must never be re-attributed.
    await tryAttributeReferral(env, id, referralCode);
  }

  // verifyGoogleIdToken only accepts identities whose email_verified claim is
  // true, so a Google sign-in proves ownership of that address: stamp THIS
  // account's own matching address as verified (first stamp wins; existing
  // stamps and other accounts are never touched — no bulk verification).
  await env.DB.prepare(
    'UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ? AND email = ?'
  )
    .bind(new Date().toISOString(), row.id, identity.email)
    .run();

  // Controlled initial-admin bootstrap: promote only on a VERIFIED Google
  // identity matching INITIAL_ADMIN_EMAIL, and only while no admin exists.
  if (
    env.INITIAL_ADMIN_EMAIL &&
    identity.email === env.INITIAL_ADMIN_EMAIL.toLowerCase().trim() &&
    row.role !== 'admin'
  ) {
    const adminExists = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first();
    if (!adminExists) {
      await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(row.id).run();
      await audit(env.DB, row.id, 'auth.initial_admin_bootstrap', row.id, { email: identity.email });
    }
  }

  return (await getFullUser(env.DB, row.id))!;
}

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

  const row = await resolveGoogleIdentity(c.env, identity, referralCode);
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
authRoutes.post('/google/link', requireMainHost, requireAuth, async (c) => {
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

authRoutes.post('/change-password', requireMainHost, requireAuth, async (c) => {
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
  } else if (sessionAgeSeconds(c) > FRESH_SESSION_SECONDS) {
    // A Google/Telegram account has no password to prove, and a session cookie
    // alone is not proof of presence — a stolen one would let its holder set a
    // password and keep the account. Setting the FIRST password needs a
    // sign-in within the last few minutes.
    throw new HttpError(
      401,
      'سجّل الدخول مجددًا ثم عيّن كلمة المرور / Sign in again, then set your password',
      'REAUTH_REQUIRED'
    );
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
  // Per address as well as per IP: one inbox must not be floodable from many IPs.
  await rateLimit(c, 'forgot-id', 3, 3600, await identifierKey(mail));
  const lang = emailLang(body.lang);

  if (!emailConfigured(c.env)) {
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
  //
  // BEST-EFFORT HAS TO MEAN IT. By this point the password is already
  // changed and every session is already gone; there is no undoing it. So
  // nothing in this block may turn a completed reset into an error the
  // person reads as "it did not work" — including `c.executionCtx` itself,
  // which throws outright in any context that has no ExecutionContext.
  try {
    const owner = await c.env.DB.prepare('SELECT email, locale FROM users WHERE id = ?')
      .bind(row.user_id)
      .first<{ email: string; locale: string }>();
    if (owner) {
      const notice = renderPasswordChangedEmail(localeToApi(owner.locale));
      const send = sendEmail(c.env, owner.email, notice.subject, notice.html, notice.text);
      waitUntil(c, send);
    }
  } catch (e) {
    console.error('password-changed notice failed', e instanceof Error ? e.message : String(e));
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
      // The address is checked for collision at the INSERT below (after the OTP
      // is consumed), never here: a pre-OTP check let one verified phone
      // challenge probe many addresses without spending its code — a working
      // email-existence oracle. The UNIQUE(users.email) handler on the insert
      // names the same 409, but only after a fresh OTP has been burned.
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

  await emitUserCreated(c, {
    userId: id,
    method: 'telegram',
    // The Telegram signup INSERT names no locale, so the account carries the
    // column's default rather than a guess made here.
    localeDb: 'en',
    referrerCode: referralCodeFrom(body),
    emailVerified: false,
    createdAt: now,
  });

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
    emailConfigured: emailConfigured(c.env),
  });
});

authRoutes.post('/verify-email/send', requireAuth, async (c) => {
  await rateLimit(c, 'verify-email-send', 6, 3600);
  const user = c.get('user')!;
  if (!emailConfigured(c.env)) {
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
authRoutes.post('/change-email', requireMainHost, requireAuth, async (c) => {
  await rateLimit(c, 'change-email', 5, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const newMail = email(body.newEmail);
  if (!emailConfigured(c.env)) {
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
  } else if (sessionAgeSeconds(c) > FRESH_SESSION_SECONDS) {
    // Telegram-only account: no password and no Google. The address is the
    // recovery channel, so moving it needs a fresh sign-in, not just a cookie.
    throw new HttpError(
      401,
      'سجّل الدخول مجددًا ثم غيّر البريد / Sign in again, then change your email',
      'REAUTH_REQUIRED'
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

// ---------------------------------------------- passwordless sign-in codes
//
// SIGNING IN WITH A CODE, over email or WhatsApp. Two endpoints:
//
//   POST /api/auth/otp/start   { channel, identifier, lang }
//   POST /api/auth/otp/verify  { channel, identifier, code }
//
// THIS SIGNS IN; IT DOES NOT SIGN UP. An account is created by /register, by
// Google, or by the Telegram flow, all of which collect the things an account
// needs (a username, a referral, a password choice). Creating one here from a
// bare address would make a half-account nobody asked for — and on the
// WhatsApp side it would mean a phone number entered a shop's user table
// without anybody ever proving they own it.
//
// WHY EACH CHANNEL IS ALLOWED TO DO THIS AT ALL:
//
//   email    — the code goes to `users.email`. Receiving it IS proof of
//              control of that mailbox, which is the same proof
//              /verify-email/confirm accepts, so a successful sign-in also
//              stamps `email_verified_at` when it was never stamped.
//
//   whatsapp — the code goes to `users.phone_e164`, and migration 0013 is
//              explicit that this column is only ever written after Telegram
//              contact verification: "a phone typed into a form is never
//              stored here". So the number is already proven to belong to the
//              account holder, and WhatsApp on it is a second factor of the
//              same ownership rather than a new trust assumption.
//
// ANTI-ENUMERATION. /start answers identically whether or not an account
// exists: the unknown case writes a decoy challenge (user_id NULL, nothing
// sent) so the response, its shape and its timing carry no signal, and the
// resend cooldown is keyed on the DESTINATION rather than a user id — a
// per-user cooldown is itself an oracle. /verify has one uniform failure for
// every cause, exactly like /login.
//
// THE ONE THING /start DOES NOT HIDE is that the channel is switched off. A
// shop with no mail provider, or whose WhatsApp session has logged out,
// answers 503 with a reason, because pretending to send a code that can never
// arrive leaves the customer waiting on nothing.

/** Uniform failure for /verify — unknown destination, wrong code, expired,
 *  burnt attempts and a re-pointed account are one message from outside. */
const OTP_FAIL_MSG =
  'الرمز غير صحيح أو انتهت صلاحيته. اطلب رمزاً جديداً. / ' +
  'That code is wrong or has expired. Request a new one.';

/**
 * Read `{channel, identifier}` into a normalized destination.
 *
 * Normalization is not cosmetic here: the resend cooldown, both rate limits
 * and the challenge lookup are all keyed on this string, so `Ali@X.COM` and
 * `ali@x.com` reaching the database as different destinations would be two
 * free buckets for the same mailbox.
 */
function readOtpTarget(body: Record<string, unknown>): { channel: AuthOtpChannel; destination: string } {
  const channel = oneOf(body.channel, 'channel', AUTH_OTP_CHANNELS as readonly string[]) as AuthOtpChannel;
  if (channel === 'email') {
    return { channel, destination: email(body.identifier ?? body.email) };
  }
  const raw = str(body.identifier ?? body.phone, 'phone', { min: 4, max: 32 });
  const phone = normalizePhone(raw, countryCodeOrNull(body.country) ?? DEFAULT_COUNTRY);
  if (!phone) throw badRequest('This phone number is not valid', 'PHONE_INVALID');
  return { channel, destination: phone };
}

/** The account a code for this destination would sign in, or null. */
async function accountForOtpDestination(
  db: D1Database,
  channel: AuthOtpChannel,
  destination: string
): Promise<{ id: string; email: string; email_verified_at: string | null } | null> {
  if (channel === 'email') {
    // A placeholder address is not a mailbox — nothing can be delivered to
    // `@telegram.local`, and /verify-email/send already refuses it.
    if (isPlaceholderEmail(destination)) return null;
    return db
      .prepare('SELECT id, email, email_verified_at FROM users WHERE email = ?')
      .bind(destination)
      .first<{ id: string; email: string; email_verified_at: string | null }>();
  }
  return db
    .prepare('SELECT id, email, email_verified_at FROM users WHERE phone_e164 = ?')
    .bind(destination)
    .first<{ id: string; email: string; email_verified_at: string | null }>();
}

authRoutes.post('/otp/start', requireMainHost, async (c) => {
  // Per IP first, then per DESTINATION — one mailbox or one phone must not be
  // floodable from many addresses, and on WhatsApp a flood is also the shop's
  // own send quota (as little as one message per five seconds) being spent by
  // a stranger.
  await rateLimit(c, 'otp-start', 8, 900);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { channel, destination } = readOtpTarget(body);
  await rateLimit(c, `otp-start-${channel}`, 4, 3600, await identifierKey(destination));

  const lang = emailLang(body.lang);

  if (channel === 'email' && !emailConfigured(c.env)) {
    throw unavailable(
      'تسجيل الدخول برمز عبر البريد غير متاح حالياً. / Sign-in codes by email are not available right now.',
      'EMAIL_NOT_CONFIGURED'
    );
  }
  if (channel === 'whatsapp' && !wasenderConfigured(c.env)) {
    throw unavailable(
      'تسجيل الدخول برمز عبر واتساب غير متاح حالياً. / Sign-in codes by WhatsApp are not available right now.',
      'WHATSAPP_NOT_CONFIGURED'
    );
  }

  const account = await accountForOtpDestination(c.env.DB, channel, destination);

  const started = await startAuthOtp(c.env, {
    channel,
    destination,
    userId: account?.id ?? null,
    // The decoy path: no account, so nothing is sent, but the row is still
    // written and this reports success — the caller cannot tell the two apart.
    send: async (code) => {
      // The decoy. 'skipped' — not `true` — so the row records honestly that
      // nothing left, while the cooldown and the response stay identical to a
      // real request.
      if (!account) return 'skipped';
      if (channel === 'email') {
        const msg = renderSignInCodeEmail(lang, code);
        return sendEmail(c.env, account.email, msg.subject, msg.html, msg.text);
      }
      const msg = authOtpMessage(code, lang);
      const sent = await sendWhatsAppText(c.env, destination, msg.text);
      if (!sent.ok) {
        // Not customer-facing: the outward response stays uniform. It is here
        // so an operator can tell a logged-out WhatsApp session from a wrong
        // number, which have completely different fixes.
        console.warn(`otp/start: WhatsApp send failed (${sent.error})`);
      }
      return sent.ok;
    },
  });

  if (!started.ok) {
    if (started.error === 'COOLDOWN') {
      throw new HttpError(
        429,
        'انتظر قليلاً قبل طلب رمز جديد. / Wait a moment before requesting another code.',
        'OTP_COOLDOWN',
        { retry_after_seconds: started.retry_after_seconds }
      );
    }
    // The send failed for a REAL destination. Saying so is honest and reveals
    // nothing an attacker could not already learn by watching the channel: it
    // is reported for the unknown-account case too, because the decoy path
    // reports success and never reaches here.
    throw unavailable(
      'تعذّر إرسال الرمز الآن. حاول مرة أخرى بعد قليل. / The code could not be sent right now. Try again shortly.',
      'OTP_SEND_FAILED'
    );
  }

  return c.json({
    success: true,
    channel,
    expires_in_seconds: started.expires_in_seconds,
    resend_after_seconds: started.resend_after_seconds,
  });
});

authRoutes.post('/otp/verify', requireMainHost, async (c) => {
  await rateLimit(c, 'otp-verify', 20, 900);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { channel, destination } = readOtpTarget(body);
  await rateLimit(c, `otp-verify-${channel}`, 10, 900, await identifierKey(destination));
  const code = str(body.code, 'code', { min: 4, max: 12 });

  const fail = () => new HttpError(401, OTP_FAIL_MSG, 'OTP_FAILED');

  const result = await verifyAuthOtp(c.env, channel, destination, code);
  if (!result.ok) throw fail();

  // RESOLVED AGAIN, from the destination, not taken from the row. The row's
  // user_id is a record of what was true when the code was issued; ten
  // minutes later the address may belong to a different account (a change of
  // email) or to none. The proof this code carries is "somebody controls this
  // destination" — who that is, is decided now.
  const account = await accountForOtpDestination(c.env.DB, channel, destination);
  if (!account) throw fail();
  if (result.user_id && result.user_id !== account.id) {
    // The destination moved between issue and use. Refusing is the only safe
    // reading: neither account consented to the other's code.
    console.warn('otp/verify: destination re-pointed between issue and use — refused');
    throw fail();
  }

  // Receiving the code IS the mailbox proof, so an account that signed in this
  // way has a verified address whether or not it ever clicked a link.
  if (channel === 'email' && !account.email_verified_at) {
    await c.env.DB.prepare(
      "UPDATE users SET email_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND email_verified_at IS NULL"
    )
      .bind(account.id)
      .run();
  }

  await audit(c.env.DB, account.id, 'auth.otp_login', `user:${account.id}`, {
    channel,
    // Never the address or the number itself: an audit row is read by staff.
    destination_masked: channel === 'email' ? maskEmail(destination) : maskPhone(destination),
  });

  await createSession(c, account.id);
  const user = await getFullUser(c.env.DB, account.id);
  if (!user) throw fail();
  return c.json({ success: true, user: publicUser(user) });
});

/** `a***@example.com` — enough for staff to recognise an address in an audit
 *  row, not enough for the row itself to be a mailing list. */
function maskEmail(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, local.length - 1))}${address.slice(at)}`;
}


// Email helpers --------------------------------------------------------------


/**
 * Sends one email NOW, for auth mail a person is waiting on (a reset link, a
 * sign-in code) — as opposed to the durable outbox, which cron drains.
 *
 * The implementation moved to lib/emailSend.ts so the configuration check,
 * the staging allowlist and the provider timeout are decided once instead of
 * at each call site; this wrapper stays because thirteen call sites in this
 * file read better as `sendEmail(...)`. Returns false, never throws: the
 * outward API response must not vary with whether a particular address exists.
 */
async function sendEmail(env: Env, to: string, subject: string, html: string, text: string): Promise<boolean> {
  return sendEmailNow(env, to, subject, html, text);
}

export { loadSessionUser };
