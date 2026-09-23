/**
 * «الرسائل» — the customer conversations the shop has to answer, for staff.
 * /api/admin/chats/*
 *
 * WHAT WAS MISSING. A customer looking at an order is offered «محادثة حول هذا
 * الطلب — محادثة مباشرة مع الفريق» (src/components/orders/SupportActions.tsx).
 * Pressing it opens the order's own thread with the customer as its ONLY
 * participant: staff joined a thread only when somebody happened to open that
 * one order's chat tab in the order modal. Nothing listed these threads,
 * nothing counted them, and sending into one told nobody — so «محادثة مباشرة
 * مع الفريق» was a conversation with an empty room until an admin stumbled on
 * it. The owner's words for the result: there is no page in the admin to
 * answer users' messages.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT.
 *   • It LISTS order threads and says which are waiting. The thread itself is
 *     opened in the support console through the same `OrderChatPanel` the
 *     order modal uses, which joins the admin as a participant through
 *     `/api/chats/open` (worker/routes/chats.ts) — there is one way to write
 *     into an order thread, not two.
 *   • It is NOT a way to read people's direct messages. General chats between
 *     two users, and a merchant-store order's thread with its seller, stay the
 *     business of their participants (chats.ts: "no moderator backdoor"). Only
 *     threads about the SHOP's own orders — `orders.merchant_id IS NULL`, the
 *     orders whose "team" is this shop — appear here.
 *
 * «غير مقروءة» — WHAT UNREAD MEANS FOR A TEAM. `chat_participants.last_read_at`
 * is per person, and the queue is not: when one agent has read a thread it is
 * not waiting for the next one. So a customer message is unread by STAFF while
 * it is newer than both the last message anybody but the customer wrote and
 * the latest moment any non-customer participant read the thread. Replying
 * clears it; so does opening it (the messages GET stamps `last_read_at`).
 */

import { Hono } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { requireAdmin, str } from '../lib/http';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { chatAttachmentKind } from './chats';

export const adminChatRoutes = new Hono<AppContext>();
adminChatRoutes.use('*', requireAdmin);

/**
 * One row per order thread that has at least one message, with the team's
 * unread count computed in SQL. `MAX(a, b)` is SQLite's scalar max, which is
 * NULL when either side is — hence the COALESCE to '' on both, so a thread no
 * staff member has ever touched counts every customer line as unread.
 */
const ORDER_THREADS_SQL = `
  SELECT ch.id AS id,
         ch.order_id AS order_id,
         o.status AS order_status,
         o.user_id AS customer_id,
         u.name AS customer_name,
         u.username AS customer_username,
         u.email AS customer_email,
         lm.body AS last_body,
         lm.kind AS last_kind,
         lm.attachment_kind AS last_attachment_kind,
         lm.file_key AS last_file_key,
         lm.created_at AS last_at,
         CASE WHEN lm.sender_id = o.user_id THEN 1 ELSE 0 END AS last_from_customer,
         (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = ch.id) AS message_count,
         (SELECT COUNT(*) FROM chat_messages m
           WHERE m.chat_id = ch.id AND m.sender_id = o.user_id
             AND m.created_at > MAX(
               COALESCE((SELECT MAX(s.created_at) FROM chat_messages s
                          WHERE s.chat_id = ch.id AND s.sender_id <> o.user_id), ''),
               COALESCE((SELECT MAX(p.last_read_at) FROM chat_participants p
                          WHERE p.chat_id = ch.id AND p.user_id <> o.user_id), ''))) AS unread
    FROM chats ch
    JOIN orders o ON o.id = ch.order_id
    JOIN users u ON u.id = o.user_id
    JOIN chat_messages lm ON lm.id = (
      SELECT m2.id FROM chat_messages m2 WHERE m2.chat_id = ch.id
       ORDER BY m2.created_at DESC, m2.rowid DESC LIMIT 1)
   WHERE o.merchant_id IS NULL`;

/**
 * «الشكاوى» — IS THE BALL ON THE DESK? One SQL condition over a complaint
 * aliased `ct`, used by the counts below and by each row of the admin's
 * complaint list (worker/routes/adminCommunity.ts), so the badge and the
 * marker on the row can never disagree.
 *
 * It reads the THREAD, not only the status. Counting `submitted` and
 * `under_review` alone meant an admin's answer never cleared the badge (the
 * reply route deliberately leaves the status alone) and a reporter answering
 * back on a complaint already `under_review` never raised it. So: a complaint
 * that is still open waits on the desk when its latest PUBLIC message is from
 * the reporter or the merchant; when nobody has written in it yet, the status
 * decides, as before. Internal notes are the desk talking to itself and do
 * not count as an answer.
 */
export const COMPLAINT_AWAITS_DESK_SQL = `(ct.status NOT IN ('resolved','rejected','closed') AND COALESCE(
    (SELECT CASE WHEN lm.sender_role = 'admin' THEN 0 ELSE 1 END
       FROM community_complaint_messages lm
      WHERE lm.complaint_id = ct.id AND lm.internal = 0
      ORDER BY lm.created_at DESC, lm.rowid DESC LIMIT 1),
    CASE WHEN ct.status IN ('submitted','under_review') THEN 1 ELSE 0 END) = 1)`;

export interface SupportInboxCounts {
  /** Tickets whose ball is on this side of the desk: `open` + `waiting_staff`. */
  tickets_waiting: number;
  /** Order threads holding at least one customer line staff have not seen. */
  chats_unread: number;
  /** Open complaints waiting on the desk (`COMPLAINT_AWAITS_DESK_SQL`): never
   *  answered, or the reporter / merchant wrote last. */
  complaints_open: number;
}

/**
 * THE THREE QUEUES IN ONE READ — the numbers the sidebar badge, the console's
 * tabs and the dashboard tile all show, from one function so the three can
 * never disagree about how many people are waiting.
 */
export async function supportInboxCounts(db: D1Database): Promise<SupportInboxCounts> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM support_tickets WHERE state IN ('open','waiting_staff')) AS tickets_waiting,
         (SELECT COUNT(*) FROM (${ORDER_THREADS_SQL}) WHERE unread > 0) AS chats_unread,
         (SELECT COUNT(*) FROM community_complaints ct WHERE ${COMPLAINT_AWAITS_DESK_SQL}) AS complaints_open`
    )
    .first<SupportInboxCounts>();
  return {
    tickets_waiting: Number(row?.tickets_waiting) || 0,
    chats_unread: Number(row?.chats_unread) || 0,
    complaints_open: Number(row?.complaints_open) || 0,
  };
}

adminChatRoutes.get('/summary', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, ...(await supportInboxCounts(c.env.DB)) });
});

/**
 * The inbox: waiting threads first, then the most recently active. `filter=
 * unread` narrows to the waiting ones. The customer's identity is here because
 * this is the admin panel, where the person answering needs to know who they
 * are answering; the Telegram line (below) carries none of it.
 */
adminChatRoutes.get('/', async (c) => {
  const filter = str(c.req.query('filter'), 'filter', { max: 10, required: false });
  const where = filter === 'unread' ? 'WHERE unread > 0' : '';
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM (${ORDER_THREADS_SQL}) ${where}
      ORDER BY CASE WHEN unread > 0 THEN 0 ELSE 1 END, last_at DESC
      LIMIT 100`
  ).all<Record<string, unknown>>();
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    chats: results.map((r) => ({
      id: r.id,
      order_id: r.order_id,
      order_status: r.order_status,
      customer: {
        id: r.customer_id,
        name: r.customer_name ?? null,
        username: r.customer_username ?? null,
        email: r.customer_email ?? null,
      },
      last_message: {
        body: typeof r.last_body === 'string' ? r.last_body.slice(0, 160) : '',
        // What the last message IS, read the way every chat screen reads it
        // (chats.ts `chatMessagePublic`): `chat_messages.kind` only holds
        // 'text' or 'image', so a clip previewed as «صورة» and a voice note
        // or a PDF as a blank line until this looked at the attachment.
        kind:
          (typeof r.last_attachment_kind === 'string' && r.last_attachment_kind
            ? r.last_attachment_kind
            : chatAttachmentKind(r.last_file_key)) ?? r.last_kind ?? 'text',
        at: r.last_at,
        from_customer: Number(r.last_from_customer) === 1,
      },
      message_count: Number(r.message_count) || 0,
      unread: Number(r.unread) || 0,
    })),
  });
});

/**
 * THE DESK IS TOLD THAT A CUSTOMER WROTE — called by POST /api/chats/:id/messages
 * after the message is stored.
 *
 * Only for the shop's own order threads and only when the ORDER'S OWNER is the
 * sender: an admin's reply announcing itself to the admins would be noise, and
 * a merchant-store order's thread belongs to its seller. Only when the message
 * is news, too: the ticket rule (worker/routes/support.ts) — a customer typing
 * four lines in a row is one conversation waiting, not four, so a line whose
 * predecessor was also the customer's says nothing new and stays silent.
 *
 * No text, no name, no phone: this lands in a group chat that gets
 * screenshotted. The order id is what staff need to find the thread.
 *
 * TOTAL. It runs after the customer's message is committed; a failure here
 * must never turn a sent message into an error on their screen.
 */
export async function announceCustomerChatMessage(
  c: { env: Env },
  chatId: string,
  senderId: string,
  messageId: string
): Promise<void> {
  try {
    const row = await c.env.DB.prepare(
      `SELECT o.id AS order_id, o.user_id, o.merchant_id,
              (SELECT m.sender_id FROM chat_messages m
                WHERE m.chat_id = ch.id AND m.id <> ?2
                ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS prev_sender
         FROM chats ch JOIN orders o ON o.id = ch.order_id
        WHERE ch.id = ?1`
    )
      .bind(chatId, messageId)
      .first<{ order_id: string; user_id: string; merchant_id: string | null; prev_sender: string | null }>();
    if (!row || row.merchant_id || row.user_id !== senderId) return;
    if (row.prev_sender === senderId) return;
    announceAfterResponse(c, 'support', `💬 Customer message on order ${row.order_id}\nAnswer it in Admin → Support → Messages`);
  } catch (e) {
    console.error('announceCustomerChatMessage failed for', chatId, e instanceof Error ? e.message : String(e));
  }
}
