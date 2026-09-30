-- ============================================================================
--  0156 — THE ASSET PLATFORM: RESUMABLE UPLOAD SESSIONS, A CHECKSUM ON EVERY
--         FILE (docs/COMMUNITY_ECOSYSTEM.md §9.4, Phase 4a)
-- ============================================================================
-- `POST /api/uploads` reads a whole body into memory, so a 300 MB print model
-- could never arrive that way. An upload SESSION is one R2 multipart upload
-- with a ledger row: the client declares the file (name, size, SHA-256), sends
-- fixed-size parts it may retry or resume after a reload, and `complete`
-- verifies every part, sniffs the bytes, streams the object through SHA-256
-- and refuses (deleting the object) when the declared digest does not match.
--
-- `parts_json` is the parts received so far — `[{n, etag, bytes}]` — because
-- R2 wants the etags back at completion and a resumed client wants to know
-- which parts it can skip. `state` moves open → completed | aborted | expired;
-- the cron sweeps `open` rows past `expires_at` (abort + expire).
--
-- `file_objects` gains the digest a completed session verified (NULL for every
-- object stored before this migration and for the whole-body route, which
-- never had one) and the PURPOSE the file was uploaded for, so a per-owner
-- quota can be counted per purpose without guessing it back from the key.
--
-- ADDITIVE: one table, two indexes, two nullable/defaulted columns.
-- ============================================================================
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  declared_bytes INTEGER NOT NULL CHECK (declared_bytes > 0),
  declared_mime TEXT NOT NULL DEFAULT '',
  -- Hex, lower-case, declared by the client and VERIFIED on complete.
  sha256 TEXT NOT NULL,
  chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes > 0),
  r2_upload_id TEXT NOT NULL,
  -- The final object key, built by buildMediaKey at session creation.
  object_key TEXT NOT NULL,
  parts_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'completed', 'aborted', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_owner_state ON upload_sessions(owner_id, state);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_state_expires ON upload_sessions(state, expires_at);

ALTER TABLE file_objects ADD COLUMN sha256 TEXT;
ALTER TABLE file_objects ADD COLUMN purpose TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_file_objects_owner_purpose ON file_objects(owner_id, purpose, deleted_at);
