-- Cancelled orders are retained for support for thirty days, then the durable
-- jobs sweep may permanently remove only never-fulfilled rows. The timestamp
-- is maintained in the database so every cancellation door (admin, customer,
-- expiry, payment failure) follows the same clock.

ALTER TABLE orders ADD COLUMN cancelled_at TEXT;

UPDATE orders
   SET cancelled_at = COALESCE(updated_at, created_at)
 WHERE status = 'cancelled' AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_cancelled_retention
  ON orders(status, cancelled_at);

CREATE TRIGGER IF NOT EXISTS trg_orders_mark_cancelled
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
BEGIN
  UPDATE orders
     SET cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_clear_cancelled
AFTER UPDATE OF status ON orders
WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
BEGIN
  UPDATE orders SET cancelled_at = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_insert_cancelled
AFTER INSERT ON orders
WHEN NEW.status = 'cancelled' AND NEW.cancelled_at IS NULL
BEGIN
  UPDATE orders
     SET cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = NEW.id;
END;
