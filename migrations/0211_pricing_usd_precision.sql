-- 0211 — Dollar unit prices and minimum profits accept six decimal places (owner, 2026-10-23).
-- 0.051 must survive typing, preview, save and reload. Exact rational calculations already support it.
-- Widen only the decimal/length CHECKs; copy every row unchanged. Preserve all indexes and guards.
-- No published dinar price or accounting entry changes. No table below has a foreign-key child.
-- An older Worker can still write cents; a newer Worker before this migration fails closed at the old CHECK.
PRAGMA defer_foreign_keys = true;

-- pricing_rules
CREATE TABLE pricing_rules_new (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('target_profit','direct_sale_extra')),
  scope               TEXT NOT NULL CHECK (scope IN ('global','category','product','option','color','sku')),
  catalog_id          TEXT,
  product_id          TEXT REFERENCES products(id) ON DELETE CASCADE,
  scope_id            TEXT NOT NULL DEFAULT '',
  state               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','BLOCKED','INHERIT')),
  amount_usd          TEXT CHECK (amount_usd IS NULL OR (amount_usd GLOB '[0-9]*' AND amount_usd NOT GLOB '*[^0-9.]*'
                        AND amount_usd NOT GLOB '*.*.*' AND amount_usd NOT GLOB '*.' AND amount_usd NOT GLOB '*.???????*'
                        AND length(amount_usd) <= 13 AND CAST(amount_usd AS REAL) > 0 AND CAST(amount_usd AS REAL) <= 100000)),
  amount_iqd          INTEGER CHECK (amount_iqd IS NULL OR amount_iqd BETWEEN 0 AND 1000000000),
  legacy_amount_iqd   INTEGER CHECK (legacy_amount_iqd IS NULL OR legacy_amount_iqd > 0),
  legacy_usd_iqd_rate TEXT CHECK (legacy_usd_iqd_rate IS NULL OR (legacy_usd_iqd_rate GLOB '[0-9]*' AND legacy_usd_iqd_rate NOT GLOB '*[^0-9.]*' AND legacy_usd_iqd_rate NOT GLOB '*.*.*' AND legacy_usd_iqd_rate NOT GLOB '*.' AND length(legacy_usd_iqd_rate) <= 32 AND CAST(legacy_usd_iqd_rate AS REAL) > 0)),
  source              TEXT NOT NULL DEFAULT 'OWNER' CHECK (source IN ('OWNER','LEGACY_MIGRATION')),
  legacy_result_id    TEXT,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by          TEXT,
  updated_at          TEXT NOT NULL,
  CHECK ((scope = 'global'   AND catalog_id IS NULL     AND product_id IS NULL     AND scope_id = '') OR
         (scope = 'category' AND catalog_id IS NOT NULL AND product_id IS NULL     AND scope_id = '') OR
         (scope = 'product'  AND catalog_id IS NULL     AND product_id IS NOT NULL AND scope_id = '') OR
         (scope IN ('option','color','sku') AND catalog_id IS NULL AND product_id IS NOT NULL AND scope_id <> '')),
  CHECK (kind = 'target_profit' OR amount_usd IS NULL),
  CHECK (kind <> 'target_profit' OR amount_iqd IS NULL
         OR (source = 'LEGACY_MIGRATION' AND amount_usd IS NULL AND amount_iqd > 0)),
  CHECK ((state = 'ACTIVE') = (CASE kind WHEN 'target_profit' THEN (amount_usd IS NOT NULL OR amount_iqd IS NOT NULL)
                                         ELSE amount_iqd IS NOT NULL END )),
  CHECK (kind <> 'direct_sale_extra' OR amount_iqd IS NULL OR amount_iqd % 1000 = 0),
  CHECK (state <> 'INHERIT' OR source = 'OWNER'),
  CHECK (state = 'ACTIVE' OR product_id IS NOT NULL),
  CHECK (source = 'OWNER' OR product_id IS NOT NULL),
  CHECK ((source = 'LEGACY_MIGRATION') = (legacy_result_id IS NOT NULL)),
  CHECK ((legacy_amount_iqd IS NULL) = (legacy_usd_iqd_rate IS NULL)),
  CHECK (legacy_amount_iqd IS NULL OR (source = 'LEGACY_MIGRATION' AND kind = 'target_profit' AND amount_usd IS NOT NULL))
);

INSERT INTO pricing_rules_new (id, kind, scope, catalog_id, product_id, scope_id, state, amount_usd, amount_iqd, legacy_amount_iqd, legacy_usd_iqd_rate, source, legacy_result_id, version, updated_by, updated_at)
  SELECT id, kind, scope, catalog_id, product_id, scope_id, state, amount_usd, amount_iqd, legacy_amount_iqd, legacy_usd_iqd_rate, source, legacy_result_id, version, updated_by, updated_at FROM pricing_rules;
DROP TABLE pricing_rules;
ALTER TABLE pricing_rules_new RENAME TO pricing_rules;

CREATE INDEX idx_pricing_rules_product ON pricing_rules(product_id) WHERE product_id IS NOT NULL;

CREATE UNIQUE INDEX idx_pricing_rules_target
  ON pricing_rules(kind, scope, IFNULL(catalog_id,''), IFNULL(product_id,''), scope_id);

CREATE TRIGGER pricing_config_rule_del AFTER DELETE ON pricing_rules WHEN OLD.product_id IS NULL
BEGIN UPDATE pricing_engine_control SET config_version = config_version + 1 WHERE id = 1; END;

CREATE TRIGGER pricing_config_rule_ins AFTER INSERT ON pricing_rules WHEN NEW.product_id IS NULL
BEGIN UPDATE pricing_engine_control SET config_version = config_version + 1 WHERE id = 1; END;

CREATE TRIGGER pricing_config_rule_upd AFTER UPDATE ON pricing_rules
WHEN NEW.product_id IS NULL OR OLD.product_id IS NULL
BEGIN UPDATE pricing_engine_control SET config_version = config_version + 1 WHERE id = 1; END;

CREATE TRIGGER pricing_rules_engine_delete BEFORE DELETE ON pricing_rules
WHEN OLD.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || OLD.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;

CREATE TRIGGER pricing_rules_engine_insert BEFORE INSERT ON pricing_rules
WHEN NEW.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;

CREATE TRIGGER pricing_rules_engine_update BEFORE UPDATE ON pricing_rules
WHEN (OLD.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || OLD.product_id))
  OR (NEW.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id))
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;

CREATE TRIGGER pricing_rules_no_reinsert BEFORE INSERT ON pricing_rules
WHEN EXISTS (SELECT 1 FROM pricing_rules r WHERE r.id = NEW.id
                OR (r.kind = NEW.kind AND r.scope = NEW.scope AND IFNULL(r.catalog_id,'') = IFNULL(NEW.catalog_id,'')
                    AND IFNULL(r.product_id,'') = IFNULL(NEW.product_id,'') AND r.scope_id = NEW.scope_id))
BEGIN SELECT RAISE(ABORT, 'PRICING_INPUT_REINSERT'); END;

CREATE TRIGGER pricing_rules_seq_del AFTER DELETE ON pricing_rules WHEN OLD.product_id IS NOT NULL
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = OLD.product_id; END;

CREATE TRIGGER pricing_rules_seq_ins AFTER INSERT ON pricing_rules WHEN NEW.product_id IS NOT NULL
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = NEW.product_id; END;

CREATE TRIGGER pricing_rules_seq_upd AFTER UPDATE ON pricing_rules
WHEN NEW.product_id IS NOT NULL OR OLD.product_id IS NOT NULL
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id IN (OLD.product_id, NEW.product_id); END;

CREATE TRIGGER trg_import_guard_pricing_rules_del BEFORE DELETE ON pricing_rules
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER trg_import_guard_pricing_rules_ins BEFORE INSERT ON pricing_rules
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER trg_import_guard_pricing_rules_upd BEFORE UPDATE ON pricing_rules
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

-- pricing_price_points
CREATE TABLE pricing_price_points_new (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL CHECK (scope IN ('product','option','color','sku')),
  scope_id   TEXT NOT NULL DEFAULT '' CHECK (length(scope_id) <= 400),
  kind       TEXT NOT NULL CHECK (kind IN ('fixed','delta')),
  amount_usd TEXT NOT NULL CHECK (
       (kind = 'fixed' AND amount_usd GLOB '[0-9]*' AND amount_usd NOT GLOB '*[^0-9.]*' AND amount_usd NOT GLOB '*.*.*'
        AND amount_usd NOT GLOB '*.' AND amount_usd NOT GLOB '*.???????*' AND length(amount_usd) <= 13
        AND CAST(amount_usd AS REAL) > 0 AND CAST(amount_usd AS REAL) <= 100000)
    OR (kind = 'delta' AND ltrim(amount_usd,'+-') GLOB '[0-9]*' AND ltrim(amount_usd,'+-') NOT GLOB '*[^0-9.]*'
        AND ltrim(amount_usd,'+-') NOT GLOB '*.*.*' AND ltrim(amount_usd,'+-') NOT GLOB '*.' AND ltrim(amount_usd,'+-') NOT GLOB '*.???????*'
        AND length(amount_usd) - length(ltrim(amount_usd,'+-')) <= 1 AND length(amount_usd) <= 14
        AND CAST(ltrim(amount_usd,'+-') AS REAL) > 0 AND CAST(ltrim(amount_usd,'+-') AS REAL) <= 100000)),
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_id, scope, scope_id),
  CHECK ((scope = 'product') = (scope_id = '')),
  CHECK (scope <> 'product' OR kind = 'fixed'),
  CHECK (scope <> 'color'   OR kind = 'delta'),
  CHECK (scope <> 'sku'     OR kind = 'fixed')
);

INSERT INTO pricing_price_points_new (product_id, scope, scope_id, kind, amount_usd, version, updated_by, updated_at)
  SELECT product_id, scope, scope_id, kind, amount_usd, version, updated_by, updated_at FROM pricing_price_points;
DROP TABLE pricing_price_points;
ALTER TABLE pricing_price_points_new RENAME TO pricing_price_points;

CREATE TRIGGER pricing_price_points_guard_delete BEFORE DELETE ON pricing_price_points
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || OLD.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;

CREATE TRIGGER pricing_price_points_guard_insert BEFORE INSERT ON pricing_price_points
WHEN NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;

CREATE TRIGGER pricing_price_points_guard_update BEFORE UPDATE ON pricing_price_points
WHEN NEW.product_id IS NOT OLD.product_id
  OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;

CREATE TRIGGER pricing_price_points_no_reinsert BEFORE INSERT ON pricing_price_points
WHEN EXISTS (SELECT 1 FROM pricing_price_points p WHERE p.product_id = NEW.product_id AND p.scope = NEW.scope AND p.scope_id = NEW.scope_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_INPUT_REINSERT'); END;

CREATE TRIGGER pricing_price_points_seq_del AFTER DELETE ON pricing_price_points
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = OLD.product_id; END;

CREATE TRIGGER pricing_price_points_seq_ins AFTER INSERT ON pricing_price_points
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = NEW.product_id; END;

CREATE TRIGGER pricing_price_points_seq_upd AFTER UPDATE ON pricing_price_points
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id IN (OLD.product_id, NEW.product_id); END;

CREATE TRIGGER trg_import_guard_pricing_price_points_del BEFORE DELETE ON pricing_price_points
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER trg_import_guard_pricing_price_points_ins BEFORE INSERT ON pricing_price_points
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER trg_import_guard_pricing_price_points_upd BEFORE UPDATE ON pricing_price_points
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

-- pricing_preorder_discounts
CREATE TABLE pricing_preorder_discounts_new (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL CHECK (scope IN ('product','option','color','sku')),
  scope_id   TEXT NOT NULL DEFAULT '' CHECK (length(scope_id) <= 400),
  amount_usd TEXT NOT NULL CHECK (amount_usd GLOB '[0-9]*' AND amount_usd NOT GLOB '*[^0-9.]*' AND amount_usd NOT GLOB '*.*.*'
        AND amount_usd NOT GLOB '*.' AND amount_usd NOT GLOB '*.???????*' AND length(amount_usd) <= 13
        AND CAST(amount_usd AS REAL) >= 0 AND CAST(amount_usd AS REAL) <= 100000),
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_id, scope, scope_id),
  CHECK ((scope = 'product') = (scope_id = ''))
);

INSERT INTO pricing_preorder_discounts_new (product_id, scope, scope_id, amount_usd, version, updated_by, updated_at)
  SELECT product_id, scope, scope_id, amount_usd, version, updated_by, updated_at FROM pricing_preorder_discounts;
DROP TABLE pricing_preorder_discounts;
ALTER TABLE pricing_preorder_discounts_new RENAME TO pricing_preorder_discounts;

CREATE TRIGGER pricing_preorder_discounts_guard_delete BEFORE DELETE ON pricing_preorder_discounts
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || OLD.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;

CREATE TRIGGER pricing_preorder_discounts_guard_insert BEFORE INSERT ON pricing_preorder_discounts
WHEN NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;

CREATE TRIGGER pricing_preorder_discounts_guard_update BEFORE UPDATE ON pricing_preorder_discounts
WHEN NEW.product_id IS NOT OLD.product_id
  OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;

CREATE TRIGGER pricing_preorder_discounts_no_reinsert BEFORE INSERT ON pricing_preorder_discounts
WHEN EXISTS (SELECT 1 FROM pricing_preorder_discounts d WHERE d.product_id = NEW.product_id AND d.scope = NEW.scope AND d.scope_id = NEW.scope_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_INPUT_REINSERT'); END;

CREATE TRIGGER pricing_preorder_discounts_seq_del AFTER DELETE ON pricing_preorder_discounts
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = OLD.product_id; END;

CREATE TRIGGER pricing_preorder_discounts_seq_ins AFTER INSERT ON pricing_preorder_discounts
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = NEW.product_id; END;

CREATE TRIGGER pricing_preorder_discounts_seq_upd AFTER UPDATE ON pricing_preorder_discounts
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id IN (OLD.product_id, NEW.product_id); END;

CREATE TRIGGER trg_import_guard_pricing_preorder_discounts_del BEFORE DELETE ON pricing_preorder_discounts
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER trg_import_guard_pricing_preorder_discounts_ins BEFORE INSERT ON pricing_preorder_discounts
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER trg_import_guard_pricing_preorder_discounts_upd BEFORE UPDATE ON pricing_preorder_discounts
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

-- pricing_v2_sku_results
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
                       AND ltrim(deltas_usd,'+-') NOT GLOB '*.*.*' AND ltrim(deltas_usd,'+-') NOT GLOB '*.' AND ltrim(deltas_usd,'+-') NOT GLOB '*.???????*'
                       AND length(deltas_usd) - length(ltrim(deltas_usd,'+-')) <= 1 AND length(deltas_usd) <= 16),
  discount_usd       TEXT CHECK (discount_usd IS NULL OR (discount_usd GLOB '[0-9]*' AND discount_usd NOT GLOB '*[^0-9.]*' AND discount_usd NOT GLOB '*.*.*'
                       AND discount_usd NOT GLOB '*.' AND discount_usd NOT GLOB '*.???????*' AND length(discount_usd) <= 13
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
                       AND target_profit_usd NOT GLOB '*.*.*' AND target_profit_usd NOT GLOB '*.' AND length(target_profit_usd) <= 13
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

INSERT INTO pricing_v2_sku_results_new (product_id, combo_key, channel, method, anchor, final_price_iqd, exact_iqd, direct_price_iqd, direct_exact_iqd, usd_ceil6, deltas_usd, discount_usd, discount_scope, discount_scope_id, floor, below_cost, below_min_profit, shipping_profile, supplier_currency, fx_rate, fx_version, cross_rate, cross_fx_version, shipping_rate, shipping_version, replacement_exact, replacement_cost_iqd, target_profit_usd, target_rule_id, target_rule_version, usd_iqd_rate, usd_fx_version, inputs_seq, config_version, write_seq, computed_at)
  SELECT product_id, combo_key, channel, method, anchor, final_price_iqd, exact_iqd, direct_price_iqd, direct_exact_iqd, usd_ceil6, deltas_usd, discount_usd, discount_scope, discount_scope_id, floor, below_cost, below_min_profit, shipping_profile, supplier_currency, fx_rate, fx_version, cross_rate, cross_fx_version, shipping_rate, shipping_version, replacement_exact, replacement_cost_iqd, target_profit_usd, target_rule_id, target_rule_version, usd_iqd_rate, usd_fx_version, inputs_seq, config_version, write_seq, computed_at FROM pricing_v2_sku_results;
DROP TABLE pricing_v2_sku_results;
ALTER TABLE pricing_v2_sku_results_new RENAME TO pricing_v2_sku_results;

CREATE INDEX idx_pricing_v2_results_currency ON pricing_v2_sku_results(supplier_currency, product_id);

CREATE TRIGGER pricing_v2_sku_results_delete_guard BEFORE DELETE ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine')
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER pricing_v2_sku_results_insert_guard BEFORE INSERT ON pricing_v2_sku_results
WHEN NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER pricing_v2_sku_results_update_guard BEFORE UPDATE ON pricing_v2_sku_results
WHEN NEW.product_id IS NOT OLD.product_id
  OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER trg_import_guard_pricing_v2_sku_results_del BEFORE DELETE ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER trg_import_guard_pricing_v2_sku_results_ins BEFORE INSERT ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

CREATE TRIGGER trg_import_guard_pricing_v2_sku_results_upd BEFORE UPDATE ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

-- pricing_sku_costs
CREATE TABLE pricing_sku_costs_new (
  product_id                      TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key                       TEXT NOT NULL,
  channel                         TEXT NOT NULL CHECK (channel IN ('direct_sale','pre_order_air','pre_order_sea','pre_order_land')),
  shipping_profile                TEXT NOT NULL CHECK (shipping_profile IN ('GERMANY_LAND','CHINA_AIR','CHINA_SEA')),
  supplier_amount                 TEXT NOT NULL,
  supplier_currency               TEXT NOT NULL CHECK (supplier_currency IN ('USD','EUR','CNY')),
  supplier_input_mode             TEXT NOT NULL CHECK (supplier_input_mode IN ('SOURCE_CURRENCY','IQD_CONVERTED')),
  current_supplier_cost_usd_exact TEXT NOT NULL CHECK ((current_supplier_cost_usd_exact GLOB '[0-9]*' AND current_supplier_cost_usd_exact NOT GLOB '*[^0-9.]*' AND current_supplier_cost_usd_exact NOT GLOB '*.*.*' AND current_supplier_cost_usd_exact NOT GLOB '*.' AND length(current_supplier_cost_usd_exact) <= 48 AND CAST(current_supplier_cost_usd_exact AS REAL) > 0)),
  usd_iqd_rate                    TEXT NOT NULL CHECK ((usd_iqd_rate GLOB '[0-9]*' AND usd_iqd_rate NOT GLOB '*[^0-9.]*' AND usd_iqd_rate NOT GLOB '*.*.*' AND usd_iqd_rate NOT GLOB '*.' AND length(usd_iqd_rate) <= 32 AND CAST(usd_iqd_rate AS REAL) > 0)),
  usd_fx_version                  INTEGER NOT NULL,
  cross_rate                      TEXT CHECK (cross_rate IS NULL OR (cross_rate GLOB '[0-9]*' AND cross_rate NOT GLOB '*[^0-9.]*' AND cross_rate NOT GLOB '*.*.*' AND cross_rate NOT GLOB '*.' AND length(cross_rate) <= 32 AND CAST(cross_rate AS REAL) > 0)),
  cross_fx_version                INTEGER,
  fx_rate                         TEXT NOT NULL CHECK ((fx_rate GLOB '[0-9]*' AND fx_rate NOT GLOB '*[^0-9.]*' AND fx_rate NOT GLOB '*.*.*' AND fx_rate NOT GLOB '*.' AND length(fx_rate) <= 48 AND CAST(fx_rate AS REAL) > 0)),
  fx_version                      INTEGER NOT NULL,
  supplier_cost_iqd               INTEGER NOT NULL CHECK (supplier_cost_iqd >= 0),
  shipping_basis                  TEXT NOT NULL CHECK (shipping_basis IN ('weight','volume')),
  shipping_rate                   TEXT NOT NULL,
  shipping_version                INTEGER NOT NULL,
  effective_weight_g              INTEGER,
  shipping_cbm                    TEXT,
  manual_cbm                      TEXT,
  effective_cbm                   TEXT,
  shipping_cost_iqd               INTEGER NOT NULL CHECK (shipping_cost_iqd >= 0),
  additional_cost_iqd             INTEGER NOT NULL CHECK (additional_cost_iqd >= 0),
  replacement_exact               TEXT NOT NULL,
  replacement_cost_iqd            INTEGER NOT NULL CHECK (replacement_cost_iqd = supplier_cost_iqd + shipping_cost_iqd + additional_cost_iqd),
  target_profit_iqd               INTEGER NOT NULL CHECK (target_profit_iqd > 0),
  target_profit_usd               TEXT CHECK (target_profit_usd IS NULL OR (target_profit_usd GLOB '[0-9]*' AND target_profit_usd NOT GLOB '*[^0-9.]*' AND target_profit_usd NOT GLOB '*.*.*' AND target_profit_usd NOT GLOB '*.' AND length(target_profit_usd) <= 13 AND CAST(target_profit_usd AS REAL) > 0)),
  target_profit_iqd_exact         TEXT NOT NULL CHECK ((target_profit_iqd_exact GLOB '[0-9]*' AND target_profit_iqd_exact NOT GLOB '*[^0-9.]*' AND target_profit_iqd_exact NOT GLOB '*.*.*' AND target_profit_iqd_exact NOT GLOB '*.' AND length(target_profit_iqd_exact) <= 48 AND CAST(target_profit_iqd_exact AS REAL) > 0)),
  shipping_cost_usd               TEXT NOT NULL CHECK ((shipping_cost_usd GLOB '[0-9]*' AND shipping_cost_usd NOT GLOB '*[^0-9.]*' AND shipping_cost_usd NOT GLOB '*.*.*' AND shipping_cost_usd NOT GLOB '*.' AND length(shipping_cost_usd) <= 32)),
  additional_cost_usd             TEXT NOT NULL CHECK ((additional_cost_usd GLOB '[0-9]*' AND additional_cost_usd NOT GLOB '*[^0-9.]*' AND additional_cost_usd NOT GLOB '*.*.*' AND additional_cost_usd NOT GLOB '*.' AND length(additional_cost_usd) <= 32)),
  current_total_cost_usd          TEXT NOT NULL CHECK ((current_total_cost_usd GLOB '[0-9]*' AND current_total_cost_usd NOT GLOB '*[^0-9.]*' AND current_total_cost_usd NOT GLOB '*.*.*' AND current_total_cost_usd NOT GLOB '*.' AND length(current_total_cost_usd) <= 32 AND CAST(current_total_cost_usd AS REAL) > 0)),
  final_price_usd                 TEXT NOT NULL CHECK ((final_price_usd GLOB '[0-9]*' AND final_price_usd NOT GLOB '*[^0-9.]*' AND final_price_usd NOT GLOB '*.*.*' AND final_price_usd NOT GLOB '*.' AND length(final_price_usd) <= 32 AND CAST(final_price_usd AS REAL) > 0)),
  target_rule_id                  TEXT NOT NULL,
  target_rule_version             INTEGER NOT NULL,
  direct_sale_extra_iqd           INTEGER CHECK (direct_sale_extra_iqd IS NULL OR (channel = 'direct_sale' AND direct_sale_extra_iqd >= 0)),
  extra_rule_id                   TEXT,
  extra_rule_version              INTEGER,
  rule_catalog_id                 TEXT,
  config_version                  INTEGER NOT NULL,
  inputs_seq                      INTEGER NOT NULL DEFAULT 0,
  rounding_step_iqd               INTEGER NOT NULL CHECK (rounding_step_iqd > 0),
  preorder_base_iqd               INTEGER NOT NULL,
  computed_price_iqd              INTEGER NOT NULL CHECK (computed_price_iqd > 0),
  pricing_revision                INTEGER,
  computed_at                     TEXT NOT NULL,
  PRIMARY KEY (product_id, combo_key, channel),
  CHECK ((supplier_currency = 'USD') = (cross_rate IS NULL)),
  CHECK ((cross_rate IS NULL) = (cross_fx_version IS NULL)),
  CHECK ((extra_rule_id IS NULL) = (extra_rule_version IS NULL)),
  -- floor(T_exact), exactly: the whole part of the decimal text.
  CHECK (target_profit_iqd = CAST(CASE WHEN instr(target_profit_iqd_exact, '.') > 0
                                       THEN substr(target_profit_iqd_exact, 1, instr(target_profit_iqd_exact, '.') - 1)
                                       ELSE target_profit_iqd_exact END AS INTEGER)),
  CHECK (computed_price_iqd - replacement_cost_iqd >= target_profit_iqd),
  CHECK (computed_price_iqd % rounding_step_iqd = 0),
  CHECK (preorder_base_iqd % rounding_step_iqd = 0 AND preorder_base_iqd >= rounding_step_iqd),
  CHECK (computed_price_iqd = preorder_base_iqd + COALESCE(direct_sale_extra_iqd, 0)),
  CHECK (channel <> 'direct_sale' OR computed_price_iqd - preorder_base_iqd >= COALESCE(direct_sale_extra_iqd, 0)),
  CHECK (computed_price_iqd - replacement_cost_iqd - target_profit_iqd - COALESCE(direct_sale_extra_iqd, 0)
         BETWEEN 0 AND rounding_step_iqd)
);

INSERT INTO pricing_sku_costs_new (product_id, combo_key, channel, shipping_profile, supplier_amount, supplier_currency, supplier_input_mode, current_supplier_cost_usd_exact, usd_iqd_rate, usd_fx_version, cross_rate, cross_fx_version, fx_rate, fx_version, supplier_cost_iqd, shipping_basis, shipping_rate, shipping_version, effective_weight_g, shipping_cbm, manual_cbm, effective_cbm, shipping_cost_iqd, additional_cost_iqd, replacement_exact, replacement_cost_iqd, target_profit_iqd, target_profit_usd, target_profit_iqd_exact, shipping_cost_usd, additional_cost_usd, current_total_cost_usd, final_price_usd, target_rule_id, target_rule_version, direct_sale_extra_iqd, extra_rule_id, extra_rule_version, rule_catalog_id, config_version, inputs_seq, rounding_step_iqd, preorder_base_iqd, computed_price_iqd, pricing_revision, computed_at)
  SELECT product_id, combo_key, channel, shipping_profile, supplier_amount, supplier_currency, supplier_input_mode, current_supplier_cost_usd_exact, usd_iqd_rate, usd_fx_version, cross_rate, cross_fx_version, fx_rate, fx_version, supplier_cost_iqd, shipping_basis, shipping_rate, shipping_version, effective_weight_g, shipping_cbm, manual_cbm, effective_cbm, shipping_cost_iqd, additional_cost_iqd, replacement_exact, replacement_cost_iqd, target_profit_iqd, target_profit_usd, target_profit_iqd_exact, shipping_cost_usd, additional_cost_usd, current_total_cost_usd, final_price_usd, target_rule_id, target_rule_version, direct_sale_extra_iqd, extra_rule_id, extra_rule_version, rule_catalog_id, config_version, inputs_seq, rounding_step_iqd, preorder_base_iqd, computed_price_iqd, pricing_revision, computed_at FROM pricing_sku_costs;
DROP TABLE pricing_sku_costs;
ALTER TABLE pricing_sku_costs_new RENAME TO pricing_sku_costs;

CREATE INDEX idx_pricing_sku_costs_currency ON pricing_sku_costs(supplier_currency, product_id);

CREATE INDEX idx_pricing_sku_costs_fx ON pricing_sku_costs(supplier_currency, fx_version);

CREATE INDEX idx_pricing_sku_costs_profile ON pricing_sku_costs(shipping_profile, product_id);
