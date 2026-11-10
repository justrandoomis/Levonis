-- ============================================================================
-- 0231 — THE FILAMENTS FILED ON «مواد FDM» MOVE INTO THEIR OWN SECTION (owner,
-- 2026-11-10: «أقسام مواد FDM» showed PLA with «منتج واحد»; docs/DECISIONS.md
-- row 309).
--
-- On the live shop seventeen filaments were classified on «مواد FDM» itself
-- (sub_category_id = 'cat_materials_fdm'), the section that HOLDS the PLA, PETG,
-- ABS and other sections, so none of those sections listed them: PLA showed one
-- product (PLA Metal) while the shop holds seventeen PLA filaments, eSUN PLA+,
-- the one in stock, among them; and PETG Basic sat outside PETG.
--
-- Two causes, both fixed in code beside this file:
--   the product form offered only the main section's direct children, so «PLA»
--   (a section inside «مواد FDM») could not be chosen
--   (src/components/adminProducts/subSectionOptions.ts);
--   the Bambu import kept a product's earlier «مواد FDM» filing when its map
--   placed it in PLA or PETG, sections created later inside «مواد FDM»
--   (worker/lib/catalogImport/writer.ts `isStrictAncestor`).
--
-- This file moves exactly those products, by slug, and only while they are
-- still on «مواد FDM» under «مواد الطباعة»: a product the owner has filed
-- anywhere else since is left alone, and so is every product not named here.
-- The target section must exist, be active and sit inside «مواد FDM».
-- Placements (product_catalogs) are untouched: PLA-CF stays on «مواد مقوّاة
-- بالألياف» as well. Every ancestor still counts the product, so «مواد FDM»
-- and «مواد الطباعة» keep their totals.
--
-- RE-RUNNABLE: a second run finds nothing left on «مواد FDM» to move
-- (scripts/migrate-check.mjs --twice). Comments use `--` only:
-- tests/d1CompoundLimit.test.ts strips no block comment.
-- ============================================================================

UPDATE products
   SET sub_category_id = 'cat_bi_pla'
 WHERE sub_category_id = 'cat_materials_fdm'
   AND category_id = 'cat_materials'
   AND slug IN (
     'esun-pla-plus',
     'bambu-lab-pla-basic-filament',
     'bambu-lab-pla-matte-1kg',
     'bambu-lab-pla-basic-gradient',
     'bambu-lab-pla-silk-plus',
     'bambu-lab-pla-silk-multi-color',
     'bambu-lab-pla-translucent',
     'bambu-lab-pla-galaxy',
     'bambu-lab-pla-marble',
     'bambu-lab-pla-sparkle',
     'bambu-lab-pla-glow',
     'bambu-lab-pla-wood',
     'bambu-lab-pla-tough-plus',
     'bambu-lab-pla-pure',
     'bambu-lab-pla-aero',
     'bambu-lab-pla-cf'
   )
   AND EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_bi_pla' AND parent_id = 'cat_materials_fdm' AND active = 1);

UPDATE products
   SET sub_category_id = 'cat_bi_petg'
 WHERE sub_category_id = 'cat_materials_fdm'
   AND category_id = 'cat_materials'
   AND slug = 'bambu-lab-petg-basic'
   AND EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_bi_petg' AND parent_id = 'cat_materials_fdm' AND active = 1);
