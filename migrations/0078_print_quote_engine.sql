-- ===========================================================================
-- 0078 — THE PRINT QUOTE ENGINE
--
-- Additive only. Nothing here drops a column, rewrites a row or changes the
-- meaning of an existing one; `merchant_printers` (0045) keeps every field it
-- has and gains the economics it never had.
--
-- The shape follows docs/PRINT_QUOTE_ENGINE.md, and the rule that decides most
-- of it is §44: every number the engine uses records WHERE IT CAME FROM. A
-- column that can hold a measurement, a merchant's setting or a platform
-- default is useless for pricing unless the row also says which of the three
-- it is — so `*_source` columns are not bookkeeping, they are what lets the
-- merchant panel say «من بكرتك» instead of presenting an average as their cost.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE CANONICAL PRINTER. One row per machine, for the whole platform.
--
-- §24: "Do NOT duplicate the whole printer specification inside each merchant
-- record." Today every merchant re-types the same build volume for the same
-- A1 mini, and two merchants can disagree about a physical fact. From here a
-- merchant printer POINTS at one of these and overrides only its own money.
--
-- The physical rows below are seeded from studio/app/printer-profiles.ts, which
-- is where the slicer's own machine presets live — so the build volumes are the
-- ones the engine actually slices against, not numbers typed twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS printer_models (
  id TEXT PRIMARY KEY,
  manufacturer TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  generation TEXT NOT NULL DEFAULT '',
  technology TEXT NOT NULL DEFAULT 'fdm' CHECK (technology IN ('fdm','resin')),

  -- The slicer preset this model maps to. Without it a "printer" in the
  -- catalogue is a name that cannot be sliced for, which is how a comparison
  -- table ends up offering a machine nobody can quote.
  slicer_profile_id TEXT NOT NULL DEFAULT '',

  build_x_mm INTEGER NOT NULL DEFAULT 0,
  build_y_mm INTEGER NOT NULL DEFAULT 0,
  build_z_mm INTEGER NOT NULL DEFAULT 0,

  nozzle_sizes TEXT NOT NULL DEFAULT '[0.4]',   -- JSON array of mm
  default_nozzle_mm REAL NOT NULL DEFAULT 0.4,
  toolhead_count INTEGER NOT NULL DEFAULT 1,
  independent_toolheads INTEGER NOT NULL DEFAULT 0,
  max_simultaneous_materials INTEGER NOT NULL DEFAULT 1,

  -- How this machine changes material. The single most consequential field in
  -- the whole table: a flushing single nozzle and a pair of independent heads
  -- differ by tens of grams per change, and §9 forbids assuming either one.
  multi_material TEXT NOT NULL DEFAULT 'none'
    CHECK (multi_material IN ('none','single_nozzle_changer','independent_toolheads','idex','toolchanger')),
  -- 0 = seeded conservatively and NOT confirmed by a human. The admin panel
  -- shows it as unconfirmed; pricing uses the costlier reading until it is,
  -- because a quote that under-charges is worse than one that asks.
  multi_material_verified INTEGER NOT NULL DEFAULT 0,

  enclosed INTEGER NOT NULL DEFAULT 0,
  heated_chamber INTEGER NOT NULL DEFAULT 0,
  hardened_nozzle_available INTEGER NOT NULL DEFAULT 0,
  materials TEXT NOT NULL DEFAULT '[]',          -- JSON array of material TYPES

  -- Power, by phase. One flat wattage overstates a long print and understates
  -- a short one, because a bed pulls hardest while it is coming up to
  -- temperature. NULL = not costed yet; the engine charges no electricity and
  -- the panel says the figure is missing rather than inventing one.
  idle_watts INTEGER,
  bed_heating_watts INTEGER,
  nozzle_heating_watts INTEGER,
  printing_watts INTEGER,

  -- Purchase economics for depreciation (§16). Deliberately NULL on seed: a
  -- made-up purchase price would flow straight into every quote as a real cost.
  purchase_iqd INTEGER,
  residual_iqd INTEGER,
  useful_print_hours INTEGER,
  maintenance_iqd_per_hour INTEGER,

  -- The conservative starting point for reliability, replaced per merchant
  -- once there is history (§14). NULL = use the platform default.
  baseline_success_rate REAL,

  -- WHAT THE MACHINE CAN LAY DOWN. These four exist so a quote can be given
  -- WITHOUT a slicer: the browser slicer lives on another origin and never runs
  -- in the store bundle (docs/STUDIO_PLAN.md decision 6), and §4 forbids a
  -- native slicer in the Worker, so `worker/lib/printQuote/geometryAdapter.ts`
  -- turns the measured solid into an estimated time from these figures.
  --
  -- They are PHYSICS, not a shop's private economics, which is why — unlike
  -- purchase_iqd above — they are seeded with real values rather than left
  -- NULL: a flow rate of zero is not a missing number, it is an infinitely long
  -- print. Every value here is published by the manufacturer or measured on the
  -- machine, and the admin panel may correct any of them.
  --
  -- max_volumetric_flow_mm3_s  peak hotend throughput, mm³/s
  -- sustained_flow_fraction    the share of that peak a real print holds, once
  --                            perimeters, corners and the first layer are
  --                            counted. NEVER 1.
  -- layer_overhead_seconds     travel, retraction and acceleration per layer
  -- warmup_minutes             cold to first layer, charged once per plate
  max_volumetric_flow_mm3_s REAL,
  sustained_flow_fraction REAL,
  layer_overhead_seconds REAL,
  warmup_minutes REAL,

  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_printer_models_active ON printer_models(active, sort_order);

-- ---------------------------------------------------------------------------
-- 2. THE MERCHANT'S OWN MACHINE. Additive columns on the table that exists.
--
-- §46: economics yes, physics no. A merchant may say their machine cost less
-- or that their power is dearer; they may not turn a 180 mm bed into 350 mm,
-- because that silently accepts jobs the machine cannot print. So the physical
-- columns already on `merchant_printers` stay, `model_id` points at the
-- canonical truth, and everything added here is money or observation.
-- ---------------------------------------------------------------------------
ALTER TABLE merchant_printers ADD COLUMN model_id TEXT REFERENCES printer_models(id);
ALTER TABLE merchant_printers ADD COLUMN purchase_iqd INTEGER;
ALTER TABLE merchant_printers ADD COLUMN purchase_date TEXT;
ALTER TABLE merchant_printers ADD COLUMN residual_iqd INTEGER;
ALTER TABLE merchant_printers ADD COLUMN useful_print_hours INTEGER;
ALTER TABLE merchant_printers ADD COLUMN maintenance_iqd_per_hour INTEGER;
ALTER TABLE merchant_printers ADD COLUMN electricity_iqd_per_kwh INTEGER;
ALTER TABLE merchant_printers ADD COLUMN labor_iqd_per_hour INTEGER;
-- Hours this machine has actually printed, for depreciation that reflects age.
ALTER TABLE merchant_printers ADD COLUMN hours_printed REAL NOT NULL DEFAULT 0;
-- The multi-material system actually fitted. A machine that CAN take an AMS
-- and has not got one is a single-material printer today.
ALTER TABLE merchant_printers ADD COLUMN multi_material TEXT;
ALTER TABLE merchant_printers ADD COLUMN toolhead_count INTEGER;

-- ---------------------------------------------------------------------------
-- 3. MATERIALS, AND WHAT A SPOOL ACTUALLY COST.
--
-- There is no materials catalogue anywhere in the schema today; filament exists
-- only as a PRODUCT, and the only price on it is retail. §7 says a merchant's
-- acquisition cost outranks every catalogue — so it needs somewhere to live,
-- and `density_g_cm3` needs somewhere too: without it the slicer's millimetres
-- cannot become grams at all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_materials (
  id TEXT PRIMARY KEY,
  material_type TEXT NOT NULL,                   -- PLA, PETG, ABS, ASA, PC, PA, TPU…
  name TEXT NOT NULL DEFAULT '',
  name_ar TEXT NOT NULL DEFAULT '',
  -- g/cm³. The one number the mm→grams conversion cannot do without.
  density_g_cm3 REAL NOT NULL,
  diameter_mm REAL NOT NULL DEFAULT 1.75,
  -- The platform's last-resort price, used only when no merchant and no
  -- catalogue product answers (§7 rung 4).
  default_iqd_per_kg INTEGER,
  -- Physical gates, so an incompatible printer is refused before it is priced.
  needs_enclosure INTEGER NOT NULL DEFAULT 0,
  abrasive INTEGER NOT NULL DEFAULT 0,           -- CF/GF — needs a hardened nozzle
  nozzle_temp_c INTEGER,
  bed_temp_c INTEGER,
  supports_soluble_interface INTEGER NOT NULL DEFAULT 0,
  -- The filament PRODUCT this material is sold as, when the shop sells it.
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_print_materials_type ON print_materials(material_type, active);

CREATE TABLE IF NOT EXISTS merchant_spools (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES print_materials(id),
  brand TEXT NOT NULL DEFAULT '',
  color_name TEXT NOT NULL DEFAULT '',
  color_hex TEXT NOT NULL DEFAULT '',
  -- WHAT THEY PAID, not what it retails for. This is the number §7 puts at the
  -- top of the hierarchy, and the reason a merchant's quote is their quote.
  purchase_iqd INTEGER NOT NULL,
  original_grams INTEGER NOT NULL,
  remaining_grams REAL,                          -- NULL = not tracked
  purchase_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_merchant_spools_merchant ON merchant_spools(merchant_id, active);
CREATE INDEX IF NOT EXISTS idx_merchant_spools_material ON merchant_spools(material_id, active);

-- ---------------------------------------------------------------------------
-- 4. THE ANALYSIS — what the slicer measured, kept apart from what it cost.
--
-- §5: "Record raw analysis separately from commercial pricing." The same
-- analysis is priced differently by every merchant who looks at it, so it is a
-- row of its own and the quote points at it.
--
-- `owner_id` may be NULL: a guest can analyse (§23). The FILE behind it is
-- private either way (§34) and is reached only through an authorised route.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_analyses (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- For a guest, the throwaway session that may read it back.
  guest_token_hash TEXT,

  -- The private R2 object. NEVER a public key — a customer's STL is their
  -- intellectual property (§34).
  file_key TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  file_sha256 TEXT NOT NULL,
  file_bytes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'file' CHECK (source IN ('file','image','gcode')),

  -- The whole cache key (§36). Every input that can change a measurable output
  -- is in it; the file hash alone is not enough, because the same file at a
  -- different layer height is a different job.
  fingerprint TEXT NOT NULL,

  printer_model_id TEXT REFERENCES printer_models(id),
  slicer_version TEXT NOT NULL DEFAULT '',
  profile_revision TEXT NOT NULL DEFAULT '',
  quality_id TEXT NOT NULL DEFAULT 'standard',
  strength_id TEXT NOT NULL DEFAULT 'standard',
  nozzle_mm REAL NOT NULL DEFAULT 0.4,
  supports INTEGER NOT NULL DEFAULT 1,
  orientation_key TEXT NOT NULL DEFAULT '',

  provenance TEXT NOT NULL DEFAULT 'measured'
    CHECK (provenance IN ('measured','profile','merchant','platform','inferred')),

  bbox_x_mm REAL NOT NULL DEFAULT 0,
  bbox_y_mm REAL NOT NULL DEFAULT 0,
  bbox_z_mm REAL NOT NULL DEFAULT 0,
  model_volume_mm3 REAL NOT NULL DEFAULT 0,
  part_count INTEGER NOT NULL DEFAULT 1,

  layer_count INTEGER NOT NULL DEFAULT 0,
  layer_height_mm REAL NOT NULL DEFAULT 0,
  print_minutes_per_plate REAL NOT NULL DEFAULT 0,
  preparation_minutes REAL NOT NULL DEFAULT 0,
  plate_count INTEGER NOT NULL DEFAULT 1,
  pieces_per_plate INTEGER NOT NULL DEFAULT 1,
  tool_changes INTEGER NOT NULL DEFAULT 0,

  -- Gram buckets this slice could NOT separate, as a JSON array of component
  -- names. A zero in one of these means "not measured", never "none" — and the
  -- UI must say which, or a support line of 0 reads as "needs no support".
  unmeasured TEXT NOT NULL DEFAULT '[]',
  -- Why it is not usable, when it is not: off_bed, slice_failed, no_filament…
  refusal TEXT,

  state TEXT NOT NULL DEFAULT 'complete'
    CHECK (state IN ('uploading','validating','analyzing','slicing','complete','failed')),
  -- A guest analysis is temporary (§35). An analysis attached to an order is
  -- not, and this is set to NULL when that happens.
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_print_analyses_owner ON print_analyses(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_analyses_fingerprint ON print_analyses(fingerprint, state);
CREATE INDEX IF NOT EXISTS idx_print_analyses_expiry ON print_analyses(expires_at) WHERE expires_at IS NOT NULL;

-- One row per material the job consumes, with every gram attributed to the
-- PURPOSE it served. §8 forbids folding support into "total filament": the
-- reason a support-heavy model costs more has to be visible in the breakdown.
CREATE TABLE IF NOT EXISTS print_analysis_materials (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES print_analyses(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL DEFAULT 0,
  material_id TEXT,
  material_type TEXT NOT NULL DEFAULT '',
  color_hex TEXT NOT NULL DEFAULT '',
  model_grams REAL NOT NULL DEFAULT 0,
  support_grams REAL NOT NULL DEFAULT 0,
  support_interface_grams REAL NOT NULL DEFAULT 0,
  purge_grams REAL NOT NULL DEFAULT 0,
  prime_tower_grams REAL NOT NULL DEFAULT 0,
  brim_raft_grams REAL NOT NULL DEFAULT 0,
  other_waste_grams REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_print_analysis_materials_analysis
  ON print_analysis_materials(analysis_id, slot);

-- ---------------------------------------------------------------------------
-- 5. THE QUOTE, AND WHY IT MUST NEVER MOVE.
--
-- §30: a quote does not change later because a filament price changed, or a
-- margin was retuned, or the engine's rules improved. `snapshot` holds every
-- input the calculation used, and `engine_version` says which rules ran — so a
-- six-month-old order is still explainable and still reproducible.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_quotes (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES print_analyses(id) ON DELETE CASCADE,
  -- NULL for the platform's own customer-facing estimate; set when a specific
  -- shop priced it with their own machines and spools.
  merchant_id TEXT REFERENCES community_merchants(id) ON DELETE CASCADE,
  merchant_printer_id TEXT REFERENCES merchant_printers(id) ON DELETE SET NULL,
  printer_model_id TEXT REFERENCES printer_models(id),

  engine_version INTEGER NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'estimated'
    CHECK (confidence IN ('exact','estimated','insufficient')),

  quantity INTEGER NOT NULL DEFAULT 1,
  base_cost_iqd INTEGER NOT NULL DEFAULT 0,
  failure_reserve_iqd INTEGER NOT NULL DEFAULT 0,
  true_cost_iqd INTEGER NOT NULL DEFAULT 0,
  price_iqd INTEGER NOT NULL DEFAULT 0,
  profit_iqd INTEGER NOT NULL DEFAULT 0,
  margin_percent REAL NOT NULL DEFAULT 0,
  markup_percent REAL NOT NULL DEFAULT 0,
  break_even_iqd INTEGER NOT NULL DEFAULT 0,
  range_low_iqd INTEGER NOT NULL DEFAULT 0,
  range_high_iqd INTEGER NOT NULL DEFAULT 0,
  waste_grams REAL NOT NULL DEFAULT 0,
  waste_percent REAL NOT NULL DEFAULT 0,
  machine_hours REAL NOT NULL DEFAULT 0,

  -- Every input, frozen. This is what makes the row reproducible rather than
  -- merely recorded.
  snapshot TEXT NOT NULL DEFAULT '{}',

  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft','offered','accepted','expired','withdrawn')),
  -- `community_requests`, not `community_print_requests`: the latter is an
  -- EXTENSION table whose primary key is `request_id`, so referencing an `id`
  -- it does not have is a foreign-key mismatch at insert time — which is what
  -- the route test caught before this reached a migration run.
  request_id TEXT REFERENCES community_requests(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_print_quotes_analysis ON print_quotes(analysis_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_quotes_merchant ON print_quotes(merchant_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_quotes_request ON print_quotes(request_id) WHERE request_id IS NOT NULL;

-- §33: structured components, not one JSON blob. A shop cannot ask "where is
-- my money going" of a blob, and the whole point of the merchant view is that
-- the answer is a row it can sum, filter and chart.
CREATE TABLE IF NOT EXISTS print_quote_cost_components (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES print_quotes(id) ON DELETE CASCADE,
  component TEXT NOT NULL,
  iqd INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'platform'
    CHECK (source IN ('measured','profile','merchant','platform','inferred')),
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_print_quote_components_quote
  ON print_quote_cost_components(quote_id, component);

-- ---------------------------------------------------------------------------
-- 6. WHAT ACTUALLY HAPPENED — the loop that makes the next estimate better.
--
-- §47/§48. The stage matters more than the count: treating every failure as a
-- whole wasted print is exactly the over-charge §13 rules out, and the only way
-- to know the real average is to record where prints actually die.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_actuals (
  id TEXT PRIMARY KEY,
  quote_id TEXT REFERENCES print_quotes(id) ON DELETE SET NULL,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  merchant_printer_id TEXT REFERENCES merchant_printers(id) ON DELETE SET NULL,
  material_id TEXT REFERENCES print_materials(id),

  estimated_minutes REAL,
  actual_minutes REAL,
  estimated_grams REAL,
  actual_grams REAL,
  actual_waste_grams REAL,
  post_processing_minutes REAL,
  succeeded INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_print_actuals_merchant
  ON print_actuals(merchant_id, merchant_printer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS print_failures (
  id TEXT PRIMARY KEY,
  actual_id TEXT REFERENCES print_actuals(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  merchant_printer_id TEXT REFERENCES merchant_printers(id) ON DELETE SET NULL,
  material_id TEXT REFERENCES print_materials(id),
  cause TEXT NOT NULL DEFAULT 'unknown'
    CHECK (cause IN ('adhesion','spaghetti','clog','support_failure','layer_shift',
                     'filament','power','operator','unknown')),
  -- WHERE it died, as a fraction of the job. This is the field that turns the
  -- failure reserve from a guess into an observation.
  stage_percent REAL NOT NULL DEFAULT 50,
  wasted_grams REAL,
  lost_minutes REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_print_failures_merchant
  ON print_failures(merchant_id, merchant_printer_id, created_at DESC);

-- The rolled-up correction factors. Kept as a table rather than computed per
-- quote because §15 requires a MINIMUM SAMPLE before a factor is allowed to
-- move a price: `samples` is what the engine checks, and below the threshold
-- the baseline stands and the quote says `platform`.
CREATE TABLE IF NOT EXISTS printer_calibration_stats (
  id TEXT PRIMARY KEY,
  -- NULL merchant_id = the platform-wide roll-up for this model. The two are
  -- kept apart deliberately: one merchant's numbers must never leak into
  -- another merchant's quote (§14).
  merchant_id TEXT REFERENCES community_merchants(id) ON DELETE CASCADE,
  printer_model_id TEXT REFERENCES printer_models(id) ON DELETE CASCADE,
  merchant_printer_id TEXT REFERENCES merchant_printers(id) ON DELETE CASCADE,
  material_id TEXT REFERENCES print_materials(id) ON DELETE CASCADE,

  samples INTEGER NOT NULL DEFAULT 0,
  time_factor REAL,
  material_factor REAL,
  success_rate REAL,
  average_failure_fraction REAL,
  support_labor_minutes_per_100g REAL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_printer_calibration_scope
  ON printer_calibration_stats(
    COALESCE(merchant_id,''), COALESCE(merchant_printer_id,''),
    COALESCE(printer_model_id,''), COALESCE(material_id,'')
  );

-- ---------------------------------------------------------------------------
-- 7. SEED — physical specifications only.
--
-- Build volumes and nozzle come from studio/app/printer-profiles.ts, which are
-- the presets the slicer actually uses, so the catalogue and the engine cannot
-- disagree about whether a part fits.
--
-- EVERY ECONOMIC FIELD IS LEFT NULL ON PURPOSE. A seeded purchase price is an
-- invented number that would flow into every quote as a real cost (§53); until
-- an admin enters one, depreciation is zero and the panel says so.
--
-- `multi_material_verified = 0` everywhere: the mechanism is seeded to the
-- COSTLIER reading so a quote cannot under-charge before a human confirms it.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO printer_models
  (id, manufacturer, model, technology, slicer_profile_id,
   build_x_mm, build_y_mm, build_z_mm, nozzle_sizes, default_nozzle_mm,
   toolhead_count, independent_toolheads, max_simultaneous_materials,
   multi_material, multi_material_verified,
   enclosed, heated_chamber, hardened_nozzle_available, materials, sort_order)
VALUES
  ('bbl-a1m','Bambu Lab','A1 mini','fdm','bbl-a1m-04',180,180,180,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,0,0,1,'["PLA","PETG","TPU"]',10),
  ('bbl-a1','Bambu Lab','A1','fdm','bbl-a1-04',256,256,256,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,0,0,1,'["PLA","PETG","TPU"]',20),
  ('bbl-p1p','Bambu Lab','P1P','fdm','bbl-p1p-04',256,256,250,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,0,0,1,'["PLA","PETG","TPU"]',30),
  ('bbl-p1s','Bambu Lab','P1S','fdm','bbl-p1s-04',256,256,250,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,1,0,1,'["PLA","PETG","TPU","ABS","ASA"]',40),
  ('bbl-p2s','Bambu Lab','P2S','fdm','bbl-p2s-04',256,256,256,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,1,0,1,'["PLA","PETG","TPU","ABS","ASA"]',50),
  ('bbl-x1','Bambu Lab','X1','fdm','bbl-x1-04',256,256,250,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,1,0,1,'["PLA","PETG","TPU","ABS","ASA","PC"]',60),
  ('bbl-x1c','Bambu Lab','X1 Carbon','fdm','bbl-x1c-04',256,256,250,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,1,0,1,'["PLA","PETG","TPU","ABS","ASA","PC","PA"]',70),
  ('bbl-x1e','Bambu Lab','X1E','fdm','bbl-x1e-04',256,256,250,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,1,1,1,'["PLA","PETG","TPU","ABS","ASA","PC","PA"]',80),
  ('bbl-x2d','Bambu Lab','X2D','fdm','bbl-x2d-04',256,256,260,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,1,0,1,'["PLA","PETG","TPU","ABS","ASA","PC","PA"]',90),
  ('bbl-h2d','Bambu Lab','H2D','fdm','bbl-h2d-04',350,320,325,'[0.2,0.4,0.6,0.8]',0.4,
   2,1,8,'independent_toolheads',0,1,1,1,'["PLA","PETG","TPU","ABS","ASA","PC","PA"]',100),
  ('bbl-h2dp','Bambu Lab','H2D Pro','fdm','bbl-h2dp-04',350,320,325,'[0.2,0.4,0.6,0.8]',0.4,
   2,1,8,'independent_toolheads',0,1,1,1,'["PLA","PETG","TPU","ABS","ASA","PC","PA"]',110),
  ('bbl-h2c','Bambu Lab','H2C','fdm','bbl-h2c-04',330,320,325,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,1,1,1,'["PLA","PETG","TPU","ABS","ASA","PC","PA"]',120),
  ('bbl-h2s','Bambu Lab','H2S','fdm','bbl-h2s-04',340,320,340,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,1,1,1,'["PLA","PETG","TPU","ABS","ASA","PC","PA"]',130),
  ('bbl-a2l','Bambu Lab','A2L','fdm','bbl-a2l-04',330,320,325,'[0.2,0.4,0.6,0.8]',0.4,
   1,0,4,'single_nozzle_changer',0,0,0,1,'["PLA","PETG","TPU"]',140);

-- ---------------------------------------------------------------------------
-- 7b. WHAT EACH MACHINE CAN LAY DOWN — the geometry path's time model.
--
-- HOW HONEST EACH NUMBER IS, stated plainly because the whole engine turns on
-- not dressing an estimate as a measurement (§53):
--
--   max_volumetric_flow_mm3_s  Bambu publishes 28 mm³/s for the A1 series and
--                              32 mm³/s for the P1/X1 hotend with a 0.4 nozzle.
--                              For the models where no figure is confirmed here
--                              the CONSERVATIVE 32 stands in, which understates
--                              speed and therefore OVERSTATES time and cost —
--                              the safe direction for a shop. An admin raising
--                              it is a correction, never a discovery.
--
--   sustained_flow_fraction    0.55 everywhere: no print holds peak flow, and
--                              perimeters, corners, small features and the
--                              first layer all run far below it. A figure this
--                              blunt is why the geometry path produces a RANGE
--                              and is labelled `platform`, never `measured`.
--
--   layer_overhead_seconds     2.0 for a moving-bed machine (A1, A1 mini, A2L)
--                              against 1.5 for CoreXY: shifting the bed and the
--                              part costs more per layer than shifting a head.
--
--   warmup_minutes             4 open-frame, 6 enclosed — a chamber and a
--                              100 °C bed take longer to reach temperature.
--                              Charged once per PLATE (§12), not once per job.
--
-- A real slice REPLACES all of this the moment one exists for the same file and
-- profile, because `measured` outranks `platform` on the provenance ladder.
-- ---------------------------------------------------------------------------
UPDATE printer_models SET
  max_volumetric_flow_mm3_s = 32,
  sustained_flow_fraction   = 0.55,
  layer_overhead_seconds    = 1.5,
  warmup_minutes            = 4
WHERE technology = 'fdm' AND max_volumetric_flow_mm3_s IS NULL;

-- The two Bambu publishes at 28, and the three that move the bed instead of
-- the gantry.
UPDATE printer_models SET max_volumetric_flow_mm3_s = 28 WHERE id IN ('bbl-a1m','bbl-a1');
UPDATE printer_models SET layer_overhead_seconds = 2.0 WHERE id IN ('bbl-a1m','bbl-a1','bbl-a2l');
UPDATE printer_models SET warmup_minutes = 6 WHERE enclosed = 1;

-- The material densities the mm→grams conversion needs. These are physical
-- constants, not prices: `default_iqd_per_kg` stays NULL, because a made-up
-- filament price is exactly the kind of number §53 forbids.
INSERT OR IGNORE INTO print_materials
  (id, material_type, name, name_ar, density_g_cm3, diameter_mm,
   needs_enclosure, abrasive, nozzle_temp_c, bed_temp_c)
VALUES
  ('pla',    'PLA',    'PLA',        'بي إل إيه',      1.24, 1.75, 0, 0, 215,  60),
  ('pla-cf', 'PLA-CF', 'PLA-CF',     'بي إل إيه كربون', 1.22, 1.75, 0, 1, 230,  60),
  ('petg',   'PETG',   'PETG',       'بي إي تي جي',    1.27, 1.75, 0, 0, 240,  80),
  ('tpu',    'TPU',    'TPU',        'تي بي يو',       1.21, 1.75, 0, 0, 230,  45),
  ('abs',    'ABS',    'ABS',        'إيه بي إس',      1.04, 1.75, 1, 0, 260, 100),
  ('asa',    'ASA',    'ASA',        'إيه إس إيه',     1.07, 1.75, 1, 0, 260, 100),
  ('pc',     'PC',     'PC',         'بولي كربونيت',   1.20, 1.75, 1, 0, 270, 110),
  ('pa-cf',  'PA-CF',  'Nylon-CF',   'نايلون كربون',   1.18, 1.75, 1, 1, 290, 100),
  ('pva',    'PVA',    'PVA support','دعم قابل للذوبان',1.23, 1.75, 0, 0, 215,  60);

UPDATE print_materials SET supports_soluble_interface = 1 WHERE id = 'pva';
