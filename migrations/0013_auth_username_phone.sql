-- Levonis migration 0013 — auth: phone identity on users + username referral
-- handles (integrated mandate §2.3 / §3.1). NONDESTRUCTIVE: ADD COLUMN,
-- guarded backfill UPDATE and CREATE INDEX only.
--
-- users.phone_e164 is the account's OWN phone identity, stored in normalized
-- E.164 exactly as produced by worker/lib/phone.ts normalizePhone (never a
-- raw or length-only-validated string). NULL = the account has no phone.
-- Ownership is only ever proven through the Telegram contact-verification
-- machinery (link_challenges → verified contact → OTP) BEFORE any code path
-- writes this column — a phone typed into a form is never stored here.
--
-- Honest schema note (mandate §2.3: "a phone account is not a fabricated
-- email address"): users.email has been NOT NULL UNIQUE since 0001, and
-- SQLite cannot drop a NOT NULL in place — making email nullable would
-- require a full users-table rebuild touching every table that references
-- users(id), which is not a nondestructive migration. So email stays NOT
-- NULL and phone-only accounts keep the ALREADY-DOCUMENTED non-routable
-- placeholder `tg-<user id>@telegram.local` (decision register row 27):
-- the API reports it via `email_placeholder: true`, refuses to "verify" it
-- (NO_REAL_EMAIL) and never emails it. The phone itself lives ONLY in
-- phone_e164 — the placeholder is never derived from the phone number.
--
-- No username schema change is needed for §3.1: users.username is already
-- UNIQUE (implicit index) and referral attribution stores the referrer's
-- stable user id (referral_attributions.referrer_id), so a username change
-- can never transfer past referrals; only NEW signups resolve a ?ref=
-- username to its CURRENT holder at signup time.

ALTER TABLE users ADD COLUMN phone_e164 TEXT;

-- Backfill from live verified Telegram links — but ONLY unambiguous phones
-- (exactly one live link holds that phone), so the UNIQUE index below can
-- never fail on legacy data. telegram_links.user_id is the PRIMARY KEY, so
-- the per-user subquery is scalar. Ambiguous or revoked links are left
-- NULL: those accounts keep working through their other identifiers and
-- self-heal on the next verified Telegram login.
UPDATE users
   SET phone_e164 = (SELECT tl.phone_e164
                       FROM telegram_links tl
                      WHERE tl.user_id = users.id AND tl.revoked_at IS NULL)
 WHERE phone_e164 IS NULL
   AND EXISTS (SELECT 1 FROM telegram_links tl
                WHERE tl.user_id = users.id AND tl.revoked_at IS NULL)
   AND (SELECT COUNT(*)
          FROM telegram_links dup
         WHERE dup.revoked_at IS NULL
           AND dup.phone_e164 = (SELECT tl.phone_e164
                                   FROM telegram_links tl
                                  WHERE tl.user_id = users.id
                                    AND tl.revoked_at IS NULL)) = 1;

-- One account per phone identity (§2.3: no duplicate accounts for a
-- formatting variant — everything is normalized to E.164 first; no silent
-- merging either, the UNIQUE constraint turns collisions into honest
-- conflicts). Partial index: multiple phone-less (NULL) accounts stay fine.
CREATE UNIQUE INDEX idx_users_phone_e164 ON users(phone_e164) WHERE phone_e164 IS NOT NULL;

-- Signup referral carried through the EXTERNAL Telegram round-trip (§3.2:
-- "pass the signup referral through external flows with server-side
-- verification, never trusting an arbitrary referrer_user_id"). The browser
-- hands over a ref (username or legacy code) when the challenge is created;
-- the server RESOLVES it there and stores only the resulting stable user id
-- here, so the value can never be forged from the client and cannot be
-- re-pointed later. Persistence is expiry-bounded by the challenge itself
-- (link_challenges.expires_at, minutes) — no long-lived tracking state — and
-- it is read exactly once, at account creation. NULL = no referral captured.
-- ON DELETE SET NULL so a deleted referrer never blocks challenge cleanup.
ALTER TABLE link_challenges ADD COLUMN signup_referrer_id TEXT REFERENCES users(id) ON DELETE SET NULL;
