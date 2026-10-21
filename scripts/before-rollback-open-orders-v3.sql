-- ============================================================================
-- READ ONLY — RUN BEFORE REDEPLOYING A BUILD OLDER THAN P1-05, BESIDE
-- scripts/before-rollback-offers-v3.sql (docs/DECISIONS.md row 267).
--
-- That script withdraws OPEN partial or substituted offers. An order already
-- accepted from one stays: its money is held at the price of what was agreed
-- (some parts, or a substitute), and the agreement is in its
-- `request_snapshot.agreement` and `offer_snapshot.substitutions`. An older
-- build's order screen and admin view do not read the agreement, so both sides
-- would see the whole request as the job. This lists every such order still
-- running; nothing is changed:
--
--   npx wrangler d1 execute levonis-db-staging --remote \
--     --file scripts/before-rollback-open-orders-v3.sql
--
-- An empty answer: nothing to follow. Otherwise each order listed is followed
-- by hand until it ends (the customer and the workshop are told what was
-- agreed), or the rollback waits until none is open.
-- ============================================================================
SELECT o.id, o.state, o.request_id, o.price_iqd, o.created_at,
       CASE WHEN json_valid(o.request_snapshot) THEN json_extract(o.request_snapshot, '$.agreement.covers_all') END AS covers_all,
       CASE WHEN json_valid(o.offer_snapshot) THEN COALESCE(json_array_length(o.offer_snapshot, '$.substitutions'), 0) ELSE 0 END AS substitutions
  FROM community_orders o
 WHERE o.state NOT IN ('completed', 'cancelled', 'refunded')
   AND (CASE WHEN json_valid(o.request_snapshot) THEN json_extract(o.request_snapshot, '$.agreement.covers_all') = 0 ELSE 0 END
        OR CASE WHEN json_valid(o.offer_snapshot) THEN COALESCE(json_array_length(o.offer_snapshot, '$.substitutions'), 0) > 0 ELSE 0 END)
 ORDER BY o.created_at;
