-- ============================================================================
-- 0226 — THE FILAMENT COUPONS ALREADY ISSUED WORK ON A SALE PRICE (owner,
-- 2026-11-06; docs/DECISIONS.md row 302).
--
-- 0225 reached the live database on 2026-11-05 and the sweep issued the first
-- week's coupons with `stacks = 0`, so a filament coupon refused eSUN PLA+, the
-- only filament it names, because eSUN PLA+ is on sale at $15. The owner chose:
-- the coupon works on the sale price, the customer pays 20,400 of 24,000 IQD.
-- New coupons take this from `filament.on_sale` in the programme's settings.
-- This file changes the ones already out, and no other coupon.
--
-- A spent coupon changes nothing here: its discount is frozen on its order.
--
-- RE-RUNNABLE: running it again finds nothing to change (scripts/migrate-check.mjs
-- --twice). Comments use `--` only: tests/d1CompoundLimit.test.ts strips no block
-- comment.
-- ============================================================================

UPDATE coupons
   SET stacks = 1
 WHERE stacks = 0
   AND reward_grant_id IN (SELECT id FROM reward_grants WHERE kind = 'filament_discount');
