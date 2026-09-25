/**
 * RANKING — of the workshops that CAN make a job, who should hear first.
 *
 * Eligibility (worker/lib/eligibility.ts) decides WHETHER; this decides the
 * ORDER among the eligible, which caps who is notified. It never runs for an
 * ineligible workshop, so nothing here — the PRO bonus included — can reach
 * one: a subscription does not make a printer bigger.
 *
 * Moved out of printMatching.ts's `decide()` unchanged in its arithmetic
 * (W5-B), so the ranking of a request did not move when the eligibility rules
 * behind it did.
 */
import { QUALITY_RANK, jobCapabilities, type Capability, type CapabilityPrinter, type CatalogueMaterial, type EligibilityRequest, type MerchantPrefs } from './eligibility';

/** How much each ranking signal is worth. Admin-tunable (`printMatchWeights`). */
export interface MatchWeights {
  capability_fit: number;
  location: number;
  availability: number;
  rating: number;
  completed_jobs: number;
  response_time: number;
  reliability: number;
  price_suitability: number;
  preference_match: number;
  pro_bonus: number;
}

export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  capability_fit: 25,
  location: 18,
  availability: 14,
  rating: 12,
  completed_jobs: 8,
  response_time: 8,
  reliability: 8,
  price_suitability: 4,
  preference_match: 3,
  // Deliberately no larger than the smallest signal in the table, and a few
  // percent of the total. It reorders shops that ALL ALREADY QUALIFY; it can
  // never reach an ineligible one, because eligibility is decided before any
  // score is computed.
  pro_bonus: 3,
};

/** The ranking signals of one workshop. */
export interface RankSignals {
  governorate: string;
  prefs: MerchantPrefs;
  rating_avg_x100: number;
  rating_count: number;
  completed_orders: number;
  /** Median minutes to a first offer. null = no history. */
  response_minutes: number | null;
  /** Cancelled or disputed as a share of finished orders, 0..1. */
  trouble_rate: number;
  pro: boolean;
}

export const clamp01 = (v: number) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

/** How comfortably the job sits on this machine, 0..1. */
function capabilityFit(req: EligibilityRequest, printer: CapabilityPrinter, needed: Capability[], prefs: MerchantPrefs): number {
  let fit = 0.5;
  if (printer.build_x_mm > 0) {
    const d = req.dims_mm ?? { x: 0, y: 0, z: 0 };
    const longest = Math.max(d.x, d.y, d.z);
    const bed = Math.max(printer.build_x_mm, printer.build_y_mm, printer.build_z_mm);
    // Best around half the bed: plenty of room, without wasting a large machine
    // on a job any small one could take.
    const use = bed > 0 ? longest / bed : 1;
    fit += 0.3 * (1 - Math.abs(use - 0.5) * 2);
  }
  const have = new Set<Capability>();
  if (printer.max_colors > 1) have.add('multicolor');
  if (printer.enclosed) have.add('functional');
  if (printer.hardened_nozzle) have.add('cf');
  if (QUALITY_RANK[printer.quality_max] >= QUALITY_RANK.fine) have.add('high_detail');
  if (Math.max(printer.build_x_mm, printer.build_y_mm, printer.build_z_mm) >= 300) have.add('large_format');
  if (prefs.capabilities.includes('flexible')) have.add('flexible');
  if (needed.length) fit += 0.2 * (needed.filter((cap) => have.has(cap)).length / needed.length);
  else fit += 0.2;
  return clamp01(fit);
}

/** The score of an ELIGIBLE workshop on the printer the job would run on, explained line by line. */
export function rankScore(
  req: EligibilityRequest,
  printer: CapabilityPrinter,
  m: RankSignals,
  material: CatalogueMaterial | null,
  weights: MatchWeights
): { score: number; detail: Record<string, number> } {
  const detail: Record<string, number> = {};
  const add = (key: keyof MatchWeights, fraction: number) => {
    const v = Math.round((weights[key] ?? 0) * clamp01(fraction));
    detail[key] = v;
    return v;
  };
  const p = m.prefs;
  const needed = jobCapabilities(req, material);
  let score = 0;
  score += add('capability_fit', capabilityFit(req, printer, needed, p));
  score += add('location', req.governorate && m.governorate === req.governorate ? 1 : 0.35);
  score += add(
    'availability',
    printer.availability === 'available' ? { light: 1, normal: 0.85, busy: 0.5, full: 0.15 }[p.workload] : 0.25
  );
  // An unrated shop sits at the middle, not at the bottom.
  score += add('rating', m.rating_count > 0 ? m.rating_avg_x100 / 500 : 0.6);
  score += add('completed_jobs', Math.log10(1 + m.completed_orders) / 2);
  score += add('response_time', m.response_minutes === null ? 0.6 : clamp01(1 - m.response_minutes / 1440));
  score += add('reliability', 1 - clamp01(m.trouble_rate * 3));
  score += add(
    'price_suitability',
    req.estimate_iqd === null || p.min_job_iqd <= 0 ? 0.6 : clamp01(req.estimate_iqd / (p.min_job_iqd * 4))
  );
  // Having explicitly asked for this kind of work beats merely tolerating it.
  score += add('preference_match', p.capabilities.length && needed.every((cap) => p.capabilities.includes(cap)) ? 1 : 0.5);
  score += add('pro_bonus', m.pro ? 1 : 0);
  return { score, detail };
}
