/**
 * ELIGIBILITY, LOADED AND KEPT — the I/O around worker/lib/eligibility.ts.
 *
 * The pure function decides; this module only
 *
 *   1. LOADS its inputs in a fixed number of queries whatever the count
 *      (every id list travels as ONE json_each parameter, so D1's 100-bound-
 *      parameter limit never applies, and no query here chains compound
 *      SELECTs),
 *   2. PERSISTS each verdict in `community_request_matches`, stamped with the
 *      request revision it was decided for (0132),
 *   3. RE-MATCHES when an input moves — a request revision, or a workshop's
 *      printers, stock, preferences or delivery — inline and bounded, with a
 *      queue row (`community_match_queue`) that the scheduled sweep finishes
 *      if the inline pass could not,
 *   4. NOTIFIES the merchants who are eligible AND want to hear, through the
 *      merchant notice door (W2-E), once per request.
 *
 * THE AUTHORITY IS ALWAYS A FRESH VERDICT. `liveVerdict` computes one
 * merchant × one request from the database as it stands and writes the row;
 * the offer route, the file policy and the costing route ask it, never an old
 * row. The persisted rows serve the board's «مناسب لي» list and the
 * notification record, and a row decided for an older revision is read by
 * nobody (`m.revision = r.revision`).
 */

import type { Env } from './types';
import { newId } from './crypto';
import { HttpError } from './http';
import { getSetting } from './settings';
import { usersWithEntitlement } from './entitlements';
import { onPublicBoard, type RequestForAccess } from './communityRequests';
import { effectiveMaterial, effectiveProcess, parseDims } from './requestRevisions';
import { safeParse } from './types';
import {
  EMPTY_PREFS,
  QUALITIES,
  evaluateEligibility,
  type CapabilityPrinter,
  type CatalogueMaterial,
  type EligibilityCandidate,
  type EligibilityRequest,
  type EligibilityResult,
  type MerchantPrefs,
  type Process,
  type Quality,
  type ReachConfig,
  type StockLine,
} from './eligibility';
import { rankScore, type MatchWeights, type RankSignals } from './printMatchingScore';
import {
  normalizeStoredProfile,
  normalizeStoredRule,
  profileFromLegacySettings,
  type MerchantDeliveryRule,
} from '@levonis/shipping/merchantDelivery';
import { normalizeGovernorate } from '@levonis/shipping/iraqGovernorates';
import { fanOutMerchantNotice, matchingRequestNotice, type MerchantNotice } from './merchantNotify';
import { notifyStatement } from './notifications';

/** The engine that writes a row: 2 = eligibility.ts (0132 `engine`). */
export const MATCH_ENGINE = 2;
/** Statements per D1 batch — the cap the rest of the codebase sends in. */
const BATCH = 90;
/** A workshop re-match looks at the newest open requests, this many per pass. */
export const MERCHANT_REMATCH_REQUESTS = 300;
/** New notices one workshop re-match may send (a new printer must not ring the phone 40 times). */
export const MERCHANT_REMATCH_NOTICES = 5;

const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------- the catalogue

/** The `printMaterials` catalogue — the vocabulary requests, printers and stock share. */
export async function loadCatalogue(db: D1Database): Promise<Map<string, CatalogueMaterial>> {
  const mats = (await getSetting(db, 'printMaterials')) as unknown as Array<Record<string, unknown>>;
  const out = new Map<string, CatalogueMaterial>();
  for (const m of mats ?? []) {
    if (!m || typeof m.id !== 'string') continue;
    out.set(m.id, {
      id: m.id,
      process: m.process === 'resin' ? 'resin' : 'fdm',
      needs_enclosure: !!m.needs_enclosure,
      abrasive: !!m.abrasive,
    });
  }
  return out;
}

// --------------------------------------------------------------- requests

export interface RequestFacts extends EligibilityRequest {
  title: string;
  state: string;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

/** The facts of each request, as the matcher reads them — one query for the lot. */
export async function loadRequestFacts(db: D1Database, ids: string[], at: string = nowIso()): Promise<Map<string, RequestFacts>> {
  const out = new Map<string, RequestFacts>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return out;
  const { results } = await db
    .prepare(
      `SELECT r.id, r.customer_id, r.title, r.state, r.visibility, r.expires_at, r.revision,
              r.governorate, r.delivery_pref, r.quantity,
              p.request_id AS print_id, p.process, p.process_unsure, p.material_id, p.material_unsure,
              p.color_hex, p.quality, p.colors_count, p.analysis, p.stated_dims, p.estimate
         FROM community_requests r
         LEFT JOIN community_print_requests p ON p.request_id = r.id
        WHERE r.id IN (SELECT value FROM json_each(?))`
    )
    .bind(JSON.stringify(unique))
    .all<Record<string, unknown>>();
  for (const r of results ?? []) {
    const print = r.print_id ? r : null;
    const analysis = safeParse<Record<string, unknown> | null>(r.analysis, null);
    const measured = analysis && analysis.measured && analysis.dimensions_mm && typeof analysis.dimensions_mm === 'object'
      ? (analysis.dimensions_mm as { x: number; y: number; z: number })
      : null;
    const dims = measured && measured.x > 0 && measured.y > 0 && measured.z > 0 ? measured : parseDims(r.stated_dims);
    const estimate = safeParse<Record<string, unknown>>(r.estimate, {});
    const process = effectiveProcess(print);
    const material = effectiveMaterial(print);
    // A price or a weight across materials nobody chose is not one job's figure.
    const firm = !!estimate.priced && !!process && !!material;
    const quality = String(r.quality ?? 'standard') as Quality;
    out.set(String(r.id), {
      id: String(r.id),
      customer_id: String(r.customer_id ?? ''),
      title: String(r.title ?? ''),
      state: String(r.state ?? ''),
      revision: Number(r.revision ?? 1) || 1,
      on_board: onPublicBoard(
        {
          id: String(r.id),
          customer_id: String(r.customer_id ?? ''),
          state: String(r.state ?? ''),
          visibility: String(r.visibility ?? ''),
          expires_at: (r.expires_at as string | null) ?? null,
        } satisfies RequestForAccess,
        at
      ),
      process,
      material_id: material,
      color_hex: String(r.color_hex ?? '').toLowerCase(),
      quality: QUALITIES.includes(quality) ? quality : 'standard',
      colors_count: Math.max(1, Number(r.colors_count ?? 1) || 1),
      dims_mm: dims,
      grams: firm ? num(estimate.material_grams) : null,
      governorate: normalizeGovernorate(r.governorate) || String(r.governorate ?? ''),
      delivery_pref: r.delivery_pref === 'delivery' || r.delivery_pref === 'pickup' ? r.delivery_pref : '',
      estimate_iqd: firm ? num(estimate.price_iqd) : null,
      quantity: Math.max(1, Number(r.quantity ?? 1) || 1),
    });
  }
  return out;
}

// -------------------------------------------------------------- workshops

export interface Candidate extends EligibilityCandidate, RankSignals {
  /** The printers with their display names, for the verdict screens. */
  printer_names: Map<string, string>;
}

const parseList = (raw: unknown): string[] => {
  const v = safeParse<unknown>(raw, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

/**
 * A printer's physics, RESOLVED: the canonical model's where the printer is
 * tied to one (0078 §2 — «economics yes, physics no»), else what the merchant
 * declared. Resin has no nozzle; a fitted multi-material system counts only as
 * far as the machine can drive one.
 */
export function resolvePrinter(p: Record<string, unknown>): CapabilityPrinter {
  const linked = !!p.m_id;
  const technology: Process = (linked ? p.m_technology : p.technology) === 'resin' ? 'resin' : 'fdm';
  const quality = String(p.quality_max ?? 'fine') as Quality;
  const nozzles = linked ? safeParse<unknown[]>(p.m_nozzle_sizes, []).map(Number).filter((n) => n > 0) : [];
  const declaredNozzle = Number(p.nozzle_mm ?? 0.4) || 0.4;
  const nozzle = technology === 'resin'
    ? 0
    : linked
      ? nozzles.includes(declaredNozzle) ? declaredNozzle : Number(p.m_default_nozzle_mm ?? 0.4) || 0.4
      : declaredNozzle;
  const maxMaterials = Math.max(1, Number(p.m_max_simultaneous_materials ?? 1) || 1);
  const multicolor = !!Number(p.multicolor ?? 0);
  const availability = ['available', 'busy', 'offline'].includes(String(p.availability))
    ? (String(p.availability) as CapabilityPrinter['availability'])
    : 'available';
  return {
    id: String(p.id),
    technology,
    build_x_mm: Number((linked ? p.m_build_x_mm : p.build_x_mm) ?? 0),
    build_y_mm: Number((linked ? p.m_build_y_mm : p.build_y_mm) ?? 0),
    build_z_mm: Number((linked ? p.m_build_z_mm : p.build_z_mm) ?? 0),
    nozzle_mm: nozzle,
    materials: parseList(p.materials),
    enclosed: linked ? !!Number(p.m_enclosed ?? 0) : !!Number(p.enclosed ?? 0),
    hardened_nozzle: !!Number(p.hardened_nozzle ?? 0) && (!linked || !!Number(p.m_hardened ?? 0)),
    max_colors: technology === 'resin' || !multicolor ? 1 : linked ? maxMaterials : 4,
    quality_max: QUALITIES.includes(quality) ? quality : 'fine',
    machine_hour_iqd: num(p.machine_hour_iqd),
    availability,
    active: !!Number(p.active ?? 1),
    canonical: linked,
  };
}

function readPrefs(p: Record<string, unknown> | undefined): MerchantPrefs {
  if (!p) return EMPTY_PREFS;
  return {
    processes: parseList(p.processes),
    materials: parseList(p.materials),
    colors: parseList(p.colors).map((x) => x.toLowerCase()),
    capabilities: parseList(p.capabilities),
    governorates: parseList(p.governorates),
    delivery: parseList(p.delivery),
    min_job_iqd: Number(p.min_job_iqd ?? 0) || 0,
    max_job_iqd: num(p.max_job_iqd),
    min_size_mm: Number(p.min_size_mm ?? 0) || 0,
    max_size_mm: num(p.max_size_mm),
    workload: (['light', 'normal', 'busy', 'full'].includes(String(p.workload)) ? p.workload : 'normal') as MerchantPrefs['workload'],
    paused: !!Number(p.paused ?? 0),
    paused_until: (p.paused_until as string | null) ?? null,
  };
}

/** The owners whose plan carries the store AND community offers (the `merchantTakesNewWork` bar), 80 ids a query. */
async function plannedOwners(db: D1Database, userIds: string[]): Promise<Set<string>> {
  const ok = new Set<string>();
  for (let i = 0; i < userIds.length; i += 80) {
    const chunk = userIds.slice(i, i + 80);
    const [store, offers] = await Promise.all([
      usersWithEntitlement(db, chunk, 'merchantStore'),
      usersWithEntitlement(db, chunk, 'communityOffers'),
    ]);
    for (const id of chunk) if (store.has(id) && offers.has(id)) ok.add(id);
  }
  return ok;
}

/**
 * Workshops with everything eligibility reads: status, store, plan, printers
 * (resolved), stock, delivery reach, preferences and the notification switch.
 * `merchantIds` = these merchants whatever their status (a live verdict must
 * be able to say MERCHANT_INACTIVE); omitted = every ACTIVE merchant (the
 * publish and the request re-match — an inactive one cannot be eligible).
 */
export async function loadCandidates(db: D1Database, merchantIds?: string[]): Promise<Candidate[]> {
  const merchants = merchantIds
    ? await db
        .prepare(
          `SELECT m.id, m.user_id, m.status, m.governorate, m.rating_avg_x100, m.rating_count, m.completed_orders,
                  s.id AS store_id, s.status AS store_status, s.accepts_custom_requests,
                  s.governorate AS store_governorate, s.delivery_settings,
                  COALESCE(np.request_opportunities, 1) AS request_opportunities
             FROM community_merchants m
             LEFT JOIN merchant_stores s ON s.merchant_id = m.id
             LEFT JOIN merchant_notification_preferences np ON np.merchant_id = m.id
            WHERE m.id IN (SELECT value FROM json_each(?))`
        )
        .bind(JSON.stringify([...new Set(merchantIds)]))
        .all<Record<string, unknown>>()
    : await db
        .prepare(
          `SELECT m.id, m.user_id, m.status, m.governorate, m.rating_avg_x100, m.rating_count, m.completed_orders,
                  s.id AS store_id, s.status AS store_status, s.accepts_custom_requests,
                  s.governorate AS store_governorate, s.delivery_settings,
                  COALESCE(np.request_opportunities, 1) AS request_opportunities
             FROM community_merchants m
             LEFT JOIN merchant_stores s ON s.merchant_id = m.id
             LEFT JOIN merchant_notification_preferences np ON np.merchant_id = m.id
            WHERE m.status = 'active'`
        )
        .all<Record<string, unknown>>();
  const rows = merchants.results ?? [];
  if (!rows.length) return [];
  const ids = JSON.stringify(rows.map((m) => String(m.id)));
  const storeIds = JSON.stringify(rows.map((m) => m.store_id).filter((x): x is string => typeof x === 'string'));

  const [printers, prefs, stock, profiles, rules, planned] = await Promise.all([
    db
      .prepare(
        `SELECT p.*, pm.id AS m_id, pm.technology AS m_technology,
                pm.build_x_mm AS m_build_x_mm, pm.build_y_mm AS m_build_y_mm, pm.build_z_mm AS m_build_z_mm,
                pm.nozzle_sizes AS m_nozzle_sizes, pm.default_nozzle_mm AS m_default_nozzle_mm,
                pm.enclosed AS m_enclosed, pm.hardened_nozzle_available AS m_hardened,
                pm.max_simultaneous_materials AS m_max_simultaneous_materials
           FROM merchant_printers p
           LEFT JOIN printer_models pm ON pm.id = p.model_id
          WHERE p.active = 1 AND p.merchant_id IN (SELECT value FROM json_each(?))
          ORDER BY p.sort_order, p.created_at`
      )
      .bind(ids)
      .all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM merchant_request_prefs WHERE merchant_id IN (SELECT value FROM json_each(?))').bind(ids).all<Record<string, unknown>>(),
    db
      .prepare('SELECT merchant_id, material_id, color_hex, grams FROM merchant_material_stock WHERE merchant_id IN (SELECT value FROM json_each(?))')
      .bind(ids)
      .all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM merchant_delivery_profiles WHERE store_id IN (SELECT value FROM json_each(?))').bind(storeIds).all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM merchant_delivery_rules WHERE store_id IN (SELECT value FROM json_each(?))').bind(storeIds).all<Record<string, unknown>>(),
    plannedOwners(db, [...new Set(rows.map((m) => String(m.user_id)))]),
  ]);

  const printersBy = new Map<string, Record<string, unknown>[]>();
  for (const p of printers.results ?? []) {
    const k = String(p.merchant_id);
    printersBy.set(k, [...(printersBy.get(k) ?? []), p]);
  }
  const prefsBy = new Map((prefs.results ?? []).map((p) => [String(p.merchant_id), p]));
  const stockBy = new Map<string, StockLine[]>();
  for (const s of stock.results ?? []) {
    const k = String(s.merchant_id);
    stockBy.set(k, [...(stockBy.get(k) ?? []), {
      material_id: String(s.material_id),
      color_hex: String(s.color_hex ?? '').toLowerCase(),
      grams: Math.max(0, Number(s.grams ?? 0) || 0),
    }]);
  }
  const profileBy = new Map((profiles.results ?? []).map((p) => [String(p.store_id), normalizeStoredProfile(p)]));
  const rulesBy = new Map<string, MerchantDeliveryRule[]>();
  for (const r of rules.results ?? []) {
    const rule = normalizeStoredRule(r);
    if (!rule) continue;
    const k = String(r.store_id);
    rulesBy.set(k, [...(rulesBy.get(k) ?? []), rule]);
  }

  return rows.map((m) => {
    const id = String(m.id);
    const storeId = (m.store_id as string | null) ?? null;
    const reach: ReachConfig = {
      // A store with no profile row is served from its wave-1 JSON as version
      // 0 — the same reading the checkout gives it (worker/lib/merchantDelivery.ts).
      profile: (storeId && profileBy.get(storeId)) || profileFromLegacySettings(m.delivery_settings),
      rules: (storeId && rulesBy.get(storeId)) || [],
    };
    const own = printersBy.get(id) ?? [];
    const lines = stockBy.get(id);
    return {
      merchant_id: id,
      user_id: String(m.user_id),
      merchant_status: String(m.status ?? ''),
      store_status: String(m.store_status ?? ''),
      store_id: storeId,
      accepts_custom_requests: m.accepts_custom_requests === null || m.accepts_custom_requests === undefined
        ? false
        : !!Number(m.accepts_custom_requests),
      plan_ok: planned.has(String(m.user_id)),
      printers: own.map(resolvePrinter),
      printer_names: new Map(own.map((p) => [String(p.id), String(p.name ?? '')])),
      stock: lines && lines.length ? lines : 'untracked',
      reach,
      prefs: readPrefs(prefsBy.get(id)),
      request_opportunities: !!Number(m.request_opportunities ?? 1),
      governorate: normalizeGovernorate(m.store_governorate || m.governorate) || String(m.store_governorate || m.governorate || ''),
      rating_avg_x100: Number(m.rating_avg_x100 ?? 0) || 0,
      rating_count: Number(m.rating_count ?? 0) || 0,
      completed_orders: Number(m.completed_orders ?? 0) || 0,
      // Not measured anywhere in the platform yet: `null` is the honest value
      // and ranks mid-table; nothing is invented for it (audit 03 §5).
      response_minutes: null,
      trouble_rate: 0,
      pro: false,
    };
  });
}

// ----------------------------------------------------------------- verdicts

export interface Verdict extends EligibilityResult {
  merchant_id: string;
  user_id: string;
  score: number;
  detail: Record<string, number>;
}

export function verdictFor(
  m: Candidate,
  req: EligibilityRequest,
  catalogue: ReadonlyMap<string, CatalogueMaterial>,
  weights: MatchWeights,
  now: number
): Verdict {
  const v = evaluateEligibility(m, req, catalogue, now);
  const printer = v.eligible ? m.printers.find((p) => p.id === v.printer_id) ?? null : null;
  const ranked = printer
    ? rankScore(req, printer, m, req.material_id ? catalogue.get(req.material_id) ?? null : null, weights)
    : { score: 0, detail: {} };
  return { ...v, merchant_id: m.merchant_id, user_id: m.user_id, ...ranked };
}

/**
 * THE ROW. One per (request, merchant), rewritten with each verdict and
 * stamped with the revision it was decided for. A merchant told once STAYS
 * told, with the id of the notification that really reached them (audit 03
 * §10 U) — `notified` only ever rises.
 */
export function verdictStatement(
  db: D1Database,
  requestId: string,
  revision: number,
  v: Verdict,
  notificationId: string | null,
  ts: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO community_request_matches
         (id, request_id, merchant_id, eligible, reject_reason, score, score_detail, notified, notification_id,
          revision, reasons, printer_id, notify_ok, engine, computed_at, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)
       ON CONFLICT (request_id, merchant_id) DO UPDATE SET
         eligible = excluded.eligible, reject_reason = excluded.reject_reason,
         score = excluded.score, score_detail = excluded.score_detail,
         revision = excluded.revision, reasons = excluded.reasons, printer_id = excluded.printer_id,
         notify_ok = excluded.notify_ok, engine = excluded.engine, computed_at = excluded.computed_at,
         notification_id = CASE WHEN community_request_matches.notified = 1
                                THEN community_request_matches.notification_id
                                ELSE excluded.notification_id END,
         notified = MAX(community_request_matches.notified, excluded.notified)`
    )
    .bind(
      newId('mch'), requestId, v.merchant_id, v.eligible ? 1 : 0, v.reason, v.score, JSON.stringify(v.detail),
      notificationId ? 1 : 0, notificationId, revision, JSON.stringify(v.reasons), v.printer_id || null,
      v.notify ? 1 : 0, MATCH_ENGINE, ts
    );
}

async function sendInBatches(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += BATCH) await db.batch(stmts.slice(i, i + BATCH));
}

/** The words of a re-match notice — composed from the job's own title, which the reader sees as the customer wrote it. */
export function rematchNoticeText(title: string): { title: { ar: string; en: string }; body: { ar: string; en: string } } {
  const t = title.replace(/\s+/g, ' ').trim().slice(0, 80) || '—';
  // The customer's words are isolated (FSI…PDI) so a Latin title inside an
  // Arabic sentence, or the reverse, is never reordered.
  return {
    title: { ar: 'طلب طباعة يناسب ورشتك', en: 'A print request fits your workshop' },
    body: { ar: `⁨${t}⁩ — افتحه لتقدّم عرضك.`, en: `⁨${t}⁩ — open it to make your offer.` },
  };
}

type NoticeText = { title: { ar: string; en: string; ckb?: string }; body: { ar: string; en: string; ckb?: string } };

/** The notice for one verdict: in-app in the verdicts' batch, outside channels after (per the merchant's switch). */
function noticeFor(requestId: string, text: NoticeText, v: Verdict): MerchantNotice {
  return matchingRequestNotice(requestId, text, { score: v.score, printer_id: v.printer_id });
}

/** The in-app row, with the id it will carry — the verdict row records that id. */
function inAppNotice(db: D1Database, userId: string, n: MerchantNotice): { id: string; stmt: D1PreparedStatement } {
  return notifyStatement(db, {
    userId,
    kind: n.kind,
    title_ar: n.title_ar,
    title_en: n.title_en,
    body_ar: n.body_ar ?? '',
    body_en: n.body_en ?? '',
    link: n.link,
    entity_type: n.entity_type,
    entity_id: n.entity_id,
    meta: n.meta,
    eventKey: n.eventKey,
  });
}

// -------------------------------------------------------- re-match a request

export interface RequestMatchOutcome {
  considered: number;
  eligible: number;
  notified: number;
}

/**
 * DECIDE EVERY ACTIVE WORKSHOP FOR ONE REQUEST, record every verdict, and —
 * when `notify` — tell the best `limit` of those who are eligible, want to
 * hear and were not told before. The publish path calls it with the composed
 * match message; a revision or the queue calls it with the re-match notice.
 * A request that is not on the board records its verdicts (all
 * REQUEST_CLOSED) and tells nobody.
 */
export async function matchRequest(
  env: Env,
  requestId: string,
  opts: { notify: boolean; limit?: number; text?: NoticeText; now?: number } = { notify: true }
): Promise<RequestMatchOutcome> {
  const db = env.DB;
  const now = opts.now ?? Date.now();
  const ts = new Date(now).toISOString();
  const [facts, candidates, catalogue, weights, notifyLimit] = await Promise.all([
    loadRequestFacts(db, [requestId], ts),
    loadCandidates(db),
    loadCatalogue(db),
    getSetting(db, 'printMatchWeights'),
    getSetting(db, 'printMatchNotifyLimit'),
  ]);
  const req = facts.get(requestId);
  if (!req) return { considered: 0, eligible: 0, notified: 0 };
  const verdicts = candidates.map((m) => verdictFor(m, req, catalogue, weights as MatchWeights, now));

  const already = new Set<string>();
  if (opts.notify && req.on_board) {
    const { results } = await db
      .prepare('SELECT merchant_id FROM community_request_matches WHERE request_id = ? AND notified = 1')
      .bind(requestId)
      .all<{ merchant_id: string }>();
    for (const r of results ?? []) already.add(String(r.merchant_id));
  }
  const limit = Math.max(1, opts.limit ?? (Number(notifyLimit) || 25));
  const tell = opts.notify && req.on_board
    ? verdicts
        .filter((v) => v.notify && !already.has(v.merchant_id))
        .sort((a, b) => b.score - a.score || a.merchant_id.localeCompare(b.merchant_id))
        .slice(0, limit)
    : [];
  const text = opts.text ?? rematchNoticeText(req.title);
  const stmts: D1PreparedStatement[] = [];
  const told = new Map<string, string>();
  for (const v of tell) {
    const { id, stmt } = inAppNotice(db, v.user_id, noticeFor(requestId, text, v));
    stmts.push(stmt);
    told.set(v.merchant_id, id);
  }
  for (const v of verdicts) stmts.push(verdictStatement(db, requestId, req.revision, v, told.get(v.merchant_id) ?? null, ts));
  await sendInBatches(db, stmts);
  await Promise.all(tell.map((v) => fanOutMerchantNotice(env, { merchant_id: v.merchant_id, user_id: v.user_id }, noticeFor(requestId, text, v))));
  return { considered: verdicts.length, eligible: verdicts.filter((v) => v.eligible).length, notified: tell.length };
}

// ------------------------------------------------------- re-match a workshop

export interface MerchantMatchOutcome {
  requests: number;
  eligible: number;
  notified: number;
}

/**
 * DECIDE ONE WORKSHOP AGAINST THE OPEN BOARD — after its printers, stock,
 * preferences or delivery changed. The newest `MERCHANT_REMATCH_REQUESTS`
 * open requests, facts loaded 100 at a time; a request that newly became
 * eligible and wanted is told about, at most `MERCHANT_REMATCH_NOTICES` per
 * pass and never twice for the same request.
 */
export async function matchMerchant(env: Env, merchantId: string, opts: { now?: number } = {}): Promise<MerchantMatchOutcome> {
  const db = env.DB;
  const now = opts.now ?? Date.now();
  const ts = new Date(now).toISOString();
  const [candidates, catalogue, weights] = await Promise.all([
    loadCandidates(db, [merchantId]),
    loadCatalogue(db),
    getSetting(db, 'printMatchWeights'),
  ]);
  const m = candidates[0];
  if (!m) return { requests: 0, eligible: 0, notified: 0 };
  const { results: open } = await db
    .prepare(
      `SELECT r.id FROM community_requests r
        WHERE r.state IN ('open','receiving_offers') AND r.visibility = 'public'
          AND (r.expires_at IS NULL OR r.expires_at = '' OR r.expires_at > ?)
        ORDER BY r.created_at DESC LIMIT ?`
    )
    .bind(ts, MERCHANT_REMATCH_REQUESTS)
    .all<{ id: string }>();
  const ids = (open ?? []).map((r) => String(r.id));
  const { results: toldRows } = await db
    .prepare(
      `SELECT request_id FROM community_request_matches
        WHERE merchant_id = ? AND notified = 1 AND request_id IN (SELECT value FROM json_each(?))`
    )
    .bind(merchantId, JSON.stringify(ids))
    .all<{ request_id: string }>();
  const already = new Set((toldRows ?? []).map((r) => String(r.request_id)));

  let eligible = 0;
  const fresh: Array<{ req: RequestFacts; v: Verdict }> = [];
  const verdicts: Array<{ req: RequestFacts; v: Verdict }> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const facts = await loadRequestFacts(db, ids.slice(i, i + 100), ts);
    for (const req of facts.values()) {
      const v = verdictFor(m, req, catalogue, weights as MatchWeights, now);
      verdicts.push({ req, v });
      if (v.eligible) eligible += 1;
      if (v.notify && req.on_board && !already.has(req.id)) fresh.push({ req, v });
    }
  }
  const tell = fresh.slice(0, MERCHANT_REMATCH_NOTICES);
  const toldIds = new Map<string, string>();
  const stmts: D1PreparedStatement[] = [];
  for (const t of tell) {
    const { id, stmt } = inAppNotice(db, m.user_id, noticeFor(t.req.id, rematchNoticeText(t.req.title), t.v));
    stmts.push(stmt);
    toldIds.set(t.req.id, id);
  }
  for (const { req, v } of verdicts) stmts.push(verdictStatement(db, req.id, req.revision, v, toldIds.get(req.id) ?? null, ts));
  await sendInBatches(db, stmts);
  for (const t of tell) {
    await fanOutMerchantNotice(env, { merchant_id: m.merchant_id, user_id: m.user_id }, noticeFor(t.req.id, rematchNoticeText(t.req.title), t.v));
  }
  return { requests: verdicts.length, eligible, notified: tell.length };
}

// ------------------------------------------------------------ the authority

export interface LiveVerdict {
  verdict: Verdict;
  request: RequestFacts;
  candidate: Candidate;
}

/**
 * THE AUTHORITY: this workshop × this request, decided NOW from the database
 * as it stands, and written to the row (so an offer's INSERT can fence on it
 * in the same breath). Null when either does not exist.
 */
export async function liveVerdict(env: Env, requestId: string, merchantId: string, now: number = Date.now()): Promise<LiveVerdict | null> {
  const db = env.DB;
  const ts = new Date(now).toISOString();
  const [facts, candidates, catalogue, weights] = await Promise.all([
    loadRequestFacts(db, [requestId], ts),
    loadCandidates(db, [merchantId]),
    loadCatalogue(db),
    getSetting(db, 'printMatchWeights'),
  ]);
  const request = facts.get(requestId);
  const candidate = candidates[0];
  if (!request || !candidate) return null;
  const verdict = verdictFor(candidate, request, catalogue, weights as MatchWeights, now);
  await verdictStatement(db, requestId, request.revision, verdict, null, ts).run();
  return { verdict, request, candidate };
}

/** The live verdict for the merchant a signed-in account owns, or null (not a merchant, no such request). */
export async function liveVerdictForUser(env: Env, requestId: string, userId: string): Promise<LiveVerdict | null> {
  const m = await env.DB.prepare('SELECT id FROM community_merchants WHERE user_id = ?').bind(userId).first<{ id: string }>();
  return m ? liveVerdict(env, requestId, String(m.id)) : null;
}

// ------------------------------------------------------------------ the queue

export type MatchSubject = 'request' | 'merchant';

/** Queue a subject for a re-match (coalesces: one row per subject, the newest stamp wins). */
export function enqueueMatchStatement(db: D1Database, kind: MatchSubject, subjectId: string, reason: string, ts: string = nowIso()): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO community_match_queue (kind, subject_id, reason, queued_at, attempts, last_error)
       VALUES (?1, ?2, ?3, ?4, 0, '')
       ON CONFLICT (kind, subject_id) DO UPDATE SET
         reason = excluded.reason, queued_at = excluded.queued_at, attempts = 0, last_error = ''`
    )
    .bind(kind, subjectId, reason.slice(0, 40), ts);
}

async function runSubject(env: Env, kind: MatchSubject, id: string): Promise<void> {
  if (kind === 'request') await matchRequest(env, id, { notify: true });
  else await matchMerchant(env, id);
}

/**
 * RE-MATCH NOW, AND LEAVE A NOTE IF IT FAILS. The queue row is written first;
 * it is removed only if its stamp is still the one written here — an edit
 * that arrives while this pass runs re-stamps the row, and the sweep picks it
 * up rather than losing it. Never throws: the change that asked for the
 * re-match has already committed.
 */
export async function rematchNow(env: Env, kind: MatchSubject, id: string, reason: string): Promise<boolean> {
  const ts = nowIso();
  try {
    await enqueueMatchStatement(env.DB, kind, id, reason, ts).run();
    await runSubject(env, kind, id);
    await env.DB.prepare('DELETE FROM community_match_queue WHERE kind = ? AND subject_id = ? AND queued_at = ?').bind(kind, id, ts).run();
    return true;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    console.error(`re-match of ${kind} ${id} left to the sweep:`, msg);
    await env.DB.prepare('UPDATE community_match_queue SET attempts = attempts + 1, last_error = ? WHERE kind = ? AND subject_id = ?')
      .bind(msg, kind, id)
      .run()
      .catch(() => {});
    return false;
  }
}

export interface MatchQueueReport {
  requests: number;
  merchants: number;
  failed: number;
  errors: string[];
}

/**
 * THE SWEEP: finish what the inline passes left, oldest first, a few
 * subjects a tick (a request re-match reads every active workshop, a workshop
 * re-match up to 300 requests). A subject that keeps failing is retried with
 * the others, and reported.
 */
export async function drainMatchQueue(env: Env, opts: { limit?: number } = {}): Promise<MatchQueueReport> {
  const report: MatchQueueReport = { requests: 0, merchants: 0, failed: 0, errors: [] };
  const { results } = await env.DB.prepare(
    `SELECT kind, subject_id, queued_at FROM community_match_queue
      WHERE attempts < 20 ORDER BY attempts, queued_at LIMIT ?`
  )
    .bind(Math.max(1, opts.limit ?? 8))
    .all<{ kind: MatchSubject; subject_id: string; queued_at: string }>();
  for (const row of results ?? []) {
    try {
      await runSubject(env, row.kind, row.subject_id);
      await env.DB.prepare('DELETE FROM community_match_queue WHERE kind = ? AND subject_id = ? AND queued_at = ?')
        .bind(row.kind, row.subject_id, row.queued_at)
        .run();
      if (row.kind === 'request') report.requests += 1;
      else report.merchants += 1;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      report.failed += 1;
      report.errors.push(`${row.kind} ${row.subject_id}: ${msg}`);
      await env.DB.prepare('UPDATE community_match_queue SET attempts = attempts + 1, last_error = ? WHERE kind = ? AND subject_id = ?')
        .bind(msg, row.kind, row.subject_id)
        .run()
        .catch(() => {});
    }
  }
  return report;
}

/** Is a re-match of this workshop waiting? The board drains it first, so «مناسب لي» is never behind the workshop's own edit. */
export async function merchantRematchPending(db: D1Database, merchantId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM community_match_queue WHERE kind = 'merchant' AND subject_id = ?`)
    .bind(merchantId)
    .first();
  return !!row;
}

/**
 * THE OFFER GATE: the live verdict, or `403 OFFER_NOT_ELIGIBLE` carrying the
 * reasons (stable codes the client words — never a sentence of ours). Asked
 * after the route's own checks (the request exists, is on the board, is not
 * the merchant's own), so their older, more specific codes still answer
 * first. The verdict row it writes is what the offer's INSERT fences on.
 */
export async function assertMayOffer(env: Env, requestId: string, merchantId: string): Promise<LiveVerdict> {
  const live = await liveVerdict(env, requestId, merchantId);
  if (!live) throw new HttpError(404, 'Request not found');
  if (!live.verdict.eligible) {
    throw new HttpError(403, 'Your workshop cannot take this request', 'OFFER_NOT_ELIGIBLE', {
      reason: live.verdict.reason,
      reasons: live.verdict.reasons,
    });
  }
  return live;
}

/**
 * The fence an offer write carries: the verdict row for THIS request revision
 * says eligible. Written by `assertMayOffer` a moment earlier; a revision
 * landing in between leaves it behind and the write matches nothing.
 * `requestAlias` is the request table's alias in the caller's statement.
 */
export function eligibleVerdictSql(requestAlias: string, merchantParam: string): string {
  return `EXISTS (SELECT 1 FROM community_request_matches vm
                   WHERE vm.request_id = ${requestAlias}.id AND vm.merchant_id = ${merchantParam}
                     AND vm.eligible = 1 AND vm.engine >= ${MATCH_ENGINE} AND vm.revision = ${requestAlias}.revision)`;
}
