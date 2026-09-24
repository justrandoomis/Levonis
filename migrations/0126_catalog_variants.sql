-- ============================================================================
--  0126 — THE MERCHANT CATALOGUE: A LIFECYCLE THE DATABASE CHECKS, REAL
--         VARIANTS, MEDIA WITH VIDEO, 3D-PRINTING ATTRIBUTES, AND COLLECTIONS.
-- ============================================================================
-- Merchant platform wave 2, stream W2-F (docs/MERCHANT_PLATFORM.md §2 decision
-- 8, audit 01 §1.2 and §5). The model's rules live in packages/catalog; this
-- migration gives them columns, tables, constraints and triggers.
--
-- NONDESTRUCTIVE. ADD COLUMNs (every one nullable or defaulted, every CHECK
-- satisfied by the default), new tables and indexes IF NOT EXISTS, and
-- triggers IF NOT EXISTS. Nothing is dropped, no table is rebuilt, no row is
-- written here — the backfill of existing rows is 0127.
--
-- ---------------------------------------------------------------------------
--  1. THE LIFECYCLE IS A CHECKED COLUMN — `publish_state`
-- ---------------------------------------------------------------------------
-- draft | published | hidden | archived. SOLD OUT IS NOT A STATE: it is
-- derived from stock (a published product that tracks stock and has none
-- left). LEVONIS'S HIDE IS NOT A STATE: it stays its own column
-- (`admin_hidden_at`, 0118) that no merchant write can clear.
--
-- `lifecycle` (0030, free text) and `status` (0001, active|hidden) are what
-- every reader written before this migration asks — `lifecycle = 'active' AND
-- status = 'active'` is "on the storefront" in eleven files. They become
-- MIRRORS the database keeps in step (triggers below), so no reader changes
-- and no writer can make them disagree:
--   lifecycle = publish_state, spelled 'active' for 'published';
--   status    = 'active' only while published AND not hidden by Levonis.
-- A row inserted without `publish_state` (a writer that predates it) takes it
-- from its legacy `lifecycle`; a legacy write of `lifecycle` moves the state
-- with it. The column is nullable only because ADD COLUMN cannot declare NOT
-- NULL without a default, and a default would silently re-classify every such
-- insert; the insert trigger fills it and an update can never empty it.
ALTER TABLE community_products ADD COLUMN publish_state TEXT
  CHECK (publish_state IS NULL OR publish_state IN ('draft','published','hidden','archived'));

-- How the product is sold:
--   simple    one price, one stock (the product row)
--   variants  option groups + variants below; the product's `stock` is the
--             SUM of its active variants' stock (triggers), so every reader of
--             `stock` — cards, filters, the checkout's product fence — stays true
--   legacy    carries pre-0126 `options`/`colors` JSON not (yet) on the variant
--             model: sold exactly as before (ids checked against the JSON, the
--             product's price and stock). `legacy_variant_note` is NULL until
--             the converter (worker/lib/catalog/legacy.ts) examined it, then why
--             it stays legacy.
ALTER TABLE community_products ADD COLUMN variant_mode TEXT NOT NULL DEFAULT 'simple'
  CHECK (variant_mode IN ('simple','variants','legacy'));
ALTER TABLE community_products ADD COLUMN legacy_variant_note TEXT;

-- Low stock: the merchant's line (NULL = no alert) and when the alert for the
-- current dip was sent (cleared when stock rises above the line again).
ALTER TABLE community_products ADD COLUMN low_stock_threshold INTEGER
  CHECK (low_stock_threshold IS NULL OR low_stock_threshold BETWEEN 0 AND 1000000);
ALTER TABLE community_products ADD COLUMN low_stock_alerted_at TEXT;

-- ---------------------------------------------------------------------------
--  2. 3D-PRINTING ATTRIBUTES — typed columns, not free JSON
-- ---------------------------------------------------------------------------
-- material     an id of the platform's print-material list (admin setting
--              `printMaterials`, checked by the Worker on write)
-- print_technology, finish, color   closed vocabularies (packages/catalog)
-- dim_*_mm     the printed part's bounding box, millimetres
-- weight_g     grams
ALTER TABLE community_products ADD COLUMN material TEXT
  CHECK (material IS NULL OR (length(material) BETWEEN 1 AND 40));
ALTER TABLE community_products ADD COLUMN print_technology TEXT
  CHECK (print_technology IS NULL OR print_technology IN ('fdm','resin','sls','laser','other'));
ALTER TABLE community_products ADD COLUMN color TEXT
  CHECK (color IS NULL OR color IN ('black','white','gray','silver','red','orange','yellow','green','teal','blue','navy',
                                    'purple','pink','brown','beige','gold','bronze','wood','marble','clear','glow','multi'));
ALTER TABLE community_products ADD COLUMN finish TEXT
  CHECK (finish IS NULL OR finish IN ('raw','sanded','primed','painted','polished','coated'));
ALTER TABLE community_products ADD COLUMN dim_x_mm REAL CHECK (dim_x_mm IS NULL OR (dim_x_mm > 0 AND dim_x_mm <= 5000));
ALTER TABLE community_products ADD COLUMN dim_y_mm REAL CHECK (dim_y_mm IS NULL OR (dim_y_mm > 0 AND dim_y_mm <= 5000));
ALTER TABLE community_products ADD COLUMN dim_z_mm REAL CHECK (dim_z_mm IS NULL OR (dim_z_mm > 0 AND dim_z_mm <= 5000));
ALTER TABLE community_products ADD COLUMN weight_g INTEGER CHECK (weight_g IS NULL OR weight_g BETWEEN 1 AND 1000000);

CREATE INDEX IF NOT EXISTS idx_community_products_state ON community_products(merchant_id, publish_state);

-- ---------------------------------------------------------------------------
--  3. OPTION GROUPS, VALUES AND VARIANTS
-- ---------------------------------------------------------------------------
-- At most 3 groups (position 0..2) and 30 values per group are the model's
-- caps (packages/catalog/src/variants.ts), enforced where the rows are
-- written; the database holds what cannot be left to a writer.
CREATE TABLE IF NOT EXISTS community_product_options (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES community_products(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  name_ar TEXT NOT NULL DEFAULT '' CHECK (length(name_ar) <= 60),
  kind TEXT NOT NULL DEFAULT 'choice' CHECK (kind IN ('choice','color')),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 2),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_product_options_product ON community_product_options(product_id, position);

-- `swatch` is a palette NAME (never CSS); `legacy_ref` is the pre-0126 entry
-- id a cart line named, kept so a line added before the conversion still
-- resolves to the value it chose.
CREATE TABLE IF NOT EXISTS community_product_option_values (
  id TEXT PRIMARY KEY NOT NULL,
  option_id TEXT NOT NULL REFERENCES community_product_options(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES community_products(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  name_ar TEXT NOT NULL DEFAULT '' CHECK (length(name_ar) <= 60),
  swatch TEXT NOT NULL DEFAULT '' CHECK (swatch = '' OR swatch IN ('black','white','gray','silver','red','orange','yellow','green',
                                   'teal','blue','navy','purple','pink','brown','beige','gold','bronze','wood','marble','clear','glow','multi')),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  legacy_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_product_option_values_option ON community_product_option_values(option_id, position);
CREATE INDEX IF NOT EXISTS idx_product_option_values_product ON community_product_option_values(product_id);

-- A variant is ONE value of each group (value1 = group 0 …). Deleting a value
-- deletes the variants built on it (CASCADE); a variant's values must belong
-- to its own product (trigger below). The combination is UNIQUE per product.
--   price_iqd        NULL = the product's price; an integer = this variant's
--   compare_at_iqd   the struck-through "was" price, shown only when higher
--   stock            moves on EVERY order line, tracked or not — symmetric with
--                    the cancel trigger, the rule 0030's product stock follows
CREATE TABLE IF NOT EXISTS community_product_variants (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES community_products(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  value1_id TEXT NOT NULL REFERENCES community_product_option_values(id) ON DELETE CASCADE,
  value2_id TEXT REFERENCES community_product_option_values(id) ON DELETE CASCADE,
  value3_id TEXT REFERENCES community_product_option_values(id) ON DELETE CASCADE,
  price_iqd INTEGER CHECK (price_iqd IS NULL OR price_iqd BETWEEN 0 AND 1000000000),
  compare_at_iqd INTEGER CHECK (compare_at_iqd IS NULL OR compare_at_iqd BETWEEN 0 AND 1000000000),
  stock INTEGER NOT NULL DEFAULT 0,
  sku TEXT NOT NULL DEFAULT '' CHECK (length(sku) <= 64),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  image_key TEXT CHECK (image_key IS NULL OR image_key GLOB 'merchants/*' OR image_key GLOB 'community/*'),
  low_stock_threshold INTEGER CHECK (low_stock_threshold IS NULL OR low_stock_threshold BETWEEN 0 AND 1000000),
  low_stock_alerted_at TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (value3_id IS NULL OR value2_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_product_variant_combo
  ON community_product_variants(product_id, value1_id, IFNULL(value2_id, ''), IFNULL(value3_id, ''));
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON community_product_variants(product_id, position);

CREATE TRIGGER IF NOT EXISTS trg_product_variant_values_own_insert
BEFORE INSERT ON community_product_variants
FOR EACH ROW
WHEN (SELECT product_id FROM community_product_option_values WHERE id = NEW.value1_id) IS NOT NEW.product_id
  OR (NEW.value2_id IS NOT NULL AND (SELECT product_id FROM community_product_option_values WHERE id = NEW.value2_id) IS NOT NEW.product_id)
  OR (NEW.value3_id IS NOT NULL AND (SELECT product_id FROM community_product_option_values WHERE id = NEW.value3_id) IS NOT NEW.product_id)
  OR (SELECT store_id FROM community_products WHERE id = NEW.product_id) IS NOT NEW.store_id
BEGIN
  SELECT RAISE(ABORT, 'VARIANT_VALUE_FOREIGN');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_variant_values_own_update
BEFORE UPDATE OF product_id, store_id, value1_id, value2_id, value3_id ON community_product_variants
FOR EACH ROW
WHEN (SELECT product_id FROM community_product_option_values WHERE id = NEW.value1_id) IS NOT NEW.product_id
  OR (NEW.value2_id IS NOT NULL AND (SELECT product_id FROM community_product_option_values WHERE id = NEW.value2_id) IS NOT NEW.product_id)
  OR (NEW.value3_id IS NOT NULL AND (SELECT product_id FROM community_product_option_values WHERE id = NEW.value3_id) IS NOT NEW.product_id)
  OR (SELECT store_id FROM community_products WHERE id = NEW.product_id) IS NOT NEW.store_id
BEGIN
  SELECT RAISE(ABORT, 'VARIANT_VALUE_FOREIGN');
END;

-- ---------------------------------------------------------------------------
--  4. PRODUCT MEDIA — pictures and video, ordered, with alt text
-- ---------------------------------------------------------------------------
-- `media_key` is a storage KEY the platform issued to the store's owner
-- (`merchants/<owner>/public/<id>.<ext>`, or the pre-ledger `community/…`
-- shape) — never a URL; the Worker checks the owner and, for a video, the
-- sniffed type in `file_objects`. `community_products.images` stays the JSON
-- mirror of the pictures, in order, for every reader that predates this table.
CREATE TABLE IF NOT EXISTS community_product_media (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES community_products(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  media_key TEXT NOT NULL CHECK (length(media_key) <= 200 AND (media_key GLOB 'merchants/*' OR media_key GLOB 'community/*')),
  alt TEXT NOT NULL DEFAULT '' CHECK (length(alt) <= 200),
  alt_ar TEXT NOT NULL DEFAULT '' CHECK (length(alt_ar) <= 200),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 11),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (product_id, media_key)
);
CREATE INDEX IF NOT EXISTS idx_product_media_product ON community_product_media(product_id, position);

-- ---------------------------------------------------------------------------
--  5. COLLECTIONS — the store's "sections" were always collections
-- ---------------------------------------------------------------------------
-- Decision (docs/DECISIONS.md, W2-F): `merchant_store_sections` IS the
-- collections table — same rows, same ids (the store builder's collection
-- blocks and links already name them) — exposed as «المجموعات» in the API and
-- the UI, which frees the word "section" for page layout.
--   manual        membership and ORDER chosen by the merchant
--                 (`merchant_collection_products`), a product in any number
--   featured      computed: the store's featured products
--   new_arrivals  computed: published in the last 30 days, newest first
--   best_sellers  computed: by units sold (cancellations already put back)
-- At most one computed collection of each kind per store.
ALTER TABLE merchant_store_sections ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'
  CHECK (kind IN ('manual','featured','new_arrivals','best_sellers'));
ALTER TABLE merchant_store_sections ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500);
ALTER TABLE merchant_store_sections ADD COLUMN description_ar TEXT NOT NULL DEFAULT '' CHECK (length(description_ar) <= 500);
ALTER TABLE merchant_store_sections ADD COLUMN image_key TEXT
  CHECK (image_key IS NULL OR image_key GLOB 'merchants/*' OR image_key GLOB 'community/*');
CREATE UNIQUE INDEX IF NOT EXISTS ux_store_computed_collection
  ON merchant_store_sections(store_id, kind) WHERE kind <> 'manual';

-- Manual membership, in the merchant's order (position ascending; a new member
-- is placed first, at MIN(position) - 1).
CREATE TABLE IF NOT EXISTS merchant_collection_products (
  collection_id TEXT NOT NULL REFERENCES merchant_store_sections(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES community_products(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (collection_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_products_order ON merchant_collection_products(collection_id, position);
CREATE INDEX IF NOT EXISTS idx_collection_products_product ON merchant_collection_products(product_id);

-- A membership joins a MANUAL collection and a product of the SAME store.
CREATE TRIGGER IF NOT EXISTS trg_collection_member_own
BEFORE INSERT ON merchant_collection_products
FOR EACH ROW
WHEN (SELECT store_id FROM merchant_store_sections WHERE id = NEW.collection_id) IS NOT NEW.store_id
  OR (SELECT store_id FROM community_products WHERE id = NEW.product_id) IS NOT NEW.store_id
  OR (SELECT kind FROM merchant_store_sections WHERE id = NEW.collection_id) IS NOT 'manual'
BEGIN
  SELECT RAISE(ABORT, 'COLLECTION_MEMBER_FOREIGN');
END;

-- `community_products.section_id` (0036, one collection per product) is kept
-- as it was for the writers that predate membership: setting it makes the
-- product a member; changing it moves the membership. New code writes
-- membership directly and never this column.
CREATE TRIGGER IF NOT EXISTS trg_product_section_member_insert
AFTER INSERT ON community_products
FOR EACH ROW
WHEN NEW.section_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO merchant_collection_products (collection_id, product_id, store_id, position)
  SELECT s.id, NEW.id, NEW.store_id,
         COALESCE((SELECT MIN(m.position) FROM merchant_collection_products m WHERE m.collection_id = s.id), 1) - 1
    FROM merchant_store_sections s
   WHERE s.id = NEW.section_id AND s.store_id = NEW.store_id AND s.kind = 'manual';
END;

CREATE TRIGGER IF NOT EXISTS trg_product_section_member_update
AFTER UPDATE OF section_id ON community_products
FOR EACH ROW
WHEN NEW.section_id IS NOT OLD.section_id
BEGIN
  DELETE FROM merchant_collection_products WHERE collection_id = OLD.section_id AND product_id = OLD.id;
  INSERT OR IGNORE INTO merchant_collection_products (collection_id, product_id, store_id, position)
  SELECT s.id, NEW.id, NEW.store_id,
         COALESCE((SELECT MIN(m.position) FROM merchant_collection_products m WHERE m.collection_id = s.id), 1) - 1
    FROM merchant_store_sections s
   WHERE s.id = NEW.section_id AND s.store_id = NEW.store_id AND s.kind = 'manual';
END;

-- ---------------------------------------------------------------------------
--  6. CART AND ORDER LINES NAME THE VARIANT
-- ---------------------------------------------------------------------------
-- A variant line also carries the variant id in `option_id`, because a
-- line's identity is (user, product, option_id, color_id) (0032's unique
-- index): two variants of one product are two lines, the same variant added
-- twice is one. The column is the reference; `option_id` is the identity.
ALTER TABLE cart_items ADD COLUMN variant_id TEXT REFERENCES community_product_variants(id) ON DELETE SET NULL;
-- History: no foreign key (the variant may be deleted; the line may not).
ALTER TABLE order_items ADD COLUMN variant_id TEXT;
ALTER TABLE order_items ADD COLUMN sku_snapshot TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_order_items_variant ON order_items(variant_id) WHERE variant_id IS NOT NULL;

-- ---------------------------------------------------------------------------
--  7. THE LIFECYCLE MIRRORS (section 1)
-- ---------------------------------------------------------------------------
-- Each trigger's own UPDATE is guarded by a WHEN that is false once the row is
-- consistent, so the chain ends whether or not recursive triggers are on.
CREATE TRIGGER IF NOT EXISTS trg_product_state_insert
AFTER INSERT ON community_products
FOR EACH ROW
BEGIN
  UPDATE community_products
     SET publish_state = CASE NEW.lifecycle WHEN 'active' THEN 'published' WHEN 'draft' THEN 'draft'
                                            WHEN 'archived' THEN 'archived' ELSE 'hidden' END
   WHERE id = NEW.id AND publish_state IS NULL;
  UPDATE community_products
     SET lifecycle = CASE publish_state WHEN 'published' THEN 'active' ELSE publish_state END,
         status = CASE WHEN publish_state = 'published' AND admin_hidden_at IS NULL THEN 'active' ELSE 'hidden' END
   WHERE id = NEW.id
     AND (lifecycle IS NOT (CASE publish_state WHEN 'published' THEN 'active' ELSE publish_state END)
          OR status IS NOT (CASE WHEN publish_state = 'published' AND admin_hidden_at IS NULL THEN 'active' ELSE 'hidden' END));
END;

CREATE TRIGGER IF NOT EXISTS trg_product_state_mirror
AFTER UPDATE OF publish_state, admin_hidden_at ON community_products
FOR EACH ROW
WHEN NEW.publish_state IS NOT NULL
BEGIN
  UPDATE community_products
     SET lifecycle = CASE publish_state WHEN 'published' THEN 'active' ELSE publish_state END,
         status = CASE WHEN publish_state = 'published' AND admin_hidden_at IS NULL THEN 'active' ELSE 'hidden' END
   WHERE id = NEW.id
     AND (lifecycle IS NOT (CASE publish_state WHEN 'published' THEN 'active' ELSE publish_state END)
          OR status IS NOT (CASE WHEN publish_state = 'published' AND admin_hidden_at IS NULL THEN 'active' ELSE 'hidden' END));
END;

-- A writer that still speaks `lifecycle` moves the state with it ('sold_out',
-- the old manual flag, reads as hidden — exactly what it did on the storefront).
CREATE TRIGGER IF NOT EXISTS trg_product_state_legacy
AFTER UPDATE OF lifecycle ON community_products
FOR EACH ROW
WHEN NEW.publish_state IS NOT NULL
 AND (CASE NEW.lifecycle WHEN 'active' THEN 'published' WHEN 'draft' THEN 'draft'
                         WHEN 'archived' THEN 'archived' ELSE 'hidden' END) IS NOT NEW.publish_state
BEGIN
  UPDATE community_products
     SET publish_state = CASE NEW.lifecycle WHEN 'active' THEN 'published' WHEN 'draft' THEN 'draft'
                                            WHEN 'archived' THEN 'archived' ELSE 'hidden' END
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_product_state_not_null
BEFORE UPDATE OF publish_state ON community_products
FOR EACH ROW
WHEN NEW.publish_state IS NULL AND OLD.publish_state IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_STATE_REQUIRED');
END;

-- ---------------------------------------------------------------------------
--  8. A VARIANT PRODUCT'S STOCK IS THE SUM OF ITS ACTIVE VARIANTS
-- ---------------------------------------------------------------------------
-- Whatever writes: a variant's own change recomputes its product, and a
-- direct write of a variant product's `stock` (the checkout's and the
-- cancellation's per-product statements, written before variants existed) is
-- put back to the sum. Negative variant stock (an untracked product's) counts
-- as zero.
CREATE TRIGGER IF NOT EXISTS trg_variant_stock_insert
AFTER INSERT ON community_product_variants
FOR EACH ROW
BEGIN
  UPDATE community_products
     SET stock = (SELECT COALESCE(SUM(CASE WHEN v.stock > 0 THEN v.stock ELSE 0 END), 0)
                    FROM community_product_variants v WHERE v.product_id = NEW.product_id AND v.active = 1)
   WHERE id = NEW.product_id AND variant_mode = 'variants';
END;

CREATE TRIGGER IF NOT EXISTS trg_variant_stock_update
AFTER UPDATE OF stock, active ON community_product_variants
FOR EACH ROW
BEGIN
  UPDATE community_products
     SET stock = (SELECT COALESCE(SUM(CASE WHEN v.stock > 0 THEN v.stock ELSE 0 END), 0)
                    FROM community_product_variants v WHERE v.product_id = NEW.product_id AND v.active = 1)
   WHERE id = NEW.product_id AND variant_mode = 'variants';
END;

CREATE TRIGGER IF NOT EXISTS trg_variant_stock_delete
AFTER DELETE ON community_product_variants
FOR EACH ROW
BEGIN
  UPDATE community_products
     SET stock = (SELECT COALESCE(SUM(CASE WHEN v.stock > 0 THEN v.stock ELSE 0 END), 0)
                    FROM community_product_variants v WHERE v.product_id = OLD.product_id AND v.active = 1)
   WHERE id = OLD.product_id AND variant_mode = 'variants';
END;

CREATE TRIGGER IF NOT EXISTS trg_variant_product_stock_heal
AFTER UPDATE OF stock, variant_mode ON community_products
FOR EACH ROW
WHEN NEW.variant_mode = 'variants'
 AND NEW.stock IS NOT (SELECT COALESCE(SUM(CASE WHEN v.stock > 0 THEN v.stock ELSE 0 END), 0)
                         FROM community_product_variants v WHERE v.product_id = NEW.id AND v.active = 1)
BEGIN
  UPDATE community_products
     SET stock = (SELECT COALESCE(SUM(CASE WHEN v.stock > 0 THEN v.stock ELSE 0 END), 0)
                    FROM community_product_variants v WHERE v.product_id = NEW.id AND v.active = 1)
   WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
--  9. A CANCELLED STORE ORDER PUTS ITS VARIANTS' UNITS BACK
-- ---------------------------------------------------------------------------
-- Every door that cancels a store order goes through one operation
-- (worker/lib/storeOrderOps.ts `cancelStoreOrder`), which restores the
-- PRODUCT's stock per line. The variant's units are restored here, on the
-- one fact every cancellation shares — the status flip into 'cancelled' — so
-- no door can forget them. It fires once: a store order that is cancelled
-- cannot be re-opened (409 STORE_ORDER_REOPEN_REFUSED), and the flip is
-- conditional on the status it came from. It rolls back with its batch.
CREATE TRIGGER IF NOT EXISTS trg_store_order_cancel_restocks_variants
AFTER UPDATE OF status ON orders
FOR EACH ROW
WHEN NEW.status = 'cancelled' AND OLD.status IS NOT 'cancelled' AND NEW.seller_type = 'merchant'
BEGIN
  UPDATE community_product_variants
     SET stock = stock + (SELECT COALESCE(SUM(i.qty), 0) FROM order_items i
                           WHERE i.order_id = NEW.id AND i.variant_id = community_product_variants.id),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id IN (SELECT i.variant_id FROM order_items i WHERE i.order_id = NEW.id AND i.variant_id IS NOT NULL);
END;
