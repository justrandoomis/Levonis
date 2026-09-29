-- ============================================================================
--  0150 — A CONVERSATION CAN CARRY A CARD (docs/COMMUNITY_COMMERCE_CHAT.md §3.1)
-- ============================================================================
-- «المحادثة هي مركز العملية»: a product, a store, a print request, a quote, a
-- private custom product or an order, sent INTO the store's conversation as a
-- real, typed message — not a pasted link.
--
-- NONDESTRUCTIVE: six nullable (or defaulted) ADD COLUMNs on `chat_messages`
-- and three partial indexes. Nothing is dropped, no existing CHECK is touched,
-- no row is rewritten. Every message written before this reads
-- `card_type IS NULL, is_system = 0` — an ordinary message, as before.
--
-- ---------------------------------------------------------------------------
--  WHY COLUMNS AND NOT A WIDER `kind`
-- ---------------------------------------------------------------------------
-- `kind` carries 0001's `CHECK (kind IN ('text','image'))`, and this project
-- does not rebuild a live table to widen a CHECK (0110 made the same call for
-- attachments). A card is stored `kind = 'text'` with a short plain `body` —
-- the entity's own name — so an older client, the conversation list's preview
-- and the inbox search keep working; `card_type` says what it really is.
--
--   card_type      product · custom_product · print_request · quote · order ·
--                  custom_order · store
--   card_ref       the entity's id — NEVER a price, a name or a picture. The
--                  server checks it belongs to THIS thread's store and customer
--                  before anything is written.
--   card_snapshot  JSON, written ONCE by the server at send time: what the card
--                  showed when it was sent (the agreement is never rewritten).
--                  The CURRENT state is computed on every read.
--   card_event_key the idempotency of a server-written system card
--                  (`order:<id>:placed` …): one per thread per event.
--   is_system      1 = written by the server about an event (an order placed,
--                  a job funded…), drawn centred, never as someone's bubble.
--                  `sender_id` is the account whose action it records.
--   client_id      the sender's own id for one send: a retried send of the
--                  same client_id answers the message already stored.
--
-- `card_snapshot` holds `/files/…` picture paths and is registered with the
-- media sweeper in the same change (worker/lib/mediaRefs.ts): a picture a card
-- showed outlives the product that was deleted after it was sent.
-- ============================================================================

ALTER TABLE chat_messages ADD COLUMN card_type TEXT
  CHECK (card_type IS NULL OR card_type IN ('product','custom_product','print_request','quote','order','custom_order','store'));
ALTER TABLE chat_messages ADD COLUMN card_ref TEXT;
ALTER TABLE chat_messages ADD COLUMN card_snapshot TEXT;
ALTER TABLE chat_messages ADD COLUMN card_event_key TEXT;
ALTER TABLE chat_messages ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1));
ALTER TABLE chat_messages ADD COLUMN client_id TEXT;

-- One system card per event per thread: the poster's INSERT OR IGNORE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_event
  ON chat_messages(chat_id, card_event_key) WHERE card_event_key IS NOT NULL;
-- One stored message per client send.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_client
  ON chat_messages(chat_id, sender_id, client_id) WHERE client_id IS NOT NULL;
-- «Which conversations show this quote / this product?» — the card by its entity.
CREATE INDEX IF NOT EXISTS idx_chat_messages_card
  ON chat_messages(card_type, card_ref) WHERE card_type IS NOT NULL;
