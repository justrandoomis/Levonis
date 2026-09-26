/**
 * Serialized-device operations (final-phase mandate §4): per-PHYSICAL-unit
 * records, per-unit delivery + warranty clocks, serial normalization and
 * coverage math. Consumed by worker/routes/devices.ts and by the delivered
 * hook every door shares (worker/lib/orderDeliveredEffects.ts).
 *
 * Eligibility is EXPLICIT configuration, never name-substring inference: a
 * product is serialized only when its products.ops_policy JSON says
 * {"serialized": true} — or when it is a PRINTER by the owner's catalog flag
 * (worker/lib/printerIdentity.ts), which is serialized unless the owner said
 * `false` and carries the 12-month base unless another is configured
 * (worker/lib/warrantyPlans.ts `effectiveDevicePolicy`: the read-time twin of
 * the defaults the product writers fill in, so a printer stored before them
 * still records the extension it sold). Base coverage months otherwise come
 * from ops_policy.warranty_base_months (alias: warranty_months). A serialized
 * non-printer with NO configured duration gets warranty_end_at NULL and an
 * honest 'needs_config' coverage state (decision register row 18) — a
 * duration is never silently assumed.
 *
 * Clocks: warranty_start_at = the authenticated per-unit delivered_at.
 * Registration NEVER starts, restarts or extends any clock.
 */

import type { Env } from './types';
import { safeParse } from './types';
import { addMonths } from './membershipOps';
import { newId } from './crypto';
import { printerProductIds } from './printerIdentity';
import { effectiveDevicePolicy } from './warrantyPlans';

// ---------------------------------------------------------------- policy

export interface SerializationPolicy {
  serialized: boolean;
  /** Explicitly configured base coverage months, or null = not configured. */
  base_months: number | null;
}

/** Parses products.ops_policy (TEXT JSON). Unknown/invalid shapes are inert. */
export function parseOpsPolicy(raw: unknown): SerializationPolicy {
  const obj =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : safeParse<Record<string, unknown>>(raw, {});
  const months = obj.warranty_base_months ?? obj.warranty_months;
  const base =
    typeof months === 'number' && Number.isInteger(months) && months >= 1 && months <= 240 ? months : null;
  return { serialized: obj.serialized === true, base_months: base };
}

// ---------------------------------------------------------------- coverage

/** Shape of order_items.warranty_snapshot persisted at checkout (0002). */
export interface WarrantySnapshotLite {
  plan_id?: string;
  title_ar?: string;
  title_en?: string;
  fee_iqd?: number;
  duration_months?: number;
  duration_kind?: string; // 'total' | 'extension'
  /** Written by the resolver since the extended-warranty round: the percent
   *  the fee came from, the regular price it was applied to, and the coverage
   *  the customer was PROMISED at checkout (base + extension). */
  fee_percent?: number | null;
  basis_iqd?: number;
  base_months?: number | null;
  total_months?: number | null;
}

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

export interface CoverageCalc {
  base_months: number | null;
  ext_months: number;
  /** Effective total coverage months, or null = not configurable → needs_config. */
  total_months: number | null;
  end_at: string | null;
}

/**
 * Calendar-month coverage from the per-unit delivered_at:
 * - base only:                 end = delivered + base months
 * - base + purchased extension: end = delivered + (base + ext) months
 *   (base 12 + ext 12/24 → 24/36 total, mandate §4)
 * - purchased 'total' plan:     end = delivered + plan months (the plan is
 *   explicit owner-configured product data, not a guess)
 * - no base and no total plan:  end = null → honest needs_config; an
 *   extension alone cannot produce a total.
 * - a snapshot that carries `total_months` (written at checkout since the
 *   extended-warranty round) is the promise the customer paid for and WINS
 *   over the product's current policy: "+12 → 24 total" survives a later
 *   edit of the product, and a printer whose ops_policy was never configured
 *   still delivers the 24/36 months it sold.
 * Month addition clamps to month end and handles leap years (addMonths).
 */
export function computeCoverage(
  baseMonths: number | null,
  snap: WarrantySnapshotLite | null,
  deliveredAtIso: string
): CoverageCalc {
  const dur =
    snap && typeof snap.duration_months === 'number' && Number.isInteger(snap.duration_months) && snap.duration_months > 0
      ? snap.duration_months
      : null;
  const kind = dur === null ? null : snap?.duration_kind === 'total' ? 'total' : snap?.duration_kind === 'extension' ? 'extension' : null;

  let ext = 0;
  let total: number | null;
  const frozenTotal = posInt(snap?.total_months);
  if (kind !== null && frozenTotal !== null) {
    // The checkout froze the whole promise; the base it was built on comes
    // with it (falling back to the product's configured base only when the
    // snapshot did not record one).
    total = frozenTotal;
    const frozenBase = posInt(snap?.base_months) ?? baseMonths;
    ext = kind === 'extension' ? (dur as number) : Math.max(0, frozenTotal - (frozenBase ?? frozenTotal));
    return {
      base_months: frozenBase,
      ext_months: ext,
      total_months: total,
      end_at: addMonths(deliveredAtIso, total),
    };
  }
  if (kind === 'extension') {
    ext = dur as number;
    total = baseMonths !== null ? baseMonths + ext : null;
  } else if (kind === 'total') {
    total = dur as number;
    ext = baseMonths !== null ? Math.max(0, (dur as number) - baseMonths) : 0;
  } else {
    total = baseMonths;
  }
  return {
    base_months: baseMonths,
    ext_months: ext,
    total_months: total,
    end_at: total !== null ? addMonths(deliveredAtIso, total) : null,
  };
}

export type CoverageState = 'active' | 'expired' | 'needs_config' | 'not_delivered';

export function coverageState(
  deliveredAt: string | null,
  endAt: string | null,
  nowMs = Date.now()
): { state: CoverageState; remaining_days: number | null } {
  if (!deliveredAt) return { state: 'not_delivered', remaining_days: null };
  if (!endAt) return { state: 'needs_config', remaining_days: null };
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(endMs)) return { state: 'needs_config', remaining_days: null };
  if (endMs <= nowMs) return { state: 'expired', remaining_days: 0 };
  return { state: 'active', remaining_days: Math.ceil((endMs - nowMs) / 86_400_000) };
}

// ---------------------------------------------------------------- serials

/**
 * Lookup normalization only (0003: upper-case, spaces/dashes removed). The
 * EXACT entered value is preserved separately in device_serials.serial_raw.
 * ONE definition, shared with the serial inventory (0139) and the scanner, so
 * `device_serials.serial_norm` and `serial_inventory.serial_norm` join on
 * equality (packages/catalog/src/deviceSerials.ts).
 */
export { normalizeSerial } from '@levonis/catalog/deviceSerials';

/** Masked display for customers: last 4 characters visible. */
export function maskSerial(raw: string): string {
  const s = String(raw);
  if (s.length <= 4) return '****';
  return `****${s.slice(-4)}`;
}

// ---------------------------------------------------------------- unit creation

interface UnitSourceRow extends Record<string, unknown> {
  item_id: string;
  product_id: string | null;
  qty: number;
  warranty_snapshot: string | null;
  ops_policy: string | null;
}

export interface CreateUnitsResult {
  serialized_items: number;
  planned_units: number;
  created: number;
}

/**
 * Creates one order_item_unit row per PHYSICAL unit of every serialized
 * product in the order (5 printers + 1 AMS = 6 rows). Idempotent under
 * retries/replays via UNIQUE(order_item_id, unit_index) + ON CONFLICT DO
 * NOTHING — replayed delivery events can never duplicate units or restart
 * coverage (existing rows are left untouched).
 *
 * Per-unit delivered_at = the passed order delivery timestamp (the admin
 * flow currently delivers whole orders; individual units are corrected
 * afterwards through the audited admin endpoint, which recomputes only that
 * unit's window).
 */
export async function createUnitsOnDelivery(
  env: Env,
  orderId: string,
  deliveredAtIso: string
): Promise<CreateUnitsResult> {
  if (!Number.isFinite(Date.parse(deliveredAtIso))) {
    throw new Error(`createUnitsOnDelivery: invalid deliveredAt "${deliveredAtIso}"`);
  }
  const order = await env.DB.prepare('SELECT id, user_id FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ id: string; user_id: string }>();
  if (!order) return { serialized_items: 0, planned_units: 0, created: 0 };

  const { results: items } = await env.DB.prepare(
    `SELECT oi.id AS item_id, oi.product_id, oi.qty, oi.warranty_snapshot, p.ops_policy
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?`
  )
    .bind(orderId)
    .all<UnitSourceRow>();

  // Which lines are printers, by the owner's catalog flag — one query for the
  // whole order. A printer is serialized and 12-month based by default, so a
  // plan sold on a printer whose ops_policy was never configured still gets
  // the unit rows it was sold for.
  const printerIds = await printerProductIds(
    env.DB,
    items.map((it) => (it.product_id === null ? '' : String(it.product_id)))
  );

  const stmts: D1PreparedStatement[] = [];
  let serializedItems = 0;
  let planned = 0;
  for (const it of items) {
    const policy = effectiveDevicePolicy(it.ops_policy, it.product_id !== null && printerIds.has(String(it.product_id)));
    if (!policy.serialized) continue;
    serializedItems++;
    const snap = safeParse<WarrantySnapshotLite | null>(it.warranty_snapshot, null);
    const cov = computeCoverage(policy.warranty_base_months, snap, deliveredAtIso);
    const qty = Math.min(Math.max(Number(it.qty) || 0, 0), 500);
    const policyVersion = JSON.stringify({
      v: 1,
      base: cov.base_months,
      ext: cov.ext_months,
      total: cov.total_months,
      plan_id: snap?.plan_id ?? null,
      plan_kind: snap?.duration_kind ?? null,
    });
    for (let i = 1; i <= qty; i++) {
      planned++;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index,
              delivered_at, warranty_base_months, warranty_ext_months, warranty_start_at, warranty_end_at, policy_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(order_item_id, unit_index) DO NOTHING`
        ).bind(
          newId('unit'),
          orderId,
          it.item_id,
          it.product_id,
          order.user_id,
          i,
          deliveredAtIso,
          cov.base_months,
          cov.ext_months,
          deliveredAtIso,
          cov.end_at,
          policyVersion
        )
      );
    }
  }
  if (stmts.length === 0) return { serialized_items: serializedItems, planned_units: 0, created: 0 };
  const results = await env.DB.batch(stmts);
  const created = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  return { serialized_items: serializedItems, planned_units: planned, created };
}

/**
 * DELIVERED ORDERS THAT NEVER GOT THEIR UNITS — the history the courier door
 * left behind. Until orderDeliveredEffects ran from `moveOrderStage`, a printer
 * order Al-Waseet (or the cron) moved to `delivered` got no order_item_units at
 * all, and the courier sync never revisits it: an order already at `delivered`
 * is `unchanged` to it. Those customers find nothing under «من طلباتي» and the
 * admin's warranty section says there are no units. This finds them and
 * creates the units from the RECORDED delivered_at, so the clock starts where
 * it would have.
 *
 * The selection is the SQL twin of the rule `createUnitsOnDelivery` applies
 * per line (`effectiveDevicePolicy`): ops_policy says serialized:true, or the
 * product sits in a printer catalog and ops_policy does not say false. It must
 * match exactly — a candidate that yields no unit would be picked again every
 * run. Only orders with NO unit rows at all are candidates; an order with some
 * units has already been through `createUnitsOnDelivery`, and the per-order
 * backfill in Admin → Serials covers anything odder than that.
 *
 * Units only. Purchase points and referral milestones the same deliveries
 * skipped are money granted months late — an owner call, not a repair.
 *
 * Bounded and idempotent (UNIQUE(order_item_id, unit_index)); each order is
 * contained on its own so one bad row cannot stall the rest.
 */
export interface DeliveredUnitsSweep {
  scanned: number;
  orders: number;
  created: number;
  errors: number;
}

export async function sweepDeliveredOrdersWithoutUnits(env: Env, limit = 50): Promise<DeliveredUnitsSweep> {
  const serialized = `(CASE WHEN json_valid(p.ops_policy) THEN json_extract(p.ops_policy, '$.serialized') END)`;
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.delivered_at
       FROM orders o
      WHERE o.status = 'delivered'
        AND o.delivered_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM order_item_units u WHERE u.order_id = o.id)
        AND EXISTS (
          SELECT 1
            FROM order_items oi
            JOIN products p ON p.id = oi.product_id
           WHERE oi.order_id = o.id
             AND oi.qty > 0
             AND (${serialized} = 1
                  OR (${serialized} IS NOT 0
                      AND EXISTS (SELECT 1 FROM product_catalogs pc
                                    JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                                   WHERE pc.product_id = oi.product_id))))
      ORDER BY o.delivered_at DESC
      LIMIT ?`
  )
    .bind(Math.min(Math.max(Math.trunc(limit), 1), 500))
    .all<{ id: string; delivered_at: string }>();
  const out: DeliveredUnitsSweep = { scanned: results.length, orders: 0, created: 0, errors: 0 };
  for (const o of results) {
    try {
      const r = await createUnitsOnDelivery(env, o.id, o.delivered_at);
      out.created += r.created;
      if (r.created > 0) out.orders++;
    } catch (e) {
      out.errors++;
      console.error('delivered-units sweep failed for order', o.id, e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

// ---------------------------------------------------------------- corrections

export interface UnitRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  order_item_id: string;
  product_id: string | null;
  owner_user_id: string;
  unit_index: number;
  delivered_at: string | null;
  warranty_base_months: number | null;
  warranty_ext_months: number;
  warranty_start_at: string | null;
  warranty_end_at: string | null;
  policy_version: string;
  replaced_by_unit_id: string | null;
  replacement_of_unit_id: string | null;
}

/** Effective total coverage months for a stored unit (policy_version first,
 *  columns as fallback). null = not configurable. */
export function unitTotalMonths(unit: Pick<UnitRow, 'warranty_base_months' | 'warranty_ext_months' | 'policy_version'>): number | null {
  const pv = safeParse<{ total?: number | null; carried?: string }>(unit.policy_version, {});
  if (typeof pv.total === 'number' && Number.isInteger(pv.total) && pv.total > 0) return pv.total;
  if (pv.total === null) return null;
  const base = unit.warranty_base_months;
  if (typeof base === 'number' && base > 0) return base + (Number(unit.warranty_ext_months) || 0);
  return null;
}

/**
 * Recomputes ONE unit's window for a corrected delivered_at. Replacement
 * units that carry the original device's end date (policy_version.carried =
 * 'original_end') keep that end date — only delivered_at/start move.
 * Returns the recomputed end.
 */
export function recomputeUnitWindow(unit: UnitRow, newDeliveredAtIso: string): { start_at: string; end_at: string | null } {
  const pv = safeParse<{ carried?: string }>(unit.policy_version, {});
  if (pv.carried === 'original_end') {
    return { start_at: newDeliveredAtIso, end_at: unit.warranty_end_at };
  }
  const total = unitTotalMonths(unit);
  return { start_at: newDeliveredAtIso, end_at: total !== null ? addMonths(newDeliveredAtIso, total) : null };
}

// ---------------------------------------------------------------- claims

export const CLAIM_STAGES = [
  'received',
  'diagnosing',
  'approved',
  'rejected',
  'repairing',
  'replaced',
  'resolved',
] as const;
export type ClaimStage = (typeof CLAIM_STAGES)[number];

/** Workflow graph — decisions are explicit admin acts, nothing auto-approves. */
export const CLAIM_TRANSITIONS: Record<ClaimStage, ClaimStage[]> = {
  received: ['diagnosing', 'approved', 'rejected'],
  diagnosing: ['approved', 'rejected'],
  approved: ['repairing', 'replaced', 'resolved', 'rejected'],
  repairing: ['resolved', 'replaced'],
  replaced: ['resolved'],
  rejected: ['diagnosing'], // reopen for another look
  resolved: [],
};

/** Effective stage for rows that predate the stage column. */
export function effectiveClaimStage(stage: unknown, legacyStatus: unknown): ClaimStage {
  if (typeof stage === 'string' && (CLAIM_STAGES as readonly string[]).includes(stage)) return stage as ClaimStage;
  switch (legacyStatus) {
    case 'in_review':
      return 'diagnosing';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return 'received';
  }
}

/**
 * `effectiveClaimStage`, spelled in SQL, for a WHERE clause.
 *
 * The admin queue filtered by stage in JavaScript AFTER `LIMIT 300`, so once
 * there were more than three hundred claims, choosing «received» silently
 * omitted every received claim past the first three hundred rows. The filter
 * has to run in the database, before the limit — and it has to apply the SAME
 * legacy rules as the function above, or a pre-0006 claim (stage NULL,
 * status 'in_review') would be listed under one stage and filtered under
 * another. Built from `CLAIM_STAGES` so the two cannot drift apart.
 */
export function effectiveClaimStageSql(alias: string): string {
  const known = CLAIM_STAGES.map((s) => `'${s}'`).join(',');
  return `(CASE WHEN ${alias}.stage IN (${known}) THEN ${alias}.stage
       WHEN ${alias}.status = 'in_review' THEN 'diagnosing'
       WHEN ${alias}.status = 'approved' THEN 'approved'
       WHEN ${alias}.status = 'rejected' THEN 'rejected'
       ELSE 'received' END)`;
}

/** Coarse mapping into the CHECK-constrained legacy status column (0001). */
export function stageToLegacyStatus(stage: ClaimStage): 'submitted' | 'in_review' | 'approved' | 'rejected' {
  switch (stage) {
    case 'received':
      return 'submitted';
    case 'diagnosing':
      return 'in_review';
    case 'rejected':
      return 'rejected';
    default:
      return 'approved'; // approved/repairing/replaced/resolved
  }
}
