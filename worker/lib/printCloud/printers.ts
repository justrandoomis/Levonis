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
 * it or that it runs a print the cloud did not give it. Readings are ORDERED
 * by the agent's own sequence (boot, seq), never by a clock, so an older
 * reading never replaces a newer one; a clock only dates a reading for
 * freshness. When a printer comes back, the outage is recorded on its row
 * and its readings are compared with the job record; a mismatch is recorded
 * for an operator — never «fixed» by guessing.
 */
import { randomToken, sha256Hex } from '../crypto';
import { fence, many, one, planned, runBatch, type Stmt } from './db';
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
  /** The agent's boot counter: it persists it and adds one at every start of its process. */
  boot: number;
  /** The reading's place in that run, strictly increasing: what ORDERS the run's readings. */
  seq: number;
  /** The agent's clock when it TOOK the reading: with `sent_at`, the reading's age — never its order. */
  reported_at: string | null;
  /** The agent's clock when it SENT the reading. */
  sent_at: string | null;
}

const optIntIn = (v: unknown, f: string, min: number, max: number) => (v === undefined || v === null ? null : reqInt(v, f, { min, max }));

/** An agent stamp, normalised; anything unparseable is no stamp. */
const agentTime = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

export function parseTelemetry(raw: Record<string, unknown>): TelemetryInput {
  const state = raw.machine_state;
  if (typeof state !== 'string' || !(MACHINE_STATES as readonly string[]).includes(state)) throw invalid('machine_state', 'not_allowed');
  // The order of the agent's readings: both are required, because no clock can stand in for them.
  if (raw.boot === undefined || raw.boot === null) throw invalid('boot', 'required');
  const boot = reqInt(raw.boot, 'boot', { min: 0, max: Number.MAX_SAFE_INTEGER });
  if (raw.seq === undefined || raw.seq === null) throw invalid('seq', 'required');
  const seq = reqInt(raw.seq, 'seq', { min: 0, max: Number.MAX_SAFE_INTEGER });
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
    boot,
    seq,
    reported_at: agentTime(raw.reported_at),
    sent_at: agentTime(raw.sent_at),
  };
}

/**
 * When a reading was TAKEN, on the server clock: its arrival less its age.
 * The age is `sent_at - reported_at`, two readings of the AGENT's one clock,
 * so a clock running fast or slow cancels out and a reading buffered while
 * the network was down arrives as old as it is. A pair out of order is age
 * 0, and an age past the window is capped one second beyond it: stale, and
 * no further back, so no stamp can move the date anywhere else. Without both
 * stamps a reading is as old as its arrival. This dates a reading for
 * FRESHNESS only; it never decides which of two readings is the newer.
 */
export function readingTakenAt(t: Pick<TelemetryInput, 'reported_at' | 'sent_at'>, staleSeconds: number, now: Date): string {
  const ageMs = t.reported_at && t.sent_at ? Date.parse(t.sent_at) - Date.parse(t.reported_at) : 0;
  return iso(new Date(now.getTime() - Math.min(Math.max(0, ageMs), (staleSeconds + 1) * 1000)));
}

/**
 * THE ORDER of two readings of one printer, as a SQL boolean: is the incoming
 * reading newer than the stored row `r`?
 *   - the row came from another agent (the printer was re-bound): yes — only
 *     the bound agent reaches this door, and another agent's sequence says
 *     nothing about this one's;
 *   - otherwise by (`boot`, `seq`): a higher boot counter is a later run of
 *     the agent's process, and within one boot the higher `seq` is newer (an
 *     equal pair is the same reading). Both numbers are the agent's own and
 *     persisted, so no arrival order and no clock enters it.
 * The pre-read and the upsert's WHERE ask it with the same parameters.
 */
function newerThan(r: string, agentId: string, t: TelemetryInput): { sql: string; params: unknown[] } {
  return {
    sql: `CASE WHEN ${r}.agent_id IS NOT ? THEN 1 WHEN ? <> ${r}.boot THEN ? > ${r}.boot ELSE ? > ${r}.seq END`,
    params: [agentId, t.boot, t.boot, t.seq],
  };
}

/**
 * When a reading was taken by the agent's own measure, its age UNCAPPED:
 * arrival less `sent_at - reported_at`. Only the outage reconciliation reads
 * it (was a `finished` reading taken during the outage?), where a buffered
 * reading flushed long after the reconnection is still placed where it was
 * taken; freshness keeps the capped `readingTakenAt`.
 */
function readingObservedAt(t: Pick<TelemetryInput, 'reported_at' | 'sent_at'>, now: Date): string {
  const ageMs = t.reported_at && t.sent_at ? Date.parse(t.sent_at) - Date.parse(t.reported_at) : 0;
  return iso(new Date(now.getTime() - Math.max(0, ageMs)));
}

/**
 * Store a reading and compare it with the job record: a reading naming
 * another job than the one assigned, or a machine back from silence
 * reporting a finished print the record still shows as printing, is recorded
 * as an event for an operator.
 *
 * ORDER. Every reading carries the agent's `boot` (a counter it persists and
 * raises at every start of its process) and `seq` (strictly increasing within
 * that boot), and readings are ordered by them alone (`newerThan`). A boot
 * counter below the stored one writes `boot_regressed` once, so a lost
 * counter is visible. A replayed old body, a reading
 * overtaken in transit, an agent clock stepped back or a stamp in the year
 * 2100 cannot change which reading is the newer, because no clock is asked.
 * A reading that is not newer changes no state and is answered `superseded`.
 * The pre-read and the upsert's WHERE ask the same order, and the fence after
 * the upsert proves the row carries this request's fresh `op_token`, so two
 * readings racing each other end with the newer one stored and only its
 * events (the loser re-plans, and is superseded). The order holds among the
 * bound agent's readings: the batch is fenced on the printer still being
 * bound to it.
 *
 * TAKEN. `received_at` holds when the stored reading was taken
 * (`readingTakenAt`); every reader judges freshness from that column, and it
 * is written only with its own reading.
 *
 * FAULTS. An error reading records machine_error once per reading, stored or
 * superseded (the id is derived from printer, agent, boot and seq): a fault
 * that arrives out of order is never lost, though it changes no state.
 *
 * OUTAGE. Silence is a property of the CONNECTION, not of a reading:
 * `arrived_at` is the server time of the agent's last POST for the printer,
 * superseded ones included, and it only moves forward. The POST that finds
 * it older than the window — stored or superseded — records the outage on the
 * row (`outage_from` = that last arrival, `outage_to` = now) and writes
 * connection_restored, in one batch fenced on `arrived_at` still holding the
 * value read: of two POSTs racing at reconnection one records it, the other
 * re-reads and only moves `arrived_at`. It reads neither the order nor the
 * stored reading.
 *
 * RECONCILE. A STORED reading saying `finished` for the assigned job the
 * record still shows `printing`, taken during the recorded outage (or the
 * first one stored that was taken after it), writes reconcile_needed — once
 * per job per outage (its id is derived from both), whichever POST of the
 * reconnection carries it, even when the first one was superseded. A finish
 * reported on a connection steady since then is the agent's own `completed`
 * event to report, not a reconciliation.
 */
export async function ingestTelemetry(db: D1Database, agent: AgentRow, printerId: string, t: TelemetryInput, staleSeconds: number, now: Date) {
  const takenAt = readingTakenAt(t, staleSeconds, now);
  const observedAt = readingObservedAt(t, now);
  const faultId = `pcpe_me_${(await sha256Hex(JSON.stringify([printerId, agent.id, t.boot, t.seq]))).slice(0, 32)}`;
  const regressedId = `pcpe_br_${(await sha256Hex(JSON.stringify([printerId, agent.id, t.boot]))).slice(0, 32)}`;
  return planned<{ stored: boolean; superseded?: true; mismatch: boolean }>(db, async () => {
    await agentPrinter(db, agent, printerId);
    const order = newerThan('t', agent.id, t);
    const previous = await one<{
      received_at: string;
      observed_at: string | null;
      arrived_at: string;
      outage_from: string | null;
      outage_to: string | null;
      agent_id: string | null;
      boot: number;
      newer: number;
    }>(
      db,
      `SELECT t.received_at, t.observed_at, t.arrived_at, t.outage_from, t.outage_to, t.agent_id, t.boot, (${order.sql}) AS newer
         FROM pc_printer_telemetry t WHERE t.printer_id = ?`,
      ...order.params,
      printerId
    );
    const event = (kind: string, detail: Record<string, unknown>) =>
      db
        .prepare("INSERT INTO pc_printer_events (id, printer_id, kind, detail_json, actor_type, actor_id, created_at) VALUES (?, ?, ?, ?, 'agent', ?, ?)")
        .bind(pcId('pcpe'), printerId, kind, JSON.stringify(detail), agent.id, iso(now));
    const fault = (superseded: boolean): Stmt[] =>
      t.machine_state === 'error' && t.errors.length
        ? [
            db
              .prepare("INSERT OR IGNORE INTO pc_printer_events (id, printer_id, kind, detail_json, actor_type, actor_id, created_at) VALUES (?, ?, 'machine_error', ?, 'agent', ?, ?)")
              .bind(faultId, printerId, JSON.stringify({ errors: t.errors, boot: t.boot, seq: t.seq, ...(superseded ? { superseded: true } : {}) }), agent.id, iso(now)),
          ]
        : [];

    // Only the agent the printer is bound to writes its row, so «another agent wrote it» means a re-bind.
    const s: Stmt[] = [fence(db, 'STATE_CHANGED', 'EXISTS (SELECT 1 FROM pc_printers WHERE id = ? AND agent_id = ?)', [printerId, agent.id])];
    // The connection first: every POST proves it alive, and the one that ends a silence records the outage.
    const lastArrival = previous?.arrived_at ?? null;
    const restored = !!lastArrival && (now.getTime() - Date.parse(lastArrival)) / 1000 > staleSeconds;
    if (restored) {
      s.push(
        fence(db, 'STATE_CHANGED', '(SELECT arrived_at FROM pc_printer_telemetry WHERE printer_id = ?) = ?', [printerId, lastArrival]),
        db.prepare('UPDATE pc_printer_telemetry SET arrived_at = ?, outage_from = ?, outage_to = ? WHERE printer_id = ?').bind(iso(now), lastArrival, iso(now), printerId),
        event('connection_restored', { silent_since: lastArrival })
      );
    } else {
      s.push(db.prepare('UPDATE pc_printer_telemetry SET arrived_at = ? WHERE printer_id = ? AND arrived_at < ?').bind(iso(now), printerId, iso(now)));
    }
    const outage = restored && lastArrival ? { from: lastArrival, to: iso(now) } : previous?.outage_from && previous.outage_to ? { from: previous.outage_from, to: previous.outage_to } : null;

    if (previous && !previous.newer) {
      // A boot counter BELOW the stored one from the same agent means the agent lost or rolled back its counter:
      // every reading it sends is superseded until the counter passes the stored one. Said once per boot, so an
      // operator sees why the machine went quiet (re-binding it to a fresh agent token also clears it).
      const regressed =
        previous.agent_id === agent.id && t.boot < Number(previous.boot)
          ? [
              db
                .prepare("INSERT OR IGNORE INTO pc_printer_events (id, printer_id, kind, detail_json, actor_type, actor_id, created_at) VALUES (?, ?, 'boot_regressed', ?, 'agent', ?, ?)")
                .bind(regressedId, printerId, JSON.stringify({ boot: t.boot, stored_boot: Number(previous.boot) }), agent.id, iso(now)),
            ]
          : [];
      return { statements: [...s, ...fault(true), ...regressed], result: { stored: false, superseded: true, mismatch: false } };
    }
    const assigned = await one<{ job_id: string; status: string }>(
      db,
      "SELECT a.job_id, j.status FROM pc_printer_assignments a JOIN pc_print_jobs j ON j.id = a.job_id WHERE a.printer_id = ? AND a.state = 'active'",
      printerId
    );
    const token = pcId('tok');
    const stillNewer = newerThan('pc_printer_telemetry', agent.id, t);
    s.push(
      db
        .prepare(
          `INSERT INTO pc_printer_telemetry (printer_id, agent_id, boot, seq, op_token, received_at, observed_at, arrived_at, machine_state, job_id, progress_permille, layer,
             total_layers, remaining_seconds, nozzle_temp_dc, bed_temp_dc, chamber_temp_dc, errors_json, camera_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (printer_id) DO UPDATE SET agent_id = excluded.agent_id, boot = excluded.boot, seq = excluded.seq, op_token = excluded.op_token,
             received_at = excluded.received_at, observed_at = excluded.observed_at, machine_state = excluded.machine_state, job_id = excluded.job_id, progress_permille = excluded.progress_permille,
             layer = excluded.layer, total_layers = excluded.total_layers, remaining_seconds = excluded.remaining_seconds, nozzle_temp_dc = excluded.nozzle_temp_dc,
             bed_temp_dc = excluded.bed_temp_dc, chamber_temp_dc = excluded.chamber_temp_dc, errors_json = excluded.errors_json, camera_json = excluded.camera_json
           WHERE ${stillNewer.sql}`
        )
        .bind(
          printerId,
          agent.id,
          t.boot,
          t.seq,
          token,
          takenAt,
          observedAt,
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
          JSON.stringify(t.camera),
          ...stillNewer.params
        ),
      // A newer reading stored meanwhile kept its place: the row is not this reading, and the re-plan answers superseded.
      fence(db, 'STATE_CHANGED', '(SELECT op_token FROM pc_printer_telemetry WHERE printer_id = ?) = ?', [printerId, token])
    );
    if (t.job_id && assigned && t.job_id !== assigned.job_id) s.push(event('telemetry_job_mismatch', { reported: t.job_id, assigned: assigned.job_id }));
    if (t.job_id && !assigned) s.push(event('telemetry_job_unassigned', { reported: t.job_id }));
    // Taken during the outage, or the first reading stored that was taken after it — judged on the UNCAPPED
    // moment, so a finish buffered during the outage and flushed long after the reconnection still counts.
    const previousObserved = previous ? (previous.observed_at ?? previous.received_at) : null;
    const backFromSilence = !!previousObserved && !!outage && observedAt >= outage.from && (observedAt <= outage.to || previousObserved < outage.to);
    if (assigned && outage && backFromSilence && t.machine_state === 'finished' && assigned.status === 'printing') {
      // Once per job per outage: the id is derived from both, and the job must still be printing on this machine when the batch runs.
      s.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO pc_printer_events (id, printer_id, kind, detail_json, actor_type, actor_id, created_at)
             SELECT ?, ?, 'reconcile_needed', ?, 'agent', ?, ?
              WHERE EXISTS (SELECT 1 FROM pc_printer_assignments a JOIN pc_print_jobs j ON j.id = a.job_id
                             WHERE a.printer_id = ? AND a.job_id = ? AND a.state = 'active' AND j.status = 'printing')`
          )
          .bind(
            `pcpe_rc_${assigned.job_id}_${Date.parse(outage.from)}`,
            printerId,
            JSON.stringify({ job_id: assigned.job_id, machine_state: t.machine_state, silent_since: outage.from }),
            agent.id,
            iso(now),
            printerId,
            assigned.job_id
          )
      );
    }
    s.push(...fault(false));
    return { statements: s, result: { stored: true, mismatch: !!(t.job_id && assigned && t.job_id !== assigned.job_id) } };
  });
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
