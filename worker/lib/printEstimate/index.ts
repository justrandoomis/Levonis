/**
 * THE ADAPTERS — each engine's result, folded into the one `Estimate` (E1).
 *
 * `fromEngineA` reads a `Quote` from worker/lib/printPricing.ts (the request
 * wizard's engine, whose `estimateFor` may also hand back a range across
 * materials); `fromEngineB` reads a `QuoteResult` from worker/lib/printQuote
 * (the calculator's engine). Both return the same shape, and neither copies a
 * cost line, a floor or a margin into it — the shape has nowhere to put one.
 *
 * NO QUANTITY CURVE (owner rule 2026-10-10, DECISIONS row 220). The
 * contract used to carry the per-piece price at 1, 2, 5 and 10 copies — pure
 * re-runs of the engine. Total(q) is linear in q, so two points gave the job's
 * fixed (setup) and per-copy cost split, and with the margin the costs
 * themselves; no screen ever drew it. The estimate is now the price of the job
 * the customer asked for and nothing else.
 */
import { PRINT_PRICING_VERSION, type Quote as EngineAQuote } from '../printPricing';
import { materialTotalGrams, type PrintAnalysis, type QuoteResult } from '../printQuote/model';
import {
  type Estimate,
  type EstimateConfidence,
  type EstimateExcludeKey,
  type EstimateReasonCode,
  ESTIMATE_REASON_CODES,
  unpricedEstimate,
} from './contract';
import { coversFrom, engineAAmounts, engineBAmounts, excludesFrom, factorsFrom } from './explain';

export * from './contract';

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
    material_id: materialId,
    process: opts.process,
    time_minutes: Math.round(r.machineHours * 60),
    material_grams: Math.round(grams * 10) / 10,
    engine,
  };
}
