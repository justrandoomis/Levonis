/**
 * INVENTORY — mandate §7: "منطق المخزون يجب أن يكون صريحًا بلا جمع مزدوج".
 *
 * THE ONE RULE. Every sellable selection resolves to exactly ONE authoritative
 * stock row. Stock levels are never added together across levels, and a level
 * that is not authoritative is never consulted to override one that is — in
 * particular, "إذا كان المنتج يعتمد مخزون اللون ... ولا يُستخدم مخزون المنتج
 * الأساسي لتجاوز نفاد اللون".
 *
 * The product's `inventory_mode` column chooses the level explicitly:
 *
 *   BASE                 products.stock / products.stock_reserved
 *   OPTION               the selected option VALUES
 *   COLOR                the selected colour
 *   VARIANT_COMBINATION  the product_variants row for the exact combination
 *
 * OPTION mode and multiple groups. A value whose `stock` is NULL does not
 * track stock and is ignored. Availability is the MINIMUM over the tracked
 * selected values, and a purchase decrements every one of them. Minimum, never
 * sum — the forbidden "double counting" is adding levels together, and the
 * common real case (only one group carries stock) reduces to exactly that one
 * row. Every consumed row is still recorded separately in the ledger, so the
 * audit trail shows what actually moved.
 *
 * VARIANT_COMBINATION mode. A combination with no `product_variants` row is
 * NOT sellable. It does not fall back to base stock: silently selling an
 * unmodelled combination is precisely the oversell this mode exists to
 * prevent.
 *
 * IDEMPOTENCY. Reserve, deduct and restore each write `inventory_ledger` rows
 * whose `idempotency_key` is UNIQUE. A repeat call — a retried checkout, a
 * duplicated webhook, a double-tapped cancel — finds the key already present
 * and performs NOTHING, returning `applied: 0`. The UNIQUE index is the
 * last-resort guard for a genuine race: it aborts the whole D1 batch, so a
 * second deduction can never be committed alongside a first.
 *
 * ATOMICITY. All statements for one operation go through `db.batch`, which D1
 * runs in a single transaction. Guards live inside the WHERE clause and the
 * CHECK constraints, so an oversell aborts the batch instead of writing a
 * negative row.
 */

import { InventoryChangedV1 } from '@levonis/contracts/events/v1/InventoryChanged';
import { outboxStatement } from './eventBus';

export type InventoryMode = 'BASE' | 'OPTION' | 'COLOR' | 'VARIANT_COMBINATION';

export const INVENTORY_MODES: readonly InventoryMode[] = [
  'BASE',
  'OPTION',
  'COLOR',
  'VARIANT_COMBINATION',
];

export function isInventoryMode(v: unknown): v is InventoryMode {
  return typeof v === 'string' && (INVENTORY_MODES as readonly string[]).includes(v);
}

/**
 * The six authoritative counters. The first four are STOCK — units on a shelf,
 * chosen by `products.inventory_mode`. The last two are PRE-ORDER CAPACITY
 * (migration 0075) — how many units the owner has undertaken to import — and
 * they are reached only when the line's ORDER TYPE is `pre_order`.
 *
 *   preorder            product_option_fulfillment.capacity — the SHARED pool
 *                       of one (model x pre-order) cell. Air, sea and land all
 *                       draw on it unless a route holds its own quota.
 *   preorder_transport  product_option_transports.capacity — one route's OWN
 *                       quota, independent of the pool and of the other routes.
 *
 * A capacity row is a stock row with different column names: an on-hand number,
 * a reserved number, and the same five verbs. That is why it is a `StockScope`
 * and not a parallel engine — `planInventory`, `applyMoves`, `stockAfter` and
 * the reservation fence all work on it unchanged.
 */
export type StockScope =
  | 'base'
  | 'option'
  | 'color'
  | 'variant'
  | 'preorder'
  | 'preorder_transport';

/**
 * WHERE EACH SCOPE'S TWO NUMBERS LIVE. One table, in one place, because three
 * separate `scope === 'base' ? … : …` ladders is how a capacity write ends up
 * pointed at `stock` on a table that has no such column.
 */
const SCOPE_COLUMNS: Record<StockScope, { table: string; stock: string; reserved: string }> = {
  base: { table: 'products', stock: 'stock', reserved: 'stock_reserved' },
  option: { table: 'product_option_values', stock: 'stock', reserved: 'reserved' },
  color: { table: 'product_colors', stock: 'stock', reserved: 'reserved' },
  variant: { table: 'product_variants', stock: 'stock', reserved: 'reserved' },
  preorder: { table: 'product_option_fulfillment', stock: 'capacity', reserved: 'capacity_reserved' },
  preorder_transport: {
    table: 'product_option_transports',
    stock: 'capacity',
    reserved: 'capacity_reserved',
  },
};

/** The four scopes `products.inventory_mode` chooses between — the ones whose
 *  number is a physical shelf. A capacity scope is never one of these. */
export const STOCK_SCOPES: readonly StockScope[] = ['base', 'option', 'color', 'variant'];

export const isCapacityScope = (scope: StockScope): boolean =>
  scope === 'preorder' || scope === 'preorder_transport';

/** One authoritative row that a purchase consumes. */
export interface StockTarget {
  scope: StockScope;
  /** '' for base. */
  scope_id: string;
  /** on-hand quantity; null = this row does not track stock */
  stock: number | null;
  reserved: number;
  low_stock_threshold: number | null;
  label: string;
}

export interface StockResolution {
  /** Rows a purchase decrements. Empty + tracked=false means "not tracked". */
  targets: StockTarget[];
  tracked: boolean;
  /** Units available for sale right now: min(stock - reserved) over targets.
   *  `null` means untracked (no limit is claimed). */
  available: number | null;
  /** Machine-readable reason when the selection cannot be sold at all.
   *  `resolveStock` itself never returns `COMPONENT_UNAVAILABLE`: it is the
   *  composition read model's verdict for a bundle component whose member
   *  product went draft or archived. A stock row can still hold units for a
   *  product nobody may buy, and nothing else in this union can say so. */
  error: 'VARIANT_NOT_MODELLED' | 'SELECTION_INCOMPLETE' | 'COMPONENT_UNAVAILABLE' | null;
}

/** The minimal shape the resolver needs — it never reads the database itself,
 *  so it is testable and usable from the storefront preview and checkout
 *  alike. */
export interface InventorySnapshot {
  inventory_mode: InventoryMode;
  base: { stock: number | null; reserved: number; low_stock_threshold: number | null };
  option_values: Array<{
    id: string;
    group_id: string;
    name_en: string;
    stock: number | null;
    reserved: number;
    low_stock_threshold: number | null;
  }>;
  colors: Array<{
    id: string;
    name_en: string;
    stock: number | null;
    reserved: number;
    low_stock_threshold: number | null;
  }>;
  variants: Array<{
    id: string;
    combo_key: string;
    stock: number | null;
    reserved: number;
    low_stock_threshold: number | null;
    active: boolean;
  }>;
  /** Groups that exist on the product; used to tell "no choice made yet" from
   *  "a product with no options". */
  group_ids: string[];
}

export interface Selection {
  option_value_ids: string[];
  color_id: string | null;
}

/**
 * Canonical, order-independent encoding of an option+colour combination.
 * Computed server-side ONLY — a client-supplied key is never trusted, because
 * it would let a buyer aim at a different variant's stock row.
 */
export function comboKey(sel: Selection): string {
  const opts = [...sel.option_value_ids].filter(Boolean).sort();
  const parts = opts.map((id) => `o:${id}`);
  if (sel.color_id) parts.push(`c:${sel.color_id}`);
  return parts.join('|');
}

const availableOf = (t: StockTarget): number | null =>
  t.stock === null ? null : Math.max(0, t.stock - Math.max(0, t.reserved));

/** Resolves the single authoritative stock source for one selection. */
export function resolveStock(snap: InventorySnapshot, sel: Selection): StockResolution {
  const untracked: StockResolution = { targets: [], tracked: false, available: null, error: null };

  switch (snap.inventory_mode) {
    case 'BASE': {
      if (snap.base.stock === null) return untracked;
      const t: StockTarget = {
        scope: 'base',
        scope_id: '',
        stock: snap.base.stock,
        reserved: snap.base.reserved,
        low_stock_threshold: snap.base.low_stock_threshold,
        label: 'base',
      };
      return { targets: [t], tracked: true, available: availableOf(t), error: null };
    }

    case 'OPTION': {
      const chosen = snap.option_values.filter((v) => sel.option_value_ids.includes(v.id));
      const tracked = chosen.filter((v) => v.stock !== null);
      if (tracked.length === 0) return untracked;
      const targets: StockTarget[] = tracked.map((v) => ({
        scope: 'option',
        scope_id: v.id,
        stock: v.stock,
        reserved: v.reserved,
        low_stock_threshold: v.low_stock_threshold,
        label: v.name_en,
      }));
      const avail = Math.min(...targets.map((t) => availableOf(t) ?? Infinity));
      return { targets, tracked: true, available: Number.isFinite(avail) ? avail : null, error: null };
    }

    case 'COLOR': {
      if (!sel.color_id) {
        // The colour IS the stock source here, so "no colour chosen yet" is a
        // genuinely unanswerable question, not "in stock".
        return { targets: [], tracked: true, available: null, error: 'SELECTION_INCOMPLETE' };
      }
      const c = snap.colors.find((x) => x.id === sel.color_id);
      if (!c) return { targets: [], tracked: true, available: 0, error: 'SELECTION_INCOMPLETE' };
      if (c.stock === null) return untracked;
      const t: StockTarget = {
        scope: 'color',
        scope_id: c.id,
        stock: c.stock,
        reserved: c.reserved,
        low_stock_threshold: c.low_stock_threshold,
        label: c.name_en,
      };
      return { targets: [t], tracked: true, available: availableOf(t), error: null };
    }

    case 'VARIANT_COMBINATION': {
      const key = comboKey(sel);
      if (!key) return { targets: [], tracked: true, available: null, error: 'SELECTION_INCOMPLETE' };
      const v = snap.variants.find((x) => x.combo_key === key && x.active);
      if (!v) {
        // No silent fallback to base stock — see the header.
        return { targets: [], tracked: true, available: 0, error: 'VARIANT_NOT_MODELLED' };
      }
      if (v.stock === null) return untracked;
      const t: StockTarget = {
        scope: 'variant',
        scope_id: v.id,
        stock: v.stock,
        reserved: v.reserved,
        low_stock_threshold: v.low_stock_threshold,
        label: v.combo_key,
      };
      return { targets: [t], tracked: true, available: availableOf(t), error: null };
    }
  }
}

// ------------------------------------------------- pre-order capacity (0075)

/**
 * WHICH COUNTER A LINE CONSUMES IS DECIDED BY THE ORDER TYPE ALONE (DECISION 4).
 *
 * Not by the transport, not by the payment method, not by what the product row
 * happens to call itself. Cash on delivery is a way to PAY; it cannot turn a
 * pre-order into a direct sale, and `resolveForOrderType` has no parameter it
 * could do so through.
 */
export type OrderType = 'direct_sale' | 'pre_order';

export const isOrderType = (v: unknown): v is OrderType =>
  v === 'direct_sale' || v === 'pre_order';

/** One capacity row: the (model x pre-order) cell, or one of its routes. */
export interface CapacityRow {
  id: string;
  /** null = UNTRACKED. Not zero. See `resolveCapacity`. */
  capacity: number | null;
  reserved: number;
  label: string;
}

export interface CapacityTransportRow extends CapacityRow {
  method: string;
  enabled: boolean;
}

/**
 * The pre-order side of one MODEL, in the shape the resolver needs. `cell` is
 * null when the model has no (model x pre-order) row at all — a product that
 * predates 0073, or one whose pre-order is configured only at product level.
 * That is UNTRACKED, exactly as it was before 0075 existed, and never a refusal.
 */
export interface CapacitySnapshot {
  cell: CapacityRow | null;
  transports: CapacityTransportRow[];
}

/**
 * THE SHARED-VERSUS-INDEPENDENT RULE, in one function.
 *
 *   transport.capacity IS NULL  the route draws on the CELL's pool. Air, sea
 *                               and land share it, so a unit sold by air is a
 *                               unit sea can no longer sell.
 *   transport.capacity = N      the route holds its OWN N. It does NOT also
 *                               consume the pool: one counter per sale, never
 *                               two, or a single unit would be deducted twice
 *                               and the shop would run out at half its stated
 *                               capacity.
 *
 * NULL IS NOT ZERO, AND THE DIFFERENCE IS THE WHOLE FEATURE. `null` claims no
 * limit — nothing is reserved and the line is sellable, exactly how a NULL
 * `stock` behaves today. `0` is a tracked counter that is empty, and it
 * refuses. A `COALESCE(capacity, 0)` anywhere in this path would silently
 * close every pre-order in the catalogue on the day 0075 shipped.
 */
export function resolveCapacity(snap: CapacitySnapshot | null, transportMethod: string): StockResolution {
  const untracked: StockResolution = { targets: [], tracked: false, available: null, error: null };
  if (!snap || !snap.cell) return untracked;

  const route = transportMethod
    ? (snap.transports.find((t) => t.method === transportMethod) ?? null)
    : null;

  // The route's own quota wins when it has one, and then the pool is not
  // touched at all.
  const row: CapacityRow = route && route.capacity !== null ? route : snap.cell;
  const scope: StockScope = row === snap.cell ? 'preorder' : 'preorder_transport';
  if (row.capacity === null) return untracked;

  const t: StockTarget = {
    scope,
    scope_id: row.id,
    stock: row.capacity,
    reserved: row.reserved,
    // A capacity has no "low capacity" warning of its own: the admin's
    // low-stock threshold describes a shelf, and inventing one here would put
    // an orange badge on a pre-order nobody has a threshold for.
    low_stock_threshold: null,
    label: row.label,
  };
  return { targets: [t], tracked: true, available: availableOf(t), error: null };
}

/**
 * THE ONE COUNTER THIS LINE CONSUMES, given what the customer chose.
 *
 * A direct sale answers from `resolveStock` — unchanged, the same shape the
 * storefront preview, the cart and the checkout already read. A pre-order
 * answers from the capacity and NEVER from the model's stock: the two are
 * different physical facts (units on the shelf versus units undertaken to
 * import) and mixing them is what lets a sold-out model refuse a pre-order it
 * could perfectly well accept, or a pre-order eat the shelf out from under a
 * direct buyer.
 *
 * Availability stays a MINIMUM over tracked targets and is never a SUM, on
 * either branch — the capacity branch returns exactly one target, so the
 * minimum is that target.
 */
export function resolveForOrderType(
  orderType: OrderType,
  snap: InventorySnapshot,
  sel: Selection,
  capacity: CapacitySnapshot | null,
  transportMethod: string
): StockResolution {
  return orderType === 'pre_order'
    ? resolveCapacity(capacity, transportMethod)
    : resolveStock(snap, sel);
}

/** True when the resolved availability is at or below the configured warning
 *  level. Never invents a threshold: unconfigured returns false. */
export function isLowStock(res: StockResolution): boolean {
  if (res.available === null) return false;
  return res.targets.some(
    (t) => t.low_stock_threshold !== null && (availableOf(t) ?? 0) <= t.low_stock_threshold
  );
}

// ---------------------------------------------------------------- mutations

/**
 * reserve/release  hold and un-hold units without moving stock
 * deduct           a reservation becomes a real decrement (order confirmed)
 * restore          a decrement is reversed (order cancelled or returned)
 * adjust_in        admin correction upward (recount, delivery received)
 * adjust_out       admin correction downward (damage, loss, write-off)
 *
 * An admin write-off is deliberately NOT expressed as 'deduct': deduct asserts
 * a matching reservation exists and is guarded on it (migration 0020).
 */
export type LedgerKind = 'reserve' | 'release' | 'deduct' | 'restore' | 'adjust_in' | 'adjust_out';

export interface StockMove {
  product_id: string;
  qty: number;
  targets: StockTarget[];
  /** Stable per-line identity: the order item id, an adjustment id, etc. */
  line_id: string;
  /**
   * THIS MOVE IS A MYSTERY SPOOL, SO ITS EVENT NAMES NO ORDER (§8.2 rows 9-10).
   *
   * Row 9 nulls `OrderCreated.items[].product_id` because "the pick is not an
   * analytics fact until revealed"; row 10 accepts `InventoryChanged` naming
   * the real product because it is an internal bus payload. As written the two
   * contradicted each other: `InventoryChanged` named the drawn product AND the
   * order it was reserved for, so one join reconstructed exactly what row 9
   * withheld, from the moment the order committed. The LEDGER row keeps the
   * real `order_id` — operational traceability is untouched — and only the
   * event drops it.
   */
  mystery?: boolean;
}

export interface ApplyOptions {
  kind: LedgerKind;
  /** Stable operation identity; combined with line + target to form the key. */
  operationId: string;
  orderId?: string | null;
  actorUserId?: string | null;
  reason?: string;
}

export interface RejectedMove {
  line_id: string;
  scope: StockScope;
  scope_id: string;
  reason: 'INSUFFICIENT_STOCK' | 'ROW_MISSING' | 'NOT_TRACKED';
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  /** Moves the guard refused. NOTHING was written for these — no counter
   *  change and no ledger row — so a corrected retry with the same operation
   *  id still works. */
  rejected: RejectedMove[];
  /** The idempotency keys that were newly written (for tests and audit). */
  keys: string[];
}

const KEY = (kind: LedgerKind, operationId: string, lineId: string, scope: string, scopeId: string) =>
  `${kind}:${operationId}:${lineId}:${scope}:${scopeId || '-'}`;

/**
 * The counter change one ledger kind performs on one row, together with its
 * bind arguments IN PLACEHOLDER ORDER (SET first, then the id, then the
 * guard). Returning the arguments here rather than deriving them at the call
 * site is deliberate: a hand-maintained parallel list silently under-binds a
 * guard, and an under-bound guard matches nothing — an inventory move that
 * quietly does not happen.
 */
function counterSql(
  kind: LedgerKind,
  scope: StockScope,
  qty: number
): { table: string; set: string; setArgs: number[]; guard: string; guardArgs: number[] } {
  const table = tableFor(scope);
  const reserved = reservedColumn(scope);
  // `on_hand` is `stock` on the four shelf scopes and `capacity` on the two
  // pre-order scopes. The ARITHMETIC below is identical for both, and that is
  // the whole point of DECISION 3: a capacity is a number of units with a hold
  // against it, so it moves through the same five verbs and the same guards.
  const onHand = stockColumn(scope);

  switch (kind) {
    case 'reserve':
      // Never hold more than is physically on hand. A NULL on-hand is
      // UNTRACKED — no limit is claimed, so there is nothing to hold and the
      // guard matches nothing; the caller reads that as NOT_TRACKED and sells.
      return {
        table,
        set: `${reserved} = ${reserved} + ?`,
        setArgs: [qty],
        guard: `${onHand} IS NOT NULL AND ${onHand} - ${reserved} >= ?`,
        guardArgs: [qty],
      };
    case 'release':
      return {
        table,
        set: `${reserved} = ${reserved} - ?`,
        setArgs: [qty],
        guard: `${reserved} >= ?`,
        guardArgs: [qty],
      };
    case 'deduct':
      // The hold becomes a real decrement; both counters move together, so
      // available (= on hand - reserved) is unchanged by confirmation.
      return {
        table,
        set: `${onHand} = ${onHand} - ?, ${reserved} = ${reserved} - ?`,
        setArgs: [qty, qty],
        guard: `${onHand} IS NOT NULL AND ${onHand} >= ? AND ${reserved} >= ?`,
        guardArgs: [qty, qty],
      };
    case 'restore':
    case 'adjust_in':
      return {
        table,
        set: `${onHand} = ${onHand} + ?`,
        setArgs: [qty],
        guard: `${onHand} IS NOT NULL`,
        guardArgs: [],
      };
    case 'adjust_out':
      // A write-off cannot take the counter negative, and cannot eat into
      // units already held for someone's order.
      return {
        table,
        set: `${onHand} = ${onHand} - ?`,
        setArgs: [qty],
        guard: `${onHand} IS NOT NULL AND ${onHand} - ${reserved} >= ?`,
        guardArgs: [qty],
      };
  }
}

function tableFor(scope: StockScope): string {
  return SCOPE_COLUMNS[scope].table;
}

/** The ON-HAND column. `capacity` for a pre-order scope, `stock` for a shelf. */
function stockColumn(scope: StockScope): string {
  return SCOPE_COLUMNS[scope].stock;
}

function reservedColumn(scope: StockScope): string {
  return SCOPE_COLUMNS[scope].reserved;
}

/** Evaluates a guard against a row's CURRENT values, so a move that cannot
 *  succeed is reported instead of being silently dropped. */
function guardHolds(kind: LedgerKind, qty: number, row: { stock: number | null; reserved: number }): boolean {
  switch (kind) {
    case 'reserve':
      return row.stock !== null && row.stock - row.reserved >= qty;
    case 'release':
      return row.reserved >= qty;
    case 'deduct':
      return row.stock !== null && row.stock >= qty && row.reserved >= qty;
    case 'restore':
    case 'adjust_in':
      return row.stock !== null;
    case 'adjust_out':
      return row.stock !== null && row.stock - row.reserved >= qty;
  }
}

export interface InventoryPlan extends ApplyResult {
  /** Statements to execute. Empty when everything was skipped or rejected. */
  statements: D1PreparedStatement[];
  /**
   * The `InventoryChanged` event ids this plan appended, so the caller can hand
   * them to `pumpAfter()` alongside its own. Without them the stock facts of a
   * checkout wait for the cron — up to fifteen minutes of avoidable lag on the
   * highest-volume event in the system, while the order event next to them in
   * the very same batch is delivered at once. Empty while the bus is off.
   */
  eventIds: string[];
  /**
   * How many `inventory_ledger` rows this plan's statements will write when
   * every guard still holds at commit. It is the `expected` side of
   * `order_reservation_fence` (§3.3): inferring it from `keys.length` would be
   * the same number today and a silent lie the first time a statement is added
   * that writes a ledger row without a key in this list.
   */
  plannedLedgerRows: number;
}

/** Bound-parameter safety for every `IN (…)` list this module builds. D1 caps
 *  parameters per query, and a bundle multiplies the move count without bound
 *  (§3.1), so the lists are chunked rather than trusted to stay small. */
export const IN_CHUNK = 50;

export function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * Builds — but does NOT execute — the statements for one inventory operation.
 *
 * Exposed separately so a caller that already runs a transaction (checkout,
 * which creates the order, spends the wallet and books the points in ONE
 * db.batch) can append these to it. Keeping the stock movement in the caller's
 * batch is what makes "the order exists but its stock was never deducted"
 * impossible; running it in a second batch would open exactly that window.
 *
 * Already-applied keys are detected first and skipped, so a retry is a no-op
 * rather than an error. Then each remaining move's guard is evaluated against
 * the row's current values; a move that cannot succeed is REJECTED and nothing
 * is written for it — neither the counter change nor the ledger row — so a
 * corrected retry under the same operation id is still possible.
 *
 * The surviving moves go into one `db.batch` (a single D1 transaction) where
 * the ledger INSERT and the counter UPDATE carry the SAME guard and the INSERT
 * comes first, evaluated against the pre-update state. Under a concurrent
 * change they therefore agree: either both take effect or neither does, and a
 * ledger row can never claim a movement that did not happen. The UNIQUE index
 * on `idempotency_key` is the final race guard — the loser's INSERT violates
 * it and D1 rolls that caller's whole batch back, counters included.
 *
 * DEMAND IS SUMMED PER STOCK ROW, NEVER JUDGED MOVE BY MOVE. Two moves in one
 * call may resolve to the SAME authoritative row — a bundle holding two spools
 * of one colour, a bundle beside the bare product it contains, two mystery
 * spools that drew the same filament. Judging each against the row's full
 * `available` accepts 2 + 2 units of a row that has 3, so `rejected` comes back
 * empty, the friendly `CONFLICT_RETRY` never fires, and the sequential guards
 * fail at commit instead — a permanent, deterministic "a stock level changed"
 * on a cart nobody is racing. The pre-check therefore walks the moves in order
 * against a running simulation of each row, so the second move is judged
 * against what the first one leaves behind. The rows themselves are read in ONE
 * batched query per table rather than one `SELECT` per candidate move: with a
 * dozen components on the hottest path in the system, a sequential read scales
 * latency linearly for no reason.
 */
export async function planInventory(
  db: D1Database,
  moves: StockMove[],
  opts: ApplyOptions
): Promise<InventoryPlan> {
  const wanted: Array<{ key: string; move: StockMove; target: StockTarget }> = [];
  for (const move of moves) {
    if (move.qty <= 0) continue;
    for (const t of move.targets) {
      wanted.push({ key: KEY(opts.kind, opts.operationId, move.line_id, t.scope, t.scope_id), move, target: t });
    }
  }
  if (wanted.length === 0) {
    return { applied: 0, skipped: 0, rejected: [], keys: [], statements: [], eventIds: [], plannedLedgerRows: 0 };
  }

  const done = new Set<string>();
  for (const part of chunk(
    wanted.map((w) => w.key),
    IN_CHUNK
  )) {
    const { results } = await db
      .prepare(`SELECT idempotency_key FROM inventory_ledger WHERE idempotency_key IN (${part.map(() => '?').join(', ')})`)
      .bind(...part)
      .all<{ idempotency_key: string }>();
    for (const r of results) done.add(r.idempotency_key);
  }

  const candidates = wanted.filter((w) => !done.has(w.key));
  const skipped = wanted.length - candidates.length;
  if (candidates.length === 0) {
    return { applied: 0, skipped, rejected: [], keys: [], statements: [], eventIds: [], plannedLedgerRows: 0 };
  }

  // ---- one batched read of every row this call touches, keyed (table, id) ---
  const rowKeyOf = (w: (typeof candidates)[number]) =>
    `${tableFor(w.target.scope)}#${w.target.scope === 'base' ? w.move.product_id : w.target.scope_id}`;
  // Grouped BY SCOPE, not by table name: the scope is what knows which two
  // columns hold the numbers (`stock`/`stock_reserved`, `stock`/`reserved`,
  // `capacity`/`capacity_reserved`), and each scope owns a distinct table, so
  // the row key stays `table#id` exactly as before.
  const byScope = new Map<StockScope, Set<string>>();
  for (const w of candidates) {
    const id = w.target.scope === 'base' ? w.move.product_id : w.target.scope_id;
    const set = byScope.get(w.target.scope);
    if (set) set.add(id);
    else byScope.set(w.target.scope, new Set([id]));
  }
  const live = new Map<string, { stock: number | null; reserved: number }>();
  for (const [scope, ids] of byScope) {
    const { table, stock, reserved } = SCOPE_COLUMNS[scope];
    for (const part of chunk([...ids], IN_CHUNK)) {
      const { results } = await db
        .prepare(
          `SELECT id, ${stock} AS stock, ${reserved} AS reserved FROM ${table} WHERE id IN (${part.map(() => '?').join(', ')})`
        )
        .bind(...part)
        .all<{ id: string; stock: number | null; reserved: number | null }>();
      for (const r of results) live.set(`${table}#${r.id}`, { stock: r.stock, reserved: r.reserved ?? 0 });
    }
  }

  // ---- guard pre-check, summed per row -------------------------------------
  const rejected: RejectedMove[] = [];
  const fresh: typeof candidates = [];
  // The row as it stood when the guard was evaluated, kept so the event can
  // state stock_after/reserved_after without a second read (03-EVENTS.md §3.4).
  // For a second move against the same row it is what the first move leaves —
  // the whole point of the running simulation.
  const before = new Map<string, { stock: number; reserved: number }>();
  const sim = new Map<string, { stock: number | null; reserved: number }>();
  for (const w of candidates) {
    const key = rowKeyOf(w);
    const row = live.get(key);
    if (!row) {
      rejected.push({ line_id: w.move.line_id, scope: w.target.scope, scope_id: w.target.scope_id, reason: 'ROW_MISSING' });
      continue;
    }
    const cur = sim.get(key) ?? { stock: row.stock, reserved: row.reserved };
    if (!guardHolds(opts.kind, w.move.qty, { stock: cur.stock, reserved: cur.reserved })) {
      rejected.push({
        line_id: w.move.line_id,
        scope: w.target.scope,
        scope_id: w.target.scope_id,
        reason: cur.stock === null ? 'NOT_TRACKED' : 'INSUFFICIENT_STOCK',
      });
      continue;
    }
    before.set(w.key, { stock: cur.stock ?? 0, reserved: cur.reserved });
    const moved = stockAfter(opts.kind, w.move.qty, { stock: cur.stock ?? 0, reserved: cur.reserved });
    // An untracked row stays untracked: `null` is not zero, and turning it into
    // one here would let a later move in the same call read a stock level the
    // row does not have.
    sim.set(key, { stock: cur.stock === null ? null : moved.stock, reserved: moved.reserved });
    fresh.push(w);
  }
  if (fresh.length === 0) {
    return { applied: 0, skipped, rejected, keys: [], statements: [], eventIds: [], plannedLedgerRows: 0 };
  }

  const statements: D1PreparedStatement[] = [];
  const eventIds: string[] = [];
  let seq = 0;
  for (const w of fresh) {
    const { table, set, setArgs, guard, guardArgs } = counterSql(opts.kind, w.target.scope, w.move.qty);
    const rowId = w.target.scope === 'base' ? w.move.product_id : w.target.scope_id;
    seq += 1;

    // 1. The ledger row, guarded by the SAME condition and evaluated BEFORE
    //    the counter moves. If a concurrent write invalidated the guard since
    //    the pre-check, zero rows are inserted and zero are updated.
    statements.push(
      db
        .prepare(
          `INSERT INTO inventory_ledger
             (id, product_id, scope, scope_id, kind, qty, order_id, idempotency_key, actor_user_id, reason)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND ${guard})`
        )
        .bind(
          `inv_${opts.kind}_${opts.operationId}_${seq}`.slice(0, 64),
          w.move.product_id,
          w.target.scope,
          w.target.scope_id,
          opts.kind,
          w.move.qty,
          opts.orderId ?? null,
          w.key,
          opts.actorUserId ?? null,
          opts.reason ?? '',
          rowId,
          ...guardArgs
        )
    );

    // 2. The counter change, under the identical guard.
    statements.push(
      db.prepare(`UPDATE ${table} SET ${set} WHERE id = ? AND ${guard}`).bind(...setArgs, rowId, ...guardArgs)
    );
  }

  // §7 of the events catalogue: one InventoryChanged per ledger write, in the
  // SAME batch as the counter change, so a stock movement and the fact that it
  // happened commit together. `outboxStatement` returns null — and this loop
  // therefore adds nothing at all — while the bus is off, which is every
  // deployment until G2.
  //
  // EVERY ROW IS GUARDED BY THE LEDGER ROW IT DESCRIBES. The ledger INSERT and
  // the counter UPDATE above are conditional: when the guard stops holding
  // between the pre-check read and the batch — two checkouts of the last unit,
  // a checkout racing an admin adjustment — they match zero rows and the batch
  // still commits. An unconditional event row would then announce a movement
  // that never happened, which is the outbox's own promise inverted for the
  // highest-volume transactional event in the system. The `inventory_ledger`
  // row is the proof the movement happened, and these statements come after it
  // in the batch, so the guard sees it.
  //
  // `delta` is exact. `stock_after`/`reserved_after` are the guard's own
  // reading plus that delta: correct whenever this operation is the only one
  // moving the row, and under concurrency an absolute that was true at the
  // pre-check rather than at commit. Consumers that must not drift key on
  // `delta` and `op_id`; deriving the absolutes in SQL is not open to us
  // because the envelope is signed over its payload.
  for (const w of fresh) {
    // A CAPACITY MOVEMENT PUBLISHES NO `InventoryChanged`, AND THAT IS NOT AN
    // OVERSIGHT. The event's `scope.table` is an enum of the four catalogue
    // stock tables in `@levonis/contracts` — a package this change does not
    // own — and a pre-order quota has no row in any of them. Naming one of the
    // four anyway would tell every bus consumer that a shelf moved when no
    // shelf did, which is worse than silence for the analytics that price
    // restocking. The LEDGER row is still written for every capacity move, so
    // the audit trail DECISION 3 exists for is complete; only the bus is quiet,
    // until the contract gains the two scopes.
    if (isCapacityScope(w.target.scope)) continue;
    const b = before.get(w.key) ?? { stock: 0, reserved: 0 };
    const after = stockAfter(opts.kind, w.move.qty, b);
    const pending = await outboxStatement(
      db,
      InventoryChangedV1,
      {
        product_id: w.move.product_id,
        scope: { table: eventTableFor(w.target.scope), id: w.target.scope === 'base' ? w.move.product_id : w.target.scope_id },
        delta: after.stock - b.stock,
        stock_after: after.stock,
        reserved_after: after.reserved,
        reason: EVENT_REASON[opts.kind],
        op_id: w.key,
        // §8.2 row 10: a mystery spool's event names the product (it must — it
        // is the stock truth) but never the order, so no bus consumer can join
        // it to `OrderCreated` and hold the pick as a per-order fact.
        order_id: w.move.mystery ? null : (opts.orderId ?? null),
      },
      {
        aggregateId: w.move.product_id,
        actorId: opts.actorUserId ?? null,
        guard: { sql: 'EXISTS (SELECT 1 FROM inventory_ledger WHERE idempotency_key = ?)', args: [w.key] },
      }
    );
    if (pending) {
      statements.push(pending.statement);
      eventIds.push(pending.eventId);
    }
  }

  return {
    applied: fresh.length,
    skipped,
    rejected,
    keys: fresh.map((w) => w.key),
    statements,
    eventIds,
    plannedLedgerRows: fresh.length,
  };
}

/**
 * THE RESERVATION FENCE (§3.3) — one statement that makes a partial inventory
 * movement impossible inside the caller's own transaction.
 *
 * `planInventory` writes a guarded INSERT and a guarded UPDATE per target. A
 * guard that stops holding BETWEEN the plan-time read and the commit makes both
 * match zero rows — without failing the batch. The order would then commit with
 * a component unreserved; a cancellation would commit with the customer
 * refunded and the units held for ever. `assertMovesApplied` was written for
 * this and, until now, had no callers.
 *
 * Earlier statements in a D1 batch are visible to later ones, so the COUNT sees
 * the ledger rows this batch has just written. If any guarded insert matched
 * zero rows, `actual < expected` and the table's `CHECK (actual = expected)`
 * rolls the WHOLE batch back — order, wallet spend, points, redemptions and
 * every other reservation with it. `worker/routes/orders.ts` already maps a
 * CHECK violation to `CONFLICT_RETRY`, so no catch block changes.
 *
 * The upsert is what makes a REPLAY safe: the same operation applied twice
 * plans zero new rows, recomputes the same `expected`, and rewrites the same
 * row instead of colliding with its own primary key.
 */
export function reservationFenceStatement(
  db: D1Database,
  orderId: string,
  kind: LedgerKind,
  expected: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO order_reservation_fence (order_id, kind, expected, actual)
       SELECT ?1, ?2, ?3, (SELECT COUNT(*) FROM inventory_ledger
                            WHERE order_id = ?1 AND kind = ?2)
       ON CONFLICT(order_id, kind) DO UPDATE SET expected = excluded.expected, actual = excluded.actual`
    )
    .bind(orderId, kind, expected);
}

/**
 * The fence statement for a plan, with `expected` read rather than assumed:
 * the rows already recorded for this (order, kind) plus the rows this plan will
 * write. Reading it is what lets a second return case on one order, or a
 * cancellation that follows a partial deduction, carry a fence of its own
 * instead of failing on a count it did not produce.
 */
export async function planReservationFence(
  db: D1Database,
  orderId: string,
  kind: LedgerKind,
  plannedLedgerRows: number
): Promise<D1PreparedStatement> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind = ?')
    .bind(orderId, kind)
    .first<{ n: number }>();
  return reservationFenceStatement(db, orderId, kind, Number(row?.n ?? 0) + Math.max(0, plannedLedgerRows));
}

/** The table whose stock row moved, as the event catalogue spells it. Only the
 *  four shelf scopes reach this — a capacity scope is filtered out above,
 *  because the contract's enum has no name for it. */
function eventTableFor(scope: StockScope): 'products' | 'product_option_values' | 'product_colors' | 'product_variants' {
  return scope === 'base' ? 'products' : scope === 'option' ? 'product_option_values' : scope === 'color' ? 'product_colors' : 'product_variants';
}

/** The ledger kind as the event catalogue names it (03-EVENTS.md §3.4). */
const EVENT_REASON: Record<LedgerKind, 'reserve' | 'commit' | 'release' | 'deduct' | 'restore' | 'adjust'> = {
  reserve: 'reserve',
  release: 'release',
  deduct: 'deduct',
  restore: 'restore',
  adjust_in: 'adjust',
  adjust_out: 'adjust',
};

/**
 * What the row will read once this move's guarded statements have run — the
 * same arithmetic `counterSql` writes, kept beside it so the event can never
 * describe a movement different from the one performed.
 */
export function stockAfter(
  kind: LedgerKind,
  qty: number,
  before: { stock: number; reserved: number }
): { stock: number; reserved: number } {
  switch (kind) {
    case 'reserve':
      return { stock: before.stock, reserved: before.reserved + qty };
    case 'release':
      return { stock: before.stock, reserved: before.reserved - qty };
    case 'deduct':
      return { stock: before.stock - qty, reserved: before.reserved - qty };
    case 'restore':
    case 'adjust_in':
      return { stock: before.stock + qty, reserved: before.reserved };
    case 'adjust_out':
      return { stock: before.stock - qty, reserved: before.reserved };
  }
}

/** Plans and executes in one call — for callers with no transaction of their
 *  own (admin adjustments, order cancellation). */
export async function applyInventory(
  db: D1Database,
  moves: StockMove[],
  opts: ApplyOptions
): Promise<ApplyResult> {
  const plan = await planInventory(db, moves, opts);
  if (plan.statements.length) await db.batch(plan.statements);
  const { statements: _statements, ...result } = plan;
  void _statements;
  return result;
}

/**
 * Verifies that every counter update in the last operation actually matched a
 * row. D1's batch does not fail on a 0-row UPDATE, and a guard that silently
 * matched nothing would leave a ledger row claiming a movement that never
 * happened — so callers that must not oversell (checkout) re-read and compare.
 */
export async function assertMovesApplied(
  db: D1Database,
  moves: StockMove[]
): Promise<{ ok: boolean; short: string[] }> {
  const short: string[] = [];
  for (const move of moves) {
    for (const t of move.targets) {
      // The same column lookup every other statement in this file uses, so a
      // capacity row is verified against `capacity`/`capacity_reserved` rather
      // than against a `stock` column its table does not have.
      const { table, stock: stockCol, reserved: reservedCol } = SCOPE_COLUMNS[t.scope];
      const id = t.scope === 'base' ? move.product_id : t.scope_id;
      const row = await db
        .prepare(`SELECT ${stockCol} AS stock, ${reservedCol} AS reserved FROM ${table} WHERE id = ?`)
        .bind(id)
        .first<{ stock: number | null; reserved: number }>();
      if (!row) {
        short.push(`${t.scope}:${id}:missing`);
        continue;
      }
      if (row.stock !== null && row.stock - row.reserved < 0) short.push(`${t.scope}:${id}:negative`);
    }
  }
  return { ok: short.length === 0, short };
}
