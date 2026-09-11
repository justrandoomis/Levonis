/**
 * Client-side READ-ONLY rules for the job sheet: which printers can take a
 * job, how many grams a batch needs, and an estimate of how long it takes.
 *
 * These exist so a player is told WHY a printer is disabled before tapping
 * Start, not after. They mirror the server's checks (docs/PRINTER_FARM.md §4,
 * `POST /jobs/:id/assign`) but decide nothing: the server re-validates every
 * allocation and its answer is the only one that counts. Every number here is
 * derived from server fields (the job row and the public config) by the
 * formula the contract states, and the sheet labels it an estimate.
 */
import {
  productByKey,
  printerModel,
  type FarmJob,
  type FarmPrinter,
  type FarmSpool,
  type PrintQuality,
  type PublicFarmConfig,
} from '../../lib/farmApi';

export type IncompatibilityReason =
  | 'unknown_model'
  | 'broken'
  | 'maintenance'
  | 'material'
  | 'multicolor'
  | 'too_large';

export interface PrinterFit {
  ok: boolean;
  reason: IncompatibilityReason | null;
}

/** Why a printer cannot take this job, or ok. Order matters: the first failing rule is the reason shown. */
export function printerFit(printer: FarmPrinter, job: FarmJob, config: PublicFarmConfig | null | undefined): PrinterFit {
  const model = printerModel(config, printer.model_key);
  if (!model) return { ok: false, reason: 'unknown_model' };
  if (printer.state === 'broken') return { ok: false, reason: 'broken' };
  if (printer.state === 'maintenance') return { ok: false, reason: 'maintenance' };
  if (!model.materials.includes(job.material)) return { ok: false, reason: 'material' };
  if ((job.colors?.length ?? 0) > 1 && !model.ams) return { ok: false, reason: 'multicolor' };
  const product = productByKey(config, job.product_key);
  if (product?.size_mm && model.volume_mm && !fits(product.size_mm, model.volume_mm)) {
    return { ok: false, reason: 'too_large' };
  }
  return { ok: true, reason: null };
}

/** A part fits when each of its sorted dimensions fits the sorted volume — orientation is free. */
export function fits(size: [number, number, number], volume: [number, number, number]): boolean {
  const a = [...size].sort((x, y) => x - y);
  const b = [...volume].sort((x, y) => x - y);
  return a.every((d, i) => d <= b[i]);
}

/** Spools that can feed this job: same material, a colour the job asks for, grams left. */
export function compatibleSpools(spools: FarmSpool[], job: FarmJob): FarmSpool[] {
  const colors = job.colors ?? [];
  return spools.filter(
    (sp) => sp.material === job.material && sp.grams_left > 0 && (colors.length === 0 || colors.includes(sp.color))
  );
}

/** Grams a batch of `qty` parts needs, from the job's whole-job grams. */
export function gramsForQty(job: FarmJob, qty: number): number {
  if (job.qty <= 0 || qty <= 0) return 0;
  return Math.ceil((job.grams / job.qty) * qty);
}

/**
 * Estimated GAME seconds for `qty` parts on this model at this quality. The
 * job's `print_seconds` are for the reference machine (the starter model) at
 * standard quality; a faster model divides, a slower one multiplies, and the
 * quality's time factor scales the result.
 */
export function estimateGameSeconds(
  job: FarmJob,
  qty: number,
  modelKey: string,
  quality: PrintQuality,
  config: PublicFarmConfig | null | undefined
): number {
  if (job.qty <= 0 || qty <= 0) return 0;
  const perPart = job.print_seconds / job.qty;
  const model = printerModel(config, modelKey);
  // The reference machine's speed: the config names it; the starter model is
  // the fallback the contract implies.
  const refSpeed = config?.time?.reference_speed_mms ?? printerModel(config, config?.starter?.printer_model ?? '')?.speed ?? 0;
  const speedFactor = model && model.speed > 0 && refSpeed > 0 ? refSpeed / model.speed : 1;
  const qFactor = config?.quality?.[quality]?.time_factor ?? 1;
  return Math.round(perPart * qty * speedFactor * qFactor);
}

/** Game seconds of work already ahead of a new batch on this printer, at `now`. */
export function queueGameSeconds(printer: FarmPrinter, now: number, timeScale: number): number {
  let total = 0;
  if (printer.current) {
    const end = new Date(printer.current.ends_at).getTime();
    if (!Number.isNaN(end) && end > now) total += ((end - now) / 1000) * (timeScale > 0 ? timeScale : 1);
  }
  for (const q of printer.queue) total += q.seconds;
  return total;
}

export type DeadlineRisk = 'on_time' | 'tight' | 'late';

/** How an estimated finish instant compares with the deadline. Tight = within the last 15% of the window or 10 real minutes. */
export function deadlineRisk(finishAt: number, deadlineIso: string | null, now: number): DeadlineRisk | null {
  if (!deadlineIso) return null;
  const deadline = new Date(deadlineIso).getTime();
  if (Number.isNaN(deadline)) return null;
  if (finishAt > deadline) return 'late';
  const window = Math.max(1, deadline - now);
  const slack = deadline - finishAt;
  if (slack < Math.max(window * 0.15, 10 * 60_000)) return 'tight';
  return 'on_time';
}

export type Urgency = 'urgent' | 'tight' | 'relaxed';

/**
 * Urgency of an offer from the room left between now and its deadline,
 * measured against the real time the print itself needs.
 */
export function offerUrgency(job: FarmJob, now: number, timeScale: number): Urgency {
  const deadline = job.deadline_at ? new Date(job.deadline_at).getTime() : NaN;
  if (Number.isNaN(deadline)) return 'relaxed';
  const needMs = (job.print_seconds / (timeScale > 0 ? timeScale : 1)) * 1000;
  const roomMs = deadline - now;
  if (roomMs <= needMs * 1.25) return 'urgent';
  if (roomMs <= needMs * 2.5) return 'tight';
  return 'relaxed';
}

/** Parts of a job still to allocate, from the server's summary; the whole job when it sent none. */
export function remainingQty(job: FarmJob): number {
  const assigned = job.assignments_summary?.assigned;
  if (typeof assigned === 'number') return Math.max(0, job.qty - assigned);
  return job.state === 'accepted' ? job.qty : 0;
}
