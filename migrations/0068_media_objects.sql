-- Logical public/private R2 metadata. Objects stay in R2; this table stores
-- references and audit metadata only. Existing URLs/keys remain valid and are
-- inventoried by the non-destructive migration utility before any cleanup.
CREATE TABLE IF NOT EXISTS file_objects (
  object_key TEXT PRIMARY KEY,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  domain TEXT NOT NULL,
  owner_id TEXT,
  entity_id TEXT,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  original_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_objects_owner ON file_objects(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_objects_entity ON file_objects(domain, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_objects_visibility ON file_objects(visibility, deleted_at);

-- Every migration is append-only and reviewable. `verified_pending_cleanup`
-- means the destination was read back and DB references were updated; it does
-- NOT delete the old object. Cleanup remains an explicit later operation.
CREATE TABLE IF NOT EXISTS file_migration_log (
  id TEXT PRIMARY KEY,
  old_key TEXT NOT NULL,
  new_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('copy', 'convert_webp')),
  state TEXT NOT NULL CHECK (state IN ('copied', 'verified_pending_cleanup', 'failed')),
  detail TEXT NOT NULL DEFAULT '',
  actor_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_file_migration_old ON file_migration_log(old_key, created_at DESC);
