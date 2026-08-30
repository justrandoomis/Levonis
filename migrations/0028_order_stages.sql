-- 0028 — order tracking stages, their schedule, and the history behind them.
--
-- WHY NOT `orders.status`. That column has carried a CHECK constraint since
-- 0001 pinning it to six values, and the stock lifecycle, the invoice writer
-- and every existing filter read it. Nineteen tracking stages cannot go in
-- there without dropping the constraint and rewriting all of them. So the
-- stage lives beside it and maps DOWN to one of the six: the legacy column
-- stays the authority for money and stock, the stage is the authority for
-- what the customer is told.
--
-- WHY THE SCHEDULE IS ON THE ROW. The owner ruled out timers in the browser.
-- A tab's timer dies with the tab, fires twice when two are open, and never
-- fires for a sleeping customer. The order carries its own alarm clock —
-- next_stage / next_stage_at — and a cron sweep promotes whatever is due. A
-- manual change overwrites those two columns, which is how it cancels the
-- transition that was pending rather than merely ignoring it.
--
-- BACKFILLED FROM THE STATUS EACH ORDER ALREADY HAS, mapped to the EARLIEST
-- stage carrying it. An order marked 'shipped' becomes 'handed_to_carrier',
-- never 'arrived_iraq': the mapping may under-report progress, never invent
-- it. stage_changed_at falls back to updated_at, which is the closest honest
-- record of when the order last moved.

ALTER TABLE orders ADD COLUMN stage TEXT NOT NULL DEFAULT 'received';
ALTER TABLE orders ADD COLUMN stage_changed_at TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN stage_source TEXT NOT NULL DEFAULT 'automatic';
ALTER TABLE orders ADD COLUMN next_stage TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN next_stage_at TEXT;

-- The courier's own identifiers, stored the moment a shipment is created so a
-- failed sync can be retried against the same shipment instead of creating a
-- second one. Empty until a shipment exists.
ALTER TABLE orders ADD COLUMN delivery_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN delivery_remote_id TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN delivery_tracking_no TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN delivery_status_id TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN delivery_status_text TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN delivery_synced_at TEXT;
ALTER TABLE orders ADD COLUMN delivery_error TEXT NOT NULL DEFAULT '';

UPDATE orders
   SET stage = CASE status
                 WHEN 'pending'    THEN 'received'
                 WHEN 'confirmed'  THEN 'confirmed'
                 WHEN 'processing' THEN CASE WHEN shipping_type = 'direct'
                                             THEN 'preparing' ELSE 'supplier_preparing' END
                 WHEN 'shipped'    THEN CASE WHEN shipping_type = 'direct'
                                             THEN 'out_for_delivery' ELSE 'handed_to_carrier' END
                 WHEN 'delivered'  THEN 'delivered'
                 WHEN 'cancelled'  THEN 'cancelled'
                 ELSE 'received'
               END
 WHERE stage = 'received';

UPDATE orders SET stage_changed_at = COALESCE(NULLIF(updated_at, ''), created_at)
 WHERE stage_changed_at = '';

-- Every move an order ever made, and who made it. The owner asked for exactly
-- these columns. It is append-only: a corrected stage adds a row, it never
-- rewrites one, because "we told the customer it had shipped" stays true even
-- after the admin takes it back.
CREATE TABLE IF NOT EXISTS order_status_history (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL CHECK (source IN ('manual','automatic','delivery_api','system')),
  changed_at   TEXT NOT NULL,
  changed_by   TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_osh_order ON order_status_history(order_id, changed_at);

-- The sweep's only query: "which orders are due?". Without this it is a table
-- scan of every order the shop has ever taken, every minute.
CREATE INDEX IF NOT EXISTS idx_orders_next_stage_at ON orders(next_stage_at)
  WHERE next_stage_at IS NOT NULL;

-- Looking an order up by what the courier calls it, for a webhook or a sync.
CREATE INDEX IF NOT EXISTS idx_orders_delivery_remote ON orders(delivery_provider, delivery_remote_id)
  WHERE delivery_remote_id != '';

-- The courier's official status list, fetched from the provider rather than
-- hardcoded — "اجلب قائمة الحالات الرسمية من GET /v1/merchant/statuses ولا
-- تعتمد على نصوص hardcoded". internal_stage is the owner's mapping and starts
-- empty: an unmapped courier status must leave the order alone, not guess.
CREATE TABLE IF NOT EXISTS delivery_status_map (
  provider       TEXT NOT NULL,
  remote_id      TEXT NOT NULL,
  remote_text    TEXT NOT NULL DEFAULT '',
  internal_stage TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (provider, remote_id)
);
