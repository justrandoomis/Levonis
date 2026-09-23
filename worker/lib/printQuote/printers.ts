/**
 * WHAT A PRINTER IS, ECONOMICALLY.
 *
 * §10 asks for capabilities and profiles rather than a hundred
 * `if (printer === 'H2D')` branches, and §9 is emphatic about why: it is NOT
 * true that every multi-colour machine wastes the same, and it is equally NOT
 * true that an independent-toolhead machine wastes nothing. Priming, ooze and
 * standby heating are real on every architecture. So each ARCHITECTURE carries
 * measurable coefficients, and an efficient machine ends up cheaper because its
 * coefficients are smaller — not because a special case says so.
 *
 * Every number below is a PLATFORM DEFAULT and is reported as one. A merchant's
 * own measurement beats it, a model's published figure beats it, and the
 * calibration loop (§15) is expected to replace most of them with observed
 * values over time. None of them is presented to anyone as a measurement.
 */

import { sourced, type Provenance, type Sourced } from './model';

// ------------------------------------------------------- multi-material waste

/**
 * HOW A MACHINE CHANGES MATERIAL. The kinds differ in what they physically have
 * to do, which is exactly why they cost different amounts:
 *
 *   none                  one material, one nozzle. No change cost exists.
 *   single_nozzle_changer one hotend fed by a changer (AMS-style). Every change
 *                         must FLUSH the old colour out of the melt zone, which
 *                         is where tens of grams per change come from.
 *   independent_toolheads two or more complete toolheads. No flushing — but a
 *                         parked head oozes, the returning head needs a prime,
 *                         and both stay hot. Small, never zero.
 *   idex                  independent X carriages; as above, with a longer
 *                         travel and usually a wipe.
 *   toolchanger           heads docked and undocked; a dock/undock cycle costs
 *                         time and a prime, and little material.
 */
export type MultiMaterialKind =
  | 'none'
  | 'single_nozzle_changer'
  | 'independent_toolheads'
  | 'idex'
  | 'toolchanger';

export interface MultiMaterialProfile {
  kind: MultiMaterialKind;
  /**
   * Cubic millimetres flushed per material change. For a single-nozzle changer
   * this is the melt-zone volume plus the margin a clean colour needs; for the
   * multi-head kinds there is nothing to flush and this is zero.
   */
  purgeMm3PerChange: number;
  /** Cubic millimetres to re-prime a head that has been idle or parked. Never
   *  zero for a real machine: a head that has sat still has lost pressure. */
  primeMm3PerChange: number;
  /** The wipe/prime tower's own consumption, per layer on which a change
   *  happens. Machines that do not build one report zero. */
  towerMm3PerChangeLayer: number;
  /** Seconds the change itself takes — flush, travel, dock, re-prime. */
  secondsPerChange: number;
  /** Watts drawn keeping an idle head/lane hot while another prints. */
  standbyWattsPerIdleTool: number;
}

/**
 * The defaults, per architecture. They are deliberately conservative and
 * deliberately NOT branded: «Snapmaker U1 has zero waste» is exactly the claim
 * §9 forbids, and the way to let an efficient machine prove itself cheap is to
 * give it small coefficients, not an exemption.
 */
export const MULTI_MATERIAL_DEFAULTS: Record<MultiMaterialKind, MultiMaterialProfile> = {
  none: {
    kind: 'none',
    purgeMm3PerChange: 0,
    primeMm3PerChange: 0,
    towerMm3PerChangeLayer: 0,
    secondsPerChange: 0,
    standbyWattsPerIdleTool: 0,
  },
  single_nozzle_changer: {
    kind: 'single_nozzle_changer',
    // ~0.4 nozzle melt zone plus the flush a clean colour needs. This is the
    // number that makes a four-colour print cost what it actually costs.
    purgeMm3PerChange: 65,
    primeMm3PerChange: 5,
    towerMm3PerChangeLayer: 25,
    secondsPerChange: 28,
    standbyWattsPerIdleTool: 0,
  },
  independent_toolheads: {
    kind: 'independent_toolheads',
    // Nothing to flush — and still not free: the parked head oozes and the
    // returning one is re-primed.
    purgeMm3PerChange: 0,
    primeMm3PerChange: 8,
    towerMm3PerChangeLayer: 0,
    secondsPerChange: 6,
    standbyWattsPerIdleTool: 35,
  },
  idex: {
    kind: 'idex',
    purgeMm3PerChange: 0,
    primeMm3PerChange: 10,
    towerMm3PerChangeLayer: 0,
    secondsPerChange: 9,
    standbyWattsPerIdleTool: 35,
  },
  toolchanger: {
    kind: 'toolchanger',
    purgeMm3PerChange: 0,
    primeMm3PerChange: 12,
    towerMm3PerChangeLayer: 0,
    secondsPerChange: 14,
    standbyWattsPerIdleTool: 25,
  },
};

// ------------------------------------------------------------- the power model

/** What a machine draws, by phase. A print is not one wattage: the bed pulls
 *  hardest while it is coming up to temperature and much less once it is
 *  holding, and a quote that ignores that overstates a long print and
 *  understates a short one. */
export interface PowerProfile {
  idleWatts: number;
  bedHeatingWatts: number;
  nozzleHeatingWatts: number;
  /** The steady-state average while actually extruding, bed included. */
  printingWatts: number;
}

// -------------------------------------------------------------- the model card

/** Canonical, one row per machine — never copied into each merchant's record
 *  (§24). A merchant references it and overrides only their own economics. */
export interface PrinterModel {
  id: string;
  manufacturer: string;
  model: string;
  generation: string;
  technology: 'fdm' | 'resin';

  buildMm: { x: number; y: number; z: number };
  nozzleSizesMm: number[];
  defaultNozzleMm: number;
  toolheadCount: number;
  independentToolheads: boolean;
  maxSimultaneousMaterials: number;
  multiMaterial: MultiMaterialKind;

  enclosed: boolean;
  heatedChamber: boolean;
  hardenedNozzleAvailable: boolean;
  /** Material types this machine can run at all. Checked before pricing —
   *  an incompatible machine is not a more expensive option, it is no option. */
  materials: string[];

  power: PowerProfile;

  /** Purchase economics, for depreciation (§16). */
  purchaseIqd: number;
  residualIqd: number;
  usefulPrintHours: number;
  /** A per-hour reserve for nozzles, belts, plates, filters, the material
   *  system (§17). */
  maintenanceIqdPerHour: number;

  /**
   * The baseline probability that a job finishes. NOT a marketing figure and
   * not a promise: it is the conservative starting point used only until this
   * merchant has enough of their own history to replace it (§14).
   */
  baselineSuccessRate: number;

  // ---- what the machine can lay down, for the geometry path --------------
  //
  // These four are what `geometryAdapter.ts` needs to turn a measured solid
  // into an estimated print TIME without a slicer. They are machine facts, not
  // pricing choices: a hotend melts so many mm³ a second, a layer costs some
  // fixed travel, a bed takes some minutes to reach temperature. Each is stored
  // on the model row so a faster machine legitimately quotes a shorter job.

  /** Peak volumetric flow the hotend sustains, mm³/s. The real speed ceiling. */
  maxVolumetricFlowMm3PerS: number;
  /** The share of that ceiling a real print holds, once perimeters, corners and
   *  the first layer are counted. Never 1 — no print runs at peak throughout. */
  sustainedFlowFraction: number;
  /** Travel, retraction and acceleration per layer, in seconds. */
  layerOverheadSeconds: number;
  /** Minutes from cold to first layer. Charged once per PLATE (§12). */
  warmupMinutes: number;
}

/** Depreciation per printing hour: (what it cost − what it will be worth) over
 *  the hours it will print (§16). A model with no usable hours figure yields 0
 *  rather than dividing by zero and charging infinity. */
export function machineIqdPerHour(m: Pick<PrinterModel, 'purchaseIqd' | 'residualIqd' | 'usefulPrintHours'>): number {
  const recoverable = Math.max(0, m.purchaseIqd - m.residualIqd);
  if (!(m.usefulPrintHours > 0)) return 0;
  return recoverable / m.usefulPrintHours;
}

/**
 * WHAT A MERCHANT MAY CHANGE. §46: economics yes, physics no. A merchant can
 * say their machine cost less, that their power is dearer, that they are
 * slower to clean a part — and cannot say a 180 mm bed is 350 mm, because that
 * would silently accept jobs the machine cannot print.
 */
export interface MerchantPrinterOverrides {
  purchaseIqd?: number;
  residualIqd?: number;
  usefulPrintHours?: number;
  maintenanceIqdPerHour?: number;
  electricityIqdPerKwh?: number;
  laborIqdPerHour?: number;
  /** Observed success rate, once there is enough history to mean anything. */
  successRate?: number;
  successRateSamples?: number;
  /** Calibration from real prints (§15): 1.08 = this shop runs 8% slower than
   *  the slicer predicts. Applied only above the sample threshold. */
  timeFactor?: number;
  materialFactor?: number;
}

/** Below this many observed prints a merchant's own rate is not a rate, it is
 *  an anecdote — so the baseline stands and the engine says `platform` (§14). */
export const MIN_CALIBRATION_SAMPLES = 8;

/**
 * Resolves the success rate to use, and says where it came from. A merchant
 * with three prints behind them does not get to claim 100% reliability.
 */
export function resolveSuccessRate(
  model: Pick<PrinterModel, 'baselineSuccessRate'>,
  overrides?: MerchantPrinterOverrides
): Sourced {
  const rate = overrides?.successRate;
  const samples = overrides?.successRateSamples ?? 0;
  if (typeof rate === 'number' && rate > 0 && rate <= 1 && samples >= MIN_CALIBRATION_SAMPLES) {
    return sourced(rate, 'merchant', `samples:${samples}`);
  }
  const baseline = model.baselineSuccessRate > 0 && model.baselineSuccessRate <= 1 ? model.baselineSuccessRate : 0.9;
  return sourced(baseline, 'platform');
}

/** The same rule for a calibration factor: a multiplier from too little data is
 *  worse than no multiplier, because it looks like knowledge. */
export function resolveFactor(
  factor: number | undefined,
  samples: number | undefined,
  from: Provenance = 'merchant'
): Sourced {
  if (typeof factor === 'number' && factor > 0 && (samples ?? 0) >= MIN_CALIBRATION_SAMPLES) {
    return sourced(factor, from, `samples:${samples}`);
  }
  return sourced(1, 'platform');
}

/**
 * CAN THIS MACHINE DO THIS JOB AT ALL. Answered before any price, because a
 * machine that cannot is not an expensive option — it is not an option, and
 * offering it is how a shop accepts work it cannot deliver (§28).
 *
 * Returns the reasons it cannot, so the comparison table can say WHY a printer
 * is missing instead of silently dropping it.
 */
export interface EligibilityRequest {
  boundingBoxMm: { x: number; y: number; z: number };
  materialTypes: string[];
  /** Distinct materials/colours that must be loaded at the same time. */
  simultaneousMaterials: number;
  nozzleMm?: number;
  /** True when any requested material needs an enclosure (ABS/ASA/PC/PA). */
  needsEnclosure?: boolean;
  /** True when any requested material is abrasive (CF/GF filled). */
  needsHardenedNozzle?: boolean;
}

export function printerEligibility(
  m: PrinterModel,
  req: EligibilityRequest
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // The part must FIT — checked on the arrangement as sliced, in the same
  // orientation. A job that has to be cut up is a different job.
  if (
    req.boundingBoxMm.x > m.buildMm.x ||
    req.boundingBoxMm.y > m.buildMm.y ||
    req.boundingBoxMm.z > m.buildMm.z
  ) {
    reasons.push('build_volume');
  }

  const known = new Set(m.materials.map((x) => x.toUpperCase()));
  for (const t of req.materialTypes) {
    if (!known.has(t.toUpperCase())) {
      reasons.push(`material:${t}`);
      break;
    }
  }

  if (req.simultaneousMaterials > m.maxSimultaneousMaterials) reasons.push('materials_at_once');
  if (req.needsEnclosure && !m.enclosed) reasons.push('enclosure');
  if (req.needsHardenedNozzle && !m.hardenedNozzleAvailable) reasons.push('hardened_nozzle');
  if (req.nozzleMm !== undefined && !m.nozzleSizesMm.some((n) => Math.abs(n - req.nozzleMm!) < 1e-6)) {
    reasons.push('nozzle');
  }

  return { eligible: reasons.length === 0, reasons };
}

/**
 * WHICH PRINTERS THE ENGINE CANNOT TELL APART — per door.
 *
 * «مهما اخترت الطابعة لا يغير من حساب السعر». On the live catalogue that is
 * partly TRUE, and the honest fix is to say so rather than to invent figures
 * that would make it false: migration 0078 leaves every model's purchase
 * economics and wattages NULL, so two machines that also share their seeded
 * physics are, to the engine, the same machine, and quote to the same dinar.
 *
 * A signature is every printer field that can reach a price through the door
 * in question. Two printers with EQUAL signatures are guaranteed to quote the
 * same job identically, so the screen may say «السعر لا يتغيّر بهذه الطابعة»
 * without it ever being a lie. The converse is not promised (two different
 * signatures can still meet on one small job), so nothing claims it.
 *
 *   file     the calculator's file door for ONE piece in ONE material — the
 *            case the screen makes the claim for. Time comes from flow,
 *            sustained fraction, layer overhead, nozzle and warm-up, then every
 *            hourly line (power by phase, depreciation, maintenance) and the
 *            baseline success rate. The build volume, the toolhead count and the
 *            material-change mechanism are left out on purpose: with one piece
 *            that fits and no material change they reach no line of the bill
 *            (a part that does not fit is refused, not priced). With more
 *            pieces the build volume decides the plates, and the screen then
 *            makes no claim.
 *   untimed  the grams door with no print time: no machine hour is billed, and
 *            the printer reaches the price only through its baseline success
 *            rate (the failure reserve).
 *
 * The day the owner enters a model's economics in the admin editor, that model
 * leaves its file group, which is exactly how the editor shows him it worked.
 */
export function printerPriceSignature(m: PrinterModel, door: 'file' | 'untimed'): string {
  const reliability = [m.technology, m.baselineSuccessRate];
  if (door === 'untimed') return JSON.stringify(reliability);
  return JSON.stringify([
    ...reliability,
    m.power.idleWatts,
    m.power.bedHeatingWatts,
    m.power.nozzleHeatingWatts,
    m.power.printingWatts,
    m.purchaseIqd,
    m.residualIqd,
    m.usefulPrintHours,
    m.maintenanceIqdPerHour,
    m.warmupMinutes,
    m.maxVolumetricFlowMm3PerS,
    m.sustainedFlowFraction,
    m.layerOverheadSeconds,
    m.defaultNozzleMm,
  ]);
}

/**
 * The signatures above as short, opaque group labels (`f1`, `u1`…), numbered
 * in catalogue order. Opaque on purpose: the public catalogue may say WHICH
 * machines price alike, never the economics that make them so (§22).
 */
export function printerPriceGroups(
  models: readonly PrinterModel[],
  /**
   * Anything else keyed by model that reaches the price — the platform's own
   * calibration rows (`printer_calibration_stats`), which correct time,
   * material and failure per model. Folded into BOTH signatures, so two
   * machines calibrated differently are never called interchangeable.
   */
  extraByModel: ReadonlyMap<string, string> = new Map()
): Map<string, { file: string; untimed: string }> {
  const label = (prefix: string) => {
    const seen = new Map<string, string>();
    return (sig: string) => {
      if (!seen.has(sig)) seen.set(sig, `${prefix}${seen.size + 1}`);
      return seen.get(sig)!;
    };
  };
  const file = label('f');
  const untimed = label('u');
  const out = new Map<string, { file: string; untimed: string }>();
  for (const m of models) {
    const extra = extraByModel.get(m.id) ?? '';
    out.set(m.id, {
      file: file(`${printerPriceSignature(m, 'file')}|${extra}`),
      untimed: untimed(`${printerPriceSignature(m, 'untimed')}|${extra}`),
    });
  }
  return out;
}
