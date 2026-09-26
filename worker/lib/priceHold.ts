/**
 * THE PRICE HOLD (migration 0140), as the two predicates every order door
 * needs. A leaf module — no imports — so the stage machine, the admin routes
 * and the sweeps can ask without pulling the price-adjustment feature (and its
 * Telegram and notification imports) into their dependency graph.
 */

/** Is this order held for the customer's decision on a new price? */
export function isPriceHeld(order: Record<string, unknown> | null | undefined): boolean {
  const v = order?.price_hold_id;
  return typeof v === 'string' && v !== '';
}

/** Did a D1 write abort on `trg_orders_price_hold_freeze`? */
export function isPriceHoldAbort(e: unknown): boolean {
  return /PRICE_APPROVAL_PENDING/.test(e instanceof Error ? e.message : String(e));
}

/** The one sentence every held door answers with (409 PRICE_APPROVAL_PENDING). */
export const PRICE_APPROVAL_PENDING_MESSAGE =
  'الطلب بانتظار موافقة الزبون على السعر الجديد — اسحب الاقتراح أو انتظر قرار الزبون. / This order is waiting for the customer to approve a new price — withdraw the proposal or wait for their decision.';
