-- 0181 — THE PRICING ENGINE CORE, MINIMUM PROFIT IN USD (FX programme plan §4.2, amended by the owner's
-- decisions 6 and 8 of 2026-10-09; USD procurement design §10; owner brief 2026-10-09).
-- ADDITIVE ONLY: new tables and triggers; nullable or defaulted columns on price_history, order_items,
-- price_protection_claims and purchase_charges. Updates or deletes no existing row of orders,
-- order_items, wallet_*, gift_*, inventory_lots, purchase_* or incoming_inventory, and changes no price.
-- INERT UNTIL A PRODUCT IS ENGINE-PRICED: every ENGINE_MANAGED lock and input guard first asks
-- product_pricing_state for mode = 'engine', which no row holds until the owner's adopting save.
-- PRIVATE (owner only; never joined by a public read; never SELECT *): pricing_engine_control,
-- product_pricing_state, pricing_inputs, pricing_rules, pricing_sku_costs, pricing_audit.
-- Every freeze is an UPDATE/DELETE trigger PLUS a BEFORE INSERT "no re-insert" trigger (SQLite's
-- INSERT OR REPLACE fires neither), so no writer uses OR IGNORE / OR REPLACE / ON CONFLICT on a frozen
-- table, and the one seed is a NOT EXISTS-guarded INSERT … SELECT (migrate-check --twice re-runs it).
-- Decimal CHECKs are written out in full (FX plan §4 DEC_POS / DEC_SIGNED; SQLite has no macros).
-- A space always separates a CASE's END from a closing parenthesis (tests/sqlSplit.test.ts).
--
-- NOT INSTALLED HERE, ON PURPOSE: the FX plan's pricing_fx_rate_guard / pricing_shipping_rate_guard
-- (a rate may move only in a batch that also reprices). Automatic repricing (FX-5) is not part of this
-- build (owner priority 2026-10-09): a confirmed rate still moves, and the engine-priced products it
-- leaves stale are listed for the owner to preview and save. The guard ships with its writer.

-- 1. The control row (MVP part 4 WITHOUT the gate columns — owner decision 8: the completing save adopts).
CREATE TABLE IF NOT EXISTS pricing_engine_control (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  revision                INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  config_version          INTEGER NOT NULL DEFAULT 0 CHECK (config_version >= 0),
  paused                  INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  paused_reason           TEXT NOT NULL DEFAULT '' CHECK (length(paused_reason) <= 200),
  large_change_pct        INTEGER NOT NULL DEFAULT 15 CHECK (large_change_pct BETWEEN 1 AND 100),
  max_drop_pct            INTEGER NOT NULL DEFAULT 30 CHECK (max_drop_pct BETWEEN 1 AND 100),
  new_products_use_engine INTEGER NOT NULL DEFAULT 0 CHECK (new_products_use_engine IN (0, 1)),
  updated_by              TEXT NOT NULL DEFAULT '',
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO pricing_engine_control (id)
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pricing_engine_control c WHERE c.id = 1);
CREATE TRIGGER IF NOT EXISTS pricing_engine_control_no_delete BEFORE DELETE ON pricing_engine_control
BEGIN SELECT RAISE(ABORT, 'PRICING_CONTROL_PERMANENT'); END;

-- 2. Per-product engine state (MVP P2 "Added", plus the M6 reprice-blocked pair). mode flips ONLY in a
--    batch holding 'pricing-mode:<product_id>'. inputs_seq is bumped by the triggers of part 5; code
--    inserts the row when the product's first input or rule is written (never a trigger, so a cascade
--    delete never inserts a child of a product being deleted). A work queue, not a freeze: no
--    re-insert trigger, upserts are allowed.
CREATE TABLE IF NOT EXISTS product_pricing_state (
  product_id            TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  mode                  TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','engine')),
  inputs_seq            INTEGER NOT NULL DEFAULT 0 CHECK (inputs_seq >= 0),
  write_seq             INTEGER NOT NULL DEFAULT 0 CHECK (write_seq >= 0),
  priced_config_version INTEGER,
  priced_inputs_seq     INTEGER,
  priced_at             TEXT,
  rule_catalog_id       TEXT,
  opted_in_at           TEXT,
  opted_in_by           TEXT,
  opted_out_at          TEXT,
  opted_out_by          TEXT,
  activation_audit_id   TEXT,
  reprice_blocked_code  TEXT CHECK (reprice_blocked_code IS NULL OR (length(reprice_blocked_code) <= 40 AND reprice_blocked_code NOT GLOB '*[^A-Z0-9_]*')),
  reprice_blocked_at    TEXT,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((reprice_blocked_code IS NULL) = (reprice_blocked_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_product_pricing_state_engine ON product_pricing_state(mode) WHERE mode = 'engine';
CREATE TRIGGER IF NOT EXISTS product_pricing_state_mode_insert BEFORE INSERT ON product_pricing_state
WHEN NEW.mode <> 'manual'
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'pricing-mode:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_MODE_ENGINE_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS product_pricing_state_mode_update BEFORE UPDATE OF mode, product_id ON product_pricing_state
WHEN NEW.product_id IS NOT OLD.product_id
  OR (NEW.mode IS NOT OLD.mode AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'pricing-mode:' || NEW.product_id))
BEGIN SELECT RAISE(ABORT, 'PRICING_MODE_ENGINE_ONLY'); END;

-- 3. The append-only pricing audit (v2 part 9, F8 re-insert guard). Values live HERE, never in
--    audit_log. Lists: v2's without the GATE (owner decision 8), plus the FX actions (FX plan §4.2)
--    and the USD design's (§6.4) and this build's (legacy accept, conversion, exit).
CREATE TABLE IF NOT EXISTS pricing_audit (
  id                  TEXT PRIMARY KEY,
  entity              TEXT NOT NULL CHECK (entity IN ('fx','shipping','rule','input','sku_price','engine_mode',
                        'product_write','run','preview','engine','rule_category','migration','fx_pair')),
  entity_key          TEXT NOT NULL,
  product_id          TEXT,
  run_id              TEXT,
  action              TEXT NOT NULL CHECK (action IN ('seed','create','update','delete','pin','unpin','enable','disable',
                        'recompute','hide','republish','run_created','run_finished','run_cancelled','change_applied',
                        'pause','resume','confirm','mark_erroneous','approve_drops',
                        'migrate_commit','migrate_refresh','migrate_resolution','migrate_switch',
                        'fx_apply','fx_review_approved','fx_review_rejected','fx_manual_set','reprice_auto',
                        'input_from_purchase','rule_set','engine_entry','reprice_owner',
                        'legacy_accept','rule_convert','engine_exit')),
  version             INTEGER,
  pricing_before_json TEXT CHECK (pricing_before_json IS NULL OR json_valid(pricing_before_json)),
  pricing_after_json  TEXT CHECK (pricing_after_json IS NULL OR json_valid(pricing_after_json)),
  summary_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
  reason              TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  pricing_revision    INTEGER,
  idempotency_key     TEXT,
  actor_id            TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pricing_audit_entity ON pricing_audit(entity, entity_key, created_at);
CREATE INDEX IF NOT EXISTS idx_pricing_audit_product ON pricing_audit(product_id, created_at) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pricing_audit_run ON pricing_audit(run_id, created_at) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_audit_idem ON pricing_audit(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS pricing_audit_immutable BEFORE UPDATE ON pricing_audit
BEGIN SELECT RAISE(ABORT, 'PRICING_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS pricing_audit_no_delete BEFORE DELETE ON pricing_audit
BEGIN SELECT RAISE(ABORT, 'PRICING_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS pricing_audit_no_reinsert BEFORE INSERT ON pricing_audit
WHEN EXISTS (SELECT 1 FROM pricing_audit a WHERE a.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'PRICING_AUDIT_IMMUTABLE'); END;

-- 4. Private inputs per scope (FX plan §4.2 part 5, verbatim): supplier cost in its own currency, the
--    IQD convenience snapshot, measures, additional cost. Colour/sku scopes are stored from FX-7 on
--    (code refuses them before).
CREATE TABLE IF NOT EXISTS pricing_inputs (
  product_id                  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope                       TEXT NOT NULL CHECK (scope IN ('base','option','color','sku')),
  scope_id                    TEXT NOT NULL DEFAULT '',
  origin                      TEXT NOT NULL DEFAULT 'MANUAL_OVERRIDE' CHECK (origin IN ('SOURCE','MANUAL_OVERRIDE')),
  supplier_cost_amount        TEXT CHECK (supplier_cost_amount IS NULL OR (supplier_cost_amount GLOB '[0-9]*' AND supplier_cost_amount NOT GLOB '*[^0-9.]*' AND supplier_cost_amount NOT GLOB '*.*.*' AND supplier_cost_amount NOT GLOB '*.' AND length(supplier_cost_amount) <= 24 AND CAST(supplier_cost_amount AS REAL) > 0)),
  supplier_cost_delta         TEXT CHECK (supplier_cost_delta IS NULL OR (ltrim(supplier_cost_delta,'+-') GLOB '[0-9]*' AND ltrim(supplier_cost_delta,'+-') NOT GLOB '*[^0-9.]*' AND ltrim(supplier_cost_delta,'+-') NOT GLOB '*.*.*' AND ltrim(supplier_cost_delta,'+-') NOT GLOB '*.' AND length(supplier_cost_delta) - length(ltrim(supplier_cost_delta,'+-')) <= 1 AND length(supplier_cost_delta) <= 25)),
  supplier_cost_currency      TEXT CHECK (supplier_cost_currency IS NULL OR supplier_cost_currency IN ('USD','EUR','CNY')),
  supplier_input_mode         TEXT CHECK (supplier_input_mode IS NULL OR supplier_input_mode IN ('SOURCE_CURRENCY','IQD_CONVERTED')),
  original_input_amount       TEXT CHECK (original_input_amount IS NULL OR (original_input_amount GLOB '[1-9]*'
                                AND original_input_amount NOT GLOB '*[^0-9]*' AND length(original_input_amount) <= 13)),
  original_input_currency     TEXT CHECK (original_input_currency IS NULL OR original_input_currency = 'IQD'),
  conversion_rate_snapshot    TEXT CHECK (conversion_rate_snapshot IS NULL OR (conversion_rate_snapshot GLOB '[0-9]*' AND conversion_rate_snapshot NOT GLOB '*[^0-9.]*' AND conversion_rate_snapshot NOT GLOB '*.*.*' AND conversion_rate_snapshot NOT GLOB '*.' AND length(conversion_rate_snapshot) <= 32 AND CAST(conversion_rate_snapshot AS REAL) > 0)),
  conversion_fx_version       INTEGER CHECK (conversion_fx_version IS NULL OR conversion_fx_version > 0),
  canonical_supplier_cost_usd TEXT CHECK (canonical_supplier_cost_usd IS NULL OR (canonical_supplier_cost_usd GLOB '[0-9]*' AND canonical_supplier_cost_usd NOT GLOB '*[^0-9.]*' AND canonical_supplier_cost_usd NOT GLOB '*.*.*' AND canonical_supplier_cost_usd NOT GLOB '*.' AND length(canonical_supplier_cost_usd) <= 24 AND CAST(canonical_supplier_cost_usd AS REAL) > 0)),
  converted_at                TEXT,
  shipping_profile    TEXT CHECK (shipping_profile IS NULL OR shipping_profile IN ('GERMANY_LAND','CHINA_AIR','CHINA_SEA')),
  pricing_weight_g    INTEGER CHECK (pricing_weight_g IS NULL OR pricing_weight_g BETWEEN 1 AND 100000000),
  shipping_weight_g   INTEGER CHECK (shipping_weight_g IS NULL OR shipping_weight_g BETWEEN 1 AND 100000000),
  shipping_length_mm  INTEGER CHECK (shipping_length_mm IS NULL OR shipping_length_mm BETWEEN 1 AND 100000),
  shipping_width_mm   INTEGER CHECK (shipping_width_mm IS NULL OR shipping_width_mm BETWEEN 1 AND 100000),
  shipping_height_mm  INTEGER CHECK (shipping_height_mm IS NULL OR shipping_height_mm BETWEEN 1 AND 100000),
  manual_cbm          TEXT CHECK (manual_cbm IS NULL OR (manual_cbm GLOB '[0-9]*' AND manual_cbm NOT GLOB '*[^0-9.]*' AND manual_cbm NOT GLOB '*.*.*' AND manual_cbm NOT GLOB '*.' AND length(manual_cbm) <= 12 AND CAST(manual_cbm AS REAL) > 0)),
  additional_cost_iqd INTEGER CHECK (additional_cost_iqd IS NULL OR additional_cost_iqd BETWEEN 0 AND 1000000000),
  unresolved_fields   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unresolved_fields) AND json_type(unresolved_fields) = 'array'),
  source_ref          TEXT NOT NULL DEFAULT '',
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by          TEXT,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (product_id, scope, scope_id, origin),
  CHECK ((scope = 'base') = (scope_id = '')),
  CHECK (supplier_cost_amount IS NULL OR supplier_cost_delta IS NULL),
  CHECK (supplier_cost_amount IS NULL OR supplier_cost_currency IS NOT NULL),
  -- M7: a delta always names its currency, so a later base-currency change cannot silently
  -- re-denominate it (E1 costToPrice.ts lets a NULL-currency delta take the base's currency).
  CHECK (supplier_cost_delta IS NULL OR supplier_cost_currency IS NOT NULL),
  CHECK ((supplier_cost_amount IS NULL AND supplier_cost_delta IS NULL) = (supplier_input_mode IS NULL)),
  CHECK ((supplier_input_mode = 'IQD_CONVERTED') = (original_input_currency IS NOT NULL)),
  CHECK (supplier_input_mode IS NOT 'IQD_CONVERTED' OR (supplier_cost_currency = 'USD'
         AND supplier_cost_amount IS NOT NULL AND canonical_supplier_cost_usd = supplier_cost_amount
         AND original_input_amount IS NOT NULL AND conversion_rate_snapshot IS NOT NULL
         AND conversion_fx_version IS NOT NULL AND converted_at IS NOT NULL)),
  CHECK (supplier_input_mode = 'IQD_CONVERTED' OR (original_input_amount IS NULL AND conversion_rate_snapshot IS NULL
         AND conversion_fx_version IS NULL AND canonical_supplier_cost_usd IS NULL AND converted_at IS NULL)),
  CHECK (origin = 'SOURCE' OR unresolved_fields = '[]')
);
CREATE INDEX IF NOT EXISTS idx_pricing_inputs_currency ON pricing_inputs(supplier_cost_currency) WHERE supplier_cost_currency IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pricing_inputs_profile ON pricing_inputs(shipping_profile) WHERE shipping_profile IS NOT NULL;
-- F8: REPLACE / OR IGNORE / upsert on an existing input are refused. The store writes a new row
-- with a plain INSERT and an existing one with a version-fenced UPDATE (never ON CONFLICT).
CREATE TRIGGER IF NOT EXISTS pricing_inputs_no_reinsert BEFORE INSERT ON pricing_inputs
WHEN EXISTS (SELECT 1 FROM pricing_inputs i WHERE i.product_id = NEW.product_id AND i.scope = NEW.scope
             AND i.scope_id = NEW.scope_id AND i.origin = NEW.origin)
BEGIN SELECT RAISE(ABORT, 'PRICING_INPUT_REINSERT'); END;
-- §13 (critique H3): once an IQD entry is converted, its cost columns change ONLY in a batch that
-- carries the owner-input token 'pricing-input-owner:<product_id>' (inserted and deleted in the same
-- batch by the owner's write), and a row that stays IQD_CONVERTED must carry a NEWER converted_at. A
-- scheduler, repricer or readiness path has no token, so even a "real" re-conversion is refused.
CREATE TRIGGER IF NOT EXISTS pricing_inputs_iqd_snapshot_frozen
BEFORE UPDATE OF supplier_cost_amount, supplier_cost_delta, supplier_cost_currency, supplier_input_mode, original_input_amount,
  original_input_currency, conversion_rate_snapshot, conversion_fx_version, canonical_supplier_cost_usd, converted_at ON pricing_inputs
WHEN OLD.supplier_input_mode = 'IQD_CONVERTED'
 AND (NEW.supplier_cost_amount IS NOT OLD.supplier_cost_amount OR NEW.supplier_cost_delta IS NOT OLD.supplier_cost_delta
   OR NEW.supplier_cost_currency IS NOT OLD.supplier_cost_currency OR NEW.supplier_input_mode IS NOT OLD.supplier_input_mode
   OR NEW.original_input_amount IS NOT OLD.original_input_amount OR NEW.original_input_currency IS NOT OLD.original_input_currency
   OR NEW.conversion_rate_snapshot IS NOT OLD.conversion_rate_snapshot OR NEW.conversion_fx_version IS NOT OLD.conversion_fx_version
   OR NEW.canonical_supplier_cost_usd IS NOT OLD.canonical_supplier_cost_usd OR NEW.converted_at IS NOT OLD.converted_at)
 AND (NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'pricing-input-owner:' || NEW.product_id)
   OR (NEW.supplier_input_mode = 'IQD_CONVERTED' AND (NEW.converted_at IS NULL OR NEW.converted_at <= OLD.converted_at)))
BEGIN SELECT RAISE(ABORT, 'FX_SNAPSHOT_IMMUTABLE'); END;

-- 5. The two owner rules (v2 part 6 reshaped; USD design §10 B): the minimum profit in USD; a dinar
--    minimum only as a migrated value not yet converted (owner question Q2: converted at the adopting
--    save); the Direct Sale Extra in whole dinars on the 1,000 step, never USD (owner decision 7).
CREATE TABLE IF NOT EXISTS pricing_rules (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('target_profit','direct_sale_extra')),
  scope               TEXT NOT NULL CHECK (scope IN ('global','category','product','option','color','sku')),
  catalog_id          TEXT,
  product_id          TEXT REFERENCES products(id) ON DELETE CASCADE,
  scope_id            TEXT NOT NULL DEFAULT '',
  state               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','BLOCKED','INHERIT')),
  amount_usd          TEXT CHECK (amount_usd IS NULL OR (amount_usd GLOB '[0-9]*' AND amount_usd NOT GLOB '*[^0-9.]*'
                        AND amount_usd NOT GLOB '*.*.*' AND amount_usd NOT GLOB '*.' AND amount_usd NOT GLOB '*.???*'
                        AND length(amount_usd) <= 9 AND CAST(amount_usd AS REAL) > 0 AND CAST(amount_usd AS REAL) <= 100000)),
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_rules_target
  ON pricing_rules(kind, scope, IFNULL(catalog_id,''), IFNULL(product_id,''), scope_id);
CREATE INDEX IF NOT EXISTS idx_pricing_rules_product ON pricing_rules(product_id) WHERE product_id IS NOT NULL;
-- F8: a rule is written by a plain INSERT when new and a version-fenced UPDATE when it exists; a
-- REPLACE on its id or its target would delete the old row without any trigger seeing it.
CREATE TRIGGER IF NOT EXISTS pricing_rules_no_reinsert BEFORE INSERT ON pricing_rules
WHEN EXISTS (SELECT 1 FROM pricing_rules r WHERE r.id = NEW.id
                OR (r.kind = NEW.kind AND r.scope = NEW.scope AND IFNULL(r.catalog_id,'') = IFNULL(NEW.catalog_id,'')
                    AND IFNULL(r.product_id,'') = IFNULL(NEW.product_id,'') AND r.scope_id = NEW.scope_id))
BEGIN SELECT RAISE(ABORT, 'PRICING_INPUT_REINSERT'); END;

-- 6. Private engine results per SKU × channel (FX plan §4.2 part 8, plus the USD figures of USD
--    design §10 C). target_profit_iqd = floor(target_profit_iqd_exact); with T_exact = amount_usd × U
--    the price is ceil_1000(R_exact + T_exact), so computed − R ≥ floor(T) and
--    computed − R − floor(T) − extra ≤ one step (the upper bound moved from step − 1 to step: R and
--    floor(T) are each rounded once). The USD columns are display and audit only (§2.2).
CREATE TABLE IF NOT EXISTS pricing_sku_costs (
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
  target_profit_usd               TEXT CHECK (target_profit_usd IS NULL OR (target_profit_usd GLOB '[0-9]*' AND target_profit_usd NOT GLOB '*[^0-9.]*' AND target_profit_usd NOT GLOB '*.*.*' AND target_profit_usd NOT GLOB '*.' AND length(target_profit_usd) <= 9 AND CAST(target_profit_usd AS REAL) > 0)),
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
CREATE INDEX IF NOT EXISTS idx_pricing_sku_costs_currency ON pricing_sku_costs(supplier_currency, product_id);
CREATE INDEX IF NOT EXISTS idx_pricing_sku_costs_profile ON pricing_sku_costs(shipping_profile, product_id);
CREATE INDEX IF NOT EXISTS idx_pricing_sku_costs_fx ON pricing_sku_costs(supplier_currency, fx_version);

-- 7. config_version: bumped by a VALUE change of a central rate (never by a scheduler check that
--    writes the same value) and by a global or category rule; a product-scoped rule bumps the
--    product's inputs_seq instead (part 8).
CREATE TRIGGER IF NOT EXISTS pricing_config_fx_upd AFTER UPDATE OF rate_iqd ON pricing_fx_rates
WHEN NEW.rate_iqd IS NOT OLD.rate_iqd
BEGIN UPDATE pricing_engine_control SET config_version = config_version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS pricing_config_ship_upd AFTER UPDATE OF rate_iqd ON pricing_shipping_rates
WHEN NEW.rate_iqd IS NOT OLD.rate_iqd
BEGIN UPDATE pricing_engine_control SET config_version = config_version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS pricing_config_rule_ins AFTER INSERT ON pricing_rules WHEN NEW.product_id IS NULL
BEGIN UPDATE pricing_engine_control SET config_version = config_version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS pricing_config_rule_upd AFTER UPDATE ON pricing_rules
WHEN NEW.product_id IS NULL OR OLD.product_id IS NULL
BEGIN UPDATE pricing_engine_control SET config_version = config_version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS pricing_config_rule_del AFTER DELETE ON pricing_rules WHEN OLD.product_id IS NULL
BEGIN UPDATE pricing_engine_control SET config_version = config_version + 1 WHERE id = 1; END;

-- 8. inputs_seq: every input row and every product-scoped rule bumps its product's counter. ONLY an
--    existing state row is updated (MVP P2), so these never insert.
CREATE TRIGGER IF NOT EXISTS pricing_inputs_seq_ins AFTER INSERT ON pricing_inputs
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = NEW.product_id; END;
CREATE TRIGGER IF NOT EXISTS pricing_inputs_seq_upd AFTER UPDATE ON pricing_inputs
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id IN (OLD.product_id, NEW.product_id); END;
CREATE TRIGGER IF NOT EXISTS pricing_inputs_seq_del AFTER DELETE ON pricing_inputs
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = OLD.product_id; END;
CREATE TRIGGER IF NOT EXISTS pricing_rules_seq_ins AFTER INSERT ON pricing_rules WHEN NEW.product_id IS NOT NULL
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = NEW.product_id; END;
CREATE TRIGGER IF NOT EXISTS pricing_rules_seq_upd AFTER UPDATE ON pricing_rules
WHEN NEW.product_id IS NOT NULL OR OLD.product_id IS NOT NULL
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id IN (OLD.product_id, NEW.product_id); END;
CREATE TRIGGER IF NOT EXISTS pricing_rules_seq_del AFTER DELETE ON pricing_rules WHEN OLD.product_id IS NOT NULL
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = OLD.product_id; END;

-- 9. The input guard (MVP P2): on an ENGINE-PRICED product, an input or a product-scoped rule
--    changes only in the batch that also reprices it (token 'engine-price:<product_id>'). The DELETE
--    form lets a product deletion through: it removes product_pricing_state first (productDeletion.ts).
CREATE TRIGGER IF NOT EXISTS pricing_inputs_engine_insert BEFORE INSERT ON pricing_inputs
WHEN EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS pricing_inputs_engine_update BEFORE UPDATE ON pricing_inputs
WHEN (EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || OLD.product_id)) OR (EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id))
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS pricing_inputs_engine_delete BEFORE DELETE ON pricing_inputs
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || OLD.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS pricing_rules_engine_insert BEFORE INSERT ON pricing_rules
WHEN NEW.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS pricing_rules_engine_update BEFORE UPDATE ON pricing_rules
WHEN (OLD.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || OLD.product_id))
  OR (NEW.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.product_id))
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS pricing_rules_engine_delete BEFORE DELETE ON pricing_rules
WHEN OLD.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || OLD.product_id)
BEGIN SELECT RAISE(ABORT, 'PRICING_PREVIEW_REQUIRED'); END;

-- 10. THE LOCKS (MVP P2; FX plan H2): on an engine-priced product, the customer-price columns change
--     only in a batch holding 'engine-price:<product_id>' or the repricing batch token
--     'pricing-rates-apply'. VALUE-COMPARED, so an unchanged full form save passes. Never locked: cost
--     columns, stock, capacity, capacity_reserved, lead times, names, images, sort, a 1→0 enable
--     (except the last active option), the JSON columns, colour and variant deletes.
CREATE TRIGGER IF NOT EXISTS engine_lock_products BEFORE UPDATE OF price_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd ON products
WHEN (NEW.price_iqd IS NOT OLD.price_iqd OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd OR NEW.direct_surcharge_iqd IS NOT OLD.direct_surcharge_iqd)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS engine_lock_option_values_update
BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, active, product_id
ON product_option_values
WHEN ((NEW.regular_price_iqd IS NOT OLD.regular_price_iqd OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd OR NEW.regular_adjust_iqd IS NOT OLD.regular_adjust_iqd
      OR NEW.prime_adjust_iqd IS NOT OLD.prime_adjust_iqd OR NEW.pro_adjust_iqd IS NOT OLD.pro_adjust_iqd)
      OR NEW.product_id IS NOT OLD.product_id
      OR (OLD.active = 0 AND NEW.active <> 0)
      OR (OLD.active <> 0 AND NEW.active = 0
          AND NOT EXISTS (SELECT 1 FROM product_option_values v WHERE v.product_id = OLD.product_id AND v.id <> OLD.id AND v.active <> 0)))
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id IN (OLD.product_id, NEW.product_id) AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
CREATE TRIGGER IF NOT EXISTS engine_lock_option_values_insert BEFORE INSERT ON product_option_values
WHEN NOT EXISTS (SELECT 1 FROM product_option_values v WHERE v.id = NEW.id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
CREATE TRIGGER IF NOT EXISTS engine_lock_option_values_delete BEFORE DELETE ON product_option_values
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS engine_lock_fulfillment_update
BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd,
  enabled, option_id, fulfillment_type, product_id ON product_option_fulfillment
WHEN ((NEW.regular_price_iqd IS NOT OLD.regular_price_iqd OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd OR NEW.regular_adjust_iqd IS NOT OLD.regular_adjust_iqd
      OR NEW.prime_adjust_iqd IS NOT OLD.prime_adjust_iqd OR NEW.pro_adjust_iqd IS NOT OLD.pro_adjust_iqd)
      OR NEW.product_id IS NOT OLD.product_id OR NEW.option_id IS NOT OLD.option_id OR NEW.fulfillment_type IS NOT OLD.fulfillment_type
      OR (OLD.enabled = 0 AND NEW.enabled <> 0))
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id IN (OLD.product_id, NEW.product_id) AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
CREATE TRIGGER IF NOT EXISTS engine_lock_fulfillment_insert BEFORE INSERT ON product_option_fulfillment
WHEN NOT EXISTS (SELECT 1 FROM product_option_fulfillment f WHERE f.id = NEW.id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
CREATE TRIGGER IF NOT EXISTS engine_lock_fulfillment_delete BEFORE DELETE ON product_option_fulfillment
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS engine_lock_transports_update
BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd,
  surcharge_iqd, enabled, fulfillment_id, method, product_id ON product_option_transports
WHEN ((NEW.regular_price_iqd IS NOT OLD.regular_price_iqd OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd OR NEW.regular_adjust_iqd IS NOT OLD.regular_adjust_iqd
      OR NEW.prime_adjust_iqd IS NOT OLD.prime_adjust_iqd OR NEW.pro_adjust_iqd IS NOT OLD.pro_adjust_iqd) OR NEW.surcharge_iqd IS NOT OLD.surcharge_iqd
      OR NEW.product_id IS NOT OLD.product_id OR NEW.fulfillment_id IS NOT OLD.fulfillment_id OR NEW.method IS NOT OLD.method
      OR (OLD.enabled = 0 AND NEW.enabled <> 0))
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id IN (OLD.product_id, NEW.product_id) AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
CREATE TRIGGER IF NOT EXISTS engine_lock_transports_insert BEFORE INSERT ON product_option_transports
WHEN NOT EXISTS (SELECT 1 FROM product_option_transports t WHERE t.id = NEW.id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
CREATE TRIGGER IF NOT EXISTS engine_lock_transports_delete BEFORE DELETE ON product_option_transports
WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = OLD.product_id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = OLD.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

CREATE TRIGGER IF NOT EXISTS engine_lock_colors_update
BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, product_id ON product_colors
WHEN ((NEW.regular_price_iqd IS NOT OLD.regular_price_iqd OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd OR NEW.regular_adjust_iqd IS NOT OLD.regular_adjust_iqd
      OR NEW.prime_adjust_iqd IS NOT OLD.prime_adjust_iqd OR NEW.pro_adjust_iqd IS NOT OLD.pro_adjust_iqd) OR NEW.product_id IS NOT OLD.product_id) AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id IN (OLD.product_id, NEW.product_id) AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
CREATE TRIGGER IF NOT EXISTS engine_lock_colors_insert BEFORE INSERT ON product_colors
WHEN (NEW.regular_price_iqd IS NOT NULL OR NEW.prime_price_iqd IS NOT NULL OR NEW.pro_price_iqd IS NOT NULL
      OR NEW.regular_adjust_iqd IS NOT NULL OR NEW.prime_adjust_iqd IS NOT NULL OR NEW.pro_adjust_iqd IS NOT NULL)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

-- The variant rung of the resolver (variant → colour → option → base) prices too, so the selection
-- price writer (inventoryReferencePrice.ts) is refused on an engine product (USD design §4.4).
CREATE TRIGGER IF NOT EXISTS engine_lock_variants_update
BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, product_id ON product_variants
WHEN (NEW.regular_price_iqd IS NOT OLD.regular_price_iqd OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd OR NEW.product_id IS NOT OLD.product_id)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id IN (OLD.product_id, NEW.product_id) AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || OLD.product_id, 'engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;
CREATE TRIGGER IF NOT EXISTS engine_lock_variants_insert BEFORE INSERT ON product_variants
WHEN (NEW.regular_price_iqd IS NOT NULL OR NEW.prime_price_iqd IS NOT NULL OR NEW.pro_price_iqd IS NOT NULL)
 AND EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = NEW.product_id AND s.mode = 'engine') AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id IN ('engine-price:' || NEW.product_id, 'pricing-rates-apply'))
BEGIN SELECT RAISE(ABORT, 'ENGINE_MANAGED'); END;

-- 11. A batch's cost is fixed in IQD (FX plan §4.2, critique M11; brief §8). Live code updates only
--     qty_remaining and nulls product_id on a product deletion; corrections are appended to
--     inventory_lot_cost_versions and read through effectiveLotCostSql, which these never touch.
CREATE TRIGGER IF NOT EXISTS inventory_lot_cost_immutable
BEFORE UPDATE OF qty_received, unit_cost_iqd, purchase_unit_iqd, shipping_share_iqd, internal_share_iqd, total_cost_iqd, cost_basis ON inventory_lots
WHEN NEW.qty_received IS NOT OLD.qty_received OR NEW.unit_cost_iqd IS NOT OLD.unit_cost_iqd
  OR NEW.purchase_unit_iqd IS NOT OLD.purchase_unit_iqd OR NEW.shipping_share_iqd IS NOT OLD.shipping_share_iqd
  OR NEW.internal_share_iqd IS NOT OLD.internal_share_iqd OR NEW.total_cost_iqd IS NOT OLD.total_cost_iqd
  OR NEW.cost_basis IS NOT OLD.cost_basis
BEGIN SELECT RAISE(ABORT, 'BATCH_COST_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS inventory_lot_no_delete BEFORE DELETE ON inventory_lots
BEGIN SELECT RAISE(ABORT, 'BATCH_COST_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS inventory_lot_no_reinsert BEFORE INSERT ON inventory_lots
WHEN EXISTS (SELECT 1 FROM inventory_lots l WHERE l.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'BATCH_COST_IMMUTABLE'); END;

-- 12. Owner decision 6 (price protection on the base USD price; ODP §5.1 item 8), additive, all
--     nullable or defaulted. A history row says which USD/IQD its price was computed at and who moved
--     it; an order line bought at an engine price carries, frozen, the engine price and the rate it was
--     bought at (written once at INSERT by pricingEngine/orderBasis.ts; every other line keeps the
--     exact current INSERT and all six NULL); a claim stores the eligible amount and its basis in its
--     own columns (never in policy_snapshot, which the customer reads).
ALTER TABLE price_history ADD COLUMN usd_iqd_rate TEXT CHECK (usd_iqd_rate IS NULL OR (usd_iqd_rate GLOB '[0-9]*' AND usd_iqd_rate NOT GLOB '*[^0-9.]*' AND usd_iqd_rate NOT GLOB '*.*.*' AND usd_iqd_rate NOT GLOB '*.' AND length(usd_iqd_rate) <= 32 AND CAST(usd_iqd_rate AS REAL) > 0));
ALTER TABLE price_history ADD COLUMN price_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (price_source IN ('manual','engine_owner','engine_fx'));
ALTER TABLE order_items ADD COLUMN price_basis TEXT CHECK (price_basis IS NULL OR price_basis = 'engine');
ALTER TABLE order_items ADD COLUMN engine_combo_key TEXT CHECK (engine_combo_key IS NULL OR length(engine_combo_key) <= 400);
ALTER TABLE order_items ADD COLUMN engine_channel TEXT
  CHECK (engine_channel IS NULL OR engine_channel IN ('direct_sale','pre_order_air','pre_order_sea','pre_order_land'));
ALTER TABLE order_items ADD COLUMN engine_regular_iqd INTEGER CHECK (engine_regular_iqd IS NULL OR engine_regular_iqd > 0);
ALTER TABLE order_items ADD COLUMN usd_iqd_at_purchase TEXT CHECK (usd_iqd_at_purchase IS NULL OR (usd_iqd_at_purchase GLOB '[0-9]*' AND usd_iqd_at_purchase NOT GLOB '*[^0-9.]*' AND usd_iqd_at_purchase NOT GLOB '*.*.*' AND usd_iqd_at_purchase NOT GLOB '*.' AND length(usd_iqd_at_purchase) <= 32 AND CAST(usd_iqd_at_purchase AS REAL) > 0));
ALTER TABLE order_items ADD COLUMN base_usd_at_purchase TEXT CHECK (base_usd_at_purchase IS NULL OR (base_usd_at_purchase GLOB '[0-9]*' AND base_usd_at_purchase NOT GLOB '*[^0-9.]*' AND base_usd_at_purchase NOT GLOB '*.*.*' AND base_usd_at_purchase NOT GLOB '*.' AND length(base_usd_at_purchase) <= 24 AND CAST(base_usd_at_purchase AS REAL) > 0));
CREATE TRIGGER IF NOT EXISTS order_items_engine_snapshot_shape BEFORE INSERT ON order_items
WHEN NOT ((NEW.price_basis IS NULL AND NEW.engine_combo_key IS NULL AND NEW.engine_channel IS NULL
           AND NEW.engine_regular_iqd IS NULL AND NEW.usd_iqd_at_purchase IS NULL AND NEW.base_usd_at_purchase IS NULL)
       OR (NEW.price_basis IS 'engine' AND NEW.engine_combo_key IS NOT NULL AND NEW.engine_channel IS NOT NULL
           AND NEW.engine_regular_iqd IS NOT NULL AND NEW.usd_iqd_at_purchase IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'ORDER_SNAPSHOT_SHAPE'); END;
CREATE TRIGGER IF NOT EXISTS order_items_engine_snapshot_frozen
BEFORE UPDATE OF price_basis, engine_combo_key, engine_channel, engine_regular_iqd, usd_iqd_at_purchase, base_usd_at_purchase ON order_items
WHEN NEW.price_basis IS NOT OLD.price_basis OR NEW.engine_combo_key IS NOT OLD.engine_combo_key
  OR NEW.engine_channel IS NOT OLD.engine_channel OR NEW.engine_regular_iqd IS NOT OLD.engine_regular_iqd
  OR NEW.usd_iqd_at_purchase IS NOT OLD.usd_iqd_at_purchase OR NEW.base_usd_at_purchase IS NOT OLD.base_usd_at_purchase
BEGIN SELECT RAISE(ABORT, 'ORDER_SNAPSHOT_IMMUTABLE'); END;
ALTER TABLE price_protection_claims ADD COLUMN eligible_unit_iqd INTEGER CHECK (eligible_unit_iqd IS NULL OR eligible_unit_iqd >= 0);
ALTER TABLE price_protection_claims ADD COLUMN basis TEXT NOT NULL DEFAULT 'iqd' CHECK (basis IN ('iqd','usd_base','owner_acts'));
ALTER TABLE price_protection_claims ADD COLUMN usd_iqd_at_purchase TEXT
  CHECK (usd_iqd_at_purchase IS NULL OR (usd_iqd_at_purchase GLOB '[0-9]*' AND usd_iqd_at_purchase NOT GLOB '*[^0-9.]*' AND usd_iqd_at_purchase NOT GLOB '*.*.*' AND usd_iqd_at_purchase NOT GLOB '*.' AND length(usd_iqd_at_purchase) <= 32 AND CAST(usd_iqd_at_purchase AS REAL) > 0));
ALTER TABLE price_protection_claims ADD COLUMN base_usd_at_purchase TEXT
  CHECK (base_usd_at_purchase IS NULL OR (base_usd_at_purchase GLOB '[0-9]*' AND base_usd_at_purchase NOT GLOB '*[^0-9.]*' AND base_usd_at_purchase NOT GLOB '*.*.*' AND base_usd_at_purchase NOT GLOB '*.' AND length(base_usd_at_purchase) <= 24 AND CAST(base_usd_at_purchase AS REAL) > 0));
ALTER TABLE price_protection_claims ADD COLUMN base_usd_observed TEXT
  CHECK (base_usd_observed IS NULL OR (base_usd_observed GLOB '[0-9]*' AND base_usd_observed NOT GLOB '*[^0-9.]*' AND base_usd_observed NOT GLOB '*.*.*' AND base_usd_observed NOT GLOB '*.' AND length(base_usd_observed) <= 24 AND CAST(base_usd_observed AS REAL) > 0));

-- 13. The double-freight guard (USD design §3.3): which of a routed purchase's extra charges feed the
--     pricing input «additional cost». NULL = never fed (old rows, manual documents). Accounting is
--     unchanged: every charge still counts in the landed IQD.
ALTER TABLE purchase_charges ADD COLUMN pricing_role TEXT
  CHECK (pricing_role IS NULL OR pricing_role IN ('additional','excluded'));
