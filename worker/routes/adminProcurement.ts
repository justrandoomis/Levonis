import { Hono, type Context } from 'hono';
import { allocateProcurementCharges, exactProcurementUnitDefault, procurementSelectionKey } from '../../packages/contracts/src/procurementCost';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, forbidden, notFound, str } from '../lib/http';
import { isOwner, projectForAdmin } from '../lib/adminScope';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { requireSelection, productSelections, type Selection } from '../lib/inventorySelection';
import { planReceive, type IncomingRow } from '../lib/inventoryReceiving';
import {
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
import { planPurchaseFunding, purchaseFundingSummary, receivePurchaseFunding, type FundedPurchaseLine } from '../lib/purchaseFunding';
import { investorFinanceInstalled } from '../lib/investorFinance';
import { packedMeasure, procurementAmount, procurementProfiles, profileRates, purchaseChargeShares, purchaseCharges, type PurchaseCharge } from '../lib/procurementCosts';

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
  auto_shipping_iqd: number;
  invoiced_qty: number;
  rejected_qty: number;
  source_unit_amount: number;
  source_total_amount: number | null;
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
    if (!current || current.version !== purchase.version || /CHECK constraint/i.test(String(error)))
      throw conflict('تغير أمر الشراء أو رصيد المورد؛ حدّث الشحنة وأعد المحاولة', 'VERSION_CHANGED');
    throw error;
  }
}
const bodyOf = async (c: Context<AppContext>) => await c.req.json<Record<string, unknown>>();
type ChargeRow = { id: string; title: string; amount_iqd: number; basis: PurchaseCharge['basis']; scope: string | null; unit_amount_iqd: number | null; applies_to_json: string | null; allocation_json: string | null };
type ChargeShare = { line_id: string; amount_iqd: number };
const json = <T,>(value: string | null): T | null => {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
};
/** Each extra charge with the dinars it put on each line it covers. Documents
 * saved before shares were stored are recomputed with the same allocator, and
 * shown only when that reproduces every line's saved extras to the dinar. */
function chargeView(rows: ChargeRow[], items: Line[]) {
  const charges = rows.map((r) => ({
    id: r.id,
    title: r.title,
    amount_iqd: r.amount_iqd,
    basis: r.basis,
    scope: r.scope === 'unit' ? 'unit' as const : 'shipment' as const,
    unit_amount_iqd: r.unit_amount_iqd ?? null,
    applies_to: json<string[]>(r.applies_to_json),
    allocations: json<ChargeShare[]>(r.allocation_json),
  }));
  if (!charges.length || !items.length || charges.some((c) => c.allocations)) return charges;
  const lines = items.map((l) => ({ key: procurementSelectionKey({ product_id: l.product_id ?? '', scope: l.scope, scope_id: l.scope_id }), qty: l.qty_ordered, value: l.purchase_total_iqd ?? l.qty_ordered * l.purchase_unit_iqd, weight_g: l.weight_g, volume_mm3: l.volume_mm3 }));
  try {
    const shares = allocateProcurementCharges(charges, lines);
    if (items.every((l, i) => shares.reduce((n, row) => n + row[i], 0) === l.charges_iqd - (l.auto_shipping_iqd ?? 0)))
      return charges.map((c, j) => ({ ...c, allocations: items.flatMap((l, i) => !c.applies_to || c.applies_to.includes(lines[i].key) ? [{ line_id: l.line_id, amount_iqd: shares[j][i] }] : []) }));
  } catch { /* an unreadable historical basis keeps its shares unknown */ }
  return charges;
}
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
        'SELECT i.*,l.id AS line_id,l.label,l.source_unit_amount,l.source_total_amount,l.weight_g,l.volume_mm3,l.selling_price_iqd,l.charges_iqd,l.auto_shipping_iqd,l.invoiced_qty,l.rejected_qty,l.purchase_cost_mode FROM purchase_lines l JOIN incoming_inventory i ON i.id=l.incoming_id WHERE l.purchase_id=? ORDER BY l.id',
      )
      .bind(id)
      .all<Line>(),
    db.prepare('SELECT * FROM purchase_charges WHERE purchase_id=? ORDER BY COALESCE(position,2147483647),id').bind(id).all<ChargeRow>(),
    db
      .prepare('SELECT * FROM supplier_payments WHERE purchase_id=? ORDER BY payment_day,id')
      .bind(id)
      .all<{ amount_iqd: number }>(),
  ]);
  const items = lines.results ?? [];
  const ordered = items.reduce((s, l) => s + (l.purchase_total_iqd ?? l.qty_ordered * l.purchase_unit_iqd) + l.charges_iqd, 0);
  const paid = (payments.results ?? []).reduce((s, pay) => s + pay.amount_iqd, 0);
  return {
    purchase: p,
    funding: await purchaseFundingSummary(db,id),
    lines: items,
    charges: chargeView(charges.results ?? [], items),
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
  const profileId = text(b.cost_profile_id, 30);
  if (profileId && !(await procurementProfiles(c.env.DB)).some(profile => profile.id === profileId))
    throw badRequest('مسار التوريد غير صحيح', 'INVALID_COST_PROFILE');
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
    const saved = matches[0].procurement_defaults.find(row => row.profile_id === profileId);
    lines.push({
      ...matches[0],
      qty_ordered: whole(r.qty, 'الكمية', 1, 100000),
      source_unit_amount: decimal(r.unit_amount, 'التكلفة'),
      weight_g: r.weight_g ? packedMeasure(r.weight_g, 'الوزن') : profileId ? saved?.weight_g ?? matches[0].packed_weight_g ?? 0 : matches[0].weight_g,
      volume_mm3: r.volume_mm3 ? packedMeasure(r.volume_mm3, 'الحجم') : profileId ? saved?.volume_mm3 ?? matches[0].packed_volume_mm3 ?? 0 : matches[0].volume_mm3,
    });
  }
  return c.json({ success: true, lines });
});
adminProcurementRoutes.get('/config', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'purchase');
  const [suppliers, locations, investors, costProfiles] = await Promise.all([
    c.env.DB.prepare('SELECT id,name FROM inventory_suppliers WHERE active=1 ORDER BY name').all(),
    c.env.DB.prepare('SELECT * FROM stock_locations WHERE active=1 ORDER BY name').all(),
    c.env.DB.prepare("SELECT p.*,u.name,u.email FROM investment_profiles p JOIN users u ON u.id=p.user_id WHERE p.state='active' AND u.role='admin' AND u.admin_scope='assistant' ORDER BY u.name").all(),
    procurementProfiles(c.env.DB),
  ]);
  return c.json({ success: true, suppliers: suppliers.results ?? [], locations: locations.results ?? [],investors:investors.results??[], cost_profiles: costProfiles });
});
adminProcurementRoutes.put('/cost-profiles/:id', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'purchase');
  const body = await bodyOf(c), id = c.req.param('id');
  const profile = (await procurementProfiles(c.env.DB)).find(row => row.id === id);
  if (!profile) throw badRequest('مسار التوريد غير صحيح', 'INVALID_COST_PROFILE');
  if ((body.currency != null && body.currency !== profile.currency) ||
      (body.shipping_basis != null && body.shipping_basis !== profile.shipping_basis))
    throw badRequest('عملة ومسار الشحن لا يتطابقان', 'COST_PROFILE_MISMATCH');
  const version = whole(body.version, 'version', 1), rates = profileRates(body);
  const updated = await c.env.DB.prepare('UPDATE procurement_cost_profiles SET exchange_rate=?,shipping_rate_iqd=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND version=?')
    .bind(rates.exchange_rate, rates.shipping_rate_iqd, user.id, new Date().toISOString(), id, version).run();
  if (!updated.meta.changes) throw conflict('تغيرت أسعار مسار التوريد؛ حدّث البيانات وأعد المحاولة', 'COST_PROFILE_CHANGED');
  await audit(c.env.DB, user.id, 'procurement.profile.updated', id, { ...rates, version: version + 1 });
  return c.json({ success: true, profile: (await procurementProfiles(c.env.DB)).find(row => row.id === id) });
});
adminProcurementRoutes.get('/documents', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'purchase');
  const offset = whole(c.req.query('offset') ?? 0, 'offset', 0, 100000);
  const awaiting=c.req.query('awaiting')==='1';
  const filter=awaiting?"WHERE p.status IN ('ordered','partial')":'';
  const count=await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM purchase_orders p ${filter}`).first<{n:number}>();
  const { results } = await c.env.DB.prepare(
    `SELECT p.*,s.name AS supplier_name,
    (SELECT COALESCE(SUM(COALESCE(i.purchase_total_iqd,i.qty_ordered*i.purchase_unit_iqd)+l.charges_iqd),0) FROM purchase_lines l JOIN incoming_inventory i ON i.id=l.incoming_id WHERE l.purchase_id=p.id) AS total_cost_iqd,
    (SELECT COALESCE(SUM(amount_iqd),0) FROM supplier_payments WHERE purchase_id=p.id) AS paid_iqd
    FROM purchase_orders p LEFT JOIN inventory_suppliers s ON s.id=p.supplier_id ${filter} ORDER BY p.created_at DESC LIMIT 50 OFFSET ?`,
  )
    .bind(offset)
    .all();
  return c.json({ success: true, purchases: results ?? [], offset, total:count?.n??0 });
});
adminProcurementRoutes.get('/documents/:id', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'purchase');
  return c.json({ success: true, ...(await document(c.env.DB, c.req.param('id'))) });
});

/**
 * RECEIVING A SHIPMENT, WITHOUT ITS COST — the `receive` holder's view of a
 * purchase order (owner decision 2).
 *
 * The purchase register and the document are cost (purchase price, charges,
 * payments, funding: `purchase` capability, the owner). Receiving is not:
 * `POST /documents/:id/receive` stays an operations route (`receive`), as it
 * was for full admins before S1 — and a receiver must be able to find the
 * shipment and its lines to use it. These two answers are an ALLOWLIST built
 * column by column, not a stripped document: who sent it, what was ordered,
 * how much has arrived. No purchase price, charge, payment, funding, FX rate,
 * invoice total or selling price is selected at all. Only shipments still
 * awaiting receipt are listed or opened.
 */
const AWAITING_RECEIPT = "('ordered','partial')";
type ReceivingHead = {
  id: string;
  invoice_no: string;
  status: string;
  purchase_day: string;
  expected_day: string | null;
  cost_state: string;
  supplier_name: string | null;
  warehouse_name: string | null;
};
const RECEIVING_HEAD_SQL = `SELECT p.id,p.invoice_no,p.status,p.purchase_day,p.expected_day,p.cost_state,
    s.name AS supplier_name,w.name AS warehouse_name
  FROM purchase_orders p LEFT JOIN inventory_suppliers s ON s.id=p.supplier_id
  LEFT JOIN stock_locations w ON w.id=p.warehouse_id`;
/** `ready` says whether the owner has fixed the final cost — receiving waits for it — without saying what it is. */
const receivingHead = (p: ReceivingHead) => ({
  id: p.id,
  invoice_no: p.invoice_no,
  status: p.status,
  purchase_day: p.purchase_day,
  expected_day: p.expected_day,
  supplier_name: p.supplier_name,
  warehouse_name: p.warehouse_name,
  ready: p.cost_state === 'final',
});
adminProcurementRoutes.get('/receiving', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'receive');
  const { results } = await c.env.DB.prepare(
    `${RECEIVING_HEAD_SQL} WHERE p.status IN ${AWAITING_RECEIPT} ORDER BY p.created_at DESC LIMIT 100`,
  ).all<ReceivingHead>();
  return c.json({ success: true, purchases: (results ?? []).map(receivingHead) });
});
adminProcurementRoutes.get('/receiving/:id', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'receive');
  const id = text(c.req.param('id'), 60);
  const head = await c.env.DB.prepare(`${RECEIVING_HEAD_SQL} WHERE p.id=? AND p.status IN ${AWAITING_RECEIPT}`)
    .bind(id)
    .first<ReceivingHead>();
  if (!head) throw notFound('Purchase not found');
  const { results } = await c.env.DB.prepare(
    `SELECT l.id AS line_id,l.label,l.rejected_qty,i.product_id,i.scope,i.scope_id,i.qty_ordered,i.qty_received
       FROM purchase_lines l JOIN incoming_inventory i ON i.id=l.incoming_id WHERE l.purchase_id=? ORDER BY l.id`,
  )
    .bind(id)
    .all<{
      line_id: string;
      label: string;
      rejected_qty: number;
      product_id: string | null;
      scope: string;
      scope_id: string;
      qty_ordered: number;
      qty_received: number;
    }>();
  return c.json({ success: true, purchase: receivingHead(head), lines: results ?? [] });
});

async function planDocument(
  db: D1Database,
  b: Record<string, unknown>,
  actor: string,
  id: string,
  previous?: Purchase,
) {
  const profileId = text(b.cost_profile_id, 30);
  const profile = profileId ? (await procurementProfiles(db)).find(row => row.id === profileId) : undefined;
  if (profileId && !profile) throw badRequest('مسار التوريد غير صحيح', 'INVALID_COST_PROFILE');
  if (profile && (b.currency !== profile.currency || (b.shipping_basis != null && b.shipping_basis !== profile.shipping_basis)))
    throw badRequest('عملة ومسار الشحن لا يتطابقان', 'COST_PROFILE_MISMATCH');
  const profileVersion = profile ? whole(b.cost_profile_version, 'إصدار أسعار المسار', 1) : null;
  if (profile && profile.version !== profileVersion)
    throw conflict('تغيرت أسعار مسار التوريد؛ حدّث البيانات وأعد المحاولة', 'COST_PROFILE_CHANGED');
  const shippingRate = profile ? profileRates(b).shipping_rate_iqd : null;
  if (!profile && b.shipping_rate_iqd != null && b.shipping_rate_iqd !== '')
    throw badRequest('اختر مسار التوريد لحساب الشحن تلقائياً', 'INVALID_COST_PROFILE');
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
    total: number;
    costMode: 'unit'|'total';
    source: number;
    sourceTotal: number | null;
    weight: number;
    volume: number;
    invoiceQty: number;
    selling: number | null;
    charges: number;
    autoShipping: number;
    key: string;
    incomingId: string;
    lineId: string;
  }> = [];
  for (const v of raw) {
    const r = v as Record<string, unknown>;
    const sel = await requireSelection(db, text(r.product_id, 60), text(r.scope, 20), text(r.scope_id, 60));
    if (profile && ((r.option_id != null && r.option_id !== '' && r.option_id !== sel.option_id) ||
        (r.color_id != null && r.color_id !== '' && r.color_id !== sel.color_id)))
      throw badRequest('اختر هوية المخزون المطابقة للخيار واللون؛ تكلفة الألوان المنفصلة تتطلب مخزون تركيبات', 'INVALID_SELECTION');
    const qty = whole(r.qty_ordered, 'الكمية', 1, 100000);
    const costMode=r.purchase_cost_mode==='total'?'total':'unit';
    const entered=decimal(costMode==='total' ? (profile ? r.source_total_amount : r.source_total_amount??r.purchase_total_iqd) : (profile ? r.source_unit_amount : r.source_unit_amount??r.purchase_unit_iqd),'تكلفة الشراء الخام');
    if(currency==='IQD')whole(entered,'تكلفة الشراء بالدينار');
    const total = profile
      ? procurementAmount(costMode === 'total' ? [entered, rate] : [entered, rate, qty])
      : whole(Math.round(costMode === 'total' ? entered * rate : Math.round(entered * rate) * qty), 'إجمالي شراء البند');
    const unit=Math.floor(total/qty),source=costMode==='total'?entered/qty:entered;
    const weight = packedMeasure(r.weight_g ?? (profile ? sel.packed_weight_g ?? 0 : sel.weight_g), 'الوزن'),
      volume = packedMeasure(r.volume_mm3 ?? (profile ? sel.packed_volume_mm3 ?? 0 : sel.volume_mm3), 'الحجم');
    if (profile && (profile.shipping_basis === 'weight' ? weight : volume) <= 0)
      throw badRequest('أدخل وزن الكرتون مع التغليف أو حجمه لجميع البنود', 'PACKED_MEASUREMENT_REQUIRED');
    const autoShipping = profile ? procurementAmount([qty, profile.shipping_basis === 'weight' ? weight : volume, shippingRate!], profile.shipping_basis === 'weight' ? 1000 : 1e9) : 0;
    lines.push({
      sel,
      qty,
      unit,
      total,
      costMode,
      source,
      sourceTotal: costMode === 'total' ? entered : null,
      weight,
      volume,
      invoiceQty: whole(r.invoiced_qty ?? qty, 'كمية الفاتورة', 0, 100000),
      selling:
        r.selling_price_iqd === null
          ? null
          : whole(r.selling_price_iqd ?? sel.selling_price_iqd, 'سعر البيع'),
      charges: autoShipping,
      autoShipping,
      key: procurementSelectionKey(sel),
      incomingId: newId('inc'),
      lineId: newId('pol'),
    });
  }
  // Extra costs are only what was typed for this document's own lines. Route
  // freight above is already in l.charges; nothing here repeats it.
  const charges = purchaseCharges(b.charges, lines.map((l) => l.key));
  const shares = purchaseChargeShares(
    charges,
    lines.map((l) => ({ key: l.key, qty: l.qty, value: l.total, weight_g: l.weight, volume_mm3: l.volume })),
    profile ? 'BAD_ALLOCATION' : 'ALLOCATION_BASIS_MISSING',
  );
  shares.forEach((row) => row.forEach((share, i) => (lines[i].charges += share)));
  whole(
    lines.reduce((n, l) => n + l.total + l.charges, 0),
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
  if (paid > lines.reduce((n, l) => n + l.total + l.charges, 0))
    throw conflict('المجموع الجديد أقل من دفعات المورد؛ سوّ الدفعة أولًا');
  const statements: D1PreparedStatement[] = [];
  if (previous) {
    const investorReady=await investorFinanceInstalled(db);
    if(investorReady&&await db.prepare("SELECT 1 FROM investment_contracts c JOIN purchase_lines l ON l.incoming_id=c.incoming_id WHERE l.purchase_id=? AND c.state='active'").bind(id).first())throw conflict('أبطل اتفاق الاستثمار غير الممول قبل تعديل بنود الشراء؛ الاتفاقات الممولة تحتفظ بأصلها','INVESTMENT_PURCHASE_FROZEN');
    if(investorReady)statements.push(...fence(db,"NOT EXISTS(SELECT 1 FROM investment_contracts c JOIN purchase_lines l ON l.incoming_id=c.incoming_id WHERE l.purchase_id=? AND c.state='active')",[id]));
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
    for (const l of old){
      if(investorReady)statements.push(db.prepare("UPDATE incoming_inventory SET status='cancelled' WHERE id=? AND EXISTS(SELECT 1 FROM investment_contracts WHERE incoming_id=?)").bind(l.incoming_id,l.incoming_id));
      statements.push(db.prepare(`DELETE FROM incoming_inventory WHERE id=?${investorReady?' AND NOT EXISTS(SELECT 1 FROM investment_contracts WHERE incoming_id=?)':''}`).bind(l.incoming_id,...(investorReady?[l.incoming_id]:[])));
    }
  }
  const header = {
    supplier_id: supplier,
    invoice_no: text(b.invoice_no),
    currency,
    exchange_rate: rate,
    cost_profile_id: profile?.id ?? null,
    cost_profile_version: profileVersion,
    shipping_rate_iqd: shippingRate,
    shipping_basis: profile?.shipping_basis ?? null,
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
  if (profile) {
    // A concurrent settings save must not be silently overwritten by an older
    // open purchase. The entire document/default transaction is fenced.
    statements.push(...fence(db, 'EXISTS(SELECT 1 FROM procurement_cost_profiles WHERE id=? AND version=?)', [profile.id, profileVersion]));
    if (status === 'ordered') statements.push(db.prepare('UPDATE procurement_cost_profiles SET exchange_rate=?,shipping_rate_iqd=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND version=?')
      .bind(rate, shippingRate, actor, now, profile.id, profileVersion));
  }
  const plannedLines:FundedPurchaseLine[]=[];
  for (const l of lines) {
    const incoming = l.incomingId,
      line = l.lineId;
    plannedLines.push({incoming_id:incoming,total_iqd:l.total+l.charges,label:l.sel.label});
    statements.push(
      db
        .prepare(
          `INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,source_currency,source_unit_amount,exchange_rate_used,supplier_id,supplier_ref,purchase_date,expected_at,tracking,notes,status,created_by,purchase_total_iqd) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          l.total,
        ),
    );
    statements.push(
      db
        .prepare(
          'INSERT INTO purchase_lines(id,purchase_id,incoming_id,label,source_unit_amount,weight_g,volume_mm3,selling_price_iqd,charges_iqd,invoiced_qty,purchase_total_iqd,purchase_cost_mode,auto_shipping_iqd,source_total_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
          l.total,
          l.costMode,
          l.autoShipping,
          l.sourceTotal,
        ),
    );
    if (profile && status === 'ordered') statements.push(db.prepare(`INSERT INTO procurement_selection_cost_defaults(profile_id,product_id,scope,scope_id,source_unit_amount,weight_g,volume_mm3,updated_by,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,product_id,scope,scope_id) DO UPDATE SET source_unit_amount=excluded.source_unit_amount,weight_g=excluded.weight_g,volume_mm3=excluded.volume_mm3,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(profile.id, l.sel.product_id, l.sel.scope, l.sel.scope_id, l.costMode === 'total' ? exactProcurementUnitDefault(l.sourceTotal!, l.qty) : l.source, l.weight, l.volume, actor, now));
  }
  charges.forEach((charge, position) => {
    const allocations: ChargeShare[] = lines.flatMap((l, i) => !charge.applies_to || charge.applies_to.includes(l.key) ? [{ line_id: l.lineId, amount_iqd: shares[position][i] }] : []);
    statements.push(
      db
        .prepare('INSERT INTO purchase_charges(id,purchase_id,title,amount_iqd,basis,scope,unit_amount_iqd,applies_to_json,allocation_json,position) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(newId('pch'), id, charge.title, shares[position].reduce((a, b) => a + b, 0), charge.basis, charge.scope, charge.unit_amount_iqd, charge.applies_to ? JSON.stringify(charge.applies_to) : null, JSON.stringify(allocations), position),
    );
  });
  if(status==='ordered')statements.push(...await planPurchaseFunding(db,id,b.funding,plannedLines,actor));
  return statements;
}
adminProcurementRoutes.post('/documents', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'purchase');
  const b = await bodyOf(c),
    id = str(b.operation_id, 'operation_id', { min: 8, max: 40 });
  if((b.funding as {mode?:string}|undefined)?.mode==='investor'&&!isOwner(c.env,user))throw forbidden('تمويل المستثمرين للأدمن الرئيسي فقط');
  const existing = await c.env.DB.prepare('SELECT request_json FROM purchase_orders WHERE id=?')
    .bind(id)
    .first<{ request_json: string }>();
  if (existing) {
    if (existing.request_json !== JSON.stringify(b))
      throw conflict('رقم العملية مستخدم لمحتوى مختلف', 'IDEMPOTENCY_MISMATCH');
    return c.json({ success: true, id, already: true });
  }
  const statements = await planDocument(c.env.DB, b, user.id, id);
  try { await c.env.DB.batch(statements); }
  catch (error) {
    if (b.cost_profile_id && /CHECK constraint/i.test(String(error)))
      throw conflict('تغيرت بيانات الشراء أو أسعار المسار؛ حدّث البيانات وأعد المحاولة', 'COST_PROFILE_CHANGED');
    throw error;
  }
  await audit(c.env.DB, user.id, 'purchase.created', id, {});
  return c.json({ success: true, id });
});
adminProcurementRoutes.put('/documents/:id', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'purchase');
  const b = await bodyOf(c),
    id = c.req.param('id'),
    d = await document(c.env.DB, id);
  if((b.funding as {mode?:string}|undefined)?.mode==='investor'&&!isOwner(c.env,user))throw forbidden('تمويل المستثمرين للأدمن الرئيسي فقط');
  if (d.purchase.version !== whole(b.version, 'version', 1))
    throw conflict('تغيرت الشحنة؛ افتح أحدث نسخة', 'VERSION_CHANGED');
  if (d.lines.some((l) => l.qty_received > 0) || !['draft', 'ordered'].includes(d.purchase.status))
    throw conflict('لا تعدّل التكلفة بعد الاستلام؛ استخدم شحنة جديدة', 'PURCHASE_FROZEN');
  await commitPurchase(c.env.DB,d.purchase,await planDocument(c.env.DB, b, user.id, id, d.purchase));
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
  const funded=(await c.env.DB.prepare('SELECT * FROM purchase_investor_allocations WHERE purchase_id=?').bind(id).all<{incoming_id:string;contract_id:string;principal_iqd:number}>()).results??[];
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
    // Split at every integer remainder boundary. Purchase total and inbound
    // freight retain their own components, and FIFO sees uniform-cost lots.
    const purchaseTotal=line.purchase_total_iqd??line.purchase_unit_iqd*line.qty_ordered;
    const purchaseBase=Math.floor(purchaseTotal/line.qty_ordered),purchaseRemainder=purchaseTotal%line.qty_ordered;
    const shippingBase=Math.floor(line.charges_iqd/line.qty_ordered),shippingRemainder=line.charges_iqd%line.qty_ordered;
    const capitalShares=funded.filter(a=>a.incoming_id===line.id);
    const boundaries=[...new Set([line.qty_received,line.qty_received+qty,purchaseRemainder,shippingRemainder,...capitalShares.map(a=>a.principal_iqd%line.qty_ordered)].filter(n=>n>=line.qty_received&&n<=line.qty_received+qty))].sort((a,b)=>a-b);
    let received=line.qty_received;
    for(let segmentIndex=0;segmentIndex<boundaries.length-1;segmentIndex++){
      const position=boundaries[segmentIndex],segment={qty:boundaries[segmentIndex+1]-position};
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
      for(const share of capitalShares)statements.push(c.env.DB.prepare('INSERT INTO purchase_investor_lot_capital(lot_id,contract_id,unit_principal_iqd,qty) VALUES (?,?,?,?)').bind(lot,share.contract_id,Math.floor(share.principal_iqd/line.qty_ordered)+Number(position<share.principal_iqd%line.qty_ordered),segment.qty));
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
      total += segment.qty * (purchaseBase+Number(position<purchaseRemainder)+shippingBase+Number(position<shippingRemainder));
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

adminProcurementRoutes.post('/documents/:id/investor-receipts',async c=>{
  const user=c.get('user')!;if(!isOwner(c.env,user))throw forbidden('تسجيل تمويل المستثمر للأدمن الرئيسي فقط');
  await requireCapability(c.env,user,'accounting');
  return c.json({success:true,...await receivePurchaseFunding(c.env.DB,c.req.param('id'),await bodyOf(c),user.id)});
});
