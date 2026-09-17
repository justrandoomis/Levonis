/**
 * WHATSAPP, VIA WASENDERAPI — the transport, and nothing else.
 *
 * WasenderAPI is not a cloud API that talks to WhatsApp on our behalf the way
 * Resend talks to SMTP. It drives a REAL WHATSAPP ACCOUNT — a phone number the
 * shop owns, linked to the provider by QR code or passkey. Three consequences
 * shape every decision in this file, and none of them is a detail:
 *
 * 1. THE SESSION CAN BE LOGGED OUT WHILE THE KEY STAYS VALID. A correct API
 *    key with a disconnected session answers 4xx with "Session is not
 *    Connected", not 401. So "configured" is NOT "working": `wasenderStatus()`
 *    exists because the only honest way to tell an operator whether WhatsApp
 *    will be delivered is to ask, and SESSION_NOT_CONNECTED is a distinct
 *    error so the admin console can say *reconnect the phone* rather than
 *    *check your key*.
 *
 * 2. THE SEND RATE IS TINY AND PER-SESSION. The published limits are 256
 *    requests/minute on a paid plan — but ONE REQUEST PER FIVE SECONDS with
 *    Account Protection on, and on a trial plan 1/minute and 50/day. This is
 *    an order of magnitude below anything the shop's own rate limits assume.
 *    So: notifications go through the durable outbox (a 429 is a retry, not a
 *    lost message), OTP sends are direct but report RATE_LIMITED with a real
 *    `retry_after_seconds` from the provider's own header instead of
 *    pretending a code was sent, and we never retry a 429 inside one request —
 *    hammering it is what gets a WhatsApp number banned.
 *
 * 3. `to` IS OVERLOADED. The provider accepts an E.164 number, a `@handle`, a
 *    GROUP JID or a CHANNEL JID in the same field. A recipient string that
 *    reaches here unvalidated is therefore not merely a wrong number — a
 *    stored "phone" of `120363...@g.us` would broadcast a customer's OTP to a
 *    group. `assertE164()` is a security boundary, not tidiness: this module
 *    sends to E.164 numbers and refuses everything else.
 *
 * WIRE CONTRACT (wasenderapi.com/api-docs, verified against the published
 * docs rather than remembered):
 *   POST https://www.wasenderapi.com/api/send-message
 *     Authorization: Bearer <WASENDER_API_KEY>
 *     {"to": "+9647XXXXXXXXX", "text": "..."}
 *   → {"success": true, "data": {"msgId": 100000, "jid": "+964...", "status": "in_progress"}}
 *   error → {"success": false, "message": "...", "errors": {"field": ["..."]}}
 *   GET  https://www.wasenderapi.com/api/status  → {"status": "connected"}
 *
 * `status: "in_progress"` is the SUCCESS shape: the provider has accepted the
 * message, not delivered it. Nothing here may report delivery.
 */

import { fetchWithBudget } from '@levonis/platform-kit/httpx';
import type { Env } from './types';

export const WASENDER_SEND_ENDPOINT = 'https://www.wasenderapi.com/api/send-message';
export const WASENDER_STATUS_ENDPOINT = 'https://www.wasenderapi.com/api/status';

/** Budget: a WhatsApp send is a human waiting on an OTP, not a batch job. */
export const WASENDER_TIMEOUT_MS = 10_000;

/**
 * The provider's own session states, verbatim. `connected` is the only one
 * that can send; the rest each have a different remedy, which is why the
 * admin console shows the string rather than a boolean.
 */
export const WASENDER_SESSION_STATUSES = [
  'connecting',
  'connected',
  'disconnected',
  'need_scan',
  'need_passkey',
  'logged_out',
  'expired',
] as const;
export type WasenderSessionStatus = (typeof WASENDER_SESSION_STATUSES)[number];

export type WhatsAppSendError =
  /** No WASENDER_API_KEY — the feature is off, and callers must say so rather than fail silently. */
  | 'NOT_CONFIGURED'
  /** Not an E.164 number. Refused HERE, before the network — see §3 above. */
  | 'INVALID_RECIPIENT'
  /** 401/403: the key is wrong, revoked, or the subscription lapsed. */
  | 'UNAUTHORIZED'
  /** The WhatsApp account is not linked right now. An operator, not a retry, fixes this. */
  | 'SESSION_NOT_CONNECTED'
  /** 429. Carries retry_after_seconds when the provider tells us. */
  | 'RATE_LIMITED'
  /** 4xx the provider owns: validation, not-on-whatsapp, blocked. Retrying cannot help. */
  | 'REJECTED'
  /** 5xx, timeout or a dead connection. Retrying later can help. */
  | 'PROVIDER_DOWN';

export type WhatsAppSendResult =
  | { ok: true; msg_id: string | null; status: string | null }
  | { ok: false; error: WhatsAppSendError; detail?: string; retry_after_seconds?: number };

/** Retryable by a later attempt (the outbox); the rest are terminal for this payload. */
export const WHATSAPP_RETRYABLE_ERRORS: readonly WhatsAppSendError[] = [
  'PROVIDER_DOWN',
  'RATE_LIMITED',
  'SESSION_NOT_CONNECTED',
];

export function whatsappErrorIsRetryable(error: WhatsAppSendError): boolean {
  return WHATSAPP_RETRYABLE_ERRORS.includes(error);
}

/** Present-and-non-blank. A whitespace key is not a key (the EMAIL_FROM lesson). */
export function wasenderConfigured(env: Env): boolean {
  return (env.WASENDER_API_KEY || '').trim().length > 0;
}

/**
 * E.164 and ONLY E.164. Deliberately stricter than "starts with +": a handle,
 * a group JID (`…@g.us`) and a channel JID all pass a looser test and all
 * deliver a private message to an audience.
 */
const E164_RE = /^\+[1-9]\d{6,14}$/;

export function isE164(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && E164_RE.test(candidate);
}

/**
 * `X-RateLimit-Reset` is documented as SECONDS UNTIL THE WINDOW RESETS, not a
 * unix timestamp — reading it as an epoch would produce a 1.7-billion-second
 * cooldown. `Retry-After` (seconds) is honoured too because proxies add it.
 * A value outside a sane range is dropped rather than shown to a customer.
 */
export function retryAfterSeconds(headers: Headers): number | undefined {
  for (const name of ['retry-after', 'x-ratelimit-reset', 'x-ratelimit-daily-reset']) {
    const raw = headers.get(name);
    if (!raw) continue;
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0 && n <= 86_400) return Math.ceil(n);
  }
  return undefined;
}

/**
 * Map a provider response onto our vocabulary. The provider signals
 * "session not connected" as an ordinary 4xx with a message, so the body has
 * to be read — the status code alone cannot distinguish "reconnect the phone"
 * from "your payload was wrong", and those have opposite remedies.
 */
export function classifyWasenderFailure(status: number, body: string): { error: WhatsAppSendError; detail: string } {
  const detail = body.slice(0, 300);
  const lowered = body.toLowerCase();
  if (status === 401 || status === 403) {
    // A lapsed subscription answers 403 with a subscription message; both are
    // an operator's problem and neither is retryable.
    return { error: 'UNAUTHORIZED', detail };
  }
  if (status === 429) return { error: 'RATE_LIMITED', detail };
  if (status >= 500) return { error: 'PROVIDER_DOWN', detail };
  if (lowered.includes('not connected') || lowered.includes('session is not') || lowered.includes('disconnected')) {
    return { error: 'SESSION_NOT_CONNECTED', detail };
  }
  return { error: 'REJECTED', detail };
}

/**
 * Send one plain-text WhatsApp message.
 *
 * NEVER THROWS. Every caller here is a notification or an OTP beside a
 * business write that has already happened; a transport fault must not
 * unwind it. The result says what went wrong so the caller can be honest
 * about it.
 *
 * NO RETRY INSIDE ONE CALL. `retries: 0` is deliberate: /api/send-message is
 * not idempotent (there is no Idempotency-Key on this provider), so a retry
 * after an ambiguous timeout sends the message TWICE — and a retry after a
 * 429 is the exact behaviour that gets a WhatsApp number flagged. Durable
 * retry belongs to the outbox, which knows how long to wait.
 */
export async function sendWhatsAppText(
  env: Env,
  to: string,
  text: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<WhatsAppSendResult> {
  const key = (env.WASENDER_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'NOT_CONFIGURED' };
  if (!isE164(to)) return { ok: false, error: 'INVALID_RECIPIENT' };

  const body = String(text ?? '');
  if (!body.trim()) return { ok: false, error: 'INVALID_RECIPIENT', detail: 'empty message' };

  let res: Response;
  try {
    res = await fetchWithBudget(
      WASENDER_SEND_ENDPOINT,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        // WhatsApp's own per-message ceiling is far above this; the cap is
        // here so a runaway template can never post a megabyte.
        body: JSON.stringify({ to, text: body.slice(0, 4000) }),
      },
      { timeoutMs: WASENDER_TIMEOUT_MS, retries: 0, provider: 'wasender', fetchImpl: opts.fetchImpl }
    );
  } catch (e) {
    // fetchWithBudget throws on timeout/network; the key must never reach a log.
    return { ok: false, error: 'PROVIDER_DOWN', detail: scrub(e instanceof Error ? e.message : String(e), key) };
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    const { error, detail } = classifyWasenderFailure(res.status, raw);
    const after = retryAfterSeconds(res.headers);
    return {
      ok: false,
      error,
      detail: `wasender ${res.status}: ${scrub(detail, key)}`,
      ...(after !== undefined ? { retry_after_seconds: after } : {}),
    };
  }

  // A 200 whose body says success:false is a failure. The provider does this
  // for at least one case (validation), so trusting the status alone would
  // record a send that never happened.
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    /* a 2xx with an unreadable body is still an accepted send */
  }
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  if (obj && obj.success === false) {
    return { ok: false, error: 'REJECTED', detail: scrub(String(obj.message ?? raw).slice(0, 300), key) };
  }
  const data = obj && typeof obj.data === 'object' && obj.data ? (obj.data as Record<string, unknown>) : null;
  return {
    ok: true,
    msg_id: data && data.msgId != null ? String(data.msgId) : null,
    // "in_progress" — ACCEPTED, not delivered. Callers must not promise more.
    status: data && typeof data.status === 'string' ? data.status : null,
  };
}

export type WasenderStatusResult =
  | { ok: true; status: WasenderSessionStatus | string; can_send: boolean }
  | { ok: false; error: WhatsAppSendError; detail?: string };

/**
 * Ask the provider whether the shop's WhatsApp account is actually linked.
 *
 * This is what makes the admin console honest. `wasenderConfigured()` only
 * proves a secret is set; a shop whose phone logged out an hour ago still
 * answers true to that and silently stops delivering. Read-only and
 * idempotent, so unlike the send it may be retried.
 */
export async function wasenderStatus(env: Env, opts: { fetchImpl?: typeof fetch } = {}): Promise<WasenderStatusResult> {
  const key = (env.WASENDER_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'NOT_CONFIGURED' };
  let res: Response;
  try {
    res = await fetchWithBudget(
      WASENDER_STATUS_ENDPOINT,
      { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } },
      { timeoutMs: WASENDER_TIMEOUT_MS, retries: 1, provider: 'wasender', fetchImpl: opts.fetchImpl }
    );
  } catch (e) {
    return { ok: false, error: 'PROVIDER_DOWN', detail: scrub(e instanceof Error ? e.message : String(e), key) };
  }
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    const { error, detail } = classifyWasenderFailure(res.status, raw);
    return { ok: false, error, detail: `wasender ${res.status}: ${scrub(detail, key)}` };
  }
  let status = '';
  try {
    const parsed = JSON.parse(raw) as { status?: unknown };
    status = typeof parsed?.status === 'string' ? parsed.status : '';
  } catch {
    return { ok: false, error: 'PROVIDER_DOWN', detail: 'unreadable status body' };
  }
  return { ok: true, status, can_send: status === 'connected' };
}

/**
 * A bearer token that reaches a log is a leaked token. The provider echoes
 * request context in some errors, so scrubbing the exact key out of any
 * string we are about to store or print is cheaper than auditing every path
 * it can travel.
 */
export function scrub(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join('[redacted]');
}
