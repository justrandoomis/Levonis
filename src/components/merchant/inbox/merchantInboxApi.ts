/**
 * The store's inbox, from the browser (worker/routes/merchantInbox.ts): the
 * store's own conversations — direct messages to the store, store orders'
 * threads and custom requests' threads — searched and paged on the server.
 * A thread is read and answered through /api/chats/:id (the Chat page), with
 * attachments exactly as today.
 */
import { api } from '../../../lib/api';

export type InboxKind = 'direct' | 'order' | 'request';

export interface InboxThread {
  id: string;
  kind: InboxKind;
  context_id: string;
  order_id: string | null;
  customer: { name: string; username: string } | null;
  last_message: string;
  last_message_at: string | null;
  last_from: 'store' | 'customer' | null;
  unread: number;
}

export const merchantInboxApi = {
  list(opts: { cursor?: string | null; q?: string; kind?: InboxKind | ''; unread?: boolean; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (opts.cursor) qs.set('cursor', opts.cursor);
    if (opts.q) qs.set('q', opts.q);
    if (opts.kind) qs.set('kind', opts.kind);
    if (opts.unread) qs.set('unread', '1');
    if (opts.limit) qs.set('limit', String(opts.limit));
    const q = qs.toString();
    return api.get<{ success: true; threads: InboxThread[]; next_cursor: string | null }>(`/api/merchant/inbox${q ? `?${q}` : ''}`);
  },
  unreadCount() {
    return api.get<{ success: true; threads: number; messages: number }>('/api/merchant/inbox/unread-count', { mascot: 'silent' });
  },
};
