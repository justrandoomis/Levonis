-- ---------------------------------------------------------------------------
-- 0050 — an email sign-up is not an account until the address is confirmed.
-- ---------------------------------------------------------------------------
-- The security audit found the one place that still said whether an address
-- has an account: POST /api/auth/register answered 409 EMAIL_TAKEN. Sign-in,
-- forgot-password and reset were all made uniform long ago; registration was
-- the weak link.
--
-- Closing it means a sign-up with an address never opens a session and never
-- says "taken": the only way to learn whether an address has an account is to
-- read that inbox. But an unconfirmed account must then also REFUSE sign-in —
-- otherwise "register, then try to sign in with my own password" would answer
-- the question instead. This column marks the accounts created under that
-- rule, so every account that existed before it is untouched: they were never
-- asked to confirm before signing in and never will be.
--
--   signup_verification_required = 1 AND email_verified_at IS NULL
--     → sign-in refused (uniformly, like a wrong password) until the emailed
--       link, or a password reset, proves the address.
--
-- Additive only: defaults to 0 for every existing row.
ALTER TABLE users ADD COLUMN signup_verification_required INTEGER NOT NULL DEFAULT 0;

-- The sign-in check reads the row it already fetched, so no new lookup; the
-- index keeps "unfinished sign-ups" cheap to list for cleanup.
CREATE INDEX IF NOT EXISTS idx_users_pending_signup
  ON users(email) WHERE signup_verification_required = 1 AND email_verified_at IS NULL;
