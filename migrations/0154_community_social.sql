-- ============================================================================
--  0154 — THE SOCIAL GRAPH OF LEVO COMMUNITY (docs/COMMUNITY_ECOSYSTEM.md §3, Phase 2)
-- ============================================================================
-- What people do with what the community makes: follow a maker, like a post,
-- save it, talk under it, and — when something is wrong — block, mute or
-- report. Small tables with the row as the fact (a like is a row, unliking
-- deletes it), so every action is idempotent by its primary key and a replayed
-- request changes nothing. The counters on `community_posts` (0153) are kept
-- by the triggers here, never trusted from a client.
--
-- ADDITIVE: new tables and triggers only. Store follows stay in `follows`
-- (0001), product saves in `community_product_favorites` (0038), disputes in
-- `community_complaints` (0031): nothing existing is duplicated.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  FOLLOW A MAKER (user → user). Following a STORE stays in `follows`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (follower_id, user_id),
  CHECK (follower_id <> user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_follows_user ON user_follows(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
--  LIKE, SAVE, COMMENT ON A POST
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_likes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_community_likes_post ON community_likes(post_id, created_at DESC);

-- A save is private by default (the brief: «Saved Collections private by
-- default»); `collection` is a short name the person gives, '' = the one list.
CREATE TABLE IF NOT EXISTS community_saves (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  collection TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_community_saves_user ON community_saves(user_id, created_at DESC);

-- One level of replies (`parent_id`), like the request board's discussion
-- will be. `state`: visible, or removed by its author («حُذف التعليق» stays as
-- a stub so replies keep their place), or hidden by Levonis with a reason.
CREATE TABLE IF NOT EXISTS community_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES community_comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'visible' CHECK (state IN ('visible','removed','hidden')),
  admin_hidden_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments(post_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_community_comments_author ON community_comments(author_id, created_at DESC);

-- ---------------------------------------------------------------------------
--  BLOCK, MUTE, REPORT
-- ---------------------------------------------------------------------------
-- A block is mutual silence enforced by the server on every door (DM, follow,
-- comment, the creator page, offers on the blocker's requests). A mute hides
-- the muted person's posts and comments from the viewer's own feeds and says
-- nothing to anyone.
CREATE TABLE IF NOT EXISTS user_blocks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, blocked_id),
  CHECK (user_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS user_mutes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, muted_id),
  CHECK (user_id <> muted_id)
);

-- A report is about ONE thing, by ONE person, once (the unique index): the
-- second press of «إبلاغ» is a replay, not a second report. Order disputes
-- stay in `community_complaints`; this is for content and conduct.
CREATE TABLE IF NOT EXISTS community_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','comment','user','store','product','request')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spam','abuse','nudity','fraud','copyright','offtopic','other')),
  details TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','reviewed','actioned','dismissed')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_reports_once ON community_reports(reporter_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_community_reports_queue ON community_reports(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_reports_target ON community_reports(target_type, target_id);

-- ---------------------------------------------------------------------------
--  THE COUNTERS ON A POST are the rows, counted by triggers
-- ---------------------------------------------------------------------------
-- `CHECK (>= 0)` on 0153's counters would abort a decrement below zero, so the
-- decrements are floored with MAX(); a counter can then only drift upward from
-- a repaired row, never make a delete fail.
CREATE TRIGGER IF NOT EXISTS trg_like_ins AFTER INSERT ON community_likes
BEGIN
  UPDATE community_posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_like_del AFTER DELETE ON community_likes
BEGIN
  UPDATE community_posts SET like_count = MAX(0, like_count - 1) WHERE id = OLD.post_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_save_ins AFTER INSERT ON community_saves
BEGIN
  UPDATE community_posts SET save_count = save_count + 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_save_del AFTER DELETE ON community_saves
BEGIN
  UPDATE community_posts SET save_count = MAX(0, save_count - 1) WHERE id = OLD.post_id;
END;
-- Only VISIBLE comments count; removing or hiding one takes it out of the
-- number, restoring it puts it back.
CREATE TRIGGER IF NOT EXISTS trg_comment_ins AFTER INSERT ON community_comments
WHEN NEW.state = 'visible'
BEGIN
  UPDATE community_posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_comment_del AFTER DELETE ON community_comments
WHEN OLD.state = 'visible'
BEGIN
  UPDATE community_posts SET comment_count = MAX(0, comment_count - 1) WHERE id = OLD.post_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_comment_state AFTER UPDATE OF state ON community_comments
WHEN OLD.state <> NEW.state AND (OLD.state = 'visible' OR NEW.state = 'visible')
BEGIN
  UPDATE community_posts
     SET comment_count = CASE WHEN NEW.state = 'visible' THEN comment_count + 1 ELSE MAX(0, comment_count - 1) END
   WHERE id = NEW.post_id;
END;

-- ---------------------------------------------------------------------------
--  FOLLOWER COUNTS on a person, denormalised for the creator card
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN follower_count INTEGER NOT NULL DEFAULT 0 CHECK (follower_count >= 0);
CREATE TRIGGER IF NOT EXISTS trg_user_follow_ins AFTER INSERT ON user_follows
BEGIN
  UPDATE users SET follower_count = follower_count + 1 WHERE id = NEW.user_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_user_follow_del AFTER DELETE ON user_follows
BEGIN
  UPDATE users SET follower_count = MAX(0, follower_count - 1) WHERE id = OLD.user_id;
END;
