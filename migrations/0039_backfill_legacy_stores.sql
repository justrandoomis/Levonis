-- Every merchant gets a real store address (§57's promise, completed).
--
-- Community merchants from the pre-store era have a profile but no
-- merchant_stores row, so a tap on their card had nowhere to hand over to —
-- the owner's directory still opened them inside the main site. This gives
-- each of them an actual store row, and therefore an actual subdomain:
--
--  * the slug is derived from the merchant id ('m-' + its hex tail), which
--    is unique by construction, safe for a hostname, and renameable later
--    from the dashboard's slug tool;
--  * the store starts PAUSED: a shop nobody asked to open must not silently
--    start taking checkout orders its owner never watches. The profile and
--    products still serve; ordering waits for the merchant to open it.
--  * their legacy products are attached to the new store, keeping them
--    exactly as sellable as they were: these rows predate stock tracking,
--    so tracking is switched off rather than letting a default stock of 0
--    mark everything unavailable.
--
-- Every statement converges: re-running adds nothing and changes nothing.

INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name, description, logo_key, status, status_reason, created_at)
SELECT
  'ms_' || lower(substr(m.id, 4)),
  m.id,
  m.user_id,
  'm-' || lower(substr(m.id, 4)),
  m.name,
  m.bio,
  m.avatar_key,
  'paused',
  'auto-provisioned from the community profile; the merchant opens it from the dashboard',
  m.created_at
FROM community_merchants m
WHERE NOT EXISTS (SELECT 1 FROM merchant_stores s WHERE s.merchant_id = m.id);

INSERT OR IGNORE INTO merchant_store_slugs (slug, store_id, active)
SELECT s.slug, s.id, 1
FROM merchant_stores s
WHERE NOT EXISTS (SELECT 1 FROM merchant_store_slugs h WHERE h.slug = s.slug);

-- Attach the pre-store products to their merchant's new (or existing) store.
UPDATE community_products
SET store_id = (SELECT s.id FROM merchant_stores s WHERE s.merchant_id = community_products.merchant_id),
    track_stock = 0
WHERE store_id IS NULL
  AND EXISTS (SELECT 1 FROM merchant_stores s WHERE s.merchant_id = community_products.merchant_id);
