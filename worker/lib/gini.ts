/**
 * GINI INSTALMENTS (Qi Card / مصرف الرافدين) — the parts that are pure.
 *
 * «خدمه اقساطي على تطبيق جني» is the one payment method whose money never
 * touches Levonis. The customer buys the product inside the Gini app, the
 * bank finances it there, and all that crosses to us is a six-digit order
 * number typed at checkout and, later, a receipt barcode a member of staff
 * scans. We collect the delivery fee at the door and nothing else.
 *
 * THREE FACTS DECIDE EVERYTHING DOWNSTREAM AND THEY ARE ALL HERE:
 *
 *   1. THE SPLIT. `giniSplit` divides the payable into what Gini already
 *      settled and what is genuinely due at the door. It is pure so the ONE
 *      place that may compute it — `settle()` in worker/routes/orders.ts,
 *      which runs up to three times per checkout — can call it without
 *      anything else being tempted to recompute the halves afterwards.
 *
 *   2. THE HOLD. «يبقى الطلب معلقا حتى ٢٤ ساعه ويلغي في حال عدم الاستجابة» —
 *      `giniHoldUntil` freezes the deadline at checkout. The sweep compares
 *      against the stored instant and never re-derives it, so an owner
 *      changing `hold_hours` tomorrow cannot cancel an order that was inside
 *      its promised window when it was placed.
 *
 *   3. THE GATE. `giniBlocksConfirmation` answers whether an order may be
 *      moved to `confirmed` — the transition that turns the checkout's stock
 *      hold into a real decrement. «يجب اعلام منصه جني بانه استلم المنتج قبل
 *      ان يتم تجهيز الطلب من الاداره»: until the receipt is scanned, no.
 *
 *   4. WHAT IS OURS TO COLLECT. `levonisCollectibleSql` is the one place that
 *      knows a Gini order's total is not a debt to Levonis. Four separate
 *      queries decide whether an order is "paid" and all four were wrong
 *      about this one method; the note on the function says which.
 *
 * No database, no clock of its own, no I/O — `now` is always an argument, the
 * same rule worker/lib/orderStages.ts follows, so a test can put an order
 * anywhere in time. The SQL fragment at the foot of the file is a STRING and
 * runs nothing; it lives here because Gini is the reason it has to exist.
 */

/**
 * Where a Gini order stands with the bank.
 *
 *   ''                 not a Gini order — every row that predates the feature
 *   'awaiting_receipt' the order number is in, the barcode has not been scanned
 *   'received'         staff scanned the receipt; Gini has been told, and the
 *                      admin may now prepare the order
 *   'expired'          the hold ran out; the sweep cancelled it and released
 *                      the stock it was sitting on
 */
export type GiniState = '' | 'awaiting_receipt' | 'received' | 'expired';

export function giniStateOf(raw: unknown): GiniState {
  return raw === 'awaiting_receipt' || raw === 'received' || raw === 'expired' ? raw : '';
}

export interface GiniSplit {
  /** Settled inside the Gini app — never collected by us, never in the wallet. */
  paidIqd: number;
  /** The only money this order owes Levonis: the delivery fee, 0 for a pickup. */
  deliveryDueIqd: number;
}

/**
 * THE SPLIT, and the two traps it exists to avoid.
 *
 * THE DELIVERY FEE IS ALREADY INSIDE THE PAYABLE. `beforeDiscounts` is
 * `subtotal - lineDiscount + shipping.total_iqd - couponDiscount`, so setting
 * the door amount to the shipping fee while leaving the goods in the payable
 * charges the fee twice. The two halves are therefore derived FROM the payable
 * and must always sum back to it:
 *
 *     paidIqd + deliveryDueIqd === payableIqd
 *
 * AND THE NAIVE SUBTRACTION GOES NEGATIVE. A coupon and points reduce the
 * merchandise before this point, and on a small order with free-ish goods the
 * payable can fall BELOW the delivery fee — `payable - shipping` is then a
 * negative "paid by Gini". The door amount is clamped to the payable and the
 * other half derived from it, which keeps both sides non-negative and the
 * invariant exact at the same time.
 *
 * `shippingIqd` must be the fee AS CHARGED — `shipping.total_iqd`, after
 * waivers and the membership subsidy — never `delivery.price_iqd`, never
 * `total_before_waiver_iqd`, and never a fresh quote. A PRO whose delivery was
 * waived owes nothing at the door, and quoting them the tariff would take
 * money the order does not ask for.
 */
export function giniSplit(payableIqd: number, shippingIqd: number): GiniSplit {
  const payable = Math.max(0, Math.trunc(payableIqd));
  const deliveryDueIqd = Math.min(Math.max(0, Math.trunc(shippingIqd)), payable);
  return { paidIqd: payable - deliveryDueIqd, deliveryDueIqd };
}

/** The frozen deadline, or null when the policy has no honest hold to give. */
export function giniHoldUntil(nowIso: string, holdHours: number): string | null {
  const hours = Number(holdHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const from = Date.parse(nowIso);
  if (!Number.isFinite(from)) return null;
  return new Date(from + Math.trunc(hours * 3_600_000)).toISOString();
}

/**
 * May this order be confirmed?
 *
 * Only a Gini order still waiting for its scan is refused. A cancelled hold
 * ('expired') is already off the path, and an order whose receipt was scanned
 * is exactly the one the admin is meant to prepare — so the answer is a
 * refusal in one state and silence in every other, including for every order
 * that has nothing to do with Gini.
 */
export function giniBlocksConfirmation(order: { payment_method_id?: unknown; gini_state?: unknown }): boolean {
  return String(order.payment_method_id ?? '') === 'gini' && giniStateOf(order.gini_state) === 'awaiting_receipt';
}

/** The 400 code both admin doors answer with, so the panel can explain it once. */
export const GINI_RECEIPT_REQUIRED = 'GINI_RECEIPT_REQUIRED';

/** What staff are told when they try to prepare an order Gini has not been told about. */
export const GINI_RECEIPT_REQUIRED_MESSAGE =
  'لا يمكن تأكيد هذا الطلب قبل مسح باركود الاستلام في تطبيق جني — يجب إعلام منصة جني بأن الزبون استلم المنتج أولاً. / This order cannot be confirmed before the Gini receipt barcode is scanned — Gini must be told the customer received the goods first.';

/**
 * WHAT LEVONIS ITSELF HAS TO COLLECT BEFORE AN ORDER IS SETTLED.
 *
 * "Paid" is one idea in this codebase and it is written as SQL in four
 * places: the points accrual's `settled_at` stamp and `recordOrderSettlement`
 * (worker/lib/pointsOps.ts), the `'paid'` reveal milestone
 * (worker/lib/mysteryReveal.ts) and the support gift's promotion to due
 * (worker/lib/membershipOps.ts). All four asked the same question —
 * `SUM(order_payment_settlements.amount_iqd) >= orders.total_iqd` — and all
 * four answered NO for ever on a Gini order.
 *
 * A Gini order's total is the whole price and the only money that can ever
 * reach `order_payment_settlements` is the delivery fee, because the goods
 * were settled inside the bank's app before the order existed. So a customer
 * who bought with Gini accrued their purchase points, had the courier's fee
 * collected in full, and then waited for a release that could not arrive:
 * `releaseDueAccruals` selects on `settled_at IS NOT NULL`.
 *
 * The fix is on the TOTAL side, never on the collected side. Adding
 * `gini_paid_iqd` to the sum would make `collected_iqd` — a figure the money
 * view and the admin's screens print — claim Levonis took money it never
 * touched. Subtracting it from the total says the true thing instead: this is
 * what is ours to collect. `gini_paid_iqd` is 0 on every other order, so
 * nothing else changes by a dinar.
 */
export function levonisCollectibleSql(alias: string): string {
  return `(${alias}.total_iqd - COALESCE(${alias}.gini_paid_iqd, 0))`;
}
