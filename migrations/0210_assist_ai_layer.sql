-- 0210: the support assistant's AI layer (push B; DECISIONS row 262). Runtime model choice per task,
-- owner-entered rates, the daily spend cap, the usage ledger and provider health. Additive only.
-- No row here names a model: the owner picks every model in Admin from the provider's live list;
-- a task with no model row runs in basic mode. No message text, transcript, image, prompt, user id,
-- IP address or credential is ever stored in these tables. Task and provider names are validated in
-- code (worker/lib/ai), not by CHECK, so a later provider or task needs no table rebuild.
--
-- Owning service: support (ai_spend_day, ai_usage, ai_provider_health) and config (ai_settings,
-- ai_task_models); packages/contracts/src/ownership.ts and docs/architecture/01-TARGET.md §2.1.
CREATE TABLE IF NOT EXISTS ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  daily_cap_micro_usd INTEGER NOT NULL DEFAULT 1000000 CHECK (daily_cap_micro_usd BETWEEN 0 AND 50000000),
  guests INTEGER NOT NULL DEFAULT 0 CHECK (guests IN (0, 1)),
  guest_share_pct INTEGER NOT NULL DEFAULT 25 CHECK (guest_share_pct BETWEEN 0 AND 100),
  understand_ckb INTEGER NOT NULL DEFAULT 0 CHECK (understand_ckb IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO ai_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS ai_task_models (
  task TEXT NOT NULL CHECK (length(task) BETWEEN 1 AND 32),
  rank INTEGER NOT NULL CHECK (rank IN (0, 1)),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 128),
  in_micro_per_mtok INTEGER NOT NULL DEFAULT 0 CHECK (in_micro_per_mtok BETWEEN 0 AND 1000000000),
  out_micro_per_mtok INTEGER NOT NULL DEFAULT 0 CHECK (out_micro_per_mtok BETWEEN 0 AND 1000000000),
  cache_write_micro_per_mtok INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_micro_per_mtok BETWEEN 0 AND 1000000000),
  cache_read_micro_per_mtok INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_micro_per_mtok BETWEEN 0 AND 1000000000),
  speech_micro_per_minute INTEGER NOT NULL DEFAULT 0 CHECK (speech_micro_per_minute BETWEEN 0 AND 1000000000),
  effort_low INTEGER NOT NULL DEFAULT 0 CHECK (effort_low IN (0, 1)),
  gone INTEGER NOT NULL DEFAULT 0 CHECK (gone IN (0, 1)),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (task, rank)
);

CREATE TABLE IF NOT EXISTS ai_spend_day (
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  spent_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  guest_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (guest_micro_usd >= 0),
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0)
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  task TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 32),
  guest INTEGER NOT NULL DEFAULT 0 CHECK (guest IN (0, 1)),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  speech_ms INTEGER NOT NULL DEFAULT 0 CHECK (speech_ms >= 0),
  cost_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_day_task ON ai_usage (day, task);

CREATE TABLE IF NOT EXISTS ai_provider_health (
  provider TEXT PRIMARY KEY CHECK (length(provider) BETWEEN 1 AND 32),
  last_ok_at TEXT,
  last_fail_at TEXT,
  last_fail_code TEXT CHECK (last_fail_code IS NULL OR length(last_fail_code) <= 32),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  open_until TEXT
);
