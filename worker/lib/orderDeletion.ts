/**
 * Permanent removal for cancelled, never-fulfilled orders.
 *
 * D1 does not guarantee that foreign-key cascades are enabled, so every owned
 * row is removed explicitly. Accounting/support rows that still make sense on
 * their own are preserved and only lose their live order pointer. A delivered
 * or serialized order is deliberately refused: deleting a customer's device
 * identity or warranty history is not database housekeeping.
 */

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
  'chats',
] as const;

async function columnsOf(db: OrderDeletionDb, table: string): Promise<Set<string>> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return new Set();
  try {
    const rows = await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
    return new Set((rows.results ?? []).map((row) => String(row.name)));
  } catch {
    return new Set();
  }
}

function changesOf(result: D1Result<unknown>): number {
  return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

export async function deleteCancelledOrder(
  db: OrderDeletionDb,
  orderId: string
): Promise<OrderDeletionResult> {
  const row = await db
    .prepare('SELECT id, status, delivered_at FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ id: string; status: string; delivered_at: string | null }>();

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

  const statements: D1PreparedStatement[] = [];
  const ledger: Array<{ kind: 'delete' | 'unlink'; table: string }> = [];

  for (const table of ORDER_HISTORY_TABLES) {
    const columns = await columnsOf(db, table);
    if (!columns.has('order_id')) continue;
    const clears = ['"order_id" = NULL'];
    let where = '"order_id" = ?1';
    if (table === 'reviews' && columns.has('order_item_id')) {
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
  const warrantyClaimColumns = await columnsOf(db, 'warranty_claims');
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
    const columns = await columnsOf(db, owned.table);
    if (!columns.has('order_id')) continue;
    statements.push(db.prepare(`DELETE FROM "${owned.table}" WHERE ${owned.where ?? '"order_id" = ?1'}`).bind(orderId));
    ledger.push({ kind: 'delete', table: owned.table });
  }
  statements.push(db.prepare('DELETE FROM orders WHERE id = ?1').bind(orderId));
  ledger.push({ kind: 'delete', table: 'orders' });

  const results = await db.batch(statements);
  const deleted: Record<string, number> = {};
  const unlinked: Record<string, number> = {};
  results.forEach((result, index) => {
    const entry = ledger[index];
    if (!entry) return;
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
  retentionDays = 30,
  limit = 100
): Promise<CancelledOrderSweepReport> {
  const report: CancelledOrderSweepReport = { retention_days: retentionDays, scanned: 0, deleted: 0, skipped: 0, errors: 0 };
  const cutoff = new Date(new Date(nowIso).getTime() - retentionDays * 86_400_000).toISOString();
  const columns = await columnsOf(db, 'orders');
  const cancelledAt = columns.has('cancelled_at') ? 'cancelled_at' : 'updated_at';
  const rows = await db
    .prepare(
      `SELECT id FROM orders
        WHERE status = 'cancelled'
          AND delivered_at IS NULL
          AND COALESCE(${cancelledAt}, updated_at, created_at) <= ?
        ORDER BY COALESCE(${cancelledAt}, updated_at, created_at)
        LIMIT ?`
    )
    .bind(cutoff, limit)
    .all<{ id: string }>();

  report.scanned = rows.results?.length ?? 0;
  for (const row of rows.results ?? []) {
    try {
      const result = await deleteCancelledOrder(db, String(row.id));
      if (result.deleted || result.already_deleted) report.deleted += 1;
      else report.skipped += 1;
    } catch (error) {
      if (error instanceof OrderDeletionRefusal) report.skipped += 1;
      else report.errors += 1;
    }
  }
  return report;
}
