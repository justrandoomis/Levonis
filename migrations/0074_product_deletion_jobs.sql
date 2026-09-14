-- Durable outbox. It deliberately has no FK to the deleted product.
CREATE TABLE IF NOT EXISTS product_deletion_jobs (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  actor_id TEXT,
  revision_matches INTEGER NOT NULL DEFAULT 1 CHECK (revision_matches=1),
  status TEXT NOT NULL CHECK (status IN ('committed','done')),
  report TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_deletion_product ON product_deletion_jobs(product_id, created_at DESC);
CREATE TABLE IF NOT EXISTS media_cleanup_jobs (
  id TEXT PRIMARY KEY,
  deletion_job_id TEXT NOT NULL REFERENCES product_deletion_jobs(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','retry','done','shared')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  completed_at TEXT,
  UNIQUE (deletion_job_id, object_key)
);
CREATE INDEX IF NOT EXISTS idx_media_cleanup_pending ON media_cleanup_jobs(status, attempts);
CREATE TABLE IF NOT EXISTS product_orphan_reports (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  report TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS historical_inventory_ledger (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
