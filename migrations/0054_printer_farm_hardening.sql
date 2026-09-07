-- ---------------------------------------------------------------------------
-- 0054 — LEVO Printer Farm hardening: what the adversarial review of Phase 1
--        found (docs/PRINTER_FARM.md §7 and §9, DECISIONS.md row 97).
-- ---------------------------------------------------------------------------
-- 1. REVISION FENCE (farm_profiles.revision). The Phase 1 compare-and-swap
--    keyed on `last_resolved_at` did not fence a mutation after its OWN
--    resolver batch wrote the token: a second request that loaded the farm
--    between the first's resolver and intent batches carried the same token,
--    both intent batches passed the CAS, and whatever the intent wrote without
--    a database guard landed twice (a resale credited twice, a queued batch's
--    grams refunded twice, one service debited twice). Every write batch now
--    opens with
--        UPDATE farm_profiles SET revision = CASE WHEN revision = ?expected
--                                             THEN revision + 1 ELSE -1 END
--    and `ck_farm_profiles_revision` (revision >= 0) aborts the whole batch
--    when the row moved under the request — nothing else in it lands. The
--    request re-reads and either replays (farm_requests below) or re-plans.
--
-- 2. SOLD PRINTERS ARE NEVER DELETED (farm_printers.sold_at). farm_assignments
--    references farm_printers ON DELETE CASCADE, so selling a machine erased
--    its batch history — a half-delivered job forgot the parts already made
--    and never paid. A sale now writes `sold_at` and PARKS the slot:
--        slot := slot + 1000000 × (1 + sold rows already parked from that slot)
--    so `CHECK (slot >= 0)` and `UNIQUE (user_id, slot)` from 0053 both hold,
--    the freed room slot (0 … max_printers-1) accepts a new purchase, and the
--    original slot is recoverable as `slot % 1000000`. Rows with `sold_at IS
--    NOT NULL` are excluded from the player's state, the slot count, the
--    leaderboard's farm value and every projection; their assignments stay.
--
-- 3. DEFERRED PAYOUT (farm_jobs.payout_deferred_day). A daily-cap 429 on
--    collect used to leave the finished batch on the bed and the printer
--    blocked. Collect now always clears the bed; when the day's jobs or coins
--    cap would be exceeded the job keeps `ready`/`late`, records the Baghdad
--    day it was held on and `delivered_at` (the moment the work was handed
--    over — lateness is judged on it), and the resolver pays it on the first
--    read of a later day, under that day's caps, with the same deterministic
--    ledger id `fl_payout_<jobId>`.
--
-- 4. REQUEST REPLAY MEMORY (farm_requests). Replay detection lived only in
--    the ledger, so a retried accept/reject/queue/rename answered 409 and its
--    key was free for a different route. Every intent batch now also inserts
--    its (user, key, route, result) row; a request whose key is already there
--    replays the stored result for the same route and is refused with 409
--    IDEMPOTENCY_KEY_REUSED for a different one. UNIQUE (user_id,
--    idempotency_key) makes a double-tap that slips past the read collide.
--
-- 5. SERVER-HELD RANDOMNESS (farm_profiles.offer_salt). Offer generation was
--    seeded from (user id, refresh index) — both known to the player — and a
--    print's outcome seed from the assignment id, itself derived from the
--    client's idempotency key: the client could search keys offline for a
--    roll that never fails. Outcome seeds are now 32 random bytes written at
--    insert (the deterministic assignment id remains the replay memory), and
--    offers are seeded from sha256(offer_salt : refresh index) where
--    `offer_salt` is a per-player secret created at bootstrap (backfilled on
--    first read for profiles that predate this migration) and never returned
--    by any route or projection.
--
-- LEDGER KEY NAMESPACES (no schema change — documented here because the
-- UNIQUE (user_id, idempotency_key) index of 0053 is what makes it matter):
-- client keys are stored as `req:<key>`, resolver/business rows as
-- `sys:<ledger id>`, so a player cannot burn a resolver key and wedge the
-- farm's clock. Client keys containing ':' or starting with 'fl_' / 'sys:'
-- are refused at the route.
--
-- Additive: ALTER TABLE … ADD COLUMN with defaults (D1's bookkeeping runs
-- them once), one new table and index with IF NOT EXISTS. No row is touched.

ALTER TABLE farm_profiles ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
  CONSTRAINT ck_farm_profiles_revision CHECK (revision >= 0);

-- Per-player secret seeding offer generation. '' = not yet issued (profiles
-- created before this migration); the first read after deploy writes one.
ALTER TABLE farm_profiles ADD COLUMN offer_salt TEXT NOT NULL DEFAULT '';

-- When the machine was sold; NULL while owned. Sold rows keep their history
-- and park their slot at slot + 1000000 × n (see header).
ALTER TABLE farm_printers ADD COLUMN sold_at TEXT;

-- The Baghdad day a finished job's payout was held on because of the daily
-- cap; NULL otherwise. The resolver pays it on a later day.
ALTER TABLE farm_jobs ADD COLUMN payout_deferred_day TEXT;

-- Replay memory for every player intent, ledger-writing or not.
CREATE TABLE IF NOT EXISTS farm_requests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  -- "<METHOD> <path>", so the same key on a different job/printer/route is a
  -- reuse, not a replay
  route TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_farm_requests_user_created ON farm_requests(user_id, created_at);

-- Live machines are what every read wants; sold rows fall out of the index.
CREATE INDEX IF NOT EXISTS idx_farm_printers_user_live ON farm_printers(user_id, slot) WHERE sold_at IS NULL;
