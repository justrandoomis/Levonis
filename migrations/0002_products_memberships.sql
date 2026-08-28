-- Levonis migration 0002 — canonical product model, taxonomy, memberships,
-- referrals, coupons, BNPL scaffolding. NONDESTRUCTIVE: only ADD COLUMN /
-- CREATE TABLE / data backfill. Existing columns keep their data; legacy
-- JSON shapes are upgraded by code-level adapters (worker/lib/productModel.ts),
-- never truncated.
--
-- Language note: *_ku columns store Iraqi Kurdish content, exposed via the
-- API as `ckb` (Sorani / Central Kurdish) — pending owner confirmation of
-- the variety (decision register).

PRAGMA defer_foreign_keys = true;

-- ---------------------------------------------------------------- taxonomy

CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  name_ckb TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE catalogs (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES catalogs(id),
  slug TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  name_ckb TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  -- marks catalogs whose products qualify as "printers" for the PLUS gift
  -- and PRO maintenance-discount rules (a real attribute, not name matching)
  is_printer_catalog INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Products can belong to multiple catalogs; display order lives on the
-- association and is unique per catalog (enforced; reorders shift atomically).
CREATE TABLE product_catalogs (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (product_id, catalog_id),
  UNIQUE (catalog_id, position)
);
CREATE INDEX idx_product_catalogs_catalog ON product_catalogs(catalog_id, position);

-- ------------------------------------------------------- product extensions

-- Explicit PRO selling price at product level (NULL = no explicit PRO price;
-- resolution falls back to the configured store policy, never a guess).
ALTER TABLE products ADD COLUMN pro_price_iqd INTEGER CHECK (pro_price_iqd IS NULL OR pro_price_iqd >= 0);
ALTER TABLE products ADD COLUMN brand_id TEXT REFERENCES brands(id);
-- Preorder transport methods offered for this product:
-- JSON [{method:'air'|'sea'|'land', commission_iqd:int|null, active:bool}]
-- commission_iqd NULL = inherit the admin default for that method.
ALTER TABLE products ADD COLUMN preorder_transports TEXT NOT NULL DEFAULT '[]';
-- Ordered bottom-of-page content blocks:
-- JSON [{id, kind:'text'|'image'|'video_embed', order, body_ar/en/ckb,
--        caption_ar/en/ckb, alt_ar/en/ckb, url, media_key}]
ALTER TABLE products ADD COLUMN content_blocks TEXT NOT NULL DEFAULT '[]';
-- Per-field translation tracking:
-- JSON {"<field>":{"en":{"status":"approved"|"machine"|"stale"|"missing","src_rev":int},
--                  "ckb":{...}}}   (Arabic is the source language)
ALTER TABLE products ADD COLUMN translation_meta TEXT NOT NULL DEFAULT '{}';
-- Monotonic revision of the Arabic source content; bumping it marks
-- dependent translations stale instead of overwriting them.
ALTER TABLE products ADD COLUMN content_rev INTEGER NOT NULL DEFAULT 1;
-- Document/schema version consumed by adapters and the template pipeline.
ALTER TABLE products ADD COLUMN doc_version INTEGER NOT NULL DEFAULT 1;

-- Local translation glossary (NO runtime AI): curated recurring terms.
CREATE TABLE glossary (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL DEFAULT 'general',   -- e.g. specs, colors, categories, ui
  term_ar TEXT NOT NULL,
  term_en TEXT NOT NULL DEFAULT '',
  term_ckb TEXT NOT NULL DEFAULT '',
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (domain, term_ar)
);

-- ------------------------------------------------------------- cart/orders

ALTER TABLE cart_items ADD COLUMN transport_method TEXT NOT NULL DEFAULT ''
  CHECK (transport_method IN ('', 'air', 'sea', 'land'));
ALTER TABLE cart_items ADD COLUMN warranty_plan_id TEXT NOT NULL DEFAULT '';

ALTER TABLE orders ADD COLUMN membership_tier_snapshot TEXT NOT NULL DEFAULT 'free';
ALTER TABLE orders ADD COLUMN delivery_waived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN delivered_at TEXT;          -- set by admin on real delivery
ALTER TABLE orders ADD COLUMN coupon_snapshot TEXT;       -- JSON, when a coupon applied

ALTER TABLE order_items ADD COLUMN pricing_snapshot TEXT; -- JSON resolved breakdown
ALTER TABLE order_items ADD COLUMN warranty_snapshot TEXT;  -- JSON {plan_id,title,fee_iqd,duration_months,kind}
ALTER TABLE order_items ADD COLUMN transport_snapshot TEXT; -- JSON {method,commission_iqd,waived}

-- ------------------------------------------------------------- memberships

CREATE TABLE membership_plans (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('plus','pro')),
  duration_months INTEGER NOT NULL CHECK (duration_months > 0),
  price_iqd INTEGER CHECK (price_iqd IS NULL OR price_iqd >= 0), -- NULL = unpriced: NOT purchasable
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Owner-supplied prices pending for PLUS ("starts from 3,500 IQD/mo" is not a
-- schedule — decision register). PRO 12mo is explicitly priced by the owner.
INSERT INTO membership_plans (id, tier, duration_months, price_iqd, sort) VALUES
  ('plus_1mo',  'plus', 1,  NULL,   1),
  ('plus_3mo',  'plus', 3,  NULL,   2),
  ('plus_6mo',  'plus', 6,  NULL,   3),
  ('plus_12mo', 'plus', 12, NULL,   4),
  ('pro_12mo',  'pro',  12, 499000, 5);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES membership_plans(id),
  tier TEXT NOT NULL CHECK (tier IN ('plus','pro')),
  state TEXT NOT NULL CHECK (state IN
    ('pending_payment','prepaid_pending_launch','active','expired','cancelled')),
  duration_months INTEGER NOT NULL,
  price_paid_iqd INTEGER NOT NULL DEFAULT 0,
  purchased_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  starts_at TEXT,                 -- set on activation
  expires_at TEXT,                -- set on activation
  source TEXT NOT NULL DEFAULT 'purchase' CHECK (source IN ('purchase','gift_printer','admin','migrated')),
  source_ref TEXT NOT NULL DEFAULT '',   -- order id / wallet tx / admin id
  wallet_tx_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_memberships_user ON memberships(user_id, state);
-- Idempotency: one gift per qualifying source transaction.
CREATE UNIQUE INDEX idx_memberships_gift_source ON memberships(source, source_ref)
  WHERE source = 'gift_printer';

-- Preserve existing paid time: users already carrying an unexpired paid plan
-- get a migrated ACTIVE membership row (plan mapped by tier, 0-cost record;
-- original purchase evidence remains in wallet_transactions).
INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months,
                         price_paid_iqd, starts_at, expires_at, source, source_ref)
SELECT 'mig_' || id, id,
       CASE WHEN subscription_plan = 'pro' THEN 'pro_12mo' ELSE 'plus_1mo' END,
       subscription_plan, 'active', 0, 0,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', subscription_expiry / 1000, 'unixepoch'),
       'migrated', 'users.subscription columns'
FROM users
WHERE subscription_plan IN ('plus','pro') AND subscription_expiry > (strftime('%s','now') * 1000);

-- ---------------------------------------------------------------- referrals

CREATE TABLE referral_codes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE referral_attributions (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL REFERENCES users(id),
  referred_id TEXT NOT NULL REFERENCES users(id),
  campaign TEXT NOT NULL CHECK (campaign IN ('printer','pro_sub')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (referred_id, campaign)
);

CREATE TABLE referral_rewards (
  id TEXT PRIMARY KEY,
  campaign TEXT NOT NULL CHECK (campaign IN ('printer','pro_sub')),
  referrer_id TEXT NOT NULL REFERENCES users(id),
  referred_id TEXT NOT NULL REFERENCES users(id),
  source_ref TEXT NOT NULL,       -- qualifying order id / membership id
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','qualified','available','reserved','fulfilled','cancelled')),
  eligible_at TEXT,               -- printer campaign: delivered_at + 7 days
  spool_product_id TEXT,          -- chosen server-side at the approved milestone
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  decided_by TEXT,
  UNIQUE (campaign, source_ref)   -- exactly one reward per qualifying transaction
);
CREATE INDEX idx_referral_rewards_referrer ON referral_rewards(referrer_id, state);

-- ------------------------------------------------------------------ coupons

CREATE TABLE coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,      -- stored uppercased
  tier_required TEXT CHECK (tier_required IS NULL OR tier_required IN ('plus','pro')),
  kind TEXT NOT NULL CHECK (kind IN ('fixed_iqd','percent')),
  value INTEGER NOT NULL CHECK (value > 0),
  min_total_iqd INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  max_global INTEGER,             -- NULL = unlimited
  max_per_user INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE coupon_redemptions (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES coupons(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  amount_iqd INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_coupon_redemptions_coupon ON coupon_redemptions(coupon_id);

-- --------------------------------------------------- BNPL (structure only)
-- Checkout with BNPL stays DISABLED until the owner supplies credit rules
-- (limits, due dates, fees, legal policy) — decision register.

CREATE TABLE bnpl_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'none' CHECK (state IN ('none','requested','approved','suspended')),
  credit_limit_iqd INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE bnpl_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('charge','repayment','adjustment')),
  amount_iqd INTEGER NOT NULL,
  due_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_bnpl_ledger_user ON bnpl_ledger(user_id);
