-- ============================================================================
--  0152 — A PRODUCT MADE FOR ONE CUSTOMER (docs/COMMUNITY_COMMERCE_CHAT.md §2 D6)
-- ============================================================================
-- «منتج خاص»: the store prices something for the customer of ONE of its
-- conversations — a finished quote turned into a thing to buy, a variation of
-- a listed product, a bundle — and the customer buys it through the store's
-- own cart and checkout (prepaid from the wallet, the merchant's share pending
-- until receipt). No temporary public product, no chat checkout, no second
-- orders table: a `community_products` row the public never sees.
--
--   audience_user_id   the ONE account that may see and buy it
--   origin_chat_id     the conversation it was made in (its card, its order's
--                      system cards)
--   origin_offer_id    the quote it replaced, when it replaced one — that quote
--                      is closed in the same batch (one deal, one flow)
--   custom_expires_at  after this it is no longer buyable
--
-- ---------------------------------------------------------------------------
--  INVISIBLE TO THE PUBLIC WITHOUT TOUCHING ONE PUBLIC READER
-- ---------------------------------------------------------------------------
-- Every public reader — the storefront, the feed, search, the sitemap, the
-- public API, favourites, social cards — asks `status = 'active'`, and 0126's
-- mirror triggers compute `status` from the product's own state. They are
-- recreated here with ONE more condition: a product with an audience is
-- `status = 'hidden'` whatever its publish state. A published private product
-- is `lifecycle = 'active'` (it can be bought) and `status = 'hidden'` (nobody
-- can find it). The buy path lets exactly its audience through
-- (worker/lib/privateProducts.ts).
--
-- ---------------------------------------------------------------------------
--  WHAT THE CUSTOMER WAS SHOWN IS WHAT THEY PAY FOR
-- ---------------------------------------------------------------------------
-- A private product is immutable once created (D6): its price, its name, its
-- description, its pictures, its audience, its store and its expiry cannot be
-- changed by anything — a change is a cancellation and a new card, so a card
-- can never say one price while the checkout charges another. Stock (the
-- checkout's decrement, a cancellation's restock), the publish state (a
-- cancellation archives it), moderation and the mirrored `lifecycle`/`status`
-- still move. It takes no variants and no gallery rows.
--
-- `cart_items.origin_chat_id` / `orders.origin_chat_id` carry a purchase from
-- the conversation it started in to the order it became, so «تم إنشاء الطلب»
-- is posted where the customer bought.
--
-- NONDESTRUCTIVE: six ADD COLUMNs (all NULL), two partial indexes, two
-- triggers dropped and recreated with the same names and one more condition,
-- one trigger that keeps a private product hidden, and three that only refuse
-- writes no route makes. Every existing row has no audience, so its computed
-- status is exactly what it was.
-- ============================================================================

ALTER TABLE community_products ADD COLUMN audience_user_id TEXT REFERENCES users(id);
ALTER TABLE community_products ADD COLUMN origin_chat_id TEXT REFERENCES chats(id);
ALTER TABLE community_products ADD COLUMN origin_offer_id TEXT REFERENCES community_offers(id);
ALTER TABLE community_products ADD COLUMN custom_expires_at TEXT;
ALTER TABLE cart_items ADD COLUMN origin_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN origin_chat_id TEXT;

CREATE INDEX IF NOT EXISTS idx_community_products_audience
  ON community_products(audience_user_id, store_id) WHERE audience_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_origin_chat
  ON orders(origin_chat_id) WHERE origin_chat_id IS NOT NULL;

-- ---------------------------------------------------------------------------
--  THE MIRRORS, WITH THE AUDIENCE IN THE STATUS RULE (0126 section 7)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_product_state_insert;
DROP TRIGGER IF EXISTS trg_product_state_mirror;

CREATE TRIGGER IF NOT EXISTS trg_product_state_insert
AFTER INSERT ON community_products
FOR EACH ROW
BEGIN
  UPDATE community_products
     SET publish_state = CASE NEW.lifecycle WHEN 'active' THEN 'published' WHEN 'draft' THEN 'draft'
                                            WHEN 'archived' THEN 'archived' ELSE 'hidden' END
   WHERE id = NEW.id AND publish_state IS NULL;
  UPDATE community_products
     SET lifecycle = CASE publish_state WHEN 'published' THEN 'active' ELSE publish_state END,
         status = CASE WHEN publish_state = 'published' AND admin_hidden_at IS NULL AND audience_user_id IS NULL
                       THEN 'active' ELSE 'hidden' END
   WHERE id = NEW.id
     AND (lifecycle IS NOT (CASE publish_state WHEN 'published' THEN 'active' ELSE publish_state END)
          OR status IS NOT (CASE WHEN publish_state = 'published' AND admin_hidden_at IS NULL AND audience_user_id IS NULL
                                 THEN 'active' ELSE 'hidden' END));
END;

CREATE TRIGGER IF NOT EXISTS trg_product_state_mirror
AFTER UPDATE OF publish_state, admin_hidden_at, audience_user_id ON community_products
FOR EACH ROW
WHEN NEW.publish_state IS NOT NULL
BEGIN
  UPDATE community_products
     SET lifecycle = CASE publish_state WHEN 'published' THEN 'active' ELSE publish_state END,
         status = CASE WHEN publish_state = 'published' AND admin_hidden_at IS NULL AND audience_user_id IS NULL
                       THEN 'active' ELSE 'hidden' END
   WHERE id = NEW.id
     AND (lifecycle IS NOT (CASE publish_state WHEN 'published' THEN 'active' ELSE publish_state END)
          OR status IS NOT (CASE WHEN publish_state = 'published' AND admin_hidden_at IS NULL AND audience_user_id IS NULL
                                 THEN 'active' ELSE 'hidden' END));
END;

-- A writer that sets `status` directly (the moderation «unhide» computes it
-- from `lifecycle`) can never make a PRIVATE product public: it is put back.
-- Public products keep the behaviour they always had.
CREATE TRIGGER IF NOT EXISTS trg_private_product_stays_hidden
AFTER UPDATE OF status ON community_products
FOR EACH ROW
WHEN NEW.audience_user_id IS NOT NULL AND NEW.status = 'active'
BEGIN
  UPDATE community_products SET status = 'hidden' WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
--  A PRIVATE PRODUCT IS WHAT IT WAS MADE AS
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_private_product_locked
BEFORE UPDATE OF price_iqd, original_price_iqd, name, name_ar, description, description_ar, images, options, colors,
                 variant_mode, track_stock, audience_user_id, store_id, merchant_id, custom_expires_at,
                 origin_chat_id, origin_offer_id ON community_products
FOR EACH ROW
WHEN (OLD.audience_user_id IS NOT NULL OR NEW.audience_user_id IS NOT NULL)
 AND (NEW.price_iqd IS NOT OLD.price_iqd OR NEW.original_price_iqd IS NOT OLD.original_price_iqd
      OR NEW.name IS NOT OLD.name OR NEW.name_ar IS NOT OLD.name_ar
      OR NEW.description IS NOT OLD.description OR NEW.description_ar IS NOT OLD.description_ar
      OR NEW.images IS NOT OLD.images OR NEW.options IS NOT OLD.options OR NEW.colors IS NOT OLD.colors
      OR NEW.variant_mode IS NOT OLD.variant_mode OR NEW.track_stock IS NOT OLD.track_stock
      OR NEW.audience_user_id IS NOT OLD.audience_user_id OR NEW.store_id IS NOT OLD.store_id
      OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.custom_expires_at IS NOT OLD.custom_expires_at
      OR NEW.origin_chat_id IS NOT OLD.origin_chat_id OR NEW.origin_offer_id IS NOT OLD.origin_offer_id)
BEGIN
  SELECT RAISE(ABORT, 'CUSTOM_PRODUCT_LOCKED');
END;

CREATE TRIGGER IF NOT EXISTS trg_private_product_no_variants
BEFORE INSERT ON community_product_variants
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM community_products p WHERE p.id = NEW.product_id AND p.audience_user_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'CUSTOM_PRODUCT_LOCKED');
END;

CREATE TRIGGER IF NOT EXISTS trg_private_product_no_media
BEFORE INSERT ON community_product_media
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM community_products p WHERE p.id = NEW.product_id AND p.audience_user_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'CUSTOM_PRODUCT_LOCKED');
END;
