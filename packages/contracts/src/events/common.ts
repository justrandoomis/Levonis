/** Field checks shared by several v1 payloads. */
import { obj, str, nonEmptyStr, nonNegInt, posInt, bool, nullable, oneOf, arr, hex64, isoDate, num } from '../schema';

export const id = nonEmptyStr;
export const idOrNull = nullable(nonEmptyStr);
export const locale = oneOf('ar', 'en', 'ckb');
export const sellerType = oneOf('platform', 'merchant');
export const paymentMethod = oneOf('wallet', 'cash');
export const ledgerCurrency = oneOf('USD', 'POINT', 'IQD');
export const userHash = hex64;
export const amount = nonNegInt;
export const at = isoDate;
export { obj, str, nonEmptyStr, nonNegInt, posInt, bool, nullable, oneOf, arr, hex64, isoDate, num };

/**
 * `OrderCreated.items` / `OrderDelivered.items` — references, never snapshots
 * (`03-EVENTS.md` 3.7).
 *
 * `product_id` IS NULLABLE, and that is a correctness fix rather than a
 * loosening (docs/BUNDLES_MYSTERY.md §7.7). A mystery spool's `order_items` row
 * stores `product_id = NULL` on purpose — it is what keeps the drawn filament
 * out of the join, the units endpoint, the invoice and the courier payload with
 * no filtering code at all. With `product_id` required here, a producer binding
 * null would fail `buildEnvelope`, `outboxStatement` would catch and return
 * null, and `OrderCreated` would SILENTLY DISAPPEAR for every mystery order —
 * the one analytics surface the mandate names. A consumer that reads
 * `product_id` must therefore handle null, which is exactly the fact the ref is
 * carrying: this line references no single catalogue product.
 *
 * `item_kind` says WHY, and is optional so every producer written before this
 * still validates; absent means `ordinary`.
 */
export const orderItemRef = obj(
  {
    order_item_id: id,
    product_id: idOrNull,
    qty: posInt,
    unit_price_iqd: nonNegInt,
    is_printer: bool,
    warranty_plan_id: idOrNull,
    ops_policy_id: idOrNull,
  },
  {
    item_kind: oneOf('ordinary', 'bundle_parent', 'bundle_component', 'mystery'),
  }
);
export const orderItemRefs = arr(orderItemRef, { max: 200 });
