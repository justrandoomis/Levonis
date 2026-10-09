/**
 * WHEN A PAIR IS CHECKED, AND WHAT IT MAY SPEND (FX programme plan §5.1, §6).
 * Pure; shared by the scheduler and the owner's answers.
 *
 * DUE (§5.1, critique L1): AUTO, and at least the pair's interval (USD/IQD 6
 * or 12 hours, the ECB pairs 24) less 30 minutes since the last CRON success,
 * measured on the cron's SCHEDULED time — a run executed 35 minutes late is
 * stamped with its scheduled 06:00, so the 12-hour cycle never slips, and a
 * refresh or a return to automatic never shifts the phase.
 *
 * THE PROVIDER BUDGET (§6, critique F4): counted per UTC day when the lease is
 * claimed, BEFORE any request: two calls per claim (the attempt and its one
 * retry). IQWealth's free plan allows 500 a day: the cap is 150, of which a
 * refresh or a return to automatic may use 140, so the cron's four ticks (at
 * most 8 calls) are always left. The ECB states no quota: 50, 42.
 */
import { HOUR_MS, iso, type FxPairRow } from './pairs';

export const FX_DUE_TOLERANCE_MS = 30 * 60_000;
export const CALLS_PER_CLAIM = 2;
export const PROVIDER_DAY_CAP: Readonly<Record<'iqwealth' | 'ecb', { total: number; nonCron: number }>> = {
  iqwealth: { total: 150, nonCron: 140 },
  ecb: { total: 50, nonCron: 42 },
};

export function isDue(row: Pick<FxPairRow, 'pair' | 'mode' | 'interval_hours' | 'last_cron_success_at'>, scheduledTime: Date): boolean {
  if (row.mode !== 'AUTO') return false;
  const hours = row.pair === 'USD_IQD' ? row.interval_hours : 24;
  if (!row.last_cron_success_at) return true;
  const last = Date.parse(row.last_cron_success_at);
  if (!Number.isFinite(last)) return true;
  return scheduledTime.getTime() - last >= hours * HOUR_MS - FX_DUE_TOLERANCE_MS;
}

/** The next cron tick (00/06/12/18 UTC) at which the pair will be due; null while MANUAL. */
export function nextCheckAt(row: Pick<FxPairRow, 'pair' | 'mode' | 'interval_hours' | 'last_cron_success_at'>, now: Date): string | null {
  if (row.mode !== 'AUTO') return null;
  const six = 6 * HOUR_MS;
  let tick = Math.ceil(now.getTime() / six) * six;
  for (let i = 0; i < 8; i++, tick += six) if (isDue(row, new Date(tick))) return iso(tick);
  return iso(tick);
}
