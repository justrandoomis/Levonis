-- Levonis migration 0020 — give an admin stock adjustment a DIRECTION
-- (product-form mandate §7: "اعرض المخزون المتاح لكل تركيبة في لوحة الإدارة،
-- مع low-stock threshold وسجل تعديلات").
--
-- 0018 created inventory_ledger with CHECK (kind IN
-- ('reserve','release','deduct','restore','adjust')) and CHECK (qty > 0). A
-- single 'adjust' kind cannot express a write-off, and reusing 'deduct' for
-- one would be wrong: 'deduct' asserts that a matching reservation exists and
-- is guarded on it. So the kind list gains an explicit pair.
--
-- The rebuild is trivially safe: inventory_ledger is introduced by 0018 and
-- nothing references it. Rows are copied verbatim; a database that already ran
-- 0018 keeps whatever it recorded.

CREATE TABLE inventory_ledger_new (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('base','option','color','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  -- reserve/release  : hold and un-hold units without moving stock
  -- deduct           : a reservation becomes a real decrement (order confirmed)
  -- restore          : a decrement is reversed (order cancelled/returned)
  -- adjust_in        : admin correction upward (recount, delivery received)
  -- adjust_out       : admin correction downward (damage, loss, write-off)
  -- 'adjust'         : retained so any row written before this migration stays
  --                    readable; no new row uses it.
  kind TEXT NOT NULL CHECK (kind IN
    ('reserve','release','deduct','restore','adjust','adjust_in','adjust_out')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  order_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_user_id TEXT REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO inventory_ledger_new
  (id, product_id, scope, scope_id, kind, qty, order_id, idempotency_key, actor_user_id, reason, created_at)
  SELECT id, product_id, scope, scope_id, kind, qty, order_id, idempotency_key, actor_user_id, reason, created_at
    FROM inventory_ledger;
DROP TABLE inventory_ledger;
ALTER TABLE inventory_ledger_new RENAME TO inventory_ledger;
CREATE INDEX idx_inventory_ledger_product ON inventory_ledger(product_id, created_at DESC);
CREATE INDEX idx_inventory_ledger_order ON inventory_ledger(order_id);
