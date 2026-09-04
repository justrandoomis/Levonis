/**
 * SMART MATCHING — which merchants are TOLD about a request.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE, in the owner's words:
 *
 *   "ONE published request → Smart Matching finds eligible merchants → ONLY
 *    notifications are sent to them → the notification opens that same request."
 *
 * So nothing here creates, copies, or reserves anything. It takes a request and
 * a list of merchants and returns a DECISION per merchant: eligible or not, and
 * if not, exactly why. The caller turns eligible decisions into notifications.
 * There is no code path from this module to a request row, by construction.
 *
 * TWO STAGES, AND THE ORDER MATTERS.
 *
 *   1. HARD COMPATIBILITY — can this shop physically make this thing? A part
 *      that does not fit the bed does not fit at any price, and a resin shop
 *      cannot print PETG. These are facts, and a fact is never outranked. A PRO
 *      subscription does not make a printer bigger: the owner said it and the
 *      code obeys it — the bonus is applied to the SCORE, after eligibility,
 *      where it can only reorder merchants who all already qualify.
 *
 *   2. RANKING — of the shops that CAN, who should hear first. Fit, distance,
 *      availability, reputation, delivered work, speed of reply, disputes,
 *      whether the budget suits them, and their own stated preferences.
 *
 * WHY EVERY REJECTION IS RECORDED. "Why did my shop never see this job?" is a
 * question a merchant will ask, and a matcher that cannot answer it is a matcher
 * nobody trusts. Every decision carries a machine-readable reason, and the
 * caller writes them all — rejections included — to community_request_matches.
 */

import type { PrintMaterial, PrintProcess } from './printPricing';

// ------------------------------------------------------------- the vocabulary

/** The capability words a customer's job can demand and a merchant can offer. */
export type Capability =
  | 'multicolor'
  | 'large_format'
  | 'high_detail'
  | 'functional'
  | 'flexible'
  | 'cf';

export const CAPABILITIES: Capability[] = [
  'multicolor',
  'large_format',
  'high_detail',
  'functional',
  'flexible',
  'cf',
];

export type Quality = 'draft' | 'standard' | 'fine' | 'ultra';
const QUALITY_RANK: Record<Quality, number> = { draft: 0, standard: 1, fine: 2, ultra: 3 };

export interface MatchRequest {
  id: string;
  process: PrintProcess;
  material_id: string;
  color_hex: string;
  quality: Quality;
  colors_count: number;
  /** Longest edge and the three dimensions; both matter. */
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

export interface MerchantPrefs {
  processes: string[];
  materials: string[];
  colors: string[];
  capabilities: string[];
  governorates: string[];
  delivery: string[];
  min_job_iqd: number;
  max_job_iqd: number | null;
  min_size_mm: number;
  max_size_mm: number | null;
  workload: 'light' | 'normal' | 'busy' | 'full';
  paused: boolean;
  paused_until: string | null;
}

export interface MerchantCandidate {
  merchant_id: string;
  user_id: string;
  /** community_merchants.status — only 'active' may be told about work. */
  status: string;
  /** merchant_stores.status — a paused store is not taking jobs. */
  store_status: string;
  store_id: string | null;
  accepts_custom_requests: boolean;
  governorate: string;
  /** The master switch from merchant_notification_preferences. */
  request_opportunities: boolean;
  printers: MerchantPrinter[];
  prefs: MerchantPrefs;
  rating_avg_x100: number;
  rating_count: number;
  completed_orders: number;
  /** Median minutes to a first offer, over recent requests. null = no history. */
  response_minutes: number | null;
  /** Cancelled or disputed as a share of finished orders, 0..1. */
  trouble_rate: number;
  /** An active PRO/PLUS subscription. A tiebreaker, never a qualifier. */
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

/** How much each ranking signal is worth. Admin-tunable; the defaults below are
 *  the starting point, and `matchWeights` in settings overrides them. */
export interface MatchWeights {
  capability_fit: number;
  location: number;
  availability: number;
  rating: number;
  completed_jobs: number;
  response_time: number;
  reliability: number;
  price_suitability: number;
  preference_match: number;
  pro_bonus: number;
}

export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  capability_fit: 25,
  location: 18,
  availability: 14,
  rating: 12,
  completed_jobs: 8,
  response_time: 8,
  reliability: 8,
  price_suitability: 4,
  preference_match: 3,
  // Deliberately no larger than the smallest signal in the table, and a few
  // percent of the total. It reorders shops that ALL ALREADY QUALIFY; it can
  // never reach an ineligible one, because eligibility is decided before any
  // score is computed. A subscription is a tiebreaker between equals, which is
  // the only thing "controlled PRO bonus" can honestly mean.
  pro_bonus: 3,
};

// ---------------------------------------------------- what the job demands

/**
 * The capabilities a job needs, derived from the job itself rather than asked
 * for. A customer should not have to know that a 300mm part is "large format".
 */
export function requiredCapabilities(req: MatchRequest, material: PrintMaterial | null): Capability[] {
  const out = new Set<Capability>();
  if (req.colors_count > 1) out.add('multicolor');
  const longest = Math.max(req.dimensions_mm.x, req.dimensions_mm.y, req.dimensions_mm.z);
  if (longest > 250) out.add('large_format');
  if (req.quality === 'fine' || req.quality === 'ultra' || req.process === 'resin') out.add('high_detail');
  if (material) {
    if (material.id === 'tpu' || material.id.includes('flexible')) out.add('flexible');
    if (material.abrasive) out.add('cf');
    if (material.needs_enclosure) out.add('functional');
  }
  return [...out];
}

/** True when this printer could run this job, ignoring everything about the
 *  merchant's preferences — pure physics and stock. */
export function printerFits(
  printer: MerchantPrinter,
  req: MatchRequest,
  material: PrintMaterial | null
): RejectReason | '' {
  if (!printer.active || printer.availability === 'offline') return 'NO_PRINTER';
  if (printer.technology !== req.process) return 'PROCESS';

  // The material has to be one the shop stocks AND one the machine can run.
  if (req.material_id) {
    if (printer.materials.length > 0 && !printer.materials.includes(req.material_id)) return 'MATERIAL';
    if (material) {
      if (material.needs_enclosure && !printer.enclosed) return 'MATERIAL';
      if (material.abrasive && !printer.hardened_nozzle) return 'MATERIAL';
    }
  }

  // THE BUILD VOLUME. The part is allowed to be rotated flat on the bed — any
  // of the six axis permutations counts — because a slicer would do exactly
  // that, and refusing a job that fits when turned would be wrong.
  if (printer.build_x_mm > 0 && printer.build_y_mm > 0 && printer.build_z_mm > 0) {
    if (!fitsInBuild(req.dimensions_mm, printer)) return 'BUILD_VOLUME';
  }

  if (QUALITY_RANK[printer.quality_max] < QUALITY_RANK[req.quality]) return 'QUALITY';
  if (req.colors_count > 1 && !printer.multicolor) return 'CAPABILITY';
  return '';
}

/** Every orientation a slicer would try. */
export function fitsInBuild(
  d: { x: number; y: number; z: number },
  p: { build_x_mm: number; build_y_mm: number; build_z_mm: number }
): boolean {
  const dims = [d.x, d.y, d.z];
  const perms: Array<[number, number, number]> = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  return perms.some(
    ([a, b, cc]) =>
      dims[a] <= p.build_x_mm && dims[b] <= p.build_y_mm && dims[cc] <= p.build_z_mm
  );
}

// ------------------------------------------------------------ the decision

/**
 * One merchant, one answer.
 *
 * The order of the checks IS the policy: the things that make a job impossible
 * come before the things that make it unwanted, so a rejection reason always
 * names the most fundamental problem rather than whichever check ran first.
 */
export function decide(
  merchant: MerchantCandidate,
  req: MatchRequest,
  material: PrintMaterial | null,
  weights: MatchWeights,
  now: number
): MatchDecision {
  const no = (reason: RejectReason): MatchDecision => ({
    merchant_id: merchant.merchant_id,
    user_id: merchant.user_id,
    eligible: false,
    reject_reason: reason,
    score: 0,
    detail: {},
    printer_id: '',
  });

  // ---- can they trade at all -------------------------------------------
  if (merchant.status !== 'active') return no('MERCHANT_INACTIVE');
  if (merchant.store_status && merchant.store_status !== 'active') return no('STORE_UNAVAILABLE');
  if (!merchant.accepts_custom_requests) return no('NOT_TAKING_REQUESTS');

  // ---- do they want to hear ---------------------------------------------
  // Checked before capability, because a merchant who switched notifications
  // off has answered the question already and their machines are irrelevant.
  if (!merchant.request_opportunities) return no('NOTIFICATIONS_OFF');
  const pausedNow =
    merchant.prefs.paused &&
    (!merchant.prefs.paused_until || Date.parse(merchant.prefs.paused_until) > now);
  if (pausedNow) return no('PAUSED');

  // ---- can any of their machines do it ----------------------------------
  if (merchant.printers.length === 0) return no('NO_PRINTER');
  let best: MerchantPrinter | null = null;
  let firstReason: RejectReason | '' = '';
  for (const printer of merchant.printers) {
    const why = printerFits(printer, req, material);
    if (why === '') {
      // Among the machines that fit, prefer an idle one, then the cheapest
      // hour — the one this shop would actually put the job on.
      if (
        !best ||
        (best.availability !== 'available' && printer.availability === 'available') ||
        ((printer.machine_hour_iqd ?? Infinity) < (best.machine_hour_iqd ?? Infinity) &&
          printer.availability === best.availability)
      ) {
        best = printer;
      }
    } else if (!firstReason || rank(why) < rank(firstReason)) {
      firstReason = why;
    }
  }
  if (!best) return no(firstReason || 'NO_PRINTER');

  // ---- have they asked NOT to hear about this kind of job ----------------
  const p = merchant.prefs;
  const longest = Math.max(req.dimensions_mm.x, req.dimensions_mm.y, req.dimensions_mm.z);
  if (p.processes.length && !p.processes.includes(req.process)) return no('PROCESS');
  if (p.materials.length && req.material_id && !p.materials.includes(req.material_id)) return no('MATERIAL');
  if (p.governorates.length && req.governorate && !p.governorates.includes(req.governorate)) {
    return no('GOVERNORATE');
  }
  if (p.delivery.length && req.delivery_pref && !p.delivery.includes(req.delivery_pref)) {
    return no('DELIVERY');
  }
  if (p.min_size_mm > 0 && longest < p.min_size_mm) return no('SIZE_PREFERENCE');
  if (p.max_size_mm !== null && p.max_size_mm > 0 && longest > p.max_size_mm) return no('SIZE_PREFERENCE');
  if (req.estimate_iqd !== null) {
    if (p.min_job_iqd > 0 && req.estimate_iqd < p.min_job_iqd) return no('JOB_TOO_SMALL');
    if (p.max_job_iqd !== null && p.max_job_iqd > 0 && req.estimate_iqd > p.max_job_iqd) {
      return no('JOB_TOO_LARGE');
    }
  }
  const needed = requiredCapabilities(req, material);
  if (p.capabilities.length) {
    const missing = needed.filter((cap) => !p.capabilities.includes(cap));
    if (missing.length) return no('CAPABILITY');
  }
  // A colour the shop does not stock is a preference, not a wall: they can buy
  // a spool. It is only a rejection when they listed their colours AND the job
  // names one, and even then only because they chose to be filtered that way.
  if (p.colors.length && req.color_hex && !p.colors.includes(req.color_hex.toLowerCase())) {
    return no('COLOR');
  }

  // ---- they qualify. Now, how well? --------------------------------------
  const detail: Record<string, number> = {};
  const add = (key: keyof MatchWeights, fraction: number) => {
    const v = Math.round(weights[key] * clamp01(fraction));
    detail[key] = v;
    return v;
  };

  let score = 0;
  // Capability fit: how much of the machine's envelope the job leaves spare. A
  // job that only just fits is a riskier match than one with room around it.
  score += add('capability_fit', capabilityFit(req, best, needed, merchant));
  score += add('location', req.governorate && merchant.governorate === req.governorate ? 1 : 0.35);
  score += add(
    'availability',
    best.availability === 'available'
      ? { light: 1, normal: 0.85, busy: 0.5, full: 0.15 }[p.workload]
      : 0.25
  );
  // An unrated shop sits at the middle, not at the bottom: a new merchant with
  // the right machine should not be buried under one bad review's worth of
  // history they have not had a chance to build.
  score += add('rating', merchant.rating_count > 0 ? merchant.rating_avg_x100 / 500 : 0.6);
  score += add('completed_jobs', Math.log10(1 + merchant.completed_orders) / 2);
  score += add(
    'response_time',
    merchant.response_minutes === null ? 0.6 : clamp01(1 - merchant.response_minutes / 1440)
  );
  score += add('reliability', 1 - clamp01(merchant.trouble_rate * 3));
  score += add(
    'price_suitability',
    req.estimate_iqd === null || p.min_job_iqd <= 0 ? 0.6 : clamp01(req.estimate_iqd / (p.min_job_iqd * 4))
  );
  // Having explicitly asked for this kind of work beats merely tolerating it.
  score += add(
    'preference_match',
    p.capabilities.length && needed.every((cap) => p.capabilities.includes(cap)) ? 1 : 0.5
  );
  score += add('pro_bonus', merchant.pro ? 1 : 0);

  return {
    merchant_id: merchant.merchant_id,
    user_id: merchant.user_id,
    eligible: true,
    reject_reason: '',
    score,
    detail,
    printer_id: best.id,
  };
}

/** How comfortably the job sits on this machine, 0..1. */
function capabilityFit(
  req: MatchRequest,
  printer: MerchantPrinter,
  needed: Capability[],
  merchant: MerchantCandidate
): number {
  let fit = 0.5;
  if (printer.build_x_mm > 0) {
    const longest = Math.max(req.dimensions_mm.x, req.dimensions_mm.y, req.dimensions_mm.z);
    const bed = Math.max(printer.build_x_mm, printer.build_y_mm, printer.build_z_mm);
    // Best around half the bed: plenty of room, without wasting a large machine
    // on a job any small one could take.
    const use = bed > 0 ? longest / bed : 1;
    fit += 0.3 * (1 - Math.abs(use - 0.5) * 2);
  }
  // Every capability the job needs and this shop genuinely has.
  const have = new Set<Capability>();
  if (printer.multicolor) have.add('multicolor');
  if (printer.enclosed) have.add('functional');
  if (printer.hardened_nozzle) have.add('cf');
  if (QUALITY_RANK[printer.quality_max] >= QUALITY_RANK.fine) have.add('high_detail');
  if (Math.max(printer.build_x_mm, printer.build_y_mm, printer.build_z_mm) >= 300) have.add('large_format');
  if (merchant.prefs.capabilities.includes('flexible')) have.add('flexible');
  if (needed.length) fit += 0.2 * (needed.filter((cap) => have.has(cap)).length / needed.length);
  else fit += 0.2;
  return clamp01(fit);
}

/** Rejection reasons, most fundamental first — physics before preference. */
function rank(reason: RejectReason): number {
  const order: RejectReason[] = [
    'PROCESS', 'BUILD_VOLUME', 'MATERIAL', 'QUALITY', 'CAPABILITY', 'NO_PRINTER',
  ];
  const i = order.indexOf(reason);
  return i === -1 ? 99 : i;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

/**
 * The whole board, decided and ordered.
 *
 * Returns EVERY merchant considered, rejections included, because the caller
 * records all of them. `limit` caps only how many are notified — a request that
 * fifty shops could take should not put fifty notifications on fifty phones,
 * and the ones beyond the cap can still find it on the public board.
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
