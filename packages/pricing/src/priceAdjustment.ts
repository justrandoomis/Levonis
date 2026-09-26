/**
 * «تعديل السعر النهائي» — WHAT A NEW FINAL TOTAL DOES TO AN ORDER'S MONEY.
 *
 * Pure arithmetic shared by the Worker (which writes it, worker/lib/
 * orderPriceAdjust.ts) and the admin panel (which previews it before the admin
 * sends the proposal). No I/O, no clock.
 *
 * THE MODEL IT WORKS ON (worker/routes/orders.ts computeCheckout):
 *
 *   total_iqd            what the order costs after every discount
 *   wallet_applied_iqd   the part already paid from the wallet at checkout
 *   due_on_delivery_iqd  what the courier collects: total − wallet
 *
 * THE OWNER'S RULES, in the order they apply:
 *
 *   higher total → the difference is collected at the door (COD grows); the
 *                  wallet is never debited again without the customer paying.
 *   lower total  → the door amount shrinks first; if the new total is below
 *                  what the wallet already prepaid, the excess goes back to
 *                  the wallet (the Worker writes that credit in the same batch).
 *
 * FINANCED ORDERS ARE REFUSED. BNPL is carried on our own instalment ledger
 * whose charge was frozen at checkout (migration 0066), and a Gini order's
 * goods were paid inside the bank's app — neither has a re-pricing path, so a
 * new total would be a number no ledger agrees with.
 */

/** The ceiling on a proposed total — the same order of magnitude as a wallet operation. */
export const PRICE_ADJUST_MAX_IQD = 1_000_000_000;

export type PriceAdjustRefusal =
  /** Not a whole number of dinars above zero, or absurdly large. */
  | 'PRICE_ADJUST_INVALID_TOTAL'
  /** The new total is the current one — nothing to ask the customer. */
  | 'PRICE_ADJUST_SAME_TOTAL'
  /** BNPL or Gini: no re-pricing path exists for financed money. */
  | 'PRICE_ADJUST_FINANCED'
  /** The stored figures do not add up to a wallet + door split this can move. */
  | 'PRICE_ADJUST_UNSUPPORTED_PAYMENT';

export interface PriceAdjustInput {
  totalIqd: number;
  dueOnDeliveryIqd: number;
  walletAppliedIqd: number;
  paymentMethodId: string;
  bnplDueIqd?: number;
  giniPaidIqd?: number;
  newTotalIqd: number;
}

export interface PriceAdjustPlan {
  oldTotalIqd: number;
  newTotalIqd: number;
  /** new − old; never 0. */
  deltaIqd: number;
  oldDueIqd: number;
  newDueIqd: number;
  oldWalletIqd: number;
  newWalletIqd: number;
  /** Dinars credited back to the wallet on approval; 0 unless the cut reached the prepaid part. */
  walletRefundIqd: number;
}

export type PriceAdjustResult = { ok: true; plan: PriceAdjustPlan } | { ok: false; code: PriceAdjustRefusal };

const whole = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
};

/** Is this payment method (or these stored figures) financed? */
export function isFinancedOrder(p: { paymentMethodId: string; bnplDueIqd?: number; giniPaidIqd?: number }): boolean {
  const id = String(p.paymentMethodId ?? '');
  return id === 'bnpl' || id === 'gini' || whole(p.bnplDueIqd) > 0 || whole(p.giniPaidIqd) > 0;
}

export function planPriceAdjustment(input: PriceAdjustInput): PriceAdjustResult {
  const next = Number(input.newTotalIqd);
  if (!Number.isSafeInteger(next) || next <= 0 || next > PRICE_ADJUST_MAX_IQD) {
    return { ok: false, code: 'PRICE_ADJUST_INVALID_TOTAL' };
  }
  if (isFinancedOrder(input)) return { ok: false, code: 'PRICE_ADJUST_FINANCED' };

  const total = whole(input.totalIqd);
  const due = whole(input.dueOnDeliveryIqd);
  const wallet = whole(input.walletAppliedIqd);
  if (next === total) return { ok: false, code: 'PRICE_ADJUST_SAME_TOTAL' };

  const delta = next - total;
  let newDue = due;
  let newWallet = wallet;
  if (delta > 0) {
    newDue = due + delta;
  } else {
    const cut = -delta;
    const fromDue = Math.min(due, cut);
    const rest = cut - fromDue;
    // Whatever the door amount cannot absorb must have been prepaid from the
    // wallet. If it was not — money the model does not know the source of —
    // refuse rather than invent a refund.
    if (rest > wallet) return { ok: false, code: 'PRICE_ADJUST_UNSUPPORTED_PAYMENT' };
    newDue = due - fromDue;
    newWallet = wallet - rest;
  }
  return {
    ok: true,
    plan: {
      oldTotalIqd: total,
      newTotalIqd: next,
      deltaIqd: delta,
      oldDueIqd: due,
      newDueIqd: newDue,
      oldWalletIqd: wallet,
      newWalletIqd: newWallet,
      walletRefundIqd: wallet - newWallet,
    },
  };
}
