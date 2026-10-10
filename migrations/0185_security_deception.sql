-- 0185 — the deception layer (owner brief 2026-10-10): decoy answers, canary
-- batches, actor scores and blocks (worker/lib/deception/, DECISIONS row 206).
-- Additive only: three new tables; no existing table or row is touched
-- (security_events keeps 0177's CHECK — the new events reuse its kinds with
-- their own codes). Every reader tolerates these tables being absent: a Worker
-- ahead of this file blocks nobody by account or network, its stateless device
-- tags still work, and the decoys still answer.
--
-- NOTHING HERE HOLDS AN ADDRESS, A TOKEN OR A SECRET. An actor is a user id, a
-- 16-hex device tag id, or a 32-hex network day hash; evidence is allowlisted
-- codes and hashes; a canary batch is the 10 hex every token of one decoy
-- answer carries (the tokens themselves are recomputed from it, never stored).

CREATE TABLE IF NOT EXISTS security_blocks (
  id           TEXT PRIMARY KEY,                                   -- 'sbk_' + newId
  incident_id  TEXT NOT NULL CHECK (length(incident_id) BETWEEN 8 AND 40), -- 'sin_' + newId: the blocks one detection placed together
  reference    TEXT NOT NULL CHECK (length(reference) BETWEEN 6 AND 20),   -- shown to the blocked party ('LV-XXXXXXXX'), one per incident
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('account','device','network')),
  actor_key    TEXT NOT NULL CHECK (length(actor_key) BETWEEN 8 AND 64),   -- user id | device tag id (16 hex) | network day hash (32 hex), never an address
  actor_class  TEXT NOT NULL CHECK (actor_class IN ('guest','customer','merchant','assistant_admin','full_admin','cost_grantee')), -- never 'owner': the owner is never blocked
  reason       TEXT NOT NULL CHECK (reason IN ('canary_used','decoy_hit','score_threshold')),
  signal       TEXT NOT NULL DEFAULT '' CHECK (length(signal) <= 64),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), -- moved by every insert, re-block and lift: the isolates' delta refresh reads it
  lifted_at    TEXT,
  lifted_by    TEXT,                                               -- the owner's user id (no FK: the log never blocks a write)
  hits         INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),       -- blocked requests answered (flushed at most once a minute per isolate)
  last_hit_at  TEXT,
  evidence     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence) AND length(evidence) <= 1500), -- allowlisted codes and hashes only
  CHECK ((lifted_at IS NULL) = (lifted_by IS NULL)),
  CHECK (expires_at > created_at)
);
-- One live block per actor; a re-block of an expired, unlifted row is an upsert on this index.
CREATE UNIQUE INDEX IF NOT EXISTS ux_security_blocks_live ON security_blocks(actor_kind, actor_key) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_security_blocks_updated  ON security_blocks(updated_at);
CREATE INDEX IF NOT EXISTS idx_security_blocks_incident ON security_blocks(incident_id);
CREATE INDEX IF NOT EXISTS idx_security_blocks_created  ON security_blocks(created_at);

CREATE TABLE IF NOT EXISTS security_canaries (
  batch_id      TEXT PRIMARY KEY CHECK (length(batch_id) = 10),    -- the 10 hex every token of one decoy answer carries
  decoy         TEXT NOT NULL CHECK (length(decoy) BETWEEN 1 AND 40), -- which decoy answered (code), so the console can regenerate it
  incident_id   TEXT,
  issued_to     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(issued_to) AND length(issued_to) <= 400), -- {u?, d?, n?} actor keys of the receiver
  issued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  first_used_at TEXT,
  use_count     INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0)
);
CREATE INDEX IF NOT EXISTS idx_security_canaries_issued ON security_canaries(issued_at);

CREATE TABLE IF NOT EXISTS security_scores (
  actor_key   TEXT PRIMARY KEY CHECK (length(actor_key) BETWEEN 3 AND 70), -- 'u:<user id>' | 'd:<tag id>' | 'n:<network day hash>'
  score       INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),       -- halves every six hours (step decay in the upsert)
  updated_at  TEXT NOT NULL,
  signals     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(signals) AND length(signals) <= 600) -- {SIGNAL_CODE: count}
);
CREATE INDEX IF NOT EXISTS idx_security_scores_updated ON security_scores(updated_at);
