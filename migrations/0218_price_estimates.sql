-- ============================================================================
-- 0218 — ESTIMATED PRE-ORDER PRICES FOR BAMBU LAB PRODUCTS
-- (docs/SMART_PRICING.md §2; owner answers D1–D4 of 2026-10-31; DECISIONS
-- rows 278–282).
--
-- What this file lands, all of it inert until the owner turns on «apply»:
--   (0) the public label `products.price_estimate` (0 / 1);
--   (1) the owner-only supplier price catalogue (Tmall CNY, EU store EUR,
--       US store USD as a reference) with its matches and manual prices;
--   (2) the owner-only per-type defaults (seeded WITHOUT any figure: every
--       measure, extra cost and minimum profit is NULL until the owner types
--       it) and the owner's two switches;
--   (3) a product's estimate bookkeeping (owner-only) and its firm SKUs (a
--       public fact: the owner confirmed that SKU's price);
--   (4) the order side: one row per estimated order line, and the 0140
--       proposal's reason code;
--   (5) the triggers that make the label, the checkout record and the order
--       gate impossible to skip, whatever door writes;
--   (6) the import guard on every new table (DECISIONS row 239 in the
--       database), in the exact shape 0195 generates and 0200 / 0211 re-emit.
--
-- ADDITIVE ONLY: two defaulted columns, twelve new tables, their indexes,
-- triggers and seed rows. No table is rebuilt, no CHECK is widened and no
-- existing row changes.
--
-- RE-RUNNABLE: every CREATE says IF NOT EXISTS and every seed is INSERT OR
-- IGNORE, so scripts/migrate-check.mjs --twice re-runs them and proves nothing
-- moves. The two ADD COLUMNs are excluded from that re-run by the harness
-- itself (SQLite has no ADD COLUMN IF NOT EXISTS; D1 applies a file once).
--
-- ONE FILE ON PURPOSE: the label, the checkout guard and the order gate must
-- exist together in every database. A database with a labelled product and no
-- gate must be impossible.
--
-- DEPLOY-AHEAD (CLAUDE.md rule 2): every reader of what this file adds
-- tolerates its absence (worker/lib/priceEstimateLabel.ts,
-- worker/lib/priceEstimateGate.ts). A database without the column holds no
-- labelled product, which is exactly what the column's default says.
--
-- Decimal grammars, spelled out in full below because SQLite has no macros:
--   DEC(x, n)  the 0181 supplier_cost_amount grammar — digits with at most one
--              dot, not ending in a dot, at most n characters, above zero;
--   USD6(x)    the 0211 amount_usd grammar — DEC(x, 13), at most six
--              decimals, at most 100000.
-- Comments use `--` only: tests/d1CompoundLimit.test.ts strips no block
-- comment, and no statement here chains a compound SELECT.
-- ============================================================================

-- ============================================================================
-- (0) THE PUBLIC LABEL. NOT NULL DEFAULT 0: a database without this column
-- holds no labelled product, so a reader that finds the key absent answers
-- exactly what the column would say (substitution, not degradation).
-- PRODUCT_COLUMNS (worker/lib/productModel.ts) never names it, so no product
-- save ever writes it; only the V2 price writer sets it (T1) and only the
-- owner's confirmation clears it (T2).
-- ============================================================================
ALTER TABLE products ADD COLUMN price_estimate INTEGER NOT NULL DEFAULT 0 CHECK (price_estimate IN (0,1));

-- ============================================================================
-- (1) SUPPLIER PRICE CATALOGUE — OWNER-ONLY. Dated snapshots of official
-- Bambu Lab prices, as captured; never fetched by the Worker on a schedule.
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier_price_snapshots (
  id TEXT PRIMARY KEY CHECK (id GLOB 'sps_*' AND length(id) <= 40),
  source TEXT NOT NULL CHECK (source IN ('tmall_cn','bambu_eu','bambu_us')),
  currency TEXT NOT NULL CHECK (currency IN ('CNY','EUR','USD')),
  -- Recorded as the store lists it; never converted in code (owner question 282(a)).
  price_basis TEXT NOT NULL DEFAULT 'list' CHECK (price_basis IN ('list','net_of_vat')),
  capture TEXT NOT NULL CHECK (capture IN ('browser_sweep','store_script','open_api')),
  captured_on TEXT NOT NULL CHECK (captured_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  captured_by TEXT NOT NULL DEFAULT '' CHECK (length(captured_by) <= 120),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count BETWEEN 0 AND 20000),
  sku_count INTEGER NOT NULL DEFAULT 0 CHECK (sku_count BETWEEN 0 AND 200000),
  state TEXT NOT NULL DEFAULT 'loading' CHECK (state IN ('loading','complete','superseded','discarded')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  -- A geo-redirected "EU" capture that carries USD can never be stored as EUR.
  CHECK ((source = 'tmall_cn' AND currency = 'CNY') OR (source = 'bambu_eu' AND currency = 'EUR') OR (source = 'bambu_us' AND currency = 'USD')),
  CHECK (state NOT IN ('complete','superseded') OR completed_at IS NOT NULL)
);
-- At most one current (complete) snapshot per source.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sps_current ON supplier_price_snapshots(source) WHERE state = 'complete';

CREATE TABLE IF NOT EXISTS supplier_price_items (
  snapshot_id TEXT NOT NULL REFERENCES supplier_price_snapshots(id) ON DELETE CASCADE,
  -- The Tmall item_id or the store handle: stable across captures.
  item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 120),
  url TEXT NOT NULL DEFAULT '' CHECK (length(url) <= 600),
  -- The host that actually served the page (a redirect is visible here).
  page_host TEXT NOT NULL DEFAULT '' CHECK (length(page_host) <= 120),
  -- In the source language (Chinese on Tmall).
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 400),
  name_en TEXT NOT NULL DEFAULT '' CHECK (length(name_en) <= 400),
  category TEXT NOT NULL DEFAULT '' CHECK (length(category) <= 40),
  sourcing_hint TEXT NOT NULL DEFAULT '' CHECK (sourcing_hint IN ('','EU_STORE_EUR','CHINA_CNY')),
  route_hint TEXT NOT NULL DEFAULT '' CHECK (route_hint IN ('','GERMANY_LAND','CHINA_SEA','CHINA_SEA_OR_AIR')),
  codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(codes_json) AND json_type(codes_json) = 'array' AND length(codes_json) <= 4000),
  props_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(props_json) AND length(props_json) <= 16000),
  PRIMARY KEY (snapshot_id, item_key)
);

CREATE TABLE IF NOT EXISTS supplier_price_skus (
  snapshot_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  -- The Tmall sku_id or the store variant id.
  sku_key TEXT NOT NULL CHECK (length(sku_key) BETWEEN 1 AND 120),
  options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json) AND json_type(options_json) = 'object' AND length(options_json) <= 2000),
  options_en_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_en_json) AND json_type(options_en_json) = 'object' AND length(options_en_json) <= 2000),
  codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(codes_json) AND json_type(codes_json) = 'array' AND length(codes_json) <= 2000),
  -- The Bambu SKU code from the store's JSON-LD.
  sku_code TEXT NOT NULL DEFAULT '' CHECK (length(sku_code) <= 120),
  -- Decimal text as captured: DEC(price, 24).
  price TEXT NOT NULL CHECK (price GLOB '[0-9]*' AND price NOT GLOB '*[^0-9.]*' AND price NOT GLOB '*.*.*' AND price NOT GLOB '*.' AND length(price) <= 24 AND CAST(price AS REAL) > 0),
  -- The label printed beside the price (Tmall: 优惠前, "before discounts"). Never a figure.
  price_label TEXT NOT NULL DEFAULT '' CHECK (length(price_label) <= 60),
  quantity INTEGER CHECK (quantity IS NULL OR quantity >= 0),
  -- Parsed at upload: 10件装 gives 10, 1kg gives 1000.
  pack_units INTEGER NOT NULL DEFAULT 1 CHECK (pack_units BETWEEN 1 AND 1000),
  net_weight_g INTEGER CHECK (net_weight_g IS NULL OR net_weight_g BETWEEN 1 AND 100000000),
  PRIMARY KEY (snapshot_id, item_key, sku_key),
  FOREIGN KEY (snapshot_id, item_key) REFERENCES supplier_price_items(snapshot_id, item_key) ON DELETE CASCADE
);

-- The matcher's index, written at upload.
CREATE TABLE IF NOT EXISTS supplier_price_keys (
  snapshot_id TEXT NOT NULL REFERENCES supplier_price_snapshots(id) ON DELETE CASCADE,
  key_type TEXT NOT NULL CHECK (key_type IN ('color_code','part_code','sku_code','variant_id','handle','model_token','name_token')),
  key_value TEXT NOT NULL CHECK (length(key_value) BETWEEN 1 AND 120),
  item_key TEXT NOT NULL,
  sku_key TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (snapshot_id, key_type, key_value, item_key, sku_key)
);
CREATE INDEX IF NOT EXISTS ix_spk_lookup ON supplier_price_keys(key_type, key_value);

-- Keyed by SOURCE IDENTITY, not by snapshot: Tmall ids and store handles are
-- stable, so a confirmed match carries over to the next capture.
CREATE TABLE IF NOT EXISTS supplier_price_matches (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- The canonical skuComboKey; '' is the product itself.
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 400),
  source TEXT NOT NULL CHECK (source IN ('tmall_cn','bambu_eu','bambu_us')),
  item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 120),
  sku_key TEXT NOT NULL CHECK (length(sku_key) BETWEEN 1 AND 120),
  confidence TEXT NOT NULL CHECK (confidence IN ('exact','high','medium','low')),
  method TEXT NOT NULL CHECK (method IN ('variant_id','sku_code','part_code','color_code','handle','name','owner')),
  -- Reason CODES only.
  reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array' AND length(reasons_json) <= 2000),
  units_per_offer INTEGER NOT NULL DEFAULT 1 CHECK (units_per_offer BETWEEN 1 AND 1000),
  state TEXT NOT NULL CHECK (state IN ('suggested','confirmed','rejected')),
  -- 'auto' for an automatic confirmation.
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT '',
  found_in_snapshot TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TEXT NOT NULL,
  CHECK (state = 'suggested' OR (decided_by <> '' AND decided_at <> '')),
  -- A pack price is divided only by the owner, never automatically.
  CHECK (units_per_offer = 1 OR (state = 'confirmed' AND decided_by NOT IN ('','auto'))),
  PRIMARY KEY (product_id, combo_key, source, item_key, sku_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_spm_confirmed ON supplier_price_matches(product_id, combo_key, source) WHERE state = 'confirmed';
CREATE INDEX IF NOT EXISTS ix_spm_source ON supplier_price_matches(source, item_key, sku_key);

-- The owner's typed price, or one store page he read.
CREATE TABLE IF NOT EXISTS supplier_price_manual (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 400),
  -- DEC(amount, 24).
  amount TEXT NOT NULL CHECK (amount GLOB '[0-9]*' AND amount NOT GLOB '*[^0-9.]*' AND amount NOT GLOB '*.*.*' AND amount NOT GLOB '*.' AND length(amount) <= 24 AND CAST(amount AS REAL) > 0),
  currency TEXT NOT NULL CHECK (currency IN ('USD','EUR','CNY')),
  origin TEXT NOT NULL DEFAULT 'typed' CHECK (origin IN ('typed','store_page')),
  evidence_url TEXT NOT NULL DEFAULT '' CHECK (length(evidence_url) <= 600),
  evidence_host TEXT NOT NULL DEFAULT '' CHECK (length(evidence_host) <= 120),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  entered_by TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (origin = 'typed' OR (evidence_url <> '' AND evidence_host <> '')),
  PRIMARY KEY (product_id, combo_key)
);

-- ============================================================================
-- (2) PER-TYPE DEFAULTS — OWNER-ONLY. Seeded WITHOUT any measure, cost or
-- profit: every figure is NULL until the owner types it (owner rule: nothing
-- hard-coded). The CHECKs fix what the owner decided per type:
-- electronics come from the EU store by land only; filament travels by sea
-- only; air exists only for China types the owner opens to it.
-- ============================================================================
CREATE TABLE IF NOT EXISTS price_estimate_types (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 2 AND 40 AND key NOT GLOB '*[^a-z_]*'),
  name_ar TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 80),
  name_en TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 80),
  -- DECISIONS row 183: a Sorani slot never carries a copy of the Arabic.
  name_ckb TEXT NOT NULL CHECK (length(name_ckb) BETWEEN 1 AND 80 AND name_ckb <> name_ar),
  sourcing TEXT NOT NULL CHECK (sourcing IN ('EU_STORE_EUR','CHINA_CNY')),
  route TEXT NOT NULL CHECK (route IN ('land','sea','air')),
  allow_air INTEGER NOT NULL DEFAULT 0 CHECK (allow_air IN (0,1)),
  us_reference_allowed INTEGER NOT NULL DEFAULT 0 CHECK (us_reference_allowed IN (0,1)),
  default_weight_g INTEGER CHECK (default_weight_g IS NULL OR default_weight_g BETWEEN 1 AND 100000000),
  default_length_mm INTEGER,
  default_width_mm INTEGER,
  default_height_mm INTEGER,
  -- DEC(default_cbm, 12).
  default_cbm TEXT CHECK (default_cbm IS NULL OR (default_cbm GLOB '[0-9]*' AND default_cbm NOT GLOB '*[^0-9.]*' AND default_cbm NOT GLOB '*.*.*' AND default_cbm NOT GLOB '*.' AND length(default_cbm) <= 12 AND CAST(default_cbm AS REAL) > 0)),
  additional_cost_iqd INTEGER CHECK (additional_cost_iqd IS NULL OR additional_cost_iqd BETWEEN 0 AND 1000000000),
  -- USD6(min_profit_usd): a fixed minimum profit in dollars, never a percentage (DECISIONS row 184(3)).
  min_profit_usd TEXT CHECK (min_profit_usd IS NULL OR (min_profit_usd GLOB '[0-9]*' AND min_profit_usd NOT GLOB '*[^0-9.]*' AND min_profit_usd NOT GLOB '*.*.*' AND min_profit_usd NOT GLOB '*.' AND min_profit_usd NOT GLOB '*.???????*' AND length(min_profit_usd) <= 13 AND CAST(min_profit_usd AS REAL) > 0 AND CAST(min_profit_usd AS REAL) <= 100000)),
  stale_after_days INTEGER NOT NULL DEFAULT 60 CHECK (stale_after_days BETWEEN 1 AND 365),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  -- Electronics: the EU store, by land only — and land only for the EU store.
  CHECK ((sourcing = 'EU_STORE_EUR') = (route = 'land')),
  CHECK (sourcing = 'CHINA_CNY' OR allow_air = 0),
  CHECK (route <> 'air' OR allow_air = 1),
  -- Filament: sea only.
  CHECK (key NOT IN ('filament','filament_pack') OR (route = 'sea' AND allow_air = 0)),
  CHECK (sourcing = 'EU_STORE_EUR' OR us_reference_allowed = 0),
  CHECK ((default_length_mm IS NULL) = (default_width_mm IS NULL) AND (default_width_mm IS NULL) = (default_height_mm IS NULL)),
  CHECK (default_length_mm IS NULL OR (default_length_mm BETWEEN 1 AND 100000 AND default_width_mm BETWEEN 1 AND 100000 AND default_height_mm BETWEEN 1 AND 100000))
);

-- The seed: names in three languages and the routing the owner decided; every
-- figure NULL (docs/SMART_PRICING.md §4.1).
--   EU_STORE_EUR / land, US reference allowed:  printer, ams, laser_machine, electronics_device, electronics_part
--   CHINA_CNY / sea, never air:                 filament, filament_pack
--   CHINA_CNY / sea, air allowed per product:   spare_part, hotend, build_plate, accessory, makers_supply, laser_material
INSERT OR IGNORE INTO price_estimate_types (key, name_ar, name_en, name_ckb, sourcing, route, allow_air, us_reference_allowed, updated_at) VALUES
  ('printer', 'طابعات ثلاثية الأبعاد', '3D printers', 'چاپکەری سێ ڕەهەندی', 'EU_STORE_EUR', 'land', 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ams', 'وحدات AMS', 'AMS units', 'یەکەکانی AMS', 'EU_STORE_EUR', 'land', 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('laser_machine', 'أجهزة الليزر والقص', 'Laser and cutting machines', 'ئامێرەکانی لەیزەر و بڕین', 'EU_STORE_EUR', 'land', 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('electronics_device', 'أجهزة إلكترونية', 'Electronic devices', 'ئامێرە ئەلیکترۆنییەکان', 'EU_STORE_EUR', 'land', 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('electronics_part', 'قطع إلكترونية', 'Electronic parts', 'پارچە ئەلیکترۆنییەکان', 'EU_STORE_EUR', 'land', 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('filament', 'خيوط الطباعة', 'Filament', 'فیلامێنت', 'CHINA_CNY', 'sea', 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('filament_pack', 'حزم خيوط الطباعة', 'Filament packs', 'پاکێجی فیلامێنت', 'CHINA_CNY', 'sea', 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('spare_part', 'قطع غيار', 'Spare parts', 'پارچەی یەدەگ', 'CHINA_CNY', 'sea', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('hotend', 'رؤوس الطباعة والفوهات', 'Hotends and nozzles', 'هۆت ئێند و نۆزڵ', 'CHINA_CNY', 'sea', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('build_plate', 'ألواح الطباعة', 'Build plates', 'تەختەکانی چاپ', 'CHINA_CNY', 'sea', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('accessory', 'إكسسوارات وأدوات', 'Accessories and tools', 'پاشکۆ و ئامرازەکان', 'CHINA_CNY', 'sea', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('makers_supply', 'مستلزمات الصناع', 'Maker supplies', 'پێداویستییەکانی دروستکەران', 'CHINA_CNY', 'sea', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('laser_material', 'مواد الليزر', 'Laser materials', 'کەرەستەی لەیزەر', 'CHINA_CNY', 'sea', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- The owner's two switches. «apply» starts OFF (and is refused until the
-- purchase policy carries the estimate clause); «ordering» is the emergency
-- brake on estimated lines.
CREATE TABLE IF NOT EXISTS price_estimate_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  apply_enabled INTEGER NOT NULL DEFAULT 0 CHECK (apply_enabled IN (0,1)),
  ordering_enabled INTEGER NOT NULL DEFAULT 1 CHECK (ordering_enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO price_estimate_control (id) VALUES (1);

-- ============================================================================
-- (3) THE ESTIMATE ON A PRODUCT (owner-only bookkeeping) AND ITS FIRM SKUs
-- (a public fact).
-- ============================================================================
CREATE TABLE IF NOT EXISTS product_price_estimates (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  type_key TEXT REFERENCES price_estimate_types(key),
  type_source TEXT NOT NULL DEFAULT '' CHECK (type_source IN ('','owner','supplier_category','import_type')),
  sourcing_override TEXT CHECK (sourcing_override IS NULL OR sourcing_override IN ('EU_STORE_EUR','CHINA_CNY')),
  route_override TEXT CHECK (route_override IS NULL OR route_override IN ('land','sea','air')),
  state TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate','estimated','confirmed','paused')),
  measure_basis TEXT NOT NULL DEFAULT '' CHECK (measure_basis IN ('','real','type_default','mixed')),
  -- Flag CODES only.
  flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags_json) AND json_type(flags_json) = 'array' AND length(flags_json) <= 4000),
  preview_hash TEXT CHECK (preview_hash IS NULL OR length(preview_hash) = 64),
  computed_at TEXT,
  applied_at TEXT,
  applied_by TEXT,
  applied_write_seq INTEGER,
  -- What the estimator wrote and where each value came from (the three-way merge of §4.5).
  applied_wire_json TEXT CHECK (applied_wire_json IS NULL OR (json_valid(applied_wire_json) AND length(applied_wire_json) <= 200000)),
  confirmed_at TEXT,
  confirmed_by TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  CHECK (state <> 'estimated' OR (type_key IS NOT NULL AND applied_at IS NOT NULL AND applied_wire_json IS NOT NULL)),
  -- A product is confirmed only on real measures: never while a type default prices a SKU (owner decision D2).
  CHECK (state <> 'confirmed' OR (confirmed_at IS NOT NULL AND measure_basis = 'real'))
);
CREATE INDEX IF NOT EXISTS ix_ppe_state ON product_price_estimates(state, updated_at);

-- The last computed preview per SKU and channel (an owner-only cache).
CREATE TABLE IF NOT EXISTS price_estimate_lines (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 400),
  channel TEXT NOT NULL CHECK (channel IN ('pre_order_air','pre_order_sea','pre_order_land')),
  price_source TEXT NOT NULL CHECK (price_source IN ('tmall_cn','bambu_eu','bambu_us','typed','store_page','none')),
  supplier_amount TEXT,
  supplier_currency TEXT CHECK (supplier_currency IS NULL OR supplier_currency IN ('USD','EUR','CNY')),
  measure_source TEXT NOT NULL CHECK (measure_source IN ('model','colour','product','type_default','owner','none')),
  flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags_json) AND json_type(flags_json) = 'array' AND length(flags_json) <= 2000),
  est_cost_iqd INTEGER,
  est_price_iqd INTEGER,
  published_price_iqd INTEGER,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (product_id, combo_key, channel)
);

-- PUBLIC fact: the owner confirmed this SKU's price, so it is no estimate.
CREATE TABLE IF NOT EXISTS price_estimate_firm_skus (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 400),
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (product_id, combo_key)
);

-- ============================================================================
-- (4) THE ORDER SIDE: every estimated line, recorded in the checkout batch.
-- Customer prices only (the line's regular unit price and the final one).
-- ============================================================================
CREATE TABLE IF NOT EXISTS order_price_estimates (
  order_item_id TEXT PRIMARY KEY REFERENCES order_items(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 400),
  channel TEXT NOT NULL CHECK (channel IN ('pre_order_air','pre_order_sea','pre_order_land')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  -- The regular unit price the line was sold at.
  estimate_unit_iqd INTEGER NOT NULL CHECK (estimate_unit_iqd > 0),
  -- The notice version the customer acknowledged.
  notice_version INTEGER NOT NULL CHECK (notice_version > 0),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','proposed','confirmed','approved','rejected','void')),
  final_unit_iqd INTEGER CHECK (final_unit_iqd IS NULL OR final_unit_iqd > 0),
  adjustment_id TEXT,
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (state NOT IN ('proposed','approved','rejected') OR adjustment_id IS NOT NULL),
  CHECK (state NOT IN ('proposed','confirmed','approved','rejected') OR final_unit_iqd IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_ope_open ON order_price_estimates(order_id) WHERE state IN ('open','proposed','rejected');
CREATE INDEX IF NOT EXISTS ix_ope_order ON order_price_estimates(order_id);
-- T11 finds a proposal's lines by adjustment_id on every 0140 decision, of any order.
CREATE INDEX IF NOT EXISTS ix_ope_adjustment ON order_price_estimates(adjustment_id) WHERE adjustment_id IS NOT NULL;

-- The 0140 proposal that settles estimate lines says so (written only by an
-- estimate proposal; every older reader sees '' through SELECT *).
ALTER TABLE order_price_adjustments ADD COLUMN reason_code TEXT NOT NULL DEFAULT '' CHECK (reason_code IN ('','ESTIMATE_FINAL_PRICE'));

-- ============================================================================
-- (5) TRIGGERS
-- ============================================================================

-- T1. The label is SET only inside a price write: the V2 writer holds
--     'engine-price:<id>' from its step 3 to its end (worker/lib/pricingEngine/v2/write.ts).
CREATE TRIGGER IF NOT EXISTS trg_products_price_estimate_set BEFORE UPDATE OF price_estimate ON products
FOR EACH ROW WHEN NEW.price_estimate = 1 AND OLD.price_estimate = 0
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.id)
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_LABEL_OUTSIDE_PRICE_WRITE'); END;

-- T2. The label is CLEARED only by the owner's confirmation, recorded first in
--     the same batch, with no type-default measure left.
CREATE TRIGGER IF NOT EXISTS trg_products_price_estimate_clear BEFORE UPDATE OF price_estimate ON products
FOR EACH ROW WHEN NEW.price_estimate = 0 AND OLD.price_estimate = 1
 AND NOT EXISTS (SELECT 1 FROM product_price_estimates e WHERE e.product_id = NEW.id AND e.state = 'confirmed' AND e.measure_basis = 'real')
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_LABEL_CLEAR_REFUSED'); END;

-- T3. No product is born labelled (the import, a copy, a create).
CREATE TRIGGER IF NOT EXISTS trg_products_price_estimate_insert AFTER INSERT ON products
FOR EACH ROW WHEN NEW.price_estimate <> 0
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_LABEL_OUTSIDE_PRICE_WRITE'); END;

-- T4. A firm SKU exists only on a labelled product — when it is recorded, and
--     if a write ever tried to move it to another product.
CREATE TRIGGER IF NOT EXISTS trg_price_estimate_firm_ins BEFORE INSERT ON price_estimate_firm_skus
FOR EACH ROW WHEN NOT EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.price_estimate = 1)
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_FIRM_UNLABELLED'); END;
CREATE TRIGGER IF NOT EXISTS trg_price_estimate_firm_upd BEFORE UPDATE OF product_id ON price_estimate_firm_skus
FOR EACH ROW WHEN NOT EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.price_estimate = 1)
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_FIRM_UNLABELLED'); END;

-- T5. A product's overrides obey its type's rules:
--     air only where the type allows it, and never for filament;
--     filament from the China store by sea only (owner answer of 2026-10-31);
--     EU sourcing by land only (an EU product with no route override travels by land);
--     China sourcing never by land.
CREATE TRIGGER IF NOT EXISTS trg_ppe_route_rule_ins BEFORE INSERT ON product_price_estimates
FOR EACH ROW WHEN (NEW.route_override = 'air' AND (NEW.type_key IN ('filament','filament_pack')
                     OR NOT EXISTS (SELECT 1 FROM price_estimate_types t WHERE t.key = NEW.type_key AND t.allow_air = 1)))
   OR (NEW.type_key IN ('filament','filament_pack')
       AND (COALESCE(NEW.route_override, 'sea') <> 'sea' OR COALESCE(NEW.sourcing_override, 'CHINA_CNY') <> 'CHINA_CNY'))
   OR (COALESCE(NEW.sourcing_override, (SELECT t.sourcing FROM price_estimate_types t WHERE t.key = NEW.type_key)) = 'EU_STORE_EUR'
       AND COALESCE(NEW.route_override, 'land') <> 'land')
   OR (COALESCE(NEW.sourcing_override, (SELECT t.sourcing FROM price_estimate_types t WHERE t.key = NEW.type_key)) = 'CHINA_CNY'
       AND COALESCE(NEW.route_override, (SELECT t.route FROM price_estimate_types t WHERE t.key = NEW.type_key)) = 'land')
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_TYPE_RULE'); END;
CREATE TRIGGER IF NOT EXISTS trg_ppe_route_rule_upd BEFORE UPDATE OF type_key, sourcing_override, route_override ON product_price_estimates
FOR EACH ROW WHEN (NEW.route_override = 'air' AND (NEW.type_key IN ('filament','filament_pack')
                     OR NOT EXISTS (SELECT 1 FROM price_estimate_types t WHERE t.key = NEW.type_key AND t.allow_air = 1)))
   OR (NEW.type_key IN ('filament','filament_pack')
       AND (COALESCE(NEW.route_override, 'sea') <> 'sea' OR COALESCE(NEW.sourcing_override, 'CHINA_CNY') <> 'CHINA_CNY'))
   OR (COALESCE(NEW.sourcing_override, (SELECT t.sourcing FROM price_estimate_types t WHERE t.key = NEW.type_key)) = 'EU_STORE_EUR'
       AND COALESCE(NEW.route_override, 'land') <> 'land')
   OR (COALESCE(NEW.sourcing_override, (SELECT t.sourcing FROM price_estimate_types t WHERE t.key = NEW.type_key)) = 'CHINA_CNY'
       AND COALESCE(NEW.route_override, (SELECT t.route FROM price_estimate_types t WHERE t.key = NEW.type_key)) = 'land')
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_TYPE_RULE'); END;

-- T6. Every order line of a labelled product goes through the estimate
--     checkout: the checkout batch inserts 'estimate-checkout:<order id>'
--     before its lines and deletes it after its estimate rows. An older
--     Worker, the community-store door or any other door cannot sell a
--     labelled product at all.
CREATE TRIGGER IF NOT EXISTS trg_order_items_price_estimate_guard AFTER INSERT ON order_items
FOR EACH ROW WHEN NEW.product_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.price_estimate = 1)
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'estimate-checkout:' || NEW.order_id)
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_CHECKOUT_REQUIRED'); END;

-- T7. Estimate rows are born with their order (checkout only: the order is
--     still pending at «تم الاستلام» with no courier, the checkout token is
--     held, and the row describes a line of that very order — its product and
--     its quantity), and their identity never changes afterwards.
CREATE TRIGGER IF NOT EXISTS trg_ope_insert_guard BEFORE INSERT ON order_price_estimates
FOR EACH ROW WHEN NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.status = 'pending' AND o.stage = 'received' AND o.delivery_remote_id = '')
  OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'estimate-checkout:' || NEW.order_id)
  OR NOT EXISTS (SELECT 1 FROM order_items i WHERE i.id = NEW.order_item_id AND i.order_id = NEW.order_id AND i.product_id = NEW.product_id AND i.qty = NEW.qty)
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_LINE_OUTSIDE_CHECKOUT'); END;
CREATE TRIGGER IF NOT EXISTS trg_ope_frozen BEFORE UPDATE OF order_item_id, order_id, product_id, combo_key, channel, qty, estimate_unit_iqd, notice_version ON order_price_estimates
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_LINE_FROZEN'); END;

-- T8. THE GATE: while a line is open, proposed or rejected, the order stays at
--     «تم الاستلام» — no confirm, no preparation, no shipping, no courier
--     booking — whatever door moves it. Cancellation stays open.
CREATE TRIGGER IF NOT EXISTS trg_orders_price_estimate_gate BEFORE UPDATE OF status, stage, delivery_remote_id ON orders
FOR EACH ROW
WHEN ((NEW.status IS NOT OLD.status AND NEW.status NOT IN ('pending','cancelled'))
   OR (NEW.stage IS NOT OLD.stage AND NEW.stage NOT IN ('received','cancelled'))
   OR (NEW.delivery_remote_id IS NOT OLD.delivery_remote_id AND NEW.delivery_remote_id <> ''))
 AND EXISTS (SELECT 1 FROM order_price_estimates e WHERE e.order_id = NEW.id AND e.state IN ('open','proposed','rejected'))
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_UNCONFIRMED'); END;

-- T9. A cancelled order with estimate lines is never reopened: the customer
--     places a new order (0175's gift rule, the same shape). It says <> and
--     not IS NOT, like 0175: a NULL fence (a lost deletion or refund race)
--     must still fail on NOT NULL, the message its caller maps.
CREATE TRIGGER IF NOT EXISTS trg_orders_price_estimate_reopen BEFORE UPDATE OF status ON orders
FOR EACH ROW WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
 AND EXISTS (SELECT 1 FROM order_price_estimates e WHERE e.order_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_REOPEN_REFUSED'); END;

-- T10. Cancellation voids the unsettled lines, whatever door cancels
--      (the customer, an admin, the expiry sweep).
CREATE TRIGGER IF NOT EXISTS trg_orders_price_estimate_cancel AFTER UPDATE OF status ON orders
FOR EACH ROW WHEN NEW.status = 'cancelled' AND OLD.status IS NOT 'cancelled'
BEGIN
  UPDATE order_price_estimates SET state = 'void', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE order_id = NEW.id AND state IN ('open','proposed','rejected');
END;

-- T11. A 0140 decision reaches its lines, whatever door decided (the web,
--      Telegram, an admin's withdrawal, the customer's cancel). It fires only
--      on the first UPDATE that leaves 'pending'; the 0140 fences write
--      pending → pending, approved → approved or rejected → rejected and
--      never fire it.
--      Each CASE closes with `END ,` — a space before the comma — because
--      Wrangler's splitter closes a CASE only on END followed by whitespace or
--      `;` (tests/sqlSplit.test.ts); `END,` would fold the rest of the file
--      into this trigger.
CREATE TRIGGER IF NOT EXISTS trg_price_adj_estimate_lines AFTER UPDATE OF state ON order_price_adjustments
FOR EACH ROW WHEN OLD.state = 'pending' AND NEW.state IN ('approved','rejected','withdrawn','void')
BEGIN
  UPDATE order_price_estimates
     SET state = CASE NEW.state WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected' WHEN 'withdrawn' THEN 'open' ELSE 'void' END ,
         adjustment_id = CASE NEW.state WHEN 'withdrawn' THEN NULL ELSE adjustment_id END ,
         final_unit_iqd = CASE NEW.state WHEN 'withdrawn' THEN NULL ELSE final_unit_iqd END ,
         decided_by = COALESCE(NEW.decided_by, ''),
         decided_at = NEW.decided_at
   WHERE adjustment_id = NEW.id AND state = 'proposed';
END;

-- ============================================================================
-- (6) THE IMPORT GUARD (DECISIONS row 239 in the database): for each of the
-- twelve new tables, trg_import_guard_<table>_{ins,upd,del} in the exact shape
-- scripts/gen-import-guard-triggers.mjs prints for 0195 and 0200 / 0211
-- re-emit. Armed only while ops_guards holds 'catalog-import-batch', which
-- exists only inside an import batch. The twelve tables are listed in
-- worker/lib/catalogImport/protectedTables.ts LATE_PROTECTED_TABLES; 0195's
-- generated block is not touched (tests/catalogImportGuards.test.ts).
-- ============================================================================
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_snapshots_ins BEFORE INSERT ON supplier_price_snapshots
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_snapshots_upd BEFORE UPDATE ON supplier_price_snapshots
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_snapshots_del BEFORE DELETE ON supplier_price_snapshots
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_items_ins BEFORE INSERT ON supplier_price_items
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_items_upd BEFORE UPDATE ON supplier_price_items
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_items_del BEFORE DELETE ON supplier_price_items
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_skus_ins BEFORE INSERT ON supplier_price_skus
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_skus_upd BEFORE UPDATE ON supplier_price_skus
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_skus_del BEFORE DELETE ON supplier_price_skus
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_keys_ins BEFORE INSERT ON supplier_price_keys
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_keys_upd BEFORE UPDATE ON supplier_price_keys
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_keys_del BEFORE DELETE ON supplier_price_keys
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_matches_ins BEFORE INSERT ON supplier_price_matches
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_matches_upd BEFORE UPDATE ON supplier_price_matches
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_matches_del BEFORE DELETE ON supplier_price_matches
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_manual_ins BEFORE INSERT ON supplier_price_manual
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_manual_upd BEFORE UPDATE ON supplier_price_manual
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_supplier_price_manual_del BEFORE DELETE ON supplier_price_manual
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_types_ins BEFORE INSERT ON price_estimate_types
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_types_upd BEFORE UPDATE ON price_estimate_types
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_types_del BEFORE DELETE ON price_estimate_types
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_control_ins BEFORE INSERT ON price_estimate_control
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_control_upd BEFORE UPDATE ON price_estimate_control
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_control_del BEFORE DELETE ON price_estimate_control
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_price_estimates_ins BEFORE INSERT ON product_price_estimates
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_price_estimates_upd BEFORE UPDATE ON product_price_estimates
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_price_estimates_del BEFORE DELETE ON product_price_estimates
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_lines_ins BEFORE INSERT ON price_estimate_lines
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_lines_upd BEFORE UPDATE ON price_estimate_lines
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_lines_del BEFORE DELETE ON price_estimate_lines
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_firm_skus_ins BEFORE INSERT ON price_estimate_firm_skus
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_firm_skus_upd BEFORE UPDATE ON price_estimate_firm_skus
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_estimate_firm_skus_del BEFORE DELETE ON price_estimate_firm_skus
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_order_price_estimates_ins BEFORE INSERT ON order_price_estimates
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_order_price_estimates_upd BEFORE UPDATE ON order_price_estimates
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_order_price_estimates_del BEFORE DELETE ON order_price_estimates
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
