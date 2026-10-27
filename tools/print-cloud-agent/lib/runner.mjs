/**
 * THE AGENT'S MAIN LOOP (docs/PRINT_CLOUD_AGENT.md §How it works).
 *
 * Every tick does what is due:
 *
 *   printers   GET /printers — which machines are bound to this token, under
 *              which `connection_ref`, and which cloud job each one holds
 *              (`current_job_id`: the scheduler's or an operator's assignment).
 *   telemetry  per bound printer with a local entry: the driver's status,
 *              sent with this run's `boot` and the next `seq`; `reported_at`
 *              when the reading was taken and `sent_at` when each attempt
 *              left, both from the agent's one clock. A reading that fails to
 *              send waits in a small outbox and goes first next time, in
 *              order, so a fault or a finish seen during a network outage
 *              still reaches the cloud.
 *   jobs       a job assigned to one of our printers is prepared in the
 *              background — its print file (this agent's own slice of it,
 *              checked against the job's current input, or a fresh slice of
 *              the files the cloud names), uploaded, started once the bed is
 *              known clear — and then WATCHED: the machine's own state drives
 *              `started`, `paused`, `resumed`, `completed`, `failed`, each
 *              reported once. Every event is written to the job's record
 *              with its `event_id` BEFORE it is sent, so a crash or a lost
 *              answer re-sends the same event and the cloud answers
 *              `already_applied`. A job handled here is never prepared twice.
 *   commands   operator commands (pause, resume, stop, light) for our
 *              printers, each executed once and never when stale.
 *   slicing    with a slicer configured: claim → download → slice → result
 *              or failure (slicers/index.mjs). Never a number the slicer
 *              did not write.
 *
 * Nothing here guesses on the cloud's behalf: an unreachable machine is
 * reported `offline`, a print the agent lost track of is reported failed
 * only after two looks (and the failure is the cloud's to judge), a job
 * whose print file cannot be made waits for an operator.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createDriver } from '../drivers/index.mjs';
import { DriverError, emptyStatus } from '../drivers/common.mjs';
import { screen3mf } from '../slicers/model3mf.mjs';
import { CloudError, tokenRejected } from './protocol.mjs';
import { silentLogger } from './log.mjs';

/** Phases of a job record that still need this agent. */
const ACTIVE = ['assigned', 'preparing_file', 'uploading', 'uploaded', 'starting', 'printing', 'paused', 'stalled'];
/** Before the machine has started it: the cloud may still take the job back. */
const PRE_START = ['assigned', 'preparing_file', 'uploading', 'uploaded', 'stalled'];
/** Phases the watcher drives from the machine's state. */
const WATCHED = ['uploaded', 'starting', 'printing', 'paused'];
const RUNNING = ['preparing', 'printing', 'paused'];
const ENDED = ['finished', 'cancelled', 'error'];
const MODEL_EXT = /\.(stl|3mf|obj)$/i;
const CLOUD_ID = /^[A-Za-z0-9_-]{1,120}$/;
const OUTBOX_MAX = 30;
const DAY_MS = 86_400_000;
/** How far behind the commands cursor every poll reads again: under the ten minutes handled ids are kept. */
const COMMAND_LOOKBACK_MS = 60_000;
/** A record whose watched print time moved is written at least this often (a crash loses at most this much). */
const PERSIST_MS = 60_000;

const iso = (ms) => new Date(ms).toISOString();
const intOrNull = (v, min, max) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null);
/** °C (a float) → the protocol's deci-degrees, or null when absent or outside the protocol's range. */
const deci = (c, min, max) => (typeof c === 'number' && Number.isFinite(c) ? intOrNull(Math.round(c * 10), min, max) : null);

/** The flag-file name `--bed-cleared <connection_ref>` writes: any ref, as a safe file name. */
export const bedFlagName = (ref) => Buffer.from(String(ref), 'utf8').toString('base64url');

/** The part of a job's input that decides what is printed: two equal projections slice to the same file. */
export function printProjection(input) {
  if (!input || typeof input !== 'object') return null;
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return JSON.stringify(
    canon({
      printer_model: input.printer_model?.code ?? null,
      settings: input.settings ?? null,
      copies: input.copies ?? 1,
      plate: input.plate ?? null,
      models: (input.models ?? []).map((m) => ({ file_id: m.file_id, quantity: m.quantity, transform: m.transform ?? {}, material_assignments: m.material_assignments ?? [] })),
      variants: (input.variants ?? []).map((v) => v.variant_id),
    })
  );
}

const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DriverError('UNREACHABLE', message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

export class Runner {
  /**
   * @param {{
   *   config: Record<string, any>,
   *   cloud: import('./protocol.mjs').CloudClient,
   *   state: import('./state.mjs').AgentState,
   *   log?: any,
   *   drivers?: Record<string, any>,
   *   driverDeps?: Record<string, any>,
   *   slicer?: { kind: string, label: string, slice: (p: any) => Promise<any> } | null,
   *   clock?: () => number,
   *   sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>,
   * }} deps
   */
  constructor(deps) {
    this.config = deps.config;
    this.cloud = deps.cloud;
    this.state = deps.state;
    this.log = deps.log ?? silentLogger;
    this.clock = deps.clock ?? (() => Date.now());
    this.sleep =
      deps.sleep ??
      ((ms, signal) =>
        new Promise((resolve) => {
          const t = setTimeout(resolve, ms);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              resolve(undefined);
            },
            { once: true }
          );
        }));
    this.slicer = deps.slicer ?? null;
    /** Driver instances by connection_ref: injected (tests) or built from the config on first use. */
    this.drivers = new Map(Object.entries(deps.drivers ?? {}));
    this.driverDeps = deps.driverDeps ?? {};
    /** @type {Map<string, any>} cloud printer id → runtime record */
    this.printers = new Map();
    /** @type {Map<string, any>} job id → persisted job record (active, or done with events still to send) */
    this.jobs = new Map();
    this.background = new Set();
    this.nextPrintersAt = 0;
    this.nextCommandsAt = 0;
    this.nextSlicingAt = 0;
    this.nextCleanupAt = 0;
    this.slicingBusy = false;
    this.disabled = { telemetry: false, job_control: false, slicer: false };
    this.fatal = null;
    this.stopping = false;
    this.warned = new Set();
    /** @type {Record<string, any>} printer id → what the agent knows about its bed (none: occupied, see readyToStart) */
    this.bed = this.readBedFile();
    this.commandsState = this.state.readJson('commands.json', null);
  }

  readBedFile() {
    try {
      return this.state.readJson('bed.json', {}) ?? {};
    } catch (e) {
      // Unreadable: nothing is known about any bed — and an unknown bed is an occupied one.
      this.log.error('bed.unreadable', { error: e, note: 'every printer waits for --bed-cleared before its next job' });
      return {};
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Load what the last run left, prove the token, learn the printers. */
  async start() {
    for (const name of this.state.list('jobs')) {
      if (!name.endsWith('.json')) continue;
      const rec = this.state.readJson(`jobs/${name}`);
      if (!rec) continue;
      const pending = (rec.events ?? []).some((e) => e.status === 'pending');
      if (rec.phase === 'stalled') {
        // A restart is the operator's way to say «try again».
        rec.phase = rec.print_file ? 'uploading' : 'assigned';
        rec.start_attempts = 0;
        rec.stall_reason = null;
      }
      if (ACTIVE.includes(rec.phase) || pending) this.jobs.set(rec.job_id, rec);
    }
    // A crash mid-slice leaves a work directory; its lease lapses and the cloud requeues the request.
    for (const name of this.state.list('work')) this.state.remove(`work/${name}`);
    if (this.slicer && this.config.slicer?.cli_path && !existsSync(this.config.slicer.cli_path)) {
      this.log.error('slicer.cli_missing', { cli_path: this.config.slicer.cli_path, note: 'slicing disabled: no request is claimed until the slicer is installed' });
      this.disabled.slicer = true;
    }
    await this.refreshPrinters();
    this.log.info('agent.started', { boot: this.state.boot, printers: this.printers.size, resumed_jobs: this.jobs.size, slicer: this.slicer && !this.disabled.slicer ? this.slicer.kind : null });
  }

  /** The loop, until `signal` aborts or the cloud refuses the token. */
  async run(signal) {
    while (!signal?.aborted && !this.fatal) {
      await this.tick();
      if (signal?.aborted || this.fatal) break;
      await this.sleep(this.config.intervals.tick_ms, signal);
    }
    await this.stop();
    if (this.fatal) throw this.fatal;
  }

  /** Graceful stop: no new work, in-flight work given a moment, pending events tried once, drivers closed. */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    const bounded = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref?.())]);
    if (this.background.size) await bounded(Promise.allSettled([...this.background]), 10_000);
    // What was watched of a running print is kept: the next run counts on from it (only the downtime is unseen).
    for (const rec of this.jobs.values()) if (ACTIVE.includes(rec.phase)) this.saveJob(rec);
    if (!this.fatal) await bounded(this.flushEvents().catch((e) => this.log.warn('agent.stop.flush_failed', { error: e })), 5_000);
    for (const d of this.drivers.values()) await Promise.resolve(d.close?.()).catch(() => undefined);
    this.log.info('agent.stopped', { boot: this.state.boot });
  }

  /** Wait for every background task (tests; shutdown). */
  async settle() {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  spawn(label, fn) {
    const p = (async () => {
      try {
        await fn();
      } catch (e) {
        this.noteFatal(e);
        this.log.error(`${label}.failed`, { error: e });
      }
    })();
    this.background.add(p);
    p.finally(() => this.background.delete(p));
    return p;
  }

  /** A 401 anywhere means the token was revoked or is wrong: nothing else can work. */
  noteFatal(e) {
    if (tokenRejected(e) && !this.fatal) {
      this.fatal = e;
      this.log.error('cloud.token_rejected', { note: 'the cloud refused the agent token (revoked or wrong): stopping' });
    }
  }

  warnOnce(key, msg, fields) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn(msg, fields);
  }

  /**
   * A driver call made inside the loop, bounded by the printer's own timeout
   * plus slack: no single machine — a host that never answers, a driver that
   * hangs — may hold telemetry, events and commands for every printer.
   */
  bounded(p, call, what) {
    return withTimeout(
      Promise.resolve().then(call),
      (p.settings?.timeout_seconds ?? 10) * 1000 + 2000,
      `${what} timed out`
    );
  }

  /** One pass of everything that is due. */
  async tick() {
    if (this.stopping || this.fatal) return;
    const step = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        this.noteFatal(e);
        this.log.error(`${name}.failed`, { error: e });
      }
    };
    await step('bed', () => this.consumeBedFlags());
    if (this.clock() >= this.nextPrintersAt) await step('printers', () => this.refreshPrinters());
    if (this.fatal) return;
    const due = [...this.printers.values()].filter((p) => p.driver && this.clock() >= p.nextTelemetryAt);
    await Promise.all(due.map((p) => step('telemetry', () => this.observe(p))));
    for (const p of this.printers.values()) await step('jobs', () => this.maybePrepare(p));
    await step('events', () => this.flushEvents());
    if (this.clock() >= this.nextCommandsAt) await step('commands', () => this.pollCommands());
    if (this.clock() >= this.nextSlicingAt) await step('slicing', () => this.slicingTick());
    if (this.clock() >= this.nextCleanupAt) await step('cleanup', () => this.cleanup());
  }

  // ------------------------------------------------------------------ printers

  driverFor(ref) {
    if (this.drivers.has(ref)) return this.drivers.get(ref);
    const entry = this.config.printers?.[ref];
    if (!entry) return null;
    const d = createDriver(entry, { ...this.driverDeps, clock: this.clock, log: this.log.child({ printer_ref: ref }) });
    this.drivers.set(ref, d);
    Promise.resolve(d.connect?.()).catch(() => undefined);
    return d;
  }

  async refreshPrinters() {
    const rows = await this.cloud.printers();
    this.nextPrintersAt = this.clock() + this.config.intervals.printers_ms;
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.id);
      let p = this.printers.get(row.id);
      if (!p) {
        p = { id: row.id, ref: undefined, outbox: [], nextTelemetryAt: 0, supersededStreak: 0, regressionWarned: false, lastStatus: null, lastSeenState: null, lostStreak: 0, task: null };
        this.printers.set(row.id, p);
      }
      p.name = row.name;
      p.model_code = row.model_code;
      p.current_job_id = row.current_job_id ?? null;
      if (p.ref !== (row.connection_ref ?? null)) {
        p.ref = row.connection_ref ?? null;
        p.driver = p.ref ? this.driverFor(p.ref) : null;
        p.settings = p.ref ? (this.config.printers?.[p.ref] ?? {}) : {};
        if (!p.driver) {
          // Honest silence: a printer this agent cannot drive sends no telemetry, so the cloud shows it never connected.
          this.warnOnce(`noref:${row.id}:${p.ref}`, 'printer.not_configured', { printer_id: row.id, name: row.name, connection_ref: p.ref, note: 'no entry for this connection_ref in the local configuration: no telemetry is sent for it' });
        }
      }
    }
    for (const id of [...this.printers.keys()]) if (!seen.has(id)) this.printers.delete(id);
    return rows;
  }

  saveBed() {
    this.state.writeJson('bed.json', this.bed);
  }

  /**
   * `node agent.mjs --bed-cleared <connection_ref>` leaves a flag file; the
   * running agent takes it here. A clearance is used EXACTLY ONCE: the flag
   * goes first, and one this process cannot remove (bed-cleared/ made by
   * another user — `sudo … --bed-cleared`) clears nothing: applied, it would
   * clear every later print too. And it clears only a bed the machine is not
   * printing on, as the machine shows it NOW: one given while a print still
   * runs, or while the machine cannot be reached, is refused and said so —
   * that print will end on the plate.
   */
  async consumeBedFlags() {
    for (const name of this.state.list('bed-cleared')) {
      const p = [...this.printers.values()].find((x) => x.ref !== null && x.ref !== undefined && bedFlagName(x.ref) === name);
      if (!p) continue;
      try {
        this.state.remove(`bed-cleared/${name}`);
      } catch (e) {
        this.warnOnce(`bedflag:${name}`, 'bed.flag_not_removable', {
          printer_id: p.id,
          connection_ref: p.ref,
          error: e,
          note: "the bed was NOT marked clear: give bed-cleared/ back to the agent's user (or run --bed-cleared as that user), then run it again",
        });
        continue;
      }
      this.warned.delete(`bedflag:${name}`);
      const st = p.driver ? await this.bounded(p, () => p.driver.status(), 'status').catch(() => null) : null;
      if (!st || st.state === 'offline' || RUNNING.includes(st.state)) {
        this.log.warn('bed.clear_refused', {
          printer_id: p.id,
          connection_ref: p.ref,
          machine_state: st?.state ?? 'unreachable',
          note: 'a bed is marked clear only while its machine is reachable and not printing: run --bed-cleared again once the print has ended and the plate is clear',
        });
        continue;
      }
      this.bed[p.id] = { occupied: false, cleared_at: iso(this.clock()), cleared_file: ENDED.includes(st.state) ? st.file : null, used_by: null };
      this.saveBed();
      // A job waiting on this bed goes now, not at its next look.
      const waiting = this.activeJob(p);
      if (waiting) waiting.wait_until = null;
      this.log.info('bed.cleared', { printer_id: p.id, connection_ref: p.ref, machine_state: st.state });
    }
  }

  bedPolicy(p) {
    return p.settings?.bed_clear ?? this.config.jobs.bed_clear;
  }

  /**
   * A print that ended leaves its plate on the bed until an operator says
   * otherwise. `previous` is the last state actually SEEN (an offline gap in
   * between does not hide a print that ended meanwhile); on the first look of
   * a run an ended print is a plate on the bed unless an operator cleared it
   * after exactly that print and nothing started since.
   */
  trackBed(p, previous, st) {
    if (!ENDED.includes(st.state)) return;
    const known = this.bed[p.id];
    const mark = (reason) => {
      this.bed[p.id] = { occupied: true, since: iso(this.clock()), reason };
      this.saveBed();
    };
    if (previous === null) {
      const stillCleared = known && known.occupied === false && !known.used_by && known.cleared_file === st.file;
      if (!stillCleared && known?.occupied !== true) mark('found_after_a_print');
    } else if (RUNNING.includes(previous)) mark(st.state);
  }

  /**
   * Can this job's print start on this machine now? The machine idle, or
   * showing an ended print — and, with `bed_clear: operator`, its bed KNOWN to
   * be clear: an operator cleared it (--bed-cleared) and nothing has started
   * on it since. Anything else is a plate on the bed: a print that ended, one
   * that vanished (a reboot, a power cut: the machine back idle with half a
   * part on it), one another job started — and a bed the agent knows nothing
   * about (a new agent, a lost bed.json). The one exception is this very
   * job's own start that did not take (the machine never showed its file
   * running): it may be sent again.
   */
  readyToStart(p, st, rec) {
    if (st.state !== 'idle' && st.state !== 'finished' && st.state !== 'cancelled') return { ok: false, reason: `machine_${st.state}` };
    if (this.bedPolicy(p) === 'assume_clear') return { ok: true };
    const bed = this.bed[p.id];
    if (bed && bed.occupied === false && !bed.used_by) return { ok: true };
    if (bed && bed.reason === 'print_started' && bed.used_by === rec.job_id) return { ok: true };
    return { ok: false, reason: 'waiting_for_bed_clear' };
  }

  /** From the start command on, the bed is this job's: whatever happens to the print, the next one waits for a clearance. */
  bedInUse(p, rec) {
    this.bed[p.id] = { occupied: true, reason: 'print_started', used_by: rec.job_id, since: iso(this.clock()) };
    this.saveBed();
  }

  // ------------------------------------------------------------------ telemetry and the job watcher

  async observe(p) {
    p.nextTelemetryAt = this.clock() + this.config.intervals.telemetry_ms;
    let st;
    try {
      st = await withTimeout(Promise.resolve(p.driver.status()), (p.settings?.timeout_seconds ?? 10) * 1000 + 2000, 'status timed out');
      if (p.unreachable) this.log.info('printer.reachable', { printer_id: p.id });
      p.unreachable = false;
    } catch (e) {
      if (!p.unreachable) this.log.warn('printer.unreachable', { printer_id: p.id, connection_ref: p.ref, error: e });
      p.unreachable = true;
      st = emptyStatus('offline');
    }
    const takenAt = this.clock();
    const previous = p.lastSeenState;
    p.lastStatus = st;
    p.lastStatusAt = takenAt;
    if (st.state !== 'offline') {
      this.trackBed(p, previous, st);
      p.lastSeenState = st.state;
    }
    this.watch(p, st, takenAt);
    if (this.disabled.telemetry) return;
    p.outbox.push(this.reading(p, st, takenAt));
    this.trimOutbox(p);
    await this.flushTelemetry(p);
  }

  /** The record of the job this printer is working on for the cloud, if any. */
  activeJob(p) {
    for (const rec of this.jobs.values()) if (rec.printer_id === p.id && ACTIVE.includes(rec.phase)) return rec;
    return null;
  }

  /** Is the machine working on THIS job's file? (the agent names every print file after its job) */
  ours(rec, st) {
    return !!(rec && st?.file && st.file.includes(rec.job_id));
  }

  reading(p, st, takenAt) {
    const rec = this.activeJob(p);
    const machineState = st.state === 'cancelled' ? 'idle' : st.state;
    const cam = st.camera ?? { available: false };
    return {
      machine_state: machineState,
      boot: this.state.boot,
      seq: this.state.nextSeq(),
      job_id: rec && WATCHED.includes(rec.phase) && this.ours(rec, st) && machineState !== 'idle' ? rec.job_id : null,
      progress_permille: intOrNull(st.progress_permille, 0, 1000),
      layer: intOrNull(st.layer, 0, 1_000_000),
      total_layers: intOrNull(st.total_layers, 0, 1_000_000),
      remaining_seconds: intOrNull(st.remaining_seconds, 0, 60 * 24 * 3600),
      nozzle_temp_dc: deci(st.nozzle_c, -500, 6000),
      bed_temp_dc: deci(st.bed_c, -500, 3000),
      chamber_temp_dc: deci(st.chamber_c, -500, 2000),
      errors: (st.errors ?? []).slice(0, 10).map((e) => ({ code: String(e.code || 'UNKNOWN').slice(0, 60), message: String(e.message ?? '').slice(0, 200) })),
      camera: {
        available: cam.available === true,
        ...(cam.available === true && p.settings?.camera_stream_id ? { stream_id: p.settings.camera_stream_id } : {}),
        ...(typeof cam.resolution === 'string' && cam.resolution ? { resolution: cam.resolution.slice(0, 20) } : {}),
      },
      reported_at: iso(takenAt),
    };
  }

  /** On overflow drop the oldest reading that only repeats its successor's state — state changes and faults stay. */
  trimOutbox(p) {
    while (p.outbox.length > OUTBOX_MAX) {
      let i = p.outbox.findIndex((r, k) => k + 1 < p.outbox.length && r.machine_state === p.outbox[k + 1].machine_state && !r.errors.length);
      if (i < 0) i = 0;
      p.outbox.splice(i, 1);
    }
  }

  async flushTelemetry(p) {
    while (p.outbox.length && !this.disabled.telemetry) {
      const r = p.outbox[0];
      let answer;
      try {
        answer = await this.cloud.telemetry(p.id, () => ({ ...r, sent_at: iso(this.clock()) }));
      } catch (e) {
        if (e instanceof CloudError && !e.retryable) {
          this.noteFatal(e);
          if (e.status === 403) {
            this.disabled.telemetry = true;
            this.log.error('telemetry.forbidden', { note: 'the token has no telemetry capability: telemetry stopped' });
            p.outbox.length = 0;
            return;
          }
          if (e.status === 404 || e.status === 401) {
            // No longer bound to us (or no longer us at all): forget its readings and learn the new binding.
            p.outbox.length = 0;
            this.nextPrintersAt = 0;
            return;
          }
          this.log.error('telemetry.refused', { printer_id: p.id, seq: r.seq, code: e.code, details: e.details });
          p.outbox.shift();
          continue;
        }
        this.log.warn('telemetry.deferred', { printer_id: p.id, queued: p.outbox.length, error: e });
        return;
      }
      p.outbox.shift();
      if (answer?.superseded) {
        p.supersededStreak++;
        if (p.supersededStreak >= 3 && !p.regressionWarned) {
          p.regressionWarned = true;
          this.log.error('telemetry.boot_counter_behind', {
            printer_id: p.id,
            boot: this.state.boot,
            note: 'the cloud keeps answering superseded: it holds a newer reading than this boot (a restored or reset state directory). Re-bind the printer to a fresh agent token, or restore the newest state directory (docs: State).',
          });
        }
      } else {
        p.supersededStreak = 0;
        p.regressionWarned = false;
      }
    }
  }

  saveJob(rec) {
    rec.updated_at = iso(this.clock());
    this.state.writeJson(`jobs/${rec.job_id}.json`, rec);
  }

  /** Write an event into the job's record (persisted) before anything sends it. */
  queueEvent(rec, kind, extra = {}) {
    const event_id = `ev_${randomUUID().replace(/-/g, '')}`;
    rec.events.push({ kind, event_id, body: { event: kind, printer_id: rec.printer_id, event_id, ...extra }, status: 'pending', queued_at: iso(this.clock()) });
    this.saveJob(rec);
    this.log.info('job.event_queued', { job_id: rec.job_id, event: kind, event_id });
  }

  /** Print time: the machine's own count when it keeps one, else what the agent saw (countPrinting). */
  printedSeconds(rec, st) {
    const s = typeof st?.elapsed_seconds === 'number' && st.elapsed_seconds >= 0 ? st.elapsed_seconds : (rec.printing_ms ?? 0) / 1000;
    return Math.min(60 * 24 * 3600, Math.round(s));
  }

  /**
   * printed_seconds — what the customer is billed — for a machine that keeps
   * no print clock of its own (Bambu): the time the agent SAW this job's print
   * running, and nothing it did not see. The gap between two looks counts
   * only when both are looks of THIS run of the agent (a downtime was not
   * seen), the earlier one saw this job's own print running after its
   * `started`, and the later one still sees it running or came within two
   * telemetry intervals — when a print ended or paused inside a longer gap is
   * unknown, so that gap is left out. A look that could not reach the machine
   * breaks the chain the same way.
   */
  countPrinting(rec, st, ours, now) {
    if (rec.phase !== 'printing' || rec.last_obs_state !== 'printing' || rec.last_obs_ours !== true || rec.last_obs_boot !== this.state.boot || !rec.last_obs_at) return;
    const gap = Math.max(0, now - Date.parse(rec.last_obs_at));
    const close = gap <= 2 * Math.max(this.config.intervals.telemetry_ms, this.config.intervals.tick_ms);
    if (close || (st.state === 'printing' && ours)) rec.printing_ms = (rec.printing_ms ?? 0) + gap;
  }

  /**
   * The machine's state against the job record: each transition becomes ONE
   * event. A record a background task is still preparing is left alone.
   */
  watch(p, st, now) {
    const rec = this.activeJob(p);
    if (!rec || p.task || !WATCHED.includes(rec.phase)) return;
    if (st.state === 'offline') {
      // Unreachable: a gap in what was seen — no time across it is counted as printing.
      rec.last_obs_state = 'offline';
      rec.last_obs_at = iso(now);
      rec.last_obs_ours = false;
      return;
    }
    const ours = this.ours(rec, st);
    // Ours as far as the machine says: it names this job's file — or none at all while our record prints (as the pause branch reads it).
    const mine = ours || (!st.file && (rec.phase === 'printing' || rec.phase === 'paused'));
    this.countPrinting(rec, st, mine, now);
    const changed = rec.last_obs_state !== st.state;
    rec.last_obs_state = st.state;
    rec.last_obs_at = iso(now);
    rec.last_obs_ours = mine;
    rec.last_obs_boot = this.state.boot;
    // The machine forgot the print (a reboot) or runs another file: only said after two looks.
    const lost = st.state === 'idle' || (!!st.file && !ours && [...RUNNING, 'finished'].includes(st.state));
    p.lostStreak = lost ? (p.lostStreak ?? 0) + 1 : 0;
    const done = (reason) => {
      rec.phase = 'done';
      rec.done_reason = reason;
    };
    const failed = (reason) => {
      const reason_code = (rec.stop_requested ? 'stopped_by_operator' : reason === 'error' ? st.errors?.[0]?.code || 'machine_error' : reason).slice(0, 60);
      this.queueEvent(rec, 'failed', {
        reason_code,
        description: `machine state ${st.state}${st.errors?.length ? `: ${st.errors.map((e) => e.code).join(', ')}` : ''}`.slice(0, 2000),
        printed_seconds: this.printedSeconds(rec, st),
      });
      done(`failed:${reason_code}`);
      // A print that ended in failure — cancelled, faulted, or forgotten by a machine back idle after a reboot or a
      // power cut — left what it made on the plate: the next print waits for an operator's --bed-cleared.
      this.bed[p.id] = { occupied: true, since: iso(now), reason: `failed:${reason_code}` };
      this.saveBed();
    };
    if (rec.phase === 'uploaded' || rec.phase === 'starting') {
      if (ours && (RUNNING.includes(st.state) || st.state === 'finished')) {
        rec.started_obs_at = iso(now);
        this.queueEvent(rec, 'started');
        rec.phase = 'printing';
        if (st.state === 'paused') {
          this.queueEvent(rec, 'paused', { reason: 'machine' });
          rec.phase = 'paused';
        } else if (st.state === 'finished') {
          this.queueEvent(rec, 'completed', { printed_seconds: this.printedSeconds(rec, st) });
          done('completed');
        }
      } else if (rec.phase === 'starting' && now - Date.parse(rec.last_start_at) > this.config.jobs.start_timeout_ms) {
        // The start command did not take: try again, or hand the job to an operator.
        const give_up = (rec.start_attempts ?? 0) >= this.config.jobs.max_start_attempts;
        rec.phase = give_up ? 'stalled' : 'uploaded';
        rec.retry_start = !give_up;
        rec.stall_reason = give_up ? 'machine_did_not_start' : null;
        this.log.warn('job.start_not_seen', { job_id: rec.job_id, printer_id: p.id, attempts: rec.start_attempts, machine_state: st.state, file: st.file, gave_up: give_up });
      }
    } else if (st.state === 'paused' && rec.phase === 'printing' && (ours || !st.file)) {
      this.queueEvent(rec, 'paused', { reason: rec.pause_reason ?? 'machine' });
      rec.pause_reason = null;
      rec.phase = 'paused';
    } else if (st.state === 'printing' && rec.phase === 'paused' && ours) {
      this.queueEvent(rec, 'resumed');
      rec.phase = 'printing';
    } else if (st.state === 'finished' && (ours || !st.file)) {
      // The cloud completes only a PRINTING job. A pause that ended out of sight (resumed at the printer while the
      // machine or this agent was away — the record still says paused), or one set in the console alone while the
      // machine kept printing, is closed first; `resumed` is applied once by its event_id and answers
      // already_applied when the cloud already shows the job printing. The completion then reaches it exactly once.
      this.queueEvent(rec, 'resumed');
      this.queueEvent(rec, 'completed', { printed_seconds: this.printedSeconds(rec, st) });
      done('completed');
    } else if (st.state === 'cancelled') failed('print_cancelled');
    else if (st.state === 'error') failed('error');
    else if (lost && p.lostStreak >= 2) failed(st.state === 'idle' ? 'print_lost_machine_idle' : 'print_replaced_on_machine');
    // The watched print time is written once a minute too, so a crash loses at most that much of it.
    const persistDue = rec.phase === 'printing' && !(Date.parse(rec.updated_at ?? '') > now - PERSIST_MS);
    if (changed || persistDue || rec.phase === 'done' || rec.phase === 'stalled') this.saveJob(rec);
  }

  // ------------------------------------------------------------------ preparing and starting a job

  launch(p, rec) {
    p.task = this.spawn('job.prepare', () => this.prepare(p, rec)).finally(() => {
      p.task = null;
    });
  }

  maybePrepare(p) {
    if (this.stopping || p.task || !p.driver || this.disabled.job_control) return;
    const rec = this.activeJob(p);
    const jobId = p.current_job_id;
    if (rec && rec.job_id !== jobId && PRE_START.includes(rec.phase)) {
      // The cloud took the job off this printer before it started.
      rec.phase = 'abandoned';
      rec.done_reason = 'unassigned_before_start';
      this.saveJob(rec);
      this.jobs.delete(rec.job_id);
      this.log.info('job.abandoned', { job_id: rec.job_id, printer_id: p.id, reason: rec.done_reason });
      return;
    }
    if (!jobId) return;
    if (rec && rec.job_id === jobId) {
      // A job waiting for its machine is looked at again once per telemetry interval, not every tick.
      if (rec.wait_until && Date.parse(rec.wait_until) > this.clock()) return;
      const auto = this.config.jobs.start_mode === 'auto';
      if (['assigned', 'preparing_file', 'uploading'].includes(rec.phase) || (rec.phase === 'uploaded' && (auto || rec.retry_start))) this.launch(p, rec);
      return;
    }
    if (rec) return; // another of our prints still runs here: one at a time
    if (this.jobs.has(jobId)) return;
    if (!CLOUD_ID.test(jobId)) {
      this.warnOnce(`badid:${jobId}`, 'job.invalid_id', { printer_id: p.id, job_id: String(jobId).slice(0, 140) });
      return;
    }
    const old = this.state.readJson(`jobs/${jobId}.json`, null);
    if (old) {
      const startedHere = (old.events ?? []).some((e) => e.kind === 'started' && e.status === 'acked');
      if (old.phase === 'done' || startedHere) {
        // Printed (or failed) here already: the cloud is waiting on an operator, not on another print.
        this.warnOnce(`handled:${jobId}`, 'job.already_handled', { job_id: jobId, printer_id: p.id, phase: old.phase, reason: old.done_reason ?? null });
        return;
      }
      // Taken back before it started, and assigned here again: prepare it again (its print file is kept), and watch
      // it from nothing — no print time is carried over from a machine it never ran on here.
      Object.assign(old, {
        printer_id: p.id,
        connection_ref: p.ref,
        phase: old.print_file ? 'uploading' : 'assigned',
        start_attempts: 0,
        retry_start: false,
        done_reason: null,
        printing_ms: 0,
        last_obs_state: null,
        last_obs_at: null,
        last_obs_ours: null,
        last_obs_boot: null,
      });
      this.jobs.set(jobId, old);
      this.saveJob(old);
      this.log.info('job.assigned_again', { job_id: jobId, printer_id: p.id });
      this.launch(p, old);
      return;
    }
    const fresh = { job_id: jobId, printer_id: p.id, connection_ref: p.ref, phase: 'assigned', print_file: null, input: null, start_attempts: 0, events: [], printing_ms: 0, created_at: iso(this.clock()) };
    this.jobs.set(jobId, fresh);
    this.saveJob(fresh);
    this.log.info('job.assigned', { job_id: jobId, printer_id: p.id, connection_ref: p.ref });
    this.launch(p, fresh);
  }

  async prepare(p, rec) {
    const machine = async () => {
      try {
        return await p.driver.status();
      } catch (e) {
        this.warnOnce(`prep-unreachable:${rec.job_id}`, 'job.printer_unreachable', { job_id: rec.job_id, printer_id: p.id, error: e });
        return null;
      }
    };
    // 1. The machine first: already running our file (a restart after the start command)? Then the watcher takes it.
    let st = await machine();
    if (!st) return;
    if (RUNNING.includes(st.state) && this.ours(rec, st)) {
      rec.phase = 'starting';
      rec.last_start_at = rec.last_start_at ?? iso(this.clock());
      this.saveJob(rec);
      this.bedInUse(p, rec);
      return;
    }
    // 2. The print file (slicing can take minutes: the machine is looked at again after it).
    if (!rec.print_file) {
      rec.phase = 'preparing_file';
      this.saveJob(rec);
      const file = await this.printFileFor(p, rec);
      if (!file) return;
      rec.print_file = file.print_file;
      rec.input = file.input;
      rec.phase = 'uploading';
      this.saveJob(rec);
      st = await machine();
      if (!st) return;
    }
    // 3. The machine must be free and its bed clear before anything is put on it.
    const ready = this.readyToStart(p, st, rec);
    rec.wait_until = ready.ok ? null : iso(this.clock() + this.config.intervals.telemetry_ms);
    if (!ready.ok) {
      this.warnOnce(`wait:${rec.job_id}:${ready.reason}`, 'job.waiting', {
        job_id: rec.job_id,
        printer_id: p.id,
        reason: ready.reason,
        ...(ready.reason === 'waiting_for_bed_clear' ? { note: `clear the bed, then run: node tools/print-cloud-agent/agent.mjs --config <file> --bed-cleared ${p.ref}` } : {}),
      });
      return;
    }
    // 4. Upload.
    if (rec.phase === 'uploading') {
      await p.driver.upload({ name: rec.print_file.name, path: rec.print_file.path });
      rec.phase = 'uploaded';
      this.saveJob(rec);
      this.log.info('job.uploaded', { job_id: rec.job_id, printer_id: p.id, file: rec.print_file.name });
    }
    if (this.config.jobs.start_mode === 'manual' && !rec.retry_start) {
      this.warnOnce(`manual:${rec.job_id}`, 'job.ready_to_start', { job_id: rec.job_id, printer_id: p.id, file: rec.print_file.name, note: 'start_mode is manual: start this file on the machine' });
      return;
    }
    // 5. Still ours? An operator may have taken the job back while the file travelled.
    const row = (await this.cloud.printers()).find((r) => r.id === p.id);
    if (!row || row.current_job_id !== rec.job_id) {
      rec.phase = 'abandoned';
      rec.done_reason = 'unassigned_before_start';
      this.saveJob(rec);
      this.jobs.delete(rec.job_id);
      this.log.info('job.abandoned', { job_id: rec.job_id, printer_id: p.id, reason: rec.done_reason });
      return;
    }
    // …and not started already? Only a job the cloud holds in `preparing` is started: one it shows printing or
    // paused was started before (by an earlier run of this agent whose state was lost, or by an operator).
    let cloudJob;
    try {
      cloudJob = await this.cloud.job(rec.job_id);
    } catch (e) {
      if (!this.jobDoorRefused(p, rec, e)) throw e;
      return;
    }
    if (this.startedElsewhere(p, rec, cloudJob)) return;
    // 6. Start — the slice's filament i is the job's variant filaments[i] (the order the materials were mapped in).
    rec.start_attempts = (rec.start_attempts ?? 0) + 1;
    rec.last_start_at = iso(this.clock());
    rec.retry_start = false;
    const byId = new Map((rec.input?.variants ?? []).map((v) => [v.variant_id, v]));
    const ordered = (rec.print_file.filaments ?? []).map((id) => byId.get(id)).filter(Boolean);
    const job = rec.input ? { ...rec.input, variants: ordered.length ? ordered : rec.input.variants } : null;
    try {
      await p.driver.start({ name: rec.print_file.name, job });
    } catch (e) {
      const give_up = rec.start_attempts >= this.config.jobs.max_start_attempts;
      rec.phase = give_up ? 'stalled' : 'uploaded';
      rec.retry_start = !give_up;
      rec.stall_reason = give_up ? 'start_refused' : null;
      this.saveJob(rec);
      this.log.error('job.start_refused', { job_id: rec.job_id, printer_id: p.id, attempt: rec.start_attempts, gave_up: give_up, error: e });
      return;
    }
    rec.phase = 'starting';
    // The clearance is spent: from now on the bed is this job's, and the next print needs it cleared again — however
    // this one ends, even if it vanishes without an end the machine shows (a reboot, a power cut).
    this.bedInUse(p, rec);
    this.saveJob(rec);
    this.log.info('job.start_sent', { job_id: rec.job_id, printer_id: p.id, file: rec.print_file.name, attempt: rec.start_attempts });
  }

  /**
   * Only a job the cloud holds in `preparing` is started. One it shows printing
   * or paused was started before — by an earlier run of this agent whose state
   * was lost, or by an operator — and is never started again here (stalled for
   * an operator). True when it stalled the job.
   */
  startedElsewhere(p, rec, cloudJob) {
    if (!cloudJob || cloudJob.status === 'preparing') return false;
    rec.phase = 'stalled';
    rec.stall_reason = `cloud_job_${cloudJob.status}`;
    this.saveJob(rec);
    this.warnOnce(`notprep:${rec.job_id}`, 'job.not_started', { job_id: rec.job_id, printer_id: p.id, cloud_status: cloudJob.status, note: 'the cloud says this job already started: not starting it again; an operator decides' });
    return true;
  }

  /**
   * The job door ANSWERED a refusal (409 INCOMPATIBLE_PRINTER, a 400, a 403…)
   * — not an outage, not the token itself: asking again every tick cannot
   * change it, it only spends the workshop's shared rate limit. The job is left
   * `stalled` for an operator (a restart tries again); a 403 means the token
   * has no job_control, so no job is prepared or started at all. True when it
   * handled `e`; false for an error the caller must rethrow.
   */
  jobDoorRefused(p, rec, e) {
    if (!(e instanceof CloudError) || e.retryable || tokenRejected(e)) return false;
    if (e.status === 403 && !this.disabled.job_control) {
      this.disabled.job_control = true;
      this.log.error('job_control.forbidden', { note: 'the token has no job_control capability: no job is prepared or started' });
    }
    rec.phase = 'stalled';
    rec.stall_reason = `job_door_${e.code ?? e.status}`.slice(0, 60);
    this.saveJob(rec);
    this.warnOnce(`door:${rec.job_id}:${rec.stall_reason}`, 'job.input_refused', {
      job_id: rec.job_id,
      printer_id: p.id,
      status: e.status,
      code: e.code,
      details: e.details,
      note: 'the cloud refused to state what this job prints: an operator decides (restart the agent to try again)',
    });
    return true;
  }

  /**
   * What to print for this job: this agent's own slice when it matches the
   * job's input as the cloud states it now, else a fresh slice of the files
   * the cloud names. Null (logged once, the job stalled) when neither is possible.
   */
  async printFileFor(p, rec) {
    const cached = this.state.readJson(`prints/${rec.job_id}/manifest.json`, null);
    let job = null;
    try {
      job = await this.cloud.job(rec.job_id);
    } catch (e) {
      if (!this.jobDoorRefused(p, rec, e)) throw e;
      return null;
    }
    if (this.startedElsewhere(p, rec, job)) return null;
    const stall = (reason, fields) => {
      this.warnOnce(`stall:${rec.job_id}:${reason}`, 'job.print_file_unavailable', { job_id: rec.job_id, printer_id: p.id, reason, ...fields });
      rec.phase = 'stalled';
      rec.stall_reason = reason;
      this.saveJob(rec);
      return null;
    };
    const cachedPath = cached ? join(this.state.dir, 'prints', rec.job_id, cached.name) : null;
    if (cached && cachedPath && existsSync(cachedPath) && (!job || printProjection(job.input) === printProjection(cached.input))) {
      if (!job) this.warnOnce(`unverified:${rec.job_id}`, 'job.cache_unverified', { job_id: rec.job_id, note: "the cloud did not state the job's input: printing this agent's own slice of it" });
      return { print_file: { name: cached.name, path: cachedPath, format: cached.format, sha256: cached.sha256, filaments: cached.filaments ?? null }, input: cached.input };
    }
    if (!job) return stall('no_print_input', { note: 'no slice of this job here and the cloud names no input for it: an operator must start it' });
    if (!this.slicer || this.disabled.slicer) return stall('no_slicer', { note: 'no slicer configured on this agent to make the print file' });
    const sliced = await this.sliceToCache(job.input, job.files, `print-${rec.job_id}`, null);
    if (!sliced.ok) return stall(`slice_failed:${sliced.error_code}`, { detail: sliced.detail });
    return { print_file: sliced.print_file, input: job.input };
  }

  // ------------------------------------------------------------------ events

  async flushEvents() {
    if (this.disabled.job_control) return;
    for (const rec of [...this.jobs.values()]) {
      for (const ev of (rec.events ?? []).filter((e) => e.status === 'pending')) {
        let answer;
        try {
          answer = await this.cloud.jobEvent(rec.job_id, ev.body);
        } catch (e) {
          if (e instanceof CloudError && !e.retryable) {
            this.noteFatal(e);
            if (tokenRejected(e)) return;
            if (e.status === 403) {
              this.disabled.job_control = true;
              this.log.error('job_control.forbidden', { note: 'the token has no job_control capability: job events stopped' });
              return;
            }
            ev.status = 'refused';
            ev.error = { status: e.status, code: e.code, details: e.details };
            this.saveJob(rec);
            this.log.error('job.event_refused', { job_id: rec.job_id, event: ev.kind, event_id: ev.event_id, status: e.status, code: e.code, details: e.details });
            if (ev.kind === 'started' && (e.status === 404 || e.code === 'INVALID_TRANSITION')) await this.startRefused(rec);
            continue;
          }
          this.log.warn('job.event_deferred', { job_id: rec.job_id, event: ev.kind, event_id: ev.event_id, error: e });
          break; // this job's events stay in order
        }
        ev.status = 'acked';
        ev.answer = { http: answer.status, already_applied: answer.data?.already_applied === true, status: answer.data?.status ?? null };
        this.saveJob(rec);
        this.log.info('job.event_sent', { job_id: rec.job_id, event: ev.kind, event_id: ev.event_id, http: answer.status, already_applied: answer.data?.already_applied === true, cloud_status: answer.data?.status ?? null });
      }
      if (!ACTIVE.includes(rec.phase) && !(rec.events ?? []).some((e) => e.status === 'pending')) {
        this.jobs.delete(rec.job_id);
        this.saveJob(rec);
        this.log.info('job.closed', { job_id: rec.job_id, reason: rec.done_reason ?? rec.phase });
      }
    }
  }

  /**
   * The cloud refused `started`: the job is not this printer's any more
   * (taken back while the file travelled). If the machine is running OUR
   * file for it, that print belongs to no job — stop it, and say so.
   */
  async startRefused(rec) {
    const p = this.printers.get(rec.printer_id);
    const st = p?.driver ? await this.bounded(p, () => p.driver.status(), 'status').catch(() => null) : null;
    if (p && st && RUNNING.includes(st.state) && this.ours(rec, st)) {
      await this.bounded(p, () => p.driver.cancel(), 'cancel').catch((e) => this.log.error('job.cancel_failed', { job_id: rec.job_id, error: e }));
      this.log.warn('job.print_cancelled_not_assigned', { job_id: rec.job_id, printer_id: rec.printer_id });
    }
    // Pending events after `started` (paused, completed…) describe a print the cloud never had.
    for (const ev of rec.events ?? []) if (ev.status === 'pending') ev.status = 'dropped';
    rec.phase = 'abandoned';
    rec.done_reason = 'start_refused_by_cloud';
    this.saveJob(rec);
  }

  // ------------------------------------------------------------------ operator commands

  async pollCommands() {
    this.nextCommandsAt = this.clock() + this.config.intervals.commands_ms;
    if (!this.commandsState) {
      // First run: what was queued before this agent existed is history, not an instruction. Its ids are
      // remembered too — the look-back below would otherwise read the last of them again.
      let since = null;
      let skipped = 0;
      const handled = {};
      for (let page = 0; page < 100; page++) {
        const { commands } = await this.cloud.commands(since);
        skipped += commands.length;
        for (const c of commands) handled[c.id] = c.created_at;
        if (commands.length) since = commands[commands.length - 1].created_at;
        if (commands.length < 100) break;
      }
      const floor = since ? Date.parse(since) - 10 * 60_000 : 0;
      for (const [id, at] of Object.entries(handled)) if (Date.parse(String(at)) < floor) delete handled[id];
      this.commandsState = { cursor: since, handled };
      this.state.writeJson('commands.json', this.commandsState);
      if (skipped) this.log.info('commands.history_skipped', { count: skipped });
      return;
    }
    // A command is stamped when its request starts and committed round trips later, so one stamped earlier can
    // commit after one stamped later — after this agent has read past its stamp. So every poll reads a window behind
    // the cursor again; what was handled is known by its id (ids are kept ten minutes, longer than the window).
    let since = this.commandsState.cursor ? iso(Date.parse(this.commandsState.cursor) - COMMAND_LOOKBACK_MS) : null;
    for (let page = 0; page < 10; page++) {
      const { commands, serverNow } = await this.cloud.commands(since);
      for (const c of commands) {
        if (this.commandsState.handled[c.id]) continue;
        const outcome = await this.execute(c, serverNow);
        this.commandsState.handled[c.id] = c.created_at;
        if (!this.commandsState.cursor || c.created_at > this.commandsState.cursor) this.commandsState.cursor = c.created_at;
        this.state.writeJson('commands.json', this.commandsState);
        this.log.info('command.handled', { command_id: c.id, printer_id: c.printer_id, ...outcome });
      }
      if (commands.length < 100) break;
      // A full page, handled or not, is read on from its last stamp — one millisecond back for that stamp's siblings —
      // so a window holding a hundred handled commands cannot hide a newer one.
      since = iso(Date.parse(commands[commands.length - 1].created_at) - 1);
    }
    const floor = this.commandsState.cursor ? Date.parse(this.commandsState.cursor) - 10 * 60_000 : 0;
    for (const [id, at] of Object.entries(this.commandsState.handled)) if (Date.parse(String(at)) < floor) delete this.commandsState.handled[id];
  }

  async execute(c, serverNow) {
    let detail = {};
    try {
      detail = JSON.parse(c.detail_json ?? '{}') ?? {};
    } catch {
      return { outcome: 'skipped', reason: 'unreadable' };
    }
    const command = String(detail.command ?? '');
    const p = this.printers.get(c.printer_id);
    if (!p?.driver) return { command, outcome: 'skipped', reason: 'printer_not_driven_here' };
    const age = (serverNow ?? this.clock()) - Date.parse(c.created_at);
    if (age > this.config.jobs.command_max_age_ms) return { command, outcome: 'skipped', reason: 'expired', age_seconds: Math.round(age / 1000) };
    const rec = this.activeJob(p);
    if (['pause', 'resume', 'stop'].includes(command) && detail.job_id && rec?.job_id !== detail.job_id) {
      return { command, outcome: 'skipped', reason: 'job_not_running_here', job_id: detail.job_id };
    }
    try {
      // Each driver call is bounded: a machine that never answers fails its command, it does not hold the loop.
      if (command === 'pause') {
        if (rec) rec.pause_reason = 'operator_command';
        await this.bounded(p, () => p.driver.pause(), 'pause');
      } else if (command === 'resume') await this.bounded(p, () => p.driver.resume(), 'resume');
      else if (command === 'stop') {
        if (rec) {
          rec.stop_requested = true;
          this.saveJob(rec);
        }
        await this.bounded(p, () => p.driver.cancel(), 'cancel');
      } else if (command === 'light_on' || command === 'light_off') {
        if (!p.driver.light) return { command, outcome: 'skipped', reason: 'unsupported_by_driver' };
        await this.bounded(p, () => p.driver.light(command === 'light_on'), 'light');
      } else if (command === 'camera_snapshot') return { command, outcome: 'skipped', reason: 'unsupported: the protocol carries camera metadata only' };
      else return { command, outcome: 'skipped', reason: 'unknown_command' };
    } catch (e) {
      return { command, outcome: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
    // The machine's next status shows the effect, and the watcher reports it as the job's event.
    p.nextTelemetryAt = 0;
    return { command, outcome: 'executed', job_id: rec?.job_id ?? null };
  }

  // ------------------------------------------------------------------ slicing

  async slicingTick() {
    this.nextSlicingAt = this.clock() + this.config.intervals.slicing_ms;
    if (!this.slicer || this.disabled.slicer || this.slicingBusy || this.stopping) return;
    let claim;
    try {
      claim = await this.cloud.claimSlicing();
    } catch (e) {
      if (e instanceof CloudError && e.status === 403) {
        this.disabled.slicer = true;
        this.log.error('slicer.forbidden', { note: 'the token has no slicer capability: slicing stopped' });
        return;
      }
      throw e;
    }
    if (!claim) return;
    this.slicingBusy = true;
    this.log.info('slicing.claimed', { slicing_request_id: claim.slicing_request_id, job_id: claim.job_id, lease_until: claim.lease_until });
    this.spawn('slicing', () => this.processClaim(claim)).finally(() => {
      this.slicingBusy = false;
      // More may be waiting: look again on the next tick rather than after a whole interval.
      this.nextSlicingAt = 0;
    });
  }

  /**
   * Download the models into a work directory and slice them; keep the
   * print file under prints/<job>/ with the input it was sliced from.
   * @returns {Promise<{ ok: true, print_file: any, estimate: any } | { ok: false, error_code: string, detail: string, transient?: boolean }>}
   */
  async sliceToCache(input, files, workName, requestId) {
    const workDir = this.state.path('work', workName);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    try {
      const local = new Map();
      for (const f of files ?? []) {
        if (!CLOUD_ID.test(String(f.file_id))) return { ok: false, error_code: 'INPUT_INVALID', detail: 'a file id the agent cannot use' };
        let got;
        try {
          got = await this.cloud.downloadFile(f.path ?? f.file_id);
        } catch (e) {
          // A network outage is not the model's fault: the lease lapses and the request returns to the queue.
          return { ok: false, error_code: 'MODEL_DOWNLOAD_FAILED', detail: e instanceof Error ? e.message : String(e), transient: !(e instanceof CloudError) || e.retryable };
        }
        const ext = MODEL_EXT.exec(got.filename ?? '')?.[1]?.toLowerCase();
        if (!ext) return { ok: false, error_code: 'UNSUPPORTED_MODEL_FORMAT', detail: `file ${f.file_id} is not STL, 3MF or OBJ` };
        let bytes = got.bytes;
        if (ext === '3mf') {
          // Customer-authored printer commands never reach the slicer: carriers refused, saved slicer config removed.
          const screened = screen3mf(bytes);
          if (!screened.ok) return { ok: false, error_code: screened.error_code, detail: `file ${f.file_id}: ${screened.detail}` };
          if (screened.removed.length) this.log.info('model.config_removed', { file_id: f.file_id, parts: screened.removed });
          bytes = screened.bytes;
        }
        const path = join(workDir, `${f.file_id}.${ext}`);
        writeFileSync(path, bytes);
        local.set(f.file_id, path);
      }
      const result = await /** @type {any} */ (this.slicer).slice({ input, files: local, workDir });
      if (!result.ok) return result;
      const jobId = String(input.job_id);
      if (!CLOUD_ID.test(jobId)) return { ok: false, error_code: 'INPUT_INVALID', detail: 'a job id the agent cannot use' };
      const dir = this.state.path('prints', jobId);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const name = `lv_${jobId}.${result.format}`;
      renameSync(result.printFile, join(dir, name));
      // Filament i+1 of the slice is the variant at index i: what a driver maps to its trays or slots.
      const filaments = result.estimate.materials.map((m) => m.variant_id);
      this.state.writeJson(`prints/${jobId}/manifest.json`, { job_id: jobId, slicing_request_id: requestId, name, format: result.format, sha256: result.sha256, filaments, input, estimate: result.estimate, created_at: iso(this.clock()) });
      return { ok: true, print_file: { name, path: join(dir, name), format: result.format, sha256: result.sha256, filaments }, estimate: result.estimate };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  async processClaim(claim) {
    const id = claim.slicing_request_id;
    const sliced = await this.sliceToCache(claim.input, claim.files, `slice-${id}`, id);
    if (!sliced.ok) {
      if (sliced.transient) {
        this.log.warn('slicing.deferred', { slicing_request_id: id, job_id: claim.job_id, error_code: sliced.error_code, detail: sliced.detail, note: 'not reported: the lease will lapse and the cloud requeues it' });
        return;
      }
      this.log.warn('slicing.failed', { slicing_request_id: id, job_id: claim.job_id, error_code: sliced.error_code, detail: sliced.detail });
      await this.answerSlicing(id, () => this.cloud.slicingFailure(id, sliced.error_code));
      return;
    }
    const posted = await this.answerSlicing(id, () => this.cloud.slicingResult(id, sliced.estimate));
    if (posted?.refused === 'VALIDATION') {
      // The cloud refused the figures as malformed: tell the customer it could not be measured rather than leave it hanging.
      await this.answerSlicing(id, () => this.cloud.slicingFailure(id, 'ESTIMATE_REJECTED'));
      return;
    }
    if (posted && !posted.refused) {
      this.log.info('slicing.result_posted', { slicing_request_id: id, job_id: claim.job_id, duration_seconds: sliced.estimate.duration_seconds, materials: sliced.estimate.materials, cloud_status: posted.status ?? null });
    }
  }

  /** Post a slicing answer; a request that is no longer ours (lease lost, already answered) is logged, not retried. */
  async answerSlicing(id, send) {
    try {
      return await send();
    } catch (e) {
      if (e instanceof CloudError && !e.retryable) {
        this.noteFatal(e);
        this.log.warn('slicing.answer_refused', { slicing_request_id: id, status: e.status, code: e.code, details: e.details });
        return { refused: e.code ?? String(e.status) };
      }
      this.log.warn('slicing.answer_failed', { slicing_request_id: id, error: e, note: 'the lease will lapse and the cloud requeues the request' });
      return null;
    }
  }

  // ------------------------------------------------------------------ housekeeping

  /**
   * Old print files and closed job records go after `prints_retention_days` —
   * never an active one, and never one the cloud still lists on our printers
   * (a completion awaiting verification): the record is what stops a second print.
   */
  async cleanup() {
    this.nextCleanupAt = this.clock() + 3_600_000;
    const horizon = this.clock() - this.config.jobs.prints_retention_days * DAY_MS;
    const assigned = new Set([...this.printers.values()].map((p) => p.current_job_id).filter(Boolean));
    for (const dir of ['prints', 'jobs']) {
      for (const name of this.state.list(dir)) {
        const id = basename(name, '.json');
        if (this.jobs.has(id) || assigned.has(id)) continue;
        try {
          if (statSync(this.state.path(dir, name)).mtimeMs < horizon) this.state.remove(`${dir}/${name}`);
        } catch {
          // Gone already.
        }
      }
    }
  }
}
