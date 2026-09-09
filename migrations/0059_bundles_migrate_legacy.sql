-- 0059 — THE LEGACY BUNDLES BACKFILL (docs/BUNDLES_MYSTERY.md §1.11)
--
-- `bundles` / `bundle_items` (0034) are SUPERSEDED, MIGRATED, FROZEN — never
-- dropped. Every legacy row arrives in the new model as a REAL `products` row
-- carrying composition='bundle', and the legacy tables become read-only
-- history: nothing writes them after this file.
--
-- Three decisions are load-bearing, and each is the opposite of a silent
-- repair:
--
--  1. EVERY MIGRATED BUNDLE IS A DRAFT WITH NO PRICE. 0034 deliberately gave a
--     bundle no price of its own — its storefront figure was the live sum of
--     its members — so there is no honest price to migrate. Publishing an
--     unpriced sellable product automatically is exactly the failure the
--     mandate forbids, so status='draft', price_iqd=0, and the admin panel
--     shows the MIGRATED_NEEDS_PRICE warning on every one of them. Publishing
--     one while price_mode='fixed' and price_iqd=0 is REFUSED at save.
--
--  2. `stock` IS NULL. A bundle is never stocked: availability is computed
--     from its members' real inventory at every read. That is the single most
--     important invariant in the design (§1.2).
--
--  3. TODAY'S MEMBERS-ONLY GATE IS PRESERVED EXACTLY, AS A SET — in
--     `0063_bundles_legacy_gate.sql`, not here. §1.11 writes that
--     `offer_windows` insert into this file, but `offer_windows` is created by
--     0060 and migrations apply in file order, so an insert into it from 0059
--     fails with "no such table" on a fresh database. The gate therefore rides
--     the first free number after the offer tables exist. It is the same rows,
--     with the same deterministic ids and the same `INSERT OR IGNORE`.
--
-- IDEMPOTENCE. Every id derived here is DETERMINISTIC and keyed off an
-- existing legacy row — 'prd_bnd_' || bundles.id, 'ofw_bnd_' || bundles.id,
-- 'bc_bnd_' || bundle_id || '_' || product_id (the legacy primary key) — so a
-- second pass collides on the primary key and INSERT OR IGNORE makes it a
-- no-op. A random id would have inserted a second copy of every component on
-- every re-run, which is precisely what `scripts/migrate-check.mjs --twice`
-- exists to catch.
--
-- FOREIGN KEYS. ON CONFLICT does NOT apply to a foreign-key violation in
-- SQLite, so every child insert is guarded with an EXISTS on the product row
-- it references rather than trusting the parent insert to have landed.

-- ------------------------------------------------------------- the products
INSERT OR IGNORE INTO products
  (id, slug, status, name, name_ar, name_ku, description, images,
   selling_type, sale_types, composition, price_iqd, stock, display_order,
   inventory_mode, created_at, updated_at)
SELECT 'prd_bnd_' || b.id,
       -- Deterministic, and namespaced by the legacy id so it can never
       -- collide with a real product slug (a collision would make OR IGNORE
       -- drop the product row and leave its children with nothing to point at).
       'bundle-' || replace(lower(b.id), '_', '-'),
       'draft',                                        -- never auto-published
       b.name, '', '', b.description,
       iif(b.image = '', '[]', json_array(b.image)),   -- iif, not CASE/END: one statement, one split
       'bundle', '["bundle"]', 'bundle',
       0,                                              -- no honest price exists to migrate
       NULL,                                           -- never stocked
       b.sort, 'BASE',
       strftime('%Y-%m-%dT%H:%M:%fZ', b.created_at / 1000, 'unixepoch'),
       strftime('%Y-%m-%dT%H:%M:%fZ', b.updated_at / 1000, 'unixepoch')
  FROM bundles b;

-- --------------------------------------------------------- the per-offer knobs
INSERT OR IGNORE INTO bundle_config (product_id, price_mode, max_qty_per_order)
SELECT 'prd_bnd_' || b.id, 'fixed', 5
  FROM bundles b
 WHERE EXISTS (SELECT 1 FROM products p WHERE p.id = 'prd_bnd_' || b.id);

-- ----------------------------------------------------------- the composition
-- The surrogate component id is what lets the same product appear twice in one
-- bundle from now on; the legacy pair's PRIMARY KEY (bundle_id, product_id)
-- forbade it, which is why it is superseded rather than extended. Deriving the
-- id from that same legacy key keeps this insert idempotent.
INSERT OR IGNORE INTO bundle_components
  (id, bundle_product_id, member_product_id, qty, sort)
SELECT 'bc_bnd_' || i.bundle_id || '_' || i.product_id,
       'prd_bnd_' || i.bundle_id,
       i.product_id, i.qty, i.sort
  FROM bundle_items i
 WHERE EXISTS (SELECT 1 FROM products p WHERE p.id = 'prd_bnd_' || i.bundle_id)
   AND EXISTS (SELECT 1 FROM products m WHERE m.id = i.product_id);
