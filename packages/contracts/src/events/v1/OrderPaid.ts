import { defineEvent, keysOf } from '../define';
import { obj, id, arr, at } from '../common';
import type { Infer } from '../../schema';

const shape = {
  order_id: id,
  ledger_tx_ids: arr(id, { max: 20 }),
  paid_at: at,
};
const check = obj(shape);
export type OrderPaidV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.7b — Orders' PaymentCompleted consumer flipped payment_state='paid'. */
export const OrderPaidV1 = defineEvent<OrderPaidV1>({
  type: 'OrderPaid', aggregate_type: 'order', pii_class: 'none', pii: [], fields: keysOf(shape), check,
  doc: 'The debit behind an order committed; everything that presumes payment hangs on this.',
});
