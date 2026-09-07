import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, oneOf, ledgerCurrency, amount, nonEmptyStr } from '../common';
import type { Infer } from '../../schema';

const shape = {
  order_id: idOrNull,
  user_id: id,
  kind: oneOf('wallet_hold', 'wallet_debit', 'psp_auth'),
  currency: ledgerCurrency,
  amount,
  reason: oneOf('INSUFFICIENT_FUNDS', 'HOLD_CONFLICT', 'STATE_CONFLICT', 'PROVIDER', 'TIMEOUT'),
  event_key: nonEmptyStr,
};
const check = obj(shape);
export type PaymentFailedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.10 — a hold or debit was refused, or a saga step failed. */
export const PaymentFailedV1 = defineEvent<PaymentFailedV1>({
  type: 'PaymentFailed', aggregate_type: 'wallet', pii_class: 'none', pii: ['user_id'], fields: keysOf(shape), check,
  doc: 'A payment command was refused.',
});
