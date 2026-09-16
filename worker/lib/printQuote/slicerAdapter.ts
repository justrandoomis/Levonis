/**
 * THE SLICER IS AUTHORITATIVE, AND IT DOES NOT MEASURE EVERYTHING.
 *
 * This is the only place `three-slicer`'s `SliceStats` becomes a `PrintAnalysis`,
 * and the reason it is worth its own file is that the honest answer is
 * uncomfortable: the engine reports filament as LENGTH, splits it by tool and
 * by purge, and does NOT separate support, interface, brim or raft.
 *
 * What the engine actually gives (engine/index.d.ts, verified):
 *
 *   filament_mm                mm of INPUT filament, all tools, all roles
 *   filament_mm_by_tool?       per tool; sums to filament_mm       (multi only)
 *   filament_mm_purge?         the prime/wipe tower's share,
 *                              ALREADY COUNTED inside the per-tool figures
 *   filament_mm_purge_by_tool? per tool                             (multi only)
 *   time_estimate              seconds — 0 in economy mode
 *   layers / model_layers / raft_layers
 *   role_times                 SECONDS per extrusion role — not grams
 *   over_bed / over_bed_model  whether anything, or the part itself, left the bed
 *
 * So support grams cannot be read off a single slice. `role_times` is seconds,
 * and dividing a time share to get a mass share would be inventing a number:
 * roles run at different flow rates, and §53 forbids exactly that kind of
 * plausible arithmetic dressed as a measurement.
 *
 * There are two honest ways to get it, and both are here:
 *
 *   1. SAY YOU DID NOT MEASURE IT. `analysisFromStats` marks the buckets it
 *      could not separate in `unmeasured`, and the UI says so rather than
 *      showing a support line of zero — which would read as "no support".
 *   2. MEASURE IT WITH A SECOND SLICE. `attributeSupport` takes the same file
 *      sliced with supports OFF and attributes the DIFFERENCE to support. That
 *      is a measurement, not a guess; it costs one more slice, so it is opt-in
 *      (§26 warns against unbounded slicing).
 */

import {
  sourced,
  type AnalysisMaterial,
  type CostComponent,
  type PrintAnalysis,
  type Provenance,
} from './model';

/** The subset of `three-slicer`'s SliceStats this module reads. Declared here
 *  rather than imported so the Worker — which has no Studio dependency — can
 *  validate a payload that arrives over the wire. */
export interface SlicerStatsInput {
  filament_mm: number;
  filament_mm_by_tool?: number[];
  filament_mm_purge?: number;
  filament_mm_purge_by_tool?: number[];
  time_estimate: number;
  first_layer_time?: number;
  layers: number;
  model_layers?: number;
  raft_layers?: number;
  over_bed?: boolean;
  over_bed_model?: boolean;
  economy?: boolean;
  error?: string;
}

/** What each tool was loaded with, which the SLICER does not know — it knows
 *  tool numbers. The caller (Studio, which set the profile) supplies it. */
export interface ToolAssignment {
  slot: number;
  materialId: string;
  materialType: string;
  colorHex: string;
  /** g/cm³. PLA ≈ 1.24, PETG ≈ 1.27, ABS ≈ 1.04, TPU ≈ 1.21. */
  densityGPerCm3: number;
  /** Filament stock diameter in mm. 1.75 unless the shop runs 2.85. */
  diameterMm?: number;
}

export const DEFAULT_FILAMENT_DIAMETER_MM = 1.75;

/**
 * Millimetres of filament → grams. The one conversion the whole engine rests
 * on, and it is pure geometry: a cylinder of stock, times its density.
 *
 * Getting the diameter wrong is a 165% error (2.85 mm stock carries 2.65× the
 * volume of 1.75 mm per millimetre), which is why it is an explicit input and
 * not a constant buried in a formula.
 */
export function filamentMmToGrams(mm: number, densityGPerCm3: number, diameterMm = DEFAULT_FILAMENT_DIAMETER_MM): number {
  if (!(mm > 0) || !(densityGPerCm3 > 0) || !(diameterMm > 0)) return 0;
  const radius = diameterMm / 2;
  const mm3 = mm * Math.PI * radius * radius;
  // mm³ → cm³ is ÷1000; cm³ × g/cm³ is grams.
  return (mm3 / 1000) * densityGPerCm3;
}

/** The inverse, for a merchant entering "I used 184 g" against an estimate. */
export function gramsToFilamentMm(grams: number, densityGPerCm3: number, diameterMm = DEFAULT_FILAMENT_DIAMETER_MM): number {
  if (!(grams > 0) || !(densityGPerCm3 > 0) || !(diameterMm > 0)) return 0;
  const radius = diameterMm / 2;
  return (grams * 1000) / densityGPerCm3 / (Math.PI * radius * radius);
}

export interface AnalysisFromStatsOptions {
  fileSha256: string;
  slicerVersion: string;
  profileRevision: string;
  tools: ToolAssignment[];
  boundingBoxMm: { x: number; y: number; z: number };
  modelVolumeMm3: number;
  partCount: number;
  layerHeightMm: number;
  plateCount: number;
  piecesPerPlate: number;
  /** Warm-up minutes. The slicer's estimate covers the TOOLPATH only; how long
   *  a bed takes to reach temperature is a property of the machine, so it
   *  arrives from the printer profile and is marked `profile`, not `measured`. */
  preparationMinutes: number;
  /** Counted by the caller from the tool sequence; the engine does not report it. */
  toolChanges?: number;
}

export interface AnalysisFromStats {
  analysis: PrintAnalysis;
  /** Gram buckets this slice could NOT separate. A zero in one of these means
   *  "not measured", never "none" — and the UI must say which. */
  unmeasured: CostComponent[];
  /** Why the analysis is not usable at all, when it is not. */
  refusal?: 'slice_failed' | 'no_filament' | 'no_tools' | 'off_bed' | 'no_time_estimate';
}

/**
 * One slice → one analysis. Every gram it can attribute, it attributes; every
 * gram it cannot, it puts in `modelGrams` and NAMES in `unmeasured`.
 *
 * Putting the unattributed remainder in `modelGrams` rather than spreading it
 * is deliberate: the TOTAL stays exactly what the slicer measured, so the
 * material cost is right to the gram even when the breakdown is coarse. A
 * breakdown that summed to more or less than the measurement would be worse
 * than a coarse one.
 */
export function analysisFromStats(stats: SlicerStatsInput, opts: AnalysisFromStatsOptions): AnalysisFromStats {
  const unmeasured: CostComponent[] = ['SUPPORT_MATERIAL', 'SUPPORT_INTERFACE', 'BRIM_RAFT'];

  const empty = (refusal: AnalysisFromStats['refusal']): AnalysisFromStats => ({
    analysis: blankAnalysis(opts),
    unmeasured,
    refusal,
  });

  if (stats.error) return empty('slice_failed');
  if (!opts.tools.length) return empty('no_tools');
  if (!(stats.filament_mm > 0)) return empty('no_filament');
  // `over_bed_model` is the one that matters: skirt or brim clipping the edge
  // is a setting, a MODEL off the bed is a job this printer cannot do.
  if (stats.over_bed_model) return empty('off_bed');
  // Economy mode skips the time estimate entirely, and a quote with no machine
  // hours is not a quote — it is a material bill.
  if (!(stats.time_estimate > 0)) return empty('no_time_estimate');

  const byTool = stats.filament_mm_by_tool;
  const purgeByTool = stats.filament_mm_purge_by_tool;
  const singleTool = !byTool || byTool.length === 0;

  const materials: AnalysisMaterial[] = opts.tools.map((tool, index) => {
    const diameter = tool.diameterMm ?? DEFAULT_FILAMENT_DIAMETER_MM;
    // A single-material slice reports no per-tool array; the one tool owns it.
    const toolMm = singleTool ? (index === 0 ? stats.filament_mm : 0) : (byTool![tool.slot] ?? byTool![index] ?? 0);
    const purgeMm = purgeByTool
      ? (purgeByTool[tool.slot] ?? purgeByTool[index] ?? 0)
      : singleTool && index === 0
        ? (stats.filament_mm_purge ?? 0)
        : 0;

    const totalGrams = filamentMmToGrams(toolMm, tool.densityGPerCm3, diameter);
    // THE ENGINE'S OWN WORDS: purge is "already counted inside the per-tool
    // figures above". Subtracting it is what stops it being billed twice.
    const purgeGrams = Math.min(totalGrams, filamentMmToGrams(purgeMm, tool.densityGPerCm3, diameter));

    return {
      slot: tool.slot,
      materialId: tool.materialId,
      materialType: tool.materialType,
      colorHex: tool.colorHex,
      modelGrams: Math.max(0, totalGrams - purgeGrams),
      supportGrams: 0,
      supportInterfaceGrams: 0,
      purgeGrams,
      // The engine folds the wipe tower into `filament_mm_purge`; keeping this
      // at zero rather than splitting it arbitrarily is the honest reading.
      primeTowerGrams: 0,
      brimRaftGrams: 0,
      otherWasteGrams: 0,
    };
  });

  return {
    analysis: {
      fileSha256: opts.fileSha256,
      slicerVersion: opts.slicerVersion,
      profileRevision: opts.profileRevision,
      provenance: 'measured',
      boundingBoxMm: opts.boundingBoxMm,
      modelVolumeMm3: opts.modelVolumeMm3,
      partCount: opts.partCount,
      layerCount: stats.layers,
      layerHeightMm: opts.layerHeightMm,
      printMinutesPerPlate: stats.time_estimate / 60,
      preparationMinutes: opts.preparationMinutes,
      plateCount: Math.max(1, Math.floor(opts.plateCount)),
      piecesPerPlate: Math.max(1, Math.floor(opts.piecesPerPlate)),
      materials,
      toolChanges: Math.max(0, Math.floor(opts.toolChanges ?? 0)),
    },
    unmeasured: stats.filament_mm_purge === undefined && !purgeByTool ? [...unmeasured, 'PURGE'] : unmeasured,
  };
}

/**
 * THE SECOND SLICE, AND WHAT IT BUYS.
 *
 * Same file, same profile, supports switched OFF. Whatever the first slice used
 * that this one does not is support — measured by difference, which is a real
 * measurement and not a share of a time budget.
 *
 * It also recovers the extra TIME support costs, which matters more than the
 * grams on a tall part: support can double a print without doubling its mass.
 *
 * Refuses rather than guesses when the two runs are not comparable — a
 * no-support slice that used MORE filament means the profiles differed, and
 * attributing a negative difference to support would produce a credit.
 */
export function attributeSupport(
  withSupport: PrintAnalysis,
  withoutSupportStats: Pick<SlicerStatsInput, 'filament_mm' | 'time_estimate'>,
  tools: ToolAssignment[]
): { analysis: PrintAnalysis; measured: boolean; supportMinutes: number } {
  const primary = tools[0];
  if (!primary) return { analysis: withSupport, measured: false, supportMinutes: 0 };

  const totalGrams = withSupport.materials.reduce((s, m) => s + m.modelGrams + m.purgeGrams, 0);
  const withoutGrams = filamentMmToGrams(
    withoutSupportStats.filament_mm,
    primary.densityGPerCm3,
    primary.diameterMm ?? DEFAULT_FILAMENT_DIAMETER_MM
  );
  const supportGrams = totalGrams - withoutGrams;
  const supportMinutes = (withSupport.printMinutesPerPlate * 60 - withoutSupportStats.time_estimate) / 60;

  // A difference that is negative, or larger than the whole job, is not a
  // support figure — it is two runs that were not the same job.
  if (!(supportGrams > 0) || supportGrams >= totalGrams) {
    return { analysis: withSupport, measured: false, supportMinutes: Math.max(0, supportMinutes) };
  }

  // Attributed to the tool that prints the support. With a dedicated support
  // material loaded that is its own slot; without one it is the model's tool,
  // which is what a single-nozzle machine actually does.
  const materials = withSupport.materials.map((m, i) =>
    i === 0 ? { ...m, modelGrams: Math.max(0, m.modelGrams - supportGrams), supportGrams } : m
  );

  return {
    analysis: { ...withSupport, materials },
    measured: true,
    supportMinutes: Math.max(0, supportMinutes),
  };
}

function blankAnalysis(opts: AnalysisFromStatsOptions): PrintAnalysis {
  return {
    fileSha256: opts.fileSha256,
    slicerVersion: opts.slicerVersion,
    profileRevision: opts.profileRevision,
    provenance: 'measured',
    boundingBoxMm: opts.boundingBoxMm,
    modelVolumeMm3: opts.modelVolumeMm3,
    partCount: opts.partCount,
    layerCount: 0,
    layerHeightMm: opts.layerHeightMm,
    printMinutesPerPlate: 0,
    preparationMinutes: opts.preparationMinutes,
    plateCount: 1,
    piecesPerPlate: 1,
    materials: [],
    toolChanges: 0,
  };
}

// --------------------------------------------------------------- the fingerprint

/**
 * WHEN A CACHED ANALYSIS MAY BE REUSED (§36).
 *
 * Every input that can change a measurable output is in the key. Leaving one
 * out is how a customer gets last week's price for this week's settings — and
 * the file hash alone is NOT enough, because the same file at a different layer
 * height is a different job.
 *
 * It deliberately does NOT include the user: the analysis is a property of the
 * file and the settings, not of who asked. Access control is the route's job
 * (a cached analysis is only ever returned to someone who can read that file),
 * and mixing identity in here would defeat the cache for no security gain.
 */
export function analysisFingerprint(parts: {
  fileSha256: string;
  printerModelId: string;
  profileRevision: string;
  slicerVersion: string;
  qualityId: string;
  strengthId: string;
  nozzleMm: number;
  supports: boolean;
  materialIds: string[];
  orientationKey: string;
}): string {
  return [
    parts.fileSha256,
    parts.printerModelId,
    parts.profileRevision,
    parts.slicerVersion,
    parts.qualityId,
    parts.strengthId,
    parts.nozzleMm.toFixed(2),
    parts.supports ? 's1' : 's0',
    [...parts.materialIds].sort().join('+'),
    parts.orientationKey,
  ].join('|');
}

// ------------------------------------------------------------- image estimates

/**
 * A PHOTO IS NOT A MODEL, AND THE ENGINE MUST NOT PRETEND OTHERWISE (§3).
 *
 * A picture carries no internal volume, no wall thickness and no support
 * geometry. What it can carry — once a person supplies at least one real
 * dimension — is an OUTLINE, and from an outline plus a solidity ratio you get
 * a volume that is honest about being an approximation.
 *
 * Every field produced here is `inferred`, which drags the whole quote to
 * `estimated` and forces a range. The caller must also show the sentence §3
 * asks for: «للحصول على سعر دقيق، ارفع ملف STL أو 3MF.»
 *
 * Returns null when there is no scale at all, because §50 says to ask for more
 * information rather than print a number that cannot be meant.
 */
export function volumeFromImageEstimate(input: {
  widthMm?: number;
  heightMm?: number;
  depthMm?: number;
  /** 0..1 — how much of the bounding box is actually solid. A vase is ~0.15, a
   *  bracket ~0.4, a solid block 1. Chosen by a person or by a vision model
   *  that is ASKED to classify, never to measure. */
  solidity: number;
  /** Fraction of the enclosed volume that is actually extruded, i.e. infill and
   *  walls rather than air. */
  infillRatio: number;
}): { volumeMm3: number; boundingBoxMm: { x: number; y: number; z: number }; provenance: Provenance } | null {
  const known = [input.widthMm, input.heightMm, input.depthMm].filter((d): d is number => typeof d === 'number' && d > 0);
  if (known.length === 0) return null;

  // With one or two dimensions given, the missing ones are assumed equal to the
  // smallest known one — the least-surprising assumption, and one the UI states
  // out loud rather than hiding.
  const fallback = Math.min(...known);
  const x = input.widthMm && input.widthMm > 0 ? input.widthMm : fallback;
  const y = input.depthMm && input.depthMm > 0 ? input.depthMm : fallback;
  const z = input.heightMm && input.heightMm > 0 ? input.heightMm : fallback;

  const solidity = Math.min(1, Math.max(0.01, input.solidity));
  const infill = Math.min(1, Math.max(0.05, input.infillRatio));
  return {
    volumeMm3: x * y * z * solidity * infill,
    boundingBoxMm: { x, y, z },
    provenance: 'inferred',
  };
}

/** The confidence an image-derived analysis may claim — never `measured`. */
export const imageAnalysisProvenance = sourced(0, 'inferred').from;
