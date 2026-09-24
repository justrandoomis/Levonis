-- ============================================================================
--  0116 — A CUSTOMER ACCEPTS THE OFFER THEY SAW, ON THE JOB THE MERCHANT
--         PRICED, AND A FAILED PAYMENT NEVER LOCKS THE OFFER FOR GOOD.
-- ============================================================================
-- NONDESTRUCTIVE: three ADD COLUMNs with constant defaults, one index swapped
-- for a narrower one over the SAME rows, two plain indexes, and one UPDATE that
-- recomputes a DERIVED counter from the rows it counts. No table is rebuilt,
-- no CHECK is touched, and no money, order, offer or escrow row is rewritten.
--
-- ---------------------------------------------------------------------------
--  1. VERSIONS — `community_offers.revision`, `community_requests.revision`,
--     `community_offers.request_revision`
-- ---------------------------------------------------------------------------
-- Audit 03 §10 B: a merchant could PATCH the price of a pending offer between
-- the customer reading it and pressing «اقبل العرض», and the hold was taken at
-- the NEW price — the confirmation dialog showed one number and the wallet
-- paid another. Audit 03 §10 K: re-publishing a request rewrote the job (PLA×1
-- became resin×50 ultra) under offers priced for the old one, and nothing told
-- anyone.
--
--   * `community_offers.revision` is the offer's own version. Every edit by
--     its merchant, and every re-confirmation, writes revision + 1. Accepting
--     names the revision AND the price the customer confirmed; the acceptance
--     batch only matches that exact version (worker/routes/marketplace.ts).
--   * `community_requests.revision` is the JOB's version. It moves when a
--     PUBLISHED request's terms change (a re-publish that changes the spec,
--     an attachment added or removed while it takes offers).
--   * `community_offers.request_revision` is the job version the offer
--     PRICED. An offer whose `request_revision` is behind its request's
--     `revision` is STALE: it stays the merchant's live offer, it cannot be
--     accepted, and it becomes acceptable again only when its merchant
--     re-confirms it (which writes the current revision onto it).
--
-- Every existing row reads revision 1 on both sides, i.e. "priced the job as
-- it stands" — which is the only honest reading of rows written before
-- anyone kept a version.
--
-- ---------------------------------------------------------------------------
--  2. ONE LIVE ORDER PER OFFER, NOT ONE ORDER PER OFFER FOREVER
-- ---------------------------------------------------------------------------
-- Audit 03 §10 A / 04 B12: accepting an offer the customer's wallet could not
-- cover left a CANCELLED community order behind that still held the offer's
-- id, and `idx_community_orders_offer` (0031) is a FULL unique index — so the
-- customer's retry after topping up (the normal path) failed with UNIQUE
-- constraint failed: community_orders.offer_id, a 500, and a request stuck in
-- `offer_selected` that no other offer could be accepted on either.
--
-- The acceptance no longer writes an order it cannot fund (it reserves the
-- money first, then writes offer, order and escrow in ONE batch). But the
-- cancelled rows the old path left on the live database are still there, and
-- each of them still locks a pending offer. So the rule becomes what it was
-- always meant to be — one LIVE order per offer — and a cancelled attempt no
-- longer counts. The old index guaranteed full uniqueness, so no existing set
-- of rows can violate the narrower one; the swap cannot fail on live data.
-- (`DROP INDEX IF EXISTS` has precedent in 0064 and 0083; this index was
-- created by CREATE UNIQUE INDEX, not inline, so it is droppable.)
--
-- ---------------------------------------------------------------------------
--  3. THE REPUTATION GATES NEED AN INDEX
-- ---------------------------------------------------------------------------
-- Completing an order (+10) and deciding a dispute (0 / −20) now write their
-- reputation event only when no event of that kind exists for that community
-- order yet — the gate that makes a replayed admin decision (04 B3) and a
-- double «تأكيد الاستلام» (04 B9) count once. This index answers that NOT
-- EXISTS without walking a merchant's whole history. It is NOT unique: rows
-- the bugs already doubled on the live database must not fail the migration.
--
-- ---------------------------------------------------------------------------
--  3b. VIEWER LINKS ARE REVOKED BY REQUEST
-- ---------------------------------------------------------------------------
-- Audit 03 §10 F: `model_view_tokens.revoked_at` existed since 0045 and
-- nothing wrote it, so a 3D-preview link outlived the request it showed. The
-- lifecycle now revokes every link on a request when it closes (cancelled,
-- removed, expired, completed) and the losing merchants' links at acceptance —
-- all `WHERE request_id = ?`, which this index answers.
--
-- ---------------------------------------------------------------------------
--  4. THE ADVERTISED OFFER COUNT, RECOMPUTED FROM THE OFFERS
-- ---------------------------------------------------------------------------
-- Audit 03 §10 H: withdrawing an offer never decremented `offer_count`, and a
-- re-offer incremented it again, so the board advertised offers that did not
-- exist. From this release every batch that moves an offer recomputes the
-- count in the same batch; this one UPDATE heals the rows the old code left
-- wrong. It writes only rows whose stored count differs from the truth, and
-- the truth is the same definition the admin reject route already used: live
-- offers, `state IN ('pending','accepted')`.
-- ============================================================================

ALTER TABLE community_requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE community_offers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE community_offers ADD COLUMN request_revision INTEGER NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS idx_community_orders_offer;
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_orders_offer_live
  ON community_orders(offer_id)
  WHERE state <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_merchant_reputation_events_community_order
  ON merchant_reputation_events(community_order_id, kind)
  WHERE community_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_model_view_tokens_request
  ON model_view_tokens(request_id);

UPDATE community_requests
   SET offer_count = (SELECT COUNT(*) FROM community_offers o
                       WHERE o.request_id = community_requests.id
                         AND o.state IN ('pending','accepted'))
 WHERE offer_count <> (SELECT COUNT(*) FROM community_offers o
                        WHERE o.request_id = community_requests.id
                          AND o.state IN ('pending','accepted'));
