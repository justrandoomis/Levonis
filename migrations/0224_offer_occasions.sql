-- ============================================================================
-- 0224 — THE SALE'S OCCASION (owner, 2026-11-04 and 2026-11-05; docs/DECISIONS.md row 294;
-- docs/ux/PRODUCT-DISCOUNT.md §16).
--
-- The owner's words: «make a label to show this is black friday discount like on to left corner», and
-- how a discount gets it: «Label all sales by dates on product edit on price dicount can named by what
-- the oocasion like cristmas or blackfriday … or anything, any of them have special design».
--
-- The label lives ON THE SALE'S OWN ROW, so it starts, ends, gates and lowers exactly as the sale does:
--
--   badge       a preset key (packages/contracts/src/offerOccasions.ts: black_friday, ramadan, …) or
--               'custom'; '' = no occasion. The CHECK is a SHAPE, never a list: a new preset is a code
--               change, never a CHECK widening (a table rebuild in SQLite). An unknown key reads as no
--               label everywhere.
--   badge_text  the owner's own name for 'custom', as JSON {ar, en?, ckb?} (Arabic required, each at most
--               32 characters — the door checks that); '' otherwise. Length-capped and JSON-checked here.
--
-- One sale per product (PRIMARY KEY (subject_type, subject_id), 0060): a sale with an occasion replaces
-- the product's older sale, as any new sale does.
--
-- ADDITIVE ONLY: two defaulted columns and one partial index. No table is rebuilt, no CHECK is widened
-- and no existing row changes (every row reads '' — no occasion).
--
-- RE-RUNNABLE: the index says IF NOT EXISTS, so scripts/migrate-check.mjs --twice re-runs it and proves
-- nothing moves; the two ADD COLUMNs are excluded from that re-run by the harness itself (SQLite has no
-- ADD COLUMN IF NOT EXISTS; D1 applies a file once).
--
-- DEPLOY-AHEAD (CLAUDE.md rule 2): every reader tolerates the columns' absence — `SELECT w.*` simply has
-- no `badge` and no sale carries a label; an ordinary save names neither column; a save that sets an
-- occasion on a database without them is refused (OFFER_OCCASION_NOT_INSTALLED, 409).
-- ============================================================================

ALTER TABLE offer_windows ADD COLUMN badge TEXT NOT NULL DEFAULT ''
  CHECK (badge = '' OR (length(badge) BETWEEN 2 AND 32 AND badge NOT GLOB '*[^a-z0-9_]*'));

ALTER TABLE offer_windows ADD COLUMN badge_text TEXT NOT NULL DEFAULT ''
  CHECK (badge_text = '' OR (length(badge_text) <= 400 AND json_valid(badge_text) AND json_type(badge_text) = 'object'));

-- The special-offers tab's filter by one occasion (`GET /api/admin/offers?badge=black_friday`): only the
-- labelled rows are indexed. SQLite takes a partial index only when the query names its WHERE, so the
-- door writes `w.badge <> '' AND w.badge = ?` (EXPLAIN QUERY PLAN: `USING INDEX idx_offer_windows_badge`);
-- a bound key alone, `w.badge = ?`, scans by subject instead.
CREATE INDEX IF NOT EXISTS idx_offer_windows_badge ON offer_windows(badge, subject_id) WHERE badge <> '';
