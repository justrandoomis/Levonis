-- 0194 — THE PRODUCT KNOWLEDGE MODEL: imported (and later hand-entered) catalogue
-- facts with their provenance (Bambu Lab import spec §B.2; docs/DECISIONS.md
-- rows 239 and 241, following rows 2, 183 and 237).
--
-- Additive only: seven NEW tables, four new defaulted columns on
-- product_option_groups, indexes. No row is updated or deleted by this file; no
-- trigger is put on an existing table; no CHECK is widened; no table is rebuilt.
--
-- Every reader probes for these tables and columns before it reads them
-- (CLAUDE.md rule 2): a Worker on an older database behaves exactly as today.
--
-- PROVENANCE IS OWNER-ONLY WHERE IT NAMES THE STORE: product_source_refs.canonical_url,
-- a store_page product_spec_values.source_ref and product_option_value_swatches.source_url
-- are never emitted to a customer. Documents, wiki and TDS/SDS references are public.
--
-- NO MONEY, STOCK OR PACKAGE COLUMN IS HERE. Logistics facts are spec rows (group
-- 'logistics'); products.package_* / net_weight_g feed Pricing V2 freight and are
-- never written by the import (0195's guard triggers refuse them).
--
-- Every CREATE carries IF NOT EXISTS: those are the statements
-- scripts/migrate-check.mjs re-runs to prove the file is idempotent.

-- (1) Option group labels in three languages, a semantic kind, and the source's default value.
--     The kind list is complete now so it never needs widening.
ALTER TABLE product_option_groups ADD COLUMN name_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE product_option_groups ADD COLUMN name_ckb TEXT NOT NULL DEFAULT '';
ALTER TABLE product_option_groups ADD COLUMN kind TEXT NOT NULL DEFAULT ''
  CHECK (kind IN ('','color','spool','printer','version','size','nozzle','plate','units','pack','item','other'));
ALTER TABLE product_option_groups ADD COLUMN default_value_id TEXT NOT NULL DEFAULT '';   -- '' = none; an unknown id is ignored

-- (2) Where a product came from, and whether its stock has been set up (§B.10). canonical_url is OWNER-ONLY.
CREATE TABLE IF NOT EXISTS product_source_refs (
  source TEXT NOT NULL CHECK (source IN ('bambu_us')),
  source_product_id TEXT NOT NULL,                 -- string: 18-digit ids exceed 2^53
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_handle TEXT NOT NULL,                     -- decoded, NFC
  canonical_url TEXT NOT NULL,
  source_route TEXT NOT NULL DEFAULT '',           -- currentAllIdRoute
  source_collections_json TEXT NOT NULL DEFAULT '[]',
  match_kind TEXT NOT NULL CHECK (match_kind IN ('created','merged')),
  stock_decision TEXT NOT NULL DEFAULT 'not_required'
    CHECK (stock_decision IN ('not_required','not_configured','tracked','untracked')),
  stock_decided_by TEXT NOT NULL DEFAULT '',
  stock_decided_at TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,                       -- sha256 of the normalised extraction
  fetched_at TEXT NOT NULL,
  import_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (match_kind = 'created' OR stock_decision = 'not_required'),
  CHECK (stock_decision NOT IN ('tracked','untracked') OR (stock_decided_by <> '' AND stock_decided_at <> '')),
  PRIMARY KEY (source, source_product_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_psr_handle ON product_source_refs(source, source_handle);
CREATE INDEX IF NOT EXISTS ix_psr_product ON product_source_refs(product_id);
CREATE INDEX IF NOT EXISTS ix_psr_stock ON product_source_refs(product_id) WHERE stock_decision = 'not_configured';

-- (3) Source id <-> Levonis id for groups, values, variants and image rows, with the rule that bound each image.
CREATE TABLE IF NOT EXISTS product_option_source_refs (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('group','value','variant','image')),
  source TEXT NOT NULL CHECK (source IN ('bambu_us')),
  source_id TEXT NOT NULL,      -- propertyKeyId | property value id | sku id | resourceFileId
  levonis_id TEXT NOT NULL,     -- product_option_groups.id | product_option_values.id | product_variants.id | product_images.id
  source_label TEXT NOT NULL DEFAULT '',
  binding_rule TEXT NOT NULL DEFAULT '' CHECK (binding_rule IN
    ('','general','value','value_set','variant','representative','content_duplicate','reviewed_override')),
  -- A representative image row is bound to a value but shows the hero of this variant (§C.4 step 3); the page drops
  -- the row when a selection chose another value of any of its groups (§G.3, R6). Set exactly on representatives.
  via_variant_id TEXT NOT NULL DEFAULT '',
  import_run_id TEXT NOT NULL,
  CHECK ((binding_rule = 'representative') = (via_variant_id <> '')),
  PRIMARY KEY (product_id, kind, source, source_id, levonis_id)
);
CREATE INDEX IF NOT EXISTS ix_posr_levonis ON product_option_source_refs(levonis_id);

-- (4) Typed specifications with provenance: the authority; spec_fields/specifications are mirrors.
CREATE TABLE IF NOT EXISTS product_spec_values (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL CHECK (length(canonical_key) BETWEEN 1 AND 80),   -- registry key, or 'x.<slug>'
  group_key TEXT NOT NULL,                       -- printing, motion, extrusion, thermal, electrical, connectivity, physical,
                                                 -- logistics, material, mechanical, print_settings, drying, safety, compat,
                                                 -- contents, identity, manufacturer_terms, other
  scope_kind TEXT NOT NULL DEFAULT 'product' CHECK (scope_kind IN ('product','option_value','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '' CHECK (region IN ('','us_110v','intl_220v')),  -- §C.6 region rule
  data_type TEXT NOT NULL CHECK (data_type IN ('string','number','boolean','enum','range','list','date','object')),
  original_label TEXT NOT NULL DEFAULT '',
  original_value TEXT NOT NULL DEFAULT '',       -- ≤ 1000
  value_text TEXT NOT NULL DEFAULT '',
  value_num REAL,
  value_num_max REAL,
  value_bool INTEGER CHECK (value_bool IS NULL OR value_bool IN (0,1)),
  value_list TEXT NOT NULL DEFAULT '[]',         -- JSON: strings, or {text, qty, media_key?} (in the box) — a MEDIA source
  unit TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('verified','unverified','not_found','not_published','not_applicable','unknown')),
  confidence TEXT NOT NULL CHECK (confidence IN ('official_variant','official_doc','official_page','component_maker','independent','derived')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('store_page','store_messages','store_doc','tds','sds','manual','wiki','curated','derived')),
  source_ref TEXT NOT NULL DEFAULT '',           -- URL; a store_page ref is owner-only, doc/wiki refs are public
  source_title TEXT NOT NULL DEFAULT '',
  source_locator TEXT NOT NULL DEFAULT '' CHECK (length(source_locator) <= 200),  -- 'p.2', 'Specifications › row 3', a message key path
  source_excerpt TEXT NOT NULL DEFAULT '' CHECK (length(source_excerpt) <= 200),  -- the quoted words the value came from
  retrieved_at TEXT NOT NULL DEFAULT '',
  test_method TEXT NOT NULL DEFAULT '',
  test_condition TEXT NOT NULL DEFAULT '',
  derived_from TEXT NOT NULL DEFAULT '',
  missing_reason TEXT NOT NULL DEFAULT '' CHECK (missing_reason IN
    ('','not_found_in_checked_sources','not_published_by_manufacturer','not_applicable')),
  checked_sources TEXT NOT NULL DEFAULT '[]',    -- JSON [{kind, url, title}] actually parsed for this key
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','owner')),
  conflict TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  import_run_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status <> 'verified' OR source_ref <> ''),
  CHECK (status NOT IN ('not_found','not_published','not_applicable','unknown') OR (value_num IS NULL AND value_text = '')),
  CHECK (status <> 'not_found' OR (missing_reason = 'not_found_in_checked_sources' AND checked_sources <> '[]')),
  CHECK (status <> 'not_published' OR (missing_reason = 'not_published_by_manufacturer' AND source_kind = 'curated')),
  CHECK (status <> 'not_applicable' OR missing_reason = 'not_applicable'),
  CHECK (status <> 'verified' OR value_num IS NULL OR source_kind NOT IN ('tds','sds','manual') OR source_excerpt <> ''),
  CHECK (region <> 'us_110v' OR status <> 'verified')
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_psv_key ON product_spec_values(product_id, canonical_key, scope_kind, scope_id, region);
CREATE INDEX IF NOT EXISTS ix_psv_facet ON product_spec_values(canonical_key, value_num) WHERE value_num IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_psv_status ON product_spec_values(product_id, status);

-- (5) Documents: links, never re-hosted bytes (L-3).
CREATE TABLE IF NOT EXISTS product_documents (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('manual','quick_start','installation','tds','sds','certificate','hex_codes','spec_sheet',
                                     'wiki','faq','guide','video','model_file','other')),
  title_en TEXT NOT NULL, title_ar TEXT NOT NULL DEFAULT '', title_ckb TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL CHECK (url LIKE 'https://%'),
  host TEXT NOT NULL,                            -- allow-listed: store.bblcdn.com, cdn.shopify.com (legacy), wiki.bambulab.com,
                                                 -- www.youtube.com, youtube.com, makerworld.com
  tracker_source TEXT NOT NULL DEFAULT '',       -- the e.bambulab.com/t?c=… link it was resolved from (§C.5)
  scope_kind TEXT NOT NULL DEFAULT 'product' CHECK (scope_kind IN ('product','option_value','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  version_label TEXT NOT NULL DEFAULT '', published_on TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '', byte_size INTEGER, content_sha256 TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT '', check_status INTEGER NOT NULL DEFAULT 0,
  source_kind TEXT NOT NULL DEFAULT 'store_page', retrieved_at TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  import_run_id TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdoc_url ON product_documents(product_id, url, scope_kind, scope_id);

-- (6) External identifiers, distinct from Levonis ids.
CREATE TABLE IF NOT EXISTS product_external_ids (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL DEFAULT 'product' CHECK (scope_kind IN ('product','option_value','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  id_type TEXT NOT NULL CHECK (id_type IN ('bambu_product_id','bambu_variant_id','bambu_sku_code','mpn','gtin','upc','ean','color_code','part_code')),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 120),
  source_kind TEXT NOT NULL DEFAULT 'store_page', source_ref TEXT NOT NULL DEFAULT '', retrieved_at TEXT NOT NULL DEFAULT '',
  searchable INTEGER NOT NULL DEFAULT 1 CHECK (searchable IN (0,1)),   -- bambu_*_id rows are 0 (opaque numbers)
  PRIMARY KEY (product_id, scope_kind, scope_id, id_type, value)
);
CREATE INDEX IF NOT EXISTS ix_pext_value ON product_external_ids(id_type, value);
CREATE INDEX IF NOT EXISTS ix_pext_search ON product_external_ids(product_id) WHERE searchable = 1;

-- (7) Compatibility and other relations, with evidence. target NULL while pending (no fake FK).
CREATE TABLE IF NOT EXISTS product_relations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL DEFAULT 'product' CHECK (scope_kind IN ('product','option_value','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  relation TEXT NOT NULL CHECK (relation IN ('compatible_with','not_compatible_with','requires','recommended_with','related',
                                             'replacement_for','included_in','includes')),
  target_kind TEXT NOT NULL DEFAULT 'other' CHECK (target_kind IN
    ('printer','ams','hub','buffer','laser_module','toolhead','spool','family','part','material','other')),
  target_product_id TEXT,
  target_source TEXT NOT NULL DEFAULT '',
  target_source_handle TEXT NOT NULL DEFAULT '',
  target_family TEXT NOT NULL DEFAULT '',
  target_label TEXT NOT NULL,                     -- the source's own words
  state TEXT NOT NULL CHECK (state IN ('resolved','pending','unresolvable')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('option_value','compat_section','spec_row','feature_bullet',
                                                       'description_text','wiki_table','manual','curated')),
  evidence_text TEXT NOT NULL DEFAULT '' CHECK (length(evidence_text) <= 300),
  source_ref TEXT NOT NULL DEFAULT '', retrieved_at TEXT NOT NULL DEFAULT '',
  import_run_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT NOT NULL DEFAULT '',
  CHECK (state <> 'resolved' OR target_product_id IS NOT NULL),
  CHECK (state = 'resolved' OR target_product_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_prel ON product_relations(product_id, scope_kind, scope_id, relation, target_source_handle, target_family, target_label);
CREATE INDEX IF NOT EXISTS ix_prel_pending ON product_relations(target_source, target_source_handle) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS ix_prel_target ON product_relations(target_product_id) WHERE target_product_id IS NOT NULL;

-- (8) The official colour swatch of an option value (and a hex ONLY when the manufacturer publishes one).
CREATE TABLE IF NOT EXISTS product_option_value_swatches (
  option_value_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL DEFAULT '', r2_key TEXT NOT NULL DEFAULT '', width INTEGER, height INTEGER,
  published_hex TEXT NOT NULL DEFAULT '' CHECK (published_hex = '' OR published_hex GLOB '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'),
  hex_source_ref TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',            -- owner-only provenance
  CHECK (published_hex = '' OR hex_source_ref <> '')
);
CREATE INDEX IF NOT EXISTS ix_povs_product ON product_option_value_swatches(product_id);

-- (The authored ar/ckb search synonyms are NOT in this migration: /run/prepare-taxonomy inserts them with
--  INSERT OR IGNORE from the reviewed data/bambu-import/search-synonyms.json, so their review never waits on a migration.)
