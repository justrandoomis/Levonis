import { setChatTyping, remoteChatTyping } from '../lib/chatPresence';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, notFound, forbidden, str } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { headMediaObject } from '../lib/mediaStorage';
import { isSchemaMissing } from '../lib/membershipBenefits';
import { announceCustomerChatMessage } from './adminChats';

/**
 * Direct chats. Only participants can read or write a conversation; there is
 * no moderator backdoor by default (an admin endpoint would need explicit,
 * audited access — deliberately not implemented in Phase 1).
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
               WHERE p2.chat_id = ch.id AND p2.user_id <> ?1 LIMIT 1) AS other_name
       FROM chats ch
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
  return c.json({ success: true, chats: results });
});

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
      `SELECT o.id, o.user_id, m.user_id AS merchant_user_id
         FROM orders o LEFT JOIN community_merchants m ON m.id = o.merchant_id
        WHERE o.id = ?`
    )
      .bind(orderId)
      .first<{ id: string; user_id: string; merchant_user_id: string | null }>();
    if (!order) throw notFound('Order not found');
    const isAdmin = user.role === 'admin';
    // The order's owner, an admin — or, for a merchant-store order, the
    // merchant who has to fulfil it. A seller who cannot ask "which colour
    // did you mean?" can only guess, and guessing ships the wrong thing.
    const isSeller = order.merchant_user_id !== null && order.merchant_user_id === user.id;
    if (!isAdmin && !isSeller && order.user_id !== user.id) throw forbidden('This is not your order');

    const existing = await c.env.DB.prepare('SELECT id FROM chats WHERE order_id = ?')
      .bind(orderId)
      .first<{ id: string }>();
    if (existing) {
      // An admin or the order's seller opening an existing thread joins it —
      // the first admin to reply is rarely the one who reads it next, and a
      // thread nobody else can open is a thread that gets abandoned.
      if (isAdmin || isSeller) {
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
    return c.json({ success: true, chatId, orderId });
  }

  // A storefront may open the conversation by MERCHANT id, so the public
  // store payload never has to carry the merchant's account id at all.
  let otherUserId: string;
  if (body.merchantId !== undefined && body.userId === undefined) {
    const merchantId = str(body.merchantId, 'merchantId', { min: 1, max: 60 });
    const m = await c.env.DB.prepare('SELECT user_id FROM community_merchants WHERE id = ?')
      .bind(merchantId)
      .first<{ user_id: string }>();
    if (!m) throw notFound('Store not found');
    otherUserId = m.user_id;
  } else {
    otherUserId = str(body.userId, 'userId', { min: 1, max: 60 });
  }
  if (otherUserId === user.id) throw badRequest('You cannot chat with yourself');
  const other = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(otherUserId).first();
  if (!other) throw notFound('User not found');

  // Only a GENERAL chat is reused here — an order thread must never be
  // returned as if it were the pair's direct message.
  const existing = await c.env.DB.prepare(
    `SELECT a.chat_id FROM chat_participants a
       JOIN chat_participants b ON b.chat_id = a.chat_id AND b.user_id = ?
       JOIN chats ch ON ch.id = a.chat_id AND ch.order_id IS NULL
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
  await assertParticipant(c.env.DB, chatId, user.id);
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
export function chatMessagePublic(m: Record<string, unknown>, viewerId: string) {
  const attachment =
    (typeof m.attachment_kind === 'string' && m.attachment_kind
      ? (m.attachment_kind as ChatAttachmentKind)
      : null) ?? chatAttachmentKind(m.file_key);
  return {
    id: m.id,
    sender_id: m.sender_id,
    mine: m.sender_id === viewerId,
    kind: attachment ?? m.kind,
    attachment_kind: attachment,
    body: m.body,
    fileUrl: m.file_key ? `/files/${m.file_key}` : null,
    created_at: m.created_at,
  };
}

chatRoutes.get('/:id/messages', async (c) => {
  const user = c.get('user')!;
  const chatId = c.req.param('id');
  await assertParticipant(c.env.DB, chatId, user.id);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT 500'
  )
    .bind(chatId)
    .all<Record<string, unknown>>();
  await c.env.DB.prepare(
    "UPDATE chat_participants SET last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id = ? AND user_id = ?"
  )
    .bind(chatId, user.id)
    .run();
  return c.json({
    success: true,
    messages: results.map((m) => chatMessagePublic(m, user.id)),
  });
});

chatRoutes.post('/:id/messages', async (c) => {
  await rateLimit(c, 'chat-send', 200, 3600);
  const user = c.get('user')!;
  const chatId = c.req.param('id');
  await assertParticipant(c.env.DB, chatId, user.id);
  const body = await c.req.json().catch(() => ({}));
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
  const id = newId('msg');
  // The timestamp is bound, not defaulted, so the message this route answers
  // with carries the SAME value the thread will read back.
  const createdAt = new Date().toISOString();
  // `attachment_kind` (0110) is named ONLY when there is an attachment, so a
  // plain text line never depends on that migration; and an attachment sent
  // while the Worker is ahead of 0110 is stored without it — the read path
  // derives the same kind from the key's folder (`chatAttachmentKind`).
  const insertPlain = () =>
    c.env.DB.prepare(
      'INSERT INTO chat_messages (id, chat_id, sender_id, kind, body, file_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(id, chatId, user.id, kind, text, fileKey, createdAt)
      .run();
  if (attachmentKind) {
    try {
      await c.env.DB.prepare(
        'INSERT INTO chat_messages (id, chat_id, sender_id, kind, body, file_key, attachment_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(id, chatId, user.id, kind, text, fileKey, attachmentKind, createdAt)
        .run();
    } catch (e) {
      if (!isSchemaMissing(e)) throw e;
      console.error(`chat_messages is behind the deployment (0110 not applied): ${e instanceof Error ? e.message : String(e)}`);
      await insertPlain();
    }
  } else {
    await insertPlain();
  }
  await setChatTyping(c.env.DB, chatId, user.id, false).catch(() => {});
  // «محادثة مباشرة مع الفريق» has to reach the team: a customer line on one of
  // the shop's order threads is announced to «‼️ Support» (debounced; total).
  await announceCustomerChatMessage(c, chatId, user.id, id);
  // The stored message, in the read path's own shape, so a screen can append
  // it instead of re-fetching the whole thread after every send.
  const message = chatMessagePublic(
    { id, sender_id: user.id, kind, body: text, file_key: fileKey, attachment_kind: attachmentKind, created_at: createdAt },
    user.id
  );
  return c.json({ success: true, id, message });
});
