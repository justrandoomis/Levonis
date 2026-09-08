/**
 * The domain types of `levonis-notifications`, and the transport interface both
 * adapters sit behind.
 *
 * They live at the top of `src/` rather than inside `src/transports/` because
 * the store and the HTTP surface need them too, and
 * `tests/serviceBoundaries.test.ts` forbids one package directory inside a
 * deployable from reaching into another's internals (ADR-004).
 */
import type { NotificationChannel } from '@levonis/contracts/rpc/notifications';

export type { NotificationChannel };

/** The two payload shapes an outbox row can hold — the core's `OutboxEmail` / `OutboxTelegram`, verbatim. */
export interface OutboxEmail {
  kind: 'email';
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface OutboxTelegram {
  kind: 'telegram';
  chat_id: number | string;
  text: string;
}

export type OutboxMessage = OutboxEmail | OutboxTelegram;

/** One row of `notify_outbox`, the legacy `outbox` shape. */
export interface OutboxRow {
  id: string;
  kind: 'email' | 'telegram';
  event_key: string;
  recipient: string;
  payload: string;
  state: 'pending' | 'sent' | 'failed' | 'dead' | 'skipped';
  attempts: number;
  last_error: string;
  created_at: string;
  sent_at: string | null;
}

export interface TransportResult {
  ok: boolean;
  /** absent on success. Never contains a credential. */
  error?: string;
  /** `true` when the transport is not configured — the row is `dropped`, not retried */
  disabled?: boolean;
  /** `true` when the failure is worth retrying (5xx, timeout, network) */
  retryable?: boolean;
}

export interface SendContext {
  /**
   * The provider `Idempotency-Key` — always the outbox row's `event_key`
   * (`03-EVENTS.md` §2.5). Retries of the same business event reuse it, so an
   * ambiguous first attempt (a timeout after the provider accepted) cannot
   * double-send.
   */
  eventKey: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

/**
 * The one interface both transports sit behind.
 *
 * `configured()` is the whole of the "delivery disabled unless the secret names
 * exist" rule: a transport that answers false is never called, its row is
 * recorded `dropped` with the reason, and no request is made.
 */
export interface Transport {
  readonly channel: Exclude<NotificationChannel, 'inapp'>;
  configured(env: Record<string, string | undefined>): boolean;
  /** the reason recorded on a `dropped` row when `configured()` is false */
  readonly disabledReason: string;
  send(message: OutboxMessage, env: Record<string, string | undefined>, ctx: SendContext): Promise<TransportResult>;
}

/** An in-app notification, as `worker/lib/notifications.ts` defines it. */
export interface NotificationInput {
  userId: string;
  kind: string;
  title_ar: string;
  title_en: string;
  body_ar?: string;
  body_en?: string;
  /** an in-app PATH, never an absolute URL: a stored origin is a stored mistake */
  link: string;
  entity_type?: 'request' | 'offer' | 'order' | '';
  entity_id?: string;
  meta?: Record<string, unknown>;
  /** unique per user; empty means "no replay protection wanted" */
  eventKey?: string;
}

/** Truncates a provider's error body so an outbox row can never become a data sink. */
export const briefly = (s: string, max = 300): string => (s.length > max ? `${s.slice(0, max)}…` : s);
