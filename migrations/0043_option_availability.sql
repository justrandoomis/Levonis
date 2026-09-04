-- ============================================================================
--  0043 — AVAILABILITY PER OPTION
-- ============================================================================
-- The owner's case: "Bambu Lab A1" is ONE product that must offer
--
--     A1        — pre-order        A1        — direct sale
--     A1 Combo  — pre-order        A1 Combo  — direct sale
--
-- with fully independent price, PRIME price, PRO price, internal cost, stock
-- and lead time on each of the four.
--
-- WHAT ALREADY EXISTED, AND IS REUSED RATHER THAN REBUILT. product_option_values
-- has carried `stock`, `regular_price_iqd`, `prime_price_iqd`, `pro_price_iqd`
-- and `cost_iqd` since 0018. Four independent prices and four independent
-- stocks per option are therefore not new — an option row is already the
-- sellable unit. What was missing is only the ANSWER TO "how is this one
-- fulfilled", which until now lived exclusively at product level
-- (products.sale_types) and so could not differ between two options of the
-- same product.
--
-- SIX COLUMNS, EVERY ONE ADDITIVE AND EVERY ONE OPTIONAL:
--
--   availability_type   '' | 'direct_sale' | 'pre_order'
--                       '' means INHERIT the product's sale_types, which is
--                       exactly what every existing row does today. That is
--                       what makes this migration a no-op for the whole
--                       catalogue: nothing is backfilled, nothing changes
--                       meaning, and an option written before this migration
--                       behaves afterwards precisely as it did before.
--
--   lead_time_text      free text shown to the customer ("3-4 weeks").
--   lead_time_min_days  optional structured pair, for sorting and for a
--   lead_time_max_days  delivery estimate the UI can compute. The text stays
--                       authoritative for DISPLAY: an owner who writes
--                       "بعد العيد" must not have it overwritten by arithmetic.
--
--   variant_key         'a1' / 'a1-combo' — the MODEL this option is a
--   variant_label       fulfilment of, and its display name.
--
-- WHY variant_key EXISTS AT ALL. Without it the only thing tying
-- "A1 - Pre-order" to "A1 - Direct Sale" is their names, and grouping the
-- storefront's two-step chooser by parsing "A1 - " out of a label is a bug
-- waiting for the first product named with a dash. The key is data; the
-- label is what the customer reads; name parsing survives only as the
-- fallback for rows written before this migration.
--
-- SQLite ALTER TABLE ADD COLUMN is O(1) here and cannot lose a row: no table
-- is rebuilt, no CHECK is redefined, no index is dropped. products.selling_type
-- keeps its original CHECK ('direct_sale','pre_order','bundle') untouched —
-- see the note at the bottom about why no 'mixed' value is added to it.
-- ============================================================================

ALTER TABLE product_option_values ADD COLUMN availability_type TEXT NOT NULL DEFAULT '';
ALTER TABLE product_option_values ADD COLUMN lead_time_text TEXT NOT NULL DEFAULT '';
ALTER TABLE product_option_values ADD COLUMN lead_time_min_days INTEGER;
ALTER TABLE product_option_values ADD COLUMN lead_time_max_days INTEGER;
ALTER TABLE product_option_values ADD COLUMN variant_key TEXT NOT NULL DEFAULT '';
ALTER TABLE product_option_values ADD COLUMN variant_label TEXT NOT NULL DEFAULT '';

-- The storefront groups by (product_id, variant_key) to build step one of the
-- chooser, then filters that group by availability_type for step two.
CREATE INDEX IF NOT EXISTS idx_option_values_variant
  ON product_option_values(product_id, variant_key, sort);

-- ============================================================================
--  WHY products.selling_type DOES NOT GAIN 'mixed'
-- ============================================================================
-- The request asked for a fourth value, `mixed`. The column already cannot
-- hold it: 0001_init.sql:84 pins
--     CHECK (selling_type IN ('direct_sale','pre_order','bundle'))
-- and widening a CHECK in SQLite means rebuilding the whole products table.
--
-- It is also unnecessary. 0018 already added `products.sale_types`, a JSON
-- ARRAY, and made it the authority — worker/lib/productModel.ts keeps
-- selling_type in sync as sale_types[0] purely so pre-0018 readers still see a
-- valid scalar. A product that sells both ways is therefore already
-- expressible, today, as sale_types = ["direct_sale","pre_order"], and
-- worker/lib/pricing.ts has always read sale_types in preference to the
-- scalar. Adding a 'mixed' enum would create a second, weaker way to say the
-- same thing, and a rebuild of the busiest table in the database to do it.
--
-- So "mixed" is a WORD the template accepts on input (it expands to both sale
-- types) and a state the admin UI reports, not a stored value. The importer
-- also DERIVES sale_types from the options' availability types, so a file
-- that declares one pre-order option and one direct option produces a product
-- whose sale_types say so without the author having to keep the two in step.
