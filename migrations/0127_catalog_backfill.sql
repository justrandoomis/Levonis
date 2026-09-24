-- ============================================================================
--  0127 — EXISTING PRODUCTS MOVE ONTO THE 0126 MODEL, AND NOTHING A CUSTOMER
--         SEES CHANGES.
-- ============================================================================
-- Merchant platform wave 2, stream W2-F. Data only: four idempotent
-- statements over the rows that exist. A second run matches nothing it did
-- not already do (each is guarded by what it writes).
--
-- ---------------------------------------------------------------------------
--  1. THE STATE, FROM WHAT THE STOREFRONT SHOWS TODAY
-- ---------------------------------------------------------------------------
-- A product is on the storefront when `lifecycle = 'active' AND status =
-- 'active'`. Each row gets the state that keeps its visibility EXACTLY:
--   active, visible               → published
--   active, hidden by Levonis     → published (the admin's hide stays its own
--                                    column and still wins — status stays hidden)
--   active, hidden otherwise      → hidden (an inconsistent pre-0118 row: it was
--                                    not on the storefront, and is not now)
--   draft / archived              → the same
--   sold_out (the old manual flag, which took the product off the storefront)
--   and anything unknown          → hidden
-- Sold out is derived from stock from now on (packages/catalog lifecycle.ts);
-- a merchant who republishes a zero-stock product sees it shown as sold out.
-- The 0126 mirror trigger then rewrites `lifecycle`/`status` from the state —
-- to the values they already had, except 'sold_out', which becomes 'hidden'.
UPDATE community_products
   SET publish_state = CASE
         WHEN lifecycle = 'active' AND (status = 'active' OR admin_hidden_at IS NOT NULL) THEN 'published'
         WHEN lifecycle IN ('draft', 'archived') THEN lifecycle
         ELSE 'hidden'
       END
 WHERE publish_state IS NULL;

-- ---------------------------------------------------------------------------
--  2. THE GALLERY BECOMES MEDIA ROWS
-- ---------------------------------------------------------------------------
-- `images` holds `/files/<key>` paths the merchant route already filtered to
-- the owner's own uploads. Each becomes a picture row in the same order
-- (deterministic id, so a re-run inserts nothing). A store-less legacy
-- product (never sellable, never on a store host) keeps its JSON only; an
-- entry that is not one of ours is left out, as the editor always did.
INSERT OR IGNORE INTO community_product_media (id, product_id, store_id, kind, media_key, position)
SELECT 'pm_' || p.id || '_' || j.key, p.id, p.store_id, 'image', substr(j.value, 8), j.key
  FROM community_products p,
       json_each(CASE WHEN json_valid(p.images) AND json_type(p.images) = 'array' THEN p.images ELSE '[]' END) j
 WHERE p.store_id IS NOT NULL
   AND j.type = 'text'
   AND j.key < 12
   AND j.value LIKE '/files/%'
   AND length(j.value) <= 207
   AND (substr(j.value, 8) GLOB 'merchants/*' OR substr(j.value, 8) GLOB 'community/*')
   AND instr(substr(j.value, 8), '..') = 0;

-- ---------------------------------------------------------------------------
--  3. A SECTION'S PRODUCTS BECOME ITS MEMBERS, IN THE ORDER SHOWN TODAY
-- ---------------------------------------------------------------------------
-- The storefront listed a section newest first; positions 0, 1, 2 … in that
-- order keep the listing identical until the merchant arranges it.
INSERT OR IGNORE INTO merchant_collection_products (collection_id, product_id, store_id, position)
SELECT p.section_id, p.id, p.store_id,
       ROW_NUMBER() OVER (PARTITION BY p.section_id ORDER BY p.created_at DESC, p.id DESC) - 1
  FROM community_products p
  JOIN merchant_store_sections s ON s.id = p.section_id AND s.store_id = p.store_id AND s.kind = 'manual'
 WHERE p.section_id IS NOT NULL;

-- ---------------------------------------------------------------------------
--  4. PRODUCTS WITH THE OLD OPTIONS / COLOURS JSON ARE MARKED LEGACY
-- ---------------------------------------------------------------------------
-- They keep selling exactly as before (the JSON-checked ids, the product's
-- price and stock). The converter (worker/lib/catalog/legacy.ts, run by the
-- scheduled jobs, 50 per tick) turns each one it can map WITHOUT INVENTING
-- anything into option groups, values and variants, and leaves a note on the
-- rest — which the merchant converts in the editor, giving each variant its
-- own stock. An empty list, 'null' or unparseable JSON never offered a choice
-- and stays simple.
UPDATE community_products
   SET variant_mode = 'legacy'
 WHERE variant_mode = 'simple'
   AND (
        (json_valid(options) AND json_type(options) NOT IN ('null') AND NOT (json_type(options) = 'array' AND json_array_length(options) = 0))
     OR (json_valid(colors) AND json_type(colors) NOT IN ('null') AND NOT (json_type(colors) = 'array' AND json_array_length(colors) = 0))
   );
