-- Per-product delivery rules are stored inside products.ops_policy as
-- delivery_options, preserving the existing product-row schema and every
-- legacy row. Orders need a dedicated immutable money snapshot for the COD
-- tax so historical totals never depend on future policy changes.
ALTER TABLE orders
  ADD COLUMN cod_tax_iqd INTEGER NOT NULL DEFAULT 0 CHECK (cod_tax_iqd >= 0);

