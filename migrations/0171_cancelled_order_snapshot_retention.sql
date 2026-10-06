-- Checkout department snapshots remain immutable while an order exists.
-- Their old unconditional DELETE trigger also blocked permanent cancellation
-- retention, including orders that never earned or paid anything. Permit only
-- the guarded deletion transaction for cancelled, never-fulfilled orders.
-- Financial records keep their own immutable triggers and foreign keys.
DROP TRIGGER finance_line_department_no_delete;
CREATE TRIGGER finance_line_department_no_delete BEFORE DELETE ON finance_line_departments
WHEN NOT EXISTS (
  SELECT 1 FROM order_items i JOIN orders o ON o.id=i.order_id
  JOIN ops_guards g ON g.id='cancelled-order-delete:'||o.id AND g.ok=1
  WHERE i.id=OLD.order_item_id AND o.status='cancelled' AND o.delivered_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM order_item_units u WHERE u.order_id=o.id)
)
BEGIN SELECT RAISE(ABORT,'Order department snapshot immutable'); END;
