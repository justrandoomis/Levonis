import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, oneOf, nullable, str, bool, isoDate } from '../common';
import type { Infer } from '../../schema';

const shape = {
  user_id: id,
  from_tier: nullable(str),
  to_tier: nullable(str),
  plan_id: idOrNull,
  membership_id: idOrNull,
  active: bool,
  expires_at: nullable(isoDate),
  reason: oneOf('purchased', 'expired', 'cancelled', 'gift', 'admin', 'launch'),
};
const check = obj(shape);
export type SubscriptionChangedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.16 (alias MembershipChanged) — Subscriptions; Identity applies last seq wins. */
export const SubscriptionChangedV1 = defineEvent<SubscriptionChangedV1>({
  type: 'SubscriptionChanged', aggregate_type: 'membership', pii_class: 'none', pii: ['user_id'], fields: keysOf(shape), check,
  doc: 'A membership tier changed (purchase, expiry, cancel, gift, admin, launch).',
});
