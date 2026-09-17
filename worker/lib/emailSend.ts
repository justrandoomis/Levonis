/**
 * THE IMMEDIATE EMAIL SEND — one implementation, finally.
 *
 * Outbound mail leaves this Worker two ways: queued through the durable
 * outbox (`lib/outbox.ts`, retried by cron), and IMMEDIATELY, when a human is
 * waiting on the other end — a password-reset link, a sign-in code. This
 * module is the second one, lifted out of `routes/auth.ts` so that the
 * staging allowlist, the configuration check and the timeout are decided in a
 * single place instead of being re-typed at each call site.
 *
 * TWO THINGS ARE FIXED HERE, not just moved.
 *
 * 1. `EMAIL_FROM` IS TRIMMED EVERYWHERE NOW. It was trim-checked in
 *    /api/auth/capabilities and in the admin providers panel, and falsy-checked
 *    in the six places that actually send. With `EMAIL_FROM=" "` the two
 *    disagreed: the UI was told mail is OFF (so the sign-up form asked for a
 *    password) while /register took the email-first branch and every send
 *    POSTed a blank `from` for a provider 422. A whitespace value is not a
 *    value — `emailConfigured()` is now the one answer to that question, and
 *    the address it sends is the trimmed one.
 *
 * 2. THERE IS A TIMEOUT. Both live Resend calls used bare `fetch`. A hung
 *    provider connection holds a Worker subrequest open with nothing to
 *    cancel it, and on this path that is an auth response a person is staring
 *    at. Eight seconds is Resend's budget in `PROVIDER_BUDGETS`; the send is
 *    NOT retried here (an immediate send carries no Idempotency-Key, so a
 *    retry after an ambiguous timeout mails the customer twice).
 *
 * WHAT DOES NOT CHANGE: failures are reported as `false` and never thrown.
 * Every caller is beside a business decision that must not be undone because
 * a mail provider blinked, and the outward HTTP response must not vary with
 * whether a particular address exists — that is the anti-enumeration rule the
 * reset flow is built on.
 */

import { fetchWithBudget, PROVIDER_BUDGETS } from '@levonis/platform-kit/httpx';
import type { Env } from './types';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Present AND non-blank, both names. The single answer to "can we mail?". */
export function emailConfigured(env: Env): boolean {
  return (env.EMAIL_API_KEY || '').trim().length > 0 && (env.EMAIL_FROM || '').trim().length > 0;
}

/**
 * The staging guard. An empty allowlist normally means "everyone" — the live
 * shop has to be able to mail real customers — but a deployment that must NOT
 * reach a real address sets `EMAIL_ALLOWLIST_REQUIRED=on`, which flips the
 * empty case to "nobody". Carried over verbatim from routes/auth.ts and
 * lib/outbox.ts, which agreed on it.
 */
export function emailAllowsRecipient(env: Env, to: string): boolean {
  const allowed = (env.EMAIL_ALLOWED_RECIPIENTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return (env.EMAIL_ALLOWLIST_REQUIRED || '').trim().toLowerCase() !== 'on';
  return allowed.includes(to.trim().toLowerCase());
}

export interface SendEmailOptions {
  /** Provider-side dedup key. Only pass one where the SAME business event can
   *  legitimately be sent twice — an immediate send has no such key. */
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Send one message now. Returns whether the provider accepted it — which is
 * acceptance, not delivery, and no caller may claim otherwise.
 */
export async function sendEmailNow(
  env: Env,
  to: string,
  subject: string,
  html: string,
  text: string,
  opts: SendEmailOptions = {}
): Promise<boolean> {
  const key = (env.EMAIL_API_KEY || '').trim();
  const from = (env.EMAIL_FROM || '').trim();
  if (!key || !from) return false;

  if (!emailAllowsRecipient(env, to)) {
    // Never silent: an operator reading logs has to be able to tell a blocked
    // staging send from a provider failure, because they have opposite fixes.
    console.warn('sendEmailNow: recipient outside EMAIL_ALLOWED_RECIPIENTS — send skipped (staging guard)');
    return false;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  // Resend documents 256 as the maximum length of this header.
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey.slice(0, 256);

  try {
    const res = await fetchWithBudget(
      RESEND_ENDPOINT,
      { method: 'POST', headers, body: JSON.stringify({ from, to, subject, html, text }) },
      {
        timeoutMs: PROVIDER_BUDGETS.resend.timeoutMs,
        // No retry without an idempotency key: an ambiguous timeout after the
        // provider accepted would mail the customer twice.
        retries: opts.idempotencyKey ? PROVIDER_BUDGETS.resend.retries : 0,
        provider: 'resend',
        fetchImpl: opts.fetchImpl,
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // The status and the provider's own message, never the key.
      console.error(`sendEmailNow: provider responded ${res.status}: ${detail.slice(0, 500)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('sendEmailNow: request failed:', e instanceof Error ? e.message : String(e));
    return false;
  }
}
