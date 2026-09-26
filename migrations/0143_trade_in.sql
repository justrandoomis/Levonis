-- ============================================================================
--  0143 — TRADE-IN: EXCHANGE A LEVONIS DEVICE FOR A NEW ONE
-- ============================================================================
-- The owner (2026-09-26): «طوّر ميزة Trade-in / استبدال الطابعة في LEVONIS
-- لتكون مخصصة فقط للمنتجات المشتراة من متجرنا، ولا تقبل أي جهاز من خارج
-- LEVONIS … النظام يعرض تقديراً أولياً فقط، ثم يرسل الطلب لمراجعة الأدمن
-- والفحص الفعلي قبل اعتماد القيمة النهائية».
--
-- SEVEN TABLES AND ONE COLUMN. The engine that prices a request is pure code
-- (packages/pricing/src/tradeIn.ts); these tables hold what it reads (the
-- versioned rules), what it is asked about (the request, its components, its
-- photographs) and what happened (the event log, the claims).
--
--   trade_in_rule_sets  one ROW PER SAVED VERSION per family (fdm, resin,
--                       laser, ams, accessory). Never updated: an admin save
--                       inserts version N+1, and the highest version is the
--                       one in force. A request records the versions it was
--                       priced with, so an estimate can always be re-derived.
--   trade_in_rules      the thirteen factors of one version: enabled, the
--                       factor's own weight in basis points («نسبة تأثير
--                       مستقلة وقابلة للتعديل») and its bands as JSON.
--   trade_in_requests   one per trade-in: the source line and unit, the scope
--                       (whole / printer_only / ams_only), the target product,
--                       the estimate, the admin's value, the final value, the
--                       difference, the status.
--   trade_in_components one per assessed part — a Combo's printer and its AMS
--                       are two rows with two sets of answers and two values.
--   trade_in_photos     the customer's pictures, private, under
--                       `trade-in/<request id>/…` (worker/routes/uploads.ts).
--   trade_in_events     the audit trail the timeline is drawn from.
--   trade_in_claims     THE MARK THAT A PART HAS BEEN TRADED (or is being).
--                       Keyed (order item, unit, part), so the same printer
--                       cannot be offered twice — not by two tabs, not by two
--                       requests, not after completion. A rejection or a
--                       cancellation deletes the claim in the same batch that
--                       closes the request, and only then is the part free.
--
-- `coupons.trade_in_id` — THE CREDIT. When the value is fixed, the Worker mints
-- a personal, single-use coupon worth it, bound to the customer and to the new
-- product and model (0077's own targeting columns). The ordinary checkout
-- redeems it, and 0049/0077's BEFORE INSERT trigger on coupon_redemptions is
-- what makes it count ONCE — inside the order's own batch. The column says
-- which trade-in minted the coupon, so the checkout can apply the trade-in's
-- extra rules (right customer, the target line in the cart, capped at that
-- line) and nothing else about coupons changes.
--
-- NONDESTRUCTIVE: new tables, their indexes, the default rule seeds, and one
-- nullable column on `coupons`. No existing row changes.

CREATE TABLE IF NOT EXISTS trade_in_rule_sets (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('fdm', 'resin', 'laser', 'ams', 'accessory')),
  version INTEGER NOT NULL CHECK (version >= 1),
  floor_bp INTEGER NOT NULL CHECK (floor_bp BETWEEN 0 AND 10000),
  cap_bp INTEGER NOT NULL CHECK (cap_bp BETWEEN 0 AND 10000),
  rounding_iqd INTEGER NOT NULL CHECK (rounding_iqd >= 1),
  min_base_iqd INTEGER NOT NULL DEFAULT 0 CHECK (min_base_iqd >= 0),
  ams_reference_iqd INTEGER NOT NULL DEFAULT 0 CHECK (ams_reference_iqd >= 0),
  is_default INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (family, version),
  CHECK (floor_bp <= cap_bp)
);

CREATE TABLE IF NOT EXISTS trade_in_rules (
  rule_set_id TEXT NOT NULL REFERENCES trade_in_rule_sets(id),
  factor TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  weight_bp INTEGER NOT NULL CHECK (weight_bp BETWEEN 0 AND 20000),
  config_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (rule_set_id, factor)
);

CREATE TABLE IF NOT EXISTS trade_in_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'submitted', 'under_review', 'approved_as_estimated', 'value_changed',
    'customer_accepted', 'customer_rejected', 'awaiting_payment', 'completed', 'cancelled'
  )),
  -- THE SOURCE: one physical unit of one delivered LEVONIS order line.
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  unit_index INTEGER NOT NULL DEFAULT 1 CHECK (unit_index >= 1),
  unit_id TEXT,
  source_product_id TEXT,
  family TEXT NOT NULL CHECK (family IN ('fdm', 'resin', 'laser', 'ams', 'accessory')),
  scope TEXT NOT NULL DEFAULT 'whole' CHECK (scope IN ('whole', 'printer_only', 'ams_only')),
  is_combo INTEGER NOT NULL DEFAULT 0,
  -- name, order number, delivered date, price paid, warranty end, the Combo
  -- split and how it was derived — frozen when the request was opened.
  source_snapshot_json TEXT NOT NULL DEFAULT '{}',
  -- THE TARGET: the new product and model, and its direct-sale price as the
  -- SERVER resolved it (after commission). Never a client figure.
  target_product_id TEXT,
  target_option_value_ids TEXT NOT NULL DEFAULT '[]',
  target_color_id TEXT,
  target_snapshot_json TEXT NOT NULL DEFAULT '{}',
  target_price_iqd INTEGER,
  -- THE MONEY. Integer dinars.
  estimated_iqd INTEGER,
  estimate_json TEXT NOT NULL DEFAULT '{}',
  rule_versions_json TEXT NOT NULL DEFAULT '{}',
  admin_value_iqd INTEGER,
  admin_reason TEXT NOT NULL DEFAULT '',
  -- Increments with every value the admin proposes; a decision names the
  -- offer it answers, so a stale Telegram button cannot accept a newer one.
  offer_no INTEGER NOT NULL DEFAULT 0,
  final_value_iqd INTEGER,
  credit_iqd INTEGER,
  difference_iqd INTEGER,
  coupon_id TEXT,
  customer_note TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT NOT NULL DEFAULT '',
  cancelled_by TEXT,
  decided_via TEXT NOT NULL DEFAULT '',
  -- The random token each state-changing batch writes, and the fence
  -- statement after it re-reads (the 0140 pattern): a second concurrent press
  -- finds another token and aborts its whole batch instead of applying twice.
  decision_token TEXT,
  tg_chat_id INTEGER,
  tg_message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  inspected_at TEXT,
  valued_at TEXT,
  decided_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_trade_in_requests_user ON trade_in_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trade_in_requests_status ON trade_in_requests(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_trade_in_requests_item ON trade_in_requests(order_item_id);

CREATE TABLE IF NOT EXISTS trade_in_components (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES trade_in_requests(id),
  role TEXT NOT NULL CHECK (role IN ('device', 'ams')),
  family TEXT NOT NULL CHECK (family IN ('fdm', 'resin', 'laser', 'ams', 'accessory')),
  label_ar TEXT NOT NULL DEFAULT '',
  label_en TEXT NOT NULL DEFAULT '',
  base_iqd INTEGER NOT NULL CHECK (base_iqd >= 0),
  inputs_json TEXT NOT NULL DEFAULT '{}',
  estimate_json TEXT NOT NULL DEFAULT '{}',
  value_iqd INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (request_id, role)
);

CREATE TABLE IF NOT EXISTS trade_in_photos (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES trade_in_requests(id),
  component_role TEXT NOT NULL CHECK (component_role IN ('device', 'ams')),
  angle TEXT NOT NULL,
  file_key TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_in_photos_request ON trade_in_photos(request_id, component_role, angle);

CREATE TABLE IF NOT EXISTS trade_in_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES trade_in_requests(id),
  actor_id TEXT,
  actor_role TEXT NOT NULL DEFAULT 'system' CHECK (actor_role IN ('customer', 'admin', 'system')),
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_in_events_request ON trade_in_events(request_id, created_at);

CREATE TABLE IF NOT EXISTS trade_in_claims (
  order_item_id TEXT NOT NULL,
  unit_index INTEGER NOT NULL,
  part TEXT NOT NULL CHECK (part IN ('device', 'ams')),
  request_id TEXT NOT NULL REFERENCES trade_in_requests(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (order_item_id, unit_index, part)
);
CREATE INDEX IF NOT EXISTS idx_trade_in_claims_request ON trade_in_claims(request_id);

ALTER TABLE coupons ADD COLUMN trade_in_id TEXT;
CREATE INDEX IF NOT EXISTS idx_coupons_trade_in ON coupons(trade_in_id);

-- ----------------------------------------------------------------------------
--  THE DEFAULT RULES — version 1 of every family, marked `is_default`.
--  Generated from DEFAULT_RULE_SETS in packages/pricing/src/tradeIn.ts, and
--  tests/tradeIn.test.ts fails if the two ever disagree. The owner tunes them
--  from «الاستبدال ← القواعد»; a save is version 2, and these rows stay as the
--  history they are.
-- ----------------------------------------------------------------------------

INSERT OR IGNORE INTO trade_in_rule_sets (id, family, version, floor_bp, cap_bp, rounding_iqd, min_base_iqd, ams_reference_iqd, is_default, note, created_by, created_at)
VALUES ('tirs_fdm_v1', 'fdm', 1, 1000, 8500, 1000, 100000, 0, 1, 'القيم الافتراضية — عدّلها من لوحة الإدارة', NULL, '2026-09-26T00:00:00.000Z');

INSERT OR IGNORE INTO trade_in_rules (rule_set_id, factor, enabled, weight_bp, config_json) VALUES
  ('tirs_fdm_v1', 'usage_age', 1, 10000, '{"kind":"age","per_month_bp":150,"max_bp":4500,"grace_months":0}'),
  ('tirs_fdm_v1', 'warranty_remaining', 1, 10000, '{"kind":"warranty","per_month_bp":60,"max_bp":800}'),
  ('tirs_fdm_v1', 'operating_hours', 1, 10000, '{"kind":"hours","bands":[{"up_to":300,"effect_bp":0},{"up_to":800,"effect_bp":-300},{"up_to":1500,"effect_bp":-700},{"up_to":3000,"effect_bp":-1300},{"up_to":null,"effect_bp":-2000}]}'),
  ('tirs_fdm_v1', 'cleanliness', 1, 10000, '{"kind":"scale","effects_bp":[-800,-400,-150,0,0]}'),
  ('tirs_fdm_v1', 'exterior', 1, 10000, '{"kind":"scale","effects_bp":[-1200,-600,-250,0,100]}'),
  ('tirs_fdm_v1', 'scratches', 1, 10000, '{"kind":"scale","effects_bp":[-800,-400,-150,0,0]}'),
  ('tirs_fdm_v1', 'faults', 1, 10000, '{"kind":"checklist","max_total_bp":-6000,"items":[{"id":"nozzle_clog","label_ar":"انسداد النوزل","label_en":"Clogged nozzle","effect_bp":-300},{"id":"extruder_skip","label_ar":"تقطيع أو انزلاق في الإكسترودر","label_en":"Extruder skipping","effect_bp":-500},{"id":"bed_leveling","label_ar":"مشكلة في معايرة السطح","label_en":"Bed-levelling problem","effect_bp":-500},{"id":"heating_error","label_ar":"خطأ في التسخين","label_en":"Heating error","effect_bp":-800},{"id":"motor_noise","label_ar":"صوت غير طبيعي في المحركات","label_en":"Abnormal motor noise","effect_bp":-400},{"id":"belt_wear","label_ar":"تآكل الأحزمة","label_en":"Worn belts","effect_bp":-300},{"id":"camera_lidar","label_ar":"عطل الكاميرا أو الليدار","label_en":"Camera or lidar fault","effect_bp":-400},{"id":"screen_touch","label_ar":"عطل الشاشة أو اللمس","label_en":"Screen or touch fault","effect_bp":-700},{"id":"wifi","label_ar":"مشكلة في الاتصال (واي فاي)","label_en":"Connectivity (Wi-Fi) problem","effect_bp":-300},{"id":"fan_noise","label_ar":"مروحة عالية الصوت أو معطلة","label_en":"Loud or dead fan","effect_bp":-200},{"id":"filament_sensor","label_ar":"عطل حساس الفلمنت","label_en":"Filament sensor fault","effect_bp":-300},{"id":"mainboard","label_ar":"عطل في اللوحة الأم","label_en":"Mainboard fault","effect_bp":-2000}]}'),
  ('tirs_fdm_v1', 'repairs', 1, 10000, '{"kind":"count","per_item_bp":300,"max_bp":1200}'),
  ('tirs_fdm_v1', 'replaced_parts', 1, 10000, '{"kind":"checklist","max_total_bp":-1500,"items":[{"id":"hotend","label_ar":"رأس الطباعة (Hotend)","label_en":"Hotend","effect_bp":-100},{"id":"nozzle","label_ar":"النوزل","label_en":"Nozzle","effect_bp":0},{"id":"build_plate","label_ar":"سطح الطباعة","label_en":"Build plate","effect_bp":-100},{"id":"belts","label_ar":"الأحزمة","label_en":"Belts","effect_bp":-100},{"id":"extruder","label_ar":"الإكسترودر","label_en":"Extruder","effect_bp":-200},{"id":"mainboard","label_ar":"اللوحة الأم","label_en":"Mainboard","effect_bp":-600},{"id":"screen","label_ar":"الشاشة","label_en":"Screen","effect_bp":-300},{"id":"fan","label_ar":"مروحة","label_en":"Fan","effect_bp":-100},{"id":"power_supply","label_ar":"مزود الطاقة","label_en":"Power supply","effect_bp":-300}]}'),
  ('tirs_fdm_v1', 'accessory_condition', 1, 10000, '{"kind":"scale","effects_bp":[-400,-200,-100,0,0]}'),
  ('tirs_fdm_v1', 'original_accessories', 1, 10000, '{"kind":"choice","options":[{"id":"all","effect_bp":0},{"id":"partial","effect_bp":-300},{"id":"none","effect_bp":-700}]}'),
  ('tirs_fdm_v1', 'market', 1, 10000, '{"kind":"market","resale_bp":-1000,"product_overrides":[]}'),
  ('tirs_fdm_v1', 'product_type', 1, 10000, '{"kind":"flat","effect_bp":0}');

INSERT OR IGNORE INTO trade_in_rule_sets (id, family, version, floor_bp, cap_bp, rounding_iqd, min_base_iqd, ams_reference_iqd, is_default, note, created_by, created_at)
VALUES ('tirs_resin_v1', 'resin', 1, 1000, 8000, 1000, 100000, 0, 1, 'القيم الافتراضية — عدّلها من لوحة الإدارة', NULL, '2026-09-26T00:00:00.000Z');

INSERT OR IGNORE INTO trade_in_rules (rule_set_id, factor, enabled, weight_bp, config_json) VALUES
  ('tirs_resin_v1', 'usage_age', 1, 10000, '{"kind":"age","per_month_bp":200,"max_bp":5000,"grace_months":0}'),
  ('tirs_resin_v1', 'warranty_remaining', 1, 10000, '{"kind":"warranty","per_month_bp":60,"max_bp":800}'),
  ('tirs_resin_v1', 'operating_hours', 1, 10000, '{"kind":"hours","bands":[{"up_to":200,"effect_bp":0},{"up_to":500,"effect_bp":-400},{"up_to":1000,"effect_bp":-900},{"up_to":2000,"effect_bp":-1600},{"up_to":null,"effect_bp":-2500}]}'),
  ('tirs_resin_v1', 'cleanliness', 1, 10000, '{"kind":"scale","effects_bp":[-1200,-600,-200,0,0]}'),
  ('tirs_resin_v1', 'exterior', 1, 10000, '{"kind":"scale","effects_bp":[-1200,-600,-250,0,100]}'),
  ('tirs_resin_v1', 'scratches', 1, 10000, '{"kind":"scale","effects_bp":[-800,-400,-150,0,0]}'),
  ('tirs_resin_v1', 'faults', 1, 10000, '{"kind":"checklist","max_total_bp":-6000,"items":[{"id":"lcd_screen","label_ar":"تلف شاشة LCD","label_en":"Damaged LCD screen","effect_bp":-2500},{"id":"fep_film","label_ar":"فيلم FEP مستهلك","label_en":"Worn FEP film","effect_bp":-200},{"id":"vat_leak","label_ar":"تسريب في الحوض","label_en":"Leaking vat","effect_bp":-600},{"id":"uv_light","label_ar":"ضعف ضوء UV","label_en":"Weak UV light","effect_bp":-1500},{"id":"z_axis","label_ar":"اهتزاز أو خلل في محور Z","label_en":"Z-axis wobble or fault","effect_bp":-800},{"id":"plate_adhesion","label_ar":"ضعف الالتصاق بالمنصة","label_en":"Poor plate adhesion","effect_bp":-300},{"id":"touch_screen","label_ar":"عطل شاشة اللمس","label_en":"Touch-screen fault","effect_bp":-700},{"id":"resin_inside","label_ar":"تسرب ريزن داخل الجهاز","label_en":"Resin spilled inside","effect_bp":-1500}]}'),
  ('tirs_resin_v1', 'repairs', 1, 10000, '{"kind":"count","per_item_bp":300,"max_bp":1200}'),
  ('tirs_resin_v1', 'replaced_parts', 1, 10000, '{"kind":"checklist","max_total_bp":-1500,"items":[{"id":"lcd","label_ar":"شاشة LCD","label_en":"LCD screen","effect_bp":-200},{"id":"fep","label_ar":"فيلم FEP","label_en":"FEP film","effect_bp":0},{"id":"vat","label_ar":"الحوض","label_en":"Vat","effect_bp":-100},{"id":"build_platform","label_ar":"منصة الطباعة","label_en":"Build platform","effect_bp":-100},{"id":"uv_module","label_ar":"وحدة UV","label_en":"UV module","effect_bp":-300},{"id":"mainboard","label_ar":"اللوحة الأم","label_en":"Mainboard","effect_bp":-600},{"id":"screen","label_ar":"الشاشة","label_en":"Screen","effect_bp":-300},{"id":"fan","label_ar":"مروحة","label_en":"Fan","effect_bp":-100},{"id":"power_supply","label_ar":"مزود الطاقة","label_en":"Power supply","effect_bp":-300}]}'),
  ('tirs_resin_v1', 'accessory_condition', 1, 10000, '{"kind":"scale","effects_bp":[-400,-200,-100,0,0]}'),
  ('tirs_resin_v1', 'original_accessories', 1, 10000, '{"kind":"choice","options":[{"id":"all","effect_bp":0},{"id":"partial","effect_bp":-300},{"id":"none","effect_bp":-700}]}'),
  ('tirs_resin_v1', 'market', 1, 10000, '{"kind":"market","resale_bp":-1500,"product_overrides":[]}'),
  ('tirs_resin_v1', 'product_type', 1, 10000, '{"kind":"flat","effect_bp":-500}');

INSERT OR IGNORE INTO trade_in_rule_sets (id, family, version, floor_bp, cap_bp, rounding_iqd, min_base_iqd, ams_reference_iqd, is_default, note, created_by, created_at)
VALUES ('tirs_laser_v1', 'laser', 1, 1000, 8000, 1000, 100000, 0, 1, 'القيم الافتراضية — عدّلها من لوحة الإدارة', NULL, '2026-09-26T00:00:00.000Z');

INSERT OR IGNORE INTO trade_in_rules (rule_set_id, factor, enabled, weight_bp, config_json) VALUES
  ('tirs_laser_v1', 'usage_age', 1, 10000, '{"kind":"age","per_month_bp":150,"max_bp":4500,"grace_months":0}'),
  ('tirs_laser_v1', 'warranty_remaining', 1, 10000, '{"kind":"warranty","per_month_bp":60,"max_bp":800}'),
  ('tirs_laser_v1', 'operating_hours', 1, 10000, '{"kind":"hours","bands":[{"up_to":300,"effect_bp":0},{"up_to":800,"effect_bp":-400},{"up_to":1500,"effect_bp":-900},{"up_to":3000,"effect_bp":-1600},{"up_to":null,"effect_bp":-2500}]}'),
  ('tirs_laser_v1', 'cleanliness', 1, 10000, '{"kind":"scale","effects_bp":[-1000,-500,-200,0,0]}'),
  ('tirs_laser_v1', 'exterior', 1, 10000, '{"kind":"scale","effects_bp":[-1200,-600,-250,0,100]}'),
  ('tirs_laser_v1', 'scratches', 1, 10000, '{"kind":"scale","effects_bp":[-800,-400,-150,0,0]}'),
  ('tirs_laser_v1', 'faults', 1, 10000, '{"kind":"checklist","max_total_bp":-6000,"items":[{"id":"lens","label_ar":"اتساخ أو خدش العدسة","label_en":"Dirty or scratched lens","effect_bp":-500},{"id":"module_power","label_ar":"ضعف قوة الليزر","label_en":"Laser power loss","effect_bp":-2500},{"id":"air_assist","label_ar":"عطل نفخ الهواء","label_en":"Air-assist fault","effect_bp":-300},{"id":"homing","label_ar":"خطأ في العودة للصفر","label_en":"Homing error","effect_bp":-500},{"id":"fan_noise","label_ar":"مروحة عالية الصوت أو معطلة","label_en":"Loud or dead fan","effect_bp":-200},{"id":"camera","label_ar":"عطل الكاميرا","label_en":"Camera fault","effect_bp":-400},{"id":"safety_sensor","label_ar":"عطل حساس الأمان","label_en":"Safety-sensor fault","effect_bp":-600}]}'),
  ('tirs_laser_v1', 'repairs', 1, 10000, '{"kind":"count","per_item_bp":300,"max_bp":1200}'),
  ('tirs_laser_v1', 'replaced_parts', 1, 10000, '{"kind":"checklist","max_total_bp":-1500,"items":[{"id":"lens","label_ar":"العدسة","label_en":"Lens","effect_bp":0},{"id":"laser_module","label_ar":"وحدة الليزر","label_en":"Laser module","effect_bp":-300},{"id":"belts","label_ar":"الأحزمة","label_en":"Belts","effect_bp":-100},{"id":"mainboard","label_ar":"اللوحة الأم","label_en":"Mainboard","effect_bp":-600},{"id":"screen","label_ar":"الشاشة","label_en":"Screen","effect_bp":-300},{"id":"fan","label_ar":"مروحة","label_en":"Fan","effect_bp":-100},{"id":"power_supply","label_ar":"مزود الطاقة","label_en":"Power supply","effect_bp":-300}]}'),
  ('tirs_laser_v1', 'accessory_condition', 1, 10000, '{"kind":"scale","effects_bp":[-400,-200,-100,0,0]}'),
  ('tirs_laser_v1', 'original_accessories', 1, 10000, '{"kind":"choice","options":[{"id":"all","effect_bp":0},{"id":"partial","effect_bp":-300},{"id":"none","effect_bp":-700}]}'),
  ('tirs_laser_v1', 'market', 1, 10000, '{"kind":"market","resale_bp":-1200,"product_overrides":[]}'),
  ('tirs_laser_v1', 'product_type', 1, 10000, '{"kind":"flat","effect_bp":-300}');

INSERT OR IGNORE INTO trade_in_rule_sets (id, family, version, floor_bp, cap_bp, rounding_iqd, min_base_iqd, ams_reference_iqd, is_default, note, created_by, created_at)
VALUES ('tirs_ams_v1', 'ams', 1, 1000, 8000, 1000, 50000, 0, 1, 'القيم الافتراضية — عدّلها من لوحة الإدارة', NULL, '2026-09-26T00:00:00.000Z');

INSERT OR IGNORE INTO trade_in_rules (rule_set_id, factor, enabled, weight_bp, config_json) VALUES
  ('tirs_ams_v1', 'usage_age', 1, 10000, '{"kind":"age","per_month_bp":120,"max_bp":4000,"grace_months":0}'),
  ('tirs_ams_v1', 'warranty_remaining', 1, 10000, '{"kind":"warranty","per_month_bp":50,"max_bp":600}'),
  ('tirs_ams_v1', 'operating_hours', 0, 10000, '{"kind":"hours","bands":[{"up_to":null,"effect_bp":0}]}'),
  ('tirs_ams_v1', 'cleanliness', 1, 10000, '{"kind":"scale","effects_bp":[-800,-400,-150,0,0]}'),
  ('tirs_ams_v1', 'exterior', 1, 10000, '{"kind":"scale","effects_bp":[-1000,-500,-200,0,100]}'),
  ('tirs_ams_v1', 'scratches', 1, 10000, '{"kind":"scale","effects_bp":[-600,-300,-100,0,0]}'),
  ('tirs_ams_v1', 'faults', 1, 10000, '{"kind":"checklist","max_total_bp":-5000,"items":[{"id":"feed_error","label_ar":"أخطاء في سحب الفلمنت","label_en":"Filament feed errors","effect_bp":-700},{"id":"rfid","label_ar":"عطل قارئ RFID","label_en":"RFID reader fault","effect_bp":-300},{"id":"buffer","label_ar":"مشكلة في الـ Buffer","label_en":"Buffer problem","effect_bp":-400},{"id":"motor_noise","label_ar":"صوت غير طبيعي في المحركات","label_en":"Abnormal motor noise","effect_bp":-400},{"id":"humidity_sensor","label_ar":"عطل حساس الرطوبة","label_en":"Humidity-sensor fault","effect_bp":-200},{"id":"cutter","label_ar":"مشكلة في القاطع","label_en":"Cutter problem","effect_bp":-500},{"id":"ptfe_tubes","label_ar":"أنابيب PTFE مستهلكة","label_en":"Worn PTFE tubes","effect_bp":-100}]}'),
  ('tirs_ams_v1', 'repairs', 1, 10000, '{"kind":"count","per_item_bp":300,"max_bp":1200}'),
  ('tirs_ams_v1', 'replaced_parts', 1, 10000, '{"kind":"checklist","max_total_bp":-1200,"items":[{"id":"feeder","label_ar":"وحدة السحب (Feeder)","label_en":"Feeder unit","effect_bp":-200},{"id":"ptfe","label_ar":"أنابيب PTFE","label_en":"PTFE tubes","effect_bp":0},{"id":"mainboard","label_ar":"اللوحة الأم","label_en":"Mainboard","effect_bp":-600}]}'),
  ('tirs_ams_v1', 'accessory_condition', 1, 10000, '{"kind":"scale","effects_bp":[-300,-150,-50,0,0]}'),
  ('tirs_ams_v1', 'original_accessories', 1, 10000, '{"kind":"choice","options":[{"id":"all","effect_bp":0},{"id":"partial","effect_bp":-300},{"id":"none","effect_bp":-600}]}'),
  ('tirs_ams_v1', 'market', 1, 10000, '{"kind":"market","resale_bp":-1000,"product_overrides":[]}'),
  ('tirs_ams_v1', 'product_type', 1, 10000, '{"kind":"flat","effect_bp":0}');

INSERT OR IGNORE INTO trade_in_rule_sets (id, family, version, floor_bp, cap_bp, rounding_iqd, min_base_iqd, ams_reference_iqd, is_default, note, created_by, created_at)
VALUES ('tirs_accessory_v1', 'accessory', 1, 500, 7000, 1000, 50000, 0, 1, 'القيم الافتراضية — عدّلها من لوحة الإدارة', NULL, '2026-09-26T00:00:00.000Z');

INSERT OR IGNORE INTO trade_in_rules (rule_set_id, factor, enabled, weight_bp, config_json) VALUES
  ('tirs_accessory_v1', 'usage_age', 1, 10000, '{"kind":"age","per_month_bp":200,"max_bp":6000,"grace_months":0}'),
  ('tirs_accessory_v1', 'warranty_remaining', 1, 10000, '{"kind":"warranty","per_month_bp":50,"max_bp":500}'),
  ('tirs_accessory_v1', 'operating_hours', 0, 10000, '{"kind":"hours","bands":[{"up_to":null,"effect_bp":0}]}'),
  ('tirs_accessory_v1', 'cleanliness', 1, 10000, '{"kind":"scale","effects_bp":[-800,-400,-150,0,0]}'),
  ('tirs_accessory_v1', 'exterior', 1, 10000, '{"kind":"scale","effects_bp":[-1200,-600,-250,0,0]}'),
  ('tirs_accessory_v1', 'scratches', 1, 10000, '{"kind":"scale","effects_bp":[-800,-400,-150,0,0]}'),
  ('tirs_accessory_v1', 'faults', 1, 10000, '{"kind":"checklist","max_total_bp":-7000,"items":[{"id":"not_working","label_ar":"لا يعمل","label_en":"Does not work","effect_bp":-6000},{"id":"partial","label_ar":"يعمل جزئياً","label_en":"Works partly","effect_bp":-2500},{"id":"missing_parts","label_ar":"قطع ناقصة","label_en":"Missing parts","effect_bp":-1500}]}'),
  ('tirs_accessory_v1', 'repairs', 1, 10000, '{"kind":"count","per_item_bp":500,"max_bp":1500}'),
  ('tirs_accessory_v1', 'replaced_parts', 0, 10000, '{"kind":"checklist","max_total_bp":0,"items":[]}'),
  ('tirs_accessory_v1', 'accessory_condition', 0, 10000, '{"kind":"scale","effects_bp":[0,0,0,0,0]}'),
  ('tirs_accessory_v1', 'original_accessories', 1, 10000, '{"kind":"choice","options":[{"id":"all","effect_bp":0},{"id":"partial","effect_bp":-500},{"id":"none","effect_bp":-1000}]}'),
  ('tirs_accessory_v1', 'market', 1, 10000, '{"kind":"market","resale_bp":-2000,"product_overrides":[]}'),
  ('tirs_accessory_v1', 'product_type', 1, 10000, '{"kind":"flat","effect_bp":-1000}');
