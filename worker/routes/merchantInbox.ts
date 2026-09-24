/**
 * THE STORE'S INBOX — /api/merchant/inbox.
 *
 *   GET /?cursor=&q=&kind=&unread=1&limit=   the store's conversations, most
 *                                            recent activity first
 *   GET /unread-count                        conversations and messages unread
 *
 * WHICH THREADS. A thread the STORE owns (`chats.store_id`, written when the
 * thread is opened — worker/routes/chats.ts: a direct message to the store,
 * a store order's thread, a request's thread) AND in which the caller is a
 * participant. Both, always, in SQL: a thread stamped with this store that
 * the owner is somehow not a member of is not listed, and nobody's personal
 * conversations are (the owner's own purchases stay in /chats). There is no
 * id in the request to swap — the store comes from the session.
 *
 *   kind   direct (a customer wrote to the store) · order (a store order's
 *          thread) · request (a custom request's thread) · omitted = all
 *   q      searched on the server: the customer's name or username, the order
 *          or request id, and the text of the thread's messages
 *   unread 1 = only threads with a message from the other side the owner has
 *          not read
 *
 * Paging is by cursor (`<last activity>|<id>`), so a page boundary never
 * drops or repeats a thread that shares a timestamp. The thread itself is
 * read and written through /api/chats/:id — attachments exactly as today.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, str, int, badRequest } from '../lib/http';
import { requireStoreOwner } from '../lib/merchantAuth';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { rateLimit } from '../lib/ratelimit';

export const merchantInboxRoutes = new Hono<AppContext>();
merchantInboxRoutes.use('*', requireAuth);

/** The query names, and the `chats.context_type` each one is. */
export const INBOX_KINDS = { direct: 'store', order: 'store_order', request: 'request' } as const;
export type InboxKind = keyof typeof INBOX_KINDS;
const KIND_OF_CONTEXT: Record<string, InboxKind> = { store: 'direct', store_order: 'order', request: 'request' };

/** Messages from the other side the caller has not read (`?1` = the caller). */
const UNREAD_SQL = `(SELECT COUNT(*) FROM chat_messages m
                      WHERE m.chat_id = ch.id AND m.sender_id <> ?1
                        AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at))`;

merchantInboxRoutes.get('/', async (c) => {
  const ctx = await requireStoreOwner(c);
  const me = c.get('user')!.id;
  const q = c.req.query();
  const limit = int(q.limit, 'limit', { min: 1, max: 50, def: 30 });
  const kindRaw = str(q.kind, 'kind', { max: 20, required: false });
  if (kindRaw && !(kindRaw in INBOX_KINDS)) throw badRequest('kind must be direct, order or request', 'BAD_KIND');
  const search = str(q.q, 'q', { max: 100, required: false });
  if (search) await rateLimit(c, 'merchant-inbox-search', 60, 60);
  const pattern = likePattern(search);
  const cursorRaw = str(q.cursor, 'cursor', { max: 120, required: false });
  const bar = cursorRaw.lastIndexOf('|');
  const cursor = bar === -1 ? null : { at: cursorRaw.slice(0, bar), id: cursorRaw.slice(bar + 1) };

  const where = ['ch.store_id = ?2'];
  const binds: unknown[] = [me, ctx.store.id];
  let n = binds.length;
  const param = (v: unknown) => {
    binds.push(v);
    return `?${++n}`;
  };
  if (kindRaw) where.push(`ch.context_type = ${param(INBOX_KINDS[kindRaw as InboxKind])}`);
  else where.push(`ch.context_type IN ('store','store_order','request')`);
  if (q.unread === '1') where.push(`${UNREAD_SQL} > 0`);
  if (cursor) {
    const at = param(cursor.at);
    const id = param(cursor.id);
    where.push(`(COALESCE(ch.last_message_at, '') < ${at} OR (COALESCE(ch.last_message_at, '') = ${at} AND ch.id < ${id}))`);
  }
  if (pattern) {
    const p = param(pattern);
    where.push(`(
      ${sqlLikeClause(['ch.context_id'], p)}
      OR EXISTS (SELECT 1 FROM chat_participants o JOIN users u ON u.id = o.user_id
                  WHERE o.chat_id = ch.id AND o.user_id <> ?1 AND (${sqlLikeClause(['u.name', 'u.username'], p)}))
      OR EXISTS (SELECT 1 FROM chat_messages sm WHERE sm.chat_id = ch.id AND (${sqlLikeClause(['sm.body'], p)}))
    )`);
  }
  const lim = param(limit + 1);

  const { results } = await c.env.DB.prepare(
    `SELECT ch.id, ch.context_type, ch.context_id, ch.order_id, ch.last_message_at,
            ${UNREAD_SQL} AS unread,
            (SELECT CASE
                      WHEN m.body <> '' THEN substr(m.body, 1, 140)
                      WHEN m.attachment_kind = 'audio' THEN '🎤'
                      WHEN m.attachment_kind = 'file' THEN '📄'
                      WHEN m.attachment_kind = 'video' THEN '🎬'
                      WHEN m.file_key IS NOT NULL THEN '📷'
                      ELSE '' END
               FROM chat_messages m WHERE m.chat_id = ch.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
            (SELECT m.sender_id = ?1 FROM chat_messages m WHERE m.chat_id = ch.id
              ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_is_mine,
            (SELECT o.user_id FROM chat_participants o WHERE o.chat_id = ch.id AND o.user_id <> ?1
              ORDER BY CASE o.role WHEN 'customer' THEN 0 ELSE 1 END LIMIT 1) AS customer_id
       FROM chats ch
       JOIN chat_participants cp ON cp.chat_id = ch.id AND cp.user_id = ?1
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(ch.last_message_at, '') DESC, ch.id DESC
      LIMIT ${lim}`
  )
    .bind(...binds)
    .all<{
      id: string;
      context_type: string;
      context_id: string;
      order_id: string | null;
      last_message_at: string | null;
      unread: number;
      last_message: string | null;
      last_is_mine: number | null;
      customer_id: string | null;
    }>();

  const rows = (results ?? []).slice(0, limit);
  // The customers' display names in ONE read (json_each: no bound-parameter ceiling).
  const ids = [...new Set(rows.map((r) => r.customer_id).filter((v): v is string => !!v))];
  const names = new Map<string, { name: string; username: string }>();
  if (ids.length) {
    const { results: people } = await c.env.DB.prepare(
      'SELECT id, name, username FROM users WHERE id IN (SELECT value FROM json_each(?))'
    )
      .bind(JSON.stringify(ids))
      .all<{ id: string; name: string | null; username: string | null }>();
    for (const u of people ?? []) names.set(u.id, { name: String(u.name ?? ''), username: String(u.username ?? '') });
  }
  const last = rows[rows.length - 1];
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    threads: rows.map((r) => ({
      id: r.id,
      kind: KIND_OF_CONTEXT[r.context_type] ?? 'direct',
      context_id: r.context_id,
      order_id: r.order_id,
      customer: r.customer_id ? names.get(r.customer_id) ?? { name: '', username: '' } : null,
      last_message: r.last_message ?? '',
      last_message_at: r.last_message_at,
      last_from: r.last_is_mine === null ? null : Number(r.last_is_mine) ? 'store' : 'customer',
      unread: Number(r.unread) || 0,
    })),
    next_cursor: (results ?? []).length > limit && last ? `${last.last_message_at ?? ''}|${last.id}` : null,
  });
});

merchantInboxRoutes.get('/unread-count', async (c) => {
  const ctx = await requireStoreOwner(c);
  const me = c.get('user')!.id;
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS threads, COALESCE(SUM(u.n), 0) AS messages FROM (
       SELECT ${UNREAD_SQL} AS n
         FROM chats ch
         JOIN chat_participants cp ON cp.chat_id = ch.id AND cp.user_id = ?1
        WHERE ch.store_id = ?2 AND ch.context_type IN ('store','store_order','request')
          AND (cp.last_read_at IS NULL OR COALESCE(ch.last_message_at, '') > cp.last_read_at)
     ) u WHERE u.n > 0`
  )
    .bind(me, ctx.store.id)
    .first<{ threads: number; messages: number }>();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, threads: Number(row?.threads ?? 0), messages: Number(row?.messages ?? 0) });
});
