-- The admin products manager derives "sold" per product from order_items
-- (a correlated SUM over the product's non-cancelled order lines) and can
-- sort by it. order_items only ever had an index on order_id, so each of
-- those lookups was a full scan of the table — measured at ~9s for the sales
-- sort on a modest catalogue with real order history, ~1s even for the
-- default sort. This covering index resolves the whole subquery from the
-- index: the same queries drop to tens of milliseconds.
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id, order_id, qty);
