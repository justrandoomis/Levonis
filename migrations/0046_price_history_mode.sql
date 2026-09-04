-- 0046 — UNDO MUST PUT A CELL BACK THE WAY IT WAS, MODE INCLUDED.
--
-- price_history has always recorded a price as a NUMBER: old_iqd, new_iqd.
-- That was enough while every cell was a fixed number, and 0044 made it
-- insufficient the day it landed. A cell can now be in one of three modes —
-- inherit (follow the level above), adjust (a signed difference that KEEPS
-- following it), or fixed (pinned) — and the number alone cannot tell them
-- apart: an option inheriting 700,000 and an option pinned at 700,000 record
-- the same old_iqd.
--
-- So undo guessed. It restored a cell to `inherit` when the old number equalled
-- what the level above says today, and to `fixed` otherwise — and it wrote
-- write_adjust: null unconditionally. Undoing a bulk change on a cell that had
-- been an adjustment therefore PINNED it: the +5,000 that used to follow the
-- base price silently became a frozen number, and the next base change stopped
-- reaching it. That is the exact failure the mode chips exist to prevent, and
-- it happened on the one action an admin presses when something went wrong.
--
-- Two nullable columns fix it by remembering rather than inferring.
--   old_mode        '' for every row written before this migration, which is
--                   honest: those rows genuinely do not know, and undo keeps
--                   its old inherit-or-fixed reasoning for them.
--   old_adjust_iqd  the signed adjustment the cell carried before the change,
--                   NULL when it carried none.
--
-- Additive ALTERs on an append-only audit table: no row is rewritten, no index
-- is dropped, and every existing reader (the price-history endpoint, the undo
-- lookup) selects named columns, so nothing sees a shape it did not ask for.
ALTER TABLE price_history ADD COLUMN old_mode TEXT NOT NULL DEFAULT '';
ALTER TABLE price_history ADD COLUMN old_adjust_iqd INTEGER;

-- The undo lookup reads `WHERE product_id = ? AND batch_id = ? ORDER BY id DESC`
-- and there is no index shaped like that: 0003's index is (product_id,
-- changed_at) and 0044's is (batch_id) alone. On a product with a long price
-- history that is a scan of every batch the product ever had, on the one
-- request an admin makes when something has just gone wrong. The composite
-- makes it a lookup, and it is the query this migration exists to serve.
CREATE INDEX IF NOT EXISTS idx_price_history_batch_product
  ON price_history(product_id, batch_id);
