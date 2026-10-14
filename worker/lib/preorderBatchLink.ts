/**
 * «اربط بالدفعة الواصلة» — A PRE-ORDER LINE TAKES THE BATCH THAT ARRIVED FOR IT
 * (the clean start's V2-6, addendum A.9 step 4; fixes F5).
 *
 * A pre-order line sells before its units exist, so it carries a frozen V2
 * estimate (0190) and no FIFO allocation. When its batch reaches the Levo
 * warehouse (the order's stage `at_levo_warehouse` or later), the owner links
 * the received lot(s) to the line: the units are consumed from those lots in
 * ONE batch with the lot decrement — so pre-order stock never inflates direct
 * stock — and the allocation rows carry `link_kind = 'preorder_batch'`. The
 * actual cost then replaces the estimate in `calculateGoods` (FIFO arm);
 * both stay visible («تقديري مقابل فعلي»). Unlinking is the existing release
 * path.
 *
 * Owner-only (cost write). Replay-safe: the idempotency key
 * `preorder_link:<item>:<lot>:<operation>` answers `already`. A database
 * before 0190 has no `link_kind`: 503 PRICING_NOT_INSTALLED.
 */
import { HttpError, badRequest, conflict, notFound } from './http';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { auditStatements } from './audit';
import { fence, isFenceMiss } from './operations';
import { cleanStartInstalled } from './engineInstalled';

/** The stages from which the pre-order's units are in the Levo warehouse. */
export const LINKABLE_STAGES: readonly string[] = ['at_levo_warehouse', 'local_delivery_prep', 'shipped', 'out_for_delivery', 'delivered'];
const MAX_LOTS = 10;

export interface LinkBatchResult {
  already: boolean;
  linked: Array<{ lot_id: string; qty: number }>;
}

interface LotRow {
  id: string;
  product_id: string | null;
  scope: string;
  scope_id: string;
  qty_remaining: number;
  unit_cost_iqd: number | null;
}

export async function linkPreorderBatch(
  db: D1Database,
  input: { orderId: string; itemId: string; lotIds: unknown; operationId: unknown; actor: string }
): Promise<LinkBatchResult> {
  if (!(await cleanStartInstalled(db))) {
    throw new HttpError(503, serverMessage('PRICING_NOT_INSTALLED'), 'PRICING_NOT_INSTALLED');
  }
  const op = typeof input.operationId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(input.operationId) ? input.operationId : null;
  if (!op) throw badRequest('operation_id: 8-80 letters, digits, _ or -', 'VALIDATION');
  if (!Array.isArray(input.lotIds) || input.lotIds.length < 1 || input.lotIds.length > MAX_LOTS || !input.lotIds.every((x) => typeof x === 'string' && /^[A-Za-z0-9_:-]{1,120}$/.test(x))) {
    throw badRequest(`lot_ids: 1-${MAX_LOTS} lot ids`, 'VALIDATION');
  }
  const lotIds = [...new Set(input.lotIds as string[])];

  const order = await db.prepare('SELECT id, shipping_type, status, stage FROM orders WHERE id = ?').bind(input.orderId).first<{ id: string; shipping_type: string; status: string; stage: string }>();
  if (!order) throw notFound('Order not found');
  const item = await db
    .prepare('SELECT id, order_id, product_id, qty FROM order_items WHERE id = ? AND order_id = ?')
    .bind(input.itemId, input.orderId)
    .first<{ id: string; order_id: string; product_id: string | null; qty: number }>();
  if (!item || !item.product_id) throw notFound('Order item not found');

  // Replay: every key of this operation already written — the same answer, nothing moves.
  const keys = lotIds.map((lot) => `preorder_link:${item.id}:${lot}:${op}`);
  const seen = (
    await db
      .prepare('SELECT idempotency_key, lot_id, qty FROM order_item_inventory_allocations WHERE idempotency_key IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(keys))
      .all<{ idempotency_key: string; lot_id: string; qty: number }>()
  ).results ?? [];
  if (seen.length) return { already: true, linked: seen.map((r) => ({ lot_id: r.lot_id, qty: Number(r.qty) })) };

  if (order.shipping_type === 'direct') throw conflict('هذا الطلب ليس طلبًا مسبقًا / this order is not a pre-order', 'PREORDER_LINK_NOT_PREORDER');
  if (!LINKABLE_STAGES.includes(order.stage) || order.status === 'cancelled') {
    throw conflict('الدفعة لم تصل إلى مستودع ليفو بعد / the batch has not reached the Levo warehouse yet', 'PREORDER_LINK_TOO_EARLY');
  }

  const held = await db
    .prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM order_item_inventory_allocations WHERE order_item_id = ? AND released_at IS NULL')
    .bind(item.id)
    .first<{ q: number }>();
  let need = Math.max(0, Number(item.qty) - Number(held?.q ?? 0));
  if (need <= 0) throw conflict('هذا البند مرتبط بالكامل / this line is already fully linked', 'PREORDER_LINK_COMPLETE');

  const lots = (
    await db
      .prepare(
        `SELECT l.id, l.product_id, l.scope, l.scope_id, l.qty_remaining,
                COALESCE((SELECT v.unit_cost_iqd FROM inventory_lot_cost_versions v WHERE v.lot_id = l.id ORDER BY v.version DESC LIMIT 1), l.unit_cost_iqd) AS unit_cost_iqd
           FROM inventory_lots l WHERE l.id IN (SELECT value FROM json_each(?))`
      )
      .bind(JSON.stringify(lotIds))
      .all<LotRow>()
  ).results ?? [];
  const byId = new Map(lots.map((l) => [l.id, l] as const));

  const statements: D1PreparedStatement[] = [];
  const linked: Array<{ lot_id: string; qty: number }> = [];
  for (const lotId of lotIds) {
    if (need <= 0) break;
    const lot = byId.get(lotId);
    if (!lot || lot.product_id !== item.product_id) throw badRequest(`lot_ids: ${lotId} is not a received lot of this product`, 'PREORDER_LINK_LOT');
    const take = Math.min(need, Number(lot.qty_remaining));
    if (take <= 0) continue;
    need -= take;
    const unit = lot.unit_cost_iqd === null || lot.unit_cost_iqd === undefined ? null : Number(lot.unit_cost_iqd);
    const key = `preorder_link:${item.id}:${lot.id}:${op}`;
    const allocationId = `ialloc_${key.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 120);
    statements.push(...fence(db, 'EXISTS (SELECT 1 FROM inventory_lots WHERE id = ? AND qty_remaining >= ?)', [lot.id, take]));
    statements.push(
      db
        .prepare(
          `INSERT INTO order_item_inventory_allocations
             (id, order_id, order_item_id, lot_id, scope, scope_id, qty, unit_cost_iqd, cogs_iqd, idempotency_key, link_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preorder_batch')`
        )
        .bind(allocationId, order.id, item.id, lot.id, lot.scope, lot.scope_id, take, unit, unit === null ? null : unit * take, key)
    );
    statements.push(db.prepare('UPDATE inventory_lots SET qty_remaining = qty_remaining - ? WHERE id = ? AND qty_remaining >= ?').bind(take, lot.id, take));
    linked.push({ lot_id: lot.id, qty: take });
  }
  if (!linked.length) throw conflict('لا توجد قطع متبقية في هذه الدفعات / these lots hold no remaining units', 'PREORDER_LINK_EMPTY');

  // Names and quantities only: a lot cost is never written to the audit log.
  const audit = await auditStatements(db, input.actor, 'order.preorder_batch_link', item.id, { order_id: order.id, order_item_id: item.id, lots: linked, operation_id: op });
  try {
    await db.batch([...statements, ...audit.statements]);
  } catch (e) {
    if (isFenceMiss(e)) throw conflict('تغيّرت كمية الدفعة — أعد المحاولة / the lot changed — try again', 'PREORDER_LINK_CHANGED');
    if (/UNIQUE constraint failed: order_item_inventory_allocations/i.test(e instanceof Error ? e.message : String(e))) return { already: true, linked };
    throw e;
  }
  return { already: false, linked };
}
