-- ---------------------------------------------------------------------------
-- 0051 — an email sign-up is not an account until the inbox proves itself,
--        and the PASSWORD is chosen by the confirming request.
-- ---------------------------------------------------------------------------
-- The security audit (docs/SECURITY_AUDIT_2026-09.md) left one place that told
-- a stranger which addresses have accounts: POST /api/auth/register answered
-- 409 EMAIL_TAKEN. Two earlier attempts to close it were reverted by their own
-- adversarial re-review, and the audit's recommendation is what this migration
-- implements:
--
--   * /register creates NOTHING in `users`. The attempt waits here, keyed by
--     address, so the LATEST attempt is the only one that can be finished and
--     nothing anywhere (the response, /username-available, /login, the referral
--     count, the admin list) can say whether the address already has an account.
--     Only the inbox learns: a "finish creating your account" link, or an
--     "account exists" notice for an address that already has one.
--
--   * NO PASSWORD IS STORED HERE. The earlier pending_signups draft carried a
--     password_hash, which let whoever submitted the sign-up fix the password
--     the inbox owner would later "confirm". The password is now typed on the
--     finish page, by the person holding the link, in the same request that
--     creates the account (POST /api/auth/signup/complete). A stranger who
--     plants a sign-up for someone else's address gains nothing: the owner
--     either ignores the mail or sets their own password.
--
-- This branch has never been deployed with a pending_signups table (the earlier
-- 0050 draft was reverted before any deploy; 0050 is now warranty_claims
-- priority), so CREATE TABLE is safe here.
CREATE TABLE IF NOT EXISTS pending_signups (
  email         TEXT PRIMARY KEY,                 -- lowercased; one pending row per address
  token_hash    TEXT NOT NULL UNIQUE,             -- sha256 of the link token; rotated on every attempt
  username      TEXT,                             -- requested handle, claimed at completion only if still free
  name          TEXT NOT NULL DEFAULT '',
  country       TEXT,
  locale        TEXT NOT NULL DEFAULT 'en',
  referral_code TEXT NOT NULL DEFAULT '',
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Opportunistic cleanup deletes by expiry; the index keeps that a range scan.
CREATE INDEX IF NOT EXISTS idx_pending_signups_expires ON pending_signups(expires_at);
