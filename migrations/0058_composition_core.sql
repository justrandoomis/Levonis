-- 0058 — COMPOSITION CORE (docs/BUNDLES_MYSTERY.md §1.2–§1.7)
--
-- A bundle and a random-filament offer are REAL `products` rows carrying a new
-- `composition` column. Nothing here creates a stock or reserved column outside
-- the four real stock tables (products, product_option_values, product_colors,
-- product_variants): availability is COMPUTED from them at every read
-- (`bundleAvailability`), never stored. §15.2 pins that with a static test.
--
-- Every statement is re-runnable: CREATE ... IF NOT EXISTS, plus the
-- ALTER TABLE ... ADD COLUMN shape `order_items` has already grown by five
-- times (0002, 0008, 0023, 0030), which D1's own bookkeeping guarantees runs
-- exactly once.

-- ---------------------------------------------------------------- products
-- ''        an ordinary catalogue product — every existing row
-- 'bundle'  a fixed composition, listed in bundle_components
-- 'mystery' a server-drawn composition, from a mystery pool
--
-- No SQLite CHECK: `sale_types` (0018) is the precedent — a constrained-by-code
-- column — so a third value is an ALTER-free change. The enum is normalised in
-- worker/lib/productModel.ts and refused at every write door.
ALTER TABLE products ADD COLUMN composition TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_products_composition
  ON products(composition, status, display_order);

-- --------------------------------------------------------------- cart_items
-- 64 hex from randomSeedHex(), written by the SERVER when a mystery line is
-- created, rewritten never. It is the only variable input to the draw seed
-- (§7.3), and it exists so that no value the client chooses — least of all the
-- checkout idempotency key — can be ground for a favourable roll.
--
-- ADD COLUMN does not touch `idx_cart_levonis_line`. A new column inside that
-- partial unique index's tuple would have rebuilt it, which is exactly why the
-- composition key is NOT this column (§5.1, §17 decision 9), and why
-- migrations/0032_cart_line_identity.sql exists.
ALTER TABLE cart_items ADD COLUMN draw_salt TEXT NOT NULL DEFAULT '';

-- ------------------------------------------------------------ bundle_config
-- The per-offer knobs a `products` row has no home for. NO stock column: the
-- bundle row's own products.stock is NULL for ever.
CREATE TABLE IF NOT EXISTS bundle_config (
  product_id         TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,

  -- PRICE MODE. 'fixed' uses the product's own ladder. The two discount modes
  -- derive the price from the live component total at every read.
  price_mode         TEXT NOT NULL DEFAULT 'fixed',   -- 'fixed'|'discount_percent'|'discount_iqd'
  discount_percent   INTEGER,                          -- 1..90, price_mode='discount_percent'
  discount_iqd       INTEGER,                          -- >0,   price_mode='discount_iqd'
  -- The floor a DERIVED price may never fall below. A derived price that
  -- computes below it is not sold at all (§4.3) — a bundle is never free
  -- because a component went free or an admin typed one zero too many.
  min_price_iqd      INTEGER NOT NULL DEFAULT 1 CHECK (min_price_iqd >= 1),
  -- The PLUS rung the product ladder does not have (§4.4). Offer-scoped only.
  plus_price_iqd     INTEGER,

  -- PURCHASE SHAPE
  max_qty_per_order  INTEGER NOT NULL DEFAULT 5 CHECK (max_qty_per_order BETWEEN 1 AND 99),

  -- MYSTERY ONLY ('' on a bundle)
  duplicate_policy   TEXT NOT NULL DEFAULT '',         -- ''|'allow'|'discourage'|'forbid'
  reveal_stage       TEXT NOT NULL DEFAULT '',         -- ''|'paid'|'confirmed'|'preparing'|'shipped'|'delivered'
  show_odds          INTEGER NOT NULL DEFAULT 0,

  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- -------------------------------------------------------- bundle_components
-- `id` is a SURROGATE key on purpose. The legacy pair's
-- `bundle_items PRIMARY KEY (bundle_id, product_id)` (0034) forbids the same
-- product twice in one bundle, which kills "two spools of PLA, one black one
-- white" and "three nozzles, two of 0.4 and one of 0.6".
--
-- member_product_id ... ON DELETE RESTRICT on purpose: deleting a member
-- product must be REFUSED with the bundle named, never silently cascade a
-- bundle into incoherence.
CREATE TABLE IF NOT EXISTS bundle_components (
  id                     TEXT PRIMARY KEY,             -- 'bc_<20 hex>' via newId('bc')
  bundle_product_id      TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  member_product_id      TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty                    INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0 AND qty <= 99),
  optional               INTEGER NOT NULL DEFAULT 0,   -- 0|1
  -- FIXED selection, pinned by the admin. Empty = not pinned at this level.
  option_value_ids       TEXT NOT NULL DEFAULT '[]',   -- JSON string[], stored SORTED
  color_id               TEXT NOT NULL DEFAULT '',
  -- CUSTOMER-SELECTABLE selection.
  customer_picks_option  INTEGER NOT NULL DEFAULT 0,
  customer_picks_color   INTEGER NOT NULL DEFAULT 0,
  sort                   INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_bundle_components_bundle
  ON bundle_components(bundle_product_id, sort, id);
CREATE INDEX IF NOT EXISTS idx_bundle_components_member
  ON bundle_components(member_product_id);

-- The allow-list a customer-selectable component may be chosen from.
-- No rows for a dimension = "any active value of that dimension".
CREATE TABLE IF NOT EXISTS bundle_component_choices (
  component_id TEXT NOT NULL REFERENCES bundle_components(id) ON DELETE CASCADE,
  dim          TEXT NOT NULL,                           -- 'option_value' | 'color'
  ref_id       TEXT NOT NULL,                           -- product_option_values.id | product_colors.id
  sort         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (component_id, dim, ref_id)
);

-- ----------------------------------------------------- cart_bundle_choices
-- The readable choices behind one bundle cart line. The line itself stays an
-- ordinary `cart_items` row (§5.1) — no index is rebuilt.
CREATE TABLE IF NOT EXISTS cart_bundle_choices (
  cart_item_id     TEXT NOT NULL REFERENCES cart_items(id) ON DELETE CASCADE,
  component_id     TEXT NOT NULL REFERENCES bundle_components(id) ON DELETE CASCADE,
  option_value_ids TEXT NOT NULL DEFAULT '[]',          -- JSON string[], SORTED server-side
  color_id         TEXT NOT NULL DEFAULT '',
  included         INTEGER NOT NULL DEFAULT 1,          -- an optional component the buyer declined = 0
  PRIMARY KEY (cart_item_id, component_id)
);

-- --------------------------------------------------------------- order_items
-- Four additive columns. `orders` gains nothing: the bundle-level snapshot
-- lives inside the parent row's existing `pricing_snapshot` (§6.2).
ALTER TABLE order_items ADD COLUMN bundle_parent_item_id TEXT;    -- NULL on a parent and on ordinary lines
ALTER TABLE order_items ADD COLUMN bundle_component_id  TEXT;     -- bundle_components.id, provenance
ALTER TABLE order_items ADD COLUMN component_value_iqd  INTEGER;  -- undiscounted standalone value
ALTER TABLE order_items ADD COLUMN component_alloc_iqd  INTEGER;  -- this component's share of the bundle price
CREATE INDEX IF NOT EXISTS idx_order_items_bundle_parent
  ON order_items(bundle_parent_item_id);

-- ------------------------------------------------- order_reservation_fence
-- Ten lines that make a PARTIAL inventory movement impossible — for every
-- order, bundle or not, and on EVERY kind, not only 'reserve'.
--
-- planInventory writes a guarded INSERT and a guarded UPDATE per target. A
-- guard that stops holding between the plan-time read and the commit makes
-- both match zero rows WITHOUT failing the batch, and the order then commits
-- with a component unreserved (or, on cancellation, the customer refunded
-- while the units stay held for ever).
--
-- Earlier statements in a D1 batch are visible to later ones, so `actual`
-- counts the ledger rows this same batch just wrote. If any guarded insert
-- matched zero rows, actual < expected, this CHECK fires, and the WHOLE batch
-- rolls back — order, wallet spend, points and every other reservation with
-- it. worker/routes/orders.ts already maps a CHECK violation to CONFLICT_RETRY,
-- so no catch-block change is needed.
--
-- The key is (order_id, kind) because confirmation, cancellation and return
-- move the same order's stock again later, each in its own batch.
CREATE TABLE IF NOT EXISTS order_reservation_fence (
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,        -- 'reserve' | 'deduct' | 'release' | 'restore'
  expected   INTEGER NOT NULL,
  actual     INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (order_id, kind),
  CHECK (actual = expected)
);
