-- 0024 — the previewed payload, stored so CONFIRM never re-parses a file.
--
-- Mandate §10 requires two separate steps: a preview that writes nothing, and
-- a confirm that is idempotent under `import_id`. Those two are only the same
-- import if the second one applies exactly what the first one showed. Keeping
-- the normalized payload here means:
--
--   * confirm needs no upload at all — the admin cannot swap the file between
--     the preview they read and the write they authorised;
--   * a retry of confirm with the same import_id finds state='applied' and
--     returns the stored report instead of writing a second time;
--   * the result report survives the request, so it stays downloadable after
--     the browser tab is closed (§10 "تقرير نتيجة قابلًا للتنزيل").
--
-- `payload` holds the parsed products AFTER name/slug resolution of brand,
-- category and facets, with image URLs already resolved to their stored
-- objects. Preview uploads image bytes to content-addressed R2 keys so that
-- confirm is a pure database operation; no product, catalog, stock or order
-- row is touched before confirm.
ALTER TABLE product_imports ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';

-- The uploaded file's name, so the history list is readable ("bambu-a1.csv")
-- rather than a bare id.
ALTER TABLE product_imports ADD COLUMN source_name TEXT NOT NULL DEFAULT '';
