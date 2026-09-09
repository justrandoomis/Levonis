-- 0062 — COMPOSITION ANALYTICS (docs/BUNDLES_MYSTERY.md §1.10, §12)
--
-- DERIVED WHEREVER POSSIBLE; COUNTED ONLY WHERE NOTHING RECORDS THE FACT.
--
-- Purchases, units, revenue, savings delivered, best bundles and every mystery
-- allocation figure are QUERIES over `order_items`, the order snapshots and
-- `mystery_allocations` — they need no table here and get none. Exactly three
-- facts have no row anywhere: that a detail page was viewed, that an
-- add-to-cart succeeded, and that availability refused a purchase. Those are
-- the three columns below.
--
-- NO user id, NO order id, NO address, NO session — this is an aggregate
-- counter, not an event log, and it is written with ONE upsert per tap rather
-- than five D1 writes, mirroring the deliberate choice already made for
-- add-to-cart analytics elsewhere in this codebase.
--
-- Both statements are re-runnable (IF NOT EXISTS), which is what
-- `tests/migrations.test.ts` demands of the newest migration.

CREATE TABLE IF NOT EXISTS composition_daily_metrics (
  day        TEXT NOT NULL,                -- 'YYYY-MM-DD', UTC
  subject_id TEXT NOT NULL,                -- the composition product id
  -- SIGNED-IN views of the DETAIL route only, never the listing (§10, §12).
  -- Anonymous callers fall back to an IP bucket that Iraqi carriers NAT
  -- heavily, which would both undercount real customers and let anyone
  -- inflate the denominator of the only conversion figure the owner reads.
  -- It is best-effort and is NEVER an input to a price, a limit or an
  -- eligibility decision.
  views      INTEGER NOT NULL DEFAULT 0,
  adds       INTEGER NOT NULL DEFAULT 0,   -- successful add-to-cart
  oos_blocks INTEGER NOT NULL DEFAULT 0,   -- availability refused a purchase
  PRIMARY KEY (day, subject_id)
);

-- The allocation figures an admin needs — how weights and inventory actually
-- shaped the draws — with NO order id and NO user id in the projection at all.
-- A pool entry with weight 10 and zero allocations is immediately visible as a
-- stock problem; nothing here can be joined back to a customer.
CREATE VIEW IF NOT EXISTS mystery_allocation_stats AS
  SELECT substr(a.created_at, 1, 10) AS day,
         a.pool_id, a.pool_entry_id, a.product_id, a.color_id, a.sale_mode,
         COUNT(*) AS n
    FROM mystery_allocations a
   GROUP BY 1, 2, 3, 4, 5, 6;
