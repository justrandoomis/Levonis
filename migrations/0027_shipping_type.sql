-- 0027 — the shipping type an order was placed under, recorded on the order.
--
-- WHY IT IS STORED AND NOT DERIVED. The type is currently readable from the
-- items' transport snapshots, but that is a reconstruction, and an order's
-- journey is decided the moment it is placed: a direct order moves through
-- five states, a pre-order through fourteen. The state machine must not have
-- to re-derive which path an order is on from its lines every time it runs,
-- and a line edited or removed later must not be able to change the answer.
--
-- BACKFILLED FROM WHAT THE ORDER ALREADY SAYS. Existing orders keep their real
-- type rather than defaulting to 'direct': the first item's stored transport
-- snapshot is the same value the cart held when the order was placed. An order
-- whose items carry no transport really was direct, so that is not a guess.
ALTER TABLE orders ADD COLUMN shipping_type TEXT NOT NULL DEFAULT 'direct'
  CHECK (shipping_type IN ('direct','preorder_air','preorder_sea','preorder_land'));

UPDATE orders
   SET shipping_type = COALESCE(
     (SELECT CASE json_extract(oi.transport_snapshot, '$.method')
               WHEN 'air'  THEN 'preorder_air'
               WHEN 'sea'  THEN 'preorder_sea'
               WHEN 'land' THEN 'preorder_land'
               ELSE 'direct'
             END
        FROM order_items oi
       WHERE oi.order_id = orders.id
         AND oi.transport_snapshot IS NOT NULL
         AND json_valid(oi.transport_snapshot)
         AND json_extract(oi.transport_snapshot, '$.method') IN ('air','sea','land')
       LIMIT 1),
     'direct'
   );

CREATE INDEX IF NOT EXISTS idx_orders_shipping_type ON orders(shipping_type);
