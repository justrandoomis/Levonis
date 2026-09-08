/**
 * `levonis-notifications` HTTP contract — `/api/notifications/*` (public) and
 * `/api/v1/notifications/admin/*` (`01-TARGET.md` row 12, `02-MIGRATION-PLAN.md`
 * 1.7 / Phase 4).
 *
 * The PUBLIC shapes below are today's core responses field for field
 * (`worker/routes/notifications.ts`): the prefix flip must be invisible to the
 * SPA, so this file is the pin, not a redesign. Type-only.
 */
import type { NotificationChannel } from '../rpc/notifications';

/** One row of `user_notifications` as the SPA sees it. */
export interface NotificationItem {
  id: string;
  kind: string;
  title_ar: string;
  title_en: string;
  body_ar: string | null;
  body_en: string | null;
  link: string | null;
  entity_type: string | null;
  entity_id: string | null;
  /** `read_at !== null` — the timestamp itself is not exposed */
  read: boolean;
  created_at: string;
}

/** `GET /api/notifications?limit=&before=&unread=1` */
export interface NotificationListResponse {
  success: true;
  unread: number;
  notifications: NotificationItem[];
  /**
   * The oldest `created_at` of the page, or `null` when the page was short —
   * which is how the client knows it has reached the end.
   */
  next_before: string | null;
}

/** `GET /api/notifications/unread-count` */
export interface UnreadCountResponse {
  success: true;
  unread: number;
}

/** `POST /api/notifications/read` with `{ id? }` — no id marks everything read. */
export interface MarkReadResponse {
  success: true;
  marked: number;
  unread: number;
}

/** Terminal outcomes are `sent`, `dropped` and `dead`; `dead` is replayable. */
export type NotifyDeliveryStatus = 'pending' | 'sent' | 'failed' | 'dead' | 'dropped';

/** One row of `notify_deliveries` (admin view). */
export interface NotifyDeliveryRow {
  id: string;
  /** the Resend `Idempotency-Key`: one delivery per key, forever */
  event_key: string;
  channel: NotificationChannel;
  template: string;
  status: NotifyDeliveryStatus;
  attempts: number;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

/** `GET /api/v1/notifications/admin/deliveries?channel=&status=&limit=&cursor=` */
export interface NotifyDeliveriesResponse {
  success: true;
  rows: NotifyDeliveryRow[];
  next: string | null;
  /** oldest unsent row's age; the §11.4 golden signal for this service */
  outbox_lag_s: number | null;
}

/**
 * `POST /api/telegram/webhook` — the only unauthenticated ingress. It answers
 * `200 {ok:true}` to every well-formed update (Telegram retries anything else),
 * and the dedup happens in `telegram_updates`, so a replay is `duplicate:true`.
 */
export interface TelegramWebhookResponse {
  ok: true;
  duplicate?: boolean;
}
