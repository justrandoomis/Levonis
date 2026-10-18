-- 0204 — Community V3 phase 1, push 1.1: the merchant approval gate's data layer
-- (DECISIONS row 256; design: Community V3 gap analysis §3.1–§3.3, §3.7–§3.8).
--
-- Approval is a FOURTH axis beside sanction (community_merchants.status), store
-- operation (merchant_stores.status) and subscription (memberships). It is
-- written into none of them: a person is approved when a human reviewer
-- approved a merchant application, and `community_merchants.approved_at` is
-- the one flag the gates read. NULL is "not approved" and fails closed — there
-- is no legacy approval and no default (owner decision C1: every existing
-- merchant applies, no exceptions).
--
-- Additive only: CREATE and ADD, nothing rewritten, no existing row changed.
-- Readers tolerate every object here being absent (worker/lib/merchantApproval.ts
-- catches "no such table/column") and fail CLOSED for commitments.

-- The approval flag and the application that earned it. Written only by the
-- reviewer's approve transition (merchantApproval.ts `transitionStatements`).
ALTER TABLE community_merchants ADD COLUMN approved_at TEXT;
ALTER TABLE community_merchants ADD COLUMN approved_application_id TEXT;

-- THE APPLICATION: a private entity, never a hidden public store. Identity
-- values are sealed by worker/lib/sealbox.ts (AES-256-GCM, the KYC_ENC_KEY
-- ring) — there is no plaintext column for any of them, and nothing here is
-- ever copied to or from kyc_cases.
CREATE TABLE IF NOT EXISTS merchant_applications (
  id                   TEXT PRIMARY KEY,                       -- 'mapp_' + newId
  user_id              TEXT NOT NULL REFERENCES users(id),
  state                TEXT NOT NULL DEFAULT 'draft' CHECK (state IN
                         ('draft','submitted','in_review','changes_requested','approved','rejected','withdrawn')),
  -- What a reviewer decides on: frozen by submit, bumped when the applicant
  -- edits after a submission. Every decision is `WHERE state = ? AND revision = ?`.
  revision             INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  submitted_at         TEXT,
  -- Private review data, SEALED ('sealed:<ver>:<iv>:<ct>' or '').
  legal_name_enc       TEXT NOT NULL DEFAULT '',               -- JSON {given, father, grandfather}; a part may hold spaces («عبد الله»)
  dob_enc              TEXT NOT NULL DEFAULT '',               -- 'YYYY-MM-DD', date only, never a timestamp
  social_link_enc      TEXT NOT NULL DEFAULT '',               -- the Instagram/Facebook activity link
  -- The personal photo: private object under merchant-review/<application id>/…,
  -- re-encoded to WebP (no EXIF). /files never serves this prefix.
  photo_key            TEXT,
  -- Review context: not sensitive, never public.
  governorate          TEXT NOT NULL DEFAULT '',
  activity_kind        TEXT NOT NULL DEFAULT '' CHECK (activity_kind IN ('','print_services','products','both')),
  activity_description TEXT NOT NULL DEFAULT '' CHECK (length(activity_description) <= 1000),
  -- The PUBLIC draft the merchant later opens a store with. Never filled from the private fields.
  public_name          TEXT NOT NULL DEFAULT '' CHECK (length(public_name) <= 60),
  public_bio           TEXT NOT NULL DEFAULT '' CHECK (length(public_bio) <= 500),
  public_links         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(public_links)),
  -- Decision. `reason_public` is shown to the applicant; `note_internal` is
  -- staff-only and never serialised to the applicant.
  reason_public        TEXT NOT NULL DEFAULT '' CHECK (length(reason_public) <= 1000),
  note_internal        TEXT NOT NULL DEFAULT '' CHECK (length(note_internal) <= 2000),
  decided_by           TEXT,
  decided_at           TEXT,
  decided_revision     INTEGER,
  -- Retention (owner decision C7): 90 days after a rejection or a withdrawal the
  -- sealed values are blanked and the photo deleted; `purged_at` records it.
  retention_until      TEXT,
  purged_at            TEXT
);
-- ONE LIVE APPLICATION PER USER. Finished ones stay as history, so a rejected
-- applicant re-applies at once with a NEW application (owner decision C8).
CREATE UNIQUE INDEX IF NOT EXISTS ux_merchant_applications_live
  ON merchant_applications(user_id)
  WHERE state NOT IN ('approved','rejected','withdrawn');
CREATE INDEX IF NOT EXISTS idx_merchant_applications_user ON merchant_applications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_merchant_applications_queue ON merchant_applications(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_merchant_applications_retention
  ON merchant_applications(retention_until) WHERE retention_until IS NOT NULL AND purged_at IS NULL;

-- THE DECISION TRAIL: append-only, and it holds NO personal value — ids, the
-- revision, the action, the public reason and the time. It outlives the purge.
CREATE TABLE IF NOT EXISTS merchant_application_events (
  id             TEXT PRIMARY KEY,                             -- 'mape_' + newId
  application_id TEXT NOT NULL REFERENCES merchant_applications(id),
  revision       INTEGER NOT NULL,
  actor_id       TEXT,                                         -- NULL for the system (the retention sweep)
  actor_kind     TEXT NOT NULL CHECK (actor_kind IN ('applicant','reviewer','system')),
  action         TEXT NOT NULL CHECK (action IN ('created','reopened','submitted','review_started',
                   'changes_requested','approved','rejected','withdrawn','purged')),
  reason_public  TEXT NOT NULL DEFAULT '' CHECK (length(reason_public) <= 1000),
  at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Idempotency: a replayed transition finds its own event and writes nothing.
  operation_id   TEXT NOT NULL UNIQUE CHECK (length(operation_id) BETWEEN 8 AND 80)
);
CREATE INDEX IF NOT EXISTS idx_merchant_application_events_app
  ON merchant_application_events(application_id, at);

CREATE TRIGGER IF NOT EXISTS merchant_application_events_no_update
BEFORE UPDATE ON merchant_application_events
BEGIN SELECT RAISE(ABORT, 'merchant_application_events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS merchant_application_events_no_delete
BEFORE DELETE ON merchant_application_events
BEGIN SELECT RAISE(ABORT, 'merchant_application_events is append-only'); END;

-- STAFF CAPABILITIES, a sibling of 0177's admin_private_grants. That table's
-- grant_key CHECK admits its two pricing keys only and SQLite cannot alter a
-- CHECK, so a new table carries the same rules: nobody grants themself,
-- revoke-only, one live grant per key, revoked by demotion, operation_id.
-- The key is checked for SHAPE here and against the allowlist in code
-- (worker/lib/merchantApproval.ts CAPABILITY_GRANTS), so a later key is a code
-- change, not a table rebuild. First key: MERCHANT_REVIEW (owner decision C5)
-- — it opens merchant review and nothing financial.
CREATE TABLE IF NOT EXISTS admin_capability_grants (
  id            TEXT PRIMARY KEY,                              -- 'acg_' + newId
  user_id       TEXT NOT NULL REFERENCES users(id),            -- the admin receiving the capability
  grant_key     TEXT NOT NULL CHECK (grant_key GLOB '[A-Z]*' AND grant_key NOT GLOB '*[^A-Z_]*'
                  AND length(grant_key) BETWEEN 3 AND 64),
  granted_by    TEXT NOT NULL REFERENCES users(id),            -- always the owner (route-enforced)
  granted_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reason        TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  operation_id  TEXT NOT NULL UNIQUE CHECK (length(operation_id) BETWEEN 8 AND 80),
  revoked_at    TEXT,
  revoked_by    TEXT,                                          -- a user id, or 'system:role_change' (no FK)
  revoke_reason TEXT NOT NULL DEFAULT '' CHECK (length(revoke_reason) <= 300),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (user_id <> granted_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_admin_capability_grants_live
  ON admin_capability_grants(user_id, grant_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_capability_grants_user ON admin_capability_grants(user_id);

CREATE TRIGGER IF NOT EXISTS admin_capability_grants_no_delete
BEFORE DELETE ON admin_capability_grants
BEGIN SELECT RAISE(ABORT, 'admin_capability_grants is append-only'); END;

CREATE TRIGGER IF NOT EXISTS admin_capability_grants_revoke_only
BEFORE UPDATE ON admin_capability_grants
WHEN OLD.revoked_at IS NOT NULL
  OR NEW.revoked_at IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.grant_key IS NOT OLD.grant_key OR NEW.granted_by IS NOT OLD.granted_by
  OR NEW.granted_at IS NOT OLD.granted_at OR NEW.reason IS NOT OLD.reason
  OR NEW.operation_id IS NOT OLD.operation_id
BEGIN SELECT RAISE(ABORT, 'a capability grant can only be revoked, once'); END;

CREATE TRIGGER IF NOT EXISTS users_demotion_revokes_capability_grants
AFTER UPDATE OF role ON users
WHEN OLD.role = 'admin' AND NEW.role IS NOT 'admin'
BEGIN
  UPDATE admin_capability_grants
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         revoked_by = 'system:role_change',
         revoke_reason = 'role_change'
   WHERE user_id = NEW.id AND revoked_at IS NULL;
END;
