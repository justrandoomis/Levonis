-- Levonis migration 0015 — wallet holds + reconcilable withdrawal state
-- machine + deposit reference dedup + linked corrections + user review
-- requests (integrated mandate §11.1–§11.4).
-- NONDESTRUCTIVE: new tables and indexes only. Nothing in 0001–0014 is
-- altered; wallet_transactions keeps its existing columns, CHECKs and
-- semantics so the deposit-review and checkout flows built on it keep
-- working unchanged.
--
-- MODEL (why a separate hold table instead of new statuses on the ledger):
--   * wallet_transactions is the LEDGER. A row is money that HAS moved once
--     status='approved' (deposit = credit, withdrawal = debit). Its CHECK
--     only allows pending/approved/rejected and 0001 may not be edited, so
--     the richer withdrawal lifecycle lives beside it, never inside it.
--   * wallet_holds is the RESERVATION book. An active hold is money that is
--     still in the settled balance but is no longer spendable.
--   * available = settled(approved ledger) − effective active holds, where a
--     hold stops being "effective" the moment its own ledger row is approved
--     (hold.tx_id → wallet_transactions.status='approved'). That single rule
--     is what makes the mandated example impossible to get wrong:
--       settled 100,000 + active hold 30,000            → available  70,000
--       payout completes (hold committed, ledger debit) → settled 70,000,
--       held 0, available 70,000 — never 40,000, because the hold stops
--       counting in the same transaction that posts the debit.
--     It also means a withdrawal approved through the LEGACY admin path
--     (which flips the ledger row straight to 'approved' without touching
--     this table) cannot double-subtract either; reconciliation reports it
--     as an anomaly instead of silently eating the balance twice.
--
-- Money is INTEGER cents throughout (no floating point). IQD display values
-- are derived at the edge from the exchange-rate setting (decision row 6).
--
-- THE SENTENCE THAT STOOD HERE IS SUPERSEDED, AND IT IS KEPT VERBATIM SO THE
-- REPLACEMENT CAN BE JUDGED AGAINST IT. It read:
--
--   «the stored unit stays USD cents because the whole existing ledger,
--    checkout and refund paths are USD cents — changing the stored unit
--    would be a destructive rewrite of live balances, not a migration.»
--
-- WHAT IS STILL TRUE: the stored unit IS still USD cents, and for exactly the
-- reason given. Every CHECK in this file is a cents identity, `wallet_holds`
-- below has no dinar column at all, and `CHECK (amount > 0)` on
-- `wallet_transactions` is the mechanism `usdSpendStatement` uses to abort a
-- D1 batch. Re-denominating any of it would still be a destructive rewrite.
-- Migration 0108 says so again in full and refuses it again.
--
-- WHAT IS NO LONGER TRUE: the clause that followed from it in practice — that
-- a DINAR FIGURE is therefore always derived from the cents. The owner has
-- set the opposite rule, in writing:
--
--   «اجعل عندما يكتب المستخدم الرصيد يضاف كما هو ولكن يحول الى الدولار
--    وليس العكس»
--
-- The dinars the customer types are what is added, and the dollar is
-- converted FROM them. Derivation-from-cents cost a live customer a sale: a
-- typed 50,000 د.ع floored to 3,571 cents and read back as 49,994, six dinars
-- short of a 50,000 د.ع printer advance that is denominated in dinars and
-- never converted at all.
--
-- HOW BOTH HOLD AT ONCE, which is the whole of the replacement: the typed
-- dinars are RECORDED beside the cents (0105 for a deposit, 0106 for a
-- withdrawal, 0108 on the ledger row itself) and a dinar balance is the cents
-- balance refined within the one cent the cents cannot resolve. Nothing
-- stored was rewritten to achieve that, no balance was recomputed, and no
-- cent figure is ever computed from a dinar column. THE ONE RULE FOR WHICH
-- UNIT WINS IS WRITTEN OUT IN FULL IN migrations/0108_wallet_ledger_dinars.sql
-- and is quoted, not restated, everywhere it is applied.

-- ---------------------------------------------------------------- holds

CREATE TABLE wallet_holds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('purchase','withdrawal')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','committed','released')),
  -- Business-event identity: the SAME event may hold only once, no matter
  -- how many times a client retries or how the idempotency key is rotated
  -- (mandate §11.4). Uniqueness is enforced by the constraint below, never
  -- by a read-then-write check in application code.
  event_key TEXT NOT NULL,
  ref_type TEXT NOT NULL DEFAULT '',          -- 'withdrawal' | 'order' | ''
  ref_id TEXT NOT NULL DEFAULT '',
  -- Ledger row that will carry (or already carries) this hold's debit.
  tx_id TEXT REFERENCES wallet_transactions(id),
  note TEXT NOT NULL DEFAULT '',
  release_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  committed_at TEXT,
  released_at TEXT,
  UNIQUE (user_id, kind, event_key),
  -- A terminal hold must carry the timestamp that proves when it ended, so
  -- "released twice" and "committed without a moment" are unrepresentable.
  CHECK (state <> 'committed' OR committed_at IS NOT NULL),
  CHECK (state <> 'released' OR released_at IS NOT NULL)
);
CREATE INDEX idx_wallet_holds_user_state ON wallet_holds(user_id, state);
CREATE INDEX idx_wallet_holds_ref ON wallet_holds(ref_type, ref_id);
-- One ledger row can back at most one hold (no debit shared by two holds).
CREATE UNIQUE INDEX uq_wallet_holds_tx ON wallet_holds(tx_id) WHERE tx_id IS NOT NULL;

-- ------------------------------------------------------- withdrawal requests

CREATE TABLE wallet_withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- The pending ledger row (type='withdrawal', status='pending'). It becomes
  -- 'approved' ONLY when the payout is recorded as actually made, and
  -- 'rejected' when the request ends without money leaving.
  tx_id TEXT NOT NULL UNIQUE REFERENCES wallet_transactions(id),
  hold_id TEXT NOT NULL UNIQUE REFERENCES wallet_holds(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  -- Fees are NOT invented here. Until the owner approves a fee/limit policy
  -- (mandate §11.3 + §13.1) fee_policy stays 'not_configured' and fee_cents
  -- is 0 — the UI says so instead of showing a made-up percentage.
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  net_cents INTEGER NOT NULL CHECK (net_cents > 0),
  fee_policy TEXT NOT NULL DEFAULT 'not_configured',
  -- Destination is FROZEN at confirmation: these columns are written once by
  -- the request and are never updated by any state transition. Changing a
  -- destination means cancelling and filing a new, re-verified request.
  destination_kind TEXT NOT NULL,
  destination_account TEXT NOT NULL,
  destination_holder TEXT NOT NULL DEFAULT '',
  destination_note TEXT NOT NULL DEFAULT '',
  destination_frozen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested','approved','processing','paid','rejected','cancelled','failed')),
  -- Unknown-outcome payout attempt: the request stays in 'processing' and is
  -- flagged. A flagged request may NOT be failed/released and may NOT be
  -- re-sent automatically — a human resolves it (mandate §11.3).
  needs_reconciliation INTEGER NOT NULL DEFAULT 0 CHECK (needs_reconciliation IN (0,1)),
  reconciliation_note TEXT NOT NULL DEFAULT '',
  -- Proof of an actual transfer. The CHECK below makes "paid" unrepresentable
  -- without a recorded reference, actor and time.
  payout_reference TEXT NOT NULL DEFAULT '',
  payout_actor TEXT NOT NULL DEFAULT '',
  payout_at TEXT,
  outcome_reason TEXT NOT NULL DEFAULT '',    -- reject / cancel / failure reason
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (net_cents = amount_cents - fee_cents),
  CHECK (state <> 'paid' OR (payout_reference <> '' AND payout_actor <> '' AND payout_at IS NOT NULL)),
  CHECK (state IN ('requested','approved','processing') OR outcome_reason <> '' OR state = 'paid')
);
CREATE INDEX idx_wallet_withdrawals_user ON wallet_withdrawals(user_id, created_at DESC);
CREATE INDEX idx_wallet_withdrawals_state ON wallet_withdrawals(state);
CREATE INDEX idx_wallet_withdrawals_recon ON wallet_withdrawals(needs_reconciliation) WHERE needs_reconciliation = 1;

-- ---------------------------------------------------------- deposit context

CREATE TABLE wallet_deposit_meta (
  tx_id TEXT PRIMARY KEY REFERENCES wallet_transactions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Reference dedup is scoped to the transfer CONTEXT, not to a bare string:
  -- the same digits at two different providers/accounts are two different
  -- transfers, while the same digits in the same context are one transfer no
  -- matter what file name or idempotency key the client sends (§11.2).
  provider TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',         -- as the user typed it
  reference_norm TEXT NOT NULL DEFAULT '',    -- casefolded, separators stripped
  -- Attachment fingerprint is a SIGNAL for the reviewer (a reused receipt
  -- image), never proof of payment and never an auto-reject.
  attachment_fingerprint TEXT NOT NULL DEFAULT '',
  declared_amount_cents INTEGER NOT NULL CHECK (declared_amount_cents > 0),
  observed_amount_cents INTEGER,              -- what finance actually saw arrive
  review_state TEXT NOT NULL DEFAULT 'awaiting_review'
    CHECK (review_state IN ('awaiting_review','amount_mismatch','duplicate_reference_signal',
                            'fingerprint_reuse_signal','cleared_for_decision')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  -- 1 while this row still owns its (provider, channel, reference) slot. A
  -- rejected deposit frees the slot so an honest correction can be filed;
  -- an approved one never does — that is what stops a second credit for the
  -- same transfer.
  dedup_active INTEGER NOT NULL DEFAULT 1 CHECK (dedup_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX uq_wallet_deposit_reference
  ON wallet_deposit_meta(provider, channel, reference_norm)
  WHERE reference_norm <> '' AND dedup_active = 1;
CREATE INDEX idx_wallet_deposit_meta_user ON wallet_deposit_meta(user_id);
CREATE INDEX idx_wallet_deposit_meta_fingerprint ON wallet_deposit_meta(attachment_fingerprint)
  WHERE attachment_fingerprint <> '';

-- --------------------------------------------------------- linked corrections

-- A final ledger row is never edited or deleted to fix a mistake (§11.1). A
-- correction is a NEW ledger row linked to the original through this table,
-- with the actor and reason recorded, and idempotent per (original, key).
CREATE TABLE wallet_adjustments (
  id TEXT PRIMARY KEY,
  original_tx_id TEXT NOT NULL REFERENCES wallet_transactions(id),
  adjustment_tx_id TEXT NOT NULL UNIQUE REFERENCES wallet_transactions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  direction TEXT NOT NULL CHECK (direction IN ('credit','debit')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (original_tx_id, event_key)
);
CREATE INDEX idx_wallet_adjustments_user ON wallet_adjustments(user_id);

-- ------------------------------------------------------- user review requests

-- §11.1: the user can ask for a review of a transaction that belongs to them.
CREATE TABLE wallet_review_requests (
  id TEXT PRIMARY KEY,
  tx_id TEXT NOT NULL REFERENCES wallet_transactions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered','closed')),
  admin_note TEXT NOT NULL DEFAULT '',
  handled_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- One OPEN request per transaction per user; closed ones stay as history.
CREATE UNIQUE INDEX uq_wallet_review_open ON wallet_review_requests(tx_id, user_id) WHERE state = 'open';
CREATE INDEX idx_wallet_review_state ON wallet_review_requests(state, created_at DESC);
