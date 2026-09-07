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

/** `OrderCreated.items` / `OrderDelivered.items` — references, never snapshots (`03-EVENTS.md` 3.7). */
export const orderItemRef = obj({
  order_item_id: id,
  product_id: id,
  qty: posInt,
  unit_price_iqd: nonNegInt,
  is_printer: bool,
  warranty_plan_id: idOrNull,
  ops_policy_id: idOrNull,
});
export const orderItemRefs = arr(orderItemRef, { max: 200 });
