-- Ephemeral presence only: no message content, keystrokes, or typing history.
-- Rows expire logically after 7 seconds and are removed on stop/send or the
-- next presence write. Participant deletion cascades. Safe on existing data.
CREATE TABLE IF NOT EXISTS chat_typing_presence (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id),
  FOREIGN KEY (chat_id, user_id) REFERENCES chat_participants(chat_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_typing_expiry ON chat_typing_presence(expires_at_ms);
