-- ============================================================================
--  0121 — «دفتر التاجر» : AN APPEND-ONLY MERCHANT LEDGER, AND PAYOUTS THAT
--         ARE REQUESTS (merchant platform wave 2, stream W2-B).
-- ============================================================================
-- ADDITIVE: two new tables, one view, triggers, and a DETERMINISTIC backfill.
-- Nothing is dropped; `merchant_payout_ledger` is kept, read-only for the code
-- (no route writes it after this wave), for history and rollback. A re-run
-- changes nothing: every CREATE is IF NOT EXISTS and every backfill INSERT is
-- guarded by NOT EXISTS over the very table it writes.
--
-- ---------------------------------------------------------------------------
--  WHY A NEW TABLE (docs/MERCHANT_PLATFORM.md §4.3, audit 02 §6 and §10 P1.5)
-- ---------------------------------------------------------------------------
-- The old ledger MUTATES `state` in place (pending → available → reversed), so
-- nothing in it can say when money moved or express a payout that is asked
-- for, reserved, and later paid or refused. Its kind/state CHECKs cannot be
-- altered in SQLite. The new ledger never changes a row:
--
--   · a line is written once — UPDATE and DELETE are refused by triggers;
--   · money lives in four BUCKETS: pending → available → reserved → paid;
--   · a bucket MOVE is two rows that sum to zero (release, payout, payout
--     reversal), so every balance is a SUM and the merchant's total
--     entitlement (receivable) is the sum of every row;
--   · each business event has one `event_key` (UNIQUE), so a replay writes
--     nothing twice;
--   · the kind decides the sign and the bucket (CHECK), so a positive
--     commission or a release into `reserved` cannot be written at all;
--   · no NEW line may take a bucket below zero (trigger) — the only exception
--     is a customer refund clawing back money already released, which the
--     platform owes the customer whatever the merchant withdrew (a debt the
--     merchant's next sales settle; a payout is refused while it lasts).
--
-- Kinds:  sale_gross (+) · commission (−) · delivery_fee (+)       a store sale
--         refund (−) · commission_refund (+) · delivery_refund (−) its reversal
--         escrow_release (+) with commission (−)                   a custom order
--         adjustment (±, a reason required)                         admin / legacy
--         release (pending −, available +)                          the owner's rule
--         payout (available −/reserved +, then reserved −/paid +)   a payout
--         payout_reversal (reserved −, available +)                 failed / cancelled
--
-- ---------------------------------------------------------------------------
--  THE BACKFILL AND WHY IT IS EXACT
-- ---------------------------------------------------------------------------
-- The wave-1 balance of the old table was (worker/lib/escrowOps.ts before this
-- wave):   pending   = Σ amount WHERE state = 'pending'
--          available = Σ amount WHERE state = 'available' OR kind = 'payout'
--          paid      = Σ amount WHERE kind = 'payout'   (negative)
-- Every old row becomes lines whose bucket sums equal THAT ROW'S OWN share of
-- those three figures, so every merchant's pending, available and |paid| are
-- identical before and after (tests/merchantLedgerBackfill.test.ts; the admin
-- `GET /api/admin/community/ledger/parity` re-proves it on the live data):
--
--   sale_credit pending/available → gross + commission + delivery lines in
--       that bucket, split from the order's own snapshot (fee, shipping,
--       goods) only where the split adds back to the credit exactly;
--   sale_credit reversed → the sale lines AND their refund lines (net 0);
--   reversal (a claw-back, available) → refund lines in available;
--   community_order_credit → escrow_release;
--   commission (escrow, state paid — counted nowhere) → escrow_release +F and
--       commission −F (net 0);
--   payout → a `merchant_payouts` row (source legacy, paid) and its two legs;
--   anything else → adjustment lines of exactly its share.
-- Keys are `legacy:<old id>:<part>`, ids `mle_legacy_<old id>_<part>`, so the
-- backfill is deterministic and each line names the row it came from
-- (`legacy_id`).
--
-- THE DEPLOY WINDOW. Migrations apply before the Worker ships (and on push),
-- so for a few minutes the OLD code may still write the old table. Two mirror
-- triggers carry those writes across by the same mapping (an insert) or as the
-- move it was (pending → available is a `release`, pending → reversed the
-- refund lines); after the deploy nothing writes the old table and they never
-- fire again. A later wave may replace them with RAISE triggers.
-- ============================================================================

CREATE TABLE IF NOT EXISTS merchant_payouts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id),
  store_id TEXT REFERENCES merchant_stores(id),
  amount_iqd INTEGER NOT NULL CHECK (amount_iqd > 0),
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested','approved','paid','failed','cancelled')),
  -- {channel, label, account, holder}: the channel from the owner's
  -- `payoutMethods`, resolved on the server and frozen at request time.
  method_snapshot TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(method_snapshot)),
  note TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  decision_reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'merchant' CHECK (source IN ('merchant','admin','legacy')),
  requested_by TEXT REFERENCES users(id),
  decided_by TEXT REFERENCES users(id),
  -- server-minted: `<merchant>:<client key>` (merchant), `admin:<merchant>:<key>`,
  -- `legacy:<old row id>` — never a bare client key on a global UNIQUE.
  event_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_at TEXT,
  paid_at TEXT,
  failed_at TEXT,
  cancelled_at TEXT,
  CHECK (state <> 'paid' OR length(reference) > 0 OR source = 'legacy')
);
CREATE INDEX IF NOT EXISTS idx_merchant_payouts_merchant ON merchant_payouts(merchant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_merchant_payouts_state ON merchant_payouts(state, created_at, id);

CREATE TABLE IF NOT EXISTS merchant_ledger_entries (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id),
  store_id TEXT REFERENCES merchant_stores(id),
  -- A store order. No foreign key: a cancelled, never-fulfilled order may be
  -- deleted by the retention sweep; its (net-zero) lines stay as history.
  order_id TEXT,
  community_order_id TEXT REFERENCES community_orders(id),
  escrow_id TEXT REFERENCES community_escrows(id),
  payout_id TEXT REFERENCES merchant_payouts(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'sale_gross','commission','delivery_fee',
    'refund','commission_refund','delivery_refund',
    'escrow_release','adjustment',
    'release','payout','payout_reversal')),
  bucket TEXT NOT NULL CHECK (bucket IN ('pending','available','reserved','paid')),
  amount_iqd INTEGER NOT NULL CHECK (amount_iqd <> 0),
  event_key TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  legacy_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- The kind decides the sign and where it may sit.
  CHECK (
    (kind = 'sale_gross'        AND amount_iqd > 0 AND bucket IN ('pending','available') AND order_id IS NOT NULL) OR
    (kind = 'delivery_fee'      AND amount_iqd > 0 AND bucket IN ('pending','available') AND order_id IS NOT NULL) OR
    (kind = 'commission'        AND amount_iqd < 0 AND bucket IN ('pending','available') AND (order_id IS NOT NULL OR escrow_id IS NOT NULL)) OR
    (kind = 'refund'            AND amount_iqd < 0 AND bucket IN ('pending','available') AND order_id IS NOT NULL) OR
    (kind = 'commission_refund' AND amount_iqd > 0 AND bucket IN ('pending','available') AND order_id IS NOT NULL) OR
    (kind = 'delivery_refund'   AND amount_iqd < 0 AND bucket IN ('pending','available') AND order_id IS NOT NULL) OR
    (kind = 'escrow_release'    AND amount_iqd > 0 AND bucket = 'available' AND escrow_id IS NOT NULL) OR
    (kind = 'adjustment'        AND bucket IN ('pending','available') AND length(note) >= 3) OR
    (kind = 'release'           AND order_id IS NOT NULL
                                AND ((bucket = 'pending' AND amount_iqd < 0) OR (bucket = 'available' AND amount_iqd > 0))) OR
    (kind = 'payout'            AND payout_id IS NOT NULL
                                AND ((bucket = 'available' AND amount_iqd < 0) OR (bucket = 'reserved')
                                     OR (bucket = 'paid' AND amount_iqd > 0))) OR
    (kind = 'payout_reversal'   AND payout_id IS NOT NULL
                                AND ((bucket = 'reserved' AND amount_iqd < 0) OR (bucket = 'available' AND amount_iqd > 0)))
  )
);
CREATE INDEX IF NOT EXISTS idx_mle_merchant_bucket ON merchant_ledger_entries(merchant_id, bucket);
CREATE INDEX IF NOT EXISTS idx_mle_merchant_created ON merchant_ledger_entries(merchant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mle_order ON merchant_ledger_entries(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mle_payout ON merchant_ledger_entries(payout_id) WHERE payout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mle_legacy ON merchant_ledger_entries(legacy_id) WHERE legacy_id IS NOT NULL;

-- ------------------------------------------------------------ the mapping
-- One view, read by the backfill below AND by the insert mirror, so the two
-- can never map an old row differently.
CREATE VIEW IF NOT EXISTS merchant_ledger_legacy_lines AS
WITH r AS (
  SELECT l.id AS legacy_id, l.merchant_id, l.kind, l.state, l.amount_iqd AS amount, ABS(l.amount_iqd) AS a,
         l.order_id, l.community_order_id, l.escrow_id, l.note, l.admin_id, l.created_at,
         (SELECT s.id FROM merchant_stores s WHERE s.merchant_id = l.merchant_id) AS store_id,
         o.id AS o_id,
         COALESCE(o.subtotal_iqd, 0) - COALESCE(o.coupon_discount_iqd, 0) AS goods,
         COALESCE(o.platform_fee_iqd, 0) AS fee,
         COALESCE(o.shipping_iqd, 0) AS ship
    FROM merchant_payout_ledger l
    LEFT JOIN orders o ON o.id = l.order_id
), s AS (
  SELECT r.*,
    CASE WHEN o_id IS NOT NULL AND goods >= 0 AND fee >= 0
              AND (a = goods - fee + ship OR a = goods - fee) THEN fee ELSE 0 END AS f,
    CASE WHEN o_id IS NOT NULL AND goods >= 0 AND fee >= 0 AND a = goods - fee + ship THEN ship ELSE 0 END AS d,
    CASE
      WHEN kind = 'sale_credit' AND amount > 0 AND order_id IS NOT NULL AND state IN ('pending','available') THEN 'sale'
      WHEN kind = 'sale_credit' AND amount > 0 AND order_id IS NOT NULL THEN 'sale_void'
      WHEN kind = 'reversal' AND amount < 0 AND order_id IS NOT NULL AND state = 'available' THEN 'clawback'
      WHEN kind = 'community_order_credit' AND amount > 0 AND escrow_id IS NOT NULL AND state = 'available' THEN 'escrow'
      WHEN kind = 'commission' AND amount < 0 AND escrow_id IS NOT NULL AND state NOT IN ('pending','available') THEN 'escrow_fee'
      WHEN kind = 'payout' AND amount < 0 THEN 'payout'
      ELSE 'other'
    END AS shape
  FROM r
), p(shape, part, kind, bucket) AS (VALUES
  ('sale','gross','sale_gross','STATE'), ('sale','commission','commission','STATE'), ('sale','delivery','delivery_fee','STATE'),
  ('sale_void','gross','sale_gross','pending'), ('sale_void','commission','commission','pending'),
  ('sale_void','delivery','delivery_fee','pending'), ('sale_void','refund','refund','pending'),
  ('sale_void','commission_refund','commission_refund','pending'), ('sale_void','delivery_refund','delivery_refund','pending'),
  ('clawback','refund','refund','available'), ('clawback','commission_refund','commission_refund','available'),
  ('clawback','delivery_refund','delivery_refund','available'),
  ('escrow','credit','escrow_release','available'),
  ('escrow_fee','fee_gross','escrow_release','available'), ('escrow_fee','commission','commission','available'),
  ('payout','out','payout','available'), ('payout','paid','payout','paid'), ('payout','adj_pending','adjustment','pending'),
  ('other','adj_pending','adjustment','pending'), ('other','adj_available','adjustment','available')
)
SELECT 'mle_legacy_' || s.legacy_id || '_' || p.part AS id,
       s.merchant_id, s.store_id, s.order_id, s.community_order_id, s.escrow_id,
       CASE WHEN s.shape = 'payout' AND p.kind = 'payout' THEN 'mpo_legacy_' || s.legacy_id END AS payout_id,
       p.kind,
       CASE WHEN p.bucket = 'STATE' THEN s.state ELSE p.bucket END AS bucket,
       CASE p.part
         WHEN 'gross' THEN s.a + s.f - s.d
         WHEN 'commission' THEN CASE WHEN s.shape = 'escrow_fee' THEN -s.a ELSE -s.f END
         WHEN 'delivery' THEN s.d
         WHEN 'refund' THEN -(s.a + s.f - s.d)
         WHEN 'commission_refund' THEN s.f
         WHEN 'delivery_refund' THEN -s.d
         WHEN 'credit' THEN s.a
         WHEN 'fee_gross' THEN s.a
         WHEN 'out' THEN -s.a
         WHEN 'paid' THEN s.a
         WHEN 'adj_pending' THEN CASE WHEN s.state = 'pending' THEN s.amount ELSE 0 END
         WHEN 'adj_available' THEN CASE WHEN s.state = 'available' THEN s.amount ELSE 0 END
       END AS amount_iqd,
       'legacy:' || s.legacy_id || ':' || p.part AS event_key,
       CASE WHEN p.kind = 'adjustment'
            THEN 'carried from the old ledger (' || s.kind || '/' || s.state || ')'
            ELSE substr(COALESCE(s.note, ''), 1, 300) END AS note,
       s.admin_id AS created_by,
       s.legacy_id,
       s.created_at
  FROM s JOIN p ON p.shape = s.shape;

-- ---------------------------------------------------------------- backfill
-- Payouts first: their ledger legs reference them.
INSERT INTO merchant_payouts (id, merchant_id, store_id, amount_iqd, state, method_snapshot, reference,
                              source, requested_by, decided_by, event_key, created_at, updated_at, paid_at)
SELECT 'mpo_legacy_' || l.id, l.merchant_id,
       (SELECT s.id FROM merchant_stores s WHERE s.merchant_id = l.merchant_id),
       -l.amount_iqd, 'paid', '{"channel":"legacy"}', substr(COALESCE(l.note, ''), 1, 300),
       'legacy', l.admin_id, l.admin_id, 'legacy:' || l.id, l.created_at, l.created_at, l.created_at
  FROM merchant_payout_ledger l
 WHERE l.kind = 'payout' AND l.amount_iqd < 0
   AND NOT EXISTS (SELECT 1 FROM merchant_payouts x WHERE x.event_key = 'legacy:' || l.id);

INSERT INTO merchant_ledger_entries (id, merchant_id, store_id, order_id, community_order_id, escrow_id, payout_id,
                                     kind, bucket, amount_iqd, event_key, note, created_by, legacy_id, created_at)
SELECT v.id, v.merchant_id, v.store_id, v.order_id, v.community_order_id, v.escrow_id, v.payout_id,
       v.kind, v.bucket, v.amount_iqd, v.event_key, v.note, v.created_by, v.legacy_id, v.created_at
  FROM merchant_ledger_legacy_lines v
 WHERE v.amount_iqd <> 0
   AND NOT EXISTS (SELECT 1 FROM merchant_ledger_entries e WHERE e.event_key = v.event_key);

-- ------------------------------------------------------------ append-only
CREATE TRIGGER IF NOT EXISTS trg_mle_no_update
BEFORE UPDATE ON merchant_ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_mle_no_delete
BEFORE DELETE ON merchant_ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_APPEND_ONLY');
END;

-- No new line takes a merchant's bucket below zero — except a customer refund
-- (see the header). Legacy lines are history and are not re-judged.
CREATE TRIGGER IF NOT EXISTS trg_mle_no_overdraw
BEFORE INSERT ON merchant_ledger_entries
FOR EACH ROW
WHEN NEW.amount_iqd < 0 AND NEW.legacy_id IS NULL AND NEW.kind NOT IN ('refund','delivery_refund')
  AND (SELECT COALESCE(SUM(amount_iqd), 0) FROM merchant_ledger_entries
        WHERE merchant_id = NEW.merchant_id AND bucket = NEW.bucket) + NEW.amount_iqd < 0
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_BUCKET_OVERDRAWN');
END;

-- A payout leg moves exactly its payout's amount, for its payout's merchant,
-- and only from the state that leg belongs to.
CREATE TRIGGER IF NOT EXISTS trg_mle_payout_leg
BEFORE INSERT ON merchant_ledger_entries
FOR EACH ROW
WHEN NEW.kind IN ('payout','payout_reversal') AND NEW.legacy_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM merchant_payouts p
   WHERE p.id = NEW.payout_id AND p.merchant_id = NEW.merchant_id AND p.amount_iqd = ABS(NEW.amount_iqd)
     AND ((NEW.kind = 'payout' AND NEW.bucket IN ('available','reserved') AND NEW.amount_iqd = CASE NEW.bucket WHEN 'available' THEN -p.amount_iqd ELSE p.amount_iqd END AND p.state = 'requested')
       OR (NEW.kind = 'payout' AND ((NEW.bucket = 'reserved' AND NEW.amount_iqd < 0) OR NEW.bucket = 'paid') AND p.state = 'paid')
       OR (NEW.kind = 'payout_reversal' AND p.state IN ('failed','cancelled')))
)
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_PAYOUT_MISMATCH');
END;

-- ------------------------------------------------------ the payout record
CREATE TRIGGER IF NOT EXISTS trg_merchant_payouts_no_delete
BEFORE DELETE ON merchant_payouts
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_merchant_payouts_immutable
BEFORE UPDATE OF id, merchant_id, store_id, amount_iqd, method_snapshot, source, requested_by, event_key, created_at
ON merchant_payouts
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.store_id IS NOT OLD.store_id
  OR NEW.amount_iqd IS NOT OLD.amount_iqd OR NEW.method_snapshot IS NOT OLD.method_snapshot
  OR NEW.source IS NOT OLD.source OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.event_key IS NOT OLD.event_key OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_IMMUTABLE');
END;

-- requested → approved | failed | cancelled ; approved → paid | failed. Nothing else, ever.
CREATE TRIGGER IF NOT EXISTS trg_merchant_payouts_state
BEFORE UPDATE OF state ON merchant_payouts
FOR EACH ROW
WHEN NEW.state <> OLD.state AND NOT (
     (OLD.state = 'requested' AND NEW.state IN ('approved','failed','cancelled'))
  OR (OLD.state = 'approved' AND NEW.state IN ('paid','failed')))
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_STATE_TRANSITION');
END;

-- ------------------------------------------------- the deploy-window mirror
CREATE TRIGGER IF NOT EXISTS trg_mpl_mirror_insert
AFTER INSERT ON merchant_payout_ledger
FOR EACH ROW
BEGIN
  INSERT INTO merchant_payouts (id, merchant_id, store_id, amount_iqd, state, method_snapshot, reference,
                                source, requested_by, decided_by, event_key, created_at, updated_at, paid_at)
  SELECT 'mpo_legacy_' || NEW.id, NEW.merchant_id,
         (SELECT s.id FROM merchant_stores s WHERE s.merchant_id = NEW.merchant_id),
         -NEW.amount_iqd, 'paid', '{"channel":"legacy"}', substr(COALESCE(NEW.note, ''), 1, 300),
         'legacy', NEW.admin_id, NEW.admin_id, 'legacy:' || NEW.id, NEW.created_at, NEW.created_at, NEW.created_at
   WHERE NEW.kind = 'payout' AND NEW.amount_iqd < 0
     AND NOT EXISTS (SELECT 1 FROM merchant_payouts x WHERE x.event_key = 'legacy:' || NEW.id);
  INSERT INTO merchant_ledger_entries (id, merchant_id, store_id, order_id, community_order_id, escrow_id, payout_id,
                                       kind, bucket, amount_iqd, event_key, note, created_by, legacy_id, created_at)
  SELECT v.id, v.merchant_id, v.store_id, v.order_id, v.community_order_id, v.escrow_id, v.payout_id,
         v.kind, v.bucket, v.amount_iqd, v.event_key, v.note, v.created_by, v.legacy_id, v.created_at
    FROM merchant_ledger_legacy_lines v
   WHERE v.legacy_id = NEW.id AND v.amount_iqd <> 0
     AND NOT EXISTS (SELECT 1 FROM merchant_ledger_entries e WHERE e.event_key = v.event_key)
   ORDER BY v.amount_iqd DESC;
END;

-- A state flip on an old row is carried as the move it was. The delta is
-- measured, not assumed: what the row's mapping says NOW minus what the new
-- ledger already holds for it, per bucket.
CREATE TRIGGER IF NOT EXISTS trg_mpl_mirror_update
AFTER UPDATE OF state ON merchant_payout_ledger
FOR EACH ROW
WHEN OLD.state <> NEW.state
BEGIN
  INSERT INTO merchant_ledger_entries (id, merchant_id, store_id, order_id, community_order_id, escrow_id, payout_id,
                                       kind, bucket, amount_iqd, event_key, note, created_by, legacy_id, created_at)
  SELECT 'mle_legacy_' || NEW.id || '_m' || q.n || '_' || q.part,
         NEW.merchant_id, q.store_id, NEW.order_id, NEW.community_order_id, NEW.escrow_id, NULL,
         q.kind, q.bucket, q.amt,
         'legacy:' || NEW.id || ':m' || q.n || ':' || q.part,
         CASE WHEN q.kind = 'adjustment' THEN 'carried from the old ledger (' || OLD.state || ' -> ' || NEW.state || ')'
              ELSE 'carried from the old ledger' END,
         NEW.admin_id, NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (
      SELECT d.store_id, d.n, p.part, p.kind, p.bucket,
             CASE p.part
               WHEN 'rel_out' THEN d.dp
               WHEN 'rel_in' THEN -d.dp
               WHEN 'refund' THEN -d.g
               WHEN 'commission_refund' THEN d.f
               WHEN 'delivery_refund' THEN -d.dd
               WHEN 'adj_pending' THEN d.dp
               WHEN 'adj_available' THEN d.dv
             END AS amt
        FROM (
          SELECT x.*,
                 CASE
                   WHEN NEW.kind = 'sale_credit' AND NEW.order_id IS NOT NULL AND x.dp < 0 AND x.dv = -x.dp THEN 'release'
                   WHEN NEW.kind = 'sale_credit' AND NEW.order_id IS NOT NULL AND x.dp < 0 AND x.dv = 0
                        AND -x.dp = x.g - x.f + x.dd AND x.g > 0 THEN 'void'
                   ELSE 'other'
                 END AS how
            FROM (
              SELECT (SELECT s.id FROM merchant_stores s WHERE s.merchant_id = NEW.merchant_id) AS store_id,
                     (SELECT COUNT(*) FROM merchant_ledger_entries WHERE legacy_id = NEW.id) AS n,
                     COALESCE((SELECT SUM(amount_iqd) FROM merchant_ledger_legacy_lines WHERE legacy_id = NEW.id AND bucket = 'pending'), 0)
                       - COALESCE((SELECT SUM(amount_iqd) FROM merchant_ledger_entries WHERE legacy_id = NEW.id AND bucket = 'pending'), 0) AS dp,
                     COALESCE((SELECT SUM(amount_iqd) FROM merchant_ledger_legacy_lines WHERE legacy_id = NEW.id AND bucket = 'available'), 0)
                       - COALESCE((SELECT SUM(amount_iqd) FROM merchant_ledger_entries WHERE legacy_id = NEW.id AND bucket = 'available'), 0) AS dv,
                     COALESCE((SELECT SUM(amount_iqd) FROM merchant_ledger_entries WHERE legacy_id = NEW.id AND kind = 'sale_gross'), 0) AS g,
                     -COALESCE((SELECT SUM(amount_iqd) FROM merchant_ledger_entries WHERE legacy_id = NEW.id AND kind = 'commission'), 0) AS f,
                     COALESCE((SELECT SUM(amount_iqd) FROM merchant_ledger_entries WHERE legacy_id = NEW.id AND kind = 'delivery_fee'), 0) AS dd
            ) x
        ) d
        JOIN (
          SELECT 'release' AS how, 'rel_out' AS part, 'release' AS kind, 'pending' AS bucket
          UNION ALL SELECT 'release', 'rel_in', 'release', 'available'
          UNION ALL SELECT 'void', 'refund', 'refund', 'pending'
          UNION ALL SELECT 'void', 'commission_refund', 'commission_refund', 'pending'
          UNION ALL SELECT 'void', 'delivery_refund', 'delivery_refund', 'pending'
          UNION ALL SELECT 'other', 'adj_pending', 'adjustment', 'pending'
          UNION ALL SELECT 'other', 'adj_available', 'adjustment', 'available'
        ) p ON p.how = d.how
    ) q
   WHERE q.amt <> 0
     AND NOT EXISTS (SELECT 1 FROM merchant_ledger_entries e WHERE e.event_key = 'legacy:' || NEW.id || ':m' || q.n || ':' || q.part);
END;
