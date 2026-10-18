import { cancelledPurchaseReviewStatements, purchaseReviewStatements } from '../lib/pricingEngine/v2/purchaseReview';
import { productNameOf, purchaseReviewArrivedBell } from '../lib/pricingEngine/v2/bell';
import { draftForPricing, purchaseUsdIqd } from '../lib/pricingEngine/purchaseRead';
import { Hono, type Context } from 'hono';
import { allocateProcurementCharges, exactProcurementUnitDefault, procurementSelectionKey } from '../../packages/contracts/src/procurementCost';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, forbidden, notFound, str, HttpError } from '../lib/http';
import { isOwner, projectForAdmin } from '../lib/adminScope';
import { newId } from '../lib/crypto';
import { audit, auditStatements } from '../lib/audit';
import { requireSelection, productSelections } from '../lib/inventorySelection';
import { planReceive, type IncomingRow } from '../lib/inventoryReceiving';
import {
  baghdadDay,
  dateValue,
  decimal,
  fence,
  isFenceMiss,
  journalPlan,
  periodOpen,
  requireCapability,
  whole,
} from '../lib/operations';
import { parsePurchaseCsv } from '../lib/purchaseCsv';
import { planPurchaseFunding, purchaseFundingSummary, receivePurchaseFunding, type FundedPurchaseLine } from '../lib/purchaseFunding';
import { investorFinanceInstalled } from '../lib/investorFinance';
import { packedMeasure, procurementProfiles, profileRates, type PurchaseCharge } from '../lib/procurementCosts';
import { parseProcurementDraft } from '../lib/procurementDraft';
import { approvedProcurementRates, requireApprovedDocumentRate } from '../lib/pricingEngine/procurementRate';
import { cleanStartInstalled, engineColumnInstalled } from '../lib/engineInstalled';
import { batchSnapshotInstalled, purchaseLotSnapshot, type PurchaseFxSource } from '../lib/batchSnapshot';
import { serverMessage } from '../../packages/contracts/src/costRefusals';
import { unitOriginsInstalled, normalizeUnitOrigins, planCreateUnitOrigins, planReceiveUnitOrigins, unitOriginsByIncoming } from '../lib/inventoryUnitOrigins';
import { planDraftOriginSerials, originSerialConflict } from '../lib/procurementOriginSerials';

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
} & Partial<Omit<PurchaseFxSource, 'id'>>;
type Line = IncomingRow & {
  line_id: string;
  label: string;
  charges_iqd: number;
  auto_shipping_iqd: number;
  invoiced_qty: number;
  rejected_qty: number;
  source_unit_amount: number;
  source_total_amount: number | null;
  purchase_cost_mode?: string | null;
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
    // The database's own freeze of a received purchase and its FX snapshot
    // (migration 0182) answers as the route's refusal does: the cost after a
    // receipt is fixed. Never the driver's text.
    if (/(^|[^A-Z_])PURCHASE_FROZEN([^A-Z_]|$)/.test(`${String(error)} ${String((error as { cause?: unknown })?.cause ?? '')}`))
      throw conflict('لا تعدّل التكلفة بعد الاستلام؛ استخدم شحنة جديدة', 'PURCHASE_FROZEN');
    // Two saves raced to fund the same purchase: it keeps the agreement that
    // landed first (immutable) — a 409 in three languages, never a 500.
    if (/UNIQUE constraint failed: purchase_investor_agreements\.purchase_id/.test(`${String(error)} ${String((error as { cause?: unknown })?.cause ?? '')}`))
      throw conflict(serverMessage('INVESTMENT_AGREEMENT_EXISTS'), 'INVESTMENT_AGREEMENT_EXISTS');
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
type ChargeRow = { id: string; title: string; amount_iqd: number; basis: PurchaseCharge['basis']; scope: string | null; unit_amount_iqd: number | null; applies_to_json: string | null; allocation_json: string | null; pricing_role?: string | null };
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
    // The double-freight guard's flag (0181): null on a manual document, an older row or database.
    pricing_role: r.pricing_role === 'additional' || r.pricing_role === 'excluded' ? r.pricing_role : null,
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
const PURCHASE_NAME_MAX = 120;
const normalizedPurchaseName = (value: unknown) => {
  const name = text(value, 10_000).replace(/\s+/g, ' ').trim();
  if (name.length > PURCHASE_NAME_MAX)
    throw new HttpError(400, serverMessage('PURCHASE_NAME_TOO_LONG'), 'PURCHASE_NAME_TOO_LONG', { max: PURCHASE_NAME_MAX });
  return name;
};
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
  const origins = await unitOriginsByIncoming(db, (lines.results ?? []).map((line) => line.id));
  const items = (lines.results ?? []).map((line) => ({ ...line, unit_origins: origins.get(line.id) ?? [] }));
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
/**
 * THE DOCUMENT AS THE OWNER'S SCREEN READS IT — every private figure under a
 * name the cost net knows (DECISIONS row 220). `document()` keeps the column
 * names its own callers compute with; the answer renames the ones whose column
 * name is generic (`amount_iqd`, `paid_iqd`, `attachment_url` are wallet,
 * store and chat words too, so they can never join FINANCIAL_FIELDS): a
 * future route that reused this answer for anyone but the owner would have it
 * stripped by `projectForAdmin`, not handed over. The panel maps it back
 * (src/components/adminOperations/procurementWire.ts).
 */
type Doc = Awaited<ReturnType<typeof document>>;
function documentWire(d: Doc) {
  const { attachment_url, ...purchase } = d.purchase as Purchase & { attachment_url?: unknown };
  return {
    purchase: { ...purchase, invoice_attachment_url: attachment_url ?? '' },
    funding: d.funding,
    lines: d.lines,
    charges: d.charges.map(({ amount_iqd, unit_amount_iqd, allocations, ...c }) => ({
      ...c,
      charge_amount_iqd: amount_iqd,
      charge_unit_amount_iqd: unit_amount_iqd,
      allocations: allocations ? allocations.map((a) => ({ line_id: a.line_id, charge_amount_iqd: a.amount_iqd })) : null,
    })),
    payments: d.payments.map(({ amount_iqd, ...pay }) => ({ ...pay, supplier_payment_iqd: amount_iqd })),
    ordered_total_iqd: d.ordered_total_iqd,
    supplier_paid_iqd: d.paid_iqd,
    supplier_balance_iqd: d.balance_iqd,
    matching: d.matching,
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
  // V2-0 F4 (DECISIONS row 224): the approved central rates the document's rate
  // is prefilled from and checked against — the engine's own (pricing_fx_rates).
  // This answer is the purchase capability's, the owner's only. An unreadable
  // rate table leaves the list empty: the field stays empty and the save, which
  // reads the rates again, decides.
  const approvedRates = await approvedProcurementRates(c.env.DB).catch(() => []);
  return c.json({ success: true, suppliers: suppliers.results ?? [], locations: locations.results ?? [],investors:investors.results??[], cost_profiles: costProfiles, approved_rates: approvedRates });
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
    (SELECT COALESCE(SUM(amount_iqd),0) FROM supplier_payments WHERE purchase_id=p.id) AS supplier_paid_iqd
    FROM purchase_orders p LEFT JOIN inventory_suppliers s ON s.id=p.supplier_id ${filter} ORDER BY p.created_at DESC LIMIT 50 OFFSET ?`,
  )
    .bind(offset)
    .all<Record<string, unknown>>();
  // The same names as the document's answer (documentWire): the invoice link under its own name.
  const purchases = (results ?? []).map(({ attachment_url, ...p }) => ({ ...p, invoice_attachment_url: attachment_url ?? '' }));
  return c.json({ success: true, purchases, offset, total:count?.n??0 });
});
/**
 * D1 (the clean start, addendum A.10): which products of a purchase have a
 * price review from its confirm, and its state — product ids and states only,
 * never a figure (the review's cost stays behind the owner's review routes).
 * Row 249: a purchase refreshes its review on every save, so each product is
 * named once — by its pending review, else its latest one. A database before
 * 0190 has none.
 */
async function priceReviewsOf(db: D1Database, purchaseId: string): Promise<Array<{ product_id: string; state: string }>> {
  try {
    const rows =
      (await db.prepare('SELECT product_id, state FROM pricing_v2_purchase_reviews WHERE purchase_id = ? ORDER BY created_at, id').bind(purchaseId).all<{ product_id: string; state: string }>()).results ?? [];
    const latest = new Map<string, { product_id: string; state: string }>();
    for (const r of rows) {
      const at = latest.get(r.product_id);
      if (!at || at.state !== 'pending') latest.set(r.product_id, { product_id: r.product_id, state: r.state });
    }
    return [...latest.values()];
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return [];
    throw e;
  }
}
adminProcurementRoutes.get('/documents/:id', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'purchase');
  const doc = documentWire(await document(c.env.DB, c.req.param('id')));
  return c.json({ success: true, ...doc, price_reviews: await priceReviewsOf(c.env.DB, doc.purchase.id) });
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
  version: number;
  invoice_no: string;
  status: string;
  purchase_day: string;
  expected_day: string | null;
  cost_state: string;
  supplier_name: string | null;
  warehouse_name: string | null;
};
const RECEIVING_HEAD_SQL = `SELECT p.id,p.version,p.invoice_no,p.status,p.purchase_day,p.expected_day,p.cost_state,
    s.name AS supplier_name,w.name AS warehouse_name
  FROM purchase_orders p LEFT JOIN inventory_suppliers s ON s.id=p.supplier_id
  LEFT JOIN stock_locations w ON w.id=p.warehouse_id`;
/** `ready` says whether the owner has fixed the final cost — receiving waits for it — without saying what it is. */
const receivingHead = (p: ReceivingHead) => ({
  id: p.id,
  version: p.version,
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
    `SELECT l.id AS line_id,i.id AS incoming_id,l.label,l.rejected_qty,i.product_id,i.scope,i.scope_id,i.qty_ordered,i.qty_received
       FROM purchase_lines l JOIN incoming_inventory i ON i.id=l.incoming_id WHERE l.purchase_id=? ORDER BY l.id`,
  )
    .bind(id)
    .all<{
      line_id: string;
      incoming_id: string;
      label: string;
      rejected_qty: number;
      product_id: string | null;
      scope: string;
      scope_id: string;
      qty_ordered: number;
      qty_received: number;
    }>();
  const origins = await unitOriginsByIncoming(c.env.DB, (results ?? []).map((line) => line.incoming_id));
  return c.json({ success: true, purchase: receivingHead(head), lines: (results ?? []).map((line) => ({ ...line, unit_origins: origins.get(line.incoming_id) ?? [] })) });
});

/**
 * The purchase's FX snapshot (FX plan §17, L6): the effective USD/IQD, EUR/USD
 * and CNY/USD of `fx_rate_pairs` at the moment it is first ordered, written
 * once (`WHERE fx_snapshot_at IS NULL`; from 0182 the database refuses any
 * later change too). The rates are read here, not by a sub-select, so a
 * database without 0179 is detected and the snapshot skipped instead of
 * failing the purchase. FX-6 (0182) records each rate's version beside it —
 * the batches received from this purchase carry them (worker/lib/batchSnapshot.ts);
 * without 0182 the statement is the FX-1 one, byte for byte.
 */
async function fxSnapshotStatements(db: D1Database, id: string, now: string): Promise<D1PreparedStatement[]> {
  let rates: Array<{ pair: string; effective_rate: string | null; effective_version: number | null }>;
  try {
    rates = (await db.prepare('SELECT pair, effective_rate, effective_version FROM fx_rate_pairs').all<{ pair: string; effective_rate: string | null; effective_version: number | null }>()).results ?? [];
  } catch {
    return [];
  }
  const of = (pair: string) => rates.find((r) => r.pair === pair)?.effective_rate ?? null;
  const versionOf = (pair: string) => {
    const r = rates.find((x) => x.pair === pair);
    return r?.effective_rate != null && Number.isSafeInteger(r.effective_version) && Number(r.effective_version) > 0 ? Number(r.effective_version) : null;
  };
  if (await batchSnapshotInstalled(db))
    return [
      db
        .prepare(
          'UPDATE purchase_orders SET fx_usd_iqd_at_purchase=?, fx_eur_usd_at_purchase=?, fx_cny_usd_at_purchase=?, fx_snapshot_at=?, fx_usd_iqd_version_at_purchase=?, fx_eur_usd_version_at_purchase=?, fx_cny_usd_version_at_purchase=? WHERE id=? AND fx_snapshot_at IS NULL',
        )
        .bind(of('USD_IQD'), of('EUR_USD'), of('CNY_USD'), now, versionOf('USD_IQD'), versionOf('EUR_USD'), versionOf('CNY_USD'), id),
    ];
  return [
    db
      .prepare(
        'UPDATE purchase_orders SET fx_usd_iqd_at_purchase=?, fx_eur_usd_at_purchase=?, fx_cny_usd_at_purchase=?, fx_snapshot_at=? WHERE id=? AND fx_snapshot_at IS NULL',
      )
      .bind(of('USD_IQD'), of('EUR_USD'), of('CNY_USD'), now, id),
  ];
}

async function planDocument(
  db: D1Database,
  b: Record<string, unknown>,
  actor: string,
  id: string,
  previous?: Purchase,
) {
  // The lines and charges, parsed and computed exactly as the owner's pricing
  // preview reads a draft (worker/lib/procurementDraft.ts).
  const parsedDraft = await parseProcurementDraft(db, b);
  const { profile, profileVersion, shippingRate, currency, rate, lines, charges, shares } = parsedDraft;
  // V2-0 F4 (DECISIONS row 224): the server decides the rate — an approved
  // central rate must exist for the currency, and one more than 6% away from it
  // needs the owner's explicit `confirm_rate` (worker/lib/pricingEngine/procurementRate.ts).
  await requireApprovedDocumentRate(db, currency, rate, b.confirm_rate === true);
  // Procurement provenance is deliberately separate from the pricing parser:
  // supplier order/tracking references never participate in prices or COGS.
  const rawLines = b.lines as Record<string, unknown>[];
  const origins = lines.map((line, index) => normalizeUnitOrigins(rawLines[index].unit_origins, line.qty));
  const serialCount = origins.reduce((sum, units) => sum + units.filter((unit) => unit.serial_no).length, 0);
  if (serialCount > 50)
    throw badRequest('سجل حتى 50 سيريالاً مع تأكيد الشراء؛ يمكن مسح بقية الأجهزة وحفظها مباشرة بعد التأكيد', 'PURCHASE_SERIAL_LIMIT');
  if (origins.reduce((sum, units) => sum + units.length, 0) > 5000)
    throw badRequest('قسّم الشراء إلى شحنات أصغر لتتبع أكثر من 5000 قطعة', 'UNIT_ORIGINS_LIMIT');
  const originsInstalled = await unitOriginsInstalled(db);
  if (origins.some((units) => units.length) && !originsInstalled)
    throw new HttpError(503, 'لم تُفعّل ميزة تتبع القطع بعد؛ أعد المحاولة بعد تحديث قاعدة البيانات', 'UNIT_ORIGINS_NOT_INSTALLED');
  const day = dateValue(b.purchase_day, baghdadDay());
  const now = new Date().toISOString();
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
  if (status === 'draft' && serialCount)
    throw badRequest('أكد أمر الشراء لتسجيل سيريالات الأجهزة؛ تبقى الأرقام في المسودة المحلية حتى التأكيد', 'PURCHASE_SERIAL_REQUIRES_CONFIRM');
  if (state !== 'final' && serialCount)
    throw badRequest('أكمل التكلفة النهائية للشحنة قبل تسجيل سيريالات الأجهزة', 'PURCHASE_SERIAL_REQUIRES_FINAL_COST');
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
    // A whole-document edit recreates its incoming lines. Once a physical
    // serial has been enrolled, that source identity must survive forever.
    // Supplier references and the purchase name have independent safe edits.
    if (originsInstalled) {
      if (await db.prepare('SELECT 1 FROM inventory_unit_origins WHERE purchase_id=? AND serial_norm IS NOT NULL LIMIT 1').bind(id).first())
        throw conflict('تم تثبيت سيريالات هذه الشحنة؛ استخدم تعديل مراجع القطع أو شحنة جديدة لتغيير البنود', 'PURCHASE_SERIALS_FROZEN');
      statements.push(...fence(db, 'NOT EXISTS(SELECT 1 FROM inventory_unit_origins WHERE purchase_id=? AND serial_norm IS NOT NULL)', [id]));
    }
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
    );
    if (originsInstalled) statements.push(db.prepare('DELETE FROM inventory_unit_origins WHERE purchase_id=? AND received_lot_id IS NULL').bind(id));
    statements.push(db.prepare('DELETE FROM purchase_lines WHERE purchase_id=?').bind(id));
    for (const l of old){
      if(investorReady)statements.push(db.prepare("UPDATE incoming_inventory SET status='cancelled' WHERE id=? AND EXISTS(SELECT 1 FROM investment_contracts WHERE incoming_id=?)").bind(l.incoming_id,l.incoming_id));
      statements.push(db.prepare(`DELETE FROM incoming_inventory WHERE id=?${investorReady?' AND NOT EXISTS(SELECT 1 FROM investment_contracts WHERE incoming_id=?)':''}`).bind(l.incoming_id,...(investorReady?[l.incoming_id]:[])));
    }
  }
  const header = {
    supplier_id: supplier,
    invoice_no: normalizedPurchaseName(b.invoice_no),
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
  // §17 groundwork (FX plan §4.1 part 5, critique L6): the FIRST time the
  // document is confirmed 'ordered' it snapshots the CENTRAL effective rates
  // (U, E, C) in a SEPARATE statement guarded on `fx_snapshot_at IS NULL` —
  // never through `header` above, which rewrites every key on every save and
  // would replace the purchase-time rates with today's. NULL is a rate not
  // known then. Skipped on a database without migration 0179.
  // ONLY WHEN THIS SAVE ORDERS IT — a new document saved as ordered, or a
  // draft confirmed: a document already ordered before 0179 has NULL rates
  // (UNKNOWN), and its next edit must not record the edit day's rates as its
  // purchase-time rates (FX-1 correctness review C7; FX-6's L10 reads them).
  if (status === 'ordered' && previous?.status !== 'ordered') statements.push(...(await fxSnapshotStatements(db, id, now)));
  // D1 (the clean start, addendum A.10; DECISIONS row 249): EVERY save that leaves the document ordered
  // creates or refreshes its pending purchase review per product, in this batch — the confirm, an
  // estimated → final edit, a cost edit before receipt — never a price or an input; the owner decides each
  // from the product. A save that takes an ordered document back to draft or estimated supersedes its reviews.
  if (status === 'ordered' || previous?.status === 'ordered') {
    const usdIqd = currency === 'IQD' && status === 'ordered' ? await purchaseUsdIqd(db, previous, now) : null;
    statements.push(...(await purchaseReviewStatements(db, { ...draftForPricing(parsedDraft, { ...b, status }, id), usd_iqd: usdIqd }, actor, now)));
  }
  if (profile) {
    // A concurrent settings save must not be silently overwritten by an older
    // open purchase. The entire document/default transaction is fenced.
    statements.push(...fence(db, 'EXISTS(SELECT 1 FROM procurement_cost_profiles WHERE id=? AND version=?)', [profile.id, profileVersion]));
    if (status === 'ordered') statements.push(db.prepare('UPDATE procurement_cost_profiles SET exchange_rate=?,shipping_rate_iqd=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND version=?')
      .bind(rate, shippingRate, actor, now, profile.id, profileVersion));
  }
  const plannedLines:FundedPurchaseLine[]=[];
  for (const [lineIndex, l] of lines.entries()) {
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
          normalizedPurchaseName(b.invoice_no),
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
    statements.push(...planCreateUnitOrigins(db, {
      incomingId: incoming, purchaseLineId: line, purchaseId: id,
      units: origins[lineIndex], actorId: actor,
    }));
    if (origins[lineIndex].some((unit) => unit.serial_no)) statements.push(...await planDraftOriginSerials(db, {
      purchaseId: id, incomingId: incoming, productId: l.sel.product_id,
      scope: l.sel.scope, scopeId: l.sel.scope_id, units: origins[lineIndex], actorId: actor,
    }));
    // The next purchase's prefill learns only a FINAL cost (row 249): an estimate is never offered as the last price.
    if (profile && status === 'ordered' && state === 'final') statements.push(db.prepare(`INSERT INTO procurement_selection_cost_defaults(profile_id,product_id,scope,scope_id,source_unit_amount,weight_g,volume_mm3,updated_by,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,product_id,scope,scope_id) DO UPDATE SET source_unit_amount=excluded.source_unit_amount,weight_g=excluded.weight_g,volume_mm3=excluded.volume_mm3,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(profile.id, l.sel.product_id, l.sel.scope, l.sel.scope_id, l.costMode === 'total' ? exactProcurementUnitDefault(l.sourceTotal!, l.qty) : l.source, l.weight, l.volume, actor, now));
  }
  // The double-freight guard's flag (0181, USD design §3.3) is named only when
  // the column exists: on an older database the INSERT is byte-identical to
  // today's (deploy-ahead, fit #9).
  const withRole = charges.length > 0 && (await engineColumnInstalled(db, 'purchase_charges', 'pricing_role'));
  charges.forEach((charge, position) => {
    const allocations: ChargeShare[] = lines.flatMap((l, i) => !charge.applies_to || charge.applies_to.includes(l.key) ? [{ line_id: l.lineId, amount_iqd: shares[position][i] }] : []);
    const values = [newId('pch'), id, charge.title, shares[position].reduce((a, b) => a + b, 0), charge.basis, charge.scope, charge.unit_amount_iqd, charge.applies_to ? JSON.stringify(charge.applies_to) : null, JSON.stringify(allocations), position];
    statements.push(
      withRole
        ? db
            .prepare('INSERT INTO purchase_charges(id,purchase_id,title,amount_iqd,basis,scope,unit_amount_iqd,applies_to_json,allocation_json,position,pricing_role) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .bind(...values, charge.pricing_role)
        : db
            .prepare('INSERT INTO purchase_charges(id,purchase_id,title,amount_iqd,basis,scope,unit_amount_iqd,applies_to_json,allocation_json,position) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .bind(...values),
    );
  });
  if(status==='ordered')statements.push(...await planPurchaseFunding(db,id,b.funding,plannedLines,actor,{costState:state}));
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
  try {
    const statements = await planDocument(c.env.DB, b, user.id, id);
    await c.env.DB.batch(statements);
  }
  catch (error) {
    // The first request may finish after our idempotency read, including while
    // we prepare its funding agreement. Re-read the immutable request after a
    // failed plan/batch so the same confirm is an exact replay, never a 500 or
    // a second capital credit. A reused key with different content stays 409.
    const raced = await c.env.DB.prepare('SELECT request_json FROM purchase_orders WHERE id=?')
      .bind(id).first<{ request_json: string }>();
    if (raced) {
      if (raced.request_json !== JSON.stringify(b))
        throw conflict('رقم العملية مستخدم لمحتوى مختلف', 'IDEMPOTENCY_MISMATCH');
      return c.json({ success: true, id, already: true });
    }
    const hasSerialInput = Array.isArray(b.lines) && b.lines.some((line) => line && typeof line === 'object' &&
      Array.isArray(line.unit_origins) && line.unit_origins.some((unit: Record<string, unknown>) => unit && typeof unit.serial_no === 'string' && unit.serial_no.trim()));
    if ((hasSerialInput && isFenceMiss(error)) || /UNIQUE constraint failed: (inventory_unit_origins.serial_norm|serial_inventory.serial_norm|stock_serial_links.serial_norm)/.test(String(error)))
      throw originSerialConflict();
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
/**
 * «تغيير الاسم» — A PURCHASE'S NAME, AT ANY STATUS (owner request 2026-10-10:
 * «لا يمكن تسمية المخزون»).
 *
 * The name is `purchase_orders.invoice_no` («اسم الشراء أو رقم الفاتورة»):
 * every reader already shows it as the purchase's name — the register, the
 * receiving list (assistant receivers too), the investor-finance labels and
 * the participant report. The full PUT cannot rename a confirmed, funded or
 * received purchase (it re-plans the cost and is frozen then); this route
 * changes the label alone:
 *   - draft, ordered, investor-funded, partly or fully received, cancelled;
 *   - trimmed, whitespace collapsed, 0-120 characters (empty clears it);
 *   - `before` (optional): the name the screen showed; a different stored name
 *     is someone else's rename → 409 PURCHASE_NAME_CHANGED;
 *   - the same name → `already`, no write, no audit;
 *   - ONE batch: a fence on the name read (a concurrent rename → 409), the
 *     purchase's name, the receiving copies (`incoming_inventory.supplier_ref`,
 *     not frozen by 0182) and the audit row `purchase.renamed {before, after}`.
 * `version` is NOT bumped — it fences cost edits, and a rename must not break
 * an open editor — and `request_json` is untouched, so a replayed POST stays
 * `already`. No cost column is written.
 */
adminProcurementRoutes.patch('/documents/:id/name', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'purchase');
  const raw = await bodyOf(c);
  const b: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // Only these two keys (a name is never sent with a cost beside it); FX's strictBody stays FX's.
  const unknown = Object.keys(b).filter((k) => k !== 'name' && k !== 'before').sort();
  if (unknown.length) throw new HttpError(400, serverMessage('UNKNOWN_FIELD'), 'UNKNOWN_FIELD', { fields: unknown });
  const id = text(c.req.param('id'), 60);
  // The name is always sent (an empty one clears it): a body without it is a mistake, never a rename to nothing.
  if (typeof b.name !== 'string') throw badRequest('اسم الشراء نص / The purchase name is text');
  if (b.before !== undefined && b.before !== null && typeof b.before !== 'string') throw badRequest('اسم الشراء نص / The purchase name is text');
  const name = normalizedPurchaseName(b.name);
  const db = c.env.DB;
  const current = await db.prepare('SELECT invoice_no FROM purchase_orders WHERE id=?').bind(id).first<{ invoice_no: string | null }>();
  if (!current) throw notFound('Purchase not found');
  const before = current.invoice_no ?? '';
  if (before === name) return c.json({ success: true, id, name, already: true });
  if (typeof b.before === 'string' && b.before.replace(/\s+/g, ' ').trim() !== before.replace(/\s+/g, ' ').trim())
    throw conflict(serverMessage('PURCHASE_NAME_CHANGED'), 'PURCHASE_NAME_CHANGED');
  const now = new Date().toISOString();
  const statements = [
    ...fence(db, 'EXISTS(SELECT 1 FROM purchase_orders WHERE id=? AND invoice_no IS ?)', [id, current.invoice_no]),
    db.prepare('UPDATE purchase_orders SET invoice_no=?, updated_at=? WHERE id=?').bind(name, now, id),
    db.prepare('UPDATE incoming_inventory SET supplier_ref=? WHERE id IN (SELECT incoming_id FROM purchase_lines WHERE purchase_id=?)').bind(name, id),
    ...(await auditStatements(db, user.id, 'purchase.renamed', id, { before, after: name })).statements,
  ];
  try {
    await db.batch(statements);
  } catch (e) {
    if (isFenceMiss(e)) throw conflict(serverMessage('PURCHASE_NAME_CHANGED'), 'PURCHASE_NAME_CHANGED');
    throw e;
  }
  return c.json({ success: true, id, name });
});
// Operational source references have no financial fields. Assistants may
// complete a tracking number after receipt without reopening frozen costs.
adminProcurementRoutes.get('/documents/:id/unit-origins', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'receive');
  const id = c.req.param('id');
  const purchase = await c.env.DB.prepare("SELECT id,invoice_no,version,status,(status IN ('ordered','partial','received') AND cost_state='final') AS serial_enrollment_allowed FROM purchase_orders WHERE id=?").bind(id).first();
  if (!purchase) throw notFound('Purchase not found');
  const lines = (await c.env.DB.prepare('SELECT id,incoming_id,label FROM purchase_lines WHERE purchase_id=? ORDER BY id').bind(id).all<{ id: string; incoming_id: string; label: string }>()).results ?? [];
  const origins = await unitOriginsByIncoming(c.env.DB, lines.map((line) => line.incoming_id));
  return c.json({ success: true, purchase, lines: lines.map((line) => ({ line_id: line.id, label: line.label, unit_origins: origins.get(line.incoming_id) ?? [] })) });
});
adminProcurementRoutes.patch('/documents/:id/unit-origins', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'receive');
  if (!await unitOriginsInstalled(c.env.DB))
    throw new HttpError(503, 'لم تُفعّل ميزة تتبع القطع بعد', 'UNIT_ORIGINS_NOT_INSTALLED');
  const id = c.req.param('id'), body = await bodyOf(c);
  if (Object.keys(body).some((key) => !['version', 'units'].includes(key)))
    throw badRequest('هذا الإجراء يحدّث مراجع المورد فقط', 'UNKNOWN_FIELD');
  const version = whole(body.version, 'إصدار الشراء', 1);
  const purchase = await c.env.DB.prepare('SELECT id,version FROM purchase_orders WHERE id=?').bind(id).first<{ id: string; version: number }>();
  if (!purchase) throw notFound('Purchase not found');
  if (purchase.version !== version) throw conflict('تغير الشراء؛ حدّث البيانات وأعد المحاولة', 'VERSION_CHANGED');
  if (!Array.isArray(body.units) || !body.units.length || body.units.length > 1000)
    throw badRequest('اختر بين قطعة واحدة و1000 قطعة', 'INVALID_UNIT_ORIGINS');
  const seen = new Set<string>();
  const edits: Array<{ id: string; supplier_order_no: string; tracking_no: string }> = [];
  const statements = fence(c.env.DB, 'EXISTS(SELECT 1 FROM purchase_orders WHERE id=? AND version=?)', [id, version]);
  for (const value of body.units) {
    if (!value || typeof value !== 'object') throw badRequest('سجل القطعة غير صحيح', 'INVALID_UNIT_ORIGINS');
    const row = value as Record<string, unknown>, unitId = str(row.id, 'id', { min: 1, max: 120 });
    if (Object.keys(row).some((key) => !['id', 'supplier_order_no', 'tracking_no'].includes(key)))
      throw badRequest('هذا الإجراء يحدّث مراجع المورد فقط', 'UNKNOWN_FIELD');
    if (seen.has(unitId)) throw badRequest('معرّف قطعة مكرر', 'INVALID_UNIT_ORIGINS');
    seen.add(unitId);
    const after = normalizeUnitOrigins([{ unit_index: 1, supplier_order_no: row.supplier_order_no, tracking_no: row.tracking_no }], 1)[0];
    edits.push({ id: unitId, supplier_order_no: after.supplier_order_no, tracking_no: after.tracking_no });
  }
  const wire = JSON.stringify(edits);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM inventory_unit_origins WHERE purchase_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))").bind(id, wire).first<{ n: number }>();
  if (count?.n !== edits.length) throw badRequest('القطعة ليست ضمن هذا الشراء', 'INVALID_UNIT_ORIGINS');
  // Bulk SQL keeps a 1000-piece document bounded without truncating the
  // before/after audit record of any piece. The purchase version fences both.
  statements.push(c.env.DB.prepare(`INSERT INTO audit_log(actor_id,action,target,detail)
    SELECT ?1,'purchase.unit_origins_updated',u.id,
      json_object('purchase_id',?2,'id',u.id,'before',json_object('supplier_order_no',u.supplier_order_no,'tracking_no',u.tracking_no),
        'after',json_object('supplier_order_no',json_extract(j.value,'$.supplier_order_no'),'tracking_no',json_extract(j.value,'$.tracking_no')))
    FROM json_each(?3) j JOIN inventory_unit_origins u ON u.id=json_extract(j.value,'$.id') WHERE u.purchase_id=?2`).bind(user.id,id,wire));
  statements.push(c.env.DB.prepare(`UPDATE inventory_unit_origins SET
    supplier_order_no=(SELECT json_extract(value,'$.supplier_order_no') FROM json_each(?1) WHERE json_extract(value,'$.id')=inventory_unit_origins.id),
    tracking_no=(SELECT json_extract(value,'$.tracking_no') FROM json_each(?1) WHERE json_extract(value,'$.id')=inventory_unit_origins.id)
    WHERE purchase_id=?2 AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))`).bind(wire,id));
  statements.push(c.env.DB.prepare('UPDATE purchase_orders SET version=version+1,updated_at=? WHERE id=?').bind(new Date().toISOString(), id));
  statements.push(...(await auditStatements(c.env.DB, user.id, 'purchase.unit_origins_batch_updated', id, { count: edits.length })).statements);
  try { await c.env.DB.batch(statements); }
  catch (error) { if (isFenceMiss(error)) throw conflict('تغير الشراء؛ حدّث البيانات وأعد المحاولة', 'VERSION_CHANGED'); throw error; }
  return c.json({ success: true, version: version + 1 });
});

/**
 * DECISIONS row 249: confirming the arrival of units whose purchase cost still waits for the owner's
 * review rings his bell once per product and purchase (bell.ts, no figure), in the receive's own batch.
 * One read; nothing on a database before 0190.
 */
async function arrivedBells(c: Context<AppContext>, purchaseId: string, productIds: string[]): Promise<D1PreparedStatement[]> {
  if (!productIds.length || !(await cleanStartInstalled(c.env.DB))) return [];
  const rows =
    (
      await c.env.DB.prepare(
        "SELECT r.product_id, p.name, p.name_ar FROM pricing_v2_purchase_reviews r JOIN products p ON p.id = r.product_id WHERE r.purchase_id = ? AND r.state = 'pending' AND r.product_id IN (SELECT value FROM json_each(?)) ORDER BY r.product_id",
      )
        .bind(purchaseId, JSON.stringify(productIds))
        .all<Record<string, unknown> & { product_id: string }>()
    ).results ?? [];
  const out: D1PreparedStatement[] = [];
  for (const r of rows) out.push(...(await purchaseReviewArrivedBell(c.env, r.product_id, purchaseId, productNameOf(r))));
  return out;
}

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
  // FX-6 (§17): each lot records, in its own INSERT, the rates this purchase
  // was confirmed at, the supplier's own currency and amount and the IQD it is
  // booked at. Without 0182 the lot INSERT is the one before FX-6.
  const snapshots = await batchSnapshotInstalled(c.env.DB);
  const calculatedAt = new Date().toISOString();
  let total = 0,
    seq = 0,
    changed = 0;
  const seen = new Set<string>();
  const receivedProducts = new Set<string>();
  for (const rawLine of raw) {
    const r = rawLine as Record<string, unknown>,
      line = d.lines.find((l) => l.line_id === r.line_id);
    if (!line || seen.has(line.line_id)) throw badRequest('Invalid or duplicate purchase line');
    seen.add(line.line_id);
    const selected = await requireSelection(c.env.DB, line.product_id!, line.scope, line.scope_id);
    const qty = whole(r.qty, 'المستلم', 0, 100000),
      rejected = whole(r.rejected_qty ?? 0, 'المرفوض', 0, 100000);
    const pendingOrigins = line.unit_origins.filter((unit) => !unit.received_lot_id && !unit.unavailable_reason);
    let originIds: string[] = [];
    if (line.unit_origins.length) {
      if (rejected) throw badRequest('استلم القطع السليمة المحددة فقط، واترك القطع الأخرى معلّقة حتى تسوية الشراء', 'TRACKED_REJECTION_REQUIRES_SELECTION');
      if (r.unit_origin_ids !== undefined && !Array.isArray(r.unit_origin_ids))
        throw badRequest('اختر معرّفات القطع المستلمة', 'INVALID_UNIT_ORIGINS');
      originIds = r.unit_origin_ids === undefined ? pendingOrigins.slice(0, qty).map((unit) => unit.id) : r.unit_origin_ids as string[];
      const pendingIds = new Set(pendingOrigins.map((unit) => unit.id));
      if (originIds.length !== qty || new Set(originIds).size !== qty || originIds.some((unitId) => typeof unitId !== 'string' || !pendingIds.has(unitId)))
        throw badRequest('القطع المحددة لا تطابق الكمية أو سبق استلامها', 'INVALID_UNIT_ORIGINS');
    } else if (Array.isArray(r.unit_origin_ids) && r.unit_origin_ids.length) {
      throw badRequest('هذا البند لا يحتوي سجلات قطع منفردة', 'INVALID_UNIT_ORIGINS');
    }
    if (qty > 0 && selected.stock === null) throw badRequest('فعّل تتبع مخزون النسخة قبل الاستلام');
    if (qty === 0 && rejected === 0) continue;
    if (qty > 0 && line.product_id) receivedProducts.add(line.product_id);
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
        snapshotOf: snapshots
          ? (cost) => purchaseLotSnapshot({ ...d.purchase, id } as PurchaseFxSource, line, { unitCostIqd: cost.unitCostIqd, purchaseUnitIqd: cost.purchaseUnitIqd }, calculatedAt)
          : null,
      });
      statements.push(...plan.statements);
      if (originIds.length) statements.push(...await planReceiveUnitOrigins(c.env.DB, {
        incomingId: line.id, lotId: lot, fromIndex: received + 1, qty: segment.qty,
        originIds: originIds.slice(received - line.qty_received, received - line.qty_received + segment.qty),
      }));
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
  statements.push(...(await arrivedBells(c, id, [...receivedProducts])));
  await commitPurchase(c.env.DB, d.purchase, statements);
  await audit(c.env.DB, user.id, 'purchase.received', id, { event_id: eventId });
  // The owner's own answer names the products whose review of this purchase waits (ids and states, never a figure).
  return c.json({ success: true, ...(isOwner(c.env, user) ? { price_reviews: await priceReviewsOf(c.env.DB, id) } : {}) });
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
  const cancelled = d.matching.received_qty <= 0;
  const now = new Date().toISOString();
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
      cancelled ? 'cancelled' : 'received',
      `\n${reason}`,
      now,
      id,
    ),
    // Row 249: a purchase closed with nothing received was never bought at that cost — its reviews go with it.
    // A close after a partial receipt keeps them: those units arrived at that cost.
    // A review this purchase had replaced (another purchase of the same levels, still bought) comes back.
    ...(cancelled && (await cleanStartInstalled(c.env.DB)) ? await cancelledPurchaseReviewStatements(c.env.DB, id, user.id, now) : []),
  ]);
  await audit(c.env.DB, user.id, 'purchase.remainder_closed', id, { reason });
  return c.json({ success: true });
});

adminProcurementRoutes.post('/documents/:id/investor-receipts',async c=>{
  const user=c.get('user')!;if(!isOwner(c.env,user))throw forbidden('تسجيل تمويل المستثمر للأدمن الرئيسي فقط');
  await requireCapability(c.env,user,'accounting');
  return c.json({success:true,...await receivePurchaseFunding(c.env.DB,c.req.param('id'),await bodyOf(c),user.id)});
});
