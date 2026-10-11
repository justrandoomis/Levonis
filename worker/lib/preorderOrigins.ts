/** Private supplier evidence for externally procured preorder pieces.
 * These records never create inventory, FIFO allocations, prices or COGS. */
import { badRequest, conflict, notFound, unavailable } from './http';
import { auditStatements } from './audit';
import { newId } from './crypto';
import { fence, isFenceMiss } from './operations';

export const PREORDER_ORIGIN_STAGES = ['confirmed', 'supplier_preparing', 'at_origin_warehouse', 'preparing_freight', 'at_levo_warehouse', 'local_delivery_prep'] as const;
export interface PreorderSourceFields {
  batch_name: string; batch_ref: string; purchase_ref: string;
  supplier_order_no: string; tracking_no: string; note: string;
}
interface OrderHead { id: string; shipping_type: string; status: string; stage: string }
interface SourceLine { order_item_id: string; product_name: string; selection: string; qty: number }
interface SourceRow extends PreorderSourceFields {
  id: string; order_id: string | null; order_ref: string; order_item_id: string | null; order_item_ref: string;
  unit_index: number; product_name: string; selection: string; version: number;
  created_at: string; updated_at: string;
}
const FIELDS = ['batch_name', 'batch_ref', 'purchase_ref', 'supplier_order_no', 'tracking_no', 'note'] as const;
const BLANK: PreorderSourceFields = { batch_name: '', batch_ref: '', purchase_ref: '', supplier_order_no: '', tracking_no: '', note: '' };

export const preorderOriginWindow = (order: OrderHead) => order.shipping_type !== 'direct' &&
  ['confirmed', 'processing'].includes(order.status) && (PREORDER_ORIGIN_STAGES as readonly string[]).includes(order.stage);

export async function preorderOriginsInstalled(db: D1Database) {
  return !!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='order_preorder_unit_origins'").first();
}

async function sourceContext(db: D1Database, orderId: string) {
  const order = await db.prepare('SELECT id,shipping_type,status,stage FROM orders WHERE id=?').bind(orderId).first<OrderHead>();
  if (!order) throw notFound('Order not found');
  const lines = (await db.prepare(`SELECT i.id AS order_item_id,i.name_snapshot AS product_name,i.option_snapshot AS selection,i.qty
    FROM order_items i WHERE i.order_id=? AND NOT EXISTS(SELECT 1 FROM order_items c WHERE c.bundle_parent_item_id=i.id) ORDER BY i.id`).bind(orderId).all<SourceLine>()).results ?? [];
  const installed = await preorderOriginsInstalled(db);
  const rows = installed ? (await db.prepare('SELECT * FROM order_preorder_unit_origins WHERE order_ref=? ORDER BY order_item_ref,unit_index').bind(orderId).all<SourceRow>()).results ?? [] : [];
  return { order, lines, rows, installed };
}

/** Public only to this admin router: no order/public/invoice serializer calls it. */
export async function preorderOriginsView(db: D1Database, orderId: string) {
  const context = await sourceContext(db, orderId);
  const { order, lines, rows, installed } = context;
  const historical = ['cancelled', 'delivered'].includes(order.status) || ['cancelled', 'delivered'].includes(order.stage);
  const saved = new Map(rows.map((r) => [`${r.order_item_ref}:${r.unit_index}`, r]));
  // A partial refund quantity cannot identify which printer returned. Only
  // exact warranty-unit evidence marks a slot returned; nothing is reassigned.
  const returned = installed ? (await db.prepare(`SELECT u.order_item_id,u.unit_index FROM order_item_units u WHERE u.order_id=? AND
    (EXISTS(SELECT 1 FROM return_cases r WHERE r.unit_id=u.id AND r.state='resolved' AND r.resolution='refund') OR
     EXISTS(SELECT 1 FROM stock_return_order_unit_evidence e JOIN return_cases r ON r.id=e.return_case_id
       WHERE e.unit_id=u.id AND r.state='resolved' AND r.resolution='refund'))`).bind(orderId).all<{ order_item_id: string; unit_index: number }>()).results ?? [] : [];
  const returnedSlots = new Set(returned.map((u) => `${u.order_item_id}:${u.unit_index}`));
  return {
    installed, editable: installed && preorderOriginWindow(order), historical,
    shipping_type: order.shipping_type, status: order.status, stage: order.stage, lines,
    rows: lines.flatMap((line) => Array.from({ length: line.qty }, (_, i) => {
      const unit_index = i + 1, found = saved.get(`${line.order_item_id}:${unit_index}`);
      return {
        id: found?.id ?? null, order_item_id: line.order_item_id, unit_index,
        product_name: found?.product_name ?? line.product_name, selection: found?.selection ?? line.selection,
        ...Object.fromEntries(FIELDS.map((key) => [key, found?.[key] ?? BLANK[key]])),
        version: found?.version ?? 0, created_at: found?.created_at ?? null, updated_at: found?.updated_at ?? null,
        state: order.status === 'cancelled' ? 'cancelled' : returnedSlots.has(`${line.order_item_id}:${unit_index}`) ? 'returned' : order.status === 'delivered' ? 'delivered' : 'active',
      };
    })),
  };
}

function onlyKeys(row: Record<string, unknown>, allowed: readonly string[]) {
  const fields = Object.keys(row).filter((key) => !allowed.includes(key));
  if (fields.length) throw badRequest('حقول غير مسموحة في بيانات مصدر القطعة', 'UNKNOWN_FIELD', { fields });
}
function sourceFields(raw: Record<string, unknown>): PreorderSourceFields {
  const normalized = { ...BLANK };
  for (const key of FIELDS) {
    const value = raw[key] ?? '';
    if (typeof value !== 'string' || value.trim().length > (key === 'note' ? 500 : 120) ||
      Array.from(value, (character) => character.charCodeAt(0)).some((code) => code === 127 || (code < 32 && !(key === 'note' && [9, 10, 13].includes(code)))))
      throw badRequest('بيانات المصدر غير صحيحة؛ الحقول 120 حرفاً والملاحظة 500 حرف', 'PREORDER_ORIGIN_INVALID');
    normalized[key] = value.trim();
  }
  if (!normalized.supplier_order_no) throw badRequest('أدخل رقم طلب المورد للقطعة', 'PREORDER_SUPPLIER_ORDER_REQUIRED');
  return normalized;
}

export async function savePreorderOrigins(db: D1Database, orderId: string, actorId: string, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('بيانات المصدر غير صحيحة', 'PREORDER_ORIGIN_INVALID');
  const body = raw as Record<string, unknown>;
  onlyKeys(body, ['units']);
  if (!Array.isArray(body.units) || !body.units.length || body.units.length > 500)
    throw badRequest('أرسل من قطعة واحدة إلى 500 قطعة في التحديث', 'PREORDER_ORIGIN_INVALID');
  const { order, lines, rows, installed } = await sourceContext(db, orderId);
  if (!installed) throw unavailable('تتبع مصدر الطلب المسبق غير مفعل بعد', 'PREORDER_ORIGINS_NOT_INSTALLED');
  if (!preorderOriginWindow(order)) throw conflict('تعديل مصدر القطعة متاح أثناء تجهيز الطلب المسبق فقط', 'PREORDER_ORIGINS_LOCKED');
  const saved = new Map(rows.map((r) => [`${r.order_item_ref}:${r.unit_index}`, r]));
  const seen = new Set<string>(), now = new Date().toISOString();
  const changes: Array<PreorderSourceFields & { id: string; expected: number; order_item_id: string; unit_index: number; qty: number; product_name: string; selection: string }> = [];
  for (const value of body.units) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('بيانات القطعة غير صحيحة', 'PREORDER_ORIGIN_INVALID');
    const unit = value as Record<string, unknown>;
    onlyKeys(unit, ['order_item_id', 'unit_index', 'version', ...FIELDS]);
    const line = lines.find((l) => l.order_item_id === unit.order_item_id);
    if (!line || typeof unit.unit_index !== 'number' || !Number.isInteger(unit.unit_index) || unit.unit_index < 1 || unit.unit_index > line.qty)
      throw badRequest('القطعة ليست ضمن بنود هذا الطلب أو تتجاوز كميته', 'PREORDER_ORIGIN_INVALID');
    const key = `${line.order_item_id}:${unit.unit_index}`;
    if (seen.has(key)) throw badRequest('تكرر رقم القطعة في التحديث', 'PREORDER_ORIGIN_INVALID');
    seen.add(key);
    const fields = sourceFields(unit), before = saved.get(key);
    // Exact replay is a read-only success even with the prior version. It
    // neither advances the version nor writes a second audit fact.
    if (before && FIELDS.every((field) => fields[field] === before[field])) continue;
    const expected = unit.version ?? 0;
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0 || expected !== (before?.version ?? 0))
      throw conflict('تغيرت بيانات القطعة؛ حدّث الطلب وأعد المحاولة', 'PREORDER_ORIGIN_VERSION_CHANGED');
    changes.push({ ...fields, id: before?.id ?? newId('porigin'), expected, order_item_id: line.order_item_id, unit_index: unit.unit_index, qty: line.qty, product_name: line.product_name, selection: line.selection });
  }
  if (changes.length) {
    const operationId = newId('porigop');
    const statements = fence(db, 'EXISTS(SELECT 1 FROM orders WHERE id=? AND shipping_type=? AND status=? AND stage=?)', [order.id, order.shipping_type, order.status, order.stage]);
    // Bounded JSON chunks: 500 pieces require 27 statements plus one audit
    // plan, rather than thousands of independent per-piece D1 statements.
    for (let offset = 0; offset < changes.length; offset += 100) {
      const entries = JSON.stringify(changes.slice(offset, offset + 100));
      statements.push(...fence(db, `NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE
        NOT EXISTS(SELECT 1 FROM order_items i WHERE i.id=json_extract(j.value,'$.order_item_id') AND i.order_id=? AND i.qty=json_extract(j.value,'$.qty')
          AND NOT EXISTS(SELECT 1 FROM order_items c WHERE c.bundle_parent_item_id=i.id)) OR
        (json_extract(j.value,'$.expected')=0 AND EXISTS(SELECT 1 FROM order_preorder_unit_origins p WHERE p.order_ref=? AND p.order_item_ref=json_extract(j.value,'$.order_item_id') AND p.unit_index=json_extract(j.value,'$.unit_index'))) OR
        (json_extract(j.value,'$.expected')>0 AND NOT EXISTS(SELECT 1 FROM order_preorder_unit_origins p WHERE p.id=json_extract(j.value,'$.id') AND p.version=json_extract(j.value,'$.expected'))))`,
        [entries, orderId, orderId]));
      statements.push(db.prepare(`UPDATE order_preorder_unit_origins SET
        (batch_name,batch_ref,purchase_ref,supplier_order_no,tracking_no,note)=(SELECT ${FIELDS.map((field) => `json_extract(j.value,'$.${field}')`).join(',')}
          FROM json_each(?1) j WHERE json_extract(j.value,'$.id')=order_preorder_unit_origins.id),
        version=version+1,updated_by=?2,updated_at=?3
        WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?1) WHERE json_extract(value,'$.expected')>0)`)
        .bind(entries, actorId, now));
      statements.push(db.prepare(`INSERT INTO order_preorder_unit_origins
        (id,order_id,order_ref,order_item_id,order_item_ref,unit_index,product_name,selection,batch_name,batch_ref,purchase_ref,supplier_order_no,tracking_no,note,version,created_by,updated_by,created_at,updated_at)
        SELECT json_extract(value,'$.id'),?2,?2,json_extract(value,'$.order_item_id'),json_extract(value,'$.order_item_id'),json_extract(value,'$.unit_index'),
          json_extract(value,'$.product_name'),json_extract(value,'$.selection'),${FIELDS.map((field) => `json_extract(value,'$.${field}')`).join(',')},1,?3,?3,?4,?4
        FROM json_each(?1) WHERE json_extract(value,'$.expected')=0`).bind(entries, orderId, actorId, now));
      statements.push(db.prepare(`INSERT INTO order_preorder_unit_origin_versions
        (origin_id,version,operation_id,order_ref,order_item_ref,unit_index,batch_name,batch_ref,purchase_ref,supplier_order_no,tracking_no,note,actor_id,recorded_at)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.expected')+1,?2,?3,json_extract(value,'$.order_item_id'),json_extract(value,'$.unit_index'),
          ${FIELDS.map((field) => `json_extract(value,'$.${field}')`).join(',')},?4,?5 FROM json_each(?1)`)
        .bind(entries, operationId, orderId, actorId, now));
    }
    statements.push(...(await auditStatements(db, actorId, 'order.preorder_origins_updated', orderId, { operation_id: operationId, units_changed: changes.length, history_table: 'order_preorder_unit_origin_versions' })).statements);
    try { await db.batch(statements); }
    catch (error) {
      if (isFenceMiss(error) || /UNIQUE constraint failed: order_preorder_unit_origins/.test(String(error)))
        throw conflict('تغير الطلب أو بيانات القطع؛ حدّث الصفحة وأعد المحاولة', 'PREORDER_ORIGIN_VERSION_CHANGED');
      throw error;
    }
  }
  return { ...(await preorderOriginsView(db, orderId)), already: changes.length === 0 };
}
