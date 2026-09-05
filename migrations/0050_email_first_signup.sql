-- ---------------------------------------------------------------------------
-- 0050 — an email sign-up is not an account until the address is confirmed.
-- ---------------------------------------------------------------------------
-- The security audit found the one place that still said whether an address
-- has an account: POST /api/auth/register answered 409 EMAIL_TAKEN. Sign-in,
-- forgot-password and reset were all made uniform long ago; registration was
-- the weak link.
--
-- Closing it means an email sign-up creates NOTHING in `users` until the inbox
-- is proven. The attempt waits here instead. Because nothing lands in `users`,
-- there is no row for /username-available, /login, the admin list or the
-- referral count to observe — the only way to learn whether an address has an
-- account is to read that inbox. An adversarial review of a first attempt that
-- kept the pending account in `users` (with a flag) found the opposite: the
-- username was claimed only on the free path, which leaked the answer, and a
-- stranger's first attempt fixed the row's password so the inbox owner could
-- confirm an account they did not control. Holding the attempt OUTSIDE `users`
-- removes both.
--
--   one row per address (email is the key), so the latest attempt wins —
--   a re-signup overwrites the previous one and re-issues the link, and no
--   earlier attempt's password can survive to be confirmed by someone else.
--   The account, and its username, are created only by /verify-email/confirm.
--
-- Rewritten from an earlier draft of this same migration that added a
-- users.signup_verification_required column; that column is gone. This file
-- has never been applied to any live database (nothing on this branch is
-- deployed), so replacing its body is safe.
CREATE TABLE pending_signups (
  email         TEXT PRIMARY KEY,                 -- lowercased; one pending row per address
  token_hash    TEXT NOT NULL UNIQUE,             -- sha256 of the verification token; rotated on every attempt
  username      TEXT,                             -- requested handle, claimed at confirm only if still free
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  country       TEXT,
  locale        TEXT NOT NULL DEFAULT 'en',
  referral_code TEXT NOT NULL DEFAULT '',
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Opportunistic cleanup deletes by expiry; the index keeps that a range scan.
CREATE INDEX IF NOT EXISTS idx_pending_signups_expires ON pending_signups(expires_at);
