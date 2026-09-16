/**
 * GEOMETRY → ANALYSIS. The path a customer's quote actually travels.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT THE SLICER.
 *
 * `slicerAdapter.ts` converts a real slice into an analysis, and a real slice
 * is the authoritative answer (§2). But a slice needs the engine, the engine is
 * multi-megabyte WASM that has already OOM'd a phone in this repo, and the one
 * place it runs is LEVO Studio on its own origin. Two invariants stop it from
 * simply being moved:
 *
 *   §4 — do NOT run a heavy native slicer inside a Cloudflare Worker.
 *   docs/STUDIO_PLAN.md decision 6, pinned by tests/store-isolation.test.ts —
 *   the store bundle carries ZERO slicer payload and never embeds Studio. The
 *   reason is stated in that test and it is a pricing reason, not a size one:
 *   "a number the customer's machine computed is a number the customer could
 *   change, and this one decides money."
 *
 * So the customer's «احسب سعر طباعتك» is answered from the file's own geometry,
 * measured on the Worker by `modelGeometry.analyseModel` — the same measurement
 * the print-request flow already trusts. The volume, the surface area and the
 * overhang area are EXACT for a closed mesh: they are integrals over the real
 * triangles, not guesses.
 *
 * WHAT IS EXACT AND WHAT IS MODELLED, stated plainly because §53 turns on it:
 *
 *   EXACT      bounding box, solid volume, surface area, triangle count,
 *              overhang area. Measured from the file.
 *   MODELLED   how that solid becomes EXTRUSION — walls, infill, support,
 *              brim — and how long the machine takes to lay it down.
 *
 * The modelled half is a stated physical model with named coefficients, every
 * one of them a real printing parameter a person can read and change. It is
 * never dressed up as a measurement: everything this module produces carries
 * `platform` provenance, which forces `QuoteResult.confidence` to `estimated`
 * and makes the engine emit a RANGE. The moment a real slice arrives for the
 * same file and profile it replaces this wholesale, because `measured` outranks
 * `platform` on the provenance ladder.
 *
 * WHAT IT REFUSES. A format that cannot be measured, a mesh that is not closed
 * enough to have a volume, a part that does not fit the machine. Those come
 * back as a refusal with a reason, never as a number with a shrug.
 */

import type { ModelAnalysis } from '../modelGeometry';
import type { AnalysisMaterial, PrintAnalysis } from './model';
import type { PrinterModel } from './printers';

/**
 * The printing parameters that turn a solid into extrusion.
 *
 * Every field is a number a slicer profile also holds, with the value a real
 * profile uses. They are gathered here rather than scattered as literals so the
 * whole model can be read in one place — and so a merchant profile, once the
 * admin UI writes one, overrides them by passing a different object.
 */
export interface GeometryPrintingModel {
  /** Extrusion width, normally ≈ the nozzle. Two of these make a 0.4 wall 0.8. */
  extrusionWidthMm: number;
  /** Perimeters per wall. 2 is the near-universal default; 3–4 is 'strong'. */
  wallLoops: number;
  /** 0..1 of the interior. 0.15 is the default nearly every slicer ships. */
  infillFraction: number;
  layerHeightMm: number;
  /**
   * Fraction of the bounding height a support column spans, on average.
   *
   * THE ONE COEFFICIENT WITH NO SLICER EQUIVALENT, and the weakest number in
   * this module — a slicer knows what is under each overhanging face, and a
   * bounding box does not. It is kept SEPARATE and named rather than folded
   * into a fudge factor precisely so it can be seen, argued with, and replaced
   * by the two-slice differential in `slicerAdapter.attributeSupport` the
   * moment a real slice exists.
   */
  supportHeightFraction: number;
  /** Support is printed sparse. 0.12 is a typical tree/normal support density. */
  supportDensity: number;
  /** The denser layer directly under the part. Share of the support volume. */
  supportInterfaceFraction: number;
  /** Brim/skirt width around the footprint, in mm. 0 disables it. */
  brimWidthMm: number;
}

/** The profile a quote uses when the customer has chosen nothing but 'standard'. */
export const STANDARD_PRINTING_MODEL: GeometryPrintingModel = {
  extrusionWidthMm: 0.42,
  wallLoops: 2,
  infillFraction: 0.15,
  layerHeightMm: 0.2,
  supportHeightFraction: 0.35,
  supportDensity: 0.12,
  supportInterfaceFraction: 0.18,
  brimWidthMm: 0,
};

/** Quality presets, matching the three LEVO Studio already offers. Layer height
 *  is the only thing quality changes — it is the only thing quality IS. */
export const QUALITY_LAYER_HEIGHT_MM: Record<string, number> = {
  draft: 0.28,
  standard: 0.2,
  fine: 0.12,
};

/** Strength presets, matching Studio's three. Walls and infill together, since
 *  a profile that adds infill without adding walls is not a real profile. */
export const STRENGTH_PRESETS: Record<string, { wallLoops: number; infillFraction: number }> = {
  light: { wallLoops: 2, infillFraction: 0.1 },
  standard: { wallLoops: 2, infillFraction: 0.15 },
  strong: { wallLoops: 4, infillFraction: 0.3 },
};

export interface GeometryAnalysisRequest {
  geometry: ModelAnalysis;
  printer: PrinterModel;
  fileSha256: string;
  /** The material every gram is attributed to. One, because geometry alone
   *  cannot tell colours apart — a multi-colour job needs a slice. */
  material: { materialId: string; materialType: string; colorHex: string; densityGPerCm3: number };
  qualityId?: string;
  strengthId?: string;
  supports?: boolean;
  nozzleMm?: number;
  /** Copies of the part. Plate packing is decided from the bounding box. */
  quantity?: number;
  /** Overrides the derived model wholesale, for a merchant's own profile. */
  model?: Partial<GeometryPrintingModel>;
}

export interface GeometryAnalysisResult {
  analysis: PrintAnalysis;
  /** Buckets this path structurally cannot measure, named for the UI (§8). */
  unmeasured: string[];
  /** Set instead of `analysis` when the file cannot be priced at all. */
  refusal?: { code: string; detail?: Record<string, number | string> };
}

const mm3ToGrams = (mm3: number, densityGPerCm3: number): number => (mm3 / 1000) * densityGPerCm3;

/** Resolves the printing model from the presets the customer actually chose. */
export function printingModelFor(req: GeometryAnalysisRequest): GeometryPrintingModel {
  const strength = STRENGTH_PRESETS[req.strengthId ?? 'standard'] ?? STRENGTH_PRESETS.standard;
  const layerHeightMm = QUALITY_LAYER_HEIGHT_MM[req.qualityId ?? 'standard'] ?? QUALITY_LAYER_HEIGHT_MM.standard;
  const nozzle = req.nozzleMm && req.nozzleMm > 0 ? req.nozzleMm : req.printer.defaultNozzleMm;
  return {
    ...STANDARD_PRINTING_MODEL,
    // Extrusion width tracks the nozzle actually fitted: a 0.6 nozzle lays a
    // wider bead, so the same two loops are a thicker wall and a heavier part.
    extrusionWidthMm: nozzle > 0 ? nozzle * 1.05 : STANDARD_PRINTING_MODEL.extrusionWidthMm,
    wallLoops: strength.wallLoops,
    infillFraction: strength.infillFraction,
    layerHeightMm,
    ...req.model,
  };
}

/**
 * HOW MANY COPIES FIT ON ONE PLATE, from the real footprint.
 *
 * A grid, with a gap between parts, because that is how a plate is actually
 * packed — and deliberately NOT the "bed area ÷ part area" shortcut, which
 * promises 11 copies of a part that tiles 8. Under-promising here costs the
 * merchant nothing; over-promising costs them a plate.
 */
export function piecesPerPlate(
  footprintMm: { x: number; y: number },
  bedMm: { x: number; y: number },
  gapMm = 6
): number {
  const fit = (partX: number, partY: number): number => {
    const cols = Math.floor((bedMm.x + gapMm) / (partX + gapMm));
    const rows = Math.floor((bedMm.y + gapMm) / (partY + gapMm));
    return Math.max(0, cols) * Math.max(0, rows);
  };
  if (footprintMm.x <= 0 || footprintMm.y <= 0) return 0;
  // Both orientations: a long thin part often tiles far better turned 90°.
  return Math.max(fit(footprintMm.x, footprintMm.y), fit(footprintMm.y, footprintMm.x));
}

/**
 * Turns a measured solid into an estimated extrusion job.
 *
 * The material model, in full:
 *
 *   wall      = surfaceArea × (extrusionWidth × wallLoops), capped at the solid
 *               volume — a part thinner than its own walls is solid, and the
 *               uncapped term would otherwise claim more material than the part
 *               contains.
 *   interior  = solidVolume − wall
 *   extruded  = wall + infillFraction × interior
 *
 * `surfaceArea × thickness` is the standard shell approximation and it is
 * slightly generous on convex parts (the outer surface is larger than the mean
 * shell surface). That direction is deliberate: a quote that is a little high
 * costs a sale, a quote that is low costs the merchant money on every unit.
 */
export function analysisFromGeometry(req: GeometryAnalysisRequest): GeometryAnalysisResult {
  const g = req.geometry;
  const printer = req.printer;
  const refuse = (code: string, detail?: Record<string, number | string>): GeometryAnalysisResult => ({
    analysis: emptyAnalysis(req),
    unmeasured: [],
    refusal: detail === undefined ? { code } : { code, detail },
  });

  if (!g.measured || !g.capability.measurable) return refuse('NOT_MEASURABLE');
  if (!(g.volume_mm3 > 0)) return refuse('ZERO_VOLUME');

  const box = { x: g.dimensions_mm.x, y: g.dimensions_mm.y, z: g.dimensions_mm.z };
  const fitsAnyWay =
    Math.min(box.x, box.y) <= Math.min(printer.buildMm.x, printer.buildMm.y) &&
    Math.max(box.x, box.y) <= Math.max(printer.buildMm.x, printer.buildMm.y) &&
    box.z <= printer.buildMm.z;
  if (!fitsAnyWay) {
    return refuse('DOES_NOT_FIT', { x: box.x, y: box.y, z: box.z, bedX: printer.buildMm.x, bedY: printer.buildMm.y, bedZ: printer.buildMm.z });
  }

  const m = printingModelFor(req);
  const quantity = Math.max(1, Math.floor(req.quantity ?? 1));
  const density = req.material.densityGPerCm3 > 0 ? req.material.densityGPerCm3 : 1.24;

  // ---- material ----------------------------------------------------------
  const wallThicknessMm = m.extrusionWidthMm * Math.max(1, m.wallLoops);
  const wallMm3 = Math.min(g.surface_area_mm2 * wallThicknessMm, g.volume_mm3);
  const interiorMm3 = Math.max(0, g.volume_mm3 - wallMm3);
  const extrudedMm3 = wallMm3 + Math.min(1, Math.max(0, m.infillFraction)) * interiorMm3;

  // Support rises under the overhanging faces — MINUS the ones lying on the
  // build plate, which the plate already holds up. Charging for those is not a
  // rounding error: a flat-bottomed part is mostly bottom, and a 20 mm cube
  // would otherwise carry a tenth of its own weight in support it never prints.
  const supportedArea = Math.max(0, g.overhang_area_mm2 - g.bed_contact_area_mm2);
  const wantsSupport = req.supports !== false && supportedArea > 0;
  const supportEnvelopeMm3 = wantsSupport ? supportedArea * box.z * m.supportHeightFraction : 0;
  const supportSolidMm3 = supportEnvelopeMm3 * Math.min(1, Math.max(0, m.supportDensity));
  const supportInterfaceMm3 = supportSolidMm3 * Math.min(1, Math.max(0, m.supportInterfaceFraction));
  const supportBodyMm3 = Math.max(0, supportSolidMm3 - supportInterfaceMm3);

  // Brim, when the profile asks for one: a ring of solid first layer.
  const footprintPerimeterMm = 2 * (box.x + box.y);
  const brimMm3 = m.brimWidthMm > 0 ? footprintPerimeterMm * m.brimWidthMm * m.layerHeightMm : 0;

  const material: AnalysisMaterial = {
    slot: 0,
    materialId: req.material.materialId,
    materialType: req.material.materialType,
    colorHex: req.material.colorHex,
    modelGrams: mm3ToGrams(extrudedMm3, density),
    supportGrams: mm3ToGrams(supportBodyMm3, density),
    supportInterfaceGrams: mm3ToGrams(supportInterfaceMm3, density),
    // A single-material job flushes nothing and builds no tower. This is not
    // the §9 "zero waste" claim that mandate forbids — that rule is about
    // pretending a MACHINE has no changeover cost. With one material loaded
    // there is no changeover to have a cost.
    purgeGrams: 0,
    primeTowerGrams: 0,
    brimRaftGrams: mm3ToGrams(brimMm3, density),
    otherWasteGrams: 0,
  };

  // ---- time --------------------------------------------------------------
  // Volumetric flow is the real constraint on a modern machine: the hotend can
  // melt so many mm³ a second and no faster. Per-layer overhead covers travel,
  // retraction and the acceleration a flow figure alone ignores.
  const flow = printer.maxVolumetricFlowMm3PerS > 0 ? printer.maxVolumetricFlowMm3PerS : 8;
  const layerCount = Math.max(1, Math.ceil(box.z / Math.max(0.04, m.layerHeightMm)));
  const perPieceExtrusionMm3 = extrudedMm3 + supportSolidMm3 + brimMm3;
  // Real prints never sustain peak flow — small perimeters, corners and the
  // first layer all run slower. The printer's own sustained fraction says how
  // much of its ceiling it actually holds.
  const sustained = Math.min(1, Math.max(0.05, printer.sustainedFlowFraction));
  const extrusionSeconds = perPieceExtrusionMm3 / (flow * sustained);
  const overheadSeconds = layerCount * Math.max(0, printer.layerOverheadSeconds);

  const perPlate = Math.max(1, piecesPerPlate({ x: box.x, y: box.y }, printer.buildMm));
  const piecesOnPlate = Math.min(perPlate, quantity);
  const plateCount = Math.ceil(quantity / perPlate);

  const analysis: PrintAnalysis = {
    fileSha256: req.fileSha256,
    // Named for what it is. Nothing downstream may mistake this for a slice.
    slicerVersion: 'levonis-geometry@1',
    profileRevision: `${printer.id}:${req.qualityId ?? 'standard'}:${req.strengthId ?? 'standard'}`,
    provenance: 'platform',
    boundingBoxMm: box,
    modelVolumeMm3: g.volume_mm3,
    partCount: Math.max(1, g.shell_count ?? 1),
    layerCount,
    layerHeightMm: m.layerHeightMm,
    printMinutesPerPlate: ((extrusionSeconds + overheadSeconds) * piecesOnPlate) / 60,
    preparationMinutes: printer.warmupMinutes,
    plateCount,
    piecesPerPlate: piecesOnPlate,
    materials: [
      {
        ...material,
        modelGrams: material.modelGrams * piecesOnPlate * plateCount,
        supportGrams: material.supportGrams * piecesOnPlate * plateCount,
        supportInterfaceGrams: material.supportInterfaceGrams * piecesOnPlate * plateCount,
        brimRaftGrams: material.brimRaftGrams * piecesOnPlate * plateCount,
      },
    ],
    toolChanges: 0,
  };

  // What this path cannot know, said out loud rather than reported as zero.
  const unmeasured = ['SUPPORT_PLACEMENT', 'SEAM_AND_TRAVEL'];
  if (g.watertight === false) unmeasured.push('OPEN_MESH_VOLUME');
  if (g.shell_count === null) unmeasured.push('PART_COUNT');

  return { analysis, unmeasured };
}

/** The shape a refusal still has to return, with every quantity zero so a
 *  caller that ignores `refusal` prices nothing rather than something wrong. */
function emptyAnalysis(req: GeometryAnalysisRequest): PrintAnalysis {
  return {
    fileSha256: req.fileSha256,
    slicerVersion: 'levonis-geometry@1',
    profileRevision: req.printer.id,
    provenance: 'platform',
    boundingBoxMm: { x: 0, y: 0, z: 0 },
    modelVolumeMm3: 0,
    partCount: 0,
    layerCount: 0,
    layerHeightMm: 0,
    printMinutesPerPlate: 0,
    preparationMinutes: 0,
    plateCount: 1,
    piecesPerPlate: 0,
    materials: [],
    toolChanges: 0,
  };
}
