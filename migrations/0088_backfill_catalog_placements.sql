-- Levonis migration 0088 — PUT EVERY PRODUCT BACK ON THE SHELF IT IS FILED UNDER.
--
-- THE DEFECT. `product_catalogs` is the table that answers "which catalogs
-- list this product". The admin product form records the owner's choice in
-- `products.category_id` and `products.sub_category_id` and posts
-- `catalog_ids: []` — a list `planCatalogs()` treats as complete, so every
-- save DELETED the product's placements. On the live database the table is
-- empty, and the consequences were not only cosmetic:
--
--   * `/api/home` counts through it, so the storefront's first screen showed
--     NO categories at all while the admin listed «الطابعات · 3»;
--   * `worker/lib/printerIdentity.ts` reads ONLY this table to decide whether
--     a product is a printer, so at runtime NOTHING was a printer — and with
--     it the PLUS printer gift, the PRO maintenance discount, the referral
--     free-delivery rule (worker/lib/membershipOps.ts) and the printer
--     delivery advance were all silently off, on a shop that sells printers.
--
-- The code fix is in `worker/lib/catalogMembership.ts`
-- (`withClassificationPlacements`), applied on every write path, so this can
-- never happen again. This migration repairs the rows already written.
--
-- WHY NOT THE OTHER DIRECTION. Migration 0022 ran exactly the opposite
-- backfill — `UPDATE products SET category_id = (SELECT ... FROM
-- product_catalogs ...)` — because back then the join table was the one with
-- the data. The form has been writing the columns ever since, so the repair
-- now goes columns → table.
--
-- RE-RUNNABLE, which `scripts/migrate-check.mjs --twice` requires. Each
-- statement is guarded by `NOT EXISTS`, so a second run inserts nothing. The
-- `EXISTS (SELECT 1 FROM catalogs ...)` guard is load-bearing for a different
-- reason: `category_id` is a nullable reference and a row pointing at a
-- deleted catalog would fail the foreign key.
--
-- POSITION. `product_catalogs` declares `UNIQUE (catalog_id, position)`, so
-- the new rows cannot all take MAX+1. `ROW_NUMBER()` over the catalog numbers
-- them from the current maximum, in creation order, which is the order the
-- merchandising screen would have put them in anyway.
--
-- THE LEGACY `subcategory_id` (no underscore, migration 0001) IS DELIBERATELY
-- NOT BACKFILLED. It is free text, not a foreign key: it holds names and slugs
-- of things that were never catalog ids, and inserting from it would file
-- products under catalogs that do not exist — or, worse, under one whose id
-- happens to collide. The read path in `catalogMembership.ts` still matches it
-- where it is genuinely a catalog id; that is the right place for a guess.

-- 1. The MAIN section every product was filed under.
INSERT INTO product_catalogs (product_id, catalog_id, position)
SELECT p.id,
       p.category_id,
       (SELECT COALESCE(MAX(x.position), 0) FROM product_catalogs x WHERE x.catalog_id = p.category_id)
         + ROW_NUMBER() OVER (PARTITION BY p.category_id ORDER BY p.created_at, p.id)
  FROM products p
 WHERE p.category_id IS NOT NULL
   AND p.category_id <> ''
   AND EXISTS (SELECT 1 FROM catalogs c WHERE c.id = p.category_id)
   AND NOT EXISTS (
         SELECT 1 FROM product_catalogs pc
          WHERE pc.product_id = p.id AND pc.catalog_id = p.category_id
       );

-- 2. The SUB section, which is what actually carries most of the catalogue —
--    a product is classified under "FDM Printers", and "Printers" is its
--    parent. Both rows are written so that every EXISTING reader of this
--    table stays correct without having to become recursive.
INSERT INTO product_catalogs (product_id, catalog_id, position)
SELECT p.id,
       p.sub_category_id,
       (SELECT COALESCE(MAX(x.position), 0) FROM product_catalogs x WHERE x.catalog_id = p.sub_category_id)
         + ROW_NUMBER() OVER (PARTITION BY p.sub_category_id ORDER BY p.created_at, p.id)
  FROM products p
 WHERE p.sub_category_id IS NOT NULL
   AND p.sub_category_id <> ''
   AND EXISTS (SELECT 1 FROM catalogs c WHERE c.id = p.sub_category_id)
   AND NOT EXISTS (
         SELECT 1 FROM product_catalogs pc
          WHERE pc.product_id = p.id AND pc.catalog_id = p.sub_category_id
       );
