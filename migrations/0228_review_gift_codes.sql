-- ============================================================================
-- 0228 — «قيّم طابعتك»: THE GIFT CODE (owner, 2026-11-05; docs/DECISIONS.md row
-- 301; rewards policy version 7, chapter 8).
--
-- The owner's road, in their words: «from placing gift 1 2 3 4 5 to system
-- reviwes from 1-100 to give admin to user code to redeem his gift»; «every 20
-- score the level appear and he can see the gift of level and select then
-- confirm then add to cart as free gift and then place order and he will pay
-- for delivery only».
--
-- WHAT THIS FILE LANDS, and nothing else:
--   review_rewards.final_score       the 1..100 the admin confirmed. The CHECK on
--                                    quality_score keeps meaning a LEVEL (1..5)
--                                    for the rows approved before this file.
--   review_rewards.redeem_code       the code the admin hands to the customer;
--                                    UNIQUE among the rows that hold one. A code
--                                    regenerated while unredeemed overwrites this
--                                    column, so the old one stops existing.
--   review_rewards.code_issued_at    when that code was made.
--   review_rewards.code_redeemed_at  when its owner wrote it; the gift is born in
--                                    the same batch.
--   gift_entitlements.choice_scope   'level': the customer chooses among the
--                                    items of `level`, as every gift before this
--                                    file does. 'up_to': among every level from
--                                    1 to `level`.
--
-- ADDITIVE ONLY: four nullable columns, one with a default, one partial index.
-- No existing row changes meaning. A reward approved before this file holds no
-- code and keeps its entitlement and its old path; every gift before this file
-- reads 'level'.
--
-- RE-RUNNABLE: D1's migration table runs this file once, and the only statement
-- scripts/migrate-check.mjs --twice re-executes is the IF NOT EXISTS index.
--
-- DEPLOY-AHEAD (CLAUDE.md rule 2): every reader tolerates these columns' absence
-- (worker/lib/gifts/reviewCode.ts says how): the queue and the hub read them apart
-- and treat a missing column as no code, an approval on an older database grants
-- the old level gift, and POST /api/rewards/program/gift-code answers
-- GIFT_CODE_INVALID as it does for any unknown code.
-- Comments use `--` only: tests/d1CompoundLimit.test.ts strips no block comment.
-- ============================================================================

ALTER TABLE review_rewards ADD COLUMN final_score INTEGER CHECK (final_score IS NULL OR final_score BETWEEN 1 AND 100);
ALTER TABLE review_rewards ADD COLUMN redeem_code TEXT;
ALTER TABLE review_rewards ADD COLUMN code_issued_at TEXT;
ALTER TABLE review_rewards ADD COLUMN code_redeemed_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_rewards_redeem_code ON review_rewards(redeem_code) WHERE redeem_code IS NOT NULL;

ALTER TABLE gift_entitlements ADD COLUMN choice_scope TEXT NOT NULL DEFAULT 'level' CHECK (choice_scope IN ('level', 'up_to'));
