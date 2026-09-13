-- Additive metadata only. Never manufacture publication dates or rewrite
-- the content/hash of policies accepted before this migration.
ALTER TABLE policy_documents ADD COLUMN published_at TEXT;
ALTER TABLE policy_documents ADD COLUMN effective_at TEXT;
ALTER TABLE policy_acceptances ADD COLUMN document_id TEXT REFERENCES policy_documents(id);
ALTER TABLE policy_acceptances ADD COLUMN order_id TEXT REFERENCES orders(id);
ALTER TABLE policy_acceptances ADD COLUMN locale TEXT CHECK (locale IS NULL OR locale IN ('ar','en','ckb'));
ALTER TABLE policy_acceptances ADD COLUMN requested_locale TEXT CHECK (requested_locale IS NULL OR requested_locale IN ('ar','en','ckb'));
ALTER TABLE policy_acceptances ADD COLUMN event TEXT;
CREATE INDEX IF NOT EXISTS idx_policy_acceptances_order ON policy_acceptances(order_id, user_id) WHERE order_id IS NOT NULL;

-- Archiving a published version is allowed. Altering accepted content is not.
CREATE TRIGGER IF NOT EXISTS policy_documents_immutable_update
BEFORE UPDATE ON policy_documents
WHEN OLD.status IN ('published','archived') AND (
  NEW.id IS NOT OLD.id OR NEW.key IS NOT OLD.key OR NEW.version IS NOT OLD.version
  OR NEW.lang IS NOT OLD.lang OR NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body
  OR NEW.hash IS NOT OLD.hash OR NEW.created_at IS NOT OLD.created_at
  OR NEW.published_at IS NOT OLD.published_at OR NEW.effective_at IS NOT OLD.effective_at
  OR NEW.status NOT IN ('published','archived')
  OR (OLD.status = 'archived' AND NEW.status != 'archived')
)
BEGIN SELECT RAISE(ABORT, 'POLICY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS policy_documents_immutable_delete
BEFORE DELETE ON policy_documents WHEN OLD.status IN ('published','archived')
BEGIN SELECT RAISE(ABORT, 'POLICY_IMMUTABLE'); END;
