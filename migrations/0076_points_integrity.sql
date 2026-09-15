-- Levonis migration 0076 — points & missions integrity, and the subscription
-- reward multiplier, recorded ON THE ROW.
--
-- STRICTLY ADDITIVE. Ten ADD COLUMNs, three indexes, one backfill of a column
-- this file itself creates, one guarded settings seed. Nothing is dropped,
-- nothing is recomputed, no existing value is rewritten, no row is deleted.
-- Re-running the set is a no-op (D1 bookkeeping runs a file once; every
-- statement that CAN run twice is written IF NOT EXISTS / WHERE NOT EXISTS,
-- and `node scripts/migrate-check.mjs --twice` proves it).
--
-- ============================== WHY ========================================
--
-- 1. reward_claims (0001) recorded only `points`. That number was decided by
--    the server, but NOTHING on the row said what the base was, which
--    multiplier produced it, which streak day it paid for, or at what server
--    instant. So:
--      - a support question ("why 8 and not 5?") had no answer in the data;
--      - the points history rendered from wallet_transactions.note, a free
--        text string, and its date came from the UTC ledger clock while the
--        award belongs to a Baghdad (UTC+3) day — the two disagree for every
--        award made between 21:00 and 24:00 UTC, which is exactly the window
--        the owner's screenshot straddles;
--      - the streak day was read from users.checkin_streak, a mutable cache,
--        instead of from the award history itself.
--    The columns below make the row self-describing, so the history can be
--    served from the awards themselves and be true by construction.
--
-- 2. Two of the missions ("Watch Ad", "Browse N minutes") paid on a bare POST.
--    `state`, `started_at` and `required_seconds` turn a claim into a
--    two-phase, server-timed transition: the row is created 'started' with a
--    server instant, and can only become 'awarded' after the server's own
--    clock says the required time has passed. The client never supplies a
--    time, a duration or an amount.
--
-- 3. `idempotency_key` is the codebase idiom (inventory_ledger.idempotency_key,
--    0018): ONE column, globally unique, carrying the business event. The
--    existing UNIQUE(user_id, mission, day) stays exactly as it is and remains
--    the primary guard; this key is the explicit, single-column form the rest
--    of the codebase uses, and it is what makes a replayed request collide
--    rather than pay twice.
--
-- 4. points_accruals (0014) froze the RATE an order earned at, so a settings
--    change could not re-price history. It did not freeze the subscription
--    MULTIPLIER, so a PRO whose membership lapsed during the seven-day hold
--    would have had history silently rewritten at release. `multiplier_x100`,
--    `base_points` and `tier_at_award` freeze it at the purchase instant, in
--    the same transaction that creates the accrual.

-- ---------------------------------------------------------- reward_claims

-- 'started' (a server-timed task in progress, NOT yet paid) | 'awarded'.
-- DEFAULT 'awarded' is correct for every existing row: they are all paid
-- awards, and they keep their points and their ledger entries untouched.
ALTER TABLE reward_claims ADD COLUMN state TEXT NOT NULL DEFAULT 'awarded';

-- What the server decided before the subscription multiplier, and the
-- multiplier it then applied. NULL/100 on historical rows is the truth about
-- them: no multiplier was recorded when they were written, and inventing one
-- now would be a fabrication.
ALTER TABLE reward_claims ADD COLUMN base_points INTEGER;
ALTER TABLE reward_claims ADD COLUMN multiplier_x100 INTEGER NOT NULL DEFAULT 100;
ALTER TABLE reward_claims ADD COLUMN tier_at_award TEXT NOT NULL DEFAULT '';

-- The consecutive-day counter this check-in paid for, taken from the award
-- history rather than from the users.checkin_streak cache.
ALTER TABLE reward_claims ADD COLUMN streak_day INTEGER;

-- Two-phase, server-timed tasks. started_at is a SERVER ISO instant; the
-- client cannot send one and none is ever read from a request.
ALTER TABLE reward_claims ADD COLUMN started_at TEXT;
ALTER TABLE reward_claims ADD COLUMN required_seconds INTEGER NOT NULL DEFAULT 0;

-- The server instant the award was actually made (UTC ISO), next to `day`
-- which is the Baghdad calendar day it belongs to. Both, so the history can
-- show the day it credited AND when it happened without the two contradicting
-- each other.
ALTER TABLE reward_claims ADD COLUMN awarded_at TEXT;

-- The POINT ledger row this claim wrote. One claim, one credit.
ALTER TABLE reward_claims ADD COLUMN wallet_tx_id TEXT;

-- The inventory_ledger idiom: 'reward:<user>:<mission>:<period>'.
ALTER TABLE reward_claims ADD COLUMN idempotency_key TEXT;

-- Fills the new column for rows that already exist, from the row's own
-- identity. It cannot collide: (user_id, mission, day) is already UNIQUE, so
-- the derived key is unique too. Data-preserving — it writes only the column
-- this file just added, and only where it is still NULL.
UPDATE reward_claims
   SET idempotency_key = 'reward:' || user_id || ':' || mission || ':' || day
 WHERE idempotency_key IS NULL;

-- The unique business event. Partial so that a row which somehow has no key
-- is not forced into a collision with another keyless row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_claims_idem
  ON reward_claims(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The points history read model: one user's awards, newest first.
CREATE INDEX IF NOT EXISTS idx_reward_claims_user_day
  ON reward_claims(user_id, day DESC, mission);

-- --------------------------------------------------------- points_accruals

-- The purchase points BEFORE the subscription multiplier, the multiplier that
-- was applied, and the tier it came from — all resolved inside the checkout
-- transaction and frozen there. DEFAULT 100 is the truth for every existing
-- row: they were earned before multipliers existed, at 1x. Nothing is
-- re-priced; `points` on existing rows is not touched by this file.
ALTER TABLE points_accruals ADD COLUMN base_points INTEGER;
ALTER TABLE points_accruals ADD COLUMN multiplier_x100 INTEGER NOT NULL DEFAULT 100;
ALTER TABLE points_accruals ADD COLUMN tier_at_award TEXT NOT NULL DEFAULT '';

-- ------------------------------------------------------------------ settings
--
-- rewardTaskConfig — the owner's control over the tasks whose completion the
-- SERVER CANNOT PROVE.
--
--   video_enabled        "Watch Ad" pays at all.
--   video_min_seconds    server wall-clock seconds that must pass between the
--                        server issuing the ad ticket and the claim. It bounds
--                        an automated claim; it does NOT prove a human watched.
--   browse_enabled       "Browse Products N minutes" pays at all.
--   push_enabled         "Enable Notifications" pays at all. This one is
--                        once-per-account-forever, so its total exposure is
--                        one award per account; it is still unprovable,
--                        because this database has no push-subscription table
--                        against which the server could check the claim.
--
-- SEEDED ENABLED, i.e. exactly the behaviour the shop has today: this
-- migration changes what those tasks REQUIRE, not whether they exist, and
-- turning off a live earning path is the owner's commercial decision, not a
-- migration's. The switches are here so that decision needs no deploy.
--
-- There is no admin UI for this key yet: worker/lib/settings.ts SETTING_KEYS
-- is owned by another slice and PUT /api/admin/settings/:key rejects a key
-- that is not in it. Until that one line lands, the owner changes it with:
--
--   wrangler d1 execute levonis-db --remote --command \
--     "UPDATE admin_settings SET value='{\"video_enabled\":false,\"video_min_seconds\":15,\"browse_enabled\":true,\"push_enabled\":true}' WHERE key='rewardTaskConfig'"
--
-- Guarded with WHERE NOT EXISTS, so an owner who has already set it is never
-- overwritten and a re-run inserts nothing.
INSERT INTO admin_settings (key, value)
SELECT 'rewardTaskConfig',
       '{"video_enabled":true,"video_min_seconds":15,"browse_enabled":true,"push_enabled":true}'
 WHERE NOT EXISTS (SELECT 1 FROM admin_settings WHERE key = 'rewardTaskConfig');
