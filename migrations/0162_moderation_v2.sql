-- ============================================================================
--  0162 — MODERATION V2 (docs/COMMUNITY_ECOSYSTEM.md §9.6, Phase 6a)
-- ============================================================================
-- An account's STANDING, and the queryable history of every moderation
-- decision the desk takes, and the one door a person has to contest it.
--
--   · users.status — active | restricted | suspended | banned. A restriction
--     or a suspension may end on `status_until`, read at request time
--     (worker/lib/userStatus.ts) — no cron has to run for it to lift. A ban
--     lasts until a `restore`. `status_reason` is what the person is told.
--   · moderation_actions — one row per decision (hide, remove, warn,
--     restrict, suspend, ban, restore) on one target, with the staff member
--     who took it, the reason, the end date and the report it answered. The
--     audit_log row is still written beside it; this table is the history the
--     desk shows and the thing an appeal names. `subject_user_id` is the
--     person the decision concerns (the author of a hidden post, the account
--     itself): who is told, and who may appeal.
--   · moderation_appeals — one appeal per decision per person (the UNIQUE
--     below), open until the desk accepts (the decision is undone) or rejects
--     it.
--
-- ADDITIVE: four nullable-or-defaulted columns on `users` (no rebuild — 60
-- foreign keys point at it) and two new tables. `community_reports` keeps its
-- 0154 CHECK; `community_comments` (0154) already has state 'hidden' and
-- admin_hidden_reason, and `community_posts` (0153) admin_hidden_at/_reason.
-- ============================================================================

ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','restricted','suspended','banned'));
ALTER TABLE users ADD COLUMN status_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN status_until TEXT;
ALTER TABLE users ADD COLUMN status_changed_at TEXT;

-- The few moderated accounts, for the «hidden authors» subquery every public
-- community list runs once (worker/lib/userStatus.ts HIDDEN_AUTHORS_SQL): a
-- partial index, so it never walks the active majority.
CREATE INDEX IF NOT EXISTS idx_users_moderated ON users(status) WHERE status <> 'active';

-- ---------------------------------------------------------------------------
--  EVERY DECISION, AS A ROW. `target_id` is polymorphic (a post, a comment, a
--  request comment, an account, a store, a product, a request, a review), so
--  it carries no foreign key; `until` is the end date of a restriction or a
--  suspension (ISO 8601, `Z`), NULL otherwise.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  subject_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','comment','request_comment','user','store','product','request','review')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('hide','remove','warn','restrict','suspend','ban','restore')),
  reason TEXT NOT NULL DEFAULT '',
  until TEXT,
  report_id TEXT REFERENCES community_reports(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_target ON moderation_actions(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_actor ON moderation_actions(actor_id);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_subject ON moderation_actions(subject_user_id, created_at);

-- ---------------------------------------------------------------------------
--  ONE APPEAL PER DECISION PER PERSON. A plain UNIQUE, not a partial one: the
--  rule is one appeal per action, open or decided — a rejected appeal is an
--  answer, not an invitation to file the same one again.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moderation_appeals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL REFERENCES moderation_actions(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','accepted','rejected')),
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  decision TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (action_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_queue ON moderation_appeals(state, created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_user ON moderation_appeals(user_id, created_at);
