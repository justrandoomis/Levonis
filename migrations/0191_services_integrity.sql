-- 0191 — SERVICES V2, S-P1: INTEGRITY TRIGGERS (Services plan §2.3, §0 correction 1,
-- §1.3; docs/DECISIONS.md row 237, following rows 223, 227 and 228).
--
-- Additive only: four nullable ADD COLUMNs on warranty_claims, one trigger
-- REPLACED (trg_coupon_redemption_limits: the 0077 body plus «an inactive coupon
-- is refused» as its first statement) and new triggers. No row is updated or
-- deleted by this file; no CHECK is widened; no table is rebuilt.
--
-- TRIGGERS, NOT UNIQUE INDEXES. The live database may already hold two open
-- warranty claims on one device, or two «requested» protection claims on one
-- order line. A unique index over those rows would fail the migration; the
-- triggers below refuse only NEW writes, and the old duplicates stay workable
-- (they can move between open stages and close) until each is closed.
--
-- «Open» for a warranty claim is spelled with the exact text closedClaimSql()
-- (worker/lib/deviceOps.ts) generates, so the database and the Worker agree;
-- tests/sv2_warranty_desk.test.ts checks the two never drift. Each CASE ends
-- `END )` with a space: Wrangler closes a CASE only on whitespace + END +
-- whitespace (tests/sqlSplit.test.ts).
--
-- Every CREATE TRIGGER carries IF NOT EXISTS: those are the statements
-- scripts/migrate-check.mjs re-runs to prove the file is idempotent.

-- ---------------------------------------------------------------- 1. W-1: the cover a claim was filed under (NULL on every older claim)
ALTER TABLE warranty_claims ADD COLUMN filed_cover_state TEXT;
ALTER TABLE warranty_claims ADD COLUMN filed_cover_via TEXT;
ALTER TABLE warranty_claims ADD COLUMN filed_cover_end_at TEXT;
ALTER TABLE warranty_claims ADD COLUMN filed_policy_version TEXT;

CREATE TRIGGER IF NOT EXISTS trg_claim_filed_cover_frozen
BEFORE UPDATE OF filed_cover_state, filed_cover_via, filed_cover_end_at, filed_policy_version ON warranty_claims
WHEN NEW.filed_cover_state IS NOT OLD.filed_cover_state
  OR NEW.filed_cover_via IS NOT OLD.filed_cover_via
  OR NEW.filed_cover_end_at IS NOT OLD.filed_cover_end_at
  OR NEW.filed_policy_version IS NOT OLD.filed_policy_version
BEGIN
  SELECT RAISE(ABORT, 'CLAIM_FILED_COVER_FROZEN');
END;

-- ---------------------------------------------------------------- 2. W-3: one open case per device
-- A BEFORE trigger fires before ON CONFLICT(id) is checked, so the row itself
-- (wc.id <> NEW.id) is excluded: an idempotent replay of the same claim id is
-- not refused. Moves between open stages, and closing, are never refused; only
-- a closed claim reopening beside an open one is.
CREATE TRIGGER IF NOT EXISTS trg_one_open_case_per_unit
BEFORE INSERT ON warranty_claims
WHEN NEW.unit_id IS NOT NULL
 AND NOT ((CASE WHEN NEW.stage IN ('received','diagnosing','approved','rejected','repairing','replaced','resolved') THEN NEW.stage
       WHEN NEW.status = 'in_review' THEN 'diagnosing'
       WHEN NEW.status = 'approved' THEN 'resolved'
       WHEN NEW.status = 'rejected' THEN 'rejected'
       ELSE 'received' END ) IN ('rejected','replaced','resolved'))
 AND EXISTS (SELECT 1 FROM warranty_claims wc
              WHERE wc.unit_id = NEW.unit_id AND wc.id <> NEW.id
                AND NOT ((CASE WHEN wc.stage IN ('received','diagnosing','approved','rejected','repairing','replaced','resolved') THEN wc.stage
                      WHEN wc.status = 'in_review' THEN 'diagnosing'
                      WHEN wc.status = 'approved' THEN 'resolved'
                      WHEN wc.status = 'rejected' THEN 'rejected'
                      ELSE 'received' END ) IN ('rejected','replaced','resolved')))
BEGIN
  SELECT RAISE(ABORT, 'CLAIM_ALREADY_OPEN');
END;

CREATE TRIGGER IF NOT EXISTS trg_one_open_case_per_unit_reopen
BEFORE UPDATE OF stage, status ON warranty_claims
WHEN NEW.unit_id IS NOT NULL
 AND ((CASE WHEN OLD.stage IN ('received','diagnosing','approved','rejected','repairing','replaced','resolved') THEN OLD.stage
       WHEN OLD.status = 'in_review' THEN 'diagnosing'
       WHEN OLD.status = 'approved' THEN 'resolved'
       WHEN OLD.status = 'rejected' THEN 'rejected'
       ELSE 'received' END ) IN ('rejected','replaced','resolved'))
 AND NOT ((CASE WHEN NEW.stage IN ('received','diagnosing','approved','rejected','repairing','replaced','resolved') THEN NEW.stage
       WHEN NEW.status = 'in_review' THEN 'diagnosing'
       WHEN NEW.status = 'approved' THEN 'resolved'
       WHEN NEW.status = 'rejected' THEN 'rejected'
       ELSE 'received' END ) IN ('rejected','replaced','resolved'))
 AND EXISTS (SELECT 1 FROM warranty_claims wc
              WHERE wc.unit_id = NEW.unit_id AND wc.id <> NEW.id
                AND NOT ((CASE WHEN wc.stage IN ('received','diagnosing','approved','rejected','repairing','replaced','resolved') THEN wc.stage
                      WHEN wc.status = 'in_review' THEN 'diagnosing'
                      WHEN wc.status = 'approved' THEN 'resolved'
                      WHEN wc.status = 'rejected' THEN 'rejected'
                      ELSE 'received' END ) IN ('rejected','replaced','resolved')))
BEGIN
  SELECT RAISE(ABORT, 'CLAIM_ALREADY_OPEN');
END;

-- ---------------------------------------------------------------- 3. G3: one requested protection claim per order line
-- The decision door's guard row (state 'financial_guard') is not «requested».
CREATE TRIGGER IF NOT EXISTS ppc_one_open
BEFORE INSERT ON price_protection_claims
WHEN NEW.state = 'requested'
 AND EXISTS (SELECT 1 FROM price_protection_claims p
              WHERE p.order_item_id = NEW.order_item_id AND p.state = 'requested' AND p.id <> NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'CLAIM_PENDING');
END;

-- ---------------------------------------------------------------- 4. Correction 1: the limit trigger (0077) also refuses an inactive coupon
-- REPLACED, not added to: order INACTIVE, PER_USER, GLOBAL, NOT_YOURS.
DROP TRIGGER IF EXISTS trg_coupon_redemption_limits;

CREATE TRIGGER IF NOT EXISTS trg_coupon_redemption_limits
BEFORE INSERT ON coupon_redemptions
BEGIN
  SELECT RAISE(ABORT, 'COUPON_INACTIVE')
   WHERE COALESCE((SELECT c.active FROM coupons c WHERE c.id = NEW.coupon_id), 0) <> 1;
  SELECT RAISE(ABORT, 'COUPON_PER_USER_LIMIT')
   WHERE (SELECT COUNT(*) FROM coupon_redemptions r
           WHERE r.coupon_id = NEW.coupon_id AND r.user_id = NEW.user_id AND r.state = 'active')
         >= (SELECT c.max_per_user FROM coupons c WHERE c.id = NEW.coupon_id);
  SELECT RAISE(ABORT, 'COUPON_GLOBAL_LIMIT')
   WHERE (SELECT c.max_global FROM coupons c WHERE c.id = NEW.coupon_id) IS NOT NULL
     AND (SELECT COUNT(*) FROM coupon_redemptions r
           WHERE r.coupon_id = NEW.coupon_id AND r.state = 'active')
         >= (SELECT c.max_global FROM coupons c WHERE c.id = NEW.coupon_id);
  SELECT RAISE(ABORT, 'COUPON_NOT_YOURS')
   WHERE (SELECT c.assigned_user_id FROM coupons c WHERE c.id = NEW.coupon_id) IS NOT NULL
     AND (SELECT c.assigned_user_id FROM coupons c WHERE c.id = NEW.coupon_id) <> NEW.user_id;
END;

-- ---------------------------------------------------------------- 5. B1: a released use comes back only within the limits
-- (the 0065 trg_offer_redemption_reclaim shape). Its ABORT rolls the whole
-- reopen back: the order stays cancelled.
CREATE TRIGGER IF NOT EXISTS trg_coupon_redemption_reclaim
BEFORE UPDATE OF state ON coupon_redemptions
WHEN NEW.state = 'active' AND OLD.state <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'COUPON_INACTIVE')
   WHERE COALESCE((SELECT c.active FROM coupons c WHERE c.id = NEW.coupon_id), 0) <> 1;
  SELECT RAISE(ABORT, 'COUPON_PER_USER_LIMIT')
   WHERE (SELECT COUNT(*) FROM coupon_redemptions r
           WHERE r.coupon_id = NEW.coupon_id AND r.user_id = NEW.user_id AND r.state = 'active' AND r.id <> NEW.id)
         >= (SELECT c.max_per_user FROM coupons c WHERE c.id = NEW.coupon_id);
  SELECT RAISE(ABORT, 'COUPON_GLOBAL_LIMIT')
   WHERE (SELECT c.max_global FROM coupons c WHERE c.id = NEW.coupon_id) IS NOT NULL
     AND (SELECT COUNT(*) FROM coupon_redemptions r
           WHERE r.coupon_id = NEW.coupon_id AND r.state = 'active' AND r.id <> NEW.id)
         >= (SELECT c.max_global FROM coupons c WHERE c.id = NEW.coupon_id);
END;

-- ---------------------------------------------------------------- 6. Correction 1: one credit coupon per trade-in request, for life
-- BEFORE INSERT only: a request that already holds two coupons from before this
-- file is left as it is. A later re-issue must re-target this same row.
CREATE TRIGGER IF NOT EXISTS trg_trade_in_one_credit
BEFORE INSERT ON coupons
WHEN NEW.trade_in_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM coupons c WHERE c.trade_in_id = NEW.trade_in_id)
BEGIN
  SELECT RAISE(ABORT, 'TRADE_IN_CREDIT_EXISTS');
END;

-- ---------------------------------------------------------------- 7. B1 + correction 1: a cancel by ANY door gives the use back
-- (customer, admin status door, stage door, expiry and Gini sweeps — the 0175
-- gift pattern). A delivered order that is then cancelled keeps its use: it was
-- received. A trade-in credit's end moves by exactly the time this order held
-- it, and the request's log says so — only while the request still awaits
-- payment: a completed (or otherwise closed) request's credit can never be
-- spent again, so its end does not move and the customer is not told it came
-- back. All three statements read state = 'active', so the release is last.
CREATE TRIGGER IF NOT EXISTS trg_orders_coupon_released
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status NOT IN ('cancelled', 'delivered')
BEGIN
  UPDATE coupons
     SET ends_at = strftime('%Y-%m-%dT%H:%M:%fZ',
                            julianday(ends_at) + MAX(0, julianday('now') - julianday(NEW.created_at)))
   WHERE trade_in_id IS NOT NULL AND julianday(ends_at) IS NOT NULL AND julianday(NEW.created_at) IS NOT NULL
     AND EXISTS (SELECT 1 FROM trade_in_requests t WHERE t.id = coupons.trade_in_id AND t.status = 'awaiting_payment')
     AND id IN (SELECT r.coupon_id FROM coupon_redemptions r WHERE r.order_id = NEW.id AND r.state = 'active');
  INSERT INTO trade_in_events (id, request_id, actor_id, actor_role, action, from_status, to_status, detail_json, created_at)
  SELECT 'tie_' || lower(hex(randomblob(10))), c.trade_in_id, NULL, 'system', 'credit_restored', t.status, t.status,
         json_object('order_id', NEW.id, 'coupon_id', c.id, 'ends_at', c.ends_at),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM coupon_redemptions r
    JOIN coupons c ON c.id = r.coupon_id
    JOIN trade_in_requests t ON t.id = c.trade_in_id
   WHERE r.order_id = NEW.id AND r.state = 'active' AND t.status = 'awaiting_payment';
  UPDATE coupon_redemptions
     SET state = 'released', released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE order_id = NEW.id AND state = 'active';
END;

-- ---------------------------------------------------------------- 8. Reopening a cancelled order takes the use back
-- (trigger 5 decides) and takes back the held-time extension, so across
-- cancel → reopen → cancel the end is the original end plus every period an
-- order held the credit; the time the order sat cancelled counts against it.
-- A use cancelled before this file is still 'active' and its end never moved:
-- the first statement charges it the time it sat cancelled (from the order's
-- cancelled_at, still set in OLD), so its next cancel adds only held time too.
-- As in trigger 7, only a credit whose request still awaits payment moves.
-- The legacy statement runs first: the last one turns 'released' into 'active'.
CREATE TRIGGER IF NOT EXISTS trg_orders_coupon_reclaimed
AFTER UPDATE OF status ON orders
WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
BEGIN
  UPDATE coupons
     SET ends_at = strftime('%Y-%m-%dT%H:%M:%fZ',
                            julianday(ends_at) - MAX(0, julianday('now') - julianday(OLD.cancelled_at)))
   WHERE trade_in_id IS NOT NULL AND julianday(ends_at) IS NOT NULL AND julianday(OLD.cancelled_at) IS NOT NULL
     AND EXISTS (SELECT 1 FROM trade_in_requests t WHERE t.id = coupons.trade_in_id AND t.status = 'awaiting_payment')
     AND id IN (SELECT r.coupon_id FROM coupon_redemptions r WHERE r.order_id = NEW.id AND r.state = 'active');
  UPDATE coupons
     SET ends_at = strftime('%Y-%m-%dT%H:%M:%fZ',
                            julianday(ends_at) - MAX(0, julianday('now') - julianday(NEW.created_at)))
   WHERE trade_in_id IS NOT NULL AND julianday(ends_at) IS NOT NULL AND julianday(NEW.created_at) IS NOT NULL
     AND EXISTS (SELECT 1 FROM trade_in_requests t WHERE t.id = coupons.trade_in_id AND t.status = 'awaiting_payment')
     AND id IN (SELECT r.coupon_id FROM coupon_redemptions r WHERE r.order_id = NEW.id AND r.state = 'released');
  UPDATE coupon_redemptions
     SET state = 'active', released_at = NULL
   WHERE order_id = NEW.id AND state = 'released';
END;

-- ---------------------------------------------------------------- 9. A reopen never brings back a switched-off trade-in credit
-- An order cancelled before this file still holds its use ('active'), so
-- trigger 8 reclaims nothing and trigger 5 never runs. If the credit was
-- switched off since — its request cancelled and the device released, or the
-- old «إتمام الدفع» minted a second coupon — reopening that order would hand
-- back a credit its request no longer has, or a second one beside it. Refused
-- for any trade-in coupon use of the order, whatever the use's state (after
-- this file trigger 5 already refuses a released one). A promo code switched
-- off since is left as it was: its use was never given back.
CREATE TRIGGER IF NOT EXISTS trg_orders_reopen_coupon_inactive
BEFORE UPDATE OF status ON orders
WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
 AND EXISTS (SELECT 1 FROM coupon_redemptions r JOIN coupons c ON c.id = r.coupon_id
              WHERE r.order_id = NEW.id AND c.trade_in_id IS NOT NULL AND COALESCE(c.active, 0) <> 1)
BEGIN
  SELECT RAISE(ABORT, 'COUPON_INACTIVE');
END;
