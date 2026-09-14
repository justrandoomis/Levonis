-- Models remain product_option_values. Availability and inbound transport are
-- separately owned relational rows. NULL inherits; zero is an explicit override.
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_product_identity ON product_option_values(product_id, id);

CREATE TABLE IF NOT EXISTS product_option_fulfillment (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('direct_sale','pre_order')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  regular_price_iqd INTEGER CHECK (regular_price_iqd IS NULL OR regular_price_iqd >= 0),
  prime_price_iqd INTEGER CHECK (prime_price_iqd IS NULL OR prime_price_iqd >= 0),
  pro_price_iqd INTEGER CHECK (pro_price_iqd IS NULL OR pro_price_iqd >= 0),
  cost_iqd INTEGER CHECK (cost_iqd IS NULL OR cost_iqd >= 0),
  regular_adjust_iqd INTEGER,
  prime_adjust_iqd INTEGER,
  pro_adjust_iqd INTEGER,
  cost_adjust_iqd INTEGER,
  stock INTEGER CHECK (stock IS NULL OR stock >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND (stock IS NULL OR reserved <= stock)),
  image TEXT NOT NULL DEFAULT '',
  sku_part TEXT NOT NULL DEFAULT '',
  lead_time_text TEXT NOT NULL DEFAULT '',
  lead_time_min_days INTEGER,
  lead_time_max_days INTEGER,
  transports_override INTEGER NOT NULL DEFAULT 0 CHECK (transports_override IN (0,1)),
  CHECK (lead_time_min_days IS NULL OR lead_time_min_days >= 0),
  CHECK (lead_time_max_days IS NULL OR lead_time_max_days >= COALESCE(lead_time_min_days,0)),
  UNIQUE (product_id, option_id, fulfillment_type),
  UNIQUE (product_id, option_id, id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, option_id) REFERENCES product_option_values(product_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS product_option_transports (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  fulfillment_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('air','sea','land')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  surcharge_iqd INTEGER,
  regular_price_iqd INTEGER CHECK (regular_price_iqd IS NULL OR regular_price_iqd >= 0),
  prime_price_iqd INTEGER CHECK (prime_price_iqd IS NULL OR prime_price_iqd >= 0),
  pro_price_iqd INTEGER CHECK (pro_price_iqd IS NULL OR pro_price_iqd >= 0),
  cost_iqd INTEGER,
  regular_adjust_iqd INTEGER,
  prime_adjust_iqd INTEGER,
  pro_adjust_iqd INTEGER,
  cost_adjust_iqd INTEGER,
  lead_time_text TEXT NOT NULL DEFAULT '',
  lead_time_min_days INTEGER,
  lead_time_max_days INTEGER,
  CHECK (lead_time_min_days IS NULL OR lead_time_min_days >= 0),
  CHECK (lead_time_max_days IS NULL OR lead_time_max_days >= COALESCE(lead_time_min_days,0)),
  UNIQUE (fulfillment_id, method),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, option_id, fulfillment_id) REFERENCES product_option_fulfillment(product_id, option_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_model_fulfillment_product ON product_option_fulfillment(product_id, option_id);
CREATE INDEX IF NOT EXISTS idx_model_transports_product ON product_option_transports(product_id, option_id);

-- Alias snapshots retain every old model/route identity for historical orders
-- and for migrating selected IDs. They are owned by the live product.
CREATE TABLE IF NOT EXISTS product_option_aliases (
  legacy_option_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES product_option_values(id) ON DELETE CASCADE,
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('direct_sale','pre_order')),
  legacy_snapshot TEXT NOT NULL
);

ALTER TABLE cart_items ADD COLUMN fulfillment_type TEXT CHECK (fulfillment_type IS NULL OR fulfillment_type IN ('direct_sale','pre_order'));
ALTER TABLE cart_items ADD COLUMN local_delivery_method TEXT;
ALTER TABLE cart_items ADD COLUMN selection_snapshot TEXT NOT NULL DEFAULT '{}';
ALTER TABLE order_items ADD COLUMN selection_snapshot TEXT NOT NULL DEFAULT '{}';

-- Existing data is converted by 0075 with alias/link/stock preservation.
-- Legacy TXT input also passes through the compatibility adapter before the
-- atomic product save. A row is never merged by guessing its name alone.

DROP INDEX IF EXISTS idx_cart_levonis_line;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_levonis_line ON cart_items(user_id,product_id,option_id,color_id,shipping_method_id,COALESCE(fulfillment_type,''),transport_method) WHERE product_id IS NOT NULL;

-- ProductForm removals cannot cascade through live reservations. Permanent
-- deletion archives the ledger and explicitly removes fulfillment rows first.
CREATE TRIGGER IF NOT EXISTS trg_model_reserved_delete
BEFORE DELETE ON product_option_values
WHEN EXISTS (SELECT 1 FROM product_option_fulfillment WHERE option_id=OLD.id AND reserved>0)
BEGIN SELECT RAISE(ABORT,'MODEL_STOCK_RESERVED'); END;
CREATE TRIGGER IF NOT EXISTS trg_fulfillment_reserved_untracked
BEFORE UPDATE OF stock ON product_option_fulfillment
WHEN OLD.reserved>0 AND NEW.stock IS NULL
BEGIN SELECT RAISE(ABORT,'FULFILLMENT_STOCK_RESERVED'); END;
