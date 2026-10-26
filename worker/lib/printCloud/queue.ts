/**
 * THE PRINT QUEUE AND THE SCHEDULER (docs/PRINT_CLOUD.md §7.5).
 *
 * Order: priority (high first), then the time the job entered the queue.
 * Waiting in the queue consumes nothing — credits are only billed against
 * verified printing time at completion.
 *
 * A job may run only on a physical machine of ITS printer model (the estimate
 * was sliced for that model's profile; the credits are that model's tier),
 * that is administratively active, has the nozzle and the materials the job
 * needs, has enough AMS slots for its colours, is not inside (or about to
 * enter, before the job would finish) a maintenance window, is not reporting
 * an error, and — if an agent drives it — whose telemetry is fresh.
 *
 * Conflicts are impossible by construction, not by care: an assignment is a
 * row in `pc_printer_assignments` with a partial UNIQUE index on the printer
 * and another on the job, inserted in the same batch as the fenced
 * queued → preparing transition. Two schedulers, or an operator racing the
 * scheduler, cannot both win.
 */
import { many, one, runBatch, type Stmt } from './db';
import { HttpError } from '../http';
import { pcError } from './errors';
import { pcAudit } from './audit';
import { jobEvent, loadJob, transition, type Actor, type JobRow } from './jobs';
import { addSeconds, iso, parseJson, pcId } from './util';
import type { PrintCloudConfig } from './settings';
import { DEFAULT_SETTINGS, type PrintSettings } from './projects';

export interface PrinterRow {
  id: string;
  model_id: string;
  name: string;
  status: string;
  nozzle_um: number;
  ams_slots: number;
  materials_json: string;
  adapter: string;
  operating_seconds: number;
}

interface JobNeeds {
  nozzle_um: number;
  materials: string[];
  colours: number;
  duration_seconds: number;
}

async function needsOf(db: D1Database, job: JobRow): Promise<JobNeeds> {
  const settings = parseJson<PrintSettings>(job.settings_json, DEFAULT_SETTINGS);
  const reqs = await many<{ material: string | null }>(
    db,
    `SELECT p.material FROM pc_job_requirements r JOIN pc_variants v ON v.id = r.variant_id JOIN pc_products p ON p.id = v.product_id
      WHERE r.job_id = ? AND r.kind = 'filament'`,
    job.id
  );
  const est = job.estimate_id ? await one<{ duration_seconds: number }>(db, 'SELECT duration_seconds FROM pc_estimates WHERE id = ?', job.estimate_id) : null;
  return {
    nozzle_um: settings.nozzle_um,
    materials: [...new Set(reqs.map((r) => (r.material ?? '').toUpperCase()).filter(Boolean))],
    colours: reqs.length,
    duration_seconds: Number(est?.duration_seconds ?? 0),
  };
}

export interface CompatibilityVerdict {
  printer_id: string;
  compatible: boolean;
  reasons: string[];
}

/** Why a machine can or cannot take this job — every reason, not just the first. */
export async function printerVerdicts(db: D1Database, job: JobRow, config: PrintCloudConfig, now: Date): Promise<CompatibilityVerdict[]> {
  const needs = await needsOf(db, job);
  const printers = await many<PrinterRow & { busy: number; machine_state: string | null; received_at: string | null }>(
    db,
    `SELECT p.id, p.model_id, p.name, p.status, p.nozzle_um, p.ams_slots, p.materials_json, p.adapter, p.operating_seconds,
            EXISTS (SELECT 1 FROM pc_printer_assignments a WHERE a.printer_id = p.id AND a.state = 'active') AS busy,
            t.machine_state, t.received_at
       FROM pc_printers p LEFT JOIN pc_printer_telemetry t ON t.printer_id = p.id
      WHERE p.model_id = ? ORDER BY p.operating_seconds, p.id`,
    job.printer_model_id
  );
  const windowEnd = iso(addSeconds(now, needs.duration_seconds));
  const out: CompatibilityVerdict[] = [];
  for (const p of printers) {
    const reasons: string[] = [];
    if (p.status !== 'active') reasons.push(`printer_${p.status}`);
    if (p.busy) reasons.push('printer_busy');
    if (p.nozzle_um !== needs.nozzle_um) reasons.push('nozzle_mismatch');
    const loadable = parseJson<string[]>(p.materials_json, []).map((m) => m.toUpperCase());
    if (loadable.length && needs.materials.some((m) => !loadable.includes(m))) reasons.push('material_not_loadable');
    if (needs.colours > 1 && p.ams_slots < needs.colours) reasons.push('not_enough_ams_slots');
    const maint = await one<{ id: string }>(
      db,
      "SELECT id FROM pc_printer_maintenance WHERE printer_id = ? AND status = 'planned' AND starts_at < ? AND ends_at > ? LIMIT 1",
      p.id,
      windowEnd,
      iso(now)
    );
    if (maint) reasons.push('maintenance_window');
    if (p.machine_state === 'error') reasons.push('printer_reports_error');
    if (p.adapter === 'agent') {
      const fresh = p.received_at && (now.getTime() - Date.parse(p.received_at)) / 1000 <= config.telemetry_stale_seconds;
      if (!fresh) reasons.push('telemetry_stale');
    }
    out.push({ printer_id: p.id, compatible: reasons.length === 0, reasons });
  }
  return out;
}

async function dependencyMet(db: D1Database, job: JobRow): Promise<boolean> {
  if (!job.depends_on_job_id) return true;
  const dep = await one<{ status: string }>(db, 'SELECT status FROM pc_print_jobs WHERE id = ?', job.depends_on_job_id);
  return dep?.status === 'completed';
}

/** The statements that put a queued job on a machine (preparing). */
export function assignmentStatements(db: D1Database, job: JobRow, printerId: string, actor: Actor, now: Date): Stmt[] {
  return [
    db
      .prepare("INSERT INTO pc_printer_assignments (id, job_id, printer_id, state, assigned_by, assigned_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .bind(pcId('pcas'), job.id, printerId, actor.id, iso(now)),
    ...transition(db, job, 'preparing', actor, 'assigned', now, { printer_id: printerId }, { assigned_printer_id: printerId }),
    db.prepare("UPDATE pc_queue_entries SET state = 'assigned', updated_at = ? WHERE job_id = ? AND state = 'waiting'").bind(iso(now), job.id),
    db
      .prepare("INSERT INTO pc_printer_events (id, printer_id, kind, detail_json, actor_type, actor_id, created_at) VALUES (?, ?, 'job_assigned', ?, ?, ?, ?)")
      .bind(pcId('pcpe'), printerId, JSON.stringify({ job_id: job.id }), actor.type === 'customer' ? 'system' : actor.type, actor.id, iso(now)),
  ];
}

/** An operator puts a job on a named machine: compatibility is checked, the DB guarantees exclusivity. */
export async function assignJob(db: D1Database, job: JobRow, printerId: string, actor: Actor, config: PrintCloudConfig, now: Date) {
  if (job.status !== 'queued') throw pcError('INVALID_TRANSITION', { from: job.status, to: 'preparing' });
  if (!(await dependencyMet(db, job))) throw pcError('DEPENDENCY_NOT_MET');
  const verdict = (await printerVerdicts(db, job, config, now)).find((v) => v.printer_id === printerId);
  if (!verdict) throw pcError('INCOMPATIBLE_PRINTER', { reason: 'other_model' });
  if (!verdict.compatible) {
    throw verdict.reasons.includes('printer_busy') ? pcError('PRINTER_BUSY') : pcError('INCOMPATIBLE_PRINTER', { reasons: verdict.reasons });
  }
  await runBatch(db, [...assignmentStatements(db, job, printerId, actor, now), ...(await pcAudit(db, actor.id, 'job.assign', job.id, { printer_id: printerId }))]);
}

/** Take a job back off a machine before it starts: preparing → queued. */
export async function unassignJob(db: D1Database, job: JobRow, actor: Actor, now: Date, reason: string) {
  if (job.status !== 'preparing') throw pcError('INVALID_TRANSITION', { from: job.status, to: 'queued' });
  await runBatch(db, [
    db.prepare("UPDATE pc_printer_assignments SET state = 'released', ended_at = ? WHERE job_id = ? AND state = 'active'").bind(iso(now), job.id),
    ...transition(db, job, 'queued', actor, 'unassigned', now, { reason }, { assigned_printer_id: null }),
    db.prepare("UPDATE pc_queue_entries SET state = 'waiting', updated_at = ? WHERE job_id = ? AND state = 'assigned'").bind(iso(now), job.id),
    ...(await pcAudit(db, actor.id, 'job.unassign', job.id, { reason })),
  ]);
}

export async function queuedJobs(db: D1Database, now: Date, limit = 200): Promise<JobRow[]> {
  return many<JobRow>(
    db,
    `SELECT j.* FROM pc_print_jobs j JOIN pc_queue_entries q ON q.job_id = j.id AND q.state = 'waiting'
      WHERE j.status = 'queued' AND (q.not_before IS NULL OR q.not_before <= ?)
      ORDER BY j.priority DESC, q.enqueued_at, j.id LIMIT ?`,
    iso(now),
    limit
  );
}

/**
 * One scheduling pass: walk the queue in order and put each job whose
 * dependency is met on the least-used compatible idle machine. Each
 * assignment is its own batch; a machine taken meanwhile is skipped, never
 * double-booked.
 */
export async function runScheduler(
  db: D1Database,
  config: PrintCloudConfig,
  now: Date,
  limit = 20,
  unitFits?: () => boolean
): Promise<{ assigned: Array<{ job_id: string; printer_id: string }>; waiting: number; more: boolean }> {
  const actor: Actor = { type: 'system', id: 'scheduler' };
  const assigned: Array<{ job_id: string; printer_id: string }> = [];
  const taken = new Set<string>();
  const queue = await queuedJobs(db, now);
  let waiting = 0;
  for (const job of queue) {
    if (assigned.length >= limit) break;
    // Out of room for one more job's look and assignment: the rest wait for the next run.
    if (unitFits && !unitFits()) return { assigned, waiting, more: true };
    if (!(await dependencyMet(db, job))) {
      waiting++;
      continue;
    }
    const candidates = (await printerVerdicts(db, job, config, now)).filter((v) => v.compatible && !taken.has(v.printer_id));
    let done = false;
    for (const c of candidates) {
      try {
        await runBatch(db, [
          ...assignmentStatements(db, await loadJob(db, job.id), c.printer_id, actor, now),
          ...(await pcAudit(db, null, 'job.assign', job.id, { printer_id: c.printer_id, by: 'scheduler' })),
        ]);
        taken.add(c.printer_id);
        assigned.push({ job_id: job.id, printer_id: c.printer_id });
        done = true;
        break;
      } catch (e) {
        if (e instanceof HttpError && (e.code === 'PRINTER_BUSY' || e.code === 'STATE_CHANGED')) continue;
        throw e;
      }
    }
    if (!done) waiting++;
  }
  return { assigned, waiting, more: false };
}

export interface QueueEstimate {
  job_id: string;
  position: number;
  estimated_start_at: string | null;
  estimated_end_at: string | null;
  printer_id: string | null;
  basis: 'simulated' | 'no_compatible_printer' | 'waiting_for_dependency';
}

/**
 * Estimated start and finish for every queued job: a simulation over the
 * machines of each model — when each frees up (its running job's estimate or
 * the agent's fresh remaining time), maintenance windows respected, the queue
 * walked in order. An ESTIMATE, labelled as one; never a promise.
 */
export async function estimateQueue(db: D1Database, config: PrintCloudConfig, now: Date): Promise<QueueEstimate[]> {
  const printers = await many<{ id: string; model_id: string; status: string }>(db, "SELECT id, model_id, status FROM pc_printers WHERE status = 'active' ORDER BY id");
  const freeAt = new Map<string, number>();
  for (const p of printers) {
    const running = await one<{ job_id: string; started_at: string | null; duration: number | null; remaining: number | null; received_at: string | null }>(
      db,
      `SELECT a.job_id, j.started_at, e.duration_seconds AS duration, t.remaining_seconds AS remaining, t.received_at
         FROM pc_printer_assignments a JOIN pc_print_jobs j ON j.id = a.job_id
         LEFT JOIN pc_estimates e ON e.id = j.estimate_id
         LEFT JOIN pc_printer_telemetry t ON t.printer_id = a.printer_id AND t.job_id = a.job_id
        WHERE a.printer_id = ? AND a.state = 'active'`,
      p.id
    );
    let at = now.getTime();
    if (running) {
      const fresh = running.received_at && (now.getTime() - Date.parse(running.received_at)) / 1000 <= config.telemetry_stale_seconds;
      if (fresh && running.remaining !== null) at = now.getTime() + Number(running.remaining) * 1000;
      else if (running.started_at && running.duration) at = Math.max(now.getTime(), Date.parse(running.started_at) + Number(running.duration) * 1000);
      else if (running.duration) at = now.getTime() + Number(running.duration) * 1000;
    }
    freeAt.set(p.id, at);
  }
  const maint = await many<{ printer_id: string; starts_at: string; ends_at: string }>(
    db,
    "SELECT printer_id, starts_at, ends_at FROM pc_printer_maintenance WHERE status = 'planned' AND ends_at > ? ORDER BY starts_at",
    iso(now)
  );
  const queue = await queuedJobs(db, now, 500);
  const out: QueueEstimate[] = [];
  let position = 0;
  for (const job of queue) {
    position++;
    if (!(await dependencyMet(db, job))) {
      out.push({ job_id: job.id, position, estimated_start_at: null, estimated_end_at: null, printer_id: null, basis: 'waiting_for_dependency' });
      continue;
    }
    const verdicts = await printerVerdicts(db, job, config, now);
    // Busy and stale are about NOW; the simulation asks when, so only permanent reasons exclude a machine.
    const usable = verdicts.filter((v) => v.reasons.every((r) => ['printer_busy', 'maintenance_window', 'telemetry_stale'].includes(r))).map((v) => v.printer_id);
    const duration = (await needsOf(db, job)).duration_seconds * 1000;
    let best: { printer: string; start: number } | null = null;
    for (const pid of usable) {
      let start = freeAt.get(pid) ?? now.getTime();
      for (const w of maint.filter((m) => m.printer_id === pid)) {
        const ws = Date.parse(w.starts_at);
        const we = Date.parse(w.ends_at);
        if (start < we && start + duration > ws) start = we;
      }
      if (!best || start < best.start) best = { printer: pid, start };
    }
    if (!best) {
      out.push({ job_id: job.id, position, estimated_start_at: null, estimated_end_at: null, printer_id: null, basis: 'no_compatible_printer' });
      continue;
    }
    freeAt.set(best.printer, best.start + duration);
    out.push({
      job_id: job.id,
      position,
      estimated_start_at: new Date(best.start).toISOString(),
      estimated_end_at: new Date(best.start + duration).toISOString(),
      printer_id: best.printer,
      basis: 'simulated',
    });
  }
  return out;
}

/** An operator moves a job up or down: its priority, mirrored on the queue entry. */
export async function setPriority(db: D1Database, job: JobRow, priority: number, actor: Actor, now: Date) {
  if (!['confirmed', 'queued'].includes(job.status)) throw pcError('INVALID_TRANSITION', { from: job.status });
  await runBatch(db, [
    db.prepare('UPDATE pc_print_jobs SET priority = ?, updated_at = ? WHERE id = ? AND status = ?').bind(priority, iso(now), job.id, job.status),
    db.prepare("UPDATE pc_queue_entries SET priority = ?, updated_at = ? WHERE job_id = ? AND state <> 'removed'").bind(priority, iso(now), job.id),
    jobEvent(db, job, 'priority_changed', actor, now, { from: job.priority, to: priority }),
    ...(await pcAudit(db, actor.id, 'job.priority', job.id, { from: job.priority, to: priority })),
  ]);
}

/** A customer or operator reschedules a queued job to wait until a time (never earlier than now). */
export async function reschedule(db: D1Database, job: JobRow, notBefore: string | null, actor: Actor, now: Date) {
  if (job.status !== 'queued') throw pcError('INVALID_TRANSITION', { from: job.status });
  if (notBefore && notBefore < iso(now)) throw pcError('VALIDATION', { field: 'not_before', reason: 'in_the_past' });
  await runBatch(db, [
    db.prepare("UPDATE pc_queue_entries SET not_before = ?, updated_at = ? WHERE job_id = ? AND state = 'waiting'").bind(notBefore, iso(now), job.id),
    jobEvent(db, job, 'rescheduled', actor, now, { not_before: notBefore }),
  ]);
}
