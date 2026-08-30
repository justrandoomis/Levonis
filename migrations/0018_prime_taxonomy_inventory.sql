-- Levonis migration 0018 — LEVO PRIME membership, database-managed taxonomy
-- and facets, relational options/colors/images, and explicit inventory modes
-- (product-form mandate §4–§11).
--
-- SAFETY CONTRACT
-- ---------------
--   * ADDITIVE. No product, order, wallet, coupon or points row is deleted,
--     rewritten or recomputed. products.options / products.colors / images
--     JSON columns are LEFT IN PLACE and keep working: the new relational
--     tables are populated by an explicit, reviewable backfill (0019) and by
--     the admin write path, never by silently dropping the old data.
--   * Two tables ARE rebuilt — membership_plans and memberships — because
--     SQLite cannot widen a CHECK constraint in place and both carry
--     CHECK (tier IN ('plus','pro')), which makes a 'prime' row impossible to
--     insert. The rebuild is contained: membership_plans is referenced by
--     exactly one foreign key (memberships.plan_id) and NOTHING references
--     memberships(id). Every row is copied verbatim.
--   * users.subscription_plan carries the same kind of CHECK, but `users` is
--     referenced by 60 foreign keys across 17 migrations, so rebuilding it is
--     not a proportionate risk for a column the code itself documents as a
--     legacy cache ("Keep the legacy users.* cache in sync"). Instead this
--     migration adds users.membership_tier — an unconstrained cache column
--     validated by the write path — and the worker moves every reader onto
--     it. subscription_plan keeps being maintained for its legal domain
--     ('free','plus','pro'); a PRIME member reads 'free' there, which is why
--     nothing may read it any more. It is dropped in a later, separate
--     migration once no code path references it.

PRAGMA defer_foreign_keys = TRUE;

-- ============================================================ 1. LEVO PRIME
--
-- §5: "اشتراك سنوي فقط بسعر 99,000 د.ع" — an annual-only plan at 99,000 IQD.
-- PRIME grants NO other PRO benefit automatically; its only order-level
-- entitlement is the conditional delivery waiver (worker/lib/shipping.ts),
-- and its discounts are per-product prime_price_iqd values.

-- ORDER MATTERS. SQLite's DEFERRED foreign-key counter is incremented by the
-- implicit DELETE that DROP TABLE performs on a parent with live children,
-- and re-creating the parent afterwards does NOT decrement it again — the
-- commit then fails with FOREIGN KEY constraint failed. So the child rows are
-- parked in a constraint-free staging table and the child table is dropped
-- FIRST; membership_plans is then rebuilt with no children in existence, and
-- the child is re-created and refilled last. Net effect on data: zero.
CREATE TABLE _mig18_memberships (
  id TEXT, user_id TEXT, plan_id TEXT, tier TEXT, state TEXT,
  duration_months INTEGER, price_paid_iqd INTEGER, purchased_at TEXT,
  starts_at TEXT, expires_at TEXT, source TEXT, source_ref TEXT,
  wallet_tx_id TEXT, created_at TEXT
);
INSERT INTO _mig18_memberships
  SELECT id, user_id, plan_id, tier, state, duration_months, price_paid_iqd,
         purchased_at, starts_at, expires_at, source, source_ref, wallet_tx_id, created_at
    FROM memberships;
DROP TABLE memberships;

CREATE TABLE membership_plans_new (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('plus','pro','prime')),
  duration_months INTEGER NOT NULL CHECK (duration_months > 0),
  price_iqd INTEGER CHECK (price_iqd IS NULL OR price_iqd >= 0), -- NULL = unpriced: NOT purchasable
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO membership_plans_new (id, tier, duration_months, price_iqd, active, sort, created_at)
  SELECT id, tier, duration_months, price_iqd, active, sort, created_at FROM membership_plans;
DROP TABLE membership_plans;
ALTER TABLE membership_plans_new RENAME TO membership_plans;

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES membership_plans(id),
  tier TEXT NOT NULL CHECK (tier IN ('plus','pro','prime')),
  state TEXT NOT NULL CHECK (state IN
    ('pending_payment','prepaid_pending_launch','active','expired','cancelled')),
  duration_months INTEGER NOT NULL,
  price_paid_iqd INTEGER NOT NULL DEFAULT 0,
  purchased_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  starts_at TEXT,
  expires_at TEXT,
  source TEXT NOT NULL DEFAULT 'purchase' CHECK (source IN ('purchase','gift_printer','admin','migrated')),
  source_ref TEXT NOT NULL DEFAULT '',
  wallet_tx_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd,
                         purchased_at, starts_at, expires_at, source, source_ref, wallet_tx_id, created_at)
  SELECT id, user_id, plan_id, tier, state, duration_months, price_paid_iqd,
         purchased_at, starts_at, expires_at, source, source_ref, wallet_tx_id, created_at
    FROM _mig18_memberships;
DROP TABLE _mig18_memberships;
CREATE INDEX idx_memberships_user ON memberships(user_id, state);
CREATE UNIQUE INDEX idx_memberships_gift_source ON memberships(source, source_ref)
  WHERE source = 'gift_printer';

INSERT OR IGNORE INTO membership_plans (id, tier, duration_months, price_iqd, active, sort)
  VALUES ('prime_12mo', 'prime', 12, 99000, 1, 4);

-- Unconstrained tier cache (see the safety contract above). Backfilled from
-- the legacy column so no existing user changes tier.
ALTER TABLE users ADD COLUMN membership_tier TEXT NOT NULL DEFAULT 'free';
UPDATE users SET membership_tier = subscription_plan;

-- ==================================================== 2. taxonomy + facets
--
-- §9: the category tree is DB-managed with parent_id / slug / sort / status /
-- template_family, and admins add branches without a code change. Facets are
-- a SEPARATE axis from the tree (§9: "أضف الفلاتر/Facets بصورة منفصلة عن
-- الأقسام") and are never mixed into it.

-- 'devices' | 'materials' | NULL = inherit from the nearest ancestor that
-- sets one. Drives which import template and which spec fields the admin
-- product form renders (§10).
ALTER TABLE catalogs ADD COLUMN template_family TEXT;

CREATE TABLE IF NOT EXISTS facets (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES facets(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  name_ckb TEXT NOT NULL DEFAULT '',
  -- grouping axis, admin-extensible; NOT a fixed enum in the UI
  kind TEXT NOT NULL DEFAULT 'tag',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_facets_kind ON facets(kind, sort);

CREATE TABLE IF NOT EXISTS product_facets (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  facet_id TEXT NOT NULL REFERENCES facets(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, facet_id)
);
CREATE INDEX IF NOT EXISTS idx_product_facets_facet ON product_facets(facet_id);

-- ============================================== 3. product-level additions
--
-- Each is nullable or defaulted, so every existing row stays valid and no
-- backfill can change how an existing product prices or sells.

-- §5: optional PRIME price; NULL falls back to regular (never a fabricated
-- discount). Ordering PRO <= PRIME <= Regular is enforced by the write path.
ALTER TABLE products ADD COLUMN prime_price_iqd INTEGER;

-- §6: a product may support several sale types at once. JSON array of
-- 'direct_sale' | 'pre_order' | 'bundle'. The scalar selling_type column is
-- KEPT and kept in sync (first entry) so every existing reader — pricing,
-- cart, checkout, invoices — keeps working untouched during the rollout.
ALTER TABLE products ADD COLUMN sale_types TEXT NOT NULL DEFAULT '[]';
UPDATE products SET sale_types = json_array(selling_type) WHERE sale_types = '[]';

-- §7: ONE authoritative stock source per SKU, chosen explicitly. Existing
-- products keep base stock semantics, which is exactly what they have today.
ALTER TABLE products ADD COLUMN inventory_mode TEXT NOT NULL DEFAULT 'BASE';

-- Reservation counter for the BASE mode. available = stock - stock_reserved.
ALTER TABLE products ADD COLUMN stock_reserved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER;

-- §4: the main section and its sub-section are real relations into the
-- catalogs tree, not the legacy free-text subcategory_id (which stays for
-- backwards compatibility and is no longer written by the new form).
ALTER TABLE products ADD COLUMN category_id TEXT REFERENCES catalogs(id);
ALTER TABLE products ADD COLUMN sub_category_id TEXT REFERENCES catalogs(id);
ALTER TABLE products ADD COLUMN template_family TEXT;

-- §4: optional-or-generated SKU. No UNIQUE index here: existing rows all
-- carry NULL and the import path (§10) enforces uniqueness among non-null
-- values via the partial index below.
ALTER TABLE products ADD COLUMN sku TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON products(sku) WHERE sku IS NOT NULL AND sku <> '';

-- §10: template-driven spec values, keyed by the field ids the section's
-- template declares. JSON object {field_id: value}.
ALTER TABLE products ADD COLUMN spec_fields TEXT NOT NULL DEFAULT '{}';

-- ================================== 4. option groups, values, colors, links
--
-- §7: unlimited option groups, each with many values; colors linked to option
-- values through a real many-to-many relation ("ولا تخزن IDs كسلسلة نصية").

CREATE TABLE IF NOT EXISTS product_option_groups (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name_en TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_option_groups_product ON product_option_groups(product_id, sort);

CREATE TABLE IF NOT EXISTS product_option_values (
  id TEXT PRIMARY KEY,
  -- denormalized product_id so visibility/stock queries never need the join
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES product_option_groups(id) ON DELETE CASCADE,
  name_en TEXT NOT NULL,
  sku_part TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  -- NULL = this level does not track stock (inventory_mode decides who does)
  stock INTEGER CHECK (stock IS NULL OR stock >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  low_stock_threshold INTEGER,
  -- NULL on any price = inherit the product-level value for THAT field only
  regular_price_iqd INTEGER CHECK (regular_price_iqd IS NULL OR regular_price_iqd >= 0),
  prime_price_iqd INTEGER CHECK (prime_price_iqd IS NULL OR prime_price_iqd >= 0),
  pro_price_iqd INTEGER CHECK (pro_price_iqd IS NULL OR pro_price_iqd >= 0),
  cost_iqd INTEGER CHECK (cost_iqd IS NULL OR cost_iqd >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_option_values_group ON product_option_values(group_id, sort);
CREATE INDEX IF NOT EXISTS idx_option_values_product ON product_option_values(product_id);

CREATE TABLE IF NOT EXISTS product_colors (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name_en TEXT NOT NULL,
  hex TEXT NOT NULL,                       -- validated #RRGGBB server-side
  image TEXT NOT NULL DEFAULT '',
  sku_part TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  stock INTEGER CHECK (stock IS NULL OR stock >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  low_stock_threshold INTEGER,
  regular_price_iqd INTEGER CHECK (regular_price_iqd IS NULL OR regular_price_iqd >= 0),
  prime_price_iqd INTEGER CHECK (prime_price_iqd IS NULL OR prime_price_iqd >= 0),
  pro_price_iqd INTEGER CHECK (pro_price_iqd IS NULL OR pro_price_iqd >= 0),
  cost_iqd INTEGER CHECK (cost_iqd IS NULL OR cost_iqd >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_product_colors_product ON product_colors(product_id, sort);

-- §7 visibility algebra, stored as data rather than as code:
--   * a color with NO row here is visible with every compatible selection;
--   * a color WITH rows is visible only when, FOR EVERY option group it links
--     into, the buyer's selection in that group is one of the linked values.
--   => OR inside a group, AND across groups. group_id is denormalized so the
--      grouping is a single indexed read.
CREATE TABLE IF NOT EXISTS product_color_option_links (
  color_id TEXT NOT NULL REFERENCES product_colors(id) ON DELETE CASCADE,
  option_value_id TEXT NOT NULL REFERENCES product_option_values(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES product_option_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (color_id, option_value_id)
);
CREATE INDEX IF NOT EXISTS idx_color_links_color_group ON product_color_option_links(color_id, group_id);
CREATE INDEX IF NOT EXISTS idx_color_links_value ON product_color_option_links(option_value_id);

-- §7: VARIANT_COMBINATION stock has the highest priority when a concrete
-- option(s)+color combination exists. combo_key is the canonical, sorted
-- encoding of that combination, computed server-side only.
CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key TEXT NOT NULL,
  sku TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  stock INTEGER CHECK (stock IS NULL OR stock >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  low_stock_threshold INTEGER,
  regular_price_iqd INTEGER CHECK (regular_price_iqd IS NULL OR regular_price_iqd >= 0),
  prime_price_iqd INTEGER CHECK (prime_price_iqd IS NULL OR prime_price_iqd >= 0),
  pro_price_iqd INTEGER CHECK (pro_price_iqd IS NULL OR pro_price_iqd >= 0),
  cost_iqd INTEGER CHECK (cost_iqd IS NULL OR cost_iqd >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (product_id, combo_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_sku ON product_variants(sku)
  WHERE sku IS NOT NULL AND sku <> '';

-- =========================================================== 5. images (§8)
CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL,                       -- R2 /files/<key> or an absolute media URL
  alt_en TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  -- an image may be bound to at most one selector; enforced by the write path
  option_value_id TEXT REFERENCES product_option_values(id) ON DELETE SET NULL,
  color_id TEXT REFERENCES product_colors(id) ON DELETE SET NULL,
  variant_id TEXT REFERENCES product_variants(id) ON DELETE SET NULL,
  width INTEGER,
  height INTEGER,
  bytes INTEGER,
  content_type TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, sort_order);
-- "يمكن تعيين صورة رئيسية واحدة فقط" — enforced by the database, not by hope.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_images_primary ON product_images(product_id)
  WHERE is_primary = 1;

-- ============================================= 6. inventory ledger (§7, §11)
--
-- Reserve on order creation, deduct on confirmation, restore on cancellation.
-- UNIQUE(idempotency_key) is what makes a retried request or a duplicated
-- webhook a no-op instead of a second deduction.
CREATE TABLE IF NOT EXISTS inventory_ledger (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('base','option','color','variant')),
  scope_id TEXT NOT NULL DEFAULT '',       -- '' for base
  kind TEXT NOT NULL CHECK (kind IN ('reserve','release','deduct','restore','adjust')),
  qty INTEGER NOT NULL CHECK (qty > 0),    -- magnitude; direction comes from kind
  order_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_user_id TEXT REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_product ON inventory_ledger(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_order ON inventory_ledger(order_id);

-- ================================== 7. local deterministic translations (§3)
--
-- English is the ONLY visible input. ar/ckb are produced by the local
-- deterministic engine (worker/lib/translate.ts) — no network call, no AI.
-- A segment the engine cannot translate safely keeps its English text and is
-- flagged review_needed; it never blocks saving and is never invented.
CREATE TABLE IF NOT EXISTS product_translations (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  field TEXT NOT NULL,                     -- 'description' | 'how_to_use' | 'spec:<id>' | 'label:<i>' ...
  source_en TEXT NOT NULL,
  source_hash TEXT NOT NULL,               -- lets a re-save skip unchanged text
  text_ar TEXT NOT NULL DEFAULT '',
  text_ckb TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'machine' CHECK (status IN ('machine','review_needed','approved')),
  translation_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (product_id, field)
);
CREATE INDEX IF NOT EXISTS idx_product_translations_status ON product_translations(status);

-- ==================================================== 8. import runs (§10)
CREATE TABLE IF NOT EXISTS product_imports (
  id TEXT PRIMARY KEY,                     -- the import_id echoed by preview + confirm
  actor_user_id TEXT REFERENCES users(id),
  template_family TEXT NOT NULL,
  category_id TEXT REFERENCES catalogs(id),
  sub_category_id TEXT REFERENCES catalogs(id),
  state TEXT NOT NULL DEFAULT 'preview' CHECK (state IN ('preview','applied','failed')),
  payload_hash TEXT NOT NULL DEFAULT '',   -- confirm must match the previewed payload
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  report TEXT NOT NULL DEFAULT '[]',       -- JSON rows: {row, action, sku, reason}
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_product_imports_created ON product_imports(created_at DESC);

-- =========================================== 9. seed taxonomy + facets (§9)
--
-- Seed data only: every row is editable, deactivatable and extendable from
-- the admin panel, and nothing in the code matches on these slugs.
-- Seeded ONE STATEMENT PER NODE, on purpose. `catalogs.slug` is UNIQUE and a
-- live store may already own a slug (the dev database really does own
-- 'printers'). A single multi-row INSERT OR IGNORE would silently drop the
-- parent and then fail the FOREIGN KEY of every child pointing at it, so each
-- node is:
--   * guarded on its stable seed ID, which makes re-running a no-op;
--   * given the first slug still free, so an existing catalog is never
--     renamed, merged into, or shadowed.
-- Nothing in the worker matches on these slugs or ids; they are ordinary
-- editable rows.
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_printers', NULL,
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'printers') THEN 'printers'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'printers-levo') THEN 'printers-levo'
            ELSE 'cat_printers' END,
         'الطابعات', 'Printers', 'چاپکەرەکان', 10, 1, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_printers');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_printers_fdm', 'cat_printers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'fdm-printers') THEN 'fdm-printers'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'fdm-printers-levo') THEN 'fdm-printers-levo'
            ELSE 'cat_printers_fdm' END,
         'طابعات FDM', 'FDM Printers', 'چاپکەری FDM', 11, 1, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_printers_fdm');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_printers_resin', 'cat_printers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'resin-printers') THEN 'resin-printers'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'resin-printers-levo') THEN 'resin-printers-levo'
            ELSE 'cat_printers_resin' END,
         'طابعات Resin', 'Resin Printers', 'چاپکەری Resin', 12, 1, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_printers_resin');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_pacc', NULL,
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'printer-accessories') THEN 'printer-accessories'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'printer-accessories-levo') THEN 'printer-accessories-levo'
            ELSE 'cat_pacc' END,
         'ملحقات الطابعات', 'Printer Accessories', 'پێداویستی چاپکەر', 20, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_pacc');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_pacc_fdm', 'cat_pacc',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'fdm-printer-accessories') THEN 'fdm-printer-accessories'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'fdm-printer-accessories-levo') THEN 'fdm-printer-accessories-levo'
            ELSE 'cat_pacc_fdm' END,
         'ملحقات طابعات FDM', 'FDM Printer Accessories', 'پێداویستی FDM', 21, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_pacc_fdm');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_pacc_resin', 'cat_pacc',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'resin-printer-accessories') THEN 'resin-printer-accessories'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'resin-printer-accessories-levo') THEN 'resin-printer-accessories-levo'
            ELSE 'cat_pacc_resin' END,
         'ملحقات طابعات Resin', 'Resin Printer Accessories', 'پێداویستی Resin', 22, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_pacc_resin');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_materials', NULL,
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'printing-materials') THEN 'printing-materials'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'printing-materials-levo') THEN 'printing-materials-levo'
            ELSE 'cat_materials' END,
         'مواد الطباعة', 'Printing Materials', 'کەرەستەی چاپ', 30, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_materials');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_materials_fdm', 'cat_materials',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'fdm-materials') THEN 'fdm-materials'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'fdm-materials-levo') THEN 'fdm-materials-levo'
            ELSE 'cat_materials_fdm' END,
         'مواد FDM', 'FDM Materials / Filaments', 'کەرەستەی FDM', 31, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_materials_fdm');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_materials_resin', 'cat_materials',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'resin-materials') THEN 'resin-materials'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'resin-materials-levo') THEN 'resin-materials-levo'
            ELSE 'cat_materials_resin' END,
         'مواد Resin', 'Resin Materials', 'کەرەستەی Resin', 32, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_materials_resin');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_accessories', NULL,
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'accessories') THEN 'accessories'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'accessories-levo') THEN 'accessories-levo'
            ELSE 'cat_accessories' END,
         'الإكسسوارات', 'Accessories', 'ئێکسسوار', 40, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_accessories');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers', NULL,
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'makers-supply') THEN 'makers-supply'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'makers-supply-levo') THEN 'makers-supply-levo'
            ELSE 'cat_makers' END,
         'مواد MakerWorld', 'Maker''s Supply', 'کەرەستەی Maker', 50, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers_new', 'cat_makers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'new-products') THEN 'new-products'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'new-products-levo') THEN 'new-products-levo'
            ELSE 'cat_makers_new' END,
         'منتجات جديدة', 'New Products', 'بەرهەمی نوێ', 51, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers_new');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers_kits', 'cat_makers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'model-kits') THEN 'model-kits'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'model-kits-levo') THEN 'model-kits-levo'
            ELSE 'cat_makers_kits' END,
         'أطقم المجسمات', 'Model Kits', 'کیتی مۆدێل', 52, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers_kits');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers_cyber', 'cat_makers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'cyberbrick-rc') THEN 'cyberbrick-rc'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'cyberbrick-rc-levo') THEN 'cyberbrick-rc-levo'
            ELSE 'cat_makers_cyber' END,
         'CyberBrick RC', 'CyberBrick RC', 'CyberBrick RC', 53, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers_cyber');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers_tools', 'cat_makers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'maker-tools') THEN 'maker-tools'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'maker-tools-levo') THEN 'maker-tools-levo'
            ELSE 'cat_makers_tools' END,
         'أدوات Maker', 'Maker Tools', 'ئامرازی Maker', 54, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers_tools');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers_parts', 'cat_makers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'parts-components') THEN 'parts-components'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'parts-components-levo') THEN 'parts-components-levo'
            ELSE 'cat_makers_parts' END,
         'قطع ومكونات', 'Parts & Components', 'پارچە و پێکهاتە', 55, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers_parts');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers_lab', 'cat_makers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'makerlab-accessories') THEN 'makerlab-accessories'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'makerlab-accessories-levo') THEN 'makerlab-accessories-levo'
            ELSE 'cat_makers_lab' END,
         'ملحقات MakerLab', 'MakerLab Accessories', 'پێداویستی MakerLab', 56, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers_lab');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers_premium', 'cat_makers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'premium-model-kits') THEN 'premium-model-kits'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'premium-model-kits-levo') THEN 'premium-model-kits-levo'
            ELSE 'cat_makers_premium' END,
         'أطقم مميزة', 'Premium Model Kits', 'کیتی تایبەت', 57, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers_premium');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers_hw', 'cat_makers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'hardware-parts') THEN 'hardware-parts'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'hardware-parts-levo') THEN 'hardware-parts-levo'
            ELSE 'cat_makers_hw' END,
         'قطع هاردوير', 'Hardware Parts', 'پارچەی هاردوێر', 58, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers_hw');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers_elec', 'cat_makers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'electronics') THEN 'electronics'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'electronics-levo') THEN 'electronics-levo'
            ELSE 'cat_makers_elec' END,
         'إلكترونيات', 'Electronics', 'ئەلیکترۆنیات', 59, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers_elec');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers_other', 'cat_makers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'others') THEN 'others'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'others-levo') THEN 'others-levo'
            ELSE 'cat_makers_other' END,
         'أخرى', 'Others', 'ئەوانی تر', 60, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers_other');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_makers_combo', 'cat_makers',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'maker-combo-kits') THEN 'maker-combo-kits'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'maker-combo-kits-levo') THEN 'maker-combo-kits-levo'
            ELSE 'cat_makers_combo' END,
         'باقات Maker', 'Maker Combo Kits', 'کۆمبۆی Maker', 61, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_makers_combo');

INSERT OR IGNORE INTO facets (id, parent_id, slug, name_en, name_ar, name_ckb, kind, sort) VALUES
  ('fct_offer_special', NULL, 'special-offer', 'Special Offer', 'عرض خاص',      'ئۆفەری تایبەت', 'offer', 1),
  ('fct_offer_bundle',  NULL, 'bundle',        'Bundle',        'باقة',         'کۆمبۆ',         'offer', 2),
  ('fct_offer_new',     NULL, 'new-arrival',   'New Arrival',   'وصل حديثًا',   'نوێ گەیشتوو',   'offer', 3),
  ('fct_offer_kit',     NULL, 'model-kit',     'Model Kit',     'طقم مجسم',     'کیتی مۆدێل',    'offer', 4),
  ('fct_mat_wood',      NULL, 'wood-bamboo',   'Wood & Bamboo', 'خشب وخيزران',  'دار و بامبۆ',   'material_type', 10),
  ('fct_mat_pu',        NULL, 'pu',            'PU',            'PU',           'PU',            'material_type', 11),
  ('fct_mat_acrylic',   NULL, 'acrylic',       'Acrylic',       'أكريليك',      'ئاکریلیک',      'material_type', 12),
  ('fct_mat_metal',     NULL, 'metal',         'Metal',         'معدن',         'کانزا',         'material_type', 13),
  ('fct_mat_paper',     NULL, 'paper',         'Paper',         'ورق',          'کاغەز',         'material_type', 14),
  ('fct_mat_vinyl',     NULL, 'sticker-vinyl', 'Sticker & Vinyl','ملصقات وفينيل','ستیکەر و ڤاینل','material_type', 15),
  ('fct_mat_misc',      NULL, 'miscellaneous', 'Miscellaneous', 'متنوع',        'جۆراوجۆر',      'material_type', 16),
  ('fct_mat_aux',       NULL, 'auxiliary-materials', 'Auxiliary Materials', 'مواد مساعدة', 'کەرەستەی یاریدەدەر', 'material_type', 17),
  ('fct_proc_laser',    NULL, 'laser-material', 'Laser Material', 'مادة ليزر',  'کەرەستەی لەیزەر','processing_mode', 20),
  ('fct_proc_blade',    NULL, 'blade-cutting-material', 'Blade Cutting Material', 'مادة قص بشفرة', 'کەرەستەی بڕین', 'processing_mode', 21),
  ('fct_fdm_pla',       NULL, 'pla',   'PLA',   'PLA',   'PLA',   'fdm_material', 30),
  ('fct_fdm_petg',      NULL, 'petg',  'PETG',  'PETG',  'PETG',  'fdm_material', 31),
  ('fct_fdm_absasa',    NULL, 'abs-asa','ABS/ASA','ABS/ASA','ABS/ASA','fdm_material', 32),
  ('fct_fdm_tpu',       NULL, 'tpu',   'TPU',   'TPU',   'TPU',   'fdm_material', 33),
  ('fct_fdm_pc',        NULL, 'pc',    'PC',    'PC',    'PC',    'fdm_material', 34),
  ('fct_fdm_papet',     NULL, 'pa-pet','PA/PET','PA/PET','PA/PET','fdm_material', 35),
  ('fct_fdm_pps',       NULL, 'pps',   'PPS',   'PPS',   'PPS',   'fdm_material', 36),
  ('fct_fdm_fiber',     NULL, 'fiber-reinforced', 'Fiber Reinforced', 'مقوى بالألياف', 'بەهێزکراو بە فایبەر', 'fdm_material', 37),
  ('fct_fdm_support',   NULL, 'support', 'Support', 'دعامات', 'پاڵپشت', 'fdm_material', 38),
  ('fct_fdm_acc',       NULL, 'filament-accessories', 'Filament Accessories', 'ملحقات الفلامنت', 'پێداویستی فیلامێنت', 'fdm_material', 39);
