/**
 * What the player is told after a Collect — read off the server's collect
 * answer (§4 `collect`, §9a deferred payout), never computed here. Pure, so
 * tests call it directly:
 *
 *   replayed        → "already collected, nothing extra paid" (quiet);
 *   a failed batch  → what failed and that the parts are free to re-assign;
 *   delivered       → the coins the server added and the reputation it moved,
 *                     late or on time, and a level reached;
 *   payout_deferred → handed over, N coins arrive tomorrow because today's
 *                     jobs or coins cap is reached (the server names which);
 *   otherwise       → parts collected, the job is paid when every part is in.
 *
 * Coins and stars are formatted with Latin digits (format.ts) and wrapped in
 * FIRST-STRONG isolates so a "+1,200" beside an Arabic word keeps its sign
 * and its digits together.
 */
import type { CollectResult } from '../../lib/farmApi';
import { formatCoins, FSI, PDI, starsDelta } from './format';
import type { FarmStrings } from './strings';

export type CollectNoticeKind = 'replayed' | 'failed' | 'paid' | 'deferred' | 'parts';

export interface CollectNotice {
  kind: CollectNoticeKind;
  /** Note tone: gold for money that arrived, amber for something to weigh, zinc for a quiet aside. */
  tone: 'gold' | 'amber' | 'zinc';
  text: string;
  /** A second line (a level reached), or null. */
  detail: string | null;
  printer_id: string;
  job_id: string;
}

const isolate = (token: string) => `${FSI}${token}${PDI}`;

/** "+0.15" / "−0.10" from a signed basis-point delta. */
export function signedStars(deltaBp: number): string {
  const abs = starsDelta(deltaBp);
  return deltaBp < 0 ? `−${abs}` : `+${abs}`;
}

/** The cap the server named, in the UI language; an unknown reason falls back to the jobs cap wording only when it says so, else the coins cap. */
export function capLabel(reason: string, s: FarmStrings): string {
  return reason === 'daily_jobs_cap' ? s.capJobs : s.capCoins;
}

export function collectNotice(r: CollectResult & { replayed: boolean }, s: FarmStrings, lang: string): CollectNotice {
  const base = { printer_id: r.printer_id, job_id: r.collected.job_id, detail: null as string | null };
  if (r.replayed) return { ...base, kind: 'replayed', tone: 'zinc', text: s.collectReplayed };
  if (r.collected.outcome === 'failed') {
    const kind = r.collected.failure_kind ? s.failureKinds[r.collected.failure_kind] ?? r.collected.failure_kind : s.failures;
    return { ...base, kind: 'failed', tone: 'amber', text: s.collectFailed(r.collected.qty, kind) };
  }
  if (r.delivered) {
    const d = r.delivered;
    const coins = isolate(formatCoins(d.reward_coins, lang));
    const stars = isolate(signedStars(d.reputation_delta_bp));
    return {
      ...base,
      kind: 'paid',
      tone: 'gold',
      text: d.late ? s.collectPaidLate(coins, stars) : s.collectPaid(coins, stars),
      detail: d.level_up ? s.collectLevelUp(d.level) : null,
    };
  }
  if (r.payout_deferred) {
    const p = r.payout_deferred;
    return {
      ...base,
      kind: 'deferred',
      tone: 'amber',
      text: s.collectDeferred(isolate(formatCoins(p.reward_coins, lang)), capLabel(p.reason, s)),
    };
  }
  return { ...base, kind: 'parts', tone: 'zinc', text: s.collectPartsOnly(r.collected.qty) };
}
