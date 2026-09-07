import { defineEvent, keysOf } from '../define';
import { obj, id, oneOf, amount, nonEmptyStr, arr } from '../common';
import type { Infer } from '../../schema';

const shape = {
  ref_type: oneOf('order', 'return', 'price_protection', 'escrow', 'membership'),
  ref_id: id, // order / case / claim / escrow / membership id
  user_id: id,
  usd_cents: amount, // 0 when none
  points: amount, // 0 when none
  ledger_tx_ids: arr(id, { max: 20 }),
  event_key: nonEmptyStr, // wtx_refund_<id>_usd, wtx_ret_<caseId>, wtx_pp_<claimId>, wtx_refund_<membershipId>
};
const check = obj(shape);
export type RefundCompletedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.11 — Ledger `refund` command. */
export const RefundCompletedV1 = defineEvent<RefundCompletedV1>({
  type: 'RefundCompleted', aggregate_type: 'wallet', pii_class: 'none', pii: ['user_id'], fields: keysOf(shape), check,
  doc: 'A refund was credited.',
});
