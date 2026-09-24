-- ============================================================================
--  0118 — TWO SANCTIONS THAT NO LONGER OVERWRITE EACH OTHER, AN ADMIN HIDE THE
--         MERCHANT CANNOT UNDO, AND A STORE ORDER'S THREAD THAT REACHES ITS
--         SELLER.
-- ============================================================================
-- Wave 1 of the merchant platform (docs/MERCHANT_PLATFORM.md), stream W1-C.
--
-- NONDESTRUCTIVE. Two nullable/defaulted ADD COLUMNs on `community_products`,
-- and three idempotent backfills. Nothing is dropped, no CHECK is touched, no
-- table is rebuilt. Every statement can run twice: the second run matches no
-- row it did not already fix (see each one).
--
-- ---------------------------------------------------------------------------
--  1. THE ADMIN'S HIDE IS ITS OWN STATE (audit 01 B9)
-- ---------------------------------------------------------------------------
-- `POST /api/admin/community/products/:id/hide` wrote `lifecycle` and
-- `status` = 'hidden' — the SAME two columns the merchant's own editor writes —
-- so one `PATCH /api/merchant/products/:id {lifecycle:'active'}` put the
-- product straight back on the storefront. A moderation decision the moderated
-- party can undo with one tap is not a decision.
--
--   admin_hidden_at      NULL = not hidden by Levonis; otherwise when it was.
--   admin_hidden_reason  what the merchant is shown, so they know WHY.
--
-- While `admin_hidden_at` is set the merchant route refuses to publish the
-- product (409 PRODUCT_HIDDEN_BY_ADMIN) AND computes `status` in SQL as
-- 'hidden' whatever `lifecycle` says (worker/routes/merchant.ts), so no path —
-- a race, a future route — can surface it. `lifecycle` stays the merchant's:
-- lifting the hide restores exactly what the merchant had chosen.
ALTER TABLE community_products ADD COLUMN admin_hidden_at TEXT;
ALTER TABLE community_products ADD COLUMN admin_hidden_reason TEXT NOT NULL DEFAULT '';

-- Products an admin hid before this column existed, and that are still hidden
-- with no later edit by their merchant: the audit log is the only record of
-- who hid them. (The hide had no control in the admin panel, so this is
-- expected to match few rows or none — it exists so none is missed.)
UPDATE community_products
   SET admin_hidden_at = (SELECT MAX(a.created_at) FROM audit_log a
                           WHERE a.action = 'admin.product_hidden' AND a.target = community_products.id)
 WHERE admin_hidden_at IS NULL
   AND status = 'hidden'
   AND EXISTS (SELECT 1 FROM audit_log a
                WHERE a.action = 'admin.product_hidden' AND a.target = community_products.id)
   AND NOT EXISTS (SELECT 1 FROM audit_log m
                    WHERE m.action IN ('merchant.product_updated', 'merchant.product_archived')
                      AND m.target = community_products.id
                      AND m.created_at > (SELECT MAX(a.created_at) FROM audit_log a
                                           WHERE a.action = 'admin.product_hidden'
                                             AND a.target = community_products.id));

-- ---------------------------------------------------------------------------
--  2. A STORE THE OLD MERCHANT SANCTION SUSPENDED GOES BACK TO ITS MERCHANT
--     (audit 04 B2, audit 01 B8)
-- ---------------------------------------------------------------------------
-- `POST /api/admin/community/merchants/:id/status` used to write the store as
-- well: 'suspended' with a suspended merchant, 'active' with anything else.
-- It writes only the merchant row now, and every public reader treats a
-- suspended MERCHANT as shutting their shop (worker/lib/merchantAuth.ts
-- `storeIsSuspended`, the cart and checkout's `m.status` check).
--
-- What is left over is the stores the old code suspended ALONG WITH their
-- merchant. Under the new model nothing would ever lift those: restoring the
-- merchant no longer touches the store, and the store would stay suspended by
-- a decision nobody made about the store. They are handed back to their
-- merchant as 'paused' — closed, and re-openable by the merchant alone — which
-- is the one state that neither re-opens a shop against its merchant's will
-- (the old restore did exactly that) nor keeps it shut on a sanction that was
-- never the store's. While the merchant stays suspended the shop is exactly as
-- unavailable as before, because the merchant row still says so.
--
-- A store an admin suspended ON ITS OWN keeps its suspension: its most recent
-- `admin.store_status` audit row is a suspension. The status reason the
-- cascade copied from the merchant is cleared with it — it explained the
-- merchant's sanction, which the merchant row still carries.
UPDATE merchant_stores
   SET status = 'paused', status_reason = ''
 WHERE status = 'suspended'
   AND merchant_id IN (SELECT id FROM community_merchants WHERE status = 'suspended')
   AND COALESCE((SELECT a.detail LIKE '%"status":"suspended"%'
                   FROM audit_log a
                  WHERE a.action = 'admin.store_status' AND a.target = merchant_stores.id
                  ORDER BY a.id DESC LIMIT 1), 0) = 0;

-- ---------------------------------------------------------------------------
--  3. THE SELLER IS IN THEIR OWN ORDER'S THREAD (audit 04 B10)
-- ---------------------------------------------------------------------------
-- A customer opening «محادثة حول هذا الطلب» on a merchant-store order created
-- a thread whose only participant was the customer: the shop desk excludes
-- merchant orders and the seller was never added, so the message reached
-- nobody. The route now adds the seller when the thread is opened and when a
-- message is sent (worker/routes/chats.ts); this adds them to the threads that
-- already exist, so what customers already wrote is in the seller's list the
-- moment this lands. `INSERT OR IGNORE` on the (chat_id, user_id) primary key
-- makes it a no-op for every seller already present.
INSERT OR IGNORE INTO chat_participants (chat_id, user_id)
SELECT ch.id, m.user_id
  FROM chats ch
  JOIN orders o ON o.id = ch.order_id
  JOIN community_merchants m ON m.id = o.merchant_id
 WHERE o.merchant_id IS NOT NULL;
