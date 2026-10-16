-- 0196 — THE CATALOGUE TRANSLATION MEMORY: imported English → Arabic and Sorani
-- (docs/bambu-import/I18N-DESIGN.md §A.2; docs/DECISIONS.md rows 2 and 183).
--
-- Additive only: three NEW tables and one index. No row is updated or deleted
-- by this file; no existing table is touched; no foreign key (a ref may precede
-- its product, and a product may be deleted). Nothing here holds money, so the
-- 0195 guard triggers do not name these tables.
--
--   catalog_translations       one row per normalized English string, keyed by
--                              sha256(normalizeSource(en)) (packages/catalog/src/
--                              bambuImport/i18n.ts). `reviewed` and `machine` rows
--                              are shown; `needs_review` is stored and never shown
--                              — it is also how a row is withdrawn (the loader
--                              never deletes).
--   catalog_translation_refs   which product shows which string: one indexed join
--                              per product serves every surface.
--   catalog_translation_parts  the loader's ledger: a committed part, by the
--                              SHA-256 of its bytes, is loaded once.
--
-- Written only by the import door (`POST /api/ops/catalog-import/run/translations`,
-- worker/lib/catalogImport/translations.ts), which re-proves every row; read at
-- display time (worker/lib/translate/memory.ts), which tolerates this file's
-- absence (CLAUDE.md rule 2).
--
-- Every CREATE carries IF NOT EXISTS: scripts/migrate-check.mjs re-runs the file.

CREATE TABLE IF NOT EXISTS catalog_translations (
  h TEXT PRIMARY KEY CHECK (length(h) = 64 AND h NOT GLOB '*[^0-9a-f]*'),
  en TEXT NOT NULL CHECK (length(en) BETWEEN 1 AND 4000),
  ar TEXT NOT NULL CHECK (length(ar) BETWEEN 1 AND 8000),
  ckb TEXT NOT NULL CHECK (length(ckb) BETWEEN 1 AND 8000),
  kind TEXT NOT NULL DEFAULT '' CHECK (length(kind) <= 40),
  status TEXT NOT NULL CHECK (status IN ('reviewed','machine','needs_review')),
  part TEXT NOT NULL DEFAULT '' CHECK (length(part) <= 40),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS catalog_translation_refs (
  product_id TEXT NOT NULL CHECK (length(product_id) BETWEEN 1 AND 80),
  h TEXT NOT NULL CHECK (length(h) = 64),
  PRIMARY KEY (product_id, h)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_ctr_h ON catalog_translation_refs(h);

CREATE TABLE IF NOT EXISTS catalog_translation_parts (
  part TEXT PRIMARY KEY CHECK (part GLOB 'p[0-9][0-9][0-9]*' AND length(part) <= 40),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  rows INTEGER NOT NULL CHECK (rows >= 0),
  run_id TEXT NOT NULL DEFAULT '',
  loaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
