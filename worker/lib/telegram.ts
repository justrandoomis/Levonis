import type { Env } from './types';
import { newId, sha256Hex, timingSafeEqual } from './crypto';

/**
 * Telegram transport + OTP helpers (final-phase §2).
 *
 * - Admin notifications (notifyAdmins) require TELEGRAM_BOT_TOKEN and
 *   TELEGRAM_ADMIN_CHAT_ID. When either is missing the feature is simply
 *   off — callers treat the result honestly and nothing pretends to have
 *   been sent.
 * - Customer messages (sendToChat) go ONLY to a specific private chat id —
 *   OTPs and account messages are NEVER routed to the admin chat or any
 *   group.
 * - Messages are sent as plain text (no parse_mode) so user-supplied names
 *   cannot inject Telegram markup.
 * - OTP codes are never stored in clear or logged: only a SHA-256 verifier
 *   (salted with the challenge id) is persisted; the code goes straight to
 *   the Telegram transport and is then dropped.
 */

const API = 'https://api.telegram.org';

export function telegramConfigured(env: Env): boolean {
  return !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ADMIN_CHAT_ID);
}

export async function notifyAdmins(env: Env, text: string): Promise<boolean> {
  if (!telegramConfigured(env)) return false;
  try {
    const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error('Telegram sendMessage failed', res.status, await res.text().catch(() => ''));
    }
    return res.ok;
  } catch (e) {
    console.error('Telegram sendMessage error', e);
    return false;
  }
}

/**
 * Send a plain-text message to one specific chat (used for PRIVATE customer
 * chats). `extra` may carry additional sendMessage fields such as
 * reply_markup. Never logs the message body (it may contain an OTP).
 */
export async function sendToChat(
  env: Env,
  chatId: number | string,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  try {
    const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
        ...extra,
      }),
    });
    if (!res.ok) {
      // Log status only — the body may contain a one-time code.
      console.error('Telegram sendToChat failed', res.status);
    }
    return res.ok;
  } catch (e) {
    console.error('Telegram sendToChat error', e instanceof Error ? e.message : e);
    return false;
  }
}

/** Token validity check (server-side only; never exposes the token). */
export async function telegramGetMe(env: Env): Promise<{ ok: boolean; username?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false };
  try {
    const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return { ok: data.ok === true, username: data.result?.username };
  } catch {
    return { ok: false };
  }
}

// ------------------------------------------------------ bot username cache

const BOT_USERNAME_SETTING_KEY = 'telegramBotUsername'; // raw admin_settings row (not in typed SETTING_DEFAULTS)
const USERNAME_TTL_MS = 6 * 60 * 60 * 1000;
let cachedBotUsername: { value: string; at: number } | null = null;

/**
 * Bot username for building t.me deep links. Cached per-isolate (6h) and in
 * admin_settings so most requests never hit getMe. Returns null when the
 * bot token is unset or the username cannot be determined — callers must
 * surface an honest 503, never a fabricated link.
 */
export async function getBotUsername(env: Env): Promise<string | null> {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  if (cachedBotUsername && Date.now() - cachedBotUsername.at < USERNAME_TTL_MS) {
    return cachedBotUsername.value;
  }
  const me = await telegramGetMe(env);
  if (me.ok && me.username) {
    cachedBotUsername = { value: me.username, at: Date.now() };
    try {
      await env.DB.prepare(
        'INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
        .bind(BOT_USERNAME_SETTING_KEY, JSON.stringify(me.username))
        .run();
    } catch (e) {
      console.error('bot username cache write failed', e instanceof Error ? e.message : e);
    }
    return me.username;
  }
  // getMe unreachable — fall back to the persisted value if we have one.
  try {
    const row = await env.DB.prepare('SELECT value FROM admin_settings WHERE key = ?')
      .bind(BOT_USERNAME_SETTING_KEY)
      .first<{ value: string }>();
    if (row) {
      const parsed = JSON.parse(row.value) as unknown;
      if (typeof parsed === 'string' && parsed) {
        cachedBotUsername = { value: parsed, at: Date.now() };
        return parsed;
      }
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

// ------------------------------------------------------------------- OTP

/** Purposes are DISTINCT (schema CHECK): a code for one action can never
 *  authorize another. */
export type OtpPurpose = 'signup' | 'login' | 'reset' | 'phone_change';
export const OTP_PURPOSES: readonly OtpPurpose[] = ['signup', 'login', 'reset', 'phone_change'];

export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

const PURPOSE_LABELS: Record<OtpPurpose, string> = {
  signup: 'إنشاء الحساب / Sign up / دروستکردنی هەژمار',
  login: 'تسجيل الدخول / Login / چوونەژوورەوە',
  reset: 'استعادة كلمة المرور / Password reset / گەڕاندنەوەی وشەی نهێنی',
  phone_change: 'تغيير رقم الهاتف / Phone change / گۆڕینی ژمارەی تەلەفۆن',
};

/** OTP delivery text — shared by account-bound and challenge-bound sends. */
function otpMessage(code: string, purpose: OtpPurpose): string {
  return (
    `LEVONIS\n` +
    `رمز التحقق / Verification code / کۆدی پشتڕاستکردنەوە:\n\n${code}\n\n` +
    `الغرض / Purpose / مەبەست: ${PURPOSE_LABELS[purpose]}\n` +
    `صالح لمدة 10 دقائق. لا تشاركه مع أي شخص — فريق LEVONIS لن يطلبه أبدًا.\n` +
    `Valid for 10 minutes. Never share it — LEVONIS staff will never ask for it.`
  );
}

/** Unbiased 6-digit code from WebCrypto (rejection sampling). */
export function generateOtpCode(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= 4_294_000_000); // largest multiple of 1e6 ≤ 2^32 → no modulo bias
  return String(n % 1_000_000).padStart(6, '0');
}

export type SendOtpResult =
  | { ok: true; expires_in_seconds: number }
  | { ok: false; error: 'NOT_CONFIGURED' | 'NOT_LINKED' | 'COOLDOWN' | 'SEND_FAILED'; retry_after_seconds?: number };

/**
 * Generate + deliver an OTP for `purpose` to the user's VERIFIED private
 * Telegram chat (telegram_links). Honest failures:
 * - NOT_LINKED: no established link — callers offer linking/support instead
 *   of pretending a code was sent.
 * - COOLDOWN: a code was sent under 60s ago (resend throttle).
 * - SEND_FAILED: Telegram delivery failed (bot blocked/unreachable) — the
 *   challenge is voided so no phantom "sent" state remains.
 * A resend supersedes all prior unconsumed challenges of the same purpose.
 * The code itself is never persisted, returned, or logged.
 */
export async function sendOtp(env: Env, userId: string, purpose: OtpPurpose): Promise<SendOtpResult> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: 'NOT_CONFIGURED' };

  const link = await env.DB.prepare(
    'SELECT chat_id FROM telegram_links WHERE user_id = ? AND revoked_at IS NULL'
  )
    .bind(userId)
    .first<{ chat_id: number }>();
  if (!link) return { ok: false, error: 'NOT_LINKED' };

  const latest = await env.DB.prepare(
    `SELECT created_at FROM otp_challenges
      WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(userId, purpose)
    .first<{ created_at: string }>();
  if (latest) {
    const ageSec = (Date.now() - new Date(latest.created_at).getTime()) / 1000;
    if (ageSec >= 0 && ageSec < OTP_RESEND_COOLDOWN_SECONDS) {
      return { ok: false, error: 'COOLDOWN', retry_after_seconds: Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - ageSec) };
    }
  }

  const id = newId('otp');
  const code = generateOtpCode();
  // Verifier is salted with the challenge id so equal codes across
  // challenges never share a digest.
  const verifier = await sha256Hex(`${id}:${code}`);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000).toISOString();

  await env.DB.batch([
    // Resend policy: invalidate every prior unconsumed challenge of this purpose.
    env.DB.prepare(
      `UPDATE otp_challenges SET superseded_by = ?
        WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL AND superseded_by IS NULL`
    ).bind(id, userId, purpose),
    env.DB.prepare(
      `INSERT INTO otp_challenges (id, user_id, purpose, verifier, chat_id, max_attempts, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, userId, purpose, verifier, link.chat_id, OTP_MAX_ATTEMPTS, expiresAt),
  ]);

  const sent = await sendToChat(env, link.chat_id, otpMessage(code, purpose));
  if (!sent) {
    // Void the undelivered challenge so nothing pretends a code is pending.
    await env.DB.prepare(
      "UPDATE otp_challenges SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND consumed_at IS NULL"
    )
      .bind(id)
      .run();
    return { ok: false, error: 'SEND_FAILED' };
  }
  return { ok: true, expires_in_seconds: OTP_TTL_SECONDS };
}

export type VerifyOtpResult =
  | { ok: true }
  | { ok: false; reason: 'no_challenge' | 'expired' | 'too_many_attempts' | 'wrong_code' };

/**
 * Verify + atomically consume an OTP. Attempts are counted with a
 * conditional UPDATE (attempts < max) BEFORE comparing, and consumption is
 * a conditional UPDATE (consumed_at IS NULL) so two concurrent correct
 * submissions can never both win. Callers perform their state transition
 * only on { ok: true }.
 */
export async function verifyOtp(
  env: Env,
  userId: string,
  purpose: OtpPurpose,
  code: string
): Promise<VerifyOtpResult> {
  const trimmed = String(code ?? '').trim();
  const row = await env.DB.prepare(
    `SELECT id, verifier, expires_at FROM otp_challenges
      WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(userId, purpose)
    .first<{ id: string; verifier: string; expires_at: string }>();
  if (!row) return { ok: false, reason: 'no_challenge' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  // Claim an attempt first — brute force burns attempts even on malformed input.
  const claim = await env.DB.prepare(
    'UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND attempts < max_attempts'
  )
    .bind(row.id)
    .run();
  if (!claim.meta || claim.meta.changes === 0) return { ok: false, reason: 'too_many_attempts' };

  if (!/^\d{6}$/.test(trimmed)) return { ok: false, reason: 'wrong_code' };
  const enc = new TextEncoder();
  const expected = await sha256Hex(`${row.id}:${trimmed}`);
  if (!timingSafeEqual(enc.encode(expected), enc.encode(row.verifier))) {
    return { ok: false, reason: 'wrong_code' };
  }

  // Conditional consume: exactly one submitter wins.
  const consume = await env.DB.prepare(
    "UPDATE otp_challenges SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND consumed_at IS NULL"
  )
    .bind(row.id)
    .run();
  if (!consume.meta || consume.meta.changes === 0) return { ok: false, reason: 'no_challenge' };
  return { ok: true };
}

// ---------------------------------------- anonymous auth challenges (§4)
//
// Telegram-first registration & sign-in reuse the link_challenges machinery
// (deep link → /start → request_contact → phone_verified) but are bound to
// an ANONYMOUS browser via a continuation token (only its SHA-256 digest is
// stored — link_challenges.continuation_hash). The OTP for such a challenge
// is challenge-bound (otp_challenges.challenge_id, user_id NULL) because at
// signup time no users row exists yet. A challenge/OTP of one purpose can
// never complete another: every query below is keyed by (challenge_id,
// purpose) and the challenge row itself carries the purpose.

export type TgAuthPurpose = 'signup' | 'login';
export const TG_AUTH_PURPOSES: readonly TgAuthPurpose[] = ['signup', 'login'];

/**
 * Map Arabic-Indic (٠-٩ U+0660–0669) and Eastern Arabic-Indic (۰-۹
 * U+06F0–06F9) digits to ASCII so customers can type their phone number in
 * either script. Pure and lossless for all other characters.
 *
 * NOTE (helper opportunity): this belongs in worker/lib/phone.ts /
 * normalizePhone itself so every phone entry point benefits — phone.ts is
 * owned by another workstream this round, so the mapping lives here and is
 * applied before calling normalizePhone.
 */
import { toAsciiDigits } from './phone';
export { toAsciiDigits }; // now canonical in phone.ts (normalizePhone maps digits itself)

/** Minimal challenge row the auth-OTP helpers need. */
export interface AuthChallengeRow {
  id: string;
  purpose: string;
  phone_entered: string;
  state: string;
  telegram_user_id: number | null;
  chat_id: number | null;
  otp_sent_at: string | null;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * Pure state summary of an auth challenge for the polling browser (no DB,
 * unit-testable). 'phone_verified' is transient — the route resolves it to
 * otp_sent / not_linkable / send_failed via maybeSendAuthChallengeOtp.
 */
export function publicAuthChallengeState(
  row: Pick<AuthChallengeRow, 'state' | 'expires_at' | 'consumed_at' | 'otp_sent_at'>,
  nowMs: number
): 'completed' | 'expired' | 'pending' | 'contact_received' | 'phone_verified' | 'otp_sent' {
  if (row.state === 'linked') return 'completed';
  if (row.consumed_at) return 'expired';
  if (new Date(row.expires_at).getTime() <= nowMs) return 'expired';
  if (row.state === 'expired' || row.state === 'revoked') return 'expired';
  if (row.state === 'phone_verified') return row.otp_sent_at ? 'otp_sent' : 'phone_verified';
  if (row.state === 'contact_received') return 'contact_received';
  return 'pending';
}

/** Seconds until a resend is allowed, from the last dispatch time. Pure. */
export function cooldownRemaining(
  sentAtIso: string | null,
  nowMs: number,
  cooldownSeconds: number = OTP_RESEND_COOLDOWN_SECONDS
): number {
  if (!sentAtIso) return 0;
  const sentMs = new Date(sentAtIso).getTime();
  if (!Number.isFinite(sentMs)) return 0;
  const remaining = Math.ceil((sentMs + cooldownSeconds * 1000 - nowMs) / 1000);
  return Math.max(0, Math.min(cooldownSeconds, remaining));
}

export type AuthLinkability =
  | { linkable: true; userId: string | null }
  | { linkable: false; hint: 'use_login' | 'use_signup' | 'support' };

/**
 * Whether a phone-verified auth challenge can actually complete, and for
 * login which account it resolves to. Hints are revealed ONLY after the
 * person proved ownership of the phone via their own Telegram contact —
 * before that, every outward response stays generic (no enumeration).
 *
 * - login: the phone must belong to a live telegram_links row AND that
 *   link's telegram_user_id must equal the verifier's — a recycled number
 *   never silently takes over the previous owner's account ('support').
 * - signup: neither the phone nor the Telegram account may already be
 *   linked — an existing owner is guided to login instead of a duplicate
 *   account or a silent merge.
 */
export async function resolveAuthLinkability(
  env: Env,
  purpose: TgAuthPurpose,
  phoneE164: string,
  telegramUserId: number | null
): Promise<AuthLinkability> {
  if (purpose === 'login') {
    const link = await env.DB.prepare(
      `SELECT user_id, telegram_user_id FROM telegram_links
        WHERE phone_e164 = ? AND revoked_at IS NULL
        ORDER BY verified_at DESC LIMIT 1`
    )
      .bind(phoneE164)
      .first<{ user_id: string; telegram_user_id: number }>();
    if (!link) return { linkable: false, hint: 'use_signup' };
    if (telegramUserId === null || link.telegram_user_id !== telegramUserId) {
      return { linkable: false, hint: 'support' };
    }
    return { linkable: true, userId: link.user_id };
  }
  // signup
  const phoneTaken = await env.DB.prepare(
    'SELECT user_id FROM telegram_links WHERE phone_e164 = ? AND revoked_at IS NULL LIMIT 1'
  )
    .bind(phoneE164)
    .first();
  if (phoneTaken) return { linkable: false, hint: 'use_login' };
  if (telegramUserId !== null) {
    const tgTaken = await env.DB.prepare(
      'SELECT user_id FROM telegram_links WHERE telegram_user_id = ? AND revoked_at IS NULL LIMIT 1'
    )
      .bind(telegramUserId)
      .first();
    if (tgTaken) return { linkable: false, hint: 'use_login' };
  }
  return { linkable: true, userId: null };
}

/**
 * Generate + deliver a challenge-bound OTP to the challenge's verified
 * private chat. Mirrors sendOtp but keys everything on (challenge_id,
 * purpose) with user_id NULL — account-level OTP flows are untouched. The
 * code is never persisted, returned, or logged.
 */
export async function sendChallengeOtp(
  env: Env,
  challengeId: string,
  purpose: TgAuthPurpose,
  chatId: number
): Promise<SendOtpResult> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: 'NOT_CONFIGURED' };

  const latest = await env.DB.prepare(
    `SELECT created_at FROM otp_challenges
      WHERE challenge_id = ? AND purpose = ? AND consumed_at IS NULL AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(challengeId, purpose)
    .first<{ created_at: string }>();
  if (latest) {
    const ageSec = (Date.now() - new Date(latest.created_at).getTime()) / 1000;
    if (ageSec >= 0 && ageSec < OTP_RESEND_COOLDOWN_SECONDS) {
      return { ok: false, error: 'COOLDOWN', retry_after_seconds: Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - ageSec) };
    }
  }

  const id = newId('otp');
  const code = generateOtpCode();
  const verifier = await sha256Hex(`${id}:${code}`);
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();

  await env.DB.batch([
    // Resend policy: invalidate every prior unconsumed challenge-bound code.
    env.DB.prepare(
      `UPDATE otp_challenges SET superseded_by = ?
        WHERE challenge_id = ? AND purpose = ? AND consumed_at IS NULL AND superseded_by IS NULL`
    ).bind(id, challengeId, purpose),
    env.DB.prepare(
      `INSERT INTO otp_challenges (id, user_id, challenge_id, purpose, verifier, chat_id, max_attempts, expires_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`
    ).bind(id, challengeId, purpose, verifier, chatId, OTP_MAX_ATTEMPTS, expiresAt),
  ]);

  const sent = await sendToChat(env, chatId, otpMessage(code, purpose));
  if (!sent) {
    await env.DB.prepare(
      "UPDATE otp_challenges SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND consumed_at IS NULL"
    )
      .bind(id)
      .run();
    return { ok: false, error: 'SEND_FAILED' };
  }
  return { ok: true, expires_in_seconds: OTP_TTL_SECONDS };
}

/**
 * Verify + atomically consume a challenge-bound OTP (mirror of verifyOtp,
 * keyed by challenge_id + purpose — a login code can never complete a
 * signup and vice versa). Exactly one concurrent correct submission wins.
 */
export async function verifyChallengeOtp(
  env: Env,
  challengeId: string,
  purpose: TgAuthPurpose,
  code: string
): Promise<VerifyOtpResult> {
  const trimmed = toAsciiDigits(String(code ?? '').trim());
  const row = await env.DB.prepare(
    `SELECT id, verifier, expires_at FROM otp_challenges
      WHERE challenge_id = ? AND purpose = ? AND consumed_at IS NULL AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(challengeId, purpose)
    .first<{ id: string; verifier: string; expires_at: string }>();
  if (!row) return { ok: false, reason: 'no_challenge' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  // Claim an attempt first — brute force burns attempts even on malformed input.
  const claim = await env.DB.prepare(
    'UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND attempts < max_attempts'
  )
    .bind(row.id)
    .run();
  if (!claim.meta || claim.meta.changes === 0) return { ok: false, reason: 'too_many_attempts' };

  if (!/^\d{6}$/.test(trimmed)) return { ok: false, reason: 'wrong_code' };
  const enc = new TextEncoder();
  const expected = await sha256Hex(`${row.id}:${trimmed}`);
  if (!timingSafeEqual(enc.encode(expected), enc.encode(row.verifier))) {
    return { ok: false, reason: 'wrong_code' };
  }

  const consume = await env.DB.prepare(
    "UPDATE otp_challenges SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND consumed_at IS NULL"
  )
    .bind(row.id)
    .run();
  if (!consume.meta || consume.meta.changes === 0) return { ok: false, reason: 'no_challenge' };
  return { ok: true };
}

export type MaybeSendResult =
  | { status: 'sent' | 'already_sent' | 'not_ready' | 'send_failed' }
  | { status: 'not_linkable'; hint: 'use_login' | 'use_signup' | 'support' };

/**
 * One-shot guarded OTP dispatch for a phone-verified auth challenge. Called
 * from BOTH the webhook (right after contact verification, so the code lands
 * while the customer is still in the chat) and the anonymous status poll —
 * the conditional otp_sent_at claim guarantees at most ONE dispatch no
 * matter how many callers race. On transport failure the claim is released
 * so a later poll can retry honestly (no phantom "code sent" state).
 */
export async function maybeSendAuthChallengeOtp(env: Env, ch: AuthChallengeRow): Promise<MaybeSendResult> {
  if (ch.purpose !== 'signup' && ch.purpose !== 'login') return { status: 'not_ready' };
  const purpose = ch.purpose as TgAuthPurpose;
  if (
    ch.state !== 'phone_verified' ||
    ch.consumed_at !== null ||
    ch.chat_id === null ||
    new Date(ch.expires_at).getTime() <= Date.now()
  ) {
    return { status: 'not_ready' };
  }
  if (ch.otp_sent_at) return { status: 'already_sent' };

  const linkability = await resolveAuthLinkability(env, purpose, ch.phone_entered, ch.telegram_user_id);
  if (!linkability.linkable) return { status: 'not_linkable', hint: linkability.hint };

  // Claim the single dispatch slot; a concurrent caller loses the claim.
  const claim = await env.DB.prepare(
    `UPDATE link_challenges SET otp_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND otp_sent_at IS NULL AND consumed_at IS NULL AND state = 'phone_verified'`
  )
    .bind(ch.id)
    .run();
  if (!claim.meta || claim.meta.changes === 0) return { status: 'already_sent' };

  const sent = await sendChallengeOtp(env, ch.id, purpose, ch.chat_id);
  if (!sent.ok) {
    // Release the claim so a later poll can retry — never a fake "sent".
    await env.DB.prepare('UPDATE link_challenges SET otp_sent_at = NULL WHERE id = ? AND consumed_at IS NULL')
      .bind(ch.id)
      .run();
    return { status: 'send_failed' };
  }
  ch.otp_sent_at = new Date().toISOString();
  return { status: 'sent' };
}
