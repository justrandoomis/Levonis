import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, oneOf, sellerType, paymentMethod, nullable, nonNegInt, at, orderItemRefs } from '../common';
import type { Infer } from '../../schema';

const shape = {
  order_id: id,
  user_id: id,
  seller_type: sellerType,
  merchant_id: idOrNull,
  delivered_at: at,
  items: orderItemRefs, // Devices fetches frozen snapshots through ORDERS.itemSnapshots(orderId)
  payment_method: paymentMethod,
  cod_amount_iqd: nullable(nonNegInt),
  by: oneOf('admin', 'merchant', 'courier', 'customer_confirm'),
};
const check = obj(shape);
export type OrderDeliveredV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.13 — Orders (canonical), one delivery per order. */
export const OrderDeliveredV1 = defineEvent<OrderDeliveredV1>({
  type: 'OrderDelivered', aggregate_type: 'order', pii_class: 'pseudonymous', pii: ['user_id'], fields: keysOf(shape), check,
  doc: 'An order reached the customer.',
});
