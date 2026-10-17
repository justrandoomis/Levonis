-- 0197 — DOLLAR SALE PRICES FOR THE ONE PROMOTION MODEL (docs/ux/PRODUCT-DISCOUNT.md §3)
--
-- A window whose offer_price_mode is 'fixed_usd' (offer_windows.offer_price_mode has no CHECK, so the
-- new value needs no ALTER) takes its price from these rows: ONE row for the whole product
-- (model_id = '') OR one row per model (the first option value in relation order, the id Pricing V2
-- calls model_id). Never both. A model without a row is not on sale. Cents are whole numbers; the
-- resolver turns them into dinars with the SKU's own V2 rate (worker/lib/offerUsd.ts).
-- Additive only: a new table and a trigger; no row of any existing table is touched. INERT until a
-- 'fixed_usd' window exists. An older Worker never reads it.
CREATE TABLE IF NOT EXISTS offer_usd_prices (
  subject_type    TEXT NOT NULL CHECK (subject_type = 'product'),
  subject_id      TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 60),
  model_id        TEXT NOT NULL DEFAULT '' CHECK (length(model_id) <= 120),
  price_usd_cents INTEGER NOT NULL CHECK (typeof(price_usd_cents) = 'integer' AND price_usd_cents BETWEEN 1 AND 10000000),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (subject_type, subject_id, model_id)
);

-- One scope per subject: the whole-product row or model rows, never both (the route refuses first;
-- this is the backstop for any other writer).
CREATE TRIGGER IF NOT EXISTS offer_usd_prices_one_scope BEFORE INSERT ON offer_usd_prices
WHEN EXISTS (SELECT 1 FROM offer_usd_prices o
              WHERE o.subject_type = NEW.subject_type AND o.subject_id = NEW.subject_id
                AND (o.model_id = '') <> (NEW.model_id = ''))
BEGIN SELECT RAISE(ABORT, 'OFFER_USD_SCOPE_MIXED'); END;
