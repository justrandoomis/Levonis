-- ============================================================================
--  0148 — «مواد الصيانة»: HOTENDS, BUILD PLATES, SPARE PARTS — AND WHICH
--         PRINTER EACH PART FITS (owner, 2026-09-27)
-- ============================================================================
-- «لا توجد مواد الصيانه مثل Hotend، Build Plate، Spare Parts … في مواد الصيانة
-- عند إضافة المنتج في الحقول يكون هذه القطعة مخصصة لأي طابعه … مثلا الفوهة
-- تكون مخصصة لطابعات متعددة مثل A1, A1 mini و A2L … بحيث تفيد عند الفلترة مواد
-- الصيانه لطابعه معينه، وتفيد في صيانه وطلب صيانه الطابعه، وتفيد في الخوارزمية
-- عندما يشتري المستخدم طابعة معينة يظهر له اقتراحات مواد الصيانة»
--
-- 1. THE SECTIONS. One main section and three sub-sections, in the DEVICES
--    family, all filed under the `parts` product type
--    (worker/lib/templateFamilies.ts `sectionSlugs`):
--
--      «مواد الصيانة» (cat_maint)
--        ├── «رؤوس الطباعة والفوهات» (cat_maint_hotend) → the hotend & nozzle fields
--        ├── «ألواح الطباعة» (cat_maint_plate)          → the build-plate fields
--        └── «قطع الغيار» (cat_maint_spare)             → the common part fields
--
--    THE SEEDING CONTRACT OF 0018, 0102 AND 0147, unchanged: one statement per
--    node, guarded on its stable seed id (a replay is a no-op), each given the
--    first slug still free — `<slug>`, `<slug>-levo`, then the id — so a
--    section a live store already calls «spare-parts» is never renamed or
--    shadowed. All three forms are listed in the `parts` type's `sectionSlugs`.
--
--    `END AS slug,` and never a bare `END,`: Wrangler's statement splitter
--    closes a CASE only on an END followed by a space or a semicolon
--    (tests/sqlSplit.test.ts).
--
--    `name_ckb` is EMPTY on purpose. Sorani is written by the owner's hand and
--    never generated (docs/DECISIONS.md), and an empty Sorani name reads as the
--    Arabic one everywhere a section is named (`loc`). OWNER: Sorani to be
--    written by hand — in the admin's «الأقسام» screen, no migration needed.
--
--    Not printer sections (`is_printer_catalog = 0`): a nozzle is not a printer
--    to the checkout, the gift rules or the warranty.
--
-- 2. WHICH PRINTER A PART FITS — `product_printer_fits`.
--
--    One row per (part, printer), both catalogue PRODUCTS. A link, not a spec
--    string, because every use the owner named is a join: the listing filter
--    «لطابعة معينة», the printer page's «قطع الصيانة لهذه الطابعة», the
--    suggestions for a printer a customer bought (an order line names a
--    product id), and the parts a maintenance request can quote. The free-text
--    «يناسب الموديلات» spec (acc_common `fits_models`) stays what it was: prose
--    for machines this shop does not sell.
--
--    `position` keeps the order the admin chose («A1, A1 mini, A2L»), so the
--    product page lists them the way the owner wrote them.
--
--    BOTH COLUMNS NAME A PRODUCT, and deleting either one takes the link with
--    it: worker/lib/productDeletion.ts deletes by `product_id = ?1 OR
--    printer_id = ?1` explicitly (the registry test walks this schema), and the
--    cascades below say the same for a runtime that enforces foreign keys. A
--    printer leaving the catalogue must not be blocked by the nozzles that fit
--    it, and a nozzle must not keep fitting a printer that is gone.

INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_maint', NULL,
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'maintenance-parts') THEN 'maintenance-parts'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'maintenance-parts-levo') THEN 'maintenance-parts-levo'
            ELSE 'cat_maint' END AS slug,
         'مواد الصيانة', 'Maintenance Parts', '', 23, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_maint');

INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_maint_hotend', 'cat_maint',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'hotends-nozzles') THEN 'hotends-nozzles'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'hotends-nozzles-levo') THEN 'hotends-nozzles-levo'
            ELSE 'cat_maint_hotend' END AS slug,
         'رؤوس الطباعة والفوهات', 'Hotends & Nozzles', '', 24, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_maint_hotend');

INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_maint_plate', 'cat_maint',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'build-plates') THEN 'build-plates'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'build-plates-levo') THEN 'build-plates-levo'
            ELSE 'cat_maint_plate' END AS slug,
         'ألواح الطباعة', 'Build Plates', '', 25, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_maint_plate');

INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_maint_spare', 'cat_maint',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'spare-parts') THEN 'spare-parts'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'spare-parts-levo') THEN 'spare-parts-levo'
            ELSE 'cat_maint_spare' END AS slug,
         'قطع الغيار', 'Spare Parts', '', 26, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_maint_spare');

CREATE TABLE IF NOT EXISTS product_printer_fits (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  printer_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (product_id, printer_id),
  CHECK (product_id <> printer_id)
);

-- The other direction: «every part that fits this printer» — the printer page,
-- the listing filter and the after-purchase suggestions all ask it this way.
CREATE INDEX IF NOT EXISTS idx_printer_fits_printer ON product_printer_fits(printer_id, product_id);
