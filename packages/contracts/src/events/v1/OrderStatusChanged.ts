import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, oneOf, nonEmptyStr, nullable, str, at } from '../common';
import type { Infer } from '../../schema';

const shape = {
  order_id: id,
  from: nonEmptyStr, // legacy status values, unchanged
  to: nonEmptyStr,
  stage: nullable(str), // fulfilment stage when the cause is the stage machine
  cause: oneOf('stage', 'admin', 'merchant', 'customer', 'courier', 'system'),
  actor_id: idOrNull,
  at,
};
const check = obj(shape);
export type OrderStatusChangedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.12 — every orders.status transition. */
export const OrderStatusChangedV1 = defineEvent<OrderStatusChangedV1>({
  type: 'OrderStatusChanged', aggregate_type: 'order', pii_class: 'none', pii: ['actor_id'], fields: keysOf(shape), check,
  doc: 'An order status moved.',
});
