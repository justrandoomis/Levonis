/**
 * PRINTER CONNECTIVITY (docs/PRINT_CLOUD.md §9): the workshop agent.
 *
 * The agent is a program on the workshop network. It holds the printers'
 * own credentials (LAN access codes, cloud tokens) — they NEVER reach this
 * Worker, its database or any API answer; a printer row carries only an
 * opaque `connection_ref` the agent resolves. The agent authenticates with a
 * bearer token whose SHA-256 alone is stored.
 *
 * What it may do, and only for the printers bound to it:
 *   - report telemetry (state, progress, layers, remaining time,
 *     temperatures, errors, camera METADATA);
 *   - report job events (started, paused, resumed, completed with
 *     consumption, failed) — each one a state-machine transition, so a
 *     re-sent event is answered «already applied» and changes nothing;
 *   - read operator commands queued for its printers;
 *   - claim slicing work and fetch the files of the jobs it serves.
 *
 * STALENESS. A reading older than `telemetry_stale_seconds` is answered with
 * `stale: true, live: false`; a stale agent printer is never auto-assigned
 * work, and neither is one whose fresh reading says the agent cannot reach
 * it or that it runs a print the cloud did not give it. A reading is dated
 * by when it was TAKEN, not when it arrived, and an older reading never
 * replaces a newer one. When a printer comes back, its readings are compared
 * with the job record and a mismatch is recorded for an operator — never
 * «fixed» by guessing.
 */
import { randomToken, sha256Hex } from '../crypto';
import { HttpError } from '../http';
import { fence, many, one, runBatch, type Stmt } from './db';
import { invalid, pcError } from './errors';
import { pcAudit } from './audit';
import { addSeconds, iso, pcId, reqInt, reqString } from './util';

export interface AgentRow {
  id: string;
  name: string;
  active: number;
  capabilities_json: string;
}

export const AGENT_CAPABILITIES = ['telemetry', 'job_control', 'slicer', 'camera'] as const;

/** Create an agent; the token is returned ONCE and only its hash is kept. */
export async function createAgent(db: D1Database, p: { name: string; capabilities: unknown; actorId: string; now: Date }) {
  const caps = Array.isArray(p.capabilities) ? p.capabilities.filter((c): c is string => (AGENT_CAPABILITIES as readonly string[]).includes(String(c))) : ['telemetry'];
  const token = `pca_${randomToken(32)}`;
  const id = pcId('pcag');
  await runBatch(db, [
    db
      .prepare('INSERT INTO pc_agents (id, name, token_hash, capabilities_json, active, created_by, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .bind(id, p.name.slice(0, 80), await sha256Hex(token), JSON.stringify([...new Set(caps)]), p.actorId, iso(p.now)),
    ...(await pcAudit(db, p.actorId, 'agent.create', id, { name: p.name, capabilities: caps })),
  ]);
  return { agent_id: id, token, capabilities: caps };
}

export async function revokeAgent(db: D1Database, agentId: string, actorId: string, now: Date) {
  const a = await one<AgentRow>(db, 'SELECT id, name, active, capabilities_json FROM pc_agents WHERE id = ?', agentId);
  if (!a) throw pcError('NOT_FOUND');
  await runBatch(db, [
    db.prepare('UPDATE pc_agents SET active = 0, revoked_at = ? WHERE id = ?').bind(iso(now), agentId),
    ...(await pcAudit(db, actorId, 'agent.revoke', agentId)),
  ]);
}

/** The agent behind a bearer token, or null. Revoked agents and malformed tokens are the same null. */
export async function authenticateAgent(db: D1Database, authorization: string | undefined | null, now: Date): Promise<AgentRow | null> {
  const m = /^Bearer (pca_[A-Za-z0-9_-]{20,100})$/.exec(authorization ?? '');
  if (!m) return null;
  const agent = await one<AgentRow>(db, 'SELECT id, name, active, capabilities_json FROM pc_agents WHERE token_hash = ?', await sha256Hex(m[1]));
  if (!agent || !agent.active) return null;
  await db.prepare('UPDATE pc_agents SET last_seen_at = ? WHERE id = ?').bind(iso(now), agent.id).run().catch(() => undefined);
  return agent;
}

export function agentCan(agent: AgentRow, capability: (typeof AGENT_CAPABILITIES)[number]): boolean {
  try {
    return (JSON.parse(agent.capabilities_json) as string[]).includes(capability);
  } catch {
    return false;
  }
}

export type SlicerAvailability = 'connected' | 'stale' | 'never_connected' | 'not_connected';

/**
 * Is a slicer there to take work? Only an active agent with the `slicer`
 * capability that called in within `freshSeconds` (every authenticated call
 * stamps `last_seen_at`) is `connected`. A token minted for a program that
 * never ran is `never_connected` and one gone silent is `stale` — a token
 * alone never claims a live slicer. `GET /status` and the analysis answer
 * both read this, so they cannot disagree.
 */
export async function slicerAvailability(db: D1Database, freshSeconds: number, now: Date): Promise<SlicerAvailability> {
  const row = await one<{ n: number; seen: string | null; fresh: number | null }>(
    db,
    `SELECT COUNT(*) AS n, MAX(last_seen_at) AS seen, SUM(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END) AS fresh
       FROM pc_agents WHERE active = 1 AND capabilities_json LIKE '%"slicer"%'`,
    iso(addSeconds(now, -freshSeconds))
  );
  if (!row || !Number(row.n)) return 'not_connected';
  if (Number(row.fresh ?? 0) > 0) return 'connected';
  return row.seen ? 'stale' : 'never_connected';
}

export async function agentPrinter(db: D1Database, agent: AgentRow, printerId: string) {
  const p = await one<{ id: string; model_id: string; name: string; status: string }>(
    db,
    'SELECT id, model_id, name, status FROM pc_printers WHERE id = ? AND agent_id = ?',
    printerId,
    agent.id
  );
  if (!p) throw pcError('NOT_FOUND', { field: 'printer_id' });
  return p;
}

const MACHINE_STATES = ['idle', 'preparing', 'printing', 'paused', 'finished', 'error', 'offline'] as const;

/** States in which a machine is running a print of its own (no cloud job holds it: one started from its screen or card). */
const OCCUPIED_STATES: readonly string[] = ['preparing', 'printing', 'paused'];

export const telemetryFresh = (takenAt: string | null, staleSeconds: number, now: Date): boolean =>
  !!takenAt && (now.getTime() - Date.parse(takenAt)) / 1000 <= staleSeconds;

/**
 * What a machine's OWN report says about taking work now — the half of a
 * scheduling verdict (queue.ts) that does not depend on the job:
 *   printer_reports_error  its latest reading is an error;
 *   telemetry_stale        an agent printer not heard from within the window;
 *   printer_offline        a fresh reading in which the agent cannot reach it;
 *   printer_occupied       a fresh reading of a print the cloud did not give
 *                          it (no cloud job holds it, yet it is preparing,
 *                          printing or paused).
 * `finished` (the last plate still on the bed) is accepted: clearing the bed
 * is the job's `preparing` step, before anything starts.
 */
export function machineStateReasons(
  p: { adapter: string; busy: number | boolean; machine_state: string | null; received_at: string | null },
  staleSeconds: number,
  now: Date
): string[] {
  const reasons: string[] = [];
  if (p.machine_state === 'error') reasons.push('printer_reports_error');
  if (p.adapter !== 'agent') return reasons;
  if (!telemetryFresh(p.received_at, staleSeconds, now)) reasons.push('telemetry_stale');
  else if (p.machine_state === 'offline') reasons.push('printer_offline');
  else if (!p.busy && OCCUPIED_STATES.includes(p.machine_state ?? '')) reasons.push('printer_occupied');
  return reasons;
}

/**
 * A machine that can take work NOW, as SQL over `pc_printers p`: active, no
 * cloud job on it, no planned maintenance on, and `machineStateReasons`
 * empty. Every count of IDLE machines a customer or the public sees uses it,
 * so a machine the scheduler would refuse is never shown as available.
 */
export function machineReadySql(staleSeconds: number, now: Date): { sql: string; params: string[] } {
  return {
    sql: `p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM pc_printer_assignments ra WHERE ra.printer_id = p.id AND ra.state = 'active')
      AND NOT EXISTS (SELECT 1 FROM pc_printer_maintenance rm WHERE rm.printer_id = p.id AND rm.status = 'planned' AND rm.starts_at <= ? AND rm.ends_at > ?)
      AND NOT EXISTS (SELECT 1 FROM pc_printer_telemetry rt WHERE rt.printer_id = p.id AND rt.machine_state = 'error')
      AND (p.adapter <> 'agent' OR EXISTS (SELECT 1 FROM pc_printer_telemetry rt WHERE rt.printer_id = p.id AND rt.received_at >= ?
             AND rt.machine_state NOT IN ('offline', ${OCCUPIED_STATES.map((s) => `'${s}'`).join(', ')})))`,
    params: [iso(now), iso(now), iso(addSeconds(now, -staleSeconds))],
  };
}

export interface TelemetryInput {
  machine_state: (typeof MACHINE_STATES)[number];
  job_id: string | null;
  progress_permille: number | null;
  layer: number | null;
  total_layers: number | null;
  remaining_seconds: number | null;
  nozzle_temp_dc: number | null;
  bed_temp_dc: number | null;
  chamber_temp_dc: number | null;
  errors: Array<{ code: string; message: string }>;
  camera: { available: boolean; stream_id?: string; resolution?: string };
  reported_at: string | null;
  /** The agent's clock when it SENT the reading: with `reported_at`, the reading's age by one clock. */
  sent_at: string | null;
}

const optIntIn = (v: unknown, f: string, min: number, max: number) => (v === undefined || v === null ? null : reqInt(v, f, { min, max }));

const agentTime = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

export function parseTelemetry(raw: Record<string, unknown>): TelemetryInput {
  const state = raw.machine_state;
  if (typeof state !== 'string' || !(MACHINE_STATES as readonly string[]).includes(state)) throw invalid('machine_state', 'not_allowed');
  const errors = Array.isArray(raw.errors)
    ? raw.errors.slice(0, 10).map((e, i) => {
        const o = (e ?? {}) as Record<string, unknown>;
        return { code: reqString(o.code, `errors[${i}].code`, { max: 60 }), message: typeof o.message === 'string' ? o.message.slice(0, 200) : '' };
      })
    : [];
  const cam = raw.camera && typeof raw.camera === 'object' ? (raw.camera as Record<string, unknown>) : {};
  // Camera METADATA only: a stream id the agent resolves, never a URL that embeds a credential.
  const streamId = typeof cam.stream_id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(cam.stream_id) ? cam.stream_id : undefined;
  return {
    machine_state: state as TelemetryInput['machine_state'],
    job_id: typeof raw.job_id === 'string' && raw.job_id ? raw.job_id.slice(0, 120) : null,
    progress_permille: optIntIn(raw.progress_permille, 'progress_permille', 0, 1000),
    layer: optIntIn(raw.layer, 'layer', 0, 1_000_000),
    total_layers: optIntIn(raw.total_layers, 'total_layers', 0, 1_000_000),
    remaining_seconds: optIntIn(raw.remaining_seconds, 'remaining_seconds', 0, 60 * 24 * 3600),
    nozzle_temp_dc: optIntIn(raw.nozzle_temp_dc, 'nozzle_temp_dc', -500, 6000),
    bed_temp_dc: optIntIn(raw.bed_temp_dc, 'bed_temp_dc', -500, 3000),
    chamber_temp_dc: optIntIn(raw.chamber_temp_dc, 'chamber_temp_dc', -500, 2000),
    errors,
    camera: { available: cam.available === true, ...(streamId ? { stream_id: streamId } : {}), ...(typeof cam.resolution === 'string' ? { resolution: cam.resolution.slice(0, 20) } : {}) },
    reported_at: agentTime(raw.reported_at),
    sent_at: agentTime(raw.sent_at),
  };
}

/** The earliest time a reading may claim; anything before is a broken clock, dated here (as old as can be). */
const EARLIEST_READING = Date.UTC(2000, 0, 1);

/**
 * Store a reading and compare it with the job record: a reading naming
 * another job than the one assigned, or a machine back from silence
 * reporting a finished print the record still shows as printing, is recorded
 * as an event for an operator.
 *
 * ORDER. `received_at` holds when the reading was TAKEN, on the server
 * clock: its arrival less its age. The age is `sent_at - reported_at`, two
 * readings of the AGENT's one clock, so a clock running fast or slow cancels
 * out and a reading buffered while the network was down arrives as old as it
 * is. Without `sent_at` the server clock is the reference (`now -
 * reported_at`, never in the future), and a slow agent clock makes readings
 * look older — stale, never live. Every reader judges freshness from that
 * column. A reading older than the stored one changes nothing and is answered
 * `superseded`: a late copy can never replace the current state, clear an
 * error or pass for live. The upsert and a fence re-check the order inside the
 * batch, so two readings racing each other end with the newer one stored and
 * only its events.
 *
 * SILENCE is a property of the CONNECTION, not of a reading: `arrived_at` is
 * the server time of the agent's last POST for the printer, superseded ones
 * included. A machine is «back» (connection_restored, and reconcile_needed for
 * a print it finished meanwhile) only when that gap passed the window — once
 * per outage, however many buffered readings the reconnection flushes.
 */
export async function ingestTelemetry(db: D1Database, agent: AgentRow, printerId: string, t: TelemetryInput, staleSeconds: number, now: Date) {
  await agentPrinter(db, agent, printerId);
  const stated = t.reported_at ? Date.parse(t.reported_at) : null;
  const ageMs = stated === null ? 0 : Math.max(0, (t.sent_at ? Date.parse(t.sent_at) : now.getTime()) - stated);
  const takenAt = iso(new Date(Math.max(EARLIEST_READING, now.getTime() - ageMs)));
  const superseded = { stored: false, superseded: true, mismatch: false };
  const previous = await one<{ received_at: string; arrived_at: string | null }>(db, 'SELECT received_at, arrived_at FROM pc_printer_telemetry WHERE printer_id = ?', printerId);
  // A late copy still proves the connection is alive.
  const arrived = () =>
    db.prepare('UPDATE pc_printer_telemetry SET arrived_at = ? WHERE printer_id = ? AND (arrived_at IS NULL OR arrived_at < ?)').bind(iso(now), printerId, iso(now)).run();
  if (previous && takenAt < previous.received_at) {
    await arrived();
    return superseded;
  }
  const assigned = await one<{ job_id: string; status: string }>(
    db,
    "SELECT a.job_id, j.status FROM pc_printer_assignments a JOIN pc_print_jobs j ON j.id = a.job_id WHERE a.printer_id = ? AND a.state = 'active'",
    printerId
  );
  const s: Stmt[] = [
    db
      .prepare(
        `INSERT INTO pc_printer_telemetry (printer_id, agent_id, received_at, reported_at, arrived_at, machine_state, job_id, progress_permille, layer, total_layers,
           remaining_seconds, nozzle_temp_dc, bed_temp_dc, chamber_temp_dc, errors_json, camera_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (printer_id) DO UPDATE SET agent_id = excluded.agent_id, received_at = excluded.received_at, reported_at = excluded.reported_at,
           arrived_at = excluded.arrived_at,
           machine_state = excluded.machine_state, job_id = excluded.job_id, progress_permille = excluded.progress_permille, layer = excluded.layer,
           total_layers = excluded.total_layers, remaining_seconds = excluded.remaining_seconds, nozzle_temp_dc = excluded.nozzle_temp_dc,
           bed_temp_dc = excluded.bed_temp_dc, chamber_temp_dc = excluded.chamber_temp_dc, errors_json = excluded.errors_json, camera_json = excluded.camera_json
         WHERE excluded.received_at >= pc_printer_telemetry.received_at`
      )
      .bind(
        printerId,
        agent.id,
        takenAt,
        t.reported_at,
        iso(now),
        t.machine_state,
        t.job_id,
        t.progress_permille,
        t.layer,
        t.total_layers,
        t.remaining_seconds,
        t.nozzle_temp_dc,
        t.bed_temp_dc,
        t.chamber_temp_dc,
        JSON.stringify(t.errors),
        JSON.stringify(t.camera)
      ),
    // A newer reading stored meanwhile kept its place: this one, and its events, land nowhere.
    fence(db, 'STATE_CHANGED', '(SELECT received_at FROM pc_printer_telemetry WHERE printer_id = ?) = ?', [printerId, takenAt]),
  ];
  const event = (kind: string, detail: Record<string, unknown>) =>
    db
      .prepare("INSERT INTO pc_printer_events (id, printer_id, kind, detail_json, actor_type, actor_id, created_at) VALUES (?, ?, ?, ?, 'agent', ?, ?)")
      .bind(pcId('pcpe'), printerId, kind, JSON.stringify(detail), agent.id, iso(now));
  const lastArrival = previous ? (previous.arrived_at ?? previous.received_at) : null;
  const wasStale = lastArrival ? (now.getTime() - Date.parse(lastArrival)) / 1000 > staleSeconds : false;
  if (wasStale) s.push(event('connection_restored', { silent_since: lastArrival }));
  if (t.job_id && assigned && t.job_id !== assigned.job_id) s.push(event('telemetry_job_mismatch', { reported: t.job_id, assigned: assigned.job_id }));
  if (t.job_id && !assigned) s.push(event('telemetry_job_unassigned', { reported: t.job_id }));
  if (assigned && wasStale && t.machine_state === 'finished' && assigned.status === 'printing') {
    s.push(event('reconcile_needed', { job_id: assigned.job_id, machine_state: t.machine_state }));
  }
  if (t.machine_state === 'error' && t.errors.length) s.push(event('machine_error', { errors: t.errors }));
  try {
    await runBatch(db, s);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'STATE_CHANGED') {
      await arrived();
      return superseded;
    }
    throw e;
  }
  return { stored: true, mismatch: !!(t.job_id && assigned && t.job_id !== assigned.job_id) };
}

/** Every printer as an operator sees it: status, connectivity derived honestly, current job, telemetry with its age. */
export async function printerStatuses(db: D1Database, staleSeconds: number, now: Date, modelId?: string) {
  const rows = await many<Record<string, unknown>>(
    db,
    `SELECT p.id, p.name, p.model_id, m.code AS model_code, p.status, p.adapter, p.location, p.nozzle_um, p.ams_slots, p.materials_json, p.camera,
            p.operating_seconds, a.job_id AS current_job_id,
            t.machine_state, t.job_id AS telemetry_job_id, t.progress_permille, t.layer, t.total_layers, t.remaining_seconds,
            t.nozzle_temp_dc, t.bed_temp_dc, t.chamber_temp_dc, t.errors_json, t.camera_json, t.received_at
       FROM pc_printers p
       JOIN pc_printer_models m ON m.id = p.model_id
       LEFT JOIN pc_printer_assignments a ON a.printer_id = p.id AND a.state = 'active'
       LEFT JOIN pc_printer_telemetry t ON t.printer_id = p.id
      ${modelId ? 'WHERE p.model_id = ?' : ''}
      ORDER BY p.name`,
    ...(modelId ? [modelId] : [])
  );
  return rows.map((r) => {
    const age = r.received_at ? Math.max(0, Math.floor((now.getTime() - Date.parse(String(r.received_at))) / 1000)) : null;
    const stale = age === null || age > staleSeconds;
    // A fresh reading in which the agent cannot reach the machine is not «online» either.
    const connectivity = r.adapter === 'manual' ? 'manual' : r.received_at === null ? 'never_connected' : stale || r.machine_state === 'offline' ? 'offline' : 'online';
    return {
      id: r.id,
      name: r.name,
      model_id: r.model_id,
      model_code: r.model_code,
      status: r.status,
      adapter: r.adapter,
      location: r.location,
      nozzle_um: r.nozzle_um,
      ams_slots: r.ams_slots,
      materials: JSON.parse(String(r.materials_json || '[]')),
      camera: !!r.camera,
      operating_seconds: r.operating_seconds,
      current_job_id: r.current_job_id ?? null,
      connectivity,
      telemetry: r.received_at
        ? {
            stale,
            live: !stale,
            age_seconds: age,
            received_at: r.received_at,
            machine_state: r.machine_state,
            job_id: r.telemetry_job_id,
            progress_permille: r.progress_permille,
            layer: r.layer,
            total_layers: r.total_layers,
            remaining_seconds: r.remaining_seconds,
            nozzle_temp_dc: r.nozzle_temp_dc,
            bed_temp_dc: r.bed_temp_dc,
            chamber_temp_dc: r.chamber_temp_dc,
            errors: JSON.parse(String(r.errors_json || '[]')),
            camera: JSON.parse(String(r.camera_json || '{}')),
          }
        : null,
    };
  });
}

export const PRINTER_COMMANDS = ['pause', 'resume', 'stop', 'light_on', 'light_off', 'camera_snapshot'] as const;

/** An operator's command for the agent to carry out; recorded append-only, read by the agent. */
export async function queueCommand(db: D1Database, printerId: string, command: string, jobId: string | null, actor: { type: 'admin' | 'operator'; id: string }, now: Date) {
  if (!(PRINTER_COMMANDS as readonly string[]).includes(command)) throw invalid('command', 'not_allowed');
  const p = await one<{ id: string; adapter: string }>(db, 'SELECT id, adapter FROM pc_printers WHERE id = ?', printerId);
  if (!p) throw pcError('NOT_FOUND');
  if (p.adapter !== 'agent') throw pcError('PRINTER_UNAVAILABLE', { reason: 'manual_printer_has_no_agent' });
  const id = pcId('pcpe');
  await runBatch(db, [
    db
      .prepare("INSERT INTO pc_printer_events (id, printer_id, kind, detail_json, actor_type, actor_id, created_at) VALUES (?, ?, 'command', ?, ?, ?, ?)")
      .bind(id, printerId, JSON.stringify({ command, job_id: jobId }), actor.type, actor.id, iso(now)),
    ...(await pcAudit(db, actor.id, 'printer.command', printerId, { command, job_id: jobId })),
  ]);
  return { command_id: id };
}

export async function commandsForAgent(db: D1Database, agent: AgentRow, since: string | null) {
  return many<Record<string, unknown>>(
    db,
    `SELECT e.id, e.printer_id, e.detail_json, e.created_at FROM pc_printer_events e JOIN pc_printers p ON p.id = e.printer_id
      WHERE p.agent_id = ? AND e.kind = 'command' AND e.created_at > ? ORDER BY e.created_at, e.id LIMIT 100`,
    agent.id,
    since ?? '1970-01-01T00:00:00.000Z'
  );
}
