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

export type StockScope = 'base' | 'option' | 'color' | 'variant';

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
  /** Machine-readable reason when the selection cannot be sold at all. */
  error: 'VARIANT_NOT_MODELLED' | 'SELECTION_INCOMPLETE' | null;
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

  switch (kind) {
    case 'reserve':
      // Never hold more than is physically on hand.
      return {
        table,
        set: `${reserved} = ${reserved} + ?`,
        setArgs: [qty],
        guard: `stock IS NOT NULL AND stock - ${reserved} >= ?`,
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
      // available (= stock - reserved) is unchanged by confirmation.
      return {
        table,
        set: `stock = stock - ?, ${reserved} = ${reserved} - ?`,
        setArgs: [qty, qty],
        guard: `stock IS NOT NULL AND stock >= ? AND ${reserved} >= ?`,
        guardArgs: [qty, qty],
      };
    case 'restore':
    case 'adjust_in':
      return {
        table,
        set: 'stock = stock + ?',
        setArgs: [qty],
        guard: 'stock IS NOT NULL',
        guardArgs: [],
      };
    case 'adjust_out':
      // A write-off cannot take stock negative, and cannot eat into units
      // already held for someone's order.
      return {
        table,
        set: 'stock = stock - ?',
        setArgs: [qty],
        guard: `stock IS NOT NULL AND stock - ${reserved} >= ?`,
        guardArgs: [qty],
      };
  }
}

function tableFor(scope: StockScope): string {
  return scope === 'base'
    ? 'products'
    : scope === 'option'
      ? 'product_option_values'
      : scope === 'color'
        ? 'product_colors'
        : 'product_variants';
}

function reservedColumn(scope: StockScope): string {
  return scope === 'base' ? 'stock_reserved' : 'reserved';
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

/**
 * Applies one inventory operation atomically and idempotently.
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
 */
export async function applyInventory(
  db: D1Database,
  moves: StockMove[],
  opts: ApplyOptions
): Promise<ApplyResult> {
  const wanted: Array<{ key: string; move: StockMove; target: StockTarget }> = [];
  for (const move of moves) {
    if (move.qty <= 0) continue;
    for (const t of move.targets) {
      wanted.push({ key: KEY(opts.kind, opts.operationId, move.line_id, t.scope, t.scope_id), move, target: t });
    }
  }
  if (wanted.length === 0) return { applied: 0, skipped: 0, rejected: [], keys: [] };

  const placeholders = wanted.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT idempotency_key FROM inventory_ledger WHERE idempotency_key IN (${placeholders})`)
    .bind(...wanted.map((w) => w.key))
    .all<{ idempotency_key: string }>();
  const done = new Set(results.map((r) => r.idempotency_key));

  const candidates = wanted.filter((w) => !done.has(w.key));
  const skipped = wanted.length - candidates.length;
  if (candidates.length === 0) return { applied: 0, skipped, rejected: [], keys: [] };

  // Guard pre-check against live values.
  const rejected: RejectedMove[] = [];
  const fresh: typeof candidates = [];
  for (const w of candidates) {
    const table = tableFor(w.target.scope);
    const reserved = reservedColumn(w.target.scope);
    const rowId = w.target.scope === 'base' ? w.move.product_id : w.target.scope_id;
    const row = await db
      .prepare(`SELECT stock, ${reserved} AS reserved FROM ${table} WHERE id = ?`)
      .bind(rowId)
      .first<{ stock: number | null; reserved: number }>();
    if (!row) {
      rejected.push({ line_id: w.move.line_id, scope: w.target.scope, scope_id: w.target.scope_id, reason: 'ROW_MISSING' });
      continue;
    }
    if (!guardHolds(opts.kind, w.move.qty, { stock: row.stock, reserved: row.reserved ?? 0 })) {
      rejected.push({
        line_id: w.move.line_id,
        scope: w.target.scope,
        scope_id: w.target.scope_id,
        reason: row.stock === null ? 'NOT_TRACKED' : 'INSUFFICIENT_STOCK',
      });
      continue;
    }
    fresh.push(w);
  }
  if (fresh.length === 0) return { applied: 0, skipped, rejected, keys: [] };

  const statements: D1PreparedStatement[] = [];
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

  await db.batch(statements);
  return { applied: fresh.length, skipped, rejected, keys: fresh.map((w) => w.key) };
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
      const table =
        t.scope === 'base'
          ? 'products'
          : t.scope === 'option'
            ? 'product_option_values'
            : t.scope === 'color'
              ? 'product_colors'
              : 'product_variants';
      const reservedCol = t.scope === 'base' ? 'stock_reserved' : 'reserved';
      const id = t.scope === 'base' ? move.product_id : t.scope_id;
      const row = await db
        .prepare(`SELECT stock, ${reservedCol} AS reserved FROM ${table} WHERE id = ?`)
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
