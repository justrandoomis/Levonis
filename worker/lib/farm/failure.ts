/**
 * Why prints fail, how often, and what a failure costs.
 *
 * The probability is computed when a batch STARTS and stored on the
 * assignment, so a config change cannot alter an in-flight print. It is
 * monotonic in every input: lower health, a less reliable model, a harder
 * material, a worse spool, a more complex part and a finer quality all raise
 * it; nothing lowers it below the base.
 */

import { FAILURE_KINDS, type FailureKind, type FarmConfig, type Quality } from './config';
import { weightedIndex } from './rng';

export interface FailureInputs {
  /** 0..100 */
  health: number;
  /** 0..1 */
  reliability: number;
  /** 0..1 */
  materialDifficulty: number;
  /** 0..1 */
  spoolQuality: number;
  /** 0..1 */
  complexity: number;
  quality: Quality;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function failureProbability(inp: FailureInputs, cfg: FarmConfig): number {
  const w = cfg.failure.weights;
  const healthLoss = 1 - clamp01(inp.health / 100);
  const p =
    cfg.failure.base +
    w.health * healthLoss * healthLoss +
    w.reliability * (1 - clamp01(inp.reliability)) +
    w.material * clamp01(inp.materialDifficulty) +
    w.spool * (1 - clamp01(inp.spoolQuality)) +
    w.complexity * clamp01(inp.complexity);
  const q = cfg.quality[inp.quality] ?? cfg.quality.standard;
  return Math.min(cfg.failure.max, Math.max(0, p * q.failure_factor));
}

/** Which kind of failure happened, by configured weight, from one roll r in [0, 1). */
export function pickFailureKind(cfg: FarmConfig, r: number, multiColor: boolean): FailureKind {
  const kinds = FAILURE_KINDS.filter((k) => multiColor || !cfg.failure.kinds[k].ams_only);
  const weights = kinds.map((k) => cfg.failure.kinds[k].weight);
  if (weights.every((w) => w <= 0)) return 'spaghetti';
  return kinds[weightedIndex(weights, r)] ?? 'spaghetti';
}

/** The probability for a batch about to START on this printer, from the rows involved. */
export function failureProbabilityFor(
  cfg: FarmConfig,
  printer: { health: number; model_key: string },
  product: { complexity: number } | null,
  material: { difficulty: number } | null,
  spool: { quality: number } | null,
  quality: Quality
): number {
  const model = cfg.printers[printer.model_key];
  return failureProbability(
    {
      health: printer.health,
      reliability: model?.reliability ?? 0.5,
      materialDifficulty: material?.difficulty ?? 0.5,
      spoolQuality: spool?.quality ?? 0.5,
      complexity: product?.complexity ?? 0.5,
      quality,
    },
    cfg
  );
}

export interface FailureCosts {
  /** Grams gone for good. */
  gramsLost: number;
  /** Grams that go back on the spool. */
  gramsReturned: number;
  /** Game seconds the printer actually ran (wear and electricity accrue on these). */
  secondsElapsed: number;
  healthHit: number;
  breaks: boolean;
}

export function failureCosts(kind: FailureKind, cfg: FarmConfig, grams: number, seconds: number): FailureCosts {
  const k = cfg.failure.kinds[kind] ?? cfg.failure.kinds.spaghetti;
  const gramsLost = Math.min(grams, Math.max(0, Math.ceil(grams * k.grams_loss_factor)));
  return {
    gramsLost,
    gramsReturned: Math.max(0, grams - gramsLost),
    secondsElapsed: Math.max(1, Math.round(seconds * k.time_loss_factor)),
    healthHit: k.health_hit,
    breaks: k.breaks,
  };
}
