-- Models keep their existing product_option_values identity and inventory ledger.
-- Only availability/pricing configuration is new. Product defaults are owned by
-- products.ops_policy.fulfillment (the existing versioned document writer).
-- No sample products, prices, inferred model merges or historical-order writes.
CREATE TABLE IF NOT EXISTS product_model_fulfillment (
  model_id TEXT PRIMARY KEY REFERENCES product_option_values(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_model_fulfillment_product ON product_model_fulfillment(product_id, model_id);

-- The raw source row, including private cost, is retained only for migration
-- audit. Public reads select IDs/type explicitly and never select original_json.
-- Noncanonical rows are retained rather than deleted: old references survive.
CREATE TABLE IF NOT EXISTS product_option_legacy_map (
  legacy_option_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES product_option_values(id) ON DELETE CASCADE,
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('direct_sale','pre_order')),
  original_json TEXT NOT NULL CHECK (json_valid(original_json) AND json_type(original_json) = 'object'),
  migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_option_legacy_model ON product_option_legacy_map(product_id, model_id);

CREATE TRIGGER IF NOT EXISTS model_fulfillment_owned_insert
BEFORE INSERT ON product_model_fulfillment
WHEN NOT EXISTS (SELECT 1 FROM product_option_values WHERE id = NEW.model_id AND product_id = NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'FULFILLMENT_MODEL_OWNER_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS model_fulfillment_owned_update
BEFORE UPDATE ON product_model_fulfillment
WHEN NOT EXISTS (SELECT 1 FROM product_option_values WHERE id = NEW.model_id AND product_id = NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'FULFILLMENT_MODEL_OWNER_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS option_legacy_owned_insert
BEFORE INSERT ON product_option_legacy_map
WHEN NOT EXISTS (SELECT 1 FROM product_option_values WHERE id = NEW.model_id AND product_id = NEW.product_id)
  OR EXISTS (SELECT 1 FROM product_option_values WHERE id = NEW.legacy_option_id AND product_id <> NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'FULFILLMENT_ALIAS_OWNER_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS option_legacy_immutable_update
BEFORE UPDATE ON product_option_legacy_map
WHEN NEW.legacy_option_id IS NOT OLD.legacy_option_id OR NEW.product_id IS NOT OLD.product_id
  OR NEW.model_id IS NOT OLD.model_id OR NEW.fulfillment_type IS NOT OLD.fulfillment_type
  OR NEW.original_json IS NOT OLD.original_json OR NEW.migrated_at IS NOT OLD.migrated_at
BEGIN SELECT RAISE(ABORT, 'FULFILLMENT_ALIAS_IMMUTABLE'); END;
