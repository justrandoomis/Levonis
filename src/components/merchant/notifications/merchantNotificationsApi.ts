/**
 * The store's notification centre, from the browser (worker/routes/
 * merchantNotifications.ts). Three calls, typed; the screen owns its state.
 * `kind` is read as an open set: a kind this bundle does not know yet still
 * renders (with the generic icon) rather than disappearing.
 */
import { api } from '../../../lib/api';

export interface MerchantNotification {
  id: string;
  kind: string;
  title_ar: string;
  title_en: string;
  body_ar: string;
  body_en: string;
  title_ckb?: string;
  body_ckb?: string;
  /** A workspace path, as stored (`/merchant/…`) — re-base it with `hostPath`. */
  link: string;
  entity_type: string;
  entity_id: string;
  read: boolean;
  created_at: string;
}

export interface MerchantNotificationPage {
  unread: number;
  unread_by_kind: Record<string, number>;
  notifications: MerchantNotification[];
  next_cursor: string | null;
}

export interface UnreadAnswer {
  unread: number;
  unread_by_kind: Record<string, number>;
}

export const merchantNotificationsApi = {
  feed(opts: { cursor?: string | null; unread?: boolean; kind?: string; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (opts.cursor) qs.set('cursor', opts.cursor);
    if (opts.unread) qs.set('unread', '1');
    if (opts.kind) qs.set('kind', opts.kind);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const q = qs.toString();
    return api.get<{ success: true } & MerchantNotificationPage>(`/api/merchant/notifications/feed${q ? `?${q}` : ''}`);
  },
  unreadCount() {
    return api.get<{ success: true } & UnreadAnswer>('/api/merchant/notifications/unread-count', { mascot: 'silent' });
  },
  markRead(id?: string) {
    return api.post<{ success: true; marked: number } & UnreadAnswer>('/api/merchant/notifications/read', id ? { id } : {});
  },
};
