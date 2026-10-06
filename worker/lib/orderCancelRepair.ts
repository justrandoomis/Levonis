import type { Env } from './types';
import { cancelledOrderRefundStatements } from './orderCancelOps';
import { auditStatements } from './audit';

export interface CancelledRefundRepairReport {
  scanned: number;
  repaired: number;
  skipped: number;
  errors: number;
}

// The old stage cancellation changed status and returned stock but never
// called the wallet refund operation. Repair only amounts testified by the
// approved ledger, never cash/Gini promises or an order total. Existing
// returns, unrelated credits and delivered orders need their own workflow.
// These predicates are repeated inside the write transaction, not just used
// to select candidates before a competing cancellation/reopening can run.
const ELIGIBLE = `o.status='cancelled' AND COALESCE(o.seller_type,'platform')<>'merchant'
  AND NULLIF(o.delivered_at,'') IS NULL AND o.gini_paid_iqd=0
  AND NOT EXISTS(SELECT 1 FROM return_cases r WHERE r.order_id=o.id)
  AND NOT EXISTS(SELECT 1 FROM wallet_transactions t WHERE t.ref=o.id AND t.user_id=o.user_id
    AND t.type='deposit' AND t.status='approved'
    AND t.id NOT IN ('wtx_refund_'||o.id||'_usd','wtx_refund_'||o.id||'_pts'))
  AND (o.wallet_applied_usd_cents=0 OR o.wallet_applied_usd_cents =
    (SELECT COALESCE(SUM(t.amount),0) FROM wallet_transactions t WHERE t.ref=o.id
      AND t.user_id=o.user_id AND t.type='withdrawal' AND t.currency='USD' AND t.status='approved')
    - (SELECT COALESCE(SUM(CASE WHEN t.type='deposit' THEN t.amount ELSE -t.amount END),0)
      FROM wallet_transactions t WHERE t.ref='order-price:'||o.id
        AND t.user_id=o.user_id AND t.currency='USD' AND t.status='approved'))
  AND (o.points_discount_iqd=0 OR o.points_discount_iqd =
    (SELECT COALESCE(SUM(t.amount),0) FROM wallet_transactions t WHERE t.ref=o.id
      AND t.user_id=o.user_id AND t.type='withdrawal' AND t.currency='POINT' AND t.status='approved'))
  AND ((o.wallet_applied_usd_cents>0 AND NOT EXISTS(SELECT 1 FROM wallet_transactions t
      WHERE t.id='wtx_refund_'||o.id||'_usd'))
    OR (o.points_discount_iqd>0 AND NOT EXISTS(SELECT 1 FROM wallet_transactions t
      WHERE t.id='wtx_refund_'||o.id||'_pts')))`;

/** Bounded, retry-safe historical recovery; new cancellations refund inline. */
export async function repairCancelledOrderRefunds(
  env: Env, nowIso = new Date().toISOString(), limit = 30,
): Promise<CancelledRefundRepairReport> {
  const report: CancelledRefundRepairReport = { scanned: 0, repaired: 0, skipped: 0, errors: 0 };
  const orders = await env.DB.prepare(
    `SELECT o.* FROM orders o WHERE ${ELIGIBLE} ORDER BY o.updated_at,o.id LIMIT ?`
  ).bind(Math.min(100, Math.max(1, Math.trunc(limit) || 30))).all<Record<string, unknown>>();
  for (const order of orders.results ?? []) {
    report.scanned++;
    const id = String(order.id);
    try {
      const audit = await auditStatements(env.DB, null, 'order.cancel_refund_repaired', id, {
        reason: 'historical_stage_cancellation',
        refund_usd_cents: Number(order.wallet_applied_usd_cents) || 0,
        refund_points: Number(order.points_discount_iqd) || 0,
      });
      await env.DB.batch([
        env.DB.prepare(`UPDATE orders SET status=CASE WHEN EXISTS(
          SELECT 1 FROM orders o WHERE o.id=?1 AND ${ELIGIBLE}
            AND o.wallet_applied_usd_cents=?2 AND o.points_discount_iqd=?3 AND o.user_id=?4
          ) THEN status ELSE NULL END WHERE id=?1`)
          .bind(id, Number(order.wallet_applied_usd_cents) || 0, Number(order.points_discount_iqd) || 0, String(order.user_id)),
        ...(await cancelledOrderRefundStatements(env, order, 'system', nowIso)),
        ...audit.statements,
      ]);
      report.repaired++;
    } catch (e) {
      // A concurrent repair or reopening is a normal lost race. A genuine
      // failure stays eligible for the next tick and is visible in the report.
      const stillEligible = await env.DB.prepare(`SELECT 1 AS ok FROM orders o WHERE o.id=? AND ${ELIGIBLE}`)
        .bind(id).first();
      if (!stillEligible) report.skipped++;
      else {
        report.errors++;
        console.error('cancelled order refund repair failed', id, e instanceof Error ? e.message : String(e));
      }
    }
  }
  return report;
}
