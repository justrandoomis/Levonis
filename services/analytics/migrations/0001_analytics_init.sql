-- 0001_analytics_init.sql — service: analytics (levonis-analytics-db)
--
-- The analytics store's own migration stream (`01-TARGET.md` §2.3 item 6). It is
-- NOT part of the core's `migrations/` stream and never runs against the shared
-- database. `merchant_store_analytics_daily` — the dead table the design re-owns
-- — is deliberately not created here: it lives in the shared database and moving
-- its rows is an owner decision, not a migration.
--
-- Generated from `services/analytics/src/schema.ts` — `test/schema.test.ts`
-- compares the two statement by statement. Additive and re-runnable: every
-- statement is CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS analytics_events (
  event_id       TEXT PRIMARY KEY,
  event_type     TEXT NOT NULL,
  version        INTEGER NOT NULL,
  day            TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  ingested_at    TEXT NOT NULL,
  source_service TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  aggregate_seq  INTEGER NOT NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  actor_hash     TEXT,
  merchant_id    TEXT,
  payload        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_daily_platform (
  day        TEXT NOT NULL,
  metric     TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, metric)
);

CREATE TABLE IF NOT EXISTS analytics_daily_merchant (
  day         TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (day, merchant_id, metric)
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_day ON analytics_events(day, event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_ingested ON analytics_events(ingested_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_aggregate ON analytics_events(aggregate_type, aggregate_id, aggregate_seq);
CREATE INDEX IF NOT EXISTS idx_analytics_daily_merchant_lookup ON analytics_daily_merchant(merchant_id, day);

CREATE TABLE IF NOT EXISTS analytics_processed_events (
  event_id     TEXT PRIMARY KEY,
  consumer     TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  result       TEXT
);

CREATE TABLE IF NOT EXISTS analytics_idempotency (
  service      TEXT NOT NULL,
  scope        TEXT NOT NULL,
  key          TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status       INTEGER NOT NULL,
  body         TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (service, scope, key)
);
CREATE INDEX IF NOT EXISTS idx_analytics_idempotency_created ON analytics_idempotency(created_at);
