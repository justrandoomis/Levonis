import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, oneOf, ledgerCurrency, amount, nonEmptyStr } from '../common';
import type { Infer } from '../../schema';

const shape = {
  order_id: idOrNull,
  user_id: id,
  kind: oneOf('wallet_hold', 'escrow_hold', 'psp_auth'),
  currency: ledgerCurrency,
  amount,
  hold_id: idOrNull,
  event_key: nonEmptyStr, // the hold's wallet_holds.event_key
};
const check = obj(shape);
export type PaymentAuthorizedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.8 — Ledger: a purchase/escrow hold was placed. */
export const PaymentAuthorizedV1 = defineEvent<PaymentAuthorizedV1>({
  type: 'PaymentAuthorized', aggregate_type: 'wallet', pii_class: 'none', pii: ['user_id'], fields: keysOf(shape), check,
  doc: 'A hold (or PSP authorisation) was placed.',
});
