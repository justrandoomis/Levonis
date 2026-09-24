-- ============================================================================
--  0115 — «عند تأكيد الزبون الاستلام أو بعد 3 أيام» : A STORE ORDER'S MONEY
--         WAITS FOR ITS CUSTOMER.
-- ============================================================================
-- NONDESTRUCTIVE: one nullable ADD COLUMN on `orders` and four
-- `CREATE INDEX IF NOT EXISTS`. Nothing is dropped, no CHECK is added or
-- touched, and NO ROW IS BACKFILLED — every order that exists when this
-- applies reads `receipt_confirmed_at IS NULL`, which is the truth about it:
-- no customer ever confirmed receiving anything, because there was no way to.
--
-- ---------------------------------------------------------------------------
--  THE OWNER'S RULE (docs/MERCHANT_PLATFORM.md §2, 2026-09-24)
-- ---------------------------------------------------------------------------
-- «When does a store order's money become available to the merchant? — When
--  the customer confirms receipt, or automatically 3 days after delivery if no
--  dispute was opened. A merchant's «تم التسليم» alone never releases money.»
--
-- It used to: the merchant's own «تم التسليم» tap flipped the sale credit to
-- `available` in the same batch (audit 02 B10), and a payout could follow the
-- same afternoon for goods nobody had confirmed receiving.
--
-- `receipt_confirmed_at` is the customer's half — written once, by
-- POST /api/orders/:id/confirm-receipt, and never cleared. The three-day half
-- needs no column: `orders.delivered_at` (0002) is its clock, and the store
-- path now stamps it (COALESCE, never re-stamped).
--
-- ---------------------------------------------------------------------------
--  THE INDEXES — each one answers one sweep's only question
-- ---------------------------------------------------------------------------
--  · pending store-sale credits: the release sweep starts from these rows
--    rather than scanning every order the shop ever took;
--  · open complaints / support tickets BY ORDER: an open one freezes the
--    release, and the sweep asks per candidate order;
--  · active store-checkout wallet holds by age: the orphan-hold sweep (B13).
ALTER TABLE orders ADD COLUMN receipt_confirmed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_payout_ledger_pending_sale
  ON merchant_payout_ledger(order_id)
  WHERE kind = 'sale_credit' AND state = 'pending';

CREATE INDEX IF NOT EXISTS idx_community_complaints_order
  ON community_complaints(order_id, status)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_tickets_order
  ON support_tickets(order_id, state)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_holds_store_active
  ON wallet_holds(created_at)
  WHERE state = 'active' AND ref_type = 'store_order';
