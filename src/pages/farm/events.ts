/**
 * "While you were away" — buckets the unseen `farm_events` by kind. Pure, so
 * tests read it directly. The kinds are the engine's (print_done, print_failed,
 * printer_broken, job_ready, job_late, job_cancelled_by_customer,
 * offer_expired, maintenance_done, repair_done, level_up); anything else lands
 * in `other` and is still counted, never dropped.
 */
import type { FarmEvent } from '../../lib/farmApi';

export interface AwayGroups {
  /** Prints that finished well and jobs that became ready. */
  finished: number;
  /** Failed prints and machines that broke. */
  failed: number;
  /** Jobs that passed their deadline. */
  late: number;
  /** Jobs the customer cancelled and offers that expired. */
  cancelled: number;
  /** Maintenance and repairs that completed. */
  maintenance: number;
  levelUp: number;
  other: number;
  /** Sum of `payload.coins` / `payload.amount` across events; null when none carried one. */
  coins: number | null;
}

export function groupEvents(events: FarmEvent[]): AwayGroups {
  const g: AwayGroups = { finished: 0, failed: 0, late: 0, cancelled: 0, maintenance: 0, levelUp: 0, other: 0, coins: null };
  for (const e of events) {
    const k = (e.kind || '').toLowerCase();
    if (k === 'print_done' || k === 'job_ready' || k.includes('deliver') || k.includes('payout')) g.finished += 1;
    else if (k === 'print_failed' || k === 'printer_broken' || k.includes('fail') || k.includes('broke')) g.failed += 1;
    else if (k === 'job_late') g.late += 1;
    else if (k.includes('cancel') || k.includes('expire')) g.cancelled += 1;
    else if (k.includes('maint') || k.includes('repair')) g.maintenance += 1;
    else if (k === 'level_up') g.levelUp += 1;
    else g.other += 1;
    const p = e.payload;
    const amount = p && typeof p.coins === 'number' ? p.coins : p && typeof p.amount === 'number' ? p.amount : null;
    if (amount !== null) g.coins = (g.coins ?? 0) + amount;
  }
  return g;
}
