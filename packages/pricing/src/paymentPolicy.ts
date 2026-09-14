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
 * nor "cash on delivery" in the owner's words, so it is refused.
 *
 * The merchant storefront (routes/storeOrders.ts) has its own vocabulary
 * ('cod' | 'wallet') and is deliberately not touched by this module.
 */

import type { ShippingType } from './shippingType';

/** 400 code for a payment id the policy refuses. */
export const PAYMENT_METHOD_NOT_ALLOWED = 'PAYMENT_METHOD_NOT_ALLOWED';

/** Base methods plus BNPL only after the server proves this checkout eligible. */
export function allowedPaymentMethods(
  _shippingType: ShippingType | null,
  options: { bnplEligible?: boolean } = {}
): string[] {
  return options.bnplEligible ? ['wallet', 'cash', 'bnpl'] : ['wallet', 'cash'];
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
 * May this cart be paid with this id? The offered list is what the storefront
 * shows; the accepted set is that list plus the tolerated alias, so an old
 * client or script keeps working without the alias ever being advertised.
 */
export function isPaymentMethodAllowed(
  paymentMethodId: string,
  shippingType: ShippingType | null,
  options: { bnplEligible?: boolean } = {}
): boolean {
  return isCod(paymentMethodId) || isPrepaid(paymentMethodId) || (isBnpl(paymentMethodId) && allowedPaymentMethods(shippingType, options).includes('bnpl'));
}

/**
 * The pricing basis a payment id implies for a PRE-ORDER line. An empty id
 * (quote mode before the customer chose) prices as prepaid — the configured
 * pre-order price — which is also what the cart and the product page show.
 */
export function preorderPricingFor(paymentMethodId: string): 'prepaid' | 'cod' {
  return isCod(paymentMethodId) ? 'cod' : 'prepaid';
}
