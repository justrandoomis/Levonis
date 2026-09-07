import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, oneOf, nonEmptyStr } from '../common';
import type { Infer } from '../../schema';

const shape = {
  referrer_id: id,
  referee_id: id,
  code: nonEmptyStr,
  attribution_id: id,
  context: oneOf('signup', 'order', 'membership'),
  order_id: idOrNull,
};
const check = obj(shape);
export type ReferralUsedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.15 — Referrals: attribution created or reward granted. */
export const ReferralUsedV1 = defineEvent<ReferralUsedV1>({
  type: 'ReferralUsed', aggregate_type: 'referral', pii_class: 'pseudonymous', pii: ['referrer_id', 'referee_id'], fields: keysOf(shape), check,
  doc: 'A referral code was used.',
});
