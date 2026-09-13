-- Separate review publication/source from reward adjudication. Existing rows
-- are user-authored by default and retain their current publication/reward
-- state. New system reviews are explicitly marked and never get reward rows.

ALTER TABLE reviews ADD COLUMN source TEXT NOT NULL DEFAULT 'user'
  CHECK (source IN ('user','system'));
ALTER TABLE reviews ADD COLUMN quality_score INTEGER
  CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100);
ALTER TABLE reviews ADD COLUMN quality_summary TEXT NOT NULL DEFAULT '{}';
ALTER TABLE reviews ADD COLUMN fallback_points_awarded INTEGER NOT NULL DEFAULT 0
  CHECK (fallback_points_awarded >= 0);

ALTER TABLE review_rewards ADD COLUMN quality_snapshot TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_reviews_source_created
  ON reviews(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_system_due_guard
  ON reviews(user_id, product_id, source);

