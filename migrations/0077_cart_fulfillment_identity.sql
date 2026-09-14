-- The same model reached by two journeys is not the same cart selection.
UPDATE cart_items SET fulfillment_type=CASE WHEN transport_method<>'' THEN 'pre_order' ELSE 'direct_sale' END
WHERE product_id IN (SELECT id FROM products WHERE composition='') AND fulfillment_type IS NULL;
DROP INDEX IF EXISTS idx_cart_levonis_line;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_levonis_line
ON cart_items(user_id,product_id,option_id,color_id,shipping_method_id,COALESCE(fulfillment_type,''),transport_method)
WHERE product_id IS NOT NULL;
