/**
 * SMART MATCHING — the vocabulary, and the notification decision in the shape
 * the matcher has always returned.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE, in the owner's words:
 *
 *   "ONE published request → Smart Matching finds eligible merchants → ONLY
 *    notifications are sent to them → the notification opens that same request."
 *
 * So nothing here creates, copies, or reserves anything. It takes a request and
 * a list of merchants and returns a DECISION per merchant: told or not, and if
 * not, exactly why. There is no code path from this module to a request row.
 *
 * SINCE W5-B THE DECISION IS NOT MADE HERE. «Can this workshop make it» is
 * `evaluateEligibility` (worker/lib/eligibility.ts) — the one function behind
 * the board, offers, files, costing and notifications — and «who hears first»
 * is `rankScore` (worker/lib/printMatchingScore.ts). This module keeps the
 * types and the `decide()` / `matchMerchants()` answers the matcher always
 * gave (a decision per merchant, eligible = would be TOLD, a legacy reason
 * code), computed through those two, so nothing that read them changes
 * meaning. The routes read the richer verdict through
 * worker/lib/printMatchingStore.ts.
 */

import type { PrintMaterial, PrintProcess } from './printPricing';
import {
  CAPABILITIES as ELIGIBILITY_CAPABILITIES,
  evaluateEligibility,
  fitsInBuild as eligibilityFitsInBuild,
  jobCapabilities,
  printerCannot,
  type Capability as EligibilityCapability,
  type CapabilityPrinter,
  type CatalogueMaterial,
  type EligibilityCandidate,
  type EligibilityRequest,
  type MerchantPrefs,
  type ReasonCode,
} from './eligibility';
import { DEFAULT_MATCH_WEIGHTS as SCORE_WEIGHTS, rankScore, type MatchWeights as ScoreWeights } from './printMatchingScore';

// ------------------------------------------------------------- the vocabulary

export type Capability = EligibilityCapability;
export const CAPABILITIES: Capability[] = ELIGIBILITY_CAPABILITIES;
export type Quality = 'draft' | 'standard' | 'fine' | 'ultra';
export type MatchWeights = ScoreWeights;
export const DEFAULT_MATCH_WEIGHTS: MatchWeights = SCORE_WEIGHTS;
export const fitsInBuild = eligibilityFitsInBuild;

export interface MatchRequest {
  id: string;
  process: PrintProcess;
  material_id: string;
  color_hex: string;
  quality: Quality;
  colors_count: number;
  /** The three dimensions; {0,0,0} = not measured. */
  dimensions_mm: { x: number; y: number; z: number };
  governorate: string;
  delivery_pref: string;
  /** The Levonis estimate, used only to respect a merchant's job-size limits. */
  estimate_iqd: number | null;
  quantity: number;
}

export interface MerchantPrinter {
  id: string;
  technology: PrintProcess;
  build_x_mm: number;
  build_y_mm: number;
  build_z_mm: number;
  nozzle_mm: number;
  materials: string[];
  colors: string[];
  multicolor: boolean;
  enclosed: boolean;
  hardened_nozzle: boolean;
  quality_max: Quality;
  machine_hour_iqd: number | null;
  availability: 'available' | 'busy' | 'offline';
  active: boolean;
}

export type { MerchantPrefs };

export interface MerchantCandidate {
  merchant_id: string;
  user_id: string;
  status: string;
  store_status: string;
  store_id: string | null;
  accepts_custom_requests: boolean;
  governorate: string;
  request_opportunities: boolean;
  printers: MerchantPrinter[];
  prefs: MerchantPrefs;
  rating_avg_x100: number;
  rating_count: number;
  completed_orders: number;
  response_minutes: number | null;
  trouble_rate: number;
  pro: boolean;
}

export type RejectReason =
  | 'MERCHANT_INACTIVE'
  | 'STORE_UNAVAILABLE'
  | 'NOT_TAKING_REQUESTS'
  | 'NOTIFICATIONS_OFF'
  | 'PAUSED'
  | 'NO_PRINTER'
  | 'PROCESS'
  | 'MATERIAL'
  | 'BUILD_VOLUME'
  | 'QUALITY'
  | 'CAPABILITY'
  | 'COLOR'
  | 'GOVERNORATE'
  | 'DELIVERY'
  | 'JOB_TOO_SMALL'
  | 'JOB_TOO_LARGE'
  | 'SIZE_PREFERENCE';

export interface MatchDecision {
  merchant_id: string;
  user_id: string;
  eligible: boolean;
  reject_reason: RejectReason | '';
  score: number;
  detail: Record<string, number>;
  /** The printer that qualified them — the one the job would run on. */
  printer_id: string;
}

// ------------------------------------------- the adapter onto eligibility.ts

/** The pre-W5-B code for each eligibility reason (a reason with no older twin keeps its dimension's nearest). */
const LEGACY: Record<ReasonCode, RejectReason> = {
  REQUEST_CLOSED: 'NOT_TAKING_REQUESTS',
  OWN_REQUEST: 'NOT_TAKING_REQUESTS',
  MERCHANT_INACTIVE: 'MERCHANT_INACTIVE',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  PLAN_LAPSED: 'MERCHANT_INACTIVE',
  NOT_TAKING_REQUESTS: 'NOT_TAKING_REQUESTS',
  NO_PRINTER: 'NO_PRINTER',
  PROCESS: 'PROCESS',
  BUILD_VOLUME: 'BUILD_VOLUME',
  MATERIAL: 'MATERIAL',
  ENCLOSURE: 'MATERIAL',
  HARDENED_NOZZLE: 'MATERIAL',
  QUALITY: 'QUALITY',
  NOZZLE: 'QUALITY',
  MULTICOLOR: 'CAPABILITY',
  STOCK_MATERIAL: 'MATERIAL',
  STOCK_COLOR: 'COLOR',
  STOCK_GRAMS: 'MATERIAL',
  REACH_DELIVERY: 'DELIVERY',
  REACH_PICKUP: 'DELIVERY',
  PREF_PROCESS: 'PROCESS',
  PREF_MATERIAL: 'MATERIAL',
  PREF_COLOR: 'COLOR',
  PREF_CAPABILITY: 'CAPABILITY',
  PREF_GOVERNORATE: 'GOVERNORATE',
  PREF_DELIVERY: 'DELIVERY',
  PREF_SIZE: 'SIZE_PREFERENCE',
  PREF_JOB_TOO_SMALL: 'JOB_TOO_SMALL',
  PREF_JOB_TOO_LARGE: 'JOB_TOO_LARGE',
};

function toRequest(req: MatchRequest): EligibilityRequest {
  const d = req.dimensions_mm;
  return {
    id: req.id,
    customer_id: '',
    revision: 1,
    on_board: true,
    process: req.process,
    material_id: req.material_id || null,
    color_hex: (req.color_hex || '').toLowerCase(),
    quality: req.quality,
    colors_count: req.colors_count,
    // {0,0,0} was the matcher's «not measured».
    dims_mm: d && (d.x > 0 || d.y > 0 || d.z > 0) ? d : null,
    grams: null,
    governorate: req.governorate,
    delivery_pref: req.delivery_pref === 'delivery' || req.delivery_pref === 'pickup' ? req.delivery_pref : '',
    estimate_iqd: req.estimate_iqd,
    quantity: req.quantity,
  };
}

function toPrinter(p: MerchantPrinter): CapabilityPrinter {
  return {
    id: p.id,
    technology: p.technology,
    build_x_mm: p.build_x_mm,
    build_y_mm: p.build_y_mm,
    build_z_mm: p.build_z_mm,
    nozzle_mm: p.nozzle_mm,
    materials: p.materials,
    enclosed: p.enclosed,
    hardened_nozzle: p.hardened_nozzle,
    max_colors: p.multicolor ? 16 : 1,
    quality_max: p.quality_max,
    machine_hour_iqd: p.machine_hour_iqd,
    availability: p.availability,
    active: p.active,
    canonical: false,
  };
}

/**
 * A pre-W5-B candidate carried no plan, stock or delivery configuration, so
 * those dimensions are not judged for it (`plan_ok`, `untracked`,
 * `not_evaluated`) — exactly what this adapter's callers always got. The
 * routes never come through here: printMatchingStore.ts loads all three.
 */
function toCandidate(m: MerchantCandidate): EligibilityCandidate {
  return {
    merchant_id: m.merchant_id,
    user_id: m.user_id,
    merchant_status: m.status,
    store_status: m.store_status,
    store_id: m.store_id,
    accepts_custom_requests: m.accepts_custom_requests,
    plan_ok: true,
    printers: m.printers.map(toPrinter),
    stock: 'untracked',
    reach: 'not_evaluated',
    prefs: m.prefs,
    request_opportunities: m.request_opportunities,
  };
}

function catalogueOf(material: PrintMaterial | null): Map<string, CatalogueMaterial> {
  return new Map(material ? [[material.id, material]] : []);
}

/** The capabilities a job needs, derived from the job itself rather than asked for. */
export function requiredCapabilities(req: MatchRequest, material: PrintMaterial | null): Capability[] {
  return jobCapabilities(toRequest(req), material);
}

/** True when this printer could run this job — pure physics (`''` = it can). */
export function printerFits(printer: MerchantPrinter, req: MatchRequest, material: PrintMaterial | null): RejectReason | '' {
  const why = printerCannot(toPrinter(printer), toRequest(req), material);
  return why ? LEGACY[why] : '';
}

/**
 * One merchant, one answer: would they be TOLD. Eligible and wanting to hear;
 * otherwise the most fundamental reason, or the notification switch / pause
 * for a merchant who could make it but asked for silence.
 */
export function decide(
  merchant: MerchantCandidate,
  req: MatchRequest,
  material: PrintMaterial | null,
  weights: MatchWeights,
  now: number
): MatchDecision {
  const er = toRequest(req);
  const cand = toCandidate(merchant);
  const v = evaluateEligibility(cand, er, catalogueOf(material), now);
  if (!v.eligible || !v.notify) {
    return {
      merchant_id: merchant.merchant_id,
      user_id: merchant.user_id,
      eligible: false,
      reject_reason: v.eligible ? (v.notify_block as RejectReason) : LEGACY[v.reason as ReasonCode],
      score: 0,
      detail: {},
      printer_id: '',
    };
  }
  const printer = cand.printers.find((p) => p.id === v.printer_id)!;
  const { score, detail } = rankScore(er, printer, merchant, material, weights);
  return {
    merchant_id: merchant.merchant_id,
    user_id: merchant.user_id,
    eligible: true,
    reject_reason: '',
    score,
    detail,
    printer_id: v.printer_id,
  };
}

/**
 * The whole board, decided and ordered. Returns EVERY merchant considered;
 * `limit` caps only how many are notified.
 */
export function matchMerchants(
  merchants: MerchantCandidate[],
  req: MatchRequest,
  material: PrintMaterial | null,
  weights: MatchWeights,
  now: number,
  limit = 25
): { decisions: MatchDecision[]; notify: MatchDecision[] } {
  const decisions = merchants.map((m) => decide(m, req, material, weights, now));
  const notify = decisions
    .filter((d) => d.eligible)
    .sort((a, b) => b.score - a.score || a.merchant_id.localeCompare(b.merchant_id))
    .slice(0, limit);
  return { decisions, notify };
}
