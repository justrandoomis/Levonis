-- ============================================================================
--  0147 — «المستعمل»: USED PRINTERS AND USED PRINTER ACCESSORIES (owner, 2026-09-27)
-- ============================================================================
-- «لا يوجد قسم بعنوان المستعمل يكون للطابعات وملحقات الطابعات … وحقول مختلفة
-- في قسم المستعمل للطابعات أو ملحقات الطابعات حيث عند المقارنة يتم المقارنة
-- بشكل احترافي»
--
-- One main section and two sub-sections, both in the DEVICES family:
--
--   «المستعمل» (cat_used)
--     ├── «طابعات مستعملة» (cat_used_printers)        → the printer type
--     └── «ملحقات طابعات مستعملة» (cat_used_pacc)     → the parts type
--
-- WHAT MAKES THEM «مستعمل» IS NOT THE SECTION ALONE. A unit's grade, running
-- hours, Levo warranty (1 or 12 months), fault and repair are its condition
-- document (0085, worker/lib/condition.ts) — the product page, the returns
-- rules and the comparison read them from there. What the sections add is the
-- form and the template: worker/lib/templateFamilies.ts asks the used branch —
-- and only the used branch (`BRANCH_ONLY`) — «مدة الاستخدام», «الحالة
-- الشكلية», «فحص التشغيل», «العلبة الأصلية» and «قطع مستبدلة», and a used
-- printer its usage record, so two used machines compare on them.
--
-- THE SEEDING CONTRACT OF 0018 AND 0102, unchanged: one statement per node,
-- guarded on its stable seed id (a replay is a no-op), each given the first
-- slug still free — `<slug>`, `<slug>-levo`, then the id — so a section a live
-- store already calls «used» is never renamed or shadowed. All three forms are
-- listed in the product types' `sectionSlugs`.
--
-- `END AS slug,` and never a bare `END,`: Wrangler's statement splitter closes
-- a CASE only on an END followed by a space or a semicolon, and would run all
-- three inserts as one statement (tests/sqlSplit.test.ts).
--
-- «طابعات مستعملة» is a printer section (`is_printer_catalog = 1`): a used
-- printer is still a printer to the checkout — its note, its advance, its
-- serial. The main section and the accessories shelf are not.

INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_used', NULL,
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'used') THEN 'used'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'used-levo') THEN 'used-levo'
            ELSE 'cat_used' END AS slug,
         'المستعمل', 'Used', 'بەکارهاتوو', 60, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_used');

INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_used_printers', 'cat_used',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'used-printers') THEN 'used-printers'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'used-printers-levo') THEN 'used-printers-levo'
            ELSE 'cat_used_printers' END AS slug,
         'طابعات مستعملة', 'Used Printers', 'پرینتەری بەکارهاتوو', 61, 1, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_used_printers');

INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
  SELECT 'cat_used_pacc', 'cat_used',
         CASE WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'used-printer-accessories') THEN 'used-printer-accessories'
            WHEN NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = 'used-printer-accessories-levo') THEN 'used-printer-accessories-levo'
            ELSE 'cat_used_pacc' END AS slug,
         'ملحقات طابعات مستعملة', 'Used Printer Accessories', 'پێداویستی پرینتەری بەکارهاتوو', 62, 0, 1, 'devices'
   WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE id = 'cat_used_pacc');
