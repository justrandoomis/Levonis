import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, userHash, nonNegInt, sellerType, paymentMethod, oneOf, bool, at, nonEmptyStr, num, orderItemRefs } from '../common';
import type { Infer } from '../../schema';

const shape = {
  order_id: id,
  user_id: id, // dropped by Analytics; Analytics keys on user_hash
  user_hash: userHash, // daily-salted
  seller_type: sellerType,
  merchant_id: idOrNull,
  store_id: idOrNull,
  payment_state: oneOf('authorized', 'cod'), // authorized = hold placed, debit not yet committed; paid arrives as OrderPaid
  items: orderItemRefs, // references, not snapshots (queue-message cap)
  totals: obj({ merchandise_iqd: nonNegInt, delivery_iqd: nonNegInt, discount_iqd: nonNegInt, total_iqd: nonNegInt }),
  payment: obj({ method: paymentMethod, wallet_usd_cents: nonNegInt, points: nonNegInt, cod_iqd: nonNegInt, exchange_rate: num }),
  shipping_type: nonEmptyStr,
  address_snapshot_ref: id, // the address id — never the address itself
  coupon_code: idOrNull,
  membership_gift: bool,
  referral_delivery_waived: bool,
  idempotency_key: nonEmptyStr, // orders.idempotency_key
  created_at: at,
};
const check = obj(shape);
export type OrderCreatedV1 = Infer<typeof check>;
/**
 * 03-EVENTS.md §3.7 — Orders, inside the fenced order batch, BEFORE the debit
 * commits. Never commission_percent_x100, platform_fee_iqd, merchant_receivable_iqd, admin_note.
 * `merchant_id` is a store identifier, not a person: Analytics keeps it for the merchant rollups (§9.2).
 */
export const OrderCreatedV1 = defineEvent<OrderCreatedV1>({
  type: 'OrderCreated', aggregate_type: 'order', pii_class: 'pseudonymous', pii: ['user_id'], fields: keysOf(shape), check,
  doc: 'An order row was persisted (payment authorized or COD).',
});
