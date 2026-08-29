-- Levonis migration 0016 — support-code gift entitlements (integrated
-- mandate §3.3 "the support code is NOT a discount" and §3.4 "filament gift
-- and abuse prevention"). NONDESTRUCTIVE: one ADD COLUMN, one new table and
-- its indexes. Nothing in 0001–0015 is dropped, rewritten or recomputed.
--
-- WHAT IS **NOT** HERE, ON PURPOSE:
--   * orders.support_snapshot ALREADY EXISTS — migration 0014 added it
--     (JSON {referrer_user_id, referrer_username, ref}, frozen at order
--     confirmation, zero monetary effect). 0002/0008 carry no column that
--     fits, so no second storage column is invented here; re-adding it would
--     fail the migration set. The snapshot stays the single attribution
--     source of truth and is never mutated after the order is confirmed
--     (§3.3: "no endpoint accepts changing the referrer after purchase").
--   * No money column. A support gift is a REAL-STOCK entitlement (a spool),
--     never a withdrawable cash balance (§3.4).

-- ------------------------------------------------------- printer eligibility
--
-- §3.4: "printer eligibility is an explicit field in product management, not
-- a search for the word printer inside the name. Accessories do not qualify
-- automatically without configuration."
--
-- The catalog-level flag catalogs.is_printer_catalog (0002) already is such
-- an explicit admin field and keeps working unchanged. This column is the
-- PER-PRODUCT override on top of it:
--     NULL = inherit the catalog flag (the existing behavior, unchanged for
--            every existing row — that is why it is nullable with no
--            backfill: nothing silently becomes eligible or ineligible),
--     1    = explicitly eligible for the support gift,
--     0    = explicitly NOT eligible (an accessory that happens to sit in a
--            printer catalog).
-- Resolution is COALESCE(products.support_gift_eligible, <catalog flag>) and
-- lives in worker/lib/membershipOps.ts — no name matching anywhere.
-- No CHECK is attached here: SQLite's ALTER TABLE ADD COLUMN keeps the rest
-- of the table definition untouched, and the value is validated by the admin
-- write path plus the `= 1` comparison used by every read.
ALTER TABLE products ADD COLUMN support_gift_eligible INTEGER;

-- ---------------------------------------------------- gift entitlement book
--
-- One row = one referrer's claim arising from ONE eligible order.
--
-- WHY UNIQUE(order_id): §3.4 demands a "unique business event" so a repeated
-- delivered transition, a cron retry or a replayed webhook can never pay a
-- second gift. The default policy is ONE gift per qualifying ORDER (not per
-- printer line) — decision register row 11 / mandate §13 item 2 — and the
-- constraint makes the other reading unrepresentable until the owner decides
-- otherwise. Widening it later is an additive migration (drop the unique
-- index, key on (order_id, order_item_id)); narrowing it is not, which is
-- why the safe default ships first.
--
-- STATES (§3.4, exactly the mandate's five):
--   pending_eligibility — attribution recorded, the gift has NOT qualified
--                         yet (not delivered, or payment not settled, or a
--                         guard needs a human).
--   due                 — delivered AND payment settled AND an eligible
--                         printer line is present. qualified_at is stamped.
--   reserved            — real stock reserved for this claim by an admin.
--   paid                — the spool actually handed over; requires the
--                         product, the actor and the moment.
--   cancelled           — self-support, order cancelled, return/refund, or
--                         an admin decision. Always carries a reason.
--
-- NO PRO REQUIREMENT AND NO SEVEN-DAY WAIT LIVE IN THIS TABLE, deliberately:
-- §3.4 forbids importing the old program's conditions, and the seven-day
-- clock is the POINTS clock (points_accruals.available_at, migration 0014) —
-- a different mechanism with a different purpose. Any extra commercial
-- hold-back must be an announced, approved setting, not a hidden default.
CREATE TABLE support_gift_entitlements (
  id TEXT PRIMARY KEY,
  -- The qualifying business event.
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  -- Stable user ids, never usernames: a later rename can no more move an
  -- earned gift than it can move a signup attribution (§3.1).
  referrer_id TEXT NOT NULL REFERENCES users(id),
  buyer_id TEXT NOT NULL REFERENCES users(id),
  -- The ref exactly as it was snapshotted on the order (audit/display only).
  support_ref TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending_eligibility'
    CHECK (state IN ('pending_eligibility','due','reserved','paid','cancelled')),
  -- A guard fired (double-payout risk with the legacy printer campaign, an
  -- open return on the eligible line, …): the claim is REAL and visible, but
  -- it may not auto-advance to due — a human decides (§3.4 "suspicion
  -- signals go to review", §13 item 2 "no hidden new conditions").
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
  review_reason TEXT NOT NULL DEFAULT '',
  delivered_at TEXT,                 -- order delivery instant observed
  settled_at TEXT,                   -- instant collections covered the total
  qualified_at TEXT,                 -- when the claim became due
  spool_product_id TEXT,             -- the real product granted
  admin_note TEXT NOT NULL DEFAULT '',
  outcome_reason TEXT NOT NULL DEFAULT '',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Self-support is unrepresentable in the schema, not merely filtered in
  -- code (§3.4 "prevent self-support").
  CHECK (referrer_id <> buyer_id),
  -- A due (or later) claim must carry the moment it qualified…
  CHECK (state IN ('pending_eligibility','cancelled') OR qualified_at IS NOT NULL),
  -- …a handed-over gift must carry what was given, by whom and when…
  CHECK (state <> 'paid' OR (spool_product_id IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  -- …and a cancellation must carry its reason.
  CHECK (state <> 'cancelled' OR outcome_reason <> '')
);
CREATE INDEX idx_support_gifts_referrer ON support_gift_entitlements(referrer_id, state);
CREATE INDEX idx_support_gifts_state ON support_gift_entitlements(state, created_at DESC);
CREATE INDEX idx_support_gifts_buyer ON support_gift_entitlements(buyer_id);
CREATE INDEX idx_support_gifts_review ON support_gift_entitlements(needs_review) WHERE needs_review = 1;
