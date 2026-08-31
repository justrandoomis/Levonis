-- 0032 — restore "the same line twice is one line with a bigger quantity".
--
-- 0030 rebuilt cart_items to carry a seller, and replaced 0001's
--
--   UNIQUE (user_id, product_id, option_id, color_id, shipping_method_id)
--
-- with the same key plus community_product_id. That looked like a widening.
-- It was not, for a reason SQLite makes easy to miss:
--
--   NULLS ARE DISTINCT IN A SQLITE UNIQUE INDEX.
--
-- A Levonis line has community_product_id = NULL, so every Levonis row became
-- unique no matter what, and a merchant line has product_id = NULL, so every
-- merchant row did too. The constraint stopped constraining anything, and
-- `ON CONFLICT(user_id, product_id, option_id, color_id, shipping_method_id)`
-- in worker/routes/cart.ts stopped matching any index at all — which SQLite
-- answers with an error, so adding ANYTHING to a cart failed.
--
-- The fix is two PARTIAL unique indexes, one per kind of line. Each covers
-- exactly the columns that identify that kind, over exactly the rows that
-- have them, so neither is defeated by the other kind's NULLs:
--
--   a Levonis line  = (user, product, option, colour, shipping)
--   a merchant line = (user, community product, option, colour)
--
-- A merchant line has no shipping_method_id — merchant delivery is settled at
-- checkout with the one store, not chosen per line — so including it would
-- make two identical lines look different whenever the column changed.
--
-- 0030's table-level UNIQUE stays where it is. It cannot be dropped without
-- rebuilding a live table again, and it is inert: at least one of its columns
-- is always NULL, so it never fires. The two indexes below are the real rule.

-- Existing duplicates, if any add succeeded between 0030 and this migration,
-- must be folded together first or the unique index cannot be created.
-- Quantities are SUMMED (capped at the column's CHECK of 99) rather than one
-- row being dropped: the customer put those items in their cart, and losing
-- them silently is worse than an unexpected quantity they can see and edit.
UPDATE cart_items
   SET qty = MIN(99, (
         SELECT SUM(d.qty) FROM cart_items d
          WHERE d.user_id = cart_items.user_id
            AND d.product_id IS NOT NULL
            AND d.product_id = cart_items.product_id
            AND d.option_id = cart_items.option_id
            AND d.color_id = cart_items.color_id
            AND d.shipping_method_id = cart_items.shipping_method_id
       ))
 WHERE product_id IS NOT NULL
   AND id = (
         SELECT MIN(k.id) FROM cart_items k
          WHERE k.user_id = cart_items.user_id
            AND k.product_id = cart_items.product_id
            AND k.option_id = cart_items.option_id
            AND k.color_id = cart_items.color_id
            AND k.shipping_method_id = cart_items.shipping_method_id
       );

DELETE FROM cart_items
 WHERE product_id IS NOT NULL
   AND id <> (
         SELECT MIN(k.id) FROM cart_items k
          WHERE k.user_id = cart_items.user_id
            AND k.product_id = cart_items.product_id
            AND k.option_id = cart_items.option_id
            AND k.color_id = cart_items.color_id
            AND k.shipping_method_id = cart_items.shipping_method_id
       );

UPDATE cart_items
   SET qty = MIN(99, (
         SELECT SUM(d.qty) FROM cart_items d
          WHERE d.user_id = cart_items.user_id
            AND d.community_product_id IS NOT NULL
            AND d.community_product_id = cart_items.community_product_id
            AND d.option_id = cart_items.option_id
            AND d.color_id = cart_items.color_id
       ))
 WHERE community_product_id IS NOT NULL
   AND id = (
         SELECT MIN(k.id) FROM cart_items k
          WHERE k.user_id = cart_items.user_id
            AND k.community_product_id = cart_items.community_product_id
            AND k.option_id = cart_items.option_id
            AND k.color_id = cart_items.color_id
       );

DELETE FROM cart_items
 WHERE community_product_id IS NOT NULL
   AND id <> (
         SELECT MIN(k.id) FROM cart_items k
          WHERE k.user_id = cart_items.user_id
            AND k.community_product_id = cart_items.community_product_id
            AND k.option_id = cart_items.option_id
            AND k.color_id = cart_items.color_id
       );

CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_levonis_line
  ON cart_items(user_id, product_id, option_id, color_id, shipping_method_id)
  WHERE product_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_merchant_line
  ON cart_items(user_id, community_product_id, option_id, color_id)
  WHERE community_product_id IS NOT NULL;
