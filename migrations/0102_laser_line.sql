-- «إضافة قسم جديد وهو قسم الليزر بجانب طابعات الفلامنت والرزن … وكذلك اضافه
--  مواد الطباعه بجانب الفلمنت والرزن … مواد الصيانه والاكسسوارات ايضا.»
--
-- THE SHELVES THE LASER LINE IS SOLD FROM. Five nodes: a root for the machines
-- with a child each for the cutters and for their consumable parts, and two
-- more under the existing «مواد الطباعة» root for the two kinds of stock a
-- cutter eats. Nothing else in this file — the FIELDS those sections ask for
-- live in worker/lib/templateFamilies.ts, which is where every other template
-- lives, and NO PRODUCT IS SEEDED. The catalogue is the owner's to type in.
--
-- WHY THE MATERIALS HANG OFF `cat_materials` AND THE MACHINES DO NOT. A sheet
-- of plywood is «مواد الطباعة» in the same sense a spool is: a consumable in
-- the materials family, sold by the piece, filed beside «مواد FDM» and «مواد
-- Resin». A cutter is not a printer and does not belong under «الطابعات», so
-- it gets a root of its own at sort 25 — between the printer accessories and
-- the materials, which is where «بجانب» puts it on the storefront.
--
-- ============================ is_printer_catalog = 0, AND IT IS A DECISION ==
--
-- That column is not a label. worker/lib/warrantyPlans.ts refuses an extended
-- warranty for a product no catalog of which carries the flag, and
-- worker/lib/membershipOps.ts keys the PLUS gift and the PRO maintenance
-- discount off the same join. Setting it to 1 here would silently enrol every
-- laser cutter in three membership rules that were written, priced and worded
-- for 3D printers — a maintenance discount on a machine whose maintenance is a
-- lens and a filter, and a warranty plan whose percentages were set against a
-- printer's failure modes.
--
-- AND IT IS NOT ONLY THOSE THREE, which is the part worth writing down. The
-- same flag is read by worker/lib/printerIdentity.ts, and through it by:
--   * worker/lib/printerAdvance.ts — the «٥٠ الف» paid on delivery when home
--     delivery is requested for a printer. A cutter at 0 is sold with no
--     advance, which is the one consequence here that is MONEY and the one the
--     owner should be asked about first;
--   * worker/lib/reviewQuality.ts — a review of a non-printer earns no reward;
--   * the referral free-delivery rule and the `is_printer` flag on
--     `OrderDelivered` (worker/lib/orderStageOps.ts).
--
-- So the laser line ships OUTSIDE all of them. This is reversible and is meant
-- to be: when the owner decides a cutter should carry the printer warranty and
-- the printer advance, it is one UPDATE on `catalogs.is_printer_catalog` from
-- the taxonomy screen, and nothing in the code has to change with it. It is
-- one UPDATE in the other direction too, which is why 0 is the safe default:
-- a rule that was never applied is easier to start than a payment taken from a
-- customer under a rule that was never meant for their machine.
--
-- ============================================ the seeding contract, from 0018
--
-- ONE STATEMENT PER NODE, copied from migration 0018 rather than reinvented.
-- `catalogs.slug` is UNIQUE and a live store may already own «laser-machines»;
-- a single multi-row INSERT OR IGNORE would drop the parent and then fail the
-- FOREIGN KEY of every child pointing at it. So each node is:
--   * guarded on its stable seed ID, which makes re-running a no-op;
--   * given the first slug still free — `<slug>`, then `<slug>-levo`, then the
--     id itself — so an existing catalog is never renamed or shadowed.
--
-- THE THREE SLUG FORMS ARE ALL DECLARED IN THE CODE. Unlike 0018's sections,
-- these leaves are not on an axis that `productTypeForBranch` can match by id
-- alone, so all three spellings are listed in the product types' sectionSlugs
-- (templateFamilies.ts). A laser section whose slug is in no type's list falls
-- through that function's last line — `family === 'devices' ? 'printer' :
-- 'filament'` — and a laser cutter would quietly be handed the printer form.

INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_laser', NULL,
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'laser-crafting') THEN 'laser-crafting'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'laser-crafting-levo') THEN 'laser-crafting-levo'
            ELSE 'cat_laser' END,
         'أجهزة الليزر', 'Laser Crafting', 'دروستکردن بە لەیزەر', 25, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_laser');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_laser_machines', 'cat_laser',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'laser-machines') THEN 'laser-machines'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'laser-machines-levo') THEN 'laser-machines-levo'
            ELSE 'cat_laser_machines' END,
         'ماكينات الليزر', 'Laser Machines', 'ئامێری لەیزەر', 26, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_laser_machines');
-- «ملحقات الليزر» is a DEVICES section on purpose: it resolves to the existing
-- «ملحقات وقطع» product type, which is where a lens, a honeycomb bed and a
-- filter cartridge already belonged. No new type was invented for them.
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_laser_acc', 'cat_laser',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'laser-accessories') THEN 'laser-accessories'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'laser-accessories-levo') THEN 'laser-accessories-levo'
            ELSE 'cat_laser_acc' END,
         'ملحقات الليزر وقطع الصيانة', 'Laser Accessories', 'پێداویستی لەیزەر', 27, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_laser_acc');
-- The two consumable shelves, under the «مواد الطباعة» root 0018 seeded as
-- `cat_materials`. They are the two leaves of templateFamilies' new
-- `cut-material-technology` axis, so a vinyl roll is never asked for an
-- engravable substrate and a birch sheet is never asked for a blade depth.
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_materials_laser', 'cat_materials',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'laser-material') THEN 'laser-material'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'laser-material-levo') THEN 'laser-material-levo'
            ELSE 'cat_materials_laser' END,
         'مواد الليزر', 'Laser Materials', 'کەرەستەی لەیزەر', 33, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_materials_laser');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_materials_blade', 'cat_materials',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'blade-cutting-material') THEN 'blade-cutting-material'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'blade-cutting-material-levo') THEN 'blade-cutting-material-levo'
            ELSE 'cat_materials_blade' END,
         'مواد القص بالشفرة', 'Blade Cutting Materials', 'کەرەستەی بڕین بە تیغ', 34, 0, 1, 'materials'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_materials_blade');
