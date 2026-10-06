-- Extra purchase costs (local delivery, customs, transfer fees, packaging) say
-- what they cover and keep the exact dinars they put on each purchase line.
-- Additive: older rows read as one shipment-wide amount with no saved split.
ALTER TABLE purchase_charges ADD COLUMN scope TEXT NOT NULL DEFAULT 'shipment' CHECK(scope IN ('shipment','unit'));
ALTER TABLE purchase_charges ADD COLUMN unit_amount_iqd INTEGER CHECK(unit_amount_iqd IS NULL OR unit_amount_iqd>0);
-- JSON array of "product_id:scope:scope_id" selection keys; NULL covers every line.
ALTER TABLE purchase_charges ADD COLUMN applies_to_json TEXT;
-- JSON array of {"line_id","amount_iqd"}: the share saved on each covered purchase line.
ALTER TABLE purchase_charges ADD COLUMN allocation_json TEXT;
ALTER TABLE purchase_charges ADD COLUMN position INTEGER;
