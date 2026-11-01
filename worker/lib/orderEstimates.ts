/**
 * «السعر التقديري» ON AN ORDER — ITS RECORD, ITS READS AND ITS SETTLEMENT
 * (docs/SMART_PRICING.md §6.2–6.5; migration 0218, triggers T6–T11; DECISIONS
 * row 280; invariants I3–I5).
 *
 * THE RECORD. A line sold at an estimated pre-order price is recorded at
 * checkout, in the order's own batch, in `order_price_estimates`: its SKU and
 * route, its quantity, the regular unit price it was sold at and the notice
 * version its buyer acknowledged. The batch holds `estimate-checkout:<order>`
 * from before the lines to after the records (`estimateCheckoutStatements`),
 * which is the only way a line of a labelled product gets in at all (T6) and
 * the only way a record does (T7).
 *
 * THE HOLD. While any record is open, proposed or rejected the order stays at
 * «تم الاستلام» — T8 refuses every confirm, preparation, shipping and courier
 * booking whatever door writes (priceEstimateGate.ts answers the doors with a
 * sentence first). The customer may cancel until then; T10 voids the lines.
 *
 * THE SETTLEMENT (`confirmEstimateFinalPrices`, a financial admin's act). The
 * request names every open or rejected line with its final unit price:
 *   - the total does not change (every final equals its estimate — honouring
 *     the estimate after a rejection included — or the differences cancel
 *     out): ONE batch confirms the lines, writes the audit row and the
 *     customer's in-app notice. No money moves; the gate opens.
 *   - the total changes: the ordinary 0140 proposal is made
 *     (`proposePriceAdjustment` with `reasonCode: 'ESTIMATE_FINAL_PRICE'`),
 *     and its own batch carries this file's statements: lines equal to their
 *     estimate become `confirmed`, the others `proposed` under the proposal's
 *     deterministic id, and a fence aborts the whole proposal when any line is
 *     left open or rejected. The customer then approves or rejects through
 *     0140's untouched doors, and T11 carries the decision onto the lines.
 * NOTHING EXTRA IS CHARGED WITHOUT APPROVAL (I5): the only path that moves
 * money is 0140's, whose money rule (packages/pricing/src/priceAdjustment.ts)
 * is not touched here.
 *
 * Customer prices only: an estimate record carries the price the line was sold
 * at and the final one, never a cost, a supplier price or a source (I6).
 *
 * This file sits outside worker/lib/pricingEngine/ on purpose — engine files
 * may not name `order_items` — and it imports nothing from the engine or FX
 * (tests/pricingCurrencyRoles.test.ts).
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): every read here answers "no estimate" on a
 * database without 0218 ("no such table: order_price_estimates"); a labelled
 * line — the only thing that writes here — cannot exist without the migration.
 */
import type { Env } from './types';
import { HttpError } from './http';
import { sha256Hex } from './crypto';
import { auditStatements } from './audit';
import { notifyStatement } from './notifications';
import { isPriceHeld, PRICE_APPROVAL_PENDING_MESSAGE } from './priceHold';
import { estimateCheckoutGuardId } from './priceEstimateGate';
import { loadRelationsViews } from './productOverlay';
import { iqdText, loadAdjustment, proposalId, proposePriceAdjustment, type PriceAdjustmentRow } from './orderPriceAdjust';
import { isOnPriceRule, roundPriceIqd } from '@levonis/pricing/priceRounding';
import { PRICE_ADJUST_MAX_IQD } from '@levonis/pricing/priceAdjustment';
import {
  ESTIMATE_DB_ABORTS,
  ESTIMATE_REASON_CODE,
  ESTIMATE_STRINGS,
  ESTIMATE_UNSETTLED_STATES,
  estimateServerMessage,
  fillEstimateText,
  isEstimateLineState,
  type EstimateLineState,
} from '@levonis/contracts/priceEstimates';

// ------------------------------------------------------------------ names

/** The three pre-order channels an estimate line is sold on (0218's CHECK). */
export type EstimateChannel = 'pre_order_air' | 'pre_order_sea' | 'pre_order_land';

/** The channel of a pre-order route, or null when the value is not one. */
export function estimateChannelOf(route: unknown): EstimateChannel | null {
  return route === 'air' || route === 'sea' || route === 'land' ? `pre_order_${route}` : null;
}

/** The states that hold the order at «تم الاستلام» (T8). */
const UNSETTLED: ReadonlySet<string> = new Set<string>(ESTIMATE_UNSETTLED_STATES);

/** Is this record's state one that holds its order (open, proposed or rejected)? */
export const isUnsettledEstimateState = (state: unknown): boolean => typeof state === 'string' && UNSETTLED.has(state);

/** 'no such table: order_price_estimates' — a database without 0218: no estimate line anywhere. */
const MISSING_TABLE = /no such table:?\s*(?:main\.)?order_price_estimates\b/i;
const isMissingTable = (e: unknown): boolean => MISSING_TABLE.test(e instanceof Error ? e.message : String(e));

/**
 * 503 PRICE_ESTIMATES_READ_FAILED — an estimate fact could not be read, so the
 * door refuses rather than guess (fail closed, §2.4). Nothing was written.
 */
export function estimatesReadFailed(): HttpError {
  return new HttpError(503, estimateServerMessage('PRICE_ESTIMATES_READ_FAILED'), 'PRICE_ESTIMATES_READ_FAILED');
}

// ------------------------------------------------------------------ the checkout

/** One line the checkout records (`order_price_estimates`), customer prices only. */
export interface EstimateCheckoutLine {
  order_item_id: string;
  product_id: string;
  /** The canonical `skuComboKey` of the line's own selection. */
  combo_key: string;
  channel: EstimateChannel;
  qty: number;
  /** The regular unit price the line was sold at (`benefit.regular_unit_iqd`). */
  estimate_unit_iqd: number;
}

/**
 * THE CHECKOUT'S THREE STATEMENTS (§6.3), split where they sit in the order's
 * batch:
 *
 *   before  `INSERT INTO ops_guards ('estimate-checkout:<order>', 1)` — after
 *           the order row, BEFORE the first `order_items` row: trigger T6
 *           refuses a line of a labelled product unless this token is held.
 *   after   ONE `INSERT … SELECT … FROM json_each(?)` writing every record
 *           (T7 holds it to this batch, to a line of this very order, and to
 *           an order still pending at «تم الاستلام» with no courier), then the
 *           token's DELETE — the token never outlives the batch.
 *
 * Called whenever ANY line's product row is labelled — a gift line of a
 * labelled product included, which is never recorded (it is priced at 0) —
 * and `lines` may then be empty. One bound list, never one parameter per line
 * (the live D1's 100-parameter ceiling).
 */
export function estimateCheckoutStatements(
  db: D1Database,
  orderId: string,
  lines: readonly EstimateCheckoutLine[],
  noticeVersion: number,
  nowIso: string
): { before: D1PreparedStatement[]; after: D1PreparedStatement[] } {
  const token = estimateCheckoutGuardId(orderId);
  const after: D1PreparedStatement[] = [];
  if (lines.length > 0) {
    const rows = lines.map((l) => ({
      i: l.order_item_id,
      p: l.product_id,
      k: l.combo_key,
      c: l.channel,
      q: Math.trunc(l.qty),
      u: Math.trunc(l.estimate_unit_iqd),
    }));
    after.push(
      db
        .prepare(
          `INSERT INTO order_price_estimates
             (order_item_id, order_id, product_id, combo_key, channel, qty, estimate_unit_iqd, notice_version, state, created_at)
           SELECT json_extract(value, '$.i'), ?1, json_extract(value, '$.p'), json_extract(value, '$.k'), json_extract(value, '$.c'),
                  json_extract(value, '$.q'), json_extract(value, '$.u'), ?2, 'open', ?3
             FROM json_each(?4)`
        )
        .bind(orderId, noticeVersion, nowIso, JSON.stringify(rows))
    );
  }
  after.push(db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(token));
  return { before: [db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(token)], after };
}

/**
 * The line's `pricing_snapshot` with `estimate: {v}` — the notice version its
 * buyer acknowledged — which `customerOrderPricing` serves as the line's
 * `price_estimate` label (worker/lib/customerPricing.ts). Every other key is
 * kept as stored.
 */
export function withEstimateSnapshot(snapshot: string | null, noticeVersion: number): string {
  let base: Record<string, unknown> = {};
  if (typeof snapshot === 'string' && snapshot !== '') {
    try {
      const parsed = JSON.parse(snapshot) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  return JSON.stringify({ ...base, estimate: { v: noticeVersion } });
}

/** Did the order batch abort on T6 — a line of a labelled product without the checkout token (a stale read)? */
export function isEstimateCheckoutAbort(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes(ESTIMATE_DB_ABORTS.CHECKOUT_REQUIRED);
}

/**
 * THE OWNER'S EMERGENCY BRAKE (`price_estimate_control.ordering_enabled`):
 * true while estimated lines may be ordered. Read ONLY for a cart with an
 * estimated line — which cannot exist without 0218 — and every failure,
 * a missing row included, is 503 PRICE_ESTIMATES_READ_FAILED (fail closed).
 */
export async function estimateOrderingEnabled(db: Pick<D1Database, 'prepare'>): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT ordering_enabled FROM price_estimate_control WHERE id = 1').first<{ ordering_enabled: number }>();
    if (!row) throw new Error('price_estimate_control has no row 1');
    return Number(row.ordering_enabled) === 1;
  } catch (e) {
    console.error('estimate ordering switch unreadable', e instanceof Error ? e.message : String(e));
    throw estimatesReadFailed();
  }
}

// ------------------------------------------------------------------ reads

/** One estimate record with its line's name, as the admin panel and the settlement read it. */
export interface OrderEstimateRow {
  order_item_id: string;
  order_id: string;
  product_id: string;
  combo_key: string;
  channel: EstimateChannel;
  qty: number;
  estimate_unit_iqd: number;
  notice_version: number;
  state: EstimateLineState;
  final_unit_iqd: number | null;
  adjustment_id: string | null;
  decided_by: string;
  decided_at: string | null;
  created_at: string;
  name_snapshot: string;
  option_snapshot: string | null;
  /**
   * A line bought under an offer, from its frozen `order_items.pricing_snapshot`: the regular unit
   * price just before the offer, and the offer's mode and percent. Null (or absent) otherwise.
   */
  offer_before_iqd?: number | null;
  offer_mode?: string | null;
  offer_percent?: number | null;
}

/** One frozen snapshot key of the line; NULL when the snapshot is not JSON (never an error). */
const snapshotKey = (path: string, as: string) =>
  `CASE WHEN json_valid(oi.pricing_snapshot) THEN json_extract(oi.pricing_snapshot, '${path}') END AS ${as}`;

const ROW_COLUMNS = `e.order_item_id, e.order_id, e.product_id, e.combo_key, e.channel, e.qty, e.estimate_unit_iqd,
       e.notice_version, e.state, e.final_unit_iqd, e.adjustment_id, e.decided_by, e.decided_at, e.created_at,
       oi.name_snapshot, oi.option_snapshot,
       ${snapshotKey('$.offer_before_iqd', 'offer_before_iqd')},
       ${snapshotKey('$.offer.offer_price_mode', 'offer_mode')},
       ${snapshotKey('$.offer.offer_discount_percent', 'offer_percent')}`;

/**
 * Every estimate record of one order, in line order (one indexed read,
 * `ix_ope_order`). Empty on a database without 0218; any other failure is
 * 503 PRICE_ESTIMATES_READ_FAILED — a settlement is never decided on a guess.
 */
export async function orderEstimateRows(db: Pick<D1Database, 'prepare'>, orderId: string): Promise<OrderEstimateRow[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT ${ROW_COLUMNS}
           FROM order_price_estimates e JOIN order_items oi ON oi.id = e.order_item_id
          WHERE e.order_id = ? ORDER BY oi.rowid`
      )
      .bind(orderId)
      .all<OrderEstimateRow>();
    return (results ?? []).filter((r) => isEstimateLineState(r.state));
  } catch (e) {
    if (isMissingTable(e)) return [];
    console.error('order estimate rows unreadable', orderId, e instanceof Error ? e.message : String(e));
    throw estimatesReadFailed();
  }
}

/** The order's estimate records that still hold it at «تم الاستلام» (open, proposed or rejected), in line order. */
export async function openEstimateLines(db: Pick<D1Database, 'prepare'>, orderId: string): Promise<OrderEstimateRow[]> {
  return (await orderEstimateRows(db, orderId)).filter((r) => isUnsettledEstimateState(r.state));
}

/**
 * THE ORDER READS' LINE STATE (`items[].price_estimate.state`): each
 * estimated line's record state, keyed by order item, for a page of orders in
 * one read. Read-only decoration: a database without 0218 answers an empty
 * map, and any other failure is logged and answers an empty map too — the
 * order itself still reads, and the gate (T8) is the database's, not this.
 */
export async function estimateStatesFor(db: Pick<D1Database, 'prepare'>, orderIds: readonly string[]): Promise<Map<string, EstimateLineState>> {
  const out = new Map<string, EstimateLineState>();
  const ids = [...new Set(orderIds.filter((x) => typeof x === 'string' && x !== ''))];
  if (!ids.length) return out;
  try {
    const { results } = await db
      .prepare('SELECT order_item_id, state FROM order_price_estimates WHERE order_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids))
      .all<{ order_item_id: string; state: string }>();
    for (const r of results ?? []) if (isEstimateLineState(r.state)) out.set(String(r.order_item_id), r.state);
  } catch (e) {
    if (!isMissingTable(e)) console.error('order estimate states unreadable', e instanceof Error ? e.message : String(e));
  }
  return out;
}

/**
 * Puts each line's estimate state on its own item row (`price_estimate_state`),
 * which `orderPublic` projects as `price_estimate: {state}`. One read for the
 * whole set of rows; rows of lines that are not estimates are left untouched.
 */
export async function attachEstimateStates(db: Pick<D1Database, 'prepare'>, items: Array<Record<string, unknown>>): Promise<Map<string, EstimateLineState>> {
  const states = await estimateStatesFor(db, items.map((it) => String(it.order_id ?? '')));
  if (states.size) {
    for (const it of items) {
      const state = states.get(String(it.id ?? ''));
      if (state) it.price_estimate_state = state;
    }
  }
  return states;
}

/** Does any of these item rows (with `attachEstimateStates` applied) hold its order at «تم الاستلام»? */
export function itemsHoldOrder(items: ReadonlyArray<Record<string, unknown>>): boolean {
  return items.some((it) => isUnsettledEstimateState(it.price_estimate_state));
}

/**
 * THE SKU × CHANNEL'S CURRENT PUBLISHED PRICE of each record — a final price a
 * customer could be charged today, never a cost — through the overlay every
 * customer read uses (its live rows; a V2 row before a V1 one). Null where the
 * SKU × channel has no live price; an unreadable view answers null for its lines.
 */
export async function currentUnitPrices(db: D1Database, rows: readonly OrderEstimateRow[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const ids = [...new Set(rows.map((r) => r.product_id))];
  if (!ids.length) return out;
  try {
    const { results } = await db
      .prepare('SELECT id, inventory_mode FROM products WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids))
      .all<{ id: string; inventory_mode: unknown }>();
    const views = await loadRelationsViews(db, results ?? []);
    for (const r of rows) {
      const live = (views.get(r.product_id)?.sku_prices ?? []).filter((p) => p.combo_key === r.combo_key && p.channel === r.channel);
      const pick = live.find((p) => p.v2 === true) ?? live[0];
      out.set(r.order_item_id, pick && Number.isSafeInteger(pick.regular_price_iqd) && pick.regular_price_iqd > 0 ? pick.regular_price_iqd : null);
    }
  } catch (e) {
    console.error('estimate current prices unreadable', e instanceof Error ? e.message : String(e));
  }
  return out;
}

/** The line's frozen regular unit price just before its offer, when it was bought under one; else null. */
export function offerBeforeUnitIqd(r: Pick<OrderEstimateRow, 'estimate_unit_iqd' | 'offer_before_iqd'>): number | null {
  const b = r.offer_before_iqd;
  // An offer always lowers the price, so a "before" at or under the estimate is no offer.
  return typeof b === 'number' && Number.isSafeInteger(b) && b > r.estimate_unit_iqd ? b : null;
}

/**
 * WHAT THE SAME OFFER GIVES ON TODAY'S PRICE, for a line bought under one. Its
 * estimate is the offer price, so today's published price is compared with the
 * frozen price before the offer, never with the estimate. A percent off is
 * re-applied as the offer computes it (worker/lib/offers.ts), when it gives
 * back the estimate; anything else keeps the same saving in dinars — which is
 * exactly what an amount off is. Null without a price today, or when the
 * answer is not a final price the settlement accepts.
 */
export function offerTodayUnitIqd(
  r: Pick<OrderEstimateRow, 'estimate_unit_iqd' | 'offer_before_iqd' | 'offer_mode' | 'offer_percent'>,
  currentUnitIqd: number | null
): number | null {
  const before = offerBeforeUnitIqd(r);
  const current = currentUnitIqd;
  if (before === null || current === null || !Number.isSafeInteger(current) || current <= 0) return null;
  let today: number | null = null;
  if (r.offer_mode === 'discount_percent' && typeof r.offer_percent === 'number' && Number.isFinite(r.offer_percent)) {
    // The offer's own clamp and rounding.
    const p = Math.min(90, Math.max(1, Math.trunc(r.offer_percent)));
    const off = (base: number) => roundPriceIqd({ num: BigInt(base) * BigInt(100 - p), den: 100n });
    if (off(before) === r.estimate_unit_iqd) {
      const t = off(current);
      // A window that no longer lowers the price sells at the price itself.
      today = t < current ? t : current;
    }
  }
  if (today === null) {
    const raw = r.estimate_unit_iqd + (current - before);
    today = raw >= 1 ? Math.min(roundPriceIqd(raw), current) : null;
  }
  return today !== null && isOnPriceRule(today) && today <= PRICE_ADJUST_MAX_IQD ? today : null;
}

/**
 * What any admin's order screen reads of one record: customer prices and the state, never a cost.
 * `currentUnitIqd`: today's published price as read (null: none today). A door that reads no price
 * today (the confirm answer) leaves it out: current_unit_iqd is then null and no same-offer price is named.
 */
export function estimateLineView(r: OrderEstimateRow, currentUnitIqd?: number | null) {
  const offerBefore = offerBeforeUnitIqd(r);
  return {
    order_item_id: r.order_item_id,
    name: r.name_snapshot,
    variant: r.option_snapshot ?? '',
    qty: r.qty,
    channel: r.channel,
    estimate_unit_iqd: r.estimate_unit_iqd,
    /** The SKU × channel's published price today (a final price), or null. */
    current_unit_iqd: currentUnitIqd ?? null,
    // Only on a line bought under an offer: the price before it (what today's price is compared
    // with) and, when today's price was read, the same offer on it (what «استخدم سعر اليوم بنفس العرض» proposes).
    ...(offerBefore !== null ? { offer_before_unit_iqd: offerBefore } : {}),
    ...(offerBefore !== null && currentUnitIqd !== undefined ? { offer_today_unit_iqd: offerTodayUnitIqd(r, currentUnitIqd) } : {}),
    final_unit_iqd: r.final_unit_iqd,
    state: r.state,
    adjustment_id: r.adjustment_id,
    decided_at: r.decided_at,
  };
}

// ------------------------------------------------------------------ the settlement

/**
 * The 0140 proposal's stored `reason` for an estimate settlement: the customer
 * reads the localized estimateReason (worker/lib/orderPriceAdjust.ts prints it
 * by `reason_code`); the stored text is the same sentence in the three
 * languages, which satisfies the 3–500 CHECK and serves an older reader.
 */
export const ESTIMATE_PROPOSAL_REASON = `${ESTIMATE_STRINGS.estimateReason.ar} / ${ESTIMATE_STRINGS.estimateReason.en} / ${ESTIMATE_STRINGS.estimateReason.ckb}`;

/** One line of a settlement request. */
export interface EstimateFinalLine {
  order_item_id: string;
  final_unit_iqd: number;
}

export interface ConfirmEstimateInput {
  orderId: string;
  /** The financial admin (the route holds `requireFinancialScope`). */
  adminId: string;
  idempotencyKey: string;
  /** EVERY open or rejected line, with its final unit price on the rounding rule. */
  lines: readonly EstimateFinalLine[];
  /** The financial admin's own final total (coupons and percentages are not re-derived); only with a changed line. */
  newTotalIqd?: number | null;
  /** The admin's optional words for the customer, added under the per-line old → new rows. */
  note?: string;
}

export type ConfirmEstimateResult =
  | { outcome: 'confirmed'; replayed: boolean; lines: OrderEstimateRow[] }
  | { outcome: 'proposed'; replayed: boolean; adjustment: PriceAdjustmentRow; lines: OrderEstimateRow[] };

const stale = (message: string, details?: Record<string, unknown>) => new HttpError(409, message, 'PRICE_ADJUST_STALE', details);

/** Integer dinars, grouped — language-neutral, for the per-line note every customer language reads. */
const grouped = (n: number): string => Math.trunc(n).toLocaleString('en-US');

/** One changed line of a settlement, as its customer reads it. */
export interface EstimateChangedLine {
  name: string;
  variant: string;
  qty: number;
  from: number;
  to: number;
}

/** «name — option × qty», trimmed. */
const rowLabel = (l: EstimateChangedLine): string => {
  const name = `${l.name}`.replace(/\s+/g, ' ').trim().slice(0, 80) || '—';
  const variant = `${l.variant}`.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${name}${variant ? ` — ${variant}` : ''} × ${l.qty}`;
};

/** The first rows that fit in `room` characters, one per line; a last «+N» says how many did not. */
function fitRows(rows: readonly string[], room: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < rows.length; i++) {
    const more = rows.length - i;
    const tail = more > 1 ? `\n+${more - 1}` : '';
    if (used + rows[i].length + 1 + tail.length > room) {
      kept.push(`+${more}`);
      break;
    }
    kept.push(rows[i]);
    used += rows[i].length + 1;
  }
  return kept;
}

/**
 * The proposal's `note`: one row per changed line, «name — option × qty:
 * estimate → final», then the admin's own words. Bounded by 0140's 1,000
 * characters: a long order keeps its first rows and says how many more.
 */
export function estimateProposalNote(changed: ReadonlyArray<EstimateChangedLine>, adminNote = ''): string {
  const own = adminNote.trim().slice(0, 300);
  const rows = changed.map((l) => `${rowLabel(l)}: ${grouped(l.from)} → ${grouped(l.to)}`);
  const kept = fitRows(rows, 1000 - (own ? own.length + 1 : 0));
  return [...kept, ...(own ? [own] : [])].join('\n').slice(0, 1000);
}

/**
 * The same-total notice's body in one language: one row per changed line,
 * «name — option × qty: estimate ← final» («→» in English, as the proposal's
 * in-app notice writes it), bounded like the note.
 */
export function estimateChangeRows(changed: ReadonlyArray<EstimateChangedLine>, lang: 'ar' | 'en' | 'ckb'): string {
  const arrow = lang === 'en' ? '→' : '←';
  return fitRows(changed.map((l) => `${rowLabel(l)}: ${iqdText(l.from, lang)} ${arrow} ${iqdText(l.to, lang)}`), 1000).join('\n');
}

/** The settlement's lines whose final differs from their estimate, in line order. */
function changedLines(unsettled: readonly OrderEstimateRow[], finals: ReadonlyMap<string, number>): EstimateChangedLine[] {
  return unsettled
    .filter((r) => finals.get(r.order_item_id) !== r.estimate_unit_iqd)
    .map((r) => ({ name: r.name_snapshot, variant: r.option_snapshot ?? '', qty: r.qty, from: r.estimate_unit_iqd, to: finals.get(r.order_item_id)! }));
}

/** The per-line update of a settlement: `{i, f, s, a}` = item, final, new state, adjustment id (or null). */
function settleLinesStatement(
  db: D1Database,
  orderId: string,
  plan: ReadonlyArray<{ i: string; f: number; s: 'confirmed' | 'proposed'; a: string | null }>,
  adminId: string,
  nowIso: string
): D1PreparedStatement {
  // Fenced on the states a settlement may move (open, rejected): a line the
  // customer's cancel voided, or another request settled, is not touched, and
  // the fence that follows this statement counts what moved.
  const pick = (field: string) =>
    `(SELECT json_extract(j.value, '$.${field}') FROM json_each(?1) j WHERE json_extract(j.value, '$.i') = order_price_estimates.order_item_id)`;
  return db
    .prepare(
      `UPDATE order_price_estimates
          SET state = ${pick('s')}, final_unit_iqd = ${pick('f')}, adjustment_id = ${pick('a')},
              decided_by = ?2, decided_at = ?3
        WHERE order_id = ?4 AND state IN ('open','rejected')
          AND order_item_id IN (SELECT json_extract(value, '$.i') FROM json_each(?1))`
    )
    .bind(JSON.stringify(plan), adminId, nowIso, orderId);
}

/**
 * «تأكيد السعر النهائي» — A FINANCIAL ADMIN SETTLES AN ORDER'S ESTIMATED LINES
 * (§6.5). See the header for the two outcomes. Replay-safe: the same request
 * again answers with what it did (a proposal by its deterministic 0140 id, a
 * confirmation by the lines' own settled state).
 *
 * Refusals: 404 (no order, or no estimate on it); 409 PRICE_APPROVAL_PENDING
 * while a proposal waits on the customer; 409 PRICE_ADJUST_STALE when the
 * request does not name exactly the open and rejected lines (or nothing is
 * left to settle); 400 PRICE_ADJUST_INVALID_TOTAL for a final price off the
 * rounding rule, or an edited total with no changed line; 409
 * IDEMPOTENCY_KEY_REUSED. The 0140 proposal's own refusals pass through as
 * `PriceAdjustError` (the route maps them).
 */
export async function confirmEstimateFinalPrices(env: Env, input: ConfirmEstimateInput): Promise<ConfirmEstimateResult> {
  const db = env.DB;
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(input.orderId).first<Record<string, unknown>>();
  if (!order) throw new HttpError(404, 'Order not found', 'NOT_FOUND');
  const rows = await orderEstimateRows(db, input.orderId);
  if (!rows.length) throw new HttpError(404, 'This order has no estimated prices to confirm.', 'NOT_FOUND');

  // 1. THE PROPOSAL THIS VERY REQUEST ALREADY MADE (0140's deterministic id).
  const pid = await proposalId(input.orderId, input.adminId, input.idempotencyKey);
  const prior = await loadAdjustment(db, pid);
  if (prior) {
    // The same key with another body is a different request: refused, never answered with this one.
    const linked = rows.filter((r) => r.adjustment_id === pid);
    const differs =
      prior.order_id !== input.orderId ||
      String(prior.reason_code ?? '') !== ESTIMATE_REASON_CODE ||
      (typeof input.newTotalIqd === 'number' && input.newTotalIqd !== prior.new_total_iqd) ||
      linked.some((r) => {
        const asked = input.lines.find((l) => l.order_item_id === r.order_item_id);
        return !asked || asked.final_unit_iqd !== r.final_unit_iqd;
      });
    if (differs) throw new HttpError(409, 'This idempotency key was already used for a different proposal.', 'IDEMPOTENCY_KEY_REUSED');
    return { outcome: 'proposed', replayed: true, adjustment: prior, lines: rows };
  }

  // 2. THE REQUEST'S SHAPE: one final per line, each on the one rounding rule (DECISIONS row 245).
  const finals = new Map<string, number>();
  for (const l of input.lines) {
    if (finals.has(l.order_item_id)) throw stale('A line is named twice — reload and retry.', { order_item_id: l.order_item_id });
    if (!isOnPriceRule(l.final_unit_iqd) || l.final_unit_iqd > PRICE_ADJUST_MAX_IQD) {
      throw new HttpError(
        400,
        'A final unit price must be whole dinars above zero — above 1,000 IQD a multiple of 250.',
        'PRICE_ADJUST_INVALID_TOTAL',
        { order_item_id: l.order_item_id }
      );
    }
    finals.set(l.order_item_id, l.final_unit_iqd);
  }

  const unsettled = rows.filter((r) => r.state === 'open' || r.state === 'rejected');
  if (!unsettled.length) {
    // 3. THE CONFIRMATION THIS REQUEST ALREADY MADE: every named line settled at the price it names.
    const byItem = new Map(rows.map((r) => [r.order_item_id, r]));
    const same =
      finals.size > 0 &&
      [...finals].every(([id, f]) => {
        const r = byItem.get(id);
        return !!r && (r.state === 'confirmed' || r.state === 'approved') && r.final_unit_iqd === f;
      });
    if (same) return { outcome: 'confirmed', replayed: true, lines: rows };
    if (isPriceHeld(order) || rows.some((r) => r.state === 'proposed')) {
      throw new HttpError(409, PRICE_APPROVAL_PENDING_MESSAGE, 'PRICE_APPROVAL_PENDING', { price_hold_id: order.price_hold_id ?? null });
    }
    // A cancelled order's lines are void: there is no final price left to settle.
    if (rows.every((r) => r.state === 'void')) throw stale('This order was cancelled — its estimated prices are void.');
    throw stale('Every estimated price of this order is already settled — reload.');
  }
  if (isPriceHeld(order)) {
    throw new HttpError(409, PRICE_APPROVAL_PENDING_MESSAGE, 'PRICE_APPROVAL_PENDING', { price_hold_id: order.price_hold_id });
  }
  // EVERY open or rejected line, and nothing else: a partial settlement would
  // leave the order held with a figure the customer was never shown.
  if (finals.size !== unsettled.length || unsettled.some((r) => !finals.has(r.order_item_id))) {
    throw stale('Name every line still waiting for its final price — reload and retry.', {
      order_item_ids: unsettled.map((r) => r.order_item_id),
    });
  }

  const total = Math.max(0, Math.trunc(Number(order.total_iqd) || 0));
  const delta = unsettled.reduce((s, r) => s + (finals.get(r.order_item_id)! - r.estimate_unit_iqd) * r.qty, 0);
  const changed = unsettled.some((r) => finals.get(r.order_item_id) !== r.estimate_unit_iqd);
  const edited = typeof input.newTotalIqd === 'number' ? input.newTotalIqd : null;
  if (edited !== null && !changed && edited !== total) {
    throw new HttpError(
      400,
      'No line’s price changed, so the total stays as it is — confirm the estimate first; an ordinary price change can follow.',
      'PRICE_ADJUST_INVALID_TOTAL'
    );
  }
  const target = edited ?? total + delta;
  if (!Number.isSafeInteger(target) || target <= 0 || target > PRICE_ADJUST_MAX_IQD) {
    throw new HttpError(400, 'The new total must be a whole number of dinars above zero.', 'PRICE_ADJUST_INVALID_TOTAL');
  }
  const nowIso = new Date().toISOString();

  if (target === total) return confirmWithoutMoney(env, order, unsettled, finals, input, nowIso);

  // 4. THE TOTAL CHANGES: the 0140 proposal, with the lines riding its batch.
  const plan = unsettled.map((r) => {
    const f = finals.get(r.order_item_id)!;
    return f === r.estimate_unit_iqd
      ? { i: r.order_item_id, f, s: 'confirmed' as const, a: null }
      : { i: r.order_item_id, f, s: 'proposed' as const, a: pid };
  });
  const note = estimateProposalNote(changedLines(unsettled, finals), input.note ?? '');
  const extra = [
    settleLinesStatement(db, input.orderId, plan, input.adminId, nowIso),
    // THE FENCE: every named line moved, and none is left open or rejected —
    // else the proposal's NOT NULL state aborts the whole batch, hold and all.
    // It writes pending → pending, which never fires T11.
    db
      .prepare(
        `UPDATE order_price_adjustments
            SET state = CASE WHEN changes() = ?2
                              AND NOT EXISTS (SELECT 1 FROM order_price_estimates e WHERE e.order_id = ?3 AND e.state IN ('open','rejected'))
                             THEN state ELSE NULL END
          WHERE id = ?1`
      )
      .bind(pid, plan.length, input.orderId),
  ];
  const res = await proposePriceAdjustment(env, {
    orderId: input.orderId,
    adminId: input.adminId,
    newTotalIqd: target,
    reason: ESTIMATE_PROPOSAL_REASON,
    note,
    idempotencyKey: input.idempotencyKey,
    reasonCode: ESTIMATE_REASON_CODE,
    extra,
  });
  return { outcome: 'proposed', replayed: res.replayed, adjustment: res.adjustment, lines: await orderEstimateRows(db, input.orderId) };
}

/**
 * THE SAME TOTAL: one batch — the lines `confirmed` at their finals, a fence,
 * the order's clock touched (the expiry sweep measures from the last write),
 * the customer's in-app notice, the audit. The notice is «… دون تغيير» when
 * every line kept its estimate; when some line moved (the differences cancel
 * out, or the admin kept the total) it says the total is unchanged and lists
 * the moved lines, estimate → final: their prices now govern returns and
 * price protection.
 */
async function confirmWithoutMoney(
  env: Env,
  order: Record<string, unknown>,
  unsettled: readonly OrderEstimateRow[],
  finals: ReadonlyMap<string, number>,
  input: ConfirmEstimateInput,
  nowIso: string
): Promise<ConfirmEstimateResult> {
  const db = env.DB;
  const orderId = input.orderId;
  const plan = unsettled.map((r) => ({ i: r.order_item_id, f: finals.get(r.order_item_id)!, s: 'confirmed' as const, a: null }));
  const guard = `estimate-settle:${orderId}`;
  const moved = changedLines(unsettled, finals);
  const text = fillEstimateText(moved.length ? ESTIMATE_STRINGS.confirmedTotalUnchanged : ESTIMATE_STRINGS.confirmedNoChange, { id: orderId });
  // Deterministic per (order, admin, key), like 0140's proposal id: a replay's notice is the same row.
  const confirmId = `pest_${(await sha256Hex(`${orderId}:${input.adminId}:${input.idempotencyKey}`)).slice(0, 24)}`;
  const notice = notifyStatement(db, {
    userId: String(order.user_id),
    kind: 'order_update',
    title_ar: text.ar,
    title_en: text.en,
    ...(moved.length ? { body_ar: estimateChangeRows(moved, 'ar'), body_en: estimateChangeRows(moved, 'en') } : {}),
    link: `/orders/${encodeURIComponent(orderId)}`,
    entity_type: 'order',
    entity_id: orderId,
    meta: { title_ckb: text.ckb, ...(moved.length ? { body_ckb: estimateChangeRows(moved, 'ckb') } : {}), price_estimate: 'confirmed' },
    eventKey: `order.price_estimate.confirmed:${confirmId}`,
  });
  const audit = await auditStatements(db, input.adminId, 'order.price_estimate.confirm', orderId, {
    confirm_id: confirmId,
    total_iqd: Math.trunc(Number(order.total_iqd) || 0),
    lines: unsettled.map((r) => ({ order_item_id: r.order_item_id, qty: r.qty, estimate_unit_iqd: r.estimate_unit_iqd, final_unit_iqd: finals.get(r.order_item_id)!, from: r.state })),
  });
  try {
    await db.batch([
      settleLinesStatement(db, orderId, plan, input.adminId, nowIso),
      // THE FENCE (ops_guards.ok CHECK = 1): every named line moved, nothing is
      // left waiting, and the order is still pending with no proposal on it.
      db
        .prepare(
          `INSERT INTO ops_guards (id, ok)
           SELECT ?1, CASE WHEN changes() = ?2
                            AND NOT EXISTS (SELECT 1 FROM order_price_estimates e WHERE e.order_id = ?3 AND e.state IN ('open','proposed','rejected'))
                            AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ?3 AND o.status = 'pending' AND o.price_hold_id IS NULL)
                           THEN 1 ELSE 0 END`
        )
        .bind(guard, plan.length, orderId),
      db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(guard),
      db.prepare("UPDATE orders SET updated_at = ?1 WHERE id = ?2 AND status = 'pending'").bind(nowIso, orderId),
      notice.stmt,
      ...audit.statements,
    ]);
  } catch (e) {
    // The same request racing itself, or a cancel / proposal that landed first.
    const now = await orderEstimateRows(db, orderId);
    const byItem = new Map(now.map((r) => [r.order_item_id, r]));
    const done = [...finals].every(([id, f]) => {
      const r = byItem.get(id);
      return !!r && r.state === 'confirmed' && r.final_unit_iqd === f;
    });
    if (done) return { outcome: 'confirmed', replayed: true, lines: now };
    if (/constraint|NOT NULL|CHECK/i.test(e instanceof Error ? e.message : String(e))) {
      throw stale('The order changed while you were confirming — reload and retry.');
    }
    throw e;
  }
  return { outcome: 'confirmed', replayed: false, lines: await orderEstimateRows(db, orderId) };
}
