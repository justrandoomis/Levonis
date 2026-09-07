import { defineEvent, keysOf } from '../define';
import { obj, id, amount, nonEmptyStr } from '../common';
import type { Infer } from '../../schema';

const shape = {
  withdrawal_id: id,
  user_id: id,
  from: nonEmptyStr,
  to: nonEmptyStr,
  usd_cents: amount,
};
const check = obj(shape);
export type WithdrawalStateChangedV1 = Infer<typeof check>;
/** 03-EVENTS.md §4 — Payments (WITHDRAWAL_TRANSITIONS); personal. */
export const WithdrawalStateChangedV1 = defineEvent<WithdrawalStateChangedV1>({
  type: 'WithdrawalStateChanged', aggregate_type: 'wallet', pii_class: 'personal', pii: ['user_id'], fields: keysOf(shape), check,
  doc: 'A withdrawal moved through its state machine.',
});
