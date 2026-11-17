/**
 * «تصحيح الفرق» — THE COST LAYERS ARE BROUGHT TO THE SHELF COUNTER, NEVER THE
 * OTHER WAY ROUND.
 *
 * The «دقة المخزون» card compares two numbers for one stock identity
 * (product + scope + scope_id):
 *
 *   stock      the counter on products / product_option_values / product_colors
 *              / product_variants — what the shop sells from, moved by every
 *              order, receipt, count and by the product editor's stock field;
 *   lot units  SUM(inventory_lots.qty_remaining) — the FIFO cost layers.
 *
 * 0098's header is the rule: lots are "NOT a second inventory system … no
 * second opinion about how many units there are". The counter is the quantity;
 * the lots only say what those units cost. Every difference on the card is a
 * counter that moved without its layers — the product editor's direct stock
 * figure (productPersistence / adminProductRelations), the editor's
 * `/stock/adjust` (planInventory, counter only), a CSV import, a deduction whose
 * FIFO queue was short (planLotConsumption logs and carries on). So a fix that
 * changed the counter would change what the shop sells on a button press; a fix
 * that changes the layers changes only the cost bookkeeping:
 *
 *   stock > lots  (+n)  n units on the shelf have no cost layer. One lot of n is
 *                       opened at UNKNOWN cost ('opening_unpriced', unit cost
 *                       NULL — 0098 §21 "do NOT invent one"); finance then says
 *                       those units' COGS is unknown instead of silently zero.
 *   stock < lots  (−n)  the layers hold n units the shelf no longer has. They
 *                       leave FIFO, oldest first — exactly as a count session's
 *                       write-off takes them (planAtomicAdjustment) — and their
 *                       known value is journalled 5300/1200 like a count's.
 *
 * Each fix writes one `inventory_ledger` row (adjust_in / adjust_out, reason
 * `reconcile`) so it is visible under «الحركات» with its actor; its UNIQUE
 * idempotency key is the replay guard. One ops_guards fence holds the counter,
 * the identity's lot total and every touched lot at the figures the person
 * confirmed: a concurrent sale, receipt or count refuses the whole batch.
 */
import { HttpError, badRequest, conflict, notFound } from './http';
import { counterTarget } from './inventoryReceiving';
import { planMoveUnitOrigins } from './inventoryUnitOrigins';
import { effectiveLotCostSql } from './inventoryLots';
import { baghdadDay, fence, journalPlan } from './operations';
import { newId } from './crypto';
import type { StockScope } from './inventory';
import { investorFinanceInstalled } from './investorFinance';
import { serverMessage } from '../../packages/contracts/src/costRefusals';

/** An active investment contract funds the lot's purchase: its write-off is the investor's loss too. */
const FUNDED_SQL = (alias: string) =>
  `EXISTS(SELECT 1 FROM investment_contracts c WHERE c.incoming_id=${alias}.incoming_id AND c.state='active')`;

/**
 * Which of these −n rows would take units from an investor-funded lot when n
 * leaves FIFO. Such a row is never written off here: only the lot count on
 * that batch posts the investor's capital loss (RECONCILE_INVESTOR_LOT).
 * One statement for the whole page; keys are `product:scope:scope_id`.
 */
export async function fundedWriteOffRows(
  db: D1Database,
  rows: ReadonlyArray<{ product_id: string; scope: string; scope_id: string; need: number }>,
): Promise<Set<string>> {
  const wanted = rows.filter((r) => r.need > 0);
  if (!wanted.length || !(await investorFinanceInstalled(db))) return new Set();
  const { results } = await db
    .prepare(
      `WITH want AS (SELECT json_extract(value,'$.p') AS p, json_extract(value,'$.s') AS s, json_extract(value,'$.i') AS i, json_extract(value,'$.n') AS n FROM json_each(?)),
       q AS (SELECT l.product_id,l.scope,l.scope_id,l.incoming_id,w.n,
               SUM(l.qty_remaining) OVER (PARTITION BY l.product_id,l.scope,l.scope_id ORDER BY l.received_at,l.created_at,l.id ROWS UNBOUNDED PRECEDING)-l.qty_remaining AS before
             FROM inventory_lots l JOIN want w ON w.p=l.product_id AND w.s=l.scope AND w.i=l.scope_id WHERE l.qty_remaining>0)
       SELECT DISTINCT product_id,scope,scope_id FROM q WHERE before<n AND ${FUNDED_SQL('q')}`,
    )
    .bind(JSON.stringify(wanted.map((r) => ({ p: r.product_id, s: r.scope, i: r.scope === 'base' ? '' : r.scope_id, n: r.need }))))
    .all<{ product_id: string; scope: string; scope_id: string }>();
  return new Set((results ?? []).map((r) => `${r.product_id}:${r.scope}:${r.scope_id}`));
}

export const RECONCILE_REASON = 'reconcile';
const SCOPE_MODE: Record<string, string> = { base: 'BASE', option: 'OPTION', color: 'COLOR', variant: 'VARIANT_COMBINATION' };

export interface ReconcileInput {
  operationId: string;
  productId: string;
  scope: StockScope;
  scopeId: string;
  /** The counter the person saw when they confirmed. */
  expectedStock: number;
  /** The lot units the person saw when they confirmed. */
  expectedLotUnits: number;
  actorUserId: string;
}

export interface ReconcilePlan {
  already: boolean;
  /** Units the layers move by: + opened at unknown cost, − written off FIFO. */
  delta: number;
  statements: D1PreparedStatement[];
  /** The known value written off; null when a consumed lot has no cost; 0 for an opening. */
  valueIqd: number | null;
}

export const reconcileKey = (i: Pick<ReconcileInput, 'operationId' | 'productId' | 'scope' | 'scopeId'>) =>
  `reconcile:${i.operationId}:${i.productId}:${i.scope}:${(i.scope === 'base' ? '' : i.scopeId) || '-'}`;

export async function planReconcile(db: D1Database, input: ReconcileInput): Promise<ReconcilePlan> {
  const target = counterTarget(input.scope);
  if (!target) throw badRequest('Invalid physical stock scope', 'BAD_SCOPE');
  const scopeId = input.scope === 'base' ? '' : input.scopeId;
  if (input.scope !== 'base' && !scopeId) throw badRequest('scope_id is required for this stock level', 'BAD_SCOPE');
  const rowId = input.scope === 'base' ? input.productId : scopeId;
  const key = reconcileKey(input);
  const expectedDelta = input.expectedStock - input.expectedLotUnits;

  const prior = await db
    .prepare('SELECT kind, qty FROM inventory_ledger WHERE idempotency_key = ?')
    .bind(key)
    .first<{ kind: string; qty: number }>();
  if (prior) {
    const priorDelta = prior.kind === 'adjust_in' ? prior.qty : -prior.qty;
    if (priorDelta !== expectedDelta)
      throw conflict('This operation was already used for a different correction', 'IDEMPOTENCY_MISMATCH');
    return { already: true, delta: priorDelta, statements: [], valueIqd: null };
  }

  const product = await db
    .prepare('SELECT inventory_mode FROM products WHERE id = ?')
    .bind(input.productId)
    .first<{ inventory_mode: string }>();
  if (!product) throw notFound('Product not found');
  if (product.inventory_mode !== SCOPE_MODE[input.scope])
    throw badRequest('اختر مستوى المخزون الفعلي للمنتج', 'SCOPE_MODE_MISMATCH');
  const ownerClause = input.scope === 'base' ? '' : ' AND product_id = ?';
  const shelf = await db
    .prepare(`SELECT stock FROM ${target.table} WHERE id = ?${ownerClause}`)
    .bind(rowId, ...(input.scope === 'base' ? [] : [input.productId]))
    .first<{ stock: number | null }>();
  if (!shelf) throw notFound('This stock selection does not belong to the product');
  if (shelf.stock === null) throw badRequest('فعّل تتبع المخزون أولًا', 'STOCK_NOT_TRACKED');
  const layers = await db
    .prepare('SELECT COALESCE(SUM(qty_remaining),0) AS units FROM inventory_lots WHERE product_id = ? AND scope = ? AND scope_id = ?')
    .bind(input.productId, input.scope, scopeId)
    .first<{ units: number }>();
  const lotUnits = Number(layers?.units ?? 0);
  if (shelf.stock !== input.expectedStock || lotUnits !== input.expectedLotUnits)
    throw new HttpError(409, 'تغيّر المخزون منذ فتح الصفحة؛ حدّث ثم أعد المحاولة', 'STOCK_CHANGED', {
      product_id: input.productId, scope: input.scope, scope_id: scopeId,
    });
  const delta = shelf.stock - lotUnits;
  if (delta === 0) return { already: false, delta: 0, statements: [], valueIqd: 0 };

  const qty = Math.abs(delta);
  const touched: Array<{ id: string; remaining: number; take: number }> = [];
  let valueIqd: number | null = 0;
  if (delta < 0) {
    const cost = await effectiveLotCostSql(db, 'inventory_lots');
    const funded = (await investorFinanceInstalled(db)) ? FUNDED_SQL('inventory_lots') : '0';
    const lots =
      (
        await db
          .prepare(
            `SELECT id, qty_remaining, ${cost} AS unit_cost_iqd, ${funded} AS funded FROM inventory_lots
              WHERE product_id = ? AND scope = ? AND scope_id = ? AND qty_remaining > 0
              ORDER BY received_at, created_at, id`,
          )
          .bind(input.productId, input.scope, scopeId)
          .all<{ id: string; qty_remaining: number; unit_cost_iqd: number | null; funded: number }>()
      ).results ?? [];
    let left = qty;
    for (const lot of lots) {
      if (left === 0) break;
      const take = Math.min(left, lot.qty_remaining);
      // Never here: the investor's capital loss is posted by the lot count alone.
      if (Number(lot.funded))
        throw new HttpError(409, serverMessage('RECONCILE_INVESTOR_LOT'), 'RECONCILE_INVESTOR_LOT', {
          product_id: input.productId, scope: input.scope, scope_id: scopeId, lot_id: lot.id,
        });
      touched.push({ id: lot.id, remaining: lot.qty_remaining, take });
      left -= take;
      if (lot.unit_cost_iqd === null) valueIqd = null;
      else if (valueIqd !== null) valueIqd += take * lot.unit_cost_iqd;
    }
    // Cannot happen: lotUnits > stock >= 0 was read above. A defensive refusal, not a partial write.
    if (left > 0) throw conflict('تغيّرت الدفعات أثناء القراءة؛ حدّث الصفحة', 'STOCK_CHANGED');
  }

  // THE FENCE: the counter, the identity's lot total and each touched lot exactly as read.
  const statements: D1PreparedStatement[] = [
    ...fence(
      db,
      `(SELECT stock FROM ${target.table} WHERE id = ?) = ?
        AND (SELECT COALESCE(SUM(qty_remaining),0) FROM inventory_lots WHERE product_id = ? AND scope = ? AND scope_id = ?) = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) g LEFT JOIN inventory_lots l ON l.id = json_extract(g.value,'$.id')
                         WHERE l.qty_remaining IS NOT json_extract(g.value,'$.remaining'))`,
      [rowId, shelf.stock, input.productId, input.scope, scopeId, lotUnits, JSON.stringify(touched)],
    ),
    db
      .prepare(
        `INSERT INTO inventory_ledger (id, product_id, scope, scope_id, kind, qty, idempotency_key, actor_user_id, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId('ilg_rec'),
        input.productId,
        input.scope,
        scopeId,
        delta > 0 ? 'adjust_in' : 'adjust_out',
        qty,
        key,
        input.actorUserId,
        `${RECONCILE_REASON}: cost lots matched to the shelf count (${delta > 0 ? '+' : '−'}${qty}); shelf unchanged`,
      ),
  ];
  if (delta > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO inventory_lots
             (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, purchase_unit_iqd,
              shipping_share_iqd, internal_share_iqd, total_cost_iqd, cost_basis, received_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, NULL, 'opening_unpriced', ?, ?)`,
        )
        .bind(newId('ilot_rec'), input.productId, input.scope, scopeId, qty, qty, new Date().toISOString(), input.actorUserId),
    );
  } else {
    for (const lot of touched) {
      try {
        statements.push(
          ...(await planMoveUnitOrigins(db, { lotId: lot.id, qty: lot.take, lotRemaining: lot.remaining, reason: `adjustment:${RECONCILE_REASON}` })),
        );
      } catch (error) {
        if (error instanceof HttpError && error.code === 'UNIT_ORIGIN_SELECTION_REQUIRED')
          throw new HttpError(
            409,
            'هذه الدفعة فيها قطع معرّفة؛ صحّح فرقها من «جرد دفعة محددة» وحدد القطع المفقودة بأرقامها الداخلية',
            'UNIT_ORIGIN_LOT_COUNT_REQUIRED',
            { lot_id: lot.id },
          );
        throw error;
      }
      statements.push(db.prepare('UPDATE inventory_lots SET qty_remaining = qty_remaining - ? WHERE id = ?').bind(lot.take, lot.id));
    }
    // The count session's journal for the same write-off (adminStockOperations POST /counts/:id/post).
    if (valueIqd !== null && valueIqd > 0)
      statements.push(
        ...journalPlan(
          db,
          { key, day: baghdadDay(), title: 'تسوية دفعات المخزون', source: 'count', sourceId: input.operationId, actor: input.actorUserId },
          [
            { account: '5300', debit: valueIqd },
            { account: '1200', credit: valueIqd },
          ],
        ).statements,
      );
  }
  return { already: false, delta, statements, valueIqd: delta > 0 ? null : valueIqd };
}
