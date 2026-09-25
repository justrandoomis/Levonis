/**
 * ELIGIBILITY — may THIS workshop make THIS request, and if not, exactly why.
 *
 * ONE PURE FUNCTION, `evaluateEligibility`, and it is the only place the
 * answer is computed (stream W5-B; docs/MERCHANT_PLATFORM.md §2 decisions 5–7,
 * §4.7; audit 03 §5, §9 G6–G14). Every door that asks the question asks it
 * here, through worker/lib/printMatchingStore.ts which only loads the inputs:
 *
 *   - the board's «مناسب لي» view        (the persisted verdicts, per revision)
 *   - OFFER permission                   (live verdict; OFFER_NOT_ELIGIBLE)
 *   - who is notified of a new request   (verdict AND the merchant wants to hear)
 *   - the model preview and the pictures (live verdict; the file policy)
 *   - costing a request's own file       (live verdict)
 *
 * No I/O, no clock of its own (the caller passes `now`), no Cloudflare types.
 *
 * THE RULE, IN THE OWNER'S WORDS: eligibility = the request's requirements ∩
 * printer capability ∩ material stock ∩ preferences ∩ location/delivery reach
 * ∩ plan/status. It is computed as FIVE INDEPENDENT DIMENSIONS and the verdict
 * is their conjunction:
 *
 *   trade        the request is on the board and not the merchant's own; the
 *                merchant is `active`, the store is `active` and takes custom
 *                requests, the plan includes the store and community offers
 *   capability   at least one active, not-offline printer can physically make
 *                it — technology, build volume in any of six orientations,
 *                material (and the enclosure / hardened nozzle it needs),
 *                quality, nozzle for fine work, colours at once
 *   stock        when the workshop tracks stock: the material (and colour, and
 *                enough grams when the job's grams are known) is on the shelf
 *   reach        the store's own delivery configuration (W2-A) reaches the
 *                customer: delivery to their governorate, or pickup there
 *   preference   the merchant's filters — narrowing only
 *
 * WHY PREFERENCES CAN NEVER WIDEN ANYTHING. `eligible` is the AND of the five,
 * and the preference dimension can only ADD failing reasons: no preference is
 * read by any other dimension. An empty preference list is «no filter», i.e.
 * everything the workshop can make (decision 6). tests/eligibility.test.ts
 * checks both, including a randomised sweep over preferences.
 *
 * NOTIFICATION IS NOT ELIGIBILITY. A merchant who switched «فرص طلبات
 * العملاء» off, or paused, is not told — but may still find the request on the
 * board and bid on it: the switch answers «tell me», not «let me». Before W5-B
 * a switched-off notice took the shop off the job entirely (DECISIONS 124 (ج)).
 *
 * UNKNOWN IS NOT A PASS BY ACCIDENT. A dimension that cannot be judged says so
 * (`unknown` / `untracked`) instead of passing silently: dimensions of a job
 * with no measured or stated size, stock of a workshop that never entered any.
 * Each such case is spelled out below, with why it is the right reading.
 */

import {
  normalizeStoredProfile,
  resolveMerchantDelivery,
  servedGovernorates,
  type MerchantDeliveryProfile,
  type MerchantDeliveryRule,
} from '@levonis/shipping/merchantDelivery';
import { normalizeGovernorate } from '@levonis/shipping/iraqGovernorates';

// ------------------------------------------------------------- vocabulary

export type Process = 'fdm' | 'resin';
export type Quality = 'draft' | 'standard' | 'fine' | 'ultra';
export const QUALITIES: readonly Quality[] = ['draft', 'standard', 'fine', 'ultra'];
export const QUALITY_RANK: Readonly<Record<Quality, number>> = { draft: 0, standard: 1, fine: 2, ultra: 3 };

/** The capability words a job can demand and a merchant can filter on. */
export type Capability = 'multicolor' | 'large_format' | 'high_detail' | 'functional' | 'flexible' | 'cf';
export const CAPABILITIES: Capability[] = ['multicolor', 'large_format', 'high_detail', 'functional', 'flexible', 'cf'];

/** The five dimensions, in policy order. */
export const DIMENSIONS = ['trade', 'capability', 'stock', 'reach', 'preference'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/**
 * EVERY REASON A VERDICT CAN CARRY — stable codes the client maps to words
 * (src/components/merchant/workshop/reasons.ts; a test holds the two lists
 * equal). Grouped by dimension; within a group, the most fundamental first.
 */
export const REASONS = {
  trade: ['REQUEST_CLOSED', 'OWN_REQUEST', 'MERCHANT_INACTIVE', 'STORE_UNAVAILABLE', 'PLAN_LAPSED', 'NOT_TAKING_REQUESTS'],
  capability: ['NO_PRINTER', 'PROCESS', 'BUILD_VOLUME', 'MATERIAL', 'ENCLOSURE', 'HARDENED_NOZZLE', 'QUALITY', 'NOZZLE', 'MULTICOLOR'],
  stock: ['STOCK_MATERIAL', 'STOCK_COLOR', 'STOCK_GRAMS'],
  reach: ['REACH_DELIVERY', 'REACH_PICKUP'],
  preference: [
    'PREF_PROCESS', 'PREF_MATERIAL', 'PREF_COLOR', 'PREF_CAPABILITY', 'PREF_GOVERNORATE',
    'PREF_DELIVERY', 'PREF_SIZE', 'PREF_JOB_TOO_SMALL', 'PREF_JOB_TOO_LARGE',
  ],
} as const;
export type ReasonCode = (typeof REASONS)[Dimension][number];
export const ALL_REASONS: readonly ReasonCode[] = DIMENSIONS.flatMap((d) => REASONS[d] as readonly ReasonCode[]);

/** Why a merchant who IS eligible is still not TOLD. Never a reason to refuse. */
export type NotifyBlock = '' | 'NOTIFICATIONS_OFF' | 'PAUSED';

// ------------------------------------------------------------------ inputs

/** A material from the `printMaterials` catalogue, as far as eligibility reads it. */
export interface CatalogueMaterial {
  id: string;
  process: Process;
  needs_enclosure: boolean;
  abrasive: boolean;
}

/** The request revision, as the matcher reads it. */
export interface EligibilityRequest {
  id: string;
  customer_id: string;
  revision: number;
  /** Public, taking offers, not expired (`onPublicBoard`). */
  on_board: boolean;
  /** null = the customer said «لست متأكدًا» (or an old request with no print spec). */
  process: Process | null;
  /** null = unsure / not given. */
  material_id: string | null;
  /** '' = any colour. Lower-case #rrggbb otherwise. */
  color_hex: string;
  quality: Quality;
  colors_count: number;
  /** Measured, else what the customer typed; null = unknown. */
  dims_mm: { x: number; y: number; z: number } | null;
  /** Material grams for the WHOLE job (all copies), from the estimate; null = unknown. */
  grams: number | null;
  /** A closed-list governorate id, or ''. */
  governorate: string;
  delivery_pref: '' | 'delivery' | 'pickup';
  /** The Levonis estimate, for the merchant's job-value band; null = not priced. */
  estimate_iqd: number | null;
  quantity: number;
}

/** A merchant printer with its physics RESOLVED (canonical model first). */
export interface CapabilityPrinter {
  id: string;
  technology: Process;
  build_x_mm: number;
  build_y_mm: number;
  build_z_mm: number;
  /** 0 for resin. */
  nozzle_mm: number;
  /** Material ids this machine runs here; [] = every material of its technology. */
  materials: string[];
  enclosed: boolean;
  hardened_nozzle: boolean;
  /** How many materials/colours it lays down in one print (1 = single). */
  max_colors: number;
  quality_max: Quality;
  machine_hour_iqd: number | null;
  availability: 'available' | 'busy' | 'offline';
  active: boolean;
  /** Tied to a canonical `printer_models` row (false = physics self-declared). */
  canonical: boolean;
}

export interface StockLine {
  material_id: string;
  /** '' = the colour of this material is not tracked (any colour). */
  color_hex: string;
  grams: number;
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

export const EMPTY_PREFS: MerchantPrefs = Object.freeze({
  processes: [], materials: [], colors: [], capabilities: [], governorates: [], delivery: [],
  min_job_iqd: 0, max_job_iqd: null, min_size_mm: 0, max_size_mm: null,
  workload: 'normal', paused: false, paused_until: null,
}) as MerchantPrefs;

export interface ReachConfig {
  profile: MerchantDeliveryProfile;
  rules: MerchantDeliveryRule[];
}

export interface EligibilityCandidate {
  merchant_id: string;
  user_id: string;
  /** community_merchants.status */
  merchant_status: string;
  /** merchant_stores.status; '' = no store row (which is not an active store). */
  store_status: string;
  store_id: string | null;
  accepts_custom_requests: boolean;
  /** The owner's plan includes the store AND community offers. */
  plan_ok: boolean;
  printers: CapabilityPrinter[];
  /** 'untracked' = the workshop has never entered stock (judged on printers alone). */
  stock: StockLine[] | 'untracked';
  /**
   * The store's delivery configuration (W2-A). 'not_evaluated' exists ONLY for
   * the pre-W5-B `decide()` adapter in printMatching.ts, whose callers never
   * had one; every route-level loader passes a real configuration.
   */
  reach: ReachConfig | 'not_evaluated';
  prefs: MerchantPrefs;
  /** merchant_notification_preferences.request_opportunities */
  request_opportunities: boolean;
}

// ------------------------------------------------------------------ output

export type DimensionState = 'pass' | 'fail' | 'unknown' | 'untracked';

export interface EligibilityResult {
  eligible: boolean;
  /** The first failing reason in policy order ('' when eligible). */
  reason: ReasonCode | '';
  /** Every failing reason, in policy order. */
  reasons: ReasonCode[];
  dims: Record<Dimension, DimensionState>;
  /** The machine the job would run on ('' when none can). */
  printer_id: string;
  /** Eligible AND the merchant wants to hear about it. */
  notify: boolean;
  notify_block: NotifyBlock;
}

// ------------------------------------------------------------- the physics

/** Every orientation a slicer would try. A part is allowed to be turned. */
export function fitsInBuild(
  d: { x: number; y: number; z: number },
  p: { build_x_mm: number; build_y_mm: number; build_z_mm: number }
): boolean {
  const dims = [d.x, d.y, d.z];
  const perms: Array<[number, number, number]> = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  return perms.some(([a, b, c]) => dims[a] <= p.build_x_mm && dims[b] <= p.build_y_mm && dims[c] <= p.build_z_mm);
}

/**
 * The capabilities a job needs, derived from the job rather than asked for —
 * a customer should not have to know that a 300 mm part is «large format».
 */
export function jobCapabilities(req: EligibilityRequest, material: CatalogueMaterial | null): Capability[] {
  const out = new Set<Capability>();
  if (req.colors_count > 1) out.add('multicolor');
  if (req.dims_mm && Math.max(req.dims_mm.x, req.dims_mm.y, req.dims_mm.z) > 250) out.add('large_format');
  if (req.quality === 'fine' || req.quality === 'ultra' || req.process === 'resin') out.add('high_detail');
  if (material) {
    if (material.id === 'tpu' || material.id.includes('flexible')) out.add('flexible');
    if (material.abrasive) out.add('cf');
    if (material.needs_enclosure) out.add('functional');
  }
  return [...out];
}

/** Finer work than this nozzle can lay down: fine and ultra want ≤ 0.4 mm. */
const FINE_NOZZLE_MAX_MM = 0.4;

/** Why ONE printer cannot make the job ('' = it can). */
export function printerCannot(
  p: CapabilityPrinter,
  req: EligibilityRequest,
  material: CatalogueMaterial | null
): ReasonCode | '' {
  if (!p.active || p.availability === 'offline') return 'NO_PRINTER';
  if (req.process && p.technology !== req.process) return 'PROCESS';
  // A job of unknown size fits nothing and everything: it is not refused on
  // size (the customer gave none), and the dimension says `unknown`.
  if (req.dims_mm && !(p.build_x_mm > 0 && p.build_y_mm > 0 && p.build_z_mm > 0 && fitsInBuild(req.dims_mm, p))) {
    return 'BUILD_VOLUME';
  }
  if (req.material_id) {
    // A material of another technology is not «not stocked», it is impossible.
    if (material && material.process !== p.technology) return 'MATERIAL';
    if (p.materials.length > 0 && !p.materials.includes(req.material_id)) return 'MATERIAL';
    if (material?.needs_enclosure && !p.enclosed) return 'ENCLOSURE';
    if (material?.abrasive && !p.hardened_nozzle) return 'HARDENED_NOZZLE';
  }
  if (QUALITY_RANK[p.quality_max] < QUALITY_RANK[req.quality]) return 'QUALITY';
  if (
    p.technology === 'fdm' &&
    (req.quality === 'fine' || req.quality === 'ultra') &&
    p.nozzle_mm > FINE_NOZZLE_MAX_MM + 1e-9
  ) {
    return 'NOZZLE';
  }
  if (req.colors_count > Math.max(1, p.max_colors)) return 'MULTICOLOR';
  return '';
}

const CAPABILITY_ORDER = REASONS.capability as readonly ReasonCode[];

// ------------------------------------------------------------------- stock

function stockVerdict(
  stock: StockLine[],
  req: EligibilityRequest,
  processes: Process[],
  catalogue: ReadonlyMap<string, CatalogueMaterial>
): ReasonCode | '' {
  const need = req.grams !== null && req.grams > 0 ? Math.ceil(req.grams) : 1;
  const colour = req.color_hex.toLowerCase();
  // Which lines could feed this job: the material it names, else any material
  // of a technology the workshop's capable printers run.
  const lines = stock.filter((l) =>
    req.material_id
      ? l.material_id === req.material_id
      : processes.includes(catalogue.get(l.material_id)?.process ?? ('' as Process))
  );
  if (!lines.some((l) => l.grams > 0)) return 'STOCK_MATERIAL';
  const inColour = colour ? lines.filter((l) => l.color_hex === '' || l.color_hex === colour) : lines;
  if (!inColour.some((l) => l.grams > 0)) return 'STOCK_COLOR';
  if (!inColour.some((l) => l.grams >= need)) return 'STOCK_GRAMS';
  return '';
}

// ------------------------------------------------------------------- reach

function reachVerdict(reach: ReachConfig, req: EligibilityRequest): ReasonCode | '' {
  const profile = normalizeStoredProfile(reach.profile as unknown as Record<string, unknown>);
  const gov = normalizeGovernorate(req.governorate);
  const pickupOk = profile.pickup_enabled && (!gov || profile.pickup_governorate === gov);
  const deliveryOk = gov
    ? resolveMerchantDelivery(profile, reach.rules, gov, 0, 'delivery').available
    : servedGovernorates(profile, reach.rules).length > 0;
  if (req.delivery_pref === 'pickup') return pickupOk ? '' : 'REACH_PICKUP';
  if (req.delivery_pref === 'delivery') return deliveryOk ? '' : 'REACH_DELIVERY';
  return pickupOk || deliveryOk ? '' : 'REACH_DELIVERY';
}

// -------------------------------------------------------------- preference

function preferenceReasons(
  p: MerchantPrefs,
  req: EligibilityRequest,
  capablePrinters: CapabilityPrinter[],
  material: CatalogueMaterial | null
): ReasonCode[] {
  const out: ReasonCode[] = [];
  if (p.processes.length) {
    // An unsure process is acceptable to a filter that allows any technology
    // this workshop could make it with.
    const ok = req.process
      ? p.processes.includes(req.process)
      : capablePrinters.some((pr) => p.processes.includes(pr.technology));
    if (!ok) out.push('PREF_PROCESS');
  }
  if (p.materials.length && req.material_id && !p.materials.includes(req.material_id)) out.push('PREF_MATERIAL');
  if (p.colors.length && req.color_hex && !p.colors.map((c) => c.toLowerCase()).includes(req.color_hex.toLowerCase())) {
    out.push('PREF_COLOR');
  }
  if (p.capabilities.length) {
    const needed = jobCapabilities(req, material);
    if (needed.some((cap) => !p.capabilities.includes(cap))) out.push('PREF_CAPABILITY');
  }
  if (p.governorates.length && req.governorate) {
    const gov = normalizeGovernorate(req.governorate) || req.governorate;
    if (!p.governorates.includes(gov) && !p.governorates.includes(req.governorate)) out.push('PREF_GOVERNORATE');
  }
  if (p.delivery.length && req.delivery_pref && !p.delivery.includes(req.delivery_pref)) out.push('PREF_DELIVERY');
  if (req.dims_mm) {
    const longest = Math.max(req.dims_mm.x, req.dims_mm.y, req.dims_mm.z);
    if ((p.min_size_mm > 0 && longest < p.min_size_mm) || (p.max_size_mm !== null && p.max_size_mm > 0 && longest > p.max_size_mm)) {
      out.push('PREF_SIZE');
    }
  }
  if (req.estimate_iqd !== null) {
    if (p.min_job_iqd > 0 && req.estimate_iqd < p.min_job_iqd) out.push('PREF_JOB_TOO_SMALL');
    if (p.max_job_iqd !== null && p.max_job_iqd > 0 && req.estimate_iqd > p.max_job_iqd) out.push('PREF_JOB_TOO_LARGE');
  }
  return out;
}

// ------------------------------------------------------------ the verdict

/** Among the machines that can, the one the shop would use: idle first, then the cheapest hour. */
function bestPrinter(capable: CapabilityPrinter[]): CapabilityPrinter | null {
  let best: CapabilityPrinter | null = null;
  for (const p of capable) {
    if (
      !best ||
      (best.availability !== 'available' && p.availability === 'available') ||
      (p.availability === best.availability && (p.machine_hour_iqd ?? Infinity) < (best.machine_hour_iqd ?? Infinity))
    ) {
      best = p;
    }
  }
  return best;
}

/** The pause, with its optional end date, as of `now`. */
export function pausedAt(p: MerchantPrefs, now: number): boolean {
  return p.paused && (!p.paused_until || !(Date.parse(p.paused_until) <= now));
}

/**
 * THE VERDICT. Pure: the same inputs give the same answer, whoever asks.
 * `catalogue` resolves the request's material (enclosure, abrasive, process).
 */
export function evaluateEligibility(
  m: EligibilityCandidate,
  req: EligibilityRequest,
  catalogue: ReadonlyMap<string, CatalogueMaterial>,
  now: number
): EligibilityResult {
  const reasons: ReasonCode[] = [];
  const dims: Record<Dimension, DimensionState> = {
    trade: 'pass', capability: 'pass', stock: 'pass', reach: 'pass', preference: 'pass',
  };
  const material = req.material_id ? catalogue.get(req.material_id) ?? null : null;

  // ---- trade: may this merchant take new work on this request at all ----
  const trade: ReasonCode[] = [];
  if (!req.on_board) trade.push('REQUEST_CLOSED');
  if (req.customer_id && req.customer_id === m.user_id) trade.push('OWN_REQUEST');
  if (m.merchant_status !== 'active') trade.push('MERCHANT_INACTIVE');
  // An allow-list, as everywhere since review S2: a missing store is not an active one.
  if (m.store_status !== 'active') trade.push('STORE_UNAVAILABLE');
  if (!m.plan_ok) trade.push('PLAN_LAPSED');
  if (!m.accepts_custom_requests) trade.push('NOT_TAKING_REQUESTS');
  if (trade.length) dims.trade = 'fail';
  reasons.push(...trade);

  // ---- capability: can a machine physically make it ---------------------
  const capable: CapabilityPrinter[] = [];
  let capReason: ReasonCode | '' = m.printers.length ? '' : 'NO_PRINTER';
  for (const p of m.printers) {
    const why = printerCannot(p, req, material);
    if (!why) capable.push(p);
    // The most fundamental reason across machines: «too big for every
    // printer» says more than «the one printer that fits is offline».
    else if (!capReason || CAPABILITY_ORDER.indexOf(why) < CAPABILITY_ORDER.indexOf(capReason)) capReason = why;
  }
  if (!capable.length) {
    dims.capability = 'fail';
    reasons.push(capReason || 'NO_PRINTER');
  } else if (!req.dims_mm) {
    dims.capability = 'unknown';
  }

  // ---- stock: is it on the shelf (only when stock is tracked) -----------
  if (m.stock === 'untracked') {
    dims.stock = 'untracked';
  } else {
    // Which technologies could run it: the capable machines', or — so the
    // dimension is judged on its own when no machine can — every machine's.
    const processes = [...new Set((capable.length ? capable : m.printers).map((p) => p.technology))];
    const why = stockVerdict(m.stock, req, processes, catalogue);
    if (why) {
      dims.stock = 'fail';
      reasons.push(why);
    }
  }

  // ---- reach: can the goods get to the customer ------------------------
  if (m.reach === 'not_evaluated') {
    dims.reach = 'unknown';
  } else {
    const why = reachVerdict(m.reach, req);
    if (why) {
      dims.reach = 'fail';
      reasons.push(why);
    }
  }

  // ---- preference: have they asked NOT to be shown this kind of job -----
  const pref = preferenceReasons(m.prefs, req, capable.length ? capable : m.printers, material);
  if (pref.length) {
    dims.preference = 'fail';
    reasons.push(...pref);
  }

  const eligible = reasons.length === 0;
  const best = eligible ? bestPrinter(capable) : null;
  const notify_block: NotifyBlock = !eligible
    ? ''
    : !m.request_opportunities
      ? 'NOTIFICATIONS_OFF'
      : pausedAt(m.prefs, now)
        ? 'PAUSED'
        : '';
  return {
    eligible,
    reason: reasons[0] ?? '',
    reasons,
    dims,
    printer_id: best?.id ?? '',
    notify: eligible && notify_block === '',
    notify_block,
  };
}

/** The dimension a reason belongs to. */
export function dimensionOf(code: ReasonCode): Dimension {
  for (const d of DIMENSIONS) if ((REASONS[d] as readonly string[]).includes(code)) return d;
  return 'trade';
}

/** Read a stored reasons column back, keeping only codes this build knows. */
export function readReasons(raw: unknown): ReasonCode[] {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((x): x is ReasonCode => (ALL_REASONS as readonly unknown[]).includes(x)) : [];
}
