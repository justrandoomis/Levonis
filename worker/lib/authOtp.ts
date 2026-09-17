/**
 * PASSWORDLESS SIGN-IN CODES, over email and WhatsApp.
 *
 * This is the channel-agnostic half of what `worker/lib/telegram.ts` already
 * does for Telegram, deliberately written to the SAME rules rather than new
 * ones — a six-digit code that behaves differently depending on which channel
 * carried it is a code nobody can reason about:
 *
 *   * unbiased 6 digits from WebCrypto (rejection sampling, no modulo bias)
 *   * the code is NEVER stored — only SHA-256("<row id>:<code>"), salted by
 *     the row id so equal codes across rows never share a digest
 *   * 10-minute TTL, 5 attempts, 60-second resend cooldown
 *   * a resend SUPERSEDES every older live code for that destination
 *   * the attempt is claimed BEFORE the comparison, so malformed input costs
 *     an attempt — otherwise the attempt counter is free to bypass
 *   * the comparison is timing-safe, and consumption is a conditional UPDATE
 *     so two concurrent correct submissions cannot both win
 *
 * WHAT IS DIFFERENT HERE, and why.
 *
 * 1. THE DESTINATION IS THE SUBJECT, not the account. A Telegram OTP goes to a
 *    chat already proven to belong to a user. Here the code goes to an address
 *    or a phone number, and control of it is what is being proven. So the
 *    account is resolved from the destination at VERIFY time as well as at
 *    start time: a row can never sign in an account it was not issued for,
 *    even if the mapping changed in between.
 *
 * 2. NOTHING ABOUT THE RESULT MAY REVEAL WHETHER AN ACCOUNT EXISTS. `start()`
 *    writes a row and answers the same shape whether or not a user matched —
 *    the no-account case is a decoy with `user_id NULL` and no send. It is the
 *    rule `/forgot-password` already follows, and it is the reason the
 *    cooldown is keyed on the destination rather than on a user id: a
 *    per-user cooldown is itself an oracle.
 *
 * 3. DELIVERY IS INJECTED. `start()` takes a `send` function and does not know
 *    what a mailbox or a WhatsApp session is. That keeps the security rules in
 *    one testable place, and it is what lets a failed send VOID the row
 *    (below) instead of leaving a code the customer never received blocking
 *    the next request for a minute.
 */

import { newId, sha256Hex, timingSafeEqual } from './crypto';
import type { Env } from './types';

export const AUTH_OTP_CHANNELS = ['email', 'whatsapp'] as const;
export type AuthOtpChannel = (typeof AUTH_OTP_CHANNELS)[number];

export const AUTH_OTP_PURPOSES = ['signin'] as const;
export type AuthOtpPurpose = (typeof AUTH_OTP_PURPOSES)[number];

/** Same numbers as the Telegram OTP — one policy, three channels. */
export const AUTH_OTP_TTL_SECONDS = 10 * 60;
export const AUTH_OTP_RESEND_COOLDOWN_SECONDS = 60;
export const AUTH_OTP_MAX_ATTEMPTS = 5;

export function isAuthOtpChannel(v: unknown): v is AuthOtpChannel {
  return typeof v === 'string' && (AUTH_OTP_CHANNELS as readonly string[]).includes(v);
}

/**
 * Unbiased 6-digit code. Rejection sampling, not `% 1e6` on a raw draw: the
 * last partial block of 2^32 would make the low codes fractionally likelier,
 * and "fractionally likelier" is a measurable advantage over millions of
 * guesses. Identical to generateOtpCode() in lib/telegram.ts by intent.
 */
export function generateAuthOtpCode(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= 4_294_000_000); // largest multiple of 1e6 ≤ 2^32
  return String(n % 1_000_000).padStart(6, '0');
}

export type StartOtpResult =
  | { ok: true; expires_in_seconds: number; resend_after_seconds: number }
  | { ok: false; error: 'COOLDOWN' | 'SEND_FAILED'; retry_after_seconds?: number; detail?: string };

export interface StartOtpInput {
  channel: AuthOtpChannel;
  /** ALREADY NORMALIZED: lowercased email, or E.164. Callers normalize; this
   *  module does not guess what a destination means. */
  destination: string;
  purpose?: AuthOtpPurpose;
  /** The account the code would sign in, or null for the decoy path. */
  userId: string | null;
  /**
   * Delivers the code. Called with the PLAINTEXT code, which is the only
   * moment it exists outside the customer's inbox — it is never returned,
   * stored or logged.
   *
   * THREE ANSWERS, not two:
   *   true      — delivered. `sent_at` is stamped.
   *   false     — the transport failed. The row is VOIDED, so a customer is
   *               not locked out for a minute by a code that never arrived.
   *   'skipped' — there was nothing to deliver (the anti-enumeration decoy:
   *               no account owns this destination). The row STAYS LIVE, so
   *               the cooldown is identical to a real request, and `sent_at`
   *               stays NULL so an operator reading the table can see that
   *               nothing actually left.
   */
  send: (code: string) => Promise<boolean | 'skipped'>;
}

/**
 * Issue a code and hand it to `send`.
 *
 * THE ROW IS WRITTEN BEFORE THE SEND, and voided if the send fails. The other
 * order — send first, then record — loses the code entirely when the write
 * fails after a successful delivery, and the customer is then holding a code
 * nothing will accept. Voiding is also what keeps a dead channel from locking
 * a customer out for 60 seconds per attempt.
 *
 * THE COOLDOWN IS CHECKED AGAINST THE NEWEST LIVE ROW for this destination,
 * including decoys — so probing an address that has no account is throttled
 * exactly like one that does.
 */
export async function startAuthOtp(env: Env, input: StartOtpInput): Promise<StartOtpResult> {
  const purpose: AuthOtpPurpose = input.purpose ?? 'signin';
  const destination = input.destination;

  const latest = await env.DB.prepare(
    `SELECT created_at FROM auth_otp
      WHERE channel = ? AND destination = ? AND purpose = ?
        AND consumed_at IS NULL AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(input.channel, destination, purpose)
    .first<{ created_at: string }>();
  if (latest) {
    const ageSec = (Date.now() - new Date(latest.created_at).getTime()) / 1000;
    if (ageSec >= 0 && ageSec < AUTH_OTP_RESEND_COOLDOWN_SECONDS) {
      return {
        ok: false,
        error: 'COOLDOWN',
        retry_after_seconds: Math.ceil(AUTH_OTP_RESEND_COOLDOWN_SECONDS - ageSec),
      };
    }
  }

  const id = newId('aotp');
  const code = generateAuthOtpCode();
  const verifier = await sha256Hex(`${id}:${code}`);
  const expiresAt = new Date(Date.now() + AUTH_OTP_TTL_SECONDS * 1000).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE auth_otp SET superseded_by = ?
        WHERE channel = ? AND destination = ? AND purpose = ?
          AND consumed_at IS NULL AND superseded_by IS NULL`
    ).bind(id, input.channel, destination, purpose),
    env.DB.prepare(
      `INSERT INTO auth_otp (id, channel, destination, purpose, user_id, verifier, max_attempts, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, input.channel, destination, purpose, input.userId, verifier, AUTH_OTP_MAX_ATTEMPTS, expiresAt),
  ]);

  let delivered: boolean | 'skipped' = false;
  try {
    delivered = await input.send(code);
  } catch (e) {
    // A transport that throws is a transport that failed. It must not unwind
    // the caller: the row is already written and has to be cleaned up.
    console.error('startAuthOtp: transport threw:', e instanceof Error ? e.message : String(e));
    delivered = false;
  }

  if (delivered === false) {
    await voidAuthOtp(env, id);
    return { ok: false, error: 'SEND_FAILED' };
  }

  if (delivered === true) {
    await env.DB.prepare("UPDATE auth_otp SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .bind(id)
      .run();
  }

  return {
    ok: true,
    expires_in_seconds: AUTH_OTP_TTL_SECONDS,
    resend_after_seconds: AUTH_OTP_RESEND_COOLDOWN_SECONDS,
  };
}

/** Consume a row without accepting it — an undelivered code is not pending. */
export async function voidAuthOtp(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE auth_otp SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND consumed_at IS NULL"
  )
    .bind(id)
    .run();
}

export type VerifyOtpOutcome =
  | { ok: true; user_id: string | null; challenge_id: string }
  | { ok: false; reason: 'no_challenge' | 'expired' | 'too_many_attempts' | 'wrong_code' };

/**
 * Verify and atomically consume.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY:
 *   expired?          → answered before an attempt is spent, so a stale code
 *                       cannot be used to drain the attempt budget
 *   claim an attempt  → conditional on attempts < max, so the claim itself is
 *                       the lock; two racing guesses cannot both be attempt 5
 *   shape check       → AFTER the claim, so junk input still costs
 *   timing-safe cmp   → a byte-by-byte compare leaks the prefix
 *   conditional consume → exactly one submitter wins
 *
 * Returns the row's `user_id` as RECORDED, which the caller must reconcile
 * against the account it resolves from the destination itself. This function
 * proves control of a destination; it does not decide who that is.
 */
export async function verifyAuthOtp(
  env: Env,
  channel: AuthOtpChannel,
  destination: string,
  code: string,
  purpose: AuthOtpPurpose = 'signin'
): Promise<VerifyOtpOutcome> {
  const trimmed = String(code ?? '').trim();
  const row = await env.DB.prepare(
    `SELECT id, user_id, verifier, expires_at FROM auth_otp
      WHERE channel = ? AND destination = ? AND purpose = ?
        AND consumed_at IS NULL AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(channel, destination, purpose)
    .first<{ id: string; user_id: string | null; verifier: string; expires_at: string }>();
  if (!row) return { ok: false, reason: 'no_challenge' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const claim = await env.DB.prepare(
    'UPDATE auth_otp SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND attempts < max_attempts'
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
    "UPDATE auth_otp SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND consumed_at IS NULL"
  )
    .bind(row.id)
    .run();
  if (!consume.meta || consume.meta.changes === 0) return { ok: false, reason: 'no_challenge' };

  return { ok: true, user_id: row.user_id, challenge_id: row.id };
}

/**
 * The message body, in the customer's language where we know it and in all
 * three otherwise.
 *
 * WHY THE WARNING IS NOT DECORATION. Every real-world OTP theft is somebody
 * persuading the holder to read the code aloud, so "we will never ask for it"
 * is the security control — the code itself is already sound. It is stated in
 * the language the customer chose, because a warning in a language they do
 * not read is not a warning.
 */
export function authOtpMessage(code: string, lang: 'ar' | 'en' | 'ckb'): { subject: string; text: string } {
  if (lang === 'en') {
    return {
      subject: `${code} is your LEVONIS sign-in code`,
      text:
        `LEVONIS\n\nYour sign-in code:\n\n${code}\n\n` +
        `It is valid for 10 minutes and can be used once.\n` +
        `Never share it. LEVONIS staff will never ask you for this code.\n` +
        `If you did not request it, ignore this message — nothing has changed.`,
    };
  }
  if (lang === 'ckb') {
    return {
      subject: `${code} کۆدی چوونەژوورەوەی LEVONIS`,
      text:
        `LEVONIS\n\nکۆدی چوونەژوورەوەت:\n\n${code}\n\n` +
        `بۆ ماوەی ١٠ خولەک کاردەکات و تەنها جارێک بەکاردێت.\n` +
        `لەگەڵ هیچ کەسێک بەشی مەکە. ستافی LEVONIS هەرگیز داوای ئەم کۆدەت لێ ناکات.\n` +
        `ئەگەر تۆ داوات نەکردووە، پشتگوێی بخە — هیچ نەگۆڕاوە.`,
    };
  }
  return {
    subject: `${code} رمز الدخول إلى LEVONIS`,
    text:
      `LEVONIS\n\nرمز الدخول الخاص بك:\n\n${code}\n\n` +
      `صالح لمدة ١٠ دقائق ويُستعمل مرة واحدة.\n` +
      `لا تشاركه مع أحد. فريق LEVONIS لن يطلبه منك أبداً.\n` +
      `إذا لم تطلبه، تجاهل هذه الرسالة — لم يتغيّر شيء.`,
  };
}
