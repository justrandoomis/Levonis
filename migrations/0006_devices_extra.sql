-- Levonis migration 0006 — serialized-device extras building on 0003.
-- NONDESTRUCTIVE: ADD COLUMN / CREATE INDEX only.
--
-- 0003 already provides order_item_units (UNIQUE(order_item_id, unit_index)),
-- device_serials, device_registrations and claim_messages. This migration
-- adds only what the device/replacement/claim workflows need on top.

PRAGMA defer_foreign_keys = true;

-- Replacement chain between PHYSICAL units: on an approved replacement the
-- old unit points forward, the new unit points back. History is preserved —
-- neither row is ever deleted.
ALTER TABLE order_item_units ADD COLUMN replaced_by_unit_id TEXT REFERENCES order_item_units(id);
ALTER TABLE order_item_units ADD COLUMN replacement_of_unit_id TEXT REFERENCES order_item_units(id);

-- Registration revocation (e.g. when the unit is replaced). The row is kept
-- for history; revoked_at marks it inactive. Never affects warranty dates.
ALTER TABLE device_registrations ADD COLUMN revoked_at TEXT;

-- Claim subject line (device claims). The legacy product_name column keeps
-- the display name of the affected product.
ALTER TABLE warranty_claims ADD COLUMN subject TEXT NOT NULL DEFAULT '';

-- Richer claim workflow stage: received|diagnosing|approved|rejected|
-- repairing|replaced|resolved (validated in code — the legacy `status`
-- column has a CHECK constraint limited to submitted/in_review/approved/
-- rejected and is kept in sync as a coarse mapping for old clients).
ALTER TABLE warranty_claims ADD COLUMN stage TEXT;

CREATE INDEX idx_units_item ON order_item_units(order_item_id);
CREATE INDEX idx_warranty_claims_unit ON warranty_claims(unit_id);
