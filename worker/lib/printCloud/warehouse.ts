/**
 * WORKSHOP STOCK — the physical material on the shelves
 * (docs/PRINT_CLOUD.md §5.3). Not the same thing as what customers own.
 *
 * Per variant, `pc_stock_positions` counts:
 *
 *   on_hand    physically in the workshop (= the sum of its stock lots)
 *   reserved   held for orders awaiting payment (`pc_stock_holds`)
 *   allocated  owned by customers, still on the shelf
 *   sellable   on_hand − reserved − allocated  (derived, never stored)
 *
 * A sale HOLDS stock inside the order's batch, followed by a fence that the
 * variant's sellable quantity is still ≥ 0 — so the same last 100 g can never
 * be held by two orders, whatever order their requests arrive in. Payment
 * converts the hold to an allocation; a print, a delivery or a waste record
 * takes it off the shelf, lot by lot (FIFO), each lot valued at its cost.
 *
 * Every physical movement is one append-only `pc_warehouse_ledger` row.
 */
import { fence, many, one, type Stmt } from './db';
import { pcError } from './errors';
import { planDraws, type LotState } from './lots';
import { iso, mulDivRound, pcId } from './util';

export type WarehouseEntryType =
  | 'receive'
  | 'hold'
  | 'hold_release'
  | 'allocate'
  | 'deallocate'
  | 'consume_customer'
  | 'consume_workshop'
  | 'waste'
  | 'damage'
  | 'customer_return'
  | 'ship_out'
  | 'adjust_up'
  | 'adjust_down'
  | 'buyback_in';

export interface StockPosition {
  variant_id: string;
  on_hand_qty: number;
  reserved_qty: number;
  allocated_qty: number;
}

interface WarehouseEntry {
  entryKey: string;
  variantId: string;
  lotId?: string | null;
  type: WarehouseEntryType;
  dOnHand: number;
  dReserved: number;
  dAllocated: number;
  userId?: string | null;
  refType?: string;
  refId?: string;
  cost?: number;
  reason?: string;
  actorId: string;
  now: Date;
}

function ledgerStmt(db: D1Database, e: WarehouseEntry): Stmt {
  return db
    .prepare(
      `INSERT INTO pc_warehouse_ledger (id, entry_key, variant_id, lot_id, entry_type, delta_on_hand, delta_reserved, delta_allocated,
         user_id, ref_type, ref_id, cost_iqd, reason, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      pcId('pcwl'),
      e.entryKey,
      e.variantId,
      e.lotId ?? null,
      e.type,
      e.dOnHand,
      e.dReserved,
      e.dAllocated,
      e.userId ?? null,
      e.refType ?? '',
      e.refId ?? '',
      e.cost ?? 0,
      (e.reason ?? '').slice(0, 500),
      e.actorId,
      iso(e.now)
    );
}

export function ensurePosition(db: D1Database, variantId: string, now: Date): Stmt {
  return db.prepare('INSERT OR IGNORE INTO pc_stock_positions (variant_id, updated_at) VALUES (?, ?)').bind(variantId, iso(now));
}

function positionDelta(db: D1Database, variantId: string, dOnHand: number, dReserved: number, dAllocated: number, now: Date): Stmt {
  return db
    .prepare(
      `UPDATE pc_stock_positions
          SET on_hand_qty = on_hand_qty + ?, reserved_qty = reserved_qty + ?, allocated_qty = allocated_qty + ?, updated_at = ?
        WHERE variant_id = ?`
    )
    .bind(dOnHand, dReserved, dAllocated, iso(now), variantId);
}

/** The sale guard: after this batch's own changes, the variant is not oversold. */
export function notOversoldFence(db: D1Database, variantId: string): Stmt {
  return fence(
    db,
    'OUT_OF_STOCK',
    '(SELECT on_hand_qty - reserved_qty - allocated_qty FROM pc_stock_positions WHERE variant_id = ?) >= 0',
    [variantId]
  );
}

export async function position(db: D1Database, variantId: string): Promise<StockPosition> {
  const row = await one<StockPosition>(
    db,
    'SELECT variant_id, on_hand_qty, reserved_qty, allocated_qty FROM pc_stock_positions WHERE variant_id = ?',
    variantId
  );
  return row ?? { variant_id: variantId, on_hand_qty: 0, reserved_qty: 0, allocated_qty: 0 };
}

export const sellable = (p: StockPosition): number => Number(p.on_hand_qty) - Number(p.reserved_qty) - Number(p.allocated_qty);

// ------------------------------------------------------------------ receiving

export interface ReceiveInput {
  variantId: string;
  qty: number;
  totalCostIqd: number;
  locationId?: string | null;
  lotCode?: string;
  supplier?: string;
  notes?: string;
  actorId: string;
  now: Date;
}

/** A delivery from a supplier: a new physical lot at its cost, on hand and sellable. */
export function receiveStock(db: D1Database, r: ReceiveInput): { lotId: string; statements: Stmt[] } {
  if (!Number.isSafeInteger(r.qty) || r.qty <= 0) throw pcError('VALIDATION', { field: 'qty' });
  if (!Number.isSafeInteger(r.totalCostIqd) || r.totalCostIqd < 0) throw pcError('VALIDATION', { field: 'total_cost_iqd' });
  const lotId = pcId('pcsl');
  const unitMilli = mulDivRound(r.totalCostIqd, 1000, r.qty);
  return {
    lotId,
    statements: [
      ensurePosition(db, r.variantId, r.now),
      db
        .prepare(
          `INSERT INTO pc_stock_lots (id, variant_id, location_id, lot_code, supplier, received_qty, on_hand_qty, unit_cost_milli_iqd,
             total_cost_iqd, received_at, received_by, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          lotId,
          r.variantId,
          r.locationId ?? null,
          (r.lotCode ?? '').slice(0, 80),
          (r.supplier ?? '').slice(0, 120),
          r.qty,
          r.qty,
          unitMilli,
          r.totalCostIqd,
          iso(r.now),
          r.actorId,
          (r.notes ?? '').slice(0, 500)
        ),
      positionDelta(db, r.variantId, r.qty, 0, 0, r.now),
      ledgerStmt(db, {
        entryKey: `receive:${lotId}`,
        variantId: r.variantId,
        lotId,
        type: 'receive',
        dOnHand: r.qty,
        dReserved: 0,
        dAllocated: 0,
        cost: r.totalCostIqd,
        actorId: r.actorId,
        now: r.now,
      }),
    ],
  };
}

// ------------------------------------------------------------------ sale holds

/** Hold `qty` of a variant for an unpaid order. Fenced: never oversells. */
export function holdStock(db: D1Database, p: { orderId: string; variantId: string; qty: number; expiresAt: Date; actorId: string; now: Date }): Stmt[] {
  const holdId = pcId('pcsh');
  return [
    ensurePosition(db, p.variantId, p.now),
    positionDelta(db, p.variantId, 0, p.qty, 0, p.now),
    notOversoldFence(db, p.variantId),
    db
      .prepare(
        `INSERT INTO pc_stock_holds (id, order_id, variant_id, qty, state, expires_at, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`
      )
      .bind(holdId, p.orderId, p.variantId, p.qty, iso(p.expiresAt), iso(p.now)),
    ledgerStmt(db, {
      entryKey: `hold:${holdId}`,
      variantId: p.variantId,
      type: 'hold',
      dOnHand: 0,
      dReserved: p.qty,
      dAllocated: 0,
      refType: 'order',
      refId: p.orderId,
      actorId: p.actorId,
      now: p.now,
    }),
  ];
}

export interface StockHoldRow {
  id: string;
  order_id: string;
  variant_id: string;
  qty: number;
  state: string;
}

function flipHold(db: D1Database, hold: StockHoldRow, to: 'converted' | 'released', now: Date): Stmt[] {
  return [
    db.prepare("UPDATE pc_stock_holds SET state = ?, settled_at = ? WHERE id = ? AND state = 'active'").bind(to, iso(now), hold.id),
    fence(db, 'STATE_CHANGED', '(SELECT state FROM pc_stock_holds WHERE id = ?) = ?', [hold.id, to]),
  ];
}

/**
 * Payment arrived: the held grams become the customer's (allocated). Fenced
 * on the hold being active in THIS batch — a second fulfilment cannot convert
 * it again (the ledger key would collide too).
 */
export function convertHoldToAllocation(db: D1Database, hold: StockHoldRow, userId: string, actorId: string, now: Date): Stmt[] {
  return [
    ...flipHold(db, hold, 'converted', now),
    positionDelta(db, hold.variant_id, 0, -hold.qty, hold.qty, now),
    ledgerStmt(db, {
      entryKey: `allocate:${hold.id}`,
      variantId: hold.variant_id,
      type: 'allocate',
      dOnHand: 0,
      dReserved: -hold.qty,
      dAllocated: hold.qty,
      userId,
      refType: 'order',
      refId: hold.order_id,
      actorId,
      now,
    }),
  ];
}

/** The order was cancelled or expired: the held grams are sellable again. */
export function releaseHold(db: D1Database, hold: StockHoldRow, actorId: string, now: Date, reason: string): Stmt[] {
  return [
    ...flipHold(db, hold, 'released', now),
    positionDelta(db, hold.variant_id, 0, -hold.qty, 0, now),
    ledgerStmt(db, {
      entryKey: `hold_release:${hold.id}`,
      variantId: hold.variant_id,
      type: 'hold_release',
      dOnHand: 0,
      dReserved: -hold.qty,
      dAllocated: 0,
      refType: 'order',
      refId: hold.order_id,
      reason,
      actorId,
      now,
    }),
  ];
}

export async function activeHolds(db: D1Database, orderId: string): Promise<StockHoldRow[]> {
  return many<StockHoldRow>(db, "SELECT id, order_id, variant_id, qty, state FROM pc_stock_holds WHERE order_id = ? AND state = 'active'", orderId);
}

// ------------------------------------------------------------------ physical movements

async function stockLots(db: D1Database, variantId: string): Promise<LotState[]> {
  const rows = await many<{ id: string; received_qty: number; on_hand_qty: number; total_cost_iqd: number }>(
    db,
    'SELECT id, received_qty, on_hand_qty, total_cost_iqd FROM pc_stock_lots WHERE variant_id = ? AND on_hand_qty > 0 ORDER BY received_at, id',
    variantId
  );
  return rows.map((r) => ({ id: r.id, total: Number(r.received_qty), remaining: Number(r.on_hand_qty), value: Number(r.total_cost_iqd) }));
}

export interface PhysicalMove {
  variantId: string;
  qty: number;
  type: 'consume_customer' | 'consume_workshop' | 'waste' | 'damage' | 'ship_out' | 'adjust_down';
  /** Customer-owned units leaving the shelf also leave `allocated`. */
  fromAllocated: boolean;
  userId?: string | null;
  refType: string;
  refId: string;
  entryKey: string;
  reason?: string;
  actorId: string;
  now: Date;
}

/**
 * Units physically leave the shelf: drawn from the oldest stock lots, each
 * lot fenced on the quantity the plan read, the cost recorded. On-hand can
 * never go negative (ck_pc_stock_on_hand → STOCK_DEFICIT): the workshop must
 * receive stock before it can record using stock it does not have.
 */
export async function removePhysical(db: D1Database, m: PhysicalMove): Promise<{ statements: Stmt[]; cost: number }> {
  if (!Number.isSafeInteger(m.qty) || m.qty <= 0) throw pcError('VALIDATION', { field: 'qty' });
  const plan = planDraws(await stockLots(db, m.variantId), m.qty);
  if (plan.shortfall > 0) throw pcError('STOCK_DEFICIT', { variant_id: m.variantId, missing: plan.shortfall });
  const statements: Stmt[] = [];
  for (const d of plan.draws) {
    statements.push(fence(db, 'STATE_CHANGED', '(SELECT on_hand_qty FROM pc_stock_lots WHERE id = ?) = ?', [d.lotId, d.expectedRemaining]));
    statements.push(db.prepare('UPDATE pc_stock_lots SET on_hand_qty = on_hand_qty - ? WHERE id = ?').bind(d.qty, d.lotId));
  }
  statements.push(positionDelta(db, m.variantId, -m.qty, 0, m.fromAllocated ? -m.qty : 0, m.now));
  statements.push(
    ledgerStmt(db, {
      entryKey: m.entryKey,
      variantId: m.variantId,
      lotId: plan.draws.length === 1 ? plan.draws[0].lotId : null,
      type: m.type,
      dOnHand: -m.qty,
      dReserved: 0,
      dAllocated: m.fromAllocated ? -m.qty : 0,
      userId: m.userId ?? null,
      refType: m.refType,
      refId: m.refId,
      cost: plan.value,
      reason: m.reason,
      actorId: m.actorId,
      now: m.now,
    })
  );
  return { statements, cost: plan.value };
}

/**
 * Customer-owned units go back to the workshop's own stock without moving
 * (a buyback, a refunded purchase): allocated falls, sellable rises.
 */
export function deallocate(
  db: D1Database,
  p: { variantId: string; qty: number; type: 'deallocate' | 'buyback_in'; userId: string; refType: string; refId: string; entryKey: string; actorId: string; now: Date }
): Stmt[] {
  return [
    positionDelta(db, p.variantId, 0, 0, -p.qty, p.now),
    ledgerStmt(db, {
      entryKey: p.entryKey,
      variantId: p.variantId,
      type: p.type,
      dOnHand: 0,
      dReserved: 0,
      dAllocated: -p.qty,
      userId: p.userId,
      refType: p.refType,
      refId: p.refId,
      actorId: p.actorId,
      now: p.now,
    }),
  ];
}

/**
 * Allocate workshop stock to a customer without a sale (a compensation, an
 * admin correction): fenced like a sale, so it can never allocate units that
 * are not on the shelf.
 */
export function allocateWithoutSale(
  db: D1Database,
  p: { variantId: string; qty: number; userId: string; refType: string; refId: string; entryKey: string; actorId: string; now: Date }
): Stmt[] {
  return [
    ensurePosition(db, p.variantId, p.now),
    positionDelta(db, p.variantId, 0, 0, p.qty, p.now),
    notOversoldFence(db, p.variantId),
    ledgerStmt(db, {
      entryKey: p.entryKey,
      variantId: p.variantId,
      type: 'allocate',
      dOnHand: 0,
      dReserved: 0,
      dAllocated: p.qty,
      userId: p.userId,
      refType: p.refType,
      refId: p.refId,
      actorId: p.actorId,
      now: p.now,
    }),
  ];
}

/** A count found MORE than the books say: a zero-cost adjustment lot (cost is unknown, never invented). */
export function adjustUp(db: D1Database, p: { variantId: string; qty: number; reason: string; actorId: string; now: Date }): Stmt[] {
  const lotId = pcId('pcsl');
  return [
    ensurePosition(db, p.variantId, p.now),
    db
      .prepare(
        `INSERT INTO pc_stock_lots (id, variant_id, lot_code, received_qty, on_hand_qty, unit_cost_milli_iqd, total_cost_iqd, received_at, received_by, notes)
         VALUES (?, ?, 'ADJUSTMENT', ?, ?, 0, 0, ?, ?, ?)`
      )
      .bind(lotId, p.variantId, p.qty, p.qty, iso(p.now), p.actorId, p.reason.slice(0, 500)),
    positionDelta(db, p.variantId, p.qty, 0, 0, p.now),
    ledgerStmt(db, {
      entryKey: `adjust_up:${lotId}`,
      variantId: p.variantId,
      lotId,
      type: 'adjust_up',
      dOnHand: p.qty,
      dReserved: 0,
      dAllocated: 0,
      reason: p.reason,
      actorId: p.actorId,
      now: p.now,
    }),
  ];
}

export async function stockOverview(db: D1Database) {
  return many<{
    variant_id: string;
    sku: string;
    name_en: string;
    name_ar: string;
    name_ckb: string;
    unit_code: string;
    on_hand_qty: number;
    reserved_qty: number;
    allocated_qty: number;
    sellable_qty: number;
    low_stock_threshold_qty: number;
    low: number;
  }>(
    db,
    `SELECT v.id AS variant_id, v.sku, v.name_en, v.name_ar, v.name_ckb, v.unit_code,
            COALESCE(p.on_hand_qty, 0) AS on_hand_qty, COALESCE(p.reserved_qty, 0) AS reserved_qty,
            COALESCE(p.allocated_qty, 0) AS allocated_qty,
            COALESCE(p.on_hand_qty, 0) - COALESCE(p.reserved_qty, 0) - COALESCE(p.allocated_qty, 0) AS sellable_qty,
            v.low_stock_threshold_qty,
            CASE WHEN COALESCE(p.on_hand_qty, 0) - COALESCE(p.reserved_qty, 0) - COALESCE(p.allocated_qty, 0) <= v.low_stock_threshold_qty
                 THEN 1 ELSE 0 END AS low
       FROM pc_variants v LEFT JOIN pc_stock_positions p ON p.variant_id = v.id
      ORDER BY v.sku`
  );
}
