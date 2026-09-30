/**
 * THE ESTIMATE CONTRACT — the one public shape a price estimate leaves the
 * Worker in (docs/MERCHANT_PLATFORM_V2.md §4.1, rows E1–E4).
 *
 * Two engines price a print today: engine A (`worker/lib/printPricing.ts`,
 * the request wizard's geometry model) and engine B (`worker/lib/printQuote/*`,
 * the calculator's slicer-or-modelled path). They will converge (E10, P11);
 * until they do, every screen that shows a customer a price reads THIS shape
 * and never either engine's own result. The adapters in ./index.ts build it.
 *
 * WHAT IT NEVER CARRIES. `cost_lines`, `cost_iqd`, `floor_iqd`,
 * `margin_percent`, `lines` — the shop's economics (§22 of the quote engine
 * mandate). The shape has no field that could hold one; the explanation a
 * customer gets («لماذا هذا السعر؟») is ORDINAL: which factors weigh most,
 * which weigh some, what the price covers and what it excludes. A share is
 * bucketed before it leaves, so no reader can subtract their way back to a
 * line. `tests/printEstimateContract.test.ts` serialises the payload of both
 * routes and asserts none of the forbidden fragments appear.
 *
 * WHAT IS CLOSED. Every key below is a member of a closed list the client
 * localises (ar / en / ckb in the estimate feature's own strings.ts). A new
 * key is added HERE first, so the client wave and P6's EstimateCard build on
 * a vocabulary that cannot drift by accident.
 */

/** Bumped when the SHAPE changes, not when a price does. */
export const ESTIMATE_CONTRACT_VERSION = 1;

// ------------------------------------------------------------- the vocabulary

/**
 * What a price is made of, in the customer's words. Each engine's cost lines
 * fold into these (see ./explain.ts): `material` is plastic + its waste +
 * purge; `machine` is the machine hour + energy; `labor` is setup + handling;
 * `support` is support plastic + the hands that remove it; `finishing` is the
 * post-processing the customer asked for; `failure_risk` the provision for
 * runs that fail; `complexity` the slow-down of a convoluted model;
 * `accessories` the magnets, LEDs and rings the model calls for; `packaging`
 * the box (engine B only, and only when a merchant prices one).
 */
export const ESTIMATE_FACTOR_KEYS = [
  'material',
  'machine',
  'labor',
  'support',
  'finishing',
  'failure_risk',
  'complexity',
  'accessories',
  'packaging',
] as const;
export type EstimateFactorKey = (typeof ESTIMATE_FACTOR_KEYS)[number];

/** `covers[]` uses the same words as the factors: a cover is a factor that is
 *  in the price at all, whatever its weight. */
export type EstimateCoverKey = EstimateFactorKey;

/**
 * What the price does NOT include and the customer might assume it does.
 * `delivery` is on every estimate until delivery is priced into it (W4);
 * `machine` appears when a job was priced from a stated weight with no print
 * time, so the machine hours could not honestly be charged.
 */
export const ESTIMATE_EXCLUDE_KEYS = ['delivery', 'machine'] as const;
export type EstimateExcludeKey = (typeof ESTIMATE_EXCLUDE_KEYS)[number];

/** Ordinal weights. A factor under the `some` threshold is omitted, not
 *  reported as `little` — its absence is the information. */
export const ESTIMATE_FACTOR_WEIGHTS = ['most', 'some'] as const;
export type EstimateFactorWeight = (typeof ESTIMATE_FACTOR_WEIGHTS)[number];

/** Share of the priced cost at which a factor is `most` / `some` (E2). */
export const FACTOR_MOST_SHARE = 0.4;
export const FACTOR_SOME_SHARE = 0.15;

/**
 * Why the confidence is what it is, or why nothing could be priced. Engine A's
 * `confidence_reasons` and unpriced `reason` codes are here verbatim; the last
 * three are engine B's, which has no reason list of its own and only a
 * provenance to read.
 */
export const ESTIMATE_REASON_CODES = [
  // engine A — confidence
  'GEOMETRY_NOT_MEASURED',
  'VOLUME_ESTIMATED_BY_CUSTOMER',
  'UNIT_ASSUMED_AND_SIZE_IMPLAUSIBLE',
  'MESH_NOT_WATERTIGHT',
  'TOPOLOGY_NOT_ANALYSED',
  'MANY_PARTS',
  'POST_PROCESSING_ESTIMATED',
  'MULTICOLOR',
  'MATERIAL_NOT_CHOSEN',
  // engine A — unpriced
  'MATERIAL_UNKNOWN',
  'NO_GEOMETRY',
  // engine B
  'MATERIAL_NOT_PRICED',
  'NOT_SLICED',
  'PLATFORM_DEFAULTS',
] as const;
export type EstimateReasonCode = (typeof ESTIMATE_REASON_CODES)[number];

export type EstimateConfidence = 'high' | 'medium' | 'low';

/** The quantities every curve carries, plus the one that was asked for (E4). */
export const ESTIMATE_CURVE_QUANTITIES = [1, 2, 5, 10] as const;

/**
 * Fragments that must never serialise out of a public estimate payload. A
 * test greps the JSON of every public route for them; a builder adding a
 * field with one of these in its name is adding a leak.
 */
export const ESTIMATE_FORBIDDEN_FRAGMENTS = ['cost_', 'floor_', 'margin_', 'lines'] as const;

// ---------------------------------------------------------------- the shape

export interface EstimateFactor {
  key: EstimateFactorKey;
  weight: EstimateFactorWeight;
}

export interface EstimateCurvePoint {
  qty: number;
  /**
   * Per piece at that quantity, so the customer sees what the count buys.
   * For engine B (`print-quote`, a WHOLE job priced from a file — nine parts
   * on one bed are one job) a «piece» is one copy of that job: `qty` counts
   * copies and `unit_iqd` is per copy, until E10 converges the engines on
   * what a piece is.
   */
  unit_iqd: number;
}

export interface EstimateEngine {
  name: 'print-pricing' | 'print-quote';
  version: number;
}

export interface Estimate {
  /** false when nothing could be priced; `reason` then says why and every
   *  number below is 0. */
  priced: boolean;
  reason?: EstimateReasonCode;

  /** The point estimate for the WHOLE job, quantity included. */
  price_iqd: number;
  price_low_iqd: number;
  price_high_iqd: number;
  /** Per piece. */
  unit_price_iqd: number;
  quantity: number;

  confidence: EstimateConfidence;
  /** Why the confidence is not higher. Empty when it is `high`. */
  reasons: EstimateReasonCode[];

  /** What weighs on the price, ordinally, heaviest first. */
  factors: EstimateFactor[];
  /** Everything that is in the price, in canonical order. */
  covers: EstimateCoverKey[];
  /** What is not, and might be assumed to be. */
  excludes: EstimateExcludeKey[];

  /** Per-piece price at 1, 2, 5, 10 and the requested quantity, ascending.
   *  Pure re-runs of the same engine — never an interpolation. */
  quantity_curve: EstimateCurvePoint[];

  /** '' when the material was left open (`range_basis: 'materials'`). */
  material_id: string;
  process: 'fdm' | 'resin';
  /** Whole-job minutes: machine time plus the hands around it. 0 when unknown. */
  time_minutes: number;
  material_grams: number;

  /** Present when the range spans several materials rather than one
   *  material's uncertainty. */
  range_basis?: 'materials';

  engine: EstimateEngine;
}

/** The empty estimate: what an unpriced job reads as. */
export function unpricedEstimate(
  reason: EstimateReasonCode,
  quantity: number,
  engine: EstimateEngine,
  facts: { material_id?: string; process?: Estimate['process'] } = {}
): Estimate {
  return {
    priced: false,
    reason,
    price_iqd: 0,
    price_low_iqd: 0,
    price_high_iqd: 0,
    unit_price_iqd: 0,
    quantity: Math.max(1, Math.floor(quantity || 1)),
    confidence: 'low',
    reasons: [reason],
    factors: [],
    covers: [],
    excludes: [],
    quantity_curve: [],
    material_id: facts.material_id ?? '',
    process: facts.process ?? 'fdm',
    time_minutes: 0,
    material_grams: 0,
    engine,
  };
}
