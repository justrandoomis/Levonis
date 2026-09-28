-- ============================================================================
--  0149 — A SECTION'S PICTURES, FOR EACH THEME AND EACH SCREEN (owner, 2026-09-28)
-- ============================================================================
-- «في صور الأقسام الفرعية والأقسام الرئيسية اجعل هنالك صورتين أيضا فيما يخص
-- الوضع الداكن والوضع الفاتح وتكون الأبعاد متجاوبة مع جميع الأجهزة … أربع صور:
-- اثنين وضع داكن لقياسين، اثنين وضع فاتح لقياسين»
--
-- Every section, main or sub, draws two pictures: its CARD (the home tile and
-- the category board, 0100) and its BANNER (the explorer rows and the top of
-- its own page, 0136/0142). Each becomes a set of four — dark and light, for a
-- large screen and for a phone:
--
--                    large screen              phone (< 640 px)
--   card    dark     image_key (0100)          mobile_image_key          ← new
--           light    light_image_key  ← new    light_mobile_image_key    ← new
--   banner  dark     hero_image_key (0136)     hero_mobile_image_key     ← new
--           light    hero_light_image_key      hero_light_mobile_image_key ← new
--                    (0142)
--
-- THE THREE COLUMNS THAT EXIST KEEP THEIR MEANING, so every picture already
-- uploaded goes on showing exactly where it shows today: `image_key` was the
-- card in both themes and is now the card's dark large picture — which is also
-- what every empty slot of the card falls back to.
--
-- The storefront picks ONE file (src/lib/catalog/sectionPictures.ts): the
-- theme on screen first — a dark picture on the cream theme is the "dark
-- island" the owner removed — then the size, then the other theme; a banner
-- with nothing of its own falls through to the card's set, and a card with
-- nothing to a product photograph, as before.
--
-- Same storage rules as 0100/0136/0142 (UiUx/MainPage/, WebP, re-validated on
-- the way out by worker/lib/siteMedia.ts catalogImageUrl), one upload path per
-- slot (worker/routes/adminTaxonomy.ts CATALOG_PICTURES), and every column is
-- registered with the media sweeper (worker/lib/mediaRefs.ts).
--
-- NONDESTRUCTIVE: five ADD COLUMNs with a default. No existing value changes.
ALTER TABLE catalogs ADD COLUMN light_image_key TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogs ADD COLUMN mobile_image_key TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogs ADD COLUMN light_mobile_image_key TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogs ADD COLUMN hero_mobile_image_key TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogs ADD COLUMN hero_light_mobile_image_key TEXT NOT NULL DEFAULT '';
