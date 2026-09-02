-- Levonis migration 0042 — the WARRANTY RECEIPT: one issued document per
-- physical unit, keyed to that unit's serial number.
--
-- WHY A SEPARATE TABLE FROM order_item_units. The unit row is the COVERAGE
-- (dates, months, delivery, replacement chain) and it changes as the truth
-- changes — a delivery correction moves its window, a replacement supersedes
-- it. The receipt is a DOCUMENT that was handed to a customer: its price, its
-- terms, its address and its dates are what they were on the day it was
-- issued, and nothing that happens to the product, the price list or the
-- terms afterwards may rewrite a receipt already in someone's hands. Every
-- printed value below is therefore a snapshot, not a join.
--
-- ONE LIVE RECEIPT PER UNIT AND PER SERIAL is enforced by the database, not
-- by the route: two partial unique indexes cover only the live states, so a
-- voided or replaced receipt stays in the table for history while a second
-- live one cannot be created by a double click or a concurrent request.
--
-- ADDITIVE and idempotent: nothing existing is altered, dropped or rewritten.

CREATE TABLE IF NOT EXISTS warranty_receipts (
  id TEXT PRIMARY KEY,
  -- WR-YYYY-MMDD-NNN, unique for the life of the shop.
  receipt_no TEXT NOT NULL,

  -- What it belongs to. The unit is the physical device; the rest is kept
  -- alongside it so the dashboard can search and filter without four joins.
  unit_id TEXT NOT NULL REFERENCES order_item_units(id),
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  product_id TEXT,
  user_id TEXT,

  -- The serial AS ISSUED. device_serials may be reassigned later; this one
  -- is what the paper says.
  serial_norm TEXT NOT NULL DEFAULT '',
  serial_raw TEXT NOT NULL DEFAULT '',

  -- draft: prepared, not handed over. active: issued. void: cancelled with a
  -- reason. replaced: superseded by the receipt of a replacement device.
  -- 'expired' is NOT stored — it is the clock's answer about an active
  -- receipt, and storing it would need a cron to stay true.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','void','replaced')),

  -- ---- snapshots: what the document says -------------------------------
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_address TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  product_description TEXT NOT NULL DEFAULT '',
  product_model TEXT NOT NULL DEFAULT '',
  purchase_price_iqd INTEGER,
  purchase_date TEXT,
  order_receipt_no TEXT NOT NULL DEFAULT '',
  -- Both languages, because the document prints in either and a receipt
  -- must never fall back to wording it was not issued with. The terms are
  -- already bilingual inside terms_json; these two were not.
  warranty_type TEXT NOT NULL DEFAULT '',
  warranty_type_en TEXT NOT NULL DEFAULT '',
  warranty_months INTEGER NOT NULL DEFAULT 12,
  coverage_text TEXT NOT NULL DEFAULT '',
  coverage_text_en TEXT NOT NULL DEFAULT '',
  terms_json TEXT NOT NULL DEFAULT '[]',
  retailer_json TEXT NOT NULL DEFAULT '{}',
  warranty_start_at TEXT,
  warranty_end_at TEXT,

  -- ---- lifecycle -------------------------------------------------------
  issued_by TEXT,
  issued_at TEXT,
  print_count INTEGER NOT NULL DEFAULT 0,
  last_printed_at TEXT,
  replaces_receipt_id TEXT,
  replaced_by_receipt_id TEXT,
  replacement_reason TEXT NOT NULL DEFAULT '',
  replaced_at TEXT,
  void_reason TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  voided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_warranty_receipts_no ON warranty_receipts(receipt_no);
-- A device may hold only ONE live receipt, and a serial may back only one.
-- Superseded rows are excluded so history survives.
CREATE UNIQUE INDEX IF NOT EXISTS idx_warranty_receipts_unit_live
  ON warranty_receipts(unit_id) WHERE status IN ('draft','active');
CREATE UNIQUE INDEX IF NOT EXISTS idx_warranty_receipts_serial_live
  ON warranty_receipts(serial_norm) WHERE status IN ('draft','active') AND serial_norm <> '';
CREATE INDEX IF NOT EXISTS idx_warranty_receipts_order ON warranty_receipts(order_id);
CREATE INDEX IF NOT EXISTS idx_warranty_receipts_user ON warranty_receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_warranty_receipts_serial ON warranty_receipts(serial_norm);
CREATE INDEX IF NOT EXISTS idx_warranty_receipts_status ON warranty_receipts(status, warranty_end_at);

-- The receipt's own history is read out of the existing audit trail, which
-- until now was only indexed by time.
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target);
