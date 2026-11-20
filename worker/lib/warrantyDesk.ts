/**
 * THE WARRANTY DESK'S FACTS — phase 8 (owner 2026-11-21, DECISIONS row 364).
 *
 * Staff who answer a customer must tell, for any device, in one glance: what he BOUGHT (no warranty / 12 / 24
 * months; Levo Care or not), what is IN FORCE today and until when, and — on a claim — which of the four
 * situations applies. Until this file no admin warranty screen read the printer services snapshot (0234): a
 * printer sold with no warranty showed a red «منتهي» and could be handed a 12-month receipt.
 *
 *   unitDeskFacts(db, units)       per unit: `services` (what the line sold, the inspection, the free-return fact),
 *                                  `care` (the Care window and what is left) and `cover` (what holds today)
 *   claimCoverVerdicts(db, claims) per claim, judged AT ITS FILING (W-1): under warranty / under warranty and Levo
 *                                  Care takes misuse / Levo Care after the warranty / not covered
 *   deskSummary(db)                the strip above the queue: open claims by kind and verdict, Care holders now and
 *                                  ending within 30 days, printers awaiting inspection, part offers live / used
 *
 * Reads only. Every statement tolerates a database one migration behind (0234 / 0236 / 0243): the fact is then
 * simply absent (`services: null`, `care: null`), never an error. No cost, margin or investor figure is read here.
 */
import { isSchemaMissing } from './membershipBenefits';
import { unitCoverage } from './deviceCustody';
import { closedClaimSql, soldServicesOf, unitMonthsExact, claimFiledColumnsInstalled, type SoldServices } from './deviceOps';
import { careClaimsInstalled, careEntitlements, careStateAt, careWindow, goodwillEndOf, type CareEntitlement, type CareState } from './careClaims';
import { SPENT_SQL, SPENT_AMOUNT_SQL } from './rewards/pool';

// ------------------------------------------------------------------ a unit

export interface DeskUnitInput {
  id: string;
  order_id?: string | null;
  order_item_id: string | null;
  delivered_at: string | null;
  warranty_base_months: number | null;
  warranty_ext_months: number;
  warranty_start_at: string | null;
  warranty_end_at: string | null;
  policy_version: unknown;
  warranty_closed_at?: string | null;
}

export interface DeskServices {
  /** What the customer bought with the printer. */
  package: string | null;
  warranty_months: 0 | 12 | 24;
  care: boolean;
  care_total_months: number;
  /** 'none' = not bought; 'pending' = bought, not done yet; 'done'. */
  inspection: 'none' | 'pending' | 'done';
  inspection_done_at: string | null;
  /** The owner's wording (phase 7): with a warranty «free return within 7 days»; Just Printer: no free return. Information only. */
  free_return: boolean;
  ack_no_warranty: boolean;
  order_id: string | null;
}

export interface DeskCare {
  state: CareState;
  start_at: string | null;
  care_only_from: string | null;
  end_at: string | null;
  warranty_months: number;
  total_months: number;
  claims_left: number | null;
  benefit_left_iqd: number | null;
  discount_pct: number | null;
}

export type DeskCoverNow = 'warranty' | 'care' | 'none' | 'not_delivered' | 'closed' | 'needs_config';

export interface DeskCover {
  /** What holds TODAY: the warranty; Levo Care alone (the warranty ended or none was bought); nothing. */
  now: DeskCoverNow;
  /** That cover's end. */
  until: string | null;
  /** The warranty by itself: 'none' = the customer bought no warranty (never «expired»). */
  warranty: 'active' | 'ended' | 'none' | 'not_delivered' | 'closed' | 'needs_config';
  warranty_end_at: string | null;
  /** The device's months today (0 = none), and the months SOLD when the line carried the services. */
  months: number | null;
  sold_months: number | null;
  /** An owner's goodwill change left the device with more months than were sold. */
  goodwill: boolean;
  /** Levo Care also takes a misuse fault while the warranty runs. */
  care_misuse: boolean;
}

export interface DeskUnitFacts {
  services: DeskServices | null;
  care: DeskCare | null;
  cover: DeskCover;
}

const deskCare = (e: CareEntitlement | undefined | null): DeskCare | null =>
  !e || e.state === 'none'
    ? null
    : {
        state: e.state,
        start_at: e.start_at,
        care_only_from: e.care_only_from,
        end_at: e.end_at,
        warranty_months: e.warranty_months,
        total_months: e.total_months,
        claims_left: e.claims_left,
        benefit_left_iqd: e.benefit_left_iqd,
        discount_pct: e.terms?.discount_pct ?? null,
      };

/** The cover of one unit at `nowMs`, from its own record, what its line sold and its Care. Pure. */
export function deskCover(unit: DeskUnitInput, sold: SoldServices | null, care: DeskCare | null, nowMs = Date.now()): DeskCover {
  const cov = unitCoverage(unit, nowMs, unit.warranty_closed_at ?? null);
  const months = unitMonthsExact(unit as never);
  const soldMonths = sold ? sold.warranty_months : null;
  const noneBought = months === 0;
  const warranty: DeskCover['warranty'] =
    cov.state === 'closed' ? 'closed'
      : cov.state === 'not_delivered' ? 'not_delivered'
        : cov.state === 'active' ? 'active'
          : noneBought ? 'none'
            : cov.state === 'needs_config' ? 'needs_config' : 'ended';
  const careActive = care?.state === 'active';
  const now: DeskCoverNow =
    warranty === 'closed' ? 'closed'
      : warranty === 'not_delivered' ? 'not_delivered'
        : warranty === 'active' ? 'warranty'
          : careActive ? 'care'
            : warranty === 'needs_config' ? 'needs_config' : 'none';
  return {
    now,
    until: now === 'warranty' ? cov.end_at : now === 'care' ? care!.end_at : null,
    warranty,
    warranty_end_at: noneBought ? null : cov.end_at,
    months,
    sold_months: soldMonths,
    // Only the owner's recorded goodwill — a resold device's carried warranty is not one.
    goodwill: soldMonths !== null && months !== null && months > soldMonths && !!goodwillEndOf({ warranty_end_at: unit.warranty_end_at, policy_version: unit.policy_version }),
    care_misuse: warranty === 'active' && careActive,
  };
}

/** `services`, `care` and `cover` for each unit of a page. Three reads for the whole page. */
export async function unitDeskFacts(db: D1Database, units: DeskUnitInput[], nowMs = Date.now()): Promise<Map<string, DeskUnitFacts>> {
  const out = new Map<string, DeskUnitFacts>();
  if (!units.length) return out;
  const lineIds = [...new Set(units.map((u) => u.order_item_id).filter((x): x is string => !!x))];
  const sold = new Map<string, SoldServices>();
  const inspection = new Map<string, { status: string; done_at: string | null }>();
  if (lineIds.length) {
    try {
      const { results } = await db
        .prepare('SELECT id, services_snapshot FROM order_items WHERE id IN (SELECT value FROM json_each(?)) AND services_snapshot IS NOT NULL')
        .bind(JSON.stringify(lineIds))
        .all<{ id: string; services_snapshot: string }>();
      for (const r of results ?? []) {
        const s = soldServicesOf(r.services_snapshot);
        if (s) sold.set(r.id, s);
      }
      if (sold.size) {
        const { results: tasks } = await db
          .prepare("SELECT order_item_id, status, done_at FROM order_service_tasks WHERE kind = 'inspection' AND order_item_id IN (SELECT value FROM json_each(?))")
          .bind(JSON.stringify([...sold.keys()]))
          .all<{ order_item_id: string; status: string; done_at: string | null }>();
        for (const t of tasks ?? []) inspection.set(t.order_item_id, { status: t.status, done_at: t.done_at });
      }
    } catch (e) {
      if (!isSchemaMissing(e)) throw e;
    }
  }
  const care = (await careClaimsInstalled(db)) ? await careEntitlements(db, units.map((u) => u.id), nowMs) : new Map<string, CareEntitlement>();
  for (const u of units) {
    const s = u.order_item_id ? sold.get(u.order_item_id) ?? null : null;
    const c = deskCare(care.get(u.id));
    const task = u.order_item_id ? inspection.get(u.order_item_id) : undefined;
    out.set(u.id, {
      services: s
        ? {
            package: s.package,
            warranty_months: s.warranty_months,
            care: s.care_months > 0,
            care_total_months: s.care_total_months,
            inspection: !s.inspection && !task ? 'none' : task?.status === 'done' ? 'done' : task?.status === 'cancelled' ? 'none' : 'pending',
            inspection_done_at: task?.status === 'done' ? task.done_at : null,
            free_return: s.warranty_months > 0,
            ack_no_warranty: s.ack_no_warranty,
            order_id: u.order_id ?? null,
          }
        : null,
      care: c,
      cover: deskCover(u, s, c, nowMs),
    });
  }
  return out;
}

// ------------------------------------------------------------------ a claim

/**
 * THE FOUR SITUATIONS, judged at the claim's filing:
 *   warranty       the warranty covered the device (and it holds no Care)
 *   warranty_care  the warranty covered it AND Levo Care was in force: a fault is the warranty's; misuse is Care's
 *   care           no warranty in force (ended, or none bought) and Levo Care was: a discount on parts
 *   none           neither — `warranty` says whether one ended or none was ever bought
 *   unknown        the claim names no device
 */
export type CoverVerdict = 'warranty' | 'warranty_care' | 'care' | 'none' | 'unknown';
export const COVER_VERDICTS: readonly CoverVerdict[] = ['warranty', 'warranty_care', 'care', 'none', 'unknown'];

export interface ClaimCover {
  verdict: CoverVerdict;
  warranty: 'active' | 'ended' | 'none' | 'not_delivered' | 'closed' | 'needs_config' | 'unknown';
  warranty_end_at: string | null;
  care: CareState | null;
  care_only_from: string | null;
  care_end_at: string | null;
}

export interface VerdictClaim {
  id: string;
  unit_id: string | null;
  created_at: string;
  filed_cover_state?: string | null;
  filed_cover_end_at?: string | null;
}

/** Pure: the verdict from the two covers at filing. */
export function coverVerdictOf(warranty: ClaimCover['warranty'], care: CareState | null): CoverVerdict {
  if (warranty === 'unknown') return 'unknown';
  const careOn = care === 'active';
  if (warranty === 'active') return careOn ? 'warranty_care' : 'warranty';
  return careOn ? 'care' : 'none';
}

export async function claimCoverVerdicts(db: D1Database, claims: VerdictClaim[]): Promise<Map<string, ClaimCover>> {
  const out = new Map<string, ClaimCover>();
  const unitIds = [...new Set(claims.map((c) => c.unit_id).filter((x): x is string => !!x))];
  const units = new Map<string, DeskUnitInput>();
  if (unitIds.length) {
    let closed = ', warranty_closed_at';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { results } = await db
          .prepare(
            `SELECT id, order_item_id, delivered_at, warranty_base_months, warranty_ext_months, warranty_start_at, warranty_end_at, policy_version${closed}
               FROM order_item_units WHERE id IN (SELECT value FROM json_each(?))`
          )
          .bind(JSON.stringify(unitIds))
          .all<DeskUnitInput>();
        for (const u of results ?? []) units.set(u.id, u);
        break;
      } catch (e) {
        if (attempt === 0 && /no such column/i.test(String((e as Error)?.message ?? e))) closed = '';
        else throw e;
      }
    }
  }
  // One Care read for the page (the windows and the terms); each claim is then judged at ITS filing instant.
  const care = unitIds.length && (await careClaimsInstalled(db)) ? await careEntitlements(db, unitIds) : new Map<string, CareEntitlement>();
  for (const c of claims) {
    const unit = c.unit_id ? units.get(c.unit_id) : undefined;
    if (!unit) {
      out.set(c.id, { verdict: 'unknown', warranty: 'unknown', warranty_end_at: null, care: null, care_only_from: null, care_end_at: null });
      continue;
    }
    const filedMs = Date.parse(c.created_at);
    const at = Number.isFinite(filedMs) ? filedMs : Date.now();
    const noneBought = unitMonthsExact(unit as never) === 0;
    let state: string;
    let end: string | null;
    if (c.filed_cover_state) {
      state = c.filed_cover_state;
      end = c.filed_cover_end_at ?? null;
    } else {
      const closedAt = unit.warranty_closed_at && Date.parse(unit.warranty_closed_at) <= at ? unit.warranty_closed_at : null;
      const cov = unitCoverage(unit, at, closedAt);
      state = cov.state;
      end = cov.end_at;
    }
    const warranty: ClaimCover['warranty'] =
      state === 'active' ? 'active'
        : state === 'closed' ? 'closed'
          : state === 'not_delivered' ? 'not_delivered'
            : noneBought ? 'none'
              : state === 'needs_config' ? 'needs_config' : 'ended';
    const ent = care.get(unit.id);
    const careState = ent && ent.state !== 'none' ? careStateAt(ent, at) : null;
    out.set(c.id, {
      verdict: coverVerdictOf(warranty, careState),
      warranty,
      warranty_end_at: warranty === 'none' ? null : end,
      care: careState,
      care_only_from: ent && careState ? ent.care_only_from : null,
      care_end_at: ent && careState ? ent.end_at : null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ the strip

export interface DeskSummary {
  open_claims: { total: number; warranty: number; care: number; by_verdict: Record<CoverVerdict, number> };
  /** Devices whose Levo Care is in force now, and those whose Care ends within 30 days. null without 0234. */
  care: { holders: number; ending_30d: number } | null;
  /** Printers (the lines' quantities) whose bought inspection is still open on a live order. null without 0234. */
  inspections_pending: number | null;
  /** Part offers: waiting in a customer's cart, and used on an order with the discount they gave. null without 0243. */
  part_offers: { live: number; used: number; used_discount_iqd: number } | null;
}

const DAY_MS = 86_400_000;

export async function deskSummary(db: D1Database, nowMs = Date.now()): Promise<DeskSummary> {
  const filed = (await claimFiledColumnsInstalled(db)) ? ', filed_cover_state, filed_cover_end_at' : '';
  const kind = (await careClaimsInstalled(db)) ? ', claim_kind' : '';
  const { results: open } = await db
    .prepare(`SELECT id, unit_id, created_at${filed}${kind} FROM warranty_claims wc WHERE NOT ${closedClaimSql('wc')} ORDER BY created_at DESC LIMIT 500`)
    .all<VerdictClaim & { claim_kind?: string | null }>();
  const verdicts = await claimCoverVerdicts(db, open ?? []);
  const byVerdict = Object.fromEntries(COVER_VERDICTS.map((v) => [v, 0])) as Record<CoverVerdict, number>;
  let careClaims = 0;
  for (const c of open ?? []) {
    byVerdict[verdicts.get(c.id)?.verdict ?? 'unknown']++;
    if (c.claim_kind === 'care') careClaims++;
  }

  let care: DeskSummary['care'] = null;
  let inspections: number | null = null;
  try {
    const { results } = await db
      .prepare(
        `SELECT u.delivered_at, u.warranty_end_at, u.policy_version, oi.services_snapshot
           FROM order_item_units u JOIN order_items oi ON oi.id = u.order_item_id
          WHERE oi.services_snapshot IS NOT NULL AND u.replacement_of_unit_id IS NULL AND u.delivered_at IS NOT NULL
            AND u.warranty_closed_at IS NULL
          LIMIT 5000`
      )
      .all<{ delivered_at: string; warranty_end_at: string | null; policy_version: string | null; services_snapshot: string }>();
    care = { holders: 0, ending_30d: 0 };
    for (const r of results ?? []) {
      const s = soldServicesOf(r.services_snapshot);
      if (!s || !(s.care_months > 0)) continue;
      const win = careWindow(r.delivered_at, { warranty_months: s.warranty_months, total_months: s.care_total_months }, goodwillEndOf(r));
      const end = win.end_at ? Date.parse(win.end_at) : NaN;
      if (!Number.isFinite(end) || end <= nowMs) continue;
      care.holders++;
      if (end - nowMs <= 30 * DAY_MS) care.ending_30d++;
    }
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(t.qty), 0) AS n FROM order_service_tasks t JOIN orders o ON o.id = t.order_id
          WHERE t.kind = 'inspection' AND t.status = 'open' AND o.status NOT IN ('cancelled', 'delivered')`
      )
      .first<{ n: number }>();
    inspections = Math.max(0, Math.trunc(Number(row?.n) || 0));
  } catch (e) {
    if (!isSchemaMissing(e) && !/no such column/i.test(String((e as Error)?.message ?? e))) throw e;
  }

  let partOffers: DeskSummary['part_offers'] = null;
  try {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN g.revoked_at IS NULL AND g.expires_at > ?1 AND NOT ${SPENT_SQL('g.coupon_id')} THEN 1 ELSE 0 END), 0) AS live,
                COALESCE(SUM(CASE WHEN ${SPENT_SQL('g.coupon_id')} THEN 1 ELSE 0 END), 0) AS used,
                COALESCE(SUM(CASE WHEN ${SPENT_SQL('g.coupon_id')} THEN ${SPENT_AMOUNT_SQL('g.coupon_id')} ELSE 0 END), 0) AS given
           FROM care_part_grants g`
      )
      .bind(new Date(nowMs).toISOString())
      .first<{ live: number; used: number; given: number }>();
    partOffers = { live: Number(row?.live) || 0, used: Number(row?.used) || 0, used_discount_iqd: Math.trunc(Number(row?.given) || 0) };
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
  }

  const total = (open ?? []).length;
  return {
    open_claims: { total, warranty: total - careClaims, care: careClaims, by_verdict: byVerdict },
    care,
    inspections_pending: inspections,
    part_offers: partOffers,
  };
}

/** Is the unit one the customer bought with NO warranty (and no goodwill since)? Reads the unit's own record. */
export function unitHasNoWarranty(unit: {
  warranty_base_months: number | null;
  warranty_ext_months: number;
  policy_version: unknown;
  warranty_start_at?: string | null;
  warranty_end_at?: string | null;
}): boolean {
  return unitMonthsExact(unit as never) === 0;
}
