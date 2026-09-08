/**
 * The Telegram transport.
 *
 * MOVED from the TRANSPORT part of `worker/lib/telegram.ts` — `sendToChat` and
 * `notifyAdmins` — and nothing else. The OTP issuing, challenge and linking
 * logic in that file belongs to Identity and stays in the core; copying it here
 * would have moved an authentication surface into a Worker whose job is to
 * deliver messages.
 *
 * Three properties of the original are kept deliberately:
 *
 *   * plain text, no `parse_mode` — a user-supplied name cannot inject Telegram
 *     markup;
 *   * 4000-character cap, as the API requires;
 *   * the body is NEVER logged. A customer message may carry a one-time code,
 *     and the URL carries the bot token, so this file logs neither.
 *
 * Telegram has no idempotency header. `notify_outbox.event_key` is UNIQUE and
 * the pump claims a row with a compare-and-swap before sending, so a duplicate
 * send needs two processors to win the same claim — which the database refuses.
 */
import { fetchWithBudget, PROVIDER_BUDGETS } from '@levonis/platform-kit/httpx';
import { briefly, type OutboxMessage, type SendContext, type Transport, type TransportResult } from '../types';

export const TELEGRAM_API = 'https://api.telegram.org';
export const TELEGRAM_SECRET_NAMES = ['TELEGRAM_BOT_TOKEN'] as const;
/** Admin messages need the group as well; a customer message never goes there. */
export const TELEGRAM_ADMIN_SECRET_NAMES = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_CHAT_ID'] as const;
export const TEXT_MAX = 4000;

export const sendMessageUrl = (token: string): string => `${TELEGRAM_API}/bot${token}/sendMessage`;

export class TelegramTransport implements Transport {
  readonly channel = 'telegram' as const;
  readonly disabledReason = 'TELEGRAM_NOT_CONFIGURED';

  configured(env: Record<string, string | undefined>): boolean {
    return TELEGRAM_SECRET_NAMES.every((n) => (env[n] ?? '').trim().length > 0);
  }

  /** `telegramConfigured()` in the core: an admin message needs the group id too. */
  adminConfigured(env: Record<string, string | undefined>): boolean {
    return TELEGRAM_ADMIN_SECRET_NAMES.every((n) => (env[n] ?? '').trim().length > 0);
  }

  async send(message: OutboxMessage, env: Record<string, string | undefined>, ctx: SendContext): Promise<TransportResult> {
    if (message.kind !== 'telegram') return { ok: false, error: 'wrong transport for payload', retryable: false };
    if (!this.configured(env)) return { ok: false, error: this.disabledReason, disabled: true };
    const res = await fetchWithBudget(
      sendMessageUrl((env.TELEGRAM_BOT_TOKEN ?? '').trim()),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: message.chat_id,
          text: message.text.slice(0, TEXT_MAX),
          disable_web_page_preview: true,
        }),
      },
      {
        timeoutMs: ctx.timeoutMs ?? PROVIDER_BUDGETS.telegram.timeoutMs,
        retries: ctx.retries ?? PROVIDER_BUDGETS.telegram.retries,
        provider: 'telegram',
        fetchImpl: ctx.fetchImpl,
      }
    );
    if (res.ok) return { ok: true };
    // The PROVIDER's response is recorded (as `worker/lib/outbox.ts` already
    // does), never the message we sent — that may carry a one-time code.
    const body = await res.text().catch(() => '');
    return { ok: false, error: `telegram ${res.status}: ${briefly(body, 200)}`, retryable: res.status >= 500 || res.status === 429 };
  }
}
