-- Levonis migration 0022 — backfill the relational option/colour/image tables
-- from the existing JSON columns (product-form mandate §11: "حافظ على التوافق
-- مع المنتجات الحالية عبر migration/backfill، ولا تستخدم destructive reset").
--
-- NON-DESTRUCTIVE IN BOTH DIRECTIONS:
--   * products.options / products.colors / products.images keep their JSON
--     exactly as it is. Nothing is deleted, blanked or rewritten. The old
--     read path therefore keeps working unchanged while the new one is rolled
--     out, and this migration can be re-applied to a database that already ran
--     it without duplicating anything (every INSERT is guarded on the target
--     row's stable id).
--   * inventory_mode stays 'BASE' for every existing product. Their stock is
--     tracked on products.stock today and that is exactly what BASE means, so
--     nothing silently changes how any live product is sold. Switching a
--     product to OPTION/COLOR/VARIANT_COMBINATION is an explicit admin choice.
--   * stock and low_stock_threshold on the new rows are left NULL = "this
--     level does not track stock". Inventing per-option quantities out of a
--     single base number would be fabricating data.
--
-- READING json_each. The `value` column UNQUOTES a JSON string, so
-- json_type(value) on a plain URL raises "malformed JSON". The kind of an
-- entry is read from json_each's own `type` column instead, and every
-- json_extract() is handed a value that is guaranteed to be an object.
--
-- SHAPE TOLERANCE. Two generations of JSON exist in the wild: the v1 shape
-- ({name, price_iqd, original_price_iqd, ...}) and the v2 shape ({name_en,
-- regular_price_iqd, compare_at_iqd, ...}). COALESCE reads whichever is
-- present. compare_at is deliberately NOT carried over — §4 retired it.
--
-- IDS. Every generated id is derived from ids that already exist, so a re-run
-- lands on the same rows: 'og_<product>' for the single migrated group,
-- 'ov_<product>_<option id>', 'pc_<product>_<colour id>',
-- 'pi_<product>_<index>'. Product ids are opaque tokens, so the result is
-- stable and collision-free.

-- ---------------------------------------------------------------- 1. groups
--
-- One group per product that has any option at all, named "Options". The old
-- model had no concept of a group; a single group is the faithful
-- representation of "one list of options", and the admin can split it later.
INSERT INTO product_option_groups (id, product_id, name_en, sort, active)
SELECT 'og_' || p.id, p.id, 'Options', 0, 1
  FROM products p
 WHERE json_valid(p.options)
   AND json_array_length(p.options) > 0
   AND NOT EXISTS (SELECT 1 FROM product_option_groups g WHERE g.id = 'og_' || p.id);

-- ---------------------------------------------------------------- 2. values
INSERT INTO product_option_values
  (id, product_id, group_id, name_en, sku_part, image, sort, active,
   stock, reserved, low_stock_threshold,
   regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd)
SELECT
  'ov_' || p.id || '_' || COALESCE(json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.id'), o.key),
  p.id,
  'og_' || p.id,
  COALESCE(
    NULLIF(json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.name_en'), ''),
    NULLIF(json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.name'), ''),
    NULLIF(json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.name_ar'), ''),
    'Option'
  ),
  '',
  COALESCE(json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.image'), ''),
  COALESCE(json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.order'), o.key),
  CASE WHEN json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.active') = 0 THEN 0 ELSE 1 END,
  NULL, 0, NULL,
  COALESCE(json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.regular_price_iqd'), json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.price_iqd')),
  json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.prime_price_iqd'),
  json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.pro_price_iqd'),
  json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.cost_iqd')
FROM products p, json_each(p.options) o
WHERE json_valid(p.options)
  AND o.type = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM product_option_values v
     WHERE v.id = 'ov_' || p.id || '_' || COALESCE(json_extract(CASE WHEN o.type = 'object' THEN o.value ELSE '{}' END, '$.id'), o.key)
  );

-- --------------------------------------------------------------- 3. colours
INSERT INTO product_colors
  (id, product_id, name_en, hex, image, sku_part, sort, active,
   stock, reserved, low_stock_threshold,
   regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd)
SELECT
  'pc_' || p.id || '_' || COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.id'), cl.key),
  p.id,
  COALESCE(
    NULLIF(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.name_en'), ''),
    NULLIF(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.name'), ''),
    NULLIF(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.name_ar'), ''),
    'Colour'
  ),
  -- A colour with an unusable hex becomes black rather than blocking the
  -- migration; the admin sees and fixes it in the form.
  CASE
    WHEN json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.hex') LIKE '#______' THEN lower(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.hex'))
    WHEN json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.hex') LIKE '#___'    THEN lower(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.hex'))
    ELSE '#000000'
  END,
  COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.image'), ''),
  '',
  COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.order'), cl.key),
  CASE WHEN json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.active') = 0 THEN 0 ELSE 1 END,
  NULL, 0, NULL,
  COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.regular_price_iqd'), json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.price_iqd')),
  json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.prime_price_iqd'),
  json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.pro_price_iqd'),
  json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.cost_iqd')
FROM products p, json_each(p.colors) cl
WHERE json_valid(p.colors)
  AND cl.type = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM product_colors c2
     WHERE c2.id = 'pc_' || p.id || '_' || COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.id'), cl.key)
  );

-- ----------------------------------------------------- 4. colour → option links
--
-- The old model allowed a colour to name ONE option (`option_id`) or a list
-- (`linked_option_ids`). Both become real link rows. A colour with neither
-- gets no rows, which is exactly "visible with every option" in the new
-- algebra — the same behaviour it had before.
INSERT INTO product_color_option_links (color_id, option_value_id, group_id)
SELECT
  'pc_' || p.id || '_' || COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.id'), cl.key),
  'ov_' || p.id || '_' || json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.option_id'),
  'og_' || p.id
FROM products p, json_each(p.colors) cl
WHERE json_valid(p.colors)
  AND cl.type = 'object'
  AND json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.option_id') IS NOT NULL
  AND json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.option_id') <> ''
  AND EXISTS (
    SELECT 1 FROM product_option_values v
     WHERE v.id = 'ov_' || p.id || '_' || json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.option_id')
  )
  AND EXISTS (
    SELECT 1 FROM product_colors c2
     WHERE c2.id = 'pc_' || p.id || '_' || COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.id'), cl.key)
  )
  AND NOT EXISTS (
    SELECT 1 FROM product_color_option_links l
     WHERE l.color_id = 'pc_' || p.id || '_' || COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.id'), cl.key)
       AND l.option_value_id = 'ov_' || p.id || '_' || json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.option_id')
  );

INSERT INTO product_color_option_links (color_id, option_value_id, group_id)
SELECT
  'pc_' || p.id || '_' || COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.id'), cl.key),
  'ov_' || p.id || '_' || li.value,
  'og_' || p.id
FROM products p,
     json_each(p.colors) cl,
     -- COALESCE is load-bearing: json_each(NULL) raises "malformed JSON", and
     -- a v1 colour has no linked_option_ids at all. The WHERE clause below
     -- cannot save us because the table-valued function is evaluated first.
     json_each(COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.linked_option_ids'), '[]')) li
WHERE json_valid(p.colors)
  AND cl.type = 'object'
  AND json_type(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.linked_option_ids')) = 'array'
  AND EXISTS (
    SELECT 1 FROM product_option_values v WHERE v.id = 'ov_' || p.id || '_' || li.value
  )
  AND EXISTS (
    SELECT 1 FROM product_colors c2
     WHERE c2.id = 'pc_' || p.id || '_' || COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.id'), cl.key)
  )
  AND NOT EXISTS (
    SELECT 1 FROM product_color_option_links l
     WHERE l.color_id = 'pc_' || p.id || '_' || COALESCE(json_extract(CASE WHEN cl.type = 'object' THEN cl.value ELSE '{}' END, '$.id'), cl.key)
       AND l.option_value_id = 'ov_' || p.id || '_' || li.value
  );

-- ----------------------------------------------------------------- 5. images
--
-- products.images holds either a JSON array of URL STRINGS (v1) or an array of
-- media OBJECTS (v2, {url, primary, alt_en}). They are handled by two separate
-- statements rather than one clever CASE, because json_extract() raises
-- "malformed JSON" the moment it is handed a plain string, and SQLite is free
-- to evaluate a guarded expression before the guard that protects it. Every
-- json_extract below is therefore given a value that is guaranteed to be an
-- object.
--
-- The first image becomes primary when nothing claims the role, which matches
-- what the storefront already displays.

-- 5a. v1: an array of URL strings.
INSERT INTO product_images (id, product_id, url, alt_en, sort_order, is_primary, content_type)
SELECT
  'pi_' || p.id || '_' || im.key,
  p.id,
  im.value,
  '',
  im.key,
  CASE WHEN im.key = 0 THEN 1 ELSE 0 END,
  ''
FROM products p, json_each(p.images) im
WHERE json_valid(p.images)
  AND im.type = 'text'
  AND im.value <> ''
  AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.id = 'pi_' || p.id || '_' || im.key)
  AND NOT EXISTS (
    -- A product that already has relational images was edited in the new form;
    -- never mix migrated rows into a set the admin curated.
    SELECT 1 FROM product_images pi2 WHERE pi2.product_id = p.id
  );

-- 5b. v2: an array of media objects.
INSERT INTO product_images (id, product_id, url, alt_en, sort_order, is_primary, content_type)
SELECT
  'pi_' || p.id || '_' || im.key,
  p.id,
  COALESCE(json_extract(CASE WHEN im.type = 'object' THEN im.value ELSE '{}' END, '$.url'), ''),
  COALESCE(json_extract(CASE WHEN im.type = 'object' THEN im.value ELSE '{}' END, '$.alt_en'), ''),
  im.key,
  CASE
    WHEN json_extract(CASE WHEN im.type = 'object' THEN im.value ELSE '{}' END, '$.primary') = 1 THEN 1
    WHEN im.key = 0 AND NOT EXISTS (
      SELECT 1 FROM json_each(p.images) j
       WHERE json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.primary') = 1
    ) THEN 1
    ELSE 0
  END,
  ''
FROM products p, json_each(p.images) im
WHERE json_valid(p.images)
  AND im.type = 'object'
  AND COALESCE(json_extract(CASE WHEN im.type = 'object' THEN im.value ELSE '{}' END, '$.url'), '') <> ''
  AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.id = 'pi_' || p.id || '_' || im.key)
  AND NOT EXISTS (SELECT 1 FROM product_images pi2 WHERE pi2.product_id = p.id);

-- ---------------------------------------------------- 6. category from legacy
--
-- products.subcategory_id was free text; product_catalogs holds the real
-- placements. Where a product sits in exactly ONE catalog, that catalog
-- becomes its main section. Anything ambiguous is left NULL for the admin to
-- set — guessing a section would mis-file real products.
UPDATE products
   SET category_id = (
     SELECT pc.catalog_id FROM product_catalogs pc WHERE pc.product_id = products.id
   )
 WHERE category_id IS NULL
   AND (SELECT COUNT(*) FROM product_catalogs pc WHERE pc.product_id = products.id) = 1;
