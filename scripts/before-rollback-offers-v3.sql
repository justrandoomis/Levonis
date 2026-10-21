-- ============================================================================
-- BEFORE REDEPLOYING A BUILD OLDER THAN P1-05 (docs/DECISIONS.md row 267).
--
-- A build before P1-05 does not know that a PARTIAL offer (covers_all = 0) or
-- a SUBSTITUTED one (substitutions_json <> '[]') may be accepted only with the
-- customer's acknowledgement (accept_partial / accept_substitutions): it would
-- fund such an offer as if it were the whole job, as asked. It also ignores
-- those columns when a merchant edits an offer, so an edit of a `pending` or
-- `superseded` row there re-opens it as a whole offer at the partial price;
-- and its «send draft» drops a draft's `coverage` / `substitutions` keys and
-- sends it as a whole offer at the price the merchant set for a part.
-- Commitments fail closed (C11), so before an emergency manual redeploy of an
-- older commit run these THREE statements against the live database:
--
--   npx wrangler d1 execute levonis-db-staging --remote \
--     --file scripts/before-rollback-offers-v3.sql
--
-- 1. Every such offer still open (`pending` or `superseded`) becomes
--    `withdrawn`. That state is terminal in every build: no edit, re-confirm
--    or acceptance re-opens it (the older build answers OFFER_NOT_AVAILABLE),
--    and it frees the merchant's one-live-offer slot, so the merchant may make
--    a NEW offer on the whole job under the older build. No money is held by
--    an open offer, so nothing else moves.
-- 2. Every request such an offer was on has its advertised `offer_count`
--    recounted by the one rule every offer move uses (`offerCountStatement`:
--    pending or accepted), so the board stops advertising offers that are
--    gone. Its `updated_at` is not touched (the revision fences read it).
-- 3. Every draft that carries a coverage or a substitution is deleted, since
--    the older build would send it as a whole offer. Its merchant writes the
--    offer again.
--
-- Idempotent; touches no offer and no draft that covers the whole request as
-- asked. A draft whose payload is not valid JSON carries no coverage and is
-- left alone. ORDERS already accepted from such an offer are not touched here:
-- list them first with the read-only scripts/before-rollback-open-orders-v3.sql
-- and follow each by hand (docs/CLOUDFLARE_BUILDS_RUNBOOK.md).
-- ============================================================================
UPDATE community_offers
   SET state = 'withdrawn',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE state IN ('pending', 'superseded')
   AND (COALESCE(covers_all, 1) = 0 OR COALESCE(substitutions_json, '[]') <> '[]');

UPDATE community_requests
   SET offer_count = (SELECT COUNT(*) FROM community_offers o
                       WHERE o.request_id = community_requests.id AND o.state IN ('pending', 'accepted'))
 WHERE id IN (SELECT request_id FROM community_offers
               WHERE state = 'withdrawn'
                 AND (COALESCE(covers_all, 1) = 0 OR COALESCE(substitutions_json, '[]') <> '[]'));

DELETE FROM community_offer_drafts
 WHERE CASE WHEN json_valid(payload_json)
            THEN json_type(payload_json, '$.coverage') = 'array'
              OR COALESCE(json_array_length(payload_json, '$.substitutions'), 0) > 0
            ELSE 0 END;
