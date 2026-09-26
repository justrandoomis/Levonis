-- ============================================================================
--  0136 — CATALOG PRESENTATION: descriptions, a hero photo, and old slugs
-- ============================================================================
-- docs/ux/CATALOG_DISCOVERY.md §5, §6, §11 and the owner defaults of
-- 2026-09-25 (Q1, Q11).
--
-- 1. `description_ar/en/ckb` — one or two lines under a section's name on the
--    category page and the explorer banner. EMPTY MEANS NONE: the page omits
--    the line rather than inventing one. Edited on the admin sections screen.
-- 2. `hero_image_key` — the banner/hero photo, distinct from `image_key` (the
--    home tile's cover, 0100). Same storage rules (UiUx/MainPage/, WebP), same
--    re-validation on the way out (worker/lib/siteMedia.ts catalogImageUrl).
-- 3. `catalog_slug_history` — a slug an admin renamed AWAY from, so a shared
--    `/categories/<old-slug>` link keeps resolving (owner Q11). A slug lives in
--    at most one place: the admin route deletes a history row when a live
--    catalog takes that slug again.
--
-- NONDESTRUCTIVE: three columns with defaults, one new table, and draft copy
-- (Arabic and English only — Sorani is never machine-written, DECISIONS row 11)
-- written into the NEW columns of the seeded sections the live shop uses. No
-- existing value changes.
ALTER TABLE catalogs ADD COLUMN description_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogs ADD COLUMN description_en TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogs ADD COLUMN description_ckb TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogs ADD COLUMN hero_image_key TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS catalog_slug_history (
  slug        TEXT PRIMARY KEY,
  catalog_id  TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  retired_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_catalog_slug_history_catalog ON catalog_slug_history(catalog_id);

-- Draft descriptions (owner Q1: "we write draft copy, editable from the admin").
UPDATE catalogs SET
  description_ar = 'للبيت والعمل، من أول طابعة إلى خط إنتاج صغير.',
  description_en = 'For home and work, from a first printer to a small production line.'
WHERE id = 'cat_printers' AND description_ar = '' AND description_en = '';
UPDATE catalogs SET
  description_ar = 'طابعات الخيوط: الأكثر استعمالًا ومتانة، من المجسمات إلى القطع العملية.',
  description_en = 'Filament printers: the most widely used and durable, from models to functional parts.'
WHERE id = 'cat_printers_fdm' AND description_ar = '' AND description_en = '';
UPDATE catalogs SET
  description_ar = 'الخيوط والمواد التي تطبع بها، بأنواعها وألوانها.',
  description_en = 'The filaments and materials you print with, in every type and colour.'
WHERE id = 'cat_materials' AND description_ar = '' AND description_en = '';
UPDATE catalogs SET
  description_ar = 'قطع الغيار والملحقات التي تُركَّب على طابعتك.',
  description_en = 'Spare parts and accessories that fit your printer.'
WHERE id = 'cat_pacc' AND description_ar = '' AND description_en = '';
UPDATE catalogs SET
  description_ar = 'أدوات وقطع ومستلزمات لمشاريع الصنّاع.',
  description_en = 'Tools, parts and supplies for makers'' projects.'
WHERE id = 'cat_makers' AND description_ar = '' AND description_en = '';
