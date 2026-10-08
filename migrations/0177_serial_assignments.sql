-- ============================================================================
--  0177 — SERIAL ASSIGNMENTS AT ORDER PREPARATION
--  (owner brief 2026-10-07 «ربط كل طابعة/AMS بالرقم التسلسلي الحقيقي أثناء
--  التجهيز», 33 sections; design docs/… serial-spec + both critiques)
-- ============================================================================
--
-- RENUMBERING. This file is self-contained: nothing outside it names "0177"
-- except worker/lib/schemaVersion.ts (EXPECTED_MIGRATION) and the comments
-- that cite it. Landing it after another migration means renaming the file
-- and that one constant; no other file or row carries the number.
--
-- NOT A SECOND SERIAL OR WARRANTY SYSTEM (0098 part 7; the 0139 header;
-- DECISIONS row 146(1)). The ONE physical device stays `serial_inventory`
-- (serial_norm PRIMARY KEY — the brief's «serial_number UNIQUE»), the warranty
-- record stays `order_item_units`, asset → warranty stays `device_serials`,
-- and the history stays `audit_log` read by target = serial_norm. What did not
-- exist is a serial bound to an order UNIT BEFORE delivery, while no
-- order_item_units row may exist yet (createUnitsOnDelivery inserts with
-- DO NOTHING; the delivered sweep and order deletion key on unit existence).
-- That binding is this table, keyed exactly like order_item_units and
-- trade_in_claims: (order_item_id, unit_index, part).
--
-- ADDITIVE ONLY: one table and its indexes, one trigger, one catalogs column
-- and three order_item_units columns (and one partial index on them), every
-- one NULL or defaulted. No existing
-- order, order_item, wallet, unit or receipt row changes when this applies.
-- Every CHECK list already holds the values later phases name, because a CHECK
-- cannot be widened without a table rebuild (the 0162 ops_permissions lesson).

CREATE TABLE IF NOT EXISTS serial_assignments (
  id                  TEXT PRIMARY KEY,
  serial_norm         TEXT NOT NULL REFERENCES serial_inventory(serial_norm),
  serial_raw          TEXT NOT NULL CHECK (length(serial_raw) BETWEEN 1 AND 80),
  -- No foreign keys on the order side: cancelled-order deletion
  -- (worker/lib/orderDeletion.ts, after 7 days) NULLs these and `order_ref`
  -- keeps the ORD- id for the serial's timeline.
  order_id            TEXT,
  order_item_id       TEXT,
  order_ref           TEXT NOT NULL,
  -- 1..qty for a sold slot; a replacement unit takes MAX(unit_index)+1, so the
  -- bound is wider than the 500-unit delivery cap.
  unit_index          INTEGER NOT NULL CHECK (unit_index BETWEEN 1 AND 1000),
  -- A Combo carries ONE serial today (the box Product SN, owner default). The
  -- AMS part and its index exist for a later owner decision
  -- (ams_units_included reaches 3 per unit, 0144); the routes refuse 'ams'.
  part                TEXT NOT NULL DEFAULT 'device' CHECK (part IN ('device','ams')),
  part_index          INTEGER NOT NULL DEFAULT 1 CHECK (part_index BETWEEN 1 AND 8),
  -- What the line was when the link was made (history; productDeletion NULLs them).
  product_id          TEXT,
  variant_id          TEXT,
  -- §27/§28: the physical unit's lot — never its cost.
  lot_id              TEXT REFERENCES inventory_lots(id),
  lot_source          TEXT CHECK (lot_source IS NULL OR lot_source IN ('serial_link','allocation','unit')),
  allocation_id       TEXT,
  source              TEXT NOT NULL CHECK (source IN
                        ('camera','scanner','manual','relink','post_delivery','owner_override','replacement','import')),
  -- How delivery computes the warranty: new = computeCoverage; carry = the
  -- device's original end (resale of a returned device — the replacement
  -- precedent, carried:'original_end'); restart = computeCoverage, owner only.
  warranty_mode       TEXT NOT NULL DEFAULT 'new' CHECK (warranty_mode IN ('new','carry','restart')),
  prior_unit_id       TEXT,
  override_kind       TEXT CHECK (override_kind IS NULL OR override_kind IN
                        ('take_from_order','delivered_device','unavailable','outside_window','batch',
                         'model_family','after_shipment')),
  override_reason     TEXT,
  -- 1 when THIS link filed the asset under the line's product (the asset had
  -- none): an unlink or a change of a mistaken first scan undoes it.
  adopted_product     INTEGER NOT NULL DEFAULT 0 CHECK (adopted_product IN (0,1)),
  idempotency_key     TEXT NOT NULL UNIQUE,
  linked_by           TEXT NOT NULL,
  linked_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Set by the delivery activation (or at insert for post_delivery/replacement).
  unit_id             TEXT,
  activated_at        TEXT,
  -- Bounded retries of the activation sweep (a conflict is the owner's, not
  -- the cron's): the sweep stops picking a row after a few failed attempts.
  activation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (activation_attempts >= 0),
  released_at         TEXT,
  released_by         TEXT,             -- NULL = the orders trigger
  release_reason      TEXT CHECK (release_reason IS NULL OR release_reason IN
                        ('unlinked','changed','order_cancelled','owner_override','returned','replaced',
                         'reassigned','policy_changed','order_deleted','traded_in')),
  release_note        TEXT NOT NULL DEFAULT '' CHECK (length(release_note) <= 500),
  return_case_id      TEXT,
  CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CHECK ((activated_at IS NULL) = (unit_id IS NULL)),
  CHECK (override_kind IS NULL OR length(COALESCE(override_reason,'')) BETWEEN 5 AND 500)
);

-- §10/§13/§18/§24: ONE pending binding per device, globally — the same serial
-- on two orders, or twice in one order. Released rows are history.
CREATE UNIQUE INDEX IF NOT EXISTS ux_serial_assignments_serial_pending
  ON serial_assignments(serial_norm) WHERE released_at IS NULL AND activated_at IS NULL;
-- And ONE delivered (activated) binding per device. Two indexes rather than one
-- so the owner's delivered_device override can hold a pending row while the
-- original customer's delivered row stays live until the new delivery moves
-- the warranty (critique M14).
CREATE UNIQUE INDEX IF NOT EXISTS ux_serial_assignments_serial_active
  ON serial_assignments(serial_norm) WHERE released_at IS NULL AND activated_at IS NOT NULL;
-- §18: ONE live serial per physical unit slot.
CREATE UNIQUE INDEX IF NOT EXISTS ux_serial_assignments_slot_live
  ON serial_assignments(order_item_id, unit_index, part, part_index) WHERE released_at IS NULL;
-- One live assignment per warranty unit (released rows keep their unit_id as
-- history, so they must not count — critique M2).
CREATE UNIQUE INDEX IF NOT EXISTS ux_serial_assignments_unit_live
  ON serial_assignments(unit_id) WHERE unit_id IS NOT NULL AND released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_serial_assignments_order ON serial_assignments(order_id, released_at);
CREATE INDEX IF NOT EXISTS idx_serial_assignments_history ON serial_assignments(serial_norm, linked_at);
CREATE INDEX IF NOT EXISTS idx_serial_assignments_item ON serial_assignments(order_item_id, released_at);
CREATE INDEX IF NOT EXISTS idx_serial_assignments_lot_live
  ON serial_assignments(order_item_id, lot_id) WHERE released_at IS NULL AND lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_serial_assignments_pending
  ON serial_assignments(order_id) WHERE released_at IS NULL AND activated_at IS NULL;

-- §29: category-level serial policy, RESOLVED AT READ TIME
-- (worker/lib/serialPolicy.ts, beside the is_printer_catalog flag it mirrors):
-- a product's own ops_policy.serialized wins; otherwise the nearest
-- non-'inherit' section on its branch; otherwise the printer default. Nothing
-- is written onto products, so a re-filed product never drifts.
ALTER TABLE catalogs ADD COLUMN serial_policy TEXT NOT NULL DEFAULT 'inherit'
  CHECK (serial_policy IN ('inherit','required','off'));

-- §14: RETURNED without zeroing anything — the dates stay, the unit is closed.
ALTER TABLE order_item_units ADD COLUMN warranty_closed_at TEXT;
ALTER TABLE order_item_units ADD COLUMN warranty_closed_reason TEXT
  CHECK (warranty_closed_reason IS NULL OR warranty_closed_reason IN
         ('returned','returned_unsellable','owner_override','order_cancelled','traded_in','replaced'));
ALTER TABLE order_item_units ADD COLUMN return_case_id TEXT;
-- The few units an undone delivery + cancel closed: a re-delivery re-opens
-- them, and the activation sweep finds a delivered order still holding one
-- through this index rather than a scan of every unit.
CREATE INDEX IF NOT EXISTS idx_units_closed_order_cancelled
  ON order_item_units(order_id) WHERE warranty_closed_reason = 'order_cancelled';

-- §12/§24: release on cancel BY EVERY DOOR (stage flip, legacy PATCH, the
-- customer, the expiry and Gini sweeps, store ops), atomically with the status
-- flip — the 0175 gift pattern. A delivered order is never cancelled
-- (canMoveStage); a delivery that was undone (delivered→shipped) and then
-- cancelled has units: their warranty is closed 'order_cancelled' (dates
-- kept), the live receipt voided and the account link revoked, so the serial
-- is not left bound to a sale that did not happen. A re-delivery of the order
-- re-opens each such unit, with or without a new scan, and gives back the
-- account link and (same device) the receipt this trigger took
-- (worker/lib/serialAssignments.ts `reopenUnitStatements`, which matches them
-- by `revoked_at` / `voided_at` ≥ the closure stamped here). The trigger
-- names only columns no test drops.
CREATE TRIGGER IF NOT EXISTS trg_orders_serial_assignments_cancelled
AFTER UPDATE OF status ON orders FOR EACH ROW
WHEN NEW.status = 'cancelled' AND OLD.status NOT IN ('cancelled','delivered')
BEGIN
  INSERT INTO audit_log (actor_id, action, target, detail)
  SELECT NULL, 'serial.released', a.serial_norm,
         json_object('assignment_id', a.id, 'order_id', NEW.id, 'order_item_id', a.order_item_id,
                     'unit_index', a.unit_index, 'part', a.part, 'reason', 'order_cancelled',
                     'from_status', OLD.status, 'unit_id', a.unit_id)
    FROM serial_assignments a
   WHERE a.order_id = NEW.id AND a.released_at IS NULL;
  UPDATE order_item_units
     SET warranty_closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), warranty_closed_reason = 'order_cancelled'
   WHERE warranty_closed_at IS NULL
     AND id IN (SELECT unit_id FROM serial_assignments
                 WHERE order_id = NEW.id AND released_at IS NULL AND unit_id IS NOT NULL);
  UPDATE warranty_receipts
     SET status = 'void', void_reason = 'order_cancelled',
         voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE status IN ('draft','active')
     AND unit_id IN (SELECT unit_id FROM serial_assignments
                      WHERE order_id = NEW.id AND released_at IS NULL AND unit_id IS NOT NULL);
  UPDATE device_registrations
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE revoked_at IS NULL
     AND unit_id IN (SELECT unit_id FROM serial_assignments
                      WHERE order_id = NEW.id AND released_at IS NULL AND unit_id IS NOT NULL);
  UPDATE serial_assignments
     SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         release_reason = 'order_cancelled', release_note = 'from:' || OLD.status
   WHERE order_id = NEW.id AND released_at IS NULL;
END;
