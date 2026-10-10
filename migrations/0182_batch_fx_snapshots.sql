-- 0182 — A BATCH REMEMBERS THE EXCHANGE RATES OF ITS PURCHASE (FX programme plan §4.3, §9 §16-§19;
-- push FX-6). inventory_lots IS the batch.
-- ADDITIVE ONLY: nullable columns on inventory_lots and purchase_orders, one partial index and
-- triggers. Updates or deletes no existing row of any table and changes no cost, price or rate.
-- EVERY LOT RECEIVED BEFORE THIS MIGRATION KEEPS EVERY NEW COLUMN NULL and is never back-filled:
-- the read model shows it «بالدينار فقط» / known only in IQD (§18), or a figure DERIVED from its own
-- purchase document and labelled so — never one converted at today's rate. The immutability trigger
-- below refuses NULL → value exactly as it refuses value → value, so no later write can fill one in.
-- PRIVATE (owner only): every new column. The two assistant-visible lot reads (GET
-- /api/admin/inventory/lots, POST /api/admin/stock-operations/scan) select the pre-0182 columns by
-- name; the owner reads the snapshot through GET /api/admin/pricing/batches only (critique F14a).
-- Decimal CHECKs are written out in full (FX plan §4 DEC_POS; SQLite has no macros). No CASE here.

-- 1. purchase_orders: the VERSION of each central rate the purchase's FX-1 snapshot took (FX-1 stored
--    the values and the moment). Written by the same once-only statement (`WHERE fx_snapshot_at IS
--    NULL`); NULL on a snapshot taken before this migration and for a pair with no rate then.
ALTER TABLE purchase_orders ADD COLUMN fx_usd_iqd_version_at_purchase INTEGER
  CHECK (fx_usd_iqd_version_at_purchase IS NULL OR fx_usd_iqd_version_at_purchase > 0);
ALTER TABLE purchase_orders ADD COLUMN fx_eur_usd_version_at_purchase INTEGER
  CHECK (fx_eur_usd_version_at_purchase IS NULL OR fx_eur_usd_version_at_purchase > 0);
ALTER TABLE purchase_orders ADD COLUMN fx_cny_usd_version_at_purchase INTEGER
  CHECK (fx_cny_usd_version_at_purchase IS NULL OR fx_cny_usd_version_at_purchase > 0);

-- 2. The batch snapshot, written ONCE, in the lot's own INSERT at receipt (worker/lib/batchSnapshot.ts
--    through planReceive). Per unit, as the lot's cost columns are; the lot's landed IQD stays the
--    existing unit_cost_iqd (read through effectiveLotCostSql, so an owner reconciliation wins) —
--    no duplicate cost column.
--    snapshot_source: 'purchase' (a purchase document's receipt), 'legacy_incoming' (a bare incoming
--    record's receipt), 'adjustment' (reserved; found units carry no purchase and stay NULL today).
ALTER TABLE inventory_lots ADD COLUMN snapshot_version INTEGER CHECK (snapshot_version IS NULL OR snapshot_version = 1);
ALTER TABLE inventory_lots ADD COLUMN snapshot_source TEXT
  CHECK (snapshot_source IS NULL OR snapshot_source IN ('purchase','legacy_incoming','adjustment'));
ALTER TABLE inventory_lots ADD COLUMN purchase_id TEXT CHECK (purchase_id IS NULL OR length(purchase_id) <= 60);
-- the supplier's own currency and amount per unit (the invoice decimal), and a 'total'-mode line's total
ALTER TABLE inventory_lots ADD COLUMN supplier_original_currency TEXT
  CHECK (supplier_original_currency IS NULL OR supplier_original_currency IN ('IQD','USD','EUR','CNY'));
ALTER TABLE inventory_lots ADD COLUMN supplier_original_amount TEXT
  CHECK (supplier_original_amount IS NULL OR (supplier_original_amount GLOB '[0-9]*' AND supplier_original_amount NOT GLOB '*[^0-9.]*' AND supplier_original_amount NOT GLOB '*.*.*' AND supplier_original_amount NOT GLOB '*.' AND length(supplier_original_amount) <= 40));
ALTER TABLE inventory_lots ADD COLUMN supplier_cost_mode TEXT CHECK (supplier_cost_mode IS NULL OR supplier_cost_mode IN ('unit','total'));
ALTER TABLE inventory_lots ADD COLUMN supplier_line_total_original TEXT
  CHECK (supplier_line_total_original IS NULL OR (supplier_line_total_original GLOB '[0-9]*' AND supplier_line_total_original NOT GLOB '*[^0-9.]*' AND supplier_line_total_original NOT GLOB '*.*.*' AND supplier_line_total_original NOT GLOB '*.' AND length(supplier_line_total_original) <= 40));
-- the document's own rate: IQD per one unit of its currency (the rate actually paid)
ALTER TABLE inventory_lots ADD COLUMN exchange_rate_at_purchase TEXT
  CHECK (exchange_rate_at_purchase IS NULL OR (exchange_rate_at_purchase GLOB '[0-9]*' AND exchange_rate_at_purchase NOT GLOB '*[^0-9.]*' AND exchange_rate_at_purchase NOT GLOB '*.*.*' AND exchange_rate_at_purchase NOT GLOB '*.' AND length(exchange_rate_at_purchase) <= 32 AND CAST(exchange_rate_at_purchase AS REAL) > 0));
-- §17: the supplier cost in USD at purchase, and the three rates in force (U, E, C) with their versions
ALTER TABLE inventory_lots ADD COLUMN supplier_cost_usd_at_purchase TEXT
  CHECK (supplier_cost_usd_at_purchase IS NULL OR (supplier_cost_usd_at_purchase GLOB '[0-9]*' AND supplier_cost_usd_at_purchase NOT GLOB '*[^0-9.]*' AND supplier_cost_usd_at_purchase NOT GLOB '*.*.*' AND supplier_cost_usd_at_purchase NOT GLOB '*.' AND length(supplier_cost_usd_at_purchase) <= 48));
ALTER TABLE inventory_lots ADD COLUMN usd_iqd_rate_at_purchase TEXT
  CHECK (usd_iqd_rate_at_purchase IS NULL OR (usd_iqd_rate_at_purchase GLOB '[0-9]*' AND usd_iqd_rate_at_purchase NOT GLOB '*[^0-9.]*' AND usd_iqd_rate_at_purchase NOT GLOB '*.*.*' AND usd_iqd_rate_at_purchase NOT GLOB '*.' AND length(usd_iqd_rate_at_purchase) <= 32 AND CAST(usd_iqd_rate_at_purchase AS REAL) > 0));
ALTER TABLE inventory_lots ADD COLUMN eur_usd_rate_at_purchase TEXT
  CHECK (eur_usd_rate_at_purchase IS NULL OR (eur_usd_rate_at_purchase GLOB '[0-9]*' AND eur_usd_rate_at_purchase NOT GLOB '*[^0-9.]*' AND eur_usd_rate_at_purchase NOT GLOB '*.*.*' AND eur_usd_rate_at_purchase NOT GLOB '*.' AND length(eur_usd_rate_at_purchase) <= 32 AND CAST(eur_usd_rate_at_purchase AS REAL) > 0));
ALTER TABLE inventory_lots ADD COLUMN cny_usd_rate_at_purchase TEXT
  CHECK (cny_usd_rate_at_purchase IS NULL OR (cny_usd_rate_at_purchase GLOB '[0-9]*' AND cny_usd_rate_at_purchase NOT GLOB '*[^0-9.]*' AND cny_usd_rate_at_purchase NOT GLOB '*.*.*' AND cny_usd_rate_at_purchase NOT GLOB '*.' AND length(cny_usd_rate_at_purchase) <= 32 AND CAST(cny_usd_rate_at_purchase AS REAL) > 0));
ALTER TABLE inventory_lots ADD COLUMN usd_iqd_fx_version INTEGER CHECK (usd_iqd_fx_version IS NULL OR usd_iqd_fx_version > 0);
ALTER TABLE inventory_lots ADD COLUMN eur_usd_fx_version INTEGER CHECK (eur_usd_fx_version IS NULL OR eur_usd_fx_version > 0);
ALTER TABLE inventory_lots ADD COLUMN cny_usd_fx_version INTEGER CHECK (cny_usd_fx_version IS NULL OR cny_usd_fx_version > 0);
-- when the purchase captured the central rates, and where the USD/IQD came from: the document's own
-- rate (a USD document) or the central effective rate of the purchase snapshot
ALTER TABLE inventory_lots ADD COLUMN fx_snapshot_at TEXT CHECK (fx_snapshot_at IS NULL OR length(fx_snapshot_at) <= 40);
ALTER TABLE inventory_lots ADD COLUMN fx_snapshot_source TEXT CHECK (fx_snapshot_source IS NULL OR fx_snapshot_source IN ('document','central'));
-- §17/§18: the lot's landed IQD ÷ the purchase-time U, floored to 6 places — an audit figure only
ALTER TABLE inventory_lots ADD COLUMN historical_usd_equivalent TEXT
  CHECK (historical_usd_equivalent IS NULL OR (historical_usd_equivalent GLOB '[0-9]*' AND historical_usd_equivalent NOT GLOB '*[^0-9.]*' AND historical_usd_equivalent NOT GLOB '*.*.*' AND historical_usd_equivalent NOT GLOB '*.' AND length(historical_usd_equivalent) <= 32));
ALTER TABLE inventory_lots ADD COLUMN calculated_at TEXT CHECK (calculated_at IS NULL OR length(calculated_at) <= 40);
-- a transfer split's child copies its parent's snapshot and names the parent
ALTER TABLE inventory_lots ADD COLUMN split_from_lot_id TEXT CHECK (split_from_lot_id IS NULL OR length(split_from_lot_id) <= 60);
CREATE INDEX IF NOT EXISTS idx_lots_purchase ON inventory_lots(purchase_id) WHERE purchase_id IS NOT NULL;

-- 3. The shape a lot's snapshot is written in: all or nothing, a USD/IQD with its source, an
--    equivalent only with its rate. Every lot older code inserts (no snapshot column named) passes.
CREATE TRIGGER IF NOT EXISTS inventory_lot_snapshot_shape BEFORE INSERT ON inventory_lots
WHEN (NEW.snapshot_version IS NULL AND (NEW.snapshot_source IS NOT NULL OR NEW.purchase_id IS NOT NULL
        OR NEW.supplier_original_currency IS NOT NULL OR NEW.supplier_original_amount IS NOT NULL
        OR NEW.supplier_cost_mode IS NOT NULL OR NEW.supplier_line_total_original IS NOT NULL
        OR NEW.exchange_rate_at_purchase IS NOT NULL OR NEW.supplier_cost_usd_at_purchase IS NOT NULL
        OR NEW.usd_iqd_rate_at_purchase IS NOT NULL OR NEW.eur_usd_rate_at_purchase IS NOT NULL
        OR NEW.cny_usd_rate_at_purchase IS NOT NULL OR NEW.usd_iqd_fx_version IS NOT NULL
        OR NEW.eur_usd_fx_version IS NOT NULL OR NEW.cny_usd_fx_version IS NOT NULL
        OR NEW.fx_snapshot_at IS NOT NULL OR NEW.fx_snapshot_source IS NOT NULL
        OR NEW.historical_usd_equivalent IS NOT NULL OR NEW.calculated_at IS NOT NULL))
  OR (NEW.snapshot_version = 1 AND (NEW.snapshot_source IS NULL OR NEW.calculated_at IS NULL))
  OR (NEW.snapshot_source = 'purchase' AND NEW.purchase_id IS NULL)
  OR ((NEW.usd_iqd_rate_at_purchase IS NULL) <> (NEW.fx_snapshot_source IS NULL))
  OR (NEW.historical_usd_equivalent IS NOT NULL AND NEW.usd_iqd_rate_at_purchase IS NULL)
BEGIN SELECT RAISE(ABORT, 'BATCH_SNAPSHOT_SHAPE'); END;

-- 4. §16: the snapshot never changes once the lot exists — a SECOND trigger beside 0181's
--    inventory_lot_cost_immutable (which locks the cost columns), value-compared, NULL → value
--    included. 0181's inventory_lot_no_delete and inventory_lot_no_reinsert already cover the row.
CREATE TRIGGER IF NOT EXISTS inventory_lot_snapshot_immutable
BEFORE UPDATE OF snapshot_version, snapshot_source, purchase_id, supplier_original_currency, supplier_original_amount,
  supplier_cost_mode, supplier_line_total_original, exchange_rate_at_purchase, supplier_cost_usd_at_purchase,
  usd_iqd_rate_at_purchase, eur_usd_rate_at_purchase, cny_usd_rate_at_purchase, usd_iqd_fx_version, eur_usd_fx_version,
  cny_usd_fx_version, fx_snapshot_at, fx_snapshot_source, historical_usd_equivalent, calculated_at, split_from_lot_id
ON inventory_lots
WHEN NEW.snapshot_version IS NOT OLD.snapshot_version OR NEW.snapshot_source IS NOT OLD.snapshot_source
  OR NEW.purchase_id IS NOT OLD.purchase_id OR NEW.supplier_original_currency IS NOT OLD.supplier_original_currency
  OR NEW.supplier_original_amount IS NOT OLD.supplier_original_amount OR NEW.supplier_cost_mode IS NOT OLD.supplier_cost_mode
  OR NEW.supplier_line_total_original IS NOT OLD.supplier_line_total_original
  OR NEW.exchange_rate_at_purchase IS NOT OLD.exchange_rate_at_purchase
  OR NEW.supplier_cost_usd_at_purchase IS NOT OLD.supplier_cost_usd_at_purchase
  OR NEW.usd_iqd_rate_at_purchase IS NOT OLD.usd_iqd_rate_at_purchase OR NEW.eur_usd_rate_at_purchase IS NOT OLD.eur_usd_rate_at_purchase
  OR NEW.cny_usd_rate_at_purchase IS NOT OLD.cny_usd_rate_at_purchase OR NEW.usd_iqd_fx_version IS NOT OLD.usd_iqd_fx_version
  OR NEW.eur_usd_fx_version IS NOT OLD.eur_usd_fx_version OR NEW.cny_usd_fx_version IS NOT OLD.cny_usd_fx_version
  OR NEW.fx_snapshot_at IS NOT OLD.fx_snapshot_at OR NEW.fx_snapshot_source IS NOT OLD.fx_snapshot_source
  OR NEW.historical_usd_equivalent IS NOT OLD.historical_usd_equivalent OR NEW.calculated_at IS NOT OLD.calculated_at
  OR NEW.split_from_lot_id IS NOT OLD.split_from_lot_id
BEGIN SELECT RAISE(ABORT, 'BATCH_COST_IMMUTABLE'); END;

-- 5. §17: a purchase's FX snapshot, once taken, never changes (FX-1 writes it once, guarded on
--    fx_snapshot_at IS NULL; this is the database's half of that rule).
CREATE TRIGGER IF NOT EXISTS purchase_order_fx_snapshot_frozen
BEFORE UPDATE OF fx_usd_iqd_at_purchase, fx_eur_usd_at_purchase, fx_cny_usd_at_purchase, fx_snapshot_at,
  fx_usd_iqd_version_at_purchase, fx_eur_usd_version_at_purchase, fx_cny_usd_version_at_purchase ON purchase_orders
WHEN OLD.fx_snapshot_at IS NOT NULL AND (
     NEW.fx_usd_iqd_at_purchase IS NOT OLD.fx_usd_iqd_at_purchase OR NEW.fx_eur_usd_at_purchase IS NOT OLD.fx_eur_usd_at_purchase
  OR NEW.fx_cny_usd_at_purchase IS NOT OLD.fx_cny_usd_at_purchase OR NEW.fx_snapshot_at IS NOT OLD.fx_snapshot_at
  OR NEW.fx_usd_iqd_version_at_purchase IS NOT OLD.fx_usd_iqd_version_at_purchase
  OR NEW.fx_eur_usd_version_at_purchase IS NOT OLD.fx_eur_usd_version_at_purchase
  OR NEW.fx_cny_usd_version_at_purchase IS NOT OLD.fx_cny_usd_version_at_purchase)
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;

-- 6. A RECEIVED purchase's cost is frozen in the database too (master plan v2 0180 M3; the code
--    already refuses: adminProcurement PUT /documents/:id → PURCHASE_FROZEN, adminInventory PATCH
--    /incoming/:id → COSTS_FROZEN). Value-compared on the cost columns only. Never frozen, because live
--    code writes them after a receipt: incoming qty_received/status/updated_at/product_id/notes/tracking/
--    supplier_ref/expected_at/purchase_date/supplier_id; purchase_orders status/note/version/updated_at/
--    tracking/attachment_url/request_json and the FX snapshot above; purchase_lines rejected_qty/
--    selling_price_iqd/label/invoiced_qty; purchase_charges title/position/pricing_role.
CREATE TRIGGER IF NOT EXISTS incoming_received_cost_frozen
BEFORE UPDATE OF qty_ordered, purchase_unit_iqd, shipping_total_iqd, internal_delivery_total_iqd, source_currency,
  source_unit_amount, exchange_rate_used, purchase_total_iqd ON incoming_inventory
WHEN OLD.qty_received > 0 AND (
     NEW.qty_ordered IS NOT OLD.qty_ordered OR NEW.purchase_unit_iqd IS NOT OLD.purchase_unit_iqd
  OR NEW.shipping_total_iqd IS NOT OLD.shipping_total_iqd OR NEW.internal_delivery_total_iqd IS NOT OLD.internal_delivery_total_iqd
  OR NEW.source_currency IS NOT OLD.source_currency OR NEW.source_unit_amount IS NOT OLD.source_unit_amount
  OR NEW.exchange_rate_used IS NOT OLD.exchange_rate_used OR NEW.purchase_total_iqd IS NOT OLD.purchase_total_iqd)
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS incoming_received_no_delete BEFORE DELETE ON incoming_inventory
WHEN OLD.qty_received > 0
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;

CREATE TRIGGER IF NOT EXISTS purchase_line_cost_frozen
BEFORE UPDATE OF purchase_id, incoming_id, source_unit_amount, source_total_amount, weight_g, volume_mm3,
  charges_iqd, auto_shipping_iqd, purchase_total_iqd, purchase_cost_mode ON purchase_lines
WHEN EXISTS (SELECT 1 FROM incoming_inventory i WHERE i.id = OLD.incoming_id AND i.qty_received > 0) AND (
     NEW.purchase_id IS NOT OLD.purchase_id OR NEW.incoming_id IS NOT OLD.incoming_id
  OR NEW.source_unit_amount IS NOT OLD.source_unit_amount OR NEW.source_total_amount IS NOT OLD.source_total_amount
  OR NEW.weight_g IS NOT OLD.weight_g OR NEW.volume_mm3 IS NOT OLD.volume_mm3
  OR NEW.charges_iqd IS NOT OLD.charges_iqd OR NEW.auto_shipping_iqd IS NOT OLD.auto_shipping_iqd
  OR NEW.purchase_total_iqd IS NOT OLD.purchase_total_iqd OR NEW.purchase_cost_mode IS NOT OLD.purchase_cost_mode)
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS purchase_line_received_no_delete BEFORE DELETE ON purchase_lines
WHEN EXISTS (SELECT 1 FROM incoming_inventory i WHERE i.id = OLD.incoming_id AND i.qty_received > 0)
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;

CREATE TRIGGER IF NOT EXISTS purchase_order_cost_frozen
BEFORE UPDATE OF currency, exchange_rate, cost_state, cost_profile_id, cost_profile_version,
  shipping_rate_iqd, shipping_basis, invoice_total_iqd ON purchase_orders
WHEN EXISTS (SELECT 1 FROM purchase_lines l JOIN incoming_inventory i ON i.id = l.incoming_id
              WHERE l.purchase_id = OLD.id AND i.qty_received > 0) AND (
     NEW.currency IS NOT OLD.currency OR NEW.exchange_rate IS NOT OLD.exchange_rate
  OR NEW.cost_state IS NOT OLD.cost_state OR NEW.cost_profile_id IS NOT OLD.cost_profile_id
  OR NEW.cost_profile_version IS NOT OLD.cost_profile_version OR NEW.shipping_rate_iqd IS NOT OLD.shipping_rate_iqd
  OR NEW.shipping_basis IS NOT OLD.shipping_basis OR NEW.invoice_total_iqd IS NOT OLD.invoice_total_iqd)
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;

CREATE TRIGGER IF NOT EXISTS purchase_charge_cost_frozen
BEFORE UPDATE OF purchase_id, amount_iqd, basis, scope, unit_amount_iqd, applies_to_json, allocation_json ON purchase_charges
WHEN EXISTS (SELECT 1 FROM purchase_lines l JOIN incoming_inventory i ON i.id = l.incoming_id
              WHERE l.purchase_id = OLD.purchase_id AND i.qty_received > 0) AND (
     NEW.purchase_id IS NOT OLD.purchase_id OR NEW.amount_iqd IS NOT OLD.amount_iqd OR NEW.basis IS NOT OLD.basis
  OR NEW.scope IS NOT OLD.scope OR NEW.unit_amount_iqd IS NOT OLD.unit_amount_iqd
  OR NEW.applies_to_json IS NOT OLD.applies_to_json OR NEW.allocation_json IS NOT OLD.allocation_json)
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS purchase_charge_received_no_delete BEFORE DELETE ON purchase_charges
WHEN EXISTS (SELECT 1 FROM purchase_lines l JOIN incoming_inventory i ON i.id = l.incoming_id
              WHERE l.purchase_id = OLD.purchase_id AND i.qty_received > 0)
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;

-- 7. INSERT OR REPLACE fires neither UPDATE nor DELETE triggers (recursive_triggers is off), so a
--    received purchase's rows also refuse being inserted again under their own id (critique F8). The
--    writers use plain INSERT with fresh ids (adminProcurement planDocument); a draft's or an
--    unreceived document's re-save is untouched (the guard asks for received stock first).
CREATE TRIGGER IF NOT EXISTS purchase_order_received_no_reinsert BEFORE INSERT ON purchase_orders
WHEN EXISTS (SELECT 1 FROM purchase_lines l JOIN incoming_inventory i ON i.id = l.incoming_id
              WHERE l.purchase_id = NEW.id AND i.qty_received > 0)
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS purchase_line_received_no_reinsert BEFORE INSERT ON purchase_lines
WHEN EXISTS (SELECT 1 FROM purchase_lines l JOIN incoming_inventory i ON i.id = l.incoming_id
              WHERE l.id = NEW.id AND i.qty_received > 0)
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS purchase_charge_received_no_reinsert BEFORE INSERT ON purchase_charges
WHEN EXISTS (SELECT 1 FROM purchase_charges c JOIN purchase_lines l ON l.purchase_id = c.purchase_id
              JOIN incoming_inventory i ON i.id = l.incoming_id
              WHERE c.id = NEW.id AND i.qty_received > 0)
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS incoming_received_no_reinsert BEFORE INSERT ON incoming_inventory
WHEN EXISTS (SELECT 1 FROM incoming_inventory i WHERE i.id = NEW.id AND i.qty_received > 0)
BEGIN SELECT RAISE(ABORT, 'PURCHASE_FROZEN'); END;
