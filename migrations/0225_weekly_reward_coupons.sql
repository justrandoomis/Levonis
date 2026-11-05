-- ============================================================================
-- 0225 — THE WEEKLY PRINTER COUPONS, AND SPENDING SEVERAL ON ONE ORDER (owner,
-- 2026-11-05; docs/DECISIONS.md row 295).
--
-- The owner's brief, in their words:
--   «كل اسبوع كوبون خصم على الفلمنت واحد وكوبون توصيل مجاني للطلبات فوق 100 الف.
--    طابعه وحده = كوبون واحد، ٣ طابعات = ٣ كوبونات وهكذا كل اسبوع»
--   «فترة محددة all the warranty period 12month»
--   «the coupon is for 1 pic, 1 free shipping 5000, 2 coupon mean shipping
--    discount 10000 and 2 pic of filament»
-- And the answers to the two open choices (2026-11-05): all of a customer's
-- coupons go on ONE order, filament and delivery together; and every printer
-- whose warranty is still running earns them, not only the new ones.
--
-- WHAT THIS FILE LANDS. Only the spending: one order may now spend several
-- reward coupons. `coupon_redemptions.order_id` has been UNIQUE since 0002 and
-- half the shop reads that row as «the order's coupon», so it stays exactly what
-- it is, and holds the first coupon spent. Every other coupon of that order goes
-- in `coupon_redemption_extras`. Nothing else in this file touches an existing
-- table, and the weekly issuing itself needs no schema: `reward_grants.source_ref`
-- gains a week ('printer:<item>:<unit>:<kind>:w<k>') and stays the idempotency key.
--
-- ADDITIVE ONLY: one new table, its indexes, and triggers on it and beside the
-- existing ones. No existing row changes, and an order that spends one coupon
-- writes exactly what it always wrote.
--
-- RE-RUNNABLE: every CREATE says IF NOT EXISTS (scripts/migrate-check.mjs --twice).
--
-- DEPLOY-AHEAD (CLAUDE.md rule 2): every reader of this table tolerates its
-- absence: the rewards hub reads `installed: false` and the checkout refuses
-- nothing it did not refuse before, on a database that has no pool to spend.
-- `d1_migrations.applied_at` of this file is also the weekly programme's start:
-- every printer's first week is counted from it at the earliest.
-- Comments use `--` only: tests/d1CompoundLimit.test.ts strips no block comment.
-- ============================================================================

CREATE TABLE IF NOT EXISTS coupon_redemption_extras (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES coupons(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  amount_iqd INTEGER NOT NULL DEFAULT 0 CHECK (amount_iqd >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'released')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  released_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_coupon_extras_live ON coupon_redemption_extras(coupon_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_coupon_extras_order ON coupon_redemption_extras(order_id);

-- ---------------------------------------------------------------- A coupon spends once, across both tables
-- The same answers the limit trigger of coupon_redemptions gives (0191), so the
-- checkout's own mapping of them applies. Only a reward coupon is ever pooled: a
-- promo code or a trade-in credit that reached this table is a bug, and refused.
CREATE TRIGGER IF NOT EXISTS trg_coupon_extra_limits
BEFORE INSERT ON coupon_redemption_extras
BEGIN
  SELECT RAISE(ABORT, 'COUPON_INACTIVE')
   WHERE COALESCE((SELECT c.active FROM coupons c WHERE c.id = NEW.coupon_id), 0) <> 1
      OR (SELECT c.reward_grant_id FROM coupons c WHERE c.id = NEW.coupon_id) IS NULL;
  SELECT RAISE(ABORT, 'COUPON_NOT_YOURS')
   WHERE (SELECT c.assigned_user_id FROM coupons c WHERE c.id = NEW.coupon_id) IS NOT NULL
     AND (SELECT c.assigned_user_id FROM coupons c WHERE c.id = NEW.coupon_id) <> NEW.user_id;
  SELECT RAISE(ABORT, 'COUPON_GLOBAL_LIMIT')
   WHERE EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = NEW.coupon_id AND r.state = 'active')
      OR EXISTS (SELECT 1 FROM coupon_redemption_extras x WHERE x.coupon_id = NEW.coupon_id AND x.state = 'active');
END;

CREATE TRIGGER IF NOT EXISTS trg_coupon_redemption_not_pooled
BEFORE INSERT ON coupon_redemptions
WHEN EXISTS (SELECT 1 FROM coupon_redemption_extras x WHERE x.coupon_id = NEW.coupon_id AND x.state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'COUPON_GLOBAL_LIMIT');
END;

-- ---------------------------------------------------------------- A cancel by any door gives the uses back
-- The 0191 pattern exactly: the same statuses, on the same write. A delivered
-- order that is then cancelled keeps its uses: it was received.
CREATE TRIGGER IF NOT EXISTS trg_orders_coupon_extras_released
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status NOT IN ('cancelled', 'delivered')
BEGIN
  UPDATE coupon_redemption_extras
     SET state = 'released', released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE order_id = NEW.id AND state = 'active';
END;

-- ---------------------------------------------------------------- A reopen takes them back, within the limits
-- Its ABORT rolls the whole reopen back: the order stays cancelled, as 0191 does.
CREATE TRIGGER IF NOT EXISTS trg_coupon_extra_reclaim
BEFORE UPDATE OF state ON coupon_redemption_extras
WHEN NEW.state = 'active' AND OLD.state <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'COUPON_INACTIVE')
   WHERE COALESCE((SELECT c.active FROM coupons c WHERE c.id = NEW.coupon_id), 0) <> 1;
  SELECT RAISE(ABORT, 'COUPON_GLOBAL_LIMIT')
   WHERE EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = NEW.coupon_id AND r.state = 'active')
      OR EXISTS (SELECT 1 FROM coupon_redemption_extras x WHERE x.coupon_id = NEW.coupon_id AND x.state = 'active' AND x.id <> NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_coupon_redemption_reclaim_not_pooled
BEFORE UPDATE OF state ON coupon_redemptions
WHEN NEW.state = 'active' AND OLD.state <> 'active'
 AND EXISTS (SELECT 1 FROM coupon_redemption_extras x WHERE x.coupon_id = NEW.coupon_id AND x.state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'COUPON_GLOBAL_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_coupon_extras_reclaimed
AFTER UPDATE OF status ON orders
WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
BEGIN
  UPDATE coupon_redemption_extras
     SET state = 'active', released_at = NULL
   WHERE order_id = NEW.id AND state = 'released';
END;
