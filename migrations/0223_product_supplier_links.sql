-- ============================================================================
-- 0223 — THE OWNER'S OWN SUPPLIER LINKS, PER PRODUCT (owner, 2026-11-05;
-- docs/DECISIONS.md row 293; docs/SMART_PRICING.md §3.10).
--
-- The owner's request, in his words: «i need to save the link so i can easily
-- track price from supplier or on pre order item to order it or when i need to
-- future buy on inventory».
--
-- What this file lands: one owner-only table, `product_supplier_links`. A row
-- is one address at any https supplier site, kept for the whole product, one
-- model or option, one colour, or one exact option and colour combination,
-- with an optional label, supplier name and note. It holds no price: a price
-- is still recorded through «تحديث السعر» (supplier_price_manual), and a link
-- never becomes a confirmed supplier match (supplier_price_matches).
--
-- The address is stored as worker/lib/supplierPrices/ownerLinks.ts wrote it,
-- after the shared parser (packages/catalog/src/supplierPrices/ownerLink.ts)
-- read it: https only, printable ASCII (the URL standard percent-encodes the
-- rest and punycodes the host), at most 1000 characters. The Worker never
-- fetches it. The CHECKs below hold that shape whatever door writes.
--
-- ADDITIVE ONLY: one new table, its two indexes and its three import-guard
-- triggers. No table is rebuilt, no CHECK is widened and no existing row
-- changes.
--
-- RE-RUNNABLE: every CREATE says IF NOT EXISTS, so scripts/migrate-check.mjs
-- --twice re-runs them and proves nothing moves.
--
-- DEPLOY-AHEAD (CLAUDE.md rule 2): the one reader (worker/lib/supplierPrices/
-- ownerLinks.ts) tolerates the table's absence: the read answers
-- `installed: false` beside the matched links, and the write answers 503
-- SUPPLIER_LINKS_NOT_INSTALLED. The name is chosen so that
-- isMissingEstimateSchema (0218's absence) never matches it: a database
-- without this file is never mistaken for one without 0218.
-- Comments use `--` only: tests/d1CompoundLimit.test.ts strips no block
-- comment, and no statement here chains a compound SELECT.
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_supplier_links (
  id TEXT PRIMARY KEY CHECK (id GLOB 'psl_?*' AND length(id) <= 40),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- '' is the whole product; otherwise a canonical SKU combo key, or a canonical
  -- subset of one: 'o:<option value>', 'c:<colour>', or one exact SKU.
  combo_key TEXT NOT NULL DEFAULT '' CHECK (length(combo_key) <= 400 AND (combo_key = '' OR combo_key GLOB 'o:?*' OR combo_key GLOB 'c:?*')),
  -- https only, printable ASCII without a space, as the parser serialised it.
  url TEXT NOT NULL CHECK (length(url) BETWEEN 12 AND 1000 AND substr(url, 1, 8) = 'https://' AND url NOT GLOB '*[^!-~]*'),
  -- The address's host: lower case, punycoded, dotted (never an IP literal).
  host TEXT NOT NULL CHECK (length(host) BETWEEN 3 AND 253 AND host NOT GLOB '*[^a-z0-9.-]*' AND host GLOB '*?.?*'),
  label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 80),
  supplier_name TEXT NOT NULL DEFAULT '' CHECK (length(supplier_name) <= 80),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_psl_product ON product_supplier_links(product_id, combo_key);
-- One address once per key of a product (the write refuses a duplicate first; this is the second net).
CREATE UNIQUE INDEX IF NOT EXISTS ux_psl_link ON product_supplier_links(product_id, combo_key, url);

-- ============================================================================
-- THE IMPORT GUARD (DECISIONS row 239 in the database), in the exact shape
-- scripts/gen-import-guard-triggers.mjs prints and 0218 re-emits: armed only
-- while ops_guards holds 'catalog-import-batch', which exists only inside an
-- import batch. The table is listed in worker/lib/catalogImport/
-- protectedTables.ts LATE_PROTECTED_TABLES (tests/catalogImportGuards.test.ts).
-- ============================================================================
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_supplier_links_ins BEFORE INSERT ON product_supplier_links
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_supplier_links_upd BEFORE UPDATE ON product_supplier_links
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_guard_product_supplier_links_del BEFORE DELETE ON product_supplier_links
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
