/** Trusted SQL aliases only. Releases belong to a line/lot, not to every
 * original allocation of that lot. Consume their quantity once in allocation
 * ID order, matching getOrderProfitBases' return budget. */
export function remainingAllocationQtySql(alias = 'a'): string {
  return `MAX(0,${alias}.qty-MAX(0,
    (SELECT COALESCE(SUM(released.qty),0) FROM order_item_inventory_allocations released
      WHERE released.order_item_id=${alias}.order_item_id AND released.lot_id=${alias}.lot_id AND released.released_at IS NOT NULL)
    -(SELECT COALESCE(SUM(earlier.qty),0) FROM order_item_inventory_allocations earlier
      WHERE earlier.order_item_id=${alias}.order_item_id AND earlier.lot_id=${alias}.lot_id
        AND earlier.released_at IS NULL AND earlier.id<${alias}.id)))`;
}
