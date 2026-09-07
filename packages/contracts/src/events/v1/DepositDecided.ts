import { defineEvent, keysOf } from '../define';
import { obj, id, amount, oneOf } from '../common';
import type { Infer } from '../../schema';

const shape = {
  request_id: id,
  user_id: id,
  decision: oneOf('approved', 'rejected'),
  decided_by: id,
  usd_cents: amount,
};
const check = obj(shape);
export type DepositDecidedV1 = Infer<typeof check>;
/** 03-EVENTS.md §4 — Payments (LEDGER.decideDeposit, the only approval path); personal. */
export const DepositDecidedV1 = defineEvent<DepositDecidedV1>({
  type: 'DepositDecided', aggregate_type: 'wallet', pii_class: 'personal', pii: ['user_id', 'decided_by'], fields: keysOf(shape), check,
  doc: 'A deposit request was approved or rejected.',
});
