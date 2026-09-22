/**
 * Which payment methods a cart may use, and what each one means for pricing.
 *
 * THE OWNER'S RULE, kept deliberately simple («Keep the system simple»):
 *
 *   - Direct sale: pay in advance from the wallet, or cash on delivery.
 *   - Pre-order:   pay in advance from the wallet — the pre-order pricing
 *                  (transport commission) stays exactly as configured — or
 *                  cash on delivery, in which case the line is PRICED like a
 *                  direct sale (base + direct-sale premium) while the order
 *                  remains a pre-order with its journey and its fourteen
 *                  stages. Only the commission/pricing logic differs — and
 *                  only when the product HAS a direct-sale premium to price
 *                  the line with (worker/lib/pricing.ts): a pre-order with
 *                  none keeps its commission under either method. A cash
 *                  order the wallet settles in full is a prepaid order and is
 *                  priced as one (worker/routes/orders.ts computeCheckout).
 *
 * `preorderPricingFor` below answers only what the BUTTON says; the resolver
 * and the checkout apply the two qualifications above.
 *
 * So the offered list is the same two ids for every shipping type, and the
 * shipping type is passed anyway so a future per-type rule has one place to
 * land instead of a scatter of `if`s across the checkout.
 *
 * IDS ARE NEVER RENAMED. `cash` is the platform's cash-on-delivery id (admin
 * labels, courier stickers and receipts branch on it) and `wallet` the
 * pay-in-advance id; both are owner-editable rows of the
 * `checkoutPaymentMethods` setting. `full_advance` is TOLERATED as an alias of
 * `wallet` because stored orders and the API scripts already carry it — it is
 * not offered by the storefront. `half_advance` is neither "pay in advance"
 * nor "cash on delivery" in the owner's words, so it is refused. `bnpl` is
 * PRO financing carried on our own books. `gini` is the fifth id and the only
 * one whose money never touches Levonis at all.
 *
 * WHY `gini` IS ITS OWN ID AND NOT A FLAVOUR OF `bnpl`. «خدمه اقساطي على
 * تطبيق جني (مصرف الرافدين)» — the customer buys the product inside the Gini
 * app, Qi Card/Rafidain finances it there, and Levonis learns of it only as a
 * six-digit order number the customer types at checkout. There is no Levonis
 * credit limit, no repayment schedule, no ledger row and no instalment we ever
 * collect: the only money that reaches us is the delivery fee at the door.
 * `bnpl` is the opposite of every one of those (migration 0066 guards its
 * ledger on an ACTIVE PRO with an approved credit line), so the two share a
 * word in English and nothing else. Anyone tempted to fold them together will
 * point a charge at `bnpl_ledger` and have the trigger abort a checkout that
 * was never financed by us.
 *
 * The merchant storefront (routes/storeOrders.ts) has its own vocabulary
 * ('cod' | 'wallet') and is deliberately not touched by this module.
 */

import type { ShippingType } from './shippingType';

/** 400 code for a payment id the policy refuses. */
export const PAYMENT_METHOD_NOT_ALLOWED = 'PAYMENT_METHOD_NOT_ALLOWED';

/**
 * What the server may offer for this cart.
 *
 * Both extras are OPT-IN and default to absent, which is what keeps the two
 * ids off a checkout that has not earned them: BNPL only after the server has
 * proved this account eligible, and Gini only while the owner has the service
 * switched on (`giniPolicy.enabled`). A client that posts either id without
 * the server having said so is refused by `isPaymentMethodAllowed` below.
 */
export function allowedPaymentMethods(
  _shippingType: ShippingType | null,
  options: PaymentMethodOptions = {}
): string[] {
  const ids = ['wallet', 'cash'];
  if (options.bnplEligible) ids.push('bnpl');
  if (options.giniEnabled) ids.push('gini');
  return ids;
}

/** What the SERVER knows that a bare id cannot say for itself. */
export interface PaymentMethodOptions {
  bnplEligible?: boolean;
  /** «خدمه اقساطي على تطبيق جني» — the owner's switch, never the client's. */
  giniEnabled?: boolean;
}

/** Cash on delivery — the platform id is 'cash'. */
export function isCod(paymentMethodId: string): boolean {
  return paymentMethodId === 'cash';
}

/** Paid in full at checkout from the wallet. `full_advance` is a tolerated alias. */
export function isPrepaid(paymentMethodId: string): boolean {
  return paymentMethodId === 'wallet' || paymentMethodId === 'full_advance';
}

/** PRO financing; eligibility is deliberately outside this pure id parser. */
export function isBnpl(paymentMethodId: string): boolean {
  return paymentMethodId === 'bnpl';
}

/**
 * Instalments taken out inside the Gini app (Qi Card / Rafidain Bank).
 *
 * Neither prepaid nor cash on delivery: the goods are settled outside Levonis
 * and only the delivery fee is collected at the door. Whether the service is
 * switched on is the owner's setting, not something an id can answer, so it
 * stays outside this pure parser exactly as BNPL eligibility does.
 */
export function isGini(paymentMethodId: string): boolean {
  return paymentMethodId === 'gini';
}

/**
 * May this cart be paid with this id? The offered list is what the storefront
 * shows; the accepted set is that list plus the tolerated alias, so an old
 * client or script keeps working without the alias ever being advertised.
 */
export function isPaymentMethodAllowed(
  paymentMethodId: string,
  shippingType: ShippingType | null,
  options: PaymentMethodOptions = {}
): boolean {
  const offered = allowedPaymentMethods(shippingType, options);
  return (
    isCod(paymentMethodId) ||
    isPrepaid(paymentMethodId) ||
    (isBnpl(paymentMethodId) && offered.includes('bnpl')) ||
    (isGini(paymentMethodId) && offered.includes('gini'))
  );
}

/**
 * The pricing basis a payment id implies for a PRE-ORDER line. An empty id
 * (quote mode before the customer chose) prices as prepaid — the configured
 * pre-order price — which is also what the cart and the product page show.
 */
export function preorderPricingFor(paymentMethodId: string): 'prepaid' | 'cod' {
  return isCod(paymentMethodId) ? 'cod' : 'prepaid';
}

/**
 * The six digits Gini gives the customer for their order in the app, which is
 * the only handle Levonis has on a purchase it did not process. Checked
 * server-side where the checkout input is parsed and again by the CHECK
 * constraint on `orders.gini_order_no`, because a typo here is an order
 * nobody can reconcile against the Gini platform afterwards.
 */
export const GINI_ORDER_NO_RE = /^[0-9]{6}$/;

export function isGiniOrderNo(value: unknown): boolean {
  return typeof value === 'string' && GINI_ORDER_NO_RE.test(value);
}
