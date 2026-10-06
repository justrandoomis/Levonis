-- What made an order (owner brief 2026-10-06 §21, docs/GIFTS_QUICK_BUY.md D15):
-- the ordinary cart checkout ('normal'), a Quick Buy session finalised after its
-- 30 minutes ('quick_buy'), or an order whose every line is a gift ('gift').
-- Reports and the admin list split on it; no money path reads it.
-- Additive: every existing order reads as 'normal'.
ALTER TABLE orders ADD COLUMN order_kind TEXT NOT NULL DEFAULT 'normal' CHECK (order_kind IN ('normal','quick_buy','gift'));
-- The Quick Buy session an order was finalised from. One order per session.
ALTER TABLE orders ADD COLUMN quick_buy_session_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_quick_buy_session ON orders(quick_buy_session_id) WHERE quick_buy_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_kind_created ON orders(order_kind, created_at) WHERE order_kind <> 'normal';
