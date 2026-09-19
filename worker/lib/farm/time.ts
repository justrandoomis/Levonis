/**
 * Time in the farm: durations are GAME seconds; the clock is the server's.
 *
 * `time.time_scale` game-seconds pass per real second (20 by default: one game
 * hour is three real minutes). Product times are quoted on the reference
 * machine at standard quality; a printer's speed and the chosen quality scale
 * them. Everything real is an ISO string + milliseconds — never a client value.
 */

import type { FarmConfig, PrinterModelSpec, ProductSpec, Quality } from './config';

export const GAME_SECONDS_PER_HOUR = 3600;

/**
 * Iraq is UTC+3 year-round (no DST since 2007) — the platform's day boundary.
 *
 * RE-EXPORTED, NOT REIMPLEMENTED. The same three-hour offset was written here
 * and in `pointsTasks.ts`, and the delivery board needed it a third time;
 * `worker/lib/baghdadTime.ts` is now the one copy. The signature is
 * unchanged, so every caller of `baghdadDayOf` reads exactly as before — the
 * only difference is that an unparseable instant now yields '' instead of
 * throwing a RangeError out of `toISOString`.
 */
export { baghdadDayOf } from '../baghdadTime';

export function msOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function addMs(iso: string, ms: number): string {
  return new Date(msOf(iso) + Math.round(ms)).toISOString();
}

/** How much slower/faster than the reference machine this model prints. */
export function speedFactor(model: PrinterModelSpec, cfg: FarmConfig): number {
  const f = cfg.time.reference_speed_mms / Math.max(1, model.speed);
  return Math.min(20, Math.max(0.05, f));
}

/** Reference-machine, standard-quality GAME seconds for a batch (what a job quotes). */
export function referenceSeconds(product: ProductSpec, qty: number): number {
  return Math.max(1, Math.round(product.seconds_per_part * qty));
}

/** GAME seconds this batch takes on THIS printer at the chosen quality. */
export function printSeconds(product: ProductSpec, qty: number, model: PrinterModelSpec, quality: Quality, cfg: FarmConfig): number {
  const q = cfg.quality[quality] ?? cfg.quality.standard;
  return Math.max(1, Math.round(product.seconds_per_part * qty * speedFactor(model, cfg) * q.time_factor));
}

export function gameSecondsToRealMs(seconds: number, cfg: FarmConfig): number {
  return (seconds / Math.max(1e-9, cfg.time.time_scale)) * 1000;
}

export function gameMinutesToRealMs(minutes: number, cfg: FarmConfig): number {
  return gameSecondsToRealMs(minutes * 60, cfg);
}

export function realMinutesToMs(minutes: number): number {
  return minutes * 60_000;
}

/** When a batch started at `startedIso` finishes on the server clock. */
export function endsAtFor(startedIso: string, seconds: number, cfg: FarmConfig): string {
  return addMs(startedIso, gameSecondsToRealMs(seconds, cfg));
}

/** Maintenance / repair completion time. */
export function serviceUntil(nowIso: string, gameMinutes: number, cfg: FarmConfig): string {
  return addMs(nowIso, gameMinutesToRealMs(gameMinutes, cfg));
}

/** 0..1 progress of a batch at `nowIso`; 1 once ends_at has passed. */
export function progressOf(startedIso: string | null, endsIso: string | null, nowIso: string): number {
  if (!startedIso || !endsIso) return 0;
  const a = msOf(startedIso);
  const b = msOf(endsIso);
  if (b <= a) return 1;
  return Math.min(1, Math.max(0, (msOf(nowIso) - a) / (b - a)));
}

/** GAME hours of a batch, for wear and electricity. */
export function gameHours(seconds: number): number {
  return seconds / GAME_SECONDS_PER_HOUR;
}
