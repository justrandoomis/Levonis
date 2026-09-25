-- ============================================================================
--  0132 — ELIGIBILITY AS DATA: WHAT A WORKSHOP CAN MAKE, WHAT IT HAS ON THE
--         SHELF, THE MATCHER'S VERDICT PER REVISION, AND WHO READ WHICH FILE.
-- ============================================================================
-- Stream W5-B (docs/merchant-platform/audit/03 §5, §6, §9 G6–G14 and G22,
-- §11 phases 2–4 and 6; docs/MERCHANT_PLATFORM.md §2 decisions 5–7, §4.7).
--
-- NONDESTRUCTIVE: three new tables, ADD COLUMNs with constant defaults, three
-- indexes, and an INSERT OR IGNORE seed of printer models. Nothing is dropped,
-- no table is rebuilt, no CHECK on an existing column is touched, no request,
-- offer, order or money row is written. The backfill of existing rows is 0133.
--
-- ---------------------------------------------------------------------------
--  1. merchant_material_stock — a LIGHT stock: material × colour × grams
-- ---------------------------------------------------------------------------
-- What the workshop has on the shelf, in the SAME material ids a request
-- names (the `printMaterials` catalogue: pla, petg, pa-cf, resin-tough …),
-- not the quote engine's `print_materials` ids — `merchant_spools` (0078)
-- keeps its purpose, the ACQUISITION COST of a spool for the costing engine,
-- and would need a resin row and a catalogue merge to answer this question.
--
-- One row per (material, colour). `color_hex = ''` means «this material, the
-- colour is not tracked» and satisfies a request in any colour; a hex means
-- that colour. `grams = 0` is a tracked line that is OUT of stock.
--
-- STOCK IS TRACKED WHEN THE WORKSHOP HAS AT LEAST ONE ROW. A workshop with no
-- row has never entered stock and is judged on its printers alone (the
-- dimension reads `untracked`); every existing merchant starts there, so this
-- migration changes nobody's eligibility. Clearing every row is an explicit
-- «stop tracking» in the API (`untrack: true`), never an empty list sent by
-- accident — an empty list must not quietly widen what a shop is shown.
--
-- ---------------------------------------------------------------------------
--  2. printer_models — more machines, resin among them, and who may pick them
-- ---------------------------------------------------------------------------
-- 0078 seeded fourteen Bambu Lab FDM machines. A resin workshop, or anyone on
-- a Creality or a Prusa, could only type a build volume by hand — the
-- self-declared capability the audit flagged (§9 G12). The rows below are
-- PHYSICS ONLY (build volume, enclosure, nozzle sizes, hardened-nozzle
-- option), from each manufacturer's published specification, with decimals
-- rounded DOWN so a part that fits the row fits the machine. Economics stay
-- NULL exactly as 0078 left them.
--
-- `merchant_selectable` — may a merchant link a printer to this row. The new
-- rows are seeded `active = 0`, which keeps them OUT of the customer price
-- calculator (`/api/print-quote/printers` lists `active = 1` only, and the
-- calculator's Studio presets exist for the Bambu machines alone), while the
-- workshop's printer picker lists every `merchant_selectable = 1` row. So the
-- customer calculator is exactly what it was, and a merchant can still tie a
-- resin machine to canonical physics.
--
-- The FDM flow figures follow 0078 §7b to the letter: the CONSERVATIVE 32
-- mm³/s where no figure is confirmed, 0.55 sustained, 1.5 s per layer on a
-- moving-head machine and 2.0 on a bed-slinger, 4 / 6 minutes warm-up — the
-- safe direction (they overstate time and cost). Resin rows carry none: the
-- geometry path is an extrusion model and the costing route refuses resin
-- (COSTING_RESIN_UNSUPPORTED) rather than price it with the wrong physics.
--
-- ---------------------------------------------------------------------------
--  3. community_request_matches — THE VERDICT, PER REVISION
-- ---------------------------------------------------------------------------
--   revision     the request revision this verdict was computed for. A row
--                whose revision is behind the request's is NOT trusted by any
--                reader: the board shows only `m.revision = r.revision`, and
--                an offer asks the live verdict and fences on the row.
--   reasons      every failing reason, in policy order (JSON array of codes);
--                `reject_reason` keeps the first, as before.
--   printer_id   the machine the job would run on (was only in the notice).
--   notify_ok    eligible AND the merchant wants to hear (switch on, not
--                paused) — the notification decision, kept apart from the
--                eligibility decision since W5-B (a switched-off notice no
--                longer takes a shop off the job).
--   engine       1 = decided by the matcher before W5-B; 2 = worker/lib/
--                eligibility.ts. 0133 queues every open request so its rows
--                are re-decided by engine 2.
--   computed_at  when this verdict was last computed.
--
-- ---------------------------------------------------------------------------
--  4. community_match_queue — the RE-MATCH queue
-- ---------------------------------------------------------------------------
-- A request revision, or a workshop's printers, stock, preferences or
-- delivery, changed: its verdicts must be decided again. One row per subject
-- (the primary key coalesces a burst of edits into one job); the writer
-- re-matches that subject inline, bounded, and the scheduled sweep
-- (`drainMatchQueue`, worker/lib/printMatchingStore.ts) finishes whatever an
-- inline pass left. A row is deleted only when its subject was re-matched.
--
-- ---------------------------------------------------------------------------
--  5. model_view_tokens — bound to a person and a revision, with a grant
-- ---------------------------------------------------------------------------
--   revision     the request revision the link was minted for; a new
--                revision retires every older link.
--   grant_level  'full' — the customer or the engaged merchant: the stored
--                preview mesh. 'preview' — an eligible merchant quoting on
--                the board: a coarser mesh derived from it (decimated and
--                snapped to a grid), never the stored one.
--   bound_user   1 = only the account that minted it may open it (every link
--                minted from W5-B on). 0133 revokes the unbound ones.
--
-- ---------------------------------------------------------------------------
--  6. request_file_reads — EVERY READ OF A REQUEST FILE, COUNTED
-- ---------------------------------------------------------------------------
-- One row per (file, reader, what, hour): an original download, a picture or
-- document shown inline, a preview link minted, the preview metadata and the
-- mesh. `count` rises with every read in that hour, so the table answers «who
-- saw this customer's model, as what, and when» without a row per request.
-- ============================================================================

CREATE TABLE IF NOT EXISTS merchant_material_stock (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL CHECK (length(material_id) BETWEEN 1 AND 60),
  color_hex TEXT NOT NULL DEFAULT ''
    CHECK (color_hex = '' OR (length(color_hex) = 7 AND substr(color_hex, 1, 1) = '#')),
  color_name TEXT NOT NULL DEFAULT '' CHECK (length(color_name) <= 40),
  grams INTEGER NOT NULL DEFAULT 0 CHECK (grams >= 0 AND grams <= 1000000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (merchant_id, material_id, color_hex)
);

ALTER TABLE printer_models ADD COLUMN merchant_selectable INTEGER NOT NULL DEFAULT 1;

INSERT OR IGNORE INTO printer_models
  (id, manufacturer, model, technology, slicer_profile_id,
   build_x_mm, build_y_mm, build_z_mm, nozzle_sizes, default_nozzle_mm,
   toolhead_count, independent_toolheads, max_simultaneous_materials,
   multi_material, multi_material_verified,
   enclosed, heated_chamber, hardened_nozzle_available, materials,
   max_volumetric_flow_mm3_s, sustained_flow_fraction, layer_overhead_seconds, warmup_minutes,
   active, merchant_selectable, sort_order)
VALUES
  ('cr-ender3v3se','Creality','Ender-3 V3 SE','fdm','',220,220,250,'[0.4]',0.4,
   1,0,1,'none',0,0,0,0,'["PLA","PETG","TPU"]',32,0.55,2.0,4,0,1,200),
  ('cr-k1','Creality','K1','fdm','',220,220,250,'[0.4,0.6,0.8]',0.4,
   1,0,1,'none',0,1,0,0,'["PLA","PETG","TPU","ABS","ASA"]',32,0.55,1.5,6,0,1,210),
  ('cr-k1c','Creality','K1C','fdm','',220,220,250,'[0.4,0.6,0.8]',0.4,
   1,0,1,'none',0,1,0,1,'["PLA","PETG","TPU","ABS","ASA","PA"]',32,0.55,1.5,6,0,1,220),
  ('cr-k1max','Creality','K1 Max','fdm','',300,300,300,'[0.4,0.6,0.8]',0.4,
   1,0,1,'none',0,1,0,1,'["PLA","PETG","TPU","ABS","ASA","PA"]',32,0.55,1.5,6,0,1,230),
  ('pr-mk4','Prusa Research','MK4','fdm','',250,210,220,'[0.25,0.4,0.6,0.8]',0.4,
   1,0,1,'none',0,0,0,1,'["PLA","PETG","TPU","ASA"]',32,0.55,2.0,4,0,1,240),
  ('pr-coreone','Prusa Research','Core One','fdm','',250,220,270,'[0.25,0.4,0.6,0.8]',0.4,
   1,0,1,'none',0,1,0,1,'["PLA","PETG","TPU","ABS","ASA","PC","PA"]',32,0.55,1.5,6,0,1,250),
  ('el-neptune4pro','Elegoo','Neptune 4 Pro','fdm','',225,225,265,'[0.4]',0.4,
   1,0,1,'none',0,0,0,0,'["PLA","PETG","TPU"]',32,0.55,2.0,4,0,1,260),
  ('el-mars4ultra','Elegoo','Mars 4 Ultra','resin','',153,77,165,'[]',0,
   1,0,1,'none',0,0,0,0,'["RESIN"]',NULL,NULL,NULL,NULL,0,1,300),
  ('el-saturn3ultra','Elegoo','Saturn 3 Ultra','resin','',218,122,260,'[]',0,
   1,0,1,'none',0,0,0,0,'["RESIN"]',NULL,NULL,NULL,NULL,0,1,310),
  ('el-saturn4ultra','Elegoo','Saturn 4 Ultra','resin','',218,122,220,'[]',0,
   1,0,1,'none',0,0,0,0,'["RESIN"]',NULL,NULL,NULL,NULL,0,1,320),
  ('ac-photonmono4','Anycubic','Photon Mono 4','resin','',153,87,165,'[]',0,
   1,0,1,'none',0,0,0,0,'["RESIN"]',NULL,NULL,NULL,NULL,0,1,330),
  ('ac-photonm5s','Anycubic','Photon Mono M5s','resin','',218,123,200,'[]',0,
   1,0,1,'none',0,0,0,0,'["RESIN"]',NULL,NULL,NULL,NULL,0,1,340),
  ('fl-form3plus','Formlabs','Form 3+','resin','',145,145,185,'[]',0,
   1,0,1,'none',0,0,0,0,'["RESIN"]',NULL,NULL,NULL,NULL,0,1,350);

ALTER TABLE community_request_matches ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_request_matches ADD COLUMN reasons TEXT NOT NULL DEFAULT '[]';
ALTER TABLE community_request_matches ADD COLUMN printer_id TEXT;
ALTER TABLE community_request_matches ADD COLUMN notify_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_request_matches ADD COLUMN engine INTEGER NOT NULL DEFAULT 1;
ALTER TABLE community_request_matches ADD COLUMN computed_at TEXT;

-- The board «مناسب لي» asks: this merchant's eligible verdicts.
CREATE INDEX IF NOT EXISTS idx_request_matches_merchant_eligible
  ON community_request_matches(merchant_id, eligible, revision);

CREATE TABLE IF NOT EXISTS community_match_queue (
  kind TEXT NOT NULL CHECK (kind IN ('request','merchant')),
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 40),
  queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (kind, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_match_queue_order ON community_match_queue(queued_at);

ALTER TABLE model_view_tokens ADD COLUMN revision INTEGER;
ALTER TABLE model_view_tokens ADD COLUMN grant_level TEXT NOT NULL DEFAULT 'full'
  CHECK (grant_level IN ('full','preview'));
ALTER TABLE model_view_tokens ADD COLUMN bound_user INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS request_file_reads (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('owner','admin','engaged','eligible')),
  what TEXT NOT NULL CHECK (what IN ('original','inline','preview_link','preview_meta','preview_mesh','costing')),
  revision INTEGER NOT NULL DEFAULT 0,
  hour TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  UNIQUE (file_id, user_id, what, hour)
);
CREATE INDEX IF NOT EXISTS idx_request_file_reads_request ON request_file_reads(request_id, last_at DESC);
