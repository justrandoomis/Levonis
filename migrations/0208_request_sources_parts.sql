-- 0208 — A PRINT REQUEST OF SEVERAL SOURCES, PARTS, MATERIALS AND COLOURS
-- (Community V3 §4.1, plan P1-04, docs/DECISIONS.md row 266).
--
-- A request used to describe ONE job: one process, one material, one colour,
-- one primary file and one link on `community_print_requests`. This adds the
-- model beside it, never instead of it:
--
--   community_request_sources         every file, link and text reference the
--                                     job comes from, with a note, a primary
--                                     and a role. A file is the request's OWN
--                                     copy (conflict 5): a project post or a
--                                     Studio revision is copied in, never
--                                     referenced, so `origin_*` is provenance
--                                     only and is never followed to read bytes.
--   community_request_parts           what is made. `quantity` is pieces per
--                                     SET, the request's `quantity` stays sets.
--   community_request_part_sources    which sources describe which part.
--   community_request_part_materials  the material and colours of a part (one
--                                     row per material, colours as JSON).
--
-- THE V1 ROW STAYS, AND IS ALWAYS WRITTEN. Every writer of the new build
-- writes the old columns as a coherent mirror of the model in the same batch,
-- so an older Worker redeployed by hand reads a job it understands. The
-- summary columns below are a cache for SQL readers, trusted only while
-- `model_mirror` still equals the fingerprint of the v1 row it was written
-- with (worker/lib/requestModel.ts `MIRROR_SQL`). The revision hash follows
-- `schema_version`, never whether rows exist here: a version-1 request keeps
-- the byte-exact v1 string, so a pending offer stays acceptable.
--
-- `budget_visible` is owner decision Q2: a budget is private by default and
-- shown to merchants only behind «اعرض ميزانيتي للتجار». The offer columns
-- are for P1-05: NULL coverage means the whole request, as every existing
-- offer is. No money column is touched.
--
-- Additive only: CREATE TABLE, ADD COLUMN and CREATE INDEX. No row is written
-- here (the model of an existing request is synthesised on read and
-- materialised by the quarter-hour job), no CHECK is rebuilt, every added
-- column has a default so an older build's INSERTs keep working.

-- A source may name only a file of ITS OWN request (the composite key below).
CREATE UNIQUE INDEX IF NOT EXISTS ux_request_files_request_id ON community_request_files(request_id, id);

CREATE TABLE IF NOT EXISTS community_request_sources (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES community_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('file','link','text_ref','studio_revision','project_post')),
  file_id TEXT,
  sha256 TEXT NOT NULL DEFAULT '' CHECK (sha256 = '' OR length(sha256) = 64),
  role TEXT NOT NULL DEFAULT '' CHECK (role IN ('','production','source','reference')),
  url TEXT NOT NULL DEFAULT '' CHECK (length(url) <= 600),
  canonical_url TEXT NOT NULL DEFAULT '' CHECK (length(canonical_url) <= 600),
  provider TEXT NOT NULL DEFAULT '' CHECK (length(provider) <= 60),
  ref_text TEXT NOT NULL DEFAULT '' CHECK (length(ref_text) <= 500),
  origin_id TEXT NOT NULL DEFAULT '',
  origin_ref TEXT NOT NULL DEFAULT '',
  origin_hash TEXT NOT NULL DEFAULT '',
  origin_meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(origin_meta)),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (kind NOT IN ('file','studio_revision','project_post') OR file_id IS NOT NULL),
  CHECK (kind IN ('file','studio_revision','project_post') OR file_id IS NULL),
  CHECK (kind <> 'link' OR canonical_url <> ''),
  CHECK (kind <> 'text_ref' OR ref_text <> ''),
  UNIQUE (request_id, file_id),
  FOREIGN KEY (request_id, file_id) REFERENCES community_request_files(request_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS community_request_parts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES community_requests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 1000),
  process TEXT NOT NULL DEFAULT '',
  process_unsure INTEGER NOT NULL DEFAULT 0 CHECK (process_unsure IN (0,1)),
  stated_dims TEXT NOT NULL DEFAULT '',
  measured_file_id TEXT REFERENCES community_request_files(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  assembly_notes TEXT NOT NULL DEFAULT '' CHECK (length(assembly_notes) <= 1000),
  legacy_text TEXT NOT NULL DEFAULT '',
  review_state TEXT NOT NULL DEFAULT '' CHECK (review_state IN ('','needs_technical_review','confirmed')),
  review_reasons TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(review_reasons)),
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS community_request_part_sources (
  part_id TEXT NOT NULL REFERENCES community_request_parts(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES community_request_sources(id) ON DELETE CASCADE,
  PRIMARY KEY (part_id, source_id)
);

CREATE TABLE IF NOT EXISTS community_request_part_materials (
  id TEXT PRIMARY KEY,
  part_id TEXT NOT NULL REFERENCES community_request_parts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  material_id TEXT NOT NULL DEFAULT '',
  material_unsure INTEGER NOT NULL DEFAULT 0 CHECK (material_unsure IN (0,1)),
  colors TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(colors)),
  finish TEXT NOT NULL DEFAULT '',
  region_reference TEXT NOT NULL DEFAULT '' CHECK (length(region_reference) <= 200),
  requirements TEXT NOT NULL DEFAULT '' CHECK (length(requirements) <= 300),
  colors_need_review INTEGER NOT NULL DEFAULT 0 CHECK (colors_need_review IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The summary of the model, for the board, cards, search and the review queue.
ALTER TABLE community_print_requests ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1);
ALTER TABLE community_print_requests ADD COLUMN parts_count INTEGER NOT NULL DEFAULT 1 CHECK (parts_count >= 1);
ALTER TABLE community_print_requests ADD COLUMN pieces_per_set INTEGER NOT NULL DEFAULT 1 CHECK (pieces_per_set >= 1);
ALTER TABLE community_print_requests ADD COLUMN materials_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(materials_json));
ALTER TABLE community_print_requests ADD COLUMN processes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(processes_json));
ALTER TABLE community_print_requests ADD COLUMN colors_total INTEGER NOT NULL DEFAULT 1 CHECK (colors_total >= 0);
ALTER TABLE community_print_requests ADD COLUMN multicolor_parts INTEGER NOT NULL DEFAULT 0 CHECK (multicolor_parts >= 0);
ALTER TABLE community_print_requests ADD COLUMN review_state TEXT NOT NULL DEFAULT '' CHECK (review_state IN ('','needs_technical_review','confirmed'));
ALTER TABLE community_print_requests ADD COLUMN model_mirror TEXT NOT NULL DEFAULT '';

-- Q2: the budget is private unless the customer shows it to merchants.
ALTER TABLE community_requests ADD COLUMN budget_visible INTEGER NOT NULL DEFAULT 0 CHECK (budget_visible IN (0,1));

-- P1-05's offer coverage. NULL coverage = the whole request (every existing offer).
ALTER TABLE community_offers ADD COLUMN coverage_json TEXT CHECK (coverage_json IS NULL OR json_valid(coverage_json));
ALTER TABLE community_offers ADD COLUMN substitutions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(substitutions_json));
ALTER TABLE community_offers ADD COLUMN covers_all INTEGER NOT NULL DEFAULT 1 CHECK (covers_all IN (0,1) AND (covers_all = 1 OR coverage_json IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_request_sources_request ON community_request_sources(request_id, position, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_sources_primary ON community_request_sources(request_id) WHERE is_primary = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_sources_link ON community_request_sources(request_id, canonical_url) WHERE kind = 'link';
-- Provenance lookups: which requests copied a post or a Studio revision (takedown propagation).
CREATE INDEX IF NOT EXISTS idx_request_sources_origin ON community_request_sources(kind, origin_id) WHERE origin_id <> '';
CREATE INDEX IF NOT EXISTS idx_request_parts_request ON community_request_parts(request_id, position, id);
CREATE INDEX IF NOT EXISTS idx_request_parts_measured ON community_request_parts(measured_file_id) WHERE measured_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_part_sources_source ON community_request_part_sources(source_id);
CREATE INDEX IF NOT EXISTS idx_request_part_materials_part ON community_request_part_materials(part_id, position, id);
-- The quarter-hour job's work list: print rows whose model was never built.
CREATE INDEX IF NOT EXISTS idx_print_requests_model_unbuilt ON community_print_requests(request_id) WHERE model_mirror = '';
CREATE INDEX IF NOT EXISTS idx_print_requests_review ON community_print_requests(review_state, updated_at) WHERE review_state = 'needs_technical_review';
