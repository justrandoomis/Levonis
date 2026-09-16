/**
 * THE PRINT QUOTE ENGINE — the vocabulary, and the one rule that governs it.
 *
 * Every number this engine touches carries a PROVENANCE, because the whole
 * difference between a quote and a guess is knowing which of the two you are
 * looking at. §44 of the mandate asks for it and §53 makes it absolute: no
 * random percentages, no hardcoded multiplier pretending to be intelligence,
 * and never an LLM-produced figure where a slicer can measure one. If the
 * slicer says 347.6 g, nothing in this file is allowed to say 320.
 *
 * AI has a real job around these numbers — orientation candidates, support
 * strategy, printability warnings, reading a photo, explaining a cost driver —
 * and none of those jobs is producing a measurable quantity.
 */

/** Bumped whenever a rule here changes meaning. Every stored quote records the
 *  version that produced it, so an old order stays explainable after the
 *  algorithm moves (§31). */
export const PRICING_ENGINE_VERSION = 1;

/**
 * WHERE A NUMBER CAME FROM.
 *
 *   measured  the slicer / geometry engine produced it. Authoritative.
 *   profile   a printer, quality or material profile states it.
 *   merchant  this merchant configured it for their own shop.
 *   platform  a Levonis default, used only because nothing better exists.
 *   inferred  derived from an image or a heuristic. NEVER a measurement, and a
 *             quote carrying one may not be presented as exact (§50).
 */
export type Provenance = 'measured' | 'profile' | 'merchant' | 'platform' | 'inferred';

/** A number and the reason you may believe it. */
export interface Sourced<T = number> {
  value: T;
  from: Provenance;
  /** The specific origin, for the audit trail: 'spool:sp_123', 'model:a1-mini'. */
  ref?: string;
}

export const sourced = <T>(value: T, from: Provenance, ref?: string): Sourced<T> =>
  ref === undefined ? { value, from } : { value, from, ref };

/** The weakest link decides. A quote is only as trustworthy as its worst input,
 *  so a single `inferred` drags the whole result down to `inferred`. */
const PROVENANCE_RANK: Record<Provenance, number> = {
  measured: 4,
  profile: 3,
  merchant: 3,
  platform: 2,
  inferred: 1,
};

export function weakestProvenance(values: Array<Provenance | undefined>): Provenance {
  let worst: Provenance = 'measured';
  for (const v of values) {
    if (!v) continue;
    if (PROVENANCE_RANK[v] < PROVENANCE_RANK[worst]) worst = v;
  }
  return worst;
}

/**
 * HOW MUCH THE ANSWER CAN BE TRUSTED — and it is decided by the inputs, not
 * chosen for presentation (§50).
 *
 *   exact      every measurable quantity came from a slicer run of THIS file
 *              on THIS profile. A single number may be shown.
 *   estimated  the measurable quantities are real but something material was
 *              defaulted, or the geometry was scaled/approximated. Show a RANGE.
 *   insufficient  there is not enough information to price honestly. Ask for
 *              more rather than printing a number.
 */
export type QuoteConfidence = 'exact' | 'estimated' | 'insufficient';

// ---------------------------------------------------------------- the analysis

/** One material the job consumes, and where every gram of it goes. Grams are
 *  split by PURPOSE because §8 forbids hiding support inside "total filament":
 *  the admin has to be able to see which part of the bill is waste. */
export interface AnalysisMaterial {
  /** The slot the slicer used — tool index, AMS lane, extruder. */
  slot: number;
  /** Catalogue material id when known, else the raw profile name. */
  materialId: string;
  /** 'PLA' | 'PETG' | … Used for compatibility, never for pricing. */
  materialType: string;
  colorHex: string;
  /** Grams that end up in the customer's part. */
  modelGrams: number;
  /** Grams printed as support, and as the denser interface under it. */
  supportGrams: number;
  supportInterfaceGrams: number;
  /** Grams flushed when switching to or from this material. */
  purgeGrams: number;
  /** Grams spent on the prime/wipe tower attributable to this material. */
  primeTowerGrams: number;
  /** Grams in brim, raft, skirt — bed adhesion, not the part. */
  brimRaftGrams: number;
  /** Anything the slicer reports that is none of the above. */
  otherWasteGrams: number;
}

export const materialTotalGrams = (m: AnalysisMaterial): number =>
  m.modelGrams +
  m.supportGrams +
  m.supportInterfaceGrams +
  m.purgeGrams +
  m.primeTowerGrams +
  m.brimRaftGrams +
  m.otherWasteGrams;

export const materialWasteGrams = (m: AnalysisMaterial): number =>
  materialTotalGrams(m) - m.modelGrams;

/**
 * What the slicer measured. Nothing in here may be produced by a language
 * model; a photo-only estimate populates the same shape but every field is
 * marked `inferred` and the quote's confidence drops accordingly.
 */
export interface PrintAnalysis {
  /** SHA-256 of the source file — half of the cache fingerprint (§36). */
  fileSha256: string;
  /** The engine + profile revision that produced it, the other half. */
  slicerVersion: string;
  profileRevision: string;
  provenance: Provenance;

  /** Millimetres, after the orientation that was actually sliced. */
  boundingBoxMm: { x: number; y: number; z: number };
  /** Cubic millimetres of solid part — geometry, not extrusion. */
  modelVolumeMm3: number;
  partCount: number;

  layerCount: number;
  layerHeightMm: number;
  /** Minutes the slicer estimates for ONE plate of this arrangement. */
  printMinutesPerPlate: number;
  /** Bed/nozzle warm-up and the run-up before the first layer. */
  preparationMinutes: number;

  /** How many plates this job needs on the chosen printer. */
  plateCount: number;
  /** Pieces that fit on one plate, for batch maths (§12). */
  piecesPerPlate: number;

  materials: AnalysisMaterial[];
  /** How many times the machine swapped material. Drives purge and time. */
  toolChanges: number;
}

/** Total minutes of machine time for the whole job, every plate included. */
export const totalPrintMinutes = (a: PrintAnalysis): number =>
  Math.max(0, a.plateCount) * (Math.max(0, a.printMinutesPerPlate) + Math.max(0, a.preparationMinutes));

// ------------------------------------------------------------ the cost result

/**
 * The components §33 requires as STRUCTURED rows, not one JSON blob. A shop
 * cannot ask "where is my money going" of a blob, and the whole point of the
 * merchant view is that the answer is visible.
 */
export type CostComponent =
  | 'MODEL_MATERIAL'
  | 'SUPPORT_MATERIAL'
  | 'SUPPORT_INTERFACE'
  | 'PURGE'
  | 'PRIME_TOWER'
  | 'BRIM_RAFT'
  | 'OTHER_WASTE'
  | 'ELECTRICITY'
  | 'DEPRECIATION'
  | 'MAINTENANCE'
  | 'LABOR'
  | 'POST_PROCESSING'
  | 'PACKAGING'
  | 'OVERHEAD'
  | 'PLATFORM_FEES'
  | 'FAILURE_RESERVE';

/** Everything that is consumed again on a retry. The failure reserve is built
 *  from exactly these, which is what stops a fixed setup fee from being charged
 *  twice for one job (§13). */
export const VARIABLE_COMPONENTS: ReadonlySet<CostComponent> = new Set<CostComponent>([
  'MODEL_MATERIAL',
  'SUPPORT_MATERIAL',
  'SUPPORT_INTERFACE',
  'PURGE',
  'PRIME_TOWER',
  'BRIM_RAFT',
  'OTHER_WASTE',
  'ELECTRICITY',
  'DEPRECIATION',
  'MAINTENANCE',
]);

export interface CostLine {
  component: CostComponent;
  /** IQD, rounded to the dinar — the smallest unit anyone actually pays in. */
  iqd: number;
  from: Provenance;
  /** Free-form detail for the merchant panel: '184 g PLA @ 18,000/kg'. */
  detail?: string;
}

export interface QuoteResult {
  engineVersion: number;
  confidence: QuoteConfidence;
  /** Every component, in the order above, zeros omitted. */
  lines: CostLine[];
  /** What one successful print costs, with no risk allowance. */
  baseCostIqd: number;
  /** The expected extra cost of the attempts that fail (§13). Never hidden
   *  inside the filament number. */
  failureReserveIqd: number;
  /** baseCost + failureReserve. What the job is expected to cost. */
  trueExpectedCostIqd: number;
  /** The price the merchant is advised to charge. */
  recommendedPriceIqd: number;
  profitIqd: number;
  /** profit ÷ price. Not markup — see `markupPercent`. */
  marginPercent: number;
  /** profit ÷ cost. The other number, named separately, because §21 says not
   *  to confuse them. */
  markupPercent: number;
  /** The price at which profit is exactly zero. */
  breakEvenIqd: number;
  /** Grams that never reach the customer, and their share of the total. */
  wasteGrams: number;
  wastePercent: number;
  /** Machine hours, for the per-hour profitability the merchant panel shows. */
  machineHours: number;
  /** A range, for anything not `exact`. Equal bounds when it is. */
  rangeIqd: { low: number; high: number };
}

/** IQD is not divisible below the dinar. Every money value the engine emits
 *  goes through this, so nothing downstream has to decide how to round. */
export const iqd = (n: number): number => (Number.isFinite(n) ? Math.round(n) : 0);
