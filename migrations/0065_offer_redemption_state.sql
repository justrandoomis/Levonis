-- ---------------------------------------------------------------------------
-- 0065 — an offer redemption has a lifecycle: active, or released.
-- Owner decision 4 (docs/BUNDLES_MYSTERY.md §17).
-- ---------------------------------------------------------------------------
-- WHAT THE OWNER RULED. A revealed mystery allocation NEVER restores its
-- redemption slot and a customer may not cancel after a reveal (both already
-- true); a genuinely cancelled or refunded NORMAL BUNDLE order MAY restore
-- its slot; a failed or expired checkout must not permanently consume a
-- bundle entitlement; and no path may enable a free mystery re-roll.
--
-- WHAT WAS ALREADY TRUE. A failed checkout consumes nothing: the redemption
-- row is written INSIDE the committing batch, so a batch that aborts writes no
-- row at all. And `MYSTERY_REVEALED_NO_CANCEL` already refuses the customer's
-- own cancel once any allocation on the order is revealed. Neither is touched.
--
-- WHAT WAS MISSING. `offer_redemptions` was an append-only tally: the limit
-- trigger sums `qty` over every row that exists, with no lifecycle, so a
-- cancelled order's row counts against the customer for ever and no cancel
-- could give a slot back without giving one back to mystery too.
--
-- THE STATE. `active` counts against the limit; `released` does not. Existing
-- rows backfill to `active`, so nothing a customer has already spent silently
-- comes back on migrate. `released_at` records when, for the audit.
ALTER TABLE offer_redemptions ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE offer_redemptions ADD COLUMN released_at TEXT;

-- The release and re-claim statements are keyed on `order_id`, which had no
-- index of its own — every cancellation would otherwise scan the table.
CREATE INDEX IF NOT EXISTS idx_offer_redemptions_order
  ON offer_redemptions(order_id);

-- The limit trigger must now count ACTIVE rows only. 0060 created it with
-- `IF NOT EXISTS` and SQLite has no ALTER TRIGGER, so editing 0060 in place
-- would change nothing on a database that already has it: it has to be
-- dropped and re-created. The body below is 0060's, verbatim, with
-- `AND r.state = 'active'` added to both sums and a state guard in front.
DROP TRIGGER IF EXISTS trg_offer_redemption_limits;
CREATE TRIGGER trg_offer_redemption_limits
BEFORE INSERT ON offer_redemptions
BEGIN
  -- SQLite cannot add a CHECK to an existing table, so the domain is enforced
  -- here: only these two states exist, and a typo aborts rather than silently
  -- creating a third state that counts against nothing.
  SELECT RAISE(ABORT, 'OFFER_REDEMPTION_STATE') WHERE NEW.state NOT IN ('active', 'released');
  SELECT RAISE(ABORT, 'OFFER_PER_USER_LIMIT') WHERE EXISTS (
    SELECT 1 FROM offer_limits l
     WHERE l.subject_type = NEW.subject_type AND l.subject_id = NEW.subject_id
       AND l.max_per_user IS NOT NULL
       AND NEW.qty + COALESCE((SELECT SUM(r.qty) FROM offer_redemptions r
             WHERE r.subject_type = NEW.subject_type AND r.subject_id = NEW.subject_id
               AND r.user_id = NEW.user_id AND r.state = 'active'), 0) > l.max_per_user);
  SELECT RAISE(ABORT, 'OFFER_GLOBAL_LIMIT') WHERE EXISTS (
    SELECT 1 FROM offer_limits l
     WHERE l.subject_type = NEW.subject_type AND l.subject_id = NEW.subject_id
       AND l.max_global IS NOT NULL
       AND NEW.qty + COALESCE((SELECT SUM(r.qty) FROM offer_redemptions r
             WHERE r.subject_type = NEW.subject_type AND r.subject_id = NEW.subject_id
               AND r.state = 'active'), 0) > l.max_global);
END;

-- RE-CLAIM IS LIMIT-CHECKED TOO. A cancelled order can be RE-OPENED — the
-- admin transition table allows cancelled -> pending/confirmed/processing, and
-- so does the stage machine — and a re-opened order must take its slot back,
-- or the customer keeps the goods AND the entitlement. But taking it back is
-- an insertion as far as the limit is concerned: between the cancel and the
-- re-open the customer may have spent the freed slot elsewhere. The BEFORE
-- INSERT trigger cannot see an UPDATE, so re-activation gets its own arm with
-- the same two sums, excluding the row being re-activated (`r.id <> NEW.id`)
-- so it never counts itself. An over-limit re-claim aborts the re-open batch,
-- which is the honest answer: that entitlement is genuinely gone.
CREATE TRIGGER IF NOT EXISTS trg_offer_redemption_reclaim
BEFORE UPDATE OF state ON offer_redemptions
WHEN NEW.state = 'active' AND OLD.state <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'OFFER_PER_USER_LIMIT') WHERE EXISTS (
    SELECT 1 FROM offer_limits l
     WHERE l.subject_type = NEW.subject_type AND l.subject_id = NEW.subject_id
       AND l.max_per_user IS NOT NULL
       AND NEW.qty + COALESCE((SELECT SUM(r.qty) FROM offer_redemptions r
             WHERE r.subject_type = NEW.subject_type AND r.subject_id = NEW.subject_id
               AND r.user_id = NEW.user_id AND r.state = 'active' AND r.id <> NEW.id), 0) > l.max_per_user);
  SELECT RAISE(ABORT, 'OFFER_GLOBAL_LIMIT') WHERE EXISTS (
    SELECT 1 FROM offer_limits l
     WHERE l.subject_type = NEW.subject_type AND l.subject_id = NEW.subject_id
       AND l.max_global IS NOT NULL
       AND NEW.qty + COALESCE((SELECT SUM(r.qty) FROM offer_redemptions r
             WHERE r.subject_type = NEW.subject_type AND r.subject_id = NEW.subject_id
               AND r.state = 'active' AND r.id <> NEW.id), 0) > l.max_global);
END;
