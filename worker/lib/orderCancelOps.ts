/**
 * What a cancelled order gives back — built as statements so BOTH cancel
 * routes (the customer's POST /api/orders/:id/cancel and the admin's PATCH
 * /api/admin/orders/:id → cancelled) run them in the SAME `db.batch` as the
 * conditional status flip.
 *
 * WHY. The customer route used to flip the status with a `.run()` of its own
 * and post the refund from a later batch. A failure between the two left an
 * order that was cancelled and unrefunded, and the route's own "only pending
 * orders can be cancelled" guard then refused every retry: the customer's
 * money was gone for good, from a transient error. The admin route had the
 * same shape and, on top of that, never returned the points reservation or
 * cancelled the pending accrual the way the customer route did.
 *
 * THE SHAPE (§11.4: every guard lives inside the writing statement):
 *  - each refund INSERT is idempotent on its deterministic id
 *    (`wtx_refund_<order>_usd` / `_pts`), so a cancel that runs again — an
 *    order re-opened and cancelled a second time — replays instead of
 *    throwing, and never credits twice;
 *  - each dependent statement repeats the flip's outcome (`status =
 *    'cancelled'`), and a refund whose order is NOT cancelled computes its
 *    amount as -1, violating CHECK (amount > 0) and aborting the batch;
 *  - the fence at the end aborts the batch whenever the flip matched zero rows
 *    — including for a cash order with nothing to refund — so a lost race
 *    (a concurrent cancel, an admin transition) writes nothing at all.
 */
import type { Env } from './types';

/** The order row as both routes hold it (a raw `SELECT *`); only four columns are read. */
export type CancellableOrderMoney = Record<string, unknown>;

/** `?2` is the order id in every statement below. */
const ORDER_IS_CANCELLED = `EXISTS (SELECT 1 FROM orders o WHERE o.id = ?2 AND o.status = 'cancelled')`;

export function cancelledOrderRefundStatements(
  env: Env,
  order: CancellableOrderMoney,
  createdBy: 'system' | 'admin',
  nowIso: string
): D1PreparedStatement[] {
  const id = String(order.id);
  const userId = String(order.user_id);
  const walletCents = Number(order.wallet_applied_usd_cents) || 0;
  const points = Number(order.points_discount_iqd) || 0;
  const out: D1PreparedStatement[] = [];

  // Wallet money comes back by its own channel, as an approved credit that
  // reverses the debit posted at checkout (usdSpendStatement / the store
  // order's hold settlement).
  if (walletCents > 0) {
    out.push(
      env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?3, 'deposit', 'USD', CASE WHEN ${ORDER_IS_CANCELLED} THEN ?4 ELSE -1 END, 'approved', ?5, ?2, ?6, ?7
          WHERE NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?1)`
      ).bind(`wtx_refund_${id}_usd`, id, userId, walletCents, `Refund for cancelled order ${id}`, createdBy, nowIso)
    );
  }
  // §4.4: points come back AS POINTS, never as cash, and the reservation
  // records that the redemption was given back.
  if (points > 0) {
    out.push(
      env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?3, 'deposit', 'POINT', CASE WHEN ${ORDER_IS_CANCELLED} THEN ?4 ELSE -1 END, 'approved', ?5, ?2, ?6, ?7
          WHERE NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?1)`
      ).bind(`wtx_refund_${id}_pts`, id, userId, points, `Points refund for cancelled order ${id}`, createdBy, nowIso),
      env.DB.prepare(
        `UPDATE points_reservations
            SET state = 'refunded', refunded_at = ?1
          WHERE order_id = ?2 AND state = 'committed' AND ${ORDER_IS_CANCELLED}`
      ).bind(nowIso, id)
    );
  }
  // §4.3: the pending accrual of a cancelled order is cancelled, never
  // released. Conditional on state='pending', so an accrual that somehow
  // already released is left to the reversal path instead of vanishing.
  out.push(
    env.DB.prepare(
      `UPDATE points_accruals
          SET state = 'cancelled', cancelled_at = ?1, reason = 'order_cancelled'
        WHERE order_id = ?2 AND state = 'pending' AND ${ORDER_IS_CANCELLED}`
    ).bind(nowIso, id)
  );
  // THE FENCE. `status` is NOT NULL: when the flip did not land, this writes
  // NULL into it and the constraint aborts the whole batch; when it did, the
  // column is rewritten to its own value and nothing changes.
  out.push(
    env.DB.prepare(
      `UPDATE orders SET status = CASE WHEN status = 'cancelled' THEN status ELSE NULL END WHERE id = ?1`
    ).bind(id)
  );
  return out;
}
