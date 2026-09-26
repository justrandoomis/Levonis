-- ============================================================================
--  0140 — ORDER PRICE ADJUSTMENT, APPROVED BY THE CUSTOMER
-- ============================================================================
-- The owner (2026-09-26): «اجعل بإمكان الأدمن التعديل على السعر النهائي لطلب
-- المستخدم، لكن عند التعديل يبقى الطلب معلقا إلى أن يوافق الزبون … فيرسل
-- إشعار للمستخدم بأنه يجب الموافقة على السعر حتى يتمكن من المتابعة للطلب مع
-- زر inline مثلا في التليجرام عند الضغط عليه يوافق».
--
-- ONE ROW PER PROPOSAL. A financial admin names a new final total and a reason
-- the customer reads; the row is `pending` until the customer approves or
-- rejects it (site button or Telegram inline button), or the admin withdraws
-- it. The money is NOT touched at proposal time: every figure on the order
-- moves only in the approval batch (worker/lib/orderPriceAdjust.ts), fenced on
-- the figures this row froze, so an approval can never land on an order whose
-- money changed underneath it.
--
-- THE HOLD. `orders.price_hold_id` names the one pending proposal. While it is
-- set, the trigger below aborts ANY write that moves `status` or `stage` —
-- every door (admin panel, stage sweep, courier sync, Telegram confirm) meets
-- the same refusal, including one that read the order a millisecond before the
-- proposal landed. The only statements that may move the order while it is
-- held are the ones that release the hold in the SAME write (the customer's
-- own cancellation sets `price_hold_id = NULL` beside `status = 'cancelled'`).
--
-- `orders.price_adjustment_iqd` is the SIGNED sum of every approved delta, the
-- line invoices, receipts and the money view print as «تعديل السعر», so the
-- lines above the total still add up to it. Items are never rewritten.
--
-- NONDESTRUCTIVE: two nullable/defaulted columns, one new table, its indexes
-- and one trigger. No existing row changes: `price_hold_id` is NULL on every
-- order, so the trigger never fires until a proposal exists.
ALTER TABLE orders ADD COLUMN price_hold_id TEXT;
ALTER TABLE orders ADD COLUMN price_adjustment_iqd INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS order_price_adjustments (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- The order's customer when the proposal was made — the only account whose
  -- approval counts (checked again against `orders.user_id` at decision time).
  user_id            TEXT NOT NULL REFERENCES users(id),
  state              TEXT NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending','approved','rejected','withdrawn','void')),
  -- The money as it stood when proposed, and as it will stand if approved.
  old_total_iqd      INTEGER NOT NULL CHECK (old_total_iqd >= 0),
  new_total_iqd      INTEGER NOT NULL CHECK (new_total_iqd > 0),
  delta_iqd          INTEGER NOT NULL CHECK (delta_iqd <> 0 AND delta_iqd = new_total_iqd - old_total_iqd),
  old_due_iqd        INTEGER NOT NULL CHECK (old_due_iqd >= 0),
  new_due_iqd        INTEGER NOT NULL CHECK (new_due_iqd >= 0),
  old_wallet_iqd     INTEGER NOT NULL CHECK (old_wallet_iqd >= 0),
  new_wallet_iqd     INTEGER NOT NULL CHECK (new_wallet_iqd >= 0 AND new_wallet_iqd <= old_wallet_iqd),
  -- Dinars returned to the wallet on approval (a price cut below what the
  -- wallet prepaid). 0 otherwise.
  wallet_refund_iqd  INTEGER NOT NULL DEFAULT 0 CHECK (wallet_refund_iqd = old_wallet_iqd - new_wallet_iqd),
  -- Shown to the customer verbatim; required.
  reason             TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  -- Optional breakdown the admin adds («+25,000 شحن جوي إضافي …»).
  note               TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  proposed_by        TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at         TEXT,
  -- The admin (withdraw) or the customer (approve / reject) who closed it.
  decided_by         TEXT,
  decided_via        TEXT NOT NULL DEFAULT ''
                       CHECK (decided_via IN ('', 'web', 'telegram', 'admin', 'customer_cancel')),
  -- A random value the deciding batch writes and every dependent statement in
  -- the SAME batch re-reads, so of two concurrent presses exactly one batch
  -- commits (the other's fence aborts it whole, audit row included).
  decision_token     TEXT,
  -- Where the customer's Telegram prompt was sent, so the outcome can be
  -- stamped onto that message even when the decision came from the site.
  tg_chat_id         INTEGER,
  tg_message_id      INTEGER,
  UNIQUE (order_id, idempotency_key)
);
-- ONE OPEN PROPOSAL PER ORDER, enforced by the database: a second concurrent
-- proposal aborts its whole batch on this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_price_adj_one_pending
  ON order_price_adjustments(order_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_order_price_adj_order ON order_price_adjustments(order_id, created_at DESC);
-- The board's «بانتظار موافقة الزبون» filter and count.
CREATE INDEX IF NOT EXISTS idx_orders_price_hold ON orders(price_hold_id) WHERE price_hold_id IS NOT NULL;

-- THE FENCE. Fires only when a held order's status or stage would change while
-- the same write leaves the hold in place.
CREATE TRIGGER IF NOT EXISTS trg_orders_price_hold_freeze
BEFORE UPDATE OF status, stage ON orders
FOR EACH ROW
WHEN OLD.price_hold_id IS NOT NULL
 AND NEW.price_hold_id IS NOT NULL
 AND (NEW.status IS NOT OLD.status OR NEW.stage IS NOT OLD.stage)
BEGIN
  SELECT RAISE(ABORT, 'PRICE_APPROVAL_PENDING');
END;
