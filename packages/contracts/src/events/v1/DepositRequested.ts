import { defineEvent, keysOf } from '../define';
import { obj, id, amount, nonEmptyStr, bool } from '../common';
import type { Infer } from '../../schema';

const shape = {
  request_id: id,
  user_id: id,
  usd_cents: amount,
  method: nonEmptyStr,
  receipt_key_present: bool,
  approval_nonce: nonEmptyStr, // its hash is stored by Ledger in wallet_deposit_meta.approval_nonce_hash (01-TARGET §6.5)
};
const check = obj(shape);
export type DepositRequestedV1 = Infer<typeof check>;
/** 03-EVENTS.md §4 — Payments; personal: Notifications (admin group), Risk, Files — never Analytics. */
export const DepositRequestedV1 = defineEvent<DepositRequestedV1>({
  type: 'DepositRequested', aggregate_type: 'wallet', pii_class: 'personal', pii: ['user_id'], fields: keysOf(shape), check,
  doc: 'A customer asked for a deposit to be approved.',
});
