import { setChatTyping, remoteChatTyping } from '../lib/chatPresence';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { requireAuth, badRequest, notFound, forbidden, str, int, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { headMediaObject } from '../lib/mediaStorage';
import { isSchemaMissing } from '../lib/membershipBenefits';
import { audit } from '../lib/audit';
import { notify } from '../lib/notifications';
import { newMessageNotice, notifyMerchant } from '../lib/merchantNotify';
import { announceCustomerChatMessage } from './adminChats';
import { storeOrderThread, storeThreadOf, threadRole, type StoreThread } from '../lib/chatThread';
import {
  SENDABLE_CARDS,
  cardInsertStatement,
  cardPublic,
  clientIdFrom,
  currentCardStates,
  isCardType,
  resolveSendableCard,
  stampThreadActivity,
  type CardCurrent,
} from '../lib/chatCards';
import { storeById } from '../lib/merchantAuth';
import { storeTakesOrders } from '../lib/storeOrderOps';
import { merchantTakesNewWork } from '../lib/communityRequests';
import { communityMayEnter, readCommunityGate } from '../lib/communityGate';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { safeParse } from '../lib/types';

/**
 * Direct chats. Only participants can read or write a conversation; there is
 * no moderator backdoor by default.
 *
 * THE ONE STAFF EXCEPTION, AND HOW IT IS BOUNDED (audit 04 B6, DECISIONS.md).
 * A merchant-store order's thread belongs to the customer and the seller. An
 * admin handling a dispute or a complaint about that order may READ it — and
 * only read it: they are never added as a participant (so nobody's list, typing
 * dots or unread counts change), they cannot write into it, and every look is
 * an audit row (`admin.chat_read`, one per admin per thread per hour). The
 * shop's OWN order threads are different — there the admin IS the other party,
 * the support desk (worker/routes/adminChats.ts), and joins as before.
 */
export const chatRoutes = new Hono<AppContext>();
chatRoutes.use('*', requireAuth);

async function assertParticipant(db: D1Database, chatId: string, userId: string): Promise<void> {
  const row = await db
    .prepare('SELECT 1 AS x FROM chat_participants WHERE chat_id = ? AND user_id = ?')
    .bind(chatId, userId)
    .first();
  if (!row) throw forbidden('You are not part of this conversation');
}

/**
 * MAY THIS ACCOUNT WRITE IN THIS THREAD — send a message, attach a file, or
 * show «يكتب…»? The ONE rule every write door asks (review S3).
 *
 * A participant, always; and on a merchant-store order's thread only its
 * customer and its seller. An admin a pre-0118 thread silently joined is still
 * a participant row: the message door refused them CHAT_READ_ONLY while the
 * typing indicator and the upload door asked participation alone, so staff
 * could still drive «يكتب…» on both sides and store files under a thread they
 * may only read. Migration 0119 removes those rows; this refuses them even
 * where one survives.
 */
export async function assertMayWriteInThread(db: D1Database, chatId: string, userId: string): Promise<void> {
  await assertParticipant(db, chatId, userId);
  const thread = await storeOrderThread(db, chatId);
  if (thread && userId !== thread.customer_id && userId !== thread.seller_id) {
    throw new HttpError(403, 'Staff can read this conversation but not write in it', 'CHAT_READ_ONLY');
  }
}

/**
 * The staff read of a merchant↔customer thread, recorded — once per admin per
 * thread per hour, because the thread screen re-reads every few seconds and an
 * audit row per poll would bury the one fact that matters: WHO looked, WHEN.
 * The dedupe is the rate limiter's own fixed-window row (`rate_limits`, keyed
 * by its primary key), so it costs one indexed upsert, not an audit-log scan.
 */
async function auditStaffRead(c: Context<AppContext>, chatId: string, orderId: string): Promise<void> {
  const admin = c.get('user')!;
  const now = Math.floor(Date.now() / 1000);
  const hour = now - (now % 3600);
  const seen = await c.env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`
  )
    .bind(`chat-staff-read:${admin.id}:${chatId}`, hour)
    .first<{ count: number }>();
  if (Number(seen?.count) === 1) {
    await audit(c.env.DB, admin.id, 'admin.chat_read', chatId, { order: orderId, read_only: true });
  }
}

/**
 * A FILE FROM A STORE THREAD, OPENED BY STAFF WHO ONLY READ IT (audit 04 #11).
 *
 * `/files/chat/<chat id>/…` serves a non-participant admin the file
 * (worker/routes/uploads.ts) — the same read-only access the thread itself
 * gives staff — and that access is recorded the same way: one `admin.chat_read`
 * row per admin, thread and hour, shared with the thread read. The shop's own
 * threads are the support desk's work, not a merchant↔customer conversation,
 * so nothing is written for them.
 */
export async function recordStaffChatFileRead(c: Context<AppContext>, chatId: string): Promise<void> {
  const thread = await storeOrderThread(c.env.DB, chatId);
  if (thread) await auditStaffRead(c, chatId, thread.order_id);
}

// The thread's parties (StoreThread, storeThreadOf) live in worker/lib/chatThread.ts.

/**
 * WHO EACH MEMBER IS (chat_participants.role, migration 0124) — written after
 * the membership rows, and best-effort: membership is the access rule, the
 * role only names the sides, so a database a migration behind still opens
 * every thread.
 */
async function setRoles(db: D1Database, chatId: string, roles: Array<[string, 'customer' | 'merchant' | 'support']>): Promise<void> {
  try {
    await db.batch(
      roles.map(([userId, role]) =>
        db.prepare("UPDATE chat_participants SET role = ? WHERE chat_id = ? AND user_id = ? AND role = ''").bind(role, chatId, userId)
      )
    );
  } catch (e) {
    if (!isSchemaMissing(e)) console.error('chat roles not written', chatId, e instanceof Error ? e.message : String(e));
  }
}

/**
 * WHO SPOKE BEFORE THIS LINE — the turn rule's one question. A system card
 * («تم إنشاء الطلب», 0150) records an action, it is not somebody speaking: a
 * customer who places an order and then writes «أرجو الإسراع» is starting a
 * turn, and must still be heard. A database a migration behind has no system
 * cards to skip.
 */
async function previousSenderOf(db: D1Database, chatId: string, messageId: string): Promise<string | null> {
  const read = (skipSystem: boolean) =>
    db
      .prepare(
        `SELECT sender_id FROM chat_messages WHERE chat_id = ? AND id <> ?${skipSystem ? ' AND is_system = 0' : ''}
          ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .bind(chatId, messageId)
      .first<{ sender_id: string }>();
  try {
    return (await read(true))?.sender_id ?? null;
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
    return (await read(false))?.sender_id ?? null;
  }
}

/**
 * «رسالة جديدة» TO THE OTHER SIDE of one of a store's threads (audit 04 B10).
 *
 * Once per TURN, not per line: a customer typing four lines in a row is one
 * question waiting, so a line whose predecessor was the same sender's says
 * nothing new — the same rule the shop desk's announce follows. The event key
 * is the message id, so a retried send cannot notify twice. The seller hears
 * it as the STORE's `new_message`, opening the thread in the workspace inbox
 * (worker/lib/merchantNotify.ts: always in-app, outside channels per their
 * `new_messages` switch); the customer as their own `chat_message`.
 */
export async function notifyStoreThread(
  env: Env,
  thread: StoreThread,
  chatId: string,
  senderId: string,
  messageId: string
): Promise<void> {
  const prev = await previousSenderOf(env.DB, chatId, messageId);
  if (prev === senderId) return;
  const toSeller = senderId !== thread.seller_id;
  const recipient = toSeller ? thread.seller_id : thread.customer_id;
  if (!recipient || recipient === senderId) return;
  if (toSeller) {
    await notifyMerchant(env, { storeId: thread.store_id }, newMessageNotice(chatId, messageId, { type: thread.context_type, id: thread.context_id }));
    return;
  }
  const about =
    thread.context_type === 'store_order'
      ? { ar: `بخصوص الطلب ${thread.context_id}`, en: `About order ${thread.context_id}` }
      : { ar: 'افتح المحادثة لقراءته.', en: 'Open the conversation to read it.' };
  await notify(env.DB, {
    userId: recipient,
    kind: 'chat_message',
    title_ar: 'ردّ المتجر على رسالتك',
    title_en: 'The store replied to your message',
    body_ar: about.ar,
    body_en: about.en,
    link: `/chat/${chatId}`,
    entity_type: 'chat',
    entity_id: chatId,
    eventKey: `chat_msg:${messageId}`,
  });
}

/**
 * THE CONVERSATION LIST, WITH OR WITHOUT 0110. The preview names an
 * attachment-only message by `attachment_kind`; a Worker that ships ahead of
 * that migration (the incident tests/deployAheadOfMigrations.test.ts records)
 * would 500 the whole list on the missing column. It falls back to the
 * pre-0110 preview — 📷 for any file — instead.
 */
function chatListSql(withAttachmentKind: boolean): string {
  const kindCases = withAttachmentKind
    ? `WHEN m.attachment_kind = 'audio' THEN '🎤'
                      WHEN m.attachment_kind = 'file' THEN '📄'
                      WHEN m.attachment_kind = 'video' THEN '🎬'
                      `
    : '';
  return `SELECT ch.id,
            ch.order_id,
            -- An attachment-only message has an empty body; the list shows
            -- what it IS instead of a blank line (a voice note reads 🎤).
            (SELECT CASE
                      WHEN m.body <> '' THEN m.body
                      ${kindCases}WHEN m.file_key IS NOT NULL THEN '📷'
                      ELSE '' END
               FROM chat_messages m WHERE m.chat_id = ch.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM chat_messages m WHERE m.chat_id = ch.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
            (SELECT COUNT(*) FROM chat_messages m
               WHERE m.chat_id = ch.id AND m.sender_id <> ?1
                 AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)) AS unread,
            (SELECT u.username FROM chat_participants p2 JOIN users u ON u.id = p2.user_id
               WHERE p2.chat_id = ch.id AND p2.user_id <> ?1 LIMIT 1) AS other_username,
            (SELECT u.name FROM chat_participants p2 JOIN users u ON u.id = p2.user_id
               WHERE p2.chat_id = ch.id AND p2.user_id <> ?1 LIMIT 1) AS other_name,
            -- A STORE'S thread (0031/0124) is named by the store to its
            -- customer — never by the owner's personal name.
            ch.context_type,
            s.name AS store_name,
            s.logo_key AS store_logo_key,
            CASE WHEN s.user_id = ?1 THEN 1 ELSE 0 END AS is_seller
       FROM chats ch
       LEFT JOIN merchant_stores s ON s.id = ch.store_id AND ch.context_type IN ('store','store_order','request')
       JOIN chat_participants cp ON cp.chat_id = ch.id AND cp.user_id = ?1
      ORDER BY last_at DESC NULLS LAST
      LIMIT 100`;
}

chatRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const list = (withAttachmentKind: boolean) =>
    c.env.DB.prepare(chatListSql(withAttachmentKind)).bind(user.id).all();
  let results: unknown[];
  try {
    ({ results } = await list(true));
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
    console.error(`chat_messages is behind the deployment (0110 not applied): ${e instanceof Error ? e.message : String(e)}`);
    ({ results } = await list(false));
  }
  return c.json({
    success: true,
    chats: (results as Array<Record<string, unknown>>).map(({ store_name, store_logo_key, is_seller, ...r }) => {
      const asCustomer = typeof store_name === 'string' && store_name !== '' && !Number(is_seller);
      return {
        ...r,
        other_name: asCustomer ? store_name : r.other_name,
        other_username: asCustomer ? null : r.other_username,
        store: typeof store_name === 'string' && store_name
          ? { name: store_name, logoUrl: store_logo_key ? `/files/${String(store_logo_key)}` : null, mine: !!Number(is_seller) }
          : null,
      };
    }),
  });
});

/**
 * The store's one thread for this context (a customer, or a request), found or
 * created. ONE per (context, store, subject) — the unique index of 0124 — so
 * two first opens that race both end in the same thread. Both parties are
 * members from the start, and nobody else ever is.
 */
async function openStoreThread(
  db: D1Database,
  t: { contextType: 'store' | 'request'; contextId: string; storeId: string; merchantId: string; customerId: string; sellerId: string }
): Promise<string> {
  const find = () =>
    db
      .prepare('SELECT id FROM chats WHERE context_type = ? AND store_id = ? AND context_id = ?')
      .bind(t.contextType, t.storeId, t.contextId)
      .first<{ id: string }>();
  const members = (chatId: string) =>
    [t.customerId, t.sellerId].map((u) =>
      db.prepare('INSERT OR IGNORE INTO chat_participants (chat_id, user_id) VALUES (?, ?)').bind(chatId, u)
    );
  let chatId = (await find())?.id ?? '';
  if (chatId) {
    await db.batch(members(chatId));
  } else {
    chatId = newId('chat');
    try {
      await db.batch([
        db
          .prepare('INSERT INTO chats (id, context_type, context_id, store_id, merchant_id) VALUES (?, ?, ?, ?, ?)')
          .bind(chatId, t.contextType, t.contextId, t.storeId, t.merchantId),
        ...members(chatId),
      ]);
    } catch (e) {
      const won = await find();
      if (!won) throw e;
      chatId = won.id;
      await db.batch(members(chatId));
    }
  }
  await setRoles(db, chatId, [[t.customerId, 'customer'], [t.sellerId, 'merchant']]);
  return chatId;
}

/**
 * Opens (or returns) a chat.
 *
 * TWO KINDS, and the difference matters. `{userId}` is the general direct
 * message — one per pair, exactly as before. `{orderId}` is a thread ABOUT
 * that order: it has a subject, it belongs on the order screen, and it is
 * deliberately NOT the same thread as the customer's general DM, so "which
 * colour did you mean?" does not end up buried in an unrelated conversation
 * six months later.
 *
 * An order thread may be opened by the order's OWNER or by an admin, and by
 * nobody else. The two participants are always the customer and whoever
 * opened it — an admin, in practice.
 */
chatRoutes.post('/open', async (c) => {
  await rateLimit(c, 'chat-open', 60, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));

  if (body.orderId !== undefined) {
    const orderId = str(body.orderId, 'orderId', { min: 1, max: 60 });
    const order = await c.env.DB.prepare(
      `SELECT o.id, o.user_id, o.merchant_id, m.user_id AS merchant_user_id
         FROM orders o LEFT JOIN community_merchants m ON m.id = o.merchant_id
        WHERE o.id = ?`
    )
      .bind(orderId)
      .first<{ id: string; user_id: string; merchant_id: string | null; merchant_user_id: string | null }>();
    if (!order) throw notFound('Order not found');
    const isAdmin = user.role === 'admin';
    // The order's owner, an admin — or, for a merchant-store order, the
    // merchant who has to fulfil it. A seller who cannot ask "which colour
    // did you mean?" can only guess, and guessing ships the wrong thing.
    const isSeller = order.merchant_user_id !== null && order.merchant_user_id === user.id;
    const isCustomer = order.user_id === user.id;
    if (!isAdmin && !isSeller && !isCustomer) throw forbidden('This is not your order');

    const existing = await c.env.DB.prepare('SELECT id FROM chats WHERE order_id = ?')
      .bind(orderId)
      .first<{ id: string }>();

    /*
     * A MERCHANT-STORE ORDER'S THREAD IS THE CUSTOMER'S AND THE SELLER'S.
     *
     * Both are members from the moment it exists (audit 04 B10: a customer who
     * opened it first was alone in it, and the shop desk excludes store orders,
     * so the question reached nobody). An admin who is neither is answered
     * READ-ONLY and is never added — staff joining a private merchant thread
     * silently is exactly what B6 found. They get the thread to read (audited
     * on each read) or nothing, if none exists yet: an admin does not start
     * a conversation between two other people.
     */
    if (order.merchant_id && order.merchant_user_id) {
      if (!isCustomer && !isSeller) {
        return c.json({ success: true, chatId: existing?.id ?? null, orderId, readOnly: true });
      }
      const chatId = existing?.id ?? newId('chat');
      // The thread is the STORE's (migration 0124): its context is the order,
      // and the store and merchant come from the order row, never the caller.
      const stmts = existing
        ? []
        : [
            c.env.DB.prepare(
              `INSERT INTO chats (id, order_id, context_type, context_id, store_id, merchant_id)
               VALUES (?1, ?2, 'store_order', ?2, (SELECT id FROM merchant_stores WHERE merchant_id = ?3), ?3)`
            ).bind(chatId, orderId, order.merchant_id),
          ];
      for (const member of new Set([order.user_id, order.merchant_user_id])) {
        stmts.push(
          c.env.DB.prepare('INSERT OR IGNORE INTO chat_participants (chat_id, user_id) VALUES (?, ?)').bind(chatId, member)
        );
      }
      try {
        await c.env.DB.batch(stmts);
      } catch (e) {
        // Two first opens raced (UNIQUE on chats.order_id): the other one made
        // the thread — use it.
        const won = await c.env.DB.prepare('SELECT id FROM chats WHERE order_id = ?').bind(orderId).first<{ id: string }>();
        if (!won) throw e;
        await c.env.DB.batch(
          [...new Set([order.user_id, order.merchant_user_id])].map((member) =>
            c.env.DB.prepare('INSERT OR IGNORE INTO chat_participants (chat_id, user_id) VALUES (?, ?)').bind(won.id, member)
          )
        );
        await setRoles(c.env.DB, won.id, [[order.user_id, 'customer'], [order.merchant_user_id, 'merchant']]);
        return c.json({ success: true, chatId: won.id, orderId });
      }
      await setRoles(c.env.DB, chatId, [[order.user_id, 'customer'], [order.merchant_user_id, 'merchant']]);
      return c.json({ success: true, chatId, orderId });
    }

    // THE SHOP'S OWN ORDER: the admin is the other party (the support desk).
    if (existing) {
      // An admin opening an existing thread joins it — the first admin to
      // reply is rarely the one who reads it next, and a thread nobody else
      // can open is a thread that gets abandoned.
      if (isAdmin) {
        await c.env.DB
          .prepare('INSERT OR IGNORE INTO chat_participants (chat_id, user_id) VALUES (?, ?)')
          .bind(existing.id, user.id)
          .run();
      }
      return c.json({ success: true, chatId: existing.id, orderId });
    }

    const chatId = newId('chat');
    const stmts = [
      c.env.DB.prepare('INSERT INTO chats (id, order_id) VALUES (?, ?)').bind(chatId, orderId),
      c.env.DB
        .prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)')
        .bind(chatId, order.user_id),
    ];
    if (user.id !== order.user_id) {
      stmts.push(
        c.env.DB.prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)').bind(chatId, user.id)
      );
    }
    await c.env.DB.batch(stmts);
    await setRoles(c.env.DB, chatId, [[order.user_id, 'customer'], ...(user.id !== order.user_id ? [[user.id, 'support'] as [string, 'support']] : [])]);
    return c.json({ success: true, chatId, orderId });
  }

  /*
   * A CUSTOM REQUEST'S THREAD — the requester and ONE merchant who made an
   * offer on it (pending, or accepted and now the job). The customer names the
   * merchant; a merchant opens the thread of their own offer. Nobody else,
   * and no merchant who never bid: the board is not a way to DM a customer.
   */
  if (body.requestId !== undefined) {
    const requestId = str(body.requestId, 'requestId', { min: 1, max: 60 });
    const request = await c.env.DB.prepare('SELECT id, customer_id FROM community_requests WHERE id = ?')
      .bind(requestId)
      .first<{ id: string; customer_id: string }>();
    if (!request) throw notFound('Request not found');
    const isCustomer = request.customer_id === user.id;
    const merchantId = isCustomer ? str(body.merchantId, 'merchantId', { min: 1, max: 60 }) : '';
    const offer = await c.env.DB.prepare(
      `SELECT m.id AS merchant_id, m.user_id AS merchant_user_id, s.id AS store_id
         FROM community_offers o
         JOIN community_merchants m ON m.id = o.merchant_id
         JOIN merchant_stores s ON s.merchant_id = m.id
        WHERE o.request_id = ?1 AND o.state IN ('pending','accepted')
          AND ${isCustomer ? 'm.id = ?2' : 'm.user_id = ?2'}
        LIMIT 1`
    )
      .bind(requestId, isCustomer ? merchantId : user.id)
      .first<{ merchant_id: string; merchant_user_id: string; store_id: string }>();
    if (!offer || offer.merchant_user_id === request.customer_id) {
      throw new HttpError(403, 'Only the requester and a merchant with an offer on it can talk about this request', 'REQUEST_THREAD_NOT_ALLOWED');
    }
    const chatId = await openStoreThread(c.env.DB, {
      contextType: 'request',
      contextId: requestId,
      storeId: offer.store_id,
      merchantId: offer.merchant_id,
      customerId: request.customer_id,
      sellerId: offer.merchant_user_id,
    });
    return c.json({ success: true, chatId, requestId, context: 'request' });
  }

  // A storefront may open the conversation by MERCHANT id, so the public
  // store payload never has to carry the merchant's account id at all. With a
  // store, it is the STORE's thread with this customer — one per pair, listed
  // in the store's inbox — and not the two accounts' personal DM.
  let otherUserId: string;
  if (body.merchantId !== undefined && body.userId === undefined) {
    const merchantId = str(body.merchantId, 'merchantId', { min: 1, max: 60 });
    const m = await c.env.DB.prepare(
      'SELECT m.user_id, s.id AS store_id FROM community_merchants m LEFT JOIN merchant_stores s ON s.merchant_id = m.id WHERE m.id = ?'
    )
      .bind(merchantId)
      .first<{ user_id: string; store_id: string | null }>();
    if (!m) throw notFound('Store not found');
    if (m.user_id === user.id) throw badRequest('You cannot chat with yourself');
    if (m.store_id) {
      const chatId = await openStoreThread(c.env.DB, {
        contextType: 'store',
        contextId: user.id,
        storeId: m.store_id,
        merchantId,
        customerId: user.id,
        sellerId: m.user_id,
      });
      return c.json({ success: true, chatId, context: 'store' });
    }
    otherUserId = m.user_id;
  } else {
    otherUserId = str(body.userId, 'userId', { min: 1, max: 60 });
  }
  if (otherUserId === user.id) throw badRequest('You cannot chat with yourself');
  const other = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(otherUserId).first();
  if (!other) throw notFound('User not found');

  // Only a GENERAL chat is reused here — an order thread must never be
  // returned as if it were the pair's direct message.
  // …and never a STORE's thread either (0124): a store's conversation with a
  // customer, or a request's, has two members too, and returning it here put
  // a personal message into the store's inbox.
  const existing = await c.env.DB.prepare(
    `SELECT a.chat_id FROM chat_participants a
       JOIN chat_participants b ON b.chat_id = a.chat_id AND b.user_id = ?
       JOIN chats ch ON ch.id = a.chat_id AND ch.order_id IS NULL AND ch.context_type = ''
      WHERE a.user_id = ?`
  )
    .bind(otherUserId, user.id)
    .first<{ chat_id: string }>();
  if (existing) return c.json({ success: true, chatId: existing.chat_id });

  const chatId = newId('chat');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO chats (id) VALUES (?)').bind(chatId),
    c.env.DB.prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)').bind(chatId, user.id),
    c.env.DB.prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)').bind(chatId, otherUserId),
  ]);
  return c.json({ success: true, chatId });
});

/**
 * WHO THIS CONVERSATION IS WITH, AND WHAT THIS READER MAY SEND IN IT.
 *
 * The thread screen's header used to be the other account's personal name,
 * found by scanning the whole conversation list — so a customer talking to a
 * shop read the owner's first name, never the shop's. Now the store is the
 * thread's identity (its name, its logo, whether it is open), the customer is
 * named to the store the way the inbox already names them, and `can` says
 * which cards this side may send here — the same rules the send door
 * enforces (worker/lib/chatCards.ts), so the menu never offers a refusal.
 *
 * Staff reading a merchant↔customer order thread get the same answer, read-only.
 * Nothing private crosses: no phone, no e-mail, no address.
 */
chatRoutes.get('/:id', async (c) => {
  const user = c.get('user')!;
  const chatId = str(c.req.param('id'), 'chatId', { min: 1, max: 60 });
  const member = await c.env.DB.prepare('SELECT 1 AS x FROM chat_participants WHERE chat_id = ? AND user_id = ?')
    .bind(chatId, user.id)
    .first();
  let readOnly = false;
  if (!member) {
    const orderThread = user.role === 'admin' ? await storeOrderThread(c.env.DB, chatId) : null;
    if (!orderThread) throw forbidden('You are not part of this conversation');
    readOnly = true;
  }
  const chat = await c.env.DB.prepare('SELECT id, order_id, context_type, context_id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ id: string; order_id: string | null; context_type: string; context_id: string }>();
  if (!chat) throw notFound('Conversation not found');

  const thread = await storeThreadOf(c.env.DB, chatId);
  const role = readOnly ? 'staff' : thread ? (threadRole(thread, user.id) ?? 'member') : 'member';
  // Staff may be members of the shop's OWN order threads (the support desk).
  const writeBlocked = readOnly || (!!thread && thread.context_type === 'store_order' && role === 'member');

  let store: Record<string, unknown> | null = null;
  let customWork = false;
  if (thread) {
    const ctx = await storeById(c.env.DB, thread.store_id);
    if (ctx) {
      const open = (await storeTakesOrders(c.env.DB, ctx)).ok;
      // Custom work (a print request to this store) needs the store to take
      // custom requests AND new work — asked here so the menu never offers a
      // door the send would refuse (worker/routes/chatCommerce.ts).
      customWork =
        Number(ctx.store.accepts_custom_requests) === 1 &&
        (await merchantTakesNewWork(c.env.DB, {
          merchantStatus: ctx.merchant.status,
          storeStatus: ctx.store.status,
          ownerUserId: ctx.store.user_id,
        }));
      store = {
        id: ctx.store.id,
        name: ctx.store.name,
        slug: ctx.store.slug,
        logoUrl: ctx.store.logo_key ? `/files/${ctx.store.logo_key}` : null,
        url: `/community/store/${encodeURIComponent(ctx.store.slug)}`,
        // A suspended store is «غير متاح» to its customers — never why.
        open,
      };
    }
  }

  // The other side, by the name this reader should see it by.
  let other: { name: string; username: string } | null = null;
  if (thread && role === 'merchant') {
    const u = await c.env.DB.prepare('SELECT name, username FROM users WHERE id = ?')
      .bind(thread.customer_id)
      .first<{ name: string | null; username: string | null }>();
    other = { name: String(u?.name ?? ''), username: String(u?.username ?? '') };
  } else if (!thread) {
    const u = await c.env.DB.prepare(
      `SELECT u.name, u.username FROM chat_participants p JOIN users u ON u.id = p.user_id
        WHERE p.chat_id = ? AND p.user_id <> ? LIMIT 1`
    )
      .bind(chatId, user.id)
      .first<{ name: string | null; username: string | null }>();
    other = u ? { name: String(u.name ?? ''), username: String(u.username ?? '') } : null;
  }

  const party = role === 'customer' || role === 'merchant';
  // Starting custom work follows Levo Community's switch (D9).
  const communityOpen = party && communityMayEnter(await readCommunityGate(c.env.DB), user);
  const commerceThread = !!thread && thread.context_type === 'store' && !writeBlocked;
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    chat: {
      id: chat.id,
      context: { type: thread ? thread.context_type : chat.order_id ? 'order' : 'direct', id: thread ? thread.context_id : (chat.order_id ?? '') },
      order_id: chat.order_id,
      role,
      read_only: writeBlocked,
      store,
      other,
      can: {
        product_card: !!thread && party && !writeBlocked,
        store_card: !!thread && party && !writeBlocked,
        print_request: commerceThread && role === 'customer' && communityOpen && customWork,
        quote: commerceThread && role === 'merchant' && communityOpen,
        // A private product is store commerce, sold through the store cart:
        // not gated by the community switch, gated by the store selling (D9).
        custom_product: commerceThread && role === 'merchant' && !!store?.open,
      },
    },
  });
});

/**
 * THE PRODUCT PICKER: this thread's store's products that a customer could buy
 * — published, not hidden, never another store's and never a private one. The
 * same rows either side sees; a card sent from here is re-checked by the send
 * door all the same. Newest first, `?q=` on the name, paged by `created_at|id`.
 */
chatRoutes.get('/:id/products', async (c) => {
  const user = c.get('user')!;
  const chatId = str(c.req.param('id'), 'chatId', { min: 1, max: 60 });
  await assertMayWriteInThread(c.env.DB, chatId, user.id);
  const thread = await storeThreadOf(c.env.DB, chatId);
  if (!thread || !threadRole(thread, user.id)) throw badRequest('Products are sent in a conversation with a store', 'CARD_NOT_ALLOWED_HERE');
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 40, def: 20 });
  const q = likePattern(c.req.query('q'));
  if (q) await rateLimit(c, 'chat-product-search', 60, 60);
  const beforeRaw = (c.req.query('cursor') ?? '').slice(0, 200);
  const bar = beforeRaw.lastIndexOf('|');
  const cursor = bar === -1 ? { at: '', id: '' } : { at: beforeRaw.slice(0, bar), id: beforeRaw.slice(bar + 1) };
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.name_ar, p.images, p.price_iqd, p.original_price_iqd, p.track_stock, p.stock,
            p.variant_mode, p.created_at,
            (SELECT MIN(COALESCE(v.price_iqd, p.price_iqd)) FROM community_product_variants v
              WHERE v.product_id = p.id AND v.active = 1) AS v_min,
            (SELECT MAX(COALESCE(v.price_iqd, p.price_iqd)) FROM community_product_variants v
              WHERE v.product_id = p.id AND v.active = 1) AS v_max
       FROM community_products p
      WHERE p.store_id = ?1 AND p.lifecycle = 'active' AND p.status = 'active'
        AND (?2 = '' OR ${sqlLikeClause(['p.name', 'p.name_ar'], '?2')})
        AND (?3 = '' OR p.created_at < ?3 OR (p.created_at = ?3 AND p.id < ?4))
      ORDER BY p.created_at DESC, p.id DESC LIMIT ?5`
  )
    .bind(thread.store_id, q, cursor.at, cursor.id, limit)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  const last = rows.length === limit ? rows[rows.length - 1] : null;
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    products: rows.map((p) => {
      const variants = p.variant_mode === 'variants' && p.v_min !== null && p.v_min !== undefined;
      const lo = variants ? Number(p.v_min) : Number(p.price_iqd ?? 0);
      const hi = variants ? Number(p.v_max ?? lo) : lo;
      const images = safeParse<unknown[]>(p.images, []);
      const image = (Array.isArray(images) ? images : []).find((x): x is string => typeof x === 'string' && x.startsWith('/files/')) ?? null;
      return {
        id: p.id,
        name: p.name,
        name_ar: p.name_ar,
        image,
        price_iqd: lo,
        price_max_iqd: hi > lo ? hi : null,
        original_price_iqd: p.original_price_iqd ?? null,
        in_stock: !Number(p.track_stock) || Number(p.stock) > 0,
        variants: p.variant_mode === 'variants',
      };
    }),
    next_cursor: last ? `${String(last.created_at)}|${String(last.id)}` : null,
  });
});

// Presence inherits authentication and the app's CSRF/host checks. Both
// operations require membership; an admin is NOT implicitly a participant.
chatRoutes.get('/:id/typing', async (c) => {
  const chatId = str(c.req.param('id'), 'chatId', { min: 1, max: 60 });
  const user = c.get('user')!;
  await assertParticipant(c.env.DB, chatId, user.id);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, ...await remoteChatTyping(c.env.DB, chatId, user.id) });
});
chatRoutes.post('/:id/typing', async (c) => {
  const chatId = str(c.req.param('id'), 'chatId', { min: 1, max: 60 });
  const user = c.get('user')!;
  // «يكتب…» is a write: only the parties to a store thread show it (review S3).
  await assertMayWriteInThread(c.env.DB, chatId, user.id);
  await rateLimit(c, 'chat-typing', 90, 60);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.typing !== 'boolean') throw badRequest('typing must be a boolean');
  await setChatTyping(c.env.DB, chatId, user.id, body.typing);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true });
});

/** What a chat attachment IS — the four the conversation can carry. */
export type ChatAttachmentKind = 'image' | 'video' | 'audio' | 'file';

/**
 * WHAT A STORED ATTACHMENT IS, read from WHERE THE UPLOAD ROUTE FILED IT.
 *
 * `uploads.ts` sniffs the bytes and files them `chat/<chatId>/<folder>/…` —
 * `attachments` for a picture, `video`, `audio`, `files` for a PDF — so the
 * folder is the server's own record of what was sniffed, and a client's
 * `kind` is never the answer. Keys written before the folders existed fall
 * back to the extension, which is how a clip stored as `kind='image'` (the only
 * home 0001's CHECK allowed it) is finally drawn as a video.
 */
export function chatAttachmentKind(fileKey: unknown): ChatAttachmentKind | null {
  if (typeof fileKey !== 'string' || !fileKey) return null;
  const folder = fileKey.split('/')[2] ?? '';
  if (folder === 'video') return 'video';
  if (folder === 'audio') return 'audio';
  if (folder === 'files') return 'file';
  const ext = (fileKey.split('.').pop() ?? '').toLowerCase();
  if (ext === 'pdf') return 'file';
  if (ext === 'mp4' || ext === 'webm') return 'video';
  if (ext === 'mp3' || ext === 'ogg') return 'audio';
  return 'image';
}

/**
 * ONE MESSAGE, AS EVERY CHAT SCREEN READS IT. `kind` is the attachment's real
 * kind when there is one (`attachment_kind`, migration 0110, else the key), so
 * a screen draws <img>, <video>, <audio> or a document link from one field.
 * `fileUrl` is composed here and the key never leaves the server.
 */
export function chatMessagePublic(m: Record<string, unknown>, viewerId: string, current?: CardCurrent) {
  const attachment =
    (typeof m.attachment_kind === 'string' && m.attachment_kind
      ? (m.attachment_kind as ChatAttachmentKind)
      : null) ?? chatAttachmentKind(m.file_key);
  // A CARD (0150): its kind (`product_card`, `quote_card`…), what it was sent
  // as and what it is now for THIS reader (worker/lib/chatCards.ts). `body`
  // stays the plain fallback an older client shows.
  const card = cardPublic(m, current);
  return {
    id: m.id,
    sender_id: m.sender_id,
    mine: m.sender_id === viewerId,
    kind: card ? card.kind : attachment ?? m.kind,
    attachment_kind: attachment,
    body: m.body,
    fileUrl: m.file_key ? `/files/${m.file_key}` : null,
    card,
    /** Written by the server about an event — drawn centred, never as a bubble. */
    system: Number(m.is_system ?? 0) === 1,
    created_at: m.created_at,
  };
}

/**
 * THE MESSAGES OF A PAGE, WITH THEIR CARDS' CURRENT STATE — one read per card
 * type on the page, never one per card, and none at all for a page of plain
 * messages. Staff reading a store thread see every card and may act on none.
 */
export async function publicPage(
  env: Env,
  chatId: string,
  rows: Array<Record<string, unknown>>,
  viewerId: string,
  staff: boolean
) {
  const hasCards = rows.some((m) => typeof m.card_type === 'string' && m.card_type);
  const current = hasCards
    ? await currentCardStates(env, rows, await storeThreadOf(env.DB, chatId), viewerId, staff)
    : new Map<string, CardCurrent>();
  return rows.map((m) => chatMessagePublic(m, viewerId, current.get(String(m.id))));
}

/**
 * A THREAD, NEWEST FIRST IN PAGES (audit 04 B5).
 *
 * This returned `ORDER BY created_at ASC LIMIT 500` — the OLDEST 500 — so on a
 * long thread every message after the 500th was invisible, including the one
 * that had just been sent. Now the default answer is the newest `limit`
 * messages (oldest→newest, the order a thread is drawn in), and `before` pages
 * backwards: `older_cursor` is `<created_at>|<id>` of the oldest message
 * returned, or null when there is nothing older. The id breaks ties, so a
 * page boundary never drops a message that shares its timestamp.
 *
 * Only the newest page marks the thread read: scrolling back through history
 * is not reading what just arrived.
 */
const PAGE_DEFAULT = 60;

chatRoutes.get('/:id/messages', async (c) => {
  const user = c.get('user')!;
  const chatId = str(c.req.param('id'), 'chatId', { min: 1, max: 60 });
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 200, def: PAGE_DEFAULT });
  const beforeRaw = (c.req.query('before') ?? '').slice(0, 200);
  const bar = beforeRaw.lastIndexOf('|');
  const before = bar === -1 ? { at: beforeRaw, id: '' } : { at: beforeRaw.slice(0, bar), id: beforeRaw.slice(bar + 1) };

  const member = await c.env.DB.prepare('SELECT 1 AS x FROM chat_participants WHERE chat_id = ? AND user_id = ?')
    .bind(chatId, user.id)
    .first();
  let readOnly = false;
  if (!member) {
    // Staff reading a merchant↔customer thread: allowed, never joined,
    // never able to write, always recorded. Anything else is refused.
    const thread = user.role === 'admin' ? await storeOrderThread(c.env.DB, chatId) : null;
    if (!thread) throw forbidden('You are not part of this conversation');
    await auditStaffRead(c, chatId, thread.order_id);
    readOnly = true;
  }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM chat_messages
      WHERE chat_id = ?1
        AND (?2 = '' OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
      ORDER BY created_at DESC, id DESC LIMIT ?4`
  )
    .bind(chatId, before.at, before.id, limit + 1)
    .all<Record<string, unknown>>();
  const hasMore = results.length > limit;
  const page = results.slice(0, limit).reverse();

  if (!readOnly && !before.at) {
    await c.env.DB.prepare(
      "UPDATE chat_participants SET last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id = ? AND user_id = ?"
    )
      .bind(chatId, user.id)
      .run();
  }
  const oldest = page[0];
  return c.json({
    success: true,
    messages: await publicPage(c.env, chatId, page, user.id, readOnly),
    has_more: hasMore,
    older_cursor: hasMore && oldest ? `${String(oldest.created_at)}|${String(oldest.id)}` : null,
    read_only: readOnly,
  });
});

/**
 * A MESSAGE ALREADY STORED FOR THIS CLIENT SEND (0150 `client_id`) — the
 * answer to a retried send, in the read path's own shape. Null on a database
 * a migration behind (no client ids there to find).
 */
async function storedClientMessage(env: Env, chatId: string, senderId: string, clientId: string | null) {
  if (!clientId) return null;
  const row = await env.DB.prepare('SELECT * FROM chat_messages WHERE chat_id = ? AND sender_id = ? AND client_id = ?')
    .bind(chatId, senderId, clientId)
    .first<Record<string, unknown>>()
    .catch((e) => {
      if (isSchemaMissing(e)) return null;
      throw e;
    });
  if (!row) return null;
  const [message] = await publicPage(env, chatId, [row], senderId, false);
  return message;
}

const isClientIdClash = (e: unknown) =>
  /UNIQUE/i.test(e instanceof Error ? e.message : String(e)) && /client_id/i.test(e instanceof Error ? e.message : String(e));

/**
 * A plain line or an attachment, written with the columns this database has.
 * `attachment_kind` (0110) and `client_id` (0150) are named only when there is
 * something to put in them, and each is dropped — newest first — when the
 * Worker is ahead of the migration that made it: the read path derives the
 * attachment's kind from its key, and a line without its client id is only a
 * line a retry could repeat.
 */
async function insertPlainMessage(
  db: D1Database,
  base: { id: string; chatId: string; senderId: string; kind: string; body: string; fileKey: string | null; createdAt: string },
  optional: { attachment_kind?: string; client_id?: string }
): Promise<void> {
  const extra = Object.entries(optional).filter(([, v]) => v !== undefined) as Array<[string, string]>;
  for (;;) {
    const cols = ['id', 'chat_id', 'sender_id', 'kind', 'body', 'file_key', ...extra.map(([k]) => k), 'created_at'];
    const vals = [base.id, base.chatId, base.senderId, base.kind, base.body, base.fileKey, ...extra.map(([, v]) => v), base.createdAt];
    try {
      await db.prepare(`INSERT INTO chat_messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...vals).run();
      return;
    } catch (e) {
      if (!isSchemaMissing(e) || !extra.length) throw e;
      const dropped = extra.pop()!;
      console.error(`chat_messages is behind the deployment (no ${dropped[0]}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

chatRoutes.post('/:id/messages', async (c) => {
  await rateLimit(c, 'chat-send', 200, 3600);
  const user = c.get('user')!;
  const chatId = str(c.req.param('id'), 'chatId', { min: 1, max: 60 });
  /*
   * A merchant-store order's thread is written by its customer and its seller
   * only. An admin who was silently joined to one before that stopped (audit
   * 04 B6) is still a participant row — and is read-only all the same.
   */
  await assertMayWriteInThread(c.env.DB, chatId, user.id);
  const storeThread = await storeThreadOf(c.env.DB, chatId);
  const body = await c.req.json().catch(() => ({}));

  // A RETRIED SEND IS THE SAME MESSAGE (0150): the client names each send, and
  // a second POST of that name answers the message already stored — a double
  // tap or a lost response never puts the line (or the card) in twice.
  const clientId = clientIdFrom(body.client_id);
  const replay = await storedClientMessage(c.env, chatId, user.id, clientId);
  if (replay) return c.json({ success: true, id: replay.id, message: replay, replayed: true });

  const id = newId('msg');
  // The timestamp is bound, not defaulted, so the message this route answers
  // with carries the SAME value the thread will read back.
  const createdAt = new Date().toISOString();
  let stored: Record<string, unknown>;

  if (body.card !== undefined) {
    /*
     * A CARD — an id and a type, and nothing else from the client
     * (worker/lib/chatCards.ts): the server checks the entity belongs to THIS
     * thread's store (and customer), builds the snapshot and writes it once.
     */
    if (!storeThread) throw badRequest('Cards are sent in a conversation with a store', 'CARD_NOT_ALLOWED_HERE');
    const raw = body.card && typeof body.card === 'object' ? (body.card as Record<string, unknown>) : {};
    if (!isCardType(raw.type) || !SENDABLE_CARDS.includes(raw.type)) {
      throw badRequest('That card cannot be sent this way', 'CARD_TYPE_UNSUPPORTED');
    }
    const ref = str(raw.ref, 'card.ref', { min: 1, max: 60 });
    const card = await resolveSendableCard(c.env, storeThread, user.id, raw.type, ref);
    try {
      await cardInsertStatement(c.env.DB, { id, chatId, senderId: user.id, card, createdAt, clientId }).run();
    } catch (e) {
      if (clientId && isClientIdClash(e)) {
        const again = await storedClientMessage(c.env, chatId, user.id, clientId);
        if (again) return c.json({ success: true, id: again.id, message: again, replayed: true });
      }
      throw e;
    }
    stored = {
      id, sender_id: user.id, kind: 'text', body: card.body, file_key: null,
      card_type: card.type, card_ref: card.ref, card_snapshot: JSON.stringify(card.snapshot), is_system: 0, created_at: createdAt,
    };
  } else {
    // «كاميرا/ملف/بصمة صوتية». Any of the four attachment kinds means "this
    // message carries a file"; WHICH kind it is comes from where the upload route
    // filed it (`chatAttachmentKind`), never from this field.
    const attaching = body.kind === 'image' || body.kind === 'video' || body.kind === 'audio' || body.kind === 'file';
    const text = str(body.body, 'message', { max: 4000, required: !attaching });
    let fileKey: string | null = null;
    let attachmentKind: ChatAttachmentKind | null = null;
    if (attaching) {
      fileKey = str(body.fileKey, 'fileKey', { min: 5, max: 300 });
      /**
       * ======================================================================
       *  THE KEY NAMES THE CONVERSATION, NOT THE SENDER.
       * ======================================================================
       * This line read `chat/${user.id}/` and had to be changed the day the
       * upload route re-filed chat attachments under the chat — «الثاني الاسهل
       * في فتح المحادثه», the owner's own reason. It was not changed, so EVERY
       * attachment has been refused since: `uploads.ts` builds
       * `chat/<chatId>/attachments/<id>.webp` (buildMediaKey, purpose='chat',
       * entityId = the chat), the bytes land in R2, and this check then rejects
       * the message the upload was for. The customer sees «تعذر إرسال الصورة»
       * and an orphan object stays in the bucket. Nobody could send a picture in
       * any conversation on this platform — the order chat included, which is
       * the screen this is being fixed for.
       *
       * AND THE NEW FORM IS THE STRONGER CHECK, not merely the matching one.
       * `assertParticipant` above has already established that this account is
       * in THIS chat; pinning the key's first segment to the same chat id is
       * therefore the whole question — a member cannot attach another
       * conversation's file, which the sender-scoped form never prevented.
       * `uploads.ts` verifies participation before it stores a byte, so the two
       * halves now ask the same question in the same words.
       */
      if (!fileKey.startsWith(`chat/${chatId}/`)) throw badRequest('Invalid attachment reference');
      const head = await headMediaObject(c.env, 'private', fileKey);
      if (!head) throw badRequest('Attachment upload not found');
      attachmentKind = chatAttachmentKind(fileKey);
    }
    if (!attaching && !text) throw badRequest('Message cannot be empty');

    // `kind` keeps 0001's two values (its CHECK cannot widen without a table
    // rebuild): a picture or a clip is 'image', as legacy readers expect; a voice
    // note or a document is 'text' with an empty body, so a reader that knows
    // nothing of `attachment_kind` shows an empty bubble, never a broken image.
    const kind = attachmentKind === 'image' || attachmentKind === 'video' ? 'image' : 'text';
    try {
      await insertPlainMessage(
        c.env.DB,
        { id, chatId, senderId: user.id, kind, body: text, fileKey, createdAt },
        { ...(attachmentKind ? { attachment_kind: attachmentKind } : {}), ...(clientId ? { client_id: clientId } : {}) }
      );
    } catch (e) {
      if (clientId && isClientIdClash(e)) {
        const again = await storedClientMessage(c.env, chatId, user.id, clientId);
        if (again) return c.json({ success: true, id: again.id, message: again, replayed: true });
      }
      throw e;
    }
    stored = { id, sender_id: user.id, kind, body: text, file_key: fileKey, attachment_kind: attachmentKind, created_at: createdAt };
  }

  await setChatTyping(c.env.DB, chatId, user.id, false).catch(() => {});
  // The thread's last activity, which the store's inbox pages by (0124).
  await stampThreadActivity(c.env.DB, chatId, createdAt);
  // «محادثة مباشرة مع الفريق» has to reach the team: a customer line on one of
  // the shop's order threads is announced to «‼️ Support» (debounced; total).
  await announceCustomerChatMessage(c, chatId, user.id, id);
  if (storeThread) {
    // …and a line on one of a store's threads reaches its SELLER (or the
    // customer, when the seller answers). The seller is made a member first: a
    // thread opened before migration 0118 may not have them, and a
    // notification pointing at a thread they cannot open would be worse than
    // none.
    await c.env.DB.prepare('INSERT OR IGNORE INTO chat_participants (chat_id, user_id) VALUES (?, ?)')
      .bind(chatId, storeThread.seller_id)
      .run()
      .catch(() => {});
    await notifyStoreThread(c.env, storeThread, chatId, user.id, id).catch(() => {});
  }
  // The stored message, in the read path's own shape (its card with its
  // current state), so a screen can append it instead of re-fetching the
  // whole thread after every send.
  const [message] = await publicPage(c.env, chatId, [stored], user.id, false);
  return c.json({ success: true, id, message });
});
