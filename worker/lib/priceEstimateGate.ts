/**
 * THE ESTIMATE GATE (migration 0218, triggers T6–T9), as the predicates every
 * order door needs. Same shape as priceHold.ts: a leaf module — no imports —
 * so the stage machine, the admin routes, the courier door, Telegram and the
 * sweeps can ask without pulling the estimate feature into their dependency
 * graph.
 *
 * While any estimate line of an order is open, proposed or rejected, the order
 * stays at «تم الاستلام»: trigger T8 refuses every status but pending /
 * cancelled, every stage but received / cancelled, and a courier booking,
 * whatever door writes. The doors pre-read the same fact (`hasOpenEstimates`,
 * one indexed statement) to answer with a sentence instead of an abort, and
 * map the abort itself when they lose a race (`isEstimateGateAbort`). The
 * customer's own cancel always passes; T9 then refuses a reopening
 * (`isEstimateReopenAbort`).
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): "no such table: order_price_estimates" is a
 * database without 0218 — no estimate line and no trigger — so
 * `hasOpenEstimates` answers false. Any other error is thrown: the stage door
 * then lets the move proceed and the trigger decide, and the courier door
 * refuses (503) before the courier is called.
 */

/** The `ops_guards` id the checkout batch holds while it writes an order's estimated lines (triggers T6 and T7). */
export const ESTIMATE_CHECKOUT_GUARD_PREFIX = 'estimate-checkout:';

/** `estimate-checkout:<order id>` — inserted before the order's lines, deleted after its estimate rows, in one batch. */
export const estimateCheckoutGuardId = (orderId: string): string => `${ESTIMATE_CHECKOUT_GUARD_PREFIX}${orderId}`;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Did a D1 write abort on the gate (`trg_orders_price_estimate_gate`)? */
export function isEstimateGateAbort(e: unknown): boolean {
  return /PRICE_ESTIMATE_UNCONFIRMED/.test(messageOf(e));
}

/** Did a D1 write abort because it reopened a cancelled estimate order (`trg_orders_price_estimate_reopen`)? */
export function isEstimateReopenAbort(e: unknown): boolean {
  return /PRICE_ESTIMATE_REOPEN_REFUSED/.test(messageOf(e));
}

/** The gate's states, through 0218's partial index `ix_ope_open`. */
const OPEN_LINES_SQL =
  "SELECT 1 AS x FROM order_price_estimates WHERE order_id = ? AND state IN ('open','proposed','rejected') LIMIT 1";

const MISSING_TABLE = /no such table:?\s*(?:main\.)?order_price_estimates\b/i;

/**
 * Is this order held by an unsettled estimate line? One indexed statement.
 * False on a database without 0218; any other failure is thrown for the door
 * to decide (see the header).
 */
export async function hasOpenEstimates(db: Pick<D1Database, 'prepare'>, orderId: string): Promise<boolean> {
  try {
    const row = await db.prepare(OPEN_LINES_SQL).bind(orderId).first<{ x: number }>();
    return row !== null && row !== undefined;
  } catch (e) {
    if (MISSING_TABLE.test(messageOf(e))) return false;
    throw e;
  }
}

/** The one sentence every held door answers with (409 PRICE_ESTIMATE_UNCONFIRMED); its Sorani is in the contract. */
export const PRICE_ESTIMATE_UNCONFIRMED_MESSAGE =
  'لا يمكن تأكيد هذا الطلب أو تجهيزه أو شحنه قبل تأكيد السعر النهائي لمنتجاته التقديرية. / This order cannot be confirmed, prepared or shipped until the final price of its estimated items is confirmed.';

/** The sentence of a refused reopening (409 PRICE_ESTIMATE_REOPEN_REFUSED); its Sorani is in the contract. */
export const PRICE_ESTIMATE_REOPEN_REFUSED_MESSAGE =
  'لا يُعاد فتح طلب ملغى فيه منتجات بسعر تقديري؛ يضع الزبون طلبًا جديدًا. / A cancelled order with items at an estimated price is not reopened; the customer places a new order.';
