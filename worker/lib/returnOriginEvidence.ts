import { badRequest, conflict } from './http';
import { fence } from './operations';
import { resolveReturnedOriginIds } from './inventoryUnitOrigins';

export interface ReturnUnitOrigin {
  origin_id: string | null;
  allocation_id: string;
  order_item_id: string;
  unit_index: number;
  unit_id: string | null;
  lot_id: string;
  purchase_name: string;
  purchase_id: string;
  supplier_order_no: string;
  tracking_no: string;
  serial_norm: string | null;
  claimed: number;
}

async function installed(db: D1Database) {
  return !!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stock_return_unit_evidence'").first();
}

/** Called only from the admin receiving route; never add this DTO to customer returns. */
export async function listReturnUnitOrigins(db: D1Database): Promise<ReturnUnitOrigin[]> {
  if (!await installed(db)) return [];
  return (await db.prepare(`SELECT a.origin_id,a.allocation_id,a.order_item_id,a.unit_index,u.id AS unit_id,a.lot_id,
    a.purchase_name,a.purchase_id,a.supplier_order_no,a.tracking_no,COALESCE(a.verified_serial_norm,d.serial_norm) AS serial_norm,
    EXISTS(SELECT 1 FROM stock_return_unit_evidence e JOIN return_cases r ON r.id=e.return_case_id
      WHERE e.origin_id=a.origin_id AND e.allocation_id=a.allocation_id AND r.state<>'rejected') AS claimed
    FROM order_item_inventory_unit_assignments a
    LEFT JOIN order_item_units u ON u.order_item_id=a.order_item_id AND u.unit_index=a.unit_index
    LEFT JOIN device_serials d ON d.unit_id=u.id
    WHERE a.released_at IS NULL AND EXISTS(SELECT 1 FROM return_cases r
      WHERE r.order_item_id=a.order_item_id AND r.state NOT IN ('resolved','rejected')
      AND NOT EXISTS(SELECT 1 FROM stock_return_inspections x WHERE x.return_case_id=r.id))
    UNION ALL
    SELECT NULL,a.id,u.order_item_id,u.unit_index,u.id,u.inventory_lot_id,'','','','',d.serial_norm,
      EXISTS(SELECT 1 FROM stock_return_order_unit_evidence e JOIN return_cases r ON r.id=e.return_case_id
        WHERE e.unit_id=u.id AND r.state<>'rejected')
    FROM order_item_units u JOIN order_item_inventory_allocations a ON a.order_item_id=u.order_item_id
      AND a.lot_id=u.inventory_lot_id AND a.released_at IS NULL
    LEFT JOIN device_serials d ON d.unit_id=u.id
    WHERE u.warranty_closed_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM order_item_inventory_unit_assignments a2 WHERE a2.order_item_id=u.order_item_id AND a2.unit_index=u.unit_index)
      AND EXISTS(SELECT 1 FROM return_cases r WHERE r.order_item_id=u.order_item_id AND r.state NOT IN ('resolved','rejected')
        AND NOT EXISTS(SELECT 1 FROM stock_return_inspections x WHERE x.return_case_id=r.id))
    ORDER BY 3,4`).all<ReturnUnitOrigin>()).results ?? [];
}

function originIds(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string' || !id || id.length > 120) || new Set(raw).size !== raw.length)
    throw badRequest('اختر أرقام القطع المرتجعة دون تكرار', 'UNIT_ORIGINS_RETURN_MISMATCH');
  return raw as string[];
}

export async function assertReturnUnitEvidenceReplay(db: D1Database, caseId: string, raw: unknown, rawUnitIds?: unknown) {
  const requested = originIds(raw);
  const units = originIds(rawUnitIds);
  if (requested === undefined && units === undefined) return;
  if (!await installed(db)) {
    if (requested?.length || units?.length) throw conflict('تحديث تتبع القطع لم يطبق بعد', 'UNIT_ORIGINS_NOT_INSTALLED');
    return;
  }
  const stored = (await db.prepare('SELECT origin_id FROM stock_return_unit_evidence WHERE return_case_id=? ORDER BY origin_id')
    .bind(caseId).all<{ origin_id: string }>()).results ?? [];
  if (requested !== undefined && JSON.stringify(stored.map(r => r.origin_id)) !== JSON.stringify([...requested].sort()))
    throw conflict('معرف المعاينة مستخدم لقطع مختلفة', 'IDEMPOTENCY_MISMATCH');
  if (units !== undefined) {
    const storedUnits = (await db.prepare('SELECT unit_id FROM stock_return_order_unit_evidence WHERE return_case_id=? ORDER BY unit_id')
      .bind(caseId).all<{ unit_id: string }>()).results ?? [];
    if (JSON.stringify(storedUnits.map(r => r.unit_id)) !== JSON.stringify([...units].sort()))
      throw conflict('معرف المعاينة مستخدم لقطع مختلفة', 'IDEMPOTENCY_MISMATCH');
  }
}

/** Evidence is committed in the same batch as the inspection. Stock/money are untouched. */
export async function planReturnUnitEvidence(db: D1Database, input: {
  caseId: string; itemId: string; qty: number; caseUnitId?: string | null; originIds?: unknown; unitIds?: unknown;
}): Promise<{ statements: D1PreparedStatement[]; allocations?: Array<{ allocation_id: string; qty: number }> }> {
  let requested = originIds(input.originIds);
  let unitIds = originIds(input.unitIds);
  if (!await installed(db)) {
    if (requested?.length || unitIds?.length) throw conflict('تحديث تتبع القطع لم يطبق بعد', 'UNIT_ORIGINS_NOT_INSTALLED');
    return { statements: [] };
  }
  if (input.caseUnitId) {
    if (input.qty !== 1 || (unitIds && (unitIds.length !== 1 || unitIds[0] !== input.caseUnitId)))
      throw badRequest('القطعة ليست من أصل هذا المرتجع', 'UNIT_ORIGINS_RETURN_MISMATCH');
    unitIds ??= [input.caseUnitId];
  }
  const rows = (await db.prepare(`SELECT a.origin_id,a.allocation_id,a.unit_index,u.id AS unit_id
    FROM order_item_inventory_unit_assignments a
    JOIN order_item_inventory_allocations l ON l.id=a.allocation_id AND l.released_at IS NULL
    LEFT JOIN order_item_units u ON u.order_item_id=a.order_item_id AND u.unit_index=a.unit_index
    WHERE a.order_item_id=? AND a.released_at IS NULL`).bind(input.itemId)
    .all<{ origin_id: string; allocation_id: string; unit_index: number; unit_id: string | null }>()).results ?? [];
  // Historical inspections may resolve their lot through stock_serial_links in
  // the existing route. Requiring a newly populated unit field would break them.
  if (!rows.length && input.unitIds === undefined && input.originIds === undefined) return { statements: [] };
  // A case tied to an older untracked unit keeps its existing, proven lot path.
  const relevant = input.caseUnitId ? rows.filter(r => r.unit_id === input.caseUnitId) : rows;
  if (!relevant.length && !unitIds?.length) {
    if (requested?.length) throw badRequest('القطعة ليست من أصل هذا المرتجع', 'UNIT_ORIGINS_RETURN_MISMATCH');
    return { statements: [] };
  }
  if (!unitIds && (!requested || requested.length !== input.qty))
    throw badRequest('حدد كل قطعة مرتجعة برقمها الداخلي قبل حفظ الفحص', 'UNIT_ORIGIN_SELECTION_REQUIRED');
  const order = await db.prepare('SELECT order_id FROM order_items WHERE id=?').bind(input.itemId).first<{ order_id: string }>();
  if (!order) throw badRequest('بند الطلب غير موجود', 'UNIT_ORIGINS_RETURN_MISMATCH');
  const selection = await resolveReturnedOriginIds(db, { orderId: order.order_id, itemId: input.itemId, qty: input.qty, originIds: requested, unitIds });
  requested = selection?.originIds ?? requested ?? [];
  const selected = requested.map(id => relevant.find(r => r.origin_id === id));
  if (selected.some(r => !r)) throw badRequest('القطعة ليست من أصل هذا المرتجع', 'UNIT_ORIGINS_RETURN_MISMATCH');
  const json = JSON.stringify(requested);
  const claimed = await db.prepare(`SELECT 1 FROM stock_return_unit_evidence e JOIN return_cases r ON r.id=e.return_case_id
    JOIN order_item_inventory_unit_assignments a ON a.origin_id=e.origin_id AND a.allocation_id=e.allocation_id
    WHERE a.order_item_id=? AND a.released_at IS NULL AND e.origin_id IN (SELECT value FROM json_each(?)) AND r.state<>'rejected' LIMIT 1`)
    .bind(input.itemId, json).first();
  if (claimed) throw conflict('إحدى القطع محددة في مرتجع آخر؛ حدّث القائمة', 'UNIT_ORIGINS_ALREADY_CLAIMED');
  const counts = new Map<string, number>(Object.entries(selection?.allocationQty ?? {}));
  const unitStatements: D1PreparedStatement[] = [];
  if (unitIds?.length) {
    const unitJson = JSON.stringify(unitIds);
    const units = (await db.prepare(`SELECT u.id,u.inventory_lot_id,a.id AS allocation_id FROM order_item_units u
      LEFT JOIN order_item_inventory_allocations a ON a.order_item_id=u.order_item_id AND a.lot_id=u.inventory_lot_id AND a.released_at IS NULL
      WHERE u.order_item_id=? AND u.id IN (SELECT value FROM json_each(?)) AND u.warranty_closed_at IS NULL`)
      .bind(input.itemId, unitJson).all<{ id: string; inventory_lot_id: string | null; allocation_id: string | null }>()).results ?? [];
    if (units.length !== input.qty || new Set(unitIds).size !== input.qty)
      throw badRequest('القطع المختارة لا تطابق المرتجع', 'UNIT_ORIGINS_RETURN_MISMATCH');
    const evidence = units.map(u => ({ unit_id: u.id, allocation_id: rows.find(r => r.unit_id === u.id)?.allocation_id ?? u.allocation_id }));
    if (evidence.some(e => !e.allocation_id)) throw badRequest('دفعة القطعة غير موثقة', 'UNIT_ORIGINS_RETURN_MISMATCH');
    if (!selection) for (const e of evidence) counts.set(e.allocation_id!, (counts.get(e.allocation_id!) ?? 0) + 1);
    const unitClaim = await db.prepare(`SELECT 1 FROM stock_return_order_unit_evidence e JOIN return_cases r ON r.id=e.return_case_id
      WHERE e.unit_id IN (SELECT value FROM json_each(?)) AND r.state<>'rejected' LIMIT 1`).bind(unitJson).first();
    if (unitClaim) throw conflict('إحدى القطع محددة في مرتجع آخر؛ حدّث القائمة', 'UNIT_ORIGINS_ALREADY_CLAIMED');
    unitStatements.push(
      ...fence(db, `(SELECT COUNT(*) FROM order_item_units WHERE order_item_id=? AND id IN (SELECT value FROM json_each(?)) AND warranty_closed_at IS NULL)=?`, [input.itemId, unitJson, input.qty]),
      ...fence(db, `NOT EXISTS(SELECT 1 FROM stock_return_order_unit_evidence e JOIN return_cases r ON r.id=e.return_case_id
        WHERE e.unit_id IN (SELECT value FROM json_each(?)) AND r.state<>'rejected')`, [unitJson]),
      db.prepare(`INSERT INTO stock_return_order_unit_evidence(return_case_id,unit_id,allocation_id)
        SELECT ?1,json_extract(value,'$.unit_id'),json_extract(value,'$.allocation_id') FROM json_each(?2)`)
        .bind(input.caseId, JSON.stringify(evidence)),
    );
  }
  const allocations = [...counts].map(([allocation_id, qty]) => ({ allocation_id, qty }));
  return {
    allocations,
    statements: [
      ...fence(db, `EXISTS(SELECT 1 FROM return_cases WHERE id=? AND order_item_id=? AND qty=? AND state NOT IN ('resolved','rejected'))`,
        [input.caseId, input.itemId, input.qty]),
      ...fence(db, `(SELECT COUNT(*) FROM order_item_inventory_unit_assignments a
        JOIN order_item_inventory_allocations l ON l.id=a.allocation_id AND l.released_at IS NULL
        WHERE a.order_item_id=? AND a.released_at IS NULL AND a.origin_id IN (SELECT value FROM json_each(?)))=?`,
        [input.itemId, json, requested.length]),
      ...fence(db, `NOT EXISTS(SELECT 1 FROM stock_return_unit_evidence e JOIN return_cases r ON r.id=e.return_case_id
        JOIN order_item_inventory_unit_assignments a ON a.origin_id=e.origin_id AND a.allocation_id=e.allocation_id
        WHERE a.order_item_id=? AND a.released_at IS NULL AND e.origin_id IN (SELECT value FROM json_each(?)) AND r.state<>'rejected')`, [input.itemId, json]),
      db.prepare(`INSERT INTO stock_return_unit_evidence(return_case_id,origin_id,allocation_id)
        SELECT ?1,a.origin_id,a.allocation_id FROM order_item_inventory_unit_assignments a
        WHERE a.order_item_id=?2 AND a.released_at IS NULL AND a.origin_id IN (SELECT value FROM json_each(?3))`)
        .bind(input.caseId, input.itemId, json),
      ...unitStatements,
    ],
  };
}
