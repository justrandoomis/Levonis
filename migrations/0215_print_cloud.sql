-- ---------------------------------------------------------------------------
-- 0215 — LEVONIS PRINT CLOUD: remote rental of the workshop's 3D printers,
--        gram-based material purchases, customer-owned inventory, model files,
--        print jobs, the queue and the workshop ledgers (docs/PRINT_CLOUD.md).
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY. Every table is new and prefixed `pc_`; no existing table is
-- altered. Customers are the existing `users` rows (one Levonis account), and
-- nothing here writes a Levonis wallet, product, order or inventory row: the
-- integration with those systems goes through the adapters in
-- worker/lib/printCloud/adapters.ts and is not live (docs/PRINT_CLOUD.md §8).
--
-- WHAT THE DATABASE ITSELF HOLDS, not the route:
--   * no balance goes negative — named CHECKs on every balance column
--     (ck_pc_credit_available, ck_pc_inventory_available, …): an overdraw
--     aborts the whole D1 batch it travels in, so two concurrent spends cannot
--     both pass;
--   * the ledgers are append-only — UPDATE and DELETE raise PC_APPEND_ONLY;
--     a correction is a compensating row, never an edit;
--   * every business event has an `entry_key` UNIQUE per ledger, so a replayed
--     fulfilment, release or consumption collides instead of counting twice;
--   * a payment provider's event is recorded once per (provider, event id);
--   * a physical printer holds at most one active assignment, a job at most
--     one active assignment, one active credit reservation, one active queue
--     entry;
--   * `pc_fence` is the batch guard: a statement inserts (code, ok) and the
--     triggers abort the batch with 'PC_FENCE:<code>' when ok is not 1 and
--     silently drop the row when it is, so the table stays empty.
--
-- MONEY is integer IQD. TIME is integer seconds. QUANTITIES are integers in
-- the variant's base unit (grams, pieces, sets, millimetres). Timestamps are
-- ISO-8601 strings written by the Worker's clock.
--
-- SEEDS reference data only (measurement units and product categories); no
-- printer, price, product or customer row. Only idempotent statements.

-- ------------------------------------------------------------------ guards

CREATE TABLE IF NOT EXISTS pc_fence (
  code TEXT NOT NULL,
  ok INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trg_pc_fence_pass BEFORE INSERT ON pc_fence
WHEN NEW.ok = 1
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_fence_out_of_stock BEFORE INSERT ON pc_fence
WHEN NEW.ok IS NOT 1 AND NEW.code = 'OUT_OF_STOCK'
BEGIN
  SELECT RAISE(ABORT, 'PC_FENCE:OUT_OF_STOCK');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_fence_insufficient_credit BEFORE INSERT ON pc_fence
WHEN NEW.ok IS NOT 1 AND NEW.code = 'INSUFFICIENT_CREDIT'
BEGIN
  SELECT RAISE(ABORT, 'PC_FENCE:INSUFFICIENT_CREDIT');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_fence_insufficient_inventory BEFORE INSERT ON pc_fence
WHEN NEW.ok IS NOT 1 AND NEW.code = 'INSUFFICIENT_INVENTORY'
BEGIN
  SELECT RAISE(ABORT, 'PC_FENCE:INSUFFICIENT_INVENTORY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_fence_printer_unavailable BEFORE INSERT ON pc_fence
WHEN NEW.ok IS NOT 1 AND NEW.code = 'PRINTER_UNAVAILABLE'
BEGIN
  SELECT RAISE(ABORT, 'PC_FENCE:PRINTER_UNAVAILABLE');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_fence_limit_reached BEFORE INSERT ON pc_fence
WHEN NEW.ok IS NOT 1 AND NEW.code = 'LIMIT_REACHED'
BEGIN
  SELECT RAISE(ABORT, 'PC_FENCE:LIMIT_REACHED');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_fence_state_changed BEFORE INSERT ON pc_fence
WHEN NEW.ok IS NOT 1 AND NEW.code NOT IN ('OUT_OF_STOCK', 'INSUFFICIENT_CREDIT', 'INSUFFICIENT_INVENTORY', 'PRINTER_UNAVAILABLE', 'LIMIT_REACHED')
BEGIN
  SELECT RAISE(ABORT, 'PC_FENCE:STATE_CHANGED');
END;

-- One row per idempotent request: the key a client sent, the hash of what it
-- asked, and the answer it got. A replay returns the stored answer; the same
-- key with a different request is refused.
CREATE TABLE IF NOT EXISTS pc_operations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (actor_id, scope, idempotency_key)
);

-- The single versioned configuration row. Defaults live in code
-- (worker/lib/printCloud/settings.ts) and are normalised on every read.
CREATE TABLE IF NOT EXISTS pc_settings (
  key TEXT PRIMARY KEY CHECK (key = 'config'),
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- ------------------------------------------------------------------ units

CREATE TABLE IF NOT EXISTS pc_units (
  code TEXT PRIMARY KEY,
  -- Quantities of different dimensions never meet: an inventory account has
  -- exactly one base unit, so grams are never added to pieces.
  dimension TEXT NOT NULL CHECK (dimension IN ('mass', 'count', 'set', 'length')),
  base_code TEXT NOT NULL,
  factor_to_base INTEGER NOT NULL CHECK (factor_to_base >= 1),
  is_base INTEGER NOT NULL CHECK (is_base IN (0, 1)),
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  label_ckb TEXT NOT NULL
);
INSERT OR IGNORE INTO pc_units (code, dimension, base_code, factor_to_base, is_base, label_ar, label_en, label_ckb) VALUES
  ('g', 'mass', 'g', 1, 1, 'غرام', 'gram', 'گرام'),
  ('kg', 'mass', 'g', 1000, 0, 'كيلوغرام', 'kilogram', 'کیلۆگرام'),
  ('pc', 'count', 'pc', 1, 1, 'قطعة', 'piece', 'دانە'),
  ('set', 'set', 'set', 1, 1, 'طقم', 'set', 'دەست'),
  ('mm', 'length', 'mm', 1, 1, 'مليمتر', 'millimetre', 'ملیمەتر'),
  ('m', 'length', 'mm', 1000, 0, 'متر', 'metre', 'مەتر');

-- ------------------------------------------------------------------ printers

-- A credit tier is the pool printing hours are bought for and spent on. Every
-- printer model belongs to exactly one tier; hours never cross tiers unless an
-- enabled conversion rule says so and the customer asks.
CREATE TABLE IF NOT EXISTS pc_credit_tiers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_ckb TEXT NOT NULL,
  description_json TEXT NOT NULL DEFAULT '{}',
  -- The rate a custom (non-package) hour purchase is priced at, per hour.
  hourly_rate_iqd INTEGER NOT NULL CHECK (hourly_rate_iqd >= 0),
  custom_hours_enabled INTEGER NOT NULL DEFAULT 0 CHECK (custom_hours_enabled IN (0, 1)),
  min_custom_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (min_custom_seconds >= 60),
  custom_step_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (custom_step_seconds >= 60),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pc_printer_models (
  id TEXT PRIMARY KEY,
  tier_id TEXT NOT NULL REFERENCES pc_credit_tiers(id),
  code TEXT NOT NULL UNIQUE,
  brand TEXT NOT NULL,
  model_name TEXT NOT NULL,
  build_x_mm INTEGER NOT NULL CHECK (build_x_mm > 0),
  build_y_mm INTEGER NOT NULL CHECK (build_y_mm > 0),
  build_z_mm INTEGER NOT NULL CHECK (build_z_mm > 0),
  nozzle_options_um TEXT NOT NULL DEFAULT '[400]',
  extruder_config TEXT NOT NULL DEFAULT 'single' CHECK (extruder_config IN ('single', 'dual', 'idex', 'toolchanger')),
  ams_systems_json TEXT NOT NULL DEFAULT '[]',
  max_colors INTEGER NOT NULL DEFAULT 1 CHECK (max_colors >= 1),
  supported_materials_json TEXT NOT NULL DEFAULT '[]',
  max_nozzle_temp_c INTEGER,
  max_bed_temp_c INTEGER,
  enclosed INTEGER NOT NULL DEFAULT 0 CHECK (enclosed IN (0, 1)),
  camera INTEGER NOT NULL DEFAULT 0 CHECK (camera IN (0, 1)),
  average_power_w INTEGER NOT NULL DEFAULT 0 CHECK (average_power_w >= 0),
  quality_rank INTEGER NOT NULL DEFAULT 0,
  spec_json TEXT NOT NULL DEFAULT '{}',
  -- The Levonis catalogue product this model is sold as, when it is (adapter link only).
  levonis_product_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_printer_models_tier ON pc_printer_models(tier_id);

-- A workshop agent: the program on the workshop network that talks to the
-- printers and to the slicer. Only a hash of its bearer token is stored.
CREATE TABLE IF NOT EXISTS pc_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_seen_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- One row per physical machine in the workshop.
CREATE TABLE IF NOT EXISTS pc_printers (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES pc_printer_models(id),
  name TEXT NOT NULL,
  serial_number TEXT NOT NULL UNIQUE,
  equipment_code TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL DEFAULT '',
  nozzle_um INTEGER NOT NULL DEFAULT 400 CHECK (nozzle_um > 0),
  ams_slots INTEGER NOT NULL DEFAULT 0 CHECK (ams_slots >= 0),
  -- Material codes currently loadable on this machine (e.g. hardened nozzle).
  materials_json TEXT NOT NULL DEFAULT '[]',
  camera INTEGER NOT NULL DEFAULT 0 CHECK (camera IN (0, 1)),
  -- Administrative availability. 'maintenance' and 'retired' are never assigned work.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'retired')),
  -- The adapter that controls it and an OPAQUE reference the agent resolves.
  -- Credentials never live here: they stay inside the workshop agent.
  adapter TEXT NOT NULL DEFAULT 'manual' CHECK (adapter IN ('manual', 'agent')),
  connection_ref TEXT NOT NULL DEFAULT '',
  agent_id TEXT REFERENCES pc_agents(id),
  operating_seconds INTEGER NOT NULL DEFAULT 0 CHECK (operating_seconds >= 0),
  -- Cost data (owner only): acquisition, expected life, residual value, upkeep.
  acquisition_cost_iqd INTEGER CHECK (acquisition_cost_iqd IS NULL OR acquisition_cost_iqd >= 0),
  acquired_at TEXT,
  expected_life_hours INTEGER CHECK (expected_life_hours IS NULL OR expected_life_hours > 0),
  residual_value_iqd INTEGER CHECK (residual_value_iqd IS NULL OR residual_value_iqd >= 0),
  maintenance_reserve_iqd_per_hour INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_reserve_iqd_per_hour >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_printers_model ON pc_printers(model_id, status);

CREATE TABLE IF NOT EXISTS pc_printer_maintenance (
  id TEXT PRIMARY KEY,
  printer_id TEXT NOT NULL REFERENCES pc_printers(id),
  kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'unscheduled', 'repair', 'calibration')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  cost_iqd INTEGER NOT NULL DEFAULT 0 CHECK (cost_iqd >= 0),
  created_by TEXT,
  created_at TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_pc_printer_maintenance_window ON pc_printer_maintenance(printer_id, status, starts_at);

-- The latest telemetry the agent reported, one row per printer. `received_at`
-- is the server clock; a reading older than the configured window is STALE
-- and is answered as such, never as live.
CREATE TABLE IF NOT EXISTS pc_printer_telemetry (
  printer_id TEXT PRIMARY KEY REFERENCES pc_printers(id),
  agent_id TEXT,
  -- When the stored reading was TAKEN, on the server clock (printers.ts ingestTelemetry).
  received_at TEXT NOT NULL,
  reported_at TEXT,
  -- When the agent last reached the cloud for this printer, any reading: the connection's own liveness.
  arrived_at TEXT,
  machine_state TEXT NOT NULL CHECK (machine_state IN ('idle', 'preparing', 'printing', 'paused', 'finished', 'error', 'offline')),
  job_id TEXT,
  progress_permille INTEGER CHECK (progress_permille IS NULL OR (progress_permille >= 0 AND progress_permille <= 1000)),
  layer INTEGER,
  total_layers INTEGER,
  remaining_seconds INTEGER,
  nozzle_temp_dc INTEGER,
  bed_temp_dc INTEGER,
  chamber_temp_dc INTEGER,
  errors_json TEXT NOT NULL DEFAULT '[]',
  camera_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS pc_printer_events (
  id TEXT PRIMARY KEY,
  printer_id TEXT NOT NULL REFERENCES pc_printers(id),
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'operator', 'agent', 'system')),
  actor_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_printer_events_printer ON pc_printer_events(printer_id, created_at);

-- ------------------------------------------------------------------ pricing

CREATE TABLE IF NOT EXISTS pc_credit_packages (
  id TEXT PRIMARY KEY,
  tier_id TEXT NOT NULL REFERENCES pc_credit_tiers(id),
  code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_ckb TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'promotional', 'bundle')),
  seconds INTEGER NOT NULL CHECK (seconds > 0),
  price_iqd INTEGER NOT NULL CHECK (price_iqd >= 0),
  min_quantity INTEGER NOT NULL DEFAULT 1 CHECK (min_quantity >= 1),
  max_quantity INTEGER NOT NULL DEFAULT 10 CHECK (max_quantity >= min_quantity),
  max_per_customer INTEGER CHECK (max_per_customer IS NULL OR max_per_customer >= 1),
  -- Credits never expire unless the administrator sets this AND the package
  -- says so to the customer before purchase (docs/PRINT_CLOUD.md §3.2).
  expires_after_days INTEGER CHECK (expires_after_days IS NULL OR expires_after_days >= 1),
  -- A bundle may carry material lines granted with the hours.
  bundle_json TEXT NOT NULL DEFAULT '[]',
  valid_from TEXT,
  valid_until TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_credit_packages_tier ON pc_credit_packages(tier_id, active, sort);

CREATE TABLE IF NOT EXISTS pc_credit_conversion_rules (
  id TEXT PRIMARY KEY,
  from_tier_id TEXT NOT NULL REFERENCES pc_credit_tiers(id),
  to_tier_id TEXT NOT NULL REFERENCES pc_credit_tiers(id),
  -- to_seconds = floor(from_seconds × ratio_num / ratio_den)
  ratio_num INTEGER NOT NULL CHECK (ratio_num >= 1),
  ratio_den INTEGER NOT NULL CHECK (ratio_den >= 1),
  -- Disabled by default: hours never move between tiers silently.
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (from_tier_id, to_tier_id),
  CHECK (from_tier_id <> to_tier_id)
);

CREATE TABLE IF NOT EXISTS pc_product_categories (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('filament', 'accessory', 'tool')),
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_ckb TEXT NOT NULL,
  -- Buyback is decided per category; accessories never inherit the filament rule.
  buyback_enabled INTEGER NOT NULL DEFAULT 0 CHECK (buyback_enabled IN (0, 1)),
  buyback_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (buyback_rate_bps >= 0 AND buyback_rate_bps <= 10000),
  storable INTEGER NOT NULL DEFAULT 1 CHECK (storable IN (0, 1)),
  sort INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO pc_product_categories (code, kind, name_ar, name_en, name_ckb, buyback_enabled, buyback_rate_bps, storable, sort) VALUES
  ('filaments', 'filament', 'خيوط الطباعة', 'Filaments', 'دەزووی چاپ', 0, 5000, 1, 10),
  ('magnets', 'accessory', 'مغناطيسات', 'Magnets', 'موگناتیس', 0, 0, 1, 20),
  ('nfc', 'accessory', 'شرائح NFC', 'NFC tags', 'تاگی NFC', 0, 0, 1, 30),
  ('medal_chains', 'accessory', 'سلاسل الميداليات', 'Medal chains', 'زنجیری میدالیا', 0, 0, 1, 40),
  ('keychain_rings', 'accessory', 'حلقات الميداليات', 'Keychain rings', 'ئەڵقەی کلیلدان', 0, 0, 1, 50),
  ('led_kits', 'accessory', 'أطقم الإضاءة LED', 'LED kits', 'کیتی LED', 0, 0, 1, 60),
  ('screws', 'accessory', 'براغي', 'Screws', 'بورغی', 0, 0, 1, 70),
  ('threaded_inserts', 'accessory', 'حشوات ملولبة', 'Threaded inserts', 'ناوپێچی خەتدار', 0, 0, 1, 80),
  ('bearings', 'accessory', 'محامل (رولمان)', 'Bearings', 'بێرینگ', 0, 0, 1, 90),
  ('electronics', 'accessory', 'إلكترونيات', 'Electronics', 'ئەلیکترۆنیات', 0, 0, 1, 100),
  ('tools', 'tool', 'أدوات', 'Tools', 'ئامراز', 0, 0, 0, 110),
  ('other_accessories', 'accessory', 'ملحقات طباعة أخرى', 'Other printing accessories', 'پاشکۆی تری چاپ', 0, 0, 1, 120);

CREATE TABLE IF NOT EXISTS pc_products (
  id TEXT PRIMARY KEY,
  category_code TEXT NOT NULL REFERENCES pc_product_categories(code),
  brand TEXT NOT NULL DEFAULT '',
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_ckb TEXT NOT NULL,
  description_json TEXT NOT NULL DEFAULT '{}',
  -- Filament only: PLA, PETG, ABS, TPU … and the grade (Basic, Matte, Silk).
  material TEXT,
  grade TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  -- Adapter link to the existing Levonis catalogue row; never a copy of it.
  levonis_product_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_products_category ON pc_products(category_code, active);

CREATE TABLE IF NOT EXISTS pc_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES pc_products(id),
  sku TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_ckb TEXT NOT NULL,
  color_name TEXT NOT NULL DEFAULT '',
  color_hex TEXT NOT NULL DEFAULT '',
  diameter_um INTEGER,
  -- The ONE base unit every quantity of this variant is counted in.
  unit_code TEXT NOT NULL REFERENCES pc_units(code),
  min_purchase_qty INTEGER NOT NULL DEFAULT 1 CHECK (min_purchase_qty >= 1),
  purchase_step_qty INTEGER NOT NULL DEFAULT 1 CHECK (purchase_step_qty >= 1),
  max_purchase_qty INTEGER NOT NULL DEFAULT 100000 CHECK (max_purchase_qty >= min_purchase_qty),
  max_per_customer_qty INTEGER CHECK (max_per_customer_qty IS NULL OR max_per_customer_qty >= 1),
  -- Where a purchase of this variant may go: kept in the workshop for the
  -- customer, delivered home, or earmarked for one printing project.
  fulfillment_modes_json TEXT NOT NULL DEFAULT '["inventory","delivery","project"]',
  low_stock_threshold_qty INTEGER NOT NULL DEFAULT 0 CHECK (low_stock_threshold_qty >= 0),
  attributes_json TEXT NOT NULL DEFAULT '{}',
  levonis_variant_ref TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_variants_product ON pc_variants(product_id, active);

-- Quantity pricing per variant. A 'pack' tier prices one exact quantity (the
-- 100 g / 250 g / 500 g / 1 kg list); a 'bracket' tier prices every gram (or
-- piece) of a purchase at or above min_qty, in thousandths of a dinar.
CREATE TABLE IF NOT EXISTS pc_price_tiers (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  mode TEXT NOT NULL CHECK (mode IN ('pack', 'bracket')),
  min_qty INTEGER NOT NULL CHECK (min_qty >= 1),
  pack_price_iqd INTEGER CHECK (pack_price_iqd IS NULL OR pack_price_iqd >= 0),
  unit_price_milli_iqd INTEGER CHECK (unit_price_milli_iqd IS NULL OR unit_price_milli_iqd >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((mode = 'pack' AND pack_price_iqd IS NOT NULL) OR (mode = 'bracket' AND unit_price_milli_iqd IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pc_price_tiers_active ON pc_price_tiers(variant_id, mode, min_qty) WHERE active = 1;

CREATE TABLE IF NOT EXISTS pc_promotions (
  id TEXT PRIMARY KEY,
  -- NULL code = automatic; otherwise the customer enters it.
  code TEXT UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_ckb TEXT NOT NULL,
  -- 'all' | 'credits' | 'materials' | 'tier:<id>' | 'variant:<id>' | 'category:<code>'
  scope TEXT NOT NULL,
  percent_bps INTEGER NOT NULL DEFAULT 0 CHECK (percent_bps >= 0 AND percent_bps <= 10000),
  amount_off_iqd INTEGER NOT NULL DEFAULT 0 CHECK (amount_off_iqd >= 0),
  min_subtotal_iqd INTEGER NOT NULL DEFAULT 0 CHECK (min_subtotal_iqd >= 0),
  -- A membership tier name from the Levonis MembershipAdapter, or NULL for everyone.
  membership TEXT,
  starts_at TEXT,
  ends_at TEXT,
  max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions >= 1),
  redemptions INTEGER NOT NULL DEFAULT 0 CHECK (redemptions >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT ck_pc_promotion_redemptions CHECK (max_redemptions IS NULL OR redemptions <= max_redemptions)
);

-- Every administrative price change, append-only: what was, what became, who.
-- Purchased credits and materials keep the price they were bought at; this
-- history is never read back into an existing balance.
CREATE TABLE IF NOT EXISTS pc_price_changes (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_price_changes_entity ON pc_price_changes(entity_type, entity_id, created_at);

-- ------------------------------------------------------------------ quotes and orders

CREATE TABLE IF NOT EXISTS pc_quotes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ordered', 'expired')),
  subtotal_iqd INTEGER NOT NULL CHECK (subtotal_iqd >= 0),
  discount_iqd INTEGER NOT NULL CHECK (discount_iqd >= 0),
  total_iqd INTEGER NOT NULL CHECK (total_iqd >= 0),
  promotion_ids_json TEXT NOT NULL DEFAULT '[]',
  snapshot_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_quotes_user ON pc_quotes(user_id, created_at);

CREATE TABLE IF NOT EXISTS pc_quote_lines (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES pc_quotes(id),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('credit_package', 'credit_hours', 'material')),
  tier_id TEXT REFERENCES pc_credit_tiers(id),
  package_id TEXT REFERENCES pc_credit_packages(id),
  variant_id TEXT REFERENCES pc_variants(id),
  -- credit_package: package count; credit_hours: seconds; material: base units.
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  seconds INTEGER NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  base_price_iqd INTEGER NOT NULL CHECK (base_price_iqd >= 0),
  discount_iqd INTEGER NOT NULL CHECK (discount_iqd >= 0),
  final_price_iqd INTEGER NOT NULL CHECK (final_price_iqd >= 0),
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('credits', 'inventory', 'delivery', 'project')),
  project_id TEXT,
  breakdown_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (quote_id, line_no)
);

CREATE TABLE IF NOT EXISTS pc_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  quote_id TEXT UNIQUE REFERENCES pc_quotes(id),
  kind TEXT NOT NULL DEFAULT 'purchase' CHECK (kind IN ('purchase', 'shipping')),
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment', 'fulfilled', 'cancelled', 'expired', 'refunded', 'partially_refunded')),
  subtotal_iqd INTEGER NOT NULL CHECK (subtotal_iqd >= 0),
  discount_iqd INTEGER NOT NULL CHECK (discount_iqd >= 0),
  total_iqd INTEGER NOT NULL CHECK (total_iqd >= 0),
  paid_iqd INTEGER NOT NULL DEFAULT 0 CHECK (paid_iqd >= 0),
  refunded_iqd INTEGER NOT NULL DEFAULT 0 CHECK (refunded_iqd >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('dev', 'manual', 'gateway', 'levonis_wallet')),
  promotion_ids_json TEXT NOT NULL DEFAULT '[]',
  delivery_address_json TEXT,
  shipment_id TEXT,
  stock_hold_expires_at TEXT NOT NULL,
  levonis_order_ref TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  fulfilled_at TEXT,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL,
  op_token TEXT NOT NULL DEFAULT '',
  CONSTRAINT ck_pc_order_refund CHECK (refunded_iqd <= paid_iqd)
);
CREATE INDEX IF NOT EXISTS idx_pc_orders_user ON pc_orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pc_orders_status ON pc_orders(status, stock_hold_expires_at);

CREATE TABLE IF NOT EXISTS pc_order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES pc_orders(id),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('credit_package', 'credit_hours', 'material', 'shipping_fee')),
  tier_id TEXT REFERENCES pc_credit_tiers(id),
  package_id TEXT REFERENCES pc_credit_packages(id),
  variant_id TEXT REFERENCES pc_variants(id),
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  seconds INTEGER NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  final_price_iqd INTEGER NOT NULL CHECK (final_price_iqd >= 0),
  refunded_iqd INTEGER NOT NULL DEFAULT 0 CHECK (refunded_iqd >= 0),
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('credits', 'inventory', 'delivery', 'project', 'fee')),
  project_id TEXT,
  expires_after_days INTEGER,
  breakdown_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (order_id, line_no),
  CONSTRAINT ck_pc_order_line_refund CHECK (refunded_iqd <= final_price_iqd)
);
CREATE INDEX IF NOT EXISTS idx_pc_order_lines_variant ON pc_order_lines(variant_id);

CREATE TABLE IF NOT EXISTS pc_payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES pc_orders(id),
  provider TEXT NOT NULL CHECK (provider IN ('dev', 'manual', 'gateway', 'levonis_wallet')),
  provider_ref TEXT NOT NULL DEFAULT '',
  amount_iqd INTEGER NOT NULL CHECK (amount_iqd >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  confirmed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_pc_payments_order ON pc_payments(order_id);
-- One confirmed payment per order: a second confirmation of the same order is
-- an event, never a second payment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pc_payments_confirmed ON pc_payments(order_id) WHERE status = 'confirmed';

-- Every payment confirmation the system ever received, once per provider event.
CREATE TABLE IF NOT EXISTS pc_payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  order_id TEXT,
  amount_iqd INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'duplicate_order', 'amount_mismatch', 'order_not_payable', 'unknown_order', 'rejected_signature')),
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS pc_refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES pc_orders(id),
  order_line_id TEXT REFERENCES pc_order_lines(id),
  amount_iqd INTEGER NOT NULL CHECK (amount_iqd > 0),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reason TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('manual', 'gateway', 'levonis_wallet', 'dev')),
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'paid_out')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_refunds_order ON pc_refunds(order_id);

-- ------------------------------------------------------------------ printing-hour credits

CREATE TABLE IF NOT EXISTS pc_credit_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tier_id TEXT NOT NULL REFERENCES pc_credit_tiers(id),
  available_seconds INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_pc_credit_available CHECK (available_seconds >= 0),
  reserved_seconds INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_pc_credit_reserved CHECK (reserved_seconds >= 0),
  consumed_seconds INTEGER NOT NULL DEFAULT 0 CHECK (consumed_seconds >= 0),
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, tier_id)
);

-- What was bought, at what price: the value of a consumed second is its lot's.
CREATE TABLE IF NOT EXISTS pc_credit_lots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES pc_credit_accounts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  tier_id TEXT NOT NULL REFERENCES pc_credit_tiers(id),
  source TEXT NOT NULL CHECK (source IN ('purchase', 'adjustment', 'compensation', 'conversion')),
  order_line_id TEXT REFERENCES pc_order_lines(id),
  seconds_total INTEGER NOT NULL CHECK (seconds_total > 0),
  seconds_remaining INTEGER NOT NULL CONSTRAINT ck_pc_credit_lot_remaining CHECK (seconds_remaining >= 0),
  paid_iqd INTEGER NOT NULL DEFAULT 0 CHECK (paid_iqd >= 0),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (seconds_remaining <= seconds_total)
);
CREATE INDEX IF NOT EXISTS idx_pc_credit_lots_account ON pc_credit_lots(account_id, created_at);

CREATE TABLE IF NOT EXISTS pc_credit_reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES pc_credit_accounts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  tier_id TEXT NOT NULL REFERENCES pc_credit_tiers(id),
  job_id TEXT NOT NULL,
  seconds_reserved INTEGER NOT NULL CHECK (seconds_reserved > 0),
  seconds_consumed INTEGER NOT NULL DEFAULT 0 CHECK (seconds_consumed >= 0),
  seconds_released INTEGER NOT NULL DEFAULT 0 CHECK (seconds_released >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'settled', 'released')),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  op_token TEXT NOT NULL DEFAULT '',
  CHECK (state = 'active' OR seconds_consumed + seconds_released = seconds_reserved)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pc_credit_reservations_active_job ON pc_credit_reservations(job_id) WHERE state = 'active';

-- Append-only. The account row is a cache of this ledger; the reconciliation
-- job proves they agree and reports — never repairs — when they do not.
CREATE TABLE IF NOT EXISTS pc_credit_ledger (
  id TEXT PRIMARY KEY,
  entry_key TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES pc_credit_accounts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  tier_id TEXT NOT NULL REFERENCES pc_credit_tiers(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'purchase', 'reserve', 'release', 'consume', 'refund', 'adjust_credit', 'adjust_debit',
    'conversion_in', 'conversion_out', 'expire', 'compensation'
  )),
  delta_available INTEGER NOT NULL,
  delta_reserved INTEGER NOT NULL,
  delta_consumed INTEGER NOT NULL,
  lot_id TEXT,
  reservation_id TEXT,
  job_id TEXT,
  order_id TEXT,
  value_iqd INTEGER NOT NULL DEFAULT 0,
  actor_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_credit_ledger_account ON pc_credit_ledger(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pc_credit_ledger_user ON pc_credit_ledger(user_id, created_at);

-- Which lot each consumed (or refunded, expired, converted) second came from.
CREATE TABLE IF NOT EXISTS pc_credit_lot_draws (
  id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL REFERENCES pc_credit_lots(id),
  ledger_entry_key TEXT NOT NULL,
  seconds INTEGER NOT NULL CHECK (seconds > 0),
  value_iqd INTEGER NOT NULL CHECK (value_iqd >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (lot_id, ledger_entry_key)
);

-- ------------------------------------------------------------------ workshop stock

CREATE TABLE IF NOT EXISTS pc_warehouse_locations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

-- Physical stock per variant. sellable = on_hand − reserved − allocated, where
-- `reserved` is held for unpaid orders and `allocated` is owned by customers
-- (still physically in the workshop). The sale guard is a fence inside the
-- reservation batch; a physical loss that leaves allocations above on-hand is
-- recorded as it happened and reported by reconciliation as a deficit.
CREATE TABLE IF NOT EXISTS pc_stock_positions (
  variant_id TEXT PRIMARY KEY REFERENCES pc_variants(id),
  on_hand_qty INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_pc_stock_on_hand CHECK (on_hand_qty >= 0),
  reserved_qty INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_pc_stock_reserved CHECK (reserved_qty >= 0),
  allocated_qty INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_pc_stock_allocated CHECK (allocated_qty >= 0),
  op_token TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pc_stock_lots (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  location_id TEXT REFERENCES pc_warehouse_locations(id),
  lot_code TEXT NOT NULL DEFAULT '',
  supplier TEXT NOT NULL DEFAULT '',
  received_qty INTEGER NOT NULL CHECK (received_qty > 0),
  on_hand_qty INTEGER NOT NULL CONSTRAINT ck_pc_stock_lot_on_hand CHECK (on_hand_qty >= 0),
  -- Cost (owner only): per base unit in thousandths of a dinar, and the total paid.
  unit_cost_milli_iqd INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_milli_iqd >= 0),
  total_cost_iqd INTEGER NOT NULL DEFAULT 0 CHECK (total_cost_iqd >= 0),
  -- 0 while the owner has not stated the cost (received without one, found by
  -- a count): the zeros above then mean UNKNOWN, never free. Stated once, by
  -- POST /admin/print-cloud/stock/lots/{id}/cost.
  cost_known INTEGER NOT NULL DEFAULT 1 CHECK (cost_known IN (0, 1)),
  received_at TEXT NOT NULL,
  received_by TEXT,
  levonis_lot_ref TEXT,
  notes TEXT NOT NULL DEFAULT '',
  CHECK (on_hand_qty <= received_qty)
);
CREATE INDEX IF NOT EXISTS idx_pc_stock_lots_variant ON pc_stock_lots(variant_id, received_at);

CREATE TABLE IF NOT EXISTS pc_stock_holds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES pc_orders(id),
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'converted', 'released')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE (order_id, variant_id)
);
CREATE INDEX IF NOT EXISTS idx_pc_stock_holds_active ON pc_stock_holds(state, expires_at);

-- Append-only physical/allocation movements of workshop stock.
CREATE TABLE IF NOT EXISTS pc_warehouse_ledger (
  id TEXT PRIMARY KEY,
  entry_key TEXT NOT NULL UNIQUE,
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  lot_id TEXT,
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'receive', 'hold', 'hold_release', 'allocate', 'deallocate', 'consume_customer', 'consume_workshop',
    'waste', 'damage', 'customer_return', 'ship_out', 'adjust_up', 'adjust_down', 'buyback_in'
  )),
  delta_on_hand INTEGER NOT NULL,
  delta_reserved INTEGER NOT NULL,
  delta_allocated INTEGER NOT NULL,
  user_id TEXT,
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '',
  cost_iqd INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_warehouse_ledger_variant ON pc_warehouse_ledger(variant_id, created_at);

-- Which stock lot each unit that left the shelf came from, at the cost known
-- when it left. cost_known = 0: the lot's cost was not stated then, so
-- cost_iqd is 0 and the profit report values the units from the cost the
-- owner states later — or reports them as cost pending.
CREATE TABLE IF NOT EXISTS pc_stock_lot_draws (
  id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL REFERENCES pc_stock_lots(id),
  ledger_entry_key TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  cost_iqd INTEGER NOT NULL CHECK (cost_iqd >= 0),
  cost_known INTEGER NOT NULL CHECK (cost_known IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (lot_id, ledger_entry_key)
);
CREATE INDEX IF NOT EXISTS idx_pc_stock_lot_draws_pending ON pc_stock_lot_draws(lot_id, created_at) WHERE cost_known = 0;

-- ------------------------------------------------------------------ customer-owned inventory

CREATE TABLE IF NOT EXISTS pc_inventory_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  unit_code TEXT NOT NULL REFERENCES pc_units(code),
  available_qty INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_pc_inventory_available CHECK (available_qty >= 0),
  reserved_qty INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_pc_inventory_reserved CHECK (reserved_qty >= 0),
  consumed_qty INTEGER NOT NULL DEFAULT 0 CHECK (consumed_qty >= 0),
  low_stock_alert_qty INTEGER CHECK (low_stock_alert_qty IS NULL OR low_stock_alert_qty >= 0),
  low_stock_notified_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, variant_id)
);

CREATE TABLE IF NOT EXISTS pc_inventory_lots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES pc_inventory_accounts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  source TEXT NOT NULL CHECK (source IN ('purchase', 'adjustment', 'compensation')),
  order_line_id TEXT REFERENCES pc_order_lines(id),
  qty_total INTEGER NOT NULL CHECK (qty_total > 0),
  qty_remaining INTEGER NOT NULL CONSTRAINT ck_pc_inventory_lot_remaining CHECK (qty_remaining >= 0),
  paid_iqd INTEGER NOT NULL DEFAULT 0 CHECK (paid_iqd >= 0),
  -- Earmarked for one printing project at purchase (fulfillment 'project').
  project_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (qty_remaining <= qty_total)
);
CREATE INDEX IF NOT EXISTS idx_pc_inventory_lots_account ON pc_inventory_lots(account_id, created_at);

CREATE TABLE IF NOT EXISTS pc_inventory_reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES pc_inventory_accounts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('print_job', 'delivery', 'buyback')),
  ref_id TEXT NOT NULL,
  qty_reserved INTEGER NOT NULL CHECK (qty_reserved > 0),
  qty_consumed INTEGER NOT NULL DEFAULT 0 CHECK (qty_consumed >= 0),
  qty_released INTEGER NOT NULL DEFAULT 0 CHECK (qty_released >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'settled', 'released')),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  op_token TEXT NOT NULL DEFAULT '',
  CHECK (state = 'active' OR qty_consumed + qty_released = qty_reserved)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pc_inventory_reservations_active
  ON pc_inventory_reservations(purpose, ref_id, account_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_pc_inventory_reservations_ref ON pc_inventory_reservations(purpose, ref_id);

CREATE TABLE IF NOT EXISTS pc_inventory_ledger (
  id TEXT PRIMARY KEY,
  entry_key TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES pc_inventory_accounts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'purchase', 'reserve', 'release', 'consume', 'deliver', 'buyback', 'refund',
    'adjust_credit', 'adjust_debit', 'compensation'
  )),
  delta_available INTEGER NOT NULL,
  delta_reserved INTEGER NOT NULL,
  delta_consumed INTEGER NOT NULL,
  lot_id TEXT,
  reservation_id TEXT,
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '',
  value_iqd INTEGER NOT NULL DEFAULT 0,
  actor_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_inventory_ledger_user ON pc_inventory_ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pc_inventory_ledger_account ON pc_inventory_ledger(account_id, created_at);

CREATE TABLE IF NOT EXISTS pc_inventory_lot_draws (
  id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL REFERENCES pc_inventory_lots(id),
  ledger_entry_key TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  value_iqd INTEGER NOT NULL CHECK (value_iqd >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (lot_id, ledger_entry_key)
);

-- ------------------------------------------------------------------ model files

CREATE TABLE IF NOT EXISTS pc_model_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  extension TEXT NOT NULL,
  format TEXT NOT NULL,
  -- What the bytes are (magic numbers / structure), independent of the name.
  type_check TEXT NOT NULL CHECK (type_check IN ('matched', 'mismatch', 'unknown')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  storage_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'url_import')),
  import_id TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'ready', 'rejected', 'failed')),
  rejection_code TEXT,
  analysis_json TEXT NOT NULL DEFAULT '{}',
  -- Bounding box in micrometres, once measured.
  size_x_um INTEGER,
  size_y_um INTEGER,
  size_z_um INTEGER,
  volume_mm3 INTEGER,
  triangle_count INTEGER,
  -- Retention: source files are kept until the owner deletes them; nothing
  -- deletes a file automatically (docs/PRINT_CLOUD.md §6.1).
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_model_files_user ON pc_model_files(user_id, created_at);

CREATE TABLE IF NOT EXISTS pc_model_imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL DEFAULT '',
  -- 'link_saved' means ONLY the link (and any metadata) was kept: no file was
  -- imported, and the customer must upload one. Never reported as an import.
  status TEXT NOT NULL CHECK (status IN ('pending', 'link_saved', 'file_imported', 'failed', 'rejected')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  license TEXT NOT NULL DEFAULT '',
  attribution TEXT NOT NULL DEFAULT '',
  file_id TEXT REFERENCES pc_model_files(id),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_model_imports_user ON pc_model_imports(user_id, created_at);

CREATE TABLE IF NOT EXISTS pc_model_import_logs (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES pc_model_imports(id),
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  code TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- ------------------------------------------------------------------ projects

CREATE TABLE IF NOT EXISTS pc_projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_type TEXT NOT NULL DEFAULT 'generic',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  duplicated_from TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_projects_user ON pc_projects(user_id, updated_at);

-- Group projects (data model only): a member listed here may see the project;
-- contributing credits or materials requires an explicit, per-member flag and
-- is not implemented yet — no resource ever moves between accounts.
CREATE TABLE IF NOT EXISTS pc_project_members (
  project_id TEXT NOT NULL REFERENCES pc_projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'contributor', 'viewer')),
  may_contribute_credits INTEGER NOT NULL DEFAULT 0 CHECK (may_contribute_credits IN (0, 1)),
  may_contribute_materials INTEGER NOT NULL DEFAULT 0 CHECK (may_contribute_materials IN (0, 1)),
  invited_by TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS pc_project_models (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES pc_projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  file_id TEXT REFERENCES pc_model_files(id),
  import_id TEXT REFERENCES pc_model_imports(id),
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1 AND quantity <= 1000),
  -- Printable configuration, kept apart from the untouched source file:
  -- rotation (millidegrees), scale (parts per million), orientation, colours.
  transform_json TEXT NOT NULL DEFAULT '{}',
  material_assignments_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (file_id IS NOT NULL OR import_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_pc_project_models_project ON pc_project_models(project_id);

CREATE TABLE IF NOT EXISTS pc_print_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_print_profiles_user ON pc_print_profiles(user_id);

CREATE TABLE IF NOT EXISTS pc_plates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES pc_projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  printer_model_id TEXT NOT NULL REFERENCES pc_printer_models(id),
  label TEXT NOT NULL DEFAULT '',
  -- 'manual' placements are validated; 'arranged' were produced by the named
  -- algorithm; nothing is reported as optimised that was not computed.
  arrangement TEXT NOT NULL DEFAULT 'manual' CHECK (arrangement IN ('manual', 'arranged')),
  algorithm TEXT NOT NULL DEFAULT '',
  spacing_um INTEGER NOT NULL DEFAULT 5000 CHECK (spacing_um >= 0),
  valid INTEGER NOT NULL DEFAULT 0 CHECK (valid IN (0, 1)),
  issues_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_plates_project ON pc_plates(project_id);

CREATE TABLE IF NOT EXISTS pc_plate_items (
  id TEXT PRIMARY KEY,
  plate_id TEXT NOT NULL REFERENCES pc_plates(id),
  project_model_id TEXT NOT NULL REFERENCES pc_project_models(id),
  instance_no INTEGER NOT NULL CHECK (instance_no >= 1),
  x_um INTEGER NOT NULL,
  y_um INTEGER NOT NULL,
  rotation_z_mdeg INTEGER NOT NULL DEFAULT 0,
  scale_ppm INTEGER NOT NULL DEFAULT 1000000 CHECK (scale_ppm > 0),
  variant_id TEXT REFERENCES pc_variants(id),
  UNIQUE (plate_id, project_model_id, instance_no)
);

-- ------------------------------------------------------------------ print jobs

CREATE TABLE IF NOT EXISTS pc_print_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL REFERENCES pc_projects(id),
  plate_id TEXT REFERENCES pc_plates(id),
  printer_model_id TEXT NOT NULL REFERENCES pc_printer_models(id),
  tier_id TEXT NOT NULL REFERENCES pc_credit_tiers(id),
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'uploaded', 'analyzing', 'ready', 'awaiting_confirmation', 'confirmed', 'queued',
    'preparing', 'printing', 'paused', 'completed', 'failed', 'cancelled', 'reprint_requested'
  )),
  settings_json TEXT NOT NULL DEFAULT '{}',
  copies INTEGER NOT NULL DEFAULT 1 CHECK (copies >= 1 AND copies <= 500),
  estimate_id TEXT,
  confirmation_expires_at TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  needs_operator_approval INTEGER NOT NULL DEFAULT 0 CHECK (needs_operator_approval IN (0, 1)),
  approved_by TEXT,
  approved_at TEXT,
  depends_on_job_id TEXT,
  parent_job_id TEXT,
  assigned_printer_id TEXT REFERENCES pc_printers(id),
  -- Instructions the operator follows (insert magnets at layer N, etc.).
  operator_instructions_json TEXT NOT NULL DEFAULT '[]',
  queued_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  billable_seconds INTEGER CHECK (billable_seconds IS NULL OR billable_seconds >= 0),
  printed_seconds INTEGER CHECK (printed_seconds IS NULL OR printed_seconds >= 0),
  failure_id TEXT,
  shipment_id TEXT,
  -- Compare-and-swap: every transition sets a fresh token and fences on it.
  op_token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_print_jobs_user ON pc_print_jobs(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_pc_print_jobs_status ON pc_print_jobs(status, priority, queued_at);

CREATE TABLE IF NOT EXISTS pc_print_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pc_print_jobs(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'operator', 'admin', 'agent', 'system')),
  actor_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_print_job_events_job ON pc_print_job_events(job_id, created_at);

-- What a job needs from the customer's inventory, per variant: filament from
-- the estimate (model + support + purge, per colour), accessories chosen by
-- the customer. Each is reserved and settled independently.
CREATE TABLE IF NOT EXISTS pc_job_requirements (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pc_print_jobs(id),
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  kind TEXT NOT NULL CHECK (kind IN ('filament', 'accessory')),
  source TEXT NOT NULL CHECK (source IN ('estimate', 'customer', 'recommendation')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  usage_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (job_id, variant_id, kind)
);

-- A slicing request: claimed by a slicer (the workshop agent running a real
-- slicer CLI with real printer profiles) and answered with measured figures.
CREATE TABLE IF NOT EXISTS pc_slicing_requests (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pc_print_jobs(id),
  adapter TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'succeeded', 'failed', 'cancelled')),
  input_json TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_slicing_requests_status ON pc_slicing_requests(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pc_slicing_requests_open ON pc_slicing_requests(job_id) WHERE status IN ('queued', 'claimed');

CREATE TABLE IF NOT EXISTS pc_estimates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pc_print_jobs(id),
  slicing_request_id TEXT REFERENCES pc_slicing_requests(id),
  -- Where the figures came from. Nothing here is ever a platform guess.
  provenance TEXT NOT NULL CHECK (provenance IN ('slicer', 'operator')),
  slicer_name TEXT NOT NULL DEFAULT '',
  slicer_version TEXT NOT NULL DEFAULT '',
  printer_profile TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  layer_count INTEGER,
  model_grams INTEGER NOT NULL DEFAULT 0 CHECK (model_grams >= 0),
  support_grams INTEGER NOT NULL DEFAULT 0 CHECK (support_grams >= 0),
  purge_grams INTEGER NOT NULL DEFAULT 0 CHECK (purge_grams >= 0),
  color_changes INTEGER NOT NULL DEFAULT 0 CHECK (color_changes >= 0),
  compatible INTEGER NOT NULL DEFAULT 1 CHECK (compatible IN (0, 1)),
  warnings_json TEXT NOT NULL DEFAULT '[]',
  generated_config_json TEXT NOT NULL DEFAULT '{}',
  submitted_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_estimates_job ON pc_estimates(job_id, created_at);

CREATE TABLE IF NOT EXISTS pc_estimate_materials (
  id TEXT PRIMARY KEY,
  estimate_id TEXT NOT NULL REFERENCES pc_estimates(id),
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  model_grams INTEGER NOT NULL DEFAULT 0 CHECK (model_grams >= 0),
  support_grams INTEGER NOT NULL DEFAULT 0 CHECK (support_grams >= 0),
  purge_grams INTEGER NOT NULL DEFAULT 0 CHECK (purge_grams >= 0),
  UNIQUE (estimate_id, variant_id)
);

CREATE TABLE IF NOT EXISTS pc_queue_entries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pc_print_jobs(id),
  priority INTEGER NOT NULL DEFAULT 0,
  enqueued_at TEXT NOT NULL,
  not_before TEXT,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'assigned', 'removed')),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pc_queue_entries_live ON pc_queue_entries(job_id) WHERE state <> 'removed';
CREATE INDEX IF NOT EXISTS idx_pc_queue_entries_order ON pc_queue_entries(state, priority, enqueued_at);

-- A physical printer works one job at a time, and a job is on one printer at a
-- time: both are partial UNIQUE indexes, so a conflicting assignment fails in
-- the database whatever the scheduler believed.
CREATE TABLE IF NOT EXISTS pc_printer_assignments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pc_print_jobs(id),
  printer_id TEXT NOT NULL REFERENCES pc_printers(id),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'finished', 'released')),
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pc_printer_assignments_printer ON pc_printer_assignments(printer_id) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_pc_printer_assignments_job ON pc_printer_assignments(job_id) WHERE state = 'active';

-- Actual consumption as reported (by the agent or an operator) and verified.
CREATE TABLE IF NOT EXISTS pc_consumption_records (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pc_print_jobs(id),
  reported_by_type TEXT NOT NULL CHECK (reported_by_type IN ('agent', 'operator', 'admin')),
  reported_by TEXT NOT NULL,
  printed_seconds INTEGER NOT NULL CHECK (printed_seconds >= 0),
  materials_json TEXT NOT NULL DEFAULT '[]',
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  verified_by TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_consumption_records_job ON pc_consumption_records(job_id);

CREATE TABLE IF NOT EXISTS pc_failures (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pc_print_jobs(id),
  reason_code TEXT NOT NULL,
  responsible TEXT NOT NULL CHECK (responsible IN ('workshop', 'customer', 'model', 'undetermined')),
  description TEXT NOT NULL DEFAULT '',
  printed_seconds INTEGER NOT NULL DEFAULT 0 CHECK (printed_seconds >= 0),
  failed_materials_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'reported' CHECK (status IN ('reported', 'resolved')),
  policy TEXT,
  billable_seconds INTEGER CHECK (billable_seconds IS NULL OR billable_seconds >= 0),
  reprint_eligible INTEGER NOT NULL DEFAULT 0 CHECK (reprint_eligible IN (0, 1)),
  reprint_job_id TEXT,
  resolution_json TEXT NOT NULL DEFAULT '{}',
  reported_by TEXT NOT NULL,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pc_failures_job_open ON pc_failures(job_id) WHERE status = 'reported';

-- ------------------------------------------------------------------ fulfilment

CREATE TABLE IF NOT EXISTS pc_shipments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('pickup', 'delivery')),
  status TEXT NOT NULL CHECK (status IN (
    'awaiting_payment', 'preparing', 'ready_for_pickup', 'shipped', 'delivered', 'picked_up', 'cancelled'
  )),
  address_json TEXT,
  packaging TEXT NOT NULL DEFAULT 'standard',
  fee_iqd INTEGER NOT NULL DEFAULT 0 CHECK (fee_iqd >= 0),
  fee_order_id TEXT REFERENCES pc_orders(id),
  carrier TEXT NOT NULL DEFAULT '',
  tracking_ref TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pc_shipments_user ON pc_shipments(user_id, created_at);

CREATE TABLE IF NOT EXISTS pc_shipment_items (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES pc_shipments(id),
  item_type TEXT NOT NULL CHECK (item_type IN ('print_job', 'inventory')),
  job_id TEXT REFERENCES pc_print_jobs(id),
  inventory_reservation_id TEXT REFERENCES pc_inventory_reservations(id),
  variant_id TEXT REFERENCES pc_variants(id),
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 1),
  live INTEGER NOT NULL DEFAULT 1 CHECK (live IN (0, 1)),
  CHECK ((item_type = 'print_job' AND job_id IS NOT NULL) OR (item_type = 'inventory' AND inventory_reservation_id IS NOT NULL))
);
-- A finished print is in at most one live shipment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pc_shipment_items_job ON pc_shipment_items(job_id) WHERE live = 1 AND job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pc_buyback_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  rate_bps INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  estimated_value_iqd INTEGER NOT NULL CHECK (estimated_value_iqd >= 0),
  lots_json TEXT NOT NULL,
  reservation_id TEXT REFERENCES pc_inventory_reservations(id),
  status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  payout_method TEXT NOT NULL DEFAULT 'manual' CHECK (payout_method IN ('manual', 'levonis_wallet')),
  payout_status TEXT NOT NULL DEFAULT 'none' CHECK (payout_status IN ('none', 'pending', 'paid')),
  final_value_iqd INTEGER CHECK (final_value_iqd IS NULL OR final_value_iqd >= 0),
  decided_by TEXT,
  decided_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_buyback_requests_user ON pc_buyback_requests(user_id, created_at);

-- ------------------------------------------------------------------ recommendations

CREATE TABLE IF NOT EXISTS pc_accessory_rules (
  id TEXT PRIMARY KEY,
  -- A lower-case keyword matched against names, tags and descriptions, and/or
  -- a project type the customer chose. Matching is lexical and says so.
  keyword TEXT NOT NULL DEFAULT '',
  project_type TEXT NOT NULL DEFAULT '',
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  qty_per_item INTEGER NOT NULL DEFAULT 1 CHECK (qty_per_item >= 1),
  needs_pause_at_layer INTEGER NOT NULL DEFAULT 0 CHECK (needs_pause_at_layer IN (0, 1)),
  note_ar TEXT NOT NULL DEFAULT '',
  note_en TEXT NOT NULL DEFAULT '',
  note_ckb TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (keyword <> '' OR project_type <> '')
);

CREATE TABLE IF NOT EXISTS pc_recommendations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL REFERENCES pc_projects(id),
  variant_id TEXT NOT NULL REFERENCES pc_variants(id),
  rule_id TEXT REFERENCES pc_accessory_rules(id),
  qty INTEGER NOT NULL CHECK (qty >= 1),
  reason_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'accepted', 'rejected')),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, variant_id)
);

-- ------------------------------------------------------------------ background work

CREATE TABLE IF NOT EXISTS pc_background_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  run_after TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pc_background_jobs_due ON pc_background_jobs(status, run_after);

CREATE TABLE IF NOT EXISTS pc_background_job_logs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pc_background_jobs(id),
  attempt INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_background_job_logs_job ON pc_background_job_logs(job_id, created_at);

-- Outbound events for the Levonis integration adapters (orders, accounting,
-- inventory). They wait here, 'pending', until an adapter is enabled; nothing
-- reports them delivered before one is.
CREATE TABLE IF NOT EXISTS pc_integration_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_integration_events_status ON pc_integration_events(status, created_at);

-- ------------------------------------------------------------------ append-only ledgers

CREATE TRIGGER IF NOT EXISTS trg_pc_credit_ledger_no_update BEFORE UPDATE ON pc_credit_ledger
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_credit_ledger_no_delete BEFORE DELETE ON pc_credit_ledger
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_credit_lot_draws_no_update BEFORE UPDATE ON pc_credit_lot_draws
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_credit_lot_draws_no_delete BEFORE DELETE ON pc_credit_lot_draws
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_inventory_ledger_no_update BEFORE UPDATE ON pc_inventory_ledger
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_inventory_ledger_no_delete BEFORE DELETE ON pc_inventory_ledger
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_inventory_lot_draws_no_update BEFORE UPDATE ON pc_inventory_lot_draws
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_inventory_lot_draws_no_delete BEFORE DELETE ON pc_inventory_lot_draws
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_stock_lot_draws_no_update BEFORE UPDATE ON pc_stock_lot_draws
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_stock_lot_draws_no_delete BEFORE DELETE ON pc_stock_lot_draws
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_warehouse_ledger_no_update BEFORE UPDATE ON pc_warehouse_ledger
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_warehouse_ledger_no_delete BEFORE DELETE ON pc_warehouse_ledger
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_print_job_events_no_update BEFORE UPDATE ON pc_print_job_events
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_print_job_events_no_delete BEFORE DELETE ON pc_print_job_events
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_payment_events_no_update BEFORE UPDATE ON pc_payment_events
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_payment_events_no_delete BEFORE DELETE ON pc_payment_events
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_price_changes_no_update BEFORE UPDATE ON pc_price_changes
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_price_changes_no_delete BEFORE DELETE ON pc_price_changes
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_printer_events_no_update BEFORE UPDATE ON pc_printer_events
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_pc_printer_events_no_delete BEFORE DELETE ON pc_printer_events
BEGIN
  SELECT RAISE(ABORT, 'PC_APPEND_ONLY');
END;
