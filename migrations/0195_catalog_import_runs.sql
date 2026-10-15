-- 0195 — THE CATALOGUE IMPORT RUN, ITS LEDGER AND ITS GUARDS (Bambu import spec
-- §B.3, §B.4, §B.5; docs/DECISIONS.md rows 239 and 241, following rows 184 and 237).
--
-- Additive only: six NEW tables (operational: one run, its items, events, media,
-- conflicts and protected-field digests), their indexes, the triggers that keep
-- an item inside the legal state graph, the lease fence, and the GENERATED guard
-- triggers on existing money, stock and catalogue tables. No row is updated or
-- deleted by this file; no CHECK is widened; no table is rebuilt.
--
-- ONE ITEM AT A TIME (R2). ux_cir_active allows one open run per source and
-- ux_cii_inflight one item of a run between DISCOVERED and a terminal state
-- (BLOCKED and RETRYING count as in flight). trg_cii_transition admits only the
-- edges of §B.5; trg_cii_stage_monotonic lets a stage be completed only by
-- leaving it; trg_cie_lease_fence aborts the whole batch of a stale executor.
--
-- THE GUARDS FIRE ONLY INSIDE AN IMPORT BATCH. They are armed by the row
-- ops_guards(id = 'catalog-import-batch') that an import batch inserts first and
-- deletes last (D1 runs a batch as one transaction and serialises batches, so no
-- other writer ever sees it). Every other write — the admin form, pricing, orders —
-- is untouched. The block between the GENERATED markers is printed by
-- scripts/gen-import-guard-triggers.mjs from worker/lib/catalogImport/protectedTables.ts
-- and is checked by tests/catalogImportGuards.test.ts; never edit it by hand.
--
-- Each CASE ends `END )` with a space: Wrangler closes a CASE only on
-- whitespace + END + whitespace (tests/sqlSplit.test.ts).
--
-- Every CREATE carries IF NOT EXISTS: those are the statements
-- scripts/migrate-check.mjs re-runs to prove the file is idempotent.

-- ---------------------------------------------------------------- 1. The run
CREATE TABLE IF NOT EXISTS catalog_import_runs (
  id TEXT PRIMARY KEY CHECK (id GLOB 'cir_[0-9a-f]*' AND length(id) = 28),   -- the shape workflow 60 validates
  source TEXT NOT NULL CHECK (source IN ('bambu_us')),
  state TEXT NOT NULL CHECK (state IN ('open','running','blocked','closed','partial')),
  token_sha256 TEXT NOT NULL DEFAULT '',
  token_expires_at TEXT NOT NULL DEFAULT '',
  github_run_id TEXT NOT NULL DEFAULT '',
  manifest_total INTEGER NOT NULL DEFAULT 0,
  reviewed_bundle_sha256 TEXT NOT NULL DEFAULT '',
  sitemap_fingerprint TEXT NOT NULL DEFAULT '',
  code_commit TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cir_active ON catalog_import_runs(source) WHERE state IN ('open','running','blocked');
CREATE INDEX IF NOT EXISTS ix_cir_token ON catalog_import_runs(token_sha256) WHERE token_sha256 <> '';

-- ---------------------------------------------------------------- 2. The items (one per manifest row)
CREATE TABLE IF NOT EXISTS catalog_import_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES catalog_import_runs(id),
  source TEXT NOT NULL, source_product_id TEXT NOT NULL, handle TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  product_type TEXT NOT NULL DEFAULT '',
  queue_position INTEGER NOT NULL,                 -- stable order (§J.4); never reused
  curated_scope INTEGER NOT NULL DEFAULT 0 CHECK (curated_scope IN (0,1)),
  hold_code TEXT NOT NULL DEFAULT '' CHECK (hold_code IN ('','OWNER_HIDDEN','ORDER_TYPE_WORD')),   -- known in P0; queued last
  source_collections TEXT NOT NULL DEFAULT '[]',
  breadcrumbs TEXT NOT NULL DEFAULT '',
  discovery_sources TEXT NOT NULL DEFAULT '[]',
  discovered_at TEXT NOT NULL,
  processing_state TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK (processing_state IN
    ('DISCOVERED','EXTRACTING','ENRICHING','VALIDATING','INGESTING_MEDIA','WRITING','PUBLISHING','VERIFYING_LIVE',
     'COMPLETE','RETRYING','BLOCKED','WITHDRAWN_AT_SOURCE')),
  last_completed_stage TEXT NOT NULL DEFAULT '' CHECK (last_completed_stage IN
    ('','EXTRACTING','ENRICHING','VALIDATING','INGESTING_MEDIA','WRITING','PUBLISHING','VERIFYING_LIVE')),
  attempts INTEGER NOT NULL DEFAULT 0,
  stage_attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT NOT NULL DEFAULT '',
  last_error_code TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '' CHECK (length(last_error) <= 300),
  blocker_code TEXT NOT NULL DEFAULT '', resume_instruction TEXT NOT NULL DEFAULT '',
  lease_token TEXT NOT NULL DEFAULT '', lease_until TEXT NOT NULL DEFAULT '',
  source_fingerprint TEXT NOT NULL DEFAULT '', payload_sha256 TEXT NOT NULL DEFAULT '',
  stage_data TEXT NOT NULL DEFAULT '{}',           -- JSON: description kind, plan estimate, counts …
  match_kind TEXT NOT NULL DEFAULT '' CHECK (match_kind IN ('','created','merged')),
  levonis_product_id TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '', live_url TEXT NOT NULL DEFAULT '',
  unpublished_on_block INTEGER NOT NULL DEFAULT 0 CHECK (unpublished_on_block IN (0,1)),
  quality TEXT NOT NULL DEFAULT '{}',              -- JSON counts (§H.3), never values
  d1_checks TEXT NOT NULL DEFAULT '{}',            -- what the Worker itself recomputed at /complete (§I.1.10)
  edge_evidence TEXT NOT NULL DEFAULT '{}',        -- what the runner saw on the public site
  withdrawn_evidence TEXT NOT NULL DEFAULT '{}',   -- two fetches ≥ 24 h apart + sitemap absence
  withdrawn_by TEXT NOT NULL DEFAULT '',           -- the owner approval reference (DECISIONS row or message id)
  source_sold_out_variants INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT NOT NULL DEFAULT '', completed_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (processing_state <> 'COMPLETE' OR (levonis_product_id <> '' AND live_url <> '' AND verified_at <> ''
         AND d1_checks <> '{}' AND edge_evidence <> '{}')),
  CHECK (processing_state <> 'BLOCKED' OR (blocker_code <> '' AND resume_instruction <> '')),
  CHECK (processing_state <> 'WITHDRAWN_AT_SOURCE' OR (blocker_code = 'SOURCE_WITHDRAWN' AND withdrawn_evidence <> '{}' AND withdrawn_by <> ''))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cii_source ON catalog_import_items(run_id, source, source_product_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cii_position ON catalog_import_items(run_id, queue_position);
-- THE GATE: at most one item of a run between DISCOVERED and a terminal state — BLOCKED and RETRYING included.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cii_inflight ON catalog_import_items(run_id)
  WHERE processing_state NOT IN ('DISCOVERED','COMPLETE','WITHDRAWN_AT_SOURCE');

-- ---------------------------------------------------------------- 3. The legal graph (§B.5)
-- Nothing (route, wrangler UPDATE, runner bug) can move an item outside it.
-- The resume CASE ends ELSE '': without it, an item RETRYING or BLOCKED with
-- last_completed_stage = 'VERIFYING_LIVE' made the CASE NULL, the whole NOT (…)
-- NULL, and the RAISE silently skipped — every move, COMPLETE included, passed
-- (found by tests/catalogImportTransitions.test.ts). Every term below is now a
-- definite true or false.
CREATE TRIGGER IF NOT EXISTS trg_cii_transition BEFORE UPDATE OF processing_state ON catalog_import_items
WHEN NEW.processing_state IS NOT OLD.processing_state
BEGIN
  SELECT RAISE(ABORT, 'IMPORT_RUN_NOT_OPEN') WHERE NOT EXISTS (
    SELECT 1 FROM catalog_import_runs r WHERE r.id = NEW.run_id AND r.state IN ('open','running','blocked'));
  SELECT RAISE(ABORT, 'IMPORT_ILLEGAL_TRANSITION') WHERE NOT (
       (OLD.processing_state = 'DISCOVERED' AND NEW.processing_state = 'EXTRACTING' AND OLD.last_completed_stage = '')
    OR (OLD.processing_state = 'EXTRACTING'      AND NEW.processing_state = 'ENRICHING')
    OR (OLD.processing_state = 'ENRICHING'       AND NEW.processing_state = 'VALIDATING')
    OR (OLD.processing_state = 'VALIDATING'      AND NEW.processing_state = 'INGESTING_MEDIA')
    OR (OLD.processing_state = 'INGESTING_MEDIA' AND NEW.processing_state = 'WRITING')
    OR (OLD.processing_state = 'WRITING'         AND NEW.processing_state = 'PUBLISHING')
    OR (OLD.processing_state = 'PUBLISHING'      AND NEW.processing_state = 'VERIFYING_LIVE')
    OR (OLD.processing_state = 'VERIFYING_LIVE'  AND NEW.processing_state = 'COMPLETE')
    OR (OLD.processing_state IN ('EXTRACTING','ENRICHING','VALIDATING','INGESTING_MEDIA','WRITING','PUBLISHING','VERIFYING_LIVE')
        AND NEW.processing_state IN ('RETRYING','BLOCKED'))
    OR (OLD.processing_state = 'RETRYING' AND NEW.processing_state = 'BLOCKED')
    OR (OLD.processing_state = 'BLOCKED'  AND NEW.processing_state = 'RETRYING')
    OR (OLD.processing_state IN ('RETRYING','BLOCKED') AND NEW.processing_state = CASE OLD.last_completed_stage
          WHEN '' THEN 'EXTRACTING' WHEN 'EXTRACTING' THEN 'ENRICHING' WHEN 'ENRICHING' THEN 'VALIDATING'
          WHEN 'VALIDATING' THEN 'INGESTING_MEDIA' WHEN 'INGESTING_MEDIA' THEN 'WRITING'
          WHEN 'WRITING' THEN 'PUBLISHING' WHEN 'PUBLISHING' THEN 'VERIFYING_LIVE' ELSE '' END )
    OR (OLD.processing_state = 'BLOCKED' AND OLD.blocker_code = 'SOURCE_WITHDRAWN' AND NEW.processing_state = 'WITHDRAWN_AT_SOURCE')
    -- a rollback (§A.10): only a COMPLETE item whose product was removed, and only to the END of the queue:
    -- past EVERY other item of the run, the not-yet-processed DISCOVERED ones included (max + 1)
    OR (OLD.processing_state = 'COMPLETE' AND NEW.processing_state = 'DISCOVERED'
        AND NEW.levonis_product_id = '' AND NEW.last_completed_stage = ''
        AND NEW.queue_position > (SELECT COALESCE(MAX(i.queue_position), 0) FROM catalog_import_items i
                                   WHERE i.run_id = NEW.run_id AND i.id <> NEW.id))
  );
END;

-- A stage is completed only by leaving it: last_completed_stage can only become the state the item was in.
CREATE TRIGGER IF NOT EXISTS trg_cii_stage_monotonic BEFORE UPDATE OF last_completed_stage ON catalog_import_items
WHEN NEW.last_completed_stage IS NOT OLD.last_completed_stage
BEGIN
  SELECT RAISE(ABORT, 'IMPORT_ILLEGAL_TRANSITION') WHERE NOT (
       NEW.last_completed_stage = OLD.processing_state
    OR (NEW.last_completed_stage = '' AND OLD.processing_state = 'COMPLETE' AND NEW.processing_state = 'DISCOVERED'));
END;

-- ---------------------------------------------------------------- 4. Events and the lease fence
CREATE TABLE IF NOT EXISTS catalog_import_events (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, item_id TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL, stage TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('start','ok','retry','blocked','info','resume','rolled_back','unpublished','republished','withdrawn')),
  code TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 300), detail TEXT NOT NULL DEFAULT '{}',
  lease_token TEXT NOT NULL DEFAULT '',
  github_run_id TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cie_seq ON catalog_import_events(run_id, seq);
CREATE INDEX IF NOT EXISTS ix_cie_item ON catalog_import_events(item_id, seq);

-- The lease fence (0099 product_import_items shape): a checkpoint from a stale executor aborts its whole batch.
CREATE TRIGGER IF NOT EXISTS trg_cie_lease_fence BEFORE INSERT ON catalog_import_events
WHEN NEW.stage IN ('WRITTEN','UNPUBLISHED','REPUBLISHED','COMPLETED')
BEGIN
  SELECT RAISE(ABORT, 'IMPORT_LEASE_LOST') WHERE NOT EXISTS (
    SELECT 1 FROM catalog_import_items i JOIN catalog_import_runs r ON r.id = i.run_id
     WHERE i.id = NEW.item_id AND i.lease_token = NEW.lease_token AND i.lease_token <> ''
       AND i.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND r.state IN ('open','running'));
END;

-- ---------------------------------------------------------------- 5. Media, conflicts, protected digests
CREATE TABLE IF NOT EXISTS catalog_import_media (
  run_id TEXT NOT NULL, source_product_id TEXT NOT NULL, source_media_id TEXT NOT NULL,  -- resourceFileId | 'swatch:'||value id | 'desc:'||sha1(url) | 'witb:'||sha1(url)
  role TEXT NOT NULL CHECK (role IN ('gallery','swatch','description','in_the_box')),
  source_url TEXT NOT NULL, fetched_variant TEXT NOT NULL DEFAULT 'original' CHECK (fetched_variant IN ('original','cdn_resized')),
  status TEXT NOT NULL CHECK (status IN ('pending','stored','failed','omitted_cap')),
  r2_key TEXT NOT NULL DEFAULT '', width INTEGER, height INTEGER, bytes INTEGER, sha256 TEXT NOT NULL DEFAULT '',
  source_etag TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, source_product_id, source_media_id)
);

CREATE TABLE IF NOT EXISTS catalog_import_conflicts (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, item_id TEXT NOT NULL, product_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('field_kept_existing','variant_not_merged','spec_sources_disagree','image_unbound','image_review',
    'taxonomy_note','relation_unresolvable','translation_review','region_value','sentence_withheld','curation_disagreement',
    'tracker_unresolved','category_filled')),
  field TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Protected-field fingerprints of EXISTING products and global counters (§E.4). Hashes only; never logged.
CREATE TABLE IF NOT EXISTS catalog_import_protected (
  run_id TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('before','after','write')),
  subject TEXT NOT NULL, digest TEXT NOT NULL, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, phase, subject, at)
);

-- ---------------------------------------------------------------- 6. The DB-level import guard (§B.4)
-- BEGIN GENERATED: scripts/gen-import-guard-triggers.mjs (worker/lib/catalogImport/protectedTables.ts). Do not edit by hand.
-- Armed only while ops_guards holds the row 'catalog-import-batch', which exists only inside an import batch.
-- Not in the schema before this file, so not guarded here (re-run the generator with --write once they land):
--   product_price_requests (0193_price_requests.sql)
--   product_price_request_stats (0193_price_requests.sql)

-- (a) Pricing, stock, orders, wallet and ledger tables: no INSERT, UPDATE or DELETE inside an import batch.
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_pricing_state_ins BEFORE INSERT ON product_pricing_state
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_pricing_state_upd BEFORE UPDATE ON product_pricing_state
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_pricing_state_del BEFORE DELETE ON product_pricing_state
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_sku_prices_ins BEFORE INSERT ON product_sku_prices
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_sku_prices_upd BEFORE UPDATE ON product_sku_prices
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_sku_prices_del BEFORE DELETE ON product_sku_prices
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_v2_sku_results_ins BEFORE INSERT ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_v2_sku_results_upd BEFORE UPDATE ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_v2_sku_results_del BEFORE DELETE ON pricing_v2_sku_results
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_price_points_ins BEFORE INSERT ON pricing_price_points
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_price_points_upd BEFORE UPDATE ON pricing_price_points
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_price_points_del BEFORE DELETE ON pricing_price_points
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_preorder_discounts_ins BEFORE INSERT ON pricing_preorder_discounts
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_preorder_discounts_upd BEFORE UPDATE ON pricing_preorder_discounts
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_preorder_discounts_del BEFORE DELETE ON pricing_preorder_discounts
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_legacy_snapshots_ins BEFORE INSERT ON pricing_legacy_snapshots
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_legacy_snapshots_upd BEFORE UPDATE ON pricing_legacy_snapshots
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_legacy_snapshots_del BEFORE DELETE ON pricing_legacy_snapshots
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_inputs_ins BEFORE INSERT ON pricing_inputs
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_inputs_upd BEFORE UPDATE ON pricing_inputs
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_inputs_del BEFORE DELETE ON pricing_inputs
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_rules_ins BEFORE INSERT ON pricing_rules
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_rules_upd BEFORE UPDATE ON pricing_rules
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_pricing_rules_del BEFORE DELETE ON pricing_rules
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_history_ins BEFORE INSERT ON price_history
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_history_upd BEFORE UPDATE ON price_history
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_price_history_del BEFORE DELETE ON price_history
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_inventory_lots_ins BEFORE INSERT ON inventory_lots
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_inventory_lots_upd BEFORE UPDATE ON inventory_lots
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_inventory_lots_del BEFORE DELETE ON inventory_lots
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_inventory_ledger_ins BEFORE INSERT ON inventory_ledger
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_inventory_ledger_upd BEFORE UPDATE ON inventory_ledger
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_inventory_ledger_del BEFORE DELETE ON inventory_ledger
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_option_fulfillment_ins BEFORE INSERT ON product_option_fulfillment
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_option_fulfillment_upd BEFORE UPDATE ON product_option_fulfillment
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_option_fulfillment_del BEFORE DELETE ON product_option_fulfillment
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_option_transports_ins BEFORE INSERT ON product_option_transports
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_option_transports_upd BEFORE UPDATE ON product_option_transports
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_option_transports_del BEFORE DELETE ON product_option_transports
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_orders_ins BEFORE INSERT ON orders
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_orders_upd BEFORE UPDATE ON orders
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_orders_del BEFORE DELETE ON orders
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_order_items_ins BEFORE INSERT ON order_items
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_order_items_upd BEFORE UPDATE ON order_items
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_order_items_del BEFORE DELETE ON order_items
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_wallet_transactions_ins BEFORE INSERT ON wallet_transactions
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_wallet_transactions_upd BEFORE UPDATE ON wallet_transactions
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_wallet_transactions_del BEFORE DELETE ON wallet_transactions
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_accounting_entries_ins BEFORE INSERT ON accounting_entries
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_accounting_entries_upd BEFORE UPDATE ON accounting_entries
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_accounting_entries_del BEFORE DELETE ON accounting_entries
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_procurement_selection_cost_defaults_ins BEFORE INSERT ON procurement_selection_cost_defaults
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_procurement_selection_cost_defaults_upd BEFORE UPDATE ON procurement_selection_cost_defaults
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_procurement_selection_cost_defaults_del BEFORE DELETE ON procurement_selection_cost_defaults
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

-- (b) Catalogue rows the import writes: money, stock and package columns stay at their defaults on a new row,
--     equal to the stored row on an upsert, and unchanged on an UPDATE.
CREATE TRIGGER IF NOT EXISTS trg_import_guard_products_ins BEFORE INSERT ON products
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
 AND ((NOT EXISTS (SELECT 1 FROM products o WHERE o.id = NEW.id)
       AND (NEW.price_iqd IS NOT 0
            OR NEW.original_price_iqd IS NOT NULL
            OR NEW.product_cost_iqd IS NOT NULL
            OR NEW.prime_price_iqd IS NOT NULL
            OR NEW.pro_price_iqd IS NOT NULL
            OR COALESCE(NEW.direct_surcharge_iqd, 0) <> 0
            OR NEW.membership_prices IS NOT '{}'
            OR NEW.stock IS NOT NULL
            OR NEW.stock_reserved IS NOT 0
            OR NEW.low_stock_threshold IS NOT NULL
            OR NEW.net_weight_g IS NOT NULL
            OR NEW.width_mm IS NOT NULL
            OR NEW.depth_mm IS NOT NULL
            OR NEW.height_mm IS NOT NULL
            OR NEW.package_weight_g IS NOT NULL
            OR NEW.package_width_mm IS NOT NULL
            OR NEW.package_depth_mm IS NOT NULL
            OR NEW.package_height_mm IS NOT NULL))
   OR EXISTS (SELECT 1 FROM products o WHERE o.id = NEW.id
       AND (NEW.price_iqd IS NOT o.price_iqd
            OR NEW.original_price_iqd IS NOT o.original_price_iqd
            OR NEW.product_cost_iqd IS NOT o.product_cost_iqd
            OR NEW.prime_price_iqd IS NOT o.prime_price_iqd
            OR NEW.pro_price_iqd IS NOT o.pro_price_iqd
            OR NEW.direct_surcharge_iqd IS NOT o.direct_surcharge_iqd
            OR NEW.membership_prices IS NOT o.membership_prices
            OR NEW.stock IS NOT o.stock
            OR NEW.stock_reserved IS NOT o.stock_reserved
            OR NEW.low_stock_threshold IS NOT o.low_stock_threshold
            OR NEW.net_weight_g IS NOT o.net_weight_g
            OR NEW.width_mm IS NOT o.width_mm
            OR NEW.depth_mm IS NOT o.depth_mm
            OR NEW.height_mm IS NOT o.height_mm
            OR NEW.package_weight_g IS NOT o.package_weight_g
            OR NEW.package_width_mm IS NOT o.package_width_mm
            OR NEW.package_depth_mm IS NOT o.package_depth_mm
            OR NEW.package_height_mm IS NOT o.package_height_mm)))
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_products_upd BEFORE UPDATE OF price_iqd, original_price_iqd, product_cost_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd, membership_prices, stock, stock_reserved, low_stock_threshold, net_weight_g, width_mm, depth_mm, height_mm, package_weight_g, package_width_mm, package_depth_mm, package_height_mm ON products
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
 AND (NEW.price_iqd IS NOT OLD.price_iqd
      OR NEW.original_price_iqd IS NOT OLD.original_price_iqd
      OR NEW.product_cost_iqd IS NOT OLD.product_cost_iqd
      OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd
      OR NEW.direct_surcharge_iqd IS NOT OLD.direct_surcharge_iqd
      OR NEW.membership_prices IS NOT OLD.membership_prices
      OR NEW.stock IS NOT OLD.stock
      OR NEW.stock_reserved IS NOT OLD.stock_reserved
      OR NEW.low_stock_threshold IS NOT OLD.low_stock_threshold
      OR NEW.net_weight_g IS NOT OLD.net_weight_g
      OR NEW.width_mm IS NOT OLD.width_mm
      OR NEW.depth_mm IS NOT OLD.depth_mm
      OR NEW.height_mm IS NOT OLD.height_mm
      OR NEW.package_weight_g IS NOT OLD.package_weight_g
      OR NEW.package_width_mm IS NOT OLD.package_width_mm
      OR NEW.package_depth_mm IS NOT OLD.package_depth_mm
      OR NEW.package_height_mm IS NOT OLD.package_height_mm)
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_option_values_ins BEFORE INSERT ON product_option_values
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
 AND ((NOT EXISTS (SELECT 1 FROM product_option_values o WHERE o.id = NEW.id)
       AND (NEW.regular_price_iqd IS NOT NULL
            OR NEW.prime_price_iqd IS NOT NULL
            OR NEW.pro_price_iqd IS NOT NULL
            OR NEW.cost_iqd IS NOT NULL
            OR NEW.regular_adjust_iqd IS NOT NULL
            OR NEW.prime_adjust_iqd IS NOT NULL
            OR NEW.pro_adjust_iqd IS NOT NULL
            OR NEW.cost_adjust_iqd IS NOT NULL
            OR NEW.stock IS NOT NULL
            OR NEW.reserved IS NOT 0
            OR NEW.low_stock_threshold IS NOT NULL
            OR NEW.net_weight_g IS NOT NULL
            OR NEW.width_mm IS NOT NULL
            OR NEW.depth_mm IS NOT NULL
            OR NEW.height_mm IS NOT NULL
            OR NEW.package_weight_g IS NOT NULL
            OR NEW.package_width_mm IS NOT NULL
            OR NEW.package_depth_mm IS NOT NULL
            OR NEW.package_height_mm IS NOT NULL))
   OR EXISTS (SELECT 1 FROM product_option_values o WHERE o.id = NEW.id
       AND (NEW.regular_price_iqd IS NOT o.regular_price_iqd
            OR NEW.prime_price_iqd IS NOT o.prime_price_iqd
            OR NEW.pro_price_iqd IS NOT o.pro_price_iqd
            OR NEW.cost_iqd IS NOT o.cost_iqd
            OR NEW.regular_adjust_iqd IS NOT o.regular_adjust_iqd
            OR NEW.prime_adjust_iqd IS NOT o.prime_adjust_iqd
            OR NEW.pro_adjust_iqd IS NOT o.pro_adjust_iqd
            OR NEW.cost_adjust_iqd IS NOT o.cost_adjust_iqd
            OR NEW.stock IS NOT o.stock
            OR NEW.reserved IS NOT o.reserved
            OR NEW.low_stock_threshold IS NOT o.low_stock_threshold
            OR NEW.net_weight_g IS NOT o.net_weight_g
            OR NEW.width_mm IS NOT o.width_mm
            OR NEW.depth_mm IS NOT o.depth_mm
            OR NEW.height_mm IS NOT o.height_mm
            OR NEW.package_weight_g IS NOT o.package_weight_g
            OR NEW.package_width_mm IS NOT o.package_width_mm
            OR NEW.package_depth_mm IS NOT o.package_depth_mm
            OR NEW.package_height_mm IS NOT o.package_height_mm)))
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_option_values_upd BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd, stock, reserved, low_stock_threshold, net_weight_g, width_mm, depth_mm, height_mm, package_weight_g, package_width_mm, package_depth_mm, package_height_mm ON product_option_values
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
 AND (NEW.regular_price_iqd IS NOT OLD.regular_price_iqd
      OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd
      OR NEW.cost_iqd IS NOT OLD.cost_iqd
      OR NEW.regular_adjust_iqd IS NOT OLD.regular_adjust_iqd
      OR NEW.prime_adjust_iqd IS NOT OLD.prime_adjust_iqd
      OR NEW.pro_adjust_iqd IS NOT OLD.pro_adjust_iqd
      OR NEW.cost_adjust_iqd IS NOT OLD.cost_adjust_iqd
      OR NEW.stock IS NOT OLD.stock
      OR NEW.reserved IS NOT OLD.reserved
      OR NEW.low_stock_threshold IS NOT OLD.low_stock_threshold
      OR NEW.net_weight_g IS NOT OLD.net_weight_g
      OR NEW.width_mm IS NOT OLD.width_mm
      OR NEW.depth_mm IS NOT OLD.depth_mm
      OR NEW.height_mm IS NOT OLD.height_mm
      OR NEW.package_weight_g IS NOT OLD.package_weight_g
      OR NEW.package_width_mm IS NOT OLD.package_width_mm
      OR NEW.package_depth_mm IS NOT OLD.package_depth_mm
      OR NEW.package_height_mm IS NOT OLD.package_height_mm)
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_variants_ins BEFORE INSERT ON product_variants
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
 AND ((NOT EXISTS (SELECT 1 FROM product_variants o WHERE o.id = NEW.id)
       AND (NEW.regular_price_iqd IS NOT NULL
            OR NEW.prime_price_iqd IS NOT NULL
            OR NEW.pro_price_iqd IS NOT NULL
            OR NEW.cost_iqd IS NOT NULL
            OR NEW.stock IS NOT NULL
            OR NEW.reserved IS NOT 0
            OR NEW.low_stock_threshold IS NOT NULL
            OR NEW.net_weight_g IS NOT NULL
            OR NEW.width_mm IS NOT NULL
            OR NEW.depth_mm IS NOT NULL
            OR NEW.height_mm IS NOT NULL
            OR NEW.package_weight_g IS NOT NULL
            OR NEW.package_width_mm IS NOT NULL
            OR NEW.package_depth_mm IS NOT NULL
            OR NEW.package_height_mm IS NOT NULL))
   OR EXISTS (SELECT 1 FROM product_variants o WHERE o.id = NEW.id
       AND (NEW.regular_price_iqd IS NOT o.regular_price_iqd
            OR NEW.prime_price_iqd IS NOT o.prime_price_iqd
            OR NEW.pro_price_iqd IS NOT o.pro_price_iqd
            OR NEW.cost_iqd IS NOT o.cost_iqd
            OR NEW.stock IS NOT o.stock
            OR NEW.reserved IS NOT o.reserved
            OR NEW.low_stock_threshold IS NOT o.low_stock_threshold
            OR NEW.net_weight_g IS NOT o.net_weight_g
            OR NEW.width_mm IS NOT o.width_mm
            OR NEW.depth_mm IS NOT o.depth_mm
            OR NEW.height_mm IS NOT o.height_mm
            OR NEW.package_weight_g IS NOT o.package_weight_g
            OR NEW.package_width_mm IS NOT o.package_width_mm
            OR NEW.package_depth_mm IS NOT o.package_depth_mm
            OR NEW.package_height_mm IS NOT o.package_height_mm)))
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_variants_upd BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd, stock, reserved, low_stock_threshold, net_weight_g, width_mm, depth_mm, height_mm, package_weight_g, package_width_mm, package_depth_mm, package_height_mm ON product_variants
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
 AND (NEW.regular_price_iqd IS NOT OLD.regular_price_iqd
      OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd
      OR NEW.cost_iqd IS NOT OLD.cost_iqd
      OR NEW.stock IS NOT OLD.stock
      OR NEW.reserved IS NOT OLD.reserved
      OR NEW.low_stock_threshold IS NOT OLD.low_stock_threshold
      OR NEW.net_weight_g IS NOT OLD.net_weight_g
      OR NEW.width_mm IS NOT OLD.width_mm
      OR NEW.depth_mm IS NOT OLD.depth_mm
      OR NEW.height_mm IS NOT OLD.height_mm
      OR NEW.package_weight_g IS NOT OLD.package_weight_g
      OR NEW.package_width_mm IS NOT OLD.package_width_mm
      OR NEW.package_depth_mm IS NOT OLD.package_depth_mm
      OR NEW.package_height_mm IS NOT OLD.package_height_mm)
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_colors_ins BEFORE INSERT ON product_colors
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
 AND ((NOT EXISTS (SELECT 1 FROM product_colors o WHERE o.id = NEW.id)
       AND (NEW.regular_price_iqd IS NOT NULL
            OR NEW.prime_price_iqd IS NOT NULL
            OR NEW.pro_price_iqd IS NOT NULL
            OR NEW.cost_iqd IS NOT NULL
            OR NEW.regular_adjust_iqd IS NOT NULL
            OR NEW.prime_adjust_iqd IS NOT NULL
            OR NEW.pro_adjust_iqd IS NOT NULL
            OR NEW.cost_adjust_iqd IS NOT NULL
            OR NEW.stock IS NOT NULL
            OR NEW.reserved IS NOT 0
            OR NEW.low_stock_threshold IS NOT NULL
            OR NEW.net_weight_g IS NOT NULL
            OR NEW.width_mm IS NOT NULL
            OR NEW.depth_mm IS NOT NULL
            OR NEW.height_mm IS NOT NULL
            OR NEW.package_weight_g IS NOT NULL
            OR NEW.package_width_mm IS NOT NULL
            OR NEW.package_depth_mm IS NOT NULL
            OR NEW.package_height_mm IS NOT NULL))
   OR EXISTS (SELECT 1 FROM product_colors o WHERE o.id = NEW.id
       AND (NEW.regular_price_iqd IS NOT o.regular_price_iqd
            OR NEW.prime_price_iqd IS NOT o.prime_price_iqd
            OR NEW.pro_price_iqd IS NOT o.pro_price_iqd
            OR NEW.cost_iqd IS NOT o.cost_iqd
            OR NEW.regular_adjust_iqd IS NOT o.regular_adjust_iqd
            OR NEW.prime_adjust_iqd IS NOT o.prime_adjust_iqd
            OR NEW.pro_adjust_iqd IS NOT o.pro_adjust_iqd
            OR NEW.cost_adjust_iqd IS NOT o.cost_adjust_iqd
            OR NEW.stock IS NOT o.stock
            OR NEW.reserved IS NOT o.reserved
            OR NEW.low_stock_threshold IS NOT o.low_stock_threshold
            OR NEW.net_weight_g IS NOT o.net_weight_g
            OR NEW.width_mm IS NOT o.width_mm
            OR NEW.depth_mm IS NOT o.depth_mm
            OR NEW.height_mm IS NOT o.height_mm
            OR NEW.package_weight_g IS NOT o.package_weight_g
            OR NEW.package_width_mm IS NOT o.package_width_mm
            OR NEW.package_depth_mm IS NOT o.package_depth_mm
            OR NEW.package_height_mm IS NOT o.package_height_mm)))
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_colors_upd BEFORE UPDATE OF regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd, stock, reserved, low_stock_threshold, net_weight_g, width_mm, depth_mm, height_mm, package_weight_g, package_width_mm, package_depth_mm, package_height_mm ON product_colors
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
 AND (NEW.regular_price_iqd IS NOT OLD.regular_price_iqd
      OR NEW.prime_price_iqd IS NOT OLD.prime_price_iqd
      OR NEW.pro_price_iqd IS NOT OLD.pro_price_iqd
      OR NEW.cost_iqd IS NOT OLD.cost_iqd
      OR NEW.regular_adjust_iqd IS NOT OLD.regular_adjust_iqd
      OR NEW.prime_adjust_iqd IS NOT OLD.prime_adjust_iqd
      OR NEW.pro_adjust_iqd IS NOT OLD.pro_adjust_iqd
      OR NEW.cost_adjust_iqd IS NOT OLD.cost_adjust_iqd
      OR NEW.stock IS NOT OLD.stock
      OR NEW.reserved IS NOT OLD.reserved
      OR NEW.low_stock_threshold IS NOT OLD.low_stock_threshold
      OR NEW.net_weight_g IS NOT OLD.net_weight_g
      OR NEW.width_mm IS NOT OLD.width_mm
      OR NEW.depth_mm IS NOT OLD.depth_mm
      OR NEW.height_mm IS NOT OLD.height_mm
      OR NEW.package_weight_g IS NOT OLD.package_weight_g
      OR NEW.package_width_mm IS NOT OLD.package_width_mm
      OR NEW.package_depth_mm IS NOT OLD.package_depth_mm
      OR NEW.package_height_mm IS NOT OLD.package_height_mm)
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;

-- (c) The stock decision (§B.10): an import records "not configured", never a decision, and never changes one.
CREATE TRIGGER IF NOT EXISTS trg_import_guard_stock_decision BEFORE INSERT ON product_source_refs
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
 AND (NEW.stock_decision IN ('tracked','untracked')
   OR EXISTS (SELECT 1 FROM product_source_refs o WHERE o.source = NEW.source AND o.source_product_id = NEW.source_product_id
       AND (NEW.stock_decision IS NOT o.stock_decision
            OR NEW.stock_decided_by IS NOT o.stock_decided_by
            OR NEW.stock_decided_at IS NOT o.stock_decided_at)))
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_stock_decision_upd BEFORE UPDATE OF stock_decision, stock_decided_by, stock_decided_at ON product_source_refs
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
 AND (NEW.stock_decision IS NOT OLD.stock_decision
      OR NEW.stock_decided_by IS NOT OLD.stock_decided_by
      OR NEW.stock_decided_at IS NOT OLD.stock_decided_at)
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
-- END GENERATED: scripts/gen-import-guard-triggers.mjs
