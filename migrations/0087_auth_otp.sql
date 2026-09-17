-- Levonis migration 0087 — passwordless sign-in codes for EMAIL and WHATSAPP.
-- NONDESTRUCTIVE: one new table and its indexes. Nothing existing is touched.
--
-- WHY A SECOND TABLE INSTEAD OF WIDENING otp_challenges.
--
-- otp_challenges (0003, 0011) is the TELEGRAM machinery, and its shape says
-- so: `chat_id INTEGER NOT NULL` is a Telegram chat, and the purpose CHECK
-- names Telegram's four actions. Widening it would mean relaxing that NOT
-- NULL — a full table rebuild of a live security table whose rows authorise
-- sign-in — and would leave every Telegram query having to remember to filter
-- by channel. A forgotten filter there is an account takeover across
-- channels: a code mailed for one identity consumed as proof of another.
--
-- Two tables keep the blast radius of each channel inside itself. The COST is
-- that the OTP rules (TTL, attempts, supersede-on-resend, atomic consume) now
-- live in two places — which is why worker/lib/authOtp.ts exists and is
-- written to mirror worker/lib/telegram.ts's semantics exactly rather than
-- inventing new ones.
--
-- WHAT A ROW IS. "Somebody asked us to prove control of <destination> over
-- <channel>." The code itself is NEVER stored: `verifier` is
-- SHA-256("<row id>:<code>"), salted by the row id so two challenges that
-- happen to draw the same six digits never share a digest.
--
-- user_id IS NULLABLE AND IS NOT THE PERMISSION. A start request for an
-- address with no account still writes a row (with user_id NULL and no send)
-- so the endpoint's timing and response cannot distinguish "account exists"
-- from "it does not" — the same anti-enumeration rule /forgot-password
-- already follows. The account is resolved AGAIN at verify time from the
-- destination, so a row can never authorise an account it was not issued for.

CREATE TABLE IF NOT EXISTS auth_otp (
  id TEXT PRIMARY KEY,
  -- The transport. Adding one (sms, …) is a CHECK change, deliberately, so a
  -- typo cannot silently create a fourth channel nobody delivers.
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  -- NORMALIZED, always: a lowercased email address, or E.164 (+964…) exactly
  -- as worker/lib/phone.ts normalizePhone produces it. Rate limits and the
  -- resend cooldown are keyed on this string, so an unnormalized value would
  -- be a free extra bucket for whoever spells the address differently.
  destination TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signin')),
  -- The account this code would sign in, resolved at START time for auditing.
  -- NULL means no account matched (decoy row, nothing was sent).
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  verifier TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  -- Resend chain: issuing a new code invalidates every older live one for the
  -- same (channel, destination, purpose), so an intercepted earlier code dies.
  superseded_by TEXT,
  -- Recorded only so the operator can see WHERE a code went in an incident,
  -- never used to decide anything. NULL for a decoy row.
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

-- IF NOT EXISTS throughout: applying the migration set twice must be a no-op
-- rather than an error (the rule migration 0083 was corrected for, and what
-- scripts/migrate-check.mjs --twice proves on every run).

-- The one hot query: "the newest live challenge for this destination on this
-- channel". Ordering by created_at is part of the index so the lookup on a
-- verify never scans a destination's history.
CREATE INDEX IF NOT EXISTS idx_auth_otp_live ON auth_otp(channel, destination, purpose, created_at);
-- The sweeper's index (jobs.ts prunes expired rows), matching
-- idx_otp_challenges_expires on the Telegram table.
CREATE INDEX IF NOT EXISTS idx_auth_otp_expires ON auth_otp(expires_at);
