-- ============================================================================
--  0072 — PERMANENT PRODUCT DELETE: THE DEFERRED HALF
-- ============================================================================
-- THE DEFECT THIS EXISTS TO CLOSE. Deleting a product ran exactly two
-- statements (worker/routes/adminProducts.ts): `DELETE FROM product_catalogs`
-- and `DELETE FROM products`. Everything else was left to `ON DELETE CASCADE`
-- — and a scan of the real schema shows that of the tables carrying a
-- product-shaped column, only some declare a foreign key at all:
--
--   * `reviews.product_id` and both `mystery_allocations` columns are NO ACTION
--     — the row survives with a dangling id;
--   * `order_items`, `order_item_units`, `warranty_receipts`, `price_history`,
--     `community_complaints` and the several `color_id` columns carry NO
--     FOREIGN KEY AT ALL, so nothing was ever going to clean or null them;
--   * nothing in the Worker sets `PRAGMA foreign_keys`, so even the declared
--     cascades are a promise this codebase never verifies at runtime.
--
-- And a product referenced by any past order was never deleted at all — it was
-- flipped to `status = 'hidden'`, leaving the row and every child behind. That
-- is the residue the owner hits when re-importing the same product or reusing
-- the same slug.
--
-- The fix is an EXPLICIT, ordered deletion driven by a registry
-- (worker/lib/productDeletion.ts) rather than by trust in cascades — which is
-- also the only way to report `rows_deleted_by_table`, as the owner asked. A
-- test walks the live schema and fails if any product-referencing table is
-- missing from that registry, so the next migration that adds one cannot
-- silently reintroduce a leak.
--
-- WHAT NEEDS A TABLE, AND WHY. D1 and R2 cannot share a transaction. Deleting
-- R2 objects first risks destroying files for a product whose rows then fail to
-- delete; deleting rows first risks orphaning R2 objects if the bucket call
-- fails. So the row deletion COMMITS FIRST, having recorded the intent here,
-- and the bucket work is retried from this table until it succeeds. A pending
-- job is a file that still exists and should not; it is never a product that
-- still exists.
-- ============================================================================

CREATE TABLE IF NOT EXISTS media_cleanup_jobs (
  id TEXT PRIMARY KEY,
  -- The R2 object key. Not a URL: an external vendor URL is never ours to
  -- delete and never reaches this table.
  object_key TEXT NOT NULL,
  -- Which bucket the key lives in, so a retry cannot guess wrong.
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  -- Provenance, for the audit trail and for the orphan scanner's report. The
  -- product is already gone by the time a job runs, so this is a plain string
  -- and deliberately NOT a foreign key.
  reason TEXT NOT NULL DEFAULT 'product_delete',
  source_product_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'skipped_shared')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The retry sweep reads exactly this.
CREATE INDEX IF NOT EXISTS idx_media_cleanup_pending
  ON media_cleanup_jobs(state, created_at);
-- Idempotency: a second delete of the same object must not queue it twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_cleanup_key_pending
  ON media_cleanup_jobs(object_key) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_media_cleanup_source
  ON media_cleanup_jobs(source_product_id, created_at);
