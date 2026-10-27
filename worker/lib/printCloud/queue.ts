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
 * an error, and — if an agent drives it — whose telemetry is fresh and says
 * the agent reaches it and it is not running a print of its own
 * (printers.ts `machineStateReasons`).
 *
 * A job that depends on another waits for that print to be MADE: the job
 * itself completing, or a reprint of it (down its `parent_job_id` chain).
 * A dependency that can no longer be made — cancelled, or failed and closed
 * without a reprint — releases the job waiting on it: the scheduler cancels
 * it, every reservation given back and the customer told, instead of holding
 * their hours and grams for a print that cannot come.
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
import { cancelJob, jobEvent, transition, type Actor, type JobRow } from './jobs';
import { machineStateReasons } from './printers';
import { iso, parseJson, pcId } from './util';
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

/** A machine as a verdict reads it: the row, whether a cloud job holds it, and its latest reading. */
interface MachineRow extends PrinterRow {
  busy: number;
  machine_state: string | null;
  received_at: string | null;
}

interface MaintenanceWindow {
  printer_id: string;
  starts_at: string;
  ends_at: string;
}

interface JobNeeds {
  nozzle_um: number;
  materials: string[];
  colours: number;
  duration_seconds: number;
}

/** The machines (of one model, or all), least used first, with their assignment and latest reading. */
async function machinesOf(db: D1Database, modelId?: string): Promise<MachineRow[]> {
  return many<MachineRow>(
    db,
    `SELECT p.id, p.model_id, p.name, p.status, p.nozzle_um, p.ams_slots, p.materials_json, p.adapter, p.operating_seconds,
            EXISTS (SELECT 1 FROM pc_printer_assignments a WHERE a.printer_id = p.id AND a.state = 'active') AS busy,
            t.machine_state, t.received_at
       FROM pc_printers p LEFT JOIN pc_printer_telemetry t ON t.printer_id = p.id
      ${modelId ? 'WHERE p.model_id = ?' : ''} ORDER BY p.operating_seconds, p.id`,
    ...(modelId ? [modelId] : [])
  );
}

/** Planned maintenance that has not ended yet (of one model's machines, or all). */
async function plannedWindows(db: D1Database, now: Date, modelId?: string): Promise<MaintenanceWindow[]> {
  return many<MaintenanceWindow>(
    db,
    `SELECT w.printer_id, w.starts_at, w.ends_at FROM pc_printer_maintenance w ${modelId ? 'JOIN pc_printers p ON p.id = w.printer_id' : ''}
      WHERE w.status = 'planned' AND w.ends_at > ? ${modelId ? 'AND p.model_id = ?' : ''} ORDER BY w.starts_at`,
    iso(now),
    ...(modelId ? [modelId] : [])
  );
}

/** What each job needs of a machine: two statements for a whole page of jobs, whatever its length. */
async function needsOf(db: D1Database, jobs: JobRow[]): Promise<Map<string, JobNeeds>> {
  const out = new Map<string, JobNeeds>();
  if (!jobs.length) return out;
  const reqs = await many<{ job_id: string; material: string | null }>(
    db,
    `SELECT r.job_id, p.material FROM pc_job_requirements r JOIN pc_variants v ON v.id = r.variant_id JOIN pc_products p ON p.id = v.product_id
      WHERE r.kind = 'filament' AND r.job_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(jobs.map((j) => j.id))
  );
  const estimateIds = jobs.map((j) => j.estimate_id).filter((id): id is string => !!id);
  const estimates = estimateIds.length
    ? await many<{ id: string; duration_seconds: number }>(db, 'SELECT id, duration_seconds FROM pc_estimates WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(estimateIds))
    : [];
  const duration = new Map(estimates.map((e) => [e.id, Number(e.duration_seconds)]));
  const materials = new Map<string, Array<string | null>>();
  for (const r of reqs) materials.set(r.job_id, [...(materials.get(r.job_id) ?? []), r.material]);
  for (const job of jobs) {
    const mine = materials.get(job.id) ?? [];
    out.set(job.id, {
      nozzle_um: parseJson<PrintSettings>(job.settings_json, DEFAULT_SETTINGS).nozzle_um,
      materials: [...new Set(mine.map((m) => (m ?? '').toUpperCase()).filter(Boolean))],
      colours: mine.length,
      duration_seconds: job.estimate_id ? (duration.get(job.estimate_id) ?? 0) : 0,
    });
  }
  return out;
}

export interface CompatibilityVerdict {
  printer_id: string;
  compatible: boolean;
  reasons: string[];
}

/** Why this machine can or cannot take a job with these needs — every reason, not just the first. Reads nothing. */
function verdictOf(p: MachineRow, needs: JobNeeds, windows: MaintenanceWindow[], staleSeconds: number, now: Date): CompatibilityVerdict {
  const reasons: string[] = [];
  if (p.status !== 'active') reasons.push(`printer_${p.status}`);
  if (p.busy) reasons.push('printer_busy');
  if (p.nozzle_um !== needs.nozzle_um) reasons.push('nozzle_mismatch');
  const loadable = parseJson<string[]>(p.materials_json, []).map((m) => m.toUpperCase());
  if (loadable.length && needs.materials.some((m) => !loadable.includes(m))) reasons.push('material_not_loadable');
  if (needs.colours > 1 && p.ams_slots < needs.colours) reasons.push('not_enough_ams_slots');
  // A window that is on now, or opens before the job would finish.
  const from = now.getTime();
  const to = from + needs.duration_seconds * 1000;
  if (windows.some((w) => w.printer_id === p.id && Date.parse(w.starts_at) < to && Date.parse(w.ends_at) > from)) reasons.push('maintenance_window');
  reasons.push(...machineStateReasons(p, staleSeconds, now));
  return { printer_id: p.id, compatible: reasons.length === 0, reasons };
}

/** Why a machine can or cannot take this job — every reason, not just the first. */
export async function printerVerdicts(db: D1Database, job: JobRow, config: PrintCloudConfig, now: Date): Promise<CompatibilityVerdict[]> {
  const needs = (await needsOf(db, [job])).get(job.id) as JobNeeds;
  const windows = await plannedWindows(db, now, job.printer_model_id);
  return (await machinesOf(db, job.printer_model_id)).map((p) => verdictOf(p, needs, windows, config.telemetry_stale_seconds, now));
}

/** Where a job's dependency stands: made, still to be made, or never to be made. */
type DependencyState = 'met' | 'pending' | 'dead';

/**
 * The state of every dependency of these jobs, in one statement. A
 * dependency is MET when it, or a reprint of it (any job down its
 * `parent_job_id` chain), completed; PENDING while some job of that chain
 * can still complete — live, or failed with its failure still open (it may
 * yet be reprinted); DEAD when none can.
 */
async function dependencyStates(db: D1Database, jobs: JobRow[]): Promise<Map<string, DependencyState>> {
  const out = new Map<string, DependencyState>();
  const deps = [...new Set(jobs.map((j) => j.depends_on_job_id).filter((id): id is string => !!id))];
  if (!deps.length) return out;
  const rows = await many<{ root: string; met: number; alive: number }>(
    db,
    `WITH RECURSIVE chain(root, id, status) AS (
       SELECT id, id, status FROM pc_print_jobs WHERE id IN (SELECT value FROM json_each(?))
       UNION
       SELECT c.root, j.id, j.status FROM pc_print_jobs j JOIN chain c ON j.parent_job_id = c.id
     )
     SELECT root, MAX(status = 'completed') AS met,
            MAX(status NOT IN ('completed', 'cancelled', 'reprint_requested', 'failed')
                OR (status = 'failed' AND EXISTS (SELECT 1 FROM pc_failures f WHERE f.job_id = chain.id AND f.status = 'reported'))) AS alive
       FROM chain GROUP BY root`,
    JSON.stringify(deps)
  );
  for (const r of rows) out.set(r.root, Number(r.met) ? 'met' : Number(r.alive) ? 'pending' : 'dead');
  return out;
}

const dependencyOf = (job: JobRow, states: Map<string, DependencyState>): DependencyState =>
  job.depends_on_job_id ? (states.get(job.depends_on_job_id) ?? 'dead') : 'met';

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
  const dependency = dependencyOf(job, await dependencyStates(db, [job]));
  if (dependency !== 'met') throw pcError('DEPENDENCY_NOT_MET', dependency === 'dead' ? { reason: 'dependency_cannot_complete' } : {});
  const verdict = (await printerVerdicts(db, job, config, now)).find((v) => v.printer_id === printerId);
  if (!verdict) throw pcError('INCOMPATIBLE_PRINTER', { reason: 'other_model' });
  if (!verdict.compatible) {
    const busy = verdict.reasons.includes('printer_busy') || verdict.reasons.includes('printer_occupied');
    throw busy ? pcError('PRINTER_BUSY') : pcError('INCOMPATIBLE_PRINTER', { reasons: verdict.reasons });
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

/** A queued job with the time it entered the queue: with its priority and id, its place in the order. */
export type QueuedJob = JobRow & { enqueued_at: string };

/** The queue in order — `limit` jobs from the start, or from just after `after`. */
export async function queuedJobs(db: D1Database, now: Date, limit = 200, after: QueuedJob | null = null): Promise<QueuedJob[]> {
  return many<QueuedJob>(
    db,
    `SELECT j.*, q.enqueued_at FROM pc_print_jobs j JOIN pc_queue_entries q ON q.job_id = j.id AND q.state = 'waiting'
      WHERE j.status = 'queued' AND (q.not_before IS NULL OR q.not_before <= ?)
        ${after ? 'AND (j.priority < ? OR (j.priority = ? AND (q.enqueued_at > ? OR (q.enqueued_at = ? AND j.id > ?))))' : ''}
      ORDER BY j.priority DESC, q.enqueued_at, j.id LIMIT ?`,
    iso(now),
    ...(after ? [after.priority, after.priority, after.enqueued_at, after.enqueued_at, after.id] : []),
    limit
  );
}

/** Jobs a scheduling pass reads at a time. */
export const SCHEDULER_PAGE = 200;

/** Is this job still where the pass read it? Cancelled, assigned or moved since, it has left the queue. */
async function stillQueued(db: D1Database, jobId: string): Promise<JobRow | null> {
  const job = await one<JobRow>(db, 'SELECT * FROM pc_print_jobs WHERE id = ?', jobId);
  return job?.status === 'queued' ? job : null;
}

/**
 * WHAT RELEASING A STRANDED JOB SENDS, AT MOST — measured, from one
 * reservation to the most a job holds (its hours, 16 colours and 20
 * accessories), in tests/printCloudFixes-queue2.test.ts. Three reads (the job,
 * its hours, its materials) and a batch of the transition (three), the queue
 * entry, the assignment, the slicing request, the notice and the audit row
 * (three with the event bus on, after its outbox probe once an isolate); then
 * four per reservation (its flip, its fence, its account, its ledger); and for
 * its hours one read of the lots they are held on and one statement per lot
 * hold given back (credits.ts `releaseCredits`). No ceiling: the room asked
 * before a release is the whole release, so a release larger than the share
 * is skipped, never squeezed in (`runScheduler`).
 */
const RELEASE_BASE_STATEMENTS = 15;
const RELEASE_PER_RESERVATION = 4;
const RELEASE_PER_HOLD = 1;

interface HeldCount {
  reservations: number;
  holds: number;
}

const releaseCost = (c: HeldCount): number => RELEASE_BASE_STATEMENTS + RELEASE_PER_RESERVATION * c.reservations + RELEASE_PER_HOLD * c.holds;

/**
 * How many reservations each of these jobs holds (its hours and each
 * material), and on how many lots its hours are held: one statement for a
 * page's stranded jobs. A queued job never gains either, so a count read with
 * the page can only be above what its release meets later.
 */
async function reservationCounts(db: D1Database, jobIds: string[]): Promise<Map<string, HeldCount>> {
  if (!jobIds.length) return new Map();
  const ids = JSON.stringify(jobIds);
  const rows = await many<{ job_id: string; reservations: number; holds: number }>(
    db,
    `SELECT job_id, SUM(r) AS reservations, SUM(h) AS holds FROM (
       SELECT job_id, 1 AS r, 0 AS h FROM pc_credit_reservations WHERE state = 'active' AND job_id IN (SELECT value FROM json_each(?1))
       UNION ALL
       SELECT ref_id, 1, 0 FROM pc_inventory_reservations WHERE purpose = 'print_job' AND state = 'active' AND ref_id IN (SELECT value FROM json_each(?1))
       UNION ALL
       SELECT r.job_id, 0, 1 FROM pc_credit_reservation_lots l JOIN pc_credit_reservations r ON r.id = l.reservation_id
        WHERE r.state = 'active' AND r.job_id IN (SELECT value FROM json_each(?1))
     ) GROUP BY job_id`,
    ids
  );
  return new Map(rows.map((r) => [r.job_id, { reservations: Number(r.reservations), holds: Number(r.holds) }]));
}

/** A queued job whose dependency can no longer be made: cancelled with every reservation released, the customer told. */
async function releaseStranded(db: D1Database, jobId: string, now: Date): Promise<boolean> {
  const job = await stillQueued(db, jobId);
  if (!job) return false;
  try {
    await cancelJob(db, job, { type: 'system', id: 'system' }, now, 'dependency_cannot_complete');
    return true;
  } catch (e) {
    if (e instanceof HttpError && (e.code === 'STATE_CHANGED' || e.code === 'INVALID_TRANSITION')) return false;
    throw e;
  }
}

/**
 * One scheduling pass: walk the WHOLE queue in order, a page at a time, and
 * put each job whose dependency is met on the least-used compatible idle
 * machine; release a job whose dependency can no longer be made. At most
 * `limit` of those changes a pass; the next pass takes the rest.
 *
 * The machines and their maintenance are read once, and each page's needs,
 * dependencies and (for its stranded jobs) reservations once, so a job no
 * machine can take now costs no statement: room (`unitFits`, one unit of work
 * and its close) is asked only before WORK — an assignment, a release, the
 * next page. The check before the reads makes room for them and the first
 * unit together. Each assignment is its own batch on the job as it is at that
 * moment: a job cancelled or assigned since its page was read is skipped, a
 * machine taken meanwhile is skipped, never double-booked.
 *
 * A release asks for all it sends (`releaseCost`, sized to the job's
 * reservations). One that does not fit is skipped — deferred, not waited on —
 * and the pass goes on placing the jobs behind it, so a large stranded job
 * never hides them. A release larger than any quarter-hour share (the largest
 * job's is) is left to a run with the room: the operator's queue run, which
 * passes no `unitFits`, or the admin task run (600 statements).
 *
 * Out of room, or past a deferred release, the pass asks to run again
 * (`more`) only if it changed something: one that only looked would look at
 * the same jobs again, so it ends, and the next quarter hour's pass starts
 * afresh.
 */
export async function runScheduler(
  db: D1Database,
  config: PrintCloudConfig,
  now: Date,
  limit = 20,
  unitFits?: (statements?: number) => boolean
): Promise<{ assigned: Array<{ job_id: string; printer_id: string }>; released: string[]; waiting: number; deferred: number; more: boolean }> {
  const actor: Actor = { type: 'system', id: 'scheduler' };
  const assigned: Array<{ job_id: string; printer_id: string }> = [];
  const released: string[] = [];
  const taken = new Set<string>();
  let waiting = 0;
  let deferred = 0;
  const result = (more: boolean) => ({ assigned, released, waiting, deferred, more });
  if (unitFits && !unitFits()) return result(true);
  // The check before the reads covers them and the first standard unit; a larger unit always asks.
  let first = true;
  const room = (statements?: number) => {
    if (first && statements === undefined) {
      first = false;
      return true;
    }
    first = false;
    return !unitFits || unitFits(statements);
  };
  const changed = () => assigned.length + released.length > 0;
  const machines = await machinesOf(db);
  const windows = await plannedWindows(db, now);
  let after: QueuedJob | null = null;
  for (;;) {
    const page = await queuedJobs(db, now, SCHEDULER_PAGE, after);
    const needs = await needsOf(db, page);
    const dependencies = await dependencyStates(db, page);
    // A run without a bound releases whatever it meets: only a bounded one sizes its releases.
    const held = unitFits ? await reservationCounts(db, page.filter((j) => dependencyOf(j, dependencies) === 'dead').map((j) => j.id)) : new Map<string, HeldCount>();
    for (const job of page) {
      if (assigned.length + released.length >= limit) return result(false);
      const dependency = dependencyOf(job, dependencies);
      if (dependency === 'pending') {
        waiting++;
        continue;
      }
      if (dependency === 'dead') {
        if (unitFits && !room(releaseCost(held.get(job.id) ?? { reservations: 0, holds: 0 }))) {
          deferred++;
          continue;
        }
        if (await releaseStranded(db, job.id, now)) released.push(job.id);
        continue;
      }
      const jobNeeds = needs.get(job.id) as JobNeeds;
      const candidates = machines.filter(
        (p) => p.model_id === job.printer_model_id && !taken.has(p.id) && verdictOf(p, jobNeeds, windows, config.telemetry_stale_seconds, now).compatible
      );
      let done = false;
      let gone = false;
      for (const c of candidates) {
        if (!room()) return result(changed());
        const current = await stillQueued(db, job.id);
        if (!current) {
          gone = true;
          break;
        }
        try {
          await runBatch(db, [
            ...assignmentStatements(db, current, c.id, actor, now),
            ...(await pcAudit(db, null, 'job.assign', job.id, { printer_id: c.id, by: 'scheduler' })),
          ]);
          taken.add(c.id);
          assigned.push({ job_id: job.id, printer_id: c.id });
          done = true;
          break;
        } catch (e) {
          // The machine was taken meanwhile: the next one. The job moved meanwhile: the next turn reads it again and leaves it.
          if (e instanceof HttpError && e.code === 'PRINTER_BUSY') taken.add(c.id);
          else if (!(e instanceof HttpError && e.code === 'STATE_CHANGED')) throw e;
        }
      }
      if (!done && !gone) waiting++;
    }
    if (page.length < SCHEDULER_PAGE) break;
    if (!room()) return result(changed());
    after = page[page.length - 1];
  }
  return result(deferred > 0 && changed());
}

export interface QueueEstimate {
  job_id: string;
  position: number;
  estimated_start_at: string | null;
  estimated_end_at: string | null;
  printer_id: string | null;
  basis: 'simulated' | 'no_compatible_printer' | 'waiting_for_dependency' | 'dependency_cannot_complete';
}

/** Reasons about NOW (a machine busy, silent, in maintenance, running its own print): the simulation asks WHEN, so they never exclude a machine. */
const MOMENTARY_REASONS = ['printer_busy', 'maintenance_window', 'telemetry_stale', 'printer_offline', 'printer_occupied'];

/**
 * Estimated start and finish for every queued job: a simulation over the
 * machines of each model — when each frees up (its running job's estimate or
 * the agent's fresh remaining time), maintenance windows respected, the queue
 * walked in order. An ESTIMATE, labelled as one; never a promise.
 */
export async function estimateQueue(db: D1Database, config: PrintCloudConfig, now: Date): Promise<QueueEstimate[]> {
  const machines = await machinesOf(db);
  const freeAt = new Map<string, number>();
  for (const p of machines.filter((m) => m.status === 'active')) {
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
  const maint = await plannedWindows(db, now);
  const queue = await queuedJobs(db, now, 500);
  const needs = await needsOf(db, queue);
  const dependencies = await dependencyStates(db, queue);
  const out: QueueEstimate[] = [];
  let position = 0;
  for (const job of queue) {
    position++;
    const dependency = dependencyOf(job, dependencies);
    if (dependency !== 'met') {
      const basis = dependency === 'pending' ? 'waiting_for_dependency' : 'dependency_cannot_complete';
      out.push({ job_id: job.id, position, estimated_start_at: null, estimated_end_at: null, printer_id: null, basis });
      continue;
    }
    const jobNeeds = needs.get(job.id) as JobNeeds;
    const usable = machines
      .filter((p) => p.model_id === job.printer_model_id)
      .map((p) => verdictOf(p, jobNeeds, maint, config.telemetry_stale_seconds, now))
      .filter((v) => v.reasons.every((r) => MOMENTARY_REASONS.includes(r)))
      .map((v) => v.printer_id);
    const duration = jobNeeds.duration_seconds * 1000;
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
