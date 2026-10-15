-- THE SEALED SNAPSHOT OF THE LIVE CATALOGUE (Bambu import spec §D.1, §E.1; DECISIONS row 239).
--
-- Run by `scripts/bambu-import/cf.mjs snapshot` inside workflow 60, one
-- statement per `wrangler d1 execute --remote --command` call (never --file:
-- a remote file import makes the live database unavailable while it runs).
-- The answer is sealed in memory to the dispatch's one-time key and leaves the
-- job only as snapshot.sealed; the log carries row counts and migration names.
--
-- It holds draft and hidden products, inactive sections and owner-only image
-- provenance, which is why it is sealed. It holds NO price, cost, stock,
-- reservation, package, weight, warranty, user or order column:
-- tests/bambuSnapshotSql.test.ts runs every statement on the migrated schema
-- and checks each column's origin against a reviewed allow-list, against
-- FINANCIAL_FIELDS (worker/lib/adminScope.ts) and against a deny list.
--
-- Format: each statement is one plain SELECT ending in `;`, preceded by
-- `-- @key <name>`, the name it carries in the sealed JSON.

-- @key d1_migrations
SELECT name FROM d1_migrations ORDER BY id;

-- Every section, active or not (§D.1: owner-made empty nodes are invisible publicly).
-- @key catalogs
SELECT id, parent_id, slug, name_ar, name_en, name_ckb, active, sort, template_family, is_printer_catalog
  FROM catalogs
 ORDER BY id;

-- @key brands
SELECT id, slug, name_en, name_ar, name_ckb, active
  FROM brands
 ORDER BY id;

-- Products of every status: identity and taxonomy only.
-- @key products
SELECT id, slug, status, name, name_ar, name_ku, sku, brand_id, brand, category_id, sub_category_id, template_family, composition
  FROM products
 ORDER BY id;

-- @key product_catalogs
SELECT product_id, catalog_id, position
  FROM product_catalogs
 ORDER BY product_id, catalog_id;

-- @key product_printer_fits
SELECT product_id, printer_id, position
  FROM product_printer_fits
 ORDER BY product_id, printer_id;

-- Option values with their group's name: the targets of a merge's value_map (§E.1).
-- @key option_values
SELECT v.id AS value_id, v.product_id, v.group_id, g.name_en AS group_name_en, v.name_en, v.name_ar, v.name_ckb,
       v.sku_part, v.variant_key, v.active
  FROM product_option_values v
  JOIN product_option_groups g ON g.id = v.group_id
 ORDER BY v.product_id, v.group_id, v.id;

-- @key colors
SELECT id, product_id, name_en, name_ar, name_ckb, hex, sku_part, active
  FROM product_colors
 ORDER BY product_id, id;

-- Owner-only provenance, the strongest match signal (§E.1): images taken from Bambu's own CDNs.
-- @key image_sources
SELECT product_id, source_url
  FROM product_images
 WHERE source_url LIKE 'https://store.bblcdn.com/%' OR source_url LIKE 'https://cdn.shopify.com/%'
 ORDER BY product_id, source_url;
