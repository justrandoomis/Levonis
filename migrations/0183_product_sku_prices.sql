-- 0183 — FX-7: THE PER-SKU PRICE RUNG (FX programme plan §4.4, §11, §26; USD procurement design
-- §4.1 and owner question Q4: colour and SKU levels; owner decision 1 of 2026-10-07, DECISIONS row
-- 184 (1): «SKU آخر درجة وأكثرها تحديدًا في السُّلّم (منتج ← خيار ← لون ← SKU)… لكل SKU سعر نهائي
-- محفوظ جاهز للقراءة»).
--
-- ADDITIVE ONLY: one new table and its three guards. Updates or deletes no existing row, changes no
-- price, names no accounting table (orders, order_items, wallet_*, gift_*, inventory_lots).
--
-- WHAT A ROW IS. The final REGULAR price of one SKU (`combo_key`, exactly the identity
-- `product_variants.combo_key` uses: option value ids sorted, each `o:<id>`, then `c:<colour id>`,
-- joined by '|') on one sale channel, written by the pricing engine's writer only. The cart's
-- resolver (packages/pricing/src/pricing.ts) reads it as the last rung of the ladder, after the
-- colour: a selection with a row is charged exactly that price (member layers, warranty and the
-- payment rule stay read-time, owner decision 6); a selection without one walks the ladder as
-- before. Public data (a price a guest is charged), never a cost: the engine's private figures stay
-- in pricing_sku_costs.
--
-- ROLLBACK SAFETY (FX plan §4.4). The writer keeps every model's route rows, order-type cells and
-- option row at the HIGHEST price of the model's SKUs and clears the colour rows' prices, so a
-- Worker that ignores this table (an older commit) never charges a SKU less than its price here.
--
-- WHO WRITES. INSERT and UPDATE only inside a batch holding the engine's token
-- 'engine-price:<product_id>' (or the repricing token 'pricing-rates-apply'), the same token the
-- 0181 locks accept. DELETE on an engine-priced product needs it too; a manual product's rows (left
-- by an exit to manual pricing) and a product being deleted are free to go. A missing row is never
-- cheaper: the ladder beneath holds the highest price. Every refusal is ENGINE_MANAGED (0181's code,
-- already a 409 in the viewer's language).
CREATE TABLE IF NOT EXISTS product_sku_prices (
  product_id        TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key         TEXT NOT NULL CHECK (length(combo_key) BETWEEN 3 AND 400 AND (combo_key GLOB 'o:?*' OR combo_key GLOB 'c:?*')),
  channel           TEXT NOT NULL CHECK (channel IN ('direct_sale','pre_order_air','pre_order_sea','pre_order_land')),
  regular_price_iqd INTEGER NOT NULL CHECK (regular_price_iqd BETWEEN 1000 AND 100000000000 AND regular_price_iqd % 1000 = 0),
  source            TEXT NOT NULL DEFAULT 'ENGINE' CHECK (source = 'ENGINE'),
  write_seq         INTEGER NOT NULL CHECK (write_seq > 0),
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (product_id, combo_key, channel)
);

CREATE TRIGGER IF NOT EXISTS product_sku_prices_insert_guard BEFORE INSERT ON product_sku_prices
WHEN NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS product_sku_prices_update_guard BEFORE UPDATE ON product_sku_prices
WHEN NEW.product_id IS NOT OLD.product_id
  OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS product_sku_prices_delete_guard BEFORE DELETE ON product_sku_prices
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine')
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
