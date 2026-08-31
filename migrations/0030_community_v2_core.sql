-- 0030 — LEVO PLUS merchant stores: plans, merchant/store identity, seller-aware cart.
--
-- Part 1 of 2. This migration establishes WHO sells and WHAT a cart belongs
-- to. 0031 builds the marketplace (requests, offers, escrow, reviews,
-- complaints) on top of it.
--
-- NON-DESTRUCTIVE. Nothing here deletes a user, order, wallet transaction,
-- membership, merchant, product, follow or chat. The one table that is
-- rebuilt (`cart_items`) is rebuilt by copy — every existing row survives
-- with its meaning unchanged — because SQLite cannot relax a NOT NULL
-- constraint in place and a merchant line has no `products` row to point at.

------------------------------------------------------------------- 1. PLANS
-- The owner set the full PLUS schedule. Migration 0025 had deactivated the
-- three short durations under an earlier decision ("PLUS and PRO are annual
-- only"); that decision is now superseded FOR PLUS ONLY. PRO stays annual —
-- 0025's pro_12mo row is untouched here.
--
-- Prices are written to the DATABASE, which stays authoritative: the
-- storefront reads /api/memberships/plans and the purchase path re-reads the
-- row. No price is ever taken from the browser.
UPDATE membership_plans SET price_iqd =  4500, active = 1 WHERE id = 'plus_1mo';
UPDATE membership_plans SET price_iqd = 10000, active = 1 WHERE id = 'plus_3mo';
UPDATE membership_plans SET price_iqd = 17000, active = 1 WHERE id = 'plus_6mo';
UPDATE membership_plans SET price_iqd = 29000, active = 1 WHERE id = 'plus_12mo';

-- Idempotent re-seed: a database that never ran 0002 (or had a row removed)
-- comes back to the same known state instead of silently having no plan.
INSERT OR IGNORE INTO membership_plans (id, tier, duration_months, price_iqd, active, sort) VALUES
  ('plus_1mo',  'plus', 1,   4500, 1, 1),
  ('plus_3mo',  'plus', 3,  10000, 1, 2),
  ('plus_6mo',  'plus', 6,  17000, 1, 3),
  ('plus_12mo', 'plus', 12, 29000, 1, 4);

--------------------------------------------------------- 2. MERCHANT ENTITY
-- community_merchants already exists (0001) and already carries the
-- user_id/name/bio/avatar/verified identity. EXTENDED, never duplicated.
--
-- `verified` (0001) is the ADMIN verification flag and keeps that meaning
-- exactly. It is NOT membership eligibility: PLUS says "may operate a store",
-- verified says "Levonis checked this merchant". Two different questions, two
-- different columns, deliberately never merged.
ALTER TABLE community_merchants ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  -- active | restricted (admin-limited) | suspended (admin-stopped)
ALTER TABLE community_merchants ADD COLUMN status_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE community_merchants ADD COLUMN status_changed_at TEXT;
ALTER TABLE community_merchants ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE community_merchants ADD COLUMN governorate TEXT NOT NULL DEFAULT '';
ALTER TABLE community_merchants ADD COLUMN badge TEXT NOT NULL DEFAULT 'new';
  -- new | trusted | professional | elite | featured — derived from reputation
  -- by worker/lib/merchantReputation.ts, or pinned by an admin override.
ALTER TABLE community_merchants ADD COLUMN badge_override TEXT NOT NULL DEFAULT '';
ALTER TABLE community_merchants ADD COLUMN reputation_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_merchants ADD COLUMN rating_avg_x100 INTEGER NOT NULL DEFAULT 0;
  -- Integer hundredths. Money and ratings never touch floating point.
ALTER TABLE community_merchants ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_merchants ADD COLUMN completed_orders INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_community_merchants_status ON community_merchants(status);

------------------------------------------------------------ 3. STOREFRONTS
-- A merchant may own exactly one storefront today, but store_id is its own
-- identity and never equals merchant_id or user_id. §69: the slug is routing
-- identity only and is NEVER a primary key, so a future custom domain can be
-- mapped to store_id without touching a single order.
CREATE TABLE merchant_stores (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL UNIQUE REFERENCES community_merchants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Denormalised owner, so ownership checks are one indexed read. It is
    -- never the authorisation input on its own: every mutation joins through
    -- the store row and compares against the session user (§72).
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  logo_key TEXT,
  banner_key TEXT,
  accent TEXT NOT NULL DEFAULT 'default',
    -- A PRESET NAME, not a colour value and never CSS. §12: no arbitrary CSS
    -- or HTML may reach the page. The frontend maps this to one of its own
    -- theme classes and ignores anything it does not recognise.
  categories TEXT NOT NULL DEFAULT '[]',
  governorate TEXT NOT NULL DEFAULT '',
  service_areas TEXT NOT NULL DEFAULT '[]',
  contact_phone TEXT NOT NULL DEFAULT '',
  contact_phone_public INTEGER NOT NULL DEFAULT 0,
  business_hours TEXT NOT NULL DEFAULT '[]',
  policies TEXT NOT NULL DEFAULT '{}',
  delivery_settings TEXT NOT NULL DEFAULT '{}',
  social_links TEXT NOT NULL DEFAULT '{}',
  accepts_custom_requests INTEGER NOT NULL DEFAULT 1,
  sells_direct_products INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','suspended')),
    -- paused    = the merchant closed their own shop
    -- suspended = an admin stopped it. Only an admin can lift this, so a
    --             merchant cannot un-suspend by pausing and re-opening.
  status_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_merchant_stores_user ON merchant_stores(user_id);
CREATE INDEX idx_merchant_stores_status ON merchant_stores(status);

-- Slug history. A released slug is NOT immediately claimable by someone else
-- (§68) — otherwise a competitor watches for a rename and takes the traffic,
-- and every link and QR code printed on a box now points at them.
CREATE TABLE merchant_store_slugs (
  slug TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 0,      -- 1 = current, 0 = retired but reserved
  reserved_until TEXT,                    -- retired slugs stay unclaimable until this
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_merchant_store_slugs_store ON merchant_store_slugs(store_id);

-- Names a merchant may never take. Held in the DATABASE rather than only in
-- code so an operator can reserve a new system name the moment it is needed,
-- without a deploy. The resolver checks system hosts BEFORE this table anyway
-- (§7), so a mistake here cannot expose a system subdomain.
CREATE TABLE reserved_slugs (
  slug TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'system'
);
INSERT OR IGNORE INTO reserved_slugs (slug, reason) VALUES
  ('www','system'), ('api','system'), ('admin','system'), ('studio','system'),
  ('mail','system'), ('support','system'), ('cdn','system'), ('assets','system'),
  ('static','system'), ('auth','system'), ('account','system'), ('community','system'),
  ('shop','system'), ('store','system'), ('app','system'), ('dashboard','system'),
  ('status','system'), ('help','system'), ('billing','system'), ('checkout','system'),
  ('levonis','brand'), ('levo','brand'), ('official','brand'), ('team','brand'),
  ('blog','system'), ('docs','system'), ('dev','system'), ('staging','system'),
  ('test','system'), ('ftp','system'), ('smtp','system'), ('imap','system'),
  ('ns1','system'), ('ns2','system'), ('mx','system'), ('webmail','system'),
  ('cpanel','system'), ('files','system'), ('media','system'), ('img','system'),
  ('images','system'), ('pay','system'), ('payments','system'), ('wallet','system'),
  ('security','system'), ('abuse','system'), ('legal','system'), ('privacy','system'),
  ('me','system'), ('my','system'), ('u','system'), ('go','system'), ('link','system');

-- Per-merchant notification switches (§61). Absent row = platform defaults.
CREATE TABLE merchant_notification_preferences (
  merchant_id TEXT PRIMARY KEY REFERENCES community_merchants(id) ON DELETE CASCADE,
  new_orders INTEGER NOT NULL DEFAULT 1,
  request_opportunities INTEGER NOT NULL DEFAULT 1,
  new_messages INTEGER NOT NULL DEFAULT 1,
  new_reviews INTEGER NOT NULL DEFAULT 1,
  new_followers INTEGER NOT NULL DEFAULT 1,
  complaints INTEGER NOT NULL DEFAULT 1,
  subscription_expiry INTEGER NOT NULL DEFAULT 1,
  system_alerts INTEGER NOT NULL DEFAULT 1,
  marketing INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- complaints, subscription_expiry and system_alerts are stored but the server
-- ignores a 0 for the money-and-safety subset (§61): a merchant cannot switch
-- off the notice that their subscription lapsed or that a dispute was opened
-- against them. The column exists so the UI can show it as forced-on with a
-- reason rather than hiding it.

------------------------------------------------------- 4. MERCHANT PRODUCTS
-- community_products already exists (0001). EXTENDED for real commerce.
ALTER TABLE community_products ADD COLUMN store_id TEXT REFERENCES merchant_stores(id) ON DELETE CASCADE;
ALTER TABLE community_products ADD COLUMN sku TEXT NOT NULL DEFAULT '';
ALTER TABLE community_products ADD COLUMN stock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_products ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 1;
ALTER TABLE community_products ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE community_products ADD COLUMN condition TEXT NOT NULL DEFAULT 'new';
ALTER TABLE community_products ADD COLUMN options TEXT NOT NULL DEFAULT '[]';
ALTER TABLE community_products ADD COLUMN colors TEXT NOT NULL DEFAULT '[]';
ALTER TABLE community_products ADD COLUMN delivery_methods TEXT NOT NULL DEFAULT '[]';
ALTER TABLE community_products ADD COLUMN prep_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_products ADD COLUMN sold_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_products ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_products ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

-- 0001's CHECK admits only ('active','hidden'). Widening it would mean
-- rebuilding a table that community carts and orders will reference, so the
-- extra lifecycle states live in a separate column that starts empty and is
-- only meaningful when set. `status` stays the visibility switch it always
-- was; `lifecycle` says why.
ALTER TABLE community_products ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active';
  -- draft | active | hidden | sold_out | archived

CREATE INDEX IF NOT EXISTS idx_community_products_store ON community_products(store_id, status);
CREATE INDEX IF NOT EXISTS idx_community_products_lifecycle ON community_products(merchant_id, lifecycle);

------------------------------------------------- 5. SELLER-AWARE CART (§14)
-- REBUILT BY COPY, not dropped. A merchant line has no `products` row to
-- reference, and 0001 declared `product_id TEXT NOT NULL REFERENCES
-- products(id)`. SQLite cannot relax NOT NULL in place, and nothing in the
-- schema has a foreign key INTO cart_items, so the rebuild is contained.
--
-- The one-seller rule is enforced in worker/routes/cart.ts, which is the only
-- writer, because SQLite cannot express "all rows for this user share a
-- seller" as a constraint. The CHECKs below enforce what they can: a line is
-- exactly one kind of thing, and a merchant line always names its seller.
CREATE TABLE cart_items_v2 (
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
  qty INTEGER NOT NULL CHECK (qty > 0 AND qty <= 99),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Exactly one product source, matching the declared seller.
  CHECK (
    (seller_type = 'levonis'  AND product_id IS NOT NULL AND community_product_id IS NULL
       AND merchant_id IS NULL AND store_id IS NULL)
    OR
    (seller_type = 'merchant' AND community_product_id IS NOT NULL AND product_id IS NULL
       AND merchant_id IS NOT NULL AND store_id IS NOT NULL)
  ),
  UNIQUE (user_id, product_id, community_product_id, option_id, color_id, shipping_method_id)
);

INSERT INTO cart_items_v2
  (id, user_id, seller_type, product_id, option_id, option_value_ids, color_id,
   shipping_method_id, transport_method, warranty_plan_id, qty, created_at)
SELECT id, user_id, 'levonis', product_id, option_id, option_value_ids, color_id,
       shipping_method_id, transport_method, warranty_plan_id, qty, created_at
  FROM cart_items;

DROP TABLE cart_items;
ALTER TABLE cart_items_v2 RENAME TO cart_items;
CREATE INDEX idx_cart_user ON cart_items(user_id);
CREATE INDEX idx_cart_seller ON cart_items(user_id, seller_type, merchant_id);

--------------------------------------------------- 6. SELLER-AWARE ORDERS
-- Existing orders are platform orders; the defaults say so without a backfill
-- pass over the table.
ALTER TABLE orders ADD COLUMN seller_type TEXT NOT NULL DEFAULT 'levonis';
ALTER TABLE orders ADD COLUMN merchant_id TEXT REFERENCES community_merchants(id);
ALTER TABLE orders ADD COLUMN store_id TEXT REFERENCES merchant_stores(id);
ALTER TABLE orders ADD COLUMN origin TEXT NOT NULL DEFAULT 'platform';
  -- platform | store_product | community_request  (§74)
ALTER TABLE orders ADD COLUMN community_order_id TEXT;
-- Commission is SNAPSHOT per order (§30, §75). Changing the platform rate
-- tomorrow must not silently rewrite what a merchant is owed for a sale that
-- already happened.
ALTER TABLE orders ADD COLUMN commission_percent_x100 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN platform_fee_iqd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN merchant_receivable_iqd INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_orders_merchant ON orders(merchant_id, created_at DESC);
CREATE INDEX idx_orders_store_status ON orders(store_id, status);

ALTER TABLE order_items ADD COLUMN community_product_id TEXT;
ALTER TABLE order_items ADD COLUMN seller_type TEXT NOT NULL DEFAULT 'levonis';

--------------------------------------------------------- 7. STORE ANALYTICS
-- Pre-aggregated per store per day. Counting store views by scanning an event
-- log would get slower every day a store succeeds.
CREATE TABLE merchant_store_analytics_daily (
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                       -- YYYY-MM-DD (UTC)
  store_views INTEGER NOT NULL DEFAULT 0,
  product_views INTEGER NOT NULL DEFAULT 0,
  orders_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  cancelled_count INTEGER NOT NULL DEFAULT 0,
  refunded_count INTEGER NOT NULL DEFAULT 0,
  gross_iqd INTEGER NOT NULL DEFAULT 0,
  platform_fee_iqd INTEGER NOT NULL DEFAULT 0,
  receivable_iqd INTEGER NOT NULL DEFAULT 0,
  offers_sent INTEGER NOT NULL DEFAULT 0,
  offers_accepted INTEGER NOT NULL DEFAULT 0,
  followers_gained INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, day)
);

--------------------------------------------------------- 8. COMMUNITY SETTINGS
-- Commission and lifecycle timings are ADMIN SETTINGS, not constants scattered
-- through business logic (§30). Seeded with the platform defaults; the admin
-- API writes the same keys.
INSERT OR IGNORE INTO admin_settings (key, value) VALUES
  ('communityFeeRequestPercentX100', '500'),   -- 5.00% on custom-request work
  ('communityFeeStorePercentX100',   '500'),   -- 5.00% on direct store sales
  ('communityFeeMinIqd',             '0'),
  ('communityAutoCompleteDays',      '7'),     -- 0 disables auto-release entirely
  ('communityOfferMaxPerRequest',    '1'),
  ('communityRequestExpiryDays',     '30');
