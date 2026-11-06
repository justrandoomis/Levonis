-- ============================================================================
-- 0229 — THE POINTS SHOP SELLS PRODUCTS (owner, 2026-11-05; docs/DECISIONS.md row 299).
--
-- The owner's brief, in their words:
--   «for redeem point make the 3000 point can redeem 1 coupon of free 5000 shipping
--    free on order above 100k. 23000 points to redeem filament of esun pla plus
--    beige , 23100 points to redeem filament of esun pla plus black and 23250
--    points to redeem filament of esun pla plus cold white»
--
-- WHAT THIS FILE LANDS. A product swapped for points is an ordinary gift
-- (gift_entitlements, mode 'product', reason 'reward', born `redeemed`), so the
-- cart, the checkout and the 0175 triggers need nothing new: the product is 0 IQD
-- and the customer pays for delivery only. A gift only has to remember what was
-- paid for it, so a cancel by the team can give the points back, once:
--   points_spent   what the swap cost; 0 on every other gift
--   points_tx_id   its POINT withdrawal (wtx_rwshop_<gift id>)
--   shop_item_id   which row of `rewardProgramConfig.shop.items` it was bought from
-- The list of products is a setting, not a table: it is the owner's terms, beside
-- the coupons' prices.
--
-- ADDITIVE ONLY: three columns and one index. No existing row changes, and every
-- gift that already exists reads points_spent 0 and shop_item_id NULL.
--
-- NO UNIQUE INDEX on (user_id, shop_item_id): an order cancelled by any door hands
-- its gift back to `redeemed` (0175 trg_orders_gift_cancelled), and a customer may
-- by then hold another of the same product. A unique index would make that trigger
-- fail, and with it the cancel. «One at a time» is the swap's own guard, in its batch.
--
-- RE-RUNNABLE as this repo's rules allow: D1's bookkeeping runs a file once, and
-- scripts/migrate-check.mjs --twice leaves ALTER TABLE ADD COLUMN to that bookkeeping.
--
-- DEPLOY-AHEAD (CLAUDE.md rule 2): every reader tolerates the absence of these
-- columns. Before this file the hub offers no product, the swap answers 503
-- REWARDS_NOT_INSTALLED as the coupon swap does before 0220, an ordinary grant names
-- none of these columns, and a cancel reads 0 points to give back.
-- Comments use `--` only: tests/d1CompoundLimit.test.ts strips no block comment.
-- ============================================================================

ALTER TABLE gift_entitlements ADD COLUMN points_spent INTEGER NOT NULL DEFAULT 0 CHECK (points_spent >= 0);
ALTER TABLE gift_entitlements ADD COLUMN points_tx_id TEXT;
ALTER TABLE gift_entitlements ADD COLUMN shop_item_id TEXT;

-- The swap's guard and the hub's «held» read: what this customer holds of a shop item.
CREATE INDEX IF NOT EXISTS idx_gift_entitlements_shop_item
  ON gift_entitlements(user_id, shop_item_id, state) WHERE shop_item_id IS NOT NULL;
