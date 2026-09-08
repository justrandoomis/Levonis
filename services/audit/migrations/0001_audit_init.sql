-- 0001_audit_init.sql — service: audit (levonis-audit-db)
--
-- The audit store's own migration stream (`01-TARGET.md` §2.3 item 6: a service
-- with its own database keeps `services/<name>/migrations/` and its own workflow
-- applies it before the code). It is NOT part of the core's `migrations/`
-- stream and never runs against the shared database.
--
-- Generated from `services/audit/src/schema.ts` — `test/schema.test.ts` compares
-- the two statement by statement, so the DDL and the code cannot drift.
-- Additive and re-runnable: every statement is CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS audit_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  event_id       TEXT NOT NULL UNIQUE,
  event_type     TEXT NOT NULL,
  actor_id       TEXT,
  action         TEXT NOT NULL,
  target         TEXT NOT NULL DEFAULT '',
  detail_hash    TEXT NOT NULL,
  detail_ref     TEXT,
  detail         TEXT,
  source_service TEXT NOT NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  occurred_at    TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  chain_index    INTEGER UNIQUE,
  prev_hash      TEXT,
  hash           TEXT,
  alg            TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_events_unsealed ON audit_events(seq) WHERE chain_index IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_recorded ON audit_events(recorded_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action, recorded_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_target ON audit_events(target, recorded_at);

CREATE TABLE IF NOT EXISTS audit_chain_heads (
  chain          TEXT PRIMARY KEY,
  chain_index    INTEGER NOT NULL,
  head_hash      TEXT NOT NULL,
  alg            TEXT NOT NULL,
  sealed_at      TEXT NOT NULL,
  anchored_index INTEGER,
  anchored_hash  TEXT,
  anchored_at    TEXT
);

CREATE TABLE IF NOT EXISTS audit_processed_events (
  event_id     TEXT PRIMARY KEY,
  consumer     TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  result       TEXT
);

CREATE TABLE IF NOT EXISTS audit_idempotency (
  service      TEXT NOT NULL,
  scope        TEXT NOT NULL,
  key          TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status       INTEGER NOT NULL,
  body         TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (service, scope, key)
);
CREATE INDEX IF NOT EXISTS idx_audit_idempotency_created ON audit_idempotency(created_at);
