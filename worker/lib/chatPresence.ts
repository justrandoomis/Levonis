/** A server-clock expiry is the truth; disconnected clients cannot leave an
 * immortal typing indicator. No client-supplied identity or timestamp. */
export const CHAT_TYPING_TTL_MS = 7000;
export async function setChatTyping(db: D1Database, chatId: string, userId: string, typing: boolean, now = Date.now()) {
  const statement = typing
    ? db.prepare(`INSERT INTO chat_typing_presence(chat_id,user_id,expires_at_ms) VALUES(?,?,?)
        ON CONFLICT(chat_id,user_id) DO UPDATE SET expires_at_ms=excluded.expires_at_ms`)
      .bind(chatId, userId, now + CHAT_TYPING_TTL_MS)
    : db.prepare('DELETE FROM chat_typing_presence WHERE chat_id=? AND user_id=?').bind(chatId, userId);
  await db.batch([db.prepare('DELETE FROM chat_typing_presence WHERE expires_at_ms <= ?').bind(now), statement]);
}
export async function remoteChatTyping(db: D1Database, chatId: string, viewerId: string, now = Date.now()) {
  const row = await db.prepare(`SELECT MAX(t.expires_at_ms) AS expires
    FROM chat_typing_presence t JOIN chat_participants p ON p.chat_id=t.chat_id AND p.user_id=t.user_id
    WHERE t.chat_id=? AND t.user_id<>? AND t.expires_at_ms>?`).bind(chatId, viewerId, now).first<{ expires: number | null }>();
  const remainingMs = Math.min(CHAT_TYPING_TTL_MS, Math.max(0, (row?.expires ?? 0) - now));
  return { typing: remainingMs > 0, remainingMs };
}
