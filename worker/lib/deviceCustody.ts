/**
 * WHO HAS THE DEVICE, AND WHICH WARRANTY IT CARRIES — owner decision 3
 * (2026-10-09; docs/DECISIONS.md row 193): a trade-in does NOT close the
 * device's warranty. It stays with the same serial and runs from the
 * ORIGINAL order's delivery date; a resale passes the same warranty on, with
 * its original start and end — never a new one, never from zero.
 *
 * THE TRADED-IN STATE IS DERIVED, NEVER WRITTEN. A unit was traded in when a
 * `trade_in_requests` row for its slot (order_item_id, unit_index) — or for
 * the slot of a unit it REPLACED under warranty, the device the customer
 * actually handed over — is
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
 * How many warranty replacements back a unit's slot is searched. A
 * replacement unit (`replacement_of_unit_id`, devices.ts «replace») sits on
 * the SAME order line under a new `unit_index` (MAX + 1), while the trade-in
 * request names the slot the customer bought (1..qty). Four replacements of
 * one device is far past anything the shop has seen; past it the slot simply
 * stops matching (the unit reads as not traded in).
 */
export const MAX_REPLACEMENT_HOPS = 4;

/** The `unit_index` of the `hops`-th unit `alias` replaced, as a scalar SQL expression (NULL when there is none). */
function replacedSlotSql(alias: string, hops: number): string {
  const joins: string[] = [];
  for (let i = 2; i <= hops; i++) joins.push(`JOIN order_item_units tir${i} ON tir${i}.id = tir${i - 1}.replacement_of_unit_id`);
  return `(SELECT tir${hops}.unit_index FROM order_item_units tir1 ${joins.join(' ')} WHERE tir1.id = ${alias}.replacement_of_unit_id)`;
}

/**
 * When the unit `alias` was traded in (the first completed request), or NULL.
 * A scalar SQL expression over `alias.order_item_id` / `alias.unit_index` /
 * `alias.replacement_of_unit_id`.
 *
 * The request names the SLOT the customer bought; the device in their hands
 * may be a warranty replacement of that slot's unit (a new `unit_index` on
 * the same line). So a request for the slot of `alias` — or of any unit
 * `alias` replaced, up to MAX_REPLACEMENT_HOPS back — makes `alias` traded
 * in: the live end of the chain is the device the customer handed over.
 */
export const tradedInSql = (alias: string) => {
  const slots = [`${alias}.unit_index`];
  for (let h = 1; h <= MAX_REPLACEMENT_HOPS; h++) slots.push(replacedSlotSql(alias, h));
  return `(SELECT t.completed_at FROM trade_in_requests t
     WHERE t.order_item_id = ${alias}.order_item_id AND t.unit_index IN (${slots.join(', ')})
       AND t.status = 'completed' AND t.scope <> 'ams_only'
     ORDER BY t.completed_at LIMIT 1)`;
};

/**
 * The LIVE unit of a slot: the slot's own unit, or the end of its warranty-
 * replacement chain (`replaced_by_unit_id`). This is the device a trade-in of
 * that slot takes (owner decision 3): its link, its serial binding, its audit.
 * Null when the slot has no unit.
 */
export async function liveUnitOfSlot<T extends { id: string; replaced_by_unit_id: string | null }>(
  db: D1Database,
  orderItemId: string,
  unitIndex: number,
  cols: string
): Promise<T | null> {
  let unit = await db
    .prepare(`SELECT ${cols}, u.replaced_by_unit_id FROM order_item_units u WHERE u.order_item_id = ? AND u.unit_index = ?`)
    .bind(orderItemId, unitIndex)
    .first<T>();
  for (let hop = 0; unit && unit.replaced_by_unit_id && hop < MAX_REPLACEMENT_HOPS; hop++) {
    const next = await db
      .prepare(`SELECT ${cols}, u.replaced_by_unit_id FROM order_item_units u WHERE u.id = ?`)
      .bind(unit.replaced_by_unit_id)
      .first<T>();
    if (!next) break;
    unit = next;
  }
  return unit ?? null;
}

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
 * original window first; when it is over — or when the used-sale period runs
 * longer — a used-sale period that still runs keeps the unit covered. A
 * closed unit stays closed. `via` names the cover the answer is about and
 * `end_at` is THAT cover's end, so a screen draws the dates the remaining
 * days were counted to (never the original end beside used-sale days).
 */
export function unitCoverage(
  unit: { delivered_at: string | null; warranty_end_at: string | null; policy_version?: unknown },
  nowMs = Date.now(),
  closedAt: string | null = null
): { state: CoverageState; remaining_days: number | null; via: 'original' | 'used_sale'; end_at: string | null } {
  const base = coverageState(unit.delivered_at, unit.warranty_end_at, nowMs, closedAt);
  const original = { ...base, via: 'original' as const, end_at: unit.warranty_end_at };
  if (closedAt || base.state === 'not_delivered') return original;
  const used = unitIdentity(unit.policy_version).used_sale;
  if (!used) return original;
  const second = coverageState(used.start_at, used.end_at, nowMs);
  if (second.state !== 'active') return original;
  if (base.state === 'active' && (base.remaining_days ?? 0) >= (second.remaining_days ?? 0)) return original;
  return { state: 'active', remaining_days: second.remaining_days, via: 'used_sale', end_at: used.end_at };
}

// ---------------------------------------------------------------- the warranty's start

/**
 * THE DAY THE WARRANTY RUNS FROM, for a unit whose custody (`history`) is
 * already read. A unit that carries nothing runs from its own start. A
 * carried one runs from the origin it names; a resale recorded before the
 * origin was (`resale_of`, no `origin_start_at`) from the first delivery its
 * custody reaches. A warranty REPLACEMENT carries the original window in its
 * own start (devices.ts «replace» copies it), and its custody is only its
 * own delivery — so it runs from its own start, never from that delivery.
 */
export function originStartFrom(
  unit: { warranty_start_at: string | null; policy_version?: unknown },
  history: ReadonlyArray<CustodyStep> | null | undefined
): string | null {
  const identity = unitIdentity(unit.policy_version);
  if (!identity.carried) return unit.warranty_start_at;
  if (identity.origin_start_at) return identity.origin_start_at;
  if (identity.resale_of) return history?.find((h) => h.kind === 'first')?.at ?? unit.warranty_start_at;
  return unit.warranty_start_at;
}

/** `originStartFrom` for units whose custody is not read yet: one custody walk, only for the older resales that need it. */
export async function originStarts(
  db: D1Database,
  units: ReadonlyArray<{ id: string; delivered_at: string | null; warranty_start_at: string | null; policy_version?: unknown }>
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const walk = units.filter((u) => {
    const id = unitIdentity(u.policy_version);
    return id.carried && !id.origin_start_at && !!id.resale_of;
  });
  const histories = walk.length ? await custodyHistory(db, walk) : new Map<string, CustodyStep[]>();
  for (const u of units) out.set(u.id, originStartFrom(u, histories.get(u.id)));
  return out;
}

/**
 * THE UNIT A RESOLD DEVICE'S WARRANTY IS TAKEN FROM. Normally the previous
 * unit itself. But a resale whose delivery was undone and whose order was
 * then cancelled never happened for the device: its unit was closed
 * `order_cancelled` and its own extension (bought on that cancelled line) was
 * never sold. A device sold again from there carries the warranty that unit
 * carried — its `resale_of` — never a fresh one (owner decision 3) and never
 * the cancelled line's extension. Walks at most MAX_REPLACEMENT_HOPS such
 * cancelled sales; a unit re-delivered since is the device's live sale.
 */
export async function warrantySourceOf(db: D1Database, priorUnitId: string): Promise<PriorUnit | null> {
  let id: string | null = priorUnitId;
  let found: PriorUnit | null = null;
  for (let hop = 0; id && hop <= MAX_REPLACEMENT_HOPS; hop++) {
    const row: (PriorUnit & { warranty_closed_reason: string | null; order_status: string | null }) | null = await db
      .prepare(
        `SELECT u.id, u.delivered_at, u.warranty_start_at, u.warranty_end_at, u.warranty_base_months, u.warranty_ext_months,
                u.policy_version, u.warranty_closed_reason, o.status AS order_status
           FROM order_item_units u LEFT JOIN orders o ON o.id = u.order_id WHERE u.id = ?`
      )
      .bind(id)
      .first<PriorUnit & { warranty_closed_reason: string | null; order_status: string | null }>();
    if (!row) break;
    found = {
      id: row.id,
      delivered_at: row.delivered_at,
      warranty_start_at: row.warranty_start_at,
      warranty_end_at: row.warranty_end_at,
      warranty_base_months: row.warranty_base_months,
      warranty_ext_months: Number(row.warranty_ext_months) || 0,
      policy_version: row.policy_version,
    };
    const identity = unitIdentity(row.policy_version);
    const cancelledSale = row.warranty_closed_reason === 'order_cancelled' && row.order_status !== 'delivered';
    if (!(cancelledSale && identity.carried && identity.resale_of)) break;
    id = identity.resale_of;
  }
  return found;
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
