-- 0189 — PRICING V2 CORE: THE METHOD, THE DOLLAR PRICE POINTS, THE ONE PRE-ORDER DISCOUNT, THE PRIVATE
-- V2 RESULTS AND THE LEGACY SNAPSHOT (docs/PRICING-V2.md; owner decisions A1, B1, C1, D1 and the §7
-- defaults, DECISIONS row 221; implementation spec §2, design calls C-1 … C-3).
--
-- ADDITIVE ONLY: new tables and triggers, and two nullable columns on product_pricing_state. Updates or
-- deletes no existing row, changes no price, names no accounting table (orders, order_items, wallet_*,
-- gift_*, inventory_lots).
--
-- INERT UNTIL A PRODUCT IS V2. A product is V2 when product_pricing_state.mode = 'engine' AND
-- pricing_method IS NOT NULL (C-1); no row holds a method until the owner's migration confirm or a
-- product created new in V2. Every 0181/0183/0188 ENGINE_MANAGED lock already keys on mode = 'engine',
-- so it covers V2 products unchanged. No code reads or writes these tables yet (V2-3 does).
--
-- PRIVATE (owner only; never joined by a public read; never SELECT *): pricing_price_points,
-- pricing_preorder_discounts, pricing_v2_sku_results, pricing_legacy_snapshots. The one public V2
-- figure stays the final IQD price in product_sku_prices (0183), where the option-less product's key is
-- the sentinel 'o:*' (C-3; that CHECK already accepts it, so no rebuild), and option id '*' is reserved.
--
-- Every freeze is an UPDATE/DELETE trigger PLUS a BEFORE INSERT "no re-insert" trigger (SQLite's INSERT
-- OR REPLACE fires neither), as in 0181. Decimal CHECKs are written out in full. A space always
-- separates a CASE's END from a closing parenthesis (tests/sqlSplit.test.ts).

-- 1. The method (A1). 'cost' = «من التكلفة», 'usd' = «سعر بالدولار». It is set, changed or cleared only in
--    a batch holding 'pricing-mode:<product_id>' (the 0181 mode token), and only on an engine product;
--    the second arm of the update trigger means a V2 product cannot drop to manual through the old exit
--    door, even from an older Worker. v2_since records the first V2 write (migration or create).
ALTER TABLE product_pricing_state ADD COLUMN pricing_method TEXT
  CHECK (pricing_method IS NULL OR pricing_method IN ('cost','usd'));
ALTER TABLE product_pricing_state ADD COLUMN v2_since TEXT;
CREATE TRIGGER IF NOT EXISTS product_pricing_state_method_insert BEFORE INSERT ON product_pricing_state
WHEN NEW.pricing_method IS NOT NULL
 AND (NEW.mode <> 'engine' OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'pricing-mode:' || NEW.product_id))
BEGIN SELECT RAISE(ABORT, 'PRICING_MODE_ENGINE_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS product_pricing_state_method_update BEFORE UPDATE OF pricing_method, mode ON product_pricing_state
WHEN (NEW.pricing_method IS NOT OLD.pricing_method AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'pricing-mode:' || NEW.product_id))
  OR (NEW.pricing_method IS NOT NULL AND NEW.mode <> 'engine')
BEGIN SELECT RAISE(ABORT, 'PRICING_MODE_ENGINE_ONLY'); END;

-- 2. The dollar price points (A1, C1). One row per scope: the product's fixed USD price (price-first
--    anchor), a model's fixed USD price or its ± USD difference, a colour's ± USD difference (the same
--    on every model), an SKU's fixed USD price. USD text: ≤ 2 decimals, ≤ 100,000; a difference may be
--    signed and is never 0. Written only by the V2 writer and the migration (token 'engine-price:').
CREATE TABLE IF NOT EXISTS pricing_price_points (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL CHECK (scope IN ('product','option','color','sku')),
  scope_id   TEXT NOT NULL DEFAULT '' CHECK (length(scope_id) <= 400),
  kind       TEXT NOT NULL CHECK (kind IN ('fixed','delta')),
  amount_usd TEXT NOT NULL CHECK (
       (kind = 'fixed' AND amount_usd GLOB '[0-9]*' AND amount_usd NOT GLOB '*[^0-9.]*' AND amount_usd NOT GLOB '*.*.*'
        AND amount_usd NOT GLOB '*.' AND amount_usd NOT GLOB '*.???*' AND length(amount_usd) <= 9
        AND CAST(amount_usd AS REAL) > 0 AND CAST(amount_usd AS REAL) <= 100000)
    OR (kind = 'delta' AND ltrim(amount_usd,'+-') GLOB '[0-9]*' AND ltrim(amount_usd,'+-') NOT GLOB '*[^0-9.]*'
        AND ltrim(amount_usd,'+-') NOT GLOB '*.*.*' AND ltrim(amount_usd,'+-') NOT GLOB '*.' AND ltrim(amount_usd,'+-') NOT GLOB '*.???*'
        AND length(amount_usd) - length(ltrim(amount_usd,'+-')) <= 1 AND length(amount_usd) <= 10
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
CREATE TRIGGER IF NOT EXISTS pricing_price_points_no_reinsert BEFORE INSERT ON pricing_price_points
WHEN EXISTS (SELECT 1 FROM pricing_price_points p WHERE p.product_id = NEW.product_id AND p.scope = NEW.scope AND p.scope_id = NEW.scope_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_INPUT_REINSERT'); END;
CREATE TRIGGER IF NOT EXISTS pricing_price_points_guard_insert BEFORE INSERT ON pricing_price_points
WHEN NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS pricing_price_points_guard_update BEFORE UPDATE ON pricing_price_points
WHEN NEW.product_id IS NOT OLD.product_id
  OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;
-- A cascade (the product row already gone) passes; productDeletion.ts holds the token for its explicit delete.
CREATE TRIGGER IF NOT EXISTS pricing_price_points_guard_delete BEFORE DELETE ON pricing_price_points
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || OLD.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS pricing_price_points_seq_ins AFTER INSERT ON pricing_price_points
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = NEW.product_id; END;
CREATE TRIGGER IF NOT EXISTS pricing_price_points_seq_upd AFTER UPDATE ON pricing_price_points
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id IN (OLD.product_id, NEW.product_id); END;
CREATE TRIGGER IF NOT EXISTS pricing_price_points_seq_del AFTER DELETE ON pricing_price_points
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = OLD.product_id; END;

-- 3. The one pre-order discount Δ (B1): one USD amount for every route, at the product or as an exception
--    for a model, a colour or an SKU. ≥ 0, ≤ 2 decimals, ≤ 100,000; 0 is an explicit «no discount»
--    exception that overrides the product's Δ. No route column (B1): B2 would get its own table.
CREATE TABLE IF NOT EXISTS pricing_preorder_discounts (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL CHECK (scope IN ('product','option','color','sku')),
  scope_id   TEXT NOT NULL DEFAULT '' CHECK (length(scope_id) <= 400),
  amount_usd TEXT NOT NULL CHECK (amount_usd GLOB '[0-9]*' AND amount_usd NOT GLOB '*[^0-9.]*' AND amount_usd NOT GLOB '*.*.*'
        AND amount_usd NOT GLOB '*.' AND amount_usd NOT GLOB '*.???*' AND length(amount_usd) <= 9
        AND CAST(amount_usd AS REAL) >= 0 AND CAST(amount_usd AS REAL) <= 100000),
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_id, scope, scope_id),
  CHECK ((scope = 'product') = (scope_id = ''))
);
CREATE TRIGGER IF NOT EXISTS pricing_preorder_discounts_no_reinsert BEFORE INSERT ON pricing_preorder_discounts
WHEN EXISTS (SELECT 1 FROM pricing_preorder_discounts d WHERE d.product_id = NEW.product_id AND d.scope = NEW.scope AND d.scope_id = NEW.scope_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_INPUT_REINSERT'); END;
CREATE TRIGGER IF NOT EXISTS pricing_preorder_discounts_guard_insert BEFORE INSERT ON pricing_preorder_discounts
WHEN NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS pricing_preorder_discounts_guard_update BEFORE UPDATE ON pricing_preorder_discounts
WHEN NEW.product_id IS NOT OLD.product_id
  OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS pricing_preorder_discounts_guard_delete BEFORE DELETE ON pricing_preorder_discounts
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || OLD.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS pricing_preorder_discounts_seq_ins AFTER INSERT ON pricing_preorder_discounts
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = NEW.product_id; END;
CREATE TRIGGER IF NOT EXISTS pricing_preorder_discounts_seq_upd AFTER UPDATE ON pricing_preorder_discounts
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id IN (OLD.product_id, NEW.product_id); END;
CREATE TRIGGER IF NOT EXISTS pricing_preorder_discounts_seq_del AFTER DELETE ON pricing_preorder_discounts
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = OLD.product_id; END;

-- 4. The V2 writer's private figures per SKU × channel (C-2). A new table, not pricing_sku_costs: its
--    0181 CHECKs cannot hold a price-first row (supplier, profile and rule are NOT NULL), a pre-order row
--    whose Δ exceeds the rounding slack, or Δ at all. combo_key is canonical ('' = the product itself).
--    The stored backstops: P ≤ D; direct_sale carries no Δ and sells at D; price-first never floors
--    (C-6); a cost-first row names its replacement cost and its minimum-profit rule. Exact figures are
--    decimal text, never a float. Guards follow 0183 (ENGINE_MANAGED, same tokens).
CREATE TABLE IF NOT EXISTS pricing_v2_sku_results (
  product_id         TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key          TEXT NOT NULL CHECK (length(combo_key) <= 400 AND (combo_key = '' OR combo_key GLOB 'o:?*' OR combo_key GLOB 'c:?*')),
  channel            TEXT NOT NULL CHECK (channel IN ('direct_sale','pre_order_air','pre_order_sea','pre_order_land')),
  method             TEXT NOT NULL CHECK (method IN ('cost','usd')),
  anchor             TEXT NOT NULL CHECK (anchor IN ('sku_fixed','model_fixed','product_fixed','cost')),
  final_price_iqd    INTEGER NOT NULL CHECK (final_price_iqd BETWEEN 1000 AND 100000000000 AND final_price_iqd % 1000 = 0),
  exact_iqd          TEXT NOT NULL CHECK (exact_iqd GLOB '[0-9]*' AND exact_iqd NOT GLOB '*[^0-9.]*' AND exact_iqd NOT GLOB '*.*.*'
                       AND exact_iqd NOT GLOB '*.' AND length(exact_iqd) <= 48 AND CAST(exact_iqd AS REAL) > 0),
  direct_price_iqd   INTEGER NOT NULL CHECK (direct_price_iqd BETWEEN 1000 AND 100000000000 AND direct_price_iqd % 1000 = 0),
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
  floor              TEXT NOT NULL DEFAULT 'none' CHECK (floor IN ('none','discount_withdrawn','lifted_to_cost','direct_min_profit')),
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
  CHECK (method = 'usd' OR (replacement_exact IS NOT NULL AND target_rule_id IS NOT NULL)),
  CHECK ((discount_scope IS NULL) = (discount_scope_id IS NULL)),
  CHECK ((replacement_exact IS NULL) = (replacement_cost_iqd IS NULL)),
  CHECK ((fx_rate IS NULL) = (fx_version IS NULL)),
  CHECK ((cross_rate IS NULL) = (cross_fx_version IS NULL)),
  CHECK ((shipping_rate IS NULL) = (shipping_version IS NULL)),
  CHECK ((target_rule_id IS NULL) = (target_rule_version IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_pricing_v2_results_currency ON pricing_v2_sku_results(supplier_currency, product_id);
CREATE TRIGGER IF NOT EXISTS pricing_v2_sku_results_insert_guard BEFORE INSERT ON pricing_v2_sku_results
WHEN NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
CREATE TRIGGER IF NOT EXISTS pricing_v2_sku_results_update_guard BEFORE UPDATE ON pricing_v2_sku_results
WHEN NEW.product_id IS NOT OLD.product_id
  OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
-- As 0183: refused while the product exists AND is engine-priced; productDeletion.ts removes the state
-- row first, and a cascade (the product row already gone) passes.
CREATE TRIGGER IF NOT EXISTS pricing_v2_sku_results_delete_guard BEFORE DELETE ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine')
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

-- 5. The legacy snapshot taken at the owner's migration confirm (spec §3 step 1, §2.5): every legacy
--    money field of the product, read by explicit column lists, so V2-7's rollback tool can restore it.
--    APPEND-ONLY: never updated, never re-inserted under an id, never deleted while the product exists —
--    except by the permanent product deletion itself, which holds 'product-delete:<product_id>' inside
--    its own batch (worker/lib/productDeletion.ts). A cascade (the product row already gone) passes.
CREATE TABLE IF NOT EXISTS pricing_legacy_snapshots (
  id              TEXT PRIMARY KEY,
  product_id      TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL CHECK (reason IN ('v2_migration')),
  captured_at     TEXT NOT NULL,
  usd_iqd_rate    TEXT NOT NULL CHECK (usd_iqd_rate GLOB '[0-9]*' AND usd_iqd_rate NOT GLOB '*[^0-9.]*' AND usd_iqd_rate NOT GLOB '*.*.*'
                    AND usd_iqd_rate NOT GLOB '*.' AND length(usd_iqd_rate) <= 32 AND CAST(usd_iqd_rate AS REAL) > 0),
  fx_version      INTEGER NOT NULL CHECK (fx_version > 0),
  actor           TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version = 1),
  payload_json    TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 1000000),
  payload_sha256  TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX IF NOT EXISTS idx_pricing_legacy_snapshots_product ON pricing_legacy_snapshots(product_id, captured_at);
CREATE TRIGGER IF NOT EXISTS pricing_legacy_snapshots_immutable BEFORE UPDATE ON pricing_legacy_snapshots
BEGIN SELECT RAISE(ABORT, 'PRICING_SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS pricing_legacy_snapshots_no_reinsert BEFORE INSERT ON pricing_legacy_snapshots
WHEN EXISTS (SELECT 1 FROM pricing_legacy_snapshots s WHERE s.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'PRICING_SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS pricing_legacy_snapshots_no_delete BEFORE DELETE ON pricing_legacy_snapshots
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'product-delete:' || OLD.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_SNAPSHOT_IMMUTABLE'); END;

-- 6. Fees stay 0 on a V2 product (PRICING-V2 §1.9): no direct-sale surcharge, and every route listed in
--    preorder_transports carries an explicit commission_iqd of 0. The JSON column has no 0181 lock, so
--    this is its only guard. A route without commission_iqd counts as non-zero, because the resolver
--    would fall back to the admin default (packages/pricing/src/pricing.ts, the commission ladder).
CREATE TRIGGER IF NOT EXISTS v2_lock_product_fees BEFORE UPDATE OF preorder_transports, direct_surcharge_iqd ON products
WHEN EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.id AND s.mode = 'engine' AND s.pricing_method IS NOT NULL)
 AND ((NEW.direct_surcharge_iqd IS NOT NULL AND NEW.direct_surcharge_iqd <> 0)
   OR (json_valid(NEW.preorder_transports) AND EXISTS (SELECT 1 FROM json_each(NEW.preorder_transports) t
        WHERE json_type(t.value) = 'object' AND COALESCE(json_extract(t.value, '$.commission_iqd'), -1) <> 0)))
BEGIN SELECT RAISE(ABORT, 'PRICING_V2_FEES_RETIRED'); END;

-- 7. The reserved option id (C-3): '*' would make an option value whose key is the option-less product's
--    stored key 'o:*'. The relations planner refuses it too (worker/lib/productPersistence.ts).
CREATE TRIGGER IF NOT EXISTS v2_reserved_option_id BEFORE INSERT ON product_option_values
WHEN NEW.id = '*'
BEGIN SELECT RAISE(ABORT, 'OPTION_ID_RESERVED'); END;
