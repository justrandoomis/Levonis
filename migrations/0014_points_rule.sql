-- Levonis migration 0014 — points rule v2, accrual lifecycle, redemption
-- reservations and payment-settlement recording (integrated mandate §4.2,
-- §4.3, §4.4, §5, §11.5). NONDESTRUCTIVE: new tables, new indexes, two
-- ADD COLUMNs and one guarded settings seed. Nothing existing is dropped,
-- rewritten or recomputed.
--
-- WHY A NEW TABLE INSTEAD OF REWRITING points_awards (0003):
-- points_awards rows are the historical record of the OLD rule (1 point per
-- 1,000 IQD, awarded at the delivered event). Mandate §4.2 forbids
-- retroactively multiplying earned balances (acceptance test PTS-07), so
-- those rows stay exactly as they are, keep serving pre-0014 orders through
-- the legacy path in worker/lib/pointsOps.ts, and are never re-evaluated.
-- Orders placed from now on use points_accruals, which carries its own
-- rule version and rate per row — the rate an order earned at is frozen
-- with the order, so a later settings change can never re-price history.

-- ---------------------------------------------------------------- settings
--
-- pointsRuleConfig: the versioned commercial rule.
--   iqd_per_point        — new rule: 100 IQD of net eligible merchandise = 1 point
--   legacy_iqd_per_point — the rule pre-0014 orders keep (1,000)
--   effective_at         — ISO UTC instant the new rule starts applying to
--                          NEW purchases. Seeded to the migration's own
--                          application time: every order that already exists
--                          is unambiguously "before" it and keeps its old
--                          rule, and nothing already earned is re-computed.
--                          The owner can move this date from admin settings
--                          (decision register row 20 / mandate §13 item 4).
-- Guarded with WHERE NOT EXISTS so re-running the migration set, or an owner
-- who already configured the key, is never overwritten.
INSERT INTO admin_settings (key, value)
SELECT 'pointsRuleConfig',
       '{"iqd_per_point":100,"legacy_iqd_per_point":1000,"version":"v2","legacy_version":"v1","effective_at":"'
         || strftime('%Y-%m-%dT%H:%M:%fZ','now') || '"}'
 WHERE NOT EXISTS (SELECT 1 FROM admin_settings WHERE key = 'pointsRuleConfig');

-- ------------------------------------------------------------------ orders
--
-- The §5 unified financial snapshot needs the MERCHANDISE basis separated
-- from fees on the order itself (subtotal_iqd includes preorder transport
-- commissions and warranty fees, which never earn or absorb points).
-- Nullable on purpose: legacy orders keep NULL and the API recomputes their
-- merchandise from the per-item pricing snapshots instead of pretending a
-- backfilled 0 is real data.
ALTER TABLE orders ADD COLUMN merchandise_iqd INTEGER;

-- Support-code attribution snapshot (§3.3): JSON {referrer_user_id,
-- referrer_username, ref, lines?}. Frozen at confirmation, ZERO monetary
-- effect — it is an entitlement attribution, never a discount. NULL = the
-- order carries no support code.
ALTER TABLE orders ADD COLUMN support_snapshot TEXT;

-- -------------------------------------------------------- points accruals
--
-- Lifecycle (§4.3): a 'purchase' row is created PENDING inside the checkout
-- batch (purchase_at = the server instant the order was accepted — the same
-- transaction that reserved stock and money; never the browser clock, never
-- cart creation). available_at = purchase_at + 7×24h, fixed forever.
-- Release requires BOTH available_at passed AND settled_at stamped (payment
-- actually collected). A COD order collected on day 9 is released on day 9 —
-- settlement never restarts the seven-day clock.
--
-- 'reversal' rows are negative entries recomputed from the REMAINING
-- eligible amount after a cancellation/return; history is never erased.
-- A reversal row's state records WHERE it landed: 'pending' means it netted
-- against a still-pending accrual (no ledger movement ever happened);
-- 'released' means a balance-guarded claw-back was written to the ledger.
CREATE TABLE points_accruals (
  id TEXT PRIMARY KEY,
  source_ref TEXT NOT NULL UNIQUE,          -- order:<id>:accrual | order:<id>:reverse[:<case>]
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('purchase','reversal')),
  points INTEGER NOT NULL,                  -- >=0 for purchase, <=0 for reversal
  eligible_iqd INTEGER NOT NULL,            -- basis the points were computed from (signed like points)
  iqd_per_point INTEGER NOT NULL CHECK (iqd_per_point > 0),
  rule_version TEXT NOT NULL,               -- e.g. 'v2' (100) / 'v1' (1000)
  state TEXT NOT NULL CHECK (state IN ('pending','released','cancelled')),
  purchase_at TEXT NOT NULL,                -- server purchase-confirmation instant (ISO UTC)
  available_at TEXT NOT NULL,               -- purchase_at + 7×24h (ISO UTC)
  settled_at TEXT,                          -- payment settled (NULL = not collected yet)
  released_at TEXT,
  cancelled_at TEXT,
  reason TEXT NOT NULL DEFAULT '',
  wallet_tx_id TEXT,                        -- POINT ledger row written at release
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((kind = 'purchase' AND points >= 0 AND eligible_iqd >= 0)
      OR (kind = 'reversal' AND points <= 0 AND eligible_iqd <= 0))
);

-- Exactly one purchase accrual per order — the business event is unique, so
-- a replayed checkout or a duplicated hook can never accrue twice.
CREATE UNIQUE INDEX idx_points_accruals_purchase ON points_accruals(order_id) WHERE kind = 'purchase';
CREATE INDEX idx_points_accruals_order ON points_accruals(order_id);
CREATE INDEX idx_points_accruals_user_state ON points_accruals(user_id, state);
-- Drives the durable release job: pending + settled + due, cheapest first.
CREATE INDEX idx_points_accruals_due ON points_accruals(state, available_at) WHERE kind = 'purchase';

-- ---------------------------------------------------- points redemption
--
-- §4.4: points are reserved and committed INSIDE the checkout batch, so the
-- reservation and the ledger withdrawal share one atomic instant — there is
-- no window in which an order exists without its spend, and a failed
-- checkout leaves no row at all (the reservation is released by the same
-- rollback that discards the order). UNIQUE(order_id) makes a replay a
-- no-op; the withdrawal itself is balance-guarded, so two concurrent orders
-- can never spend the same point.
CREATE TABLE points_reservations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  points INTEGER NOT NULL CHECK (points > 0),   -- 1 point redeems as exactly 1 IQD
  eligible_basis_iqd INTEGER NOT NULL DEFAULT 0,-- eligible merchandise the cap came from
  state TEXT NOT NULL CHECK (state IN ('committed','refunded')),
  wallet_tx_id TEXT NOT NULL DEFAULT '',        -- the POINT withdrawal row
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  refunded_at TEXT
);
CREATE INDEX idx_points_reservations_user ON points_reservations(user_id, state);

-- ------------------------------------------------- payment settlement log
--
-- §11.5: "delivery alone does not mean the courier collected the full COD" —
-- collection is recorded separately, with its amount, reference and actor.
-- This log is what makes an accrual releasable; nothing else may claim a
-- payment was settled. UNIQUE(order_id, event_key) is the unique business
-- event: a replayed webhook, a retried cron or a double click records once.
CREATE TABLE order_payment_settlements (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,                  -- 'purchase' | 'cod:<ref>' | 'adj:<ref>'
  kind TEXT NOT NULL CHECK (kind IN ('prepaid_at_purchase','cod_collection','adjustment')),
  amount_iqd INTEGER NOT NULL CHECK (amount_iqd >= 0),
  reference TEXT NOT NULL DEFAULT '',       -- courier receipt / transfer reference
  note TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL DEFAULT 'system' CHECK (recorded_by IN ('system','admin')),
  actor_id TEXT,
  settled_at TEXT NOT NULL,                 -- server instant of the collection (ISO UTC)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (order_id, event_key)
);
CREATE INDEX idx_order_settlements_order ON order_payment_settlements(order_id);
