/**
 * WHO HAS THE DEVICE, AND WHICH WARRANTY IT CARRIES — owner decision 3
 * (2026-10-09; docs/DECISIONS.md row 193): a trade-in does NOT close the
 * device's warranty. It stays with the same serial and runs from the
 * ORIGINAL order's delivery date; a resale passes the same warranty on, with
 * its original start and end — never a new one, never from zero.
 *
 * THE TRADED-IN STATE IS DERIVED, NEVER WRITTEN. A unit was traded in when a
 * `trade_in_requests` row for its slot (order_item_id, unit_index) is
 * `completed` with a scope other than `ams_only` (the AMS alone leaves the
 * printer with its owner; `printer_only` follows `whole`, because the
 * warranty follows the serial and the serial is the printer's). That covers
 * every trade-in completed before this code and after it, and writes nothing:
 * `warranty_closed_reason = 'traded_in'` is never written — a closed warranty
 * is exactly what the owner ruled out. `tradedInSql` is the ONE definition;
 * every door and reader splices it.
 *
 * THE WARRANTY IDENTITY travels in `order_item_units.policy_version` (TEXT
 * JSON), where `carried` and `resale_of` already live: `origin_unit_id` and
 * `origin_start_at` name the first sale, and `used_sale` is the used-device
 * cover of THIS sale — kept separate, so neither shortens or restarts the
 * other, and a claim is accepted while either is in force (warranty policy
 * version 4, article 5.19 and the used-device clause). No schema change.
 */
import { safeParse } from './types';
import { addMonths } from './membershipOps';
import { coverageState, unitTotalMonths, type CoverageState } from './deviceOps';
import { parseConditionDoc } from './condition';

/**
 * When the unit `alias` was traded in (the first completed request), or NULL.
 * A scalar SQL expression over `alias.order_item_id` / `alias.unit_index`.
 */
export const tradedInSql = (alias: string) =>
  `(SELECT t.completed_at FROM trade_in_requests t
     WHERE t.order_item_id = ${alias}.order_item_id AND t.unit_index = ${alias}.unit_index
       AND t.status = 'completed' AND t.scope <> 'ams_only'
     ORDER BY t.completed_at LIMIT 1)`;

/** unit id → traded-in date, for the units given; one query. */
export async function tradedInMap(db: D1Database, unitIds: ReadonlyArray<string>): Promise<Map<string, string>> {
  const ids = [...new Set(unitIds.filter((x) => typeof x === 'string' && x !== ''))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { results } = await db
    .prepare(`SELECT u.id, ${tradedInSql('u')} AS traded_in_at FROM order_item_units u WHERE u.id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids))
    .all<{ id: string; traded_in_at: string | null }>();
  for (const r of results ?? []) if (r.traded_in_at) out.set(r.id, r.traded_in_at);
  return out;
}

// ---------------------------------------------------------------- policy_version

export interface UsedSaleCover {
  months: number;
  start_at: string;
  end_at: string;
}

export interface UnitIdentity {
  carried: boolean;
  resale_of: string | null;
  origin_unit_id: string | null;
  origin_start_at: string | null;
  used_sale: UsedSaleCover | null;
}

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

/** What a unit's `policy_version` says about the warranty it carries. Unknown shapes are inert. */
export function unitIdentity(policyVersion: unknown): UnitIdentity {
  const pv = safeParse<Record<string, unknown>>(policyVersion, {});
  const us = pv.used_sale && typeof pv.used_sale === 'object' ? (pv.used_sale as Record<string, unknown>) : null;
  const months = Number(us?.months);
  const usStart = isoOrNull(us?.start_at);
  const usEnd = isoOrNull(us?.end_at);
  return {
    carried: pv.carried === 'original_end',
    resale_of: typeof pv.resale_of === 'string' && pv.resale_of ? pv.resale_of : null,
    origin_unit_id: typeof pv.origin_unit_id === 'string' && pv.origin_unit_id ? pv.origin_unit_id : null,
    origin_start_at: isoOrNull(pv.origin_start_at),
    used_sale: us && Number.isInteger(months) && months > 0 && usStart && usEnd ? { months, start_at: usStart, end_at: usEnd } : null,
  };
}

/** The used-device cover a resale on a condition listing adds: its own months from THIS delivery. */
export function usedSaleCover(conditionDoc: unknown, deliveredAtIso: string | null): UsedSaleCover | null {
  const doc = parseConditionDoc(conditionDoc);
  if (!doc || !deliveredAtIso || !Number.isFinite(Date.parse(deliveredAtIso))) return null;
  return { months: doc.warranty_months, start_at: deliveredAtIso, end_at: addMonths(deliveredAtIso, doc.warranty_months) };
}

export interface PriorUnit {
  id: string;
  delivered_at: string | null;
  warranty_start_at: string | null;
  warranty_end_at: string | null;
  warranty_base_months: number | null;
  warranty_ext_months: number;
  policy_version: string;
}

export interface CarriedWindow {
  start_at: string | null;
  end_at: string | null;
  base_months: number | null;
  ext_months: number;
  policy_version: string;
}

/**
 * THE WINDOW A RESOLD DEVICE CARRIES (S6). From the previous unit: its start
 * (the first delivery), its end — plus the months of a paid extension the
 * new line bought (0 when none) — its base, and its extension plus the new
 * one. The identity names the origin unit and its start (the previous unit's
 * origin when it was itself a resale), and `used_sale` holds this sale's
 * used-device cover when the line is a condition listing. Pure: the delivery
 * hook (S8) and the activation (A1) both call it, so the window written
 * before activation is the one activation confirms.
 */
export function carriedWindow(
  prior: PriorUnit,
  sale: { ext_months: number; delivered_at: string | null; condition_doc?: unknown }
): CarriedWindow {
  const before = unitIdentity(prior.policy_version);
  const addExt = Math.max(0, Math.trunc(Number(sale.ext_months) || 0));
  const priorExt = Math.max(0, Math.trunc(Number(prior.warranty_ext_months) || 0));
  const start = prior.warranty_start_at ?? prior.delivered_at ?? null;
  const end = prior.warranty_end_at ? (addExt > 0 ? addMonths(prior.warranty_end_at, addExt) : prior.warranty_end_at) : null;
  const priorTotal = unitTotalMonths(prior);
  const used = usedSaleCover(sale.condition_doc, sale.delivered_at);
  const pv = {
    v: 1,
    carried: 'original_end',
    resale_of: prior.id,
    origin_unit_id: before.origin_unit_id ?? prior.id,
    origin_start_at: before.origin_start_at ?? start,
    base: prior.warranty_base_months,
    ext: priorExt + addExt,
    total: priorTotal === null ? null : priorTotal + addExt,
    ...(addExt > 0 ? { ext_added: addExt } : {}),
    ...(used ? { used_sale: used } : {}),
  };
  return {
    start_at: start,
    end_at: end,
    base_months: prior.warranty_base_months,
    ext_months: priorExt + addExt,
    policy_version: JSON.stringify(pv),
  };
}

// ---------------------------------------------------------------- coverage

/**
 * COVERED WHILE EITHER IS IN FORCE (policy v4, the used-device clause): the
 * original window first; when it is over, a used-sale cover that still runs
 * keeps the unit covered. A closed unit stays closed.
 */
export function unitCoverage(
  unit: { delivered_at: string | null; warranty_end_at: string | null; policy_version?: unknown },
  nowMs = Date.now(),
  closedAt: string | null = null
): { state: CoverageState; remaining_days: number | null; via: 'original' | 'used_sale' } {
  const base = coverageState(unit.delivered_at, unit.warranty_end_at, nowMs, closedAt);
  if (closedAt || base.state === 'not_delivered') return { ...base, via: 'original' };
  const used = unitIdentity(unit.policy_version).used_sale;
  if (!used) return { ...base, via: 'original' };
  const second = coverageState(used.start_at, used.end_at, nowMs);
  if (second.state !== 'active') return { ...base, via: 'original' };
  if (base.state === 'active' && (base.remaining_days ?? 0) >= (second.remaining_days ?? 0)) return { ...base, via: 'original' };
  return { state: 'active', remaining_days: second.remaining_days, via: 'used_sale' };
}

// ---------------------------------------------------------------- history

export interface CustodyStep {
  kind: 'first' | 'traded_in' | 'returned' | 'resold';
  at: string;
}

interface ChainUnit {
  id: string;
  delivered_at: string | null;
  warranty_closed_at: string | null;
  warranty_closed_reason: string | null;
  policy_version: string;
  traded_in_at: string | null;
}

/**
 * The device's custody, DATES ONLY (no order, no person — a later holder must
 * not learn who had it before): first delivery, each trade-in or return, each
 * resale. Walks `resale_of` back, at most `maxHops` sales, one query per hop
 * for all the units given. Units with no resale behind them get only their
 * own trade-in, when there is one.
 */
export async function custodyHistory(
  db: D1Database,
  units: ReadonlyArray<{ id: string; delivered_at: string | null; policy_version?: unknown; traded_in_at?: string | null }>,
  maxHops = 6
): Promise<Map<string, CustodyStep[]>> {
  const out = new Map<string, CustodyStep[]>();
  const chains = new Map<string, ChainUnit[]>();
  let frontier = new Map<string, string>(); // unit asked about → previous unit to read next
  for (const u of units) {
    chains.set(u.id, []);
    const prev = unitIdentity(u.policy_version).resale_of;
    if (prev) frontier.set(u.id, prev);
  }
  for (let hop = 0; hop < maxHops && frontier.size; hop++) {
    const ids = [...new Set(frontier.values())];
    const { results } = await db
      .prepare(
        `SELECT u.id, u.delivered_at, u.warranty_closed_at, u.warranty_closed_reason, u.policy_version, ${tradedInSql('u')} AS traded_in_at
           FROM order_item_units u WHERE u.id IN (SELECT value FROM json_each(?))`
      )
      .bind(JSON.stringify(ids))
      .all<ChainUnit>();
    const byId = new Map((results ?? []).map((r) => [r.id, r]));
    const next = new Map<string, string>();
    for (const [asked, prevId] of frontier) {
      const prev = byId.get(prevId);
      if (!prev) continue;
      const chain = chains.get(asked)!;
      if (chain.some((c) => c.id === prev.id)) continue; // a loop is never followed
      chain.push(prev);
      const further = unitIdentity(prev.policy_version).resale_of;
      if (further) next.set(asked, further);
    }
    frontier = next;
  }
  for (const u of units) {
    const steps: CustodyStep[] = [];
    const chain = [...(chains.get(u.id) ?? [])].reverse(); // oldest sale first
    for (const prev of chain) {
      if (prev.delivered_at) steps.push({ kind: steps.length ? 'resold' : 'first', at: prev.delivered_at });
      if (prev.traded_in_at) steps.push({ kind: 'traded_in', at: prev.traded_in_at });
      else if (prev.warranty_closed_reason === 'returned' || prev.warranty_closed_reason === 'returned_unsellable') {
        if (prev.warranty_closed_at) steps.push({ kind: 'returned', at: prev.warranty_closed_at });
      }
    }
    if (u.delivered_at) steps.push({ kind: steps.length ? 'resold' : 'first', at: u.delivered_at });
    if (u.traded_in_at) steps.push({ kind: 'traded_in', at: u.traded_in_at });
    out.set(u.id, steps);
  }
  return out;
}
