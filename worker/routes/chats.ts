import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, notFound, forbidden, str } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';

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

chatRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT ch.id,
            (SELECT body FROM chat_messages m WHERE m.chat_id = ch.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
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
      LIMIT 100`
  )
    .bind(user.id)
    .all();
  return c.json({ success: true, chats: results });
});

/** Opens (or returns) the direct chat with another user. */
chatRoutes.post('/open', async (c) => {
  await rateLimit(c, 'chat-open', 60, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const otherUserId = str(body.userId, 'userId', { min: 1, max: 60 });
  if (otherUserId === user.id) throw badRequest('You cannot chat with yourself');
  const other = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(otherUserId).first();
  if (!other) throw notFound('User not found');

  const existing = await c.env.DB.prepare(
    `SELECT a.chat_id FROM chat_participants a
       JOIN chat_participants b ON b.chat_id = a.chat_id AND b.user_id = ?
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
    messages: results.map((m) => ({
      id: m.id,
      sender_id: m.sender_id,
      mine: m.sender_id === user.id,
      kind: m.kind,
      body: m.body,
      fileUrl: m.file_key ? `/files/${m.file_key}` : null,
      created_at: m.created_at,
    })),
  });
});

chatRoutes.post('/:id/messages', async (c) => {
  await rateLimit(c, 'chat-send', 200, 3600);
  const user = c.get('user')!;
  const chatId = c.req.param('id');
  await assertParticipant(c.env.DB, chatId, user.id);
  const body = await c.req.json().catch(() => ({}));
  const kind = body.kind === 'image' ? 'image' : 'text';
  const text = str(body.body, 'message', { max: 4000, required: kind === 'text' });
  let fileKey: string | null = null;
  if (kind === 'image') {
    fileKey = str(body.fileKey, 'fileKey', { min: 5, max: 300 });
    if (!fileKey.startsWith(`chat/${user.id}/`)) throw badRequest('Invalid image reference');
    const head = await c.env.BUCKET.head(fileKey);
    if (!head) throw badRequest('Image upload not found');
  }
  if (kind === 'text' && !text) throw badRequest('Message cannot be empty');

  const id = newId('msg');
  await c.env.DB.prepare(
    'INSERT INTO chat_messages (id, chat_id, sender_id, kind, body, file_key) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, chatId, user.id, kind, text, fileKey)
    .run();
  return c.json({ success: true, id });
});
