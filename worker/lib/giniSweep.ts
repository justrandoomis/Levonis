/**
 * THE 24-HOUR GINI HOLD — «وبخلاف ذلك يبقى الطلب معلقا حتى ٢٤ ساعه ويلغي في
 * حال عدم الاستجابة».
 *
 * A Gini order is placed with its six-digit number and then WAITS: the
 * customer has to collect it and have the receipt barcode scanned, which is
 * what tells the bank the purchase completed. Until that scan the order is
 * `pending` at `received` — and it is holding the stock its checkout
 * reserved. This sweep is the promise that the hold ends.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A CLAUSE IN `orderExpirySweep.ts`
 *
 * That sweep's selection requires `due_on_delivery_iqd >= total_iqd` — "the
 * whole total is still uncollected" — and it is one of four independent layers
 * protecting an order somebody has genuinely paid for. A GINI ORDER CAN NEVER
 * SATISFY IT: its door amount is the delivery fee and its total is the full
 * price, so the existing sweep is structurally blind to these rows.
 *
 * Relaxing that clause to let them through would remove the protection for
 * every other order at the same time, which is the trade nobody may make. So
 * this is a second sweep with its OWN selection, and the clause that stands in
 * for "nobody has paid" here is `gini_state = 'awaiting_receipt'` — the state
 * that says, in the bank's own terms, that the purchase never closed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LAYERS, each one a refusal, any one of them enough:
 *
 *  L1 SELECTION. `status = 'pending'` excludes every stock-deducted state, and
 *     `gini_state = 'awaiting_receipt'` excludes an order whose barcode WAS
 *     scanned — the scan is the response the hold was waiting for, and after
 *     it the order is the admin's to prepare, with no deadline on it at all.
 *     The query also refuses anything ever confirmed (a `deduct`/`restore`/
 *     `release` ledger row: an admin may walk an order BACKWARDS to pending,
 *     and a status-only filter gets exactly that case wrong), anything a human
 *     has already moved, anything with money collected against it, anything
 *     belonging to a merchant store, and any revealed mystery allocation.
 *
 *  L2 THE CLOCK IS THE ORDER'S OWN, frozen at checkout. `gini_hold_until` was
 *     computed once from `giniPolicy.hold_hours` as that checkout read it, so
 *     an owner shortening the policy tomorrow cannot cancel an order that was
 *     inside the window it was promised. Deliberately NOT `updated_at`: the
 *     twenty-four hours are a bank's queue, and an admin opening the order to
 *     look at it must not restart the customer's wait.
 *
 *  L3 THE CONDITIONAL FLIP. `WHERE id = ? AND status = 'pending' AND stage =
 *     'received' AND gini_state = 'awaiting_receipt'` — staff scanning the
 *     barcode in the same instant win the race and this UPDATE matches zero
 *     rows.
 *
 *  L4 THE FENCE. `cancelledOrderRefundStatements` ends with a statement that
 *     writes NULL into NOT NULL `orders.status` when the flip matched nothing,
 *     so D1 rolls the WHOLE batch back: no stock release, no refund, nothing.
 *
 * IT REUSES THE SAFE CANCELLATION PATH, not a private one. `planOrderReturn` +
 * `cancelledOrderRefundStatements` are exactly what the customer's own cancel
 * and the admin's cancel run, in one batch. `moveOrderStage(to: 'cancelled')`
 * would have returned the stock and refunded nothing — and while a Gini order
 * has no wallet money on it by construction, it can carry POINTS the customer
 * spent, and those are theirs to get back.
 *
 * THE MONEY IT MUST NOT TOUCH IS GINI'S. Nothing here refunds an instalment:
 * the goods were financed inside the app and the cancellation of an order we
 * never collected for is not ours to reverse. `gini_state` becomes 'expired',
 * which is the record a customer service conversation with the bank starts
 * from.
 *
 * IT IS IDEMPOTENT BY CONSTRUCTION, for the same reasons orderExpirySweep.ts
 * sets out: the inventory ledger's UNIQUE idempotency key makes a replayed
 * release plan zero statements, the refund rows are deterministic ids behind
 * WHERE NOT EXISTS, the points updates are state-conditional, and the history
 * insert is INSERT OR IGNORE with a deterministic id.
 */
import type { Env } from './types';
import { planOrderReturn } from './orderInventory';
import { cancelledOrderRefundStatements } from './orderCancelOps';
import { newHistoryId } from './orderStageOps';
import { audit } from './audit';

export interface GiniHoldReport {
  scanned: number;
  cancelled: number;
  skipped: number;
  errors: number;
}

/**
 * The candidates.
 *
 * ############################################################################
 * #  `gini_state = 'awaiting_receipt'` IS WRITTEN VERBATIM ON PURPOSE.       #
 * ############################################################################
 *
 * `idx_orders_gini_hold` (migration 0103) is a PARTIAL index on exactly that
 * expression, and SQLite will only use a partial index when the query's WHERE
 * SYNTACTICALLY implies the index's — it matches the text, it does not reason.
 * Rewriting this into an equivalent form (`gini_state <> ''`, an IN list, a
 * COALESCE) costs this sweep its index and turns every cron tick into a full
 * scan of `orders`, with no visible symptom until the table is large.
 */
const CANDIDATES = `
  SELECT o.* FROM orders o
   WHERE o.gini_state = 'awaiting_receipt'                -- the purchase never closed
     AND o.status = 'pending'                             -- never a deducted state
     AND o.stage  = 'received'                            -- the only stage that maps to pending
     AND o.gini_hold_until IS NOT NULL
     AND o.gini_hold_until <= ?1                          -- the frozen deadline has passed
     AND COALESCE(o.origin, 'platform') = 'platform'
     AND COALESCE(o.seller_type, 'levonis') = 'levonis'
     AND NOT EXISTS (SELECT 1 FROM order_payment_settlements s
                      WHERE s.order_id = o.id AND s.amount_iqd > 0)      -- nothing was collected
     AND NOT EXISTS (SELECT 1 FROM inventory_ledger l
                      WHERE l.order_id = o.id AND l.kind IN ('deduct', 'restore', 'release'))
     AND NOT EXISTS (SELECT 1 FROM order_status_history h
                      WHERE h.order_id = o.id AND h.stage <> 'received') -- nobody has moved it
     AND NOT EXISTS (SELECT 1 FROM mystery_allocations a
                      WHERE a.order_id = o.id AND a.revealed_at IS NOT NULL)
   ORDER BY o.gini_hold_until
   LIMIT ?2`;

export async function sweepGiniHolds(env: Env, nowIso: string, limit = 100): Promise<GiniHoldReport> {
  const out: GiniHoldReport = { scanned: 0, cancelled: 0, skipped: 0, errors: 0 };

  const { results } = await env.DB.prepare(CANDIDATES)
    .bind(nowIso, limit)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  out.scanned = rows.length;

  for (const order of rows) {
    const id = String(order.id);
    try {
      // Planned per order (reads only), executed in that order's own batch —
      // one order's problem never takes another order's release with it.
      // NULL actor, not the string 'system': `inventory_ledger.actor_user_id`
      // is a foreign key to `users` and no such user exists.
      const stock = await planOrderReturn(env.DB, id, null);
      const res = await env.DB.batch([
        env.DB.prepare(
          `UPDATE orders SET status = 'cancelled', gini_state = 'expired', updated_at = ?1
            WHERE id = ?2 AND status = 'pending' AND stage = 'received'
              AND gini_state = 'awaiting_receipt'`
        ).bind(nowIso, id),
        ...(stock.plan?.statements ?? []),
        ...cancelledOrderRefundStatements(env, order, 'system', nowIso),
        // In the SAME batch: a history row written afterwards could be lost to
        // a crash, leaving a cancellation nobody can explain to a customer who
        // is still waiting on the bank.
        env.DB.prepare(
          `INSERT OR IGNORE INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note)
           VALUES (?1, ?2, 'cancelled', 'cancelled', 'system', ?3, 'system', ?4)`
        ).bind(
          newHistoryId(id, nowIso),
          id,
          nowIso,
          'Cancelled automatically: the Gini receipt barcode was not scanned before the hold expired'
        ),
      ]);
      const changes = (res[0] as unknown as { meta: { changes: number } })?.meta.changes ?? 0;
      if (changes > 0) {
        out.cancelled += 1;
        await audit(env.DB, 'system', 'order.gini_expired', id, {
          gini_order_no: String(order.gini_order_no ?? ''),
          hold_until: String(order.gini_hold_until ?? ''),
          released: stock.plan?.applied ?? 0,
        });
      } else {
        // The flip lost a race — somebody scanned the barcode in the same
        // instant, and the fence rolled everything back with it.
        out.skipped += 1;
      }
    } catch (e) {
      out.errors += 1;
      console.error('gini hold sweep failed for', id, e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}
