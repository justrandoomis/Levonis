-- ============================================================================
--  0073 — A PRODUCT OPTION IS A MODEL. IT IS NOT AN ORDER TYPE.
-- ============================================================================
-- THE DEFECT, IN THE OWNER'S WORDS:
--
--   "لا تنشئ Pre-order / Direct / Air / Sea / Land كـProduct Options."
--   "PRODUCT OPTION != ORDER TYPE != PREORDER TRANSPORT != LOCAL DELIVERY."
--
-- Migration 0043 made an OPTION ROW the unit of fulfilment: it hung
-- `availability_type`, `lead_time_*` and `variant_key` off
-- `product_option_values`, so "A1 mini — Pre-order" and "A1 mini — Direct" are
-- two option rows that pretend to be one model by sharing a `variant_key`.
-- That was the cheapest way to ship per-option availability, and it is the
-- wrong shape: it doubles the catalogue for every model, it cannot express a
-- per-model direct difference (A1 mini +50,000 while the Combo is +20,000 —
-- `products.direct_surcharge_iqd` is ONE number for the whole product), and it
-- makes the customer pick their order type from a list of product options.
--
-- THE SHAPE THIS RESTORES. Four independent things, each with its own home:
--
--   PRODUCT OPTION      product_option_values        the MODEL. `A1 mini`.
--   ORDER TYPE          product_option_fulfillment   direct sale / pre-order,
--                                                    priced PER MODEL.
--   PREORDER TRANSPORT  product_option_transports    air / sea / land — how the
--                                                    unit reaches Iraq.
--   LOCAL DELIVERY      products.ops_policy           standard / personal —
--                       .delivery_options             how it reaches the door,
--                                                    AFTER the purchase. It is
--                                                    not touched here, and it
--                                                    never mixes with the row
--                                                    above: one is import, the
--                                                    other is the last mile.
--
-- PRICING PRECEDENCE (packages/pricing) once these exist, most specific first:
--   transport row -> fulfilment row -> option row -> product row, with the
--   product's `preorder_transports` commission and `direct_surcharge_iqd`
--   remaining as FALLBACKS ONLY. An override REPLACES its fallback and never
--   adds to it: a model Air surcharge of 80,000 over a product Air of 50,000
--   is 80,000, not 130,000.
--
-- WHAT THIS MIGRATION DOES TO EXISTING DATA, AND WHY IT CANNOT CHANGE A PRICE:
--
--   Every option row that declares a route becomes a FULFILMENT row carrying
--   that row's prices VERBATIM — the same four price columns and the same four
--   adjustment columns, copied, not recomputed. A fulfilment rung with a fixed
--   price replaces what is beneath it, so the resolved number is identical to
--   what the option row resolved to before. A NULL stays NULL and still
--   inherits. No arithmetic is performed anywhere in this file.
--
--   Rows sharing a `variant_key` then MERGE into one model. The survivor is the
--   CHEAPEST member — the one whose regular price resolves lowest, which is the
--   number a model should show before the customer has chosen anything. The
--   others become tombstones: `active = 0`, `merged_into = <survivor>`. They
--   are NOT deleted, and that is deliberate — `order_items.option_id` is NOT
--   NULL and points at them, and an order's line must keep resolving. The
--   overlay hides a tombstone; history still finds it.
--
--   Live cart lines are repointed to the survivor and keep their order type in
--   the new `cart_items.fulfillment_type`, so nobody's basket silently changes
--   what it is buying.
-- ============================================================================

-- ---------------------------------------------------------------- ORDER TYPE
-- One row per (model, order type). Absence means the model does not sell that
-- way; `enabled = 0` means it is configured but currently switched off, which
-- the admin needs to tell apart from "never set up".
CREATE TABLE IF NOT EXISTS product_option_fulfillment (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES product_option_values(id) ON DELETE CASCADE,
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('direct_sale', 'pre_order')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- The same four selling fields every other pricing row carries, with the
  -- same contract: NULL = inherit the rung beneath; a fixed price REPLACES it;
  -- an adjustment MOVES it. Nothing new to learn, and one resolver walks all
  -- of them.
  regular_price_iqd INTEGER CHECK (regular_price_iqd IS NULL OR regular_price_iqd >= 0),
  prime_price_iqd INTEGER CHECK (prime_price_iqd IS NULL OR prime_price_iqd >= 0),
  pro_price_iqd INTEGER CHECK (pro_price_iqd IS NULL OR pro_price_iqd >= 0),
  cost_iqd INTEGER CHECK (cost_iqd IS NULL OR cost_iqd >= 0),
  regular_adjust_iqd INTEGER,
  prime_adjust_iqd INTEGER,
  pro_adjust_iqd INTEGER,
  cost_adjust_iqd INTEGER,

  -- NO STOCK COLUMN HERE, AND THE REASON MATTERS.
  --
  -- The request listed stock on the fulfilment cell, and the behaviour it asks
  -- for — a model that is sold out for direct sale but still open for
  -- pre-order — is exactly right. But a PRE-ORDER has no stock by definition:
  -- it is the sale of a unit that is not on the shelf. So there is only ever
  -- ONE number, "how many we have", and that is the MODEL's stock, which
  -- `product_option_values.stock` already is and which the inventory ledger
  -- already counts (scope 'option', with 'base', 'color' and 'variant').
  --
  -- The behaviour therefore comes from WHO READS IT: the direct-sale cell
  -- consults the model's stock, the pre-order cell ignores it. Putting a fifth
  -- counter here instead would fork the ledger — `inventory_ledger.scope` is
  -- pinned by a CHECK that SQLite cannot widen without rebuilding an
  -- append-only history table — and give the store two places to be wrong
  -- about the same physical shelf.

  -- A pre-order's promise. Prose wins over the numbers, which are for sorting
  -- and estimates. A direct sale normally leaves all three empty.
  lead_time_text TEXT NOT NULL DEFAULT '',
  lead_time_min_days INTEGER,
  lead_time_max_days INTEGER,

  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- One cell per (model, order type) — the constraint that makes "Pre-order" a
-- property of a model rather than a second model.
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_fulfillment_cell
  ON product_option_fulfillment(option_id, fulfillment_type);
CREATE INDEX IF NOT EXISTS idx_option_fulfillment_product
  ON product_option_fulfillment(product_id, sort);

-- ------------------------------------------------------- PREORDER TRANSPORT
-- How the unit reaches Iraq, per (model, pre-order). NEVER local delivery:
-- `standard_delivery_*` / `personal_delivery_*` are the last mile after the
-- purchase and live in products.ops_policy, untouched by this file.
CREATE TABLE IF NOT EXISTS product_option_transports (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  fulfillment_id TEXT NOT NULL REFERENCES product_option_fulfillment(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('air', 'sea', 'land')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- THE FEE FOR THIS ROUTE, for this model. When set it REPLACES the product's
  -- `preorder_transports` commission for this method — it does not add to it.
  -- NULL = fall back to the product, then to the admin default.
  surcharge_iqd INTEGER CHECK (surcharge_iqd IS NULL OR surcharge_iqd >= 0),

  -- Per-tier overrides for the ITEM price on this exact route, with the same
  -- fixed/adjust contract as every other rung. Distinct from `surcharge_iqd`:
  -- that is a shipping fee an active PRO is exempt from; these are the item's
  -- own price, which no membership waives.
  regular_price_iqd INTEGER CHECK (regular_price_iqd IS NULL OR regular_price_iqd >= 0),
  prime_price_iqd INTEGER CHECK (prime_price_iqd IS NULL OR prime_price_iqd >= 0),
  pro_price_iqd INTEGER CHECK (pro_price_iqd IS NULL OR pro_price_iqd >= 0),
  cost_iqd INTEGER CHECK (cost_iqd IS NULL OR cost_iqd >= 0),
  regular_adjust_iqd INTEGER,
  prime_adjust_iqd INTEGER,
  pro_adjust_iqd INTEGER,
  cost_adjust_iqd INTEGER,

  lead_time_text TEXT NOT NULL DEFAULT '',
  lead_time_min_days INTEGER,
  lead_time_max_days INTEGER,

  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_transport_cell
  ON product_option_transports(fulfillment_id, method);
CREATE INDEX IF NOT EXISTS idx_option_transport_product
  ON product_option_transports(product_id, sort);

-- -------------------------------------------------------------- TOMBSTONES
-- Where a merged-away option went. '' = this row is a model in its own right.
-- A tombstone is hidden by the overlay and skipped by every write path, but it
-- still EXISTS, because `order_items.option_id` is NOT NULL and names it.
ALTER TABLE product_option_values ADD COLUMN merged_into TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_option_values_merged
  ON product_option_values(merged_into) WHERE merged_into <> '';

-- ------------------------------------------------- ORDER TYPE ON A CART LINE
-- The order type stops being inferred from "did they send a transport?" and
-- becomes what it is: an independent choice the customer made. '' = not stated
-- (a legacy line, or a product that sells only one way), which resolves
-- exactly as it did before.
ALTER TABLE cart_items ADD COLUMN fulfillment_type TEXT NOT NULL DEFAULT '';

-- ============================================================================
--  THE MERGE
-- ============================================================================

-- 1. Every option that declares a route becomes a fulfilment row, attributed
--    to the SURVIVOR of its variant group. Prices are COPIED, never computed.
INSERT INTO product_option_fulfillment (
  id, product_id, option_id, fulfillment_type, enabled,
  regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd,
  regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd,
  lead_time_text, lead_time_min_days, lead_time_max_days, sort
)
SELECT
  'ofl_' || v.id || '_' || v.availability_type,
  v.product_id,
  -- The survivor: the cheapest member of this variant group, by the regular
  -- price it actually resolves to (a NULL inherits the product's, plus this
  -- row's adjustment if it has one). Ties break on sort then id, so the choice
  -- is deterministic and a re-run picks the same row.
  COALESCE((
    SELECT s.id FROM product_option_values s
     WHERE s.product_id = v.product_id
       AND s.group_id = v.group_id
       AND s.variant_key = v.variant_key
       AND v.variant_key <> ''
     ORDER BY
       COALESCE(
         s.regular_price_iqd,
         (SELECT p.price_iqd FROM products p WHERE p.id = s.product_id) + COALESCE(s.regular_adjust_iqd, 0)
       ),
       s.sort, s.id
     LIMIT 1
  ), v.id),
  v.availability_type,
  v.active,
  v.regular_price_iqd, v.prime_price_iqd, v.pro_price_iqd, v.cost_iqd,
  v.regular_adjust_iqd, v.prime_adjust_iqd, v.pro_adjust_iqd, v.cost_adjust_iqd,
  v.lead_time_text, v.lead_time_min_days, v.lead_time_max_days,
  v.sort
FROM product_option_values v
WHERE v.availability_type IN ('direct_sale', 'pre_order')
  -- ONE ROW PER CELL. A malformed legacy group can hold two rows declaring the
  -- SAME route (two "A1 mini — Pre-order"s); only the first by (sort, id)
  -- becomes the fulfilment, because `idx_option_fulfillment_cell` is what makes
  -- a cell a cell and a second insert would abort the whole migration.
  AND v.id = (
    SELECT s.id FROM product_option_values s
     WHERE s.product_id = v.product_id
       AND s.group_id = v.group_id
       AND s.availability_type = v.availability_type
       AND (CASE WHEN v.variant_key = '' THEN s.id = v.id ELSE s.variant_key = v.variant_key END)
     ORDER BY s.sort, s.id
     LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM product_option_fulfillment f
     WHERE f.id = 'ofl_' || v.id || '_' || v.availability_type
  );

-- 2. Mark the merged-away rows. A row is a tombstone when it shares a
--    non-empty variant_key with a DIFFERENT row that won the survivor test.
UPDATE product_option_values
   SET merged_into = (
         SELECT s.id FROM product_option_values s
          WHERE s.product_id = product_option_values.product_id
            AND s.group_id = product_option_values.group_id
            AND s.variant_key = product_option_values.variant_key
          ORDER BY
            COALESCE(
              s.regular_price_iqd,
              (SELECT p.price_iqd FROM products p WHERE p.id = s.product_id) + COALESCE(s.regular_adjust_iqd, 0)
            ),
            s.sort, s.id
          LIMIT 1
       )
 WHERE merged_into = ''
   AND variant_key <> ''
   AND id <> (
         SELECT s.id FROM product_option_values s
          WHERE s.product_id = product_option_values.product_id
            AND s.group_id = product_option_values.group_id
            AND s.variant_key = product_option_values.variant_key
          ORDER BY
            COALESCE(
              s.regular_price_iqd,
              (SELECT p.price_iqd FROM products p WHERE p.id = s.product_id) + COALESCE(s.regular_adjust_iqd, 0)
            ),
            s.sort, s.id
          LIMIT 1
       );

-- 3. A tombstone is never sellable again. (Its fulfilment row carries whether
--    that ROUTE is enabled; this is about the duplicate MODEL row.)
UPDATE product_option_values SET active = 0 WHERE merged_into <> '';

-- 3b. THE SHELF FOLLOWS THE MODEL. In the legacy shape the DIRECT row carried
--     the real count and the pre-order row carried NULL — and the survivor is
--     the cheaper row, which is usually the pre-order one. Without this the
--     merge would silently zero a model that has units in the warehouse.
UPDATE product_option_values
   SET stock = (
         SELECT d.stock FROM product_option_values d
          WHERE d.merged_into = product_option_values.id AND d.availability_type = 'direct_sale'
          ORDER BY d.sort, d.id LIMIT 1
       ),
       low_stock_threshold = (
         SELECT d.low_stock_threshold FROM product_option_values d
          WHERE d.merged_into = product_option_values.id AND d.availability_type = 'direct_sale'
          ORDER BY d.sort, d.id LIMIT 1
       )
 WHERE merged_into = ''
   AND availability_type <> 'direct_sale'
   AND EXISTS (
         SELECT 1 FROM product_option_values d
          WHERE d.merged_into = product_option_values.id AND d.availability_type = 'direct_sale'
       );

-- 4. The survivor takes the model's name. `variant_label` is what 0043 stored
--    it as; with none, the row keeps the name it already had and an admin can
--    rename it — inventing one by stripping words out of a name is how you
--    turn "A1 mini Direct Drive" into "A1 mini".
UPDATE product_option_values
   SET name_en = variant_label
 WHERE merged_into = '' AND variant_key <> '' AND variant_label <> '' AND name_en <> variant_label;

-- 5. Live baskets. The order type the line already implied is written down
--    BEFORE the pointer moves, or it would be lost with the tombstone.
UPDATE cart_items
   SET fulfillment_type = COALESCE(
         (SELECT v.availability_type FROM product_option_values v WHERE v.id = cart_items.option_id),
         ''
       )
 WHERE fulfillment_type = ''
   AND option_id IS NOT NULL
   AND (SELECT v.availability_type FROM product_option_values v WHERE v.id = cart_items.option_id)
       IN ('direct_sale', 'pre_order');

UPDATE cart_items
   SET option_id = (SELECT v.merged_into FROM product_option_values v WHERE v.id = cart_items.option_id)
 WHERE option_id IS NOT NULL
   AND (SELECT v.merged_into FROM product_option_values v WHERE v.id = cart_items.option_id) <> '';

-- 6. Colour links follow the model, not the tombstone. `INSERT OR IGNORE` then
--    delete, because the survivor may already carry the same link and the
--    table's uniqueness would refuse a plain UPDATE.
INSERT OR IGNORE INTO product_color_option_links (color_id, option_value_id, group_id)
SELECT l.color_id, v.merged_into, l.group_id
  FROM product_color_option_links l
  JOIN product_option_values v ON v.id = l.option_value_id
 WHERE v.merged_into <> '';

DELETE FROM product_color_option_links
 WHERE option_value_id IN (SELECT id FROM product_option_values WHERE merged_into <> '');
