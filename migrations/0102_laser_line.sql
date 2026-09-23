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
-- Resin». A cutter is not filed UNDER «الطابعات» — it is a different machine
-- and a shopper looking for one is not browsing 3D printers — so it gets a
-- root of its own at sort 25, between the printer accessories and the
-- materials, which is where «بجانب» puts it on the storefront. That is a
-- statement about the SHELF only; what RULES it is sold under is the section
-- below, and there it is treated exactly as a printer.
--
-- ================ is_printer_catalog = 1 ON THE MACHINES — THE OWNER'S CALL ==
--
-- «الليزر يعتبر كطابعة، أي أنه يعامل كطابعة فيلمنت أو رزن: من الضمان الممدد،
--  من دفع مقدمة خمسين ألف، التوصيل، خصم الصيانة للبرو — نفس طابعة الفيلمنت
--  والرزن.»
--
-- This file first shipped with 0 on all five nodes and a long argument for it.
-- The argument was mine, not the shop's, and the owner has answered it: a
-- laser cutter is a machine they sell the way they sell a printer, so it
-- carries the printer's rules. The flag is what carries them, so the flag is 1.
--
-- WHAT THE 1 TURNS ON, each one asked for by name:
--   * worker/lib/warrantyPlans.ts      — the extended warranty (+12 / +24)
--   * worker/lib/printerAdvance.ts     — the «٥٠ الف» advance on home delivery
--   * worker/lib/membershipOps.ts      — the PRO maintenance discount, and the
--                                        PLUS gift that shares the same join
--   * worker/lib/reviewQuality.ts      — a review of a machine earns its reward
--   * worker/lib/orderStageOps.ts      — the referral free-delivery rule and
--                                        `is_printer` on `OrderDelivered`
--
-- WHY ONLY TWO OF THE FIVE NODES. This mirrors migration 0018 exactly rather
-- than inventing a rule for the laser line: there `cat_printers`,
-- `cat_printers_fdm` and `cat_printers_resin` are 1, while `cat_pacc*` (the
-- accessories) and `cat_materials*` are 0. A spool is not a printer and a lens
-- is not a printer; the machine is. So `cat_laser` and `cat_laser_machines`
-- are 1, and the accessories and the two consumable shelves stay 0 — which is
-- «نفس طابعة الفيلمنت والرزن» read literally.
--
-- WHAT THE 1 DOES **NOT** DO, and this is the part worth knowing. It does not
-- give a laser cutter the printer's SPEC SHEET. The form and the CSV template
-- are chosen by `template_family` through `productTypeForBranch`
-- (worker/lib/templateFamilies.ts), which never reads this column; the only
-- place the two meet is `worker/lib/importApply.ts`, where the flag feeds
-- `printerWarrantyRules` and nothing else. So a cutter is asked for its laser
-- source and its work area, not for a nozzle diameter — and is still sold with
-- the printer's warranty, advance and PRO discount.
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
         'أجهزة الليزر', 'Laser Crafting', 'دروستکردن بە لەیزەر', 25, 1, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_laser');
INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_laser_machines', 'cat_laser',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'laser-machines') THEN 'laser-machines'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'laser-machines-levo') THEN 'laser-machines-levo'
            ELSE 'cat_laser_machines' END,
         'ماكينات الليزر', 'Laser Machines', 'ئامێری لەیزەر', 26, 1, 1, 'devices'
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
