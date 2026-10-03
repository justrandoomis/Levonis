import { badRequest, conflict, notFound } from './http';
import { counterTarget, type AdjustInput } from './inventoryReceiving';

/** One physical correction: quantity, FIFO layers and its movement commit together. */
export async function planAtomicAdjustment(db: D1Database, input: AdjustInput & { expectedStock?: number }) {
  const target = counterTarget(input.scope);
  if (!target) throw badRequest('Invalid physical stock scope', 'BAD_SCOPE');
  const scopeId = input.scope === 'base' ? '' : input.scopeId;
  const rowId = input.scope === 'base' ? input.productId : scopeId;
  const kind = input.delta > 0 ? 'adjust_in' : 'adjust_out';
  const key = `${kind}:adj:${input.operationId}:${input.productId}:${input.scope}:${scopeId || '-'}`;
  const existing = await db
    .prepare('SELECT product_id, scope, scope_id, kind, qty FROM inventory_ledger WHERE idempotency_key = ?')
    .bind(key)
    .first<{ product_id: string; scope: string; scope_id: string; kind: string; qty: number }>();
  if (existing) {
    if (existing.qty !== Math.abs(input.delta))
      throw conflict('This operation was already used for a different quantity', 'IDEMPOTENCY_MISMATCH');
    return { already: true, statements: [] as D1PreparedStatement[], valueIqd: null as number | null };
  }
  const product = await db
    .prepare('SELECT inventory_mode FROM products WHERE id = ?')
    .bind(input.productId)
    .first<{ inventory_mode: string }>();
  if (!product) throw notFound('Product not found');
  const scopeMode = { base: 'BASE', option: 'OPTION', color: 'COLOR', variant: 'VARIANT_COMBINATION' };
  if (product.inventory_mode !== scopeMode[input.scope as keyof typeof scopeMode])
    throw badRequest('اختر مستوى المخزون الفعلي للمنتج', 'SCOPE_MODE_MISMATCH');
  const reservedColumn = input.scope === 'base' ? 'stock_reserved' : 'reserved';
  const ownerClause = input.scope === 'base' ? '' : ' AND product_id = ?';
  const shelf = await db
    .prepare(`SELECT stock, ${reservedColumn} AS reserved FROM ${target.table} WHERE id = ?${ownerClause}`)
    .bind(rowId, ...(input.scope === 'base' ? [] : [input.productId]))
    .first<{ stock: number | null; reserved: number }>();
  if (!shelf) throw notFound('This stock selection does not belong to the product');
  if (shelf.stock === null) throw badRequest('فعّل تتبع المخزون قبل الجرد', 'STOCK_NOT_TRACKED');
  if (input.expectedStock !== undefined && shelf.stock !== input.expectedStock)
    throw conflict('تغير المخزون منذ فتح الجرد؛ حدّث الكمية أولاً', 'STOCK_CHANGED');
  if (!Number.isSafeInteger(input.delta) || input.delta === 0)
    throw badRequest('Invalid adjustment quantity', 'ZERO_DELTA');
  if (shelf.stock + input.delta < 0)
    throw badRequest(`لا يمكن خصم ${Math.abs(input.delta)} من ${shelf.stock} وحدة`, 'INSUFFICIENT_STOCK', {
      on_hand: shelf.stock,
    });
  if (shelf.stock + input.delta < shelf.reserved)
    throw conflict('الكمية الجديدة أقل من المخزون المحجوز لطلبات العملاء', 'RESERVED_STOCK');
  const lots =
    input.delta < 0
      ? ((
          await db
            .prepare(
              `SELECT id, qty_remaining, unit_cost_iqd FROM inventory_lots
    WHERE product_id = ? AND scope = ? AND scope_id = ? AND qty_remaining > 0 ORDER BY received_at, id`,
            )
            .bind(input.productId, input.scope, scopeId)
            .all<{ id: string; qty_remaining: number; unit_cost_iqd: number | null }>()
        ).results ?? [])
      : [];
  const touched: Array<{ id: string; remaining: number; take: number }> = [];
  let left = Math.abs(input.delta);
  let valueIqd: number | null = 0;
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(left, lot.qty_remaining);
    touched.push({ id: lot.id, remaining: lot.qty_remaining, take });
    left -= take;
    if (lot.unit_cost_iqd === null) valueIqd = null;
    else if (valueIqd !== null) valueIqd += take * lot.unit_cost_iqd;
  }
  if (input.delta < 0 && left > 0)
    throw conflict(
      'دفعات التكلفة لا تطابق الكمية؛ راجع تقرير المطابقة قبل التسوية',
      'INVENTORY_COST_MISMATCH',
    );
  const qty = Math.abs(input.delta);
  const checkLots = JSON.stringify(touched);
  const statements = [
    db
      .prepare(
        `INSERT INTO inventory_ledger
    (id, product_id, scope, scope_id, kind, qty, idempotency_key, actor_user_id, reason)
    SELECT ?1, ?2, ?3, ?4, ?5,
      CASE WHEN (SELECT stock FROM ${target.table} WHERE id = ?10) = ?11
        AND (SELECT ${reservedColumn} FROM ${target.table} WHERE id = ?10) <= ?11 + ?12
        AND NOT EXISTS (SELECT 1 FROM json_each(?13) g LEFT JOIN inventory_lots l ON l.id = json_extract(g.value,'$.id')
          WHERE l.qty_remaining IS NOT json_extract(g.value,'$.remaining')) THEN ?6 ELSE 0 END,
      ?7, ?8, ?9`,
      )
      .bind(
        `ilg_adj_${input.operationId}`.slice(0, 60),
        input.productId,
        input.scope,
        scopeId,
        kind,
        qty,
        key,
        input.actorUserId,
        `${input.reason}${input.note ? `: ${input.note}` : ''}`.slice(0, 200),
        rowId,
        shelf.stock,
        input.delta,
        checkLots,
      ),
    db.prepare(`UPDATE ${target.table} SET stock = stock + ? WHERE id = ?`).bind(input.delta, rowId),
  ];
  if (input.delta > 0) {
    const cost = input.unitCostIqd ?? null;
    if (cost !== null && (!Number.isSafeInteger(cost) || cost < 0))
      throw badRequest('Invalid unit cost', 'BAD_COST');
    valueIqd = cost === null ? null : cost * qty;
    statements.push(
      db
        .prepare(
          `INSERT INTO inventory_lots
      (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, purchase_unit_iqd,
       shipping_share_iqd, internal_share_iqd, total_cost_iqd, cost_basis, received_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
        )
        .bind(
          `ilot_adj_${input.operationId}`.slice(0, 60),
          input.productId,
          input.scope,
          scopeId,
          qty,
          qty,
          cost,
          cost,
          valueIqd,
          cost === null ? 'opening_unpriced' : 'opening',
          new Date().toISOString(),
          input.actorUserId,
        ),
    );
  } else
    for (const lot of touched)
      statements.push(
        db
          .prepare('UPDATE inventory_lots SET qty_remaining = qty_remaining - ? WHERE id = ?')
          .bind(lot.take, lot.id),
      );
  return { already: false, statements, valueIqd };
}
