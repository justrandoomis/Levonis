-- Levonis migration 0023 — a selection can now name a value in EVERY option
-- group, not just one option (product-form mandate §7: unlimited option
-- groups, and a colour that may be linked across several of them).
--
-- The pre-0018 model had exactly one `option_id` per cart line, which cannot
-- express "A1 + Combo + EU". These columns carry the full selection as a JSON
-- array of product_option_values ids, canonically sorted by the server.
--
-- NON-DESTRUCTIVE AND BACKWARD COMPATIBLE:
--   * option_id / color_id are KEPT and kept in sync (option_id continues to
--     hold the first selected value), so every existing reader — the cart UI,
--     order history, invoices, the returns flow — keeps working untouched.
--   * Existing rows are backfilled from option_id, so a cart or an order
--     placed before this migration describes exactly the same selection
--     afterwards.
--   * The UNIQUE(user_id, product_id, option_id, color_id, shipping_method_id)
--     constraint on cart_items is deliberately left alone. Two lines that
--     differ only in a SECOND group would collide under it, so the cart route
--     merges on the full selection before writing — a table rebuild to widen
--     the constraint would mean dropping and re-creating a table that live
--     carts point at, for a case the write path already handles.

ALTER TABLE cart_items ADD COLUMN option_value_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE order_items ADD COLUMN option_value_ids TEXT NOT NULL DEFAULT '[]';

-- Backfill: a single legacy option becomes a one-element selection.
UPDATE cart_items
   SET option_value_ids = json_array(option_id)
 WHERE option_value_ids = '[]' AND option_id <> '';

UPDATE order_items
   SET option_value_ids = json_array(option_id)
 WHERE option_value_ids = '[]' AND option_id <> '';
