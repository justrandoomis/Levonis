-- ============================================================================
--  0094 — «يستطيع اختيار وتغيير يوم التوصيل» : THE CUSTOMER'S DELIVERY DAY.
-- ============================================================================
-- NONDESTRUCTIVE: six ADD COLUMNs on `orders` and one new index. Nothing
-- existing is touched, no column is dropped, NO ROW IS BACKFILLED.
--
-- THE NO-BACKFILL GUARANTEE. Every row that exists when this applies keeps
-- `delivery_day_schedulable = 0`, a NULL `delivery_due_day` and an empty
-- source, so deployed behaviour is BYTE-IDENTICAL until the first new
-- checkout — the same guarantee `worker/lib/orderExpiry.ts` states for its own
-- policy. There is no honest day to invent for an order placed before the
-- feature existed: nobody was asked.
--
-- ---------------------------------------------------------------------------
--  WHY A NEW COLUMN AND NOT `next_stage_at`
-- ---------------------------------------------------------------------------
-- `next_stage_at` is the CRON's due time, not a delivery date. `sweepDueStages`
-- selects `WHERE next_stage_at IS NOT NULL AND next_stage_at <= ?` and then
-- PROMOTES the order. Putting the customer's chosen day there would defer the
-- confirmed→preparing promotion by the whole postponement: a customer who
-- moves 18-9 to 23-9 would stop their own order being PREPARED for five days,
-- and it would arrive unpacked. The day the box goes out and the clock that
-- moves an order through its stages are different facts.
--
-- ---------------------------------------------------------------------------
--  ONE DAY COLUMN, NOT TWO
-- ---------------------------------------------------------------------------
-- The board sorts on the SAME value the customer chose. A second "promised"
-- column next to an "actual" one means two answers to one question, and the
-- first screen that reads the wrong one shows a packer a different day from
-- the one on the customer's confirmation. `delivery_due_day` is it.
--
-- NULL means "no day can be named yet" — a pickup, a merchant order, a
-- pre-order still in transit, a row from before this migration. It is NOT
-- "today", and nothing may COALESCE it to one.
--
-- ---------------------------------------------------------------------------
--  THE CHECK IS A SHAPE CHECK, AND IT IS AT ITS BUDGET
-- ---------------------------------------------------------------------------
-- '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' is 42 BYTES against D1's
-- 50-BYTE cap on a LIKE/GLOB pattern (`D1_ERROR: LIKE or GLOB pattern too
-- complex` — see worker/lib/sqlLike.ts, which exists because that limit took
-- the product delete down on the live site). It fits, with 8 bytes to spare.
--
-- THERE IS NO ROOM FOR A PRETTIER ONE. Anyone tempted to "tidy" this into
-- something more readable — alternations, a longer character class, a second
-- GLOB for the month range — will cross 50 bytes, and the failure lands on
-- INSERT, on production, on a real customer's checkout. SQLite's own default
-- for this limit is 50 000, so nothing local will ever reproduce it. Leave it
-- exactly as written.
--
-- It checks SHAPE ONLY: '2026-02-31' passes here and is rejected in
-- TypeScript by `dayParts` in worker/lib/baghdadTime.ts, which round-trips the
-- date through Date.UTC. A calendar in a CHECK constraint is not worth the
-- bytes; a shape guarantee is, because the board's ORDER BY and every window
-- comparison rely on these strings being fixed-width and therefore sorting
-- lexicographically in date order.
ALTER TABLE orders ADD COLUMN delivery_due_day TEXT
  CHECK (delivery_due_day IS NULL OR delivery_due_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

-- THE FROZEN CEILING: the order's anchor day + the policy's max_days, computed
-- ONCE at checkout and never again. «الأسبوع أقصد به مدة سبعة أيام من تاريخ
-- الطلب» — seven days from the ORDER date, not from today.
--
-- A rolling ceiling is not a ceiling. Recomputed from today, a customer moves
-- 18-9 → 25-9, then next week 25-9 → 2-10, for ever in weekly hops, and every
-- single step looks correct on its own. Frozen, the answer to "may I move it
-- again" is a comparison against a value that cannot move.
ALTER TABLE orders ADD COLUMN delivery_day_window_end TEXT
  CHECK (delivery_day_window_end IS NULL OR delivery_day_window_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

-- MAY THIS ORDER HAVE A DAY AT ALL? Decided once, at checkout, from the
-- delivery method — `deliversToHome` in worker/lib/settings.ts, not a
-- hardcoded `id = 'pickup'`, because `checkoutDeliveryMethods` is an
-- admin-editable array and the next pickup-like method the owner adds would be
-- misclassified by an id test.
--
-- DEFAULT 0 is what makes the no-backfill guarantee true: every existing row,
-- and every MERCHANT order (which inserts here with
-- `delivery_method_id = 'merchant'` and never passes through platform
-- checkout), reads "not schedulable" without anybody having to remember.
ALTER TABLE orders ADD COLUMN delivery_day_schedulable INTEGER NOT NULL DEFAULT 0;

-- WHO PUT THE DAY THERE.
--   ''         nobody — no day, which is the state of every row today.
--   'default'  the server's own first offer, not a choice the customer made.
--   'customer' the customer chose it.
--   'admin'    an admin overrode it, and support will be asked why.
--
-- Deliberately NOT a boolean "was it changed". «تغيير يوم التوصيل في أي وقت»
-- means this column will be re-read in a dispute, and "the customer asked for
-- Thursday" and "we defaulted to Thursday" are different sentences to have to
-- say to someone whose parcel did not come.
ALTER TABLE orders ADD COLUMN delivery_day_source TEXT NOT NULL DEFAULT '';

-- WHEN it last moved, as a full UTC instant — this is a timestamp, not a civil
-- day, so it is not GLOB-checked and must not be compared against the day
-- columns above.
ALTER TABLE orders ADD COLUMN delivery_day_changed_at TEXT;

-- HOW MANY TIMES. The owner set no limit — «في أي وقت يريد» — so nothing reads
-- this as a quota today. It exists because the first question after "the
-- courier keeps missing this order" is how often the day moved, and that is
-- not answerable from a single `changed_at`.
ALTER TABLE orders ADD COLUMN delivery_day_changes INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
--  THE INDEX THE BOARD READS THROUGH — AND THE WARNING ON IT
-- ---------------------------------------------------------------------------
-- The admin board is "open orders, by the day they are due, PRO first inside
-- each day, then oldest first" — owner decision (أ): the due day is the FIRST
-- sort key and PRO is the first tie-break INSIDE a day, not a pin above the
-- calendar.
--
-- ############################################################################
-- #  DO NOT REWRITE THE WHERE CLAUSE. NOT EVEN TO "IMPROVE" IT.              #
-- ############################################################################
--
-- A PARTIAL index is usable ONLY when the query's WHERE is SYNTACTICALLY
-- implied by the index's. SQLite does not reason about set theory here: it
-- matches the text of the expression. So
--
--     status NOT IN ('delivered','cancelled')
--
-- must appear VERBATIM in the board query and in this index. Rewriting it as
-- the equivalent positive form — `status IN ('pending','confirmed',...)` — is
-- logically identical, and it costs the board this index. Measured on this
-- schema (tests/deliveryDay.test.ts asserts both plans):
--
--   NOT IN  (verbatim)  SCAN orders USING INDEX idx_orders_board_open
--   IN      (rewritten) SEARCH orders USING INDEX idx_orders_cancelled_retention
--                       (status=?) | USE TEMP B-TREE FOR ORDER BY
--
-- AND THE REWRITE IS QUIETER THAN A FULL SCAN, WHICH IS WORSE. The planner
-- falls back to another index for the predicate, so EXPLAIN still reads
-- "USING INDEX" and looks perfectly healthy — while the ORDER BY has become a
-- temp B-tree over EVERY open order, re-sorted on every page of the board.
-- There is no visible symptom until the table is large: the board renders,
-- the tests pass, and one day the admin screen takes nine seconds. The board
-- agent gets this warning too, next to the query.
CREATE INDEX IF NOT EXISTS idx_orders_board_open
  ON orders(delivery_due_day, priority DESC, created_at)
  WHERE status NOT IN ('delivered','cancelled');
