-- ============================================================================
--  0134 — REVIEW W2-5: THE PLATFORM'S COST STAYS CONFIDENTIAL, THE MERCHANT'S
--         PRIVATE PHONE STAYS PRIVATE, AND THE OLD PAYOUT LEDGER IS SEALED.
-- ============================================================================
-- Stream W5-C. Additive and idempotent: three UPDATEs over existing rows (a
-- re-run matches nothing it already changed), two DROP TRIGGER IF EXISTS and
-- two CREATE TRIGGER IF NOT EXISTS. No row is deleted, no money row is
-- written, no compound SELECT anywhere (the live D1 caps them at 5 terms).
--
-- 1. THE ESTIMATE'S COST BREAKDOWN LEAVES EVERY STORED SNAPSHOT. 0130 backfilled
--    `community_request_revisions.estimate` from `community_print_requests.
--    estimate` — the RAW estimate, with the platform's cost lines, cost, floor
--    and margin — and accepting an offer copied a revision's estimate into
--    `community_orders.request_snapshot`, which the order screen returns to
--    BOTH parties (review W2-5 p6). The code now strips them on write and on
--    read (worker/lib/requestRevisions.ts `publicEstimate`); this removes them
--    from the rows already written. `community_print_requests.estimate` keeps
--    the raw figures: it is the platform's own record, never returned as is.
--
-- 2. THE MERCHANT'S CONTACT IN AN ORDER IS THE STORE'S PUBLISHED PHONE ONLY.
--    `contact_snapshot.merchant.phone` fell back to `community_merchants.phone`
--    (the account's private phone) when the store had published none (review
--    W2-5 #7). A snapshot whose merchant phone IS that private phone and is not
--    the store's current published phone is cleared: the customer sees no
--    phone and uses the order's thread, as for a store that publishes none.
--
-- 3. THE OLD PAYOUT LEDGER IS READ-ONLY IN THE DATABASE TOO. 0121 kept
--    `merchant_payout_ledger` for history and mirrored any write the OLD code
--    made during the deploy window into the new ledger. That window is long
--    closed and no Worker code writes the table (tests/merchantLedgerSchema
--    .test.ts); the mirrors are replaced by triggers that REFUSE an insert
--    and any update — except the one write the platform still makes to it:
--    worker/lib/orderDeletion.ts unlinking a deleted order's id (order_id →
--    NULL, nothing else changed), which moves no money.
-- ============================================================================

-- 1a. The revisions.
UPDATE community_request_revisions
   SET estimate = json_remove(estimate, '$.cost_lines', '$.cost_iqd', '$.floor_iqd', '$.margin_percent')
 WHERE json_valid(estimate)
   AND json_type(estimate) = 'object'
   AND (json_type(estimate, '$.cost_lines') IS NOT NULL
     OR json_type(estimate, '$.cost_iqd') IS NOT NULL
     OR json_type(estimate, '$.floor_iqd') IS NOT NULL
     OR json_type(estimate, '$.margin_percent') IS NOT NULL);

-- 1b. The orders' copies of them.
UPDATE community_orders
   SET request_snapshot = json_remove(request_snapshot,
         '$.estimate.cost_lines', '$.estimate.cost_iqd', '$.estimate.floor_iqd', '$.estimate.margin_percent')
 WHERE json_valid(request_snapshot)
   AND json_type(request_snapshot, '$.estimate') = 'object'
   AND (json_type(request_snapshot, '$.estimate.cost_lines') IS NOT NULL
     OR json_type(request_snapshot, '$.estimate.cost_iqd') IS NOT NULL
     OR json_type(request_snapshot, '$.estimate.floor_iqd') IS NOT NULL
     OR json_type(request_snapshot, '$.estimate.margin_percent') IS NOT NULL);

-- 2. The merchant's private phone out of the contact snapshots.
UPDATE community_orders
   SET contact_snapshot = json_set(contact_snapshot, '$.merchant.phone', '')
 WHERE json_valid(contact_snapshot)
   AND json_type(contact_snapshot, '$.merchant') = 'object'
   AND COALESCE(json_extract(contact_snapshot, '$.merchant.phone'), '') <> ''
   AND json_extract(contact_snapshot, '$.merchant.phone') =
       (SELECT m.phone FROM community_merchants m WHERE m.id = community_orders.merchant_id)
   AND json_extract(contact_snapshot, '$.merchant.phone') IS NOT
       (SELECT NULLIF(s.contact_phone, '') FROM merchant_stores s WHERE s.merchant_id = community_orders.merchant_id);

-- 3. The old ledger, sealed.
DROP TRIGGER IF EXISTS trg_mpl_mirror_insert;
DROP TRIGGER IF EXISTS trg_mpl_mirror_update;

CREATE TRIGGER IF NOT EXISTS trg_mpl_no_insert
BEFORE INSERT ON merchant_payout_ledger
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'MERCHANT_PAYOUT_LEDGER_READ_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_mpl_no_update
BEFORE UPDATE ON merchant_payout_ledger
FOR EACH ROW
WHEN NOT (
      NEW.order_id IS NULL AND OLD.order_id IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.merchant_id IS OLD.merchant_id AND NEW.kind IS OLD.kind
  AND NEW.amount_iqd IS OLD.amount_iqd AND NEW.state IS OLD.state
  AND NEW.community_order_id IS OLD.community_order_id AND NEW.escrow_id IS OLD.escrow_id
  AND NEW.note IS OLD.note AND NEW.admin_id IS OLD.admin_id
  AND NEW.idempotency_key IS OLD.idempotency_key AND NEW.created_at IS OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'MERCHANT_PAYOUT_LEDGER_READ_ONLY');
END;
