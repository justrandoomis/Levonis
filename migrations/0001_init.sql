-- Levonis — initial schema (fresh database).
-- Money conventions (documented in docs/SECURITY.md):
--   * Catalog / order amounts: IQD as INTEGER whole dinars (columns *_iqd).
--   * Wallet USD amounts: INTEGER US cents (columns *_usd_cents).
--   * Points: INTEGER points.
--   * admin_settings.exchange_rate: INTEGER IQD per 1 USD.
-- NOTE: this migration is for a FRESH database. Upgrading a database that
-- already holds data is a separate Phase 3 task performed after inspecting
-- and backing up the real schema (see docs/CLOUDFLARE_SETUP.md).

PRAGMA defer_foreign_keys = true;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,               -- stored lowercased
  username TEXT UNIQUE,                     -- stored lowercased
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,                       -- pbkdf2$<iter>$<salt>$<hash>; NULL = google-only account
  google_sub TEXT UNIQUE,                   -- Google account subject, set on verified Google sign-in
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','merchant','admin')),
  is_investor INTEGER NOT NULL DEFAULT 0,
  subscription_plan TEXT NOT NULL DEFAULT 'free' CHECK (subscription_plan IN ('free','plus','pro')),
  subscription_expiry INTEGER NOT NULL DEFAULT 0,  -- epoch ms; 0 = none
  subscription_cost_iqd INTEGER NOT NULL DEFAULT 0,-- what the current term cost (for upgrade proration)
  subscription_days INTEGER NOT NULL DEFAULT 0,    -- length of the current term
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ar','ku')),
  avatar_key TEXT,                          -- R2 object key
  bio TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  profile_json TEXT NOT NULL DEFAULT '{}',  -- printers/socials etc. (non-authoritative display data)
  checkin_streak INTEGER NOT NULL DEFAULT 0,
  last_checkin_day TEXT,                    -- YYYY-MM-DD (Asia/Baghdad)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                      -- SHA-256 hash of the cookie token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,                     -- e.g. "login:1.2.3.4"
  window_start INTEGER NOT NULL,            -- epoch seconds of window start
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,                            -- NULL for system
  action TEXT NOT NULL,                     -- e.g. wallet.approve, product.delete
  target TEXT NOT NULL DEFAULT '',          -- affected record id
  detail TEXT NOT NULL DEFAULT '',          -- JSON; never passwords/tokens
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_created ON audit_log(created_at);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','hidden')),
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  name_ku TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  description_ar TEXT NOT NULL DEFAULT '',
  description_ku TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',            -- JSON string[]
  options TEXT NOT NULL DEFAULT '[]',           -- JSON [{id,name,name_ar,image,price_iqd,original_price_iqd,cost_iqd,pro_price_iqd}]
  colors TEXT NOT NULL DEFAULT '[]',            -- JSON [{id,name,name_ar,hex,gradient,image,option_id,linked_option_ids,price_iqd,...}]
  selling_type TEXT NOT NULL DEFAULT 'direct_sale' CHECK (selling_type IN ('direct_sale','pre_order','bundle')),
  shipping_methods TEXT NOT NULL DEFAULT '[]',  -- JSON [{id,method,delivery_time,price_iqd}]
  price_iqd INTEGER NOT NULL DEFAULT 0 CHECK (price_iqd >= 0),
  original_price_iqd INTEGER CHECK (original_price_iqd IS NULL OR original_price_iqd >= 0),
  product_cost_iqd INTEGER,                     -- internal; never exposed publicly
  membership_prices TEXT NOT NULL DEFAULT '{}', -- JSON {plus?:iqd, pro?:iqd}
  payment_options TEXT NOT NULL DEFAULT '[]',   -- JSON string[] of checkout payment method ids
  subcategory_id TEXT NOT NULL DEFAULT '',
  categories TEXT NOT NULL DEFAULT '',          -- comma-separated
  display_order INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  specifications TEXT NOT NULL DEFAULT '[]',    -- JSON [{key,value}]
  brand TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '[]',
  hashtags TEXT NOT NULL DEFAULT '[]',
  algorithm_tags TEXT NOT NULL DEFAULT '[]',
  features TEXT NOT NULL DEFAULT '[]',
  description_images TEXT NOT NULL DEFAULT '[]',
  description_videos TEXT NOT NULL DEFAULT '[]',
  stores TEXT NOT NULL DEFAULT '[]',            -- JSON [{name,url,price_iqd}]
  warranty_plans TEXT NOT NULL DEFAULT '[]',    -- JSON [{name,price_iqd}]
  how_to_use TEXT NOT NULL DEFAULT '',
  stock INTEGER CHECK (stock IS NULL OR stock >= 0), -- NULL = not tracked
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_products_status_created ON products(status, created_at DESC);
CREATE INDEX idx_products_subcategory ON products(subcategory_id);

CREATE TABLE addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'Home',
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  landmark TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_addresses_user ON addresses(user_id);

CREATE TABLE cart_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL DEFAULT '',       -- selected product option id ('' = none)
  color_id TEXT NOT NULL DEFAULT '',
  shipping_method_id TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL CHECK (qty > 0 AND qty <= 99),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, product_id, option_id, color_id, shipping_method_id)
);
CREATE INDEX idx_cart_user ON cart_items(user_id);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,                      -- e.g. ORD-XXXXXXXX
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','processing','shipped','delivered','cancelled')),
  address_snapshot TEXT NOT NULL,           -- JSON copy of the address at order time
  delivery_method_id TEXT NOT NULL,
  delivery_method_snapshot TEXT NOT NULL,   -- JSON
  payment_method_id TEXT NOT NULL,
  subtotal_iqd INTEGER NOT NULL CHECK (subtotal_iqd >= 0),
  shipping_iqd INTEGER NOT NULL DEFAULT 0 CHECK (shipping_iqd >= 0),
  points_discount_iqd INTEGER NOT NULL DEFAULT 0 CHECK (points_discount_iqd >= 0),
  wallet_applied_iqd INTEGER NOT NULL DEFAULT 0 CHECK (wallet_applied_iqd >= 0),
  wallet_applied_usd_cents INTEGER NOT NULL DEFAULT 0 CHECK (wallet_applied_usd_cents >= 0),
  exchange_rate INTEGER NOT NULL,           -- IQD per USD at order time
  total_iqd INTEGER NOT NULL CHECK (total_iqd >= 0),
  due_on_delivery_iqd INTEGER NOT NULL CHECK (due_on_delivery_iqd >= 0),
  idempotency_key TEXT UNIQUE,
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders(status);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT,                          -- kept even if product later deleted
  name_snapshot TEXT NOT NULL,
  image_snapshot TEXT NOT NULL DEFAULT '',
  option_snapshot TEXT NOT NULL DEFAULT '', -- human-readable variant text
  shipping_method_id TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_iqd INTEGER NOT NULL CHECK (unit_price_iqd >= 0),
  line_total_iqd INTEGER NOT NULL CHECK (line_total_iqd >= 0)
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

CREATE TABLE wallet_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('deposit','withdrawal')),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','POINT')),
  amount INTEGER NOT NULL CHECK (amount > 0),  -- USD cents or points
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT '',
  receipt_key TEXT,                          -- private R2 object key
  ref TEXT NOT NULL DEFAULT '',              -- related record (order id, mission, plan)
  created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','admin','system')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX idx_wallet_user_created ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX idx_wallet_status ON wallet_transactions(status);

CREATE TABLE reward_claims (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission TEXT NOT NULL,                    -- checkin | push | video | browse
  day TEXT NOT NULL,                        -- YYYY-MM-DD (Asia/Baghdad)
  points INTEGER NOT NULL CHECK (points > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, mission, day)
);

CREATE TABLE browse_sessions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  started_at INTEGER NOT NULL,              -- epoch seconds
  seconds INTEGER NOT NULL DEFAULT 0,
  last_ping INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE investments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount_usd_cents INTEGER NOT NULL CHECK (amount_usd_cents > 0),
  expected_profit_usd_cents INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_investments_user ON investments(user_id);

CREATE TABLE investment_items (
  id TEXT PRIMARY KEY,
  investment_id TEXT NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_usd_cents INTEGER NOT NULL DEFAULT 0,
  image TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_investment_items_inv ON investment_items(investment_id);

CREATE TABLE investor_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('user','admin')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_investor_messages_user ON investor_messages(user_id, created_at);

CREATE TABLE community_merchants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar_key TEXT,
  verified INTEGER NOT NULL DEFAULT 0,      -- set only by admins
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE community_products (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')),
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  description_ar TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  price_iqd INTEGER NOT NULL DEFAULT 0 CHECK (price_iqd >= 0),
  original_price_iqd INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_community_products_merchant ON community_products(merchant_id);

CREATE TABLE community_requests (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, merchant_id)
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE chat_participants (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX idx_chat_participants_user ON chat_participants(user_id);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image')),
  body TEXT NOT NULL DEFAULT '',
  file_key TEXT,                            -- R2 key for image messages
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_chat_messages_chat ON chat_messages(chat_id, created_at);

CREATE TABLE favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE warranty_claims (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_item_id TEXT REFERENCES order_items(id),
  product_name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','in_review','approved','rejected')),
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_warranty_user ON warranty_claims(user_id);

CREATE TABLE admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                        -- JSON
);
