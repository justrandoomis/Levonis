/**
 * Permanent removal for cancelled, never-fulfilled orders.
 *
 * D1 does not guarantee that foreign-key cascades are enabled, so every owned
 * row is removed explicitly. Accounting/support rows that still make sense on
 * their own are preserved and only lose their live order pointer. A delivered
 * or serialized order is deliberately refused: deleting a customer's device
 * identity or warranty history is not database housekeeping.
 */

import { revokeOrderProductFileGrantStatements } from './fileOwnership';

export const CANCELLED_ORDER_RETENTION_DAYS = 7;
export const CANCELLED_ORDER_SWEEP_LIMIT = 5;

export interface OrderDeletionDb {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface OrderDeletionResult {
  order_id: string;
  deleted: boolean;
  already_deleted: boolean;
  rows_deleted_by_table: Record<string, number>;
  rows_unlinked_by_table: Record<string, number>;
}

export class OrderDeletionRefusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OrderDeletionRefusal';
  }
}

type Owned = { table: string; where?: string };

// Children before parents. All predicates bind the order id as ?1.
export const ORDER_OWNED_TABLES: Owned[] = [
  { table: 'finance_staff_order_rules' },
  { table: 'finance_staff_basis' },
  { table: 'finance_task_assignments' },
  { table: 'finance_order_versions' },
  { table: 'finance_order_snapshots' },
  { table: 'finance_line_departments', where: 'order_item_id IN (SELECT id FROM order_items WHERE order_id=?1)' },
  { table: 'order_item_inventory_allocations' },
  { table: 'coupon_redemptions' },
  { table: 'invoices' },
  { table: 'return_cases' },
  { table: 'price_protection_claims' },
  { table: 'points_accruals' },
  { table: 'points_reservations' },
  { table: 'order_payment_settlements' },
  { table: 'support_gift_entitlements' },
  { table: 'order_status_history' },
  { table: 'order_price_adjustments' },
  { table: 'warranty_receipts' },
  { table: 'order_reservation_fence' },
  { table: 'offer_redemptions' },
  { table: 'mystery_draw_audits' },
  { table: 'mystery_allocations' },
  { table: 'order_item_units' },
  { table: 'order_items' },
];

/** Rows retained for audit, support, or customer-created content. */
export const ORDER_HISTORY_TABLES = [
  'bnpl_ledger',
  'inventory_ledger',
  'merchant_payout_ledger',
  'merchant_reviews',
  'merchant_reputation_events',
  'community_complaints',
  'policy_acceptances',
  'support_tickets',
  'reviews',
  // 0175: a gift names the order that consumed it. A cancelled order — the
  // only kind deleted — already returned its gift (trigger
  // trg_orders_gift_cancelled), so this is the belt to that brace: unlinked,
  // never deleted.
  'gift_entitlements',
  'chats',
  // 0177: a serial's preparation binding is the DEVICE's history (released
  // 'order_cancelled' by trg_orders_serial_assignments_cancelled before any
  // cancelled order reaches here). Unlinked — order_id and order_item_id
  // cleared, `order_ref` keeps the ORD- id for the timeline — never deleted.
  'serial_assignments',
] as const;

async function columnsOf(db: OrderDeletionDb, table: string): Promise<Set<string>> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return new Set();
  const rows = await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
  return new Set((rows.results ?? []).map((row) => String(row.name)));
}

type Protection = { code: string; message: string; query: string };
type DeletionSchema = { columns: Map<string, Set<string>>; protections: Protection[] };
const financialTables = ['finance_order_costs','finance_order_adjustments','finance_workspace_postings','finance_order_calculations',
  'finance_collections','finance_refund_facts','investor_finance_events','finance_investor_earnings','finance_expense_links'] as const;
const itemEvidenceTables = ['stock_serial_links','stock_return_inspections','trade_in_claims'] as const;
const allocationEvidenceTables = ['investor_finance_events','investor_allocation_results','lot_cost_adjustment_shares','stock_return_lot_evidence'] as const;

/** One schema read set per sweep; absent newer tables are not assumed empty
 * after they have been observed. The same predicates select candidates and
 * fence the final batch, including when SQLite FK enforcement is unavailable. */
async function deletionSchema(db: OrderDeletionDb): Promise<DeletionSchema> {
  const names = new Set(['orders','order_item_units','ops_guards','warranty_claims','wallet_transactions','wallet_holds','serial_assignments',
    'product_file_grants','trade_in_requests','finance_posting_errors',...financialTables,...itemEvidenceTables,...allocationEvidenceTables,
    ...ORDER_HISTORY_TABLES,...ORDER_OWNED_TABLES.map(t=>t.table)]);
  const columns = new Map<string, Set<string>>();
  for (const name of names) columns.set(name, await columnsOf(db, name));
  const protections: Protection[] = [];
  const add = (table: string, column: string, code: string, message: string, query: string) => {
    if (columns.get(table)?.has(column)) protections.push({ code, message, query });
  };
  for (const table of financialTables) add(table,'order_id','ORDER_HAS_FINANCIAL_HISTORY',
    'Linked accounting, wages, collections, refunds or investor history must be retained.',`SELECT 1 FROM ${table} WHERE order_id=?1`);
  for (const table of itemEvidenceTables) add(table,'order_item_id','ORDER_HAS_FULFILMENT_HISTORY',
    'Serial, return inspection or trade-in evidence must be retained.',`SELECT 1 FROM ${table} WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=?1)`);
  add('trade_in_requests','order_id','ORDER_HAS_FULFILMENT_HISTORY','Trade-in evidence must be retained.',
    'SELECT 1 FROM trade_in_requests WHERE order_id=?1');
  // 0177: a LIVE serial binding means a device is still promised by this
  // order. The cancel trigger releases them all, so this is the second guard.
  add('serial_assignments','order_id','ORDER_HAS_FULFILMENT_HISTORY','A serial is still bound to this order.',
    'SELECT 1 FROM serial_assignments WHERE order_id=?1 AND released_at IS NULL');
  for (const table of allocationEvidenceTables) add(table,'allocation_id','ORDER_HAS_FINANCIAL_HISTORY',
    'Stock allocation evidence is linked to investor, cost or return history.',
    `SELECT 1 FROM ${table} WHERE allocation_id IN (SELECT id FROM order_item_inventory_allocations WHERE order_id=?1)`);
  add('finance_posting_errors','order_id','ORDER_FINANCIAL_RECONCILIATION_PENDING','A financial posting still requires reconciliation.',
    'SELECT 1 FROM finance_posting_errors WHERE order_id=?1');
  add('order_payment_settlements','order_id','ORDER_HAS_FINANCIAL_HISTORY','A recorded payment settlement must be retained.',
    'SELECT 1 FROM order_payment_settlements WHERE order_id=?1 AND amount_iqd>0');
  add('points_accruals','order_id','ORDER_HAS_FINANCIAL_HISTORY','Released rewards must retain their earning and reversal evidence.',
    "SELECT 1 FROM points_accruals WHERE order_id=?1 AND (state='released' OR wallet_tx_id IS NOT NULL)");
  add('points_reservations','order_id','ORDER_REFUND_PENDING','Committed redeemed points have not been refunded.',
    "SELECT 1 FROM points_reservations WHERE order_id=?1 AND state='committed'");
  add('order_item_inventory_allocations','order_id','ORDER_STOCK_PENDING','Consumed stock has not been fully restored.',
    'SELECT 1 FROM order_item_inventory_allocations WHERE order_id=?1 GROUP BY order_item_id,lot_id HAVING SUM(CASE WHEN released_at IS NULL THEN qty ELSE -qty END)<>0');
  add('inventory_ledger','order_id','ORDER_STOCK_PENDING','A stock reservation or deduction has not been released.',
    `SELECT 1 FROM inventory_ledger WHERE order_id=?1 GROUP BY product_id,scope,scope_id HAVING
      SUM(CASE WHEN kind='reserve' THEN qty WHEN kind IN ('release','deduct') THEN -qty ELSE 0 END)>0
      OR SUM(CASE WHEN kind='deduct' THEN qty WHEN kind='restore' THEN -qty ELSE 0 END)>0`);
  if (columns.get('orders')?.has('wallet_applied_usd_cents')) protections.push({code:'ORDER_REFUND_PENDING',message:'The cancelled wallet payment has not been refunded.',
    query:`SELECT 1 FROM orders o WHERE o.id=?1 AND o.wallet_applied_usd_cents>0 AND NOT EXISTS(SELECT 1 FROM wallet_transactions t
      WHERE t.id='wtx_refund_'||o.id||'_usd' AND t.user_id=o.user_id AND t.currency='USD' AND t.type='deposit' AND t.status='approved' AND t.amount>=o.wallet_applied_usd_cents)`});
  if (columns.get('orders')?.has('points_discount_iqd')) protections.push({code:'ORDER_REFUND_PENDING',message:'The cancelled points payment has not been refunded.',
    query:`SELECT 1 FROM orders o WHERE o.id=?1 AND o.points_discount_iqd>0 AND NOT EXISTS(SELECT 1 FROM wallet_transactions t
      WHERE t.id='wtx_refund_'||o.id||'_pts' AND t.user_id=o.user_id AND t.currency='POINT' AND t.type='deposit' AND t.status='approved' AND t.amount>=o.points_discount_iqd)`});
  if (columns.get('orders')?.has('gini_paid_iqd')) protections.push({code:'ORDER_HAS_FINANCIAL_HISTORY',message:'An external payment receipt must be retained.',
    query:"SELECT 1 FROM orders WHERE id=?1 AND (gini_paid_iqd>0 OR gini_state='received')"});
  add('wallet_holds','ref_id','ORDER_REFUND_PENDING','An active wallet hold must be released before deletion.',
    `SELECT 1 FROM wallet_holds h JOIN orders o ON o.id=?1 WHERE h.state='active' AND (
      (h.ref_type='order' AND h.ref_id=o.id) OR (h.ref_type='store_order' AND h.ref_id=o.user_id||':'||o.idempotency_key))`);
  return { columns, protections };
}

const protectionCondition = (schema: DeletionSchema, idSql: string) => schema.protections
  .map(p=>`NOT EXISTS(${p.query.replaceAll('?1',idSql)})`).join(' AND ') || '1';

function changesOf(result: D1Result<unknown>): number {
  return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

export async function deleteCancelledOrder(
  db: OrderDeletionDb,
  orderId: string,
  opts: { cutoff?: string; schema?: DeletionSchema } = {}
): Promise<OrderDeletionResult> {
  const schema = opts.schema ?? await deletionSchema(db);
  const row = await db
    .prepare('SELECT * FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ id: string; status: string; delivered_at: string | null; cancelled_at?: string | null; updated_at: string; created_at: string }>();

  if (!row) {
    return {
      order_id: orderId,
      deleted: false,
      already_deleted: true,
      rows_deleted_by_table: {},
      rows_unlinked_by_table: {},
    };
  }
  if (row.status !== 'cancelled') {
    throw new OrderDeletionRefusal('ORDER_NOT_CANCELLED', 'Only a cancelled order can be permanently deleted.');
  }

  const units = await db
    .prepare('SELECT COUNT(*) AS n FROM order_item_units WHERE order_id = ?')
    .bind(orderId)
    .first<{ n: number }>()
    .catch(() => ({ n: 0 }));
  if (row.delivered_at || Number(units?.n ?? 0) > 0) {
    throw new OrderDeletionRefusal(
      'ORDER_HAS_FULFILMENT_HISTORY',
      'This order has delivered or serialized units and must remain for warranty and device history.'
    );
  }
  if (schema.protections.length) {
    const protectedRows = await db.prepare(`SELECT ${schema.protections.map((p,i)=>`EXISTS(${p.query}) AS p${i}`).join(',')}`)
      .bind(orderId).first<Record<string, number>>();
    const blocked = schema.protections.find((_p,i)=>protectedRows?.[`p${i}`]);
    if (blocked) throw new OrderDeletionRefusal(blocked.code, blocked.message);
  }
  const timestamp = schema.columns.get('orders')?.has('cancelled_at') ? 'cancelled_at' : 'updated_at';
  const clock = timestamp==='cancelled_at' ? row.cancelled_at ?? null : row.updated_at;
  if (opts.cutoff && new Date(clock ?? row.updated_at ?? row.created_at).getTime()>new Date(opts.cutoff).getTime())
    throw new OrderDeletionRefusal('ORDER_RETENTION_NOT_REACHED','Seven full days have not elapsed since cancellation.');

  const statements: D1PreparedStatement[] = [];
  const ledger: Array<{ kind: 'delete' | 'unlink' | 'guard'; table: string }> = [];
  // A reopened/re-cancelled order or new money/stock evidence invalidates the
  // whole batch before a child is removed, even with foreign keys disabled.
  const effectiveClock = schema.columns.get('orders')?.has('cancelled_at') ? 'cancelled_at' : 'COALESCE(updated_at,created_at)';
  const safety = `status='cancelled' AND delivered_at IS NULL AND ${timestamp} IS ?2
    AND NOT EXISTS(SELECT 1 FROM order_item_units WHERE order_id=?1) AND ${protectionCondition(schema,'?1')}
    ${opts.cutoff ? `AND julianday(${effectiveClock})<=julianday(?3)` : ''}`;
  statements.push(db.prepare(`UPDATE orders SET status=CASE WHEN ${safety} THEN status ELSE NULL END WHERE id=?1`)
    .bind(orderId,clock,...(opts.cutoff?[opts.cutoff]:[])));
  ledger.push({kind:'guard',table:'orders'});
  if (schema.columns.get('ops_guards')?.has('id')) {
    statements.push(db.prepare("INSERT INTO ops_guards(id,ok) VALUES ('cancelled-order-delete:'||?,1)").bind(orderId));
    ledger.push({kind:'guard',table:'ops_guards'});
  }

  if (schema.columns.get('product_file_grants')?.has('order_id')) {
    statements.push(...revokeOrderProductFileGrantStatements(db as D1Database,orderId,{sql:"EXISTS(SELECT 1 FROM orders WHERE id=?1 AND status='cancelled')",binds:[]}));
    ledger.push({kind:'unlink',table:'product_file_grants'},{kind:'delete',table:'product_file_grants'});
  }

  for (const table of ORDER_HISTORY_TABLES) {
    const columns = schema.columns.get(table)!;
    if (!columns.has('order_id')) continue;
    const clears = ['"order_id" = NULL'];
    let where = '"order_id" = ?1';
    if ((table === 'reviews' || table === 'gift_entitlements' || table === 'serial_assignments') && columns.has('order_item_id')) {
      clears.push('"order_item_id" = NULL');
      where += ' OR "order_item_id" IN (SELECT id FROM order_items WHERE order_id = ?1)';
    }
    if (table === 'support_tickets' && columns.has('unit_id')) {
      clears.push('"unit_id" = NULL');
      where += ' OR "unit_id" IN (SELECT id FROM order_item_units WHERE order_id = ?1)';
    }
    statements.push(db.prepare(`UPDATE "${table}" SET ${clears.join(', ')} WHERE ${where}`).bind(orderId));
    ledger.push({ kind: 'unlink', table });
  }

  // Warranty claims may point at an item without carrying order_id itself.
  const warrantyClaimColumns = schema.columns.get('warranty_claims')!;
  if (warrantyClaimColumns.has('order_item_id')) {
    const clears = ['"order_item_id" = NULL'];
    if (warrantyClaimColumns.has('unit_id')) clears.push('"unit_id" = NULL');
    statements.push(
      db
        .prepare(
          `UPDATE warranty_claims SET ${clears.join(', ')}
            WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?1)`
        )
        .bind(orderId)
    );
    ledger.push({ kind: 'unlink', table: 'warranty_claims' });
  }

  for (const owned of ORDER_OWNED_TABLES) {
    const columns = schema.columns.get(owned.table)!;
    if (!columns.has(owned.where?'order_item_id':'order_id')) continue;
    statements.push(db.prepare(`DELETE FROM "${owned.table}" WHERE ${owned.where ?? '"order_id" = ?1'}`).bind(orderId));
    ledger.push({ kind: 'delete', table: owned.table });
  }
  statements.push(db.prepare('DELETE FROM orders WHERE id = ?1').bind(orderId));
  ledger.push({ kind: 'delete', table: 'orders' });
  if (schema.columns.get('ops_guards')?.has('id')) {
    statements.push(db.prepare("DELETE FROM ops_guards WHERE id='cancelled-order-delete:'||?").bind(orderId));
    ledger.push({kind:'guard',table:'ops_guards'});
  }

  let results: D1Result<unknown>[];
  try { results = await db.batch(statements); }
  catch (error) {
    if (/NOT NULL constraint failed: orders.status/.test(String(error)))
      throw new OrderDeletionRefusal('ORDER_CHANGED','The order or its financial, stock or cancellation evidence changed before deletion.');
    throw error;
  }
  const deleted: Record<string, number> = {};
  const unlinked: Record<string, number> = {};
  results.forEach((result, index) => {
    const entry = ledger[index];
    if (!entry || entry.kind==='guard') return;
    const target = entry.kind === 'delete' ? deleted : unlinked;
    target[entry.table] = (target[entry.table] ?? 0) + changesOf(result);
  });

  return {
    order_id: orderId,
    deleted: (deleted.orders ?? 0) > 0,
    already_deleted: false,
    rows_deleted_by_table: deleted,
    rows_unlinked_by_table: unlinked,
  };
}

export interface CancelledOrderSweepReport {
  retention_days: number;
  scanned: number;
  deleted: number;
  skipped: number;
  errors: number;
}

export async function sweepCancelledOrders(
  db: OrderDeletionDb,
  nowIso: string,
  retentionDays = CANCELLED_ORDER_RETENTION_DAYS,
  limit = CANCELLED_ORDER_SWEEP_LIMIT
): Promise<CancelledOrderSweepReport> {
  const report: CancelledOrderSweepReport = { retention_days: retentionDays, scanned: 0, deleted: 0, skipped: 0, errors: 0 };
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(CANCELLED_ORDER_SWEEP_LIMIT, Math.floor(limit))) : CANCELLED_ORDER_SWEEP_LIMIT;
  const cutoff = new Date(new Date(nowIso).getTime() - retentionDays * 86_400_000).toISOString();
  const schema = await deletionSchema(db), columns = schema.columns.get('orders')!;
  const cancelledAt = columns.has('cancelled_at') ? 'candidate_order.cancelled_at' : 'COALESCE(candidate_order.updated_at,candidate_order.created_at)';
  const rows = await db
    .prepare(
      `SELECT candidate_order.id FROM orders candidate_order
        WHERE candidate_order.status = 'cancelled'
          AND candidate_order.delivered_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM order_item_units WHERE order_id=candidate_order.id)
          AND ${protectionCondition(schema,'candidate_order.id')}
          AND julianday(${cancelledAt}) <= julianday(?)
        ORDER BY ${cancelledAt},candidate_order.id
        LIMIT ?`
    )
    .bind(cutoff, boundedLimit)
    .all<{ id: string }>();

  report.scanned = rows.results?.length ?? 0;
  for (const row of rows.results ?? []) {
    try {
      const result = await deleteCancelledOrder(db, String(row.id), {cutoff,schema});
      if (result.deleted || result.already_deleted) report.deleted += 1;
      else report.skipped += 1;
    } catch (error) {
      if (error instanceof OrderDeletionRefusal) report.skipped += 1;
      else report.errors += 1;
    }
  }
  return report;
}
