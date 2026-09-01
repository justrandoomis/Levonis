-- ============================================================================
-- 0036 — STORE BUILDER: sections, services, showcase, merchant coupons.
--
-- The merchant round's schema. Everything here EXTENDS the community-v2 core
-- (0030/0031); nothing rebuilds a live table and nothing deletes a row. All
-- new columns carry defaults so every existing fixture INSERT keeps working,
-- and every CREATE is IF NOT EXISTS so the file re-runs cleanly (the
-- migrations harness re-executes exactly those statements).
-- ============================================================================

-- ------------------------------------------------------------- 1. SECTIONS
-- Named groups a merchant arranges their own catalogue into («مطبوعات جاهزة»,
-- «قطع غيار», «خامات»). Purely organisational: a product without a section is
-- simply ungrouped, and deleting a section must never delete a product — the
-- FK on community_products.section_id is enforced in code (SET NULL on
-- section delete) because 0001's table cannot gain a real FK without a
-- rebuild.
CREATE TABLE IF NOT EXISTS merchant_store_sections (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_store_sections_store
  ON merchant_store_sections(store_id, sort_order);

-- The section a product belongs to (nullable — ungrouped is the default),
-- and whether the merchant pinned it to the top of their shopfront.
ALTER TABLE community_products ADD COLUMN section_id TEXT;
ALTER TABLE community_products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_community_products_section
  ON community_products(section_id);

-- ------------------------------------------------------------- 2. SERVICES
-- What a 3D-printing shop actually SELLS beyond ready goods: print-on-demand,
-- design, finishing. A service is an advertisement with an honest starting
-- price — the real quote always happens through the request/offer flow, so a
-- service row never carries authority over money.
CREATE TABLE IF NOT EXISTS merchant_services (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'print_service'
    CHECK (kind IN ('print_service','design','finishing','scanning','repair','other')),
  -- «يبدأ من» — a floor, not a promise. NULL means "ask for a quote".
  price_from_iqd INTEGER CHECK (price_from_iqd IS NULL OR price_from_iqd >= 0),
  price_unit TEXT NOT NULL DEFAULT '',
  materials TEXT NOT NULL DEFAULT '[]',
  image_key TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_merchant_services_store
  ON merchant_services(store_id, active, sort_order);

-- ------------------------------------------------------------- 3. SHOWCASE
-- The workshop on display: the printers a shop runs, the materials it stocks,
-- and finished works it is proud of. One table, three kinds — they are the
-- same shape (a titled, captioned picture) and always render together.
CREATE TABLE IF NOT EXISTS merchant_showcase (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('printer','material','work')),
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  image_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_merchant_showcase_store
  ON merchant_showcase(store_id, kind, sort_order);

-- ------------------------------------------------------- 4. MERCHANT COUPONS
-- A merchant's own discount codes, scoped to their store and their store
-- ONLY. Platform coupons (0002/0029) are a membership construct and stay
-- untouched; these are validated exclusively inside the store checkout
-- (/api/store-orders), where the discount comes off the merchant's goods —
-- never off the platform's commission base dishonestly: the commission is
-- computed on what the customer actually pays.
CREATE TABLE IF NOT EXISTS merchant_coupons (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fixed_iqd','percent')),
  value INTEGER NOT NULL CHECK (value > 0),
  min_total_iqd INTEGER NOT NULL DEFAULT 0 CHECK (min_total_iqd >= 0),
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (store_id, code)
);
CREATE INDEX IF NOT EXISTS idx_merchant_coupons_store
  ON merchant_coupons(store_id, active);

-- What a coupon did to an order, on the order itself — so a receipt can
-- explain its own total forever, even if the coupon row is later deactivated.
ALTER TABLE orders ADD COLUMN coupon_code TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN coupon_discount_iqd INTEGER NOT NULL DEFAULT 0;
