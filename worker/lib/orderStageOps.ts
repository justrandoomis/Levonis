/**
 * Moving an order between tracking stages — the one place it happens.
 *
 * Three callers need this and must not each have their own version of it:
 * the admin panel (a person confirms something), the cron sweep (a
 * configured wait elapsed), and the courier sync (Al-Waseet says the parcel
 * was delivered). If any of them had its own copy, the day they disagreed
 * would be the day an order's history stopped matching what the customer was
 * shown.
 *
 * WHAT A MOVE HAS TO DO, ALL OF IT OR NONE:
 *
 *   1. Refuse an illegal move (canMoveStage), unless the caller is repairing.
 *   2. Flip the stage CONDITIONALLY on the stage it was read at, so two
 *      concurrent movers cannot both win.
 *   3. Keep the legacy `status` column in step, because the stock lifecycle,
 *      the invoice writer and every existing filter still read it.
 *   4. Re-arm the alarm clock from the NEW entry time — which is how a manual
 *      change cancels the automatic transition that was pending. The pending
 *      one is overwritten, not remembered and ignored.
 *   5. Append to order_status_history. Append, never rewrite: "we told the
 *      customer it had shipped" stays true even after an admin takes it back.
 *   6. Cross the stock boundary if the legacy status crossed it.
 *
 * Step 6 is a real edge case, not a theoretical one. No AUTOMATIC promotion
 * crosses it — every clock-driven stage sits at or after `confirmed`, whose
 * legacy status is already inside STOCK_DEDUCTED_STATES — but an admin
 * jumping an unconfirmed order straight to a warehouse stage does cross it,
 * and skipping the deduction there would ship goods the inventory still
 * believes are on the shelf.
 */

import type { Env } from './types';
import type { ShippingType } from './shippingType';
import { typeForTransport } from './shippingType';
import {
  type OrderStage,
  type StageSource,
  STAGE_LEGACY_STATUS,
  STAGE_SOURCE,
  canMoveStage,
  nextStageOf,
  resolveDurations,
  scheduleFrom,
  spreadFor,
  stagesFor,
} from './orderStages';
import { deductOrderStock, returnOrderStock } from './orderInventory';
import { getSetting } from './settings';

/** Mirrors STOCK_DEDUCTED_STATES in the admin route — the same four statuses. */
const STOCK_DEDUCTED_STATES = new Set(['confirmed', 'processing', 'shipped', 'delivered']);

export interface OrderStageRow {
  id: string;
  stage: OrderStage;
  status: string;
  shipping_type: ShippingType;
  stage_changed_at: string;
  next_stage: string;
  next_stage_at: string | null;
  stage_source: string;
}

function asStage(v: unknown, fallback: OrderStage = 'received'): OrderStage {
  return typeof v === 'string' && v in STAGE_LEGACY_STATUS ? (v as OrderStage) : fallback;
}

function asShippingType(v: unknown): ShippingType {
  return v === 'preorder_air' || v === 'preorder_sea' || v === 'preorder_land' || v === 'direct'
    ? v
    : typeForTransport(v);
}

export function stageRowFrom(row: Record<string, unknown>): OrderStageRow {
  return {
    id: String(row.id),
    stage: asStage(row.stage),
    status: String(row.status ?? 'pending'),
    shipping_type: asShippingType(row.shipping_type),
    // An order written before 0028 could carry an empty entry time. Falling
    // back to created_at keeps the clock honest instead of measuring from the
    // epoch and promoting the order the instant the sweep first sees it.
    stage_changed_at: String(row.stage_changed_at || row.updated_at || row.created_at || ''),
    next_stage: String(row.next_stage ?? ''),
    next_stage_at: (row.next_stage_at as string | null) ?? null,
    stage_source: String(row.stage_source ?? 'automatic'),
  };
}

export interface MoveResult {
  moved: boolean;
  from: OrderStage;
  to: OrderStage;
  legacy_from: string;
  legacy_to: string;
  next_stage: OrderStage | null;
  next_stage_at: string | null;
  /** Honest partial outcomes — the move happened, something beside it did not. */
  notes: string[];
  /** Why a move was refused, when moved === false. */
  reason?: 'ILLEGAL_MOVE' | 'RACED' | 'NOT_FOUND';
}

export interface MoveOptions {
  orderId: string;
  to: OrderStage;
  source: StageSource | 'system';
  changedBy?: string;
  note?: string;
  /**
   * Skips the legality check. Only for a repair path that already knows what
   * it is doing (a courier status arriving out of order, a backfill). The
   * history row still records who did it and why.
   */
  force?: boolean;
  /** Injected so tests can move an order through weeks in milliseconds. */
  now?: string;
}

function newHistoryId(orderId: string, at: string): string {
  // Deterministic enough to be greppable, unique enough for a primary key:
  // two moves of the same order in the same millisecond are not a thing the
  // conditional UPDATE below allows.
  return `osh_${orderId.slice(-12)}_${at.replace(/[^0-9]/g, '')}`;
}

/**
 * Moves one order to `to`. Returns { moved: false } rather than throwing when
 * the move is illegal or lost a race — the sweep processes many orders and
 * one of them being overtaken by an admin is normal, not an error.
 */
export async function moveOrderStage(env: Env, opts: MoveOptions): Promise<MoveResult> {
  const nowIso = opts.now ?? new Date().toISOString();
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?')
    .bind(opts.orderId)
    .first<Record<string, unknown>>();
  if (!row) {
    return { moved: false, from: 'received', to: opts.to, legacy_from: '', legacy_to: '', next_stage: null, next_stage_at: null, notes: [], reason: 'NOT_FOUND' };
  }
  const order = stageRowFrom(row);
  const from = order.stage;
  const legacyFrom = order.status;
  const legacyTo = STAGE_LEGACY_STATUS[opts.to];

  if (!opts.force && !canMoveStage(from, opts.to, order.shipping_type)) {
    return { moved: false, from, to: opts.to, legacy_from: legacyFrom, legacy_to: legacyTo, next_stage: null, next_stage_at: null, notes: [], reason: 'ILLEGAL_MOVE' };
  }

  const durations = resolveDurations(await getSetting(env.DB, 'orderStageDurations'));
  const schedule = scheduleFrom(opts.to, order.shipping_type, durations, nowIso, spreadFor(order.id));

  // Conditional on the stage we read. Two movers arriving together — the
  // sweep and an admin, or two sweeps — leave exactly one winner, and the
  // loser reports RACED instead of writing a second history row for a move
  // that never happened.
  const flip = await env.DB.prepare(
    `UPDATE orders
        SET stage = ?, stage_changed_at = ?, stage_source = ?,
            next_stage = ?, next_stage_at = ?, status = ?,
            delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(NULLIF(delivered_at,''), ?) ELSE delivered_at END,
            updated_at = ?
      WHERE id = ? AND stage = ?`
  )
    .bind(
      opts.to, nowIso, opts.source === 'system' ? 'manual' : opts.source,
      schedule.next_stage ?? '', schedule.next_stage_at, legacyTo,
      opts.to, nowIso, nowIso,
      order.id, from
    )
    .run();
  if (flip.meta.changes === 0) {
    return { moved: false, from, to: opts.to, legacy_from: legacyFrom, legacy_to: legacyTo, next_stage: null, next_stage_at: null, notes: [], reason: 'RACED' };
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newHistoryId(order.id, nowIso), order.id, opts.to, legacyTo,
      opts.source, nowIso, opts.changedBy ?? '', opts.note ?? ''
    )
    .run();

  const notes: string[] = [];
  const wasDeducted = STOCK_DEDUCTED_STATES.has(legacyFrom);
  const nowDeducted = STOCK_DEDUCTED_STATES.has(legacyTo);
  if (!wasDeducted && nowDeducted) {
    const res = await deductOrderStock(env.DB, order.id, opts.changedBy ?? 'system');
    if (res.rejected > 0) {
      notes.push(`Stock could not be deducted for ${res.rejected} line(s) — check the product's stock before shipping.`);
    }
  } else if (legacyTo === 'cancelled') {
    const res = await returnOrderStock(env.DB, order.id, opts.changedBy ?? 'system');
    if (res.kind !== 'none') notes.push(`Stock ${res.kind}d for ${res.applied} row(s).`);
  }

  return {
    moved: true,
    from,
    to: opts.to,
    legacy_from: legacyFrom,
    legacy_to: legacyTo,
    next_stage: schedule.next_stage,
    next_stage_at: schedule.next_stage_at,
    notes,
  };
}

/**
 * Gives an order its first schedule. Called once, at checkout, so a brand new
 * order carries the same alarm clock as one that has been moved by hand.
 */
export async function initOrderStage(env: Env, orderId: string, shippingType: ShippingType, at: string): Promise<void> {
  const durations = resolveDurations(await getSetting(env.DB, 'orderStageDurations'));
  const schedule = scheduleFrom('received', shippingType, durations, at, spreadFor(orderId));
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET stage = 'received', stage_changed_at = ?, stage_source = 'automatic',
              next_stage = ?, next_stage_at = ? WHERE id = ?`
    ).bind(at, schedule.next_stage ?? '', schedule.next_stage_at, orderId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note)
       VALUES (?, ?, 'received', 'pending', 'automatic', ?, '', '')`
    ).bind(newHistoryId(orderId, at), orderId, at),
  ]);
}

export interface SweepReport {
  scanned: number;
  promoted: number;
  skipped: number;
  errors: string[];
}

/**
 * The cron's job: promote every order whose configured wait has elapsed.
 *
 * Deliberately narrow. It only touches orders that ALREADY carry a
 * next_stage_at, which `scheduleFrom` only ever writes for a stage whose
 * successor is `automatic`. A stage waiting on an admin or on the courier has
 * a null next_stage_at and is invisible to this query, so the sweep cannot
 * confirm an order, cannot declare it out for delivery, and cannot declare it
 * delivered — exactly as the owner required.
 */
export async function sweepDueStages(env: Env, limit = 200, now?: string): Promise<SweepReport> {
  const nowIso = now ?? new Date().toISOString();
  const report: SweepReport = { scanned: 0, promoted: 0, skipped: 0, errors: [] };
  const { results } = await env.DB.prepare(
    `SELECT id, stage, status, shipping_type, stage_changed_at, next_stage, next_stage_at, stage_source
       FROM orders
      WHERE next_stage_at IS NOT NULL AND next_stage_at <= ? AND next_stage != ''
        AND status NOT IN ('cancelled','delivered')
      ORDER BY next_stage_at
      LIMIT ?`
  )
    .bind(nowIso, limit)
    .all<Record<string, unknown>>();

  for (const raw of results ?? []) {
    report.scanned++;
    const order = stageRowFrom(raw);
    const target = asStage(order.next_stage, order.stage);
    // Re-checked here and not trusted from the column: a stored next_stage
    // could have been written by an older build, or by a path that has since
    // changed. Only a clock-owned stage may be promoted by the clock.
    if (STAGE_SOURCE[target] !== 'automatic' || target === order.stage) {
      report.skipped++;
      continue;
    }
    if (nextStageOf(order.stage, order.shipping_type) !== target) {
      report.skipped++;
      continue;
    }
    try {
      const res = await moveOrderStage(env, {
        orderId: order.id,
        to: target,
        source: 'automatic',
        changedBy: '',
        note: 'Automatic transition — scheduled wait elapsed',
        now: nowIso,
      });
      if (res.moved) report.promoted++;
      else report.skipped++;
    } catch (e) {
      report.errors.push(`${order.id}: ${e instanceof Error ? e.message : 'failed'}`);
    }
  }
  return report;
}

/** The stage path an order is on, with each stage's source and whether it is done. */
export interface StageView {
  stage: OrderStage;
  source: StageSource;
  reached: boolean;
  current: boolean;
  at: string | null;
}

export function stagePath(
  shippingType: ShippingType,
  current: OrderStage,
  history: Array<{ stage: string; changed_at: string }>
): StageView[] {
  const path = stagesFor(shippingType);
  const currentIndex = path.indexOf(current);
  // The FIRST time each stage was entered. A stage reversed and re-entered
  // keeps its original timestamp, which is what the customer was told.
  const firstAt = new Map<string, string>();
  for (const h of history) if (!firstAt.has(h.stage)) firstAt.set(h.stage, h.changed_at);
  return path.map((stage, i) => ({
    stage,
    source: STAGE_SOURCE[stage],
    reached: currentIndex >= 0 && i <= currentIndex,
    current: stage === current,
    at: firstAt.get(stage) ?? null,
  }));
}
