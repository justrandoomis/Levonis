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

import { planInventory, planReservationFence, type InventoryPlan, type LedgerKind, type StockMove } from './inventory';

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

/**
 * The moves that put ONE returned order line's units back, reconstructed from
 * the `deduct` rows the confirmation actually wrote.
 *
 * `worker/routes/returns.ts` used to do this with
 * `UPDATE products SET stock = stock + ? WHERE id = ?`, which bypassed
 * `inventory_ledger` entirely and always credited the BASE row — already wrong
 * for every OPTION / COLOR / VARIANT_COMBINATION product, and wrong once per
 * component for a bundle. Replaying the ledger credits the row the units came
 * off, and only when they were genuinely deducted: a line that was never
 * deducted has nothing to give back, and inventing the units would be an
 * inventory forgery signed by a refund.
 *
 * `qty` is what the CASE returns, not what the line bought — a partial-qty
 * return of a multi-unit line gives back exactly what came back.
 */
export async function restoreMovesForItem(
  db: D1Database,
  orderId: string,
  orderItemId: string,
  qty: number
): Promise<StockMove[]> {
  if (qty <= 0) return [];
  const moves = await movesFor(db, orderId, 'deduct');
  return moves.filter((m) => m.line_id === orderItemId).map((m) => ({ ...m, qty }));
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
 *
 * The plan CARRIES ITS OWN FENCE ROW (§3.3), so a deduction whose guard stopped
 * holding between the plan and the commit rolls its own batch back instead of
 * committing a confirmed order over units that were never taken.
 */
export async function planOrderDeduction(
  db: D1Database,
  orderId: string,
  actorUserId: string | null
): Promise<InventoryPlan | null> {
  const moves = await movesFor(db, orderId, 'reserve');
  if (moves.length === 0) return null;
  const plan = await planInventory(db, moves, {
    kind: 'deduct',
    operationId: orderId,
    orderId,
    actorUserId,
    reason: 'order confirmed',
  });
  plan.statements.push(await planReservationFence(db, orderId, 'deduct', plan.plannedLedgerRows));
  return plan;
}

/** Deducts the units an order is holding. Idempotent. */
export async function deductOrderStock(
  db: D1Database,
  orderId: string,
  actorUserId: string | null
): Promise<{ applied: number; rejected: number }> {
  const plan = await planOrderDeduction(db, orderId, actorUserId);
  if (!plan) return { applied: 0, rejected: 0 };
  if (plan.statements.length) await db.batch(plan.statements);
  return { applied: plan.applied, rejected: plan.rejected.length };
}

/**
 * Plans the return of an order's units, for a caller that wants it inside its
 * own transaction (both cancel routes run it in the batch that flips the
 * status and refunds the money, so a cancellation that fails half-way cannot
 * hand units back on an order that is still open).
 *
 * RELEASE VERSUS RESTORE IS DECIDED PER LEDGER ROW, NOT PER ORDER. The old rule
 * asked `hasLedgerKind(order, 'deduct')` once and applied the answer to
 * everything, so a PARTIALLY deducted order — one line confirmed, another
 * rejected by its guard at confirmation time — tried to restore rows that were
 * never deducted. Every one of those fails its own guard and matches zero rows:
 * units held for ever, invisible to every screen. A row with a matching
 * `deduct` restores; a row without one releases, and an order that needs both
 * gets both, each with its own fence row.
 *
 * `plan` is null when the order reserved nothing.
 */
export interface OrderReturnPlan {
  /** 'mixed' = some rows restore and some release (a partial deduction). */
  kind: 'release' | 'restore' | 'mixed' | 'none';
  /** Every part's statements, fences included, in one appendable plan. */
  plan: InventoryPlan | null;
  parts: Array<{ kind: 'release' | 'restore'; plan: InventoryPlan }>;
}

/** Line + target identity, the granularity the release/restore choice is made at. */
const moveSig = (m: StockMove) => `${m.line_id}|${m.targets[0]?.scope ?? ''}|${m.targets[0]?.scope_id ?? ''}`;

export async function planOrderReturn(
  db: D1Database,
  orderId: string,
  actorUserId: string | null
): Promise<OrderReturnPlan> {
  const reserved = await movesFor(db, orderId, 'reserve');
  if (reserved.length === 0) return { kind: 'none', plan: null, parts: [] };
  const deducted = new Set((await movesFor(db, orderId, 'deduct')).map(moveSig));

  const split: Array<[LedgerKind & ('restore' | 'release'), StockMove[]]> = [
    ['restore', reserved.filter((m) => deducted.has(moveSig(m)))],
    ['release', reserved.filter((m) => !deducted.has(moveSig(m)))],
  ];

  const parts: OrderReturnPlan['parts'] = [];
  for (const [kind, moves] of split) {
    if (moves.length === 0) continue;
    const plan = await planInventory(db, moves, {
      kind,
      operationId: orderId,
      orderId,
      actorUserId,
      reason: 'order cancelled',
    });
    plan.statements.push(await planReservationFence(db, orderId, kind, plan.plannedLedgerRows));
    parts.push({ kind, plan });
  }
  if (parts.length === 0) return { kind: 'none', plan: null, parts: [] };

  const combined: InventoryPlan = {
    applied: parts.reduce((n, p) => n + p.plan.applied, 0),
    skipped: parts.reduce((n, p) => n + p.plan.skipped, 0),
    rejected: parts.flatMap((p) => p.plan.rejected),
    keys: parts.flatMap((p) => p.plan.keys),
    statements: parts.flatMap((p) => p.plan.statements),
    eventIds: parts.flatMap((p) => p.plan.eventIds),
    plannedLedgerRows: parts.reduce((n, p) => n + p.plan.plannedLedgerRows, 0),
  };
  return { kind: parts.length === 2 ? 'mixed' : parts[0].kind, plan: combined, parts };
}

/** Puts an order's units back in a batch of its own. Idempotent (see planOrderReturn). */
export async function returnOrderStock(
  db: D1Database,
  orderId: string,
  actorUserId: string | null
): Promise<{ kind: OrderReturnPlan['kind']; applied: number }> {
  const { kind, plan } = await planOrderReturn(db, orderId, actorUserId);
  if (!plan) return { kind: 'none', applied: 0 };
  if (plan.statements.length) await db.batch(plan.statements);
  return { kind, applied: plan.applied };
}

/**
 * The operator-facing sentence for a stock return. A partially deducted order
 * returns 'mixed', and «Stock mixedd for 3 row(s)» is not a sentence — the two
 * routes that report this share one wording instead of interpolating a verb.
 */
export function stockReturnNote(kind: OrderReturnPlan['kind'], rows: number): string | null {
  if (kind === 'none') return null;
  if (kind === 'mixed') return `Stock returned for ${rows} row(s) — some released, some restored.`;
  return `Stock ${kind}d for ${rows} row(s).`;
}
