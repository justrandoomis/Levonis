import { defineEvent, keysOf } from '../define';
import { obj, id, userHash, posInt, nonNegInt, sellerType, paymentMethod, arr } from '../common';
import type { Infer } from '../../schema';

const shape = {
  session_id: id, // the checkout_sagas id once it exists; the idempotency_key before
  user_hash: userHash,
  lines: arr(obj({ product_id: id, qty: posInt }), { max: 200 }),
  totals: obj({ items_iqd: nonNegInt, delivery_iqd: nonNegInt, discount_iqd: nonNegInt, grand_iqd: nonNegInt }),
  payment_method: paymentMethod, // ids never renamed (lib/paymentPolicy.ts)
  seller_type: sellerType,
};
const check = obj(shape);
export type CheckoutStartedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.6 — Checkout quote step; at most one per session_id. */
export const CheckoutStartedV1 = defineEvent<CheckoutStartedV1>({
  type: 'CheckoutStarted', aggregate_type: 'checkout', pii_class: 'pseudonymous', pii: ['user_hash'], fields: keysOf(shape), check,
  doc: 'A checkout quote was computed for a cart.',
});
