import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, oneOf, ledgerCurrency, amount, nonEmptyStr, arr } from '../common';
import type { Infer } from '../../schema';

const shape = {
  order_id: idOrNull,
  user_id: id,
  kind: oneOf('wallet_debit', 'cod_settled', 'deposit_approved', 'escrow_released', 'psp_capture'),
  currency: ledgerCurrency,
  amount,
  ledger_tx_ids: arr(id, { max: 20 }), // wallet_transactions.id values written
  event_key: nonEmptyStr, // the command's key (wtx_ord_<id>_usd, …)
};
const check = obj(shape);
export type PaymentCompletedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.9 — Ledger/Payments: a debit committed, a COD settlement was recorded, a deposit approved. */
export const PaymentCompletedV1 = defineEvent<PaymentCompletedV1>({
  type: 'PaymentCompleted', aggregate_type: 'wallet', pii_class: 'none', pii: ['user_id'], fields: keysOf(shape), check,
  doc: 'Money moved for good.',
});
