-- ---------------------------------------------------------------------------
--  0079 — THE HUMAN TEXT THAT HAD NOWHERE TO PUT ITS ARABIC AND KURDISH.
-- ---------------------------------------------------------------------------
-- THE OWNER'S REQUEST. Every template field that holds human text must carry
-- all three languages, so an export writes them and an import reads them back:
--
--   how_to_use_ar= / _en= / _ckb=
--   usage_steps.1.title_ar= / _en= / _ckb=   (and .body_*)
--   options.1.preorder.lead_time_text_ar= / _en= / _ckb=
--
-- Thirteen field families already had that triple — name, description, image
-- alt, option and colour names, spec titles/labels/values, labels, warranty
-- titles/terms, content blocks. These are the ones nobody got to, and the
-- reason is the same each time: there was no per-language COLUMN to read back
-- from, so the template had nothing to export.
--
-- IT IS ALSO A LIVE DATA-LOSS BUG, not only a missing feature.
-- `localizeProductDoc` translates `how_to_use` on every save and then throws
-- the result away — `put('how_to_use', doc.how_to_use, () => {})`, an empty
-- setter — with a comment saying the translation "lives only in
-- product_translations and is read from there by the storefront". Nothing
-- reads it from there: `loadProductTranslations` has no caller. So the work
-- was done on every save and discarded on every save, and «طريقة الاستخدام»
-- has been English-only on the storefront for as long as the column has
-- existed. The usage steps and the lead-time sentences were never translated
-- at all.
--
-- THE SHAPE FOLLOWS 0055 EXACTLY, which did this once already for option and
-- colour names: the existing column stays as the ENGLISH source, and `_ar` /
-- `_ckb` are added NOT NULL with a '' default. '' means "no authored text in
-- this language" and every reader falls back to English — an honest fallback,
-- never a stored fabrication. Additive only: every existing row and every
-- reader that has never heard of these columns is unaffected.
--
-- `usage_steps` needs no column here: the steps live in the `products.usage_guide`
-- JSON blob, so their per-language slots are added to `UsageStepV2` in
-- worker/lib/productModel.ts and ride along inside the same column.

-- ------------------------------------------------------------- how_to_use
-- The plain-text usage instructions. 0035 added the structured `usage_guide`
-- beside it and deliberately left this as the fallback, so it is still what
-- most products actually carry.
ALTER TABLE products ADD COLUMN how_to_use_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN how_to_use_ckb TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------- lead_time_text
-- «مدة التجهيز» as the customer reads it — "ships in 2-3 weeks". It exists in
-- THREE places because 0073 made pre-order a per-model cell with per-route
-- branches, and each level may state its own:
--
--   product_option_values     the MODEL's own sentence (0043)
--   product_option_fulfillment the model's PRE-ORDER cell (0073)
--   product_option_transports  one ROUTE of that cell — land/sea/air (0073)
--
-- A sentence is the one thing on that list a machine cannot translate from a
-- number, which is why all three needed the columns rather than a formatter.
ALTER TABLE product_option_values ADD COLUMN lead_time_text_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE product_option_values ADD COLUMN lead_time_text_ckb TEXT NOT NULL DEFAULT '';

ALTER TABLE product_option_fulfillment ADD COLUMN lead_time_text_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE product_option_fulfillment ADD COLUMN lead_time_text_ckb TEXT NOT NULL DEFAULT '';

ALTER TABLE product_option_transports ADD COLUMN lead_time_text_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE product_option_transports ADD COLUMN lead_time_text_ckb TEXT NOT NULL DEFAULT '';
