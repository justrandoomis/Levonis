import type { Env } from './types';
import { baghdadDay, periodOpen } from './operations';
import { recordFinancialFailure, runOrderFinancialEffects } from './orderFinance';
import { staffBasisFingerprintSql } from './financeParticipants';

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
// The shared basis fingerprint also finds legacy percentages and source writes
// interrupted before they could record a failure. Reuse the exact payable
// guard's inputs instead of inventing a second definition of a fresh wage.
// Genuine unknown costs remain candidates, but the rotating cursor prevents
// them from starving later orders. Refund posting has its own writer and is
// intentionally not claimed by this delivery-only repair.
const candidate = `o.seller_type='levonis' AND o.status='delivered' AND o.delivered_at IS NOT NULL AND (
  EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.order_id=o.id AND c.staff_id IS NOT NULL AND c.state<>'reversed' AND (
    c.state='pending_cost' OR EXISTS(SELECT 1 FROM finance_wage_targets t WHERE t.cost_id=c.id AND t.amount_iqd IS NULL)
    OR (COALESCE((SELECT basis FROM finance_wage_targets t WHERE t.cost_id=c.id),CASE WHEN json_valid(c.snapshot) THEN json_extract(c.snapshot,'$.rule.basis') END) IN ('profit_percent','revenue_percent')
      AND NOT EXISTS(SELECT 1 FROM finance_staff_basis b WHERE b.order_id=o.id AND b.basis_fingerprint=(${staffBasisFingerprintSql('o.id')}))
      AND NOT EXISTS(SELECT 1 FROM finance_cost_adjustments a WHERE a.cost_id=c.id AND a.kind='manual'))))
  OR EXISTS(SELECT 1 FROM finance_posting_errors e WHERE e.order_id=o.id AND e.event_key IN (
    'delivered:'||o.id,'cogs:'||o.id,'investor:'||o.id,'workspace-reconciliation:'||o.id,'automatic-finance:'||o.id)))`;

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
    'finance_posting_errors','finance_wage_versions','lot_cost_adjustment_shares')`).first<{ n: number }>();
  if (schema?.n !== 8) return report;
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
  const select = () => db.prepare(`SELECT o.id FROM orders o WHERE o.id>? AND ${candidate} ORDER BY o.id LIMIT ?`).bind(state.cursor, limit).all<{ id: string }>();
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
        await runOrderFinancialEffects(env, order.id, 'delivered', day);
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
