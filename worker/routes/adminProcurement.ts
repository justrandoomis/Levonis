import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, notFound, str } from '../lib/http';
import { projectForAdmin } from '../lib/adminScope';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { requireSelection, productSelections, type Selection } from '../lib/inventorySelection';
import { planReceive, type IncomingRow } from '../lib/inventoryReceiving';
import {
  allocateExact,
  baghdadDay,
  dateValue,
  decimal,
  fence,
  journalPlan,
  periodOpen,
  requireCapability,
  whole,
} from '../lib/operations';
import { parsePurchaseCsv } from '../lib/purchaseCsv';

export const adminProcurementRoutes = new Hono<AppContext>();
adminProcurementRoutes.use('*', requireAdmin);
type Purchase = {
  id: string;
  supplier_id: string | null;
  currency: string;
  warehouse_id: string | null;
  status: string;
  version: number;
  cost_state: string;
  invoice_total_iqd: number | null;
  request_json: string;
};
type Line = IncomingRow & {
  line_id: string;
  label: string;
  charges_iqd: number;
  invoiced_qty: number;
  rejected_qty: number;
  source_unit_amount: number;
  weight_g: number;
  volume_mm3: number;
  selling_price_iqd: number | null;
};
async function commitPurchase(
  db: D1Database,
  purchase: Purchase,
  statements: D1PreparedStatement[],
) {
  try {
    await db.batch(statements);
  } catch (error) {
    const current = await db
      .prepare('SELECT version FROM purchase_orders WHERE id=?')
      .bind(purchase.id)
      .first<{ version: number }>();
    if (!current || current.version !== purchase.version)
      throw conflict('تغير أمر الشراء أو رصيد المورد؛ حدّث الشحنة وأعد المحاولة', 'VERSION_CHANGED');
    throw error;
  }
}
const bodyOf = async (c: Context<AppContext>) => await c.req.json<Record<string, unknown>>();
const text = (v: unknown, max = 200) => str(v, 'text', { max, required: false }) ?? '';
async function document(db: D1Database, id: string) {
  const p = await db
    .prepare(
      'SELECT p.*,s.name AS supplier_name,w.name AS warehouse_name FROM purchase_orders p LEFT JOIN inventory_suppliers s ON s.id=p.supplier_id LEFT JOIN stock_locations w ON w.id=p.warehouse_id WHERE p.id=?',
    )
    .bind(id)
    .first<Purchase>();
  if (!p) throw notFound('Purchase not found');
  const [lines, charges, payments] = await Promise.all([
    db
      .prepare(
        'SELECT i.*,l.id AS line_id,l.label,l.source_unit_amount,l.weight_g,l.volume_mm3,l.selling_price_iqd,l.charges_iqd,l.invoiced_qty,l.rejected_qty FROM purchase_lines l JOIN incoming_inventory i ON i.id=l.incoming_id WHERE l.purchase_id=? ORDER BY l.id',
      )
      .bind(id)
      .all<Line>(),
    db.prepare('SELECT * FROM purchase_charges WHERE purchase_id=? ORDER BY id').bind(id).all(),
    db
      .prepare('SELECT * FROM supplier_payments WHERE purchase_id=? ORDER BY payment_day,id')
      .bind(id)
      .all<{ amount_iqd: number }>(),
  ]);
  const items = lines.results ?? [];
  const ordered = items.reduce((s, l) => s + l.qty_ordered * l.purchase_unit_iqd + l.charges_iqd, 0);
  const paid = (payments.results ?? []).reduce((s, pay) => s + pay.amount_iqd, 0);
  return {
    purchase: p,
    lines: items,
    charges: charges.results ?? [],
    payments: payments.results ?? [],
    ordered_total_iqd: ordered,
    paid_iqd: paid,
    balance_iqd: ordered - paid,
    matching: {
      ordered_qty: items.reduce((s, l) => s + l.qty_ordered, 0),
      received_qty: items.reduce((s, l) => s + l.qty_received, 0),
      invoiced_qty: items.reduce((s, l) => s + l.invoiced_qty, 0),
      rejected_qty: items.reduce((s, l) => s + l.rejected_qty, 0),
      invoice_difference_iqd: p.invoice_total_iqd === null ? null : p.invoice_total_iqd - ordered,
    },
  };
}
adminProcurementRoutes.get('/selections/:id', async (c) =>
  c.json(
    projectForAdmin(c.env, c.get('user'), {
      success: true,
      selections: await productSelections(c.env.DB, text(c.req.param('id'), 60)),
    }),
  ),
);
adminProcurementRoutes.post('/import-preview', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'purchase');
  const b = await bodyOf(c),
    records = parsePurchaseCsv(String(b.csv ?? '')),
    lines = [];
  for (const r of records) {
    const products =
      (
        await c.env.DB.prepare(
          `SELECT id FROM products WHERE sku=? UNION SELECT product_id FROM product_variants WHERE sku=? UNION SELECT product_id FROM product_option_values WHERE sku_part=? UNION SELECT product_id FROM product_colors WHERE sku_part=?`,
        )
          .bind(r.sku, r.sku, r.sku, r.sku)
          .all<{ id: string }>()
      ).results ?? [];
    const matches = [];
    for (const p of products) {
      for (const s of await productSelections(c.env.DB, p.id)) {
        if (s.sku === r.sku) matches.push(s);
      }
    }
    if (matches.length !== 1)
      throw badRequest(`SKU ${r.sku}: اختر نسخة لها رمز فريد قبل الاستيراد`, 'CSV_SELECTION_AMBIGUOUS');
    lines.push({
      ...matches[0],
      qty_ordered: whole(r.qty, 'الكمية', 1, 100000),
      source_unit_amount: decimal(r.unit_amount, 'التكلفة'),
      weight_g: r.weight_g ? decimal(r.weight_g, 'الوزن') : matches[0].weight_g,
      volume_mm3: r.volume_mm3 ? decimal(r.volume_mm3, 'الحجم') : matches[0].volume_mm3,
    });
  }
  return c.json({ success: true, lines });
});
adminProcurementRoutes.get('/config', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'purchase');
  const [suppliers, locations] = await Promise.all([
    c.env.DB.prepare('SELECT id,name FROM inventory_suppliers WHERE active=1 ORDER BY name').all(),
    c.env.DB.prepare('SELECT * FROM stock_locations WHERE active=1 ORDER BY name').all(),
  ]);
  return c.json({ success: true, suppliers: suppliers.results ?? [], locations: locations.results ?? [] });
});
adminProcurementRoutes.get('/documents', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'purchase');
  const offset = whole(c.req.query('offset') ?? 0, 'offset', 0, 100000);
  const { results } = await c.env.DB.prepare(
    `SELECT p.*,s.name AS supplier_name,
    (SELECT COALESCE(SUM(i.qty_ordered*i.purchase_unit_iqd+l.charges_iqd),0) FROM purchase_lines l JOIN incoming_inventory i ON i.id=l.incoming_id WHERE l.purchase_id=p.id) AS total_cost_iqd,
    (SELECT COALESCE(SUM(amount_iqd),0) FROM supplier_payments WHERE purchase_id=p.id) AS paid_iqd
    FROM purchase_orders p LEFT JOIN inventory_suppliers s ON s.id=p.supplier_id ORDER BY p.created_at DESC LIMIT 50 OFFSET ?`,
  )
    .bind(offset)
    .all();
  return c.json({ success: true, purchases: results ?? [], offset });
});
adminProcurementRoutes.get('/documents/:id', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'purchase');
  return c.json({ success: true, ...(await document(c.env.DB, c.req.param('id'))) });
});

async function planDocument(
  db: D1Database,
  b: Record<string, unknown>,
  actor: string,
  id: string,
  previous?: Purchase,
) {
  const currency = text(b.currency, 8) || 'IQD';
  if (!['IQD', 'USD', 'CNY', 'EUR'].includes(currency)) throw badRequest('Unsupported currency');
  const rate = currency === 'IQD' ? 1 : decimal(b.exchange_rate, 'سعر الصرف', 0.000001);
  const day = dateValue(b.purchase_day, baghdadDay());
  const raw = Array.isArray(b.lines) ? b.lines : [];
  if (raw.length < 1 || raw.length > 30) throw badRequest('أضف بين منتج واحد و30 منتجًا في الشحنة');
  const now = new Date().toISOString();
  const lines: Array<{
    sel: Selection;
    qty: number;
    unit: number;
    source: number;
    weight: number;
    volume: number;
    invoiceQty: number;
    selling: number | null;
    charges: number;
  }> = [];
  for (const v of raw) {
    const r = v as Record<string, unknown>;
    const sel = await requireSelection(db, text(r.product_id, 60), text(r.scope, 20), text(r.scope_id, 60));
    const qty = whole(r.qty_ordered, 'الكمية', 1, 100000);
    const source = decimal(r.source_unit_amount ?? r.purchase_unit_iqd, 'تكلفة الشراء');
    const unit = whole(Math.round(source * rate), 'التكلفة');
    whole(unit * qty, 'مجموع تكلفة البند');
    lines.push({
      sel,
      qty,
      unit,
      source,
      weight: decimal(r.weight_g ?? sel.weight_g, 'الوزن'),
      volume: decimal(r.volume_mm3 ?? sel.volume_mm3, 'الحجم'),
      invoiceQty: whole(r.invoiced_qty ?? qty, 'كمية الفاتورة', 0, 100000),
      selling:
        r.selling_price_iqd === null
          ? null
          : whole(r.selling_price_iqd ?? sel.selling_price_iqd, 'سعر البيع'),
      charges: 0,
    });
  }
  const charges = (Array.isArray(b.charges) ? b.charges : []).map((v) => {
    const r = v as Record<string, unknown>,
      basis = text(r.basis, 20) || 'quantity';
    if (!['quantity', 'weight', 'volume', 'value'].includes(basis))
      throw badRequest('Invalid allocation method');
    const amount = whole(r.amount_iqd, 'تكلفة الشحنة');
    const shares = allocateExact(
      amount,
      lines.map((l) =>
        basis === 'weight'
          ? l.qty * l.weight
          : basis === 'volume'
            ? l.qty * l.volume
            : basis === 'value'
              ? l.qty * l.unit
              : l.qty,
      ),
    );
    lines.forEach((l, i) => (l.charges += shares[i]));
    return { title: str(r.title, 'عنوان التكلفة', { min: 1, max: 120 }), basis, amount };
  });
  if (charges.length > 15) throw badRequest('Too many charges');
  whole(
    lines.reduce((n, l) => n + l.unit * l.qty + l.charges, 0),
    'مجموع الشحنة',
  );
  const supplier = text(b.supplier_id, 60) || null,
    warehouse = text(b.warehouse_id, 60) || null;
  if (
    supplier &&
    !(await db.prepare('SELECT id FROM inventory_suppliers WHERE id=? AND active=1').bind(supplier).first())
  )
    throw badRequest('اختر موردًا فعالًا');
  if (
    warehouse &&
    !(await db
      .prepare("SELECT id FROM stock_locations WHERE id=? AND active=1 AND kind<>'quarantine'")
      .bind(warehouse)
      .first())
  )
    throw badRequest('اختر مستودعًا فعالًا');
  const attachment = text(b.attachment_url, 600);
  if (attachment && !/^https:\/\//.test(attachment)) throw badRequest('مرفق الفاتورة يجب أن يكون رابط HTTPS');
  const state = b.cost_state === 'final' ? 'final' : 'estimated';
  const status = b.status === 'ordered' ? 'ordered' : 'draft';
  const paid =
    (
      await db
        .prepare('SELECT COALESCE(SUM(amount_iqd),0) AS n FROM supplier_payments WHERE purchase_id=?')
        .bind(id)
        .first<{ n: number }>()
    )?.n ?? 0;
  if (
    previous &&
    paid > 0 &&
    (supplier !== previous.supplier_id || currency !== previous.currency || status === 'draft')
  )
    throw conflict('المورد والعملة وأصل الطلب مثبتة بالدفعة المقدمة');
  if (paid > lines.reduce((n, l) => n + l.qty * l.unit + l.charges, 0))
    throw conflict('المجموع الجديد أقل من دفعات المورد؛ سوّ الدفعة أولًا');
  const statements: D1PreparedStatement[] = [];
  if (previous) {
    statements.push(
      ...fence(
        db,
        `EXISTS(SELECT 1 FROM purchase_orders WHERE id=? AND version=? AND status IN ('draft','ordered')) AND NOT EXISTS(SELECT 1 FROM purchase_lines l JOIN incoming_inventory i ON i.id=l.incoming_id WHERE l.purchase_id=? AND i.qty_received>0) AND (SELECT COALESCE(SUM(amount_iqd),0) FROM supplier_payments WHERE purchase_id=?)=?`,
        [id, previous.version, id, id, paid],
      ),
    );
    const old =
      (
        await db
          .prepare('SELECT incoming_id FROM purchase_lines WHERE purchase_id=?')
          .bind(id)
          .all<{ incoming_id: string }>()
      ).results ?? [];
    statements.push(
      db.prepare('DELETE FROM purchase_charges WHERE purchase_id=?').bind(id),
      db.prepare('DELETE FROM purchase_lines WHERE purchase_id=?').bind(id),
    );
    for (const l of old)
      statements.push(db.prepare('DELETE FROM incoming_inventory WHERE id=?').bind(l.incoming_id));
  }
  const header = {
    supplier_id: supplier,
    invoice_no: text(b.invoice_no),
    currency,
    exchange_rate: rate,
    purchase_day: day,
    expected_day: b.expected_day ? dateValue(b.expected_day) : null,
    warehouse_id: warehouse,
    status,
    cost_state: state,
    tracking: text(b.tracking),
    note: text(b.note, 2000),
    attachment_url: attachment,
    invoice_total_iqd:
      b.invoice_total_iqd == null || b.invoice_total_iqd === ''
        ? null
        : whole(b.invoice_total_iqd, 'مجموع الفاتورة'),
    version: (previous?.version ?? 0) + 1,
    request_json: JSON.stringify(b),
    updated_at: now,
  };
  if (previous) {
    const keys = Object.keys(header);
    statements.push(
      db
        .prepare(`UPDATE purchase_orders SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`)
        .bind(...Object.values(header), id),
    );
  } else {
    const row = { id, ...header, created_by: actor, created_at: now },
      keys = Object.keys(row);
    statements.push(
      db
        .prepare(`INSERT INTO purchase_orders(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .bind(...Object.values(row)),
    );
  }
  for (const l of lines) {
    const incoming = newId('inc'),
      line = newId('pol');
    statements.push(
      db
        .prepare(
          `INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,source_currency,source_unit_amount,exchange_rate_used,supplier_id,supplier_ref,purchase_date,expected_at,tracking,notes,status,created_by) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          incoming,
          l.sel.product_id,
          l.sel.scope,
          l.sel.scope_id,
          l.qty,
          l.unit,
          l.charges,
          currency,
          l.source,
          rate,
          supplier,
          text(b.invoice_no),
          day,
          b.expected_day ? dateValue(b.expected_day) : null,
          text(b.tracking),
          text(b.note, 2000),
          status === 'draft' ? 'draft' : 'incoming',
          actor,
        ),
    );
    statements.push(
      db
        .prepare(
          'INSERT INTO purchase_lines(id,purchase_id,incoming_id,label,source_unit_amount,weight_g,volume_mm3,selling_price_iqd,charges_iqd,invoiced_qty) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          line,
          id,
          incoming,
          l.sel.label,
          l.source,
          l.weight,
          l.volume,
          l.selling,
          l.charges,
          l.invoiceQty,
        ),
    );
  }
  for (const charge of charges)
    statements.push(
      db
        .prepare('INSERT INTO purchase_charges(id,purchase_id,title,amount_iqd,basis) VALUES (?,?,?,?,?)')
        .bind(newId('pch'), id, charge.title, charge.amount, charge.basis),
    );
  return statements;
}
adminProcurementRoutes.post('/documents', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'purchase');
  const b = await bodyOf(c),
    id = str(b.operation_id, 'operation_id', { min: 8, max: 40 });
  const existing = await c.env.DB.prepare('SELECT request_json FROM purchase_orders WHERE id=?')
    .bind(id)
    .first<{ request_json: string }>();
  if (existing) {
    if (existing.request_json !== JSON.stringify(b))
      throw conflict('رقم العملية مستخدم لمحتوى مختلف', 'IDEMPOTENCY_MISMATCH');
    return c.json({ success: true, id, already: true });
  }
  await c.env.DB.batch(await planDocument(c.env.DB, b, user.id, id));
  await audit(c.env.DB, user.id, 'purchase.created', id, {});
  return c.json({ success: true, id });
});
adminProcurementRoutes.put('/documents/:id', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'purchase');
  const b = await bodyOf(c),
    id = c.req.param('id'),
    d = await document(c.env.DB, id);
  if (d.purchase.version !== whole(b.version, 'version', 1))
    throw conflict('تغيرت الشحنة؛ افتح أحدث نسخة', 'VERSION_CHANGED');
  if (d.lines.some((l) => l.qty_received > 0) || !['draft', 'ordered'].includes(d.purchase.status))
    throw conflict('لا تعدّل التكلفة بعد الاستلام؛ استخدم شحنة جديدة', 'PURCHASE_FROZEN');
  await c.env.DB.batch(await planDocument(c.env.DB, b, user.id, id, d.purchase));
  await audit(c.env.DB, user.id, 'purchase.updated', id, {
    before: JSON.parse(d.purchase.request_json),
    after: b,
    version: d.purchase.version + 1,
  });
  return c.json({ success: true, id });
});
adminProcurementRoutes.post('/documents/:id/receive', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'receive');
  const b = await bodyOf(c),
    id = c.req.param('id'),
    eventId = str(b.operation_id, 'operation_id', { min: 8, max: 40 });
  const existing = await c.env.DB.prepare('SELECT request_json FROM purchase_receiving_events WHERE id=?')
    .bind(eventId)
    .first<{ request_json: string }>();
  if (existing) {
    if (existing.request_json !== JSON.stringify(b))
      throw conflict('تغير محتوى الاستلام', 'IDEMPOTENCY_MISMATCH');
    return c.json({ success: true, already: true });
  }
  const d = await document(c.env.DB, id);
  if (!['ordered', 'partial'].includes(d.purchase.status)) throw conflict('أكد أمر الشراء قبل الاستلام');
  if (d.purchase.cost_state !== 'final')
    throw badRequest('ثبت تكاليف الشحنة النهائية قبل الاستلام', 'FINAL_COST_REQUIRED');
  const day = dateValue(b.received_day, baghdadDay());
  await periodOpen(c.env.DB, day);
  const raw = Array.isArray(b.lines) ? b.lines : [];
  if (!raw.length || raw.length > 30) throw badRequest('اختر البنود المستلمة');
  const statements = [
    ...fence(c.env.DB, 'EXISTS(SELECT 1 FROM purchase_orders WHERE id=? AND version=?)', [
      id,
      d.purchase.version,
    ]),
    c.env.DB.prepare(
      'INSERT INTO purchase_receiving_events(id,purchase_id,request_json) VALUES (?,?,?)',
    ).bind(eventId, id, JSON.stringify(b)),
  ];
  let total = 0,
    seq = 0,
    changed = 0;
  const seen = new Set<string>();
  for (const rawLine of raw) {
    const r = rawLine as Record<string, unknown>,
      line = d.lines.find((l) => l.line_id === r.line_id);
    if (!line || seen.has(line.line_id)) throw badRequest('Invalid or duplicate purchase line');
    seen.add(line.line_id);
    const selected = await requireSelection(c.env.DB, line.product_id!, line.scope, line.scope_id);
    const qty = whole(r.qty, 'المستلم', 0, 100000),
      rejected = whole(r.rejected_qty ?? 0, 'المرفوض', 0, 100000);
    if (qty > 0 && selected.stock === null) throw badRequest('فعّل تتبع مخزون النسخة قبل الاستلام');
    if (qty === 0 && rejected === 0) continue;
    changed += qty + rejected;
    if (qty + line.qty_received > line.qty_ordered) throw badRequest('المستلم يتجاوز كمية الشراء');
    if (rejected + line.rejected_qty > line.qty_ordered - line.qty_received - qty)
      throw badRequest('الكمية المرفوضة أكبر من المتبقي');
    statements.push(
      ...fence(
        c.env.DB,
        "EXISTS(SELECT 1 FROM incoming_inventory WHERE id=? AND qty_received=? AND status<>'cancelled')",
        [line.id, line.qty_received],
      ),
    );
    // Split at the rounding boundary, so each FIFO lot has a real integer unit cost.
    const base = Math.floor(line.charges_iqd / line.qty_ordered),
      remainder = line.charges_iqd % line.qty_ordered;
    const high = Math.max(0, Math.min(qty, remainder - line.qty_received));
    let received = line.qty_received;
    for (const segment of [
      { qty: high, extra: 1 },
      { qty: qty - high, extra: 0 },
    ]) {
      if (!segment.qty) continue;
      const receipt = `${eventId}_${seq++}`,
        lot = newId('ilot');
      const row = { ...line, qty_received: received };
      const plan = planReceive(c.env.DB, {
        row,
        qty: segment.qty,
        receiptId: receipt,
        lotId: lot,
        actorUserId: user.id,
        receivedAt: `${day}T09:00:00.000Z`,
      });
      statements.push(...plan.statements);
      if (d.purchase.warehouse_id)
        statements.push(
          c.env.DB.prepare('INSERT INTO inventory_lot_locations(lot_id,location_id) VALUES (?,?)').bind(
            lot,
            d.purchase.warehouse_id,
          ),
        );
      statements.push(
        c.env.DB.prepare(
          'INSERT INTO purchase_receiving_notes(id,purchase_id,rejected_qty,note) VALUES (?,?,?,?)',
        ).bind(receipt, id, 0, text(r.note, 500)),
      );
      total += segment.qty * (line.purchase_unit_iqd + base + segment.extra);
      received += segment.qty;
    }
    if (rejected)
      statements.push(
        c.env.DB.prepare('UPDATE purchase_lines SET rejected_qty=rejected_qty+? WHERE id=?').bind(
          rejected,
          line.line_id,
        ),
      );
  }
  if (!changed) throw badRequest('أدخل كمية مستلمة أو مرفوضة');
  if (total > 0) {
    const prior =
      (
        await c.env.DB.prepare(
          "SELECT COALESCE(SUM(l.credit_iqd-l.debit_iqd),0) AS n FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.source_id=? AND e.state='posted' AND l.account_code='1300'",
        )
          .bind(id)
          .first<{ n: number }>()
      )?.n ?? 0;
    const prepaid = Math.min(total, Math.max(0, -prior));
    statements.push(
      ...journalPlan(
        c.env.DB,
        {
          key: `receive:${eventId}`,
          day,
          title: 'استلام شراء ومصاريفه',
          source: 'purchase',
          sourceId: id,
          actor: user.id,
        },
        [
          { account: '1200', debit: total },
          { account: '1300', credit: prepaid },
          { account: '2000', credit: total - prepaid },
        ],
      ).statements,
    );
  }
  statements.push(
    c.env.DB.prepare(
      `UPDATE purchase_orders SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM purchase_lines l JOIN incoming_inventory i ON i.id=l.incoming_id WHERE l.purchase_id=? AND i.qty_received<i.qty_ordered) THEN 'received' ELSE 'partial' END,version=version+1,updated_at=? WHERE id=?`,
    ).bind(id, new Date().toISOString(), id),
  );
  await commitPurchase(c.env.DB, d.purchase, statements);
  await audit(c.env.DB, user.id, 'purchase.received', id, { event_id: eventId });
  return c.json({ success: true });
});
adminProcurementRoutes.post('/documents/:id/payments', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'pay');
  const b = await bodyOf(c),
    id = c.req.param('id'),
    paymentId = str(b.operation_id, 'operation_id', { min: 8, max: 40 });
  const existing = await c.env.DB.prepare('SELECT purchase_id,amount_iqd FROM supplier_payments WHERE id=?')
    .bind(paymentId)
    .first<{ purchase_id: string; amount_iqd: number }>();
  const amount = whole(b.amount_iqd, 'الدفعة', 1),
    day = dateValue(b.payment_day, baghdadDay());
  if (existing) {
    if (existing.purchase_id !== id || existing.amount_iqd !== amount)
      throw conflict('عملية الدفع مستخدمة لمبلغ مختلف');
    return c.json({ success: true, already: true });
  }
  await periodOpen(c.env.DB, day);
  const d = await document(c.env.DB, id);
  if (d.purchase.status === 'cancelled' || d.purchase.status === 'draft')
    throw badRequest('أكد أمر الشراء قبل الدفع');
  if (amount > d.balance_iqd) throw badRequest('الدفعة تتجاوز الرصيد المتبقي');
  const payable =
    (
      await c.env.DB.prepare(
        "SELECT COALESCE(SUM(l.credit_iqd-l.debit_iqd),0) AS n FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.source_id=? AND e.state='posted' AND l.account_code='2000'",
      )
        .bind(id)
        .first<{ n: number }>()
    )?.n ?? 0;
  const settle = Math.min(amount, Math.max(0, payable));
  await commitPurchase(c.env.DB, d.purchase, [
    // Receipts and document edits change both the amount owed and the prepaid
    // split. Share their version fence, so a stale payment plan cannot commit
    // against a newer receipt, edit or cancellation.
    ...fence(
      c.env.DB,
      "EXISTS(SELECT 1 FROM purchase_orders WHERE id=? AND version=? AND status NOT IN ('draft','cancelled')) AND (SELECT COALESCE(SUM(amount_iqd),0) FROM supplier_payments WHERE purchase_id=?)=?",
      [id, d.purchase.version, id, d.paid_iqd],
    ),
    c.env.DB.prepare(
      'INSERT INTO supplier_payments(id,purchase_id,amount_iqd,payment_day,reference,actor_id,created_at) VALUES (?,?,?,?,?,?,?)',
    ).bind(paymentId, id, amount, day, text(b.reference), user.id, new Date().toISOString()),
    ...journalPlan(
      c.env.DB,
      {
        key: `supplier-payment:${paymentId}`,
        day,
        title: 'دفعة مورد',
        source: 'purchase',
        sourceId: id,
        actor: user.id,
      },
      [
        { account: '2000', debit: settle },
        { account: '1300', debit: amount - settle },
        { account: '1000', credit: amount },
      ],
    ).statements,
    // Advancing the version also invalidates receipts planned before this
    // payment, whose prepaid balance was read outside the transaction.
    c.env.DB.prepare('UPDATE purchase_orders SET version=version+1,updated_at=? WHERE id=?').bind(
      new Date().toISOString(),
      id,
    ),
  ]);
  return c.json({ success: true });
});
adminProcurementRoutes.post('/documents/:id/close', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'purchase');
  const b = await bodyOf(c),
    id = c.req.param('id'),
    d = await document(c.env.DB, id),
    reason = str(b.reason, 'سبب إغلاق المتبقي', { min: 3, max: 500 });
  if (['received', 'cancelled'].includes(d.purchase.status)) return c.json({ success: true, already: true });
  await c.env.DB.batch([
    ...fence(c.env.DB, 'EXISTS(SELECT 1 FROM purchase_orders WHERE id=? AND version=?)', [
      id,
      d.purchase.version,
    ]),
    c.env.DB.prepare(
      "UPDATE incoming_inventory SET status='cancelled' WHERE id IN (SELECT incoming_id FROM purchase_lines WHERE purchase_id=?) AND qty_received<qty_ordered",
    ).bind(id),
    c.env.DB.prepare(
      'UPDATE purchase_orders SET status=?,note=note||?,version=version+1,updated_at=? WHERE id=?',
    ).bind(
      d.matching.received_qty > 0 ? 'received' : 'cancelled',
      `\n${reason}`,
      new Date().toISOString(),
      id,
    ),
  ]);
  await audit(c.env.DB, user.id, 'purchase.remainder_closed', id, { reason });
  return c.json({ success: true });
});
