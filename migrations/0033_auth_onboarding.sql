-- Levonis migration 0033 — account onboarding, profile completion and the
-- country a person is actually in. NONDESTRUCTIVE: ADD COLUMN and CREATE
-- INDEX only; no rewrite, no backfill that could lose a value.
--
-- WHY THESE COLUMNS EXIST
--
-- `country` — the platform had no idea where anyone was. Locale is not a
-- country (an Arabic-speaking customer in Sweden is not in Iraq) and a phone
-- number is not one either: calling codes are shared, so `countryOfPhone` is
-- explicitly best-effort and for display only. This column is what the person
-- told us, stored as ISO 3166-1 alpha-2, NULL when they have not said.
--
-- `onboarding_state` — whether the multi-step account setup was finished,
-- skipped, or never reached. It is NOT a synonym for "profile complete": a
-- person can finish onboarding having skipped every optional step, and a
-- person who never saw onboarding can complete their profile later from the
-- account page. Two different questions, two different columns.
--
-- `profile_prompt_at` / `profile_prompt_count` — the reminder schedule for
-- the completion prompt, stored SERVER-SIDE on purpose. A dismissal kept in
-- localStorage is per-device and per-browser: the same person is nagged again
-- on their phone, and again after clearing site data. `profile_prompt_at` is
-- the earliest moment the prompt may appear again; the count exists so the
-- interval can widen instead of repeating forever.
--
-- WHAT IS DELIBERATELY NOT HERE: a `profile_complete` boolean. Completion is
-- derived from the fields themselves (worker/lib/profileCompletion.ts), so it
-- can never disagree with them — a stored flag goes stale the first time a
-- field is edited by a path that forgets to update it.

ALTER TABLE users ADD COLUMN country TEXT;
ALTER TABLE users ADD COLUMN onboarding_state TEXT NOT NULL DEFAULT 'new';
ALTER TABLE users ADD COLUMN profile_prompt_at TEXT;
ALTER TABLE users ADD COLUMN profile_prompt_count INTEGER NOT NULL DEFAULT 0;

-- Existing accounts have already been using the platform; they are not "new"
-- and must not be dropped into a signup wizard on their next visit. They see
-- the completion prompt instead, which is the honest thing to show someone
-- who already has an account.
UPDATE users SET onboarding_state = 'existing' WHERE onboarding_state = 'new';

-- Username lookups happen on every availability check while somebody types.
-- users.username is already UNIQUE (so the constraint that prevents two
-- accounts sharing a name is unchanged); this index is only about the read.
CREATE INDEX IF NOT EXISTS idx_users_username_lookup ON users(username) WHERE username IS NOT NULL;
