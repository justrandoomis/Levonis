/**
 * MY INVENTORY — what each customer owns inside the workshop
 * (docs/PRINT_CLOUD.md §5).
 *
 * One account per (customer, variant), counted in the variant's ONE base unit
 * (grams of PLA Basic Cold White, pieces of 8×3 mm magnets, sets, millimetres),
 * so grams are never added to pieces and two colours never share a balance.
 *
 *   available — the customer may use, ship or sell it back
 *   reserved  — held for a confirmed print, a delivery or a buyback request
 *   consumed  — used in printing, delivered or sold back (lifetime)
 *
 * Lots record what each unit was bought for (a buyback is valued on them);
 * the account is a cache of `pc_inventory_ledger`, guarded by named CHECKs.
 *
 * This is OWNERSHIP, not physical stock: the physical grams are workshop
 * stock (warehouse.ts), where a customer's units are counted as `allocated`.
 * Every function that changes both returns both sets of statements to the
 * caller's single batch.
 */
import { fence, many, one, type Stmt } from './db';
import { pcError } from './errors';
import { planDraws, type LotDraw, type LotState } from './lots';
import { iso, pcId } from './util';

export const inventoryAccountId = (userId: string, variantId: string): string => `pcia_${userId}__${variantId}`;

export type InventoryPurpose = 'print_job' | 'delivery' | 'buyback';
export type InventoryEntryType =
  | 'purchase'
  | 'reserve'
  | 'release'
  | 'consume'
  | 'deliver'
  | 'buyback'
  | 'refund'
  | 'adjust_credit'
  | 'adjust_debit'
  | 'compensation';

export interface InventoryReservationRow {
  id: string;
  account_id: string;
  user_id: string;
  variant_id: string;
  purpose: InventoryPurpose;
  ref_id: string;
  qty_reserved: number;
  qty_consumed: number;
  qty_released: number;
  state: 'active' | 'settled' | 'released';
}

interface LedgerEntry {
  entryKey: string;
  accountId: string;
  userId: string;
  variantId: string;
  type: InventoryEntryType;
  dAvailable: number;
  dReserved: number;
  dConsumed: number;
  lotId?: string | null;
  reservationId?: string | null;
  refType?: string;
  refId?: string;
  value?: number;
  actorId: string;
  note?: string;
  now: Date;
}

function ledgerStmt(db: D1Database, e: LedgerEntry): Stmt {
  return db
    .prepare(
      `INSERT INTO pc_inventory_ledger (id, entry_key, account_id, user_id, variant_id, entry_type, delta_available, delta_reserved,
         delta_consumed, lot_id, reservation_id, ref_type, ref_id, value_iqd, actor_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      pcId('pcil'),
      e.entryKey,
      e.accountId,
      e.userId,
      e.variantId,
      e.type,
      e.dAvailable,
      e.dReserved,
      e.dConsumed,
      e.lotId ?? null,
      e.reservationId ?? null,
      e.refType ?? '',
      e.refId ?? '',
      e.value ?? 0,
      e.actorId,
      (e.note ?? '').slice(0, 500),
      iso(e.now)
    );
}

function accountDelta(db: D1Database, accountId: string, dAvailable: number, dReserved: number, dConsumed: number, now: Date): Stmt {
  return db
    .prepare(
      `UPDATE pc_inventory_accounts
          SET available_qty = available_qty + ?, reserved_qty = reserved_qty + ?, consumed_qty = consumed_qty + ?, updated_at = ?
        WHERE id = ?`
    )
    .bind(dAvailable, dReserved, dConsumed, iso(now), accountId);
}

/** Creates the account in the variant's own base unit; a no-op when it exists. */
export function ensureInventoryAccount(db: D1Database, userId: string, variantId: string, now: Date): Stmt {
  return db
    .prepare(
      `INSERT OR IGNORE INTO pc_inventory_accounts (id, user_id, variant_id, unit_code, updated_at)
       SELECT ?, ?, v.id, v.unit_code, ? FROM pc_variants v WHERE v.id = ?`
    )
    .bind(inventoryAccountId(userId, variantId), userId, iso(now), variantId);
}

/**
 * The lots units are drawn from, in order: the ones earmarked for `projectId`
 * first (bought FOR that project), then the oldest.
 */
export async function inventoryLots(db: D1Database, accountId: string, projectId?: string | null): Promise<LotState[]> {
  const rows = await many<{ id: string; qty_total: number; qty_remaining: number; paid_iqd: number; project_id: string | null }>(
    db,
    `SELECT id, qty_total, qty_remaining, paid_iqd, project_id FROM pc_inventory_lots
      WHERE account_id = ? AND qty_remaining > 0
      ORDER BY CASE WHEN project_id IS NOT NULL AND project_id = ? THEN 0 ELSE 1 END, created_at, id`,
    accountId,
    projectId ?? ''
  );
  return rows.map((r) => ({ id: r.id, total: Number(r.qty_total), remaining: Number(r.qty_remaining), value: Number(r.paid_iqd) }));
}

function drawStatements(db: D1Database, draws: LotDraw[], entryKey: string, now: Date): Stmt[] {
  const out: Stmt[] = [];
  for (const d of draws) {
    out.push(fence(db, 'STATE_CHANGED', '(SELECT qty_remaining FROM pc_inventory_lots WHERE id = ?) = ?', [d.lotId, d.expectedRemaining]));
    out.push(db.prepare('UPDATE pc_inventory_lots SET qty_remaining = qty_remaining - ? WHERE id = ?').bind(d.qty, d.lotId));
    out.push(
      db
        .prepare('INSERT INTO pc_inventory_lot_draws (id, lot_id, ledger_entry_key, qty, value_iqd, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(pcId('pcild'), d.lotId, entryKey, d.qty, d.value, iso(now))
    );
  }
  return out;
}

// ------------------------------------------------------------------ grant

export interface InventoryGrant {
  userId: string;
  variantId: string;
  qty: number;
  paidIqd: number;
  source: 'purchase' | 'adjustment' | 'compensation';
  orderLineId?: string | null;
  projectId?: string | null;
  entryKey: string;
  actorId: string;
  note?: string;
  now: Date;
}

/** New units in a new lot: 490 g + a 250 g purchase is a 740 g balance in two lots. */
export function grantInventory(db: D1Database, g: InventoryGrant): { lotId: string; statements: Stmt[] } {
  if (!Number.isSafeInteger(g.qty) || g.qty <= 0) throw pcError('VALIDATION', { field: 'qty' });
  const accountId = inventoryAccountId(g.userId, g.variantId);
  const lotId = pcId('pcilot');
  const type: InventoryEntryType = g.source === 'purchase' ? 'purchase' : g.source === 'compensation' ? 'compensation' : 'adjust_credit';
  return {
    lotId,
    statements: [
      ensureInventoryAccount(db, g.userId, g.variantId, g.now),
      db
        .prepare(
          `INSERT INTO pc_inventory_lots (id, account_id, user_id, variant_id, source, order_line_id, qty_total, qty_remaining,
             paid_iqd, project_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(lotId, accountId, g.userId, g.variantId, g.source, g.orderLineId ?? null, g.qty, g.qty, g.paidIqd, g.projectId ?? null, iso(g.now)),
      ledgerStmt(db, {
        entryKey: g.entryKey,
        accountId,
        userId: g.userId,
        variantId: g.variantId,
        type,
        dAvailable: g.qty,
        dReserved: 0,
        dConsumed: 0,
        lotId,
        value: g.paidIqd,
        actorId: g.actorId,
        note: g.note,
        now: g.now,
      }),
      accountDelta(db, accountId, g.qty, 0, 0, g.now),
    ],
  };
}

// ------------------------------------------------------------------ reserve / release / settle

export interface InventoryReserve {
  userId: string;
  variantId: string;
  qty: number;
  purpose: InventoryPurpose;
  refId: string;
  actorId: string;
  now: Date;
}

/**
 * Hold units for a print, a delivery or a buyback. ck_pc_inventory_available
 * aborts the batch when the customer does not own enough — so a print and a
 * delivery racing for the same last 100 g cannot both hold it.
 */
export function reserveInventory(db: D1Database, r: InventoryReserve): { reservationId: string; statements: Stmt[] } {
  if (!Number.isSafeInteger(r.qty) || r.qty <= 0) throw pcError('VALIDATION', { field: 'qty' });
  const accountId = inventoryAccountId(r.userId, r.variantId);
  const reservationId = pcId('pcir');
  return {
    reservationId,
    statements: [
      ensureInventoryAccount(db, r.userId, r.variantId, r.now),
      accountDelta(db, accountId, -r.qty, r.qty, 0, r.now),
      db
        .prepare(
          `INSERT INTO pc_inventory_reservations (id, account_id, user_id, variant_id, purpose, ref_id, qty_reserved, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
        )
        .bind(reservationId, accountId, r.userId, r.variantId, r.purpose, r.refId, r.qty, iso(r.now)),
      ledgerStmt(db, {
        entryKey: `reserve:${reservationId}`,
        accountId,
        userId: r.userId,
        variantId: r.variantId,
        type: 'reserve',
        dAvailable: -r.qty,
        dReserved: r.qty,
        dConsumed: 0,
        reservationId,
        refType: r.purpose,
        refId: r.refId,
        actorId: r.actorId,
        now: r.now,
      }),
    ],
  };
}

function closeReservation(db: D1Database, res: InventoryReservationRow, state: 'settled' | 'released', consumed: number, released: number, now: Date): Stmt[] {
  const token = pcId('tok');
  return [
    db
      .prepare(
        `UPDATE pc_inventory_reservations
            SET state = ?, qty_consumed = ?, qty_released = ?, settled_at = ?, op_token = ?
          WHERE id = ? AND state = 'active'`
      )
      .bind(state, consumed, released, iso(now), token, res.id),
    fence(db, 'STATE_CHANGED', '(SELECT op_token FROM pc_inventory_reservations WHERE id = ?) = ?', [res.id, token]),
  ];
}

/** Give the whole reservation back. Exactly once: the flip is fenced. */
export function releaseInventory(db: D1Database, res: InventoryReservationRow, actorId: string, now: Date, note = ''): Stmt[] {
  if (res.state !== 'active') throw pcError('STATE_CHANGED');
  return [
    ...closeReservation(db, res, 'released', 0, res.qty_reserved, now),
    accountDelta(db, res.account_id, res.qty_reserved, -res.qty_reserved, 0, now),
    ledgerStmt(db, {
      entryKey: `release:${res.id}`,
      accountId: res.account_id,
      userId: res.user_id,
      variantId: res.variant_id,
      type: 'release',
      dAvailable: res.qty_reserved,
      dReserved: -res.qty_reserved,
      dConsumed: 0,
      reservationId: res.id,
      refType: res.purpose,
      refId: res.ref_id,
      actorId,
      note,
      now,
    }),
  ];
}

export interface InventorySettleOutcome {
  statements: Stmt[];
  fromReservation: number;
  overage: number;
  released: number;
  unbilled: number;
  /** Units that left the customer's ownership (billed). */
  billed: number;
  /** What those units were bought for. */
  value: number;
}

/**
 * Settle a reservation against what actually left: a print's verified
 * consumption, a shipped delivery, an approved buyback. Same rule as the
 * credit wallet: min(actual, reserved) from the reservation, the rest
 * released, an overage only under 'charge_from_balance' and never beyond it.
 */
export async function settleInventory(
  db: D1Database,
  res: InventoryReservationRow,
  actualQty: number,
  p: {
    type: 'consume' | 'deliver' | 'buyback';
    policy: 'cap_at_reserved' | 'charge_from_balance';
    projectId?: string | null;
    actorId: string;
    now: Date;
    note?: string;
  }
): Promise<InventorySettleOutcome> {
  if (res.state !== 'active') throw pcError('STATE_CHANGED');
  if (!Number.isSafeInteger(actualQty) || actualQty < 0) throw pcError('VALIDATION', { field: 'qty' });
  const fromReservation = Math.min(actualQty, res.qty_reserved);
  const released = res.qty_reserved - fromReservation;
  let overage = 0;
  if (actualQty > res.qty_reserved && p.policy === 'charge_from_balance') {
    const acct = await one<{ available_qty: number }>(db, 'SELECT available_qty FROM pc_inventory_accounts WHERE id = ?', res.account_id);
    overage = Math.min(actualQty - res.qty_reserved, Number(acct?.available_qty ?? 0));
  }
  const billed = fromReservation + overage;
  const unbilled = actualQty - billed;
  const statements: Stmt[] = [...closeReservation(db, res, 'settled', fromReservation, released, p.now)];
  let value = 0;
  if (billed > 0) {
    const plan = planDraws(await inventoryLots(db, res.account_id, p.projectId), billed);
    if (plan.shortfall > 0) throw pcError('STATE_CHANGED', { reason: 'lots_do_not_cover_balance' });
    value = plan.value;
    const key = `${p.type}:${res.id}`;
    statements.push(...drawStatements(db, plan.draws, key, p.now));
    statements.push(
      ledgerStmt(db, {
        entryKey: key,
        accountId: res.account_id,
        userId: res.user_id,
        variantId: res.variant_id,
        type: p.type,
        dAvailable: -overage,
        dReserved: -fromReservation,
        dConsumed: billed,
        reservationId: res.id,
        refType: res.purpose,
        refId: res.ref_id,
        value,
        actorId: p.actorId,
        note: p.note,
        now: p.now,
      })
    );
  }
  if (released > 0) {
    statements.push(
      ledgerStmt(db, {
        entryKey: `release:${res.id}`,
        accountId: res.account_id,
        userId: res.user_id,
        variantId: res.variant_id,
        type: 'release',
        dAvailable: released,
        dReserved: -released,
        dConsumed: 0,
        reservationId: res.id,
        refType: res.purpose,
        refId: res.ref_id,
        actorId: p.actorId,
        now: p.now,
      })
    );
  }
  statements.push(accountDelta(db, res.account_id, released - overage, -res.qty_reserved, billed, p.now));
  return { statements, fromReservation, overage, released, unbilled, billed, value };
}

/** Take units out of the AVAILABLE balance (an admin correction, a refund of one purchase lot). */
export async function debitInventory(
  db: D1Database,
  p: {
    userId: string;
    variantId: string;
    qty: number;
    type: 'refund' | 'adjust_debit';
    entryKey: string;
    lotId?: string;
    refType?: string;
    refId?: string;
    actorId: string;
    note?: string;
    now: Date;
  }
): Promise<{ statements: Stmt[]; value: number }> {
  if (!Number.isSafeInteger(p.qty) || p.qty <= 0) throw pcError('VALIDATION', { field: 'qty' });
  const accountId = inventoryAccountId(p.userId, p.variantId);
  let lots = await inventoryLots(db, accountId);
  if (p.lotId) lots = lots.filter((l) => l.id === p.lotId);
  const plan = planDraws(lots, p.qty);
  if (plan.shortfall > 0) throw pcError('INSUFFICIENT_INVENTORY');
  return {
    value: plan.value,
    statements: [
      ...drawStatements(db, plan.draws, p.entryKey, p.now),
      ledgerStmt(db, {
        entryKey: p.entryKey,
        accountId,
        userId: p.userId,
        variantId: p.variantId,
        type: p.type,
        dAvailable: -p.qty,
        dReserved: 0,
        dConsumed: 0,
        lotId: p.lotId ?? null,
        refType: p.refType,
        refId: p.refId,
        value: plan.value,
        actorId: p.actorId,
        note: p.note,
        now: p.now,
      }),
      accountDelta(db, accountId, -p.qty, 0, 0, p.now),
    ],
  };
}

// ------------------------------------------------------------------ the workshop's default reminder

/**
 * The unit the workshop's default low-balance reminder counts in
 * (`low_inventory_default_g`): a balance in grams without its own reminder
 * amount is reminded at the default; a balance in any other unit (pieces,
 * sets, millimetres) has no default — no gram figure is ever applied to
 * pieces — and is reminded only at an amount the customer set.
 */
export const LOW_STOCK_DEFAULT_UNIT = 'g';

/**
 * The reminder amount the workshop applies to a balance of `unitCode` that has
 * none of its own, or null where no default applies. The low-inventory scan
 * reminds by this rule (background.ts) and GET /me/inventory states it per row.
 */
export function lowStockDefaultQty(unitCode: string, config: { low_inventory_default_g: number }): number | null {
  return unitCode === LOW_STOCK_DEFAULT_UNIT ? config.low_inventory_default_g : null;
}

// ------------------------------------------------------------------ reads

export async function activeInventoryReservations(db: D1Database, purpose: InventoryPurpose, refId: string): Promise<InventoryReservationRow[]> {
  return many<InventoryReservationRow>(
    db,
    `SELECT id, account_id, user_id, variant_id, purpose, ref_id, qty_reserved, qty_consumed, qty_released, state
       FROM pc_inventory_reservations WHERE purpose = ? AND ref_id = ? AND state = 'active' ORDER BY id`,
    purpose,
    refId
  );
}

export async function inventoryBalances(db: D1Database, userId: string, category?: string | null) {
  return many<{
    account_id: string;
    variant_id: string;
    sku: string;
    unit_code: string;
    available_qty: number;
    reserved_qty: number;
    consumed_qty: number;
    low_stock_alert_qty: number | null;
    name_ar: string;
    name_en: string;
    name_ckb: string;
    color_name: string;
    color_hex: string;
    product_id: string;
    category_code: string;
    category_kind: string;
    material: string | null;
    brand: string;
    remaining_value_iqd: number;
  }>(
    db,
    `SELECT a.id AS account_id, a.variant_id, v.sku, a.unit_code, a.available_qty, a.reserved_qty, a.consumed_qty, a.low_stock_alert_qty,
            v.name_ar, v.name_en, v.name_ckb, v.color_name, v.color_hex, p.id AS product_id, p.category_code, c.kind AS category_kind,
            p.material, p.brand,
            COALESCE((SELECT SUM((l.paid_iqd * l.qty_remaining + l.qty_total / 2) / l.qty_total) FROM pc_inventory_lots l
                       WHERE l.account_id = a.id AND l.qty_remaining > 0), 0) AS remaining_value_iqd
       FROM pc_inventory_accounts a
       JOIN pc_variants v ON v.id = a.variant_id
       JOIN pc_products p ON p.id = v.product_id
       JOIN pc_product_categories c ON c.code = p.category_code
      WHERE a.user_id = ? ${category ? 'AND p.category_code = ?' : ''}
      ORDER BY c.sort, p.name_en, v.name_en`,
    ...(category ? [userId, category] : [userId])
  );
}
