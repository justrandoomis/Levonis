-- 0177 — owner decision 2 (2026-10-07), brief 1 §25–§43. Private grants (deny by
-- default; ignored while PRIVATE_DELEGATION_ENABLED=false), the security-event log,
-- and "every new admin starts as an assistant" enforced by the database.
-- Additive only: applying this file changes no existing row of any table.
--
-- «أي Admin جديد يبدأ Assistant Admin بدون PRICING_PRIVATE_READ / PRICING_PRIVATE_WRITE
--  ولا يتم منح هذه الصلاحيات تلقائياً لأي شخص.»
--
-- Readers tolerate every object here being absent (the Worker can reach a database
-- this file has not): the grant loader is never called while delegation is off and
-- catches "no such table" when it is; the promotion default is also written by the
-- user PATCH route; the cost predicates read no table at all.

-- Grants of private pricing access. Append-only: a grant is created once and
-- revoked once; nothing is ever deleted, so the history survives.
CREATE TABLE IF NOT EXISTS admin_private_grants (
  id            TEXT PRIMARY KEY,                                   -- 'apg_' + newId: referenced by revoke and audit
  user_id       TEXT NOT NULL REFERENCES users(id),                 -- the admin receiving access
  grant_key     TEXT NOT NULL CHECK (grant_key IN ('PRICING_PRIVATE_READ','PRICING_PRIVATE_WRITE')),
  granted_by    TEXT NOT NULL REFERENCES users(id),                 -- always the owner (route-enforced)
  granted_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reason        TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  operation_id  TEXT NOT NULL UNIQUE CHECK (length(operation_id) BETWEEN 8 AND 80), -- idempotency (§37)
  revoked_at    TEXT,
  revoked_by    TEXT,                                               -- a user id, or 'system:role_change' (no FK)
  revoke_reason TEXT NOT NULL DEFAULT '' CHECK (length(revoke_reason) <= 300),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (user_id <> granted_by)                                     -- nobody grants themself
);
-- At most one LIVE grant per (user, key); revoked ones stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS ux_admin_private_grants_live
  ON admin_private_grants(user_id, grant_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_private_grants_user ON admin_private_grants(user_id);

CREATE TRIGGER IF NOT EXISTS admin_private_grants_no_delete
BEFORE DELETE ON admin_private_grants
BEGIN SELECT RAISE(ABORT, 'admin_private_grants is append-only'); END;

-- The only legal UPDATE sets revoked_* on a live row; every other column frozen.
CREATE TRIGGER IF NOT EXISTS admin_private_grants_revoke_only
BEFORE UPDATE ON admin_private_grants
WHEN OLD.revoked_at IS NOT NULL
  OR NEW.revoked_at IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.grant_key IS NOT OLD.grant_key OR NEW.granted_by IS NOT OLD.granted_by
  OR NEW.granted_at IS NOT OLD.granted_at OR NEW.reason IS NOT OLD.reason
  OR NEW.operation_id IS NOT OLD.operation_id
BEGIN SELECT RAISE(ABORT, 'a private grant can only be revoked, once'); END;

-- A grant never outlives the admin role, whichever code path demotes.
CREATE TRIGGER IF NOT EXISTS users_demotion_revokes_private_grants
AFTER UPDATE OF role ON users
WHEN OLD.role = 'admin' AND NEW.role IS NOT 'admin'
BEGIN
  UPDATE admin_private_grants
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         revoked_by = 'system:role_change',
         revoke_reason = 'role_change'
   WHERE user_id = NEW.id AND revoked_at IS NULL;
END;

-- Decision 2: every new admin starts as an assistant, whatever the writer.
-- Fires only on the non-admin → admin transition; a later scope-only UPDATE
-- (owner elevation) does not touch `role` and is not affected.
--
-- THE OWNER'S BOOTSTRAP FIRES IT TOO (critique G-3). This file cannot know
-- INITIAL_ADMIN_EMAIL, so the trigger cannot exempt the owner. Two things keep
-- the owner whole instead: the bootstrap (worker/routes/auth.ts) writes the
-- role and then `admin_scope = NULL` as two statements in one batch, and every
-- cost and money predicate recognises the owner by address BEFORE it reads any
-- scope, so an owner row left at 'assistant' still holds every owner power.
--
-- A SAME-STATEMENT SCOPE IS OVERWRITTEN (critique D5): `SET role='admin',
-- admin_scope='full'` lands as 'assistant'. The user PATCH route therefore
-- writes the role and an owner's elevation as two statements, and answers with
-- the scope it reads back.
CREATE TRIGGER IF NOT EXISTS users_promotion_starts_assistant
AFTER UPDATE OF role ON users
WHEN NEW.role = 'admin' AND OLD.role IS NOT 'admin'
BEGIN
  UPDATE users SET admin_scope = 'assistant' WHERE id = NEW.id;
END;

-- §40: refusals, rate-limit hits and privilege changes, for the owner only.
-- Written by S2 (worker/lib/securityEvents.ts); nothing in S1 writes or reads it.
CREATE TABLE IF NOT EXISTS security_events (
  id          TEXT PRIMARY KEY,                               -- 'sev_' + newId
  bucket      TEXT NOT NULL UNIQUE,                           -- dedupe key: kind|code|actor|method route|target|minute
  kind        TEXT NOT NULL CHECK (kind IN ('cost_denied','money_denied','owner_denied','admin_denied',
                'rate_limited','role_changed','scope_changed','investor_changed','grant_changed',
                'enumeration_suspected','private_input_dropped','idor_suspected')),
  code        TEXT NOT NULL DEFAULT '' CHECK (length(code) <= 64),          -- refusal code, e.g. COST_ACCESS_DENIED
  actor_id    TEXT,                                           -- NULL = guest; no FK (the log must never block a write)
  actor_class TEXT NOT NULL CHECK (actor_class IN ('guest','customer','merchant','assistant_admin',
                'full_admin','cost_grantee','owner')),
  ip_hash     TEXT NOT NULL DEFAULT '',                       -- sha256(ip|baghdadDay) first 16 hex: groups a guest's tries, stores no address
  method      TEXT NOT NULL CHECK (method IN ('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS')),
  route       TEXT NOT NULL CHECK (length(route) <= 200),     -- Hono route PATTERN, never a raw URL or query string
  target_id   TEXT CHECK (target_id IS NULL OR length(target_id) <= 80), -- the :id param, evidence of enumeration
  status      INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  first_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  detail      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND length(detail) <= 1000) -- allowlisted keys only
);
CREATE INDEX IF NOT EXISTS idx_security_events_last  ON security_events(last_at);
CREATE INDEX IF NOT EXISTS idx_security_events_actor ON security_events(actor_id, kind, last_at);
CREATE INDEX IF NOT EXISTS idx_security_events_kind  ON security_events(kind, last_at);
