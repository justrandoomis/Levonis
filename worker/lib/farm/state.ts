/**
 * The shapes a player receives (docs/PRINTER_FARM.md §4 GET /state), built
 * from rows + config. Names come from the config so the admin's edits show;
 * every number is a server field — the client renders, it never derives.
 */

import type { FarmConfig, LocalizedName } from './config';
import { locationSpec, printerModel, productSpec, resaleValue } from './catalog';
import { starsFrom, unlocks, xpForNextLevel } from './progression';
import { parseColors } from './sim';
import { progressOf, realMinutesToMs, msOf } from './time';
import {
  parseStats, type FarmAssignmentRow, type FarmEventRow, type FarmJobRow, type FarmPrinterRow, type FarmProfileRow,
  type FarmSpoolRow,
} from './types';

function parseName(json: string): LocalizedName {
  try {
    const v = JSON.parse(json) as Partial<LocalizedName>;
    return { ar: String(v.ar ?? ''), en: String(v.en ?? ''), ckb: String(v.ckb ?? '') };
  } catch {
    return { ar: '', en: '', ckb: '' };
  }
}

function productTitle(cfg: FarmConfig, key: string): LocalizedName {
  const p = productSpec(cfg, key);
  return p ? p.name : { ar: key, en: key, ckb: key };
}

export interface AssignmentsSummary {
  assigned: number;
  queued: number;
  printing: number;
  done: number;
  collected: number;
  failed: number;
  remaining: number;
}

export function assignmentsSummary(job: FarmJobRow, assignments: FarmAssignmentRow[]): AssignmentsSummary {
  const s: AssignmentsSummary = { assigned: 0, queued: 0, printing: 0, done: 0, collected: 0, failed: 0, remaining: job.qty };
  for (const a of assignments) {
    if (a.job_id !== job.id) continue;
    if (a.state === 'queued') { s.queued += a.qty; s.assigned += a.qty; }
    else if (a.state === 'printing') { s.printing += a.qty; s.assigned += a.qty; }
    else if (a.state === 'done') { s.done += a.qty; s.assigned += a.qty; }
    else if (a.state === 'collected') { s.collected += a.qty; s.assigned += a.qty; }
    else if (a.state === 'failed') s.failed += a.qty;
  }
  s.remaining = Math.max(0, job.qty - s.assigned);
  return s;
}

export function jobPublic(job: FarmJobRow, assignments: FarmAssignmentRow[], cfg: FarmConfig) {
  return {
    id: job.id,
    state: job.state,
    customer_tier: job.customer_tier,
    customer_name: parseName(job.customer_name),
    title: productTitle(cfg, job.product_key),
    product_key: job.product_key,
    qty: job.qty,
    material: job.material,
    colors: parseColors(job.colors_json),
    grams: job.grams,
    print_seconds: job.print_seconds,
    quality: job.quality,
    reward_coins: job.reward_coins,
    reputation_gain_bp: job.reputation_gain_bp,
    late_penalty_bp: job.late_penalty_bp,
    cancel_penalty_coins: job.cancel_penalty_coins,
    cancel_penalty_bp: job.cancel_penalty_bp,
    offer_expires_at: job.offer_expires_at,
    deadline_at: job.deadline_at,
    accepted_at: job.accepted_at,
    delivered_at: job.delivered_at,
    /** Set when every part was handed over but the day's cap held the payout; paid on a later day. */
    payout_deferred_day: job.payout_deferred_day ?? null,
    assignments_summary: assignmentsSummary(job, assignments),
  };
}
export type JobPublic = ReturnType<typeof jobPublic>;

/** The batch sitting on a printer: printing, finished, or failed and not yet cleared. */
export function currentAssignmentOf(printer: FarmPrinterRow, assignments: FarmAssignmentRow[]): FarmAssignmentRow | null {
  return (
    assignments.find(
      (a) => a.printer_id === printer.id &&
        (a.state === 'printing' || a.state === 'done' || (a.state === 'failed' && !a.collected_at))
    ) ?? null
  );
}

export function queueOf(printer: FarmPrinterRow, assignments: FarmAssignmentRow[]): FarmAssignmentRow[] {
  return assignments.filter((a) => a.printer_id === printer.id && a.state === 'queued').sort((a, b) => a.position - b.position);
}

/** What a machine is called when the player never named it: the model's name and its room position. */
export function defaultNickname(cfg: FarmConfig, modelKey: string, slot: number): string {
  const model = printerModel(cfg, modelKey);
  return `${model?.name.en || modelKey} ${slot + 1}`.slice(0, 40);
}

export function printerPublic(
  printer: FarmPrinterRow, assignments: FarmAssignmentRow[], jobs: Map<string, FarmJobRow>, cfg: FarmConfig, now: string
) {
  const cur = currentAssignmentOf(printer, assignments);
  const curJob = cur ? jobs.get(cur.job_id) : undefined;
  return {
    id: printer.id,
    model_key: printer.model_key,
    nickname: printer.nickname || defaultNickname(cfg, printer.model_key, printer.slot),
    slot: printer.slot,
    /** What the store pays for this machine right now — the exact credit `sell` would write. */
    resale_coins: resaleValue(cfg, printer.model_key),
    health: printer.health,
    state: printer.state,
    state_until: printer.state_until,
    hours: printer.hours / 100,
    prints: printer.prints,
    failures: printer.failures,
    current: cur
      ? {
          assignment_id: cur.id,
          job_id: cur.job_id,
          title: curJob ? productTitle(cfg, curJob.product_key) : productTitle(cfg, ''),
          qty: cur.qty,
          state: cur.state,
          quality: cur.quality,
          started_at: cur.started_at,
          ends_at: cur.ends_at,
          progress: progressOf(cur.started_at, cur.ends_at, now),
          failure_kind: cur.failure_kind,
          failure_p: cur.failure_p,
        }
      : null,
    queue: queueOf(printer, assignments).map((a) => {
      const j = jobs.get(a.job_id);
      return { assignment_id: a.id, job_id: a.job_id, title: j ? productTitle(cfg, j.product_key) : productTitle(cfg, ''), qty: a.qty, seconds: a.seconds };
    }),
  };
}

export function spoolPublic(s: FarmSpoolRow) {
  return { id: s.id, material: s.material, color: s.color, grams_left: s.grams_left, grams_total: s.grams_total, quality: s.quality };
}

export function eventPublic(e: FarmEventRow) {
  let payload: Record<string, unknown> = {};
  try {
    const v = JSON.parse(e.payload_json);
    if (v && typeof v === 'object') payload = v as Record<string, unknown>;
  } catch {
    /* empty payload */
  }
  return { id: e.id, kind: e.kind, payload, created_at: e.created_at, seen_at: e.seen_at };
}

export function profilePublic(profile: FarmProfileRow, balance: number, cfg: FarmConfig) {
  const loc = locationSpec(cfg, profile.location_key);
  let tutorial: Record<string, unknown> = {};
  try {
    const v = JSON.parse(profile.tutorial_json);
    if (v && typeof v === 'object') tutorial = v as Record<string, unknown>;
  } catch {
    /* {} */
  }
  return {
    farm_name: profile.farm_name,
    level: profile.level,
    xp: profile.xp,
    xp_next: xpForNextLevel(profile.level, cfg),
    reputation_bp: profile.reputation_bp,
    stars: starsFrom(profile.reputation_bp),
    location: { key: profile.location_key, name: loc.name, max_printers: loc.max_printers, storage_grams: loc.storage_grams },
    state: profile.state,
    coins: balance,
    stats: parseStats(profile.stats_json),
    tutorial,
    last_seen_at: profile.last_seen_at,
    created_at: profile.created_at,
  };
}

/** The "While you were away" header, or null when the absence was short. */
export function awaySummary(profile: FarmProfileRow, unseen: FarmEventRow[], now: string, cfg: FarmConfig) {
  const awayMs = msOf(now) - msOf(profile.last_seen_at);
  if (awayMs < realMinutesToMs(cfg.time.away_summary_after_minutes)) return null;
  const counts: Record<string, number> = {};
  for (const e of unseen) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return { since: profile.last_seen_at, minutes: Math.floor(awayMs / 60_000), counts };
}

export function stateUnlocks(profile: FarmProfileRow, cfg: FarmConfig) {
  return unlocks(profile, cfg);
}
