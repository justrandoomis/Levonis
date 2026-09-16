-- ---------------------------------------------------------------------------
--  0080 — THE SECOND BOT: @alilevobot, AND THE GROUP IT LEARNS BY ITSELF.
-- ---------------------------------------------------------------------------
-- THE OWNER'S REQUEST. A DEDICATED admin bot, completely separate from the
-- customer bot, that must NOT make anyone go and dig a numeric Chat ID or a
-- forum Topic ID out of Telegram and paste it into a GitHub secret:
--
--   «The new admin system must NOT require me to manually discover or enter
--    the group Chat ID or Topic IDs.»
--
-- So the group and its topics are DISCOVERED from the updates Telegram already
-- sends: an authorized admin types `/topic_here wallet` inside the Wallet
-- topic, and the bot reads `message.chat.id`, `message.message_thread_id` and
-- `message.from.id` out of that one update and stores them here.
--
-- WHY THESE ARE TABLES AND NOT SETTINGS ROWS. `admin_settings` is readable by
-- every admin screen and has no `updated_by` column; a Chat ID is operational
-- wiring with an author and a history, and a topic binding is a row that gets
-- re-pointed when a forum is reorganised. Two small tables say that honestly.
--
-- WHAT IS NOT HERE. No token, no webhook secret and no admin allow-list: those
-- are Worker SECRETS (`TELEGRAM_ADMIN_BOT_TOKEN`, `TELEGRAM_ADMIN_WEBHOOK_SECRET`,
-- `TELEGRAM_ADMIN_USER_IDS`), because a settings row is readable by every admin
-- screen and a credential must never be one (worker/lib/types.ts).

-- -------------------------------------------------------------- the group
-- ONE admin group, ever. `id` is pinned to a single row by a CHECK rather than
-- by convention, so a second group cannot be created by a careless INSERT and
-- then race the first one for every notification.
--
-- `group_chat_id` is TEXT because a Telegram supergroup id is a negative
-- number beyond 2^31 (-100…) that is passed straight back to the API as a
-- string; storing it as text is what `tg_admin_notifications.target_chat`
-- already does for the legacy chat.
CREATE TABLE IF NOT EXISTS telegram_admin_config (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  group_chat_id TEXT NOT NULL CHECK (group_chat_id <> ''),
  -- What Telegram called the group when it was bound. Display only: the id is
  -- the identity, and a renamed group keeps working.
  group_title TEXT NOT NULL DEFAULT '',
  -- WHO bound it, in BOTH identities: the site user (the audit trail's actor,
  -- resolved through admin_tg_identities) and the raw Telegram numeric id that
  -- pressed the key. Neither is derivable from the other later.
  configured_by TEXT NOT NULL,
  configured_by_tg INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ------------------------------------------------------------- the topics
-- One row per forum topic the platform routes to. `topic_key` is the PRIMARY
-- KEY, so binding the same key twice RE-POINTS it (an UPSERT) instead of
-- creating a second destination — moving «المحفظة» to another topic is one
-- `/topic_here wallet` in the new topic, with nothing to clean up.
--
-- `message_thread_id` IS NULLABLE ON PURPOSE. Telegram sends NO
-- `message_thread_id` for a forum's General topic, and inventing one would
-- address a topic that does not exist. NULL here means exactly what Telegram
-- meant: "post to the group, no thread".
--
-- The key set is not constrained by a CHECK: the application owns the
-- vocabulary (worker/lib/telegramAdmin.ts TOPIC_KEYS) and refuses an unknown
-- key at the door with the list of valid ones. A CHECK here would make adding
-- the next topic a migration instead of a constant.
CREATE TABLE IF NOT EXISTS telegram_admin_topics (
  topic_key TEXT PRIMARY KEY CHECK (topic_key <> ''),
  message_thread_id INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  configured_by TEXT NOT NULL,
  configured_by_tg INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ------------------------------------------------- the second bot's dedup
-- A SEPARATE TABLE, and this is the whole reason for it.
--
-- `telegram_updates.update_id` is a BARE INTEGER PRIMARY KEY (0003), and
-- Telegram's update_id sequence is PER BOT: a brand-new bot starts near zero,
-- squarely inside the range the customer bot has been using for a year. The
-- webhook treats a PK collision as "already handled" and answers 200 without
-- processing and without logging, so a shared table would make the admin bot
-- silently drop most of its first updates — and Telegram would never retry
-- them, because it was told they were fine.
CREATE TABLE IF NOT EXISTS telegram_admin_updates (
  update_id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- The sweeper's index: old ids are prunable, the recent ones are the dedup.
CREATE INDEX IF NOT EXISTS idx_tg_admin_updates_seen ON telegram_admin_updates(received_at);

-- ------------------------------------------- which bot carries which message
-- A notification row already knows WHERE it goes (`target_chat`). Once two
-- bots exist it must also know WHO sends it, because a chat id is only
-- addressable by the bot that shares the conversation, and because the edit
-- that stamps the final decision onto the message (`closeNotificationMessage`)
-- happens later, from the site, with no callback to say which bot delivered it.
--
-- DEFAULT 'customer' is what every row written before today is: delivered by
-- the single bot that existed. No backfill, no behaviour change.
ALTER TABLE tg_admin_notifications ADD COLUMN bot TEXT NOT NULL DEFAULT 'customer';
-- The forum topic, when the destination is one. NULL = no thread (a plain
-- group, a channel, or a forum's General topic) — the same honest NULL as
-- `telegram_admin_topics.message_thread_id`.
ALTER TABLE tg_admin_notifications ADD COLUMN message_thread_id INTEGER;
-- Which topic the router CHOSE, kept for the routing audit: '' for a legacy
-- row, 'wallet' for a routed one, 'general' when the wallet topic was missing
-- and the fallback carried it.
ALTER TABLE tg_admin_notifications ADD COLUMN topic_key TEXT NOT NULL DEFAULT '';
