-- ============================================================================
--  0139 — SERIAL INVENTORY: the serials the shop holds BEFORE a sale
-- ============================================================================
-- The owner (2026-09-26): «اجعل للأدمن قبل بيع المخزون … يمكنه إضافة سيريال
-- نمبر للطابعات والأجهزة ويكون الاسترداد لاحقًا للمستخدم من صفحة الضمان
-- وربطه تلقائي», with a camera that reads the box label (MODEL line, Product
-- SN line and its Code 128 barcode, BOX SN and EAN barcodes below).
--
-- ONE ROW PER PHYSICAL BOX THE SHOP KNOWS OF. It is NOT a second device
-- system (0098 part 7 forbids one): the device, its warranty clock and its
-- account link stay `order_item_units` + `device_serials` +
-- `device_registrations`. This table only remembers a serial, its model and
-- its catalogue product before any unit exists, so that when the buyer types
-- or scans it the server can attach it to THEIR OWN delivered unit of that
-- product (worker/lib/serialInventory.ts `linkFromInventory`).
--
-- STATUS IS DERIVED, NEVER STORED: in_stock (no unit carries this serial),
-- sold (a unit carries it, nobody linked), registered (a unit carries it and
-- an account holds that unit), void (`voided_at` set). A stored status would
-- drift the first time a customer unlinked a device or an admin reassigned a
-- serial through the existing routes, which do not know this table exists.
--
-- `serial_norm` uses the SAME normalisation as `device_serials.serial_norm`
-- (upper case, no spaces or dashes — packages/catalog/src/deviceSerials.ts),
-- which is what makes the join between the two a plain equality.
--
-- NONDESTRUCTIVE: one new table and its indexes. No existing row changes.
CREATE TABLE IF NOT EXISTS serial_inventory (
  serial_norm   TEXT PRIMARY KEY,
  serial_raw    TEXT NOT NULL,
  model_code    TEXT NOT NULL DEFAULT '' CHECK (length(model_code) <= 60),
  model_name    TEXT NOT NULL DEFAULT '' CHECK (length(model_name) <= 120),
  -- Nullable, no foreign key: a deleted product NULLs these through
  -- worker/lib/productDeletion.ts HISTORY_TABLES, and the row keeps its
  -- model code and name.
  product_id    TEXT,
  variant_id    TEXT,
  box_sn        TEXT NOT NULL DEFAULT '' CHECK (length(box_sn) <= 60),
  ean           TEXT NOT NULL DEFAULT '' CHECK (length(ean) <= 14),
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','bulk','scan')),
  note          TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  voided_at     TEXT,
  void_reason   TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- The admin list is keyset-paged newest first.
CREATE INDEX IF NOT EXISTS idx_serial_inventory_created ON serial_inventory(created_at DESC, serial_norm DESC);
-- A customer who types the BOX SN instead of the product SN, and the
-- "EAN → product" memory the scanner uses to fill the model.
CREATE INDEX IF NOT EXISTS idx_serial_inventory_box ON serial_inventory(box_sn) WHERE box_sn <> '';
CREATE INDEX IF NOT EXISTS idx_serial_inventory_ean ON serial_inventory(ean, created_at) WHERE ean <> '';
CREATE INDEX IF NOT EXISTS idx_serial_inventory_product ON serial_inventory(product_id) WHERE product_id IS NOT NULL;
