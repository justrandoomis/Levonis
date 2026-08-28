-- Levonis migration 0007 — review/gift extras building on 0003.
-- NONDESTRUCTIVE: ADD COLUMN / CREATE TABLE / CREATE INDEX only.
--
-- 0003 already provides reviews (UNIQUE(user_id, product_id)), review_rewards
-- (UNIQUE(review_id)), gift_entitlements (UNIQUE(reward_id)) and gift_pools.
-- This migration adds:
--   1) reviews.order_id — a review is tied to the delivered order that proves
--      the purchase. The existing UNIQUE(user_id, product_id) from 0003 stays
--      (nondestructive) and is STRICTER than one-per-(user,product,order):
--      a customer who bought the same product twice still reviews it once.
--   2) gift_pool_items — normalized per-item gift stock. gift_pools.items
--      (0003) is a JSON blob, which cannot enforce atomic stock decrements;
--      a real INTEGER column with CHECK (stock >= 0) lets a D1 batch abort on
--      concurrent depletion instead of overselling a gift. gift_pools stays
--      in place (no data existed) but the pool rows of record are these.
--   3) gift_redemptions — exactly ONE redemption per entitlement (PRIMARY
--      KEY entitlement_id). The redeem batch inserts here first, so a
--      concurrent/replayed redeem violates the PK and the whole batch
--      (including stock decrements) aborts — contents are persisted once and
--      never reroll on refresh.

PRAGMA defer_foreign_keys = true;

ALTER TABLE reviews ADD COLUMN order_id TEXT REFERENCES orders(id);
CREATE INDEX idx_reviews_order ON reviews(order_id);

CREATE TABLE gift_pool_items (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  -- Composition slot this item can fill (level 3 draws one 'filament' plus
  -- one 'accessory'; levels 4/5 need 'nozzle'/'plate').
  kind TEXT NOT NULL DEFAULT 'accessory' CHECK (kind IN ('accessory','filament','nozzle','plate','other')),
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL DEFAULT '',
  label_ckb TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  material TEXT NOT NULL DEFAULT '',      -- e.g. PLA / PETG
  color TEXT NOT NULL DEFAULT '',
  option_value TEXT NOT NULL DEFAULT '',  -- e.g. nozzle size "0.4"
  -- Printer product ids this part fits (JSON array). Compatibility comes from
  -- the reviewed printer model — an empty list means "not configured", which
  -- makes the item INELIGIBLE for nozzle/plate matching (honest, no guessing).
  compat_products TEXT NOT NULL DEFAULT '[]',
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_gift_pool_items_level ON gift_pool_items(level, active);

CREATE TABLE gift_redemptions (
  entitlement_id TEXT PRIMARY KEY REFERENCES gift_entitlements(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  options TEXT NOT NULL DEFAULT '{}',     -- JSON {nozzle_size?, plate_item_id?}
  contents TEXT NOT NULL DEFAULT '[]',    -- JSON server-chosen item snapshots, persisted ONCE
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_gift_redemptions_user ON gift_redemptions(user_id);
