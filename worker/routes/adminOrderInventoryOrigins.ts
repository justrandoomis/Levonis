import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, notFound, str, conflict, unavailable } from '../lib/http';
import { requireSerialWrite, fence, isFenceMiss } from '../lib/operations';
import { auditStatements } from '../lib/audit';

/** This router is admin-only even when mounted independently. No cost column
 * is selected: source references are operational data available to assistants. */
export const adminOrderInventoryOriginRoutes = new Hono<AppContext>();
adminOrderInventoryOriginRoutes.use('/:id/inventory-origins', requireAdmin);
adminOrderInventoryOriginRoutes.use('/:id/inventory-origins/*', requireAdmin);

async function installed(db: D1Database) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('inventory_unit_origins','order_item_inventory_unit_assignments')").first<{ n: number }>();
  return row?.n === 2;
}

async function orderExists(db: D1Database, orderId: string) {
  if (!await db.prepare('SELECT id FROM orders WHERE id=?').bind(orderId).first()) throw notFound('Order not found');
}

/** Immutable consumption snapshots, including released history. Existing
 * serials are offered for explicit physical confirmation, never inferred to
 * be the purchased unit simply because the lot and order line happen to match. */
adminOrderInventoryOriginRoutes.get('/:id/inventory-origins', async (c) => {
  const db = c.env.DB, orderId = c.req.param('id');
  c.header('Cache-Control', 'private, no-store');
  await orderExists(db, orderId);
  if (!await installed(db)) return c.json({ success: true, installed: false, units: [], untracked: [] });
  const serialsInstalled = !!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='serial_assignments'").first();
  const serialColumns = serialsInstalled
    ? `s.id AS serial_assignment_id,s.serial_norm AS slot_serial_norm,s.lot_id AS serial_lot_id`
    : 'NULL AS serial_assignment_id,NULL AS slot_serial_norm,NULL AS serial_lot_id';
  const serialJoin = serialsInstalled
    ? `LEFT JOIN serial_assignments s ON s.order_id=a.order_id AND s.order_item_id=a.order_item_id AND s.unit_index=a.unit_index AND s.part='device' AND s.part_index=1 AND s.released_at IS NULL`
    : '';
  const [units, untracked] = await Promise.all([
    db.prepare(`SELECT a.id AS assignment_id,a.origin_id AS inventory_unit_id,a.order_item_ref AS order_item_id,
      a.unit_index,oi.name_snapshot AS product_name,oi.option_snapshot AS selection,a.lot_id,a.purchase_name AS batch_name,
      a.purchase_id,a.purchase_line_id,a.incoming_id,a.purchase_unit_index,a.supplier_order_no,a.tracking_no,
      a.assigned_at,a.released_at,a.release_reason,a.physical_verified_at,a.verified_serial_norm,
      u.serial_norm AS inventory_serial_norm,u.unavailable_reason,
      u.supplier_order_no AS current_supplier_order_no,u.tracking_no AS current_tracking_no,${serialColumns}
      FROM order_item_inventory_unit_assignments a JOIN inventory_unit_origins u ON u.id=a.origin_id
      LEFT JOIN order_items oi ON oi.id=a.order_item_id ${serialJoin}
      WHERE a.order_id=? ORDER BY a.order_item_ref,a.unit_index,a.assigned_at,a.id`).bind(orderId).all<Record<string, unknown>>(),
    db.prepare(`SELECT a.order_item_id,oi.name_snapshot AS product_name,a.lot_id,
      SUM(CASE WHEN a.released_at IS NULL THEN a.qty ELSE -a.qty END)-
      (SELECT COUNT(*) FROM order_item_inventory_unit_assignments u WHERE u.order_id=a.order_id AND u.order_item_id=a.order_item_id AND u.lot_id=a.lot_id AND u.released_at IS NULL) AS missing_qty
      FROM order_item_inventory_allocations a LEFT JOIN order_items oi ON oi.id=a.order_item_id
      WHERE a.order_id=? GROUP BY a.order_id,a.order_item_id,a.lot_id HAVING missing_qty>0`).bind(orderId).all<{order_item_id:string;product_name:string;lot_id:string;missing_qty:number}>(),
  ]);
  return c.json({ success: true, installed: true, units: (units.results ?? []).map((unit) => ({
    ...unit,
    state: unit.released_at ? 'released' : unit.unavailable_reason ? 'unavailable' : 'allocated',
    physical_match: !!unit.physical_verified_at && unit.verified_serial_norm === unit.slot_serial_norm && unit.serial_lot_id === unit.lot_id,
    can_confirm: !unit.released_at && !unit.unavailable_reason && !!unit.serial_assignment_id && unit.serial_lot_id === unit.lot_id &&
      (!unit.inventory_serial_norm || unit.inventory_serial_norm === unit.slot_serial_norm) && !unit.physical_verified_at,
  })), untracked: (untracked.results ?? []).map(({ missing_qty, ...row }) => ({ ...row, qty: missing_qty })) });
});

adminOrderInventoryOriginRoutes.post('/:id/inventory-origins/:assignmentId/confirm', async (c) => {
  const db = c.env.DB, user = c.get('user')!, orderId = c.req.param('id');
  await requireSerialWrite(c.env, user);
  if (!await installed(db)) throw unavailable('تتبع القطع غير متاح بعد', 'INVENTORY_ORIGINS_NOT_INSTALLED');
  await orderExists(db, orderId);
  const body = await c.req.json<Record<string, unknown>>();
  const originId = str(body.inventory_unit_id, 'inventory_unit_id', { min: 1, max: 120 });
  const serialId = str(body.serial_assignment_id, 'serial_assignment_id', { min: 1, max: 120 });
  const assignmentId = c.req.param('assignmentId');
  const condition = `EXISTS(SELECT 1 FROM order_item_inventory_unit_assignments a
    JOIN inventory_unit_origins u ON u.id=a.origin_id JOIN orders o ON o.id=a.order_id
    JOIN serial_assignments s ON s.order_id=a.order_id AND s.order_item_id=a.order_item_id AND s.unit_index=a.unit_index
    WHERE a.id=? AND a.order_id=? AND a.origin_id=? AND a.released_at IS NULL AND o.status<>'cancelled'
      AND s.id=? AND s.part='device' AND s.part_index=1 AND s.released_at IS NULL AND s.lot_id=a.lot_id
      AND u.current_lot_id=a.lot_id AND COALESCE(u.unavailable_reason,'')=''
      AND (u.serial_norm IS NULL OR u.serial_norm=s.serial_norm)
      AND (a.physical_verified_at IS NULL OR a.verified_serial_norm=s.serial_norm))`;
  const args = [assignmentId, orderId, originId, serialId];
  const valid = await db.prepare(`SELECT 1 WHERE ${condition}`).bind(...args).first();
  if (!valid) throw conflict('طابق رقم القطعة على الكرتون والرقم التسلسلي المسجل لنفس القطعة والدفعة، ثم حدّث الطلب.', 'INVENTORY_ORIGIN_MISMATCH');
  const existing = await db.prepare('SELECT physical_verified_at FROM order_item_inventory_unit_assignments WHERE id=?').bind(assignmentId).first<{ physical_verified_at: string | null }>();
  if (existing?.physical_verified_at) return c.json({ success: true, already: true });
  const now = new Date().toISOString();
  const audit = await auditStatements(db, user.id, 'inventory.origin_verified', originId, { order_id: orderId, assignment_id: assignmentId, serial_assignment_id: serialId });
  try {
    await db.batch([
      ...fence(db, condition, args),
      ...fence(db, 'EXISTS(SELECT 1 FROM order_item_inventory_unit_assignments WHERE id=? AND physical_verified_at IS NULL)', [assignmentId]),
      ...fence(db, 'NOT EXISTS(SELECT 1 FROM inventory_unit_origins WHERE serial_norm=(SELECT serial_norm FROM serial_assignments WHERE id=?) AND id<>?)', [serialId, originId]),
      db.prepare('UPDATE inventory_unit_origins SET serial_norm=(SELECT serial_norm FROM serial_assignments WHERE id=?) WHERE id=?').bind(serialId, originId),
      db.prepare('UPDATE order_item_inventory_unit_assignments SET physical_verified_at=?,verified_serial_norm=(SELECT serial_norm FROM serial_assignments WHERE id=?),verified_by=? WHERE id=? AND physical_verified_at IS NULL').bind(now, serialId, user.id, assignmentId),
      ...audit.statements,
    ]);
  } catch (error) {
    if (isFenceMiss(error) || /UNIQUE constraint failed: inventory_unit_origins.serial_norm/.test(String(error)))
      throw conflict('تغير تخصيص القطعة أو الرقم التسلسلي؛ حدّث الطلب وأعد المطابقة.', 'INVENTORY_ORIGIN_MISMATCH');
    throw error;
  }
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true });
});
