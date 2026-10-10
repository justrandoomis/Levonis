/**
 * A BATCH REMEMBERS THE EXCHANGE RATES OF ITS PURCHASE (FX programme plan
 * §4.3, §9 §16-§19; push FX-6; migration 0182). `inventory_lots` IS the batch.
 *
 * THE SNAPSHOT. When a purchase is received, each new lot records, in its own
 * INSERT and never again:
 *   - the supplier's own currency and amount per unit (the invoice decimal),
 *     the line's mode and, for a 'total' line, its original total;
 *   - the document's own rate (IQD per one unit of its currency);
 *   - the three rates in force at purchase — USD/IQD (U), EUR/USD (E),
 *     CNY/USD (C) — with each one's version and the moment the purchase took
 *     them. U is the document's own rate for a USD document (the rate actually
 *     paid, source 'document'); otherwise the central effective rate the
 *     purchase snapshotted when it was confirmed 'ordered' (FX-1, source
 *     'central'); otherwise unknown. E and C come from that purchase snapshot;
 *   - the supplier cost in USD at purchase (USD as is, EUR × E, CNY × C, an
 *     IQD price ÷ U floored to 6 places) and the historical USD equivalent of
 *     the landed cost (unit_cost_iqd ÷ U, floored to 6 places — an audit
 *     figure only).
 * The landed IQD the batch was booked at is the lot's existing
 * `unit_cost_iqd`, read through `effectiveLotCostSql` (an owner
 * reconciliation wins) — no duplicate column. Rates are read from the
 * purchase row the receipt already holds; this module never reads the
 * central rate tables, and nothing here converts at TODAY's rate.
 *
 * TWO COSTS, NEVER MIXED (§19). The batch cost (`batch_cost`: what this
 * batch actually cost, in IQD, fixed) and the engine's current replacement
 * cost (`pricing_*`) are different numbers on different screens. The profit
 * and FIFO paths read lot costs only; the engine reads no lot.
 *
 * OLD BATCHES ARE NEVER REWRITTEN (§18). A lot received before 0182 keeps
 * every snapshot column NULL — the database refuses NULL → value as it
 * refuses any change (`inventory_lot_snapshot_immutable`). The owner's read
 * model may DERIVE, without storing, a historical USD equivalent when the
 * purchase-time USD/IQD is known from the purchase itself (a USD document's
 * own rate, or a purchase ordered after FX-1 with its central snapshot),
 * labelled as derived; anything else is «غير معروف» / Unknown / «نەزانراو»,
 * and the batch shows «بالدينار فقط» / known only in IQD.
 *
 * DEPLOY-AHEAD. Every write asks `batchSnapshotInstalled` first: on a
 * database without 0182 the lot INSERT is byte-identical to today's.
 *
 * PRIVATE. Every figure here is the owner's (FINANCIAL_FIELDS, both copies);
 * the read model answers only behind the pricing router's owner door.
 */
import {
  floorToPlaces,
  mulProcurementExact,
  procurementExact,
  procurementExactText,
  quotientProcurementExact,
  type ProcurementExact,
} from '@levonis/contracts/procurementCost';
import { effectiveLotCostSql } from './inventoryLots';

export type SupplierCurrency = 'IQD' | 'USD' | 'EUR' | 'CNY';
const CURRENCIES: readonly SupplierCurrency[] = ['IQD', 'USD', 'EUR', 'CNY'];
const isCurrency = (v: unknown): v is SupplierCurrency => typeof v === 'string' && (CURRENCIES as readonly string[]).includes(v);

// ------------------------------------------------------------------ installed?

const PRESENT = new WeakMap<object, true>();

/**
 * Is migration 0182 on this database? Remembered per binding only when it is
 * (a migration never un-lands); a failure to ask is a "no", which keeps every
 * statement exactly as it was before FX-6.
 */
export async function batchSnapshotInstalled(db: D1Database): Promise<boolean> {
  if (PRESENT.has(db)) return true;
  try {
    const { results } = await db.prepare('PRAGMA table_info(inventory_lots)').all<{ name: string }>();
    const names = new Set((results ?? []).map((r) => String(r.name)));
    if (!names.has('snapshot_version') || !names.has('split_from_lot_id')) return false;
    PRESENT.set(db, true);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ decimals

/**
 * Canonical decimal text of a stored amount or rate: a decimal TEXT as is, a
 * REAL from an older column through its shortest round-trip digits (an
 * exponent spelled out). Null for a negative, a non-finite value, an
 * unreadable text or one longer than `maxLen`.
 */
export function decimalText(value: unknown, maxLen = 32): string | null {
  if (value === null || value === undefined || value === '') return null;
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);
    if (/e/i.test(text)) text = value.toFixed(20).replace(/\.?0+$/, '');
  } else if (typeof value === 'string') text = value.trim();
  else return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  try {
    const canonical = procurementExactText(procurementExact(text));
    return canonical.length <= maxLen ? canonical : null;
  } catch {
    return null;
  }
}

const positive = (value: unknown, maxLen = 32): string | null => {
  const t = decimalText(value, maxLen);
  return t !== null && /[1-9]/.test(t) ? t : null;
};

const version = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** The exact value, as text within `maxLen`, else floored to `places` (still null if too long). */
function fitted(x: ProcurementExact, maxLen: number, places: number): string | null {
  try {
    const exact = procurementExactText(x);
    if (exact.length <= maxLen) return exact;
  } catch {
    /* a non-terminating quotient: floor it below */
  }
  const floored = procurementExactText(floorToPlaces(x, places));
  return floored.length <= maxLen ? floored : null;
}

/** floor6(iqd ÷ rate): a dinar figure in dollars at a purchase-time rate (§17, §18). */
export function iqdAtRate(iqd: number | null | undefined, rate: string | null): string | null {
  if (iqd === null || iqd === undefined || rate === null || !Number.isSafeInteger(iqd) || iqd < 0) return null;
  try {
    return procurementExactText(floorToPlaces(quotientProcurementExact(procurementExact(iqd), procurementExact(rate)), 6));
  } catch {
    return null;
  }
}

/**
 * The supplier cost per unit in USD at purchase (§17): USD as is, EUR × E,
 * CNY × C, an IQD price ÷ U (floor 6). Null when a rate it needs is unknown.
 */
export function supplierCostUsd(
  currency: SupplierCurrency | null,
  amount: string | null,
  purchaseUnitIqd: number | null,
  u: string | null,
  e: string | null,
  c: string | null,
): string | null {
  try {
    if (currency === 'USD') return amount;
    if (currency === 'EUR') return amount !== null && e !== null ? fitted(mulProcurementExact(procurementExact(amount), procurementExact(e)), 48, 12) : null;
    if (currency === 'CNY') return amount !== null && c !== null ? fitted(mulProcurementExact(procurementExact(amount), procurementExact(c)), 48, 12) : null;
    if (currency === 'IQD') return iqdAtRate(purchaseUnitIqd, u);
  } catch {
    /* an unreadable figure is unknown */
  }
  return null;
}

// ------------------------------------------------------------------ the snapshot

export interface LotSnapshot {
  snapshot_source: 'purchase' | 'legacy_incoming';
  purchase_id: string | null;
  supplier_original_currency: SupplierCurrency | null;
  supplier_original_amount: string | null;
  supplier_cost_mode: 'unit' | 'total' | null;
  supplier_line_total_original: string | null;
  exchange_rate_at_purchase: string | null;
  supplier_cost_usd_at_purchase: string | null;
  usd_iqd_rate_at_purchase: string | null;
  eur_usd_rate_at_purchase: string | null;
  cny_usd_rate_at_purchase: string | null;
  usd_iqd_fx_version: number | null;
  eur_usd_fx_version: number | null;
  cny_usd_fx_version: number | null;
  fx_snapshot_at: string | null;
  fx_snapshot_source: 'document' | 'central' | null;
  historical_usd_equivalent: string | null;
  calculated_at: string;
}

/** The snapshot columns, in the order every INSERT names them (snapshot_version is written as 1 before them). */
export const LOT_SNAPSHOT_COLUMNS = [
  'snapshot_source',
  'purchase_id',
  'supplier_original_currency',
  'supplier_original_amount',
  'supplier_cost_mode',
  'supplier_line_total_original',
  'exchange_rate_at_purchase',
  'supplier_cost_usd_at_purchase',
  'usd_iqd_rate_at_purchase',
  'eur_usd_rate_at_purchase',
  'cny_usd_rate_at_purchase',
  'usd_iqd_fx_version',
  'eur_usd_fx_version',
  'cny_usd_fx_version',
  'fx_snapshot_at',
  'fx_snapshot_source',
  'historical_usd_equivalent',
  'calculated_at',
] as const satisfies readonly (keyof LotSnapshot)[];

/** Every column 0182 adds to inventory_lots — the transfer-split copy and the owner's read model name them all. */
export const LOT_SNAPSHOT_ALL_COLUMNS = ['snapshot_version', ...LOT_SNAPSHOT_COLUMNS, 'split_from_lot_id'] as const;

/**
 * THE LOT COLUMNS BEFORE 0182, by name. The two lot reads open to assistant
 * admins (GET /api/admin/inventory/lots, POST /api/admin/stock-operations/scan)
 * select exactly these, so no snapshot column — private or merely generic —
 * can reach them through a `SELECT l.*` (critique F14a).
 */
export const PRE_SNAPSHOT_LOT_COLUMNS = [
  'id', 'product_id', 'scope', 'scope_id', 'qty_received', 'qty_remaining', 'unit_cost_iqd', 'purchase_unit_iqd',
  'shipping_share_iqd', 'internal_share_iqd', 'total_cost_iqd', 'cost_basis', 'incoming_id', 'supplier_id',
  'purchase_date', 'received_at', 'created_by', 'created_at',
] as const;

/** `l.id, l.product_id, …` — the pre-0182 lot columns under an alias. */
export const preSnapshotLotSelect = (alias = 'l') => PRE_SNAPSHOT_LOT_COLUMNS.map((c) => `${alias}.${c}`).join(', ');

/** The purchase row a receipt already holds (`SELECT p.* FROM purchase_orders`); FX columns absent before 0179/0182 read as unknown. */
export interface PurchaseFxSource {
  id: string;
  currency: unknown;
  exchange_rate: unknown;
  fx_usd_iqd_at_purchase?: unknown;
  fx_eur_usd_at_purchase?: unknown;
  fx_cny_usd_at_purchase?: unknown;
  fx_snapshot_at?: unknown;
  fx_usd_iqd_version_at_purchase?: unknown;
  fx_eur_usd_version_at_purchase?: unknown;
  fx_cny_usd_version_at_purchase?: unknown;
}

/** The purchase line being received (purchase_lines joined to incoming_inventory). */
export interface PurchaseLineSource {
  qty_ordered: number;
  source_unit_amount: unknown;
  source_total_amount?: unknown;
  purchase_cost_mode?: unknown;
}

/** The lot's own IQD figures at this receipt (`lotCostBreakdown`). */
export interface LotIqd {
  unitCostIqd: number | null;
  purchaseUnitIqd: number | null;
}

/** The snapshot of a lot received from a purchase document (POST /procurement/documents/:id/receive). */
export function purchaseLotSnapshot(purchase: PurchaseFxSource, line: PurchaseLineSource, cost: LotIqd, now: string): LotSnapshot {
  const currency = isCurrency(purchase.currency) ? purchase.currency : null;
  const mode: 'unit' | 'total' = line.purchase_cost_mode === 'total' ? 'total' : 'unit';
  const lineTotal = mode === 'total' ? decimalText(line.source_total_amount, 40) : null;
  let amount: string | null = null;
  if (mode === 'total') {
    if (lineTotal !== null && Number.isSafeInteger(line.qty_ordered) && line.qty_ordered > 0)
      amount = fitted(quotientProcurementExact(procurementExact(lineTotal), procurementExact(line.qty_ordered)), 40, 12);
  } else amount = decimalText(line.source_unit_amount, 40);
  const documentRate = positive(purchase.exchange_rate);
  const central = positive(purchase.fx_usd_iqd_at_purchase);
  const fromDocument = currency === 'USD' && documentRate !== null;
  const u = fromDocument ? documentRate : central;
  const e = positive(purchase.fx_eur_usd_at_purchase);
  const c = positive(purchase.fx_cny_usd_at_purchase);
  const at = typeof purchase.fx_snapshot_at === 'string' && purchase.fx_snapshot_at ? purchase.fx_snapshot_at.slice(0, 40) : null;
  return {
    snapshot_source: 'purchase',
    purchase_id: purchase.id,
    supplier_original_currency: currency,
    supplier_original_amount: amount,
    supplier_cost_mode: mode,
    supplier_line_total_original: lineTotal,
    exchange_rate_at_purchase: documentRate,
    supplier_cost_usd_at_purchase: supplierCostUsd(currency, amount, cost.purchaseUnitIqd, u, e, c),
    usd_iqd_rate_at_purchase: u,
    eur_usd_rate_at_purchase: e,
    cny_usd_rate_at_purchase: c,
    usd_iqd_fx_version: fromDocument || u === null ? null : version(purchase.fx_usd_iqd_version_at_purchase),
    eur_usd_fx_version: e === null ? null : version(purchase.fx_eur_usd_version_at_purchase),
    cny_usd_fx_version: c === null ? null : version(purchase.fx_cny_usd_version_at_purchase),
    fx_snapshot_at: at,
    fx_snapshot_source: u === null ? null : fromDocument ? 'document' : 'central',
    historical_usd_equivalent: iqdAtRate(cost.unitCostIqd, u),
    calculated_at: now,
  };
}

/** A bare incoming record (no purchase document): its own currency, amount and rate; no central snapshot exists for it. */
export interface IncomingFxSource {
  source_currency?: unknown;
  source_unit_amount?: unknown;
  exchange_rate_used?: unknown;
}

/** The snapshot of a lot received from a bare incoming record (POST /inventory/incoming/:id/receive). */
export function legacyIncomingLotSnapshot(row: IncomingFxSource, cost: LotIqd, now: string): LotSnapshot {
  const currency = isCurrency(row.source_currency) ? row.source_currency : null;
  const amount = decimalText(row.source_unit_amount, 40);
  const rate = positive(row.exchange_rate_used);
  const u = currency === 'USD' ? rate : null;
  return {
    snapshot_source: 'legacy_incoming',
    purchase_id: null,
    supplier_original_currency: currency,
    supplier_original_amount: amount,
    supplier_cost_mode: null,
    supplier_line_total_original: null,
    exchange_rate_at_purchase: rate,
    supplier_cost_usd_at_purchase: supplierCostUsd(currency, amount, cost.purchaseUnitIqd, u, null, null),
    usd_iqd_rate_at_purchase: u,
    eur_usd_rate_at_purchase: null,
    cny_usd_rate_at_purchase: null,
    usd_iqd_fx_version: null,
    eur_usd_fx_version: null,
    cny_usd_fx_version: null,
    fx_snapshot_at: null,
    fx_snapshot_source: u === null ? null : 'document',
    historical_usd_equivalent: iqdAtRate(cost.unitCostIqd, u),
    calculated_at: now,
  };
}

/**
 * The INSERT pieces a snapshot adds to a lot's own INSERT: the column names
 * (snapshot_version first, written as the literal 1), their numbered
 * placeholders from `firstParam`, and the values in the same order.
 */
export function snapshotInsertParts(s: LotSnapshot, firstParam: number): { columns: string; placeholders: string; values: unknown[] } {
  return {
    columns: ['snapshot_version', ...LOT_SNAPSHOT_COLUMNS].join(', '),
    placeholders: ['1', ...LOT_SNAPSHOT_COLUMNS.map((_, i) => `?${firstParam + i}`)].join(', '),
    values: LOT_SNAPSHOT_COLUMNS.map((k) => s[k]),
  };
}

/**
 * A transfer split's child lot (adminStockOperations): the same cost columns
 * the split always wrote, plus its parent's snapshot copied verbatim in the
 * same statement and the parent's id — so a moved part of a batch keeps the
 * batch's purchase-time rates. An old parent's NULLs copy as NULLs.
 * Bind: target, product_id, scope, scope_id, qty, qty, unit_cost_iqd,
 * purchase_unit_iqd, total_cost_iqd, cost_basis, received_at, created_by,
 * incoming_id, supplier_id, purchase_date, parent id (split_from_lot_id), parent id (the source row).
 */
export const SPLIT_CHILD_INSERT_SQL =
  `INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at,created_by,incoming_id,supplier_id,purchase_date,` +
  `${['snapshot_version', ...LOT_SNAPSHOT_COLUMNS].join(',')},split_from_lot_id) ` +
  `SELECT ?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,${['snapshot_version', ...LOT_SNAPSHOT_COLUMNS].map((c) => `p.${c}`).join(',')},? FROM inventory_lots p WHERE p.id=?`;

// ------------------------------------------------------------------ the owner's read model

export type BatchFilter = { product_id: string } | { lot_id: string } | { purchase_id: string };
export type SnapshotState = 'recorded' | 'derived' | 'iqd_only';

/** The §17 FX figures a batch either knows or shows as «غير معروف». */
const FX_FIELDS = [
  'supplier_cost_usd_at_purchase',
  'usd_iqd_rate_at_purchase',
  'eur_usd_rate_at_purchase',
  'cny_usd_rate_at_purchase',
  'historical_usd_equivalent',
] as const;

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export interface BatchDto {
  id: string;
  product_id: string | null;
  scope: string;
  scope_id: string;
  qty_received: number;
  qty_remaining: number;
  received_at: string;
  purchase_date: string | null;
  incoming_id: string | null;
  purchase_id: string | null;
  cost_basis: string;
  batch_cost: {
    unit_cost_iqd: number | null;
    actual_landed_cost_iqd: number | null;
    actual_landed_total_iqd: number | null;
    purchase_unit_iqd: number | null;
    shipping_share_iqd: number | null;
    internal_share_iqd: number | null;
    total_cost_iqd: number | null;
  };
  snapshot_state: SnapshotState;
  snapshot: (Omit<LotSnapshot, 'calculated_at'> & { snapshot_version: 1; calculated_at: string | null; split_from_lot_id: string | null }) | null;
  derived: { usd_iqd_rate: string; historical_usd_equivalent: string | null; derived_from: 'purchase_document' | 'purchase_snapshot' } | null;
  unknown_fields: string[];
}

/**
 * One batch for the owner: its fixed IQD cost and, apart, its purchase-time
 * snapshot — recorded (an FX-6 lot), derived from its own purchase and
 * labelled so (an older lot whose purchase-time USD/IQD is known from the
 * purchase), or known only in IQD. Field by field; nothing else of the row.
 */
export function batchDto(r: Row): BatchDto {
  const unitCost = num(r.unit_cost_iqd);
  const effective = num(r.effective_unit_cost_iqd);
  const qtyReceived = num(r.qty_received) ?? 0;
  const recorded = num(r.snapshot_version) === 1;
  let derived: BatchDto['derived'] = null;
  if (!recorded) {
    const docUsd = (r.doc_currency === 'USD' && positive(r.doc_exchange_rate)) || (r.inc_currency === 'USD' && positive(r.inc_exchange_rate)) || null;
    const central = positive(r.doc_fx_usd_iqd);
    if (docUsd) derived = { usd_iqd_rate: docUsd, historical_usd_equivalent: iqdAtRate(unitCost, docUsd), derived_from: 'purchase_document' };
    else if (central) derived = { usd_iqd_rate: central, historical_usd_equivalent: iqdAtRate(unitCost, central), derived_from: 'purchase_snapshot' };
  }
  const snapshot: BatchDto['snapshot'] = recorded
    ? {
        snapshot_version: 1,
        snapshot_source: r.snapshot_source === 'legacy_incoming' ? 'legacy_incoming' : 'purchase',
        purchase_id: str(r.purchase_id),
        supplier_original_currency: isCurrency(r.supplier_original_currency) ? r.supplier_original_currency : null,
        supplier_original_amount: str(r.supplier_original_amount),
        supplier_cost_mode: r.supplier_cost_mode === 'total' ? 'total' : r.supplier_cost_mode === 'unit' ? 'unit' : null,
        supplier_line_total_original: str(r.supplier_line_total_original),
        exchange_rate_at_purchase: str(r.exchange_rate_at_purchase),
        supplier_cost_usd_at_purchase: str(r.supplier_cost_usd_at_purchase),
        usd_iqd_rate_at_purchase: str(r.usd_iqd_rate_at_purchase),
        eur_usd_rate_at_purchase: str(r.eur_usd_rate_at_purchase),
        cny_usd_rate_at_purchase: str(r.cny_usd_rate_at_purchase),
        usd_iqd_fx_version: version(r.usd_iqd_fx_version),
        eur_usd_fx_version: version(r.eur_usd_fx_version),
        cny_usd_fx_version: version(r.cny_usd_fx_version),
        fx_snapshot_at: str(r.fx_snapshot_at),
        fx_snapshot_source: r.fx_snapshot_source === 'document' ? 'document' : r.fx_snapshot_source === 'central' ? 'central' : null,
        historical_usd_equivalent: str(r.historical_usd_equivalent),
        calculated_at: str(r.calculated_at),
        split_from_lot_id: str(r.split_from_lot_id),
      }
    : null;
  // UNKNOWN is a null plus its name here: the screen says «غير معروف» for each, never 0.
  const unknown = recorded
    ? FX_FIELDS.filter((k) => snapshot![k] === null)
    : FX_FIELDS.filter((k) => !(derived && (k === 'usd_iqd_rate_at_purchase' || (k === 'historical_usd_equivalent' && derived.historical_usd_equivalent !== null))));
  return {
    id: String(r.id),
    product_id: str(r.product_id),
    scope: String(r.scope ?? 'base'),
    scope_id: String(r.scope_id ?? ''),
    qty_received: qtyReceived,
    qty_remaining: num(r.qty_remaining) ?? 0,
    received_at: String(r.received_at ?? ''),
    purchase_date: str(r.purchase_date),
    incoming_id: str(r.incoming_id),
    purchase_id: (recorded ? snapshot!.purchase_id : null) ?? str(r.doc_purchase_id),
    cost_basis: String(r.cost_basis ?? ''),
    batch_cost: {
      unit_cost_iqd: unitCost,
      actual_landed_cost_iqd: effective,
      actual_landed_total_iqd: effective === null ? null : effective * qtyReceived,
      purchase_unit_iqd: num(r.purchase_unit_iqd),
      shipping_share_iqd: num(r.shipping_share_iqd),
      internal_share_iqd: num(r.internal_share_iqd),
      total_cost_iqd: num(r.total_cost_iqd),
    },
    snapshot_state: recorded ? 'recorded' : derived ? 'derived' : 'iqd_only',
    snapshot,
    derived,
    unknown_fields: unknown,
  };
}

/** At most this many batches per answer (a product's whole history fits; the list is the owner's, not a feed). */
export const BATCH_PAGE = 200;

/**
 * The owner's batches for one product, one lot or one purchase document —
 * ONE read (plus the installed probe and the cost-version probe), oldest
 * first. Without 0182 the snapshot columns are not named and every batch is
 * derived or known only in IQD.
 */
export async function loadBatches(db: D1Database, filter: BatchFilter): Promise<{ installed: boolean; batches: BatchDto[] }> {
  const installed = await batchSnapshotInstalled(db);
  const cost = await effectiveLotCostSql(db, 'l');
  const snapshotCols = installed ? LOT_SNAPSHOT_ALL_COLUMNS.map((c) => `l.${c}`).join(', ') : `NULL AS snapshot_version`;
  const where = 'product_id' in filter ? 'l.product_id = ?' : 'lot_id' in filter ? 'l.id = ?' : installed ? '(l.purchase_id = ? OR pl.purchase_id = ?)' : 'pl.purchase_id = ?';
  const args = 'product_id' in filter ? [filter.product_id] : 'lot_id' in filter ? [filter.lot_id] : installed ? [filter.purchase_id, filter.purchase_id] : [filter.purchase_id];
  const { results } = await db
    .prepare(
      `SELECT ${preSnapshotLotSelect('l')}, ${cost} AS effective_unit_cost_iqd, ${snapshotCols},
              pl.purchase_id AS doc_purchase_id, po.currency AS doc_currency, po.exchange_rate AS doc_exchange_rate,
              ${installed ? 'po.fx_usd_iqd_at_purchase' : 'NULL'} AS doc_fx_usd_iqd,
              i.source_currency AS inc_currency, i.exchange_rate_used AS inc_exchange_rate
         FROM inventory_lots l
         LEFT JOIN incoming_inventory i ON i.id = l.incoming_id
         LEFT JOIN purchase_lines pl ON pl.incoming_id = l.incoming_id
         LEFT JOIN purchase_orders po ON po.id = pl.purchase_id
        WHERE ${where}
        ORDER BY l.received_at ASC, l.id ASC
        LIMIT ${BATCH_PAGE}`,
    )
    .bind(...args)
    .all<Row>();
  return { installed, batches: (results ?? []).map(batchDto) };
}

// ------------------------------------------------------------------ the profit page's USD view

/**
 * The purchase-time USD/IQD of each lot that RECORDED one (0182 snapshot) —
 * the profit page's USD view converts a line's cost of goods at its batches'
 * own rates where every batch of the line has one, and at the order's rate
 * otherwise (worker/routes/adminFinanceWorkspace.ts). Derived rates are not
 * used there: only what the batch itself recorded. Empty without 0182, or on
 * any read error (the page then converts exactly as before).
 */
export async function loadLotUsdRates(db: D1Database, lotIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(lotIds.filter((id) => typeof id === 'string' && id))];
  if (!ids.length || !(await batchSnapshotInstalled(db))) return out;
  try {
    for (let i = 0; i < ids.length; i += 400) {
      const { results } = await db
        .prepare('SELECT id, usd_iqd_rate_at_purchase AS rate FROM inventory_lots WHERE id IN (SELECT value FROM json_each(?)) AND usd_iqd_rate_at_purchase IS NOT NULL')
        .bind(JSON.stringify(ids.slice(i, i + 400)))
        .all<{ id: string; rate: unknown }>();
      for (const r of results ?? []) {
        const rate = positive(r.rate);
        if (rate) out.set(String(r.id), rate);
      }
    }
  } catch {
    return new Map();
  }
  return out;
}
