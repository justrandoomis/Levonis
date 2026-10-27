/**
 * THE DURABLE BACKGROUND RUNNER (docs/PRINT_CLOUD.md §12).
 *
 * Work is a row (`pc_background_jobs`, written by tasks.ts in the batch of
 * the request that needs it). A runner CLAIMS due rows under a lease — a
 * fenced UPDATE with a fresh token, so two runners never take the same row —
 * runs the handler with a deadline, and records the outcome: succeeded, or
 * failed with the next attempt backed off exponentially, or dead after its
 * last attempt. A runner that dies mid-task (killed, so no outcome is ever
 * recorded) leaves a lease that expires; the claim already set that attempt's
 * backoff, so the row is claimed again after it, behind fresher due work —
 * and after the LAST attempt it is dead, never claimed again. Every handler is
 * idempotent (it re-reads state and acts only on what is still to do), so a
 * retried task cannot double an effect. Each attempt writes a log line.
 *
 * Runners, every one bounded by the D1 statements of its own invocation: the
 * quarter-hour cron (its share, after the platform's own jobs), a `waitUntil`
 * after the request that enqueued the work (only the kinds that request
 * enqueued, `runAfterRequest`), and the operator's «run now» door.
 */
import type { Env } from '../types';
import { countingD1 } from '../d1Count';
import { many, one, runBatch, fence, printCloudInstalled } from './db';
import { expireUnpaidOrders } from './orders';
import { analyseStoredFile } from './files';
import { processImport } from './imports';
import { loadConfig } from './settings';
import { runScheduler } from './queue';
import { reconcile } from './reconcile';
import { sweepSlicingLeases } from './slicing';
import { enqueueTask, type TaskKind } from './tasks';
import { expiredLots, planLotExpiry } from './credits';
import { pcNotify } from './notify';
import { addSeconds, iso, pcId } from './util';

type RunnerEnv = Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>;

export const LEASE_SECONDS = 120;
export const TASK_TIMEOUT_MS = 25_000;

/** Whether `n` more D1 statements fit in what the caller may still spend. */
export type Room = (n: number) => boolean;

/**
 * THE MOST STATEMENTS ONE UNIT OF TASK WORK SENDS: one order expired, one
 * credit lot expired, one low-balance notice, one queue assignment, one
 * slicing lease swept, one file measured, one import step — or the whole
 * reconciliation (twenty-four reads). Every loop asks for this much room
 * before each unit, so a bounded run never overshoots its share
 * (tests/printCloudOperations.test.ts measures a run at its bound). The one
 * larger unit, the scheduler's release of a stranded job, asks for its own
 * measured size, and is skipped when that does not fit (queue.ts `releaseCost`).
 */
export const PRINT_CLOUD_UNIT_STATEMENTS = 30;

/** A task's own statements around its work: the claim (read, update, fence), the settings read, the first list read, the close (update, log), and slack. */
export const PRINT_CLOUD_TASK_OVERHEAD = 8;

/** A `Room` over a monotonic statement counter: `budget` statements from the moment it is made. */
export function roomWithin(used: () => number, budget: number): Room {
  const start = used();
  return (n) => used() - start + n <= budget;
}

/** Room for one more unit of a loop (or `statements` of a larger one), and the close that follows it. */
const unitFits = (room: Room | undefined, statements = PRINT_CLOUD_UNIT_STATEMENTS) => !room || room(statements + 2);

/** A scheduling pass's `unitFits` within a room (queue.ts `runScheduler`): a standard unit, or a release's own measured size, and the close after it. */
export function schedulerRoom(room: Room): (statements?: number) => boolean {
  return (statements) => unitFits(room, statements);
}

interface TaskRow {
  id: string;
  kind: TaskKind;
  payload_json: string;
  attempts: number;
  max_attempts: number;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error('TASK_TIMEOUT')), ms)))]);
  } finally {
    if (t) clearTimeout(t);
  }
}

interface Outcome {
  summary: string;
  /** The loop stopped for room, not for want of work: the task runs again. */
  more?: boolean;
}

/** The work itself. Each handler is idempotent and returns a short summary for the log. */
async function handle(env: RunnerEnv, task: TaskRow, now: Date, room?: Room): Promise<Outcome> {
  const db = env.DB;
  const payload = JSON.parse(task.payload_json || '{}') as Record<string, unknown>;
  const { config } = await loadConfig(db);
  switch (task.kind) {
    case 'analyze_model_file':
      return { summary: `file ${String(payload.file_id)}: ${await analyseStoredFile(env, String(payload.file_id), now)}` };
    case 'import_model_url':
      return { summary: `import ${String(payload.import_id)}: ${await processImport(env, String(payload.import_id), config, now)}` };
    case 'expire_orders': {
      const r = await expireUnpaidOrders(db, now, 25, room ? () => unitFits(room) : undefined);
      return { summary: `expired ${r.expired}, failed ${r.failed}`, more: r.more };
    }
    case 'expire_credit_lots': {
      let n = 0;
      let failed = 0;
      let firstError = '';
      let more = false;
      for (const lot of await expiredLots(db, now)) {
        if (!unitFits(room)) {
          more = true;
          break;
        }
        // Only the lot's free part expires (credits.ts), and the page holds
        // only lots that have one. A lot that changed since it was read — a
        // hold settled or given back meanwhile — fails its batch and waits for
        // the next run; it never holds back the lots behind it.
        try {
          const planned = await planLotExpiry(db, lot, now);
          if (!planned) continue;
          await runBatch(db, planned.statements);
          n++;
        } catch (e) {
          failed++;
          firstError ||= e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        }
      }
      // The lots that could expire did; a lot that failed fails the task, so the error is retried and stays visible.
      if (failed) throw new Error(`expired lots ${n}, failed ${failed}: ${firstError}`.slice(0, 400));
      return { summary: `expired lots ${n}`, more };
    }
    case 'low_inventory_scan': {
      // The variant's three names and the unit's labels: each body of the notice reads its own (notify.ts `material`).
      const low = await many<{
        id: string;
        user_id: string;
        variant_id: string;
        available_qty: number;
        unit_code: string;
        name_ar: string;
        name_en: string;
        name_ckb: string;
        label_ar: string | null;
        label_ckb: string | null;
        low_stock_alert_qty: number | null;
      }>(
        db,
        `SELECT a.id, a.user_id, a.variant_id, a.available_qty, a.unit_code, v.name_ar, v.name_en, v.name_ckb, u.label_ar, u.label_ckb, a.low_stock_alert_qty
           FROM pc_inventory_accounts a JOIN pc_variants v ON v.id = a.variant_id LEFT JOIN pc_units u ON u.code = a.unit_code
          WHERE a.available_qty <= COALESCE(a.low_stock_alert_qty, CASE WHEN a.unit_code = 'g' THEN ? ELSE -1 END)
            AND a.consumed_qty > 0
            AND (a.low_stock_notified_at IS NULL OR a.low_stock_notified_at < a.updated_at)
          LIMIT 100`,
        config.low_inventory_default_g
      );
      let more = false;
      let sent = 0;
      for (const a of low) {
        if (!unitFits(room)) {
          more = true;
          break;
        }
        sent++;
        await runBatch(db, [
          pcNotify(db, {
            userId: a.user_id,
            notice: 'inventory_low',
            entity: 'print_cloud_inventory',
            entityId: a.variant_id,
            link: '/print-cloud/inventory',
            vars: { qty: String(a.available_qty) },
            material: a,
            eventKey: `inventory_low:${a.id}:${a.available_qty}`,
          }),
          db.prepare('UPDATE pc_inventory_accounts SET low_stock_notified_at = ? WHERE id = ?').bind(iso(now), a.id),
        ]);
      }
      return { summary: `low balances ${sent} of ${low.length}`, more };
    }
    case 'schedule_queue': {
      const r = await runScheduler(db, config, now, 20, room ? schedulerRoom(room) : undefined);
      return { summary: `assigned ${r.assigned.length}, released ${r.released.length}, deferred ${r.deferred.length}, waiting ${r.waiting}`, more: r.more };
    }
    case 'reconcile': {
      const r = await reconcile(db);
      return { summary: `reconciliation ${r.ok ? 'clean' : 'issues: ' + r.checks.filter((c) => !c.ok).map((c) => c.name).join(',')}` };
    }
    case 'slicing_lease_sweep': {
      const r = await sweepSlicingLeases(db, now, room ? () => unitFits(room) : undefined);
      return { summary: `requeued ${r.requeued}, failed ${r.failed}`, more: r.more };
    }
  }
}

/** The wait after failed attempt number `attempts`, before the next one. */
const backoffSeconds = (attempts: number) => Math.min(3600, 30 * 2 ** (attempts - 1));

/** What a runner that died in a task's last attempt leaves in its row. */
const LEASE_EXPIRED_AFTER_LAST_ATTEMPT = 'LEASE_EXPIRED_AFTER_LAST_ATTEMPT';

/** Due: queued and its time has come, or running under a lease that expired (its runner died) once that attempt's backoff is over. */
const DUE = "(status = 'queued' AND run_after <= ?) OR (status = 'running' AND lease_until < ? AND run_after <= ?)";

/**
 * Claim one due task under a lease — of these `kinds` only, when named. Null
 * when there is nothing due or another runner won; 'retired' when the due row
 * was a spent lease — its runner died in the last attempt — now recorded dead
 * instead of run again.
 */
async function claim(db: D1Database, now: Date, kinds?: readonly TaskKind[]): Promise<TaskRow | 'retired' | null> {
  const due = await one<TaskRow & { status: string }>(
    db,
    `SELECT id, kind, payload_json, attempts, max_attempts, status FROM pc_background_jobs
      WHERE (${DUE}) ${kinds ? 'AND kind IN (SELECT value FROM json_each(?))' : ''} ORDER BY run_after, id LIMIT 1`,
    iso(now),
    iso(now),
    iso(now),
    ...(kinds ? [JSON.stringify(kinds)] : [])
  );
  if (!due) return null;
  const token = pcId('lease');
  if (due.status === 'running' && due.attempts >= due.max_attempts) {
    try {
      await runBatch(db, [
        db
          .prepare(
            `UPDATE pc_background_jobs SET status = 'dead', lease_token = ?, lease_until = NULL, last_error = ?, finished_at = ?, updated_at = ?
              WHERE id = ? AND attempts = ? AND status = 'running' AND lease_until < ?`
          )
          .bind(token, LEASE_EXPIRED_AFTER_LAST_ATTEMPT, iso(now), iso(now), due.id, due.attempts, iso(now)),
        fence(db, 'STATE_CHANGED', '(SELECT lease_token FROM pc_background_jobs WHERE id = ?) = ?', [due.id, token]),
        log(db, due, 'error', LEASE_EXPIRED_AFTER_LAST_ATTEMPT, now),
      ]);
    } catch {
      return null;
    }
    return 'retired';
  }
  // run_after is set as if this attempt had already failed: should the runner
  // die in it, the row is due again only after the lease and that backoff.
  const attempts = due.attempts + 1;
  try {
    await runBatch(db, [
      db
        .prepare(
          `UPDATE pc_background_jobs SET status = 'running', lease_token = ?, lease_until = ?, run_after = ?, attempts = attempts + 1, updated_at = ?
            WHERE id = ? AND attempts = ? AND (${DUE})`
        )
        .bind(token, iso(addSeconds(now, LEASE_SECONDS)), iso(addSeconds(now, LEASE_SECONDS + backoffSeconds(attempts))), iso(now), due.id, due.attempts, iso(now), iso(now), iso(now)),
      fence(db, 'STATE_CHANGED', '(SELECT lease_token FROM pc_background_jobs WHERE id = ?) = ?', [due.id, token]),
    ]);
  } catch {
    return null;
  }
  return { ...due, attempts };
}

function log(db: D1Database, task: TaskRow, level: 'info' | 'warning' | 'error', message: string, now: Date) {
  return db
    .prepare('INSERT INTO pc_background_job_logs (id, job_id, attempt, level, message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(pcId('pcbl'), task.id, task.attempts, level, message.slice(0, 1000), iso(now));
}

export interface RunReport {
  ran: number;
  succeeded: number;
  failed: number;
  dead: number;
}

/**
 * Run up to `limit` due tasks — of these `kinds` only, when named (the claim
 * takes no other). Never throws: a broken task is recorded, the next one
 * still runs. With `room`, a task starts only while its overhead and one unit
 * of work fit, and a task whose loop stopped for room is queued again (its
 * attempt not counted) for the next run.
 */
export async function runPrintCloudTasks(
  env: RunnerEnv,
  opts: { limit?: number; now?: () => Date; room?: Room; kinds?: readonly TaskKind[] } = {}
): Promise<RunReport> {
  const report: RunReport = { ran: 0, succeeded: 0, failed: 0, dead: 0 };
  const clock = opts.now ?? (() => new Date());
  if (!(await printCloudInstalled(env.DB))) return report;
  const db = env.DB;
  for (let i = 0; i < (opts.limit ?? 10); i++) {
    if (opts.room && !opts.room(PRINT_CLOUD_TASK_OVERHEAD + PRINT_CLOUD_UNIT_STATEMENTS)) break;
    const now = clock();
    const task = await claim(db, now, opts.kinds);
    if (!task) break;
    if (task === 'retired') {
      report.dead++;
      continue;
    }
    report.ran++;
    try {
      const outcome = await withTimeout(handle(env, task, now, opts.room), TASK_TIMEOUT_MS);
      const done = clock();
      await db.batch(
        outcome.more
          ? [
              db
                .prepare("UPDATE pc_background_jobs SET status = 'queued', run_after = ?, attempts = attempts - 1, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?")
                .bind(iso(done), iso(done), task.id),
              log(db, task, 'info', `${outcome.summary}; the rest next run`, done),
            ]
          : [
              db.prepare("UPDATE pc_background_jobs SET status = 'succeeded', finished_at = ?, updated_at = ?, last_error = NULL WHERE id = ?").bind(iso(done), iso(done), task.id),
              log(db, task, 'info', outcome.summary, done),
            ]
      );
      report.succeeded++;
    } catch (e) {
      const done = clock();
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const dead = task.attempts >= task.max_attempts;
      const backoff = backoffSeconds(task.attempts);
      await db
        .batch([
          db
            .prepare('UPDATE pc_background_jobs SET status = ?, run_after = ?, last_error = ?, updated_at = ?, finished_at = ? WHERE id = ?')
            .bind(dead ? 'dead' : 'queued', iso(addSeconds(done, backoff)), message.slice(0, 500), iso(done), dead ? iso(done) : null, task.id),
          log(db, task, 'error', message, done),
        ])
        .catch(() => undefined);
      if (dead) report.dead++;
      else report.failed++;
    }
  }
  return report;
}

/** What the runner after a request may spend of that request's invocation (D1 allows 1,000 queries in one). */
export const AFTER_REQUEST_STATEMENTS = 300;

/**
 * The runner a request starts after its answer (`waitUntil`, after
 * `POST /files` and `POST /imports`): only the `kinds` of work that request
 * enqueued (an import's, with the analysis of the file it brings in), at most
 * `limit` tasks, within `AFTER_REQUEST_STATEMENTS` of the invocation. A
 * customer's request never works the scheduler's backlog or the periodic
 * work: whatever else is due waits for the cron and the operator's doors,
 * each bounded by its own invocation.
 */
export function runAfterRequest(env: RunnerEnv, kinds: readonly TaskKind[], limit = 2): Promise<RunReport> {
  const counted = countingD1(env.DB);
  return runPrintCloudTasks({ ...env, DB: counted.db }, { limit, kinds, room: roomWithin(() => counted.executed, AFTER_REQUEST_STATEMENTS) });
}

/**
 * The operator's «run now» door (`POST /admin/print-cloud/tasks/run`): a
 * scheduling pass leads the due work, so the release of a stranded job too
 * large for the cron's share (queue.ts `releaseCost`) is done with this run's
 * room. One such pass a minute, however often the door is used.
 */
export async function runTasksByHand(env: RunnerEnv, opts: { limit?: number; room?: Room } = {}): Promise<RunReport> {
  if (await printCloudInstalled(env.DB)) {
    const now = new Date();
    // Due before anything else, so the pass meets the run's whole room.
    const dedupeKey = `schedule_queue:by_hand:${Math.floor(now.getTime() / 60_000)}`;
    await env.DB.batch([enqueueTask(env.DB, { kind: 'schedule_queue', dedupeKey, now, runAfter: new Date(0), maxAttempts: 2 })]);
  }
  return runPrintCloudTasks(env, opts);
}

/** The periodic work, enqueued once per quarter hour (the dedupe key names the slot). */
export async function enqueuePeriodic(db: D1Database, now: Date): Promise<void> {
  if (!(await printCloudInstalled(db))) return;
  const slot = Math.floor(now.getTime() / (15 * 60 * 1000));
  const kinds: TaskKind[] = ['expire_orders', 'expire_credit_lots', 'low_inventory_scan', 'schedule_queue', 'slicing_lease_sweep'];
  const statements = kinds.map((kind) => enqueueTask(db, { kind, dedupeKey: `${kind}:${slot}`, now, maxAttempts: 2 }));
  // Reconciliation once a day.
  statements.push(enqueueTask(db, { kind: 'reconcile', dedupeKey: `reconcile:${Math.floor(now.getTime() / 86_400_000)}`, now, maxAttempts: 2 }));
  await db.batch(statements);
}

/** The periodic enqueue's statements: the schema probe and six inserts. */
const PERIODIC_STATEMENTS = 7;

/**
 * The cron step: enqueue the periodic work, then run a bounded number of due
 * tasks within `budget` statements of the invocation's counter `used`
 * (worker/index.ts passes `quarterHourPrintCloudBudget`, worker/lib/
 * quarterHourBudget.ts step 8). Nothing when not even the enqueue and one
 * task fit. Never throws.
 */
export async function printCloudTick(env: RunnerEnv, opts: { limit?: number; budget?: number; used?: () => number } = {}): Promise<RunReport | null> {
  try {
    const room = opts.used && opts.budget !== undefined ? roomWithin(opts.used, opts.budget) : undefined;
    if (room && !room(PERIODIC_STATEMENTS + PRINT_CLOUD_TASK_OVERHEAD + PRINT_CLOUD_UNIT_STATEMENTS)) return null;
    if (!(await printCloudInstalled(env.DB))) return null;
    await enqueuePeriodic(env.DB, new Date());
    return await runPrintCloudTasks(env, { limit: opts.limit ?? 8, room });
  } catch (e) {
    console.error('print cloud tick rejected:', e instanceof Error ? e.name : 'unknown');
    return null;
  }
}

export async function taskOverview(db: D1Database) {
  const counts = await many<{ kind: string; status: string; n: number }>(db, 'SELECT kind, status, COUNT(*) AS n FROM pc_background_jobs GROUP BY kind, status ORDER BY kind, status');
  const recentFailures = await many<Record<string, unknown>>(
    db,
    "SELECT id, kind, status, attempts, max_attempts, last_error, updated_at FROM pc_background_jobs WHERE status IN ('dead', 'queued') AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 50"
  );
  return { counts, recent_failures: recentFailures };
}
