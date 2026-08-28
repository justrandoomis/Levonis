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

  const text =
    `LEVONIS\n` +
    `رمز التحقق / Verification code / کۆدی پشتڕاستکردنەوە:\n\n${code}\n\n` +
    `الغرض / Purpose / مەبەست: ${PURPOSE_LABELS[purpose]}\n` +
    `صالح لمدة 10 دقائق. لا تشاركه مع أي شخص — فريق LEVONIS لن يطلبه أبدًا.\n` +
    `Valid for 10 minutes. Never share it — LEVONIS staff will never ask for it.`;

  const sent = await sendToChat(env, link.chat_id, text);
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
