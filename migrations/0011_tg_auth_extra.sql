-- Levonis migration 0011 — Telegram-first registration & sign-in (§4).
--
-- 1. link_challenges is REBUILT (SQLite cannot alter a CHECK constraint) to
--    allow purpose='login' next to the existing purposes, and to add:
--      continuation_hash — SHA-256 digest of the anonymous browser
--        continuation token (the raw token lives only in the customer's
--        browser; signup/login challenges are bound to it instead of an
--        authenticated session_ref).
--      otp_sent_at — one-shot OTP dispatch guard: the OTP for a verified
--        auth challenge is sent at most once by the guarded claim
--        (conditional UPDATE ... WHERE otp_sent_at IS NULL); resends move
--        the timestamp forward.
--    Rows are copied verbatim — in-flight link/recovery/phone_change
--    challenges keep working. NONDESTRUCTIVE for all persisted data.
--
-- 2. otp_challenges gains challenge_id so an OTP can be bound to an
--    anonymous auth challenge before any users row exists (signup) —
--    user_id was already nullable in 0003.

PRAGMA defer_foreign_keys = true;

CREATE TABLE link_challenges_v2 (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup','login','link','recovery','phone_change')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,   -- NULL for signup/login
  session_ref TEXT NOT NULL DEFAULT '',
  phone_entered TEXT NOT NULL,          -- normalized E.164 entered on the site
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','contact_received','phone_verified','browser_confirmed','linked','expired','revoked')),
  telegram_user_id INTEGER,
  chat_id INTEGER,
  continuation_hash TEXT,               -- SHA-256 of the anonymous browser continuation token
  otp_sent_at TEXT,                     -- one-shot OTP dispatch guard / resend cooldown anchor
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

INSERT INTO link_challenges_v2
  (id, purpose, user_id, session_ref, phone_entered, state, telegram_user_id, chat_id, created_at, expires_at, consumed_at)
  SELECT id, purpose, user_id, session_ref, phone_entered, state, telegram_user_id, chat_id, created_at, expires_at, consumed_at
    FROM link_challenges;

DROP TABLE link_challenges;
ALTER TABLE link_challenges_v2 RENAME TO link_challenges;

CREATE INDEX idx_link_challenges_user ON link_challenges(user_id, state);
CREATE UNIQUE INDEX idx_link_challenges_continuation
  ON link_challenges(continuation_hash) WHERE continuation_hash IS NOT NULL;

-- Challenge-bound OTPs for anonymous signup/login (the user row may not
-- exist yet at send time).
ALTER TABLE otp_challenges ADD COLUMN challenge_id TEXT;
CREATE INDEX idx_otp_challenge ON otp_challenges(challenge_id, purpose);
