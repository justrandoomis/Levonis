-- ============================================================================
--  0135 — CATEGORY-LEVEL QUANTITY DELIVERY RULES
-- ============================================================================
-- Owner, 2026-09-25: «في الفلمنت يجب وضع اعداد عام وليس اعداد للمنتج الواحد …
-- توصيل العادي قسم fdm filament على القسم الفرعي كاملا هو 5000 لكل 15 بكرة».
--
-- The per-product rule (`products.ops_policy.delivery_options`) counts each
-- cart line on its own, so three colours of one filament paid three started
-- blocks. A row here prices every unit filed under a catalog section — or any
-- of its sub-sections — as ONE pool for one delivery method:
--
--     fee = ceil(total units in the section across the order / quantity_step)
--           × fee_per_step_iqd
--
-- the same formula (first block charged) as the product rule. The nearest
-- section with an enabled rule wins; a pooled line is not also priced by its
-- product rule, the ordinary flat fee, the printer freight or the carton
-- count. Pure engine: packages/shipping/src/shipping.ts `quoteShipping`.
--
-- NONDESTRUCTIVE: one new table. No existing row changes, so every order is
-- priced exactly as before until the owner adds a rule.
CREATE TABLE IF NOT EXISTS category_delivery_rules (
  catalog_id        TEXT    NOT NULL REFERENCES catalogs(id),
  method            TEXT    NOT NULL CHECK (method IN ('standard', 'personal')),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  quantity_step     INTEGER NOT NULL CHECK (quantity_step >= 1 AND quantity_step <= 100000),
  fee_per_step_iqd  INTEGER NOT NULL CHECK (fee_per_step_iqd >= 0 AND fee_per_step_iqd <= 100000000),
  updated_by        TEXT,
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (catalog_id, method)
);
