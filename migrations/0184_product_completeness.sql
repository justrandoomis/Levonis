-- 0184 — PRODUCT COMPLETENESS AND «إخفاء المنتجات الناقصة عن الزبائن» (owner brief 2026-10-10:
-- «اخفاء كل المنتجات التي تنقصها التكاليف والحقول الناقصه مع اعلام احمر للحقل الناقص»).
--
-- ADDITIVE ONLY: one new table and two indexes. No column is added to `products` (its AFTER UPDATE
-- finance-clock triggers, 0167, would tick on every flag change, and every `SELECT *` shape would
-- move), no existing row is touched, and no orders / order_items / wallet / gift / inventory_lots
-- row is read or written.
--
-- WHAT A ROW IS. The server's verdict on one ordinary product (composition = '') against the ONE
-- central list of required fields (worker/lib/productCompleteness.ts, `COMPLETENESS_LIST_VERSION`):
-- complete or not, and which required fields are missing — as CODES and option ids, never a value
-- (`missing_json`: [{"c":"PRICE","o":""},{"c":"COST","o":"opt_x"}, …]). The private codes (cost and
-- the USD pricing data) are projected away for every viewer but the verified owner; a non-owner
-- admin reads one generic «owner data» item instead.
--
-- INERT UNTIL THE OWNER TURNS THE SWITCH ON. `held` is 1 only while the owner's switch
-- admin_settings 'catalogHideIncomplete' says {"enabled": true} AND the product is incomplete; the
-- writer reads the switch INSIDE its own statement, so a concurrent toggle never leaves a stale
-- `held`. Every customer surface lists a product only while `status = 'active'` and no held row
-- names it (worker/lib/listing.ts); a database without this table lists exactly as before.
--
-- `facts_key` is the digest of what the verdict was computed from (the row's updated_at, its
-- category, picture count, pricing mode and inputs, the minimum-profit rules, the list version), so
-- the quarter-hour sweep re-evaluates only what moved. A row whose product is deleted goes with it.
CREATE TABLE IF NOT EXISTS product_completeness (
  product_id      TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  complete        INTEGER NOT NULL CHECK (complete IN (0, 1)),
  held            INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
  missing_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(missing_json) AND json_type(missing_json) = 'array'),
  missing_count   INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  private_missing INTEGER NOT NULL DEFAULT 0 CHECK (private_missing >= 0 AND private_missing <= missing_count),
  list_version    INTEGER NOT NULL DEFAULT 1 CHECK (list_version > 0),
  facts_key       TEXT NOT NULL DEFAULT '' CHECK (length(facts_key) <= 64),
  computed_at     TEXT NOT NULL,
  CHECK (held = 0 OR complete = 0),
  CHECK ((complete = 1) = (missing_count = 0))
);

-- The customer predicate probes this index (NOT EXISTS … held = 1): empty while the switch is off.
CREATE INDEX IF NOT EXISTS idx_product_completeness_held ON product_completeness(product_id) WHERE held = 1;
-- The admin list's «ناقص» filter and the owner's count.
CREATE INDEX IF NOT EXISTS idx_product_completeness_incomplete ON product_completeness(complete) WHERE complete = 0;

-- OWNER DECISION (2026-10-10): «في نعم اخفي كل المنتجات» — the switch ships ON. The verdict rows are
-- written by every catalogue write and by the quarter-hour sweep, so `held` follows within the first
-- ticks after this migration; the owner can still turn it off from «المنتجات». INSERT OR IGNORE: a
-- switch the owner already moved is never overwritten, and a re-run changes nothing.
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('catalogHideIncomplete', '{"enabled":true,"since":"2026-10-10T00:00:00.000Z","by":null}');
