-- 0238 — SMART TRADE-IN VALUE (owner, 2026-11-18; docs/DECISIONS.md row 353, following rows 223 and 238).
--
-- Additive only: two NEW, empty, owner-private tables. Nothing existing is altered, updated or deleted.
--
-- (1) trade_in_model_profiles — one row per printer MODEL (a product) the owner has tuned:
--       resale_bp              the model's own resale share (NULL = the family's, blended with what
--                              traded-in units of the model really resold for)
--       successor_product_id   the newer generation; while it is on sale the resale share is lowered
--                              by the family's superseded_bp, or this row's own superseded_bp
--       value_off_sale         the owner's switch: a model no longer sold is valued from what was paid
-- (2) trade_in_smart_params — the family's smart-value knobs (NULL = the code default,
--     packages/pricing/src/tradeInOffer.ts DEFAULT_SMART_PARAMS).
--
-- PRIVATE: both are read and written only by the owner's trade-in doors (`trade_in_rules`), by
-- named columns (worker/lib/tradeInSmart.ts). A database without this file prices exactly as before.
--
-- Every CREATE carries IF NOT EXISTS: those are the statements scripts/migrate-check.mjs re-runs to
-- prove the file is idempotent.

CREATE TABLE IF NOT EXISTS trade_in_model_profiles (
  product_id TEXT PRIMARY KEY,
  resale_bp INTEGER CHECK (resale_bp IS NULL OR resale_bp BETWEEN 1000 AND 9500),
  successor_product_id TEXT CHECK (successor_product_id IS NULL OR successor_product_id <> product_id),
  superseded_bp INTEGER CHECK (superseded_bp IS NULL OR superseded_bp BETWEEN 0 AND 5000),
  -- 1 = while the model has no price on sale, value it from what the customer paid (less the
  -- family's monthly decay). 0 (the default) = no price today → no offer, as before.
  value_off_sale INTEGER NOT NULL DEFAULT 0 CHECK (value_off_sale IN (0, 1)),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_in_smart_params (
  family TEXT PRIMARY KEY CHECK (family IN ('fdm','resin','laser','ams','accessory')),
  hours_allowance_per_month INTEGER CHECK (hours_allowance_per_month IS NULL OR hours_allowance_per_month BETWEEN 0 AND 720),
  last_price_decay_bp INTEGER CHECK (last_price_decay_bp IS NULL OR last_price_decay_bp BETWEEN 0 AND 1000),
  last_price_max_decay_bp INTEGER CHECK (last_price_max_decay_bp IS NULL OR last_price_max_decay_bp BETWEEN 0 AND 9000),
  superseded_bp INTEGER CHECK (superseded_bp IS NULL OR superseded_bp BETWEEN 0 AND 5000),
  learn_weight INTEGER CHECK (learn_weight IS NULL OR learn_weight BETWEEN 1 AND 50),
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
