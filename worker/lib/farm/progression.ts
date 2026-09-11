/**
 * XP, levels, reputation and progressive disclosure.
 *
 * Reputation is integer basis points 0..cap (5000 = 5.00 ★). Every delta is
 * clamped. `unlocks` tells the client what to show; a feature is unlocked only
 * when the player's level reaches the configured threshold AND the feature
 * exists in this phase — a flag that says "open" for an empty room is a lie.
 */

import type { FarmConfig } from './config';
import type { FarmProfileRow } from './types';

/** Features Phase 1 actually ships. Later phases flip entries to true. */
export const PHASE_FEATURES: Record<string, boolean> = {
  market: true,
  inventory: true,
  maintenance: true,
  leaderboard: true,
  store: false,
  upgrades: false,
  locations: false,
  employees: false,
  contracts: false,
  loans: false,
};

export function levelForXp(xp: number, cfg: FarmConfig): number {
  const th = cfg.progression.level_thresholds;
  let level = 1;
  for (let i = 0; i < th.length; i++) if (xp >= th[i]) level = i + 1;
  return Math.max(1, level);
}

/** XP at which the next level starts, or null at the top. */
export function xpForNextLevel(level: number, cfg: FarmConfig): number | null {
  const th = cfg.progression.level_thresholds;
  return level < th.length ? th[level] : null;
}

export function xpForJob(qty: number, cfg: FarmConfig): number {
  return Math.max(0, Math.round(cfg.progression.xp_per_job + cfg.progression.xp_per_part * qty));
}

export function clampReputation(bp: number, cfg: FarmConfig): number {
  return Math.min(cfg.progression.reputation_cap_bp, Math.max(0, Math.round(bp)));
}

/** ★ 0.00–5.00 from basis points. */
export function starsFrom(bp: number): number {
  return Math.round(bp / 10) / 100;
}

/** Reputation after a delivery: +gain (scaled by quality) on time, −late penalty after the deadline. */
export function reputationAfterDelivery(
  bp: number,
  job: { reputation_gain_bp: number; late_penalty_bp: number },
  late: boolean,
  qualityFactor: number,
  cfg: FarmConfig
): number {
  const delta = late ? -job.late_penalty_bp : Math.round(job.reputation_gain_bp * qualityFactor);
  return clampReputation(bp + delta, cfg);
}

export function maxActiveJobs(level: number, cfg: FarmConfig): number {
  const arr = cfg.jobs.max_active_jobs;
  if (arr.length === 0) return 1;
  return arr[Math.min(arr.length, Math.max(1, level)) - 1];
}

export function unlockLevels(cfg: FarmConfig): Record<string, number> {
  return { ...cfg.progression.unlocks };
}

/**
 * The level a feature needs when this player may NOT use it yet, else null.
 * The route turns a non-null answer into 409 FEATURE_LOCKED — progressive
 * disclosure is a server rule, not a client courtesy.
 */
export function featureLockLevel(profile: Pick<FarmProfileRow, 'level'>, cfg: FarmConfig, feature: string): number | null {
  const need = cfg.progression.unlocks[feature] ?? 1;
  if ((PHASE_FEATURES[feature] ?? false) && profile.level >= need) return null;
  return need;
}

/** Feature → whether this player may use it now. */
export function unlocks(profile: Pick<FarmProfileRow, 'level'>, cfg: FarmConfig): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const keys = new Set([...Object.keys(PHASE_FEATURES), ...Object.keys(cfg.progression.unlocks)]);
  for (const k of keys) {
    const need = cfg.progression.unlocks[k] ?? 1;
    out[k] = (PHASE_FEATURES[k] ?? false) && profile.level >= need;
  }
  return out;
}

export interface StarterKit {
  coins: number;
  printer: { model_key: string; slot: number };
  spool: { material: string; color: string; grams: number; quality: number };
  firstJob: { product: string; qty: number; customer_tier: string; quality: 'draft' | 'standard' | 'fine' | 'ultra'; colors: string[] };
  location_key: string;
  reputation_bp: number;
}

export function starterKit(cfg: FarmConfig): StarterKit {
  return {
    coins: cfg.economy.starter_coins,
    printer: { model_key: cfg.starter.printer_model, slot: 0 },
    spool: { ...cfg.starter.spool },
    firstJob: { ...cfg.starter.first_job, colors: [...cfg.starter.first_job.colors] },
    location_key: cfg.locations.tiny_room ? 'tiny_room' : (Object.keys(cfg.locations)[0] ?? 'tiny_room'),
    reputation_bp: clampReputation(cfg.progression.reputation_start_bp, cfg),
  };
}
