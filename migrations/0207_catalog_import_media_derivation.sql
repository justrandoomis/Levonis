-- 0207 — WHAT AN IMPORTED PICTURE WAS MADE FROM (Bambu import spec §C.4 step 2b; DECISIONS row 264).
--
-- The owner decided (2026-10-20) that an animated GIF the import would refuse
-- (IMAGE_ANIMATED_GIF) is stored as a still of its FIRST FRAME: the CDN's own
-- `__op__format,f_png` rendition, verified a single still PNG or JPEG and
-- stored as WebP like any picture (worker/lib/catalogImport/media.ts). The
-- media row says so, so the owner can tell such a picture from a photograph:
--
--   derivation   '' — the picture is what the address shows (the original, or
--                its CDN resize: `fetched_variant` says which);
--                'gif_first_frame' — the first frame of an animated GIF.
--
-- Additive only: one column with a default, no row touched (every existing
-- row is ''). An older Worker never reads or writes it; the writer falls back
-- to the statement without it on a database before 0207, and every read of it
-- tolerates its absence (no first frame counted).
ALTER TABLE catalog_import_media ADD COLUMN derivation TEXT NOT NULL DEFAULT ''
  CHECK (derivation IN ('', 'gif_first_frame'));
