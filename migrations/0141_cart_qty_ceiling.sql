-- Raises the per-line
-- storage ceiling of cart_items.qty from 99 to 9999 so a direct sale can take
-- what the shelf holds (owner 2026-09-26: «ألف قطعة من الميدالية») and a
-- pre-order stays open up to a technical ceiling. SQLite cannot ALTER a CHECK,
-- so the table is rebuilt. cart_bundle_choices references cart_items ON DELETE
-- CASCADE and D1 fires FK actions on DROP TABLE, so its rows are stashed
-- first and restored after. Land together with LINE_QTY_MAX = 9999 in
-- packages/pricing/src/quantity.ts.
CREATE TABLE _mig0141_cart_bundle_choices AS SELECT * FROM cart_bundle_choices;

CREATE TABLE cart_items_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_type TEXT NOT NULL DEFAULT 'levonis' CHECK (seller_type IN ('levonis','merchant')),
  merchant_id TEXT REFERENCES community_merchants(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES merchant_stores(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  community_product_id TEXT REFERENCES community_products(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL DEFAULT '',
  option_value_ids TEXT NOT NULL DEFAULT '[]',
  color_id TEXT NOT NULL DEFAULT '',
  shipping_method_id TEXT NOT NULL DEFAULT '',
  transport_method TEXT NOT NULL DEFAULT '',
  warranty_plan_id TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL CHECK (qty > 0 AND qty <= 9999),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  draw_salt TEXT NOT NULL DEFAULT '',
  fulfillment_type TEXT NOT NULL DEFAULT '',
  variant_id TEXT REFERENCES community_product_variants(id) ON DELETE SET NULL,
  CHECK (
    (seller_type = 'levonis'  AND product_id IS NOT NULL AND community_product_id IS NULL
       AND merchant_id IS NULL AND store_id IS NULL)
    OR
    (seller_type = 'merchant' AND community_product_id IS NOT NULL AND product_id IS NULL
       AND merchant_id IS NOT NULL AND store_id IS NOT NULL)
  ),
  UNIQUE (user_id, product_id, community_product_id, option_id, color_id, shipping_method_id)
);
INSERT INTO cart_items_new (id,user_id,seller_type,merchant_id,store_id,product_id,community_product_id,option_id,
  option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty,created_at,draw_salt,fulfillment_type,variant_id)
SELECT id,user_id,seller_type,merchant_id,store_id,product_id,community_product_id,option_id,
  option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty,created_at,draw_salt,fulfillment_type,variant_id
  FROM cart_items;
DROP TABLE cart_items;
ALTER TABLE cart_items_new RENAME TO cart_items;

CREATE INDEX IF NOT EXISTS idx_cart_user ON cart_items(user_id);
CREATE INDEX IF NOT EXISTS idx_cart_seller ON cart_items(user_id, seller_type, merchant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_merchant_line ON cart_items(user_id, community_product_id, option_id, color_id)
  WHERE community_product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_levonis_line ON cart_items(user_id, product_id, option_id, option_value_ids, color_id, shipping_method_id)
  WHERE product_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_cart_items_one_seller_insert
BEFORE INSERT ON cart_items FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM cart_items x WHERE x.user_id = NEW.user_id AND x.id <> NEW.id
  AND (x.seller_type <> NEW.seller_type OR COALESCE(x.merchant_id, '') <> COALESCE(NEW.merchant_id, '')))
BEGIN SELECT RAISE(ABORT, 'CART_SELLER_CONFLICT'); END;
CREATE TRIGGER IF NOT EXISTS trg_cart_items_one_seller_update
BEFORE UPDATE OF user_id, seller_type, merchant_id ON cart_items FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM cart_items x WHERE x.user_id = NEW.user_id AND x.id <> NEW.id
  AND (x.seller_type <> NEW.seller_type OR COALESCE(x.merchant_id, '') <> COALESCE(NEW.merchant_id, '')))
BEGIN SELECT RAISE(ABORT, 'CART_SELLER_CONFLICT'); END;

-- The stash is the truth for these rows: whatever the DROP left behind (with
-- foreign keys off nothing cascades) is cleared first, then restored in full.
-- Plain statements, not OR IGNORE: this file runs once, and the stash exists
-- only inside it.
DELETE FROM cart_bundle_choices
  WHERE cart_item_id IN (SELECT cart_item_id FROM _mig0141_cart_bundle_choices);
INSERT INTO cart_bundle_choices SELECT * FROM _mig0141_cart_bundle_choices
  WHERE cart_item_id IN (SELECT id FROM cart_items);
DROP TABLE _mig0141_cart_bundle_choices;
