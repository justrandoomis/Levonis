/**
 * FIFO — «كل عملية بيع تستهلك أقدم دفعة تكلفة متاحة أولًا».
 *
 * Twenty units on a shelf may have been bought at two prices. `inventory_ledger`
 * already knows how many there are; this file knows what each of them cost, and
 * which ones a sale actually ate.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT MOVE STOCK. `worker/lib/inventory.ts` does that, and it is good
 * at it: one authoritative rung per product, guards in the WHERE clause, a
 * UNIQUE idempotency key, and statements the caller appends to its OWN batch so
 * the order and its deduction commit together. Nothing here duplicates a single
 * line of it.
 *
 * What this adds is the COST dimension the counters cannot express. Every
 * function below returns STATEMENTS for the caller's existing batch, for
 * exactly the reason `planInventory` does: a lot consumed in a second
 * transaction is a window in which the shelf and its cost disagree.
 *
 * ---------------------------------------------------------------------------
 * THE QUEUE IS PER (scope, scope_id), WHICH IS THE LEDGER'S OWN IDENTITY.
 *
 * Not per product. §22: black must not consume white's older lot merely because
 * it is older, and it cannot — white's lots are in a different queue. The four
 * stock scopes have lots; 'preorder' and 'preorder_transport' do not, because
 * capacity is a promise to import and not a unit on a shelf (§65).
 *
 * ---------------------------------------------------------------------------
 * ALLOCATION HAPPENS AT `deduct`, NOT AT `reserve`.
 *
 * A reservation holds a QUANTITY, and that is what stops an oversell — it
 * already works, and §34 forbids a second mechanism for it. A lot is a COST
 * fact, and a cost becomes real when the sale does. §36 then costs nothing: an
 * order cancelled before confirmation released no lots because it consumed
 * none, and one cancelled after restores to the exact rows recorded here.
 */

import type { StockMove, StockScope } from './inventory';

/** Lots exist only for units on a shelf. Capacity scopes are promises. */
export const LOT_SCOPES: readonly StockScope[] = ['base', 'option', 'color', 'variant'];

export const hasLots = (scope: StockScope): boolean =>
  (LOT_SCOPES as readonly string[]).includes(scope);

// ===========================================================================
//  MONEY: INTEGER DINARS, AND THE REMAINDER IS NOT LOST
// ===========================================================================

/**
 * Split `total` into `parts` integer shares that sum to EXACTLY `total`.
 *
 * §14. 500,000 dinars of shipping over 7 units is 71,428.571…, and three
 * plausible-looking ways to handle that all lose money:
 *
 *   round()  → 71,429 × 7 = 500,003. The shop's books gain three dinars from
 *              nowhere, every time, and finance stops reconciling.
 *   floor()  → 71,428 × 7 = 499,996. Four dinars of real freight vanish.
 *   float    → 71428.571428571… stored, and the sum depends on the order of
 *              addition. §84 forbids floating-point money outright.
 *
 * The largest-remainder rule instead: everyone gets `floor(total/parts)`, and
 * the first `total mod parts` shares get one dinar more. The sum is exactly
 * `total` by construction — not approximately, and not for most inputs.
 *
 * DETERMINISTIC, because the alternative is worse than inexact. Handing the
 * extra dinars to the FIRST shares rather than to random ones means the same
 * purchase received twice in the same two parts produces the same two lots,
 * so a figure the owner checked yesterday is the same figure today.
 *
 * A negative total is refused rather than clamped: a negative freight cost is
 * a data-entry fault, and silently reading it as zero would hide it.
 */
export function splitExact(total: number, parts: number): number[] {
  if (!Number.isInteger(total) || total < 0) throw new Error('splitExact: total must be a non-negative integer');
  if (!Number.isInteger(parts) || parts <= 0) throw new Error('splitExact: parts must be a positive integer');
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * What ONE receipt of `qty` units out of a purchase of `qtyOrdered` costs.
 *
 * §33: a purchase of ten received as six then four must have its freight split
 * so the two lots together account for the whole freight bill and not a dinar
 * more. So the shares are computed against the ORDERED quantity — the basis the
 * freight was actually incurred for — and this receipt takes the slice of that
 * split belonging to the units it is receiving.
 *
 * `alreadyReceived` is what makes the second receipt take the SECOND slice
 * rather than the first one again: units 0..5 went to the earlier lot, so this
 * one starts at 6. Without it two partial receipts of an odd total would both
 * claim the extra dinars and the purchase would over-account by exactly the
 * remainder.
 *
 * Returns nulls where a component has not been entered. §13: not-entered is not
 * zero, and a lot built on a missing number would be a fact invented from a
 * blank box.
 */
export interface LotCostInput {
  purchaseUnitIqd: number;
  /** null = not entered yet. 0 = genuinely free. */
  shippingTotalIqd: number | null;
  internalDeliveryTotalIqd: number | null;
  qtyOrdered: number;
  qtyThisReceipt: number;
  alreadyReceived: number;
}

export interface LotCostBreakdown {
  /** null when any component is unstated — the lot is then unpriceable. */
  unitCostIqd: number | null;
  purchaseUnitIqd: number;
  shippingShareIqd: number | null;
  internalShareIqd: number | null;
  totalCostIqd: number | null;
  /** True when every component was stated and the lot can be priced. */
  complete: boolean;
}

export function lotCostBreakdown(input: LotCostInput): LotCostBreakdown {
  const { purchaseUnitIqd, shippingTotalIqd, internalDeliveryTotalIqd } = input;
  const qty = Math.max(0, Math.floor(input.qtyThisReceipt));
  const ordered = Math.max(1, Math.floor(input.qtyOrdered));
  const from = Math.max(0, Math.floor(input.alreadyReceived));

  const slice = (total: number | null): number | null => {
    if (total === null || total === undefined) return null;
    const shares = splitExact(total, ordered);
    // The units this receipt is taking, from where the last one stopped. A
    // receipt that runs past the ordered quantity cannot happen (the route and
    // a CHECK both refuse it), and `slice` clamping rather than throwing keeps
    // this function total for a caller previewing an oversized draft.
    return shares.slice(from, from + qty).reduce((n, x) => n + x, 0);
  };

  const shippingShareIqd = slice(shippingTotalIqd);
  const internalShareIqd = slice(internalDeliveryTotalIqd);
  const complete = shippingShareIqd !== null && internalShareIqd !== null;

  if (!complete || qty === 0) {
    return {
      unitCostIqd: null,
      purchaseUnitIqd,
      shippingShareIqd,
      internalShareIqd,
      totalCostIqd: null,
      complete: false,
    };
  }

  // The lot's TOTAL is the honest figure — purchase for these units plus their
  // exact slice of each freight bill. The per-unit cost is derived from it, and
  // it is the per-unit figure that rounds, never the total: a lot of 7 whose
  // total is 3,000,001 has a unit cost of 428,571.57…, and FIFO consumes units.
  const purchaseTotal = purchaseUnitIqd * qty;
  const totalCostIqd = purchaseTotal + shippingShareIqd! + internalShareIqd!;
  return {
    // Rounded per unit for display and for allocation arithmetic; the exact
    // total is stored beside it so the lot always reconciles to what was paid.
    unitCostIqd: Math.round(totalCostIqd / qty),
    purchaseUnitIqd,
    shippingShareIqd,
    internalShareIqd,
    totalCostIqd,
    complete: true,
  };
}

// ===========================================================================
//  THE QUEUE
// ===========================================================================

export interface LotRow {
  id: string;
  product_id: string | null;
  scope: StockScope;
  scope_id: string;
  qty_remaining: number;
  unit_cost_iqd: number | null;
  received_at: string;
}

const identityKey = (scope: string, scopeId: string) => `${scope}:${scopeId}`;

/**
 * Which of this order's lines have already been allocated.
 *
 * BY `order_id`, NOT BY A LIKE ON THE KEY, and that is not a style preference.
 * D1 caps a LIKE/GLOB pattern at FIFTY BYTES, and the obvious
 * `idempotency_key LIKE 'alloc:<order>:<item>:%'` is 6 + 24 + 1 + 24 + 1 = 56
 * bytes with this project's real ids — over the cap, and the way it fails is
 * the bad way: the query errors or matches nothing, every line looks
 * un-allocated, and a replayed confirmation consumes the lots a second time.
 * This repo has already lost a product-delete to exactly that cap.
 *
 * `order_id` is indexed (idx_alloc_order), the row already carries the line id,
 * and one equality read answers the whole order.
 */
async function appliedAllocationLines(db: D1Database, orderId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT order_item_id FROM order_item_inventory_allocations
        WHERE order_id = ? AND released_at IS NULL`
    )
    .bind(orderId)
    .all<{ order_item_id: string }>();
  return new Set((results ?? []).map((r) => r.order_item_id));
}

/**
 * The lots available for a set of identities, oldest first.
 *
 * ONE QUERY FOR THE WHOLE BASKET, not one per line. A bundle can name a dozen
 * components and the hottest path in the shop is checkout; a sequential read
 * would scale its latency linearly for no reason — the same argument
 * `planInventory` makes about reading stock rows.
 *
 * `ORDER BY received_at, id` and not `received_at` alone. Two lots received in
 * the same millisecond must still have ONE order, or two replays of the same
 * consumption could pick different lots and produce two different COGS for one
 * sale. The id is the tiebreak and the index carries it.
 */
export async function fifoQueues(
  db: D1Database,
  identities: ReadonlyArray<{ scope: StockScope; scope_id: string }>
): Promise<Map<string, LotRow[]>> {
  const out = new Map<string, LotRow[]>();
  const wanted = identities.filter((i) => hasLots(i.scope));
  if (wanted.length === 0) return out;

  // Chunked for the same reason inventory.ts chunks: D1 caps bound parameters,
  // and a bundle multiplies the identity count without an obvious bound.
  const CHUNK = 40;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const part = wanted.slice(i, i + CHUNK);
    const where = part.map(() => '(scope = ? AND scope_id = ?)').join(' OR ');
    const args = part.flatMap((p) => [p.scope, p.scope_id]);
    const { results } = await db
      .prepare(
        `SELECT id, product_id, scope, scope_id, qty_remaining, unit_cost_iqd, received_at
           FROM inventory_lots
          WHERE qty_remaining > 0 AND (${where})
          ORDER BY received_at ASC, id ASC`
      )
      .bind(...args)
      .all<LotRow>();
    for (const row of results ?? []) {
      const key = identityKey(row.scope, row.scope_id);
      const list = out.get(key);
      if (list) list.push(row);
      else out.set(key, [row]);
    }
  }
  return out;
}

// ===========================================================================
//  CONSUMPTION
// ===========================================================================

export interface PlannedAllocation {
  order_item_id: string;
  lot_id: string;
  scope: StockScope;
  scope_id: string;
  qty: number;
  unit_cost_iqd: number | null;
  cogs_iqd: number | null;
}

export interface LotPlan {
  statements: D1PreparedStatement[];
  allocations: PlannedAllocation[];
  /**
   * Units the queue could not cover. ZERO in every healthy shop, because the
   * counters and the lots are kept equal in the same batch — see
   * docs/INVENTORY-DECISIONS.md §7. It is reported rather than thrown on: a
   * bookkeeping gap must not refuse a customer's paid order, and finance
   * already knows how to say that part of a COGS is unknown.
   */
  shortfall: Array<{ order_item_id: string; scope: StockScope; scope_id: string; qty: number }>;
  /** How many allocation rows the statements will write when every guard holds. */
  plannedRows: number;
}

const EMPTY: LotPlan = { statements: [], allocations: [], shortfall: [], plannedRows: 0 };

/**
 * Plans the FIFO consumption for one order's deduction.
 *
 * The moves are the ones `orderInventory.movesFor()` reconstructs from the
 * RESERVE ledger rows, so `line_id` is the order item id, `targets[0]` is the
 * exact stock identity that was held, and `qty` is what is being deducted.
 * Recomputing any of that from the product's current shape is what that
 * module's header forbids, and this inherits the guarantee for free.
 *
 * TWO STATEMENTS PER LOT TOUCHED, IN THIS ORDER AND WITH THE SAME GUARD:
 *
 *   1. INSERT the allocation, guarded on the lot still holding the units.
 *   2. UPDATE the lot, guarded identically.
 *
 * The INSERT first and evaluated against the pre-update state, exactly as
 * `planInventory` orders its ledger row before its counter — under a
 * concurrent change the two then agree, and an allocation can never claim
 * units a lot did not give up. The UNIQUE `idempotency_key` is the final race
 * guard: the loser's INSERT violates it and D1 rolls that caller's whole batch
 * back, counters and lots together.
 *
 * A REPLAY WRITES NOTHING. The key is `alloc:<orderId>:<itemId>:<lotId>`, so a
 * retried confirmation finds every row present and its INSERTs are no-ops.
 */
export async function planLotConsumption(
  db: D1Database,
  orderId: string,
  moves: readonly StockMove[]
): Promise<LotPlan> {
  const relevant = moves
    .flatMap((m) => m.targets.map((t) => ({ move: m, target: t })))
    .filter((x) => hasLots(x.target.scope) && x.move.qty > 0);
  if (relevant.length === 0) return EMPTY;

  /**
   * ALREADY-APPLIED KEYS ARE READ FIRST AND SKIPPED WHOLE — the same thing
   * `planInventory` does before it plans anything, and for a reason this file
   * learned the hard way.
   *
   * The first design guarded the lot UPDATE on its allocation row existing,
   * so that the two statements could not disagree. They could not — but the
   * guard cannot tell "this INSERT just wrote it" from "last run wrote it", so
   * a REPLAYED confirmation found the row present, passed the guard, and
   * decremented the lot a second time. A double-tapped confirm silently ate
   * four more units of a ten-unit lot.
   *
   * So a key that is already present means the work is already done: the lot
   * is not re-read, not re-planned and not touched. The UNIQUE index stays as
   * the last-resort guard for a genuine race, where two callers plan at once
   * and neither can see the other's row yet — there the loser's INSERT
   * violates it and D1 rolls that caller's whole batch back, lots included.
   *
   * WHICH IS WHY THAT INSERT IS HARD AND NOT `OR IGNORE`. `OR IGNORE` would
   * make the loser's duplicate a silent no-op while the lot UPDATE beside it —
   * which only asks whether the lot still holds enough — went ahead and
   * decremented a second time. The sentence above would be a description of
   * something the code did not do.
   */
  const applied = await appliedAllocationLines(db, orderId);

  const queues = await fifoQueues(
    db,
    relevant.map((x) => ({ scope: x.target.scope, scope_id: x.target.scope_id }))
  );

  // A RUNNING SIMULATION, not a fresh read per line. Two lines of one order may
  // resolve to the SAME identity — a bundle holding two spools of one colour,
  // or two cart lines of one product — and judging each against the queue's
  // full remaining quantity would allocate the same units twice. The same
  // reasoning `planInventory` applies to its stock rows.
  const remaining = new Map<string, number[]>();
  for (const [key, lots] of queues) remaining.set(key, lots.map((l) => l.qty_remaining));

  const statements: D1PreparedStatement[] = [];
  const allocations: PlannedAllocation[] = [];
  const shortfall: LotPlan['shortfall'] = [];

  for (const { move, target } of relevant) {
    const key = identityKey(target.scope, target.scope_id);
    const lots = queues.get(key) ?? [];
    const left = remaining.get(key) ?? [];
    let need = move.qty;

    // This line was already allocated by an earlier run. Nothing to plan, and
    // nothing to subtract from the simulation either: the lots it consumed are
    // already absent from the queue, because `fifoQueues` reads their CURRENT
    // remaining quantity.
    if (applied.has(move.line_id)) continue;

    for (let i = 0; i < lots.length && need > 0; i++) {
      const available = left[i];
      if (available <= 0) continue;
      const take = Math.min(available, need);
      const lot = lots[i];
      left[i] = available - take;
      need -= take;

      const unitCost = lot.unit_cost_iqd;
      const alloc: PlannedAllocation = {
        order_item_id: move.line_id,
        lot_id: lot.id,
        scope: target.scope,
        scope_id: target.scope_id,
        qty: take,
        unit_cost_iqd: unitCost,
        // NULL, never 0, when the lot's cost is unknown. §5 of the decisions
        // doc: a zero here would report 100% margin on a unit nobody knows the
        // cost of, which is not a small error — it is a number the owner would
        // act on.
        cogs_iqd: unitCost === null ? null : unitCost * take,
      };
      allocations.push(alloc);

      const idem = `alloc:${orderId}:${move.line_id}:${lot.id}`;
      statements.push(
        db
          .prepare(
            `INSERT INTO order_item_inventory_allocations
               (id, order_id, order_item_id, lot_id, scope, scope_id, qty, unit_cost_iqd, cogs_iqd, idempotency_key)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
              WHERE EXISTS (SELECT 1 FROM inventory_lots WHERE id = ?4 AND qty_remaining >= ?7)`
          )
          .bind(
            `ialloc_${idem.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 120),
            orderId,
            move.line_id,
            lot.id,
            target.scope,
            target.scope_id,
            take,
            unitCost,
            alloc.cogs_iqd,
            idem
          )
      );
      statements.push(
        db
          .prepare(
            `UPDATE inventory_lots SET qty_remaining = qty_remaining - ?1
              WHERE id = ?2 AND qty_remaining >= ?1`
          )
          .bind(take, lot.id)
      );
    }

    if (need > 0) {
      shortfall.push({ order_item_id: move.line_id, scope: target.scope, scope_id: target.scope_id, qty: need });
    }
  }

  return { statements, allocations, shortfall, plannedRows: allocations.length };
}

/**
 * Plans the return of an order's units to THE LOTS THEY CAME FROM.
 *
 * §36/§37, and the reason this is not "add them to the newest lot": a unit
 * bought at 450,000 and returned is still a unit that cost 450,000. Crediting
 * it to today's 560,000 layer would invent 110,000 dinars of inventory value
 * out of a refund, and the next sale would then report a cost the shop never
 * paid.
 *
 * `lineIds` narrows it to one returned line; omitted, it returns the whole
 * order. Quantities are capped at what was allocated, so a partial return of a
 * multi-unit line gives back exactly what came back and never more.
 */
export async function planLotRestore(
  db: D1Database,
  orderId: string,
  opts: { lineIds?: readonly string[]; qtyByLine?: Record<string, number>; operation?: string } = {}
): Promise<LotPlan> {
  const { results } = await db
    .prepare(
      `SELECT id, order_item_id, lot_id, scope, scope_id, qty, unit_cost_iqd
         FROM order_item_inventory_allocations
        WHERE order_id = ? AND released_at IS NULL
        ORDER BY id`
    )
    .bind(orderId)
    .all<{
      id: string;
      order_item_id: string;
      lot_id: string;
      scope: StockScope;
      scope_id: string;
      qty: number;
      unit_cost_iqd: number | null;
    }>();

  const rows = (results ?? []).filter((r) => !opts.lineIds || opts.lineIds.includes(r.order_item_id));
  if (rows.length === 0) return EMPTY;

  const operation = opts.operation ?? 'return';

  /**
   * THE RELEASES THIS ORDER HAS ALREADY RECORDED, so a second call plans none
   * of them again.
   *
   * The consumption rows this walks are matched on `released_at IS NULL` and a
   * release is a SEPARATE row, so the consumption row stays visible for ever —
   * which means a repeated return read exactly the same rows and planned
   * exactly the same restore. That was survivable only by accident, thanks to
   * the `qty_remaining + ? <= qty_received` cap, and only while the lot had no
   * room: a lot of 10 that had sold 4 to this order and 6 to another, then had
   * this order returned, would take the replay's +4 as well and claim 8 units
   * on a shelf holding 4.
   *
   * An equality read on `order_id`, not a LIKE over the key: D1 caps a LIKE
   * pattern at 50 BYTES and these keys are longer than that with real ids.
   */
  const releasedKeys = await db
    .prepare(
      `SELECT idempotency_key FROM order_item_inventory_allocations
        WHERE order_id = ? AND released_at IS NOT NULL`
    )
    .bind(orderId)
    .all<{ idempotency_key: string }>();
  const released = new Set((releasedKeys.results ?? []).map((r) => r.idempotency_key));
  const budget = new Map<string, number>();
  if (opts.qtyByLine) for (const [k, v] of Object.entries(opts.qtyByLine)) budget.set(k, Math.max(0, Math.floor(v)));

  const statements: D1PreparedStatement[] = [];
  const allocations: PlannedAllocation[] = [];

  for (const r of rows) {
    // NEWEST ALLOCATION FIRST would be the intuitive order for a partial
    // return, but it is not the honest one: the rows are walked in creation
    // order so a partial return gives back the units the sale took FIRST,
    // which is the same layer FIFO would next consume. Either choice is
    // defensible; this one is deterministic and matches the direction of
    // travel, so a return and an immediate re-sale leave the shelf where it
    // started.
    let give = r.qty;
    if (opts.qtyByLine) {
      const left = budget.get(r.order_item_id) ?? 0;
      if (left <= 0) continue;
      give = Math.min(r.qty, left);
      budget.set(r.order_item_id, left - give);
    }
    if (give <= 0) continue;

    const idem = `${operation}:${orderId}:${r.id}:${give}`;
    // Already given back. Skipped whole — not re-planned and not re-guarded.
    if (released.has(idem)) continue;
    statements.push(
      db
        .prepare(
          // Hard, for the reason `planLotConsumption` spells out: `OR IGNORE`
          // plus a guard that asks whether the row EXISTS lets a racer's
          // duplicate no-op while its UPDATE credits the lot a second time.
          `INSERT INTO order_item_inventory_allocations
             (id, order_id, order_item_id, lot_id, scope, scope_id, qty, unit_cost_iqd, cogs_iqd, idempotency_key, released_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        )
        .bind(
          `ialloc_${idem.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 120),
          orderId,
          r.order_item_id,
          r.lot_id,
          r.scope,
          r.scope_id,
          // A NEGATIVE qty would break the CHECK; the release is recorded as a
          // positive row carrying `released_at`, which is what makes the two
          // distinguishable in a report without a sign convention nobody
          // remembers.
          give,
          r.unit_cost_iqd,
          r.unit_cost_iqd === null ? null : r.unit_cost_iqd * give,
          idem
        )
    );
    statements.push(
      db
        .prepare(
          // The cap stays: a lot may never hold more than it received. The
          // `EXISTS` that used to sit beside it is gone — it was the thing that
          // made the replay possible, not the thing that prevented it.
          `UPDATE inventory_lots SET qty_remaining = qty_remaining + ?1
            WHERE id = ?2 AND qty_remaining + ?1 <= qty_received`
        )
        .bind(give, r.lot_id)
    );
    allocations.push({
      order_item_id: r.order_item_id,
      lot_id: r.lot_id,
      scope: r.scope,
      scope_id: r.scope_id,
      qty: give,
      unit_cost_iqd: r.unit_cost_iqd,
      cogs_iqd: r.unit_cost_iqd === null ? null : r.unit_cost_iqd * give,
    });
  }

  return { statements, allocations, shortfall: [], plannedRows: allocations.length };
}

/**
 * The COGS of one order line, from its immutable allocations.
 *
 * `known` is false when ANY consumed lot had no cost. Finance then says the
 * cost is partly unknown rather than reporting the known part as the whole —
 * §68's honesty rule, and the difference between "this sold at 90% margin" and
 * "we do not know what this cost".
 */
export interface LineCogs {
  order_item_id: string;
  qty: number;
  cogs_iqd: number;
  known: boolean;
  lots: number;
}

export async function cogsByLine(db: D1Database, orderIds: readonly string[]): Promise<Map<string, LineCogs>> {
  const out = new Map<string, LineCogs>();
  if (orderIds.length === 0) return out;
  const CHUNK = 40;
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const part = orderIds.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(
        `SELECT order_item_id,
                -- A release carries released_at, so it SUBTRACTS: a returned
                -- unit was not a cost of goods sold.
                SUM(CASE WHEN released_at IS NULL THEN qty ELSE -qty END) AS qty,
                SUM(CASE WHEN released_at IS NULL THEN COALESCE(cogs_iqd, 0) ELSE -COALESCE(cogs_iqd, 0) END) AS cogs,
                SUM(CASE WHEN cogs_iqd IS NULL THEN 1 ELSE 0 END) AS unknown_rows,
                COUNT(DISTINCT lot_id) AS lots
           FROM order_item_inventory_allocations
          WHERE order_id IN (${part.map(() => '?').join(',')})
          GROUP BY order_item_id`
      )
      .bind(...part)
      .all<{ order_item_id: string; qty: number; cogs: number; unknown_rows: number; lots: number }>();
    for (const r of results ?? []) {
      out.set(r.order_item_id, {
        order_item_id: r.order_item_id,
        qty: Number(r.qty) || 0,
        cogs_iqd: Number(r.cogs) || 0,
        known: Number(r.unknown_rows) === 0,
        lots: Number(r.lots) || 0,
      });
    }
  }
  return out;
}
