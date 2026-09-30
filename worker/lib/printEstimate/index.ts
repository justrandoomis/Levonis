/**
 * THE ADAPTERS — each engine's result, folded into the one `Estimate` (E1).
 *
 * `fromEngineA` reads a `Quote` from worker/lib/printPricing.ts (the request
 * wizard's engine, whose `estimateFor` may also hand back a range across
 * materials); `fromEngineB` reads a `QuoteResult` from worker/lib/printQuote
 * (the calculator's engine). Both return the same shape, and neither copies a
 * cost line, a floor or a margin into it — the shape has nowhere to put one.
 *
 * The quantity curve is the caller's re-run (see `quantityCurve`), because
 * only the route knows how it built the engine's input. `engineBUnitPriceAt`
 * is the pure re-run for engine B, kept here because it knows one thing a
 * route should not have to: the hardware handed to `priceJob` is already
 * multiplied by the copy count and must be re-scaled per quantity.
 */
import { PRINT_PRICING_VERSION, type Quote as EngineAQuote } from '../printPricing';
import { priceJob, type PricingInputs } from '../printQuote/cost';
import { materialTotalGrams, type PrintAnalysis, type QuoteResult } from '../printQuote/model';
import {
  type Estimate,
  type EstimateConfidence,
  type EstimateCurvePoint,
  type EstimateExcludeKey,
  type EstimateReasonCode,
  ESTIMATE_REASON_CODES,
  unpricedEstimate,
} from './contract';
import { coversFrom, engineAAmounts, engineBAmounts, excludesFrom, factorsFrom } from './explain';

export * from './contract';
export { quantityCurve } from './explain';

const REASONS = new Set<string>(ESTIMATE_REASON_CODES);
/** A code the contract does not list is dropped, not forwarded: the client
 *  localises a closed list and an unknown code would render as its raw name. */
const knownReasons = (codes: ReadonlyArray<string>): EstimateReasonCode[] =>
  [...new Set(codes)].filter((c): c is EstimateReasonCode => REASONS.has(c));

/** Delivery is outside every estimate until W4 prices it in. */
const BASE_EXCLUDES: EstimateExcludeKey[] = ['delivery'];

// ---------------------------------------------------------------- engine A

export interface FromEngineAOptions {
  /** The count the customer asked for — `Quote` does not carry it. */
  quantity: number;
  /** From `quantityCurve(quantity, (qty) => re-run.unit_price_iqd)`. */
  curve: EstimateCurvePoint[];
  excludes?: EstimateExcludeKey[];
}

export function fromEngineA(q: EngineAQuote & { range_basis?: 'materials' }, opts: FromEngineAOptions): Estimate {
  const engine = { name: 'print-pricing' as const, version: PRINT_PRICING_VERSION };
  const quantity = Math.max(1, Math.floor(opts.quantity || 1));
  if (!q.priced) {
    const reason = knownReasons([q.reason ?? ''])[0] ?? 'NO_GEOMETRY';
    return unpricedEstimate(reason, quantity, engine, { material_id: q.material_id, process: q.process });
  }
  const amounts = engineAAmounts(q.cost_lines);
  const estimate: Estimate = {
    priced: true,
    price_iqd: q.price_iqd,
    price_low_iqd: q.price_low_iqd,
    price_high_iqd: q.price_high_iqd,
    unit_price_iqd: q.unit_price_iqd,
    quantity,
    confidence: q.confidence,
    reasons: knownReasons(q.confidence_reasons),
    factors: factorsFrom(amounts),
    covers: coversFrom(amounts),
    excludes: excludesFrom([...BASE_EXCLUDES, ...(opts.excludes ?? [])]),
    quantity_curve: opts.curve,
    material_id: q.material_id,
    process: q.process,
    time_minutes: q.total_time_minutes,
    material_grams: q.material_grams,
    engine,
  };
  if (q.range_basis === 'materials') estimate.range_basis = 'materials';
  return estimate;
}

// ---------------------------------------------------------------- engine B

export interface FromEngineBOptions {
  analysis: PrintAnalysis;
  process: Estimate['process'];
  quantity: number;
  curve: EstimateCurvePoint[];
  excludes?: EstimateExcludeKey[];
}

const CONFIDENCE_B: Record<QuoteResult['confidence'], EstimateConfidence> = {
  exact: 'high',
  estimated: 'medium',
  insufficient: 'low',
};

export function fromEngineB(r: QuoteResult, opts: FromEngineBOptions): Estimate {
  const engine = { name: 'print-quote' as const, version: r.engineVersion };
  const quantity = Math.max(1, Math.floor(opts.quantity || 1));
  const materialId = opts.analysis.materials[0]?.materialId ?? '';
  if (r.confidence === 'insufficient' || !(r.recommendedPriceIqd > 0)) {
    return unpricedEstimate('MATERIAL_NOT_PRICED', quantity, engine, { material_id: materialId, process: opts.process });
  }
  // Engine B has no reason list, only a provenance: a modelled (not sliced)
  // geometry is the doubt when it is there; otherwise a platform default —
  // a catalogue price or the platform's machine rate — is what kept the
  // result from `exact`.
  const reasons: EstimateReasonCode[] =
    r.confidence === 'exact'
      ? []
      : opts.analysis.provenance === 'platform' || opts.analysis.provenance === 'inferred'
        ? ['NOT_SLICED']
        : ['PLATFORM_DEFAULTS'];
  const amounts = engineBAmounts(r.lines);
  const grams = opts.analysis.materials.reduce((sum, m) => sum + materialTotalGrams(m), 0) * quantity;
  return {
    priced: true,
    price_iqd: r.recommendedPriceIqd,
    price_low_iqd: r.rangeIqd.low,
    price_high_iqd: r.rangeIqd.high,
    unit_price_iqd: Math.round(r.recommendedPriceIqd / quantity),
    quantity,
    confidence: CONFIDENCE_B[r.confidence],
    reasons,
    factors: factorsFrom(amounts),
    covers: coversFrom(amounts),
    excludes: excludesFrom([...BASE_EXCLUDES, ...(opts.excludes ?? [])]),
    quantity_curve: opts.curve,
    material_id: materialId,
    process: opts.process,
    time_minutes: Math.round(r.machineHours * 60),
    material_grams: Math.round(grams * 10) / 10,
    engine,
  };
}

/**
 * Engine B's pure re-run at another quantity, for the curve. `priceJob`
 * multiplies every per-job figure by `quantity`, so the only input that must
 * be rebuilt is the hardware, which the route pre-multiplied by the ORIGINAL
 * count (see `PriceForPrinterInput.accessories`). Null when the re-run could
 * not price — the curve leaves that point out.
 */
export function engineBUnitPriceAt(pricing: PricingInputs, qty: number): number | null {
  const original = Math.max(1, Math.floor(pricing.quantity ?? 1));
  const hardware = pricing.hardware ? { ...pricing.hardware, iqd: (pricing.hardware.iqd / original) * qty } : undefined;
  const r = priceJob({ ...pricing, quantity: qty, hardware });
  if (r.confidence === 'insufficient' || !(r.recommendedPriceIqd > 0)) return null;
  return r.recommendedPriceIqd / qty;
}
