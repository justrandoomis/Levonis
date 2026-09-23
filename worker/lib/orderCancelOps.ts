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
import { releaseOrderRedemptionsStatement } from './offers';
import { walletLedgerDinarsReady } from './walletOps';

/** The order row as both routes hold it (a raw `SELECT *`); only four columns are read. */
export type CancellableOrderMoney = Record<string, unknown>;

/** `?2` is the order id in every statement below. */
const ORDER_IS_CANCELLED = `EXISTS (SELECT 1 FROM orders o WHERE o.id = ?2 AND o.status = 'cancelled')`;

/**
 * ASYNC SINCE MIGRATION 0108, AND THIS IS WHY.
 *
 * The wallet refund below now has to carry the DINARS the debit carried, and
 * whether `wallet_transactions` can hold them is a question about the
 * DATABASE, not about the order. A Worker can be live ahead of its migration
 * (worker/lib/schemaVersion.ts reports drift, it does not prevent it), and an
 * INSERT that names a column which is not there does not degrade — it aborts
 * the very batch that is cancelling the order and returning the money. So the
 * shape is chosen from `walletLedgerDinarsReady`, which memoises a `true` for
 * the life of the isolate: a sweep holding hundreds of orders probes once.
 */
export async function cancelledOrderRefundStatements(
  env: Env,
  order: CancellableOrderMoney,
  createdBy: 'system' | 'admin',
  nowIso: string
): Promise<D1PreparedStatement[]> {
  const id = String(order.id);
  const userId = String(order.user_id);
  const walletCents = Number(order.wallet_applied_usd_cents) || 0;
  const points = Number(order.points_discount_iqd) || 0;
  const out: D1PreparedStatement[] = [];
  const ledgerDinars = walletCents > 0 ? await walletLedgerDinarsReady(env.DB) : false;

  /**
   * Wallet money comes back by its own channel, as an approved credit that
   * reverses the debit posted at checkout (usdSpendStatement / the store
   * order's hold settlement).
   *
   * AND IT COMES BACK IN BOTH UNITS, WHICH IT DID NOT USED TO.
   *
   * THE BUG THIS CLOSES, measured end to end: a customer typed 50,000 د.ع and
   * read 50,000. They placed the printer order, whose debit records
   * `amount_iqd = 50,000` (migration 0108) — and recording it is what cancels
   * the six-dinar remainder of their own deposit, correctly, because that
   * remainder was spent. They cancelled the order. Every CENT came back and no
   * dinar did, so the balance read 49,994: six dinars LOWER than before they
   * shopped, permanently, and the same printer order was then refused for
   * being six dinars short. A cancel that leaves a customer poorer than not
   * ordering at all is the forbidden shape, and it was live.
   *
   * THE DINARS ARE COPIED FROM THE DEBITS, NOT RECOMPUTED. The subquery sums
   * `amount_iqd` over the USD debits filed against THIS order and takes the
   * rate recorded beside them, so:
   *   * a debit that recorded dinars is reversed by a credit recording the
   *     same dinars — the remainder it cancelled comes back, exactly;
   *   * a debit that recorded none (a store order settled from a hold, an
   *     escrow path) is reversed by a credit recording none — symmetric, and
   *     the remainder sum is untouched by either side;
   *   * NO RATE IS EVER INVENTED. `exchange_rate_snapshot` is read off the
   *     debit; a debit with no rate yields NULL and the pair is dropped
   *     together, because a dinar figure with no rate beside it is a claim no
   *     later reader could convert.
   * `MAX(...)` over the snapshot rather than an arbitrary pick: an order has
   * at most one USD wallet debit, and if a repair ever produced two, taking
   * the larger rate cannot make the refund claim more dinars than the debits
   * recorded (the dinars themselves are SUMmed, not derived from the rate).
   */
  if (walletCents > 0) {
    const refundDinarsSql = `(SELECT SUM(d.amount_iqd) FROM wallet_transactions d
            WHERE d.ref = ?2 AND d.user_id = ?3 AND d.currency = 'USD' AND d.type = 'withdrawal'
              AND d.amount_iqd > 0 AND d.exchange_rate_snapshot > 0)`;
    const refundRateSql = `(SELECT MAX(d.exchange_rate_snapshot) FROM wallet_transactions d
            WHERE d.ref = ?2 AND d.user_id = ?3 AND d.currency = 'USD' AND d.type = 'withdrawal'
              AND d.amount_iqd > 0 AND d.exchange_rate_snapshot > 0)`;
    out.push(
      env.DB.prepare(
        ledgerDinars
          ? `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, amount_iqd, exchange_rate_snapshot)
         SELECT ?1, ?3, 'deposit', 'USD', CASE WHEN ${ORDER_IS_CANCELLED} THEN ?4 ELSE -1 END, 'approved', ?5, ?2, ?6, ?7,
                ${refundDinarsSql}, ${refundRateSql}
          WHERE NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?1)`
          : `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
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
  // §17 decision 4: a genuinely cancelled order gives its offer slot back —
  // unless it carries a mystery allocation, in which case it never does. The
  // statement is fenced on `status = 'cancelled'` exactly like the refunds
  // above, so a flip that did not land releases nothing.
  out.push(releaseOrderRedemptionsStatement(env.DB, id, nowIso));

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
