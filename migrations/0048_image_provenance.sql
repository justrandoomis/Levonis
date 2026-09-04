-- ---------------------------------------------------------------------------
-- 0048 — where a picture came from, and what it says in every language.
-- ---------------------------------------------------------------------------
-- The TXT product template has advertised `images.N.alt_ar`, `images.N.alt_ckb`,
-- `images.N.key` and `images.N.source_url` since version 2, and the blank
-- template teaches all four. `product_images` has never had a column for any of
-- them: it carries `alt_en` alone. So the overlay filled alt_ar and alt_ckb with
-- the ENGLISH alt text and reported key and source_url as empty strings, and
-- every export wrote that fiction into the file. Re-importing it copied the
-- English alt into the Arabic field — the store's own round trip corrupted its
-- own alt text.
--
-- source_url matters twice over from today: the owner asked to pull product
-- photography from bambulab / qidi / biqu / esun / creality pages, and an image
-- fetched from someone else's site without a record of WHERE it came from
-- cannot be re-checked, re-fetched or removed on request.
--
-- Additive only: every column is nullable with a '' default, so the existing
-- rows and every reader that has never heard of them are unaffected.
ALTER TABLE product_images ADD COLUMN alt_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE product_images ADD COLUMN alt_ckb TEXT NOT NULL DEFAULT '';
ALTER TABLE product_images ADD COLUMN r2_key TEXT NOT NULL DEFAULT '';
ALTER TABLE product_images ADD COLUMN source_url TEXT NOT NULL DEFAULT '';

-- A store that re-ingests the same vendor photo should recognise it rather than
-- download it again; the index is what makes that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_product_images_source
  ON product_images(source_url) WHERE source_url <> '';
