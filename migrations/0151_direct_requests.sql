-- ============================================================================
--  0151 — A REQUEST ADDRESSED TO ONE STORE (docs/COMMUNITY_COMMERCE_CHAT.md §2 D4, D5)
-- ============================================================================
-- «طلب طباعة» sent INSIDE a store's conversation, and «عرض سعر» a store writes
-- there, both ride the request → offer → escrow flow that already exists: the
-- customer owns the request, the store quotes it, acceptance holds the money
-- and freezes the quote, and release waits for the customer's confirmation. No
-- second escrow and no second orders table — the same `community_requests`,
-- `community_offers` and `community_orders` rows, with three columns saying
-- that this request was addressed to ONE store and never to the board.
--
--   target_merchant_id  the only store that may see and quote it
--   origin_chat_id      the conversation it was made in (where its cards and
--                       its order's system cards are posted)
--   created_by          'customer' — the customer's own «طلب طباعة»;
--                       'merchant' — made by the store's quote for the customer
--                       of that conversation (D5): nothing is charged, nobody
--                       else sees it, and the customer's acceptance is the
--                       consent.
--
-- `visibility` gains the value 'direct' (the column has no CHECK). Every board
-- reader already asks `visibility = 'public'` — the board, the matching, the
-- workshop list, the workspace, the public API — so a direct request is on
-- none of them with no change of theirs.
--
-- THE DATABASE KEEPS THE PROMISE, NOT ONLY THE ROUTES:
--   · a direct request names its store;
--   · a request never moves onto or off the board by changing `visibility`;
--   · its store never changes;
--   · and an offer on it can only be that store's (a merchant cannot quote —
--     or be tricked into holding — another store's private job).
--
-- NONDESTRUCTIVE: three ADD COLUMNs (NULL / a default), two partial indexes and
-- four triggers that only refuse writes no route makes. No row is rewritten.
-- ============================================================================

ALTER TABLE community_requests ADD COLUMN target_merchant_id TEXT REFERENCES community_merchants(id);
ALTER TABLE community_requests ADD COLUMN origin_chat_id TEXT REFERENCES chats(id);
ALTER TABLE community_requests ADD COLUMN created_by TEXT NOT NULL DEFAULT 'customer'
  CHECK (created_by IN ('customer','merchant'));

CREATE INDEX IF NOT EXISTS idx_requests_target
  ON community_requests(target_merchant_id, state) WHERE target_merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_requests_origin_chat
  ON community_requests(origin_chat_id) WHERE origin_chat_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_request_direct_names_store
BEFORE INSERT ON community_requests
FOR EACH ROW
WHEN NEW.visibility = 'direct' AND NEW.target_merchant_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'DIRECT_REQUEST_NEEDS_STORE');
END;

CREATE TRIGGER IF NOT EXISTS trg_request_direct_visibility_locked
BEFORE UPDATE OF visibility ON community_requests
FOR EACH ROW
WHEN (OLD.visibility = 'direct') <> (NEW.visibility = 'direct')
BEGIN
  SELECT RAISE(ABORT, 'DIRECT_REQUEST_VISIBILITY_LOCKED');
END;

CREATE TRIGGER IF NOT EXISTS trg_request_target_locked
BEFORE UPDATE OF target_merchant_id ON community_requests
FOR EACH ROW
WHEN OLD.target_merchant_id IS NOT NEW.target_merchant_id
BEGIN
  SELECT RAISE(ABORT, 'DIRECT_REQUEST_TARGET_LOCKED');
END;

CREATE TRIGGER IF NOT EXISTS trg_offer_direct_store_only
BEFORE INSERT ON community_offers
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM community_requests r
              WHERE r.id = NEW.request_id AND r.visibility = 'direct'
                AND r.target_merchant_id IS NOT NEW.merchant_id)
BEGIN
  SELECT RAISE(ABORT, 'DIRECT_REQUEST_OTHER_STORE');
END;
