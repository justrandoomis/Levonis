-- ============================================================================
--  0044 — ADJUSTMENT PRICING + UNDOABLE PRICE CHANGES
-- ============================================================================
-- The owner's case: changing one cost or one price on a product that carries
-- Options × Colors × Availability means editing dozens of fields by hand. The
-- ask is to make that take seconds, WITHOUT building a second pricing system
-- beside the one that already works ("لا تنشئ Pricing System موازيًا إذا كان
-- لدينا نظام موجود").
--
-- WHAT ALREADY EXISTS AND IS NOT REBUILT.
--
--   INHERIT and FIXED are already the model. worker/lib/pricing.ts resolves
--   every price down variant → colour → option → product, PER FIELD, treating
--   NULL as "inherit" and any number as "fixed". So of the three modes the
--   owner asked for (§5: INHERIT / ADJUSTMENT / FIXED) two are already here
--   and have been since 0018. Adding `price_mode` columns to store which of
--   them a row is in would be storing a value that is already derivable from
--   the row itself — precisely what §6 and §27 forbid ("لا تضف هذه الحقول
--   حرفيًا إذا كانت البنية الحالية لديها mechanism يؤدي نفس الوظيفة" /
--   "ولا تخزن قيمًا مشتقة/محسوبة بلا حاجة").
--
--   price_history already exists (0003, widened by 0019) and is already the
--   table the seven-day price protection reads. §23 asks for price history;
--   it is this table, not a new one.
--
-- WHAT IS GENUINELY MISSING, AND IS ALL THIS MIGRATION ADDS.
--
-- 1. ADJUSTMENT. A row that says "this option is 60,000 above whatever the
--    product costs" cannot be expressed today: the only way to say it is to
--    freeze the arithmetic into a fixed number, which is exactly why a base
--    price change leaves options stranded (see worker/lib/pinnedPrices.ts for
--    the whole story of that failure). Four nullable columns per price-bearing
--    table say it directly.
--
--    THE MODE IS DERIVED, NEVER STORED:
--
--        <field>_price_iqd   <field>_adjust_iqd   mode
--        -----------------   ------------------   -----------
--        NULL                NULL                 INHERIT
--        NULL                set                  ADJUSTMENT
--        set                 (ignored)            FIXED
--
--    A fixed price wins over an adjustment on the same row because a number
--    the owner typed is an answer, and an adjustment beside it is at most a
--    leftover. Nothing is backfilled: every existing row has NULL in all four
--    new columns, so every existing row keeps resolving byte-for-byte as it
--    does today. The adjustment is a signed number of dinars (a discount is
--    negative); the resolver clamps the result at zero.
--
--    ONLY THE TWO TABLES THE RESOLVER ACTUALLY READS get these columns.
--    product_variants also carries four prices (0018), but worker/lib/pricing.ts
--    never reads them — a variant row exists for stock tracking of an exact
--    combination, and resolveUnitPrice takes only an option and a colour. Giving
--    it adjustment columns would create a field an admin could set that no
--    customer could ever be charged from, which is worse than not having it.
--
-- 2. A BATCH ID ON price_history. §22 asks for undo after a bulk update, using
--    the existing history rather than a new one. Undo needs to know which rows
--    moved together — a timestamp is not an identity, and two admins repricing
--    in the same second would otherwise undo each other's work. `batch_id` is
--    '' for every row written before this migration and for every ordinary
--    single-field edit, so it costs nothing and changes nothing.
-- ============================================================================

-- --------------------------------------------------------- 1. adjustments
ALTER TABLE product_option_values ADD COLUMN regular_adjust_iqd INTEGER;
ALTER TABLE product_option_values ADD COLUMN prime_adjust_iqd INTEGER;
ALTER TABLE product_option_values ADD COLUMN pro_adjust_iqd INTEGER;
ALTER TABLE product_option_values ADD COLUMN cost_adjust_iqd INTEGER;

ALTER TABLE product_colors ADD COLUMN regular_adjust_iqd INTEGER;
ALTER TABLE product_colors ADD COLUMN prime_adjust_iqd INTEGER;
ALTER TABLE product_colors ADD COLUMN pro_adjust_iqd INTEGER;
ALTER TABLE product_colors ADD COLUMN cost_adjust_iqd INTEGER;

-- ------------------------------------------------- 2. undoable price moves
-- '' = not part of a batch (every historical row, and every single-cell edit).
ALTER TABLE price_history ADD COLUMN batch_id TEXT NOT NULL DEFAULT '';

-- Undo reads one batch at a time and always newest-first, so the index is on
-- the batch alone; the existing idx_price_history_product still serves §23's
-- per-product timeline.
CREATE INDEX IF NOT EXISTS idx_price_history_batch
  ON price_history(batch_id) WHERE batch_id <> '';
