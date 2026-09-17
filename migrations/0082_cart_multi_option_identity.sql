-- 0082 EXPAND PHASE — prepare complete cart-selection identity without
-- invalidating the Worker version that is serving while migrations run.
--
-- ROLLOUT CONTRACT:
--   * `idx_cart_levonis_line` (0032, five columns) stays in place. The previous
--     Worker names that exact conflict target.
--   * The six-column v2 index is added under a new name. Release A uses an
--     untargeted UPSERT and therefore works before and after this migration.
--   * 0083 is the separate contract release. Never deploy 0082 and 0083 in
--     the same Git auto-deploy.

-- Canonicalize ordinary-product selection JSON before TEXT equality becomes
-- identity. Reversed arrays, duplicate ids and an omitted legacy option become
-- the same sorted JSON. Composition rows are excluded: their option_id is a
-- server-owned `bx_…` key and mystery rows may use option_value_ids as family
-- identity rather than as ordinary product option values.
UPDATE cart_items
   SET option_value_ids = COALESCE(
         (
           SELECT json_group_array(value)
             FROM (
               SELECT DISTINCT CAST(selected.value AS TEXT) AS value
                 FROM json_each(
                        CASE
                          WHEN json_valid(cart_items.option_value_ids)
                            THEN cart_items.option_value_ids
                          ELSE '[]'
                        END
                      ) AS selected
                WHERE selected.type = 'text'
                  AND CAST(selected.value AS TEXT) <> ''
               UNION
               SELECT v.id AS value
                 FROM product_option_values v
                WHERE v.product_id = cart_items.product_id
                  AND v.id = cart_items.option_id
               ORDER BY value COLLATE BINARY
             )
         ),
         '[]'
       )
 WHERE product_id IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM products p
          WHERE p.id = cart_items.product_id
            AND COALESCE(p.composition, '') = ''
       );

-- Canonicalization can reveal rows that were always the same complete
-- selection but used reversed JSON and different legacy option_id values.
-- Fold by the COMPLETE selection, retaining the oldest row and summing qty
-- exactly as migration 0032 did. This must happen before v2 is created.
UPDATE cart_items
   SET qty = MIN(99, (
         SELECT SUM(d.qty)
           FROM cart_items d
          WHERE d.user_id = cart_items.user_id
            AND d.product_id = cart_items.product_id
            AND d.option_value_ids = cart_items.option_value_ids
            AND d.color_id = cart_items.color_id
            AND d.shipping_method_id = cart_items.shipping_method_id
       )),
       -- A warranty applies to every unit on one cart line. Preserve it only
       -- when every duplicate row agrees exactly; mixed/competing choices are
       -- cleared so migration never charges an unagreed warranty.
       warranty_plan_id = (
         SELECT CASE
                  WHEN MIN(COALESCE(d.warranty_plan_id, '')) = MAX(COALESCE(d.warranty_plan_id, ''))
                    THEN MIN(COALESCE(d.warranty_plan_id, ''))
                  ELSE ''
                END
           FROM cart_items d
          WHERE d.user_id = cart_items.user_id
            AND d.product_id = cart_items.product_id
            AND d.option_value_ids = cart_items.option_value_ids
            AND d.color_id = cart_items.color_id
            AND d.shipping_method_id = cart_items.shipping_method_id
       )
 WHERE product_id IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM products p
          WHERE p.id = cart_items.product_id
            AND COALESCE(p.composition, '') = ''
       )
   AND id = (
         SELECT MIN(k.id)
           FROM cart_items k
          WHERE k.user_id = cart_items.user_id
            AND k.product_id = cart_items.product_id
            AND k.option_value_ids = cart_items.option_value_ids
            AND k.color_id = cart_items.color_id
            AND k.shipping_method_id = cart_items.shipping_method_id
       );

DELETE FROM cart_items
 WHERE product_id IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM products p
          WHERE p.id = cart_items.product_id
            AND COALESCE(p.composition, '') = ''
       )
   AND id <> (
         SELECT MIN(k.id)
           FROM cart_items k
          WHERE k.user_id = cart_items.user_id
            AND k.product_id = cart_items.product_id
            AND k.option_value_ids = cart_items.option_value_ids
            AND k.color_id = cart_items.color_id
            AND k.shipping_method_id = cart_items.shipping_method_id
       );

-- EXPAND ONLY: v1 remains for the old Worker; v2 is ready for Release A.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_levonis_line_v2
  ON cart_items(
    user_id,
    product_id,
    option_id,
    option_value_ids,
    color_id,
    shipping_method_id
  )
  WHERE product_id IS NOT NULL;
