/**
 * «إضافة إلى المخزون الحالي» — TURNING A PURCHASE INTO UNITS ON A SHELF.
 *
 * Receiving is the one operation in this feature that a double tap can make
 * expensive, and the one that must be all-or-nothing. §16 lists eleven steps
 * and then says the part that matters: it must not be possible for the ledger
 * row to succeed while the counter does not.
 *
 * So this module builds ONE list of statements for ONE `db.batch`, which D1
 * runs as a single transaction:
 *
 *   1. the inventory lot                      (the cost layer)
 *   2. the receipt                            (the audit trail, UNIQUE-keyed)
 *   3. the stock counter increase             (the sellable units)
 *   4. the `adjust_in` ledger row             (the movement, UNIQUE-keyed)
 *   5. the incoming record's received count   (the purchase's progress)
 *
 * Either all five commit or none does.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCY IS THE DATABASE'S JOB, NOT THE BUTTON'S. §17.
 *
 * `incoming_inventory_receipts.idempotency_key` and
 * `inventory_ledger.idempotency_key` are both UNIQUE, and both carry the
 * caller's receipt id.
 *
 * THE RECEIPT IS INSERTED HARD — `INSERT INTO`, NOT `INSERT OR IGNORE` — AND
 * THAT IS THE WHOLE MECHANISM. It is worth being exact about why, because the
 * gentler spelling looks safer and is not:
 *
 *   INSERT OR IGNORE INTO receipts ...                      -- silently no-ops
 *   UPDATE products SET stock = stock + 10
 *    WHERE ... AND EXISTS (SELECT 1 FROM receipts WHERE id = ?)
 *
 * On the second press that `EXISTS` is TRUE — because the FIRST press wrote the
 * row — so the counter increments a second time and the shop gains ten units it
 * never bought. `EXISTS (the row)` cannot distinguish "I inserted it just now"
 * from "it was already there". A hard INSERT can: it raises on the duplicate,
 * D1 rolls the whole batch back, and nothing at all happens.
 *
 * So the caller does not need to have read first. `planReceive` is safe to
 * replay verbatim, which is what a retry of a request whose response was lost
 * actually is.
 *
 * THE RECEIPT ID IS THE CLIENT'S, and that is deliberate. A server-minted id
 * would be different on every retry, which is precisely how a double tap
 * becomes two receipts. The client sends one id per press of the button, so a
 * retry of THAT press is recognisable as the same operation.
 *
 * ---------------------------------------------------------------------------
 * COSTS MUST BE STATED BEFORE UNITS BECOME SELLABLE. §13.
 *
 * Not "truthy": stated. An internal delivery of 0 is a real and common answer —
 * the owner collected the boxes themselves — and a shipping total of 0 is not.
 * Both are legitimate; neither is an empty box. `readyToReceive` refuses only
 * the empty box, and it says which component is missing rather than failing
 * with a generic refusal the admin has to guess at.
 */

import type { StockScope } from './inventory';
import { lotCostBreakdown, type LotCostBreakdown } from './inventoryLots';

export type IncomingStatus = 'draft' | 'incoming' | 'partial' | 'received' | 'cancelled';

export interface IncomingRow {
  id: string;
  product_id: string | null;
  scope: StockScope;
  scope_id: string;
  qty_ordered: number;
  qty_received: number;
  purchase_unit_iqd: number;
  shipping_total_iqd: number | null;
  internal_delivery_total_iqd: number | null;
  supplier_id: string | null;
  purchase_date: string | null;
  status: IncomingStatus;
}

/** The three components, and only the three (§8). */
export const COST_COMPONENTS = ['purchase', 'shipping', 'internal_delivery'] as const;
export type CostComponent = (typeof COST_COMPONENTS)[number];

export type ReceiveRefusal =
  | { ok: false; code: 'ALREADY_RECEIVED'; message: string }
  | { ok: false; code: 'CANCELLED'; message: string }
  | { ok: false; code: 'QTY_EXCEEDS_ORDER'; message: string; remaining: number }
  | { ok: false; code: 'QTY_INVALID'; message: string }
  | { ok: false; code: 'COST_NOT_STATED'; message: string; missing: CostComponent[] };

export type ReceiveCheck = { ok: true; remaining: number; cost: LotCostBreakdown } | ReceiveRefusal;

/**
 * May this quantity be received right now, and at what cost?
 *
 * Pure, and returns the COST as well as the verdict, so the confirmation sheet
 * (§59) shows the reader exactly the figures the commit will use. A dialog that
 * computes its own preview is a dialog that can disagree with the thing it is
 * confirming.
 */
export function readyToReceive(row: IncomingRow, qty: number): ReceiveCheck {
  if (row.status === 'cancelled') {
    return { ok: false, code: 'CANCELLED', message: 'هذا الطلب ملغى ولا يمكن استلامه / This purchase is cancelled' };
  }
  const remaining = Math.max(0, row.qty_ordered - row.qty_received);
  if (remaining === 0) {
    // §17's exact wording. The admin pressed twice; they are owed a sentence
    // that says the first press worked, not a failure.
    return { ok: false, code: 'ALREADY_RECEIVED', message: 'تم استلام هذه الكمية بالفعل / This quantity has already been received' };
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return { ok: false, code: 'QTY_INVALID', message: 'الكمية يجب أن تكون عددًا صحيحًا أكبر من صفر / Quantity must be a whole number above zero' };
  }
  if (qty > remaining) {
    return {
      ok: false,
      code: 'QTY_EXCEEDS_ORDER',
      message: `لا يمكن استلام أكثر من المتبقي (${remaining}) / Cannot receive more than the ${remaining} still outstanding`,
      remaining,
    };
  }

  // NOT `!row.shipping_total_iqd`. Zero is a stated cost; null is a blank box.
  const missing: CostComponent[] = [];
  if (row.shipping_total_iqd === null || row.shipping_total_iqd === undefined) missing.push('shipping');
  if (row.internal_delivery_total_iqd === null || row.internal_delivery_total_iqd === undefined) {
    missing.push('internal_delivery');
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'COST_NOT_STATED',
      message:
        'أدخل تكلفة الشحن والتوصيل للمخزن قبل الاستلام (الصفر قيمة صحيحة) / ' +
        'Enter the shipping and warehouse-delivery costs before receiving (zero is a valid answer)',
      missing,
    };
  }

  return {
    ok: true,
    remaining,
    cost: lotCostBreakdown({
      purchaseUnitIqd: row.purchase_unit_iqd,
      shippingTotalIqd: row.shipping_total_iqd,
      internalDeliveryTotalIqd: row.internal_delivery_total_iqd,
      qtyOrdered: row.qty_ordered,
      qtyThisReceipt: qty,
      alreadyReceived: row.qty_received,
    }),
  };
}

/** The status a purchase reaches once this receipt commits. */
export function statusAfterReceipt(row: IncomingRow, qty: number): IncomingStatus {
  const received = row.qty_received + qty;
  return received >= row.qty_ordered ? 'received' : 'partial';
}

// ---------------------------------------------------------------------------
//  THE COUNTER
// ---------------------------------------------------------------------------

/** The table and column a scope's units live in. Mirrors inventory.ts's own
 *  mapping rather than re-deciding it — two answers to "where is the stock"
 *  is the defect docs/INVENTORY-DECISIONS.md §7 exists to prevent. */
export function counterTarget(scope: StockScope): { table: string; column: string } | null {
  switch (scope) {
    case 'base':
      return { table: 'products', column: 'stock' };
    case 'option':
      return { table: 'product_option_values', column: 'stock' };
    case 'color':
      return { table: 'product_colors', column: 'stock' };
    case 'variant':
      return { table: 'product_variants', column: 'stock' };
    default:
      // A capacity scope has no shelf to add to (§65).
      return null;
  }
}

export interface ReceivePlan {
  statements: D1PreparedStatement[];
  lotId: string;
  cost: LotCostBreakdown;
  status: IncomingStatus;
}

export interface ReceiveInput {
  row: IncomingRow;
  qty: number;
  /** The CLIENT's id for this press of the button — see the header. */
  receiptId: string;
  lotId: string;
  actorUserId: string | null;
  receivedAt: string;
}

/**
 * The five statements, in one batch.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. The lot is inserted first because the
 * receipt's `lot_id` references it; the receipt comes second because it is the
 * idempotency anchor and must be attempted before anything moves a number; the
 * counter, the ledger row and the purchase's progress follow.
 *
 * NOTHING AFTER THE RECEIPT NEEDS A GUARD ABOUT WHETHER THIS RECEIPT HAPPENED,
 * because if it did not, the batch is already gone (see the header). That is
 * why the counter is a plain `UPDATE` rather than one carrying an `EXISTS` over
 * the receipt: the `EXISTS` spelling was actively wrong, not merely redundant.
 *
 * A NULL COUNTER CANNOT REACH THE SHELF. NULL means "this level does not track
 * stock", and `NULL + 10` is NULL — so an untracked rung would stay untracked
 * while the lot claimed ten units. Two locks:
 *
 *   - the LOT is inserted `SELECT … WHERE EXISTS (the counter, non-NULL)`, so
 *     on an untracked rung no lot row appears and the receipt's NOT NULL
 *     foreign key to it fails, taking the batch with it;
 *   - the counter's own `IS NOT NULL` keeps the second lock local to the
 *     statement that would do the damage.
 *
 * THE PURCHASE'S PROGRESS IS NOT GUARDED EITHER, deliberately. It used to carry
 * `AND qty_received + ? <= qty_ordered`, which turned receiving more than was
 * ordered into a SILENT no-op: the shelf gained units the purchase did not
 * record. Dropped, so `CHECK (qty_received <= qty_ordered)` on the table aborts
 * the batch instead. A loud refusal beats a quiet disagreement.
 */
export function planReceive(db: D1Database, input: ReceiveInput): ReceivePlan {
  const { row, qty, receiptId, lotId, actorUserId, receivedAt } = input;
  const check = readyToReceive(row, qty);
  if (!check.ok) throw new Error(`planReceive called on a refused receipt: ${check.code}`);
  const cost = check.cost;
  const target = counterTarget(row.scope);
  if (!target) throw new Error(`planReceive: scope ${row.scope} has no shelf`);
  // `products.id` for base, the option/colour/variant row's id for the rest.
  const counterRowId = row.scope === 'base' ? row.product_id : row.scope_id;

  const idem = `receipt:${receiptId}`;
  const statements: D1PreparedStatement[] = [];

  statements.push(
    db
      .prepare(
        `INSERT INTO inventory_lots
           (id, product_id, scope, scope_id, qty_received, qty_remaining,
            unit_cost_iqd, purchase_unit_iqd, shipping_share_iqd, internal_share_iqd, total_cost_iqd,
            cost_basis, incoming_id, supplier_id, purchase_date, received_at, created_by)
         SELECT ?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9, ?10, 'received', ?11, ?12, ?13, ?14, ?15
          WHERE EXISTS (SELECT 1 FROM "${target.table}"
                         WHERE id = ?16 AND "${target.column}" IS NOT NULL)`
      )
      .bind(
        lotId,
        row.product_id,
        row.scope,
        row.scope_id,
        qty,
        cost.unitCostIqd,
        cost.purchaseUnitIqd,
        cost.shippingShareIqd,
        cost.internalShareIqd,
        cost.totalCostIqd,
        row.id,
        row.supplier_id,
        row.purchase_date,
        receivedAt,
        actorUserId,
        counterRowId
      )
  );

  statements.push(
    db
      .prepare(
        // HARD. The duplicate raises and D1 rolls the batch back — see the
        // module header for why `OR IGNORE` here was the bug and not the fix.
        `INSERT INTO incoming_inventory_receipts
           (id, incoming_id, lot_id, qty, idempotency_key, actor_user_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
      .bind(receiptId, row.id, lotId, qty, idem, actorUserId)
  );

  statements.push(
    db
      .prepare(
        `UPDATE "${target.table}" SET "${target.column}" = "${target.column}" + ?1
          WHERE id = ?2 AND "${target.column}" IS NOT NULL`
      )
      .bind(qty, counterRowId)
  );

  statements.push(
    db
      .prepare(
        // Also hard, and also UNIQUE-keyed: a second anchor on the same press.
        `INSERT INTO inventory_ledger
           (id, product_id, scope, scope_id, kind, qty, idempotency_key, actor_user_id, reason)
         VALUES (?1, ?2, ?3, ?4, 'adjust_in', ?5, ?6, ?7, ?8)`
      )
      .bind(
        `ilg_${receiptId}`.slice(0, 60),
        row.product_id,
        row.scope,
        row.scope_id,
        qty,
        `adjust_in:${idem}`,
        actorUserId,
        'stock received'
      )
  );

  statements.push(
    db
      .prepare(
        `UPDATE incoming_inventory
            SET qty_received = qty_received + ?1,
                status = ?2,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?3`
      )
      .bind(qty, statusAfterReceipt(row, qty), row.id)
  );

  return { statements, lotId, cost, status: statusAfterReceipt(row, qty) };
}

// ---------------------------------------------------------------------------
//  MANUAL ADJUSTMENT — §39
// ---------------------------------------------------------------------------

/** The reasons an admin may give. Compact on purpose (§39): these are REASONS
 *  for a correction, and turning them into sellable stock categories is exactly
 *  the taxonomy §32 forbids. */
export const ADJUST_REASONS = ['count', 'damaged', 'lost', 'supplier_shortage', 'other'] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

export const isAdjustReason = (v: unknown): v is AdjustReason =>
  typeof v === 'string' && (ADJUST_REASONS as readonly string[]).includes(v);

export interface AdjustInput {
  productId: string;
  scope: StockScope;
  scopeId: string;
  /** Signed: -1 for "the shelf says 10, I counted 9". */
  delta: number;
  reason: AdjustReason;
  note: string;
  operationId: string;
  actorUserId: string | null;
  /** For a POSITIVE adjustment: the lot the found units belong to. */
  lotId?: string | null;
  unitCostIqd?: number | null;
}

/**
 * A correction, as a movement rather than an overwrite.
 *
 * §39: the system says 10 and the shelf holds 9, so the answer is an
 * adjustment of −1 with a reason — not `SET stock = 9`, which leaves nobody
 * able to say what happened or when.
 *
 * A NEGATIVE ADJUSTMENT EATS LOTS IN FIFO ORDER, because the units that are
 * missing are units that were bought, and the oldest layer is the one the next
 * sale would have consumed. A positive one needs a lot to put them in: found
 * units with no lot would be units of unknown cost, so the caller either names
 * the lot they came from or states the cost, and `unit_cost_iqd` NULL is
 * recorded honestly when it genuinely is not known.
 *
 * IT IS SAFE TO REPLAY, for the reason the module header gives: the ledger row
 * goes in with a hard `INSERT` on a UNIQUE `idempotency_key` derived from the
 * caller's `operationId`, so a repeat raises and D1 rolls the counter back with
 * it. `INSERT OR IGNORE` plus `WHERE EXISTS (the ledger row)` would decrement
 * the shelf a second time — the `EXISTS` is true precisely because the first
 * attempt succeeded.
 *
 * AN OVER-LARGE WRITE-OFF ABORTS; IT DOES NOT PARTLY APPLY (§40). There is no
 * `AND stock >= ?` on the counter, on purpose: that guard made the UPDATE a
 * silent no-op, leaving a ledger row claiming a movement the shelf never made.
 * Without it, `stock - 5` on a shelf of 2 is -3 and
 * `CHECK (stock IS NULL OR stock >= 0)` — which every one of the four rungs
 * carries — takes the whole batch down. Nothing is recorded, and the caller is
 * told. The route checks first so the admin gets a sentence rather than a 500;
 * this is the lock behind that courtesy.
 */
export function planAdjustmentLedger(db: D1Database, input: AdjustInput): D1PreparedStatement[] {
  const target = counterTarget(input.scope);
  if (!target) throw new Error(`planAdjustment: scope ${input.scope} has no shelf`);
  const qty = Math.abs(input.delta);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('planAdjustment: delta must be a non-zero integer');
  const kind = input.delta > 0 ? 'adjust_in' : 'adjust_out';
  const idem = `${kind}:adj:${input.operationId}:${input.scope}:${input.scopeId || '-'}`;
  const rowId = input.scope === 'base' ? input.productId : input.scopeId;

  return [
    db
      .prepare(
        // Conditional on the rung TRACKING stock at all: on an untracked rung
        // no ledger row appears and the counter below moves nothing, so the two
        // cannot end up disagreeing. The route refuses that case by name.
        `INSERT INTO inventory_ledger
           (id, product_id, scope, scope_id, kind, qty, idempotency_key, actor_user_id, reason)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
          WHERE EXISTS (SELECT 1 FROM "${target.table}"
                         WHERE id = ?10 AND "${target.column}" IS NOT NULL)`
      )
      .bind(
        `ilg_adj_${input.operationId}`.slice(0, 60),
        input.productId,
        input.scope,
        input.scopeId,
        kind,
        qty,
        idem,
        input.actorUserId,
        `${input.reason}${input.note ? `: ${input.note}` : ''}`.slice(0, 200),
        rowId
      ),
    db
      .prepare(
        `UPDATE "${target.table}"
            SET "${target.column}" = "${target.column}" ${input.delta > 0 ? '+' : '-'} ?1
          WHERE id = ?2 AND "${target.column}" IS NOT NULL`
      )
      .bind(qty, rowId),
  ];
}
