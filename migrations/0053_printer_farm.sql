-- ---------------------------------------------------------------------------
-- 0053 — LEVO Printer Farm, Phase 1: the tables of a server-authoritative
--        3D-printing business simulator (docs/PRINTER_FARM.md §2).
-- ---------------------------------------------------------------------------
-- TWO CURRENCIES, ONE WALL. Farm Coins are an IN-GAME currency and live only
-- in `farm_ledger`. They are not money and they are not Levonis Points:
-- Levonis Points remain `wallet_transactions` rows with currency='POINT',
-- minted only through the existing points functions, and NOTHING in this
-- migration or in Phase 1 code touches that table. `ticket_ledger` and
-- `game_sessions` (migration 0003) stay exactly as they are — unused — because
-- tickets are blocked by DECISIONS row 25 (legality of competitions/draws).
--
-- BALANCE IS DERIVED. There is no coin column anywhere: a player's balance is
-- always SUM(farm_ledger.amount). A BEFORE INSERT trigger refuses any debit
-- that would take that sum below zero with a stable message
-- ('FARM_INSUFFICIENT_COINS'), so an overdraft aborts the whole D1 batch it
-- travels in — the printer purchase, the maintenance order, whatever it was —
-- and two concurrent debits cannot both pass. Every coin movement is one row
-- with an idempotency key UNIQUE per user, so a replayed request is a no-op.
--
-- INVARIANTS THE DATABASE HOLDS, not the route:
--   * a printer holds at most one `printing` assignment (partial UNIQUE);
--   * a player holds at most one printer per room slot (UNIQUE user_id, slot);
--   * a spool cannot go negative (CHECK grams_left >= 0) — grams are RESERVED
--     at assignment, so the check is what refuses an overdraw;
--   * the live assignments of a job never exceed its quantity (trigger
--     'FARM_QTY_EXCEEDED'), so two concurrent assigns cannot double-book parts.
--
-- TIME. Every timestamp is an ISO string written by the Worker's clock; no
-- client timestamp is ever stored. `farm_daily.day` is the platform's day —
-- Asia/Baghdad (UTC+3), the same boundary rewards.ts uses — not UTC.
--
-- SEEDS NO ROWS. Defaults live in code (worker/lib/farm/config.ts) and are
-- normalised on every read; the starter kit is written the first time a player
-- opens the game. Only idempotent statements: CREATE ... IF NOT EXISTS.
-- Additive: new tables, indexes and triggers; nothing existing is touched.

-- One row per player. NO coin column (see header).
CREATE TABLE IF NOT EXISTS farm_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  farm_name TEXT NOT NULL DEFAULT '',
  -- NAMED so the route can recognise it: every farm write batch opens with a
  -- compare-and-swap on last_resolved_at that sets level to 0 when the row
  -- moved under the request (CASE ... ELSE 0), and this CHECK is what aborts
  -- the stale batch with a stable message.
  level INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_farm_profiles_level CHECK (level >= 1),
  xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  -- reputation in basis points: 0..5000 = 0.00..5.00 stars
  reputation_bp INTEGER NOT NULL DEFAULT 0 CHECK (reputation_bp >= 0 AND reputation_bp <= 5000),
  location_key TEXT NOT NULL DEFAULT 'tiny_room',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','recovery')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_resolved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- when offers were last generated, and how many refreshes happened; the
  -- refresh index seeds the deterministic offer generator
  last_offer_at TEXT,
  offer_refresh_index INTEGER NOT NULL DEFAULT 0,
  config_version INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL DEFAULT '{}',
  tutorial_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Append-only Farm Coin ledger. The balance is SUM(amount); never stored.
CREATE TABLE IF NOT EXISTS farm_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'starter','job_payout','filament_purchase','printer_purchase','printer_sale',
    'maintenance','repair','electricity','penalty','refund','admin_grant','admin_adjust'
  )),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_farm_ledger_user_created ON farm_ledger(user_id, created_at DESC);

-- The overdraft wall. RAISE(ABORT) carries a stable message the route maps to
-- 400 INSUFFICIENT_COINS; because a D1 batch is one transaction, every other
-- statement in that batch rolls back with it.
CREATE TRIGGER IF NOT EXISTS trg_farm_ledger_no_overdraft
BEFORE INSERT ON farm_ledger
BEGIN
  SELECT RAISE(ABORT, 'FARM_INSUFFICIENT_COINS')
   WHERE NEW.amount < 0
     AND (SELECT COALESCE(SUM(amount), 0) FROM farm_ledger WHERE user_id = NEW.user_id) + NEW.amount < 0;
END;

-- Owned machines. health 0..100; hours = operating hours x 100 (integer).
CREATE TABLE IF NOT EXISTS farm_printers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_key TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  nickname TEXT NOT NULL DEFAULT '',
  health REAL NOT NULL DEFAULT 100 CHECK (health >= 0 AND health <= 100),
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','printing','done','maintenance','broken')),
  -- server time when maintenance/repair finishes; NULL otherwise
  state_until TEXT,
  hours INTEGER NOT NULL DEFAULT 0 CHECK (hours >= 0),
  prints INTEGER NOT NULL DEFAULT 0 CHECK (prints >= 0),
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  upgrades_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (state NOT IN ('maintenance') OR state_until IS NOT NULL),
  UNIQUE (user_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_farm_printers_user_state ON farm_printers(user_id, state);

-- Filament inventory. grams_left can never be negative: reservation at
-- assignment is what refuses an overdraw.
CREATE TABLE IF NOT EXISTS farm_spools (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  material TEXT NOT NULL,
  color TEXT NOT NULL,
  grams_left INTEGER NOT NULL CHECK (grams_left >= 0),
  grams_total INTEGER NOT NULL CHECK (grams_total > 0),
  -- 0..1; the starter spool is 1.0, market spools carry the material's quality
  quality REAL NOT NULL DEFAULT 1 CHECK (quality >= 0 AND quality <= 1),
  cost_paid INTEGER NOT NULL DEFAULT 0 CHECK (cost_paid >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_farm_spools_user ON farm_spools(user_id, material);

-- Customer jobs. Every reward, penalty and deadline is SNAPSHOT at offer time
-- from the config of that moment, so a later balancing change never rewrites
-- a job a player already holds.
CREATE TABLE IF NOT EXISTS farm_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'offered' CHECK (state IN (
    'offered','accepted','printing','ready','delivered','late','cancelled','rejected','expired'
  )),
  customer_tier TEXT NOT NULL,
  -- JSON {ar,en,ckb} — a fictional customer from the tier's name list
  customer_name TEXT NOT NULL DEFAULT '{}',
  product_key TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  material TEXT NOT NULL,
  colors_json TEXT NOT NULL DEFAULT '[]',
  grams INTEGER NOT NULL CHECK (grams > 0),
  -- reference machine, standard quality, GAME seconds
  print_seconds INTEGER NOT NULL CHECK (print_seconds > 0),
  quality TEXT NOT NULL DEFAULT 'standard' CHECK (quality IN ('draft','standard','fine','ultra')),
  reward_coins INTEGER NOT NULL CHECK (reward_coins >= 0),
  reputation_gain_bp INTEGER NOT NULL DEFAULT 0,
  late_penalty_bp INTEGER NOT NULL DEFAULT 0,
  cancel_penalty_coins INTEGER NOT NULL DEFAULT 0,
  cancel_penalty_bp INTEGER NOT NULL DEFAULT 0,
  offered_at TEXT NOT NULL,
  offer_expires_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  accepted_at TEXT,
  delivered_at TEXT,
  seed TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (state <> 'delivered' OR delivered_at IS NOT NULL),
  CHECK (state NOT IN ('accepted','printing','ready','late','delivered') OR accepted_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_farm_jobs_user_state ON farm_jobs(user_id, state);

-- One row per printer per job batch. The failure probability is stored at
-- start so a config change cannot alter an in-flight print; the outcome seed
-- decides it deterministically when the print ends.
CREATE TABLE IF NOT EXISTS farm_assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES farm_jobs(id) ON DELETE CASCADE,
  printer_id TEXT NOT NULL REFERENCES farm_printers(id) ON DELETE CASCADE,
  spool_id TEXT NOT NULL REFERENCES farm_spools(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  grams INTEGER NOT NULL CHECK (grams > 0),
  -- GAME seconds this batch takes on THIS printer at the chosen quality
  seconds INTEGER NOT NULL CHECK (seconds > 0),
  quality TEXT NOT NULL DEFAULT 'standard' CHECK (quality IN ('draft','standard','fine','ultra')),
  position INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','printing','done','failed','collected','cancelled')),
  started_at TEXT,
  ends_at TEXT,
  failure_p REAL NOT NULL DEFAULT 0 CHECK (failure_p >= 0 AND failure_p <= 1),
  failure_kind TEXT,
  outcome_seed TEXT NOT NULL DEFAULT '',
  -- when the player cleared this batch off the printer; a done batch becomes
  -- 'collected', a failed one keeps 'failed' (its parts are free to re-assign)
  collected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (state NOT IN ('printing','done','failed','collected') OR (started_at IS NOT NULL AND ends_at IS NOT NULL)),
  CHECK (state <> 'failed' OR failure_kind IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_farm_assignments_printer_position ON farm_assignments(printer_id, position);
CREATE INDEX IF NOT EXISTS idx_farm_assignments_job ON farm_assignments(job_id, state);
-- A printer prints one batch at a time — enforced where a race cannot get past it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_farm_assignments_one_printing
  ON farm_assignments(printer_id) WHERE state = 'printing';

-- Parts cannot be booked twice: the live assignments of a job (queued,
-- printing, done, collected — a failed or cancelled batch frees its parts)
-- never exceed the job's quantity.
CREATE TRIGGER IF NOT EXISTS trg_farm_assignments_qty
BEFORE INSERT ON farm_assignments
BEGIN
  SELECT RAISE(ABORT, 'FARM_QTY_EXCEEDED')
   WHERE (SELECT COALESCE(SUM(a.qty), 0) FROM farm_assignments a
           WHERE a.job_id = NEW.job_id AND a.state IN ('queued','printing','done','collected'))
         + NEW.qty
         > (SELECT j.qty FROM farm_jobs j WHERE j.id = NEW.job_id);
END;

-- What happened while the player was away or on resolve; seen_at drives the
-- "While you were away" sheet.
CREATE TABLE IF NOT EXISTS farm_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'print_done','print_failed','printer_broken','job_ready','job_late','job_cancelled_by_customer',
    'offer_expired','maintenance_done','repair_done','level_up'
  )),
  payload_json TEXT NOT NULL DEFAULT '{}',
  seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_farm_events_user_created ON farm_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_farm_events_user_unseen ON farm_events(user_id) WHERE seen_at IS NULL;

-- Per player per Baghdad day (UTC+3, YYYY-MM-DD) counters for limits.
CREATE TABLE IF NOT EXISTS farm_daily (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  coins_earned INTEGER NOT NULL DEFAULT 0 CHECK (coins_earned >= 0),
  jobs_delivered INTEGER NOT NULL DEFAULT 0 CHECK (jobs_delivered >= 0),
  -- Phase 5; always 0 in Phase 1 — no code path converts coins to points
  points_converted INTEGER NOT NULL DEFAULT 0 CHECK (points_converted >= 0),
  PRIMARY KEY (user_id, day)
);

-- Phase 5 fills it; the table exists so Phase 1 statistics land somewhere.
CREATE TABLE IF NOT EXISTS farm_achievements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  unlocked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reward_json TEXT NOT NULL DEFAULT '{}',
  claimed_at TEXT,
  UNIQUE (user_id, key)
);
