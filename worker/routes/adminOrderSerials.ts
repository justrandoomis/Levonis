/**
 * Admin — SERIALS AT ORDER PREPARATION (migration 0177; owner brief
 * 2026-10-07). The doors of worker/lib/serialAssignments.ts.
 *
 * Mounted at /api/admin/orders beside the price-adjustment router (the
 * `/api/admin/` gateway rule covers it), guarded here by `requireAdmin` on its
 * own paths so it stays closed if it is ever mounted elsewhere.
 *
 *   GET  /:id/serials            the order's slots (the order detail carries the same `serials`)
 *   POST /:id/serials/scan       { order_item_id, unit_index, part?, code, ean?, box_sn?, source, op_id }
 *   POST /:id/serials/change     { assignment_id, code, ean?, box_sn?, source, op_id }
 *   POST /:id/serials/unlink     { assignment_id, reason? }        (owner only outside the window, with a reason)
 *   POST /:id/serials/override   { order_item_id, unit_index, part?, code, ean?, box_sn?, kind, reason, warranty_mode?, op_id }
 *
 * WHO. Any admin may scan, change and unlink while the order is being
 * prepared, unless the owner revoked their `receive` operations capability
 * (worker/lib/operations.ts — the capability that already gates serial→lot
 * linking). Every exception is the OWNER's (INITIAL_ADMIN_EMAIL): taking a
 * serial from another order, a delivered or unavailable device, outside the
 * window, a batch or model mismatch — each with a 5–500 character reason,
 * audited inside the same batch.
 *
 * ERRORS are codes with the brief's Arabic sentence (§31) and never a trace;
 * the screen localises by code (src/lib/refusalStrings.ts).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, int, str, oneOf } from '../lib/http';
import { requireCapability } from '../lib/operations';
import {
  OVERRIDE_KINDS,
  linkSerial,
  orderSerialsView,
  refuse,
  serialActor,
  unlinkSerial,
  type LinkSource,
  type OverrideKind,
} from '../lib/serialAssignments';

export const adminOrderSerialRoutes = new Hono<AppContext>();
adminOrderSerialRoutes.use('/:id/serials', requireAdmin);
adminOrderSerialRoutes.use('/:id/serials/*', requireAdmin);

const SOURCES: readonly LinkSource[] = ['camera', 'scanner', 'manual', 'relink'];

async function body(c: Context<AppContext>): Promise<Record<string, unknown>> {
  return ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

function orderIdOf(c: Context<AppContext>): string {
  const id = c.req.param('id') ?? '';
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw refuse(404, 'ORDER_NOT_FOUND');
  return id;
}

const codeOf = (b: Record<string, unknown>) => {
  if (typeof b.code !== 'string' || !b.code.trim()) throw refuse(400, 'SERIAL_INVALID', { problem: 'SERIAL_EMPTY' });
  return b.code.slice(0, 200);
};
const opOf = (b: Record<string, unknown>) => str(b.op_id, 'op_id', { min: 8, max: 80 });

adminOrderSerialRoutes.get('/:id/serials', async (c) => {
  const view = await orderSerialsView(c.env, serialActor(c.env, c.get('user')!), orderIdOf(c));
  return c.json({ success: true, serials: view });
});

adminOrderSerialRoutes.post('/:id/serials/scan', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'receive');
  const b = await body(c);
  const res = await linkSerial(c.env, serialActor(c.env, user), {
    orderId: orderIdOf(c),
    orderItemId: str(b.order_item_id, 'order_item_id', { min: 1, max: 80 }),
    unitIndex: int(b.unit_index, 'unit_index', { min: 1, max: 500 }),
    part: b.part === undefined ? 'device' : str(b.part, 'part', { max: 10 }),
    code: codeOf(b),
    ean: b.ean,
    boxSn: b.box_sn,
    source: oneOf(b.source ?? 'manual', 'source', SOURCES),
    opId: opOf(b),
  });
  return c.json(res);
});

adminOrderSerialRoutes.post('/:id/serials/change', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'receive');
  const b = await body(c);
  const orderId = orderIdOf(c);
  const assignmentId = str(b.assignment_id, 'assignment_id', { min: 1, max: 80 });
  const row = await c.env.DB.prepare(
    'SELECT order_item_id, unit_index, part FROM serial_assignments WHERE id = ? AND order_id = ? AND released_at IS NULL'
  )
    .bind(assignmentId, orderId)
    .first<{ order_item_id: string; unit_index: number; part: string }>()
    .catch(() => null);
  if (!row) throw refuse(404, 'SERIAL_ASSIGNMENT_NOT_FOUND');
  const res = await linkSerial(c.env, serialActor(c.env, user), {
    orderId,
    orderItemId: row.order_item_id,
    unitIndex: row.unit_index,
    part: row.part,
    code: codeOf(b),
    ean: b.ean,
    boxSn: b.box_sn,
    source: oneOf(b.source ?? 'manual', 'source', SOURCES),
    opId: opOf(b),
    replaceAssignmentId: assignmentId,
  });
  return c.json(res);
});

adminOrderSerialRoutes.post('/:id/serials/unlink', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'receive');
  const b = await body(c);
  const res = await unlinkSerial(c.env, serialActor(c.env, user), {
    orderId: orderIdOf(c),
    assignmentId: str(b.assignment_id, 'assignment_id', { min: 1, max: 80 }),
    reason: str(b.reason, 'reason', { max: 500, required: false }),
  });
  return c.json(res);
});

adminOrderSerialRoutes.post('/:id/serials/override', async (c) => {
  const user = c.get('user')!;
  const actor = serialActor(c.env, user);
  // §11/§25: Main Admin only, a mandatory reason, the full audit.
  if (!actor.owner) throw refuse(403, 'OWNER_ONLY');
  const b = await body(c);
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < 5 || reason.length > 500) throw refuse(400, 'OVERRIDE_REASON_REQUIRED');
  const kind = oneOf(b.kind, 'kind', OVERRIDE_KINDS) as OverrideKind;
  const mode = b.warranty_mode === undefined || b.warranty_mode === null ? undefined : oneOf(b.warranty_mode, 'warranty_mode', ['carry', 'restart'] as const);
  const orderId = orderIdOf(c);
  const assignmentId = typeof b.assignment_id === 'string' && b.assignment_id ? b.assignment_id : undefined;
  let target = { order_item_id: '', unit_index: 0, part: 'device' };
  if (assignmentId) {
    const row = await c.env.DB.prepare(
      'SELECT order_item_id, unit_index, part FROM serial_assignments WHERE id = ? AND order_id = ? AND released_at IS NULL'
    )
      .bind(assignmentId, orderId)
      .first<{ order_item_id: string; unit_index: number; part: string }>()
      .catch(() => null);
    if (!row) throw refuse(404, 'SERIAL_ASSIGNMENT_NOT_FOUND');
    target = row;
  } else {
    target = {
      order_item_id: str(b.order_item_id, 'order_item_id', { min: 1, max: 80 }),
      unit_index: int(b.unit_index, 'unit_index', { min: 1, max: 500 }),
      part: b.part === undefined ? 'device' : str(b.part, 'part', { max: 10 }),
    };
  }
  const res = await linkSerial(c.env, actor, {
      orderId,
      orderItemId: target.order_item_id,
      unitIndex: target.unit_index,
      part: target.part,
      code: codeOf(b),
      ean: b.ean,
      boxSn: b.box_sn,
      source: 'manual',
      opId: opOf(b),
      replaceAssignmentId: assignmentId,
    override: { kind, reason, ...(mode ? { warrantyMode: mode } : {}) },
  });
  return c.json(res);
});
