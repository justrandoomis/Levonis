/**
 * READ MODELS (docs/PRINT_CLOUD.md §10): the customer dashboard's data and
 * the administration's reports. No UI is built here — every section of the
 * future dashboard has an API that answers its data.
 *
 * FINANCE, kept apart on purpose:
 *   cash collected      what was paid (by category of what was bought);
 *   deferred            what customers still hold, valued at what they paid —
 *                       unconsumed hours and unused material are a liability,
 *                       not revenue, until they are used;
 *   recognised          what was used (consumed seconds and grams at their
 *                       purchase value, delivery fees once paid);
 *   refunds, buybacks   recorded obligations. A refund of unused hours or
 *                       grams gives back deferred value, never revenue: it
 *                       moves profit only by what it paid beyond (or kept
 *                       of) that value; a refunded delivery fee was revenue;
 *   costs (owner only)  material cost of what left the shelf, waste, the
 *                       electricity, maintenance reserve and depreciation of
 *                       printed hours — and the gross and net profit they leave.
 *                       Units drawn from a lot whose cost is still pending are
 *                       reported as such, never costed as a known zero.
 */
import { many, one } from './db';
import { creditBalances } from './credits';
import { inventoryBalances } from './inventory';
import { drawValue } from './lots';
import { hoursMinutes, mulDivRound, parseJson } from './util';

export async function dashboardCredits(db: D1Database, userId: string) {
  const balances = await creditBalances(db, userId);
  const purchases = await many<Record<string, unknown>>(
    db,
    `SELECT l.id, l.tier_id, l.source, l.seconds_total, l.seconds_remaining, l.seconds_held, l.paid_iqd, l.expires_at, l.created_at, l.order_line_id
       FROM pc_credit_lots l WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 100`,
    userId
  );
  return {
    tiers: balances.map((b) => ({
      tier_id: b.tier_id,
      code: b.code,
      name: { ar: b.name_ar, en: b.name_en, ckb: b.name_ckb },
      available_seconds: b.available_seconds,
      reserved_seconds: b.reserved_seconds,
      consumed_seconds: b.consumed_seconds,
      available: hoursMinutes(b.available_seconds),
      reserved: hoursMinutes(b.reserved_seconds),
      consumed: hoursMinutes(b.consumed_seconds),
    })),
    purchases,
  };
}

/**
 * «My printers»: the printer models the customer holds credit for — not
 * machines they own. `ready`: the test of a machine that can take work now,
 * over `pc_printers p` (printers.ts `machineReadySql`) — what «idle» counts.
 */
export async function dashboardPrinters(db: D1Database, userId: string, ready: { sql: string; params: unknown[] }) {
  return many<Record<string, unknown>>(
    db,
    `SELECT m.id AS printer_model_id, m.code, m.brand, m.model_name, a.available_seconds, a.reserved_seconds,
            (SELECT COUNT(*) FROM pc_printers p WHERE p.model_id = m.id AND p.status = 'active') AS compatible_machines,
            (SELECT COUNT(*) FROM pc_printers p WHERE p.model_id = m.id AND ${ready.sql}) AS idle_machines
       FROM pc_credit_accounts a JOIN pc_printer_models m ON m.tier_id = a.tier_id AND m.active = 1
      WHERE a.user_id = ? AND (a.available_seconds > 0 OR a.reserved_seconds > 0)
      ORDER BY m.brand, m.model_name`,
    ...ready.params,
    userId
  );
}

export async function dashboardInventory(db: D1Database, userId: string, category: string | null) {
  const rows = await inventoryBalances(db, userId, category);
  return rows.map((r) => ({ ...r, name: { ar: r.name_ar, en: r.name_en, ckb: r.name_ckb } }));
}

export async function dashboardJobs(db: D1Database, userId: string) {
  const rows = await many<{ id: string; title: string; status: string; printer_model_id: string; created_at: string; updated_at: string }>(
    db,
    'SELECT id, title, status, printer_model_id, created_at, updated_at FROM pc_print_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 500',
    userId
  );
  const group = (statuses: string[]) => rows.filter((r) => statuses.includes(r.status));
  return {
    current: group(['preparing', 'printing', 'paused']),
    queued: group(['confirmed', 'queued']),
    in_preparation: group(['draft', 'uploaded', 'analyzing', 'ready', 'awaiting_confirmation']),
    completed: group(['completed']),
    failed: group(['failed', 'reprint_requested']),
    cancelled: group(['cancelled']),
  };
}

export async function dashboardFiles(db: D1Database, userId: string) {
  const files = await many<Record<string, unknown>>(
    db,
    `SELECT id, original_name, extension, size_bytes, status, rejection_code, source, size_x_um, size_y_um, size_z_um, created_at
       FROM pc_model_files WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
    userId
  );
  const imports = await many<Record<string, unknown>>(
    db,
    'SELECT id, url, provider, status, error_code, file_id, license, attribution, created_at FROM pc_model_imports WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
    userId
  );
  const projects = await many<Record<string, unknown>>(
    db,
    'SELECT id, name, project_type, status, updated_at FROM pc_projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200',
    userId
  );
  const profiles = await many<Record<string, unknown>>(db, 'SELECT id, name, settings_json, updated_at FROM pc_print_profiles WHERE user_id = ? ORDER BY name', userId);
  return { files, imports, projects, profiles: profiles.map((p) => ({ ...p, settings: parseJson(String(p.settings_json), {}), settings_json: undefined })) };
}

/** Where a page of `transactions` stopped: the last row's time, ledger and id. */
interface TxCursor {
  at: string;
  ledger: string;
  id: string;
}

/**
 * `before` as the client sent it: the `next_before` of the previous page
 * («time~ledger~id»), or a bare timestamp — the cursor's old form — which
 * keeps meaning «strictly before»: an empty ledger name sorts before them all.
 */
function txCursor(before: string | null): TxCursor {
  if (!before) return { at: '9999-12-31T00:00:00.000Z', ledger: '', id: '' };
  const [at, ledger = '', id = ''] = before.split('~');
  return { at, ledger, id };
}

/** Byte order, as SQLite compares TEXT: the merge agrees with every source's ORDER BY. */
const byBytes = (a: unknown, b: unknown): number => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/**
 * Every movement of the customer's value, newest first: purchases, printing
 * usage, material usage, refunds, buybacks, deliveries — one list, with the
 * kind of each row.
 *
 * PAGED ON A STRICT ORDER — (created_at, ledger, id), all descending — never
 * on time alone: one batch writes several rows at one instant (a payment's
 * credit and material purchases, a settlement's consume and release rows), so
 * a page ending inside such an instant must name the row it ended on, or the
 * rest of that instant is skipped by every later page. `next_before` is that
 * row («time~ledger~id»); each source reads only its rows after it in that
 * order, so pages are exact however many rows share an instant.
 */
export async function transactions(db: D1Database, userId: string, before: string | null, limit = 50) {
  const cur = txCursor(before);
  const source = (ledger: string, select: string, from: string, at: string, id: string) => {
    // This source's rows after the cursor: its ledger name is a constant, so
    // the (time, ledger, id) comparison reduces to one of three predicates.
    const cut =
      ledger < cur.ledger
        ? { sql: `${at} <= ?`, params: [cur.at] }
        : ledger > cur.ledger
          ? { sql: `${at} < ?`, params: [cur.at] }
          : { sql: `(${at} < ? OR (${at} = ? AND ${id} < ?))`, params: [cur.at, cur.at, cur.id] };
    return many<Record<string, unknown>>(
      db,
      `SELECT '${ledger}' AS ledger, ${select}, ${id} AS id, ${at} AS created_at
         FROM ${from} AND ${cut.sql} ORDER BY ${at} DESC, ${id} DESC LIMIT ?`,
      userId,
      ...cut.params,
      limit
    );
  };
  const sources = await Promise.all([
    source(
      'credits',
      'entry_type, tier_id AS subject_id, delta_available, delta_reserved, delta_consumed, value_iqd, job_id AS ref_id',
      'pc_credit_ledger WHERE user_id = ?',
      'created_at',
      'id'
    ),
    source(
      'inventory',
      'entry_type, variant_id AS subject_id, delta_available, delta_reserved, delta_consumed, value_iqd, ref_id',
      'pc_inventory_ledger WHERE user_id = ?',
      'created_at',
      'id'
    ),
    source(
      'orders',
      "'order_' || status AS entry_type, id AS subject_id, 0 AS delta_available, 0 AS delta_reserved, 0 AS delta_consumed, total_iqd AS value_iqd, id AS ref_id",
      'pc_orders WHERE user_id = ?',
      'created_at',
      'id'
    ),
    source(
      'refunds',
      "'refund' AS entry_type, r.order_line_id AS subject_id, 0 AS delta_available, 0 AS delta_reserved, 0 AS delta_consumed, r.amount_iqd AS value_iqd, r.order_id AS ref_id",
      'pc_refunds r JOIN pc_orders o ON o.id = r.order_id WHERE o.user_id = ?',
      'r.created_at',
      'r.id'
    ),
    source(
      'buybacks',
      "'buyback_' || status AS entry_type, variant_id AS subject_id, 0 AS delta_available, 0 AS delta_reserved, qty AS delta_consumed, COALESCE(final_value_iqd, estimated_value_iqd) AS value_iqd, id AS ref_id",
      'pc_buyback_requests WHERE user_id = ?',
      'created_at',
      'id'
    ),
    source(
      'shipments',
      "'shipment_' || status AS entry_type, kind AS subject_id, 0 AS delta_available, 0 AS delta_reserved, 0 AS delta_consumed, fee_iqd AS value_iqd, id AS ref_id",
      'pc_shipments WHERE user_id = ?',
      'created_at',
      'id'
    ),
  ]);
  const all = sources
    .flat()
    .sort((a, b) => byBytes(b.created_at, a.created_at) || byBytes(b.ledger, a.ledger) || byBytes(b.id, a.id))
    .slice(0, limit);
  const last = all[all.length - 1];
  return { items: all, next_before: all.length === limit ? `${String(last.created_at)}~${String(last.ledger)}~${String(last.id)}` : null };
}

// ------------------------------------------------------------------ administration

export interface Range {
  from: string;
  to: string;
}

/** MONEY (no cost): cash, deferred, recognised, refunds, buybacks. */
export async function revenueReport(db: D1Database, r: Range) {
  const cash = await many<{ kind: string; amount: number }>(
    db,
    `SELECT l.kind, COALESCE(SUM(l.final_price_iqd), 0) AS amount FROM pc_order_lines l JOIN pc_orders o ON o.id = l.order_id
      WHERE o.paid_at >= ? AND o.paid_at < ? AND o.paid_iqd > 0 GROUP BY l.kind`,
    r.from,
    r.to
  );
  const recognisedCredits = await one<{ v: number }>(
    db,
    "SELECT COALESCE(SUM(value_iqd), 0) AS v FROM pc_credit_ledger WHERE entry_type = 'consume' AND created_at >= ? AND created_at < ?",
    r.from,
    r.to
  );
  const recognisedMaterial = await many<{ category: string; v: number }>(
    db,
    `SELECT p.category_code AS category, COALESCE(SUM(l.value_iqd), 0) AS v FROM pc_inventory_ledger l
       JOIN pc_variants v ON v.id = l.variant_id JOIN pc_products p ON p.id = v.product_id
      WHERE l.entry_type IN ('consume', 'deliver') AND l.created_at >= ? AND l.created_at < ? GROUP BY p.category_code`,
    r.from,
    r.to
  );
  const refunds = await one<{ v: number }>(db, 'SELECT COALESCE(SUM(amount_iqd), 0) AS v FROM pc_refunds WHERE created_at >= ? AND created_at < ?', r.from, r.to);
  // What those refunds gave back of unused, prepaid value: the value of the
  // lot draws each one wrote ('refund:<id>' in the credit or material ledger).
  // Deferred value, never recognised; a refunded delivery fee draws none.
  const refundsUnused = await one<{ v: number }>(
    db,
    `SELECT COALESCE(SUM((SELECT COALESCE(SUM(c.value_iqd), 0) FROM pc_credit_ledger c WHERE c.entry_key = 'refund:' || f.id)
                       + (SELECT COALESCE(SUM(i.value_iqd), 0) FROM pc_inventory_ledger i WHERE i.entry_key = 'refund:' || f.id)), 0) AS v
       FROM pc_refunds f WHERE f.created_at >= ? AND f.created_at < ?`,
    r.from,
    r.to
  );
  const buybacks = await one<{ v: number; paid: number }>(
    db,
    "SELECT COALESCE(SUM(final_value_iqd), 0) AS v, COALESCE(SUM(CASE WHEN payout_status = 'paid' THEN final_value_iqd ELSE 0 END), 0) AS paid FROM pc_buyback_requests WHERE status = 'approved' AND decided_at >= ? AND decided_at < ?",
    r.from,
    r.to
  );
  const deferredCredits = await one<{ v: number }>(
    db,
    'SELECT COALESCE(SUM((paid_iqd * seconds_remaining + seconds_total / 2) / seconds_total), 0) AS v FROM pc_credit_lots WHERE seconds_remaining > 0'
  );
  const deferredMaterial = await one<{ v: number }>(
    db,
    'SELECT COALESCE(SUM((paid_iqd * qty_remaining + qty_total / 2) / qty_total), 0) AS v FROM pc_inventory_lots WHERE qty_remaining > 0'
  );
  const byKind = Object.fromEntries(cash.map((c) => [c.kind, Number(c.amount)]));
  const recognisedFees = Number(byKind.shipping_fee ?? 0);
  const materialRecognised = recognisedMaterial.reduce((s, x) => s + Number(x.v), 0);
  return {
    range: r,
    cash_collected: {
      printing_hours: Number(byKind.credit_package ?? 0) + Number(byKind.credit_hours ?? 0),
      materials: Number(byKind.material ?? 0),
      delivery_fees: recognisedFees,
      total: Object.values(byKind).reduce((s, v) => s + v, 0),
    },
    recognised_revenue: {
      printing_hours: Number(recognisedCredits?.v ?? 0),
      materials_by_category: Object.fromEntries(recognisedMaterial.map((x) => [x.category, Number(x.v)])),
      materials: materialRecognised,
      delivery_fees: recognisedFees,
      total: Number(recognisedCredits?.v ?? 0) + materialRecognised + recognisedFees,
    },
    deferred_liability_now: { printing_hours: Number(deferredCredits?.v ?? 0), materials: Number(deferredMaterial?.v ?? 0) },
    refunds_recorded: Number(refunds?.v ?? 0),
    refunds_of_unused_value: Number(refundsUnused?.v ?? 0),
    buybacks: { approved_value: Number(buybacks?.v ?? 0), paid_out: Number(buybacks?.paid ?? 0) },
    note:
      'Cash collected is not revenue: prepaid hours and customer-owned material are recognised when used. ' +
      'refunds_of_unused_value is the part of refunds_recorded that gave back that prepaid value, never recognised.',
  };
}

/** The warehouse movements that take stock off the shelf at a cost (warehouse.ts `removePhysical`). */
const MATERIAL_COST_TYPES = ['consume_customer', 'consume_workshop', 'waste', 'damage', 'ship_out', 'adjust_down'];

/**
 * Units that left the shelf from a lot whose cost was not stated then (their
 * draws carry cost_known = 0 and no cost; the ledger row records none for
 * them). Once the owner has stated the lot's cost they are valued from it,
 * cumulatively over the lot's pending draws exactly as lots.ts values every
 * draw — the pending draws are the first units the lot gave, the draws after
 * the statement were valued as they happened — and counted in the period they
 * left. While the cost is still pending they are listed, never costed at 0.
 */
async function pendingCostDraws(db: D1Database, r: Range) {
  const draws = await many<{ lot_id: string; variant_id: string; qty: number; received_qty: number; total_cost_iqd: number; lot_known: number; entry_type: string; at: string }>(
    db,
    `SELECT d.lot_id, l.variant_id, d.qty, l.received_qty, l.total_cost_iqd, l.cost_known AS lot_known, w.entry_type, w.created_at AS at
       FROM pc_stock_lot_draws d JOIN pc_stock_lots l ON l.id = d.lot_id JOIN pc_warehouse_ledger w ON w.entry_key = d.ledger_entry_key
      WHERE d.cost_known = 0
        AND d.lot_id IN (SELECT p.lot_id FROM pc_stock_lot_draws p JOIN pc_warehouse_ledger x ON x.entry_key = p.ledger_entry_key
                          WHERE p.cost_known = 0 AND x.created_at >= ? AND x.created_at < ?)
      ORDER BY d.lot_id, d.created_at, d.id`,
    r.from,
    r.to
  );
  const statedLater: Record<string, number> = {};
  const pending = new Map<string, { variant_id: string; entry_type: string; qty: number }>();
  let lotId = '';
  let drawn = 0;
  for (const d of draws) {
    if (d.lot_id !== lotId) [lotId, drawn] = [d.lot_id, 0];
    const qty = Number(d.qty);
    const total = Number(d.received_qty);
    const value = Number(d.lot_known) === 1 ? drawValue({ id: d.lot_id, total, remaining: total - drawn, value: Number(d.total_cost_iqd) }, qty) : 0;
    drawn += qty;
    if (d.at < r.from || d.at >= r.to || !MATERIAL_COST_TYPES.includes(d.entry_type)) continue;
    if (Number(d.lot_known) === 1) {
      statedLater[d.entry_type] = (statedLater[d.entry_type] ?? 0) + value;
      continue;
    }
    const key = `${d.variant_id}|${d.entry_type}`;
    const p = pending.get(key) ?? { variant_id: d.variant_id, entry_type: d.entry_type, qty: 0 };
    p.qty += qty;
    pending.set(key, p);
  }
  return { statedLater, pending: [...pending.values()].sort((a, b) => byBytes(a.variant_id, b.variant_id) || byBytes(a.entry_type, b.entry_type)) };
}

/** COST (owner only): production costs, waste, the printers' running costs, gross and net profit. */
export async function profitReport(db: D1Database, r: Range, electricityIqdPerKwh: number) {
  const revenue = await revenueReport(db, r);
  const materialCost = await many<{ entry_type: string; cost: number }>(
    db,
    `SELECT entry_type, COALESCE(SUM(cost_iqd), 0) AS cost FROM pc_warehouse_ledger
      WHERE entry_type IN (${MATERIAL_COST_TYPES.map(() => '?').join(', ')}) AND created_at >= ? AND created_at < ?
      GROUP BY entry_type`,
    ...MATERIAL_COST_TYPES,
    r.from,
    r.to
  );
  const { statedLater, pending } = await pendingCostDraws(db, r);
  const pendingLots = await many<{ lot_id: string; variant_id: string; received_qty: number; on_hand_qty: number; received_at: string }>(
    db,
    'SELECT id AS lot_id, variant_id, received_qty, on_hand_qty, received_at FROM pc_stock_lots WHERE cost_known = 0 ORDER BY received_at, id LIMIT 100'
  );
  const printed = await many<{ printer_id: string; seconds: number; power_w: number; reserve: number; acquisition: number | null; residual: number | null; life: number | null }>(
    db,
    `SELECT a.printer_id, COALESCE(SUM(COALESCE(j.printed_seconds, 0)), 0) AS seconds, m.average_power_w AS power_w,
            p.maintenance_reserve_iqd_per_hour AS reserve, p.acquisition_cost_iqd AS acquisition, p.residual_value_iqd AS residual,
            p.expected_life_hours AS life
       FROM pc_printer_assignments a JOIN pc_print_jobs j ON j.id = a.job_id JOIN pc_printers p ON p.id = a.printer_id
       JOIN pc_printer_models m ON m.id = p.model_id
      WHERE a.state = 'finished' AND a.ended_at >= ? AND a.ended_at < ?
      GROUP BY a.printer_id`,
    r.from,
    r.to
  );
  let electricity = 0;
  let maintenanceReserve = 0;
  let depreciation = 0;
  for (const p of printed) {
    const s = Number(p.seconds);
    // kWh × tariff = W × s / 3,600,000 × tariff
    electricity += mulDivRound(Number(p.power_w) * s, electricityIqdPerKwh, 3_600_000);
    maintenanceReserve += mulDivRound(Number(p.reserve), s, 3600);
    if (p.acquisition !== null && p.life) depreciation += mulDivRound(Math.max(0, Number(p.acquisition) - Number(p.residual ?? 0)), s, Number(p.life) * 3600);
  }
  const maintenanceRecorded = await one<{ v: number }>(
    db,
    "SELECT COALESCE(SUM(cost_iqd), 0) AS v FROM pc_printer_maintenance WHERE status = 'done' AND ends_at >= ? AND ends_at < ?",
    r.from,
    r.to
  );
  const recorded = Object.fromEntries(materialCost.map((m) => [m.entry_type, Number(m.cost)]));
  const cost = (type: string) => Number(recorded[type] ?? 0) + Number(statedLater[type] ?? 0);
  const cogs = cost('consume_customer') + cost('ship_out');
  const waste = cost('consume_workshop') + cost('waste') + cost('damage') + cost('adjust_down');
  const gross = revenue.recognised_revenue.total - cogs;
  const operating = electricity + maintenanceReserve + depreciation + Number(maintenanceRecorded?.v ?? 0) + waste;
  // Refunds move profit only by what they did not give back of unused,
  // prepaid value (never revenue): a refunded delivery fee (revenue once
  // paid) or more paid back than the unused value lowers it; less raises it.
  const refundsEffect = revenue.refunds_of_unused_value - revenue.refunds_recorded;
  return {
    range: r,
    recognised_revenue: revenue.recognised_revenue.total,
    cost_of_material_used: cogs,
    gross_profit: gross,
    operating_costs: {
      material_waste_and_workshop_use: waste,
      electricity_estimate: electricity,
      electricity_basis: { tariff_iqd_per_kwh: electricityIqdPerKwh, method: 'model average watts × printed seconds' },
      maintenance_reserve: maintenanceReserve,
      maintenance_recorded: Number(maintenanceRecorded?.v ?? 0),
      depreciation,
    },
    material_cost_stated_after_use: Object.values(statedLater).reduce((s, v) => s + v, 0),
    cost_complete: pending.length === 0,
    cost_pending: pending,
    lots_cost_pending: pendingLots,
    refunds_recorded: revenue.refunds_recorded,
    refunds_of_unused_value: revenue.refunds_of_unused_value,
    refunds_profit_effect: refundsEffect,
    buybacks_approved: revenue.buybacks.approved_value,
    net_profit: gross - operating + refundsEffect,
    note:
      'Estimates are labelled; recorded costs come from the warehouse ledger and maintenance records, and units drawn from a lot before its cost was stated are valued from the cost stated since. ' +
      'While cost_complete is false, the units in cost_pending came from lots whose cost is not stated yet (lots_cost_pending): they carry no cost here, so both profits are overstated by their cost. ' +
      'Refunds count only by their effect: returning unused, prepaid value is no loss. ' +
      'Employee commissions and investor shares are computed by the Levonis finance system once the accounting adapter is connected.',
  };
}

/** OPERATIONS: utilisation, failure rate and material use. */
export async function operationsReport(db: D1Database, r: Range) {
  const spanSeconds = Math.max(1, Math.floor((Date.parse(r.to) - Date.parse(r.from)) / 1000));
  const printers = await many<{ id: string; name: string; printed: number; jobs: number }>(
    db,
    `SELECT p.id, p.name, COALESCE(SUM(COALESCE(j.printed_seconds, 0)), 0) AS printed, COUNT(a.id) AS jobs
       FROM pc_printers p LEFT JOIN pc_printer_assignments a ON a.printer_id = p.id AND a.state = 'finished' AND a.ended_at >= ? AND a.ended_at < ?
       LEFT JOIN pc_print_jobs j ON j.id = a.job_id
      GROUP BY p.id ORDER BY p.name`,
    r.from,
    r.to
  );
  const outcomes = await one<{ completed: number; failed: number }>(
    db,
    `SELECT SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status IN ('failed', 'reprint_requested') THEN 1 ELSE 0 END) AS failed
       FROM pc_print_jobs WHERE ended_at >= ? AND ended_at < ?`,
    r.from,
    r.to
  );
  const failures = await many<{ responsible: string; n: number }>(
    db,
    'SELECT responsible, COUNT(*) AS n FROM pc_failures WHERE created_at >= ? AND created_at < ? GROUP BY responsible',
    r.from,
    r.to
  );
  const material = await many<{ variant_id: string; consumed: number }>(
    db,
    "SELECT variant_id, -SUM(delta_on_hand) AS consumed FROM pc_warehouse_ledger WHERE entry_type IN ('consume_customer', 'consume_workshop', 'waste') AND created_at >= ? AND created_at < ? GROUP BY variant_id",
    r.from,
    r.to
  );
  const completed = Number(outcomes?.completed ?? 0);
  const failed = Number(outcomes?.failed ?? 0);
  return {
    range: r,
    printers: printers.map((p) => ({ ...p, utilisation_permille: Math.min(1000, Math.floor((Number(p.printed) * 1000) / spanSeconds)) })),
    jobs: { completed, failed, failure_rate_permille: completed + failed ? Math.floor((failed * 1000) / (completed + failed)) : 0 },
    failures_by_responsible: Object.fromEntries(failures.map((f) => [f.responsible, Number(f.n)])),
    material_used: material,
  };
}

export function parseRange(from: string | undefined, to: string | undefined, now: Date): Range {
  const t = to && !Number.isNaN(Date.parse(to)) ? new Date(to) : now;
  const f = from && !Number.isNaN(Date.parse(from)) ? new Date(from) : new Date(t.getTime() - 30 * 86400 * 1000);
  return { from: f.toISOString(), to: t.toISOString() };
}
