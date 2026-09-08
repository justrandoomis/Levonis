-- ---------------------------------------------------------------------------
-- 0055 — option values and colours carry their Arabic and Kurdish names.
-- ---------------------------------------------------------------------------
-- The TXT product template has required `options.N.name_ar` and offered
-- `options.N.name_ckb` / `colors.N.name_ar` / `colors.N.name_ckb` since
-- version 2, and the canonical ProductDoc has a slot for each. The relational
-- tables — the only place the storefront, the cart and the admin form read an
-- option or a colour from once a product has rows — had `name_en` alone, so
-- the overlay filled the Arabic and Kurdish slots with the English name and
-- every export wrote that fiction into the file. A file that stated a real
-- Arabic name lost it on apply (docs/TXT_IMPORT_PARITY.md, root cause 5).
--
-- Additive only: NOT NULL with a '' default, so every existing row and every
-- reader that has never heard of the columns is unaffected. '' means "no
-- authored name in this language" and the overlay falls back to name_en for
-- display — an honest fallback, never a stored fabrication.
ALTER TABLE product_option_values ADD COLUMN name_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE product_option_values ADD COLUMN name_ckb TEXT NOT NULL DEFAULT '';
ALTER TABLE product_colors ADD COLUMN name_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE product_colors ADD COLUMN name_ckb TEXT NOT NULL DEFAULT '';

-- Values are read GROUP BY GROUP (group sort, then value sort): the flat
-- `ORDER BY sort, name_en` interleaved the groups and flipped their order on
-- every TXT round trip (root cause 13). The index serves the per-group read.
CREATE INDEX IF NOT EXISTS idx_option_values_product_group_sort
  ON product_option_values(product_id, group_id, sort);
