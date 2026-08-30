/**
 * Order → stock lifecycle — mandate §7: "الحجز عند إنشاء الطلب والخصم عند
 * تأكيده والإرجاع عند الإلغاء يجب أن يكون transactional وidempotent لمنع
 * overselling والخصم المكرر".
 *
 *   order created    reserve   units are HELD: stock is unchanged, available
 *                              (= stock − reserved) drops, so nobody else can
 *                              buy them
 *   order confirmed  deduct    the hold becomes a real decrement
 *   order cancelled  release   when it was never deducted
 *                    restore   when it had been
 *
 * WHY THE LEDGER IS THE SOURCE FOR THE LATER STEPS. Confirmation happens
 * minutes or days after checkout, and by then the admin may have changed the
 * product's inventory_mode, renamed a colour, or removed an option. Recomputing
 * the targets from the product's CURRENT shape could deduct from a different
 * row than the one that was reserved, stranding the reservation forever. So
 * the reserve rows written at checkout — which record product, scope, scope_id
 * and quantity exactly — are replayed instead. What was held is what is
 * deducted, and what was deducted is what comes back.
 *
 * Every step is idempotent through the same UNIQUE idempotency_key, so a
 * double-clicked confirmation, a replayed webhook or a retried cancellation
 * moves nothing a second time.
 */

import { applyInventory, planInventory, type InventoryPlan, type StockMove } from './inventory';

interface LedgerRow {
  product_id: string;
  scope: string;
  scope_id: string;
  qty: number;
  idempotency_key: string;
}

/** Reconstructs the moves recorded for one order under a given ledger kind. */
async function movesFor(db: D1Database, orderId: string, kind: string): Promise<StockMove[]> {
  const { results } = await db
    .prepare(
      `SELECT product_id, scope, scope_id, qty, idempotency_key
         FROM inventory_ledger WHERE order_id = ? AND kind = ?`
    )
    .bind(orderId, kind)
    .all<LedgerRow>();

  return results.map((r) => ({
    product_id: r.product_id,
    qty: r.qty,
    // The key is `<kind>:<operationId>:<lineId>:<scope>:<scopeId>`; the line id
    // is what keeps a two-line order with the same product from collapsing
    // into one movement.
    line_id: r.idempotency_key.split(':')[2] ?? r.product_id,
    targets: [
      {
        scope: r.scope as StockMove['targets'][number]['scope'],
        scope_id: r.scope_id,
        stock: 0,
        reserved: 0,
        low_stock_threshold: null,
        label: r.scope_id || 'base',
      },
    ],
  }));
}

export async function hasLedgerKind(db: D1Database, orderId: string, kind: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS x FROM inventory_ledger WHERE order_id = ? AND kind = ? LIMIT 1')
    .bind(orderId, kind)
    .first<{ x: number }>();
  return !!row;
}

/**
 * Plans the deduction for a confirmed order, for a caller that wants it inside
 * its own transaction. Returns null when the order reserved nothing.
 */
export async function planOrderDeduction(
  db: D1Database,
  orderId: string,
  actorUserId: string | null
): Promise<InventoryPlan | null> {
  const moves = await movesFor(db, orderId, 'reserve');
  if (moves.length === 0) return null;
  return planInventory(db, moves, {
    kind: 'deduct',
    operationId: orderId,
    orderId,
    actorUserId,
    reason: 'order confirmed',
  });
}

/** Deducts the units an order is holding. Idempotent. */
export async function deductOrderStock(
  db: D1Database,
  orderId: string,
  actorUserId: string | null
): Promise<{ applied: number; rejected: number }> {
  const moves = await movesFor(db, orderId, 'reserve');
  if (moves.length === 0) return { applied: 0, rejected: 0 };
  const res = await applyInventory(db, moves, {
    kind: 'deduct',
    operationId: orderId,
    orderId,
    actorUserId,
    reason: 'order confirmed',
  });
  return { applied: res.applied, rejected: res.rejected.length };
}

/**
 * Puts an order's units back. Chooses release or restore from what the ledger
 * actually records, so a cancellation before confirmation frees the hold while
 * one after it adds the units back to stock — never both, never the wrong one.
 */
export async function returnOrderStock(
  db: D1Database,
  orderId: string,
  actorUserId: string | null
): Promise<{ kind: 'release' | 'restore' | 'none'; applied: number }> {
  const deducted = await hasLedgerKind(db, orderId, 'deduct');
  const moves = await movesFor(db, orderId, 'reserve');
  if (moves.length === 0) return { kind: 'none', applied: 0 };
  const kind = deducted ? ('restore' as const) : ('release' as const);
  const res = await applyInventory(db, moves, {
    kind,
    operationId: orderId,
    orderId,
    actorUserId,
    reason: 'order cancelled',
  });
  return { kind, applied: res.applied };
}
