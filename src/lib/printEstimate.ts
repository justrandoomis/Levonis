/**
 * THE ESTIMATE CONTRACT — the client's copy.
 *
 * Mirrors worker/lib/printEstimate/contract.ts field for field. It is the ONE
 * shape a price estimate reaches the browser in, from the request wizard's
 * `/api/marketplace/print/quote` and the calculator's
 * `/api/print-quote/analyses/:id/quote` alike (docs/MERCHANT_PLATFORM_V2.md
 * §4.1 E1–E4). The EstimateCard and its «لماذا هذا السعر؟» sheet read this and
 * nothing else.
 *
 * WHAT IS DELIBERATELY ABSENT. No cost line, no floor, no margin, no `lines`:
 * the server's shape has no field for them, and a type that named one would
 * invite a component to read what is never sent. The explanation is ordinal
 * (`factors`, `covers`, `excludes`) and every key is a member of a closed list
 * below, which the estimate feature's own strings.ts localises in ar, en and
 * Sorani (ckb). A key added on the server is added here in the same change.
 */

export const ESTIMATE_CONTRACT_VERSION = 1;

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
export type EstimateCoverKey = EstimateFactorKey;

export const ESTIMATE_EXCLUDE_KEYS = ['delivery', 'machine'] as const;
export type EstimateExcludeKey = (typeof ESTIMATE_EXCLUDE_KEYS)[number];

export type EstimateFactorWeight = 'most' | 'some';

export const ESTIMATE_REASON_CODES = [
  'GEOMETRY_NOT_MEASURED',
  'VOLUME_ESTIMATED_BY_CUSTOMER',
  'UNIT_ASSUMED_AND_SIZE_IMPLAUSIBLE',
  'MESH_NOT_WATERTIGHT',
  'TOPOLOGY_NOT_ANALYSED',
  'MANY_PARTS',
  'POST_PROCESSING_ESTIMATED',
  'MULTICOLOR',
  'MATERIAL_NOT_CHOSEN',
  'MATERIAL_UNKNOWN',
  'NO_GEOMETRY',
  'MATERIAL_NOT_PRICED',
  'NOT_SLICED',
  'PLATFORM_DEFAULTS',
] as const;
export type EstimateReasonCode = (typeof ESTIMATE_REASON_CODES)[number];

export type EstimateConfidence = 'high' | 'medium' | 'low';

export interface EstimateFactor {
  key: EstimateFactorKey;
  weight: EstimateFactorWeight;
}

export interface EstimateCurvePoint {
  qty: number;
  /** Per piece at that quantity. */
  unit_iqd: number;
}

export interface EstimateEngine {
  name: 'print-pricing' | 'print-quote';
  version: number;
}

export interface Estimate {
  /** false when nothing could be priced; `reason` says why and the numbers are 0. */
  priced: boolean;
  reason?: EstimateReasonCode;

  /** The whole job, quantity included. */
  price_iqd: number;
  price_low_iqd: number;
  price_high_iqd: number;
  /** Per piece. */
  unit_price_iqd: number;
  quantity: number;

  confidence: EstimateConfidence;
  /** Why the confidence is not higher; empty when it is `high`. */
  reasons: EstimateReasonCode[];

  /** What weighs on the price, heaviest first; under `some` is omitted. */
  factors: EstimateFactor[];
  /** Everything in the price, canonical order. */
  covers: EstimateCoverKey[];
  /** What is not in it and might be assumed to be (delivery, until W4). */
  excludes: EstimateExcludeKey[];

  /** Per-piece price at 1, 2, 5, 10 and the requested count, ascending;
   *  pure re-runs of the engine, never an interpolation. */
  quantity_curve: EstimateCurvePoint[];

  /** '' when the material was left open (`range_basis: 'materials'`). */
  material_id: string;
  process: 'fdm' | 'resin';
  /** Whole-job minutes; 0 when unknown. */
  time_minutes: number;
  material_grams: number;

  range_basis?: 'materials';

  engine: EstimateEngine;
}
