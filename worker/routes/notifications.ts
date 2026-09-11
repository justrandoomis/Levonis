import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, str, int } from '../lib/http';
import { listNotifications, markRead, unreadCount } from '../lib/notifications';

/**
 * THE NOTIFICATION INBOX.
 *
 * Small on purpose. A notification is a pointer: a title, a line of context and
 * a link back to the thing it is about. Everything else — the request, the
 * offer, the order — is fetched from the route that owns it, so this endpoint
 * can never become a second, staler copy of the data it points at.
 *
 * Every query is scoped to `c.get('user').id` in SQL, so a guessed id belonging
 * to someone else returns nothing and marks nothing.
 */

export const notificationRoutes = new Hono<AppContext>();
notificationRoutes.use('*', requireAuth);

notificationRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const q = c.req.query();
  const limit = int(q.limit, 'limit', { min: 1, max: 50, def: 25 });
  const before = str(q.before, 'before', { max: 40, required: false }) ?? '';
  const [items, unread] = await Promise.all([
    listNotifications(c.env.DB, user.id, {
      limit,
      before: before || undefined,
      unreadOnly: q.unread === '1',
    }),
    unreadCount(c.env.DB, user.id),
  ]);
  return c.json({
    success: true,
    unread,
    notifications: items.map((n) => ({
      id: n.id,
      kind: n.kind,
      title_ar: n.title_ar,
      title_en: n.title_en,
      body_ar: n.body_ar,
      body_en: n.body_en,
      link: n.link,
      entity_type: n.entity_type,
      entity_id: n.entity_id,
      read: n.read_at !== null,
      created_at: n.created_at,
    })),
    // The cursor is the oldest row returned; absent when the page was short,
    // which is how the client knows it has reached the end.
    next_before: items.length === limit ? items[items.length - 1].created_at : null,
  });
});

/** Just the badge. Cheap enough to poll, and backed by a partial index. */
notificationRoutes.get('/unread-count', async (c) => {
  const user = c.get('user')!;
  return c.json({ success: true, unread: await unreadCount(c.env.DB, user.id) });
});

notificationRoutes.post('/read', async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = str(body.id, 'id', { max: 60, required: false }) ?? '';
  const changed = await markRead(c.env.DB, user.id, id || undefined);
  return c.json({ success: true, marked: changed, unread: await unreadCount(c.env.DB, user.id) });
});
