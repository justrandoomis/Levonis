-- ============================================================================
--  0124 — A MERCHANT HEARS ABOUT THEIR OWN BUSINESS, AND A STORE OWNS ITS
--         CONVERSATIONS.
-- ============================================================================
-- Wave 2 of the merchant platform (docs/MERCHANT_PLATFORM.md §4.8), stream W2-E.
--
-- NONDESTRUCTIVE. Four ADD COLUMNs with defaults, three indexes created IF NOT
-- EXISTS, and idempotent backfills (each matches only rows it has not already
-- fixed, so a second run changes nothing). Nothing is dropped, no CHECK is
-- widened, no table is rebuilt. The ADD COLUMNs cannot run twice — SQLite has
-- no ADD COLUMN IF NOT EXISTS — which is safe because the runner records this
-- file as applied; do not re-run it by hand.
--
-- ---------------------------------------------------------------------------
--  1. TWO SWITCHES FOR THE TWO NEW KINDS OF NEWS (merchant_notification_
--     preferences)
-- ---------------------------------------------------------------------------
-- The nine switches of 0030 cover orders, requests, messages, reviews,
-- followers, complaints, the subscription, system alerts and marketing. Two
-- merchant notifications fit none of them: a product crossing its low-stock
-- threshold, and money becoming available / a payout being paid. Each gets its
-- own switch, ON by default like the rest (an absent row is the platform
-- default, which is on).
--
-- WHAT A SWITCH MEANS NOW (worker/lib/merchantNotify.ts): the in-app row is
-- ALWAYS written — it is the record of what happened to the business, and the
-- workspace's notification centre is where the merchant reads it. A switch
-- decides whether the same news ALSO goes out on the merchant's outside
-- channels (Telegram, WhatsApp, email). `complaints`, `subscription_expiry`
-- and `system_alerts` stay forced on (§61).
ALTER TABLE merchant_notification_preferences ADD COLUMN low_stock INTEGER NOT NULL DEFAULT 1;
ALTER TABLE merchant_notification_preferences ADD COLUMN payouts INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
--  2. A THREAD KNOWS WHEN IT LAST MOVED (chats.last_message_at)
-- ---------------------------------------------------------------------------
-- The merchant inbox pages a store's threads newest-activity first, by cursor
-- (GET /api/merchant/inbox). Ordering by a correlated MAX() over messages
-- forces every thread of the store to be read before the first page can be
-- cut; a column the send route stamps makes it one index range. NULL = no
-- message yet (sorted last).
ALTER TABLE chats ADD COLUMN last_message_at TEXT;

UPDATE chats
   SET last_message_at = (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.chat_id = chats.id)
 WHERE last_message_at IS NULL
   AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = chats.id);

CREATE INDEX IF NOT EXISTS idx_chats_store_activity
  ON chats(store_id, last_message_at DESC, id DESC)
  WHERE store_id IS NOT NULL;

-- ---------------------------------------------------------------------------
--  3. WHO EACH PARTICIPANT IS (chat_participants.role)
-- ---------------------------------------------------------------------------
--   customer   the shopper / requester side of a store conversation
--   merchant   the store's owner
--   support    Levonis staff on the shop's OWN order threads (the desk)
--   ''         a personal direct message — nobody is anybody's customer
-- Membership is still the whole access rule (worker/routes/chats.ts); the role
-- only says which side of the counter someone stands on, so the inbox can name
-- the customer and a future staff seat can be added without guessing.
ALTER TABLE chat_participants ADD COLUMN role TEXT NOT NULL DEFAULT ''
  CHECK (role IN ('', 'customer', 'merchant', 'support'));

-- ---------------------------------------------------------------------------
--  4. A STORE ORDER'S THREAD BELONGS TO THE STORE (0031's context columns)
-- ---------------------------------------------------------------------------
-- 0031 added context_type / context_id / merchant_id / store_id to `chats`
-- and nothing ever wrote them. Every thread on a merchant-store order is now
-- stamped as the store's: context 'store_order', the order as its context,
-- the store and merchant from the order row. The shop's own order threads and
-- personal direct messages are left alone — they are not a store's.
UPDATE chats
   SET context_type = 'store_order',
       context_id = chats.order_id,
       store_id = (SELECT s.id FROM orders o JOIN merchant_stores s ON s.merchant_id = o.merchant_id WHERE o.id = chats.order_id),
       merchant_id = (SELECT o.merchant_id FROM orders o WHERE o.id = chats.order_id)
 WHERE context_type = ''
   AND order_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM orders o JOIN merchant_stores s ON s.merchant_id = o.merchant_id
                WHERE o.id = chats.order_id AND o.merchant_id IS NOT NULL);

-- Roles on those threads: the order's customer, and the store's owner. (0119
-- already removed anybody else from them.)
UPDATE chat_participants
   SET role = 'customer'
 WHERE role = ''
   AND EXISTS (SELECT 1 FROM chats ch JOIN orders o ON o.id = ch.order_id
                WHERE ch.id = chat_participants.chat_id AND ch.context_type = 'store_order'
                  AND o.user_id = chat_participants.user_id);
UPDATE chat_participants
   SET role = 'merchant'
 WHERE role = ''
   AND EXISTS (SELECT 1 FROM chats ch JOIN merchant_stores s ON s.id = ch.store_id
                WHERE ch.id = chat_participants.chat_id AND ch.context_type = 'store_order'
                  AND s.user_id = chat_participants.user_id);
-- The shop's own order threads: the customer, and the support desk.
UPDATE chat_participants
   SET role = CASE WHEN EXISTS (SELECT 1 FROM chats ch JOIN orders o ON o.id = ch.order_id
                                 WHERE ch.id = chat_participants.chat_id AND o.user_id = chat_participants.user_id)
                   THEN 'customer' ELSE 'support' END
 WHERE role = ''
   AND EXISTS (SELECT 1 FROM chats ch JOIN orders o ON o.id = ch.order_id
                WHERE ch.id = chat_participants.chat_id AND ch.context_type = '' AND o.merchant_id IS NULL);

-- ONE thread per store and customer, and one per store and request: a second
-- «راسل المتجر» returns the first conversation rather than opening a parallel
-- one. (Store-order threads are already one per order: idx_chats_order.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_store_context
  ON chats(context_type, store_id, context_id)
  WHERE context_type IN ('store', 'request');

-- ---------------------------------------------------------------------------
--  5. THE MERCHANT'S OLDEST NOTICES POINT AT THE ORDER, NOT THE DASHBOARD
-- ---------------------------------------------------------------------------
-- Wave 1's new/cancelled store-order notices linked to `/merchant` because the
-- workspace had no addresses. It has now (packages/contracts/src/
-- merchantRoutes.ts); the rows already written open the order they are about.
--
-- They also take the merchant kinds the notification centre lists (kind, not a
-- column, is what makes a notification the STORE's — worker/lib/
-- merchantNotify.ts): a new order is `new_order`, a cancellation the merchant
-- must not ship is `order_needs_action`, and a customer's line on a store
-- thread is `new_message`, opening that thread in the inbox.
UPDATE user_notifications
   SET kind = CASE WHEN event_key LIKE 'store\_order.new:%' ESCAPE '\' THEN 'new_order' ELSE 'order_needs_action' END
 WHERE kind = 'order_update'
   AND (event_key LIKE 'store\_order.new:%' ESCAPE '\' OR event_key LIKE 'store\_order.cancelled:%' ESCAPE '\');

UPDATE user_notifications
   SET kind = 'new_message',
       link = '/merchant/inbox/' || entity_id
 WHERE kind = 'chat_message'
   AND entity_type = 'chat'
   AND entity_id <> ''
   AND EXISTS (SELECT 1 FROM chats ch JOIN merchant_stores s ON s.id = ch.store_id
                WHERE ch.id = user_notifications.entity_id AND s.user_id = user_notifications.user_id);

UPDATE user_notifications
   SET link = '/merchant/orders/' || entity_id
 WHERE link = '/merchant'
   AND entity_type = 'order'
   AND entity_id <> ''
   AND (event_key LIKE 'store\_order.new:%' ESCAPE '\' OR event_key LIKE 'store\_order.cancelled:%' ESCAPE '\');
