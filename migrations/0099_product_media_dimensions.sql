-- ============================================================================
-- 0099 — SELECTION-SPECIFIC PHYSICAL DIMENSIONS + LEGACY SELECTOR IMAGES
-- ============================================================================
--
-- A product-level measurement is only the fallback.  A printer model, colour,
-- or exact option/colour combination can ship in a different carton, so each
-- selector row gets the same eight nullable facts as `products`.  NULL means
-- "inherit the next less-specific row"; zero is never a measurement.
--
-- Order items carry the resolved values under the same column names.  They are
-- snapshots: changing the catalogue later must not rewrite the size/weight the
-- customer bought or the courier quote used.

-- ---------------------------------------------------------------------------
-- Option values (for example A1 vs A1 Combo)
-- ---------------------------------------------------------------------------
ALTER TABLE product_option_values ADD COLUMN net_weight_g INTEGER
  CHECK (net_weight_g IS NULL OR net_weight_g > 0);
ALTER TABLE product_option_values ADD COLUMN width_mm INTEGER
  CHECK (width_mm IS NULL OR width_mm > 0);
ALTER TABLE product_option_values ADD COLUMN depth_mm INTEGER
  CHECK (depth_mm IS NULL OR depth_mm > 0);
ALTER TABLE product_option_values ADD COLUMN height_mm INTEGER
  CHECK (height_mm IS NULL OR height_mm > 0);
ALTER TABLE product_option_values ADD COLUMN package_weight_g INTEGER
  CHECK (package_weight_g IS NULL OR package_weight_g > 0);
ALTER TABLE product_option_values ADD COLUMN package_width_mm INTEGER
  CHECK (package_width_mm IS NULL OR package_width_mm > 0);
ALTER TABLE product_option_values ADD COLUMN package_depth_mm INTEGER
  CHECK (package_depth_mm IS NULL OR package_depth_mm > 0);
ALTER TABLE product_option_values ADD COLUMN package_height_mm INTEGER
  CHECK (package_height_mm IS NULL OR package_height_mm > 0);

-- ---------------------------------------------------------------------------
-- Colours
-- ---------------------------------------------------------------------------
ALTER TABLE product_colors ADD COLUMN net_weight_g INTEGER
  CHECK (net_weight_g IS NULL OR net_weight_g > 0);
ALTER TABLE product_colors ADD COLUMN width_mm INTEGER
  CHECK (width_mm IS NULL OR width_mm > 0);
ALTER TABLE product_colors ADD COLUMN depth_mm INTEGER
  CHECK (depth_mm IS NULL OR depth_mm > 0);
ALTER TABLE product_colors ADD COLUMN height_mm INTEGER
  CHECK (height_mm IS NULL OR height_mm > 0);
ALTER TABLE product_colors ADD COLUMN package_weight_g INTEGER
  CHECK (package_weight_g IS NULL OR package_weight_g > 0);
ALTER TABLE product_colors ADD COLUMN package_width_mm INTEGER
  CHECK (package_width_mm IS NULL OR package_width_mm > 0);
ALTER TABLE product_colors ADD COLUMN package_depth_mm INTEGER
  CHECK (package_depth_mm IS NULL OR package_depth_mm > 0);
ALTER TABLE product_colors ADD COLUMN package_height_mm INTEGER
  CHECK (package_height_mm IS NULL OR package_height_mm > 0);

-- ---------------------------------------------------------------------------
-- Exact combinations
-- ---------------------------------------------------------------------------
ALTER TABLE product_variants ADD COLUMN net_weight_g INTEGER
  CHECK (net_weight_g IS NULL OR net_weight_g > 0);
ALTER TABLE product_variants ADD COLUMN width_mm INTEGER
  CHECK (width_mm IS NULL OR width_mm > 0);
ALTER TABLE product_variants ADD COLUMN depth_mm INTEGER
  CHECK (depth_mm IS NULL OR depth_mm > 0);
ALTER TABLE product_variants ADD COLUMN height_mm INTEGER
  CHECK (height_mm IS NULL OR height_mm > 0);
ALTER TABLE product_variants ADD COLUMN package_weight_g INTEGER
  CHECK (package_weight_g IS NULL OR package_weight_g > 0);
ALTER TABLE product_variants ADD COLUMN package_width_mm INTEGER
  CHECK (package_width_mm IS NULL OR package_width_mm > 0);
ALTER TABLE product_variants ADD COLUMN package_depth_mm INTEGER
  CHECK (package_depth_mm IS NULL OR package_depth_mm > 0);
ALTER TABLE product_variants ADD COLUMN package_height_mm INTEGER
  CHECK (package_height_mm IS NULL OR package_height_mm > 0);

-- ---------------------------------------------------------------------------
-- Immutable order-line snapshots (resolved before INSERT)
-- ---------------------------------------------------------------------------
ALTER TABLE order_items ADD COLUMN net_weight_g INTEGER
  CHECK (net_weight_g IS NULL OR net_weight_g > 0);
ALTER TABLE order_items ADD COLUMN width_mm INTEGER
  CHECK (width_mm IS NULL OR width_mm > 0);
ALTER TABLE order_items ADD COLUMN depth_mm INTEGER
  CHECK (depth_mm IS NULL OR depth_mm > 0);
ALTER TABLE order_items ADD COLUMN height_mm INTEGER
  CHECK (height_mm IS NULL OR height_mm > 0);
ALTER TABLE order_items ADD COLUMN package_weight_g INTEGER
  CHECK (package_weight_g IS NULL OR package_weight_g > 0);
ALTER TABLE order_items ADD COLUMN package_width_mm INTEGER
  CHECK (package_width_mm IS NULL OR package_width_mm > 0);
ALTER TABLE order_items ADD COLUMN package_depth_mm INTEGER
  CHECK (package_depth_mm IS NULL OR package_depth_mm > 0);
ALTER TABLE order_items ADD COLUMN package_height_mm INTEGER
  CHECK (package_height_mm IS NULL OR package_height_mm > 0);

-- ---------------------------------------------------------------------------
-- One image authority
-- ---------------------------------------------------------------------------
-- `product_option_values.image` and `product_colors.image` are rollout-era
-- compatibility columns. Preserve every owned legacy selector picture as a
-- bound `product_images` row when an identical binding does not already
-- exist, then drain both scalar columns. New readers and writers have exactly
-- one authority; an external legacy scalar is removed rather than hotlinked.

-- A quarantined row is deliberately still a `product_images` row: its id,
-- selector binding and `source_url` are repair provenance, not an image a
-- browser may load.  Keeping that state explicit is important.  An empty URL
-- alone is too easy for the admin's full-replacement save to mistake for a
-- broken active image (and then either reject or delete), while a reason lets
-- readers exclude the row and lets a later verified upsert of the same id
-- activate it by clearing the reason.
ALTER TABLE product_images ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0
  CHECK (
    quarantined = 0 OR (
      quarantined = 1
      AND trim(url) = ''
      AND trim(r2_key) = ''
      AND trim(source_url) <> ''
    )
  );
ALTER TABLE product_images ADD COLUMN quarantine_reason TEXT NOT NULL DEFAULT '';

-- `products.images` remained writable for years after `product_images` was
-- introduced. A product created by an older/import path can therefore reach
-- this migration with a populated JSON mirror and ZERO authoritative rows.
-- Snapshot both supported mirror spellings (a URL string or a MediaV2 object)
-- before the quarantine pass below. Safe local WebP URLs will be activated by
-- the common canonicalisation step; external/non-WebP values will retain this
-- row only as inert `source_url` provenance.
WITH mirror_media AS (
  SELECT
    p.id AS product_id,
    CAST(j.key AS INTEGER) AS array_index,
    j.type AS item_type,
    CASE
      WHEN j.type = 'text' THEN trim(CAST(j.value AS TEXT))
      WHEN j.type = 'object' THEN trim(COALESCE(CAST(json_extract(j.value, '$.url') AS TEXT), ''))
      ELSE ''
    END AS url,
    CASE
      WHEN j.type = 'object' THEN trim(COALESCE(CAST(json_extract(j.value, '$.source_url') AS TEXT), ''))
      ELSE ''
    END AS source_url,
    CASE
      WHEN j.type = 'object' AND json_type(j.value, '$.primary') = 'true' THEN 1
      ELSE 0
    END AS is_primary,
    CASE WHEN j.type = 'object' THEN COALESCE(CAST(json_extract(j.value, '$.alt_en') AS TEXT), '') ELSE '' END AS alt_en,
    CASE WHEN j.type = 'object' THEN COALESCE(CAST(json_extract(j.value, '$.alt_ar') AS TEXT), '') ELSE '' END AS alt_ar,
    CASE WHEN j.type = 'object' THEN COALESCE(CAST(json_extract(j.value, '$.alt_ckb') AS TEXT), '') ELSE '' END AS alt_ckb,
    CASE
      WHEN j.type = 'object' AND json_type(j.value, '$.order') IN ('integer', 'real')
        THEN CAST(json_extract(j.value, '$.order') AS INTEGER)
      ELSE CAST(j.key AS INTEGER)
    END AS sort_order,
    CASE WHEN j.type = 'object' AND json_type(j.value, '$.width') IN ('integer', 'real')
      THEN CAST(json_extract(j.value, '$.width') AS INTEGER) ELSE NULL END AS width,
    CASE WHEN j.type = 'object' AND json_type(j.value, '$.height') IN ('integer', 'real')
      THEN CAST(json_extract(j.value, '$.height') AS INTEGER) ELSE NULL END AS height,
    CASE WHEN j.type = 'object' AND json_type(j.value, '$.bytes') IN ('integer', 'real')
      THEN CAST(json_extract(j.value, '$.bytes') AS INTEGER) ELSE NULL END AS bytes,
    CASE WHEN j.type = 'object' THEN COALESCE(CAST(json_extract(j.value, '$.content_type') AS TEXT), '') ELSE '' END AS content_type,
    CASE WHEN j.type = 'object' THEN trim(COALESCE(CAST(json_extract(j.value, '$.option_value_id') AS TEXT), '')) ELSE '' END AS option_value_id,
    CASE WHEN j.type = 'object' THEN trim(COALESCE(CAST(json_extract(j.value, '$.color_id') AS TEXT), '')) ELSE '' END AS color_id,
    CASE WHEN j.type = 'object' THEN trim(COALESCE(CAST(json_extract(j.value, '$.variant_id') AS TEXT), '')) ELSE '' END AS variant_id
  FROM products p
  CROSS JOIN json_each(
    CASE
      WHEN json_valid(COALESCE(p.images, '[]')) AND substr(ltrim(COALESCE(p.images, '')), 1, 1) = '['
        THEN p.images
      ELSE '[]'
    END
  ) AS j
  WHERE j.type IN ('text', 'object')
)
INSERT OR IGNORE INTO product_images
  (id, product_id, url, alt_en, sort_order, is_primary,
   option_value_id, color_id, variant_id, width, height, bytes, content_type,
   alt_ar, alt_ckb, r2_key, source_url)
SELECT
  'pi_legacy_mirror_' || m.product_id || '_' || m.array_index,
  m.product_id,
  m.url,
  m.alt_en,
  m.sort_order,
  CASE
    -- A malformed legacy mirror can claim more than one primary. Preserve a
    -- deterministic winner (the first authored true in array order); if that
    -- row is later quarantined, the canonical fallback promotion below takes
    -- over rather than leaving the gallery without a lead.
    WHEN m.is_primary = 1 AND m.array_index = (
      SELECT MIN(candidate.array_index)
        FROM mirror_media candidate
       WHERE candidate.product_id = m.product_id
         AND candidate.is_primary = 1
    ) THEN 1
    ELSE 0
  END,
  CASE WHEN EXISTS (
    SELECT 1 FROM product_option_values v
     WHERE v.id = m.option_value_id AND v.product_id = m.product_id
  ) THEN m.option_value_id ELSE NULL END,
  CASE WHEN EXISTS (
    SELECT 1 FROM product_colors c
     WHERE c.id = m.color_id AND c.product_id = m.product_id
  ) THEN m.color_id ELSE NULL END,
  CASE WHEN EXISTS (
    SELECT 1 FROM product_variants v
     WHERE v.id = m.variant_id AND v.product_id = m.product_id
  ) THEN m.variant_id ELSE NULL END,
  m.width,
  m.height,
  m.bytes,
  m.content_type,
  m.alt_ar,
  m.alt_ckb,
  '',
  m.source_url
FROM mirror_media m
WHERE (m.url <> '' OR m.source_url <> '')
  -- A non-empty relation set is already authoritative. Importing additional
  -- mirror entries here would resurrect stale local URLs beside a curated
  -- gallery merely because their spelling differs. Snapshot the mirror only
  -- for products that genuinely have no product_images rows at migration
  -- time; every item of a mirror-only array is still inserted by this one
  -- statement.
  AND NOT EXISTS (
    SELECT 1 FROM product_images authority
     WHERE authority.product_id = m.product_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM product_images i
     WHERE i.product_id = m.product_id
       AND (
         (m.url <> '' AND (i.url = m.url OR i.source_url = m.url))
         OR (m.source_url <> '' AND (i.url = m.source_url OR i.source_url = m.source_url))
       )
  );

INSERT OR IGNORE INTO product_images
  (id, product_id, url, alt_en, sort_order, is_primary, option_value_id, r2_key)
SELECT
  'pi_legacy_option_' || v.id,
  v.product_id,
  v.image,
  v.name_en,
  v.sort,
  0,
  v.id,
  CASE
    WHEN v.image GLOB '/files/[A-Za-z0-9]*'
      AND length(substr(v.image, 8)) BETWEEN 5 AND 500
      AND instr(v.image, '..') = 0
      AND instr(v.image, char(92)) = 0
      AND instr(v.image, '%') = 0
    THEN substr(v.image, 8)
    ELSE ''
  END
FROM product_option_values v
WHERE trim(v.image) <> ''
  -- External hotlinks stay outside the new authority. Only a URL whose key
  -- satisfies `isSafeMediaKey`'s shape is eligible for this SQL backfill.
  AND v.image GLOB '/files/[A-Za-z0-9]*'
  AND length(substr(v.image, 8)) BETWEEN 5 AND 500
  AND substr(v.image, 8) NOT GLOB '*[^A-Za-z0-9._/-]*'
  AND instr(substr(v.image, 8), '//') = 0
  AND substr(v.image, 8, 1) <> '/'
  AND substr(v.image, -1) <> '/'
  AND substr(v.image, 8, 2) <> './'
  AND substr(v.image, 8, 3) <> '../'
  AND instr(substr(v.image, 8), '/./') = 0
  AND instr(substr(v.image, 8), '/../') = 0
  AND substr(substr(v.image, 8), -2) <> '/.'
  AND substr(substr(v.image, 8), -3) <> '/..'
  AND NOT EXISTS (
    SELECT 1
      FROM product_images i
     WHERE i.product_id = v.product_id
       AND i.option_value_id = v.id
       AND i.url = v.image
  );

INSERT OR IGNORE INTO product_images
  (id, product_id, url, alt_en, sort_order, is_primary, color_id, r2_key)
SELECT
  'pi_legacy_color_' || c.id,
  c.product_id,
  c.image,
  c.name_en,
  c.sort,
  0,
  c.id,
  CASE
    WHEN c.image GLOB '/files/[A-Za-z0-9]*'
      AND length(substr(c.image, 8)) BETWEEN 5 AND 500
      AND instr(c.image, '..') = 0
      AND instr(c.image, char(92)) = 0
      AND instr(c.image, '%') = 0
    THEN substr(c.image, 8)
    ELSE ''
  END
FROM product_colors c
WHERE trim(c.image) <> ''
  AND c.image GLOB '/files/[A-Za-z0-9]*'
  AND length(substr(c.image, 8)) BETWEEN 5 AND 500
  AND substr(c.image, 8) NOT GLOB '*[^A-Za-z0-9._/-]*'
  AND instr(substr(c.image, 8), '//') = 0
  AND substr(c.image, 8, 1) <> '/'
  AND substr(c.image, -1) <> '/'
  AND substr(c.image, 8, 2) <> './'
  AND substr(c.image, 8, 3) <> '../'
  AND instr(substr(c.image, 8), '/./') = 0
  AND instr(substr(c.image, 8), '/../') = 0
  AND substr(substr(c.image, 8), -2) <> '/.'
  AND substr(substr(c.image, 8), -3) <> '/..'
  AND NOT EXISTS (
    SELECT 1
      FROM product_images i
     WHERE i.product_id = c.product_id
       AND i.color_id = c.id
       AND i.url = c.image
  );

-- An inactive blank bound row can safely carry the drained scalar's
-- provenance. Never attach it to an ACTIVE row with a different URL: that
-- would falsely claim the scalar was the source of the image customers see.
UPDATE product_images
   SET source_url = (
     SELECT v.image FROM product_option_values v
      WHERE v.id = product_images.option_value_id
        AND v.product_id = product_images.product_id
        AND trim(v.image) <> ''
      LIMIT 1
   ),
       quarantined = 1,
       quarantine_reason = 'legacy_option_source'
 WHERE trim(COALESCE(source_url, '')) = ''
   AND trim(COALESCE(url, '')) = ''
   AND EXISTS (
     SELECT 1 FROM product_option_values v
      WHERE v.id = product_images.option_value_id
        AND v.product_id = product_images.product_id
        AND trim(v.image) <> ''
   );

UPDATE product_images
   SET source_url = (
     SELECT c.image FROM product_colors c
      WHERE c.id = product_images.color_id
        AND c.product_id = product_images.product_id
        AND trim(c.image) <> ''
      LIMIT 1
   ),
       quarantined = 1,
       quarantine_reason = 'legacy_color_source'
 WHERE trim(COALESCE(source_url, '')) = ''
   AND trim(COALESCE(url, '')) = ''
   AND EXISTS (
     SELECT 1 FROM product_colors c
      WHERE c.id = product_images.color_id
        AND c.product_id = product_images.product_id
        AND trim(c.image) <> ''
   );

-- Anything the active backfill above refused is still valuable provenance.
-- Preserve it as its own bound quarantine row before draining the scalar. A
-- distinct `_source_` id prevents an active row with another image from
-- suppressing the provenance, while the exact URL/source predicate prevents
-- duplicates when this scalar already has a row.
INSERT OR IGNORE INTO product_images
  (id, product_id, url, alt_en, sort_order, is_primary, option_value_id, r2_key, source_url, quarantined, quarantine_reason)
SELECT
  'pi_legacy_option_source_' || v.id,
  v.product_id,
  '',
  v.name_en,
  v.sort,
  0,
  v.id,
  '',
  v.image,
  1,
  'legacy_option_source'
FROM product_option_values v
WHERE trim(v.image) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM product_images i
     WHERE i.product_id = v.product_id
       AND i.option_value_id = v.id
       AND (i.url = v.image OR i.source_url = v.image)
  );

INSERT OR IGNORE INTO product_images
  (id, product_id, url, alt_en, sort_order, is_primary, color_id, r2_key, source_url, quarantined, quarantine_reason)
SELECT
  'pi_legacy_color_source_' || c.id,
  c.product_id,
  '',
  c.name_en,
  c.sort,
  0,
  c.id,
  '',
  c.image,
  1,
  'legacy_color_source'
FROM product_colors c
WHERE trim(c.image) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM product_images i
     WHERE i.product_id = c.product_id
       AND i.color_id = c.id
       AND (i.url = c.image OR i.source_url = c.image)
  );

-- The bound rows above now own every safe local selector image and retain
-- every refused address as inactive source provenance. External scalar
-- hotlinks cannot be fetched inside SQL, so fail closed by removing the
-- scalar serving path; a later repair can explicitly re-ingest source_url.
UPDATE product_option_values SET image = '' WHERE image <> '';
UPDATE product_colors SET image = '' WHERE image <> '';

-- Rows that already existed before this migration get the same canonical key.
-- Normalize even a non-empty mismatch: a local URL and its r2_key are two
-- spellings of ONE object, and leaving them divergent would make the row look
-- active while different readers fetch different objects. Only canonical
-- lowercase WebP paths are activated; other local formats are quarantined by
-- the next statement.
UPDATE product_images
   SET r2_key = substr(url, 8)
 WHERE url GLOB '/files/[A-Za-z0-9]*'
   AND substr(url, -5) = '.webp'
   AND length(substr(url, 8)) BETWEEN 5 AND 500
   AND substr(url, 8) NOT GLOB '*[^A-Za-z0-9._/-]*'
   AND instr(substr(url, 8), '//') = 0
   AND substr(url, 8, 1) <> '/'
   AND substr(url, -1) <> '/'
   AND substr(url, 8, 2) <> './'
   AND substr(url, 8, 3) <> '../'
   AND instr(substr(url, 8), '/./') = 0
   AND instr(substr(url, 8), '/../') = 0
   AND substr(substr(url, 8), -2) <> '/.'
   AND substr(substr(url, 8), -3) <> '/..';

-- A `.webp` suffix cannot overrule explicit legacy metadata saying that the
-- object is some other format. SQL cannot inspect R2 bytes, so blank metadata
-- remains eligible for the runtime verifier; an explicit contradiction is
-- quarantined now and keeps its original address as repair provenance.
UPDATE product_images
   SET source_url = CASE
         WHEN trim(COALESCE(source_url, '')) = '' THEN url
         ELSE source_url
       END,
       url = '',
       r2_key = '',
       is_primary = 0,
       quarantined = 1,
       quarantine_reason = 'content_type_not_webp'
 WHERE trim(url) <> ''
   AND trim(COALESCE(content_type, '')) <> ''
   AND lower(trim(content_type)) <> 'image/webp';

-- A local key is not enough to make an image canonical. Product media is
-- served as WebP; legacy JPG/PNG/GIF/AVIF rows bypassed the ingest/conversion
-- pipeline and must not stay active merely because their path is ours. Keep
-- the original URL as repair provenance, then fail closed exactly like an
-- external hotlink. Existing bytes are deliberately not queued for deletion
-- here: the repair/orphan pipeline decides their fate after reference checks.
UPDATE product_images
   SET source_url = CASE
         WHEN trim(COALESCE(source_url, '')) = '' THEN url
         ELSE source_url
       END,
       url = '',
       r2_key = '',
       is_primary = 0,
       quarantined = 1,
       quarantine_reason = 'legacy_local_format'
 WHERE trim(url) <> ''
   AND url GLOB '/files/[A-Za-z0-9]*'
   AND length(substr(url, 8)) BETWEEN 5 AND 500
   AND substr(url, 8) NOT GLOB '*[^A-Za-z0-9._/-]*'
   AND instr(substr(url, 8), '//') = 0
   AND substr(url, 8, 1) <> '/'
   AND substr(url, -1) <> '/'
   AND substr(url, 8, 2) <> './'
   AND substr(url, 8, 3) <> '../'
   AND instr(substr(url, 8), '/./') = 0
   AND instr(substr(url, 8), '/../') = 0
   AND substr(substr(url, 8), -2) <> '/.'
   AND substr(substr(url, 8), -3) <> '/..'
   AND substr(url, -5) <> '.webp';

-- Existing product_images hotlinks are quarantined as provenance only. They
-- are no longer loaded by a customer's browser, while the original source is
-- retained for an admin to re-import through the guarded fetch pipeline.
UPDATE product_images
   SET source_url = CASE
         WHEN trim(COALESCE(source_url, '')) = '' THEN url
         ELSE source_url
       END,
       url = '',
       r2_key = '',
       is_primary = 0,
       quarantined = 1,
       quarantine_reason = 'external_or_unsafe_url'
 WHERE trim(url) <> ''
   AND NOT (
     url GLOB '/files/[A-Za-z0-9]*'
     AND length(substr(url, 8)) BETWEEN 5 AND 500
     AND substr(url, 8) NOT GLOB '*[^A-Za-z0-9._/-]*'
     AND instr(substr(url, 8), '//') = 0
     AND substr(url, 8, 1) <> '/'
     AND substr(url, -1) <> '/'
     AND substr(url, 8, 2) <> './'
     AND substr(url, 8, 3) <> '../'
     AND instr(substr(url, 8), '/./') = 0
     AND instr(substr(url, 8), '/../') = 0
     AND substr(substr(url, 8), -2) <> '/.'
     AND substr(substr(url, 8), -3) <> '/..'
   );

-- Final fail-closed drain: no alternate spelling may remain active. This also
-- catches rows with an empty URL but a stray key/primary bit, unsafe local
-- paths, and URL/key disagreement that the format-specific clauses above did
-- not activate. Preserve a non-empty URL as provenance before clearing it.
-- A completely empty shell has no provenance to preserve and cannot satisfy
-- the quarantine invariant, so remove it before marking the remaining rows.
DELETE FROM product_images
 WHERE trim(COALESCE(url, '')) = ''
   AND trim(COALESCE(r2_key, '')) = ''
   AND trim(COALESCE(source_url, '')) = '';

UPDATE product_images
   SET source_url = CASE
         WHEN trim(COALESCE(source_url, '')) = '' AND trim(COALESCE(url, '')) <> '' THEN url
         WHEN trim(COALESCE(source_url, '')) = '' AND trim(COALESCE(r2_key, '')) <> '' THEN '/files/' || r2_key
         ELSE source_url
       END,
       url = '',
       r2_key = '',
       is_primary = 0,
       quarantined = 1,
       quarantine_reason = CASE
         WHEN trim(COALESCE(quarantine_reason, '')) = '' THEN 'invalid_media_reference'
         ELSE quarantine_reason
       END
 WHERE NOT (
   url GLOB '/files/[A-Za-z0-9]*'
   AND substr(url, -5) = '.webp'
   AND length(substr(url, 8)) BETWEEN 5 AND 500
   AND substr(url, 8) NOT GLOB '*[^A-Za-z0-9._/-]*'
   AND instr(substr(url, 8), '//') = 0
   AND substr(url, 8, 1) <> '/'
   AND substr(url, -1) <> '/'
   AND substr(url, 8, 2) <> './'
   AND substr(url, 8, 3) <> '../'
   AND instr(substr(url, 8), '/./') = 0
   AND instr(substr(url, 8), '/../') = 0
   AND substr(substr(url, 8), -2) <> '/.'
   AND substr(substr(url, 8), -3) <> '/..'
   AND r2_key = substr(url, 8)
   AND (
     trim(COALESCE(content_type, '')) = ''
     OR lower(trim(content_type)) = 'image/webp'
   )
 );

-- A mirror-only product had no relational primary to preserve. Once unsafe
-- rows have been quarantined, promote the first canonical row only when the
-- product still has no active primary. This restores the old string-array
-- lead-image behaviour without ever promoting provenance.
UPDATE product_images
   SET is_primary = 1
 WHERE quarantined = 0
   AND trim(url) <> ''
   AND id = (
     SELECT lead.id
       FROM product_images lead
      WHERE lead.product_id = product_images.product_id
        AND lead.quarantined = 0
        AND trim(lead.url) <> ''
      ORDER BY lead.sort_order, lead.id
      LIMIT 1
   )
   AND NOT EXISTS (
     SELECT 1 FROM product_images primary_image
      WHERE primary_image.product_id = product_images.product_id
        AND primary_image.quarantined = 0
        AND primary_image.is_primary = 1
        AND trim(primary_image.url) <> ''
   );

-- The JSON column is now a compatibility projection, never an independent
-- source. Rebuild every product (including mirror-only rows whose entire
-- gallery was quarantined) from canonical active relations so a stale vendor
-- URL cannot survive 0099 and be resurrected by an older reader.
UPDATE products
   SET images = COALESCE((
     SELECT json_group_array(ordered.url)
       FROM (
         SELECT image.url
           FROM product_images image
          WHERE image.product_id = products.id
            AND image.quarantined = 0
            AND image.url = '/files/' || image.r2_key
            AND substr(image.url, -5) = '.webp'
          ORDER BY image.is_primary DESC, image.sort_order, image.id
       ) AS ordered
   ), '[]');

-- ---------------------------------------------------------------------------
-- Product-media rollback grace
-- ---------------------------------------------------------------------------
-- A failed apply can have created a content-addressed object that another
-- concurrent apply has already discovered but has not committed yet. Deleting
-- it inline after a SELECT creates a D1 -> R2 TOCTOU window. Rollback therefore
-- queues the object and gives the successful apply at least one cleanup tick
-- to publish its reference; the guarded drain re-checks all references before
-- touching R2. Empty means immediately eligible for the older product-delete
-- and image-detach jobs already in the table.
ALTER TABLE media_cleanup_jobs ADD COLUMN not_before TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_media_cleanup_due
  ON media_cleanup_jobs(state, not_before, created_at);

-- The queue row cannot serialize an attachment that starts while no cleanup
-- job exists. This per-object guard is the linearization point shared by every
-- product-media attach and destructive cleanup path. An attach extends
-- `protected_until` only while no cleanup owns `claim_token`; cleanup claims
-- only an unprotected key. A crashed claim is reclaimed by cleanup after
-- `claim_until`, never bypassed by an attaching request.
CREATE TABLE IF NOT EXISTS media_object_guards (
  object_key TEXT PRIMARY KEY,
  protected_until TEXT NOT NULL DEFAULT '',
  claim_token TEXT NOT NULL DEFAULT '',
  claim_until TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_media_object_guards_claim
  ON media_object_guards(claim_token, claim_until, protected_until);

-- ---------------------------------------------------------------------------
-- Resumable CSV-import apply lease and per-product checkpoints
-- ---------------------------------------------------------------------------
-- `/api/admin/import/confirm` applies as many as 500 independent product
-- batches. `state = 'applied'` is the terminal replay marker, but it cannot
-- serialize two confirms while work is in flight, and a Worker may disappear
-- after a product commits but before the final report is written. These fields
-- make the in-flight owner explicit and recoverable: a live token excludes a
-- second executor; an expired token may be replaced by a retry.
ALTER TABLE product_imports ADD COLUMN media_stage_until TEXT NOT NULL DEFAULT '';
ALTER TABLE product_imports ADD COLUMN apply_token TEXT NOT NULL DEFAULT '';
ALTER TABLE product_imports ADD COLUMN apply_lease_until TEXT NOT NULL DEFAULT '';
ALTER TABLE product_imports ADD COLUMN apply_generation INTEGER NOT NULL DEFAULT 0;

-- Previews created before this migration receive the same finite window they
-- would have received at creation time. Old abandoned previews are deliberately
-- left expired; otherwise their JSON payload would keep staged R2 objects alive
-- forever merely because the row itself has no pruning job.
UPDATE product_imports
   SET media_stage_until = COALESCE(
     strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+24 hours'),
     ''
   )
 WHERE state = 'preview';

CREATE INDEX IF NOT EXISTS idx_product_imports_media_stage
  ON product_imports(state, media_stage_until, apply_lease_until);

-- One terminal outcome per payload item. A successful row is inserted in the
-- SAME D1 batch as the product, relations, catalogs, membership and search
-- mutations. Therefore a retry either sees both product + checkpoint, or
-- neither, and never repeats a committed CREATE.
CREATE TABLE IF NOT EXISTS product_import_items (
  import_id TEXT NOT NULL REFERENCES product_imports(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  item_key TEXT NOT NULL DEFAULT '',
  line INTEGER NOT NULL DEFAULT 0,
  product_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('created','updated','failed')),
  name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  apply_token TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (import_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_product_import_items_product
  ON product_import_items(product_id, completed_at);

-- This is the fencing boundary, not merely a preflight check. Every product
-- batch inserts its checkpoint; a stale/expired owner makes that INSERT abort,
-- which rolls the entire D1 batch back. An executor that wakes after another
-- retry acquired a newer token can therefore never publish an old plan.
CREATE TRIGGER IF NOT EXISTS trg_product_import_item_lease_fence
BEFORE INSERT ON product_import_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM product_imports i
     WHERE i.id = NEW.import_id
       AND i.state = 'preview'
       AND i.apply_token = NEW.apply_token
       AND i.apply_token <> ''
       AND i.apply_lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')
  ) THEN RAISE(ABORT, 'IMPORT_APPLY_LEASE_LOST') END;
END;
