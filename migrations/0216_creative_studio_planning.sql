-- «استوديو Levonis الإبداعي» — campaigns and the internal calendar (spec §21, §25; Phase 4 of
-- docs/CREATIVE_STUDIO_PROGRESS.md).
--
-- ADDITIVE ONLY: CREATE TABLE / CREATE INDEX IF NOT EXISTS, so a second run changes nothing
-- (scripts/migrate-check.mjs --twice). 0215 already has `creative_documents.campaign_id` and the
-- 'scheduled' status, but no campaign row to name a campaign and no planned date. A planned date is
-- a row of its own instead of a new column, so no ALTER is needed and the code that reads it
-- tolerates a database without this migration (worker/lib/creative/planning.ts, readOr/writeOr503).
--
-- INTERNAL ONLY: nothing here publishes anywhere. A planned date is the day (Asia/Baghdad calendar
-- day, 'YYYY-MM-DD') the team means to post the design by hand; there is no publishing provider.

CREATE TABLE IF NOT EXISTS creative_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  starts_on TEXT,
  ends_on TEXT,
  archived_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_campaigns_updated ON creative_campaigns(updated_at);

CREATE TABLE IF NOT EXISTS creative_document_plans (
  document_id TEXT PRIMARY KEY REFERENCES creative_documents(id),
  planned_for TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_document_plans_day ON creative_document_plans(planned_for);
