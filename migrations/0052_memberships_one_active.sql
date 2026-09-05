-- ---------------------------------------------------------------------------
-- 0052 — ONE active membership per account, enforced by the database, and the
--        value a membership carries into a later upgrade, stored explicitly.
-- ---------------------------------------------------------------------------
-- Found by the adversarial review of the memberships purchase path.
--
-- 1. ONE ACTIVE ROW. quotePurchase read the ledger with a plain SELECT and
--    subscribeUser then committed its batch; two purchases fired together
--    (different idempotency keys — the same plan twice, or PRIME and PRO at
--    once) both saw "no active membership" and both committed: two active
--    rows, and for an upgrade the proration credit was granted twice. The
--    closing `UPDATE … SET state='cancelled'` could not fail and nothing read
--    its row count. The rule "one membership at a time" now lives where a
--    race cannot get past it: a UNIQUE index on user_id over the active rows.
--    The second batch's INSERT violates it and the whole batch — the wallet
--    spend included — rolls back (D1 runs a batch as one transaction).
--
--    The index cannot be created while duplicates exist, so they are resolved
--    first, with the same precedence a customer would expect: per account the
--    active row with the latest expires_at stays (tie: the latest created_at;
--    a final tie on id so exactly one survives), the others become
--    'cancelled' — the only closed state the CHECK admits for a row that did
--    not run to its end. Nothing is deleted; the audit trail of what was
--    bought stays in the rows.
--
-- 2. CREDIT BASIS. price_paid_iqd stores what was CHARGED after an upgrade
--    credit, and the next proration read it — so PLUS 29,000 → PRIME 99,000 →
--    PRO 199,000 on one day charged 29,000 + 70,000 + 129,000 = 228,000 for a
--    199,000 PRO: the first credit was lost at the second hop.
--      credit_basis_iqd   — the value the membership represents for a later
--                           proration: the charge plus the credit applied
--                           (the plan's price for a purchase). NULL for rows
--                           written before this migration → the code falls
--                           back to price_paid_iqd. 0 for admin grants and
--                           gifts, which carry no purchase value forward.
--      credit_applied_iqd — the credit this purchase consumed, so a replayed
--                           confirmation tells the same story as the first.
--    Refunds keep using price_paid_iqd: it is what actually left the wallet.
--
-- Additive: two nullable/defaulted columns, one partial unique index, and a
-- literal-assignment UPDATE that is a no-op once the index holds.

UPDATE memberships SET state = 'cancelled'
 WHERE state = 'active'
   AND EXISTS (
     SELECT 1 FROM memberships o
      WHERE o.user_id = memberships.user_id
        AND o.state = 'active'
        AND o.id <> memberships.id
        AND (
             COALESCE(o.expires_at, '') > COALESCE(memberships.expires_at, '')
          OR (COALESCE(o.expires_at, '') = COALESCE(memberships.expires_at, '')
              AND o.created_at > memberships.created_at)
          OR (COALESCE(o.expires_at, '') = COALESCE(memberships.expires_at, '')
              AND o.created_at = memberships.created_at
              AND o.id > memberships.id)
        )
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_one_active
  ON memberships(user_id) WHERE state = 'active';

ALTER TABLE memberships ADD COLUMN credit_basis_iqd INTEGER;
ALTER TABLE memberships ADD COLUMN credit_applied_iqd INTEGER NOT NULL DEFAULT 0;
