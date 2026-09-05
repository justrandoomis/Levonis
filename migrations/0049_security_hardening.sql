-- ---------------------------------------------------------------------------
-- 0049 — two money rules the database now enforces itself.
-- ---------------------------------------------------------------------------
-- Found by the authorised security audit (branch claude/security-audit).
--
-- 1. COUPON LIMITS. `coupons.max_per_user` and `max_global` were checked by
--    counting `coupon_redemptions` in one statement and inserting the
--    redemption in a later one; the only constraint on the table was
--    UNIQUE(order_id). Two checkouts fired together by one customer both
--    counted zero and both redeemed a single-use coupon. The counts now live
--    in a BEFORE INSERT trigger, so the limit is decided in the same
--    transaction as the order — and a refused redemption takes its order down
--    with it (D1 runs a batch as one transaction). RAISE(ABORT) carries a
--    stable message the checkout maps back to its existing error codes.
--
--    The index makes the per-user count in that trigger a lookup, not a scan.
--
-- 2. REFERRAL FREE DELIVERY is "one qualifying purchase per friend", but the
--    row that records the use was only written on DELIVERY. Every further
--    printer order placed before the first one arrived also shipped free.
--    The waiver is now recorded on the order at checkout, and
--    referralFreeDeliveryApplies reads it.
--
-- Additive only: the column defaults to 0, the index and trigger are new.

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_user
  ON coupon_redemptions(coupon_id, user_id);

CREATE TRIGGER IF NOT EXISTS trg_coupon_redemption_limits
BEFORE INSERT ON coupon_redemptions
BEGIN
  SELECT RAISE(ABORT, 'COUPON_PER_USER_LIMIT')
   WHERE (SELECT COUNT(*) FROM coupon_redemptions r
           WHERE r.coupon_id = NEW.coupon_id AND r.user_id = NEW.user_id)
         >= (SELECT c.max_per_user FROM coupons c WHERE c.id = NEW.coupon_id);
  SELECT RAISE(ABORT, 'COUPON_GLOBAL_LIMIT')
   WHERE (SELECT c.max_global FROM coupons c WHERE c.id = NEW.coupon_id) IS NOT NULL
     AND (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id = NEW.coupon_id)
         >= (SELECT c.max_global FROM coupons c WHERE c.id = NEW.coupon_id);
END;

ALTER TABLE orders ADD COLUMN referral_delivery_waived INTEGER NOT NULL DEFAULT 0;
