import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, str, int } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { projectForAdmin, canViewFinancials } from '../lib/adminScope';
import { isInventoryMode, STOCK_SCOPES, type StockScope } from '../lib/inventory';
import {
  ADJUST_REASONS,
  counterTarget,
  isAdjustReason,
  planAdjustmentLedger,
  planReceive,
  readyToReceive,
  type IncomingRow,
} from '../lib/inventoryReceiving';
import { lotCostBreakdown } from '../lib/inventoryLots';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';

/**
 * «إدارة المخزون» — THE OPERATIONAL LAYER, AS AN API.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * QUANTITIES ARE OPERATIONAL. COSTS ARE FINANCIAL. THE DIFFERENCE IS ENFORCED
 * HERE AND NOT IN THE BROWSER.
 *
 * §52: an assistant admin runs the warehouse — they need to see that twenty
 * units are on the shelf, four are reserved and ten are on their way. They may
 * not see what any of it cost. So every payload leaves through
 * `projectForAdmin`, which strips `FINANCIAL_FIELDS` recursively, and the cost
 * columns are named in that list (worker/lib/adminScope.ts) rather than
 * omitted by hand at each site — a hand-omitted field is one somebody adds
 * back without noticing.
 *
 * The UI hiding a number is not a permission. This is the permission.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SERVER RECOMPUTES EVERY TOTAL. §77.
 *
 * A browser may preview `quantity x unit cost` for the person typing; nothing
 * it sends is believed. `purchase_total` is not even a field — it is
 * `qty_ordered x purchase_unit_iqd` and a stored copy is a number that can
 * disagree with its own factors (§7). Shipping and delivery shares are derived
 * by `lotCostBreakdown` at the moment of receipt, from the totals on the
 * purchase record.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No customer-facing route. No endpoint that returns a cost without the gate.
 * No mixed-shipment allocation (§31): each purchase carries its own freight
 * totals and the owner decides outside this system what belongs to each.
 */
export const adminInventoryRoutes = new Hono<AppContext>();
adminInventoryRoutes.use('*', requireAdmin);

const isScope = (v: unknown): v is StockScope =>
  typeof v === 'string' && (STOCK_SCOPES as readonly string[]).includes(v);

/** A scope that has a shelf. Capacity is not stock (§65). */
const isShelfScope = (v: unknown): v is StockScope => isScope(v) && counterTarget(v) !== null;

/** `null` when the caller did not state the value at all; a number when they
 *  did, INCLUDING zero. The whole §13 distinction in one helper — `Number(x) ||
 *  null` would silently turn a stated 0 into "not entered". */
function statedInt(v: unknown, field: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw badRequest(`${field} must be a whole number of dinars, or left empty`, 'BAD_COST');
  }
  return n;
}

// ===========================================================================
//  1. OVERVIEW — §44
// ===========================================================================

/**
 * The dashboard numbers. Restrained on purpose: §44 asks for useful summaries
 * and then says not to build twenty KPI cards.
 *
 * INVENTORY VALUE IS SUM(remaining x lot cost) AND NOT stock x latest cost.
 * §45 calls that essential and it is: the second form reports a shop holding
 * ten units at 450,000 and ten at 560,000 as though all twenty cost 560,000 —
 * an inventory 1.1 million dinars richer than it is.
 */
adminInventoryRoutes.get('/overview', async (c) => {
  const db = c.env.DB;
  const [lots, incoming, aging] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS lots,
                COALESCE(SUM(qty_remaining), 0) AS units,
                COALESCE(SUM(CASE WHEN unit_cost_iqd IS NOT NULL THEN qty_remaining * unit_cost_iqd END), 0) AS value,
                COALESCE(SUM(CASE WHEN unit_cost_iqd IS NULL THEN qty_remaining END), 0) AS unpriced_units
           FROM inventory_lots WHERE qty_remaining > 0`
      )
      .first<{ lots: number; units: number; value: number; unpriced_units: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS purchases,
                COALESCE(SUM(qty_ordered - qty_received), 0) AS units,
                COALESCE(SUM((qty_ordered - qty_received) * purchase_unit_iqd), 0) AS value
           FROM incoming_inventory WHERE status IN ('draft','incoming','partial')`
      )
      .first<{ purchases: number; units: number; value: number }>(),
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN julianday('now') - julianday(received_at) <= 30 THEN qty_remaining ELSE 0 END) AS d0,
           SUM(CASE WHEN julianday('now') - julianday(received_at) > 30
                     AND julianday('now') - julianday(received_at) <= 90 THEN qty_remaining ELSE 0 END) AS d31,
           SUM(CASE WHEN julianday('now') - julianday(received_at) > 90
                     AND julianday('now') - julianday(received_at) <= 180 THEN qty_remaining ELSE 0 END) AS d91,
           SUM(CASE WHEN julianday('now') - julianday(received_at) > 180 THEN qty_remaining ELSE 0 END) AS d180
         FROM inventory_lots WHERE qty_remaining > 0`
      )
      .first<{ d0: number; d31: number; d91: number; d180: number }>(),
  ]);

  return c.json(
    projectForAdmin(c.env, c.get('user'), {
      success: true,
      on_hand_units: Number(lots?.units ?? 0),
      active_lots: Number(lots?.lots ?? 0),
      // Reported so the owner can see how much of the value figure is an
      // absence rather than a zero. §21: unknown stays unknown, and a summary
      // that hides how much it could not price is a summary that overstates
      // its own confidence.
      unpriced_units: Number(lots?.unpriced_units ?? 0),
      inventory_value_iqd: Number(lots?.value ?? 0),
      incoming_purchases: Number(incoming?.purchases ?? 0),
      incoming_units: Number(incoming?.units ?? 0),
      incoming_purchase_total_iqd: Number(incoming?.value ?? 0),
      aging_units: {
        d0_30: Number(aging?.d0 ?? 0),
        d31_90: Number(aging?.d31 ?? 0),
        d91_180: Number(aging?.d91 ?? 0),
        d180_plus: Number(aging?.d180 ?? 0),
      },
    })
  );
});

// ===========================================================================
//  2. CURRENT INVENTORY — §4
// ===========================================================================

/**
 * One row per stock identity that has lots or units, with its lot summary.
 *
 * PAGINATED AND FILTERED SERVER-SIDE (§62). The alternative — send every lot
 * and group in the browser — is the query that is fine on a demo and unusable
 * the first year the shop trades.
 */
adminInventoryRoutes.get('/lines', async (c) => {
  const limit = Math.min(100, Math.max(1, int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 })));
  const offset = Math.max(0, int(c.req.query('offset'), 'offset', { min: 0, max: 100000, def: 0 }));
  const q = (c.req.query('q') ?? '').trim().slice(0, 60);
  const productId = (c.req.query('product_id') ?? '').trim().slice(0, 60);

  const where: string[] = ['l.qty_remaining > 0'];
  const args: unknown[] = [];
  if (productId) {
    where.push('l.product_id = ?');
    args.push(productId);
  }
  // `likePattern`, never a hand-rolled `%${q}%`. D1 refuses a LIKE pattern over
  // 50 BYTES and Arabic costs two bytes a letter, so a search the owner types
  // in Arabic hits that ceiling at 24 characters. The helper trims on CODE
  // POINTS (never splitting a letter in half), escapes `%` and `_` so a search
  // for "50% off" is not a search for everything, and its clause carries the
  // matching `ESCAPE` — which is why the pattern and the clause come from the
  // same place rather than being written out here.
  const pattern = likePattern(q);
  if (pattern) {
    where.push(sqlLikeClause(['p.name', 'p.name_ar', 'p.sku']));
    args.push(pattern, pattern, pattern);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT l.product_id, l.scope, l.scope_id,
            p.name AS product_name, p.images AS product_images, p.sku AS product_sku,
            p.inventory_mode,
            COUNT(*) AS lot_count,
            SUM(l.qty_remaining) AS on_hand,
            MIN(l.received_at) AS oldest_received_at,
            SUM(CASE WHEN l.unit_cost_iqd IS NOT NULL THEN l.qty_remaining * l.unit_cost_iqd END) AS inventory_value_iqd,
            SUM(CASE WHEN l.unit_cost_iqd IS NULL THEN l.qty_remaining ELSE 0 END) AS unpriced_units
       FROM inventory_lots l
       LEFT JOIN products p ON p.id = l.product_id
      WHERE ${where.join(' AND ')}
      GROUP BY l.product_id, l.scope, l.scope_id
      ORDER BY on_hand DESC, l.product_id
      LIMIT ? OFFSET ?`
  )
    .bind(...args, limit, offset)
    .all<Record<string, unknown>>();

  const rows = results ?? [];

  // The FIFO head and tail per identity: «Next FIFO cost» and the newest layer,
  // which §50 says must be visible so a single misleading "Product Cost" cannot
  // hide cheaper stock the shop still holds.
  const heads = new Map<string, { oldest: number | null; newest: number | null }>();
  for (const r of rows) {
    const key = `${r.scope}:${r.scope_id}`;
    const pair = await c.env.DB.prepare(
      `SELECT
         (SELECT unit_cost_iqd FROM inventory_lots
           WHERE scope = ?1 AND scope_id = ?2 AND qty_remaining > 0
           ORDER BY received_at ASC, id ASC LIMIT 1) AS oldest,
         (SELECT unit_cost_iqd FROM inventory_lots
           WHERE scope = ?1 AND scope_id = ?2 AND qty_remaining > 0
           ORDER BY received_at DESC, id DESC LIMIT 1) AS newest`
    )
      .bind(r.scope, r.scope_id)
      .first<{ oldest: number | null; newest: number | null }>();
    heads.set(key, { oldest: pair?.oldest ?? null, newest: pair?.newest ?? null });
  }

  return c.json(
    projectForAdmin(c.env, c.get('user'), {
      success: true,
      lines: rows.map((r) => {
        const head = heads.get(`${r.scope}:${r.scope_id}`);
        return {
          product_id: r.product_id,
          product_name: r.product_name ?? null,
          product_sku: r.product_sku ?? null,
          product_image: firstImage(r.product_images),
          inventory_mode: r.inventory_mode ?? null,
          scope: r.scope,
          scope_id: r.scope_id,
          on_hand: Number(r.on_hand ?? 0),
          lot_count: Number(r.lot_count ?? 0),
          oldest_received_at: r.oldest_received_at ?? null,
          unpriced_units: Number(r.unpriced_units ?? 0),
          inventory_value_iqd: r.inventory_value_iqd === null ? null : Number(r.inventory_value_iqd),
          oldest_unit_cost_iqd: head?.oldest ?? null,
          newest_unit_cost_iqd: head?.newest ?? null,
        };
      }),
      limit,
      offset,
    })
  );
});

function firstImage(raw: unknown): string | null {
  try {
    const list = JSON.parse(String(raw ?? '[]')) as unknown;
    return Array.isArray(list) && typeof list[0] === 'string' ? list[0] : null;
  } catch {
    return null;
  }
}

// ===========================================================================
//  3. LOTS — §50
// ===========================================================================

adminInventoryRoutes.get('/lots', async (c) => {
  const scope = c.req.query('scope');
  const scopeId = c.req.query('scope_id') ?? '';
  const productId = (c.req.query('product_id') ?? '').trim();
  if (!productId && !isScope(scope)) throw badRequest('product_id or scope is required', 'MISSING_FILTER');

  const where = isScope(scope) ? 'l.scope = ? AND l.scope_id = ?' : 'l.product_id = ?';
  const args = isScope(scope) ? [scope, scopeId] : [productId];

  const { results } = await c.env.DB.prepare(
    `SELECT l.*, s.name AS supplier_name,
            (SELECT COALESCE(SUM(qty), 0) FROM order_item_inventory_allocations a
              WHERE a.lot_id = l.id AND a.released_at IS NULL) AS consumed
       FROM inventory_lots l
       LEFT JOIN inventory_suppliers s ON s.id = l.supplier_id
      WHERE ${where}
      ORDER BY l.received_at ASC, l.id ASC
      LIMIT 200`
  )
    .bind(...args)
    .all<Record<string, unknown>>();

  return c.json(projectForAdmin(c.env, c.get('user'), { success: true, lots: results ?? [] }));
});

// ===========================================================================
//  4. INCOMING — §5, §6, §58
// ===========================================================================

adminInventoryRoutes.get('/incoming', async (c) => {
  const status = c.req.query('status');
  const where = status && ['draft', 'incoming', 'partial', 'received', 'cancelled'].includes(status)
    ? 'i.status = ?'
    : "i.status <> 'cancelled'";
  const args = status && where.includes('?') ? [status] : [];

  const { results } = await c.env.DB.prepare(
    `SELECT i.*, p.name AS product_name, p.images AS product_images, s.name AS supplier_name
       FROM incoming_inventory i
       LEFT JOIN products p ON p.id = i.product_id
       LEFT JOIN inventory_suppliers s ON s.id = i.supplier_id
      WHERE ${where}
      ORDER BY CASE i.status WHEN 'partial' THEN 0 WHEN 'incoming' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
               COALESCE(i.expected_at, i.created_at)
      LIMIT 200`
  )
    .bind(...args)
    .all<Record<string, unknown>>();

  return c.json(
    projectForAdmin(c.env, c.get('user'), {
      success: true,
      incoming: (results ?? []).map((r) => ({
        ...r,
        product_image: firstImage(r.product_images),
        product_images: undefined,
        // DERIVED, NEVER STORED (§7). Two numbers that must agree are one
        // number and a copy of it.
        purchase_total_iqd: Number(r.qty_ordered) * Number(r.purchase_unit_iqd),
        qty_outstanding: Number(r.qty_ordered) - Number(r.qty_received),
      })),
    })
  );
});

adminInventoryRoutes.post('/incoming', async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const productId = str(body.product_id, 'product_id', { min: 1, max: 60 });
  const scope = body.scope;
  if (!isShelfScope(scope)) throw badRequest('scope must be base, option, color or variant', 'BAD_SCOPE');
  const scopeId = str(body.scope_id, 'scope_id', { max: 60, required: false }) ?? '';
  if (scope !== 'base' && !scopeId) throw badRequest('scope_id is required for this scope', 'MISSING_SCOPE_ID');

  const product = await c.env.DB.prepare('SELECT id, inventory_mode FROM products WHERE id = ?')
    .bind(productId)
    .first<{ id: string; inventory_mode: string }>();
  if (!product) throw notFound('Product not found');

  /**
   * THE PURCHASE MUST TARGET THE RUNG THE SHOP ACTUALLY SELLS FROM.
   *
   * `inventory_mode` names exactly one authoritative rung. Receiving ten units
   * into a colour on a product that sells by option would increment a counter
   * nothing reads: the units would be invisible to every customer and the lots
   * would claim stock that cannot be sold. Refused here, with the mode named,
   * rather than discovered weeks later as a discrepancy.
   */
  const mode = isInventoryMode(product.inventory_mode) ? product.inventory_mode : 'BASE';
  const expected: Record<string, StockScope> = {
    BASE: 'base',
    OPTION: 'option',
    COLOR: 'color',
    VARIANT_COMBINATION: 'variant',
  };
  if (expected[mode] !== scope) {
    throw badRequest(
      `هذا المنتج يعتمد مخزون ${mode} — اختر نفس المستوى / This product's stock lives at ${mode}, not ${scope}`,
      'SCOPE_NOT_AUTHORITATIVE'
    );
  }

  const qty = int(body.qty_ordered, 'qty_ordered', { min: 1, max: 1_000_000 });
  const unit = int(body.purchase_unit_iqd, 'purchase_unit_iqd', { min: 0, max: 10_000_000_000 });
  const id = newId('inc');

  await c.env.DB.prepare(
    `INSERT INTO incoming_inventory
       (id, product_id, scope, scope_id, qty_ordered, purchase_unit_iqd,
        shipping_total_iqd, internal_delivery_total_iqd,
        source_currency, source_unit_amount, exchange_rate_used,
        supplier_id, supplier_ref, purchase_date, expected_at, tracking, notes, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      id,
      productId,
      scope,
      scopeId,
      qty,
      unit,
      statedInt(body.shipping_total_iqd, 'shipping_total_iqd'),
      statedInt(body.internal_delivery_total_iqd, 'internal_delivery_total_iqd'),
      str(body.source_currency, 'source_currency', { max: 8, required: false }) || 'IQD',
      body.source_unit_amount === null || body.source_unit_amount === undefined || body.source_unit_amount === ''
        ? null
        : Number(body.source_unit_amount),
      body.exchange_rate_used === null || body.exchange_rate_used === undefined || body.exchange_rate_used === ''
        ? null
        : Number(body.exchange_rate_used),
      str(body.supplier_id, 'supplier_id', { max: 60, required: false }) || null,
      str(body.supplier_ref, 'supplier_ref', { max: 120, required: false }) ?? '',
      str(body.purchase_date, 'purchase_date', { max: 30, required: false }) || null,
      str(body.expected_at, 'expected_at', { max: 30, required: false }) || null,
      str(body.tracking, 'tracking', { max: 120, required: false }) ?? '',
      str(body.notes, 'notes', { max: 1000, required: false }) ?? '',
      body.status === 'incoming' ? 'incoming' : 'draft',
      user.id
    )
    .run();

  await audit(c.env.DB, user.id, 'inventory.incoming_created', id, { product_id: productId, scope, scope_id: scopeId, qty });
  return c.json({ success: true, id });
});

adminInventoryRoutes.patch('/incoming/:id', async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const row = await c.env.DB.prepare('SELECT * FROM incoming_inventory WHERE id = ?').bind(id).first<IncomingRow>();
  if (!row) throw notFound('Purchase not found');

  /**
   * ONCE UNITS HAVE BEEN RECEIVED, THE COSTS ARE FROZEN. §54.
   *
   * Changing shipping from 500,000 to 300,000 after a lot exists would restate
   * what that lot cost — and units from it may already have been sold, so it
   * would silently rewrite profit that has been reported. The quantity and the
   * money are locked together here: what stays editable is the paperwork
   * (supplier reference, tracking, notes, expected date), which changes nothing
   * anybody has been paid on.
   */
  const frozen = row.qty_received > 0;
  const sets: string[] = [];
  const args: unknown[] = [];
  const setIf = (key: string, value: unknown) => {
    sets.push(`${key} = ?`);
    args.push(value);
  };

  if (!frozen) {
    if ('qty_ordered' in body) setIf('qty_ordered', int(body.qty_ordered, 'qty_ordered', { min: 1, max: 1_000_000 }));
    if ('purchase_unit_iqd' in body) {
      setIf('purchase_unit_iqd', int(body.purchase_unit_iqd, 'purchase_unit_iqd', { min: 0, max: 10_000_000_000 }));
    }
  } else if ('qty_ordered' in body || 'purchase_unit_iqd' in body || 'shipping_total_iqd' in body || 'internal_delivery_total_iqd' in body) {
    throw badRequest(
      'تم استلام جزء من هذه الدفعة، فلا يمكن تعديل تكاليفها / Part of this purchase has been received; its costs are frozen',
      'COSTS_FROZEN'
    );
  }
  if (!frozen && 'shipping_total_iqd' in body) setIf('shipping_total_iqd', statedInt(body.shipping_total_iqd, 'shipping_total_iqd'));
  if (!frozen && 'internal_delivery_total_iqd' in body) {
    setIf('internal_delivery_total_iqd', statedInt(body.internal_delivery_total_iqd, 'internal_delivery_total_iqd'));
  }

  for (const [key, max] of [['supplier_ref', 120], ['tracking', 120], ['notes', 1000]] as const) {
    if (key in body) setIf(key, str(body[key], key, { max, required: false }) ?? '');
  }
  for (const key of ['purchase_date', 'expected_at'] as const) {
    if (key in body) setIf(key, str(body[key], key, { max: 30, required: false }) || null);
  }
  if ('supplier_id' in body) setIf('supplier_id', str(body.supplier_id, 'supplier_id', { max: 60, required: false }) || null);
  if ('status' in body && (body.status === 'incoming' || body.status === 'draft' || body.status === 'cancelled')) {
    if (body.status === 'cancelled' && row.qty_received > 0) {
      // §55: a purchase that has received stock keeps its history. Cancelling
      // it would orphan the lots it created from the reason they exist.
      throw badRequest('لا يمكن إلغاء دفعة تم استلام جزء منها / A partly received purchase cannot be cancelled', 'ALREADY_RECEIVED');
    }
    setIf('status', body.status);
  }

  if (sets.length === 0) return c.json({ success: true, changed: 0 });
  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  await c.env.DB.prepare(`UPDATE incoming_inventory SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...args, id)
    .run();
  await audit(c.env.DB, user.id, 'inventory.incoming_updated', id, { fields: sets.length - 1, frozen });
  return c.json({ success: true, changed: sets.length - 1 });
});

/** The confirmation sheet's figures, computed by the SERVER so the dialog and
 *  the commit cannot disagree (§59, §77). */
adminInventoryRoutes.get('/incoming/:id/receive-preview', async (c) => {
  const id = str(c.req.param('id'), 'id', { max: 60 });
  const row = await c.env.DB.prepare('SELECT * FROM incoming_inventory WHERE id = ?').bind(id).first<IncomingRow>();
  if (!row) throw notFound('Purchase not found');
  const qty = int(c.req.query('qty'), 'qty', { min: 1, max: 1_000_000, def: Math.max(1, row.qty_ordered - row.qty_received) });
  const check = readyToReceive(row, qty);
  return c.json(
    projectForAdmin(c.env, c.get('user'), {
      success: true,
      ok: check.ok,
      ...(check.ok
        ? { qty, remaining: check.remaining, cost: check.cost }
        : { code: check.code, message: check.message }),
    })
  );
});

/**
 * RECEIVE — the one operation a double tap could make expensive (§15-§17).
 *
 * `receipt_id` comes FROM THE CLIENT, one per press of the button. A
 * server-minted id would differ on every retry, which is exactly how a double
 * tap becomes two receipts; with the client's id, the second press carries the
 * same key, the UNIQUE index refuses it and the batch writes nothing.
 */
adminInventoryRoutes.post('/incoming/:id/receive', async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const receiptId = str(body.receipt_id, 'receipt_id', { min: 1, max: 60 });

  const row = await c.env.DB.prepare('SELECT * FROM incoming_inventory WHERE id = ?').bind(id).first<IncomingRow>();
  if (!row) throw notFound('Purchase not found');

  const already = await c.env.DB.prepare('SELECT id FROM incoming_inventory_receipts WHERE id = ?')
    .bind(receiptId)
    .first<{ id: string }>();
  if (already) {
    // Not an error: the first press worked. §17 asks for this sentence.
    return c.json({ success: true, already: true, message: 'تم استلام هذه الكمية بالفعل / Already received' });
  }

  const qty = int(body.qty, 'qty', { min: 1, max: 1_000_000, def: row.qty_ordered - row.qty_received });
  const check = readyToReceive(row, qty);
  if (!check.ok) {
    throw badRequest(check.message, check.code, 'missing' in check ? { missing: check.missing } : undefined);
  }

  const target = counterTarget(row.scope);
  if (!target) throw badRequest('This purchase targets a scope with no shelf', 'BAD_SCOPE');
  const rowId = row.scope === 'base' ? row.product_id : row.scope_id;
  const shelf = await c.env.DB.prepare(`SELECT "${target.column}" AS stock FROM "${target.table}" WHERE id = ?`)
    .bind(rowId)
    .first<{ stock: number | null }>();
  if (!shelf) throw notFound('The stock row this purchase targets no longer exists');
  if (shelf.stock === null) {
    // NULL means "this level does not track stock", and `NULL + 10` is NULL.
    // Receiving here would create a lot claiming units the counter never got.
    throw badRequest(
      'هذا المستوى لا يتتبع المخزون — فعّل التتبع قبل الاستلام / This level does not track stock; enable tracking before receiving',
      'STOCK_NOT_TRACKED'
    );
  }

  const plan = planReceive(c.env.DB, {
    row,
    qty,
    receiptId,
    lotId: newId('ilot'),
    actorUserId: user.id,
    receivedAt: new Date().toISOString(),
  });

  /**
   * ONE BATCH. D1 runs it as a single transaction, so the lot, the receipt, the
   * counter, the ledger row and the purchase's progress all commit or none do.
   *
   * THE READ ABOVE IS A COURTESY, NOT THE GUARD. Two presses that arrive close
   * enough together both read "no receipt yet" and both get here; the second
   * one's hard INSERT hits the UNIQUE key and D1 throws away its whole batch,
   * counter included. So the loser of that race is not an error to report — the
   * units ARE on the shelf, put there by the winner — and it is owed the same
   * sentence the early return gives.
   *
   * The receipt is re-read rather than the message parsed: a constraint name in
   * an error string is a different database's promise, and this one only has to
   * answer whether the receipt exists.
   */
  try {
    await c.env.DB.batch(plan.statements);
  } catch (err) {
    const landed = await c.env.DB.prepare('SELECT id FROM incoming_inventory_receipts WHERE id = ?')
      .bind(receiptId)
      .first<{ id: string }>();
    if (landed) {
      return c.json({ success: true, already: true, message: 'تم استلام هذه الكمية بالفعل / Already received' });
    }
    throw err;
  }

  await audit(c.env.DB, user.id, 'inventory.received', id, {
    receipt_id: receiptId,
    lot_id: plan.lotId,
    qty,
    unit_cost_iqd: plan.cost.unitCostIqd,
    total_cost_iqd: plan.cost.totalCostIqd,
    status: plan.status,
  });

  return c.json(
    projectForAdmin(c.env, c.get('user'), {
      success: true,
      lot_id: plan.lotId,
      qty,
      status: plan.status,
      cost: plan.cost,
    })
  );
});

// ===========================================================================
//  5. MOVEMENTS AND ADJUSTMENTS — §38, §39
// ===========================================================================

adminInventoryRoutes.get('/movements', async (c) => {
  const productId = (c.req.query('product_id') ?? '').trim();
  const limit = Math.min(200, Math.max(1, int(c.req.query('limit'), 'limit', { min: 1, max: 200, def: 60 })));
  const where = productId ? 'l.product_id = ?' : '1 = 1';
  const args = productId ? [productId] : [];
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.product_id, l.scope, l.scope_id, l.kind, l.qty, l.order_id, l.reason, l.created_at,
            u.name AS actor_name, p.name AS product_name
       FROM inventory_ledger l
       LEFT JOIN users u ON u.id = l.actor_user_id
       LEFT JOIN products p ON p.id = l.product_id
      WHERE ${where}
      ORDER BY l.created_at DESC
      LIMIT ?`
  )
    .bind(...args, limit)
    .all<Record<string, unknown>>();
  return c.json({ success: true, movements: results ?? [] });
});

adminInventoryRoutes.post('/adjustments', async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const productId = str(body.product_id, 'product_id', { min: 1, max: 60 });
  const scope = body.scope;
  if (!isShelfScope(scope)) throw badRequest('scope must be base, option, color or variant', 'BAD_SCOPE');
  const scopeId = str(body.scope_id, 'scope_id', { max: 60, required: false }) ?? '';
  const delta = int(body.delta, 'delta', { min: -1_000_000, max: 1_000_000 });
  if (delta === 0) throw badRequest('An adjustment of zero changes nothing', 'ZERO_DELTA');
  // §39 requires a reason. Not optional, and not free text alone: a list the
  // owner can count, plus a note for the detail.
  if (!isAdjustReason(body.reason)) {
    throw badRequest(`reason must be one of: ${ADJUST_REASONS.join(', ')}`, 'REASON_REQUIRED');
  }

  /**
   * THE TWO REFUSALS AN ADMIN IS OWED IN WORDS.
   *
   * Both are enforced by the database as well — an untracked rung writes no
   * ledger row, and a shelf driven below zero fails its CHECK and takes the
   * batch with it. But a CHECK violation reaches the admin as a 500, and
   * «تعذّر تنفيذ العملية» tells somebody counting boxes nothing. So the same
   * two conditions are read first and answered by name.
   */
  const target = counterTarget(scope);
  if (!target) throw badRequest('This scope has no shelf', 'BAD_SCOPE');
  const shelfId = scope === 'base' ? productId : scopeId;
  const shelf = await c.env.DB.prepare(`SELECT "${target.column}" AS stock FROM "${target.table}" WHERE id = ?`)
    .bind(shelfId)
    .first<{ stock: number | null }>();
  if (!shelf) throw notFound('The stock row this adjustment targets does not exist');
  if (shelf.stock === null) {
    throw badRequest(
      'هذا المستوى لا يتتبع المخزون — فعّل التتبع أولاً / This level does not track stock; enable tracking first',
      'STOCK_NOT_TRACKED'
    );
  }
  if (delta < 0 && shelf.stock + delta < 0) {
    // §40. Never negative, and never a silent partial write-off either.
    throw badRequest(
      `لا يمكن خصم ${Math.abs(delta)} من ${shelf.stock} وحدة / Cannot remove ${Math.abs(delta)} from a shelf of ${shelf.stock}`,
      'INSUFFICIENT_STOCK',
      { on_hand: shelf.stock }
    );
  }

  const statements = planAdjustmentLedger(c.env.DB, {
    productId,
    scope,
    scopeId,
    delta,
    reason: body.reason,
    note: str(body.note, 'note', { max: 200, required: false }) ?? '',
    operationId: newId('adj'),
    actorUserId: user.id,
  });
  await c.env.DB.batch(statements);

  /**
   * A NEGATIVE ADJUSTMENT MUST ALSO LEAVE THE LOTS, or the shelf and its cost
   * stop agreeing. The units written off were bought, and the oldest layer is
   * the one the next sale would have consumed — so the write-off eats the queue
   * in the same order a sale would.
   *
   * Done as a second batch rather than in the one above, and that is a real
   * (small) window: if it fails, the counter has moved and the lots have not.
   * The alternative was to plan the lot consumption from a read taken before
   * the counter moved, which would be a guess about a number that had just
   * changed. The window is reported by the invariant check on the overview
   * screen rather than hidden.
   */
  if (delta < 0) {
    const need = Math.abs(delta);
    const { results } = await c.env.DB.prepare(
      `SELECT id, qty_remaining FROM inventory_lots
        WHERE scope = ? AND scope_id = ? AND qty_remaining > 0
        ORDER BY received_at ASC, id ASC`
    )
      .bind(scope, scopeId)
      .all<{ id: string; qty_remaining: number }>();
    let left = need;
    const lotStatements: D1PreparedStatement[] = [];
    for (const lot of results ?? []) {
      if (left <= 0) break;
      const take = Math.min(lot.qty_remaining, left);
      left -= take;
      lotStatements.push(
        c.env.DB.prepare(
          `UPDATE inventory_lots SET qty_remaining = qty_remaining - ?1 WHERE id = ?2 AND qty_remaining >= ?1`
        ).bind(take, lot.id)
      );
    }
    if (lotStatements.length) await c.env.DB.batch(lotStatements);
  }

  await audit(c.env.DB, user.id, 'inventory.adjusted', productId, {
    scope,
    scope_id: scopeId,
    delta,
    reason: body.reason,
  });
  return c.json({ success: true });
});

// ===========================================================================
//  6. SUPPLIERS — §42
// ===========================================================================

adminInventoryRoutes.get('/suppliers', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, contact, notes, active FROM inventory_suppliers ORDER BY active DESC, name`
  ).all<Record<string, unknown>>();
  return c.json({ success: true, suppliers: results ?? [] });
});

adminInventoryRoutes.post('/suppliers', async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = newId('sup');
  await c.env.DB.prepare(
    `INSERT INTO inventory_suppliers (id, name, contact, notes, created_by) VALUES (?,?,?,?,?)`
  )
    .bind(
      id,
      str(body.name, 'name', { min: 1, max: 120 }),
      str(body.contact, 'contact', { max: 200, required: false }) ?? '',
      str(body.notes, 'notes', { max: 1000, required: false }) ?? '',
      user.id
    )
    .run();
  await audit(c.env.DB, user.id, 'inventory.supplier_created', id, {});
  return c.json({ success: true, id });
});

// ===========================================================================
//  7. PROFIT PREVIEW — §49
// ===========================================================================

/**
 * What a received lot would earn at today's selling price.
 *
 * FINANCIAL, SO IT IS GATED TWICE: the route refuses an assistant outright
 * rather than returning a stripped shell, because unlike an inventory line
 * there is nothing left of this payload once the money is removed. It is a
 * PREVIEW and it changes no price (§49).
 */
adminInventoryRoutes.get('/incoming/:id/profit-preview', async (c) => {
  if (!canViewFinancials(c.env, c.get('user'))) throw notFound('Not found');
  const id = str(c.req.param('id'), 'id', { max: 60 });
  const row = await c.env.DB.prepare(
    `SELECT i.*, p.price_iqd FROM incoming_inventory i LEFT JOIN products p ON p.id = i.product_id WHERE i.id = ?`
  )
    .bind(id)
    .first<IncomingRow & { price_iqd: number | null }>();
  if (!row) throw notFound('Purchase not found');

  const cost = lotCostBreakdown({
    purchaseUnitIqd: row.purchase_unit_iqd,
    shippingTotalIqd: row.shipping_total_iqd,
    internalDeliveryTotalIqd: row.internal_delivery_total_iqd,
    qtyOrdered: row.qty_ordered,
    qtyThisReceipt: row.qty_ordered,
    alreadyReceived: 0,
  });
  if (!cost.complete || row.price_iqd === null) {
    return c.json({ success: true, ready: false, cost });
  }
  const unitProfit = row.price_iqd - cost.unitCostIqd!;
  return c.json({
    success: true,
    ready: true,
    cost,
    selling_price_iqd: row.price_iqd,
    gross_profit_iqd: unitProfit,
    // A margin is a share of the PRICE, the same reading the rest of the
    // platform uses — never profit over cost, which would read 19% as 24%.
    margin_percent: row.price_iqd > 0 ? Math.round((unitProfit / row.price_iqd) * 1000) / 10 : 0,
    total_gross_profit_iqd: unitProfit * row.qty_ordered,
  });
});
