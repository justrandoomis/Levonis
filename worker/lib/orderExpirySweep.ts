/**
 * THE SWEEP THAT LETS AN ABANDONED CHECKOUT GO — owner decision 5.
 *
 * The config lives in `orderExpiry.ts` (a leaf); this is the part that reads
 * the database, and it exists to honour one sentence: *"the customer must
 * never lose a legitimately confirmed order because a cleanup job ran."*
 *
 * FOUR INDEPENDENT LAYERS SAY NO, and any ONE of them is enough:
 *
 *  L1 SELECTION. `status = 'pending'` excludes every stock-deducted state
 *     (confirmed, processing, shipped, delivered). But `pending` does NOT mean
 *     unpaid — checkout writes `pending` even for a fully wallet-prepaid order
 *     — so the query also refuses anything with wallet money applied, anything
 *     whose total is not still entirely due on delivery, anything with a
 *     settlement recorded, anything that was ever confirmed (a `deduct` or
 *     `restore` ledger row: an admin may walk an order BACKWARDS from
 *     confirmed to pending, and a status-only filter gets exactly that case
 *     wrong), anything a human has already moved, anything belonging to a
 *     merchant store, and any order carrying a revealed mystery allocation.
 *
 *  L2 THE CLOCK IS `updated_at`, NOT `created_at`. Every write to the order
 *     touches it, so a row an admin re-opened, edited or moved back to pending
 *     starts its wait again instead of being swept 15 minutes later, for ever,
 *     invisibly.
 *
 *  L3 THE CONDITIONAL FLIP. `WHERE id = ? AND status = 'pending' AND stage =
 *     'received'` — an admin confirming in the same instant wins the race and
 *     the sweep's UPDATE matches zero rows.
 *
 *  L4 THE FENCE. `cancelledOrderRefundStatements` ends with a statement that
 *     writes NULL into NOT NULL `orders.status` when the flip matched nothing,
 *     so D1 rolls the WHOLE batch back: no refund, no stock release, nothing.
 *
 * IT REUSES THE SAFE CANCELLATION PATH, not a private one:
 * `planOrderReturn` + `cancelledOrderRefundStatements` are exactly what the
 * customer's own cancel and the admin's cancel run, in one batch. Using
 * `moveOrderStage(to: 'cancelled')` instead would have returned the stock and
 * refunded nothing.
 *
 * IT IS IDEMPOTENT BY CONSTRUCTION. Every write is already single-winner: the
 * inventory ledger's UNIQUE idempotency key makes a replayed release plan zero
 * statements, the reservation fence re-reads and upserts, the refund rows are
 * deterministic ids behind WHERE NOT EXISTS, the points updates are
 * state-conditional, and the history insert is INSERT OR IGNORE with a
 * deterministic id. Two overlapping cron runs — or a cron overlapping the
 * customer's own cancel — converge.
 */
import type { Env } from './types';
import { planOrderReturn } from './orderInventory';
import { cancelledOrderRefundStatements } from './orderCancelOps';
import { newHistoryId } from './orderStageOps';
import { orderExpiryActive, type OrderExpiryConfig } from './orderExpiry';
import { audit } from './audit';

export interface OrderExpiryReport {
  configured: boolean;
  scanned: number;
  cancelled: number;
  skipped: number;
  errors: number;
}

/**
 * The candidates. Every clause is a refusal, and the comment on each says
 * which legitimate order it protects.
 */
const CANDIDATES = `
  SELECT o.* FROM orders o
   WHERE o.status = 'pending'                       -- never a deducted state
     AND o.stage  = 'received'                      -- the only stage that maps to pending
     AND o.updated_at <= ?1                         -- untouched for the whole TTL
     AND COALESCE(o.origin, 'platform') = 'platform'
     AND COALESCE(o.seller_type, 'levonis') = 'levonis'
     AND COALESCE(o.wallet_applied_iqd, 0) = 0      -- nothing prepaid from the wallet
     AND COALESCE(o.wallet_applied_usd_cents, 0) = 0
     AND COALESCE(o.points_discount_iqd, 0) = 0     -- no points spent on it either
     AND COALESCE(o.due_on_delivery_iqd, 0) >= COALESCE(o.total_iqd, 0)  -- the whole total is still uncollected
     AND NOT EXISTS (SELECT 1 FROM order_payment_settlements s
                      WHERE s.order_id = o.id AND s.amount_iqd > 0)      -- nothing was ever collected
     AND NOT EXISTS (SELECT 1 FROM inventory_ledger l
                      WHERE l.order_id = o.id AND l.kind IN ('deduct', 'restore', 'release'))
     AND NOT EXISTS (SELECT 1 FROM order_status_history h
                      WHERE h.order_id = o.id AND h.stage <> 'received') -- nobody has moved it
     AND NOT EXISTS (SELECT 1 FROM mystery_allocations a
                      WHERE a.order_id = o.id AND a.revealed_at IS NOT NULL)
   ORDER BY o.updated_at
   LIMIT ?2`;

export async function sweepExpiredOrders(
  env: Env,
  cfg: OrderExpiryConfig,
  nowIso: string
): Promise<OrderExpiryReport> {
  const out: OrderExpiryReport = { configured: false, scanned: 0, cancelled: 0, skipped: 0, errors: 0 };
  if (!orderExpiryActive(cfg)) return out;
  out.configured = true;

  const cutoff = new Date(new Date(nowIso).getTime() - cfg.ttl_minutes * 60_000).toISOString();
  const { results } = await env.DB.prepare(CANDIDATES)
    .bind(cutoff, cfg.batch_limit)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  out.scanned = rows.length;

  for (const order of rows) {
    const id = String(order.id);
    try {
      // Planned per order (reads only), executed in that order's own batch —
      // one order's problem never takes another order's release with it.
      // NULL actor, not the string 'system': `inventory_ledger.actor_user_id`
      // is a foreign key to `users`, and no such user exists. The column is
      // nullable precisely for a write nobody made.
      const stock = await planOrderReturn(env.DB, id, null);
      const res = await env.DB.batch([
        env.DB.prepare(
          `UPDATE orders SET status = 'cancelled', updated_at = ?1
            WHERE id = ?2 AND status = 'pending' AND stage = 'received'`
        ).bind(nowIso, id),
        ...(stock.plan?.statements ?? []),
        ...cancelledOrderRefundStatements(env, order, 'system', nowIso),
        // In the SAME batch: a history row written after the batch could be
        // lost to a crash, leaving a cancellation nobody can explain.
        env.DB.prepare(
          `INSERT OR IGNORE INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note)
           VALUES (?1, ?2, 'cancelled', 'cancelled', 'system', ?3, 'system', ?4)`
        ).bind(
          newHistoryId(id, nowIso),
          id,
          nowIso,
          `Expired automatically after ${cfg.ttl_minutes} minutes without payment or confirmation`
        ),
      ]);
      const changes = (res[0] as unknown as { meta: { changes: number } })?.meta.changes ?? 0;
      if (changes > 0) {
        out.cancelled += 1;
        await audit(env.DB, 'system', 'order.expired', id, {
          ttl_minutes: cfg.ttl_minutes,
          released: stock.plan?.applied ?? 0,
        });
      } else {
        // The flip lost a race — the fence rolled everything back with it.
        out.skipped += 1;
      }
    } catch (e) {
      out.errors += 1;
      console.error('order expiry failed for', id, e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}
