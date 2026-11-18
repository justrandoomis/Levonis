-- PRINTER SERVICES, PHASE 5b — THE MONTHLY LEVO CARE DRAW (owner request 2026-11-18/19; DECISIONS row 359).
--
-- «monthly competitions of free filaments to random customer who have active levo care is included with levo care»,
-- and, asked how: «Random, I confirm each month» and «I set the prize each month».
--
-- care_draws: ONE row per Baghdad month ('YYYY-MM', the month the draw is FOR — the month that just started).
-- UNIQUE(month) is what makes the monthly job idempotent and a second prize for one month impossible.
--
--   state            'proposed'  the system picked a name; nothing is granted and the customer is told nothing
--                    'confirmed' the owner confirmed: the gift (gift_id) was granted in the same batch
--                    'skipped'   no eligible holder that month, or the owner skipped it (skip_reason)
--                    'void'      reserved (no writer yet): a confirmed draw the owner later annuls
--   candidates       how many customers were eligible when the name was picked (one ticket per customer)
--   candidate_hash   sha-256 of the sorted candidate user ids, one per line — the audit of WHO was in the draw.
--                    The list of names is never stored.
--   seed             32 crypto-random bytes, hex. The winner is a pure function of (seed, sorted candidates):
--                    worker/lib/careDraw.ts `pickIndex`, so a draw can be re-computed and checked afterwards.
--   winner_user_id   the proposed (then confirmed) winner; winner_unit_id the Care device that made him eligible
--   redraws          how many times the owner drew another name; passed_user_ids the ids drawn before and passed
--                    over this month (JSON list of user ids — they cannot be drawn again for this month)
--   prize_*          the product and quantity the owner chose when he confirmed, and his optional note
--   gift_id          the gift entitlement the confirmation granted (gift_entitlements.id)
--
-- Additive; no foreign keys. Every reader tolerates its absence (worker/lib/careDraw.ts). Re-runnable: every
-- CREATE says IF NOT EXISTS. Comments use `--` only.
CREATE TABLE IF NOT EXISTS care_draws (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','confirmed','skipped','void')),
  candidates INTEGER NOT NULL DEFAULT 0 CHECK (candidates >= 0),
  candidate_hash TEXT NOT NULL DEFAULT '',
  seed TEXT NOT NULL DEFAULT '',
  winner_user_id TEXT,
  winner_unit_id TEXT,
  redraws INTEGER NOT NULL DEFAULT 0 CHECK (redraws >= 0),
  passed_user_ids TEXT NOT NULL DEFAULT '[]',
  prize_product_id TEXT,
  prize_qty INTEGER CHECK (prize_qty IS NULL OR (prize_qty >= 1 AND prize_qty <= 10)),
  prize_note TEXT NOT NULL DEFAULT '',
  gift_id TEXT,
  proposed_at TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  skip_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- A confirmed draw always names its winner, its prize and its gift; a proposed one always names its winner.
  CHECK (state <> 'confirmed' OR (winner_user_id IS NOT NULL AND gift_id IS NOT NULL AND prize_product_id IS NOT NULL AND prize_qty IS NOT NULL)),
  CHECK (state <> 'proposed' OR winner_user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_care_draws_winner ON care_draws(winner_user_id, state);
-- One gift is the prize of at most one draw.
CREATE UNIQUE INDEX IF NOT EXISTS idx_care_draws_gift ON care_draws(gift_id) WHERE gift_id IS NOT NULL;
