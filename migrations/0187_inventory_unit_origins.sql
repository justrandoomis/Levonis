-- Optional procurement provenance for individual pieces. Stock counters, FIFO
-- lots and accounting allocations remain authoritative. No historical backfill:
-- a purchase reference cannot be inferred from an old quantity or cost layer.
CREATE TABLE inventory_unit_origins (
  id TEXT PRIMARY KEY,
  incoming_id TEXT NOT NULL,
  purchase_line_id TEXT NOT NULL,
  purchase_id TEXT NOT NULL,
  unit_index INTEGER NOT NULL CHECK(unit_index BETWEEN 1 AND 1000),
  supplier_order_no TEXT NOT NULL CHECK(length(supplier_order_no) BETWEEN 1 AND 120),
  tracking_no TEXT NOT NULL DEFAULT '' CHECK(length(tracking_no)<=120),
  serial_norm TEXT,
  received_lot_id TEXT REFERENCES inventory_lots(id),
  current_lot_id TEXT REFERENCES inventory_lots(id),
  received_at TEXT,
  unavailable_reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(incoming_id,unit_index),
  CHECK((received_lot_id IS NULL)=(received_at IS NULL)),
  CHECK(received_lot_id IS NOT NULL OR current_lot_id IS NULL)
);
CREATE UNIQUE INDEX ux_inventory_origin_serial ON inventory_unit_origins(serial_norm) WHERE serial_norm IS NOT NULL;
CREATE INDEX idx_inventory_origin_purchase ON inventory_unit_origins(purchase_id,unit_index);
CREATE INDEX idx_inventory_origin_lot ON inventory_unit_origins(current_lot_id,unavailable_reason,unit_index);
CREATE TRIGGER inventory_origin_identity_immutable BEFORE UPDATE ON inventory_unit_origins
WHEN NEW.id<>OLD.id OR NEW.incoming_id<>OLD.incoming_id OR NEW.purchase_line_id<>OLD.purchase_line_id
  OR NEW.purchase_id<>OLD.purchase_id OR NEW.unit_index<>OLD.unit_index
  OR (OLD.serial_norm IS NOT NULL AND NEW.serial_norm IS NOT OLD.serial_norm)
  OR (OLD.received_lot_id IS NOT NULL AND (NEW.received_lot_id IS NOT OLD.received_lot_id OR NEW.received_at IS NOT OLD.received_at))
BEGIN SELECT RAISE(ABORT,'inventory origin identity is immutable'); END;
CREATE TRIGGER inventory_origin_received_no_delete BEFORE DELETE ON inventory_unit_origins
WHEN OLD.received_lot_id IS NOT NULL OR OLD.serial_norm IS NOT NULL
BEGIN SELECT RAISE(ABORT,'received inventory origin cannot be deleted'); END;

-- Append-only ownership episodes. Releasing a piece preserves its earlier
-- customer/order and supplier evidence; a subsequent sale creates a new row.
-- Order references deliberately have no FK: cancelled-order housekeeping must
-- preserve provenance even when the original allocation/order rows are deleted.
CREATE TABLE order_item_inventory_unit_assignments (
  id TEXT PRIMARY KEY,
  origin_id TEXT NOT NULL REFERENCES inventory_unit_origins(id),
  allocation_id TEXT NOT NULL,
  order_id TEXT,
  order_ref TEXT NOT NULL,
  order_item_id TEXT,
  order_item_ref TEXT NOT NULL,
  unit_index INTEGER NOT NULL CHECK(unit_index>0),
  lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  purchase_id TEXT NOT NULL,
  purchase_line_id TEXT NOT NULL,
  incoming_id TEXT NOT NULL,
  purchase_unit_index INTEGER NOT NULL,
  purchase_name TEXT NOT NULL DEFAULT '',
  supplier_order_no TEXT NOT NULL,
  tracking_no TEXT NOT NULL DEFAULT '',
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  physical_verified_at TEXT,
  verified_serial_norm TEXT,
  verified_by TEXT,
  released_at TEXT,
  release_reason TEXT,
  CHECK((released_at IS NULL)=(release_reason IS NULL)),
  UNIQUE(allocation_id,origin_id)
);
CREATE UNIQUE INDEX ux_inventory_origin_assigned ON order_item_inventory_unit_assignments(origin_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX ux_inventory_origin_order_slot ON order_item_inventory_unit_assignments(order_item_id,unit_index) WHERE released_at IS NULL;
CREATE INDEX idx_inventory_origin_assignment_order ON order_item_inventory_unit_assignments(order_id,order_item_id);
CREATE INDEX idx_inventory_origin_assignment_allocation ON order_item_inventory_unit_assignments(allocation_id,released_at);
CREATE TRIGGER inventory_origin_assignment_immutable BEFORE UPDATE ON order_item_inventory_unit_assignments
WHEN NEW.origin_id<>OLD.origin_id OR NEW.allocation_id<>OLD.allocation_id OR NEW.order_ref<>OLD.order_ref
 OR NEW.order_item_ref<>OLD.order_item_ref OR NEW.unit_index<>OLD.unit_index OR NEW.lot_id<>OLD.lot_id
 OR NEW.purchase_id<>OLD.purchase_id OR NEW.purchase_line_id<>OLD.purchase_line_id OR NEW.incoming_id<>OLD.incoming_id
 OR NEW.purchase_unit_index<>OLD.purchase_unit_index OR NEW.purchase_name<>OLD.purchase_name
 OR NEW.supplier_order_no<>OLD.supplier_order_no OR NEW.tracking_no<>OLD.tracking_no OR NEW.assigned_at<>OLD.assigned_at
 OR (OLD.physical_verified_at IS NOT NULL AND (NEW.physical_verified_at IS NOT OLD.physical_verified_at OR NEW.verified_serial_norm IS NOT OLD.verified_serial_norm OR NEW.verified_by IS NOT OLD.verified_by))
 OR (OLD.released_at IS NOT NULL AND (NEW.released_at IS NOT OLD.released_at OR NEW.release_reason IS NOT OLD.release_reason))
BEGIN SELECT RAISE(ABORT,'inventory assignment provenance is immutable'); END;

-- Admin inspection evidence identifies actual returned pieces before money or
-- stock moves. Lot evidence remains the source of investor/cost attribution.
CREATE TABLE stock_return_unit_evidence (
  return_case_id TEXT NOT NULL REFERENCES return_cases(id),
  origin_id TEXT NOT NULL REFERENCES inventory_unit_origins(id),
  allocation_id TEXT NOT NULL REFERENCES order_item_inventory_allocations(id),
  PRIMARY KEY(return_case_id,origin_id)
);
CREATE INDEX idx_stock_return_unit_origin ON stock_return_unit_evidence(origin_id,return_case_id);

-- Physical warranty-unit evidence also covers older pieces that have no
-- supplier origin. Selecting one must not release a newer tracked piece.
CREATE TABLE stock_return_order_unit_evidence (
  return_case_id TEXT NOT NULL REFERENCES return_cases(id),
  unit_id TEXT NOT NULL REFERENCES order_item_units(id),
  allocation_id TEXT NOT NULL,
  PRIMARY KEY(return_case_id,unit_id)
);

-- External preorder procurement evidence. This is not warehouse stock and
-- does not create FIFO, financial costs or reservation movements. Immutable
-- references survive cancellation, return and cancelled-order housekeeping.
CREATE TABLE order_preorder_unit_origins (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  order_ref TEXT NOT NULL,
  order_item_id TEXT,
  order_item_ref TEXT NOT NULL,
  unit_index INTEGER NOT NULL CHECK(unit_index>0),
  product_name TEXT NOT NULL,
  selection TEXT NOT NULL DEFAULT '',
  batch_name TEXT NOT NULL DEFAULT '' CHECK(length(batch_name)<=120),
  batch_ref TEXT NOT NULL DEFAULT '' CHECK(length(batch_ref)<=120),
  purchase_ref TEXT NOT NULL DEFAULT '' CHECK(length(purchase_ref)<=120),
  supplier_order_no TEXT NOT NULL CHECK(length(supplier_order_no) BETWEEN 1 AND 120),
  tracking_no TEXT NOT NULL DEFAULT '' CHECK(length(tracking_no)<=120),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=500),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_ref,order_item_ref,unit_index)
);
CREATE INDEX idx_preorder_origin_order ON order_preorder_unit_origins(order_id,order_item_id,unit_index);
CREATE TRIGGER preorder_origin_identity_immutable BEFORE UPDATE ON order_preorder_unit_origins
WHEN NEW.id<>OLD.id OR NEW.order_ref<>OLD.order_ref OR NEW.order_item_ref<>OLD.order_item_ref
 OR NEW.unit_index<>OLD.unit_index OR NEW.product_name<>OLD.product_name OR NEW.selection<>OLD.selection
 OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
 OR (NEW.order_id IS NOT OLD.order_id AND NEW.order_id IS NOT NULL)
 OR (NEW.order_item_id IS NOT OLD.order_item_id AND NEW.order_item_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'preorder source identity is immutable'); END;
CREATE TRIGGER preorder_origin_version BEFORE UPDATE ON order_preorder_unit_origins
WHEN NEW.version NOT IN (OLD.version,OLD.version+1)
 OR ((NEW.batch_name<>OLD.batch_name OR NEW.batch_ref<>OLD.batch_ref OR NEW.purchase_ref<>OLD.purchase_ref
   OR NEW.supplier_order_no<>OLD.supplier_order_no OR NEW.tracking_no<>OLD.tracking_no OR NEW.note<>OLD.note)
   AND NEW.version<>OLD.version+1)
BEGIN SELECT RAISE(ABORT,'preorder source version must advance'); END;
CREATE TRIGGER preorder_origin_no_delete BEFORE DELETE ON order_preorder_unit_origins
BEGIN SELECT RAISE(ABORT,'preorder source evidence must be retained'); END;
CREATE TRIGGER preorder_origin_no_reinsert BEFORE INSERT ON order_preorder_unit_origins
WHEN EXISTS(SELECT 1 FROM order_preorder_unit_origins WHERE id=NEW.id OR
  (order_ref=NEW.order_ref AND order_item_ref=NEW.order_item_ref AND unit_index=NEW.unit_index))
BEGIN SELECT RAISE(ABORT,'preorder source evidence cannot be replaced'); END;

-- Every source correction is retained separately. The operation id links all
-- per-piece revisions to one bounded platform audit event. No live-order FK:
-- evidence remains intact after cancelled-order cleanup.
CREATE TABLE order_preorder_unit_origin_versions (
  origin_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  operation_id TEXT NOT NULL,
  order_ref TEXT NOT NULL,
  order_item_ref TEXT NOT NULL,
  unit_index INTEGER NOT NULL CHECK(unit_index>0),
  batch_name TEXT NOT NULL DEFAULT '',
  batch_ref TEXT NOT NULL DEFAULT '',
  purchase_ref TEXT NOT NULL DEFAULT '',
  supplier_order_no TEXT NOT NULL,
  tracking_no TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(origin_id,version)
);
CREATE INDEX idx_preorder_origin_versions_order ON order_preorder_unit_origin_versions(order_ref,order_item_ref,unit_index,version);
CREATE INDEX idx_preorder_origin_versions_operation ON order_preorder_unit_origin_versions(operation_id);
CREATE TRIGGER preorder_origin_version_no_update BEFORE UPDATE ON order_preorder_unit_origin_versions
BEGIN SELECT RAISE(ABORT,'preorder source versions are immutable'); END;
CREATE TRIGGER preorder_origin_version_no_delete BEFORE DELETE ON order_preorder_unit_origin_versions
BEGIN SELECT RAISE(ABORT,'preorder source versions must be retained'); END;
CREATE TRIGGER preorder_origin_version_no_reinsert BEFORE INSERT ON order_preorder_unit_origin_versions
WHEN EXISTS(SELECT 1 FROM order_preorder_unit_origin_versions WHERE origin_id=NEW.origin_id AND version=NEW.version)
BEGIN SELECT RAISE(ABORT,'preorder source versions cannot be replaced'); END;
