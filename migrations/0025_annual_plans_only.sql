-- 0025 — PLUS and PRO are sold as annual plans only.
--
-- The owner's decision: "make the plan for pro and plus is only 12 months".
-- PRO already had a single 12-month plan (`pro_12mo`) and LEVO PRIME is annual
-- by mandate (`prime_12mo`, §5), so the only rows that change are the three
-- short PLUS durations seeded by migration 0002.
--
-- DEACTIVATED, NOT DELETED. A plan row is referenced by `memberships.plan_id`
-- for everyone who ever bought one, and by the invoice and price-history
-- trails behind those. Deleting the row would orphan a real purchase and lose
-- the record of what the member actually paid for. `active = 0` is the
-- supported way to retire a plan: worker/routes/memberships.ts refuses to sell
-- an inactive plan (`if (!plan.active …) PLAN_UNPRICED`), and
-- `GET /api/memberships/plans` only lists `active = 1`, so it disappears from
-- the storefront while every existing membership keeps resolving.
--
-- EXISTING MEMBERS ARE UNTOUCHED. Nothing here writes to `memberships`; a
-- member who is part-way through a 3-month PLUS keeps their row, their expiry
-- and their benefits until it lapses, and simply cannot renew into the same
-- short plan afterwards.
--
-- Idempotent: re-running sets an already-zero flag to zero.
UPDATE membership_plans
   SET active = 0
 WHERE tier = 'plus'
   AND duration_months < 12;

-- The annual plans stay sellable. Stated explicitly rather than assumed, so a
-- database where someone had already deactivated one of these comes back to a
-- known state instead of silently having no purchasable plan at all.
UPDATE membership_plans
   SET active = 1
 WHERE id IN ('plus_12mo', 'pro_12mo', 'prime_12mo')
   AND price_iqd IS NOT NULL;
