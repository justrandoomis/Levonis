-- Warranty claims carry the PRO priority-service snapshot, the same way
-- support tickets do (0010): decided at creation from the member's ACTIVE
-- standing, never re-read later, so a lapsed membership does not silently
-- demote a claim that was opened as a priority one. The admin queue orders
-- by it first.
ALTER TABLE warranty_claims ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_warranty_claims_queue ON warranty_claims(priority DESC, created_at ASC);
