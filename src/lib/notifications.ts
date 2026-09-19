/**
 * THE NOTIFICATION INBOX, from the browser's side.
 *
 * The server (worker/routes/notifications.ts) treats a notification as a
 * POINTER — a title, a line of context and an in-app path back to the thing it
 * is about — and this client keeps that promise rather than widening it. There
 * is no cache, no store and no merge logic here: three calls, typed, and the
 * screen that renders them owns its own state. A cache would immediately become
 * a second, staler copy of an inbox whose whole job is to be current.
 *
 * Kept beside `lib/api.ts` for the same reason `lib/merchant.ts` is: api.ts is
 * the file every page imports, and a feature only the bell and its panel need
 * has no business growing inside it.
 *
 * Every endpoint requires a session. A signed-out caller gets `ApiError` with
 * status 401 — not an empty list — so a caller can tell "nothing to show" from
 * "you are not the one being told".
 */

import { api } from './api';

/**
 * The kinds the server writes today. Deliberately NOT the row's type: the
 * server may add a kind before this bundle is redeployed, and a UI that
 * crashed — or silently dropped a row — on an unknown string would turn a new
 * backend feature into a frontend outage. Callers switch on this union and
 * fall through to a default.
 */
export type NotificationKind =
  | 'print_request_match'
  | 'offer_received'
  | 'offer_accepted'
  | 'order_update'
  /** «رد من الدعم» — staff answered a support ticket. */
  | 'support_reply';

export interface NotificationRow {
  id: string;
  /** One of `NotificationKind`, but read as an open set — see above. */
  kind: string;
  /** The text is stored per language, so it is read in the language of
   *  whoever is reading, not the one active when it was written. */
  title_ar: string;
  title_en: string;
  body_ar: string;
  body_en: string;
  /** An in-app PATH (`/requests?request=req_123`), never an absolute URL —
   *  safe to hand straight to react-router's navigate(). May be empty. */
  link: string;
  entity_type: string;
  entity_id: string;
  read: boolean;
  created_at: string;
}

export interface NotificationPage {
  /** The account's unread total — the WHOLE inbox, not this page. */
  unread: number;
  notifications: NotificationRow[];
  /** Feed back as `before` for the next page; null means the end. */
  next_before: string | null;
}

export interface ListNotificationsOptions {
  /** Server clamps to 1..50 and defaults to 25. */
  limit?: number;
  /** The `next_before` cursor of the previous page. */
  before?: string;
  unreadOnly?: boolean;
}

export interface MarkReadResult {
  /** How many rows this call actually changed — 0 when they were already
   *  read, which lets a caller skip a pointless list refresh. */
  marked: number;
  /** The unread total AFTER the write, so the badge never has to guess. */
  unread: number;
}

/** One page of the inbox, newest first. */
export function listNotifications(opts: ListNotificationsOptions = {}): Promise<NotificationPage> {
  const qs = new URLSearchParams();
  if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
  if (opts.before) qs.set('before', opts.before);
  if (opts.unreadOnly) qs.set('unread', '1');
  const q = qs.toString();
  return api.get<{ success: true } & NotificationPage>(`/api/notifications${q ? `?${q}` : ''}`);
}

/**
 * Just the badge number. Unwrapped from its envelope on purpose: this is the
 * one call that gets polled, and every call site wants the integer.
 */
export async function unreadCount(): Promise<number> {
  const r = await api.get<{ success: true; unread: number }>('/api/notifications/unread-count', { mascot: 'silent' });
  return r.unread;
}

/** Mark one notification read, or — with no id — the entire inbox. */
export function markRead(id?: string): Promise<{ success: true } & MarkReadResult> {
  return api.post<{ success: true } & MarkReadResult>('/api/notifications/read', id ? { id } : {});
}
