-- ============================================================================
-- 0227 — THE VIDEO ADS OF «اجمع النقاط» (owner, 2026-11-05; docs/DECISIONS.md
-- row 300).
--
-- The owner's brief, in their words:
--   «make sure for اجمع النقاط is work espissaly تصفّح المنتجات and شاهد إعلانً
--    and add this as first ads i give a video [ 2 times he can see. one per day
--    so the ads will run for 10 days so the user van watch it 2 times on whole
--    10 days but 1 per day ,ex he watch it on day 2 and the second time on day 9 >»
--
-- What this file lands:
--   (1) `reward_ads`: one row per ad: three titles, the video and its poster
--       (both public objects under rewards/ads/, worker/lib/mediaStorage.ts),
--       its size and length as the owner's browser read them from the file, the
--       seconds the server's clock must run before a view pays, its window, how
--       many views one customer gets (the owner's 2), and an on/off switch.
--   (2) `reward_claims.ad_id`: which ad a `video` award or ticket belongs to.
--
-- WHAT «ONE PER DAY» IS: not a new rule. Every award stays one `reward_claims`
-- row, and that table's UNIQUE (user_id, mission, day) over the Baghdad day is
-- what stops a second view the same day. «Two in ten days» is a COUNT of this
-- customer's awarded rows carrying this `ad_id`, re-checked inside the award's
-- own UPDATE (worker/lib/pointsTasks.ts `buildTimedAwardStatements`).
--
-- ADDITIVE ONLY: one new table, one nullable column and two indexes. No table is
-- rebuilt and no existing row changes; a mission row written before this file
-- has `ad_id` NULL and counts against no ad.
--
-- RE-RUNNABLE: every CREATE says IF NOT EXISTS, so scripts/migrate-check.mjs
-- --twice re-runs them and proves nothing moves. The one ADD COLUMN is excluded
-- from that re-run by the harness itself (SQLite has no ADD COLUMN IF NOT
-- EXISTS; D1 applies a file once).
--
-- DEPLOY-AHEAD (CLAUDE.md rule 2): worker/lib/rewards/ads.ts tolerates the
-- absence of both: before this file the mission runs on the old `adVideoUrl`
-- setting with the same statuses, an admin's write answers 503
-- REWARDS_NOT_INSTALLED and an admin's list is empty with `installed: false`.
--
-- NO AD IS SEEDED HERE: a row names an object in the bucket, and an object is put
-- there by the owner's upload (Admin → المكافآت → الإعلانات), never by SQL.
-- Comments use `--` only: tests/d1CompoundLimit.test.ts strips no block comment.
-- ============================================================================

CREATE TABLE IF NOT EXISTS reward_ads (
  id TEXT PRIMARY KEY,
  title_ar TEXT NOT NULL DEFAULT '',
  title_en TEXT NOT NULL DEFAULT '',
  title_ckb TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL,
  poster_url TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0 CHECK (width >= 0),
  height INTEGER NOT NULL DEFAULT 0 CHECK (height >= 0),
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  required_seconds INTEGER NOT NULL CHECK (required_seconds > 0),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  max_views INTEGER NOT NULL DEFAULT 2 CHECK (max_views > 0),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  sort INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_reward_ads_live ON reward_ads(active, sort, starts_at);

ALTER TABLE reward_claims ADD COLUMN ad_id TEXT;

-- «How many views of this ad does this customer have»: the count the award's
-- UPDATE asks inside its own transaction, and the admin list's figures.
CREATE INDEX IF NOT EXISTS idx_reward_claims_ad ON reward_claims(ad_id, user_id) WHERE ad_id IS NOT NULL;
