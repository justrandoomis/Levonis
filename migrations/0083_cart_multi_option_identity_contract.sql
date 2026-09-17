-- 0083 CONTRACT PHASE — DEPLOY SEPARATELY, after Release A is live on every
-- Worker. Release A uses untargeted UPSERTs and is compatible with old-only,
-- dual-index and new-only schemas. Never ship this file with 0082.

DROP INDEX IF EXISTS idx_cart_levonis_line;
DROP INDEX IF EXISTS idx_cart_levonis_line_v2;

-- option_id remains in the key for composition rows. For an ordinary line it
-- is a legacy projection only, so make it the stable lexical first value from
-- canonical option_value_ids; authored group order remains pricing-only.
UPDATE cart_items
   SET option_id = COALESCE(
         (
           SELECT CAST(selected.value AS TEXT)
             FROM json_each(
                    CASE
                      WHEN json_valid(cart_items.option_value_ids)
                        THEN cart_items.option_value_ids
                      ELSE '[]'
                    END
                  ) AS selected
            WHERE selected.type = 'text'
              AND CAST(selected.value AS TEXT) <> ''
            ORDER BY CAST(selected.value AS TEXT) COLLATE BINARY
            LIMIT 1
         ),
         option_id
       )
 WHERE product_id IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM products p
          WHERE p.id = cart_items.product_id
            AND COALESCE(p.composition, '') = ''
       );

-- A group reorder may have left the same canonical selection under two old
-- option_id projections. The five-column index is gone now, so normalize first
-- and fold exact v2 duplicates before creating the final constraint.
UPDATE cart_items
   SET qty = MIN(99, (
         SELECT SUM(d.qty)
           FROM cart_items d
          WHERE d.user_id = cart_items.user_id
            AND d.product_id = cart_items.product_id
            AND d.option_id = cart_items.option_id
            AND d.option_value_ids = cart_items.option_value_ids
            AND d.color_id = cart_items.color_id
            AND d.shipping_method_id = cart_items.shipping_method_id
       )),
       warranty_plan_id = (
         SELECT CASE
                  WHEN MIN(COALESCE(d.warranty_plan_id, '')) = MAX(COALESCE(d.warranty_plan_id, ''))
                    THEN MIN(COALESCE(d.warranty_plan_id, ''))
                  ELSE ''
                END
           FROM cart_items d
          WHERE d.user_id = cart_items.user_id
            AND d.product_id = cart_items.product_id
            AND d.option_id = cart_items.option_id
            AND d.option_value_ids = cart_items.option_value_ids
            AND d.color_id = cart_items.color_id
            AND d.shipping_method_id = cart_items.shipping_method_id
       )
 WHERE product_id IS NOT NULL
   AND id = (
         SELECT MIN(k.id)
           FROM cart_items k
          WHERE k.user_id = cart_items.user_id
            AND k.product_id = cart_items.product_id
            AND k.option_id = cart_items.option_id
            AND k.option_value_ids = cart_items.option_value_ids
            AND k.color_id = cart_items.color_id
            AND k.shipping_method_id = cart_items.shipping_method_id
       );

DELETE FROM cart_items
 WHERE product_id IS NOT NULL
   AND id <> (
         SELECT MIN(k.id)
           FROM cart_items k
          WHERE k.user_id = cart_items.user_id
            AND k.product_id = cart_items.product_id
            AND k.option_id = cart_items.option_id
            AND k.option_value_ids = cart_items.option_value_ids
            AND k.color_id = cart_items.color_id
            AND k.shipping_method_id = cart_items.shipping_method_id
       );

CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_levonis_line
  ON cart_items(
    user_id,
    product_id,
    option_id,
    option_value_ids,
    color_id,
    shipping_method_id
  )
  WHERE product_id IS NOT NULL;
