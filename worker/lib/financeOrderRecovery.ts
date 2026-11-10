import type { Env } from './types';
import { baghdadDay, periodOpen } from './operations';
import { recordFinancialFailure, runOrderFinancialEffects } from './orderFinance';
import { staffBasisFingerprintSql } from './financeParticipants';
import { reconcileFinanceOrder } from './financeReconcile';
import { investorLostDeliveryPendingSql, investorOrderProjectionStaleSql } from './investorFinance';
import { membershipDiscountAtLineSql } from './orderMembership';
import { settledCostSql, settledThroughSql, settlementInstalled } from './staffSettledSql';

// An internal checkpoint, deliberately absent from SETTING_KEYS and
// PUBLIC_SETTING_KEYS. No customer or admin setting API exposes this value.
const CHECKPOINT = '__finance_order_recovery_v1';
const LEASE_MS = 120_000;
// Full delivery replays perform hundreds of source/fence reads. Two leave
// room for multi-line orders inside the Worker's per-invocation D1 budget.
const MAX_ORDERS = 2;

interface Checkpoint { cursor: string; owner: string | null; lease_until: number }
export interface OrderFinanceRecoveryReport {
  schema_ready: boolean;
  locked: boolean;
  scanned: number;
  completed: number;
  pending: number;
  failed: number;
  errors: Array<{ order_id: string; message: string }>;
}

// A completed employee job is not evidence that every wage was calculable.
// Keep these order candidates independent of that job's cursor/revision. The
// shared basis fingerprint also finds legacy percentages and source writes
// interrupted before they could record a failure. Reuse the exact payable
// guard's inputs instead of inventing a second definition of a fresh wage.
// A missing first checkpoint has no cost row to inspect, even when there is
// no investor. Replaying it also records a checkpoint when no wage applies.
// Genuine unknown costs remain candidates, but the rotating cursor prevents
// them from starving later orders. Refund posting has its own writer and is
// intentionally not claimed by this delivery repair.
const deliveredCandidateSql = (settled: boolean) => `o.seller_type='levonis' AND o.status='delivered' AND o.delivered_at IS NOT NULL AND (
  (EXISTS(SELECT 1 FROM order_items oi WHERE oi.order_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM finance_staff_basis b WHERE b.order_id=o.id))
  OR
  EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.order_id=o.id AND c.staff_id IS NOT NULL AND c.state<>'reversed' AND NOT ${settledCostSql('c.id', settled)} AND (
    c.state='pending_cost' OR EXISTS(SELECT 1 FROM finance_wage_targets t WHERE t.cost_id=c.id AND t.amount_iqd IS NULL)
    OR (COALESCE((SELECT basis FROM finance_wage_targets t WHERE t.cost_id=c.id),CASE WHEN json_valid(c.snapshot) THEN json_extract(c.snapshot,'$.rule.basis') END) IN ('profit_percent','revenue_percent')
      AND NOT EXISTS(SELECT 1 FROM finance_staff_basis b WHERE b.order_id=o.id AND b.basis_fingerprint=(${staffBasisFingerprintSql('o.id')}))
      AND NOT EXISTS(SELECT 1 FROM finance_cost_adjustments a WHERE a.cost_id=c.id AND a.kind='manual'))))
  OR (EXISTS(SELECT 1 FROM order_items mi WHERE mi.order_id=o.id AND mi.membership_discount_iqd>0
    AND (${membershipDiscountAtLineSql('mi')})=0)
    AND NOT EXISTS(SELECT 1 FROM finance_staff_basis b WHERE b.order_id=o.id AND b.basis_fingerprint=(${staffBasisFingerprintSql('o.id')})))
  OR ${investorOrderProjectionStaleSql('o.id')}
  OR EXISTS(SELECT 1 FROM finance_posting_errors e WHERE e.order_id=o.id AND e.event_key IN (
    'delivered:'||o.id,'cogs:'||o.id,'investor:'||o.id,'investor-pending:'||o.id,'workspace-reconciliation:'||o.id,'automatic-finance:'||o.id)))`;
// AN ORDER THAT LOST ITS DELIVERY (DECISIONS row 307). Cancelled or moved back
// after delivery, it keeps `delivered_at`, and its timeline-managed wages used
// to keep counting, held for ever. It is a candidate while such a live,
// unsettled wage is not 0 — exactly the rows reconcileEffectiveWages brings to
// 0: a rule with a wage version of this employee who is dated or whose rule was
// revised, on an order delivered on or after the employee's settled day. A wage
// an open withdrawal holds is left as it is (and an older rule's cutoff refuses
// outright), so while any of the order's unsettled wages is held the order
// waits, unselected, until that withdrawal is paid or released — instead of
// being picked every minute for a wage that cannot move.
// It is also a candidate while the investor projections its delivery wrote are
// not yet the settled zero that takes the sale back (DECISIONS row 308).
const lostDeliverySql = (settled: boolean) => `o.seller_type='levonis' AND o.status<>'delivered' AND o.delivered_at IS NOT NULL AND ((
  EXISTS(SELECT 1 FROM finance_order_costs c JOIN finance_staff s ON s.id=c.staff_id
    WHERE c.order_id=o.id AND c.state<>'reversed' AND NOT ${settledCostSql('c.id', settled)}
      AND (c.amount_iqd IS NULL OR c.amount_iqd+COALESCE((SELECT SUM(a.delta_iqd) FROM finance_cost_adjustments a WHERE a.cost_id=c.id),0)<>0)
      AND EXISTS(SELECT 1 FROM finance_wage_versions v WHERE v.rule_id=c.rule_id AND v.staff_id=c.staff_id AND (s.start_work_date IS NOT NULL
        OR EXISTS(SELECT 1 FROM finance_wage_versions r WHERE r.rule_id=v.rule_id AND r.revision>1 AND r.id NOT LIKE 'wage:baseline:%')))
      AND COALESCE(date(o.delivered_at,'+3 hours')>=${settledThroughSql('s.id', settled)},1))
  AND NOT EXISTS(SELECT 1 FROM finance_order_costs hc JOIN finance_withdrawal_allocations wa ON wa.source_kind='staff' AND wa.source_id=hc.id
    JOIN finance_withdrawals w ON w.id=wa.withdrawal_id
    WHERE hc.order_id=o.id AND w.state IN ('requested','approved','part_paid') AND wa.amount_iqd>wa.paid_iqd AND NOT ${settledCostSql('hc.id', settled)}))
  OR ${investorLostDeliveryPendingSql('o.id')})`;
const candidateSql = (settled: boolean) => `((${deliveredCandidateSql(settled)}) OR (${lostDeliverySql(settled)}))`;

function checkpoint(value: string): Checkpoint {
  try {
    const parsed = JSON.parse(value) as Partial<Checkpoint>;
    return { cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '',
      owner: typeof parsed.owner === 'string' ? parsed.owner : null,
      lease_until: typeof parsed.lease_until === 'number' && Number.isFinite(parsed.lease_until) ? parsed.lease_until : 0 };
  } catch { return { cursor: '', owner: null, lease_until: 0 }; }
}

/** Automatic history/failure recovery; NEW deliveries still post synchronously
 * in runOrderDeliveredEffects. At most two orders run in one invocation.
 *
 * The CAS lease keeps cron/opportunistic drains from duplicating expensive
 * reads. Correctness does not depend on the lease: the existing financial
 * writers retain their source fences, unique journals and payment protection.
 * A crashed/expired owner can replay an order, but cannot checkpoint or release
 * a replacement owner's lease. Unknown facts are never promoted to known.
 */
export async function drainOrderFinanceRecovery(env: Env, opts: { maxOrders?: number } = {}): Promise<OrderFinanceRecoveryReport> {
  const db = env.DB;
  const report: OrderFinanceRecoveryReport = { schema_ready: false, locked: false, scanned: 0, completed: 0, pending: 0, failed: 0, errors: [] };
  const schema = await db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN (
    'admin_settings','finance_order_costs','finance_wage_targets','finance_staff_basis','finance_cost_adjustments',
    'finance_posting_errors','finance_wage_versions','lot_cost_adjustment_shares','investor_allocation_results')`).first<{ n: number }>();
  if (schema?.n !== 9) return report;
  report.schema_ready = true;
  const initial: Checkpoint = { cursor: '', owner: null, lease_until: 0 };
  await db.prepare('INSERT INTO admin_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').bind(CHECKPOINT, JSON.stringify(initial)).run();
  const previous = (await db.prepare('SELECT value FROM admin_settings WHERE key=?').bind(CHECKPOINT).first<{ value: string }>())!;
  let state = checkpoint(previous.value);
  if (state.owner && state.lease_until > Date.now()) { report.locked = true; return report; }
  const owner = crypto.randomUUID();
  state = { ...state, owner, lease_until: Date.now() + LEASE_MS };
  let ownedValue = JSON.stringify(state);
  const claim = await db.prepare('UPDATE admin_settings SET value=? WHERE key=? AND value=?').bind(ownedValue, CHECKPOINT, previous.value).run();
  if (!claim.meta.changes) { report.locked = true; return report; }
  const update = async (next: Checkpoint): Promise<boolean> => {
    const serialized = JSON.stringify(next);
    const saved = await db.prepare('UPDATE admin_settings SET value=? WHERE key=? AND value=?').bind(serialized, CHECKPOINT, ownedValue).run();
    if (!saved.meta.changes) return false;
    state = next; ownedValue = serialized; return true;
  };
  const requested = opts.maxOrders ?? MAX_ORDERS;
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_ORDERS, Math.floor(requested))) : MAX_ORDERS;
  // A settled wage row is final (DECISIONS row 306): it is never a reason to replay its order.
  const candidate = candidateSql(await settlementInstalled(db));
  const select = () => db.prepare(`SELECT o.id,o.status FROM orders o WHERE o.id>? AND ${candidate} ORDER BY o.id LIMIT ?`).bind(state.cursor, limit).all<{ id: string; status: string }>();
  try {
    let orders = (await select()).results ?? [];
    if (!orders.length && state.cursor) {
      if (!await update({ ...state, cursor: '', lease_until: Date.now() + LEASE_MS })) return report;
      orders = (await select()).results ?? [];
    }
    for (const order of orders) {
      if (!await update({ ...state, lease_until: Date.now() + LEASE_MS })) break;
      report.scanned++;
      let writerStarted = false;
      try {
        // Historical corrections belong to today's open posting period while
        // the wage calculator still selects rules using the real delivery day.
        const day = baghdadDay();
        await periodOpen(db, day);
        writerStarted = true;
        // An order that lost its delivery has no sale to post: it gets the
        // reconciliation every recalculation runs, which brings its wages to 0
        // (DECISIONS row 307) and, done, clears the order's stale `investor:`
        // marker; a failed one is recorded there and fails here too.
        if (order.status === 'delivered') await runOrderFinancialEffects(env, order.id, 'delivered', day);
        else {
          const done = await reconcileFinanceOrder(db, order.id, { day });
          if (!done.complete && !done.pending) {
            const failure = await db.prepare('SELECT message FROM finance_posting_errors WHERE event_key=?').bind(`investor:${order.id}`).first<{ message: string }>();
            throw new Error(failure?.message || 'تعذر تصفير أجور طلب لم يعد مُسلَّمًا');
          }
        }
        // These markers describe the same full reconciliation just completed.
        // COGS/unknown/refund failures are owned by their original writers.
        await db.prepare('DELETE FROM finance_posting_errors WHERE order_id=? AND event_key IN (?,?)')
          .bind(order.id, `automatic-finance:${order.id}`, `workspace-reconciliation:${order.id}`).run();
        const remaining = await db.prepare(`SELECT 1 FROM orders o WHERE o.id=? AND ${candidate}`).bind(order.id).first();
        if (remaining) report.pending++; else report.completed++;
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 500);
        report.failed++; report.errors.push({ order_id: order.id, message });
        // A replay failure needs a durable retry signal. A rejected preflight
        // made no financial changes, however: adding a generic failure then
        // would freeze an otherwise valid fixed wage merely because an
        // unrelated unknown COGS item met a closed accounting period. Its
        // original candidate remains durable and the cursor still advances.
        if (writerStarted) await recordFinancialFailure(db, order.id, 'automatic-finance', error);
      }
      if (!await update({ ...state, cursor: order.id, lease_until: Date.now() + LEASE_MS })) break;
    }
  } finally {
    await update({ ...state, owner: null, lease_until: 0 });
  }
  return report;
}
