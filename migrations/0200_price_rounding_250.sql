-- 0199 — THE PRICE ROUNDING RULE: ABOVE 1,000 IQD TO THE NEXT 250 (owner decision 2026-10-17,
-- DECISIONS row 245; packages/pricing/src/priceRounding.ts)
--
-- Every published price used to be a positive multiple of 1,000, and the two tables that hold the
-- published V2 prices said so in a CHECK (0183 `product_sku_prices.regular_price_iqd`, 0189
-- `pricing_v2_sku_results.final_price_iqd` / `direct_price_iqd`). The rule is now: above 1,000 IQD
-- a price is a multiple of 250 (13,120 → 13,250); at or below 1,000 it is whole dinars (999 stays).
-- The CHECKs become exactly that rule, and nothing else in either table changes.
--
-- WIDENED, NEVER NARROWED: every stored price (a multiple of 1,000, at least 1,000) satisfies the new
-- CHECK, so the copy below keeps every row byte for byte. No price moves here: the existing published
-- prices move to the new rule ONLY when a product is re-published through the review sheet
-- («راجع الأسعار التي ستتغيّر»), product by product (the «تقريب الأسعار الجديد» filter of the queue
-- lists them), or by the next automatic repricing a rate change makes.
--
-- A REBUILD, because SQLite cannot widen a CHECK (the 0141 / 0175 precedent). Neither table has a
-- child: no foreign key names them, so nothing is stashed. Their twelve triggers (the engine guards of
-- 0183 / 0189 and the import guards of 0195) and the one index are re-created after the rename, with
-- IF NOT EXISTS, exactly as they were. An older Worker writes multiples of 1,000, which this CHECK
-- accepts; a newer Worker on a database without this file has its off-1,000 prices refused by the old
-- CHECK (fail closed: the write does not happen, no price is published).
PRAGMA defer_foreign_keys = true;

-- ============================================================================
-- 1. product_sku_prices — the published price the resolver reads (0183).
-- ============================================================================
CREATE TABLE product_sku_prices_new (
  product_id        TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key         TEXT NOT NULL CHECK (length(combo_key) BETWEEN 3 AND 400 AND (combo_key GLOB 'o:?*' OR combo_key GLOB 'c:?*')),
  channel           TEXT NOT NULL CHECK (channel IN ('direct_sale','pre_order_air','pre_order_sea','pre_order_land')),
  regular_price_iqd INTEGER NOT NULL CHECK (regular_price_iqd BETWEEN 1 AND 100000000000 AND (regular_price_iqd <= 1000 OR regular_price_iqd % 250 = 0)),
  source            TEXT NOT NULL DEFAULT 'ENGINE' CHECK (source = 'ENGINE'),
  write_seq         INTEGER NOT NULL CHECK (write_seq > 0),
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (product_id, combo_key, channel)
);

INSERT INTO product_sku_prices_new (product_id, combo_key, channel, regular_price_iqd, source, write_seq, updated_at)
  SELECT product_id, combo_key, channel, regular_price_iqd, source, write_seq, updated_at FROM product_sku_prices;

DROP TABLE product_sku_prices;
ALTER TABLE product_sku_prices_new RENAME TO product_sku_prices;

-- ============================================================================
-- 2. pricing_v2_sku_results — the private figures behind each published V2 price (0189).
-- ============================================================================
CREATE TABLE pricing_v2_sku_results_new (
  product_id         TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key          TEXT NOT NULL CHECK (length(combo_key) <= 400 AND (combo_key = '' OR combo_key GLOB 'o:?*' OR combo_key GLOB 'c:?*')),
  channel            TEXT NOT NULL CHECK (channel IN ('direct_sale','pre_order_air','pre_order_sea','pre_order_land')),
  method             TEXT NOT NULL CHECK (method IN ('cost','usd')),
  anchor             TEXT NOT NULL CHECK (anchor IN ('sku_fixed','model_fixed','product_fixed','cost')),
  final_price_iqd    INTEGER NOT NULL CHECK (final_price_iqd BETWEEN 1 AND 100000000000 AND (final_price_iqd <= 1000 OR final_price_iqd % 250 = 0)),
  exact_iqd          TEXT NOT NULL CHECK (exact_iqd GLOB '[0-9]*' AND exact_iqd NOT GLOB '*[^0-9.]*' AND exact_iqd NOT GLOB '*.*.*'
                       AND exact_iqd NOT GLOB '*.' AND length(exact_iqd) <= 48 AND CAST(exact_iqd AS REAL) > 0),
  direct_price_iqd   INTEGER NOT NULL CHECK (direct_price_iqd BETWEEN 1 AND 100000000000 AND (direct_price_iqd <= 1000 OR direct_price_iqd % 250 = 0)),
  direct_exact_iqd   TEXT NOT NULL CHECK (direct_exact_iqd GLOB '[0-9]*' AND direct_exact_iqd NOT GLOB '*[^0-9.]*' AND direct_exact_iqd NOT GLOB '*.*.*'
                       AND direct_exact_iqd NOT GLOB '*.' AND length(direct_exact_iqd) <= 48 AND CAST(direct_exact_iqd AS REAL) > 0),
  usd_ceil6          TEXT NOT NULL CHECK (usd_ceil6 GLOB '[0-9]*' AND usd_ceil6 NOT GLOB '*[^0-9.]*' AND usd_ceil6 NOT GLOB '*.*.*'
                       AND usd_ceil6 NOT GLOB '*.' AND usd_ceil6 NOT GLOB '*.???????*' AND length(usd_ceil6) <= 32 AND CAST(usd_ceil6 AS REAL) > 0),
  deltas_usd         TEXT NOT NULL DEFAULT '0' CHECK (ltrim(deltas_usd,'+-') GLOB '[0-9]*' AND ltrim(deltas_usd,'+-') NOT GLOB '*[^0-9.]*'
                       AND ltrim(deltas_usd,'+-') NOT GLOB '*.*.*' AND ltrim(deltas_usd,'+-') NOT GLOB '*.' AND ltrim(deltas_usd,'+-') NOT GLOB '*.???*'
                       AND length(deltas_usd) - length(ltrim(deltas_usd,'+-')) <= 1 AND length(deltas_usd) <= 16),
  discount_usd       TEXT CHECK (discount_usd IS NULL OR (discount_usd GLOB '[0-9]*' AND discount_usd NOT GLOB '*[^0-9.]*' AND discount_usd NOT GLOB '*.*.*'
                       AND discount_usd NOT GLOB '*.' AND discount_usd NOT GLOB '*.???*' AND length(discount_usd) <= 9
                       AND CAST(discount_usd AS REAL) >= 0 AND CAST(discount_usd AS REAL) <= 100000)),
  discount_scope     TEXT CHECK (discount_scope IS NULL OR discount_scope IN ('product','option','color','sku')),
  discount_scope_id  TEXT CHECK (discount_scope_id IS NULL OR length(discount_scope_id) <= 400),
  floor              TEXT NOT NULL DEFAULT 'none' CHECK (floor IN ('none','discount_withdrawn','direct_min_profit')),
  below_cost         INTEGER NOT NULL DEFAULT 0 CHECK (below_cost IN (0,1)),
  below_min_profit   INTEGER NOT NULL DEFAULT 0 CHECK (below_min_profit IN (0,1)),
  shipping_profile   TEXT CHECK (shipping_profile IS NULL OR shipping_profile IN ('GERMANY_LAND','CHINA_AIR','CHINA_SEA')),
  supplier_currency  TEXT CHECK (supplier_currency IS NULL OR supplier_currency IN ('USD','EUR','CNY')),
  fx_rate            TEXT CHECK (fx_rate IS NULL OR (fx_rate GLOB '[0-9]*' AND fx_rate NOT GLOB '*[^0-9.]*' AND fx_rate NOT GLOB '*.*.*'
                       AND fx_rate NOT GLOB '*.' AND length(fx_rate) <= 48 AND CAST(fx_rate AS REAL) > 0)),
  fx_version         INTEGER,
  cross_rate         TEXT CHECK (cross_rate IS NULL OR (cross_rate GLOB '[0-9]*' AND cross_rate NOT GLOB '*[^0-9.]*' AND cross_rate NOT GLOB '*.*.*'
                       AND cross_rate NOT GLOB '*.' AND length(cross_rate) <= 32 AND CAST(cross_rate AS REAL) > 0)),
  cross_fx_version   INTEGER,
  shipping_rate      TEXT,
  shipping_version   INTEGER,
  replacement_exact  TEXT CHECK (replacement_exact IS NULL OR (replacement_exact GLOB '[0-9]*' AND replacement_exact NOT GLOB '*[^0-9.]*'
                       AND replacement_exact NOT GLOB '*.*.*' AND replacement_exact NOT GLOB '*.')),
  replacement_cost_iqd INTEGER CHECK (replacement_cost_iqd IS NULL OR replacement_cost_iqd >= 0),
  target_profit_usd  TEXT CHECK (target_profit_usd IS NULL OR (target_profit_usd GLOB '[0-9]*' AND target_profit_usd NOT GLOB '*[^0-9.]*'
                       AND target_profit_usd NOT GLOB '*.*.*' AND target_profit_usd NOT GLOB '*.' AND length(target_profit_usd) <= 9
                       AND CAST(target_profit_usd AS REAL) > 0)),
  target_rule_id     TEXT,
  target_rule_version INTEGER,
  usd_iqd_rate       TEXT NOT NULL CHECK (usd_iqd_rate GLOB '[0-9]*' AND usd_iqd_rate NOT GLOB '*[^0-9.]*' AND usd_iqd_rate NOT GLOB '*.*.*'
                       AND usd_iqd_rate NOT GLOB '*.' AND length(usd_iqd_rate) <= 32 AND CAST(usd_iqd_rate AS REAL) > 0),
  usd_fx_version     INTEGER NOT NULL,
  inputs_seq         INTEGER NOT NULL,
  config_version     INTEGER NOT NULL,
  write_seq          INTEGER NOT NULL CHECK (write_seq > 0),
  computed_at        TEXT NOT NULL,
  PRIMARY KEY (product_id, combo_key, channel),
  CHECK (final_price_iqd <= direct_price_iqd),
  CHECK ((channel = 'direct_sale') = (discount_usd IS NULL)),
  CHECK (channel <> 'direct_sale' OR final_price_iqd = direct_price_iqd),
  CHECK (method = 'cost' OR floor = 'none'),
  CHECK (method = 'usd' OR (below_cost = 0 AND below_min_profit = 0)),
  CHECK (method = 'usd' OR (replacement_exact IS NOT NULL AND target_rule_id IS NOT NULL)),
  CHECK ((discount_scope IS NULL) = (discount_scope_id IS NULL)),
  CHECK ((replacement_exact IS NULL) = (replacement_cost_iqd IS NULL)),
  CHECK ((fx_rate IS NULL) = (fx_version IS NULL)),
  CHECK ((cross_rate IS NULL) = (cross_fx_version IS NULL)),
  CHECK ((shipping_rate IS NULL) = (shipping_version IS NULL)),
  CHECK ((target_rule_id IS NULL) = (target_rule_version IS NULL))
);

INSERT INTO pricing_v2_sku_results_new (
  product_id, combo_key, channel, method, anchor, final_price_iqd, exact_iqd, direct_price_iqd, direct_exact_iqd, usd_ceil6,
  deltas_usd, discount_usd, discount_scope, discount_scope_id, floor, below_cost, below_min_profit, shipping_profile,
  supplier_currency, fx_rate, fx_version, cross_rate, cross_fx_version, shipping_rate, shipping_version, replacement_exact,
  replacement_cost_iqd, target_profit_usd, target_rule_id, target_rule_version, usd_iqd_rate, usd_fx_version, inputs_seq,
  config_version, write_seq, computed_at)
SELECT
  product_id, combo_key, channel, method, anchor, final_price_iqd, exact_iqd, direct_price_iqd, direct_exact_iqd, usd_ceil6,
  deltas_usd, discount_usd, discount_scope, discount_scope_id, floor, below_cost, below_min_profit, shipping_profile,
  supplier_currency, fx_rate, fx_version, cross_rate, cross_fx_version, shipping_rate, shipping_version, replacement_exact,
  replacement_cost_iqd, target_profit_usd, target_rule_id, target_rule_version, usd_iqd_rate, usd_fx_version, inputs_seq,
  config_version, write_seq, computed_at
FROM pricing_v2_sku_results;

DROP TABLE pricing_v2_sku_results;
ALTER TABLE pricing_v2_sku_results_new RENAME TO pricing_v2_sku_results;

CREATE INDEX IF NOT EXISTS idx_pricing_v2_results_currency ON pricing_v2_sku_results(supplier_currency, product_id);

-- ============================================================================
-- 3. The guards, exactly as 0183 / 0189 (the engine's batch only) and 0195 (no import batch) wrote them.
-- ============================================================================
CREATE TRIGGER IF NOT EXISTS product_sku_prices_insert_guard BEFORE INSERT ON product_sku_prices
WHEN NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS product_sku_prices_update_guard BEFORE UPDATE ON product_sku_prices
WHEN NEW.product_id IS NOT OLD.product_id
  OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS product_sku_prices_delete_guard BEFORE DELETE ON product_sku_prices
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine')
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS pricing_v2_sku_results_insert_guard BEFORE INSERT ON pricing_v2_sku_results
WHEN NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS pricing_v2_sku_results_update_guard BEFORE UPDATE ON pricing_v2_sku_results
WHEN NEW.product_id IS NOT OLD.product_id
  OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS pricing_v2_sku_results_delete_guard BEFORE DELETE ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine')
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_sku_prices_ins BEFORE INSERT ON product_sku_prices
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_sku_prices_upd BEFORE UPDATE ON product_sku_prices
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_sku_prices_del BEFORE DELETE ON product_sku_prices
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_v2_sku_results_ins BEFORE INSERT ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_v2_sku_results_upd BEFORE UPDATE ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_v2_sku_results_del BEFORE DELETE ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
