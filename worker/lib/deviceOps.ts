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
 * Clocks: warranty_start_at = the authenticated per-unit delivered_at — except
 * for a device sold AGAIN (returned or traded in, owner decision 3,
 * 2026-10-09), whose unit carries its first sale's start and end
 * (`carriedWindow`, worker/lib/deviceCustody.ts). Registration NEVER starts,
 * restarts or extends any clock, and nothing restarts a carried one.
 */

import type { Env } from './types';
import { safeParse } from './types';
import { addMonths } from './membershipOps';
import { newId } from './crypto';
import { anySectionSerialPolicy, serializationContext, lineDevicePolicy, serializedProductSql, serialAssignmentsInstalled } from './serialPolicy';
import { carriedWindow, unitIdentity, warrantySourceOf, type PriorUnit } from './deviceCustody';

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

export type CoverageState = 'active' | 'expired' | 'needs_config' | 'not_delivered' | 'closed';

/**
 * `closedAt` (order_item_units.warranty_closed_at, migration 0178): a unit
 * whose device came back on a return — or was superseded by an owner
 * override — is CLOSED. Its dates are kept and shown; it no longer covers.
 */
export function coverageState(
  deliveredAt: string | null,
  endAt: string | null,
  nowMs = Date.now(),
  closedAt: string | null = null
): { state: CoverageState; remaining_days: number | null } {
  if (closedAt) return { state: 'closed', remaining_days: null };
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
  /** The listing's condition (open box / used / refurbished), for a resale's used-sale cover. */
  condition_doc?: string | null;
  /** 1 when other lines of the order hang off this one (a bundle or mystery PARENT). */
  is_bundle_parent: number;
}

export interface CreateUnitsResult {
  serialized_items: number;
  planned_units: number;
  created: number;
  /** The preparation serials bound to the new units (migration 0178), or
   *  null when that step did not run. Its own batch: a failure here never
   *  costs a unit (critique H3). */
  activation?: { pending: number; activated: number; released_policy: number; conflicts: number; reopened: number } | null;
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

  // A bundle PARENT is never a device of its own (landing round 3, F7): it
  // is the composition row — stock NULL, no options, never reserved — and
  // the physical items are its COMPONENT lines, which carry the real product
  // and get their units here. The preparation slots and the board skip the
  // parent the same way (`serialRequiredSlots`, `boardSerialCounts`), so a
  // parent filed under a printer catalog or carrying `serialized` can never
  // add warranty units on top of its components'.
  const { results: items } = await env.DB.prepare(
    `SELECT oi.id AS item_id, oi.product_id, oi.qty, oi.warranty_snapshot, p.ops_policy, p.condition_doc,
            EXISTS (SELECT 1 FROM order_items c WHERE c.bundle_parent_item_id = oi.id) AS is_bundle_parent
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?`
  )
    .bind(orderId)
    .all<UnitSourceRow>();

  // S8 (owner decision 3): a slot whose live preparation binding CARRIES a
  // previous unit's warranty (a resold device) is born with that window — the
  // original start and end — so no reset window ever exists between this
  // batch and the activation batch, even when activation fails and waits for
  // the sweep. The activation writes the same values again (carriedWindow).
  const carried = await carriedPriors(env.DB, orderId);

  // Which lines are printers, by the owner's catalog flag, and which sit in a
  // section whose serial policy says 'required' (0178) — two batched reads for
  // the whole order (worker/lib/serialPolicy.ts). A printer is serialized and
  // 12-month based by default, so a plan sold on a printer whose ops_policy
  // was never configured still gets the unit rows it was sold for.
  const policyCtx = await serializationContext(
    env.DB,
    items.map((it) => (it.product_id === null ? '' : String(it.product_id)))
  );

  const stmts: D1PreparedStatement[] = [];
  let serializedItems = 0;
  let planned = 0;
  for (const it of items) {
    if (Number(it.is_bundle_parent) === 1) continue;
    const policy = lineDevicePolicy(it.ops_policy, it.product_id, policyCtx);
    if (!policy.serialized) continue;
    serializedItems++;
    const { cov, policyVersion } = ownUnitWindow(policy.warranty_base_months, it.warranty_snapshot, deliveredAtIso);
    const qty = Math.min(Math.max(Number(it.qty) || 0, 0), 500);
    for (let i = 1; i <= qty; i++) {
      planned++;
      const prior = carried.get(`${it.item_id}:${i}`);
      const win = prior
        ? carriedWindow(prior, { ext_months: cov.ext_months, delivered_at: deliveredAtIso, condition_doc: it.condition_doc })
        : null;
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
          win ? win.base_months : cov.base_months,
          win ? win.ext_months : cov.ext_months,
          win ? win.start_at ?? deliveredAtIso : deliveredAtIso,
          win ? win.end_at : cov.end_at,
          win ? win.policy_version : policyVersion
        )
      );
    }
  }
  let created = 0;
  if (stmts.length > 0) {
    const results = await env.DB.batch(stmts);
    created = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }
  // The serials scanned at preparation → these units (§8). A SEPARATE batch,
  // after the units committed, so nothing new can ever cost a customer their
  // warranty units; contained, and retried by the activation sweep.
  let activation: CreateUnitsResult['activation'] = null;
  try {
    const { activateOrderSerials } = await import('./serialAssignments');
    activation = await activateOrderSerials(env, orderId);
  } catch (e) {
    console.error('serial activation failed for order', orderId, e instanceof Error ? e.message : String(e));
  }
  const result: CreateUnitsResult = { serialized_items: serializedItems, planned_units: planned, created };
  // Reported only when there was something to activate or re-open, so the
  // result of an order with no preparation serials is exactly what it always was.
  if (activation && (activation.pending > 0 || activation.reopened > 0)) result.activation = activation;
  return result;
}

/**
 * A unit's OWN window — the one a sale that carries nothing gets: base and
 * purchased extension from its delivery (computeCoverage), and the
 * `policy_version` that records them. One definition for the delivery hook
 * and for the head start taken back (`headStartUndoStatements`).
 */
export function ownUnitWindow(
  baseMonths: number | null,
  warrantySnapshot: unknown,
  deliveredAtIso: string
): { cov: CoverageCalc; policyVersion: string } {
  const snap = safeParse<WarrantySnapshotLite | null>(warrantySnapshot, null);
  const cov = computeCoverage(baseMonths, snap, deliveredAtIso);
  const policyVersion = JSON.stringify({
    v: 1,
    base: cov.base_months,
    ext: cov.ext_months,
    total: cov.total_months,
    plan_id: snap?.plan_id ?? null,
    plan_kind: snap?.duration_kind ?? null,
  });
  return { cov, policyVersion };
}

/**
 * THE HEAD START TAKEN BACK (owner decision 3, S8's undo). The delivery hook
 * writes a resold device's carried window on the unit before activation
 * confirms it. When the `carry` binding that justified it is released WITHOUT
 * ever activating — unlinked by the owner after delivery, changed for another
 * serial, or displaced by a serial typed on the delivered unit — that window
 * belongs to a device the customer never got: the unit goes back to its own
 * line's window (from its delivery, `ownUnitWindow`), audited.
 *
 * Only a unit that still carries FROM that binding's previous unit (or the
 * unit its warranty was taken from, `warrantySourceOf`) is touched, only
 * while it has no activated binding, and only in the batch that releases the
 * binding: every statement is guarded on the binding being released by then
 * and the unit's `policy_version` being exactly what was read. A device that
 * does activate later carries again (A1 writes the window of ITS previous unit).
 */
export async function headStartUndoStatements(
  db: D1Database,
  binding: { id: string; order_item_id: string | null; unit_index: number; prior_unit_id: string | null; warranty_mode: string | null; activated_at: string | null },
  actorId: string | null
): Promise<D1PreparedStatement[]> {
  if (!binding.prior_unit_id || binding.activated_at || !binding.order_item_id) return [];
  if (binding.warranty_mode !== 'carry' && binding.warranty_mode !== 'restart') return [];
  const unit = await db
    .prepare(
      `SELECT u.id, u.product_id, u.delivered_at, u.warranty_start_at, u.warranty_end_at, u.policy_version, oi.warranty_snapshot, p.ops_policy
         FROM order_item_units u JOIN order_items oi ON oi.id = u.order_item_id LEFT JOIN products p ON p.id = u.product_id
        WHERE u.order_item_id = ? AND u.unit_index = ?`
    )
    .bind(binding.order_item_id, binding.unit_index)
    .first<{
      id: string;
      product_id: string | null;
      delivered_at: string | null;
      warranty_start_at: string | null;
      warranty_end_at: string | null;
      policy_version: string;
      warranty_snapshot: string | null;
      ops_policy: string | null;
    }>();
  if (!unit || !unit.delivered_at) return [];
  const identity = unitIdentity(unit.policy_version);
  if (!identity.carried || !identity.resale_of) return [];
  const source = await warrantySourceOf(db, binding.prior_unit_id);
  if (identity.resale_of !== binding.prior_unit_id && identity.resale_of !== source?.id) return [];
  const policyCtx = await serializationContext(db, unit.product_id ? [unit.product_id] : []);
  const policy = lineDevicePolicy(unit.ops_policy, unit.product_id, policyCtx);
  const own = ownUnitWindow(policy.warranty_base_months, unit.warranty_snapshot, unit.delivered_at);
  return [
    db
      .prepare(
        `UPDATE order_item_units
            SET warranty_base_months = ?1, warranty_ext_months = ?2, warranty_start_at = ?3, warranty_end_at = ?4, policy_version = ?5
          WHERE id = ?6 AND policy_version = ?7
            AND EXISTS (SELECT 1 FROM serial_assignments ra WHERE ra.id = ?8 AND ra.released_at IS NOT NULL AND ra.activated_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM serial_assignments xa WHERE xa.unit_id = ?6 AND xa.released_at IS NULL AND xa.activated_at IS NOT NULL)`
      )
      .bind(own.cov.base_months, own.cov.ext_months, unit.delivered_at, own.cov.end_at, own.policyVersion, unit.id, unit.policy_version, binding.id),
    db
      .prepare(`INSERT INTO audit_log (actor_id, action, target, detail) SELECT ?, 'device.window_restored', ?, ? WHERE changes() = 1`)
      .bind(
        actorId,
        unit.id,
        JSON.stringify({
          reason: 'carry_binding_released',
          assignment_id: binding.id,
          prior_unit_id: binding.prior_unit_id,
          from: { start_at: unit.warranty_start_at, end_at: unit.warranty_end_at },
          to: { start_at: unit.delivered_at, end_at: own.cov.end_at },
        })
      ),
  ];
}

/**
 * The previous units the live, not-yet-activated `carry` bindings of this
 * order name, by slot (`order_item_id:unit_index`) — each read through
 * `warrantySourceOf`, so a resale whose delivery was undone and cancelled
 * hands on the warranty IT carried, as activation does. Empty before
 * migration 0178 (deploy-ahead) and when nothing is carried. A legacy pending
 * `restart` binding carries too: the owner retired restarting (decision 3).
 */
async function carriedPriors(db: D1Database, orderId: string): Promise<Map<string, PriorUnit>> {
  const out = new Map<string, PriorUnit>();
  if (!(await serialAssignmentsInstalled(db))) return out;
  try {
    const { results } = await db
      .prepare(
        `SELECT a.order_item_id, a.unit_index, a.prior_unit_id
           FROM serial_assignments a
          WHERE a.order_id = ? AND a.released_at IS NULL AND a.activated_at IS NULL AND a.part = 'device'
            AND a.prior_unit_id IS NOT NULL AND a.warranty_mode IN ('carry','restart')`
      )
      .bind(orderId)
      .all<{ order_item_id: string; unit_index: number; prior_unit_id: string }>();
    for (const r of results ?? []) {
      const source = await warrantySourceOf(db, r.prior_unit_id);
      if (source) out.set(`${r.order_item_id}:${r.unit_index}`, source);
    }
  } catch (e) {
    // A failed read costs only the head start: activation still carries the window.
    console.error('carried windows not read for order', orderId, e instanceof Error ? e.message : String(e));
  }
  return out;
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
 * product sits in a printer catalog and ops_policy does not say false — and
 * the line is not a bundle parent (it never gets units). It must match
 * exactly — a candidate that yields no unit would be picked again every
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
  // The SQL twin of `lineDevicePolicy` (worker/lib/serialPolicy.ts): one
  // definition of the section walk, spliced here and into the batched reader.
  // The section walk is spliced in only once the owner has set a section policy.
  const serializedLine = serializedProductSql('oi.product_id', 'p.ops_policy', await anySectionSerialPolicy(env.DB));
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
             AND NOT EXISTS (SELECT 1 FROM order_items k WHERE k.bundle_parent_item_id = oi.id)
             AND ${serializedLine})
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
 * Recomputes ONE unit's window for a corrected delivered_at. A unit that
 * CARRIES a warranty (policy_version.carried = 'original_end': a replacement,
 * or a resold device — owner decision 3) keeps BOTH its start and its end:
 * the warranty runs from the original delivery, which this correction does
 * not touch (S9). Only a resale's own used-sale cover moves with its delivery
 * date (`policy_version`, returned when it changed).
 */
export function recomputeUnitWindow(unit: UnitRow, newDeliveredAtIso: string): { start_at: string; end_at: string | null; policy_version?: string } {
  const pv = safeParse<{ carried?: string; used_sale?: { months?: unknown } }>(unit.policy_version, {});
  if (pv.carried === 'original_end') {
    const months = Number(pv.used_sale?.months);
    const moved =
      pv.used_sale && Number.isInteger(months) && months > 0
        ? JSON.stringify({ ...pv, used_sale: { months, start_at: newDeliveredAtIso, end_at: addMonths(newDeliveredAtIso, months) } })
        : undefined;
    return {
      start_at: unit.warranty_start_at ?? newDeliveredAtIso,
      end_at: unit.warranty_end_at,
      ...(moved ? { policy_version: moved } : {}),
    };
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
