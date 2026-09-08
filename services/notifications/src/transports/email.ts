/**
 * The email transport — Resend.
 *
 * MOVED, not rewritten: the request is the one `worker/lib/outbox.ts`
 * `deliver()` makes today, field for field, including the two things that are
 * easy to lose in a port and expensive to lose in production:
 *
 *   * `Idempotency-Key: <event_key>` (truncated to 256). Provider-side dedup:
 *     retries of the same business event reuse the key, so an ambiguous first
 *     attempt — a timeout after the provider accepted — cannot double-send.
 *   * `EMAIL_ALLOWED_RECIPIENTS`, the staging guard. A recipient outside the
 *     allowlist is `skipped` with the reason recorded, never silently dropped
 *     and never sent. `EMAIL_ALLOWLIST_REQUIRED=on` additionally makes an
 *     EMPTY allowlist mean "nobody" instead of "everybody" — the dark stack's
 *     setting, where mailing a real customer is the failure to prevent.
 *
 * The core's copy stays where it is and keeps sending until Phase 3
 * (`02-MIGRATION-PLAN.md` 1.7). This is a second, dark implementation, not a
 * replacement — which is why the difference from the original is limited to
 * going through `fetchWithBudget` (8 s, 2 retries — `01-TARGET.md` §11.5) and
 * returning a typed result instead of a bare boolean.
 */
import { fetchWithBudget, PROVIDER_BUDGETS } from '@levonis/platform-kit/httpx';
import { briefly, type OutboxMessage, type SendContext, type Transport, type TransportResult } from '../types';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
export const EMAIL_SECRET_NAMES = ['EMAIL_API_KEY', 'EMAIL_FROM'] as const;
export const IDEMPOTENCY_KEY_MAX = 256;

/**
 * The staging guard, carried over verbatim — with one addition the dark stack
 * needs.
 *
 * The core's semantics are "empty allowlist = everyone", which is right for
 * production, where the allowlist is a staging convenience. It is exactly
 * wrong for the dark stack, whose whole point is that a dark run cannot mail a
 * real customer: an unset var there means the guard is silently OFF while the
 * config comments say it is on, and `NOTIFY_DELIVERY` is `on` in dark.
 *
 * `EMAIL_ALLOWLIST_REQUIRED=on` inverts the empty case to DENY. It is a
 * separate var rather than a change to the existing one because the two
 * environments genuinely want opposite defaults, and because an operator
 * reading `EMAIL_ALLOWED_RECIPIENTS: ""` should not have to know which of the
 * two meanings this deployment gives it.
 */
export function allowedRecipient(allowlist: string | undefined, recipient: string, opts: { requireAllowlist?: boolean } = {}): boolean {
  const allow = (allowlist || '').trim();
  if (!allow) return !opts.requireAllowlist;
  return allow
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes(recipient.toLowerCase());
}

export class EmailTransport implements Transport {
  readonly channel = 'email' as const;
  readonly disabledReason = 'EMAIL_NOT_CONFIGURED';

  configured(env: Record<string, string | undefined>): boolean {
    return EMAIL_SECRET_NAMES.every((n) => (env[n] ?? '').trim().length > 0);
  }

  async send(message: OutboxMessage, env: Record<string, string | undefined>, ctx: SendContext): Promise<TransportResult> {
    if (message.kind !== 'email') return { ok: false, error: 'wrong transport for payload', retryable: false };
    if (!this.configured(env)) return { ok: false, error: this.disabledReason, disabled: true };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${(env.EMAIL_API_KEY ?? '').trim()}`,
      'Content-Type': 'application/json',
    };
    if (ctx.eventKey) headers['Idempotency-Key'] = ctx.eventKey.slice(0, IDEMPOTENCY_KEY_MAX);
    const res = await fetchWithBudget(
      RESEND_ENDPOINT,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: (env.EMAIL_FROM ?? '').trim(),
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      },
      {
        timeoutMs: ctx.timeoutMs ?? PROVIDER_BUDGETS.resend.timeoutMs,
        retries: ctx.retries ?? PROVIDER_BUDGETS.resend.retries,
        provider: 'resend',
        fetchImpl: ctx.fetchImpl,
      }
    );
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    return { ok: false, error: `resend ${res.status}: ${briefly(body)}`, retryable: res.status >= 500 || res.status === 429 };
  }
}
