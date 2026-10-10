import { serialAssignmentsInstalled } from '../lib/serialPolicy';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, notFound, str } from '../lib/http';
import { projectForAdmin, canWriteCost } from '../lib/adminScope';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { planAtomicAdjustment } from '../lib/inventoryAdjustment';
import { requireSelection, selectionStock } from '../lib/inventorySelection';
import { baghdadDay, fence, journalPlan, requireCapability, whole } from '../lib/operations';
import { changedExactlyOne, isLostRace } from '../lib/gifts/fence';
import { normalizeSerial } from '../lib/deviceOps';
import { counterTarget } from '../lib/inventoryReceiving';
import type { StockScope } from '../lib/inventory';
import { investorFinanceInstalled, planInvestorCapitalLoss, planInvestorSources, type InvestmentContract } from '../lib/investorFinance';
import { effectiveLotCostSql } from '../lib/inventoryLots';
import { SPLIT_CHILD_INSERT_SQL, batchSnapshotInstalled, preSnapshotLotSelect } from '../lib/batchSnapshot';

export const adminStockOperationsRoutes = new Hono<AppContext>();
adminStockOperationsRoutes.use('*', requireAdmin);
const text = (v: unknown, max = 200) => str(v, 'text', { max, required: false }) ?? '';
adminStockOperationsRoutes.get('/locations', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'transfer');
  const q = text(c.req.query('q'), 120),
    offset = whole(c.req.query('offset') ?? 0, 'offset', 0, 100000);
  const cost=await effectiveLotCostSql(c.env.DB,'l');
  const [locations, lots] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM stock_locations ORDER BY name').all(),
    c.env.DB.prepare(
      `SELECT l.id,l.product_id,l.scope,l.scope_id,l.qty_remaining,${cost} AS unit_cost_iqd,p.name_ar,p.name,loc.location_id,w.name AS location_name
    FROM inventory_lots l LEFT JOIN products p ON p.id=l.product_id LEFT JOIN inventory_lot_locations loc ON loc.lot_id=l.id LEFT JOIN stock_locations w ON w.id=loc.location_id
    WHERE l.qty_remaining>0 AND (?='' OR instr(lower(COALESCE(p.name,'')||' '||COALESCE(p.name_ar,'')||' '||COALESCE(p.sku,'')||' '||l.id),lower(?))>0) ORDER BY l.received_at,l.id LIMIT 200 OFFSET ?`,
    )
      .bind(q, q, offset)
      .all(),
  ]);
  return c.json(
    projectForAdmin(c.env, c.get('user'), {
      success: true,
      locations: locations.results ?? [],
      lots: lots.results ?? [],
    }),
  );
});
adminStockOperationsRoutes.post('/locations', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'transfer');
  const b = await c.req.json<Record<string, unknown>>();
  const kind = text(b.kind, 20) || 'warehouse';
  if (!['warehouse', 'shelf', 'quarantine'].includes(kind)) throw badRequest('Invalid location type');
  const id = newId('loc');
  await c.env.DB.prepare('INSERT INTO stock_locations(id,name,parent_id,kind) VALUES (?,?,?,?)')
    .bind(id, str(b.name, 'الاسم', { min: 1, max: 120 }), text(b.parent_id, 60) || null, kind)
    .run();
  await audit(c.env.DB, user.id, 'stock.location_created', id, {});
  return c.json({ success: true, id });
});
adminStockOperationsRoutes.post('/transfers', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'transfer');
  const b = await c.req.json<Record<string, unknown>>(),
    db = c.env.DB;
  const id = str(b.operation_id, 'operation_id', { min: 8, max: 40 }),
    lotId = text(b.lot_id, 60),
    location = text(b.location_id, 60),
    qty = whole(b.qty, 'الكمية', 1, 100000);
  const prior = await db
    .prepare('SELECT source_lot_id,to_location_id,qty FROM stock_transfers WHERE id=?')
    .bind(id)
    .first<{ source_lot_id: string; to_location_id: string; qty: number }>();
  if (prior) {
    if (prior.source_lot_id !== lotId || prior.to_location_id !== location || prior.qty !== qty)
      throw conflict('عملية النقل مستخدمة لمحتوى مختلف');
    return c.json({ success: true, already: true });
  }
  const l = await db
    .prepare(
      'SELECT l.*,loc.location_id FROM inventory_lots l LEFT JOIN inventory_lot_locations loc ON loc.lot_id=l.id WHERE l.id=?',
    )
    .bind(lotId)
    .first<{
      product_id: string;
      scope: StockScope;
      scope_id: string;
      qty_remaining: number;
      unit_cost_iqd: number | null;
      purchase_unit_iqd: number | null;
      received_at: string;
      cost_basis: string;
      location_id: string | null;
      incoming_id: string | null;
      supplier_id: string | null;
      purchase_date: string | null;
    }>();
  if (!l) throw notFound('Lot not found');
  if (qty > l.qty_remaining) throw badRequest('الكمية تتجاوز المتاح في الدفعة');
  if (location === l.location_id) throw badRequest('اختر موقعًا مختلفًا');
  const destination = await db
    .prepare('SELECT kind FROM stock_locations WHERE id=? AND active=1')
    .bind(location)
    .first<{ kind: string }>();
  if (!destination) throw badRequest('موقع غير فعال');
  if (destination.kind === 'quarantine')
    throw badRequest('موقع الحجر مخصص للمرتجعات غير المتاحة للبيع؛ لا تنقل إليه دفعات قابلة للبيع');
  const stock = await selectionStock(db, { product_id: l.product_id, scope: l.scope, scope_id: l.scope_id });
  if ((stock?.reserved ?? 0) > 0)
    throw conflict('للمنتج وحدات محجوزة؛ أتم تجهيزها قبل نقل الدفعات', 'RESERVED_STOCK');
  if (
    qty < l.qty_remaining &&
    (await db
      .prepare('SELECT serial_norm FROM stock_serial_links WHERE lot_id=? LIMIT 1')
      .bind(lotId)
      .first())
  )
    throw conflict('انقل الدفعة المسلسلة كاملة لتبقى أرقام الأجهزة مرتبطة بموقعها', 'SERIAL_TRANSFER');
  const target = qty === l.qty_remaining ? lotId : newId('ilot');
  const versioned=await investorFinanceInstalled(db);
  const costVersion=versioned?await db.prepare('SELECT * FROM inventory_lot_cost_versions WHERE lot_id=? ORDER BY version DESC LIMIT 1').bind(lotId).first<{version:number;unit_cost_iqd:number;adjustment_id:string}>():null;
  const counter = counterTarget(l.scope)!;
  // FX-6 (§17): a split's child is part of the same batch, so it copies the
  // parent's purchase-time snapshot in the same INSERT and names its parent.
  // Without 0182 the INSERT is the one before FX-6.
  const snapshots = target !== lotId && (await batchSnapshotInstalled(db));
  const statements = [
    ...fence(
      db,
      `EXISTS(SELECT 1 FROM inventory_lots WHERE id=? AND qty_remaining=?) AND (SELECT location_id FROM inventory_lot_locations WHERE lot_id=?) IS ? AND EXISTS(SELECT 1 FROM ${counter.table} WHERE id=? AND ${l.scope === 'base' ? 'stock_reserved' : 'reserved'}=0)`,
      [lotId, l.qty_remaining, lotId, l.location_id, l.scope === 'base' ? l.product_id : l.scope_id],
    ),
  ];
  if (target !== lotId)
    statements.push(
      db.prepare('UPDATE inventory_lots SET qty_remaining=qty_remaining-? WHERE id=?').bind(qty, lotId),
      db
        .prepare(
          snapshots
            ? SPLIT_CHILD_INSERT_SQL
            : 'INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at,created_by,incoming_id,supplier_id,purchase_date) VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?)',
        )
        .bind(
          target,
          l.product_id,
          l.scope,
          l.scope_id,
          qty,
          qty,
          l.unit_cost_iqd,
          l.purchase_unit_iqd,
          l.unit_cost_iqd === null ? null : qty * l.unit_cost_iqd,
          l.cost_basis,
          l.received_at,
          user.id,
          l.incoming_id,
          l.supplier_id,
          l.purchase_date,
          ...(snapshots ? [lotId, lotId] : []),
        ),
    );
  if(versioned){
    statements.push(...fence(db,'COALESCE((SELECT MAX(version) FROM inventory_lot_cost_versions WHERE lot_id=?),0)=?',[lotId,costVersion?.version??0]));
    if(target!==lotId&&costVersion)statements.push(db.prepare('INSERT INTO inventory_lot_cost_versions(lot_id,version,unit_cost_iqd,adjustment_id) VALUES (?,1,?,?)').bind(target,costVersion.unit_cost_iqd,costVersion.adjustment_id));
  }
  statements.push(
    db
      .prepare(
        'INSERT INTO inventory_lot_locations(lot_id,location_id) VALUES (?,?) ON CONFLICT(lot_id) DO UPDATE SET location_id=excluded.location_id',
      )
      .bind(target, location),
    db
      .prepare(
        'INSERT INTO stock_transfers(id,source_lot_id,target_lot_id,from_location_id,to_location_id,qty,note,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        lotId,
        target,
        l.location_id,
        location,
        qty,
        text(b.note, 500),
        user.id,
        new Date().toISOString(),
      ),
  );
  await db.batch(statements);
  await audit(db, user.id, 'stock.transferred', id, { lot_id: lotId, qty });
  return c.json({ success: true });
});
adminStockOperationsRoutes.get('/counts', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'count');
  const { results } = await c.env.DB.prepare(
    'SELECT c.*,COUNT(l.id) AS lines FROM stock_counts c LEFT JOIN stock_count_lines l ON l.count_id=c.id GROUP BY c.id ORDER BY c.created_at DESC LIMIT 50',
  ).all();
  return c.json({ success: true, counts: results ?? [] });
});
adminStockOperationsRoutes.get('/counts/:id', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'count');
  const [count, lines] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM stock_counts WHERE id=?').bind(c.req.param('id')).first(),
    c.env.DB.prepare(
      'SELECT l.*,p.name,p.name_ar FROM stock_count_lines l LEFT JOIN products p ON p.id=l.product_id WHERE count_id=?',
    )
      .bind(c.req.param('id'))
      .all(),
  ]);
  if (!count) throw notFound('Count not found');
  return c.json(projectForAdmin(c.env, c.get('user'), { success: true, count, lines: lines.results ?? [] }));
});
adminStockOperationsRoutes.post('/counts', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'count');
  const b = await c.req.json<Record<string, unknown>>(),
    db = c.env.DB,
    id = str(b.operation_id, 'operation_id', { min: 8, max: 40 });
  if (await db.prepare('SELECT id FROM stock_counts WHERE id=?').bind(id).first())
    return c.json({ success: true, id, already: true });
  const raw = Array.isArray(b.lines) ? b.lines : [];
  if (!raw.length || raw.length > 50) throw badRequest('أضف من 1 إلى 50 بندًا للجرد');
  const statements = [
    db
      .prepare('INSERT INTO stock_counts(id,name,created_by,created_at) VALUES (?,?,?,?)')
      .bind(id, str(b.name, 'اسم الجرد', { min: 1, max: 120 }), user.id, new Date().toISOString()),
  ];
  for (const v of raw) {
    const r = v as Record<string, unknown>,
      s = await requireSelection(db, text(r.product_id, 60), text(r.scope, 20), text(r.scope_id, 60));
    if (s.stock === null) throw badRequest('فعّل تتبع المخزون أولًا');
    statements.push(
      db
        .prepare(
          'INSERT INTO stock_count_lines(id,count_id,product_id,scope,scope_id,expected_qty,counted_qty,unit_cost_iqd,reason,note) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          newId('cntl'),
          id,
          s.product_id,
          s.scope,
          s.scope_id,
          s.stock,
          whole(r.counted_qty, 'الكمية الفعلية', 0, 100000),
          canWriteCost(c.env, user)
            ? r.unit_cost_iqd == null
              ? s.unit_cost_iqd
              : whole(r.unit_cost_iqd, 'التكلفة')
            : null,
          'count',
          text(r.note, 200),
        ),
    );
  }
  await db.batch(statements);
  return c.json({ success: true, id });
});
adminStockOperationsRoutes.post('/counts/:id/post', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'count');
  const db = c.env.DB,
    id = c.req.param('id');
  const session = await db
    .prepare('SELECT status FROM stock_counts WHERE id=?')
    .bind(id)
    .first<{ status: string }>();
  if (!session) throw notFound('Count not found');
  if (session.status === 'posted') return c.json({ success: true, already: true });
  if (session.status !== 'draft') throw conflict('الجرد مغلق');
  const lines =
    (
      await db.prepare('SELECT * FROM stock_count_lines WHERE count_id=?').bind(id).all<{
        id: string;
        product_id: string;
        scope: StockScope;
        scope_id: string;
        expected_qty: number;
        counted_qty: number;
        unit_cost_iqd: number | null;
        note: string;
      }>()
    ).results ?? [];
  const statements = [...fence(db, "EXISTS(SELECT 1 FROM stock_counts WHERE id=? AND status='draft')", [id])];
  let unknown = 0;
  for (const l of lines) {
    const delta = l.counted_qty - l.expected_qty;
    if (!delta) continue;
    const plan = await planAtomicAdjustment(db, {
      productId: l.product_id,
      scope: l.scope,
      scopeId: l.scope_id,
      delta,
      expectedStock: l.expected_qty,
      reason: 'count',
      note: l.note,
      operationId: l.id,
      actorUserId: user.id,
      unitCostIqd: l.unit_cost_iqd,
    });
    statements.push(...plan.statements);
    if (plan.valueIqd === null) unknown++;
    else if (plan.valueIqd > 0)
      statements.push(
        ...journalPlan(
          db,
          {
            key: `count:${l.id}`,
            day: baghdadDay(),
            title: 'فروقات جرد',
            source: 'count',
            sourceId: id,
            actor: user.id,
          },
          delta > 0
            ? [
                { account: '1200', debit: plan.valueIqd },
                { account: '5300', credit: plan.valueIqd },
              ]
            : [
                { account: '5300', debit: plan.valueIqd },
                { account: '1200', credit: plan.valueIqd },
              ],
        ).statements,
      );
  }
  statements.push(
    db
      .prepare("UPDATE stock_counts SET status='posted',posted_at=? WHERE id=?")
      .bind(new Date().toISOString(), id),
  );
  await db.batch(statements);
  await audit(db, user.id, 'stock.count_posted', id, { unknown_cost_lines: unknown });
  return c.json({ success: true, unknown_cost_lines: unknown });
});
adminStockOperationsRoutes.post('/counts/:id/cancel', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'count');
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(
    "UPDATE stock_counts SET status='cancelled' WHERE id=? AND status='draft'",
  )
    .bind(id)
    .run();
  if (result.meta.changes) await audit(c.env.DB, user.id, 'stock.count_cancelled', id, {});
  return c.json({ success: true });
});
adminStockOperationsRoutes.get('/health', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'count');
  const q = text(c.req.query('q'), 120),
    offset = whole(c.req.query('offset') ?? 0, 'offset', 0, 100000);
  const cost=await effectiveLotCostSql(c.env.DB,'inventory_lots');
  const { results } = await c.env.DB.prepare(
    `WITH counters AS (
    SELECT id AS product_id,'base' AS scope,'' AS scope_id,stock,stock_reserved AS reserved,low_stock_threshold FROM products WHERE inventory_mode='BASE' AND stock IS NOT NULL
    UNION ALL SELECT v.product_id,'option',v.id,v.stock,v.reserved,v.low_stock_threshold FROM product_option_values v JOIN products p ON p.id=v.product_id WHERE p.inventory_mode='OPTION' AND v.stock IS NOT NULL
    UNION ALL SELECT v.product_id,'color',v.id,v.stock,v.reserved,v.low_stock_threshold FROM product_colors v JOIN products p ON p.id=v.product_id WHERE p.inventory_mode='COLOR' AND v.stock IS NOT NULL
    UNION ALL SELECT v.product_id,'variant',v.id,v.stock,v.reserved,v.low_stock_threshold FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.inventory_mode='VARIANT_COMBINATION' AND v.stock IS NOT NULL
    ), layers AS (SELECT product_id,scope,scope_id,SUM(qty_remaining) AS units,SUM(qty_remaining*${cost}) AS inventory_value_iqd,MIN(CASE WHEN qty_remaining>0 THEN received_at END) AS oldest FROM inventory_lots GROUP BY product_id,scope,scope_id), velocity AS (
    SELECT product_id,scope,scope_id,SUM(qty) AS sold FROM inventory_ledger WHERE kind='deduct' AND created_at>=datetime('now','-30 days') GROUP BY product_id,scope,scope_id)
    SELECT c.*,p.name,p.name_ar,COALESCE(l.units,0) AS lot_units,c.stock-COALESCE(l.units,0) AS discrepancy,l.inventory_value_iqd,l.oldest,
      COALESCE(v.sold,0) AS sold_30d,COALESCE(r.lead_time_days,7) AS lead_time_days,COALESCE(r.reorder_point,c.low_stock_threshold,0) AS reorder_point,
      (SELECT COALESCE(SUM(i.qty_ordered-i.qty_received),0) FROM incoming_inventory i WHERE i.product_id=c.product_id AND i.scope=c.scope AND i.scope_id=c.scope_id AND i.status IN ('incoming','partial')) AS incoming
    FROM counters c JOIN products p ON p.id=c.product_id LEFT JOIN layers l ON l.product_id=c.product_id AND l.scope=c.scope AND l.scope_id=c.scope_id
    LEFT JOIN velocity v ON v.product_id=c.product_id AND v.scope=c.scope AND v.scope_id=c.scope_id LEFT JOIN inventory_reorder_settings r ON r.product_id=c.product_id AND r.scope=c.scope AND r.scope_id=c.scope_id
    WHERE (?='' OR instr(lower(COALESCE(p.name,'')||' '||COALESCE(p.name_ar,'')||' '||COALESCE(p.sku,'')||' '||c.scope_id),lower(?))>0)
    ORDER BY ABS(c.stock-COALESCE(l.units,0)) DESC,c.stock-c.reserved ASC,c.product_id,c.scope_id LIMIT 200 OFFSET ?`,
  )
    .bind(q, q, offset)
    .all<Record<string, unknown>>();
  const rows = (results ?? []).map((r) => ({
    ...r,
    available: Number(r.stock) - Number(r.reserved),
    recommended_purchase: Math.max(
      0,
      Math.ceil(
        (Number(r.sold_30d) / 30) * (Number(r.lead_time_days) + 7) +
          Number(r.reorder_point) -
          (Number(r.stock) - Number(r.reserved)) -
          Number(r.incoming),
      ),
    ),
    cover_days:
      Number(r.sold_30d) > 0
        ? Math.floor(((Number(r.stock) - Number(r.reserved)) * 30) / Number(r.sold_30d))
        : null,
  }));
  return c.json(projectForAdmin(c.env, c.get('user'), { success: true, rows, limit: 200 }));
});
adminStockOperationsRoutes.post('/reorder', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'count');
  const b = await c.req.json<Record<string, unknown>>(),
    s = await requireSelection(c.env.DB, text(b.product_id, 60), text(b.scope, 20), text(b.scope_id, 60));
  await c.env.DB.prepare(
    "INSERT INTO inventory_reorder_settings(id,product_id,scope,scope_id,reorder_point,lead_time_days,updated_by) VALUES (?,?,?,?,?,?,?) ON CONFLICT(product_id,scope,scope_id) DO UPDATE SET reorder_point=excluded.reorder_point,lead_time_days=excluded.lead_time_days,updated_by=excluded.updated_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  )
    .bind(
      newId('reorder'),
      s.product_id,
      s.scope,
      s.scope_id,
      whole(b.reorder_point, 'حد الطلب', 0, 100000),
      whole(b.lead_time_days, 'مهلة التوريد', 0, 365),
      user.id,
    )
    .run();
  return c.json({ success: true });
});
adminStockOperationsRoutes.get('/trace', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'receive');
  const serial = text(c.req.query('serial'), 160),
    q = text(c.req.query('q'), 120),
    offset = whole(c.req.query('offset') ?? 0, 'offset', 0, 100000),
    db = c.env.DB;
  const investmentReady=await investorFinanceInstalled(db);
  const [links, returns, lots,returnAllocations] = await Promise.all([
    db
      .prepare(
        `SELECT s.serial_norm,l.id AS lot_id,l.product_id,l.received_at,l.unit_cost_iqd,w.name AS location_name,pl.purchase_id,po.invoice_no,po.supplier_id,COALESCE(oi.order_id,u.order_id) AS order_id,
      u.id AS unit_id,u.warranty_end_at,u.delivered_at,si.model_name FROM stock_serial_links s JOIN inventory_lots l ON l.id=s.lot_id JOIN serial_inventory si ON si.serial_norm=s.serial_norm
      LEFT JOIN inventory_lot_locations il ON il.lot_id=l.id LEFT JOIN stock_locations w ON w.id=il.location_id
      LEFT JOIN purchase_lines pl ON pl.incoming_id=l.incoming_id LEFT JOIN purchase_orders po ON po.id=pl.purchase_id
      LEFT JOIN order_items oi ON oi.id=s.order_item_id LEFT JOIN device_serials ds ON ds.serial_norm=s.serial_norm LEFT JOIN order_item_units u ON u.id=ds.unit_id
      WHERE (?='' OR instr(s.serial_norm,?)>0) ORDER BY s.linked_at DESC LIMIT 200`,
      )
      .bind(serial, serial)
      .all(),
    db
      .prepare(
        `SELECT r.id,r.order_id,r.order_item_id,r.qty,r.state,i.name_snapshot FROM return_cases r JOIN order_items i ON i.id=r.order_item_id
      WHERE r.state NOT IN ('resolved','rejected') AND NOT EXISTS(SELECT 1 FROM stock_return_inspections x WHERE x.return_case_id=r.id) ORDER BY r.requested_at LIMIT 200`,
      )
      .all(),
    // Linking a delivered device needs its consumed purchase lot as well as
    // lots still on the shelf. Read access follows receiving, not transfers.
    db.prepare(
      `SELECT l.id,l.product_id,l.qty_remaining,p.name,p.name_ar,il.location_id,w.name AS location_name
      FROM inventory_lots l LEFT JOIN products p ON p.id=l.product_id
      LEFT JOIN inventory_lot_locations il ON il.lot_id=l.id LEFT JOIN stock_locations w ON w.id=il.location_id
      WHERE l.qty_received>0 AND (?='' OR instr(lower(COALESCE(p.name,'')||' '||COALESCE(p.name_ar,'')||' '||COALESCE(p.sku,'')||' '||l.id),lower(?))>0)
      ORDER BY l.received_at DESC,l.id LIMIT 200 OFFSET ?`,
    )
      .bind(q, q, offset)
      .all(),
    investmentReady?db.prepare(`SELECT a.id,a.order_item_id,a.lot_id,a.qty,i.name_snapshot||' · '||substr(a.lot_id,-12) AS label,
      (SELECT COALESCE(SUM(e.qty),0) FROM stock_return_lot_evidence e JOIN return_cases r ON r.id=e.return_case_id WHERE e.allocation_id=a.id AND r.state<>'rejected') AS claimed
      FROM order_item_inventory_allocations a JOIN order_items i ON i.id=a.order_item_id WHERE a.released_at IS NULL AND EXISTS(SELECT 1 FROM return_cases r WHERE r.order_item_id=a.order_item_id AND r.state NOT IN ('resolved','rejected'))`).all():Promise.resolve({results:[]}),
  ]);
  return c.json(
    projectForAdmin(c.env, c.get('user'), {
      success: true,
      links: links.results ?? [],
      returns: returns.results ?? [],
      lots: lots.results ?? [],
      return_allocations:returnAllocations.results??[],
      limit: 200,
      offset,
    }),
  );
});
/** Whether an order line still holds units of a lot: its allocations netted (release rows subtract). */
async function lineHoldsLot(db: D1Database, itemId: string, lotId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN released_at IS NULL THEN qty ELSE -qty END),0) AS net
         FROM order_item_inventory_allocations WHERE order_item_id=? AND lot_id=?`,
    )
    .bind(itemId, lotId)
    .first<{ net: number }>();
  return Number(row?.net ?? 0) > 0;
}

adminStockOperationsRoutes.post('/serial-link', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'receive');
  const b = await c.req.json<Record<string, unknown>>(),
    db = c.env.DB;
  const serial = normalizeSerial(text(b.serial_norm, 160)),
    lot = text(b.lot_id, 60),
    item = text(b.order_item_id, 60) || null;
  const prior = await db
    .prepare('SELECT lot_id,order_item_id FROM stock_serial_links WHERE serial_norm=?')
    .bind(serial)
    .first<{ lot_id: string; order_item_id: string | null }>();
  if (prior) {
    if (prior.lot_id === lot && prior.order_item_id === item) return c.json({ success: true, already: true });
    throw conflict('الرقم التسلسلي مرتبط بالفعل؛ راجع سجل الجهاز قبل تغييره');
  }
  // 0178 (critique M13): ONE serial→order-item link. A serial bound to an
  // order unit at preparation belongs to THAT line; this door may record its
  // lot, never point it at another line — and (integrity review #4) the lot it
  // records must be one THAT line was allocated, item or no item: otherwise
  // the device ships from a lot the accounting never took it from (§27).
  let bound: { id: string; order_item_id: string | null; lot_id: string | null; activated_at: string | null } | null = null;
  if (await serialAssignmentsInstalled(db)) {
    bound = await db
      .prepare('SELECT id, order_item_id, lot_id, activated_at FROM serial_assignments WHERE serial_norm=? AND released_at IS NULL')
      .bind(serial)
      .first<{ id: string; order_item_id: string | null; lot_id: string | null; activated_at: string | null }>();
    if (bound && item && bound.order_item_id !== item) throw conflict('الرقم التسلسلي مربوط بوحدة في طلب آخر؛ لا يُربط ببند مختلف', 'SERIAL_IN_USE');
    if (bound?.order_item_id && !(await lineHoldsLot(db, bound.order_item_id, lot)))
      throw badRequest('دفعة الرقم التسلسلي ليست ضمن الدفعات المصروفة لهذا الطلب', 'SERIAL_BATCH_MISMATCH');
  }
  const match = await db
    .prepare(
      'SELECT s.product_id,l.qty_received,l.product_id AS lot_product FROM serial_inventory s JOIN inventory_lots l ON l.id=? WHERE s.serial_norm=? AND s.voided_at IS NULL',
    )
    .bind(lot, serial)
    .first<{ product_id: string; lot_product: string; qty_received: number }>();
  if (!match || match.product_id !== match.lot_product)
    throw badRequest('الرقم التسلسلي والدفعة لا يتبعان المنتج نفسه');
  if (
    item &&
    !(await db
      .prepare('SELECT id FROM order_items WHERE id=? AND product_id=?')
      .bind(item, match.product_id)
      .first())
  )
    throw badRequest('المنتج لا يطابق بند الطلب');
  // The line's NET allocation on this lot (a release row subtracts — the same
  // netting as cogsByLine and the preparation scan's fence; serial-scan
  // critique-1 #7): a lot whose units all came back is not this line's any more.
  if (item && !(await lineHoldsLot(db, item, lot)))
    throw badRequest('دفعة الرقم التسلسلي ليست ضمن الدفعات المصروفة لهذا الطلب');
  // A serial bound at preparation and not delivered yet takes this verified
  // lot in the same batch (lot_source 'serial_link', the gate's evidence). If
  // the lot already holds as many of this line's serials as it was allocated,
  // one whose lot was only INFERRED from the allocation trades places with
  // it; a lot full of verified serials refuses.
  const line = bound?.order_item_id ?? null;
  const pending = bound && !bound.activated_at && line ? bound : null;
  const NET = (itemRef: string, lotRef: string) =>
    `(SELECT COALESCE(SUM(CASE WHEN released_at IS NULL THEN qty ELSE -qty END),0) FROM order_item_inventory_allocations WHERE order_item_id=${itemRef} AND lot_id=${lotRef})`;
  const bindingStatements: D1PreparedStatement[] = pending
    ? [
        db
          .prepare(
            `UPDATE serial_assignments SET lot_id=?1, lot_source='allocation',
                    allocation_id=(SELECT MIN(id) FROM order_item_inventory_allocations WHERE order_item_id=?2 AND lot_id=?1 AND released_at IS NULL)
              WHERE ?1 IS NOT NULL AND ?1<>?3
                AND id=(SELECT x.id FROM serial_assignments x
                         WHERE x.order_item_id=?2 AND x.lot_id=?3 AND x.lot_source='allocation' AND x.released_at IS NULL AND x.id<>?4 LIMIT 1)
                AND (SELECT COUNT(*) FROM serial_assignments y WHERE y.order_item_id=?2 AND y.lot_id=?3 AND y.released_at IS NULL AND y.id<>?4)
                    >= ${NET('?2', '?3')}`,
          )
          .bind(pending.lot_id, line, lot, pending.id),
        db
          .prepare(
            `UPDATE serial_assignments SET lot_id=?1, lot_source='serial_link',
                    allocation_id=(SELECT MIN(id) FROM order_item_inventory_allocations WHERE order_item_id=?2 AND lot_id=?1 AND released_at IS NULL)
              WHERE id=?3 AND released_at IS NULL AND activated_at IS NULL`,
          )
          .bind(lot, line, pending.id),
        ...changedExactlyOne(db),
        // `fence` binds its own id first: plain `?` placeholders only.
        ...fence(db, `(SELECT COUNT(*) FROM serial_assignments WHERE order_item_id=? AND lot_id=? AND released_at IS NULL) <= ${NET('?', '?')}`, [
          line,
          lot,
          line,
          lot,
        ]),
      ]
    : [];
  try {
    await db.batch([
      ...fence(
        db,
        '(SELECT COUNT(*) FROM stock_serial_links WHERE lot_id=?)<?-(SELECT COALESCE(SUM(qty),0) FROM stock_transfers WHERE source_lot_id=? AND target_lot_id<>source_lot_id)',
        [lot, match.qty_received, lot],
      ),
      db
        .prepare(
          'INSERT INTO stock_serial_links(serial_norm,lot_id,order_item_id,linked_by,linked_at) VALUES (?,?,?,?,?)',
        )
        .bind(serial, lot, item, user.id, new Date().toISOString()),
      ...bindingStatements,
    ]);
  } catch (e) {
    if (pending && isLostRace(e)) {
      // Which fence: the binding moved under us, or the lot is full of verified serials.
      const still = await db
        .prepare('SELECT 1 AS x FROM serial_assignments WHERE id=? AND released_at IS NULL AND activated_at IS NULL')
        .bind(pending.id)
        .first();
      if (!still) throw conflict('تغيّر ربط الرقم التسلسلي أثناء العملية — أعد المحاولة', 'SERIAL_RACE');
      throw badRequest('هذه الدفعة استوفت وحداتها لهذا البند بأرقام موثقة — خذ القطعة من دفعة أخرى مصروفة له', 'SERIAL_BATCH_MISMATCH');
    }
    throw e;
  }
  return c.json({ success: true });
});
adminStockOperationsRoutes.post('/return-inspections', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'receive');
  const b = await c.req.json<Record<string, unknown>>(),
    db = c.env.DB,
    id = str(b.operation_id, 'operation_id', { min: 8, max: 40 });
  const prior = await db
    .prepare('SELECT return_case_id,disposition FROM stock_return_inspections WHERE id=?')
    .bind(id)
    .first<{ return_case_id: string; disposition: string }>();
  if (prior) {
    if (prior.return_case_id !== b.return_case_id || prior.disposition !== b.disposition)
      throw conflict('عملية الفحص مستخدمة لحالة أو نتيجة مختلفة');
    if(Array.isArray(b.allocations)&&b.allocations.length&&await investorFinanceInstalled(db)){
      const stored=(await db.prepare('SELECT allocation_id,qty FROM stock_return_lot_evidence WHERE return_case_id=? ORDER BY allocation_id').bind(prior.return_case_id).all<{allocation_id:string;qty:number}>()).results??[];
      const requested=b.allocations.map(v=>{const r=v as Record<string,unknown>;return{allocation_id:text(r.allocation_id,120),qty:whole(r.qty,'الكمية',1,100000)};}).sort((a,b)=>a.allocation_id.localeCompare(b.allocation_id));
      if(JSON.stringify(stored)!==JSON.stringify(requested))throw conflict('معرف المعاينة مستخدم لدفعات مختلفة','IDEMPOTENCY_MISMATCH');
    }
    return c.json({ success: true, already: true });
  }
  const caseId = str(b.return_case_id, 'حالة المرتجع', { min: 1, max: 60 });
  const kase = await db
    .prepare('SELECT order_item_id,unit_id,qty,state FROM return_cases WHERE id=?')
    .bind(caseId)
    .first<{ order_item_id: string; unit_id:string|null;qty: number; state: string }>();
  if (!kase || ['resolved', 'rejected'].includes(kase.state)) throw badRequest('اختر حالة مرتجع مفتوحة');
  const item = kase.order_item_id,
    qty = kase.qty,
    disposition = text(b.disposition, 20);
  if (!['restock', 'quarantine', 'damage'].includes(disposition)) throw badRequest('حدد نتيجة فحص المرتجع');
  const orderItem = await db
    .prepare('SELECT qty FROM order_items WHERE id=?')
    .bind(item)
    .first<{ qty: number }>();
  if (!orderItem) throw notFound('Order line not found');
  const evidence:D1PreparedStatement[]=[];
  if(await investorFinanceInstalled(db)){
    let requested=Array.isArray(b.allocations)?b.allocations:[];
    if(!requested.length&&kase.unit_id&&qty===1){const linked=await db.prepare(`SELECT a.id FROM device_serials d JOIN stock_serial_links s ON s.serial_norm=d.serial_norm JOIN order_item_inventory_allocations a ON a.lot_id=s.lot_id WHERE d.unit_id=? AND a.order_item_id=? AND a.released_at IS NULL`).bind(kase.unit_id,item).first<{id:string}>()
      // 0178 §28: the lot the preparation scan verified, recorded on the unit at delivery.
      ??await db.prepare(`SELECT a.id FROM order_item_units u JOIN order_item_inventory_allocations a ON a.lot_id=u.inventory_lot_id WHERE u.id=? AND a.order_item_id=? AND a.released_at IS NULL`).bind(kase.unit_id,item).first<{id:string}>();if(linked)requested=[{allocation_id:linked.id,qty:1}];}
    const allocations=(await db.prepare(`SELECT a.id,a.lot_id,a.qty,EXISTS(SELECT 1 FROM investment_contracts c WHERE c.incoming_id=l.incoming_id AND c.state='active') AS funded,
      (SELECT COALESCE(SUM(e.qty),0) FROM stock_return_lot_evidence e JOIN return_cases r ON r.id=e.return_case_id WHERE e.allocation_id=a.id AND r.state<>'rejected') AS claimed
      FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id WHERE a.order_item_id=? AND a.released_at IS NULL`).bind(item).all<{id:string;lot_id:string;qty:number;funded:number;claimed:number}>()).results??[];
    const mixed=new Set(allocations.map(a=>a.lot_id)).size>1&&allocations.some(a=>a.funded);
    if(mixed&&!requested.length)throw badRequest('حدد دفعة القطع المرتجعة لتسوية المستثمر الصحيح','RETURN_LOT_REQUIRED');
    if(requested.length){
      const seen=new Set<string>();let sum=0;
      for(const v of requested){const r=v as Record<string,unknown>,aid=text(r.allocation_id,120),n=whole(r.qty,'الكمية',1,100000),a=allocations.find(a=>a.id===aid);
        if(!a||seen.has(aid)||n>a.qty-a.claimed)throw badRequest('أصل المرتجع أو كميته لا يطابق الدفعة المباعة','RETURN_LOT_MISMATCH');seen.add(aid);sum+=n;
        evidence.push(...fence(db,`(SELECT COALESCE(SUM(e.qty),0) FROM stock_return_lot_evidence e JOIN return_cases r ON r.id=e.return_case_id WHERE e.allocation_id=? AND r.state<>'rejected')+?<=?`,[aid,n,a.qty]),db.prepare('INSERT INTO stock_return_lot_evidence(return_case_id,allocation_id,qty) VALUES (?,?,?)').bind(caseId,aid,n));
      }
      if(sum!==qty)throw badRequest('مجموع الدفعات يجب أن يساوي كمية المرتجع','RETURN_LOT_MISMATCH');
    }
  }
  await db.batch([
    ...fence(db,"EXISTS(SELECT 1 FROM return_cases WHERE id=? AND state=?)",[caseId,kase.state]),
    ...evidence,
    ...fence(db, '(SELECT COALESCE(SUM(qty),0) FROM stock_return_inspections WHERE order_item_id=?)+?<=?', [
      item,
      qty,
      orderItem.qty,
    ]),
    db
      .prepare(
        'INSERT INTO stock_return_inspections(id,order_item_id,qty,disposition,note,actor_id,created_at,location_id,return_case_id) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        item,
        qty,
        disposition,
        text(b.note, 500),
        user.id,
        new Date().toISOString(),
        text(b.location_id, 60) || null,
        caseId,
      ),
  ]);
  return c.json({
    success: true,
    message: 'تم حفظ الفحص؛ استرجاع المال والكمية يتم من مسار المرتجعات المعتمد',
  });
});

adminStockOperationsRoutes.post('/scan',async c=>{
  const user=c.get('user')!;await requireCapability(c.env,user,'receive');const b=await c.req.json<Record<string,unknown>>(),db=c.env.DB;
  const code=text(b.code,160).trim(),serial=await db.prepare('SELECT * FROM stock_serial_links WHERE serial_norm=?').bind(normalizeSerial(code)).first<{lot_id:string;serial_norm:string;order_item_id:string|null}>();
  // The pre-0182 lot columns by name (FX plan §4.3, critique F14a): a scan is
  // open to every admin who receives, and a batch's purchase snapshot is the
  // owner's alone (GET /api/admin/pricing/batches).
  const lot=await db.prepare(`SELECT ${preSnapshotLotSelect('l')},p.name,p.name_ar FROM inventory_lots l LEFT JOIN products p ON p.id=l.product_id WHERE l.id=?`).bind(serial?.lot_id??code).first<Record<string,unknown>>();if(!lot)throw notFound('الرمز غير مرتبط بدفعة أو رقم جهاز موثق');
  if((b.product_id&&b.product_id!==lot.product_id)||(b.scope&&b.scope!==lot.scope)||(b.scope_id!==undefined&&b.scope_id!==lot.scope_id))throw badRequest('الرمز لا يطابق المنتج أو الخيار أو اللون المختار','SCAN_SELECTION_MISMATCH');
  if(b.order_item_id&&!await lineHoldsLot(db,text(b.order_item_id,60),String(lot.id)))throw badRequest('الدفعة ليست من أصل هذا الطلب','SCAN_ORDER_MISMATCH');
  return c.json(projectForAdmin(c.env,user,{success:true,lot,serial,match:true}));
});

adminStockOperationsRoutes.post('/lot-counts',async c=>{
  const user=c.get('user')!;await requireCapability(c.env,user,'count');const b=await c.req.json<Record<string,unknown>>(),db=c.env.DB;
  const id=str(b.operation_id,'operation_id',{min:8,max:60}),lotId=text(b.lot_id,60),counted=whole(b.counted_qty,'الكمية الفعلية',0,100000);
  const prior=await db.prepare('SELECT lot_id,counted_qty FROM lot_count_events WHERE id=?').bind(id).first<{lot_id:string;counted_qty:number}>();if(prior){if(prior.lot_id!==lotId||prior.counted_qty!==counted)throw conflict('المعرف مستخدم لجرد مختلف');return c.json({success:true,already:true});}
  const lot=await db.prepare(`SELECT l.*,COALESCE((SELECT v.unit_cost_iqd FROM inventory_lot_cost_versions v WHERE v.lot_id=l.id ORDER BY version DESC LIMIT 1),l.unit_cost_iqd) AS effective,
    COALESCE((SELECT MAX(version) FROM inventory_lot_cost_versions WHERE lot_id=l.id),0) AS cost_version,
    qty_received-(SELECT COALESCE(SUM(t.qty),0) FROM stock_transfers t WHERE t.source_lot_id=l.id AND t.target_lot_id<>t.source_lot_id)-(SELECT COALESCE(SUM(CASE WHEN a.released_at IS NULL THEN a.qty ELSE -a.qty END),0) FROM order_item_inventory_allocations a WHERE a.lot_id=l.id) AS max_remaining
    FROM inventory_lots l WHERE id=?`).bind(lotId).first<{product_id:string;scope:StockScope;scope_id:string;qty_remaining:number;incoming_id:string|null;effective:number|null;max_remaining:number;cost_version:number}>();if(!lot)throw notFound('Lot not found');
  if(counted>lot.max_remaining)throw badRequest('الكمية تتجاوز الوحدات المستلمة غير المباعة لهذه الدفعة؛ سجّل شراء أو أصل مستقل للوحدات الجديدة','LOT_COUNT_ORIGIN_LIMIT');
  const s=await requireSelection(db,lot.product_id,lot.scope,lot.scope_id);if(s.stock===null)throw badRequest('المخزون غير متتبع');if(s.reserved>0)throw conflict('أكمل تجهيز الوحدات المحجوزة قبل جرد الدفعة','RESERVED_STOCK');
  const delta=counted-lot.qty_remaining,target=counterTarget(lot.scope)!,rowId=lot.scope==='base'?lot.product_id:lot.scope_id;
  const statements=[...fence(db,`EXISTS(SELECT 1 FROM inventory_lots WHERE id=? AND qty_remaining=?) AND EXISTS(SELECT 1 FROM ${target.table} WHERE id=? AND stock=? AND ${lot.scope==='base'?'stock_reserved':'reserved'}=0) AND COALESCE((SELECT MAX(version) FROM inventory_lot_cost_versions WHERE lot_id=?),0)=?`,[lotId,lot.qty_remaining,rowId,s.stock,lotId,lot.cost_version]),db.prepare('INSERT INTO lot_count_events(id,lot_id,expected_qty,counted_qty,delta,actor_id,created_at) VALUES (?,?,?,?,?,?,?)').bind(id,lotId,lot.qty_remaining,counted,delta,user.id,new Date().toISOString())];
  const contracts=lot.incoming_id?(await db.prepare("SELECT * FROM investment_contracts WHERE incoming_id=? AND state='active'").bind(lot.incoming_id).all<InvestmentContract>()).results??[]:[];
  if(delta){
    statements.push(db.prepare('INSERT INTO inventory_ledger(id,product_id,scope,scope_id,kind,qty,idempotency_key,actor_user_id,reason) VALUES (?,?,?,?,?,?,?,?,?)').bind(newId('ilg'),lot.product_id,lot.scope,lot.scope_id,delta>0?'adjust_in':'adjust_out',Math.abs(delta),`lot-count:${id}`,user.id,'count'),db.prepare(`UPDATE ${target.table} SET stock=stock+? WHERE id=?`).bind(delta,rowId),db.prepare('UPDATE inventory_lots SET qty_remaining=? WHERE id=?').bind(counted,lotId));
    if(lot.effective!==null&&lot.effective>0){const value=Math.abs(delta)*lot.effective;
      statements.push(...journalPlan(db,{key:`lot-count:${id}`,day:baghdadDay(),title:'فرق جرد دفعة محددة',source:'lot-count',sourceId:id,actor:user.id},delta<0?[{account:'5300',debit:value},{account:'1200',credit:value}]:[{account:'1200',debit:value},{account:'5300',credit:value}]).statements);
      for(const contract of contracts){const amount=Math.trunc(-delta*lot.effective*contract.loss_share_bps/10000);if(!amount)continue;
        if(amount<0){const known=(await db.prepare("SELECT COALESCE(SUM(amount_iqd),0) AS n FROM investor_finance_events WHERE contract_id=? AND lot_id=? AND allocation_id IS NULL AND kind IN ('loss','loss_correction')").bind(contract.id,lotId).first<{n:number}>())?.n??0;if(-amount>known)throw badRequest('لا توجد خسارة موثقة تكفي لتصحيح رأس مال المستثمر');}
        statements.push(db.prepare('INSERT INTO investor_finance_events(id,event_key,contract_id,kind,amount_iqd,event_day,lot_id,actor_id,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(newId('ive'),`lot-count:${id}:${contract.id}`,contract.id,amount>0?'loss':'loss_correction',amount,baghdadDay(),lotId,user.id,JSON.stringify({expected:lot.qty_remaining,counted,unit_cost_iqd:lot.effective}),new Date().toISOString()));
        const loss=await planInvestorCapitalLoss(db,contract,amount,baghdadDay(),user.id);statements.unshift(...loss.guards);statements.push(...loss.post);
      }
    }
  }
  statements.push(...contracts.flatMap(c=>planInvestorSources(db,c,baghdadDay())));
  try{await db.batch(statements);}catch(e){if(/ops_guards|CHECK constraint|UNIQUE/i.test(String(e)))throw conflict('تغيرت الدفعة أثناء الجرد؛ حدّث الصفحة');throw e;}
  return c.json({success:true,delta,unknown_cost:lot.effective===null});
});
