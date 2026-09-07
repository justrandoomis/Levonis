import { defineEvent, keysOf } from '../define';
import { obj, id, hex64, nonNegInt, oneOf, arr } from '../common';
import type { Infer } from '../../schema';

const shape = {
  order_id: id, // doubles as the provider event_id for dedup
  user_hash: hex64, // stable (not daily-salted); Ads joins against ads_consent_snapshots
  value_iqd: nonNegInt,
  currency: oneOf('IQD'),
  content_ids: arr(id, { max: 200 }), // product ids
  num_items: nonNegInt,
};
const check = obj(shape);
export type PurchaseCompletedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.14 — Orders, on OrderPaid (prepaid) or OrderDelivered (COD, D20); never on OrderCreated. */
export const PurchaseCompletedV1 = defineEvent<PurchaseCompletedV1>({
  type: 'PurchaseCompleted', aggregate_type: 'order', pii_class: 'pseudonymous', pii: [], fields: keysOf(shape), check,
  doc: 'The PII-free conversion fact for Ads and Analytics.',
});
