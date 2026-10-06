-- Raw supplier costs and packed measurements are opt-in, forward-only defaults.
-- Do not infer raw prices from catalogue or old purchases: those may be landed.
CREATE TABLE procurement_cost_profiles (
  id TEXT PRIMARY KEY CHECK(id IN ('germany_land','china_air','china_sea')),
  currency TEXT NOT NULL CHECK(currency IN ('EUR','CNY')),
  shipping_basis TEXT NOT NULL CHECK(shipping_basis IN ('weight','volume')),
  exchange_rate REAL CHECK(exchange_rate IS NULL OR exchange_rate>0),
  shipping_rate_iqd REAL CHECK(shipping_rate_iqd IS NULL OR shipping_rate_iqd>=0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by TEXT REFERENCES users(id), updated_at TEXT,
  CHECK((id='germany_land' AND currency='EUR' AND shipping_basis='weight') OR
        (id='china_air' AND currency='CNY' AND shipping_basis='weight') OR
        (id='china_sea' AND currency='CNY' AND shipping_basis='volume'))
);
INSERT INTO procurement_cost_profiles(id,currency,shipping_basis) VALUES
  ('germany_land','EUR','weight'),('china_air','CNY','weight'),('china_sea','CNY','volume');
CREATE TABLE procurement_selection_cost_defaults (
  profile_id TEXT NOT NULL REFERENCES procurement_cost_profiles(id),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('base','option','color','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  source_unit_amount REAL CHECK(source_unit_amount IS NULL OR source_unit_amount>=0),
  weight_g REAL NOT NULL CHECK(weight_g>=0),
  volume_mm3 REAL NOT NULL CHECK(volume_mm3>=0),
  updated_by TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
  PRIMARY KEY(profile_id,product_id,scope,scope_id)
);
CREATE INDEX idx_procurement_defaults_product ON procurement_selection_cost_defaults(product_id);
ALTER TABLE purchase_orders ADD COLUMN cost_profile_id TEXT REFERENCES procurement_cost_profiles(id);
ALTER TABLE purchase_orders ADD COLUMN cost_profile_version INTEGER;
ALTER TABLE purchase_orders ADD COLUMN shipping_rate_iqd REAL CHECK(shipping_rate_iqd IS NULL OR shipping_rate_iqd>=0);
ALTER TABLE purchase_orders ADD COLUMN shipping_basis TEXT CHECK(shipping_basis IS NULL OR shipping_basis IN ('weight','volume'));
ALTER TABLE purchase_lines ADD COLUMN auto_shipping_iqd INTEGER NOT NULL DEFAULT 0 CHECK(auto_shipping_iqd>=0);

-- Preserve the supplier invoice decimal; rounded IQD / FX cannot reconstruct it.
ALTER TABLE purchase_lines ADD COLUMN source_total_amount REAL CHECK(source_total_amount IS NULL OR source_total_amount>=0);
