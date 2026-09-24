-- ============================================================================
--  0122 — A STORE PAGE AS DATA: ONE DRAFT, PUBLISHED REVISIONS, AND THE
--         POINTER THE PUBLIC STOREFRONT READS.
-- ============================================================================
-- Merchant platform wave 2, stream W2-C (docs/MERCHANT_PLATFORM.md §2
-- decision 12, §4.4). The schema of a layout lives in packages/storeLayout;
-- this migration only gives it somewhere to be kept.
--
-- NONDESTRUCTIVE: two `CREATE TABLE IF NOT EXISTS` and one nullable
-- `ADD COLUMN` on `merchant_stores`. Nothing is dropped, no CHECK is touched,
-- no table is rebuilt, and NO ROW IS BACKFILLED: a store with no published
-- revision renders `defaultLayoutFromStore` on the fly — the classic page it
-- has always had, read live from its settings — so every existing store looks
-- exactly as it did the moment this applies, and keeps doing so until its
-- merchant publishes something (worker/lib/storeLayout.ts).
--
-- ---------------------------------------------------------------------------
--  store_layout_drafts — the merchant's working copy, one per store
-- ---------------------------------------------------------------------------
--   layout_json    the normalised layout (never read by a public route)
--   base_revision  the revision the draft was last published as or restored
--                  from; NULL = never published
--   version        optimistic concurrency: every write is
--                  `WHERE version = <the version the editor saw>` and bumps
--                  it, and so does a publish — two tabs cannot overwrite each
--                  other, and one draft version is published at most once
--                  (409 DRAFT_CHANGED to the loser)
CREATE TABLE IF NOT EXISTS store_layout_drafts (
  store_id TEXT PRIMARY KEY NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  layout_json TEXT NOT NULL,
  base_revision INTEGER CHECK (base_revision IS NULL OR base_revision >= 1),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);

-- ---------------------------------------------------------------------------
--  store_layout_revisions — what was published, immutable
-- ---------------------------------------------------------------------------
-- A publish INSERTS a row (revision = the store's previous maximum + 1) and
-- moves the store's pointer in the SAME batch; a restore copies an old row's
-- layout into the draft (and, if asked, publishes it as a NEW revision, so the
-- history stays a straight line). Rows are never updated. The publish batch
-- keeps the 50 newest per store and never deletes the one the store points
-- at. `layout_json NOT NULL` is also the publish fence: the batch inserts
-- `CASE WHEN <draft version matches> THEN <layout> ELSE NULL END`, so a stale
-- draft aborts the whole batch — the revision, the pointer and the audit row
-- together — instead of publishing something nobody verified.
--
-- UNIQUE (store_id, revision) is the second fence (two publishes can never
-- share a number) and the index the history list and the pruning read.
CREATE TABLE IF NOT EXISTS store_layout_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  layout_json TEXT NOT NULL,
  published_by TEXT,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  note TEXT NOT NULL DEFAULT '',
  -- A publish that restored an older revision names it; NULL otherwise.
  restored_from INTEGER,
  UNIQUE (store_id, revision)
);

-- ---------------------------------------------------------------------------
--  merchant_stores.published_revision_id — THE ONLY THING THE STOREFRONT READS
-- ---------------------------------------------------------------------------
-- NULL = never published (the classic page renders). The public routes read
-- the revision this names and nothing else: never the draft, never "the
-- newest revision" (worker/routes/storefront.ts). No REFERENCES clause, like
-- `community_products.section_id`: a pointer whose row were somehow gone
-- degrades to the classic page on read, and a foreign key here would only turn
-- that into a failed publish batch.
ALTER TABLE merchant_stores ADD COLUMN published_revision_id TEXT;
