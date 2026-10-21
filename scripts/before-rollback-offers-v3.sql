-- ============================================================================
-- BEFORE REDEPLOYING A BUILD OLDER THAN P1-05 (docs/DECISIONS.md row 267).
--
-- A build before P1-05 does not know that a PARTIAL offer (covers_all = 0) or
-- a SUBSTITUTED one (substitutions_json <> '[]') may be accepted only with the
-- customer's acknowledgement (accept_partial / accept_substitutions): it would
-- fund such an offer as if it were the whole job, as asked. Commitments fail
-- closed (C11), so before an emergency manual redeploy of an older commit run
-- this ONE statement against the live database:
--
--   npx wrangler d1 execute levonis-db-staging --remote \
--     --file scripts/before-rollback-offers-v3.sql
--
-- Every such pending offer becomes `superseded`: the older build answers
-- OFFER_STALE to any acceptance of it, and its merchant is shown «re-confirm,
-- edit or withdraw». No money is held by a pending offer, so nothing else
-- moves. After rolling forward again, the merchant's edit (PATCH) or
-- re-confirmation re-opens the offer under the build that knows its terms.
--
-- Idempotent; touches no offer that covers the whole request as asked.
-- ============================================================================
UPDATE community_offers
   SET state = 'superseded'
 WHERE state = 'pending'
   AND (covers_all = 0 OR substitutions_json <> '[]');
