/**
 * HOW AN ESTIMATE EXPLAINS ITSELF WITHOUT PUBLISHING A COST LINE (E2).
 *
 * The input is a list of (public key, dinars) pairs — each engine's lines
 * already folded onto the contract's vocabulary by the maps at the bottom.
 * The output is ordinal: `most` at ≥ 40 % of the priced cost, `some` at
 * ≥ 15 %, nothing below. The dinars never leave this function, and two
 * buckets of a rounded share cannot be subtracted back into a line.
 *
 * Pure throughout: no clock, no database, no settings. That is what lets
 * the adapters be unit-tested on a synthetic quote and lets a route re-run
 * an engine a few times for the quantity curve without a second read.
 */
import type { CostLine as EngineACostLine } from '../printPricing';
import type { CostComponent as EngineBComponent } from '../printQuote/model';
import {
  ESTIMATE_CURVE_QUANTITIES,
  ESTIMATE_EXCLUDE_KEYS,
  ESTIMATE_FACTOR_KEYS,
  FACTOR_MOST_SHARE,
  FACTOR_SOME_SHARE,
  type EstimateCoverKey,
  type EstimateCurvePoint,
  type EstimateExcludeKey,
  type EstimateFactor,
  type EstimateFactorKey,
} from './contract';

export interface KeyedAmount {
  key: EstimateFactorKey;
  iqd: number;
}

const FACTOR_ORDER = new Map<EstimateFactorKey, number>(ESTIMATE_FACTOR_KEYS.map((k, i) => [k, i]));
const EXCLUDE_ORDER = new Map<EstimateExcludeKey, number>(ESTIMATE_EXCLUDE_KEYS.map((k, i) => [k, i]));

/** Sums the amounts per key. Zero and negative amounts are dropped: a line
 *  that charged nothing is not in the price and must not be said to be. */
function totalsByKey(amounts: ReadonlyArray<KeyedAmount>): Map<EstimateFactorKey, number> {
  const totals = new Map<EstimateFactorKey, number>();
  for (const a of amounts) {
    if (!(a.iqd > 0) || !FACTOR_ORDER.has(a.key)) continue;
    totals.set(a.key, (totals.get(a.key) ?? 0) + a.iqd);
  }
  return totals;
}

/**
 * The ordinal factors, heaviest first; ties in canonical order so the same
 * price always explains itself in the same words.
 */
export function factorsFrom(amounts: ReadonlyArray<KeyedAmount>): EstimateFactor[] {
  const totals = totalsByKey(amounts);
  let sum = 0;
  for (const v of totals.values()) sum += v;
  if (!(sum > 0)) return [];
  return [...totals.entries()]
    .map(([key, iqd]) => ({ key, share: iqd / sum }))
    .filter((f) => f.share >= FACTOR_SOME_SHARE)
    .sort((a, b) => b.share - a.share || FACTOR_ORDER.get(a.key)! - FACTOR_ORDER.get(b.key)!)
    .map((f) => ({ key: f.key, weight: f.share >= FACTOR_MOST_SHARE ? 'most' : 'some' }));
}

/** Every key that charged anything, in canonical order. */
export function coversFrom(amounts: ReadonlyArray<KeyedAmount>): EstimateCoverKey[] {
  return [...totalsByKey(amounts).keys()].sort((a, b) => FACTOR_ORDER.get(a)! - FACTOR_ORDER.get(b)!);
}

/** De-duplicated, in canonical order, and never a key the contract lacks. */
export function excludesFrom(keys: ReadonlyArray<EstimateExcludeKey>): EstimateExcludeKey[] {
  return [...new Set(keys.filter((k) => EXCLUDE_ORDER.has(k)))].sort(
    (a, b) => EXCLUDE_ORDER.get(a)! - EXCLUDE_ORDER.get(b)!
  );
}

/**
 * The quantity curve (E4): 1, 2, 5, 10 and the requested count, each priced
 * by a PURE RE-RUN the caller supplies. `unitFor` returns the per-piece price
 * at that quantity, or null when the engine could not price it — an unpriced
 * point is left out rather than drawn at zero. Ascending by quantity, one
 * point per quantity.
 *
 * Not smoothed. The engine's own arithmetic decides the shape: setup shared
 * across copies pulls the unit price down, a failure provision that grows
 * with a long run pushes it up, and the curve shows whichever wins, because
 * it is the same number the wizard would quote at that quantity.
 */
export function quantityCurve(
  requested: number,
  unitFor: (qty: number) => number | null | undefined
): EstimateCurvePoint[] {
  const asked = Math.max(1, Math.floor(requested || 1));
  const quantities = [...new Set<number>([...ESTIMATE_CURVE_QUANTITIES, asked])].sort((a, b) => a - b);
  const points: EstimateCurvePoint[] = [];
  for (const qty of quantities) {
    const unit = unitFor(qty);
    if (typeof unit === 'number' && Number.isFinite(unit) && unit > 0) {
      points.push({ qty, unit_iqd: Math.round(unit) });
    }
  }
  return points;
}

// ------------------------------------------------ each engine's lines, folded

/** Engine A (`printPricing.ts`) cost-line keys onto the public vocabulary. */
export const ENGINE_A_KEY: Record<EngineACostLine['key'], EstimateFactorKey> = {
  material: 'material',
  waste: 'material',
  purge: 'material',
  support_material: 'support',
  support_removal: 'support',
  machine: 'machine',
  energy: 'machine',
  setup: 'labor',
  labor: 'labor',
  post_processing: 'finishing',
  failure_risk: 'failure_risk',
  complexity: 'complexity',
  accessories: 'accessories',
};

/**
 * Engine B (`printQuote/model.ts`) components onto the same words. `null`
 * means the component is folded into the price but not NAMED to the customer:
 * a shop's overhead and the platform's fee are the margin structure §22 keeps
 * private, and both are 0 on every public path today.
 */
export const ENGINE_B_KEY: Record<EngineBComponent, EstimateFactorKey | null> = {
  MODEL_MATERIAL: 'material',
  SUPPORT_MATERIAL: 'support',
  SUPPORT_INTERFACE: 'support',
  PURGE: 'material',
  PRIME_TOWER: 'material',
  BRIM_RAFT: 'material',
  OTHER_WASTE: 'material',
  ELECTRICITY: 'machine',
  DEPRECIATION: 'machine',
  MAINTENANCE: 'machine',
  LABOR: 'labor',
  POST_PROCESSING: 'finishing',
  PACKAGING: 'packaging',
  OVERHEAD: null,
  PLATFORM_FEES: null,
  HARDWARE: 'accessories',
  FAILURE_RESERVE: 'failure_risk',
};

export function engineAAmounts(lines: ReadonlyArray<EngineACostLine>): KeyedAmount[] {
  return lines.map((l) => ({ key: ENGINE_A_KEY[l.key], iqd: l.iqd })).filter((a) => a.key !== undefined);
}

export function engineBAmounts(lines: ReadonlyArray<{ component: EngineBComponent; iqd: number }>): KeyedAmount[] {
  const out: KeyedAmount[] = [];
  for (const l of lines) {
    const key = ENGINE_B_KEY[l.component];
    if (key) out.push({ key, iqd: l.iqd });
  }
  return out;
}
