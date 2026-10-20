-- 0206 — Smart search 1.5: the identifier lane (assistant plan §4 A, §5 step 3).
--
-- A shopper holding a spool, a box or a spare part types the code printed on
-- it: a colour code «10101», a part code «FAP035», a SKU. The token index
-- (0089) finds the product by such a code, but it cannot say WHICH of the
-- product's selections the code names, and it cannot say "no product carries
-- this code" — an unknown code simply ranks whatever is near it. This table
-- answers both, exactly:
--
--   key         the code as `identifierKey()` writes it (worker/lib/search/
--               identifiers.ts): upper case, Arabic-Indic digits folded,
--               separators removed («fap-035» → FAP035). A measure an option
--               value is named with keeps its decimal point (0.4, 6X2).
--   scope       what the code names: the product, one option value, one
--               variant, or one `product_colors` colour — the selection the
--               product page opens with.
--   kind        what sort of code it is (the external id's type, a SKU, a
--               measure).
--   source      which stored row it was derived from.
--
-- DERIVED, NEVER AUTHORED. Every row is rebuilt from `products.sku`,
-- `product_variants.sku`, `product_external_ids` (0194), and the option and
-- colour names — by the product save, in the same batch as the product, and by
-- the search catch-up for every product it has not written yet (the identifier
-- stamp `#ids:1` in search_tokens). Dropping every row loses nothing.
--
-- Additive only: one new table and its index, nothing existing touched.
-- Readers tolerate the table being absent (no exact answer, no miss line); the
-- writers skip it until it exists.

CREATE TABLE IF NOT EXISTS search_identifiers (
  key        TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL DEFAULT 'product' CHECK (scope_kind IN ('product','option_value','variant','color')),
  scope_id   TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL CHECK (kind IN ('sku','variant_sku','part_code','color_code','mpn','gtin','ean','bambu_sku','model','measure')),
  source     TEXT NOT NULL,
  PRIMARY KEY (key, product_id, scope_kind, scope_id)
);

-- The lookup is by key: the primary key leads with it, so `key IN (…)` is an
-- index search. This one serves the writers, which replace a product's rows.
CREATE INDEX IF NOT EXISTS ix_search_identifiers_product ON search_identifiers(product_id);
