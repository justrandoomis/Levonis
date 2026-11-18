-- PRINTER SERVICES, PHASE 5 — the Levo Care PART OFFER (owner request 2026-11-18; DECISIONS row 358).
--
-- The customer applies for Levo Care on /warranty; staff answer in the claim thread with a discount on one
-- store PART (an ordinary product). He adds the part to the cart and orders it like any part; the discount applies
-- by itself, on ONE unit of that product, once, for that account only.
--
-- (1) care_part_grants: one row per offer. It names the claim, the claimant, the device's ROOT unit (Care and its
--     caps follow the device), the product, the percent, the money ceiling left on the device when it was issued,
--     its end (14 days) and its revocation. The discount itself is carried by ONE personal coupon (coupon_id):
--     scope product, one unit, one use — so every door that already prices, records, releases and reports a coupon
--     discount does the same for this one. «Used» is never stored here: it is the coupon's live redemption
--     (coupon_redemption_extras, or coupon_redemptions), so a cancelled order gives the offer back by the existing
--     release triggers and nothing can drift.
-- (2) claim_messages.part_grant_id: the staff message that carries the offer (the thread draws it as a product card).
-- (3) trg_coupon_extra_limits (0225) REPLACED: an order may now spend, beside its typed code, the coupon of a live
--     Care part offer. Same body and the same answers as 0225, plus: a coupon without reward_grant_id is accepted
--     only when it is the coupon of a part offer that is neither revoked nor ended. A promo code or a trade-in
--     credit reaching the extras is still refused.
-- (4) Two guards on the offers themselves, inside the issuing batch: one live offer per (claim, product), at most
--     five live offers per claim. Live = not revoked, not ended, its coupon not spent on a live order.
--
-- Additive; no foreign keys. Every reader tolerates its absence (worker/lib/carePartGrants.ts). Re-runnable: every
-- CREATE says IF NOT EXISTS, the replaced trigger is dropped first. Comments use `--` only.
CREATE TABLE IF NOT EXISTS care_part_grants (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- The device's ROOT unit (a replacement resolves to the unit first sold).
  entitlement_unit_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  coupon_id TEXT NOT NULL UNIQUE,
  discount_pct INTEGER NOT NULL CHECK (discount_pct BETWEEN 1 AND 90),
  -- What was left of the device's Care money ceiling when the offer was issued; NULL = the terms set no ceiling.
  max_discount_iqd INTEGER CHECK (max_discount_iqd IS NULL OR max_discount_iqd >= 0),
  -- The desk found misuse (the only way Care is given while the warranty is in force).
  misuse INTEGER NOT NULL DEFAULT 0 CHECK (misuse IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_care_part_grants_claim ON care_part_grants(claim_id);
CREATE INDEX IF NOT EXISTS idx_care_part_grants_user_product ON care_part_grants(user_id, product_id);
CREATE INDEX IF NOT EXISTS idx_care_part_grants_unit ON care_part_grants(entitlement_unit_id);

ALTER TABLE claim_messages ADD COLUMN part_grant_id TEXT;

-- One live offer per (claim, product), five live offers per claim — decided here, inside the issuing batch,
-- so two clicks at once cannot both pass.
CREATE TRIGGER IF NOT EXISTS trg_care_part_grant_limits
BEFORE INSERT ON care_part_grants
BEGIN
  SELECT RAISE(ABORT, 'CARE_PART_ALREADY_OFFERED')
   WHERE EXISTS (SELECT 1 FROM care_part_grants g
                  WHERE g.claim_id = NEW.claim_id AND g.product_id = NEW.product_id
                    AND g.revoked_at IS NULL AND g.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    AND NOT EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = g.coupon_id AND r.state = 'active')
                    AND NOT EXISTS (SELECT 1 FROM coupon_redemption_extras x WHERE x.coupon_id = g.coupon_id AND x.state = 'active'));
  SELECT RAISE(ABORT, 'CARE_PART_LIMIT')
   WHERE (SELECT COUNT(*) FROM care_part_grants g
           WHERE g.claim_id = NEW.claim_id
             AND g.revoked_at IS NULL AND g.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             AND NOT EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = g.coupon_id AND r.state = 'active')
             AND NOT EXISTS (SELECT 1 FROM coupon_redemption_extras x WHERE x.coupon_id = g.coupon_id AND x.state = 'active')) >= 5;
END;

-- An offer is written once: only its revocation is ever recorded, and only once.
CREATE TRIGGER IF NOT EXISTS trg_care_part_grant_frozen
BEFORE UPDATE ON care_part_grants
WHEN OLD.revoked_at IS NOT NULL
  OR NEW.id IS NOT OLD.id OR NEW.claim_id IS NOT OLD.claim_id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.entitlement_unit_id IS NOT OLD.entitlement_unit_id OR NEW.product_id IS NOT OLD.product_id
  OR NEW.coupon_id IS NOT OLD.coupon_id OR NEW.discount_pct IS NOT OLD.discount_pct
  OR NEW.max_discount_iqd IS NOT OLD.max_discount_iqd OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'CARE_PART_GRANT_FROZEN');
END;

-- The 0225 trigger, replaced: the same three answers, and the coupon of a live Care part offer may ride beside
-- the order's own code.
DROP TRIGGER IF EXISTS trg_coupon_extra_limits;

CREATE TRIGGER IF NOT EXISTS trg_coupon_extra_limits
BEFORE INSERT ON coupon_redemption_extras
BEGIN
  SELECT RAISE(ABORT, 'COUPON_INACTIVE')
   WHERE COALESCE((SELECT c.active FROM coupons c WHERE c.id = NEW.coupon_id), 0) <> 1
      OR ((SELECT c.reward_grant_id FROM coupons c WHERE c.id = NEW.coupon_id) IS NULL
          AND NOT EXISTS (SELECT 1 FROM care_part_grants g
                           WHERE g.coupon_id = NEW.coupon_id AND g.revoked_at IS NULL
                             AND g.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
  SELECT RAISE(ABORT, 'COUPON_NOT_YOURS')
   WHERE (SELECT c.assigned_user_id FROM coupons c WHERE c.id = NEW.coupon_id) IS NOT NULL
     AND (SELECT c.assigned_user_id FROM coupons c WHERE c.id = NEW.coupon_id) <> NEW.user_id;
  SELECT RAISE(ABORT, 'COUPON_GLOBAL_LIMIT')
   WHERE EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = NEW.coupon_id AND r.state = 'active')
      OR EXISTS (SELECT 1 FROM coupon_redemption_extras x WHERE x.coupon_id = NEW.coupon_id AND x.state = 'active');
END;

-- A Care part offer's coupon is spent only beside an order's own code (the extras), never as the order's code:
-- its code is never shown, and `coupon_redemptions` stays «the order's coupon» for every reader.
CREATE TRIGGER IF NOT EXISTS trg_care_part_coupon_not_primary
BEFORE INSERT ON coupon_redemptions
WHEN EXISTS (SELECT 1 FROM care_part_grants g WHERE g.coupon_id = NEW.coupon_id)
BEGIN
  SELECT RAISE(ABORT, 'COUPON_INACTIVE');
END;
